/**
 * P3 的端到端验收：补交轮 · 超时预算 · 幂等 · 待答问题的持久化 · ⑧ 有界自修正。
 *
 * 这里用的是**精简假宿主**（只造这条路径需要的那几个面），与 `runtime-minimal-agent.test.ts`
 * 的内联 fixture 是**有意的重复**：那是 P1 的验收文件，动它会把两期的改动搅在一起。
 *
 * ## 驱动的两条纪律（不遵守就会得到"测试超时"这种没信息量的失败）
 *
 * 1. **想跑"干净的一轮"就必须先交活**：一轮正常跑完却没调交活工具时，运行时会**注入一条
 *    补交提示再跑一轮**——那是 §4.3 要求的行为。所以除了专门测补交轮的用例，其余用例都在
 *    `complete(...)` 之前调 {@link report}（模拟"模型调了交活工具"）。
 * 2. **每一轮都要自己发事件**：`complete(...)` 只发一轮（`turn/start` → `assistant/message`
 *    → `turn/end`）。补交轮与自修正轮都需要再发一次。
 *
 * 断言全部落在**对外可见的行为**上：注入了几条 user message、交付了什么、载体里留下了什么。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it, vi } from 'vitest'
import type { ParticipantRequest, ParticipantResult } from '../packages/runtime/src/contract.ts'
import { ConversationLifecycle, type AgentRuntime, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import { createParticipant, type RuntimeParticipant } from '../packages/runtime/src/participant.ts'
import type { AgentDefinition, ProjectedResult } from '../packages/runtime/src/definition.ts'
import type { HandoffLedger } from '../packages/runtime/src/handoff.ts'
import type { AgentDatabasePort, AgentStoragePort, ConversationPort, OwnerKey, TurnStorePort } from '../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'

const AGENT_ID = 'closure-agent'
const ACTOR: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-chat' }
const OWNER: OwnerKey = { namespace: 'user', userId: 'alice' }
/** 待答问题的键：与运行时用的 `OwnerKey` 同形。 */
const ownerKey = (owner: OwnerKey, conversationId: string): string => `${owner.namespace}:${owner.userId}:${conversationId}`

// ---------------------------------------------------------------------------
// 待答问题的载体（内存版 `TurnStorePort`）
// ---------------------------------------------------------------------------

/**
 * 只实现 P3 需要的那几个面。
 *
 * `questions` 由调用方**传进来**：这样"关掉一个实例、开一个新实例"只要共用同一个 Map，
 * 就等价于"数据落进了持久存储"——而那正是接线要保证的事。
 */
function memoryStorage(port: ConversationPort, questions: Map<string, string>) {
  const turns: TurnStorePort = {
    claim: async () => 'claimed',
    finish: async () => {},
    // 永远"没有这一轮的记录"，与上面的恒 `'claimed'` 自洽。
    //
    // ⚠️ 注意替身这么宽松的代价：**既有运行时用例全都碰不到 `claim` 接线**，一处都测不到
    // （接线后它们仍全绿）。`runtime-turn-claim.test.ts` 里那个可编程替身是唯一覆盖 ——
    // 这正是"实现与测试各自都在、中间的线没接"能连续发生三次的结构性原因。
    turnStatus: async () => undefined,
    // 结果层（`dsh_turn_results`）：这个替身不实现它——本文件的用例都不投影结果，
    // 如实返回"没有这一轮 / 没有结果"。**结果层的真实覆盖在 `runtime-turn-results.test.ts`**
    // （那里有一个按轮次真存取的替身），不要拿这里的空实现当成"结果层被测过了"。
    turnId: async () => undefined,
    appendTurnResult: async () => '',
    turnResults: async () => [],
    pendingQuestion: async (owner, conversationId) => questions.get(ownerKey(owner, conversationId)),
    setPendingQuestion: async (owner, conversationId, question) => {
      const key = ownerKey(owner, conversationId)
      if (question === undefined) questions.delete(key)
      else questions.set(key, question)
    },
  }
  const db = {
    assertSchema: async () => {},
    conversations: port,
    turns,
    query: async () => [],
    transaction: async (fn: (tx: AgentDatabasePort) => Promise<unknown>) => fn(db as unknown as AgentDatabasePort),
    close: async () => {},
  } as unknown as AgentDatabasePort
  const storage: AgentStoragePort = { db, access: { mode: 'authenticated' } as unknown as Access }
  return { storage, turns }
}

// ---------------------------------------------------------------------------
// 精简假宿主
// ---------------------------------------------------------------------------

interface FakeSession {
  readonly id: string
  readonly events: SessionEvent[]
  agent: Agent
  disposed: boolean
}

