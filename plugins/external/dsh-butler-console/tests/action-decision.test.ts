/**
 * 点掉确认卡之后的**用户决策事实**与撤回终态。
 *
 * 2026-09-18 生产现场（CF-01/CF-02）暴露的两个链路断点，本文件锁死：
 *
 * 1. 用户点了「确认」/「先不办」是这一步的亲历事实，但此前只活在事件流里
 *    （"你点了确认"），成员交回的正文只有一句"已经按你确认的办了"——裁决与汇总
 *    看不到用户做过决定，把"点了确认才删"读成"没经过确认就删了"（#12），把
 *    "点了先不删"读成"还没办"再派一轮重做（#10/K2）。现在决策事实写进 `result`
 *    一处，裁决清单、任务快照与刷新后的页面读到同一句话。
 * 2. 成员对「先不办」的投影此前恒为 completed，子任务落 succeeded；现在无剩余
 *    待办时投影 cancelled，子任务落 cancelled（对齐 README「他选择不办 cancelled」），
 *    且被撤回的那张卡要从本步名下清掉（不留死卡）。
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor, AgentAction, AgentArtifact, AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import type { ButlerMemberReturn } from '../src/storage/types.ts'
import { advanceSubtask, SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const memberConversationId = 'blog-chat-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const CARD_A = 'op-delete-352'
const CARD_B = 'op-delete-353'

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

/** 成员就地确认的投影：与博客 `createApplyAction` 修复后的形状一致（cancel 无剩余 → cancelled）。 */
type ActionProjection =
  | {
    status: 'succeeded'
    summary: string
    /** 批 2：办结材料（链接/状态）与对照操作记录的自检结论随确认结果上交。 */
    artifacts?: AgentArtifact[]
    selfCheck?: AgentSelfCheck
  }
  | { status: 'cancelled'; summary: string; actions?: AgentAction[]; externalPending?: { reason: string } }

function memberExecutor(projectionFor: (actionId: string) => ActionProjection): ButlerAgentExecutor {
  return {
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async () => ({ status: 'succeeded' as const, summary: '第一步好了' }),
    applyAction: async request => ({ ...projectionFor(request.actionId), conversationId: memberConversationId }),
  }
}

async function fixture(projectionFor: (actionId: string) => ActionProjection) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const executor = memberExecutor(projectionFor)
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

/** 建一个单步任务，步骤停在 external_pending 并声明 given 那几张卡。 */
async function pendingTask(
  f: Awaited<ReturnType<typeof fixture>>,
  declared: readonly AgentAction[],
) {
  const taskId = `butler-task-${randomUUID()}`
  f.store.openOrReserveConversation(conversationId, actor)
  f.store.createTask({
    id: taskId, conversationId, actor, goal: '删掉这篇草稿，先出确认卡等我点', note: '',
    subtasks: [{ id: 's1', goal: '删 352', agentId: 'blog', reason: '', logicalId: 'g1' }],
  })
  const memberReturn: ButlerMemberReturn = {
    protocol: 1, text: '确认卡已生成，等你点。', actions: [...declared],
    externalPending: { reason: '等你在这张卡上确认' },
  }
  advanceSubtask(f.store, taskId, 's1', 'external_pending', { memberReturn, conversationId: memberConversationId })
  return taskId
}

