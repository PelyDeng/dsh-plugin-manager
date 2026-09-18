/**
 * 子任务流式发言的到达时机测试。
 *
 * 背景：执行方在 `dispatch` 的 await 期间回调 `onProgress`，而生成器只能在自己体内
 * `yield`。旧实现把进度事件攒进数组、等子任务 settle 后一次性补发，页面于是先看到一句
 * 状态、空白很久、最后整段回答一起蹦出来 —— 通道都在，流式却没发生。
 *
 * 这里锁住的就是「不等结束」这一条：执行方一上报，事件就得在 dispatch 还没返回时到页面。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole, type ButlerEvent } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor, ButlerProgressUpdate } from '../src/protocol.ts'
import type { ButlerStorage } from '../src/storage/types.ts'

/**
 * 只实现本测试用到的两条通道。
 *
 * 调度入口要「在目录里且可调度」才有效：目录是用户能追踪到这位成员的前提，
 * 所以这里照实提供目录条目，而不是绕过这道校验。
 */
function dispatchContext(executor: ButlerAgentExecutor): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') {
          accept({
            protocol: 1,
            plugin: {
              id: executor.agentId,
              packageName: `dsh-${executor.agentId}`,
              version: '1.0.0',
              displayName: '封闭化管理智能助手',
              description: '',
              entryPath: `/${executor.agentId}`,
              permissions: [],
              tools: [],
              category: 'agents',
            },
          })
        }
      },
    },
  } as unknown as Context
}

/**
 * 直接驱动子任务调度。
 *
 * `dispatchSubtask` 是内部方法：从这里到页面之间还隔着整个宿主 Agent（拆解、汇总、
 * SSE），没有更轻的公开入口能验证「增量什么时候到达」。所以这里只伪装它真正用到的
 * 三个协作者（调度入口、状态库、配置），其余一律不造假。
 */
function consoleFor(executor: ButlerAgentExecutor) {
  const states: string[] = []
  /** 落库补丁（含 `result` / `memberReturn`），用来核"事件与库同源"。 */
  const writes: { readonly state: string; readonly patch: Record<string, unknown> }[] = []
  const store = {
    setSubtaskState: vi.fn((_taskId: string, _subtaskId: string, state: string, patch?: Record<string, unknown>) => {
      states.push(state)
      if (patch !== undefined) writes.push({ state, patch })
    }),
    // 派单前要核验这条子任务有没有已固定的材料快照；本文件不涉及派单材料，
    // 按「排队中、还没派出去过」算 —— 也就是唯一允许首次固定的那一种。
    task: vi.fn(() => ({
      subtasks: [{
        id: 's1', supersedes: '', state: 'queued', startedAt: null,
        inputRefs: undefined, inputRefsState: 'unfixed',
      }],
    })),
  } as unknown as ButlerStorage
  const access = { mode: 'authenticated', ready() {}, resolve: () => undefined, assert() {} } as unknown as Access
  const config = { subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000 } as Config
  const console_ = new ButlerConsole(dispatchContext(executor), config, access, store, '')
  const dispatchSubtask = (console_ as unknown as {
    dispatchSubtask(input: {
      taskId: string
      subtaskId: string
      goal: string
      agentId: string
      displayName: string
      taskGoal: string
      actor: { namespace: 'user'; userId: string; sessionId: string }
      signal: AbortSignal
    }): AsyncGenerator<ButlerEvent, unknown>
  }).dispatchSubtask.bind(console_)
  return { dispatchSubtask, states, writes }
}

/** 让已经就绪的微任务与宏任务跑一轮，模拟页面在等待期间收到 SSE。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function executor(dispatch: ButlerAgentExecutor['dispatch']): ButlerAgentExecutor {
  return { protocol: 1, agentId: 'closedoff', dispatch }
}

const input = {
  taskId: 'butler-task-1',
  subtaskId: 's1',
  goal: '查今天的通行记录',
  agentId: 'closedoff',
  displayName: '封闭化管理智能助手',
  taskGoal: '看看今天园区的情况',
  actor: { namespace: 'user' as const, userId: 'alice', sessionId: 'alice-login' },
  signal: new AbortController().signal,
}

/**
 * 取出调度请求里的进度出口。
 *
 * 协议里它是可选字段（执行方可以一次都不上报），但本文件要验证的正是上报通道，
 * 所以缺了就当场失败，而不是让断言在一堆空数组上「通过」。
 */
