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
import { ButlerConsole, REPLAY_REJECTED_PREFIX, dispatchFailureDetail, planReworkAttempts, reportOf, taskAcceptanceFinding } from '../src/butler.ts'
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

/**
 * 设计 §5.4 第 2 步的**动作面**：有 `rework` / `replace` 且预算允许 ⇒ 追加尝试、回调度。
 *
 * 这里直调 `applyReworkAttempts`（收尾里那段动作的唯一实现），不经过汇总轮 —— 汇总轮要模型
 * 驱动，而本文件的替身一律回 `waiting_user`（见 `recordingExecutor` 的注释：那一轮进不去）。
 * 传 `conversation: undefined` 让递归收尾走"没有观众"的分支：不跑汇总、直接落终态，用例能收干净。
 */
describe('裁决要求重做 ⇒ 真的追加尝试并回调度', () => {
  /** 迭代一个异步生成器、收集它 yield 的事件，并拿到它的返回值。 */
  async function drain(source: AsyncGenerator<unknown, boolean>): Promise<{ events: { type?: string }[]; result: boolean }> {
    const events: { type?: string }[] = []
    let step = await source.next()
    while (!step.done) {
      events.push(step.value as { type?: string })
      step = await source.next()
    }
    return { events, result: step.value }
  }

  /** 直接调收尾里那段"追加 + 派单 + 回调度"的动作。 */
  const applyRework = (console_: unknown, args: {
    readonly taskId: string
    readonly subtasks: readonly Record<string, unknown>[]
    readonly decisions: readonly Record<string, unknown>[]
  }) => (console_ as { applyReworkAttempts(input: unknown): AsyncGenerator<unknown, boolean> })
    .applyReworkAttempts({
      input: {
        taskId: args.taskId, actor, conversation: undefined,
        goal: '写一篇关于园区安全的稿子',
        subtasks: args.subtasks,
        reports: ['【blog】第一版正文'], signal: new AbortController().signal,
        stopped: false, summarize: false,
      },
      decisions: args.decisions,
      problems: [],
    })

  it('追加的新尝试真的落库：沿用 logicalId、supersedes 指向被裁的那条', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '这就安排。',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作', acceptance: GOOD }],
    })
    const { events, result } = await drain(applyRework(f.console_, {
      taskId,
      subtasks: [{
        id: 's1', logicalId: 'g1', goal: '写稿', agentId: 'blog', state: 'succeeded',
        acceptance: GOOD, artifacts: [], result: '第一版正文', memberReturnText: '', verdict: '',
      }],
      decisions: [{ subtaskId: 's1', verdict: 'rework', requested: 'rework' }],
    }))
    // `true` = 已经重新派出去了，这一轮**不该再落终态**（新尝试跑完会再收尾一次）。
    expect(result).toBe(true)
    // 页面要看得见"重做已经派出去了"：只写库不上报，用户会以为任务就停在 partial。
    expect(events.some(event => event.type === 'plan')).toBe(true)

    const record = f.store.task(actor, taskId)!
    expect(record.subtasks.map(item => [item.id, item.logicalId, item.supersedes]))
      .toEqual([['s1', 'g1', ''], ['s2', 'g1', 's1']])
    // 口径沿用原步的那一份：重做的是同一件事。
    expect(record.subtasks[1]!.acceptance).toBe(GOOD)
    await f.settle()
  })

  it('预算用尽 ⇒ 不追加、返回 false（调用方按 partial 如实收尾，不冒充已重做）', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '这就安排。',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作', acceptance: GOOD }],
    })
    const base = {
      logicalId: 'g1', goal: '写稿', agentId: 'blog', state: 'failed' as const,
      acceptance: GOOD, artifacts: [], result: '', memberReturnText: '', verdict: '',
    }
    /**
     * ⚠️ **这条改成直调纯函数**，因为原构造用了一组真实链路不可能给出的输入。
     *
     * 原写法往 `applyReworkAttempts` 的 `subtasks` 里塞**同一 `logicalId` 的两条尝试**，
     * 拿它们体现"预算已用满"。但真实链路传进来的是 `effectiveSubtasks()` 之后的集合 ——
     * 它按 `supersedes` 链把被替代的旧尝试剔掉，同一目标永远只剩最新那条 ⇒ 那种输入在生产里
     * 到不了这里。而预算**必须**按全部历史尝试算：只看有效集合会永远算成 1 条、预算永不耗尽，
     * 于是每一轮裁决都追加一次（实测撞 `UNIQUE constraint failed: subtasks.id`），所以判定改从
     * 库里的原始记录读（见 `applyReworkAttempts` 的调用点）。
     * "真链路上追加有界、预算用尽按 `partial` 收尾"由端到端那条覆盖：
     * `tests/verdict-e2e.test.ts` 的「预算用尽」。
     */
    const plan = planReworkAttempts({
      decided: [{ subtaskId: 's2', verdict: 'rework', requested: 'rework' }],
      // 有效尝试只剩最新那条（去重之后），而历史上有两条 —— 这正是真实链路的形状。
      // `verdict: undefined` 覆盖 `base` 里的空串：`SettleTaskInput` 的该字段是
      // `SubtaskVerdict | undefined`，`''` 不是合法取值（夹具只在这里借用 base）。
      subtasks: [{ id: 's2', ...base, verdict: undefined }],
      allSubtasks: [{ id: 's1', logicalId: 'g1' }, { id: 's2', logicalId: 'g1' }],
      baseCount: 2,
    })
    expect(plan.appended).toEqual([])
    expect(plan.exhausted).toEqual(['s2'])
    // 库里没有第三条：`exhausted` 不是"追加了但没上报"。
    expect(f.store.task(actor, taskId)!.subtasks.map(item => item.id)).toEqual(['s1'])
    await f.settle()
  })
})

