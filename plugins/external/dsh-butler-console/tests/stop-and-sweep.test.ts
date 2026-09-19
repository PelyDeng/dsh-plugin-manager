/**
 * 喊停收等待（#14）与等待超时兜底（#6）。
 *
 * 生产现场：等待中的步骤没有活跃 run，`cancel` 只看执行中的轮次时永远喊不停它们；
 * 等待超时的内存闹钟丢失时，等待要挂到下次服务重启才被收敛（实测 50+ 分钟）。
 * 两条出口都必须可用：喊停是老板的明确意志，兜底扫描保证闹钟丢了也兜得住。
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import type { ButlerMemberReturn } from '../src/storage/types.ts'
import { advanceSubtask, ageStartedAt, SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const memberConversationId = 'blog-chat-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`等待超时：${label}`)
}

const executor: ButlerAgentExecutor = {
  protocol: 1, agentId: 'blog', capabilities: ['写作'],
  dispatch: async () => ({ status: 'waiting_user' as const, summary: '先说说你要哪种版式？' }),
}

function context(): Context {
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

async function fixture() {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(), config, access, new SqliteButlerStorage(store), '')
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
  vi.spyOn(console_, 'open').mockImplementation(async (requestedId?: string) => {
    store.openOrReserveConversation(String(requestedId), actor)
    const conversation = { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() }
    inner.conversations.set(conversationId, conversation)
    return conversation as never
  })
  const settleAll = async () => {
    for (let attempt = 0; attempt < 50 && background.length > 0; attempt += 1) {
      await Promise.allSettled(background.splice(0))
    }
    store.close()
  }
  return { store, console_, settleAll }
}

/** 建一个单步任务，步骤停在 waiting_user 并带材料（成员提问后等回话）。 */
async function waitingTask(f: Awaited<ReturnType<typeof fixture>>) {
  const taskId = `butler-task-${randomUUID()}`
  f.store.openOrReserveConversation(conversationId, actor)
  f.store.createTask({
    id: taskId, conversationId, actor, goal: '给博客写篇测试稿', note: '',
    subtasks: [{ id: 's1', goal: '写测试稿', agentId: 'blog', reason: '', logicalId: 'g1' }],
  })
  const memberReturn: ButlerMemberReturn = { protocol: 1, text: '先说说你要哪种版式？' }
  advanceSubtask(f.store, taskId, 's1', 'waiting_user', { memberReturn, conversationId: memberConversationId })
  return taskId
}

describe('等待的两条出口', () => {
  it('喊停收掉等待中的步骤（#14）：cancelled、材料保留、任务一并收尾', async () => {
    const f = await fixture()
    const taskId = await waitingTask(f)

    const outcome = await f.console_.cancel(conversationId, actor)
    expect(outcome.accepted).toBe(true)
    expect(outcome.reason).toContain('等待')

    await until(() => f.store.task(actor, taskId)?.subtasks[0]?.state === 'cancelled', '步骤按喊停收尾')
    const record = f.store.task(actor, taskId)!
    const subtask = record.subtasks[0]!
    expect(subtask.error).toContain('喊停')
    // 材料是成员已经交回的东西，喊停不该把它抹掉。
    expect(subtask.memberReturn?.text).toBe('先说说你要哪种版式？')
    await until(() => f.store.task(actor, taskId)?.state === 'cancelled', '任务按喊停收尾（单步取消，不是 partial）')
    await f.settleAll()
  })

  it('入口兜底收掉明显超期的等待（#6）：闹钟丢了也兜得住，按超时失败、材料保留', async () => {
    const f = await fixture()
    const taskId = await waitingTask(f)
    // 摆出"孤儿"：比兜底线（waitingTimeoutMs×2 + 60s）更老，且闹钟没在内存里（夹具不挂闹钟）。
    ageStartedAt(f.store, taskId, 's1', 600_000 * 2 + 60_000 + 60_000)

    // 任何一个写入口都会顺手兜一遍（fire-and-forget 不阻塞受理）；测试里直接等它跑完，
    // 让失败当场暴露而不是被入口的 catch 吞掉。
    await (f.console_ as unknown as { sweepStaleWaitings(a: Actor): Promise<void> }).sweepStaleWaitings(actor)
    await until(() => f.store.task(actor, taskId)?.subtasks[0]?.state === 'failed', '超期等待被兜底收尾')

    const subtask = f.store.task(actor, taskId)!.subtasks[0]!
    expect(subtask.error).toContain('过期')
    expect(subtask.memberReturn?.text).toBe('先说说你要哪种版式？')
    await f.settleAll()
  })
})
