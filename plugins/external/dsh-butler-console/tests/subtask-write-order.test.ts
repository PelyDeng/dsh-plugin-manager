/**
 * 同子任务存储写入的串行化（方案 §3「同子任务写入顺序」，T1-2 不变量 b）。
 *
 * 执行器的 `onProgress` 是 fire-and-forget 回调：异步存储下，回调触发的 `running` 写入与
 * 派单阶段的 `dispatched`（含 inputRefs 首次固定）、结果落库之间没有天然的先后保证。
 * 这里把存储替身的每次写入人为安排**不同时长**的网络往返（模拟乱序到达），断言落库顺序
 * 仍然是调用顺序 —— `dispatched` 先于一切 `running`，终态最后落地。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole, type ButlerEvent } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import type { ButlerStorage } from '../src/storage/types.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'

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

describe('同子任务的存储写入串行化', () => {
  it('延迟各不相同的写入仍按调用顺序落库：dispatched 先于 running，终态最后', async () => {
    const landed: string[] = []
    let ticket = 0
    // 每次写入按票号给不同时长的「网络往返」：不经队列时它们的落库顺序会与调用顺序脱钩。
    const store = {
      task: vi.fn(() => ({
        subtasks: [{ id: 's1', supersedes: '', state: 'queued', startedAt: null, inputRefs: undefined, inputRefsState: 'unfixed' }],
      })),
      async setSubtaskState(_taskId: string, _subtaskId: string, state: string) {
        ticket += 1
        const delay = ticket % 2 === 0 ? 4 : 0
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        landed.push(state)
      },
    } as unknown as ButlerStorage
    const access = { mode: 'authenticated', ready() {}, resolve: () => undefined, assert() {} } as unknown as Access
    const config = { subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000 } as Config
    const console_ = new ButlerConsole(context({
      protocol: 1,
      agentId: 'blog',
      dispatch: async request => {
        // 执行方在 dispatch 的 await 期间连发两次进度：早期会话引用与普通状态行。
        request.onProgress?.({ stage: '开工', conversationId: 'member-conv' })
        request.onProgress?.({ stage: '正在写', delta: '第一段' })
        return { status: 'succeeded', summary: '写完了' }
      },
    }), config, access, store, '')
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

    const events: ButlerEvent[] = []
    for await (const event of dispatchSubtask({
      taskId: 'task-1', subtaskId: 's1', goal: '起草', agentId: 'blog', displayName: '博客',
      taskGoal: '写一篇介绍', actor: { namespace: 'user', userId: 'alice', sessionId: 'login' },
      signal: new AbortController().signal,
    })) events.push(event)

    // inputRefs 首次固定跟着 dispatched 走：它必须最先落地，后面的 running 才不会把快照
    // 判成「已派出却没留材料」的未知。
    expect(landed[0]).toBe('dispatched')
    expect(landed.at(-1)).toBe('succeeded')
    // 全部落库顺序与调用顺序一致，没有任何乱序穿插。
    expect(landed).toEqual(['dispatched', 'running', 'running', 'succeeded'])
    expect(events.at(-1)).toMatchObject({ type: 'subtask', state: 'succeeded' })
  })
})