/**
 * §5.2 第二条消费点：汇总前**程序化核验**"任务级口径提到的产出物有没有交回"。
 *
 * ⚠️ 强度只有"**口径非空 ⇒ 材料非空**"这一档（与运行时 ⑦ 第 3 条同强度）：`acceptance` 是自由
 * 文本、`kind` 是固定枚举，契约里没有"文本 → kind"的映射。断言按这个强度写，**不许**写成
 * "交错了种类"。
 */
describe('任务级口径的产出物核验（§5.2 第二条消费点）', () => {
  const ARTIFACT = { title: '候选稿', path: '/agents/blog/drafts/1', kind: 'draft' }

  it('没有口径 ⇒ 不施加这条，也不记问题', () => {
    expect(taskAcceptanceFinding({ acceptance: undefined, artifacts: [] }))
      .toEqual({ applied: false, ok: true, detail: '' })
    expect(taskAcceptanceFinding({ acceptance: '   ', artifacts: [] }))
      .toEqual({ applied: false, ok: true, detail: '' })
  })

  it('口径非空 + 有材料 ⇒ 通过', () => {
    expect(taskAcceptanceFinding({ acceptance: '一篇已发布的文章链接', artifacts: [ARTIFACT] }))
      .toEqual({ applied: true, ok: true, detail: '' })
  })

  it('口径非空 + 一份材料都没有 ⇒ 不通过，说明里**带上口径原文**（可追溯）', () => {
    const finding = taskAcceptanceFinding({ acceptance: '一篇已发布的文章链接', artifacts: [] })
    expect(finding.applied).toBe(true)
    expect(finding.ok).toBe(false)
    expect(finding.detail).toContain('没有任何材料交回')
    expect(finding.detail).toContain('一篇已发布的文章链接')
    // 强度不夸大：它证明的是"有没有材料"，不是"交的是不是那一种"。
    expect(finding.detail).not.toContain('kind')
  })

  it('核验结论进终态说明：口径非空却零材料 ⇒ `error` 里如实写出来', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '这就安排。',
      acceptance: '一篇已发布的博客文章链接',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作' }],
    })
    const inner = f.console_ as unknown as {
      settleTask(input: unknown): AsyncGenerator<unknown, unknown>
    }
    const source = inner.settleTask({
      taskId, actor, conversation: undefined, goal: '写一篇关于园区安全的稿子',
      subtasks: [{
        id: 's1', logicalId: 'g1', goal: '写稿', agentId: 'blog', state: 'succeeded',
        acceptance: '', artifacts: [], result: '写好了', memberReturnText: '', verdict: '',
      }],
      acceptance: '一篇已发布的博客文章链接',
      reports: ['【blog】写好了'], signal: new AbortController().signal,
      stopped: false, summarize: false,
    })
    let step = await source.next()
    while (!step.done) step = await source.next()
    expect(f.store.task(actor, taskId)!.error).toContain('没有任何材料交回')
    await f.settle()
  })

  it('反向对照：口径为空时 `error` 里**不出现**那句话（说明上一条不是恒真）', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '这就安排。',
      subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作' }],
    })
    const inner = f.console_ as unknown as {
      settleTask(input: unknown): AsyncGenerator<unknown, unknown>
    }
    const source = inner.settleTask({
      taskId, actor, conversation: undefined, goal: '写一篇关于园区安全的稿子',
      subtasks: [{
        id: 's1', logicalId: 'g1', goal: '写稿', agentId: 'blog', state: 'succeeded',
        acceptance: '', artifacts: [], result: '写好了', memberReturnText: '', verdict: '',
      }],
      reports: ['【blog】写好了'], signal: new AbortController().signal,
      stopped: false, summarize: false,
    })
    let step = await source.next()
    while (!step.done) step = await source.next()
    expect(f.store.task(actor, taskId)!.error).not.toContain('没有任何材料交回')
    await f.settle()
  })
})

