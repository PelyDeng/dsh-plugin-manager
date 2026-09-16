/**
 * `TurnStorePort.claim` 接线的**唯一覆盖**。
 *
 * ⚠️ 为什么必须有这个文件：`runtime-closure.test.ts` 与 `runtime-reply-e2e.test.ts` 里的假
 * `TurnStorePort` 都是 `claim: async () => 'claimed'`（永远"首次受理"）⇒ 接线之后它们全部仍走
 * 首次受理分支，**一处接线都碰不到、也全绿**。这正是"实现与测试各自都在、中间的线没接"能在本
 * 项目连续发生三次的结构性原因：替身太宽松。所以这里的替身是**可编程**的，专门逼出另外两条分支。
 *
 * 被锁的四件事：
 *   C1 接线真的存在于生产路径（而不是只有接口和实现）；
 *   C2 它发生在**第一个副作用之前**（放晚就等于没接）；
 *   C3 `duplicate` + `finished`（已交付过）⇒ 显式拒绝，不静默重跑；
 *   C4 `duplicate` + `claimed`（上一轮崩在半路）⇒ 视为中断，允许重跑；
 *   C5 `finish` 发生在 `resolve` **之前**（反了会留下 `claimed` 行，下次被判可重跑 ⇒ 重复副作用）；
 *   C6 没有存储门面时整层跳过，不炸。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it } from 'vitest'
import type { ParticipantRequest, ParticipantResult } from '../packages/runtime/src/contract.ts'
import { ConversationLifecycle, type AgentRuntime, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import { createParticipant } from '../packages/runtime/src/participant.ts'
import type { AgentDefinition } from '../packages/runtime/src/definition.ts'
import type { AgentDatabasePort, AgentStoragePort, TurnStorePort } from '../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'

const AGENT_ID = 'claim-agent'
const ACTOR: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-chat' }
const REQUEST_ID = 'r1'
const MESSAGE = '干活'
/** 运行时给 `claim` 的身份：`settledKey` 带 mode 前缀，与"`run`/`reply` 分开算"一致。 */
const EXPECTED_KEY = `run:${REQUEST_ID}`

const sleep = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** 有界等待；失败时给有信息量的错，而不是干等超时。 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await sleep()
  }
  throw new Error(`等待超时：${label}`)
}

interface FakeSession {
  readonly id: string
  readonly events: SessionEvent[]
  agent: Agent
}

/** 替身记录下来的调用痕迹 —— C1/C2/C4/C5 全看它。 */
interface Calls {
  /** **共享事件序列**：`claim` 与 `followup` 都往里追加，用来断言先后（C2）。 */
  readonly events: string[]
  readonly claimed: { requestId: string; inputHash: string; conversationId: string }[]
  readonly finished: string[]
  /** `finish` 被调用那一刻，"结果是否已经 resolve"（C5 必须是 `false`）。 */
  finishSawResolved: boolean
}

interface HostOptions {
  /** 假 `claim` 的答案；缺省 `'claimed'`（首次受理）。 */
  readonly verdict?: 'claimed' | 'duplicate'
  /** 假 `turnStatus` 的答案；只在 `verdict === 'duplicate'` 时被问到。 */
  readonly status?: 'claimed' | 'finished' | undefined
  /** 不传存储门面，验 C6。 */
  readonly withoutStorage?: boolean
}

