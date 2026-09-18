/**
 * 办完一张确认卡之后：**待办只归声明过它的那一步**。
 *
 * ## 现场（2026-09-18 17:23，用户报「这个是什么意思，我没看懂」）
 *
 * 老板说"343、342 这两篇需要删除，但是需要我一个一个确认删除"，拆成两步、共用同一个成员会话：
 *
 * ```
 * 17:23:07  第一步那一轮做出 342 的卡
 * 17:23:16  第二步那一轮做出 343 的卡（成员交回的是**会话级**清单：342 也还在）
 * 17:23:27  老板点掉 342 的卡 → 成员交回"这个会话里还剩 343"
 * 17:23:35  老板又点了一张 343 的卡 —— 但结算的是**第一步**
 * ```
 *
 * 因为那张 343 的卡是**挂在第一步下面**的：第一步办完时成员交回的"还剩 343"被整份挂到了它名下，
 * 界面于是把同一张卡在两个步骤下面各画了一遍。结算第一步之后，真正等 343 的第二步永远停在
 * "待外部处理"，任务卡在 `external_pending`，界面上留着一张点了只回"已经按你确认的办了"的卡。
 *
 * 这条判据钉住两条：办完之后只留**自己声明过的**待办；同会话里已经不在清单里的卡要清掉。
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import type { ButlerMemberReturn } from '../src/storage/types.ts'
import type { AgentAction } from '@dsh-plugin-manager/plugin-kit'
import { advanceSubtask, SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const memberConversationId = 'blog-chat-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const CARD_A = 'op-delete-342'
const CARD_B = 'op-delete-343'

const card = (id: string, title: string): AgentAction => ({
  id, kind: 'blog.delete', title, summary: '确认后会永久删除这篇文章，无法恢复。', state: 'prepared',
})

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
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

/** 成员的就地确认：**交回会话级清单**（与博客 `createApplyAction` 同一个形状）。 */
type StubDispatch = { status: 'succeeded' | 'external_pending'; summary: string; actions?: AgentAction[]; externalPending?: { reason: string } }

function memberExecutor(dispatchResults: Record<string, StubDispatch> = {}): ButlerAgentExecutor {
  const executor: ButlerAgentExecutor = {
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async request => {
      const fixed = dispatchResults[request.subtaskId]
      // 派单请求不带原会话引用：这一步的会话就是成员自己的会话（与生产同形）。
      if (fixed !== undefined) return { ...fixed, conversationId: memberConversationId }
      return { status: 'succeeded' as const, summary: '第一步好了' }
    },
    applyAction: async request => {
      // 与真实桥接同一个口径：把协调方给的原会话引用**原样带回**（会话级待办要靠它归属）。
      const echoed = request.conversationId ?? ''
      if (request.actionId === CARD_A) {
        // 办掉 A 之后，这个会话里还剩 B —— 成员如实交回整份清单。
        return {
          status: 'external_pending' as const,
          summary: '已经按你确认的办了。',
          conversationId: echoed,
          actions: [card(CARD_B, '删除《测试2》')],
          externalPending: { reason: '这个会话里还有别的待确认操作。' },
        }
      }
      // 桥接把参与者的 `completed` 映射成协调方的 `succeeded`（`toButlerStatus`）：这里按同一口径。
      return { status: 'succeeded' as const, summary: '已经按你确认的办了。', conversationId: echoed, actions: [] }
    },
  }
  return executor
}

async function fixture(dispatchResults: Record<string, StubDispatch> = {}) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const executor = memberExecutor(dispatchResults)
  const console_ = new ButlerConsole(context(executor), config, access, new SqliteButlerStorage(store), '')
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

