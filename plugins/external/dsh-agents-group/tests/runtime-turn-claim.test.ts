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
 *   C9 受理一条用户消息**推进 `updated_at`**（侧栏排序键；`syncTitle` 不碰那一列）；
 *
 * C7（幂等缓存上界）与 C9 不是 `claim` 的判据，但它们的接线点同在这条路径上（`participant` →
 * `lifecycle`），另建文件会把同一套夹具抄第二遍 —— 夹具的用途是"让接线可见"，不是"一个文件
 * 只测一件事"。C8 号被本文件末尾那条"已知无覆盖"的说明占用了（当时尝试补的
 * `ledger.available` 告警），所以这里从 C9 续号，不重排既有编号。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it, vi } from 'vitest'
import type { ParticipantRequest, ParticipantResult } from '../packages/runtime/src/contract.ts'
import { ConversationLifecycle, type AgentRuntime, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import { createParticipant } from '../packages/runtime/src/participant.ts'
import type { AgentDefinition } from '../packages/runtime/src/definition.ts'
import type { AgentDatabasePort, AgentStoragePort, TurnRecord, TurnResultRecord, TurnStorePort } from '../packages/runtime/src/storage/ports.ts'
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
  /**
   * 结果层（`dsh_turn_results`）：`turnId` 被查了几次。
   *
   * **它是"惰性"与"记忆化"的判据**：业务不读结果 ⇒ 0 次；同一轮读两次 ⇒ 仍 1 次。
   */
  turnIdLookups: number
  /** 结果层：落过的行（按落库顺序）。 */
  readonly results: TurnResultRecord[]
}

interface HostOptions {
  /** 假 `claim` 的答案；缺省 `'claimed'`（首次受理）。 */
  readonly verdict?: 'claimed' | 'duplicate'
  /** 假 `turnStatus` 的答案；只在 `verdict === 'duplicate'` 时被问到。 */
  readonly status?: 'claimed' | 'finished' | undefined
  /** 不传存储门面，验 C6。 */
  readonly withoutStorage?: boolean
  /** 幂等缓存上界，供 C7 验"淘汰真的发生"。 */
  readonly settledCacheMax?: number
  /**
   * 结果层：`claim` 成功后**立刻**往这一轮落的结果。
   *
   * 这样最贴近生产——业务是在**这一轮进行中**写结果的（工具处理器里落库），而不是跑完之后。
   * 入参是这一轮的 `requestId`，所以可以按轮次区分（"这一轮写了、那一轮没写"）。
   */
  readonly seedResults?: (requestId: string) => readonly Record<string, unknown>[]
  /** 换一个定义（结果层的用例要自己的 `projectResult`）；缺省是那个什么都不做的定义。 */
  readonly definition?: AgentDefinition
}