const sleep = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** 有界等待；次数刻意压到 200（Windows 上每次 tick 可能十几毫秒），失败时给**有信息量**的错。 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await sleep()
  }
  throw new Error(`等待超时：${label}`)
}

function host(definition: AgentDefinition, config: Partial<RuntimeConfig> = {}, questions = new Map<string, string>()) {
  const byEvent = new Map<string, Set<(...args: unknown[]) => void>>()
  const sessions = new Map<string, FakeSession>()
  const followups: { readonly id: string; readonly text: string }[] = []
  const disposers: (() => Promise<void> | void)[] = []
  const openedIds: string[] = []
  /** 每个句柄被 `dispose` 的次数（"泄漏 / 恰好一次"这类判据要看它）。 */
  const disposals = new Map<string, number>()
  /** 投给 driver 的取消（`agent.cancel`），按会话记。 */
  const cancels: { readonly id: string; readonly cause: unknown }[] = []
  let seq = 0

  const sessionOf = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [], disposed: false } as unknown as FakeSession
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: (message: unknown) => {
        const text = (message as { content?: readonly { text?: string }[] }).content?.[0]?.text ?? ''
        followups.push({ id, text })
        seq += 1
        session.events.push({ type: 'user/message', data: message, time: Date.now(), seq } as unknown as SessionEvent)
      },
      whenIdle: async () => {},
      cancel: (cause: unknown) => { cancels.push({ id, cause }) },
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

  const scopeOf = (): Context => ({
    systemPrompt: { section: () => {} },
    tools: { restrict: () => {} },
  }) as unknown as Context
  const agents = {
    create: async (input: { readonly sessionId: unknown; readonly setup?: (ctx: Context, agent: Agent) => unknown }) => {
      const session = sessionOf(String(input.sessionId))
      openedIds.push(session.id)
      await input.setup?.(scopeOf(), session.agent)
      return { agent: session.agent, dispose: async () => { session.disposed = true; disposals.set(session.id, (disposals.get(session.id) ?? 0) + 1) } }
    },
    resume: async (input: { readonly resumeSessionId: unknown; readonly setup?: (ctx: Context, agent: Agent) => unknown }) => {
      const session = sessionOf(String(input.resumeSessionId))
      await input.setup?.(scopeOf(), session.agent)
      return { agent: session.agent, dispose: async () => { session.disposed = true; disposals.set(session.id, (disposals.get(session.id) ?? 0) + 1) } }
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
  const port = new MemoryConversationPort(AGENT_ID)
  const { storage } = memoryStorage(port, questions)
  const runtimeConfig: RuntimeConfig = {
    routePrefix: '/closure',
    turnTimeoutMs: 30_000,
    authRecheckMs: 10_000,
    maxActiveConversations: 8,
    reasoningEffort: 'medium',
    ...config,
  }
  const lifecycle = new ConversationLifecycle({
    ctx, definition, access, store: port, config: runtimeConfig, allowedTools: () => [],
  })
  const runtime: AgentRuntime = { ctx, definition, access, store: port, config: runtimeConfig, lifecycle, allowedTools: () => [] }
  const participant: RuntimeParticipant = createParticipant({ definition, runtime, storage, access, config: runtimeConfig })

  return {
    participant, lifecycle, port, storage, questions, ctx,
    followups: () => followups,
    cancels: () => cancels,
    disposals: () => disposals,
    opened: () => openedIds,
    /** 最近一次建立句柄的会话 id。 */
    lastConversation: () => openedIds[openedIds.length - 1] ?? '',
    /** 发一轮完整回合：`turn/start` → `assistant/message` → `turn/end`。 */
    complete: (conversationId: string, text: string, reason = 'completed') => {
      emit('turn/start', { turn: 1 }, conversationId)
      emit('assistant/message', { message: { content: [{ type: 'text', text }] }, step: 0 }, conversationId)
      emit('turn/end', { reason: { kind: reason } }, conversationId)
    },
    request: (overrides: Partial<ParticipantRequest> = {}): ParticipantRequest => ({
      actor: ACTOR, missionId: 'm1', requestId: 'r1', message: '干活',
      signal: new AbortController().signal, onProgress: () => {},
      ...overrides,
    }),
    dispose: async () => { await lifecycle.dispose(); await Promise.allSettled(disposers.map(fn => fn())) },
  }
}

const definitionOf = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: AGENT_ID,
  displayName: '闭环 Agent',
  description: '只跑一轮',
  persona: '你好',
  tools: () => [],
  config: {} as never,
  ...overrides,
})

