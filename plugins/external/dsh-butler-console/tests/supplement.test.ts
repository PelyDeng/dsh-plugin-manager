/**
 * 补充当前这一轮的目标。
 *
 * 三个入口各管一件事：`/chat` 开新回合、`/reply` 回答成员、`/supplement` 改当前目标。
 * 这里锁住补充特有的几条：
 *
 * 1. 补充改的是**同一轮**：新活追加到原来的任务里，编号接着排，不另开一轮。
 * 2. 「换个说法」与「改了范围」由大总管判断，两条路径都要能走通。
 * 3. 接受不等于处理完成：接口先受理（版本 +1、原文落库），处理完才追平版本。
 * 4. 任务已经结束就明确拒绝，绝不偷偷开一轮新的 —— 那是老板的决定。
 * 5. 正在跑的那一轮不被打断：补充等它到安全点。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole, type ButlerEvent } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { SqliteButlerStorage } from '../src/storage/sqlite-adapter.ts'
import { TaskStore } from '../src/store.ts'

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

/** 一个让子任务停在「等人回话」的执行方：任务因此保持未终结，可以接着补充。 */
const waitingExecutor: ButlerAgentExecutor = {
  protocol: 1,
  agentId: 'blog',
  capabilities: ['写作'],
  dispatch: async () => ({ status: 'waiting_user', summary: '候选稿已交回', question: '采用哪一版？' }),
}

async function fixture(executor: ButlerAgentExecutor = waitingExecutor) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, new SqliteButlerStorage(store), '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, unknown>
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
  const tasks = () => store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' }).items
  return { store, console_, agent, planTool, endTurn, tasks, inner }
}

/** 起一轮任务并派一个活，让它停在「等人回话」。 */
async function startWaiting(f: Awaited<ReturnType<typeof fixture>>) {
  await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
  await until(() => f.agent.followup.mock.calls.length === 1, '大总管开始理解')
  await f.planTool.execute({
    reply: '我先让博客起一版。',
    note: '',
    subtasks: [{ goal: '起草园区封闭化管理介绍', agentId: 'blog', reason: '写作' }],
  }, { signal: new AbortController().signal })
  f.endTurn()
  await until(() => f.tasks().length === 1, '任务落库')
  const taskId = f.tasks()[0]!.id
  await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
  return taskId
}

/**
 * 放掉大总管的一次理解轮。
 *
 * 补充轮与派活轮一样要等 `turn/end`：没有它 `runTurn` 会一直挂着，测试就只会超时。
 * 放在每个用例显式调用，而不是让 `followup` 自动结束 —— 派活那一轮需要在结束**之前**
 * 把计划塞回去。
 */
async function releaseTurn(f: Awaited<ReturnType<typeof fixture>>, expected: number, label: string) {
  await until(() => f.agent.followup.mock.calls.length >= expected, label)
  f.endTurn()
}

describe('补充改的是同一轮', () => {
  it('受理时版本加一、原文落库，处理完才追平', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)
    expect(f.store.task(actor, taskId)).toMatchObject({ acceptedVersion: 1, processedVersion: 1 })

    const run = f.console_.submitSupplement({ taskId, text: '标题再短一点', actor })
    // 受理是立刻的：版本先加一，处理还在后头。
    await until(() => f.store.task(actor, taskId)!.acceptedVersion === 2, '版本加一')
    await releaseTurn(f, 2, '补充轮开始')
    await run
    await until(() => f.store.task(actor, taskId)!.processedVersion === 2, '补充处理完')

    // 原文留着：汇总要能核对最新一条到底说了什么，只存版本号不够。
    expect(f.store.inputs(taskId).map(item => [item.version, item.source, item.text])).toEqual([
      [1, 'chat', '写一篇园区封闭化管理介绍'],
      [2, 'supplement', '标题再短一点'],
    ])
    f.store.close()
  })

  it('只改表达时不重复派活，任务仍是原来那一轮', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)
    const run = f.console_.submitSupplement({ taskId, text: '标题再短一点', actor })
    await releaseTurn(f, 2, '补充轮开始')
    await run
    await until(() => f.store.task(actor, taskId)!.processedVersion === 2, '补充处理完')

    // 没有新子任务：换个说法不该再派一次活。
    expect(f.store.task(actor, taskId)!.subtasks).toHaveLength(1)
    // 还是同一个任务，没有被拆成两轮。
    expect(f.tasks()).toHaveLength(1)
    expect(f.store.task(actor, taskId)!.processedVersion).toBe(2)
    f.store.close()
  })

  it('改了范围时新活追加到同一个任务里，编号接着排', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)

    const run = f.console_.submitSupplement({ taskId, text: '再加一份配图说明', actor })
    // 补充轮同样走理解：这次它交回一份新的计划。
    await until(() => f.agent.followup.mock.calls.length >= 2, '补充轮开始')
    await f.planTool.execute({
      reply: '好，我再让博客补一份配图说明。',
      note: '',
      subtasks: [{ goal: '起草配图说明', agentId: 'blog', reason: '写作' }],
    }, { signal: new AbortController().signal })
    f.endTurn()
    await run
    await until(() => f.store.task(actor, taskId)!.subtasks.length === 2, '新活追加进来')

    const record = f.store.task(actor, taskId)!
    // 追加而不是另开一轮：任务还是那一个，编号接着原有的往下排。
    expect(f.tasks()).toHaveLength(1)
    expect(record.subtasks.map(item => item.id)).toEqual(['s1', 's2'])
    expect(record.subtasks[1]!.goal).toBe('起草配图说明')
    expect(record.acceptedVersion).toBe(2)
    f.store.close()
  })
})