function host(options: HostOptions = {}) {
  const byEvent = new Map<string, Set<(...args: unknown[]) => void>>()
  const sessions = new Map<string, FakeSession>()
  const followups: { readonly id: string; readonly text: string }[] = []
  const disposers: (() => Promise<void> | void)[] = []
  const openedIds: string[] = []
  const calls: Calls = { events: [], claimed: [], finished: [], finishSawResolved: false }
  /** 判定 C5 用：`resolve` 之后由调用方的 `.then` 置真。 */
  const settledFlag = { value: false }
  let seq = 0

  const sessionOf = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [] } as unknown as FakeSession
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: (message: unknown) => {
        const text = (message as { content?: readonly { text?: string }[] }).content?.[0]?.text ?? ''
        followups.push({ id, text })
        // 与 `claim` 共用一条序列：C2 靠比较两者下标来证明"claim 在 followup 之前"。
        calls.events.push('followup')
        seq += 1
        session.events.push({ type: 'user/message', data: message, time: Date.now(), seq } as unknown as SessionEvent)
      },
      whenIdle: async () => {},
      cancel: () => {},
    } as unknown as Agent
    sessions.set(id, session)
    return session
  }

  const dispatch = (name: string, ...args: unknown[]): void => {
    for (const listener of [...(byEvent.get(name) ?? [])]) listener(...args)
  }
  const emit = (type: string, data: unknown, conversationId: string): void => {
    const session = sessionOf(conversationId)
    seq += 1
    const value = { type, data, time: Date.now(), seq } as unknown as SessionEvent
    session.events.push(value)
    dispatch('session/event', { id: conversationId }, value)
  }

  const turns: TurnStorePort = {
    claim: async (_owner, conversationId, requestId, inputHash) => {
      calls.events.push('claim')
      calls.claimed.push({ requestId, inputHash, conversationId })
      return options.verdict ?? 'claimed'
    },
    finish: async (_owner, requestId) => {
      calls.finished.push(requestId)
      // ⚠️ 必须先让出一个微任务再读。少了这一步，`finish` 与 `resolve` 在同一个同步块里，
      // 调用方的 `.then` 回调根本还没机会跑，读到的**永远是 `false`** —— 用例就成了假绿：
      // 把 `finish` 挪到 `resolve` 之后它照样通过。让出之后，顺序错了才会被观察到。
      await Promise.resolve()
      calls.finishSawResolved = settledFlag.value
    },
    turnStatus: async () => options.status,
    pendingQuestion: async () => undefined,
    setPendingQuestion: async () => {},
  }

  const port = new MemoryConversationPort(AGENT_ID)
  const db = {
    assertSchema: async () => {},
    conversations: port,
    turns,
    query: async () => [],
    transaction: async (fn: (tx: AgentDatabasePort) => Promise<unknown>) => fn(db as unknown as AgentDatabasePort),
    close: async () => {},
  } as unknown as AgentDatabasePort
  const storage: AgentStoragePort = { db, access: { mode: 'authenticated' } as unknown as Access }

  const scopeOf = (): Context => ({
    systemPrompt: { section: () => {} },
    tools: { restrict: () => {} },
  }) as unknown as Context
  const agents = {
    create: async (input: { readonly sessionId: unknown; readonly setup?: (ctx: Context, agent: Agent) => unknown }) => {
      const session = sessionOf(String(input.sessionId))
      openedIds.push(session.id)
      await input.setup?.(scopeOf(), session.agent)
      return { agent: session.agent, dispose: async () => {} }
    },
    resume: async (input: { readonly resumeSessionId: unknown; readonly setup?: (ctx: Context, agent: Agent) => unknown }) => {
      const session = sessionOf(String(input.resumeSessionId))
      await input.setup?.(scopeOf(), session.agent)
      return { agent: session.agent, dispose: async () => {} }
    },
    list: () => [],
    get: () => undefined,
  }
  const llm = {
    resolveCallConfig: async (value: unknown) => value,
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'medium' }] } }),
  }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ ...DEFAULT_MODEL }) },
    sessionController: {
      modelCatalog: async () => ({
        groups: [{ id: DEFAULT_MODEL.provider, name: 'DeepSeek', models: [{ id: DEFAULT_MODEL.model, name: 'DeepSeek Chat' }] }],
        failures: [],
        selected: { ...DEFAULT_MODEL },
      }),
      selectModel: async (input: { readonly provider: string; readonly model: string }) => ({ selected: { provider: input.provider, model: input.model } }),
    },
    llm,
    sessionPersistence: { inspect: async (id: string) => ({ events: sessions.get(id)?.events ?? [], header: { id } }) },
    sessionProjections: { restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { ...DEFAULT_MODEL } } } } }) },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    agents,
  }
  const ctx = {
    effect: (effect: () => () => Promise<void> | void) => { disposers.push(effect()) },
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
    mode: 'authenticated',
    ready: () => {},
    resolve: () => ACTOR,
    assert: value => { if (value !== ACTOR) throw new AccessError(403, '无权访问') },
  }
  const runtimeConfig: RuntimeConfig = {
    routePrefix: '/claim', turnTimeoutMs: 30_000, authRecheckMs: 10_000,
    maxActiveConversations: 8, reasoningEffort: 'medium',
  }
  const lifecycle = new ConversationLifecycle({
    ctx, definition: definitionOf(), access, store: port, config: runtimeConfig, allowedTools: () => [],
  })
  const runtime: AgentRuntime = { ctx, definition: definitionOf(), access, store: port, config: runtimeConfig, lifecycle, allowedTools: () => [] }
  // C6 靠"根本不传 storage"来验：少了这个守卫，接线处会以 TypeError 炸掉。
  const participant = options.withoutStorage === true
    ? createParticipant({ definition: definitionOf(), runtime, access, config: runtimeConfig })
    : createParticipant({ definition: definitionOf(), runtime, storage, access, config: runtimeConfig })

  return {
    participant, calls, settledFlag,
    followups: () => followups,
    lastConversation: () => openedIds[openedIds.length - 1] ?? '',
    /** 发一轮完整回合（单轮就够：没装交活工具 ⇒ 不做补交轮，直接按投影交付）。 */
    complete: (conversationId: string, text: string) => {
      emit('turn/start', { turn: 1 }, conversationId)
      emit('assistant/message', { message: { content: [{ type: 'text', text }] }, step: 0 }, conversationId)
      emit('turn/end', { reason: { kind: 'completed' } }, conversationId)
    },
    request: (overrides: Partial<ParticipantRequest> = {}): ParticipantRequest => ({
      actor: ACTOR, missionId: 'm1', requestId: REQUEST_ID, message: MESSAGE,
      signal: new AbortController().signal, onProgress: () => {},
      ...overrides,
    }),
    /** 等会话接单并返回它的 id；先挂 `catch` 以免未处理拒绝污染别处。 */
    accept: async (promise: Promise<ParticipantResult>): Promise<string> => {
      void promise.catch(() => {})
      await until(() => followups.length > 0, '接单')
      return openedIds[openedIds.length - 1] ?? ''
    },
    dispose: async () => { await lifecycle.dispose(); await Promise.allSettled(disposers.map(fn => fn())) },
  }
}