type Hosted = ReturnType<typeof host>

/**
 * 模拟**装配侧接线**：注册交活工具。
 *
 * 补交轮只在 `ledger.available` 为真时跑（没注册工具时补交只会让模型把同一件事再答一遍）。
 * 真实装配里这一步发生在把 `reportResultTool(...)` 注册进 agent 作用域的时候。
 */
function install(hosted: Hosted, conversationId: string): HandoffLedger {
  const ledger = hosted.participant.handoffFor(conversationId)
  ledger.install()
  return ledger
}

/** 模拟"模型调了交活工具"：接线 + 把结论写进这个会话的账本，收尾时就会被采用。 */
function report(hosted: Hosted, conversationId: string, result: ProjectedResult): void {
  install(hosted, conversationId).submit(result)
}

/** 起一轮并等它接单（`followup` 投出去的那一刻），返回会话 id。 */
async function accept(hosted: Hosted, promise: Promise<ParticipantResult>, since = 0): Promise<string> {
  await until(() => hosted.followups().length > since, '这一轮接单')
  void promise.catch(() => {})
  return hosted.followups()[hosted.followups().length - 1]!.id
}

/** 跑一轮"干净"的回合：交活 → 发事件 → 拿到结论。 */
async function runOnce(hosted: Hosted, request: ParticipantRequest, text: string, result: ProjectedResult, since = 0): Promise<ParticipantResult> {
  const promise = hosted.participant.run(request)
  const id = await accept(hosted, promise, since)
  report(hosted, id, result)
  hosted.complete(id, text)
  return promise
}

// ---------------------------------------------------------------------------

describe('补交轮：没调交活工具时补一次，补不上就按投影兜底（不判失败）', () => {
  it('第一轮没交活 → 注入补交提示；第二轮交活 → 用**工具的结果**交付', async () => {
    const hosted = host(definitionOf())
    try {
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      install(hosted, id)
      hosted.complete(id, '第一轮自己写的正文')
      await until(() => hosted.followups().length >= 2, '补交提示已注入')
      expect(hosted.followups()[1]!.text).toContain('report_result')
      expect(hosted.followups()[1]!.text).toContain('实际')
      // 第二轮：模型显式交活。
      report(hosted, id, { status: 'completed', text: '工具交回的正文' })
      hosted.complete(id, '第二轮自己写的正文')
      const result = await promise
      expect(result.text).toBe('工具交回的正文')
      expect(result.status).toBe('completed')
      // 交活过 ⇒ 第 4 条通过；没有口径 ⇒ 第 3 条未核验；业务侧没有自检 ⇒ 第 2 条 **absent**。
      // 汇总如实报 `absent`（"这个执行方没有自检能力"），不折成 `unverifiable`。
      expect(result.selfCheck?.status).toBe('absent')
    } finally { await hosted.dispose() }
  })

  it('两轮都没交活 → **只补一次**，最后按会话投影兜底交付且不判失败', async () => {
    const hosted = host(definitionOf())
    try {
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      install(hosted, id)
      hosted.complete(id, '第一轮正文')
      await until(() => hosted.followups().length >= 2, '补交提示已注入')
      hosted.complete(id, '第二轮正文')
      const result = await promise
      // 补交只补一次：注入计数停在 2（一条原始 + 一条补交）。
      expect(hosted.followups().length).toBe(2)
      expect(result.status).toBe('completed')
      expect(result.text).toBe('第二轮正文')
      // 两轮都没自检能力 ⇒ 汇总报 `absent`（同样是"未核验、不计入不达标"的那一档）。
      expect(result.selfCheck?.status).toBe('absent')
    } finally { await hosted.dispose() }
  })

  it('取消的回合不触发补交（没有可补的结论）', async () => {
    const hosted = host(definitionOf())
    try {
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      hosted.complete(id, '', 'aborted')
      const result = await promise
      expect(result.status).toBe('cancelled')
      expect(hosted.followups().length).toBe(1)
    } finally { await hosted.dispose() }
  })

  it('**没接线（交活工具没注册）也不补交** —— 补交只会让模型把同一件事再答一遍', async () => {
    // `ledger.available` 是装配侧 `install()` 的结果。没注册工具时模型手里根本没有
    // `report_result`，补一次只会白花一轮（而那一轮吃的是同一个超时预算）。
    // 这条用例锁定那个门槛：有人把它改成"无条件补交"时，这里必须红。
    const hosted = host(definitionOf())
    try {
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      // 刻意**不** install。
      hosted.complete(id, '只答了一句')
      const result = await promise
      expect(hosted.followups().length).toBe(1)
      expect(result.status).toBe('completed')
      expect(result.text).toBe('只答了一句')
      // 没调工具 ⇒ 第 4 条如实标"未核验"，不冒充通过；业务侧也没有自检 ⇒ 汇总报 `absent`。
      expect(result.selfCheck?.status).toBe('absent')
    } finally { await hosted.dispose() }
  })
})

