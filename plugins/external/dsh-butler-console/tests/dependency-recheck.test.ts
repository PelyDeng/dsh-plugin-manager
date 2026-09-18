/**
 * 安全重试后的依赖重判（依赖重判方案 §3.6 的五条反例）。
 *
 * 走真实的 `ButlerConsole` 调用链（补充轮 / 等待超时 / 补话收尾），只把宿主 Agent、执行方
 * 和登录换成替身。前两组用例的起点是**直接落库**的「上游已失败、下游还排队」任务：那是
 * 旧版本等待超时路径遗留的悬空形态，也正是这批改动要消除的东西；用夹具摆出来，是为了证明
 * 补充路径现在会把它的依赖重判传导下去，而不是继续等老板人工过问。
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor, ButlerDispatchRequest } from '../src/protocol.ts'
import type { ButlerMemberReturn } from '../src/storage/types.ts'
import { advanceSubtask, SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
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

/** 一套完整运行环境：替身执行方（记录派单请求）、真实 SQLite 索引、注册好的派活工具。 */
async function fixture(executor: ButlerAgentExecutor, options: { waitingTimeoutMs?: number } = {}) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: options.waitingTimeoutMs ?? 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, new SqliteButlerStorage(store), '')
  // 后台那一轮要在关库之前收干净（受理类接口先返回凭据、后台继续跑），否则测试日志里会
  // 留下一串数据库已关闭的噪音，掩盖真正的存储故障。
  const background: Promise<unknown>[] = []
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, unknown>
    pump: (...args: never[]) => Promise<void>
    waitingTimers: Map<string, ReturnType<typeof setTimeout>>
  }
  const realPump = inner.pump.bind(console_)
  inner.pump = (...args: never[]) => {
    const running = realPump(...args)
    background.push(running.catch(() => {}))
    return running
  }
  const settleAll = async () => {
    for (let attempt = 0; attempt < 50 && background.length > 0; attempt += 1) {
      await Promise.allSettled(background.splice(0))
    }
    store.close()
  }
  vi.spyOn(console_, 'open').mockImplementation(async (requestedId?: string) => {
    store.openOrReserveConversation(String(requestedId), actor)
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
  const endTurn = () => {
    console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
  }
  const record = () => store.task(actor, taskIdOf(store))
  return { store, console_, agent, planTool, endTurn, settleAll, inner }
}

/** 目前库里唯一的任务 id（每个用例只起一个任务）。 */
function taskIdOf(store: TaskStore): string {
  return store.history(actor, { offset: 0, limit: 1, keyword: '', state: '' }).items[0]!.id
}

/** 一套装好的运行环境。 */
type Fixture = Awaited<ReturnType<typeof fixture>>

/** 等计划落库（真实链路里这一步在后台回合中完成）。 */
async function taskCreated(f: Fixture): Promise<string> {
  await until(() => f.store.history(actor, { offset: 0, limit: 1, keyword: '', state: '' }).items.length === 1, '任务落库')
  return taskIdOf(f.store)
}

const subtaskOf = (f: Fixture, id: string) =>
  f.store.task(actor, taskIdOf(f.store))?.subtasks.find(item => item.id === id)

/** 记录全部派单请求、按子任务给固定结论的执行方。 */
function recordingExecutor(bySubtask: Record<string, () => Promise<{ status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_user'; summary: string; question?: string }>>) {
  const requests: ButlerDispatchRequest[] = []
  const executor: ButlerAgentExecutor = {
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async request => {
      requests.push(request)
      const handler = bySubtask[request.subtaskId] ?? (() => Promise.resolve({ status: 'succeeded' as const, summary: `${request.subtaskId} 做好了` }))
      return await handler()
    },
  }
  return { executor, requests }
}

/** 直接落库一份「s1 起草、s2 校对依赖 s1」的两步计划，任务停在 running。 */
function twoStepTask(store: TaskStore): string {
  const taskId = `butler-task-${randomUUID()}`
  store.openOrReserveConversation(conversationId, actor)
  store.createTask({
    id: taskId, conversationId, actor, goal: '写一篇园区封闭化管理介绍', note: '',
    subtasks: [
      { id: 's1', goal: '起草', agentId: 'blog', reason: '', logicalId: 'g1' },
      { id: 's2', goal: '校对', agentId: 'blog', reason: '', logicalId: 'g2', dependsOn: ['g1'] },
    ],
  })
  return taskId
}

/** 摆出旧版本等待超时路径遗留的悬空形态：上游已判失败，下游还停在队列里。 */
async function danglingFixture(bySubtask: Parameters<typeof recordingExecutor>[0]) {
  const { executor, requests } = recordingExecutor(bySubtask)
  const f = await fixture(executor)
  const taskId = twoStepTask(f.store)
  f.store.setSubtaskState(taskId, 's1', 'failed', { error: '第一次没干成' })
  return { f, taskId, requests }
}

/** 交给用例的计划提交回调：参数是「执行派活工具」的函数，返回它的受理结果。 */
type SubmitPlan = (execute: (args: unknown) => Promise<unknown>) => Promise<unknown>

/** 受理一条补充并等它处理完（理解轮与后续可能的汇总轮都要放掉）。 */
async function runSupplement(f: Fixture, plan?: SubmitPlan) {
  const taskId = taskIdOf(f.store)
  await f.console_.submitSupplement({ taskId, text: plan === undefined ? '继续推进' : '按新要求调整', actor })
  await until(() => f.agent.followup.mock.calls.length >= 1, '补充轮开始')
  if (plan !== undefined) await plan(args => f.planTool.execute(args, { signal: new AbortController().signal }))
  f.endTurn()
  // 排空与收尾在后台继续；需要汇总轮时（followup 第二次被调用）再放掉它。
  let released = false
  await until(() => {
    if (f.agent.followup.mock.calls.length >= 2 && !released) {
      released = true
      f.endTurn()
      return false
    }
    return f.store.task(actor, taskId)!.state !== 'running' && f.store.task(actor, taskId)!.state !== 'summarizing'
  }, '补充收尾')
  return taskId
}

describe('安全重试形态：supersedes 新行触发下游重判', () => {
  it('上游 failed 后补充轮声明 supersedes 新尝试成功，排队的下游重判后照常派单', async () => {
    const { f, requests } = await danglingFixture({
      s3: () => Promise.resolve({ status: 'succeeded', summary: '重做后的协作原文' }),
      s2: () => Promise.resolve({ status: 'succeeded', summary: '校对完成' }),
    })
    const taskId = taskIdOf(f.store)
    await runSupplement(f, execute => execute({
      reply: '起草没干成，我让人重做一遍。',
      note: '',
      subtasks: [{ goal: '起草（重做）', agentId: 'blog', reason: '重写', logicalId: 'g1', supersedes: 's1' }],
    }))

    // 安全重试形态固定为 supersedes 新行：新尝试沿用目标 g1、指向旧尝试 s1，旧行原样留在历史里。
    const record = f.store.task(actor, taskId)!
    expect(record.subtasks.map(item => [item.id, item.logicalId, item.supersedes, item.state])).toEqual([
      ['s1', 'g1', '', 'failed'],
      ['s2', 'g2', '', 'succeeded'],
      ['s3', 'g1', 's1', 'succeeded'],
    ])
    // 下游确实被重新派了出去：先派新尝试，再派重判放行的校对。
    expect(requests.map(item => item.subtaskId)).toEqual(['s3', 's2'])
    // 派单材料来自新尝试的协作返回原文（判定与交付同一真值）。
    const second = record.subtasks.find(item => item.id === 's2')!
    expect(second.inputRefs?.[0]).toMatchObject({ subtaskId: 's3', logicalId: 'g1', text: '重做后的协作原文' })
    // 被替代的旧失败不参与结论：这一轮按有效尝试收成完成。
    expect(record.state).toBe('completed')
    await f.settleAll()
  })
})

describe('材料真值统一到协作返回原文', () => {
  it('result 非空但没有协作返回原文时，上游判 succeeded 也不放行（口径统一的反向反例）', async () => {
    const { executor, requests } = recordingExecutor({})
    const f = await fixture(executor)
    const taskId = twoStepTask(f.store)
    // 展示摘要有值、协作返回原文缺失：旧版本记录的形态。判定真值是 memberReturn，不看 result。
    f.store.setSubtaskState(taskId, 's1', 'dispatched')
    f.store.setSubtaskState(taskId, 's1', 'succeeded', { result: '展示摘要' })
    await runSupplement(f)

    const record = f.store.task(actor, taskId)!
    expect(requests.map(item => item.subtaskId)).toEqual([])
    const second = record.subtasks.find(item => item.id === 's2')!
    expect(second.state).toBe('failed')
    expect(second.error).toContain('前置没有完成')
    expect(second.error).toContain('未知')
    await f.settleAll()
  })

  it('memberReturn 有正文而 result 与 artifacts 皆空时，上游算就绪、下游放行（口径统一的正向反例）', async () => {
    const { executor, requests } = recordingExecutor({
      s2: () => Promise.resolve({ status: 'succeeded', summary: '校对完成' }),
    })
    const f = await fixture(executor)
    const taskId = twoStepTask(f.store)
    // 协作返回原文有正文，但展示摘要与位置型材料全空：判定真值只看 memberReturn。
    f.store.setSubtaskState(taskId, 's1', 'dispatched')
    const memberReturn: ButlerMemberReturn = { protocol: 1, text: '协作返回原文' }
    f.store.setSubtaskState(taskId, 's1', 'succeeded', { memberReturn })
    expect(f.store.task(actor, taskId)?.subtasks.find(item => item.id === 's1')).toMatchObject({
      state: 'succeeded', result: '', artifacts: [], memberReturn: { text: '协作返回原文' },
    })
    await runSupplement(f)

    // 下游被派出去，材料原文进入员工实际收到的派单 message。
    expect(requests.map(item => item.subtaskId)).toEqual(['s2'])
    expect(requests[0]?.brief).toContain('协作返回原文')
    const record = f.store.task(actor, taskId)!
    expect(record.subtasks.find(item => item.id === 's2')?.inputRefs?.[0]).toMatchObject({
      subtaskId: 's1', logicalId: 'g1', text: '协作返回原文',
    })
    expect(record.state).toBe('completed')
    await f.settleAll()
  })
})

describe('补充路径派完触发排空', () => {
  it('补充追加与依赖无关的新活后，排队的下游被结账，不再悬空', async () => {
    const { f, requests } = await danglingFixture({
      s3: () => Promise.resolve({ status: 'succeeded', summary: '配图说明好了' }),
    })
    const taskId = taskIdOf(f.store)
    await runSupplement(f, execute => execute({
      reply: '再补一份配图说明。',
      note: '',
      subtasks: [{ goal: '配图说明', agentId: 'blog', reason: '写作' }],
    }))

    // 下游没有被派出去（前置仍是那次失败），但状态被传导成失败，不再永远排队。
    expect(requests.map(item => item.subtaskId)).toEqual(['s3'])
    const record = f.store.task(actor, taskId)!
    const second = record.subtasks.find(item => item.id === 's2')!
    expect(second.state).toBe('failed')
    expect(second.error).toContain('前置没有完成')
    expect(second.error).toContain('g1')
    // 一部分成、一部分没成：任务拿到终态结论，悬空的排队步骤不复存在。
    expect(record.state).toBe('partial')
    await f.settleAll()
  })
})

describe('等待超时后排队下游被结账', () => {
  it('上游等待超时判 failed 后，排队下游随之失败并写明原因，任务收尾', async () => {
    const { executor, requests } = recordingExecutor({
      s1: () => Promise.resolve({ status: 'waiting_user', summary: '候选稿两版都在', question: '采用哪一版？' }),
    })
    const f = await fixture(executor, { waitingTimeoutMs: 120 })
    // 走真实链路摆出悬空前置：s1 停在等人回话，s2 因为 g1 没终结留在队列里。
    await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
    await f.planTool.execute({
      reply: '先起一版，写完给你过目。',
      note: '',
      subtasks: [
        { goal: '起草', agentId: 'blog', reason: '', logicalId: 'g1' },
        { goal: '校对', agentId: 'blog', reason: '', logicalId: 'g2', dependsOn: ['g1'] },
      ],
    }, { signal: new AbortController().signal })
    f.endTurn()
    const taskId = await taskCreated(f)
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    expect(subtaskOf(f, 's2')?.state).toBe('queued')

    // 到点：上游收成超时失败，下游在同一收尾里被结账，而不是悬空到下一次人工过问。
    await until(() => subtaskOf(f, 's1')?.state === 'failed', '等待超时')
    await until(() => subtaskOf(f, 's2')?.state !== 'queued', '下游被结账')

    expect(requests.map(item => item.subtaskId)).toEqual(['s1'])
    const second = subtaskOf(f, 's2')!
    expect(second.state).toBe('failed')
    expect(second.error).toContain('前置没有完成')
    expect(second.error).toContain('g1')
    const record = f.store.task(actor, taskId)!
    expect(record.state).toBe('failed')
    expect(record.finishedAt).not.toBeNull()
    await f.settleAll()
  })

  it('超时的上游不是它的前置时，下游保持排队如实挂起，任务按既有规则处理', async () => {
    const { executor, requests } = recordingExecutor({
      s1: () => Promise.resolve({ status: 'waiting_user', summary: '正文候选稿', question: '这版可以吗？' }),
      s2: () => Promise.resolve({ status: 'waiting_user', summary: '配图候选稿', question: '用哪张？' }),
    })
    const f = await fixture(executor, { waitingTimeoutMs: 150 })
    await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
    await f.planTool.execute({
      reply: '正文和配图各起一版，再一起校对。',
      note: '',
      subtasks: [
        { goal: '起草正文', agentId: 'blog', reason: '', logicalId: 'g1' },
        { goal: '起草配图说明', agentId: 'blog', reason: '', logicalId: 'g2' },
        { goal: '校对', agentId: 'blog', reason: '', logicalId: 'g3', dependsOn: ['g2'] },
      ],
    }, { signal: new AbortController().signal })
    f.endTurn()
    const taskId = await taskCreated(f)
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    // 只让 s1 的等待到点：撤掉 s2 的闹钟，模拟「另一位成员还在等人回话」的常态。
    const key = `${taskId}:s2`
    const timer = f.inner.waitingTimers.get(key)
    if (timer === undefined) throw new Error('s2 的等待闹钟没有登记')
    clearTimeout(timer)
    f.inner.waitingTimers.delete(key)

    await until(() => subtaskOf(f, 's1')?.state === 'failed', 's1 等待超时')
    // 前置 g2 还在等人回话：校对这一步保持排队、不判失败，也不占员工。
    expect(requests.map(item => item.subtaskId)).toEqual(['s1', 's2'])
    expect(subtaskOf(f, 's2')?.state).toBe('waiting_user')
    const third = subtaskOf(f, 's3')!
    expect(third.state).toBe('queued')
    expect(third.error).toBe('')
    // 任务状态按既有规则：还有非终态子任务，不强行结账。
    expect(f.store.task(actor, taskId)?.state).toBe('waiting_user')
    await f.settleAll()
  })
})

/**
 * R9：等待超时的收尾判定必须与 `closeTask` 共用同一份实现。
 *
 * 这一组用例存在的理由：既有的两条真跑 `expireWaiting` 的用例（本文件上一组的
 * `上游等待超时判 failed 后…` 与 `reply-close.test.ts` 的 `到点收成超时失败…`）都落在
 * 「全部失败 ⇒ `failed`」这一格 —— 两份实现在这一格上答案相同，所以只做合并、不加用例时，
 * 「合并接线了」与「合并没有接线」不可区分。
 *
 * 下面两条按**设计该有的行为**写断言（§5.4 终态规则：被停止 / 有取消 ⇒ `cancelled`；
 * 还有已接受未处理的输入 ⇒ 先不结账），不按现状写。
 */
describe('等待超时的终态判定与收尾共用一份实现', () => {
  it('子任务里有取消的：超时收尾仍按停止收成 cancelled，不改写成部分完成', async () => {
    const { executor } = recordingExecutor({
      s1: () => Promise.resolve({ status: 'cancelled', summary: '第一位已经不干了' }),
      s2: () => Promise.resolve({ status: 'waiting_user', summary: '配图候选稿都在这里', question: '用哪一张？' }),
    })
    // 超时给得比别处长：要在闹钟响之前先读出「这一轮自己已经按停止收尾」。
    const f = await fixture(executor, { waitingTimeoutMs: 500 })
    await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
    await f.planTool.execute({
      reply: '两个人各起一版。',
      note: '',
      subtasks: [
        { goal: '起草正文', agentId: 'blog', reason: '', logicalId: 'g1' },
        { goal: '起草配图说明', agentId: 'blog', reason: '', logicalId: 'g2' },
      ],
    }, { signal: new AbortController().signal })
    f.endTurn()
    const taskId = await taskCreated(f)

    // 一位被取消、一位在等人回话：这一轮自己的收尾按「子任务里有取消的同样按停止处理」写 cancelled。
    await until(() => f.store.task(actor, taskId)?.state === 'cancelled', '这一轮按停止收尾')
    await until(() => subtaskOf(f, 's2')?.state === 'waiting_user', 's2 停在等人回话')
    expect(subtaskOf(f, 's1')?.state).toBe('cancelled')
    const closedAt = f.store.task(actor, taskId)!.updatedAt

    // 等待到点：s2 收成超时失败。收尾判定仍然要看得到那条已取消的子任务 ⇒ 结论还是 cancelled。
    // 重复实现那一份只数失败数（1 失败 / 2 条）⇒ partial，把已经写下的结论改掉。
    await until(() => subtaskOf(f, 's2')?.state === 'failed', 's2 等待超时')
    await until(() => f.store.task(actor, taskId)!.updatedAt > closedAt, '超时收尾写回任务')
    expect(f.store.task(actor, taskId)!.state).toBe('cancelled')
    await f.settleAll()
  })

  it('还有已接受未处理的输入：超时收尾先不结账，不改写成部分完成', async () => {
    const { executor } = recordingExecutor({
      s1: () => Promise.resolve({ status: 'succeeded', summary: '正文写好了' }),
      s2: () => Promise.resolve({ status: 'waiting_user', summary: '配图候选稿都在这里', question: '用哪一张？' }),
    })
    const f = await fixture(executor, { waitingTimeoutMs: 600 })
    await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
    await f.planTool.execute({
      reply: '两个人各起一版。',
      note: '',
      subtasks: [
        { goal: '起草正文', agentId: 'blog', reason: '', logicalId: 'g1' },
        { goal: '起草配图说明', agentId: 'blog', reason: '', logicalId: 'g2' },
      ],
    }, { signal: new AbortController().signal })
    f.endTurn()
    const taskId = await taskCreated(f)
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')

    // 老板刚补了一句：已接受、还没轮到处理。受理补充与收尾是两条异步路径，这一格能构造出来。
    f.store.addInput(actor, taskId, '配图改成夜间的', 'supplement')

    // 到点：s2 收成超时失败（子任务自己那一步照常结账），但这一轮**不能**就此结账 ——
    // 按旧范围给结论等于把刚改的目标丢掉，留给那条输入自己的回合收尾。
    await until(() => subtaskOf(f, 's2')?.state === 'failed', 's2 等待超时')
    await new Promise(resolve => setTimeout(resolve, 60))
    const record = f.store.task(actor, taskId)!
    expect({
      state: record.state, accepted: record.acceptedVersion, processed: record.processedVersion,
    }).toEqual({ state: 'waiting_user', accepted: 2, processed: 1 })
    await f.settleAll()
  })

  it('有材料交回、事情在别处办：超时收尾写 external_pending，不改判成部分完成', async () => {
    // `external_pending` 是**终态**（`task-model.ts` 的 `isTerminal`）：`expireWaiting` 开头那道
    // 「还有人没终结就返回」的守卫**挡不住它**，所以这一格真的会走到终态判定里来。
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async request => (request.subtaskId === 's1'
        ? {
          status: 'external_pending' as const,
          summary: '候选稿已交回，等你去页面采用',
          externalPending: { reason: '去博客页面采用这一版' },
        }
        : { status: 'waiting_user' as const, summary: '配图候选稿都在这里', question: '用哪一张？' }),
    }
    const f = await fixture(executor, { waitingTimeoutMs: 600 })
    await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
    await f.planTool.execute({
      reply: '一位先交回材料，一位等你定。',
      note: '',
      subtasks: [
        { goal: '起草正文', agentId: 'blog', reason: '', logicalId: 'g1' },
        { goal: '起草配图说明', agentId: 'blog', reason: '', logicalId: 'g2' },
      ],
    }, { signal: new AbortController().signal })
    f.endTurn()
    const taskId = await taskCreated(f)

    // 有人等着回话时，这一轮先停在 waiting_user（等用户回话优先于外部待办）。
    await until(() => subtaskOf(f, 's2')?.state === 'waiting_user', 's2 停在等人回话')
    expect(subtaskOf(f, 's1')?.state).toBe('external_pending')
    expect(f.store.task(actor, taskId)?.state).toBe('waiting_user')

    // 到点：结论按判定表走 —— 还有材料在别处办 ⇒ external_pending，而不是按失败数算出来的 partial。
    await until(() => subtaskOf(f, 's2')?.state === 'failed', 's2 等待超时')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(f.store.task(actor, taskId)!.state).toBe('external_pending')
    await f.settleAll()
  })
})

describe('前置声明损坏', () => {
  it('depends_on 读不出来时拒派，原始值原样保留', async () => {
    const { executor, requests } = recordingExecutor({
      s1: () => Promise.resolve({ status: 'waiting_user', summary: '候选稿两版都在', question: '采用哪一版？' }),
    })
    const executorWithReply: ButlerAgentExecutor = {
      ...executor,
      reply: async () => ({ status: 'succeeded', summary: '已按第二版定稿，正文与配图说明一并交付。' }),
    }
    const f = await fixture(executorWithReply)
    await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
    await f.planTool.execute({
      reply: '先起一版，写完给你过目。',
      note: '',
      subtasks: [
        { goal: '起草', agentId: 'blog', reason: '', logicalId: 'g1' },
        { goal: '校对', agentId: 'blog', reason: '', logicalId: 'g2', dependsOn: ['g1'] },
      ],
    }, { signal: new AbortController().signal })
    f.endTurn()
    const taskId = await taskCreated(f)
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    // 直插坏 JSON：模拟旧版本写入或人工改库留下的损坏前置声明。
    const db = (f.store as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.prepare("UPDATE subtasks SET depends_on='{not json' WHERE task_id=? AND id='s2'").run(taskId)

    // 老板答复上游、上游成功收尾：排空队列时下游被核验 —— 损坏即拒，不降级成「没有前置」。
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '采用第二版', decideByAgent: false, actor })
    await until(() => f.agent.followup.mock.calls.length >= 2, '汇总轮开始')
    f.endTurn()
    await until(() => {
      const state = f.store.task(actor, taskId)!.state
      return state !== 'running' && state !== 'summarizing' && state !== 'waiting_user'
    }, '这一轮收尾')

    expect(requests.map(item => item.subtaskId)).toEqual(['s1'])
    const second = subtaskOf(f, 's2')!
    expect(second.state).toBe('failed')
    expect(second.error).toContain('前置声明')
    expect(second.error).toContain('损坏')
    // 原始值一个字都没改：既没被清空，也没被修补成合法列表。
    const raw = db.prepare("SELECT depends_on AS value FROM subtasks WHERE task_id=? AND id='s2'").get(taskId) as unknown as { value: string }
    expect(raw.value).toBe('{not json')
    expect(second.dependsOnState).toBe('damaged')
    await f.settleAll()
  })
})