/**
 * `butler_verdict` 工具的**接线**：判定本身由 `tests/verdict.test.ts` 的纯函数用例覆盖，
 * 这里管的是"工具里真的调了那些判定"—— 上一批如实登记过这块**只有静态保证**。
 *
 * 做法：直取 `verdictTool`（工具对所有轮次都注册着）并注入裁决上下文（`verdictContexts`），
 * 这样不必走汇总轮 —— 汇总轮要模型驱动，而本文件的替身一律回 `waiting_user`，进不去。
 */
describe('butler_verdict 工具的接线（判定真的被调到）', () => {
  const toolOf = (console_: unknown) =>
    (console_ as { verdictTool(id: string): { execute(args: unknown, exec: unknown): Promise<unknown> } })
      .verdictTool(conversationId)
  const contextsOf = (console_: unknown) =>
    (console_ as { verdictContexts: Map<string, Record<string, unknown>> }).verdictContexts
  const openStep = (over: Record<string, unknown> = {}) => ({
    id: 's1', goal: '写稿', agentId: 'blog', result: '写好了', artifacts: [],
    memberReturnText: '', selfCheck: { status: 'passed' as const }, ...over,
  })
  const contextFor = (taskId: string, open: readonly Record<string, unknown>[]) => ({
    actor, taskId, open, decided: new Set<string>(), decisions: [] as unknown[], problems: [] as string[],
  })

  it('不在裁决上下文里调用 ⇒ 明确拒绝（工具对所有轮次都注册着，派活轮也可能调它）', async () => {
    const f = await fixture(recordingExecutor().executor)
    await expect(toolOf(f.console_).execute({ items: [{ subtaskId: 's1', verdict: 'accept' }] }, run))
      .rejects.toThrow(/没有待裁决的清单/)
    await f.settle()
  })

  it('空清单 / 不在清单里 / 重复裁决 ⇒ 都在落库之前被拒', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '好', subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作' }],
    })
    const tool = toolOf(f.console_)
    contextsOf(f.console_).set(conversationId, contextFor(taskId, [openStep()]))
    await expect(tool.execute({ items: [] }, run)).rejects.toThrow(/裁决清单不能为空/)
    await expect(tool.execute({ items: [{ subtaskId: 'nope', verdict: 'accept' }] }, run))
      .rejects.toThrow(/不在这一次的待裁决清单里/)
    // ⚠️ 漏裁：清单里两步只裁一步 —— 汇总写下去就等于默认通过，所以整批拒绝。
    contextsOf(f.console_).set(conversationId, contextFor(taskId, [openStep(), openStep({ id: 's2' })]))
    await expect(tool.execute({ items: [{ subtaskId: 's1', verdict: 'accept', evidence: '写好了' }] }, run))
      .rejects.toThrow(/还有步骤没有裁决/)
    // 被拒的这几批一条都没落库（"半批落下去"会让重试面对已经变了的清单）。
    expect(f.store.task(actor, taskId)!.subtasks.every(item => item.verdict === '')).toBe(true)
    await f.settle()
  })

  it('重复裁决被拒：同一个子任务不能裁两次', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '好', subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作' }],
    })
    const context = contextFor(taskId, [openStep()])
    context.decided.add('s1')
    contextsOf(f.console_).set(conversationId, context)
    await expect(toolOf(f.console_).execute({ items: [{ subtaskId: 's1', verdict: 'accept', evidence: '写好了' }] }, run))
      .rejects.toThrow(/不能重复裁决/)
    await f.settle()
  })

  it('写后核验：affected 行数为 0 ⇒ 报错，不静默当成"裁决过了"', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '好', subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作' }],
    })
    // 清单里那条**不在库里**（模拟两边对不上）：判定都过，但写库 0 行。
    contextsOf(f.console_).set(conversationId, contextFor(taskId, [openStep({ id: 'ghost' })]))
    await expect(toolOf(f.console_).execute({ items: [{ subtaskId: 'ghost', verdict: 'accept', evidence: '写好了' }] }, run))
      .rejects.toThrow(/没有落到库里/)
    await f.settle()
  })

  it('成功路径：D-2 与证据核验真的被调到，结论落库', async () => {
    const f = await fixture(recordingExecutor().executor)
    // 两步：一条走成功路径、一条走"证据找不到 ⇒ 降级"的反向对照（两条都必须在库里，
    // 否则会先撞上写后核验的 0 行报错 —— 那正是上一条用例在测的东西）。
    const taskId = await f.planAndSettle({
      reply: '好', subtasks: [
        { goal: '写稿', agentId: 'blog', reason: '写作' },
        { goal: '校对', agentId: 'blog', reason: '编辑' },
      ],
    })
    const context = contextFor(taskId, [openStep()])
    contextsOf(f.console_).set(conversationId, context)
    await expect(toolOf(f.console_).execute(
      { items: [{ subtaskId: 's1', verdict: 'accept', evidence: '写好了' }] }, run,
    )).resolves.toEqual({ accepted: true, decided: 1 })
    expect(f.store.task(actor, taskId)!.subtasks.find(item => item.id === 's1')!.verdict).toBe('accept')
    // 结论文里记下了这一条（`settleTask` 之后靠它决定去路）。
    expect(context.decisions).toEqual([
      { subtaskId: 's1', verdict: 'accept', requested: 'accept' },
    ])
    // 反向对照：证据在该步结果里找不到 ⇒ **降级 unverified**，不静默 accept。
    contextsOf(f.console_).set(conversationId, contextFor(taskId, [openStep({ id: 's2' })]))
    await toolOf(f.console_).execute(
      { items: [{ subtaskId: 's2', verdict: 'accept', evidence: '这句话结果里没有' }] }, run,
    )
    expect(f.store.task(actor, taskId)!.subtasks.find(item => item.id === 's2')!.verdict).toBe('unverified')
    await f.settle()
  })
})