describe('判据②：补交轮不撑破 turnTimeoutMs', () => {
  it('补交轮迟迟不结束 → 总时长仍受 turnTimeoutMs 约束，且用首轮结论兜底交付', async () => {
    // 预算 120ms，且**先把首轮拖到 ~90ms 才结束** —— 这样共用预算只剩 ~30ms，而"每轮重设
    // 预算"会拿到完整 120ms，两者差一个数量级。只测总时长是区分不开的：两种行为的总时长都
    // 远小于任何宽松上界（这正是变异验证发现的假绿 —— 一个不会因实现被改坏而变红的用例，
    // 等于这条判据形同虚设）。
    const hosted = host(definitionOf(), { turnTimeoutMs: 120 })
    try {
      const started = Date.now()
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      install(hosted, id)
      await new Promise<void>(resolve => { setTimeout(resolve, 90) })
      hosted.complete(id, '第一轮正文')
      await until(() => hosted.followups().length >= 2, '补交提示已注入')
      const injectedAt = Date.now()
      // 补交轮不结束：不发第二轮的任何事件。
      //
      // ⚠️ 这里**不再是整条 reject**：首轮已经产出可用结论，而补交是运行时自己的补救动作，
      // 它没跑完不该毁掉那一份交付（P3 红队攻击 3）。超时改成用首轮投影兜底交付，并把 ⑦ 的
      // `report-called` 如实标成未核验——所以旧断言 `rejects.toThrow(/超时/)` 与新语义相反，
      // 必须随之改写；不改就是拿旧语义的绿灯冒充新语义的覆盖。
      const result = await promise
      // 判据一：补交轮**没有拿到一份新预算**。共用 ⇒ 距注入约 30ms；每轮重设 ⇒ 约 120ms。
      expect(Date.now() - injectedAt).toBeLessThan(80)
      // 判据二：整体仍然有界，防止"其实一直在等"被上面那条掩盖。
      expect(Date.now() - started).toBeLessThan(1_000)
      // 判据三：交付的是**首轮**的结论（补交轮的正文一个字都没进来），不是"这一轮失败"。
      expect(result.status).toBe('completed')
      expect(result.text).toBe('第一轮正文')
      expect(result.conversationId).toBe(id)
      // 判据四：没调交活工具这件事如实标注（⑦ 的 `report-called: unverified`），不冒充通过。
      // ⚠️ 断言必须**指名到 `absent`**：业务侧没有自检能力，`toSelfCheck` 只会报 `absent`。
      // 原先写的是 `not.toBe('passed')`，它被上一行的 detail 断言完全蕴含——`unverifiable`、
      // `failed` 甚至 `undefined` 都能过，等于这一条没有鉴别力（P3 收口评审 F2：把兜底那份
      // `selfCheck` 硬编码成 `unverifiable` 都照样绿）。
      expect(result.selfCheck?.detail ?? '').toContain('没有调用交活工具')
      expect(result.selfCheck?.status).toBe('absent')
      // 判据五：这一轮的占用**真的放掉了**。补交轮之后 `releaseTurn` 已经是空函数，只有
      // `lifecycle.finish()` 会清 `active`——少了它，同会话后续的 `run`/`reply` 一律 409
      // 「正在回答上一条问题」，而 LRU 也永远驱逐不掉它（`reserveSlot` 只挑 `!active` 的会话）。
      // 红队实测过这个静默后果：走两轮的交付 `isBusy=true`，单轮的 `false`。
      expect(hosted.lifecycle.isBusy(id)).toBe(false)
    } finally { await hosted.dispose() }
  })

  it('超时也发生在首轮（补交之前）——同一个预算覆盖整条循环', async () => {
    const hosted = host(definitionOf(), { turnTimeoutMs: 40 })
    try {
      const promise = hosted.participant.run(hosted.request())
      await accept(hosted, promise)
      await expect(promise).rejects.toThrow(/超时/)
      expect(hosted.followups().length).toBe(1)
    } finally { await hosted.dispose() }
  })

  it('自修正轮超时 → 整条失败，且不把首轮结论当成功交出去', async () => {
    // 规则：自修正轮开始前会清掉兜底（首轮结论**已被判定不达标**，不能再当"成功交付"）。
    // 这条规则此前**零覆盖**——红队变异 M3（把清空那一行改成空操作）预期 0 条变红，实测确认。
    //
    // 路径要避开补交轮：模型**调了交活工具**，第 1 轮直接进 ⑧ 的自修正判定。
    const hosted = host(definitionOf({
      judge: async () => ({ ok: false, reason: '缺少发布链接' }),
    }), { turnTimeoutMs: 200 })
    try {
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      install(hosted, id)
      report(hosted, id, { status: 'completed', text: '第一版' })
      hosted.complete(id, '第一轮正文')
      await until(() => hosted.followups().length >= 2, '重做提示已注入')
      // 自修正轮不给任何事件 ⇒ 超时。
      await expect(promise).rejects.toThrow(/超时/)
      // 整条失败，而不是把不达标的结论送出去，也不是无限重开自修正轮。
      expect(hosted.followups().length).toBe(2)
    } finally { await hosted.dispose() }
  })
})

