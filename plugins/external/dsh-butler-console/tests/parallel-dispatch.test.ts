/**
 * 并行派发的判据：不同成员的两个排队步骤，队首挂起时队尾照样被派出。
 *
 * 旧实现逐个 await（队首的 dispatch 不返回，后面纹丝不动）；并行版取批后一起派。
 * 断言用**行为**而不是时钟：blog 的 dispatch 挂在门闩上未返回期间，closedoff 的
 * dispatch 已被调用且它的子任务已落 `succeeded`——串行实现下这结构性不可能。
 * （fixture 与消费方式照 dependency-recheck：直调 drainQueue，for-await 消费事件。）
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`等待超时：${label}`)
}

describe('并行派发', () => {
  it('不同成员的独立步骤：队首挂起时队尾照样派出（blog 未返回，closedoff 已办完）', async () => {
    const dispatched = new Set<string>()
    let releaseBlog: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseBlog = resolve })
    const executors: ButlerAgentExecutor[] = [
      {
        protocol: 1, agentId: 'blog', capabilities: ['写作'],
        // 挂在门闩上：不返回，模拟慢执行。
        dispatch: async () => { dispatched.add('blog'); await gate; return { status: 'succeeded' as const, summary: '慢的那件好了' } },
      },
      {
        protocol: 1, agentId: 'closedoff', capabilities: ['查询'],
        dispatch: async () => { dispatched.add('closedoff'); return { status: 'succeeded' as const, summary: '快的那件好了' } },
      },
    ]
    const ctx = {
      root: {
        emit(name: string, accept: (value: unknown) => void) {
          if (name === 'butler/executors') { for (const e of executors) accept(e); return }
          if (name === 'ecosystem/catalog') {
            for (const e of executors) {
              accept({ protocol: 1, plugin: { id: e.agentId, packageName: `pkg-${e.agentId}`, version: '1', displayName: e.agentId, description: '', entryPath: '/x', permissions: [], tools: [], category: 'agents' } })
            }
          }
        },
      },
    } as unknown as Context
    const store = new TaskStore(':memory:')
    const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
    const config = { subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200, waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000 } as Config
    const console_ = new ButlerConsole(ctx, config, access, new SqliteButlerStorage(store), '')
    const background: Promise<unknown>[] = []
    const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
    const inner = console_ as unknown as { conversations: Map<string, unknown>; pump: (...a: never[]) => Promise<void> }
    const realPump = inner.pump.bind(console_)
    inner.pump = (...args: never[]) => { const r = realPump(...args); background.push(r.catch(() => {})); return r }
    vi.spyOn(console_, 'open').mockImplementation(async (id?: string) => {
      store.openOrReserveConversation(String(id), actor)
      inner.conversations.set(conversationId, { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() })
      return inner.conversations.get(conversationId) as never
    })

    const taskId = `butler-task-${randomUUID()}`
    store.openOrReserveConversation(conversationId, actor)
    store.createTask({
      id: taskId, conversationId, actor, goal: '两件独立的事', note: '',
      subtasks: [
        { id: 's1', goal: '慢的那件', agentId: 'blog', reason: '', logicalId: 'g1' },
        { id: 's2', goal: '快的那件', agentId: 'closedoff', reason: '', logicalId: 'g2' },
      ],
    })

    const drainQueue = (console_ as unknown as {
      drainQueue(input: { taskId: string; actor: Actor; goal: string; signal: AbortSignal }): AsyncGenerator<unknown>
    }).drainQueue.bind(console_)
    const draining = drainQueue({ taskId, actor, goal: '两件独立的事', signal: new AbortController().signal })
    void (async () => { for await (const _event of draining) { void _event } })().catch(() => {})

    // 判据：blog 的 dispatch 挂在门闩上未返回时，closedoff 已经派出并办完。
    await until(() => dispatched.has('blog') && dispatched.has('closedoff'), '两个成员都被派出')
    await until(() => store.task(actor, taskId)?.subtasks.find(item => item.id === 's2')?.state === 'succeeded', '队尾（快的那件）已办完')
    expect(dispatched.has('blog'), '此时队首仍挂在门闩上未返回').toBe(true)

    releaseBlog?.()
    await until(() => store.task(actor, taskId)?.subtasks.find(item => item.id === 's1')?.state === 'succeeded', '放行后队首也办完')
    for (let i = 0; i < 60 && background.length > 0; i++) await Promise.allSettled(background.splice(0))
    store.close()
  }, 15_000)

  it('同一成员的两个步骤仍逐个派：第一步挂起时第二步不被派出', async () => {
    const dispatched: string[] = []
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const calls: string[] = []
    const executor: ButlerAgentExecutor = {
      protocol: 1, agentId: 'blog', capabilities: ['写作'],
      dispatch: async () => {
        calls.push(`call-${dispatched.length + 1}`)
        dispatched.push('blog')
        if (dispatched.length === 1) await gate
        return { status: 'succeeded' as const, summary: '好了' }
      },
    }
    const ctx = {
      root: {
        emit(name: string, accept: (value: unknown) => void) {
          if (name === 'butler/executors') { accept(executor); return }
          if (name === 'ecosystem/catalog') {
            accept({ protocol: 1, plugin: { id: 'blog', packageName: 'pkg', version: '1', displayName: '博客', description: '', entryPath: '/x', permissions: [], tools: [], category: 'agents' } })
          }
        },
      },
    } as unknown as Context
    const store = new TaskStore(':memory:')
    const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
    const config = { subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200, waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000 } as Config
    const console_ = new ButlerConsole(ctx, config, access, new SqliteButlerStorage(store), '')
    const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
    const inner = console_ as unknown as { conversations: Map<string, unknown>; pump: (...a: never[]) => Promise<void> }
    const realPump = inner.pump.bind(console_)
    const background: Promise<unknown>[] = []
    inner.pump = (...args: never[]) => { const r = realPump(...args); background.push(r.catch(() => {})); return r }
    vi.spyOn(console_, 'open').mockImplementation(async (id?: string) => {
      store.openOrReserveConversation(String(id), actor)
      inner.conversations.set(conversationId, { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() })
      return inner.conversations.get(conversationId) as never
    })

    const taskId = `butler-task-${randomUUID()}`
    store.openOrReserveConversation(conversationId, actor)
    store.createTask({
      id: taskId, conversationId, actor, goal: '同一个人的两件事', note: '',
      subtasks: [
        { id: 's1', goal: '第一件', agentId: 'blog', reason: '', logicalId: 'g1' },
        { id: 's2', goal: '第二件', agentId: 'blog', reason: '', logicalId: 'g2' },
      ],
    })
    const drainQueue = (console_ as unknown as {
      drainQueue(input: { taskId: string; actor: Actor; goal: string; signal: AbortSignal }): AsyncGenerator<unknown>
    }).drainQueue.bind(console_)
    const draining = drainQueue({ taskId, actor, goal: '同一个人的两件事', signal: new AbortController().signal })
    void (async () => { for await (const _event of draining) { void _event } })().catch(() => {})

    await until(() => dispatched.length === 1, '第一步派出并挂起')
    expect(calls.length === 1, '同成员保守口径：第一步没返回前不派第二步').toBe(true)
    releaseFirst?.()
    await until(() => (store.task(actor, taskId)?.subtasks.every(item => item.state === 'succeeded')) === true, '两步先后办完')
    for (let i = 0; i < 60 && background.length > 0; i++) await Promise.allSettled(background.splice(0))
    store.close()
  }, 15_000)
})