describe('点掉确认卡：用户决策的事实与终态', () => {
  it('点了「确认」：决策事实写进 result 一处，裁决与快照读同一句话', async () => {
    const f = await fixture(() => ({ status: 'succeeded', summary: '已经按你确认的办了。' }))
    const taskId = await pendingTask(f, [card(CARD_A, '删除草稿 352')])

    await f.console_.startAction({ taskId, subtaskId: 's1', actionId: CARD_A, decision: 'confirm', actor })
    await until(() => f.store.task(actor, taskId)?.subtasks.find(s => s.id === 's1')?.state === 'succeeded', '步骤办完')

    const subtask = f.store.task(actor, taskId)!.subtasks[0]!
    // 决策事实必须在 result 开头：裁决清单、任务快照、刷新后的页面都读它。
    expect(subtask.result.startsWith('用户已在确认卡上点了「确认」')).toBe(true)
    expect(subtask.result).toContain('已经按你确认的办了。')
    expect(subtask.memberReturn?.actions ?? []).toEqual([])
    await f.settleAll()
  })

  it('点了「先不删」且没有别的卡：投影 cancelled、子任务落 cancelled，不再被当成"还没办"', async () => {
    const f = await fixture(() => ({ status: 'cancelled', summary: '已经撤回，没有执行。' }))
    const taskId = await pendingTask(f, [card(CARD_A, '删除草稿 352')])

    await f.console_.startAction({ taskId, subtaskId: 's1', actionId: CARD_A, decision: 'cancel', actor })
    await until(() => f.store.task(actor, taskId)?.subtasks.find(s => s.id === 's1')?.state === 'cancelled', '步骤按撤回收尾')

    const subtask = f.store.task(actor, taskId)!.subtasks[0]!
    expect(subtask.result.startsWith('用户已在确认卡上点了「先不办」')).toBe(true)
    expect(subtask.result).toContain('已经撤回，没有执行。')
    // 撤回的那张卡不留在这步名下：留着就是一张点了只回"已经办完了"的死卡。
    expect(subtask.memberReturn?.actions ?? []).toEqual([])
    await f.settleAll()
  })

  it('点了「先不删」但同会话还有别的卡：这步继续等剩下的卡，被撤回的那张清掉', async () => {
    const f = await fixture(() => ({
      status: 'cancelled', summary: '已经撤回，没有执行。',
      actions: [card(CARD_B, '删除草稿 353')],
      externalPending: { reason: '这个会话里还有别的待确认操作。' },
    }))
    const taskId = await pendingTask(f, [card(CARD_A, '删除草稿 352'), card(CARD_B, '删除草稿 353')])

    await f.console_.startAction({ taskId, subtaskId: 's1', actionId: CARD_A, decision: 'cancel', actor })
    // 注意不能只等"还有 B"：初始声明里本来就有 B，那个条件会被旧状态直接满足。
    await until(() => {
      const subtask = f.store.task(actor, taskId)?.subtasks.find(s => s.id === 's1')
      const actions = subtask?.memberReturn?.actions ?? []
      return subtask?.state === 'external_pending' && actions.length === 1 && actions[0]?.id === CARD_B
    }, '撤回 A 之后这步只剩 B')

    const subtask = f.store.task(actor, taskId)!.subtasks[0]!
    expect(subtask.state).toBe('external_pending')
    expect((subtask.memberReturn?.actions ?? []).map(action => action.id), '只剩 B，A 已随撤回清掉')
      .toEqual([CARD_B])
    await f.settleAll()
  })
})

describe('点掉确认卡：办结材料落库（批 2：办了，要递东西回来核）', () => {
  const publishedMaterial: AgentArtifact = {
    kind: 'article', title: '《测试1》已发布', path: '/agents/blog?conversationId=c',
    state: 'published', url: 'https://blog.example/p/1.html',
    fields: [{ label: '发布状态', value: '已发布' }, { label: '链接', value: 'https://blog.example/p/1.html' }],
  }

  it('成员交回材料与自检结论：写进步骤记录（刷新后产出区有得画、裁决有 url/state 可比）', async () => {
    const f = await fixture(() => ({
      status: 'succeeded',
      summary: '已经按你确认的办了。《测试1》已发布。',
      artifacts: [publishedMaterial],
      selfCheck: { status: 'passed', detail: '材料取自业务库操作记录，操作已办结。' },
    }))
    const taskId = await pendingTask(f, [card(CARD_A, '删除草稿 352')])

    await f.console_.startAction({ taskId, subtaskId: 's1', actionId: CARD_A, decision: 'confirm', actor })
    await until(() => f.store.task(actor, taskId)?.subtasks.find(s => s.id === 's1')?.state === 'succeeded', '步骤办完')

    const subtask = f.store.task(actor, taskId)!.subtasks[0]!
    // 材料必须落库：只进事件不进库，重启后产出区与裁决就全丢。
    expect(subtask.artifacts).toEqual([publishedMaterial])
    // 自检结论随留存落库：裁决轮的 D-2 判据拿的是落库这一份。
    expect(subtask.memberReturn?.selfCheck).toEqual({ status: 'passed', detail: '材料取自业务库操作记录，操作已办结。' })
    // 正文仍是"决策事实 + 成员原话"，材料不拼进正文（各有各的呈现位）。
    expect(subtask.result.startsWith('用户已在确认卡上点了「确认」')).toBe(true)
    expect(subtask.result).toContain('《测试1》已发布')
    await f.settleAll()
  })

  it('成员没交材料（撤回/删除类）：步骤照常收尾，artifacts 保持原值不伪造', async () => {
    const f = await fixture(() => ({ status: 'cancelled', summary: '已经撤回，没有执行。' }))
    const taskId = await pendingTask(f, [card(CARD_A, '删除草稿 352')])

    await f.console_.startAction({ taskId, subtaskId: 's1', actionId: CARD_A, decision: 'cancel', actor })
    await until(() => f.store.task(actor, taskId)?.subtasks.find(s => s.id === 's1')?.state === 'cancelled', '步骤按撤回收尾')

    const subtask = f.store.task(actor, taskId)!.subtasks[0]!
    // 撤回没有产出：不落 `undefined`（exactOptionalPropertyTypes 惯例），也不编一份材料。
    expect(subtask.artifacts).toEqual([])
    expect(subtask.memberReturn?.selfCheck).toBeUndefined()
    await f.settleAll()
  })
})