describe('判据③：同 requestId 重试不产生第二轮副作用', () => {
  it('第二次调用直接回上一次的结论，**不再注入任何 user message**', async () => {
    const hosted = host(definitionOf())
    try {
      const result = await runOnce(hosted, hosted.request({ requestId: 'same-id' }), '正文', { status: 'completed', text: '交回的正文' })
      const injected = hosted.followups().length
      // 同 ID 同内容重试：必须回缓存，不能重跑（否则补交轮会再跑一遍 ⇒ 第二轮副作用）。
      const again = await hosted.participant.run(hosted.request({ requestId: 'same-id' }))
      expect(again).toEqual(result)
      expect(hosted.followups().length).toBe(injected)
    } finally { await hosted.dispose() }
  })

  it('同 requestId 换了内容 → 明确拒绝（不静默当同一次；且失败走 Promise 而非同步抛）', async () => {
    const hosted = host(definitionOf())
    try {
      await runOnce(hosted, hosted.request({ requestId: 'clash' }), '正文', { status: 'completed', text: '交回的正文' })
      let thrown: unknown
      let promise: Promise<ParticipantResult> | undefined
      try {
        promise = hosted.participant.run(hosted.request({ requestId: 'clash', message: '换了个问题' }))
      } catch (error) { thrown = error }
      // `run`/`reply` 对外是异步方法：校验失败也必须走 rejected Promise，调用方写 `.catch()`
      // 才接得住。以前这里是从 `new Promise` **之前**同步抛出的，同步断言能过、`.catch()` 接不住。
      expect(thrown).toBeUndefined()
      if (promise === undefined) throw new Error('未返回 Promise')
      await expect(promise).rejects.toThrow(/同一请求身份/u)
    } finally { await hosted.dispose() }
  })

  it('不同 requestId 各自跑一轮（缓存不串）', async () => {
    const hosted = host(definitionOf())
    try {
      await runOnce(hosted, hosted.request({ requestId: 'a' }), '正文 A', { status: 'completed', text: '交回 A' })
      const injected = hosted.followups().length
      const result = await runOnce(hosted, hosted.request({ requestId: 'b' }), '正文 B', { status: 'completed', text: '交回 B' }, injected)
      expect(result.text).toBe('交回 B')
      expect(hosted.followups().length).toBe(injected + 1)
    } finally { await hosted.dispose() }
  })
})