function reporter(request: { onProgress?: (update: ButlerProgressUpdate) => void }) {
  if (request.onProgress === undefined) throw new Error('调度请求缺少进度出口')
  return request.onProgress
}

const deltasOf = (events: readonly ButlerEvent[]) =>
  events.filter(event => event.type === 'subtask_delta').map(event => event.delta)

const thoughtsOf = (events: readonly ButlerEvent[]) =>
  events.filter(event => event.type === 'subtask_thinking').map(event => event.thinking)

describe('子任务的进度事件实时到达页面', () => {
  it('执行方一上报就产出增量，不等 dispatch 返回', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { dispatchSubtask } = consoleFor(executor(async request => {
      const report = reporter(request)
      report({ stage: '正在查询通行记录', delta: '今天共有 ' })
      await gate
      report({ stage: '正在查询通行记录', delta: '12 辆车入园。' })
      return { status: 'succeeded', summary: '今天共有 12 辆车入园。' }
    }))
    const events: ButlerEvent[] = []
    let finished = false
    const running = (async () => {
      for await (const event of dispatchSubtask(input)) events.push(event)
      finished = true
    })()

    await settle()
    // 关键断言：dispatch 还挂在这里，第一段增量就必须已经到了。
    expect(finished).toBe(false)
    expect(deltasOf(events)).toEqual(['今天共有 '])

    release()
    await running
    expect(deltasOf(events)).toEqual(['今天共有 ', '12 辆车入园。'])
    expect(events.at(-1)).toMatchObject({ type: 'subtask', state: 'succeeded', detail: '今天共有 12 辆车入园。' })
  })

  it('执行失败时先到的增量不丢，失败事件仍然排在最后', async () => {
    const { dispatchSubtask } = consoleFor(executor(async request => {
      reporter(request)({ stage: '正在查询通行记录', delta: '已经查到的部分：' })
      throw new Error('上游返回 502')
    }))
    const events: ButlerEvent[] = []
    for await (const event of dispatchSubtask(input)) events.push(event)
    expect(deltasOf(events)).toEqual(['已经查到的部分：'])
    expect(events.at(-1)).toMatchObject({ type: 'subtask', state: 'failed' })
  })

  it('思考快照走覆盖事件，同样边到边产出且不再多出状态文字', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { dispatchSubtask } = consoleFor(executor(async request => {
      const report = reporter(request)
      report({ stage: '正在思考', thinking: '先看今天的通行记录。\n正在生成…' })
      await gate
      report({ stage: '正在思考', thinking: '先看今天的通行记录。' })
      return { status: 'succeeded', summary: '今天共有 12 辆车入园。' }
    }))
    const events: ButlerEvent[] = []
    const running = (async () => { for await (const event of dispatchSubtask(input)) events.push(event) })()
    await settle()
    // 第一份快照在 dispatch 返回前就到了；后续快照是替换，不是追加。
    expect(thoughtsOf(events)).toEqual(['先看今天的通行记录。\n正在生成…'])
    release()
    await running
    expect(thoughtsOf(events)).toEqual(['先看今天的通行记录。\n正在生成…', '先看今天的通行记录。'])
    expect(events.filter(event => event.type === 'subtask' && event.state === 'running')).toHaveLength(0)
  })

  it('工具与阶段状态照旧走 running，只有 delta 走增量事件', async () => {
    const updates: ButlerProgressUpdate[] = [
      { stage: '正在翻阅资料', phase: 'tool', tool: 'closedoff_vehicle_track' },
      { stage: '正在查询通行记录', delta: '今天共有 ' },
    ]
    const { dispatchSubtask, states } = consoleFor(executor(async request => {
      const report = reporter(request)
      for (const update of updates) report(update)
      return { status: 'succeeded', summary: '今天共有 12 辆车入园。' }
    }))
    const events: ButlerEvent[] = []
    for await (const event of dispatchSubtask(input)) events.push(event)
    expect(events.map(event => event.type)).toEqual(['subtask', 'subtask', 'subtask_delta', 'subtask'])
    expect(events[1]).toMatchObject({ type: 'subtask', state: 'running', tool: 'closedoff_vehicle_track' })
    // 状态迁移仍然只在第一条进度上报时写一次库。
    expect(states).toEqual(['dispatched', 'running', 'succeeded'])
  })
})

