/**
 * 派单材料的端到端行为：材料是否真的进了员工收到的 message、缺材料时是否拒绝派单、
 * 容量超限是否停止而不是截断、库里损坏的留存是否一律按未知处理，以及存储重开之后
 * 上游外部待办是否仍进入下游实际派单 message、续问之后已固定的下游快照是否保持不变。
 *
 * 走 `ButlerConsole` 的完整调用链（大总管理解 → 计划 → 依赖判定 → 派活 → 收尾），
 * 只把执行方换成替身；断言的是**员工实际收到的请求内容**与 **dispatch 调用次数**，
 * 不是字段形状。
 */
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor, ButlerDispatchRequest } from '../src/protocol.ts'
import { TaskStore } from '../src/store.ts'
import type { SubtaskState } from '../src/task-model.ts'

type Dispatch = ButlerAgentExecutor['dispatch']
type Reply = NonNullable<ButlerAgentExecutor['reply']>

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const openedDbs: string[] = []
function tempDb(): string {
  const path = join(tmpdir(), `butler-inputrefs-flow-${randomUUID()}.sqlite`)
  openedDbs.push(path)
  return path
}
afterEach(() => {
  for (const path of openedDbs.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${path}${suffix}`, { force: true }) } catch { /* 留给系统清理 */ }
    }
  }
})

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

/** 直接改库：摆出「旧已派出但没留材料」「快照损坏」这类历史形态（只用合成数据）。 */
function rawRun(path: string, sql: string): void {
  const db = new DatabaseSync(path)
  db.exec(sql)
  db.close()
}

/** 直接读库里的原始列，绕开解析层看真实落库的字节。 */
function rawColumn(path: string, column: 'input_refs' | 'member_return', subtaskId: string): string {
  const db = new DatabaseSync(path)
  const row = db.prepare(`SELECT ${column} AS value FROM subtasks WHERE id=?`).get(subtaskId) as unknown as { value: string }
  db.close()
  return row.value
}

function context(executor: ButlerAgentExecutor): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: executor.agentId, packageName: 'dsh-blog', version: '1.0.0', displayName: '博客',
          description: '', entryPath: '/agents/blog', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

/** 一套完整运行环境：替身执行方、给定存储、注册好的派活工具。 */
function environment(store: TaskStore, handlers: { dispatch: Dispatch; reply?: Reply }, maxResultChars = 8000) {
  const requests: ButlerDispatchRequest[] = []
  const replies: unknown[] = []
  const executor: ButlerAgentExecutor = {
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async request => { requests.push(request); return await handlers.dispatch(request) },
    ...(handlers.reply === undefined ? {} : {
      reply: async request => { replies.push(request); return await handlers.reply!(request) },
    }),
  }
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, store, '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, unknown>
  }
  // 取当前挂在管家上的存储（用例中途换过存储时，替身入口也要跟着换）。
  const currentStore = () => (console_ as unknown as { store: TaskStore }).store
  vi.spyOn(console_, 'open').mockImplementation(async (requestedId?: string) => {
    currentStore().openOrReserveConversation(String(requestedId), actor)
    const conversation = { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() }
    inner.conversations.set(conversationId, conversation)
    return conversation as never
  })
  const tools: { execute(args: unknown, exec: unknown): Promise<unknown> }[] = []
  inner.setup({
    systemPrompt: { section: vi.fn() },
    tools: { register: (tool: never) => { tools.push(tool) }, restrict: vi.fn() },
  }, conversationId)
  const planTool = tools[0]
  if (planTool === undefined) throw new Error('派活工具没有注册')
  const endTurn = () => console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
  return { console_, agent, planTool, requests, replies, endTurn }
}

type Env = ReturnType<typeof environment>

/** 计划成两步：`s1` 起草，`s2` 依赖它。 */
async function planDependent(env: Env, store: TaskStore): Promise<string> {
  await env.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
  await until(() => env.agent.followup.mock.calls.length === 1, '大总管开始理解')
  await env.planTool.execute({
    reply: '先起一版，再校对。',
    note: '',
    subtasks: [
      { goal: '起草', agentId: 'blog', reason: '博客负责写作', logicalId: 'g1' },
      { goal: '校对', agentId: 'blog', reason: '同一成员接力', logicalId: 'g2', dependsOn: ['g1'] },
    ],
  }, { signal: new AbortController().signal })
  env.endTurn()
  await until(() => tasks(store).length === 1, '任务落库')
  return tasks(store)[0]!.id
}

const tasks = (store: TaskStore) => store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' }).items
const subtaskOf = (store: TaskStore, taskId: string, id: string) => store.task(actor, taskId)?.subtasks.find(item => item.id === id)

/** 等这一轮收尾（中途进汇总时替它结束那一轮）。 */
async function settleRound(env: Env, store: TaskStore, taskId: string): Promise<void> {
  let settledSummary = false
  await until(() => {
    const state = store.task(actor, taskId)!.state
    if (state === 'summarizing') {
      if (!settledSummary) {
        settledSummary = true
        env.endTurn()
      }
      return false
    }
    return state !== 'running'
  }, '这一轮收尾')
}

/**
 * 跑一轮：两个子任务，第二个依赖第一个（都用同一个替身执行方）。
 * 返回 store、任务 id、以及替身收到的全部派单请求。
 */
async function runDependentFlow(
  dispatch: Dispatch,
  maxResultChars = 8000,
  options: { store?: TaskStore } = {},
) {
  const store = options.store ?? new TaskStore(':memory:')
  const env = environment(store, { dispatch }, maxResultChars)
  const taskId = await planDependent(env, store)
  await settleRound(env, store, taskId)
  return { store, env, taskId, requests: env.requests, subtasks: store.task(actor, taskId)!.subtasks }
}

/**
 * 库里的留存被人为改坏的替身：模拟旧版本写入或人工改库留下的损坏嵌套数据。
 *
 * 每次写入 `member_return` 之后立刻把它改坏，用来验证下游不拿损坏材料派单 ——
 * 真实现里这种数据只会来自库本身，不会从执行方返回值产生（`memberReturnOf` 会先过滤字段）。
 */
class DamagedStore extends TaskStore {
  override setSubtaskState(
    taskId: string,
    subtaskId: string,
    state: SubtaskState,
    patch: Parameters<TaskStore['setSubtaskState']>[3] = {},
  ): void {
    super.setSubtaskState(taskId, subtaskId, state, patch)
    if (patch.memberReturn === undefined) return
    const db = (this as unknown as { db: DatabaseSync }).db
    db.prepare('UPDATE subtasks SET member_return=? WHERE task_id=? AND id=?')
      .run('{"protocol":1,"text":"协作原文正常","externalPending":null}', taskId, subtaskId)
  }
}

/** 一条形状完整的材料来源快照。 */
function refOf(text: string) {
  return { subtaskId: 's1', logicalId: 'g1', state: 'succeeded' as const, text, artifacts: [] }
}

describe('派单材料进入员工实际请求', () => {
  it('上游交回正文后，下游派单 message 里带上原文，并固定成不可变快照', async () => {
    const { store, requests, subtasks } = await runDependentFlow(async request =>
      request.subtaskId === 's1'
        ? { status: 'succeeded' as const, summary: '上游协作原文 A' }
        : { status: 'succeeded' as const, summary: '下游完成' })
    expect(requests).toHaveLength(2)
    // 员工实际收到的 message：整体目标 + 本步 + 可用材料原文。
    expect(requests[1]?.brief).toContain('上游协作原文 A')
    expect(requests[1]?.brief).toContain('可用材料')
    // 派单时固定下来的快照：正文原文与来源。
    const second = subtasks.find(item => item.id === 's2')
    expect(second?.inputRefs?.[0]?.text).toBe('上游协作原文 A')
    expect(second?.inputRefs?.[0]?.logicalId).toBe('g1')
    // 新任务（排队中、从未派过）走的是唯一允许首次固定的那一种。
    expect(second?.inputRefsState).toBe('fixed')
    store.close()
  })

  it('上游只给页面位置（没有正文）时拒绝派单，并如实说明缺什么', async () => {
    const { store, requests, subtasks } = await runDependentFlow(async request =>
      request.subtaskId === 's1'
        ? { status: 'succeeded' as const, summary: '', artifacts: [{ kind: 'draft', title: '在博客查看', path: '/blog?c=1' }] }
        : { status: 'succeeded' as const, summary: '不该被执行' })
    // 下游没有被派出去：员工侧的调用次数停在 1。
    expect(requests).toHaveLength(1)
    const second = subtasks.find(item => item.id === 's2')
    expect(second?.state).toBe('failed')
    expect(second?.error).toContain('只提供页面位置')
    expect(second?.inputRefs).toBeUndefined()
    store.close()
  })

  it('完整派单 message 超过本地保守上限时停止派单，不截断', async () => {
    const { store, requests, subtasks } = await runDependentFlow(async request =>
      request.subtaskId === 's1'
        ? { status: 'succeeded' as const, summary: '长'.repeat(9000) }
        : { status: 'succeeded' as const, summary: '不该被执行' })
    expect(requests).toHaveLength(1)
    const second = subtasks.find(item => item.id === 's2')
    expect(second?.state).toBe('failed')
    expect(second?.error).toContain('超过成员接收上限')
    store.close()
  })

  it('展示摘要被裁剪，但留存的是未裁剪的协作返回原文', async () => {
    const { store, subtasks } = await runDependentFlow(
      async () => ({ status: 'succeeded' as const, summary: '长'.repeat(300) }),
      120,
    )
    const first = subtasks.find(item => item.id === 's1')
    expect(first?.result).toHaveLength(120)
    expect(first?.memberReturn?.text).toHaveLength(300)
    store.close()
  })

  it('库里留存嵌套损坏（正文正常、待办非法）时下游一次都不派，按未知处理', async () => {
    const store = new DamagedStore(':memory:')
    const { requests, subtasks } = await runDependentFlow(async request =>
      request.subtaskId === 's1'
        ? { status: 'succeeded' as const, summary: '协作原文正常' }
        : { status: 'succeeded' as const, summary: '不该被执行' }, 8000, { store })
    expect(requests).toHaveLength(1)
    // 损坏的留存没有被修补成可派单材料：读出来是「未知」。
    expect(subtasks.find(item => item.id === 's1')?.memberReturn).toBeUndefined()
    const second = subtasks.find(item => item.id === 's2')
    expect(second?.state).toBe('failed')
    expect(second?.error).toContain('未知')
    expect(second?.inputRefs).toBeUndefined()
    store.close()
  })
})

describe('存储重开与续问之后的来源', () => {
  /**
   * 第一轮跑到「上游停在等人回话、下游留在队列里」，然后**关库重开**，把管家换到重开后的存储上。
   *
   * 之后每一步材料读取都来自重开后的库（派单前核验走 `store.task`，快照与留存都是重新解析出来的）。
   * 等待上下文本身是内存态、不随库重开变化：这一层不在本用例的验证范围，另有 `重启不会假装能回复`
   * 一条覆盖。
   */
  async function reopenWithQueuedDependent(options: {
    fixDownstreamSnapshot?: boolean
    /** 关库之前直接改库：用来摆出「旧已派出但没留材料」「快照损坏」这类历史形态。 */
    prepare?: (path: string) => void
  } = {}) {
    const path = tempDb()
    const store = new TaskStore(path)
    const env = environment(store, {
      // 第一步停在等人回话：下游这一步留在队列里，等续问之后再核验。
      dispatch: async request => request.subtaskId === 's1'
        ? { status: 'waiting_user' as const, summary: '两版都在', question: '用哪一版？' }
        : { status: 'succeeded' as const, summary: '下游完成' },
      reply: async () => ({
        status: 'succeeded' as const,
        summary: '续问后的新原文',
        externalPending: { reason: '待在原页面采用', next: '采用后继续' },
      }),
    })
    const taskId = await planDependent(env, store)
    await settleRound(env, store, taskId)
    expect(env.requests.map(item => item.subtaskId)).toEqual(['s1'])
    expect(subtaskOf(store, taskId, 's2')?.state).toBe('queued')
    if (options.fixDownstreamSnapshot === true) {
      store.setSubtaskState(taskId, 's2', 'queued', { inputRefs: [refOf('第一次派单时固定的材料')] })
      expect(subtaskOf(store, taskId, 's2')?.inputRefs?.[0]?.text).toBe('第一次派单时固定的材料')
    }
    store.close()
    options.prepare?.(path)

    const reopened = new TaskStore(path)
    ;(env.console_ as unknown as { store: TaskStore }).store = reopened
    return { path, store: reopened, env, taskId }
  }

  /** 续问上游，等下游按「派单前重新核验」给出结论（派出去，或按未知/损坏拒绝）。 */
  async function replyUpstreamAndSettle(r: Awaited<ReturnType<typeof reopenWithQueuedDependent>>) {
    await r.env.console_.startReply({ taskId: r.taskId, subtaskId: 's1', text: '用第一版', decideByAgent: false, actor })
    await until(() => subtaskOf(r.store, r.taskId, 's2')?.state !== 'queued', '下游按重新核验给出结论')
  }

  it('关库重开后，上游外部待办仍随原文进入下游实际派单 message', async () => {
    const r = await reopenWithQueuedDependent()
    await replyUpstreamAndSettle(r)
    // 重开后只派了下游这一步；上游在第一轮已经派过。
    const later = r.env.requests.filter(item => item.subtaskId === 's2')
    expect(later).toHaveLength(1)
    const brief = later[0]?.brief ?? ''
    expect(brief).toContain('续问后的新原文')
    expect(brief).toContain('上游外部待办')
    expect(brief).toContain('待在原页面采用')
    expect(brief).toContain('采用后继续')
    // 来源确实来自重开后的库：上游留存与下游快照都是重新解析出来的那一份。
    expect(subtaskOf(r.store, r.taskId, 's1')?.memberReturn?.text).toBe('续问后的新原文')
    const second = subtaskOf(r.store, r.taskId, 's2')
    expect(second?.inputRefs?.[0]?.text).toBe('续问后的新原文')
    expect(second?.inputRefs?.[0]?.externalPending?.reason).toBe('待在原页面采用')
    expect(second?.inputRefs?.[0]?.externalPending?.next).toBe('采用后继续')
    await settleRound(r.env, r.store, r.taskId)
    r.store.close()
  })

  it('续问更新了上游来源，但下游已从重开后的库里读回固定快照，不被重算的材料顶替', async () => {
    const r = await reopenWithQueuedDependent({ fixDownstreamSnapshot: true })
    await replyUpstreamAndSettle(r)
    const later = r.env.requests.filter(item => item.subtaskId === 's2')
    expect(later).toHaveLength(1)
    const brief = later[0]?.brief ?? ''
    // 员工收到的是这个步骤当时固定下来的材料，不是此刻重算出来的一份。
    expect(brief).toContain('第一次派单时固定的材料')
    expect(brief).not.toContain('续问后的新原文')
    expect(brief).not.toContain('待在原页面采用')
    const second = subtaskOf(r.store, r.taskId, 's2')
    expect(second?.inputRefs?.[0]?.text).toBe('第一次派单时固定的材料')
    // 上游来源确实更新了：变的是来源，不是已经派出去过的那份快照。
    expect(subtaskOf(r.store, r.taskId, 's1')?.memberReturn?.text).toBe('续问后的新原文')
    await settleRound(r.env, r.store, r.taskId)
    r.store.close()
  })

  it('旧已派出但没留材料的步骤不补造历史：不派单，原始空值一个字都没改', async () => {
    // 「旧已派出」= 开始过（`started_at` 有值）而列是空的：这是旧版本留下的未知形态。
    const r = await reopenWithQueuedDependent({ prepare: path => rawRun(path, "UPDATE subtasks SET started_at=1 WHERE id='s2'") })
    await replyUpstreamAndSettle(r)
    const target = subtaskOf(r.store, r.taskId, 's2')
    // 员工侧没有收到这一步的任何派单：上游此刻的原文没有被拿来补一份历史。
    expect(r.env.requests.filter(item => item.subtaskId === 's2')).toHaveLength(0)
    expect(target?.state).toBe('failed')
    expect(target?.error).toContain('未知')
    expect(target?.error).toContain('不补造历史')
    expect(target?.inputRefsState).toBe('unknown')
    expect(target?.inputRefs).toBeUndefined()
    // 原始列还是空的，也没有出现上游此刻的原文。
    expect(rawColumn(r.path, 'input_refs', 's2')).toBe('')
    // 上游这一步本身照常更新，只是没有被当成下游的来源。
    expect(subtaskOf(r.store, r.taskId, 's1')?.memberReturn?.text).toBe('续问后的新原文')
    r.store.close()
  })

  it('目标子任务自身的快照损坏时不派单，损坏原值原样保留', async () => {
    // 目标是 s2 自己：与「上游 member_return 损坏」是两个不同位置。
    const r = await reopenWithQueuedDependent({ prepare: path => rawRun(path, "UPDATE subtasks SET input_refs='{not json' WHERE id='s2'") })
    await replyUpstreamAndSettle(r)
    const target = subtaskOf(r.store, r.taskId, 's2')
    expect(r.env.requests.filter(item => item.subtaskId === 's2')).toHaveLength(0)
    expect(target?.state).toBe('failed')
    expect(target?.error).toContain('损坏')
    expect(target?.inputRefsState).toBe('damaged')
    expect(target?.inputRefs).toBeUndefined()
    // 损坏值原样保留：既没被清空，也没被上游此刻的原文盖掉。
    expect(rawColumn(r.path, 'input_refs', 's2')).toBe('{not json')
    r.store.close()
  })

  it('管家整轮重启后不会假装能回复，但库里那份材料还在', async () => {
    const r = await reopenWithQueuedDependent()
    // 换一个管家实例（等待上下文是内存态，重启后就没了）：续问如实被拒。
    const restarted = environment(r.store, {
      dispatch: async () => ({ status: 'succeeded' as const, summary: '下游完成' }),
      reply: async () => ({ status: 'succeeded' as const, summary: '不该被用上' }),
    })
    await expect(restarted.console_.startReply({
      taskId: r.taskId, subtaskId: 's1', text: '用第一版', decideByAgent: false, actor,
    })).rejects.toThrow('这次等待已经失效')
    expect(restarted.requests).toHaveLength(0)
    // 上游停在哪里、下游还在队列里，都如实留在库里；这一步没有材料快照（它还没被派过）。
    expect(subtaskOf(r.store, r.taskId, 's1')?.state).toBe('waiting_user')
    expect(subtaskOf(r.store, r.taskId, 's2')?.state).toBe('queued')
    expect(subtaskOf(r.store, r.taskId, 's2')?.inputRefs).toBeUndefined()
    r.store.close()
  })
})