describe('待答问题的持久化（重启后仍能恢复"在等什么"）', () => {
  it('产出 waiting → 写入载体；**新实例**读回同一 question', async () => {
    const questions = new Map<string, string>()
    const definition = definitionOf()
    const first = host(definition, {}, questions)
    let conversationId = ''
    try {
      const result = await runOnce(
        first,
        first.request(),
        '阶段正文',
        // 模型通过交活工具交回"我在等用户回话"——`status: 'waiting'` 与 `question` 一起。
        { status: 'waiting', text: '阶段成果', question: '采用哪一版？' },
      )
      conversationId = first.lastConversation()
      expect(result.status).toBe('waiting')
      expect(result.question).toBe('采用哪一版？')
      // 载体里必须有它——**接线缺失时这条断言必然红**（Map 里根本没记录）。
      expect(questions.get(ownerKey(OWNER, conversationId))).toBe('采用哪一版？')
    } finally { await first.dispose() }

    // 等价重启：新宿主、新 participant、**同一个载体**。
    const second = host(definition, {}, questions)
    try {
      expect(await second.storage.db.turns.pendingQuestion(OWNER, conversationId)).toBe('采用哪一版？')
    } finally { await second.dispose() }
  })

  it('非 waiting 的一轮把待答问题**清空**（否则上一轮的问题会被下一轮读回来）', async () => {
    const questions = new Map<string, string>()
    const hosted = host(definitionOf(), {}, questions)
    try {
      const waiting = await runOnce(hosted, hosted.request({ requestId: 'q1' }), '阶段正文',
        { status: 'waiting', text: '阶段成果', question: '采用哪一版？' })
      const id = hosted.lastConversation()
      expect(waiting.status).toBe('waiting')
      expect(questions.has(ownerKey(OWNER, id))).toBe(true)

      // 第二轮：不再等待 ⇒ 必须清空。
      const done = await runOnce(hosted, hosted.request({ requestId: 'q2', conversationId: id }), '做完了',
        { status: 'completed', text: '做完了' }, 1)
      expect(done.status).toBe('completed')
      expect(questions.has(ownerKey(OWNER, id))).toBe(false)
    } finally { await hosted.dispose() }
  })

  it('⚠️ 补交轮超时走兜底交付时，待答问题**也必须落库**', async () => {
    // 兜底交付那条路径曾经整段跳过 `setPendingQuestion`：结果带着 `question` 交回，而载体里
    // 什么都没有 ⇒ 协调方进了 `waiting_user`、重启后读不到"在等什么"，只会报 `waiting_expired`
    // ——静默。两个独立评审都点到了这一条（红队 B2 / 收口评审 F3）。
    //
    // 走法：第 1 轮**不调交活工具**（于是进补交轮），业务投影显式产出 `waiting` + `question`；
    // 补交轮不给任何事件 ⇒ 超时 ⇒ 用第 1 轮那份结论兜底交付。
    const questions = new Map<string, string>()
    const hosted = host(
      definitionOf({ projectResult: async () => ({ status: 'waiting', text: '阶段成果', question: '采用哪一版？' }) }),
      { turnTimeoutMs: 150 },
      questions,
    )
    try {
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      install(hosted, id)
      hosted.complete(id, '第一轮正文')
      await until(() => hosted.followups().length >= 2, '补交提示已注入')
      const result = await promise
      expect(result.status).toBe('waiting')
      expect(result.question).toBeTruthy()
      // **这条就是缺口本身的判据**：接线缺失时载体里什么都没有。
      expect(questions.get(ownerKey(OWNER, id))).toBe(result.question)
    } finally { await hosted.dispose() }
  })
})

describe('⑧ 有界自修正', () => {
  it('judge 不达标 → 注入重做提示（带上原因）；第二轮达标 → 交付', async () => {
    let round = 0
    const hosted = host(definitionOf({
      judge: async () => { round += 1; return round === 1 ? { ok: false, reason: '缺少发布链接' } : { ok: true } },
    }))
    try {
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      report(hosted, id, { status: 'completed', text: '第一版' })
      hosted.complete(id, '第一版正文')
      await until(() => hosted.followups().length >= 2, '重做提示已注入')
      expect(hosted.followups()[1]!.text).toContain('缺少发布链接')
      report(hosted, id, { status: 'completed', text: '第二版（含链接）' })
      hosted.complete(id, '第二版正文')
      const result = await promise
      expect(result.text).toBe('第二版（含链接）')
      expect(round).toBe(2)
    } finally { await hosted.dispose() }
  })

  it('maxSelfRetries: 0 → 不重跑，直接交付（并如实回报）', async () => {
    const hosted = host(definitionOf({
      maxSelfRetries: 0,
      judge: async () => ({ ok: false, reason: '就是不达标' }),
    }))
    try {
      const result = await runOnce(hosted, hosted.request(), '正文', { status: 'completed', text: '唯一一版' })
      expect(result.text).toBe('唯一一版')
      expect(hosted.followups().length).toBe(1)
    } finally { await hosted.dispose() }
  })

  it('⑦ 的不达标（有口径却零材料）也触发自修正', async () => {
    const hosted = host(definitionOf())
    try {
      const promise = hosted.participant.run(hosted.request({ acceptance: '一份 800 字以上的候选稿' }))
      const id = await accept(hosted, promise)
      // 交了正文但**没有任何材料** ⇒ 第 3 条不达标 ⇒ 自修正。
      report(hosted, id, { status: 'completed', text: '只有正文' })
      hosted.complete(id, '正文')
      await until(() => hosted.followups().length >= 2, '自修正提示已注入')
      expect(hosted.followups()[1]!.text).toContain('没有达到验收要求')
      report(hosted, id, { status: 'completed', text: '带材料的版本', artifacts: [{ title: '候选稿', path: '/x', kind: 'draft' }] })
      hosted.complete(id, '正文')
      const result = await promise
      expect(result.selfCheck?.status).not.toBe('failed')
    } finally { await hosted.dispose() }
  })

  it('自修正次数硬上限是 3（声明 99 也不会无限重跑）', async () => {
    let judgeCalls = 0
    const hosted = host(definitionOf({
      maxSelfRetries: 99,
      judge: async () => { judgeCalls += 1; return { ok: false, reason: '永远不达标' } },
    }))
    try {
      const promise = hosted.participant.run(hosted.request())
      let finished = false
      void promise.then(() => { finished = true }, () => { finished = true })
      // 每一轮都交活、都宣告不达标：**驱动到它自己停下来为止**（同时盯着 promise 是否已交付，
      // 免得在"它已经交付、不再注入"之后还傻等）。
      for (let round = 0; round < 8 && !finished; round += 1) {
        const ready = await Promise.race([
          until(() => hosted.followups().length > round, `第 ${round + 1} 轮`)
            .then(() => true).catch(() => false),
          promise.then(() => false, () => false),
        ])
        if (!ready || finished) break
        const id = hosted.followups()[round]!.id
        report(hosted, id, { status: 'completed', text: `第 ${round + 1} 版` })
        hosted.complete(id, `第 ${round + 1} 轮`)
      }
      const result = await promise
      // 1 次原始 + 最多 3 次自修正：注入条数与 judge 调用次数都被硬上限夹住。
      expect(judgeCalls).toBeLessThanOrEqual(4)
      expect(hosted.followups().length).toBeLessThanOrEqual(4)
      expect(result.selfCheck?.status).toBe('failed')
    } finally { await hosted.dispose() }
  })
})