const definitionOf = (): AgentDefinition => ({
  id: AGENT_ID,
  displayName: '认领 Agent',
  description: '只跑一轮',
  persona: '你好',
  tools: () => [],
  config: {} as never,
})

/** 跑完一轮并返回结果；同时登记"结果已 resolve"供 C5 使用。 */
async function runOnce(h: ReturnType<typeof host>): Promise<ParticipantResult> {
  const promise = h.participant.run(h.request())
  // 登记"结果已 settle"，供 C5 判定 `finish` 是在它之前还是之后被调的。
  promise.then(() => { h.settledFlag.value = true })
  const id = await h.accept(promise)
  h.complete(id, '这一轮的正文')
  return promise
}

describe('判据：轮次幂等真的接在运行时上（`dsh_turns`）', () => {
  it('C1 接线存在：claim 收到 mode 前缀的身份、正文摘要与**已 open 的会话 id**', async () => {
    const h = host()
    try {
      const promise = h.participant.run(h.request())
      const id = await h.accept(promise)
      h.complete(id, '正文')
      await promise
      expect(h.calls.claimed).toHaveLength(1)
      expect(h.calls.claimed[0]?.requestId).toBe(EXPECTED_KEY)
      // `inputHash` 用整条正文：同身份换正文时 `claim` 才会报 409，而不是当成同一次重跑。
      expect(h.calls.claimed[0]?.inputHash).toBe(MESSAGE)
      // 会话 id 必须是**已建立句柄之后**的那个；放早（open 之前）根本没有 id 可用。
      expect(h.calls.claimed[0]?.conversationId).toBe(id)
      expect(id).not.toBe('')
    } finally { await h.dispose() }
  })

  it('C2 顺序：claim 发生在第一个副作用（followup 注入）之前 —— 放晚就等于没接', async () => {
    const h = host()
    try {
      const promise = h.participant.run(h.request())
      const id = await h.accept(promise)
      h.complete(id, '正文')
      await promise
      const claimAt = h.calls.events.indexOf('claim')
      const followAt = h.calls.events.indexOf('followup')
      expect(claimAt).toBeGreaterThanOrEqual(0)
      expect(followAt).toBeGreaterThanOrEqual(0)
      // 这是本文件的核心断言：`followup` 一执行模型就开跑、外部副作用已经发生，
      // 此时再 claim 只能丢结果。两者顺序反了，接线就是装饰。
      expect(claimAt).toBeLessThan(followAt)
    } finally { await h.dispose() }
  })

  it('C3 duplicate + finished（已交付过）⇒ 显式拒绝，且绝不注入消息', async () => {
    const h = host({ verdict: 'duplicate', status: 'finished' })
    try {
      await expect(h.participant.run(h.request())).rejects.toThrow(/已经结算过/)
      // 静默重跑会重复外部副作用；这里的判据是"一个字都没往里发"。
      expect(h.followups()).toHaveLength(0)
    } finally { await h.dispose() }
  })

  it('C4 duplicate + claimed（上一轮崩在半路）⇒ 视为中断，允许重跑并结算', async () => {
    const h = host({ verdict: 'duplicate', status: 'claimed' })
    try {
      const promise = h.participant.run(h.request())
      const id = await h.accept(promise)
      h.complete(id, '正文')
      const result = await promise
      expect(result.status).toBe('completed')
      // 重跑之后必须结算，否则下一轮又会把它当成"中断"，永远重跑下去。
      expect(h.calls.finished).toEqual([EXPECTED_KEY])
    } finally { await h.dispose() }
  })

  it('C5 finish 在 resolve 之前 —— 反过来会留下 claimed 行，下次被判可重跑', async () => {
    const h = host()
    try {
      await runOnce(h)
      expect(h.calls.finished).toEqual([EXPECTED_KEY])
      // 若把 `finish` 挪到 `resolve` 之后，调用方可能在两者之间退出进程：
      // 状态停在 `claimed`，下次重试被判"中断可重跑"，而它其实已经交付过 ⇒ 重复副作用。
      expect(h.calls.finishSawResolved).toBe(false)
    } finally { await h.dispose() }
  })

  it('C6 没有存储门面时整层跳过，不炸', async () => {
    const h = host({ withoutStorage: true })
    try {
      const result = await runOnce(h)
      expect(result.status).toBe('completed')
      // 一次都没碰存储层。
      expect(h.calls.claimed).toHaveLength(0)
      expect(h.calls.finished).toHaveLength(0)
    } finally { await h.dispose() }
  })
})