/**
 * **判据 R8 第二半**（D-7 的两条之一）：裁决与汇总**在同一轮内**，且裁决发生在汇总正文之前。
 *
 * 锚点用**方法调用序**（同步可观测），不用"`butler_verdict` 被调用"—— 那是模型驱动的，
 * 而且裁决上下文的开合已经把"模型只能在上下文开着时裁决"这件事钉住了。
 * ⚠️ 这一条**不能**拿"调用 `summarize`"当异步时序的锚点：本文件把 `summarize` 换成假生成器
 * （真汇总轮要模型驱动，替身一律回 `waiting_user` 进不去），所以它测的是**结构**：
 * 上下文开 → 汇总正文 → 上下文关 → 落终态，且汇总**只跑一次**（不额外占一轮）。
 */
describe('R8 第二半：裁决并入汇总轮（同一轮、裁决在前）', () => {
  it('裁决上下文在汇总正文之前开启、之后关闭；汇总只跑一次；落终态在其后', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '好', subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作' }],
    })
    const inner = f.console_ as unknown as {
      settleTask(input: unknown): AsyncGenerator<unknown, unknown>
      summarize: (...args: unknown[]) => AsyncGenerator<unknown, void>
      openVerdictContext(...args: unknown[]): void
      closeVerdictContext(...args: unknown[]): unknown
    }
    const order: string[] = []
    // 真 `summarize` 会调模型、等一个不会来的回合 ⇒ 换成只 yield 一条正文的假生成器。
    inner.summarize = async function * (): AsyncGenerator<unknown, void> {
      order.push('summarize')
      yield { type: 'summary', taskId, text: '汇总正文', state: 'completed', error: '', time: 0 }
    }
    const realOpen = inner.openVerdictContext.bind(f.console_)
    inner.openVerdictContext = (...args: unknown[]) => { order.push('open-verdict'); realOpen(...args) }
    const realClose = inner.closeVerdictContext.bind(f.console_)
    inner.closeVerdictContext = (...args: unknown[]) => { order.push('close-verdict'); return realClose(...args) }

    const source = inner.settleTask({
      taskId, actor, conversation: { id: conversationId }, goal: '写一篇关于园区安全的稿子',
      subtasks: [{
        id: 's1', logicalId: 'g1', goal: '写稿', agentId: 'blog', state: 'succeeded',
        acceptance: '', artifacts: [], result: '写好了', memberReturnText: '', verdict: '',
      }],
      reports: ['【blog】写好了'], signal: new AbortController().signal,
      stopped: false, summarize: true,
    })
    let step = await source.next()
    while (!step.done) step = await source.next()

    expect(order).toEqual(['open-verdict', 'summarize', 'close-verdict'])
    // 落终态在上下文关闭之后：任务已经是终态（这条同时说明"不额外占一轮"——汇总只出现一次）。
    expect(f.store.task(actor, taskId)!.state).toBe('completed')
    await f.settle()
  })

  it('反向对照：`summarize: false`（后台等待超时那条路径）不开裁决上下文', async () => {
    const f = await fixture(recordingExecutor().executor)
    const taskId = await f.planAndSettle({
      reply: '好', subtasks: [{ goal: '写稿', agentId: 'blog', reason: '写作' }],
    })
    const inner = f.console_ as unknown as {
      settleTask(input: unknown): AsyncGenerator<unknown, unknown>
      openVerdictContext(...args: unknown[]): void
    }
    const order: string[] = []
    const realOpen = inner.openVerdictContext.bind(f.console_)
    inner.openVerdictContext = (...args: unknown[]) => { order.push('open-verdict'); realOpen(...args) }
    const source = inner.settleTask({
      taskId, actor, conversation: undefined, goal: '写一篇关于园区安全的稿子',
      subtasks: [{
        id: 's1', logicalId: 'g1', goal: '写稿', agentId: 'blog', state: 'failed',
        acceptance: '', artifacts: [], result: '', memberReturnText: '', verdict: '',
      }],
      reports: [], signal: new AbortController().signal,
      stopped: false, summarize: false, settleErrorOverride: '等用户回话超时，材料保留',
    })
    let step = await source.next()
    while (!step.done) step = await source.next()
    // 没有观众的后台路径不该开裁决上下文（也就不会让模型去裁）。
    expect(order).toEqual([])
    await f.settle()
  })
})