// ---------------------------------------------------------------------------
// 句柄回收：发布段失败时不能留下永不释放的 driver
// ---------------------------------------------------------------------------

/**
 * `openReserved`（新建路径）在 `store.publish` 失败时会 `await handle.dispose()`；`fork`（分支路径）
 * 曾经没有这一步。后果不是"多了一个对象"，而是**进程里留下一个永不释放的 driver**：那个 Agent
 * 既不进活跃表（`publish()` 没被调用，`publish(id, handle, options)` 走不到）、也不会被 LRU 回收
 * （`reserveSlot` 只在活跃表里挑），`finally` 只管 `pendingOpens` 与 `forks` 两个计数。
 */
describe('fork 的发布段失败', () => {
  it('发布失败时那个句柄必须被销毁（照 openReserved 的形状）', async () => {
    const hosted = host(definitionOf())
    try {
      const conversation = (await hosted.lifecycle.open(undefined, true, ACTOR))!
      hosted.complete(conversation.id, '第一轮完成')
      // 分支边界必须是**已完成回合**的 `turn/end`。
      const boundary = [...hosted.lifecycle.events(conversation)].reverse().find(event => event.type === 'turn/end')!.seq

      // 发布段失败（真实现是 PG 往返失败；本地围栏写不进去也一样）。
      vi.spyOn(hosted.port, 'publish').mockRejectedValueOnce(new Error('PG 不可用'))
      await expect(hosted.lifecycle.fork(conversation, boundary, ACTOR)).rejects.toThrow('PG 不可用')

      const childId = hosted.opened().at(-1)!
      expect(childId).not.toBe(conversation.id)
      // ★ 判据：删掉 `fork` 里发布段那次 `handle.dispose()`，这一条立刻变红（句柄泄漏）。
      expect(hosted.disposals().get(childId)).toBe(1)
      // 预留行还在、但没发布：与 `openReserved` 的失败路径同一形状（侧栏看不到这条会话）。
      expect(hosted.port.record(ACTOR, childId).ready).toBe(false)
    } finally { await hosted.dispose() }
  })
})

// ---------------------------------------------------------------------------
// 取消的作用范围：只取消这一轮自己的回合
// ---------------------------------------------------------------------------