describe('办完一张卡之后，待办只归声明过它的那一步', () => {
  it('第一步办完时交回的"还剩第二张卡"，不会搬到第一步名下；第二步仍能办完并收尾', async () => {
    const f = await fixture()
    const taskId = `butler-task-${randomUUID()}`
    f.store.openOrReserveConversation(conversationId, actor)
    f.store.createTask({
      id: taskId, conversationId, actor, goal: '343、342 这两篇需要删除，但是需要我一个一个确认删除', note: '',
      subtasks: [
        { id: 's1', goal: '删 342', agentId: 'blog', reason: '', logicalId: 'g1' },
        { id: 's2', goal: '删 343', agentId: 'blog', reason: '', logicalId: 'g2' },
      ],
    })
    const returns: ButlerMemberReturn[] = [
      // 第一步那一轮：只做出自己那张卡。
      { protocol: 1, text: '已生成 342 的确认卡片，等你确认。', actions: [card(CARD_A, '删除草稿 342')] },
      // 第二步那一轮：成员交回的是**会话级**清单 —— 342 也还在（这就是重复挂卡的来源）。
      { protocol: 1, text: '已生成 343 的确认卡片，等你确认。', actions: [card(CARD_A, '删除草稿 342'), card(CARD_B, '删除草稿 343')] },
    ]
    for (const [index, id] of ['s1', 's2'].entries()) {
      const memberReturn = returns[index]
      if (memberReturn === undefined) throw new Error(`夹具缺第 ${index + 1} 步的协作返回`)
      advanceSubtask(f.store, taskId, id, 'external_pending', { memberReturn, conversationId: memberConversationId })
    }

    // 老板点了挂在**第一步**下面的 342 那张卡（界面把同一张卡画在了两个步骤下面）。
    await f.console_.startAction({ taskId, subtaskId: 's1', actionId: CARD_A, decision: 'confirm', actor })
    await until(() => f.store.task(actor, taskId)?.subtasks.find(s => s.id === 's1')?.state === 'succeeded', '第一步办完')

    const s1 = f.store.task(actor, taskId)?.subtasks.find(item => item.id === 's1')
    const s2 = f.store.task(actor, taskId)?.subtasks.find(item => item.id === 's2')
    expect(s1?.memberReturn?.actions ?? [], '第一步自己已经没有待办，不该把第二步的卡搬过来')
      .toEqual([])
    expect((s2?.memberReturn?.actions ?? []).map(action => action.id), '第二步手上那张 342 的卡已经办完，该清掉')
      .toEqual([CARD_B])

    // 老板接着点 343 的卡 —— 现在它只挂在第二步下面，结算的就是第二步。
    await f.console_.startAction({ taskId, subtaskId: 's2', actionId: CARD_B, decision: 'confirm', actor })
    await until(() => f.store.task(actor, taskId)?.subtasks.find(s => s.id === 's2')?.state === 'succeeded', '第二步办完')
    await until(() => f.store.task(actor, taskId)?.state === 'completed', '整轮收尾')

    const after = f.store.task(actor, taskId)
    expect(after?.subtasks.every(item => item.state === 'succeeded')).toBe(true)
    expect((after?.subtasks ?? []).flatMap(item => item.memberReturn?.actions ?? []).length, '办完之后不该还剩待办').toBe(0)
    await f.settleAll()
  })

  it('派活那一路同样不搬：后一步的清单里带着前一步的卡，也不挂到自己名下', async () => {
    // 第二步那一轮交回的是会话级清单：第一步刚做出来的 A 也在里面（生产上就是这样冒出两张同样的卡）。
    const f = await fixture({
      s2: {
        status: 'external_pending',
        summary: '已生成 343 的确认卡片，等你确认。',
        externalPending: { reason: '还有确认卡等你点。' },
        actions: [card(CARD_A, '删除草稿 342'), card(CARD_B, '删除草稿 343')],
      },
      s1: {
        status: 'external_pending',
        summary: '已生成 342 的确认卡片，等你确认。',
        externalPending: { reason: '还有确认卡等你点。' },
        actions: [card(CARD_A, '删除草稿 342')],
      },
    })
    const taskId = `butler-task-${randomUUID()}`
    f.store.openOrReserveConversation(conversationId, actor)
    f.store.createTask({
      id: taskId, conversationId, actor, goal: '343、342 这两篇需要删除，但是需要我一个一个确认删除', note: '',
      subtasks: [
        { id: 's1', goal: '删 342', agentId: 'blog', reason: '', logicalId: 'g1' },
        { id: 's2', goal: '删 343', agentId: 'blog', reason: '', logicalId: 'g2' },
      ],
    })

    // 队列把两步依次派出去（与生产同一条路）。
    const drainQueue = (f.console_ as unknown as {
      drainQueue(input: { taskId: string; actor: Actor; goal: string; signal: AbortSignal }): AsyncGenerator<unknown>
    }).drainQueue.bind(f.console_)
    for await (const _event of drainQueue({ taskId, actor, goal: '删两篇', signal: new AbortController().signal })) { /* 无观众 */ }

    const task = f.store.task(actor, taskId)
    const s1 = task?.subtasks.find(item => item.id === 's1')
    const s2 = task?.subtasks.find(item => item.id === 's2')
    expect(s1?.state).toBe('external_pending')
    expect(s2?.state).toBe('external_pending')
    expect((s1?.memberReturn?.actions ?? []).map(action => action.id), '第一步只该有自己那张卡').toEqual([CARD_A])
    expect((s2?.memberReturn?.actions ?? []).map(action => action.id), '第二步不该把第一步那张卡也挂过来').toEqual([CARD_B])
    await f.settleAll()
  })
})