function host(options: HostOptions = {}) {
  const byEvent = new Map<string, Set<(...args: unknown[]) => void>>()
  const sessions = new Map<string, FakeSession>()
  const followups: { readonly id: string; readonly text: string }[] = []
  const disposers: (() => Promise<void> | void)[] = []
  const openedIds: string[] = []
  const calls: Calls = { events: [], claimed: [], finished: [], finishSawResolved: false, turnIdLookups: 0, results: [] }
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

  /**
   * 结果层替身的状态。
   *
   * `turnIds` 与真实现同形：**turn 行 id 是在 `claim` 插入那一行时产生的**（不是幂等键本身）。
   * 这个区别是 DDL 第 150 行专门写下的"同名不同义"，替身也照它建模——否则"按行 id 筛结果"
   * 这类错误在测试里看不出来。
   */
  const turnIds = new Map<string, string>()
  /**
   * 轮次**行**（`dsh_turns`）的替身，按行 id 存。
   *
   * 与 `turnIds` 的关系就是真实现里"幂等键 → 行 id"那一步：`turnIds` 回答"这一轮的行 id 是哪个"，
   * 这张表回答"那个行 id 现在是什么样"。③-A 的 `turnById` / `turnsOf` 读它。
   */
  const turnRows = new Map<string, TurnRecord>()
  let resultSeq = 0
  /** 轮次**行**的插入序。真实现里是库生成的 `IDENTITY`（`dsh_turns.seq`），替身照样单调递增。 */
  let turnSeq = 0
  const appendRow = (turnId: string, payload: Record<string, unknown>): string => {
    resultSeq += 1
    const id = `res-${resultSeq}`
    calls.results.push({ id, turnId, operationId: `op-${resultSeq}`, seq: resultSeq, createdAt: 1000 + resultSeq, payload })
    return id
  }

  const turns: TurnStorePort = {
    claim: async (_owner, conversationId, requestId, inputHash) => {
      calls.events.push('claim')
      calls.claimed.push({ requestId, inputHash, conversationId })
      const verdict = options.verdict ?? 'claimed'
      if (verdict === 'claimed') {
        turnIds.set(requestId, `turn-${requestId}`)
        turnSeq += 1
        turnRows.set(`turn-${requestId}`, {
          id: `turn-${requestId}`,
          conversationId,
          requestId,
          inputHash,
          status: 'claimed',
          seq: turnSeq,
          createdAt: 1000 + turnRows.size,
          payload: {},
        })
        // 业务是在**这一轮进行中**写结果的（工具处理器里落库），所以种在 `claim` 这一刻。
        for (const payload of options.seedResults?.(requestId) ?? []) appendRow(`turn-${requestId}`, payload)
      }
      return verdict
    },
    finish: async (_owner, requestId) => {
      calls.finished.push(requestId)
      const row = turnRows.get(turnIds.get(requestId) ?? '')
      if (row !== undefined) turnRows.set(row.id, { ...row, status: 'finished' })
      // ⚠️ 必须先让出一个微任务再读。少了这一步，`finish` 与 `resolve` 在同一个同步块里，
      // 调用方的 `.then` 回调根本还没机会跑，读到的**永远是 `false`** —— 用例就成了假绿：
      // 把 `finish` 挪到 `resolve` 之后它照样通过。让出之后，顺序错了才会被观察到。
      await Promise.resolve()
      calls.finishSawResolved = settledFlag.value
    },
    turnStatus: async () => options.status,
    // 结果层（`dsh_turn_results`）：**真的**按轮次存取。这样"接线到底接没接"能被观测到，
    // 而不是靠一个恒空的替身把缺口藏住（本文件开头那段注释说的就是这个教训）。
    turnId: async (_owner, requestId) => {
      calls.turnIdLookups += 1
      return turnIds.get(requestId)
    },
    appendTurnResult: async (_owner, input) => appendRow(input.turnId, input.payload),
    turnResults: async (_owner, turnId) => calls.results.filter(row => row.turnId === turnId),
    // ③-A 的端口增量：本文件的用例不读整行，但替身**照样按行真存**（恒空替身会把缺口藏住）。
    turnById: async (_owner, turnId) => turnRows.get(turnId),
    turnsOf: async (_owner, conversationId) =>
      [...turnRows.values()].filter(row => row.conversationId === conversationId),
    // 按会话读结果：真实现靠 `dsh_turn_results.conversation_id` **一条查询**（不是先查轮次再逐轮查），
    // 替身按同一个语义从"轮次行 → 结果"拼——先按会话收轮次 id，再筛结果。
    turnResultsOf: async (_owner, conversationId) => {
      const ids = new Set([...turnRows.values()]
        .filter(row => row.conversationId === conversationId)
        .map(row => row.id))
      return calls.results.filter(row => ids.has(row.turnId))
    },
    // 按业务键（载荷里的 `operationId`）跨会话读轮次：替身按同一口径过滤并按插入序降序。
    turnsByOperationId: async (_owner, operationId) => {
      if (operationId === '') return []
      return [...turnRows.values()]
        .filter(row => row.payload.operationId === operationId)
        .sort((left, right) => right.seq - left.seq)
    },
    // 本文件的用例不写轮次载荷；真实现是"行不存在 ⇒ 404"，所以这里也**不静默成功**。
    patchTurnPayload: async (_owner, turnId) => {
      const row = turnRows.get(turnId)
      if (row === undefined) throw new AccessError(404, '轮次不存在或无权访问')
      return row.payload
    },
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
    /**
     * `section` 与 `context` **两个都要**：`setup()` 注册人设段用前者，而声明了
     * `definition.turnContext` 的 Agent 还会用后者注册"每轮求值"的动态上下文
     * （`conversation.ts` 的 `setup()`）。本文件的回合身份用例要用 `turnContext`，
     * 少了 `context` 就是在 `open()` 里以 `TypeError` 炸掉 —— 表现成 `accept` 一直等不到接单。
     */
    systemPrompt: { section: () => {}, context: () => {} },
    // `register` 是交活工具的接线口（`conversation.ts` 的 `registerScopedTools`）：
    // 宿主在 agent 作用域注册工具时走它。替身不持有工具，但接口必须在位——否则接线一发生
    // 就会在这里抛 `register is not a function`。
    tools: { restrict: () => {}, register: () => () => {} },
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
    ...(options.settledCacheMax === undefined ? {} : { settledCacheMax: options.settledCacheMax }),
  }
  const definition = options.definition ?? definitionOf()
  const lifecycle = new ConversationLifecycle({
    ctx, definition, access, store: port, config: runtimeConfig, allowedTools: () => [],
  })
  // 记录"占用回合"的时刻：这是 `claim` 真正要抢先的第一个副作用。
  //
  // ⚠️ 不能拿假 `followup` 的 push 顺序当顺序判据：`lifecycle.followup()` 是**异步启动**的，
  // 真正注入消息的 `agent.followup` 要到微任务里才被调到，而 `claim` 替身是同步 push。实测
  // 把 claim 块整体挪到 `followup` 之后，`events` 仍然是 `["claim","followup"]` —— 那样写出来
  // 的顺序断言**天然没有约束力**（变异不会让它变红）。
  const originalRetain = lifecycle.retainTurn.bind(lifecycle)
  lifecycle.retainTurn = ((...args: Parameters<typeof originalRetain>) => {
    calls.events.push('retainTurn')
    return originalRetain(...args)
  }) as typeof lifecycle.retainTurn
  const runtime: AgentRuntime = { ctx, definition, access, store: port, config: runtimeConfig, lifecycle, allowedTools: () => [] }
  // C6 靠"根本不传 storage"来验：少了这个守卫，接线处会以 TypeError 炸掉。
  const participant = options.withoutStorage === true
    ? createParticipant({ definition, runtime: { ...runtime, lifecycle: () => lifecycle }, access, config: runtimeConfig })
    : createParticipant({ definition, runtime: { ...runtime, lifecycle: () => lifecycle }, storage, access, config: runtimeConfig })

  return {
    participant, calls, settledFlag, lifecycle, port,
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
    /**
     * 等**第 `since + 1` 轮**接单并返回会话 id；先挂 `catch` 以免未处理拒绝污染别处。
     *
     * ⚠️ 多轮用例必须传 `since`：判据是 `followups.length > since`，缺省 0 时首轮就已满足，
     * 会**立刻返回首轮那个会话**。这个坑在 P3.5 的 A3-1 上耗过三次往返。
     */
    accept: async (promise: Promise<ParticipantResult>, since = 0): Promise<string> => {
      void promise.catch(() => {})
      await until(() => followups.length > since, '接单')
      return openedIds[openedIds.length - 1] ?? ''
    },
    dispose: async () => { await lifecycle.dispose(); await Promise.allSettled(disposers.map(fn => fn())) },
  }
}