/**
 * 协作入口的接续失败分支（`participant.ts` 的 IIFE catch）里那句 `lifecycle.abort(...)` 取消的是
 * **这个会话此刻的当前回合**，不是"这一轮的回合"。这里把守卫（`abortHeldTurn`：句柄仍是当前句柄
 * **且**当前回合就是这一轮 `retainTurn` 之后派发出去的那一个）钉在**可达**的那一半上：
 *
 * 这一轮的回合已经被别人（页面入口的 `cancel`）中止过 ⇒ `turns` 里已经没有它了 ⇒ 迟到的接续失败
 * 不能再对同一个 driver 补一次取消。少了守卫就会多出一次 `agent.cancel`，而"取消"是会被页面与
 * 宿主观察到的动作；在守卫的另一个条件上（句柄已被换掉 / 当前回合是别人的），补的那一次取消会
 * 直接打断**别人**的回合——那一条按下面的不变式不可达，所以这里不断言它，只保留守卫本身。
 *
 * 不可达的理由（写入本仓库的推理链，供以后改动核对）：① 从 `admitted = true` 到
 * `lifecycle.followup(...)` 之间**没有 await**，而 `followup` 在第一个 await 之前就
 * `turns.set(...)` 且 `active = true`，所以别人插不进来；② 一旦登记了回合，`active` 为真，
 * 页面的 `followup` 与 LRU 驱逐都被挡住；③ 这一轮释放凭据（`releaseTurn`）只发生在
 * `cleanup()` 里，而 `cleanup()` 首先把 `finished` 置真 —— catch 开头的 `if (finished) return`
 * 因此已经拦住了"收尾之后才到的失败"。
 */
describe('接续失败的取消只作用于这一轮自己的回合', () => {
  it('这一轮的回合已被页面取消时，迟到的失败不再补一次取消', async () => {
    const hosted = host(definitionOf())
    try {
      // 让**这一轮**的模型路由挂住（第一次调目录是打开会话用的，正常返回）：`followup` 在第一个
      // await 之前就登记了回合，所以挂在这里就能拿到"回合已登记、还没派发"那个窗口。
      const controller = hosted.ctx.get('sessionController') as { modelCatalog: () => Promise<unknown> }
      const real = controller.modelCatalog
      let calls = 0
      let rejectTurn!: (error: unknown) => void
      controller.modelCatalog = () => {
        calls += 1
        return calls === 1 ? real() : new Promise((_resolve, reject) => { rejectTurn = reject })
      }

      const promise = hosted.participant.run(hosted.request())
      void promise.catch(() => {})
      await until(() => rejectTurn !== undefined, '这一轮的模型路由已经开始等目录')
      const id = hosted.opened().at(-1)!
      // 回合已经登记（占用是真的）但还没派发给 driver。
      expect(hosted.followups()).toHaveLength(0)
      expect(hosted.lifecycle.isBusy(id)).toBe(true)

      // 页面入口在这个窗口里取消这一轮：pending 回合被摘掉，driver 收到**一次**取消。
      hosted.lifecycle.cancel(id, ACTOR)
      expect(hosted.cancels()).toEqual([{ id, cause: { kind: 'user' } }])

      // 迟到的目录失败：这一轮的接续失败分支执行 —— 它的回合已经不在 `turns` 里了。
      controller.modelCatalog = real
      rejectTurn(new Error('目录已下线'))
      await expect(promise).rejects.toThrow('目录已下线')

      // ★ 判据：把 `abortHeldTurn` 换回 `abort(id)`，这里会变成 2 次（对已经中止的回合补一次取消）。
      expect(hosted.cancels()).toHaveLength(1)
      // 这一轮自己的占用如实放掉，会话回到空闲。
      expect(hosted.lifecycle.isBusy(id)).toBe(false)
    } finally { await hosted.dispose() }
  })
})

describe('投影拿到的 actor 是**这一次派活**的那一个', () => {
  it('⚠️ 传进 `ResultContext` 的是请求的 actor（不是装配期的占位值）', async () => {
    // `definition` 是**每 Agent 一份**（装配期造一次），而 `actor` 是**每请求**的 ⇒ 业务不能靠闭包
    // 捕获它：闭包只能拿到装配期的值，拿它去查业务库会查到**别人的**数据（或者静默查不到、返回空）。
    //
    // ⚠️ **这条覆盖的边界（如实登记）**：它证明"传进去的是请求的 actor、不是占位值"（把
    // `context.actor` 换成固定值就会红）。它**证明不了**"同一实例里第二个请求拿到的是第二个
    // actor"——那需要"同一 participant、两个不同 actor"，而夹具的鉴权与登录身份绑定不支持
    // （实测挂 vitest 的 testTimeout）。要补那条，先得让夹具支持多 actor 的身份绑定。
    const seen: Actor[] = []
    const hosted = host(definitionOf({
      projectResult: async (context) => { seen.push(context.actor); return { status: 'completed', text: '答好了' } },
    }))
    try {
      // 刻意**不** install 交活账本 ⇒ 不触发补交轮，一轮结束就交付、投影只被调一次。
      const promise = hosted.participant.run(hosted.request())
      const id = await accept(hosted, promise)
      hosted.complete(id, '正文')
      await expect(promise).resolves.toMatchObject({ text: '答好了' })
      expect(seen).toEqual([ACTOR])
    } finally { await hosted.dispose() }
  })
})