/**
 * 判据：**实时事件与落库记录同源**——正文与待确认操作都不能"刷新前一套、刷新后一套"。
 *
 * ## 两条真实的生产症状（用户截图报的）
 *
 * 1. **正文不一致**：落库拼的是 `正文 + 外部待办：理由`，而实时事件只发那句 `reason`
 *    ⇒ 刷新前的卡片里没有"外部待办"那一段，刷新后有了。
 * 2. **按钮只在刷新后出现**：`memberReturnOf` 把 `actions` 存进了库（回看那条路能取回来），
 *    而 `emit` 的 extra 里**根本没有 actions 字段** ⇒ 实时那条路永远画不出确认按钮。
 *
 * 根因是同一个：**结构化的东西有两条路，各写各的**。所以判据也必须同时压两条路：
 * 事件里的 `detail` 与库里的 `result` 逐字相同、`actions` 两边都在。
 */
describe('实时与落库同源：正文与待确认操作', () => {
  const action = { id: 'op-1', kind: 'blog.publish', title: '发布文章', summary: '确认后公开发布。', state: 'prepared' as const }

  it('external_pending：事件正文 == 落库正文，且 actions 两条路都在', async () => {
    const { dispatchSubtask, writes } = consoleFor(executor(async () => ({
      status: 'external_pending',
      summary: '卡片已生成，尚未执行。',
      externalPending: { reason: '发布确认还没点', next: '点完再派一轮' },
      actions: [action],
    }) as never))
    const events: ButlerEvent[] = []
    for await (const event of dispatchSubtask(input)) events.push(event)

    const terminal = events.filter((event): event is Extract<ButlerEvent, { type: 'subtask' }> => event.type === 'subtask' && event.state === 'external_pending').at(-1)
    expect(terminal, '没有 external_pending 的终态事件').toBeDefined()
    // ① 正文两边一致：事件里就该有"外部待办"那一段（旧实现只有 reason）。
    expect(terminal?.detail).toContain('外部待办：发布确认还没点')
    expect(writes.at(-1)?.patch.result, '事件正文与落库正文漂移了').toBe(terminal?.detail)
    // ② 待确认操作两边都在：事件里没有它，用户就只看到"要确认"却没有按钮。
    expect(terminal?.actions, '实时事件丢了待确认操作（按钮画不出来）').toEqual([action])
    expect((writes.at(-1)?.patch.memberReturn as { actions?: unknown } | undefined)?.actions, '落库丢了待确认操作（刷新后按钮消失）').toEqual([action])
  })

  it('succeeded：正文两边一致，带 actions 时也一并透传', async () => {
    const { dispatchSubtask, writes } = consoleFor(executor(async () => ({
      status: 'succeeded',
      summary: '材料已交回。',
      actions: [action],
    }) as never))
    const events: ButlerEvent[] = []
    for await (const event of dispatchSubtask(input)) events.push(event)

    const terminal = events.filter((event): event is Extract<ButlerEvent, { type: 'subtask' }> => event.type === 'subtask' && event.state === 'succeeded').at(-1)
    expect(terminal?.detail).toBe('材料已交回。')
    expect(writes.at(-1)?.patch.result).toBe(terminal?.detail)
    expect(terminal?.actions).toEqual([action])
  })
})