describe('跨任务的待办归属（#13）', () => {
  it('点掉后出任务的卡时，成员交回的会话级清单不会把先出任务已声明的卡挂过来', async () => {
    // 现场重放：任务一先声明了发布卡 X；同会话又开了任务二（等它自己那张卡 Y）。
    // 点 Y 之后成员交回的是整份会话清单 [X, Y]——X 不许跟着挂到任务二名下，
    // 否则页面上 X 挂两处，点任务二名下的 X 结算的就是错的任务。
    const CARD_X = 'op-publish-355'
    const f = await fixture(() => ({
      status: 'succeeded', summary: '已经按你确认的办了。',
      actions: [card(CARD_X, '发布《测试废稿D》')],
    }))
    const conversation = conversationId
    f.store.openOrReserveConversation(conversation, actor)
    f.store.createTask({
      id: 'task-early', conversationId: conversation, actor,
      goal: '发布 355：先出确认卡', note: '',
      subtasks: [{ id: 's1', goal: '出发布卡', agentId: 'blog', reason: '', logicalId: 'g1' }],
    })
    advanceSubtask(f.store, 'task-early', 's1', 'external_pending', {
      memberReturn: { protocol: 1, text: '发布卡已生成。', actions: [card(CARD_X, '发布《测试废稿D》')], externalPending: { reason: '等你确认发布' } },
      conversationId: memberConversationId,
    })
    f.store.createTask({
      id: 'task-late', conversationId: conversation, actor,
      goal: '删掉别的稿：也出一张卡', note: '',
      subtasks: [{ id: 's1', goal: '出删除卡', agentId: 'blog', reason: '', logicalId: 'g1' }],
    })
    advanceSubtask(f.store, 'task-late', 's1', 'external_pending', {
      memberReturn: { protocol: 1, text: '删除卡已生成。', actions: [card(CARD_B, '删除草稿 353')], externalPending: { reason: '等你确认删除' } },
      conversationId: memberConversationId,
    })

    await f.console_.startAction({ taskId: 'task-late', subtaskId: 's1', actionId: CARD_B, decision: 'confirm', actor })
    await until(() => f.store.task(actor, 'task-late')?.subtasks[0]?.state === 'succeeded', '后出任务的步骤办完')

    const late = f.store.task(actor, 'task-late')!.subtasks[0]!
    expect((late.memberReturn?.actions ?? []).map(item => item.id), '会话级清单里先出任务的卡不许挂到这步名下')
      .toEqual([])
    const early = f.store.task(actor, 'task-early')!.subtasks[0]!
    expect((early.memberReturn?.actions ?? []).map(item => item.id), '先出任务名下的卡保持原样，等它自己被点')
      .toEqual([CARD_X])
    await f.settleAll()
  })
})