/**
 * 默认定义：什么都不做。
 *
 * `hooks` 用于**按需**加钩子（回合身份的用例要 `onTurnStart` / `turnContext` / `onTurnFinish`
 * 三处都记一份）——这样不必为每个用例手写整份定义，也不会让默认定义悄悄变胖。
 */
const definitionOf = (hooks: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: AGENT_ID,
  displayName: '认领 Agent',
  description: '只跑一轮',
  persona: '你好',
  tools: () => [],
  config: {} as never,
  ...hooks,
})

/**
 * 跑完一轮并返回结果；同时登记"结果已 resolve"供 C5 使用。
 *
 * `lookupsAfterAccept`（可选）回填**接单之后、投影之前**的 `turnId` 查询次数。
 *
 * ⚠️ 结果层的三条判据（只给本轮 / 惰性 / 记忆化）要看的是"**投影这一步**查了几次库"，而自从回合
 * 身份上线之后，每一轮在 `claim` 之后**必然先查一次** `turnId`（把行 id 交给回合钩子）。所以那三条
 * 不能再用**绝对次数**：绝对次数会把"身份那一次"算进去，而它对结果层毫无意义 —— 于是断言会随着身份
 * 机制的增删而漂移（本批实测到 +1 的三条假红）。改成**相对量**才是它们本来想说的那句话。
 */