/**
 * 老板办掉一张确认卡之后，**等它的下游要自动接上**。
 *
 * ## 现场（2026-09-18）
 *
 * 一次「把这六篇草稿删掉」被拆成了 g1→g2→…→g6 一条链。g1 停在"等你确认"时，后五步全被判成
 * `failed`（就绪表里 `external_pending + requiresExternalAction` 那一行当时写的是 `fail`）。
 * 老板点掉第一张卡之后，**没有人回头看那五步** —— 它们永远停在失败，只能重新派活。
 *
 * 这条判据压两件事：
 * 1. 上游停在"等你确认"时，下游**排队等**（判失败不在选项里 —— 老板随时能点掉它）；
 * 2. 老板点掉确认、上游结账之后，**依赖重判真的被跑了一遍**，下游被派出去。
 */
describe('老板办掉确认之后，排队等它的下游自动接上', () => {
  const actionId = 'op-delete-1'

  it('上游停在等你确认：下游排队等（不判失败）；点掉确认后下游被派出', async () => {
    const { executor, requests } = recordingExecutor({
      s2: () => Promise.resolve({ status: 'succeeded' as const, summary: '第二篇也删掉了' }),
    })
    // 执行方要支持"就地确认"（老板在卡片上点的那一下）。
    ;(executor as { applyAction?: unknown }).applyAction = async () => ({ status: 'succeeded' as const, summary: '已按你确认的办了' })
    const f = await fixture(executor)
    const taskId = `butler-task-${randomUUID()}`
    f.store.openOrReserveConversation(conversationId, actor)
    f.store.createTask({
      id: taskId, conversationId, actor, goal: '删掉这两篇草稿', note: '',
      subtasks: [
        { id: 's1', goal: '删第一篇', agentId: 'blog', reason: '', logicalId: 'g1' },
        { id: 's2', goal: '删第二篇', agentId: 'blog', reason: '', logicalId: 'g2', dependsOn: ['g1'], requiresExternalAction: true },
      ],
    })
    // s1 已经跑到"等你确认"：材料交回了，并挂着一条待确认操作。
    // （走合法路径推过去：真实生命周期一定先写 `dispatched`，替身与生产同一份写入白名单。）
    advanceSubtask(f.store, taskId, 's1', 'external_pending', {
      result: '确认卡片已生成，等你点确认。',
      memberReturn: {
        protocol: 1,
        text: '确认卡片已生成，等你点确认。',
        actions: [{ id: actionId, kind: 'blog.delete', title: '删除文章', summary: '确认后永久删除这篇文章', state: 'prepared' }],
      },
    })

    // ① 排空队列：这一步该**等**，不该被判死。
    const drainQueue = (f.console_ as unknown as {
      drainQueue(input: { taskId: string; actor: Actor; goal: string; signal: AbortSignal }): AsyncGenerator<unknown>
    }).drainQueue.bind(f.console_)
    for await (const _event of drainQueue({ taskId, actor, goal: '删掉这两篇草稿', signal: new AbortController().signal })) { /* 无观众 */ }

    expect(subtaskOf(f, 's2')?.state, '上游只是等老板点确认，下游却被判死了').toBe('queued')
    expect(requests.some(item => item.subtaskId === 's2'), '上游还没办完，下游不该被派出去').toBe(false)

    // ② 老板点确认 → 上游结账 → 依赖重判 → 下游自动接上。
    await f.console_.startAction({ taskId, subtaskId: 's1', actionId, decision: 'confirm', actor })
    /**
     * 先验**上游的结账真的落到了库里**。
     *
     * 这一步写不进去时（迁移不合法 ⇒ 条件 UPDATE 影响 0 行），后面那句"等下游"会一直等下去，
     * 报出来只是一句超时 —— 现场是 2026-09-18 的生产：老板点掉确认卡，库里那一步还是
     * `external_pending`，等它的下游永远留在队列里。先钉住这一条，失败原因才指得准。
     */
    await until(() => subtaskOf(f, 's1')?.state === 'succeeded', '上游办完之后写成 succeeded')
    await until(() => requests.some(item => item.subtaskId === 's2'), '下游被派出去')
    await until(() => subtaskOf(f, 's2')?.state === 'succeeded', '下游干完')
    expect(subtaskOf(f, 's1')?.state).toBe('succeeded')
    await f.settleAll()
  })
})
