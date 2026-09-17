/**
 * 验收口径（`acceptance`）的贯通与防套话。
 *
 * 口径是「交回什么才算完成」，它决定两件事：执行方要不要按它自检，以及协调方能不能核验
 * 「口径里提到的产出物有没有真的交回」。所以这里有两条独立的断言线：
 *
 * 1. **贯通**：`butler_plan` 的工具参数 → 落库 → 派单/续问的请求，一路都不能掉字段。
 *    断言落在**执行方收到的请求**上，而不是中间某次调用上：从工具到执行方之间有两处逐字段
 *    重建（落库映射、派单构造），漏传一个可选字段既不报错、也不影响别的字段，只看其中一跳
 *    的 spy 是看不见的。
 * 2. **防套话**：模型很容易用「完成即可」把口径敷衍过去。那种口径在核验阶段没有任何可对照
 *    的东西，**比没有口径更危险**——它会让「口径提到的产出物必须交回」那条校验假装有依据。
 *    所以写入时就拒绝，并给模型一句能照着改的话。
 *
 * 会话打开与执行泵用替身：这里测的是口径的落库与传递，不测模型怎么执行。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole, REPLAY_REJECTED_PREFIX, dispatchFailureDetail, reportOf } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const run = { signal: new AbortController().signal }

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await tick()
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

/**
 * 记录每一次派单与续问收到的请求；这是「字段有没有真的到执行方」的唯一取证点。
 *
 * 派单一律回 `waiting_user`：这一轮因此停在「等人回话」，不会进入汇总轮。汇总是另一轮
 * 模型调用，替身不产生它 —— 用 `succeeded` 会让执行泵一直等着那个不会来的回合，
 * 用例收尾时关不掉库。
 */
function recordingExecutor() {
  const dispatches: Record<string, unknown>[] = []
  const replies: Record<string, unknown>[] = []
  const executor = {
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async (request: Record<string, unknown>) => {
      dispatches.push(request)
      return { status: 'waiting_user', summary: '写了一半', question: '采用哪一版？' }
    },
    reply: async (request: Record<string, unknown>) => {
      replies.push(request)
      // 同样回「还在等人回话」：续问若报成功会接着进汇总轮，而那一轮的模型调用替身不产生。
      return { status: 'waiting_user', summary: '还得再确认一版', question: '用第一版吗？' }
    },
  } as unknown as ButlerAgentExecutor
  return { executor, dispatches, replies }
}

async function fixture(executor: ButlerAgentExecutor) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, new SqliteButlerStorage(store), '')
  // 后台那一轮要在关库之前收干净，否则日志里会留下一串 `database is not open`，
  // 用例照样过，但那种噪音会掩盖真正的存储故障。
  const background: Promise<unknown>[] = []
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, unknown>
    pump: (...args: never[]) => Promise<void>
  }
  const realPump = inner.pump.bind(console_)
  inner.pump = (...args: never[]) => {
    const running = realPump(...args)
    background.push(running.catch(() => {}))
    return running
  }
  const settle = async () => {
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
  const tasks = () => store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' }).items
  /** 起一轮并等大总管进入「理解目标」的等待态。 */
  const startTurn = async (goal = '写一篇关于园区安全的稿子') => {
    await console_.start(conversationId, goal, actor)
    await until(() => agent.followup.mock.calls.length >= 1, '大总管开始理解')
  }
  /** 起一轮 → 交回计划 → 结束这一轮，等计划落库。 */
  const planAndSettle = async (args: Record<string, unknown>) => {
    await startTurn()
    await planTool.execute(args, run)
    endTurn()
    await until(() => tasks().length === 1, '任务落库')
    return tasks()[0]!.id
  }
  return { store, console_, agent, planTool, endTurn, tasks, settle, startTurn, planAndSettle }
}

const GOOD = '一份 800 字以上的候选稿，含标题与正文'

describe('验收口径的落库与贯通', () => {
  it('任务级与子任务级的口径各自落库，互不覆盖', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '这就安排。',
      acceptance: '一篇已发布的博客文章链接',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作', acceptance: GOOD }],
    })
    const record = f.store.task(actor, taskId)!
    expect(record.acceptance).toBe('一篇已发布的博客文章链接')
    expect(record.subtasks[0]!.acceptance).toBe(GOOD)
    await f.settle()
  })

  it('派单时子任务口径真的到了执行方', async () => {
    const r = recordingExecutor()
    const f = await fixture(r.executor)
    await f.planAndSettle({
      reply: '这就安排。',
      acceptance: '一篇已发布的博客文章链接',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作', acceptance: GOOD }],
    })
    await until(() => r.dispatches.length >= 1, '派出第一步')
    expect(r.dispatches[0]!.acceptance).toBe(GOOD)
    await f.settle()
  })

  it('这一步没有口径时不传该字段，而不是传任务级口径顶替', async () => {
    const r = recordingExecutor()
    const f = await fixture(r.executor)
    await f.planAndSettle({
      reply: '这就安排。',
      acceptance: '一篇已发布的博客文章链接',
      subtasks: [{ goal: '查资料', agentId: 'blog', reason: '写作' }],
    })
    await until(() => r.dispatches.length >= 1, '派出第一步')
    // 任务级口径描述的是整件事要交回什么（常常是最终产物），套到「先查个资料」这种中间步骤上，
    // 会让「口径提到的产出物必须交回」把它系统性判成不达标。
    expect('acceptance' in r.dispatches[0]!).toBe(false)
    await f.settle()
  })

  it('续问沿用同一份口径', async () => {
    const r = recordingExecutor()
    const f = await fixture(r.executor)
    const taskId = await f.planAndSettle({
      reply: '这就安排。',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作', acceptance: GOOD }],
    })
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    // 口径从库里读回来：续问可能发生在重启过的进程里，不能指望派的单还留在内存。
    const events: unknown[] = []
    for await (const event of f.console_.submitReply({
      taskId, subtaskId: 's1', text: '用第一版', decideByAgent: false, actor,
    })) {
      events.push(event)
    }
    expect(events.length).toBeGreaterThan(0)
    await until(() => r.replies.length >= 1, '续问到达执行方')
    expect(r.replies[0]!.acceptance).toBe(GOOD)
    await f.settle()
  })
})