async function runOnce(h: ReturnType<typeof host>, lookupsAfterAccept?: { value: number }): Promise<ParticipantResult> {
  const promise = h.participant.run(h.request())
  // 登记"结果已 settle"，供 C5 判定 `finish` 是在它之前还是之后被调的。
  promise.then(() => { h.settledFlag.value = true })
  const id = await h.accept(promise)
  if (lookupsAfterAccept !== undefined) lookupsAfterAccept.value = h.calls.turnIdLookups
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

  it('C2 顺序：claim 发生在第一个副作用（retainTurn 占用回合）之前 —— 放晚就等于没接', async () => {
    const h = host()
    try {
      const promise = h.participant.run(h.request())
      const id = await h.accept(promise)
      h.complete(id, '正文')
      await promise
      const claimAt = h.calls.events.indexOf('claim')
      const retainAt = h.calls.events.indexOf('retainTurn')
      expect(claimAt).toBeGreaterThanOrEqual(0)
      expect(retainAt).toBeGreaterThanOrEqual(0)
      // 这是本文件的核心断言：`retainTurn` 一旦执行，这一轮就被算作"已接单"（`admitted`），
      // 之后再 claim 出 409 也收不回来。顺序反了，接线就只是装饰。
      expect(claimAt).toBeLessThan(retainAt)
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

  it('C7 幂等缓存有上界：超过上限后最旧的被淘汰（防长期运行单调增长）', async () => {
    const h = host({ settledCacheMax: 2 })
    try {
      for (const requestId of ['a', 'b', 'c']) {
        const promise = h.participant.run(h.request({ requestId }))
        const id = await h.accept(promise, h.followups().length)
        h.complete(id, `正文 ${requestId}`)
        await promise
      }
      // 跑了 3 个不同请求、上限 2 ⇒ 只该留 2 条。没有淘汰时这里会单调增长。
      expect(h.participant.settledRequests).toBe(2)
      // 淘汰的只是"进程内回放"：三轮都真的走了 `claim`，一次都没被缓存短路。
      expect(h.calls.claimed.map(entry => entry.requestId)).toEqual(['run:a', 'run:b', 'run:c'])
    } finally { await h.dispose() }
  })

  it('C9 受理一条用户消息必须推进 `updated_at`（`syncTitle` 不碰那一列）', async () => {
    /**
     * 判据：**侧栏排序键**。
     *
     * `lifecycle.followup` 里两次存储调用缺一不可，而它们管的事完全不同：
     * - `syncTitle` 把首条消息压成标题（官方标题随后覆盖它），**守卫只认 `title` / `title_source`，
     *   完全不碰 `updated_at`**；
     * - `touch` 才推进 `updated_at`，而列表排序是 `pinned DESC, updated_at DESC, id`、
     *   `from` / `to` 过滤也按这一列。
     *
     * 所以只留 `syncTitle` 的话，侧栏排序键退化成**创建时间**：刚续问过的会话沉在下面，
     * 时间范围过滤也算错——而且**静默**（没有任何报错）。删掉 `followup` 里那一次 `touch`，
     * 本条即红。真实 PG 侧的同一件事由 `tests/storage-contract.test.ts` 的 `touch` 用例覆盖
     * （那里是真 SQL）。
     *
     * ⚠️ 把 `Date.now` 钉成递增而不是"让替身自己取时钟"：`followup` 传给端口的是它开头记下的
     * `lastUsedAt`（**显式时刻**），端口根本不会去读时钟——第一版就是这么写的，于是断言读到
     * 两个相同的毫秒值而红（`Math.max(old, at)` 里 `at` 来自真实时钟，和 `publish` 撞在同一
     * 毫秒）。钉住真实的 `Date.now` 才能让"严格变大"成为确定的事实，而不是碰运气。
     */
    const h = host()
    const base = Date.now() + 1_000_000_000
    let ticks = 0
    // 钉住真实的 `Date.now`（递增，保证"严格变大"是确定的事实）。恢复放在 `dispose()` **之前**：
    // 时钟一旦泄漏到别的用例，那边所有依赖真实时间的断言都会变成另一个故事。
    vi.spyOn(Date, 'now').mockImplementation(() => base + (ticks += 1))
    try {
      const conversation = (await h.lifecycle.open(undefined, true, ACTOR))!
      const before = h.port.rawOf(conversation.id)!.updatedAt

      await h.lifecycle.followup(conversation, '第二问', ACTOR)

      const after = h.port.rawOf(conversation.id)!.updatedAt
      expect(after).toBeGreaterThan(before)
      // 再钉一次"是谁推进的"：只有 `touch` 往这条痕迹里写东西（`publish` / `create` 都不写）。
      expect(h.port.touched.map(entry => entry.id)).toEqual([conversation.id])
      // 调用方给的时刻必须**晚于**改动前的值（给一个陈旧时刻会被 `Math.max` 挡下 ⇒ 上面那条
      // `toBeGreaterThan` 也会红，但那是"没推进"，与"传错了时刻"是两件事）。
      expect(h.port.touched[0]!.at).toBeGreaterThan(before)
      expect(h.port.touched[0]!.updatedAt).toBe(after)
    } finally {
      vi.restoreAllMocks()
      await h.dispose()
    }
  })

  // ⚠️ **已知无覆盖（如实记录，不是遗漏）**：`participant.ts` 的 `ledger.available` 告警
  // （装配侧漏调 `install()` 时只警告一次）目前**没有断言**。尝试补 C8 时用例在夹具的
  // `accept`/`complete` 时序上挂住（表现为 vitest 的 testTimeout），排查成本超过这条观测的
  // 价值，故按本仓规矩"做不到就如实标注未验证"，不留半成品、也不写成已覆盖。
  // 判据：把 `participant.ts` 里那段 `console.warn` 删掉，**不会有任何用例变红**。
  // 要补的话，落点应在 `runtime-turn-claim.test.ts`，用 `vi.spyOn(console, 'warn')` +
  // 一个**不 install** 的 host 跑一轮。
})

// ---------------------------------------------------------------------------
// 回合的**身份**：`TurnHookContext.requestId` / `.turnId`
// ---------------------------------------------------------------------------
//
// 为什么单独一组：批次 C 要把 blog 的协作入口换成运行时的 participant，而 blog 的业务工具
// **按 agent 句柄索引**一份"这一轮是谁"的绑定（`jobs.bindings`，`authorize: agent => bound(agent)`）。
// 句柄由运行时的生命周期创建时，那份绑定建立不起来 ⇒ **模型手里的工具全部 403**；同理，
// 结构化产出要落 `dsh_turn_results` 也需要**这一轮的行 id**。两者都靠这两个字段。
//
// ⚠️ 判据刻意用**回查到的行 id**（替身把它铸成 `turn-<幂等键>`，见 `host` 里的 `claim` 替身），
// 而不是"非空字符串"——`turnId 直接给 requestId` 这种错法（变异 M1）只有前者能抓到。

describe('回合钩子拿到**这一轮的身份**', () => {
  /** 三个钩子按调用顺序把身份记下来。 */
  const recorder = (seen: { hook: string; requestId?: string; turnId?: string }[]) => ({
    onTurnStart: ({ requestId, turnId }: { requestId?: string; turnId?: string }) => {
      seen.push({ hook: 'onTurnStart', ...(requestId === undefined ? {} : { requestId }), ...(turnId === undefined ? {} : { turnId }) })
    },
    turnContext: ({ requestId, turnId }: { requestId?: string; turnId?: string }) => {
      seen.push({ hook: 'turnContext', ...(requestId === undefined ? {} : { requestId }), ...(turnId === undefined ? {} : { turnId }) })
      return '本轮资料'
    },
    onTurnFinish: ({ requestId, turnId }: { requestId?: string; turnId?: string }) => {
      seen.push({ hook: 'onTurnFinish', ...(requestId === undefined ? {} : { requestId }), ...(turnId === undefined ? {} : { turnId }) })
    },
  })

  it('C10 三个钩子拿到**同一份**身份：requestId 是幂等键、turnId 是 `dsh_turns` 的**行 id**', async () => {
    const seen: { hook: string; requestId?: string; turnId?: string }[] = []
    const h = host({ definition: definitionOf(recorder(seen) as Partial<AgentDefinition>) })
    try {
      const promise = h.participant.run(h.request())
      const conversationId = await h.accept(promise)
      h.complete(conversationId, '正文')
      await promise
      // `onTurnFinish` 是 fire-and-forget（`finish` 同步返回），所以要有界地等它跑完。
      await until(() => seen.length === 3, '三个钩子都跑过')

      expect(seen.map(item => item.hook)).toEqual(['onTurnStart', 'turnContext', 'onTurnFinish'])
      // 替身的 `claim` 把行 id 铸成 `turn-<幂等键>`（见 `host`）⇒ "回查到的行 id"是确定值。
      const expectedTurnId = `turn-${EXPECTED_KEY}`
      // ⚠️ 先钉住这两个值**本来就不一样**：相等的话下面那三条断言对"turnId 直接给 requestId"
      // 这种错法（M1）就没有分辨力了（会变成一条永远绿的断言）。
      expect(expectedTurnId).not.toBe(EXPECTED_KEY)
      for (const item of seen) {
        expect(item.requestId, item.hook).toBe(EXPECTED_KEY)
        expect(item.turnId, item.hook).toBe(expectedTurnId)
      }
      /**
       * ★ **只回查一次**（M1b 的判据）。
       *
       * `onTurnStart` 与 `turnContext` 在同一轮里都会问身份；"每个钩子各查一次库"是这件事最自然
       * 的错写法，而它在功能上**完全看不出来**（每处都拿得到值），只多烧两次 PG 往返。
       */
      expect(h.calls.turnIdLookups).toBe(1)
    } finally { await h.dispose() }
  })

  it('C11 续问（`reply`）的身份与首次派活**分开**，且 turnId 是**续问那一轮**的行 id', async () => {
    const seen: { hook: string; requestId?: string; turnId?: string }[] = []
    const h = host({ definition: definitionOf(recorder(seen) as Partial<AgentDefinition>) })
    try {
      const first = h.participant.run(h.request())
      const conversationId = await h.accept(first)
      h.complete(conversationId, '第一轮')
      await first
      await until(() => seen.length === 3, '首轮的三个钩子')

      seen.length = 0
      const since = h.followups().length
      const second = h.participant.reply!(h.request({ requestId: 'r2', conversationId }))
      await h.accept(second, since)
      h.complete(conversationId, '第二轮')
      await second
      await until(() => seen.length === 3, '续问的三个钩子')

      for (const item of seen) {
        expect(item.requestId, item.hook).toBe('reply:r2')
        expect(item.turnId, item.hook).toBe('turn-reply:r2')
      }
      // ⚠️ 这两条把"两个命名空间互不冒充"钉死：续问既不能复用首轮的幂等键，
      // 也不能把首轮的行 id 当成自己那一轮（M2 就是这两种错法）。
      expect(seen[0]!.requestId).not.toBe(EXPECTED_KEY)
      expect(seen[0]!.turnId).not.toBe(`turn-${EXPECTED_KEY}`)
    } finally { await h.dispose() }
  })

  it('C12 没有存储门面 ⇒ 身份里**没有 turnId**（如实缺省、不编一个），requestId 照常有', async () => {
    const seen: { hook: string; requestId?: string; turnId?: string }[] = []
    const h = host({ withoutStorage: true, definition: definitionOf(recorder(seen) as Partial<AgentDefinition>) })
    try {
      const promise = h.participant.run(h.request())
      const conversationId = await h.accept(promise)
      h.complete(conversationId, '正文')
      await promise
      await until(() => seen.length === 3, '三个钩子都跑过')

      for (const item of seen) {
        // 幂等键不依赖存储：它由驱动方给。
        expect(item.requestId, item.hook).toBe(EXPECTED_KEY)
        // ★ 判据（M3 是"未注入存储就抛错"；这一条同时钉住"不许编一个 id"）：
        //   连 `claim` 都没发生过，所以既没有行 id、也不该去查。
        expect(item.turnId, item.hook).toBeUndefined()
      }
      expect(h.calls.claimed).toHaveLength(0)
      expect(h.calls.turnIdLookups).toBe(0)
    } finally { await h.dispose() }
  })
})

// ---------------------------------------------------------------------------
// 结果层（`dsh_turn_results`）：业务在 `projectResult` 里读本轮的结构化产出
// ---------------------------------------------------------------------------
//
// 为什么值得单独一组：结果记录是"这一轮交回了什么结构化产出"的唯一载体（候选稿引用、
// 待确认的操作……），而它此前在运行时里**只出现在建表核验清单里、零读写方法**。这一组钉住
// 四件事：**接线真的在**、**只给本轮**、**惰性**（不读就不查库）、**记忆化**（读两次只查一次）。

describe('结果层：projectResult 读本轮结果', () => {
  /** 记录投影里读到的结果，供断言。 */
  function resultReadingDefinition(seen: { count: number; rows: readonly TurnResultRecord[] }): AgentDefinition {
    return {
      ...definitionOf(),
      projectResult: async (ctx) => {
        seen.count += 1
        seen.rows = await ctx.loadResults()
        return { status: 'completed', text: '读完了' }
      },
    }
  }

  it('读得到**本轮**的结果，按插入序返回', async () => {
    const seen = { count: 0, rows: [] as readonly TurnResultRecord[] }
    const h = host({
      definition: resultReadingDefinition(seen),
      seedResults: () => [{ kind: 'candidate', draftId: 'd1' }, { kind: 'operation', status: 'prepared' }],
    })
    try {
      await runOnce(h)
      expect(seen.rows).toHaveLength(2)
      expect(seen.rows.map(row => row.payload.kind)).toEqual(['candidate', 'operation'])
      // 按 `seq` 升序（插入序），不是按 id 或时间戳的字典序。
      expect(seen.rows.map(row => row.seq)).toEqual([...seen.rows.map(row => row.seq)].sort((a, b) => a - b))
      // 行 id 与幂等键**不同**：`turnId` 是 `claim` 那一行的 id（DDL 第 150 行专门写的同名不同义）。
      expect(seen.rows[0]!.turnId).toBe(`turn-${EXPECTED_KEY}`)
      expect(seen.rows[0]!.turnId).not.toBe(EXPECTED_KEY)
    } finally { await h.dispose() }
  })

  it('**只给本轮**：别的轮次落的结果读不出来', async () => {
    const seen = { count: 0, rows: [] as readonly TurnResultRecord[] }
    const h = host({ definition: resultReadingDefinition(seen), seedResults: requestId => requestId === EXPECTED_KEY ? [{ kind: 'candidate' }] : [] })
    try {
      // 第一轮：种了结果 ⇒ 读得到。
      const first = { value: 0 }
      await runOnce(h, first)
      const afterFirst = h.calls.turnIdLookups
      expect(seen.rows).toHaveLength(1)
      // 第二轮：**换一个 requestId**（`claim` 不种结果）⇒ 必须读不到上一轮那条。
      //
      // ⚠️ `since` 必须在 `run` **之前**取：`accept` 的判据是 `followups.length > since`，
      // 而第一轮已经留下一条记录 ⇒ 传当前长度会让它立刻返回**上一轮**的会话。
      const before = h.followups().length
      const promise = h.participant.run(h.request({ requestId: 'r2' }))
      const id = await h.accept(promise, before)
      const second = h.calls.turnIdLookups
      h.complete(id, '第二轮正文')
      await promise
      expect(seen.count).toBe(2)
      expect(seen.rows).toEqual([])
      // 两轮都真的**为结果层**查了一次（各自一轮一次），不是"第二轮没查所以为空"。
      // 判据是**相对量**：身份那一次已经被各自的基线排除（见 `runOnce` 的注释）。
      expect(afterFirst - first.value).toBe(1)
      expect(h.calls.turnIdLookups - second).toBe(1)
    } finally { await h.dispose() }
  })

  it('**惰性**：投影不读结果时，一次都不查（不替所有 Agent 付这次查询）', async () => {
    // 缺省定义没有 `projectResult` ⇒ 走兜底投影 ⇒ 不该碰结果层。
    const h = host({ seedResults: () => [{ kind: 'candidate' }] })
    try {
      const baseline = { value: 0 }
      await runOnce(h, baseline)
      // 接单之后是 1（身份那一次），投影走完仍是 1 ⇒ 结果层一次都没查。
      expect(h.calls.turnIdLookups - baseline.value).toBe(0)
    } finally { await h.dispose() }
  })

  it('**记忆化**：同一轮里读两次只查一次库', async () => {
    const seen = { count: 0, rows: [] as readonly TurnResultRecord[] }
    const h = host({
      definition: {
        ...definitionOf(),
        projectResult: async (ctx) => {
          seen.rows = await ctx.loadResults()
          seen.rows = await ctx.loadResults()
          return { status: 'completed', text: '读了两遍' }
        },
      },
      seedResults: () => [{ kind: 'candidate' }],
    })
    try {
      const baseline = { value: 0 }
      await runOnce(h, baseline)
      expect(seen.rows).toHaveLength(1)
      // 读两遍只查一次（+1 是那次唯一的**结果层**查询；身份那一次在基线里）。
      expect(h.calls.turnIdLookups - baseline.value).toBe(1)
    } finally { await h.dispose() }
  })

  it('没有存储门面 ⇒ 空数组，不抛错（"没有结果"是常态，不是异常）', async () => {
    const seen = { count: 0, rows: [] as readonly TurnResultRecord[] }
    const h = host({ withoutStorage: true, definition: resultReadingDefinition(seen) })
    try {
      await runOnce(h)
      expect(seen.rows).toEqual([])
    } finally { await h.dispose() }
  })
})