describe('补充的边界', () => {
  it('任务已经结束就拒绝，且不偷偷开一轮新的', async () => {
    // 这一位干完就交差：任务跑成终态。
    const done: ButlerAgentExecutor = {
      protocol: 1, agentId: 'blog', capabilities: ['写作'],
      dispatch: async () => ({ status: 'succeeded', summary: '写好了' }),
    }
    const f = await fixture(done)
    await f.console_.start(conversationId, '写一篇园区推广稿', actor)
    await until(() => f.agent.followup.mock.calls.length === 1, '开始理解')
    await f.planTool.execute({
      reply: '这就安排。', note: '',
      subtasks: [{ goal: '起草推广稿', agentId: 'blog', reason: '写作' }],
    }, { signal: new AbortController().signal })
    f.endTurn()
    await until(() => f.tasks().length === 1, '任务落库')
    const taskId = f.tasks()[0]!.id
    // 子任务交差之后还会跑一轮汇总，那一轮也要放掉才会落到终态。
    let released = false
    await until(() => {
      const state = f.store.task(actor, taskId)!.state
      if (state === 'summarizing' && !released) { released = true; f.endTurn(); return false }
      return state !== 'running' && state !== 'summarizing'
    }, '这一轮收尾')

    await expect(f.console_.submitSupplement({ taskId, text: '再改一版', actor }))
      .rejects.toMatchObject({ reason: 'task_already_finished', status: 409 })
    // 拒绝就是拒绝：不因为改不了旧任务就顺手开一个新的。
    expect(f.tasks()).toHaveLength(1)
    expect(f.store.task(actor, taskId)!.acceptedVersion).toBe(1)
    f.store.close()
  })

  it('版本对不上时拒绝，并告诉客户端现在是第几版', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)
    await expect(f.console_.submitSupplement({ taskId, text: '改一下', actor, expectVersion: 99 }))
      .rejects.toMatchObject({ reason: 'version_conflict', status: 409 })
    // 被拒的那条不该留下痕迹。
    expect(f.store.task(actor, taskId)!.acceptedVersion).toBe(1)
    f.store.close()
  })

  it('别人的任务碰不到', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)
    await expect(f.console_.submitSupplement({
      taskId, text: '改一下', actor: { namespace: 'user', userId: 'bob', sessionId: 'bob-login' },
    })).rejects.toMatchObject({ reason: 'task_not_found', status: 404 })
    f.store.close()
  })

  it('同一个 requestId 重复提交不会处理两遍', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)
    const request = { taskId, text: '标题再短一点', actor, requestId: 'sup-1' }

    const first = await f.console_.submitSupplement(request)
    await releaseTurn(f, 2, '补充轮开始')
    await until(() => f.store.task(actor, taskId)!.processedVersion === 2, '第一次处理完')
    const retry = await f.console_.submitSupplement(request)

    expect(retry.runId).toBe(first.runId)
    expect(f.store.task(actor, taskId)!.acceptedVersion).toBe(2)
    expect(f.store.inputs(taskId)).toHaveLength(2)
    f.store.close()
  })
})

describe('补充不打断正在跑的那一轮', () => {
  it('等当前这一轮跑到安全点再动', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)

    // 再起一轮（**不**结束它），让会话处于「正在跑」。
    await f.console_.start(conversationId, '顺便看看通行记录', actor)
    await until(() => f.agent.followup.mock.calls.length >= 2, '新一轮开始理解')

    const run = f.console_.submitSupplement({ taskId, text: '标题再短一点', actor })
    await until(() => f.store.task(actor, taskId)!.acceptedVersion === 2, '受理完成')
    // 受理是立刻的，处理还没轮到：正在跑的那一轮不该被补充打断。
    expect(f.store.task(actor, taskId)!.processedVersion).toBe(1)

    // 把正在跑的那一轮放掉，补充这才开始处理。
    f.endTurn()
    await releaseTurn(f, 3, '补充轮开始')
    await run
    await until(() => f.store.task(actor, taskId)!.processedVersion === 2, '补充处理完')
    f.store.close()
  })
})

/** 事件流里收集起来便于断言。 */
async function collect(events: AsyncGenerator<{ event: ButlerEvent }>): Promise<ButlerEvent[]> {
  const seen: ButlerEvent[] = []
  for await (const logged of events) seen.push(logged.event)
  return seen
}

describe('补充对外的事件', () => {
  it('先告诉老板「收到了」，再说处理到哪一步', async () => {
    const f = await fixture()
    const taskId = await startWaiting(f)
    const started = await f.console_.submitSupplement({ taskId, text: '标题再短一点', actor })
    const watched = (await f.console_.watch(started.conversationId, actor, started.from))!
    const reading = collect(watched.events)
    await releaseTurn(f, 2, '补充轮开始')
    const seen = await reading

    // 第一条就是「收到了」：处理可能还要等，但老板该立刻知道话没丢。
    expect(seen[0]).toMatchObject({ type: 'input', taskId, version: 2, source: 'supplement' })
    expect(seen.some(event => event.type === 'chat')).toBe(true)
    f.store.close()
  })
})