describe('防套话：写入时拒绝没有信息量的口径', () => {
  it.each([
    ['完成', '最短的敷衍'],
    ['完成即可。', '加个句号不算信息量'],
    ['没问题', '口头允诺'],
    ['好了', '应答词'],
    ['OK', '英文敷衍'],
    ['你看着办', '把判断推回来'],
  ])('拒绝「%s」（%s）', async (text) => {
    const f = await fixture(recordingExecutor().executor)
    await f.startTurn()
    await expect(f.planTool.execute({
      reply: '好',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '', acceptance: text }],
    }, run)).rejects.toThrow(/验收口径太笼统/u)
    f.endTurn()
    await f.settle()
  })

  it('任务级口径同样被校验，不是只查子任务', async () => {
    const f = await fixture(recordingExecutor().executor)
    await f.startTurn()
    await expect(f.planTool.execute({
      reply: '好',
      acceptance: '完成',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '' }],
    }, run)).rejects.toThrow(/验收口径太笼统/u)
    f.endTurn()
    await f.settle()
  })

  it('不声明口径是合法的：确实没有可核验产出物的步骤不该被硬塞一个标准', async () => {
    const f = await fixture(recordingExecutor().executor)
    await f.startTurn()
    await expect(f.planTool.execute({
      reply: '这就安排。',
      subtasks: [{ goal: '问一句今天是否开园', agentId: 'blog', reason: '写作' }],
    }, run)).resolves.toMatchObject({ accepted: true })
    f.endTurn()
    await f.settle()
  })

  it('合格的口径原样保留，不被裁剪或改写', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '这就安排。',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '', acceptance: GOOD }],
    })
    expect(f.store.task(actor, taskId)!.subtasks[0]!.acceptance).toBe(GOOD)
    await f.settle()
  })
})

describe('重启重放被拒（409）与成员失败要分得开（判据 D-1）', () => {
  /**
   * 场景：同一个 `requestId` 的那一轮此前**已经交付过**，进程重启后重放被运行时显式拒绝
   * （`AccessError(409, …)`）—— 拒绝的理由是外部副作用（候选稿、归档）已经发生过一次。
   *
   * 这件事不是"活没干好"：成员没有失败，是这一次请求本来就不该重跑。如果它与一次普通的
   * 成员失败**同形**，页面与汇总材料都会写成"这位成员失败了"，把老板引向一个不存在的问题。
   *
   * ⚠️ **端到端那条路没做成，如实记在这里**：拒绝发生在派单循环内部，而走夹具那条路时
   * `planTool.execute` 会等执行泵，派单一旦抛错用例就挂在 vitest 的 testTimeout 上
   * （试过两种驱动方式：直调 `dispatchSubtask`、以及手工 `startTurn` + `execute`）。
   * 所以判据拆成两个**可直测**的入口：归类（`dispatchFailureDetail`）与渲染（`reportOf`）；
   * "catch 里真的调了归类"由调用点保证，**没有自动化覆盖**（报告里如实登记）。
   */
  it('归类：409 落固定前缀，普通失败原样', () => {
    const rejection = new AccessError(409, '这一轮已经结算过（同一个请求标识）')
    const detail = dispatchFailureDetail(rejection, 'AccessError: 这一轮已经结算过（同一个请求标识）')
    expect(detail.startsWith(REPLAY_REJECTED_PREFIX)).toBe(true)
    expect(detail).toContain('这一轮已经结算过')

    // 反向对照：普通失败**不能**带那个前缀 —— 少了这条，"带前缀"可能只是无条件加上的。
    expect(dispatchFailureDetail(new Error('成员内部崩了'), '成员内部崩了')).toBe('成员内部崩了')
  })

  it('渲染：带前缀的失败写成"已经结算过"，普通失败仍写"失败："', () => {
    const replayed = reportOf({
      state: 'failed', agentId: 'blog', result: '',
      error: `${REPLAY_REJECTED_PREFIX}：这一轮已经结算过（同一个请求标识）`,
    })
    expect(replayed).toContain(REPLAY_REJECTED_PREFIX)
    expect(replayed).not.toContain('失败：')

    // 反向对照：普通失败仍然带「失败：」，说明上一条的 not.toContain 不是恒真。
    const normal = reportOf({ state: 'failed', agentId: 'blog', result: '', error: '成员内部崩了' })
    expect(normal).toContain('失败：')
  })
})
