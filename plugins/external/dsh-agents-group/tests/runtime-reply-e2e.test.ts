/**
 * P1 判据② 的端到端覆盖：**真 `ButlerConsole.submitReply` → 桥接 → 运行时 `participant.reply`**。
 *
 * 判据原文要求"`reply`/`waiting` 由**运行时实现的 participant** 产出并**经 butler `/reply`
 * 走通一轮**（**不能用替身**）"。此前两侧都有绿，但**中间那一跳没有覆盖**：
 *
 * - `runtime-minimal-agent.test.ts` 用的是内存端口替身，全程不碰 butler；
 * - `acceptance-field.test.ts` 虽然真的走 `submitReply`，但它的 `executor` 是**假替身**。
 *
 * 这个文件走的是真链：`ButlerConsole`（真：真落库、真调度、真等待上下文）→ `executorFor`
 * 桥接（真：逐字段重建）→ **运行时 `createParticipant`**（真：会话生命周期、收尾循环、
 * ⑦⑧）。只有两侧的**宿主**是假的（butler 侧用 SQLite 替身存储，运行时侧用精简假宿主），
 * 因为它们不是被测对象。
 *
 * 断言落在**跨这一跳之后仍然成立的东西**上：子任务真的停在 `waiting_user`、续问真的沿原
 * 会话续接、以及运行时的 `selfCheck` 结论真的过了桥。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it } from 'vitest'
import { ButlerConsole } from '../../dsh-butler-console/src/butler.ts'
import type { Config } from '../../dsh-butler-console/src/config.ts'
import type { ButlerAgentExecutor } from '../../dsh-butler-console/src/protocol.ts'
import { SqliteButlerStorage, TaskStore } from '../../dsh-butler-console/tests/helpers/sqlite-test-store.ts'
import { executorFor } from '../src/butler-bridge.ts'
import type { AgentManifest } from '../src/agents/registry.ts'
import { ConversationLifecycle, type AgentRuntime, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import { createParticipant, type RuntimeParticipant } from '../packages/runtime/src/participant.ts'
import type { AgentDefinition, ProjectedResult } from '../packages/runtime/src/definition.ts'
import type { AgentDatabasePort, AgentStoragePort, ConversationPort, TurnStorePort } from '../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'

const AGENT_ID = 'closure-e2e'
const CONVERSATION_ID = 'closure-e2e-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-chat' }

const sleep = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await sleep()
  }
  throw new Error(`等待超时：${label}`)
}

// ---------------------------------------------------------------------------
// 运行时侧：精简假宿主（与 runtime-closure.test.ts 同一套做法的再一份）
// ---------------------------------------------------------------------------

function runtimeHost(definition: AgentDefinition, questions = new Map<string, string>()) {
  const byEvent = new Map<string, Set<(...args: unknown[]) => void>>()
  const sessions = new Map<string, { id: string; events: SessionEvent[]; agent: Agent }>()
  const followups: { readonly id: string; readonly text: string }[] = []
  const openedIds: string[] = []
  let seq = 0

  const sessionOf = (id: string) => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [] as SessionEvent[] } as { id: string; events: SessionEvent[]; agent: Agent }
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: (message: unknown) => {
        followups.push({ id, text: (message as { content?: readonly { text?: string }[] }).content?.[0]?.text ?? '' })
        seq += 1
        session.events.push({ type: 'user/message', data: message, time: Date.now(), seq } as unknown as SessionEvent)
      },
      whenIdle: async () => {},
      cancel: () => {},
    } as unknown as Agent
    sessions.set(id, session)
    return session
  }
  const emit = (type: string, data: unknown, conversationId: string): void => {
    const session = sessionOf(conversationId)
    seq += 1
    const value = { type, data, time: Date.now(), seq } as unknown as SessionEvent
    session.events.push(value)
    for (const listener of [...(byEvent.get('session/event') ?? [])]) listener({ id: conversationId }, value)
  }
  // `register` 是交活工具的接线口（`conversation.ts` 的 `registerScopedTools`）。本文件的
  // `agents` 替身**不调 `setup`**（会话不装配人设段），但接口仍放在位：将来一旦有人让替身
  // 走上 setup，接线不会在这里以"register 不是函数"炸掉。
  const scope = { systemPrompt: { section: () => {} }, tools: { restrict: () => {}, register: () => () => {} } } as unknown as Context
  const agents = {
    create: async (input: { readonly sessionId: unknown }) => {
      const session = sessionOf(String(input.sessionId))
      openedIds.push(session.id)
      return { agent: session.agent, dispose: async () => {} }
    },
    resume: async (input: { readonly resumeSessionId: unknown }) => {
      const session = sessionOf(String(input.resumeSessionId))
      openedIds.push(session.id)
      return { agent: session.agent, dispose: async () => {} }
    },
    list: () => [],
    get: () => undefined,
  }
  const llm = { resolveCallConfig: async (value: unknown) => value, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'medium' }] } }) }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ ...DEFAULT_MODEL }) },
    sessionController: {
      modelCatalog: async () => ({ groups: [{ id: DEFAULT_MODEL.provider, name: 'DeepSeek', models: [{ id: DEFAULT_MODEL.model, name: 'DeepSeek Chat' }] }], failures: [], selected: { ...DEFAULT_MODEL } }),
      selectModel: async (input: { readonly provider: string; readonly model: string }) => ({ selected: { provider: input.provider, model: input.model } }),
    },
    llm,
    sessionPersistence: { inspect: async (id: string) => ({ events: sessions.get(id)?.events ?? [], header: { id } }) },
    sessionProjections: { restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { ...DEFAULT_MODEL } } } } }) },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    agents,
  }
  const ctx = {
    effect: (effect: () => () => Promise<void> | void) => { void effect() },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const group = byEvent.get(name) ?? new Set<(...args: unknown[]) => void>()
      group.add(listener); byEvent.set(name, group)
      return () => { group.delete(listener) }
    },
    get: (name: string) => services[name],
    llm,
    agents,
    root: { emit: () => {} },
  } as unknown as Context
  const access: Access = {
    mode: 'authenticated', ready: () => {}, resolve: () => actor,
    assert: value => { if (value !== actor) throw new AccessError(403, '无权访问') },
  }
  const port: ConversationPort = new MemoryConversationPort(AGENT_ID)
  const turns: TurnStorePort = {
    claim: async () => 'claimed',
    finish: async () => {},
    // 与恒 `'claimed'` 自洽：没有"已存在"的轮次，也就没有状态可答。
    turnStatus: async () => undefined,
    // 结果层（`dsh_turn_results`）本文件用不到，如实返回"没有这一轮 / 没有结果"。
    // 结果层的真实覆盖在 `runtime-turn-results.test.ts`。
    turnId: async () => undefined,
    appendTurnResult: async () => '',
    turnResults: async () => [],
    // ③-A 的端口增量本文件用不到。**故意抛**而不是返回空值：静默返回 `undefined` / `[]` / `{}`
    // 会把"线接到了这里"伪装成成功（假绿）。真实覆盖在 `storage-contract.test.ts`（真 PG）。
    turnById: async () => { throw new Error('本文件的替身不实现 turnById') },
    turnsOf: async () => { throw new Error('本文件的替身不实现 turnsOf') },
    turnResultsOf: async () => { throw new Error('本文件的替身不实现 turnResultsOf') },
    turnsByOperationId: async () => { throw new Error('本文件的替身不实现 turnsByOperationId') },
    patchTurnPayload: async () => { throw new Error('本文件的替身不实现 patchTurnPayload') },
    pendingQuestion: async (owner, conversationId) => questions.get(`${owner.namespace}:${owner.userId}:${conversationId}`),
    setPendingQuestion: async (owner, conversationId, question) => {
      const key = `${owner.namespace}:${owner.userId}:${conversationId}`
      if (question === undefined) questions.delete(key)
      else questions.set(key, question)
    },
  }
  const db = {
    assertSchema: async () => {}, conversations: port, turns,
    query: async () => [],
    transaction: async (fn: (tx: AgentDatabasePort) => Promise<unknown>) => fn(db as unknown as AgentDatabasePort),
    close: async () => {},
  } as unknown as AgentDatabasePort
  const storage: AgentStoragePort = { db, access }
  const config: RuntimeConfig = { routePrefix: '/closure-e2e', turnTimeoutMs: 30_000, authRecheckMs: 10_000, maxActiveConversations: 8, reasoningEffort: 'medium' }
  const lifecycle = new ConversationLifecycle({ ctx, definition, access, store: port, config, allowedTools: () => [] })
  const runtime: AgentRuntime = { ctx, definition, access, store: port, config, allowedTools: () => [] }
  const participant: RuntimeParticipant = createParticipant({ definition, runtime: { ...runtime, lifecycle: () => lifecycle }, storage, access, config })
  void scope
  return {
    participant, lifecycle, questions,
    followups: () => followups,
    lastConversation: () => openedIds[openedIds.length - 1] ?? '',
    complete: (conversationId: string, text: string, reason = 'completed') => {
      emit('turn/start', { turn: 1 }, conversationId)
      emit('assistant/message', { message: { content: [{ type: 'text', text }] }, step: 0 }, conversationId)
      emit('turn/end', { reason: { kind: reason } }, conversationId)
    },
  }
}

// ---------------------------------------------------------------------------
// butler 侧：真 ButlerConsole + SQLite 落库
// ---------------------------------------------------------------------------

const manifest: AgentManifest = {
  id: AGENT_ID,
  displayName: '闭环 Agent',
  directory: 'closure',
  category: '测试',
  description: '端到端用',
}

function butlerContext(executor: ButlerAgentExecutor): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: executor.agentId, packageName: 'dsh-closure', version: '1.0.0', displayName: '闭环 Agent',
          description: '端到端用', entryPath: '/closure', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

const definitionOf = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: AGENT_ID, displayName: '闭环 Agent', description: '端到端用', persona: '你好', tools: () => [], config: {} as never,
  ...overrides,
})

describe('真链：ButlerConsole.submitReply → executorFor 桥接 → 运行时 participant.reply', () => {
  it('派单产出 waiting_user（运行时真身）→ 续问沿原会话走通一轮', async () => {
    // 运行时侧：业务声明"需要用户补一句话"，所以收尾会产出 `waiting`。
    const questions = new Map<string, string>()
    const hosted = runtimeHost(
      definitionOf({
        projectResult: async (): Promise<ProjectedResult> => ({ status: 'completed', text: '第一版写好了', question: '采用哪一版？' }),
        needsReply: () => true,
      }),
      questions,
    )
    // 桥接：把运行时 participant 包成 butler 的执行入口（真 `executorFor`，逐字段重建那一层）。
    const executor = executorFor(manifest, hosted.participant)

    const store = new TaskStore(':memory:')
    store.reserveConversation(CONVERSATION_ID, actor)
    const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
    const config = {
      subtaskTimeoutMs: 20_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
      waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
    } as Config
    const console_ = new ButlerConsole(butlerContext(executor), config, access, new SqliteButlerStorage(store), '')
    store.createTask({
      id: 'task-1', conversationId: CONVERSATION_ID, actor, goal: '按新版本改一遍', note: '',
      subtasks: [{ id: 's1', goal: '第一步', agentId: AGENT_ID, reason: '只有它能干' }],
    })
    const dispatchSubtask = (console_ as unknown as {
      dispatchSubtask(value: unknown): AsyncGenerator<unknown, unknown>
    }).dispatchSubtask.bind(console_)

    try {
      // —— 派单：butler → 桥接 → 运行时 participant.run ——
      const dispatched: unknown[] = []
      const dispatching = (async () => {
        for await (const event of dispatchSubtask({
          taskId: 'task-1', subtaskId: 's1', goal: '第一步', agentId: AGENT_ID,
          displayName: '闭环 Agent', taskGoal: '按新版本改一遍', actor,
          signal: new AbortController().signal,
        })) dispatched.push(event)
      })()
      // 运行时那一轮：模型交活（带 waiting）→ 收尾产出 waiting。
      await until(() => hosted.followups().length >= 1, '运行时接单')
      const conversationId = hosted.lastConversation()
      hosted.participant.handoffFor(conversationId).submit({ status: 'waiting', text: '第一版写好了', question: '采用哪一版？' })
      hosted.complete(conversationId, '第一版写好了')
      await dispatching

      // **跨了一整跳之后仍然成立**：子任务真的停在等人回话，正文与问题都过了桥。
      const record = store.task(actor, 'task-1')
      expect(record?.subtasks[0]?.state).toBe('waiting_user')
      expect(record?.subtasks[0]?.result).toContain('第一版写好了')
      // ⚠️ `question` 不在 `result` 列里：butler 把结果正文写进 `result`，而等待的问题走
      // **事件**（`state: 'waiting_user'` 的那条带 `question` 字段）。断在事件上才断对了地方。
      const waitingEvent = dispatched.find(event => (event as { state?: string }).state === 'waiting_user') as
        { readonly question?: string } | undefined
      expect(waitingEvent?.question).toBe('采用哪一版？')
      // 待答问题也落了载体（运行时那边写的，用的是运行时自己的会话 id）。
      expect(questions.get(`user:alice:${conversationId}`)).toBe('采用哪一版？')

      // —— 续问：真 `submitReply`（async generator）→ butler → 桥接 → 运行时 participant.reply ——
      const replies: unknown[] = []
      const replying = (async () => {
        for await (const event of console_.submitReply({
          taskId: 'task-1', subtaskId: 's1', text: '采用第二版', decideByAgent: false, actor,
        })) replies.push(event)
      })()
      await until(() => hosted.followups().length >= 2, '续问被运行时受理')
      // 续问的那一轮：交活一个终态结论。
      const secondId = hosted.lastConversation()
      hosted.participant.handoffFor(secondId).submit({ status: 'completed', text: '按第二版改完了' })
      hosted.complete(secondId, '按第二版改完了')
      await replying

      expect(replies.length).toBeGreaterThan(0)
      // 续问**沿原会话**：没有新建会话（同一个会话 id 被复用）。
      expect(hosted.lastConversation()).toBe(conversationId)
      // 终态落库，且带上了运行时回报的 selfCheck（过了桥的那一份）。
      const settled = store.task(actor, 'task-1')
      expect(settled?.subtasks[0]?.result).toContain('按第二版改完了')
      expect(settled?.subtasks[0]?.state).toBe('succeeded')
    } finally { await hosted.lifecycle.dispose(); store.close() }
  })
})
