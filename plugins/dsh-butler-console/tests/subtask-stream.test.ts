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
import type { TaskStore } from '../src/store.ts'

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
  const store = {
    setSubtaskState: vi.fn((_taskId: string, _subtaskId: string, state: string) => { states.push(state) }),
  } as unknown as TaskStore
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
  return { dispatchSubtask, states }
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
