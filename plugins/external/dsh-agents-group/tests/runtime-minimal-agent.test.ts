/**
 * P1（运行时骨架）判据① 的验收：**最小 Agent 跑通一轮**。
 *
 * 这个文件用**假宿主**驱动真实的 `ConversationLifecycle` 与 `createParticipant`：宿主只提供
 * `ctx.agents.create` / `ctx.agents.resume` / `ctx.on` / `ctx.effect` / `ctx.get` / `ctx.llm`
 * 这几个面，事件（`turn/start` / `assistant/message` / `tool/result` / `turn/end`）由测试自己
 * 按需发出 —— 所以"一轮"是确定性的，不依赖真实模型、不依赖计时器、不依赖 PG 与网络。
 *
 * 这里的断言全部落在**对外可见的行为**上：
 *
 * 1. 一轮 `run`：预留 → 发布 → 装配（persona + 工具限制）→ 追加用户消息 → 投影 → 交回结果；
 * 2. `waiting` 的产生路径：`needsReply` 是它的**唯一来源**，且一定带 `question`
 *    （两个既有生产实现从未产生过等待，这是本期新增的能力）；
 * 3. `reply` 续问沿原会话；**缺 `conversationId` 时拒绝**，不新建会话；
 * 4. `acceptance` / `reworkOf` 原样到达参与者（P0 契约在运行时路径上的延续）；
 * 5. `opaqueFromToolResult` 是**安全钩子**：工具结果里的标识进 opaque 集合，
 *    之后发布的思考快照里它必须已被替换（钩子没被调就必然红）。
 *
 * 会话存储用 `./fixtures/memory-conversation-port.ts` 的**测试替身**（P2 的真实 PG 实现不在这里），
 * 替身与真身的语义差写在那个文件头上，别把替身当"存储已经实现"的证据。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ParticipantProgress, ParticipantRequest, ParticipantResult } from '../packages/runtime/src/contract.ts'
import { ConversationLifecycle, type AgentRuntime, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import type {
  AgentDefinition,
  AgentToolContext,
  ProjectedResult,
  ReasoningProjectionContext,
  ResultContext,
} from '../packages/runtime/src/definition.ts'
import { createParticipant, type RuntimeParticipant } from '../packages/runtime/src/participant.ts'
import type { ConversationQueryShape, OwnerKey } from '../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'

const AGENT_ID = 'minimal'
const PERSONA = '你是一个最小 Agent：只回答一轮，不调用任何业务工具。'
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-chat' }
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const otherActor: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }

/**
 * 单条用例的超时放到 30s。
 *
 * 这个文件里的每一轮都由测试自己驱动，逻辑上不吃墙钟时间；但 `pnpm test` 默认**并行**跑整套，
 * 机器可能被别的用例占满。留出宽裕的上界，是为了让"机器忙"表现为慢、而不是表现为红
 * （文件内自己的等待上限见 `until`，只有 10s，所以卡住时先报出来的是带名字的等待超时）。
 */
vi.setConfig({ testTimeout: 30_000 })

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

interface PromptSection {
  readonly name?: string
  readonly order?: number
  readonly text?: string
}

/** 一个业务会话在假宿主里的全部状态。 */
interface FakeSession {
  readonly id: string
  /** 持久事件日志（`agent.session.snapshotEvents()` 读它）。 */
  readonly events: SessionEvent[]
  /** agent 作用域里注册过的提示词段。 */
  readonly prompts: PromptSection[]
  /** agent 作用域里应用过的工具限制。 */
  readonly restrictions: (readonly string[])[]
  /** 每次 create / resume 收到的 `agentOptions`。 */
  readonly options: unknown[]
  disposed: boolean
  agent: FakeAgent
}

interface FakeAgent {
  readonly id: string
  readonly session: { readonly id: string; readonly snapshotEvents: () => readonly SessionEvent[] }
  readonly followup: (message: unknown) => void
  readonly whenIdle: () => Promise<void>
  readonly cancel: (cause: unknown) => void
}

/** 一次 `run` / `reply` 调用：请求本身 + 它自己的进度收集器。 */
interface PlannedCall {
  readonly request: ParticipantRequest
  readonly progress: ParticipantProgress[]
}

interface CallOverrides {
  readonly message?: string
  readonly requestId?: string
  readonly missionId?: string
  readonly conversationId?: string
  readonly acceptance?: string
  readonly reworkOf?: string
  readonly actor?: Actor
}

interface Harness {
  readonly definition: AgentDefinition
  readonly participant: RuntimeParticipant
  readonly lifecycle: ConversationLifecycle
  readonly port: MemoryConversationPort
  /** 假宿主 Context 与鉴权（装配 adapter 的侧栏入口要用）。 */
  readonly ctx: Context
  readonly access: Access
  /** 造一次 `run` / `reply` 的请求（每次调用自带一个进度收集器）。 */
  call(overrides?: CallOverrides): PlannedCall
  /** `participant.run`：外挂一个已消化的影子 promise，避免失败路径上出现"未处理拒绝"噪音。 */
  run(request: ParticipantRequest): Promise<ParticipantResult>
  /** `participant.reply`：没暴露续问能力时直接报错（契约要求"实现了才暴露"）。 */
  reply(request: ParticipantRequest): Promise<ParticipantResult>
  /** 等到第 `since + 1` 轮接单（用户消息已经投给 Agent），返回它的会话 id。 */
  accept(since?: number): Promise<string>
  /** 等到会话回到空闲（`turn/end` 之后 driver 退出的那一刻）。 */
  settle(conversationId: string): Promise<void>
  emit(type: string, data: unknown, conversationId: string): void
  /** 模型实时帧（`agent/assistant-stream` 通道）。 */
  stream(frame: unknown, conversationId: string): void
  toolResult(resultText: string, meta: unknown, conversationId: string): void
  /** 发一轮完整回合：`turn/start` → `assistant/message` → `turn/end`。 */
  complete(conversationId: string, text: string, input?: { readonly turn?: number; readonly reason?: string }): void
  /**
   * 驱动一轮到交付：发一个完整回合。
   *
   * 这个最小 Agent 的工具集是**空的**、也没有交活工具，所以运行时按 §4.3 的兜底路径直接交付
   * （P3 的补交轮只在"交活工具确实装配过却没被调用"时才发生——账本的 `available` 为真，
   * 见 `handoff.ts` 的 `install()`）。
   */
  answer(conversationId: string, text: string, input?: { readonly turn?: number; readonly reason?: string }): Promise<void>
  promptsOf(conversationId: string): readonly PromptSection[]
  restrictionsOf(conversationId: string): readonly (readonly string[])[]
  agentOptionsOf(conversationId: string): unknown
  /** 建立过句柄的会话 id（`create` / `resume` 各算一次）。 */
  opened(): readonly string[]
  resumed(): readonly string[]
  /** 投给 Agent 的用户消息。 */
  followups(): readonly { readonly id: string; readonly message: unknown }[]
  cancels(): readonly { readonly id: string; readonly cause: unknown }[]
  revoke(): void
}

/**
 * 假宿主 + 真实运行时。
 *
 * 只造这条最小路径需要的那几个面：**没有**宿主会话存储、**没有** schedule 投影、**没有**真实模型。
 */
function fixture(definition: AgentDefinition): Harness {
  const byEvent = new Map<string, Set<Listener>>()
  const disposers: (() => Promise<void> | void)[] = []
  const sessions = new Map<string, FakeSession>()
  const openedIds: string[] = []
  const resumedIds: string[] = []
  const disposedIds: string[] = []
  const cancels: { readonly id: string; readonly cause: unknown }[] = []
  const followups: { readonly id: string; readonly message: unknown }[] = []
  const archivedSessionIds: string[] = []
  let seq = 0
  let revoked = false

  /** 每个会话一个**稳定**的 Agent 对象：`onAssistantDelta` 拿它当 WeakMap 键认同一轮尝试。 */
  const sessionOf = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = {
      id, events: [], prompts: [], restrictions: [], options: [], disposed: false,
    } as unknown as FakeSession
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: message => {
        followups.push({ id, message })
        // 真实宿主会把这条用户消息写进日志；`historyOf` / `previewMessages` 读的就是它。
        session.events.push(event('user/message', message, id))
      },
      whenIdle: async () => { /* 假宿主同步空闲：`whenIdle` 的 then 在下一个微任务里跑完。 */ },
      cancel: cause => { cancels.push({ id, cause }) },
    }
    sessions.set(id, session)
    return session
  }

  const event = (type: string, data: unknown, id: string): SessionEvent => {
    seq += 1
    return { type, data, time: Date.now(), seq } as unknown as SessionEvent
  }

  const on = (name: string, listener: Listener): (() => void) => {
    const group = byEvent.get(name) ?? new Set<Listener>()
    group.add(listener)
    byEvent.set(name, group)
    return () => { group.delete(listener) }
  }
  const dispatch = (name: string, ...args: unknown[]): void => {
    for (const listener of [...(byEvent.get(name) ?? [])]) listener(...args)
  }
  const emit = (type: string, data: unknown, conversationId: string): void => {
    const session = sessionOf(conversationId)
    const value = event(type, data, conversationId)
    session.events.push(value)
    dispatch('session/event', { id: conversationId }, value)
  }

  /** agent 作用域：`ConversationLifecycle.setup` 只碰这两个面。 */
  const scopeOf = (session: FakeSession): Context => ({
    systemPrompt: { section: (section: PromptSection) => { session.prompts.push(section) } },
    tools: { restrict: (input: { readonly allow: readonly string[] }) => { session.restrictions.push([...input.allow]) } },
  }) as unknown as Context

  const handleOf = (session: FakeSession) => ({
    agent: session.agent as unknown as Agent,
    dispose: async () => { session.disposed = true; disposedIds.push(session.id) },
  })

  interface AgentScopeInput {
    readonly agentOptions?: unknown
    readonly setup?: (agentCtx: Context, agent: Agent) => unknown
  }
  const agents = {
    create: async (input: AgentScopeInput & { readonly sessionId: unknown }) => {
      const session = sessionOf(String(input.sessionId))
      openedIds.push(session.id)
      session.options.push(input.agentOptions)
      // 真实宿主在公布之前调用 setup 组装 agent 作用域（persona 段 + 工具限制）。
      await input.setup?.(scopeOf(session), session.agent as unknown as Agent)
      return handleOf(session)
    },
    resume: async (input: AgentScopeInput & { readonly resumeSessionId: unknown }) => {
      const session = sessionOf(String(input.resumeSessionId))
      resumedIds.push(session.id)
      session.options.push(input.agentOptions)
      await input.setup?.(scopeOf(session), session.agent as unknown as Agent)
      return handleOf(session)
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
    // `requestedConversationModel` 会先查目录再看路由是否可用：两样都得给。
    sessionController: {
      modelCatalog: async () => ({
        groups: [{ id: DEFAULT_MODEL.provider, name: 'DeepSeek', models: [{ id: DEFAULT_MODEL.model, name: 'DeepSeek Chat' }] }],
        failures: [],
        selected: { ...DEFAULT_MODEL },
      }),
      selectModel: async (input: { readonly provider: string; readonly model: string }) => ({
        selected: { provider: input.provider, model: input.model },
      }),
    },
    llm,
    sessionPersistence: { inspect: async (id: string) => ({ events: sessions.get(id)?.events ?? [], header: { id } }) },
    sessionProjections: {
      restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { ...DEFAULT_MODEL } } } } }),
    },
    workspaceRegistry: { archivedSessionIds, archiveSession: async () => {} },
    agents,
  }

  const ctx = {
    // cordis 的 `effect` 立即执行一次，把返回的清理函数登记给 fiber。
    effect: (effect: () => () => Promise<void> | void) => { disposers.push(effect()) },
    on,
    get: (name: string) => services[name],
    llm,
    agents,
    root: { emit: () => {} },
  } as unknown as Context

  const access: Access = {
    mode: 'authenticated',
    ready: () => {},
    resolve: () => actor,
    assert: value => { if (revoked || value !== actor) throw new AccessError(403, '无权访问') },
  }
  const port = new MemoryConversationPort(AGENT_ID)
  const config: RuntimeConfig = {
    routePrefix: '/minimal-agent',
    turnTimeoutMs: 30_000,
    authRecheckMs: 10_000,
    maxActiveConversations: 8,
    // 宿主認这个 effort（见 `resolveModelInfo` 的假实现），所以它会进 `agentOptions`。
    reasoningEffort: 'medium',
  }
  const allowedTools = () => ['dsh_tool_read']
  const lifecycle = new ConversationLifecycle({ ctx, definition, access, store: port, config, allowedTools })
  const runtime: AgentRuntime = { ctx, definition, access, store: port, config, lifecycle, allowedTools }
  const participant = createParticipant({ definition, runtime, access, config })

  /**
   * 等到条件成立。
   *
   * 用真实计时器轮询（不用假计时器：假计时器会把"谁在推进回合"变成测试自己说了算），并且
   * 用**墙钟上限**而不是固定次数：并行跑整套时机器会更忙，但这条链只吃微任务，10s 已经是
   * 极宽松的上界；真卡住时报出的是带名字的等待超时，不是一句笼统的用例超时。
   */
  const until = async (check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`等待超时（10s）：${label}`)
      await new Promise<void>(resolve => { setTimeout(resolve, 1) })
    }
  }

  /**
   * 这条用例自己发出去的、还没收敛的协作轮次。
   *
   * 收尾前要先等它们收敛：插件释放会把还在飞的一轮**拒绝成 503**（`participant.ts` 的
   * `close()`），而"释放"一旦落在一轮还没跑完的时候，红的就是那条正在等结果的用例 ——
   * 这正是"看起来像并行时序问题"的那一类 503。
   */
  const inFlight = new Set<Promise<unknown>>()

  /**
   * 登记一轮协作：留一个已消化的影子 promise（用例失败时插件释放产生的 503 拒绝没有调用方
   * 接住，会在输出里留下"未处理拒绝"的噪音、掩盖真正的原因），并在收敛后把它移出在飞集合。
   */
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise)
    void promise.catch(() => {})
    void promise.then(() => { inFlight.delete(promise) }, () => { inFlight.delete(promise) })
    return promise
  }

  const harness: Harness = {
    definition, participant, lifecycle, port, ctx, access,
    call(overrides = {}) {
      const progress: ParticipantProgress[] = []
      return {
        progress,
        request: {
          actor: overrides.actor ?? actor,
          missionId: overrides.missionId ?? 'mission-1',
          requestId: overrides.requestId ?? 'turn-1',
          message: overrides.message ?? '跑一轮最小会话',
          ...(overrides.conversationId === undefined ? {} : { conversationId: overrides.conversationId }),
          ...(overrides.acceptance === undefined ? {} : { acceptance: overrides.acceptance }),
          ...(overrides.reworkOf === undefined ? {} : { reworkOf: overrides.reworkOf }),
          signal: new AbortController().signal,
          onProgress: value => { progress.push(value) },
        },
      }
    },
    async accept(since = 0) {
      await until(() => followups.length > since, `第 ${since + 1} 轮接单`)
      const last = followups.at(-1)
      if (last === undefined) throw new Error('接单记录为空')
      return last.id
    },
    run: request => track(participant.run(request)),
    reply: request => {
      const delegate = participant.reply
      if (delegate === undefined) throw new Error('运行时必须暴露 reply：契约里"实现了才暴露续问"')
      return track(delegate.call(participant, request))
    },
    async settle(conversationId) {
      await until(() => !lifecycle.isBusy(conversationId), `会话 ${conversationId} 回到空闲`)
    },
    emit, stream: (frame, conversationId) => {
      dispatch('agent/assistant-stream', { agent: sessionOf(conversationId).agent, frame })
    },
    toolResult: (resultText, meta, conversationId) => {
      emit('tool/result', {
        turn: 1,
        step: 1,
        // 参与者从 `message.content[0].content` 取结果正文、从 `meta` 取结构化值。
        message: { content: [{ content: resultText === '' ? [] : [{ type: 'text', text: resultText }] }] },
        ...(meta === undefined ? {} : { meta }),
      }, conversationId)
    },
    complete: (conversationId, text, input = {}) => {
      const turn = input.turn ?? 1
      emit('turn/start', { turn }, conversationId)
      emit('assistant/message', {
        turn, step: 1, stream: [], message: { content: [{ type: 'text', text }] },
      }, conversationId)
      emit('turn/end', { turn, reason: { kind: input.reason ?? 'completed' } }, conversationId)
    },
    async answer(conversationId, text, input = {}) {
      harness.complete(conversationId, text, {
        turn: input.turn ?? 1,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
    },
    promptsOf: conversationId => sessionOf(conversationId).prompts,
    restrictionsOf: conversationId => sessionOf(conversationId).restrictions,
    agentOptionsOf: conversationId => sessionOf(conversationId).options[0],
    opened: () => openedIds,
    resumed: () => resumedIds,
    followups: () => followups,
    cancels: () => cancels,
    revoke: () => { revoked = true },
  }
  /**
   * 替身的生命周期**只跟它自己那条用例绑定**，而且要先等这一轮跑完再释放。
   *
   * 两处都是必要的：
   *
   * 1. **不共享"当前所有在用替身"的数组**（早先用的是模块级 `afterEach` + 一个全局数组）：
   *    那种写法把不同用例的释放耦合在一起，只要两条用例在时间上重叠，一条的收尾就会把另一条
   *    还在跑的替身一起释放掉，症状是「最小 Agent正在停止」的 503 落在别的用例上。
   * 2. **释放前先等自己这一轮收敛**：`onTestFinished` 在 vitest 的并发模式里用的是"当前用例"
   *    这个环境指针（`getCurrentTest()`），并发下并不可靠——收尾有可能被挂到别的用例上而提前
   *    触发。等一轮收敛这一步把这种提前释放变成"晚一点释放"，不会用 503 打断正在跑的一轮。
   *
   * 本仓库与 CI 都按默认（文件并行、文件内顺序）跑，所以第 1 条已经足够；第 2 条是冗余保险。
   */
  onTestFinished(async () => {
    await Promise.allSettled([...inFlight])
    await lifecycle.dispose()
    for (const close of disposers) await close()
  })
  return harness
}

// ---------------------------------------------------------------------------
// 最小 AgentDefinition 与请求
// ---------------------------------------------------------------------------

interface DefinitionInput {
  readonly tools?: (ctx: AgentToolContext) => readonly { readonly name: string }[]
  readonly projectResult?: (ctx: ResultContext) => Promise<ProjectedResult>
  readonly needsReply?: (ctx: ResultContext) => boolean
  readonly opaqueFromToolResult?: (resultText: string, meta: unknown) => readonly string[]
  readonly projectReasoning?: (raw: string, ctx: ReasoningProjectionContext) => string
}

/** 最小声明：身份 + persona + 空工具集 + 一个结果投影（其余钩子按需覆盖）。 */
function define(input: DefinitionInput = {}): AgentDefinition {
  return {
    id: AGENT_ID,
    displayName: '最小 Agent',
    description: '验收用最小成员：一轮问答',
    persona: PERSONA,
    tools: (input.tools ?? (() => [])) as AgentDefinition['tools'],
    // 运行时路径不读 `config`（它由 `mount()` 校验），这里只给出形状。
    config: {} as AgentDefinition['config'],
    ...(input.projectResult === undefined ? {} : { projectResult: input.projectResult }),
    ...(input.needsReply === undefined ? {} : { needsReply: input.needsReply }),
    ...(input.opaqueFromToolResult === undefined ? {} : { opaqueFromToolResult: input.opaqueFromToolResult }),
    ...(input.projectReasoning === undefined ? {} : { projectReasoning: input.projectReasoning }),
  }
}

/** 取一次同步抛错（同步面用 try/catch 断言，避免把"同步抛"写成"promise 拒绝"）。 */
function caught(run: () => unknown): unknown {
  try { run(); return undefined } catch (error) { return error }
}

/** 从投给 Agent 的用户消息里取正文（形状是 llm 的 `UserMessage`）。 */
function userText(message: unknown): string {
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => typeof block === 'object' && block !== null
    && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
    ? [block.text] : []).join('')
}

// ---------------------------------------------------------------------------
// 判据①：最小 Agent 跑通一轮
// ---------------------------------------------------------------------------

describe('P1 判据①：最小 Agent 跑通一轮', () => {
  it('一轮 run：预留→发布→装配→追加消息→投影→交回结果', async () => {
    const seen: ResultContext[] = []
    const definition = define({
      projectResult: async context => {
        seen.push(context)
        return { status: 'completed', text: `答复：${context.history.finalText}` }
      },
    })
    const f = fixture(definition)
    const call = f.call({ message: '跑一轮最小会话' })
    const pending = f.run(call.request)
    const id = await f.accept()

    // 预留段已经写过、发布段已经翻真：会话在侧栏可见、可以发消息。
    expect(f.port.size).toBe(1)
    expect(f.port.rawOf(id)?.ready).toBe(true)
    expect(id).toMatch(/^minimal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // agent 作用域在这个会话上装配了 persona 段与工具限制（不是插件级限制）。
    expect(f.promptsOf(id)).toEqual([{ name: `${AGENT_ID}:persona`, order: 600, text: PERSONA }])
    expect(f.restrictionsOf(id)).toEqual([['dsh_tool_read']])
    // 模型路由：默认选择 + 宿主認可的 reasoningEffort 一起进 create 选项。
    expect(f.agentOptionsOf(id)).toMatchObject({ ...DEFAULT_MODEL, reasoningEffort: 'medium' })
    // 首条用户消息压成标题（自动来源）。"空标题 = automatic" 是 D4 的修复口径（`a5b580f`）：
    // 真实现与这个替身在这里已经一致，真 PG 回归在 `storage-contract.test.ts` 的 D4 用例里守着。
    expect(f.port.rawOf(id)).toMatchObject({ title: '跑一轮最小会话', titleSource: 'automatic' })

    await f.answer(id, '最小 Agent 已跑通一轮')
    const result = await pending

    expect(result).toMatchObject({ status: 'completed', conversationId: id, text: '答复：最小 Agent 已跑通一轮' })
    // 没有交产物时回落到"查看会话"这一条材料定位。
    expect(result.artifacts).toEqual([{ kind: 'conversation', title: '查看会话', path: `/minimal-agent?conversationId=${id}` }])
    expect(result.question).toBeUndefined()
    // ⑦ 的结论如实回报：业务侧没有自检能力（`absent`）⇒ 汇总报 `absent`，**不折成
    // `unverifiable`** —— 协调方要能分清"这个执行方没有自检能力"与"这一轮没有可核验的产出"。
    expect(result.selfCheck).toMatchObject({ status: 'absent' })
    // 投影拿到的是完整一轮历史 + 派单请求 + 未注入的存储。
    expect(seen).toHaveLength(1)
    expect(seen[0]?.history.conversationId).toBe(id)
    expect(seen[0]?.history.finalText).toBe('最小 Agent 已跑通一轮')
    expect(seen[0]?.history.messages.map(message => [message.role, message.text]))
      .toEqual([['user', '跑一轮最小会话'], ['assistant', '最小 Agent 已跑通一轮']])
    expect(seen[0]?.request).toEqual({ message: '跑一轮最小会话' })
    expect(seen[0]?.storage).toBeUndefined()
    // 交活工具没被装配（账本 `available` 为假）⇒ 结论走投影兜底，不做补交轮。
    expect(result.text).toBe('答复：最小 Agent 已跑通一轮')
    // 接单时就把会话引用交回（页面刷新不丢），且只交一次。
    expect(call.progress.filter(value => value.conversationArtifact !== undefined)).toHaveLength(1)
    expect(call.progress[0]).toMatchObject({ kind: 'status', conversationId: id })

    await f.settle(id)
    expect(f.lifecycle.isBusy(id)).toBe(false)
  })

  it('needsReply 是 waiting 的唯一来源，并且一定带 question', async () => {
    const asked: ResultContext[] = []
    const definition = define({
      // 投影只报"已完成"；是否等待由 needsReply 决定（业务不能自己把状态改成等待）。
      projectResult: async () => ({ status: 'completed', text: '第一版和第二版都准备好了' }),
      needsReply: context => { asked.push(context); return true },
    })
    const f = fixture(definition)
    const call = f.call({ message: '先出哪一版？' })
    const pending = f.run(call.request)
    const id = await f.accept()
    await f.answer(id, '两版都写好了，要哪一版？')
    const result = await pending

    expect(result.status).toBe('waiting')
    // `question` 必须存在：投影没给问题时用兜底问题，否则用户面对一个没有问题的"等待"。
    expect(result.question).toBe('第一版和第二版都准备好了')
    expect(result.text).toBe('第一版和第二版都准备好了')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.history.finalText).toBe('两版都写好了，要哪一版？')
    await f.settle(id)
  })

  it('reply 沿原会话续问；缺 conversationId 一律拒绝且不新建会话', async () => {
    const definition = define({
      projectResult: async context => ({ status: 'completed', text: `收到：${context.history.finalText}` }),
    })
    const f = fixture(definition)
    // 契约：只有实现了才暴露续问能力，群组不因为"存在通用 run"就推断可以续问。
    expect(typeof f.participant.reply).toBe('function')

    const first = f.call({ message: '第一问', requestId: 'turn-1' })
    const pending = f.run(first.request)
    const id = await f.accept()
    await f.answer(id, '第一答')
    expect(await pending).toMatchObject({ status: 'completed', conversationId: id })
    await f.settle(id)

    // 缺 conversationId：拒绝 —— 否则用户的话会落进一条他不认识的对话里。
    const orphan = f.call({ message: '第二问', requestId: 'turn-2' })
    const before = f.followups().length
    const rejection = await Promise.resolve().then(() => f.reply(orphan.request)).then(() => undefined, (error: unknown) => error)
    expect(rejection).toMatchObject({ status: 400, code: 'DSH_ACCESS_ERROR' })
    // 没有任何副作用：没有新会话、没有新句柄、也没有把这句话投给 Agent。
    expect(f.followups()).toHaveLength(before)
    expect(f.port.size).toBe(1)
    expect(f.opened()).toEqual([id])

    // 带 conversationId：沿原会话、同一个 Agent 对象续接，不新建会话、不 resume。
    const second = f.call({ message: '第二问', requestId: 'turn-2', conversationId: id })
    const seen = f.followups().length
    const continued = f.reply(second.request)
    expect(await f.accept(seen)).toBe(id)
    await f.answer(id, '第二答', { turn: 2 })
    expect(await continued).toMatchObject({ status: 'completed', conversationId: id, text: '收到：第二答' })

    expect(f.followups().filter(entry => userText(entry.message) === '第二问')).toHaveLength(1)
    expect(f.followups().filter(entry => userText(entry.message) === '第一问')).toHaveLength(1)
    expect(f.followups().every(entry => entry.id === id)).toBe(true)
    expect(f.port.size).toBe(1)
    expect(f.opened()).toEqual([id])
    expect(f.resumed()).toEqual([])
    await f.settle(id)
  })

  it('acceptance 与 reworkOf 原样到达参与者，没有口径时不凭空多出字段', async () => {
    const contexts: ResultContext[] = []
    const definition = define({
      projectResult: async context => {
        contexts.push(context)
        return {
          status: 'completed',
          text: '已交回',
          // ⑦ 的第 3 条：口径非空 ⇒ 材料非空。给一条材料，这一轮才不会被自修正重跑。
          artifacts: [{ kind: 'report', title: '验收报告', path: '/minimal-agent?report=1' }],
        }
      },
    })
    const f = fixture(definition)

    const first = f.call({ message: '重做一遍', acceptance: '必须有结论', reworkOf: 'subtask-7' })
    const pending = f.run(first.request)
    const id = await f.accept()
    await f.answer(id, '第一版')
    await pending
    expect(contexts[0]?.request).toEqual({ message: '重做一遍', acceptance: '必须有结论', reworkOf: 'subtask-7' })
    await f.settle(id)

    // 第二次派活没有 conversationId（新一轮会话）、也没有口径：请求里不该出现 undefined 字段。
    const second = f.call({ message: '再跑一轮', requestId: 'turn-2' })
    const beforeSecond = f.followups().length
    const next = f.run(second.request)
    const nextId = await f.accept(beforeSecond)
    await f.answer(nextId, '第二版')
    await next
    expect(nextId).not.toBe(id)
    expect(contexts[1]?.request).toEqual({ message: '再跑一轮' })
    expect(contexts).toHaveLength(2)
    expect(f.port.size).toBe(2)
    await f.settle(nextId)
  })

  it('opaqueFromToolResult 是安全钩子：标识进 opaque 集合后思考快照里被替换', async () => {
    const internal = 'bd7f5c2e-91aa-4f30-9c31-8ee0a5d0c001'
    const toolResultText = JSON.stringify({ data: { reservationId: internal } })
    const hookCalls: { readonly text: string; readonly meta: unknown }[] = []
    const opaqueSizes: number[] = []
    const definition = define({
      // 钩子没被调用 ⇒ `opaqueValues` 恒为空 ⇒ 这里抛错 ⇒ 整轮失败 ⇒ 本用例必红。
      // 这是刻意的：本用例要证明的是"运行时**真的**调用了安全钩子"，而不是"投影函数写得对"。
      projectReasoning: (raw, context) => {
        if (context.opaqueValues.length === 0) throw new Error('opaqueFromToolResult 没有被调用：安全钩子失效')
        opaqueSizes.push(context.opaqueValues.length)
        return context.opaqueValues.reduce((text, value) => text.split(value).join('[内部标识已隐藏]'), raw)
      },
      opaqueFromToolResult: (resultText, meta) => {
        hookCalls.push({ text: resultText, meta })
        const parsed = JSON.parse(resultText) as { readonly data?: { readonly reservationId?: string } }
        const value = parsed.data?.reservationId
        return value === undefined ? [] : [value]
      },
    })
    const f = fixture(definition)
    const call = f.call({ message: '核对这条记录' })
    const pending = f.run(call.request)
    const id = await f.accept()

    f.emit('turn/start', { turn: 1 }, id)
    f.toolResult(toolResultText, { tool: 'minimal_lookup' }, id)
    f.stream({ type: 'start', attemptId: 'attempt-a', revision: 1, turn: 1, step: 1 }, id)
    f.stream({
      type: 'chunk', attemptId: 'attempt-a', revision: 2, index: 0, time: 120,
      chunk: { type: 'reasoning-delta', index: 0, text: `这条 ${internal} 是关键。` },
    }, id)
    f.emit('assistant/message', { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: '已核对。' }] } }, id)
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, id)
    const result = await pending

    expect(result).toMatchObject({ status: 'completed', text: '已核对。' })
    // 钩子被调用过，并且拿到的是工具结果的正文与 meta（不是空值、不是别的事件）。
    expect(hookCalls).toEqual([{ text: toolResultText, meta: { tool: 'minimal_lookup' } }])
    expect(opaqueSizes.length).toBeGreaterThan(0)
    const thinking = call.progress.filter(value => value.kind === 'thinking').map(value => value.thinking ?? '').join('\n')
    expect(call.progress.some(value => value.kind === 'thinking')).toBe(true)
    expect(thinking).toContain('[内部标识已隐藏]')
    expect(thinking).not.toContain(internal)
    // 任何一条上报里都不能出现这个标识。
    expect(JSON.stringify(call.progress)).not.toContain(internal)
    await f.settle(id)
  })

  it('安全钩子的负向对照：不发 tool/result 时，同一套投影必然让整轮失败', async () => {
    // 这条用例把上一条的判据反过来钉住：钩子没被调用（等价于"运行时不再在 tool/result 上调用它"）
    // 时，投影拿到的 `opaqueValues` 恒为空 —— 于是它抛错、整轮失败、上一条用例必红。
    // 没有这条对照，"钩子没被调就必然红"只是注释里的承诺。
    const definition = define({
      projectReasoning: (raw, context) => {
        if (context.opaqueValues.length === 0) throw new Error('opaqueFromToolResult 没有被调用：安全钩子失效')
        return raw
      },
      opaqueFromToolResult: () => ['不会被调用'],
    })
    const f = fixture(definition)
    const call = f.call({ message: '核对这条记录' })
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    // 关键差别：**不**发 `tool/result`，直接给推理增量。
    f.stream({ type: 'start', attemptId: 'attempt-a', revision: 1, turn: 1, step: 1 }, id)
    f.stream({
      type: 'chunk', attemptId: 'attempt-a', revision: 2, index: 0, time: 120,
      chunk: { type: 'reasoning-delta', index: 0, text: '这条 bd7f5c2e 是关键。' },
    }, id)
    f.emit('assistant/message', { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: '已核对。' }] } }, id)
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, id)

    // 钩子没被调用 ⇒ 投影拿不到 opaque 集合 ⇒ 这一轮**不可能被当成成功交付**：
    // 要么整轮拒绝（错误就是那句"钩子没被调用"），要么如实标成 `failed`。
    const outcome = await pending.then((value: ParticipantResult) => value, (error: unknown) => error)
    if (outcome instanceof Error) expect(outcome.message).toContain('opaqueFromToolResult 没有被调用')
    else expect(outcome).toMatchObject({ status: 'failed' })
    await f.settle(id)
  })

  it('侧栏管理列表把"正在跑的会话"当作 busy（busy 集合由运行时算出来再传进存储端口）', async () => {
    const definition = define({
      projectResult: async context => ({ status: 'completed', text: context.history.finalText }),
    })
    const f = fixture(definition)
    const call = f.call({ message: '跑一轮' })
    const pending = f.run(call.request)
    const id = await f.accept()
    expect(f.lifecycle.isBusy(id)).toBe(true)

    const query = (overrides: Partial<ConversationQueryShape> = {}): ConversationQueryShape =>
      ({ offset: 0, limit: 30, q: '', state: '', ...overrides })
    // 宿主侧的两个集合在内存替身场景里是空的：它们来自 kit
    // （`hostBusyConversationIds` / `conversationArchive`），而那条路径只有 adapter 该碰。
    const hostScope = { hostBusy: [], archived: [] } as const
    const running = await f.lifecycle.list(actor, query(), hostScope)
    expect(running.items.map(item => item.id)).toEqual([id])
    expect(running.items[0]).toMatchObject({ id, state: 'busy', canRemove: false })
    expect(running.items[0]?.blockedReason).toBeTruthy()
    // 状态过滤与搜索都走存储端口，不是在这里现筛的。
    expect((await f.lifecycle.list(actor, query({ state: 'busy' }), hostScope)).items.map(item => item.id)).toEqual([id])
    expect((await f.lifecycle.list(actor, query({ state: 'ready' }), hostScope)).items).toEqual([])
    expect((await f.lifecycle.list(actor, query({ q: '不存在' }), hostScope)).items).toEqual([])

    await f.answer(id, '跑完了')
    await pending
    await f.settle(id)
    const idle = await f.lifecycle.list(actor, query(), hostScope)
    expect(idle.items[0]).toMatchObject({ id, state: 'ready', canRemove: true })
    expect(idle.items[0]?.blockedReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 测试替身本身：它必须真的具备被依赖的那些语义
// ---------------------------------------------------------------------------

describe('内存会话端口替身（P1 用它替代 P2 的真实实现）', () => {
  const owner: OwnerKey = { namespace: 'user', userId: 'alice' }
  const otherOwner: OwnerKey = { namespace: 'user', userId: 'bob' }
  const query = (overrides: Partial<ConversationQueryShape> = {}): ConversationQueryShape =>
    ({ offset: 0, limit: 30, q: '', state: '', ...overrides })
  const noScope = { busy: [], archived: [] }

  it('create 是预留段并按 requestId 幂等，publish 之后才可见', async () => {
    const port = new MemoryConversationPort('minimal')
    const reserved = await port.create(owner, 'minimal-1', 'mission:minimal:user:alice:m-1')
    expect(reserved).toMatchObject({ id: 'minimal-1', ready: false, removalState: '', deletedAt: null })
    // 预留行在侧栏不可见（发布握手没走完）。
    expect((await port.list(owner, query(), noScope)).items).toEqual([])
    await port.publish(owner, 'minimal-1')
    expect(port.rawOf('minimal-1')?.ready).toBe(true)
    expect((await port.list(owner, query(), noScope)).items.map(item => item.id)).toEqual(['minimal-1'])

    // 同一个 (owner, requestId) 再来一次：返回原来那一行，不新建。
    const again = await port.create(owner, 'minimal-2', 'mission:minimal:user:alice:m-1')
    expect(again.id).toBe('minimal-1')
    expect(port.size).toBe(1)
    // 同一个 id 被别的 owner 预留：撞身份，直接拒绝。
    await expect(port.create(otherOwner, 'minimal-1', '')).rejects.toMatchObject({ status: 409 })
    // 别的 requestId 是另一条会话。
    await port.create(owner, 'minimal-3', 'mission:minimal:user:alice:m-2')
    expect(port.size).toBe(2)
  })

  it('record / mark 是同步面：未知与他人身份一律同一个 404，不泄露存在性', async () => {
    const port = new MemoryConversationPort('minimal')
    await port.create(owner, 'minimal-1', 'r-1')
    await port.publish(owner, 'minimal-1')
    const alice: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
    const bob: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }

    // 同步读：直接返回值，不是 promise（kit 的移除围栏同步调它）。
    expect(port.record(alice, 'minimal-1')).toMatchObject({ id: 'minimal-1', ready: true, removalState: '', deletedAt: null })
    expect(caught(() => port.record(alice, '不存在的会话'))).toMatchObject({ status: 404 })
    expect(caught(() => port.record(bob, 'minimal-1'))).toMatchObject({ status: 404 })
    expect(caught(() => port.mark(bob, 'minimal-1', 'pending'))).toMatchObject({ status: 404 })
    // 别的 Agent 的端口里这条会话根本不存在：跨 Agent 不串数据。
    const otherAgent = new MemoryConversationPort('blog')
    expect(caught(() => otherAgent.record(alice, 'minimal-1'))).toMatchObject({ status: 404 })

    // 同步写：pending 让该项不可移除，removed 让它从列表消失并补 deletedAt。
    port.mark(alice, 'minimal-1', 'pending')
    const pending = (await port.list(owner, query({ state: 'pending' }), noScope)).items
    expect(pending[0]).toMatchObject({ id: 'minimal-1', state: 'pending', canRemove: false })
    expect(pending[0]?.blockedReason).toBeTruthy()
    port.mark(alice, 'minimal-1', 'removed')
    expect(port.record(alice, 'minimal-1').removalState).toBe('removed')
    expect(port.record(alice, 'minimal-1').deletedAt).not.toBeNull()
    expect((await port.list(owner, query(), noScope)).items).toEqual([])
  })

  it('list 真的用上 scope.busy 与 scope.archived', async () => {
    const port = new MemoryConversationPort('minimal')
    await port.create(owner, 'minimal-running', 'r-1')
    await port.publish(owner, 'minimal-running')
    await port.create(owner, 'minimal-idle', 'r-2')
    await port.publish(owner, 'minimal-idle')
    await port.create(otherOwner, 'minimal-bob', 'r-3')
    await port.publish(otherOwner, 'minimal-bob')

    const idle = await port.list(owner, query(), noScope)
    expect([...idle.items.map(item => item.id)].sort()).toEqual(['minimal-idle', 'minimal-running'])
    expect(idle.total).toBe(2)
    expect(idle.items.every(item => item.canRemove)).toBe(true)

    // busy 集合决定 state / canRemove / blockedReason。
    const busy = await port.list(owner, query(), { busy: ['minimal-running'], archived: [] })
    expect(busy.items.find(item => item.id === 'minimal-running')).toMatchObject({ state: 'busy', canRemove: false })
    expect(busy.items.find(item => item.id === 'minimal-running')?.blockedReason).toBeTruthy()
    expect((await port.list(owner, query({ state: 'busy' }), { busy: ['minimal-running'], archived: [] })).items.map(item => item.id))
      .toEqual(['minimal-running'])
    // 换一个 id 进 busy 集合，状态跟着集合走（不是"忙过一次就一直忙"）。
    expect((await port.list(owner, query({ state: 'ready' }), { busy: ['minimal-idle'], archived: [] })).items.map(item => item.id))
      .toEqual(['minimal-running'])

    // archived：已删除但没标记移除的行，只有**未**归档时才出现。
    port.seedLegacy(owner, 'minimal-legacy')
    expect((await port.list(owner, query(), noScope)).items.map(item => item.id)).toContain('minimal-legacy')
    expect((await port.list(owner, query(), { busy: [], archived: ['minimal-legacy'] })).items.map(item => item.id))
      .not.toContain('minimal-legacy')

    // 搜索与分页。
    expect((await port.list(owner, query({ q: 'IDLE' }), noScope)).items.map(item => item.id)).toEqual(['minimal-idle'])
    const page = await port.list(owner, query({ limit: 1 }), noScope)
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(1)
    expect(page.nextOffset).toBe(1)
  })

  it('syncTitle 守住"自动标题不覆盖手动标题"', async () => {
    const port = new MemoryConversationPort('minimal')
    await port.create(owner, 'minimal-1', 'r-1')
    // 未发布的预留行不写标题（与真实实现的 `ready = TRUE` 条件一致）。
    await port.syncTitle(owner, 'minimal-1', '还没发布', 'automatic')
    expect(port.rawOf('minimal-1')?.title).toBe('')
    await port.publish(owner, 'minimal-1')
    await expect(port.syncTitle(otherOwner, 'minimal-1', '别人的标题', 'manual')).rejects.toMatchObject({ status: 404 })

    await port.syncTitle(owner, 'minimal-1', '首句自动标题', 'automatic')
    expect(port.rawOf('minimal-1')).toMatchObject({ title: '首句自动标题', titleSource: 'automatic' })
    await port.syncTitle(owner, 'minimal-1', '用户改名', 'manual')
    expect(port.rawOf('minimal-1')).toMatchObject({ title: '用户改名', titleSource: 'manual' })
    // 自动与生成都不能覆盖手动。
    await port.syncTitle(owner, 'minimal-1', '迟到的自动标题', 'automatic')
    await port.syncTitle(owner, 'minimal-1', '迟到的生成标题', 'generated')
    expect(port.rawOf('minimal-1')).toMatchObject({ title: '用户改名', titleSource: 'manual' })
    // 手动可以再改。
    await port.syncTitle(owner, 'minimal-1', '再改一次', 'manual')
    expect(port.rawOf('minimal-1')?.title).toBe('再改一次')

    await port.create(owner, 'minimal-2', 'r-2')
    await port.publish(owner, 'minimal-2')
    await port.syncTitle(owner, 'minimal-2', '官方标题', 'generated')
    await port.syncTitle(owner, 'minimal-2', '迟到的自动标题', 'automatic')
    expect(port.rawOf('minimal-2')).toMatchObject({ title: '官方标题', titleSource: 'generated' })
  })

  it('missionRequestId 是纯函数：同一输入恒等，跨 Agent / 跨用户 / 跨任务都不同', () => {
    const minimal = new MemoryConversationPort('minimal')
    const blog = new MemoryConversationPort('blog')
    const value = minimal.missionRequestId(owner, 'mission-1')
    expect(minimal.missionRequestId(owner, 'mission-1')).toBe(value)
    expect(value).toContain('minimal')
    expect(minimal.missionRequestId(owner, 'mission-2')).not.toBe(value)
    expect(minimal.missionRequestId(otherOwner, 'mission-1')).not.toBe(value)
    expect(blog.missionRequestId(owner, 'mission-1')).not.toBe(value)
    // 纯函数：不产生任何副作用。
    expect(minimal.size).toBe(0)
    expect(minimal.ids()).toEqual([])
  })

  it('managed 是所有者作用域的侧栏入口：预览受围栏限制，移除走 pending→removed', async () => {
    const port = new MemoryConversationPort('minimal')
    await port.create(owner, 'minimal-1', 'r-1')
    await port.publish(owner, 'minimal-1')
    const provider = port.managed(owner)
    const alice: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
    expect(provider.protocol).toBe(1)
    expect(provider.pluginId).toBe('minimal')
    expect((await provider.list(alice, query())).items.map(item => item.id)).toEqual(['minimal-1'])
    // 别人的身份看不到任何东西，也不会因此知道这条会话存在（同一个 404）。
    await expect(provider.list(otherActor, query())).rejects.toMatchObject({ status: 404 })
    await expect(provider.preview(otherActor, 'minimal-1')).rejects.toMatchObject({ status: 404 })
    // 事件日志不在端口里：预览只回答"这条会话存在且可读"。
    expect(await provider.preview(alice, 'minimal-1')).toEqual({ messages: [], previousBefore: null, total: 0 })
    await expect(provider.remove(alice, [])).rejects.toMatchObject({ status: 400 })

    expect(await provider.remove(alice, ['minimal-1'])).toEqual({ results: [{ id: 'minimal-1', status: 'removed' }] })
    expect(port.rawOf('minimal-1')?.removalState).toBe('removed')
    expect((await provider.list(alice, query())).items).toEqual([])
    // 重复移除走 alreadyRemoved（kit 的围栏依赖这一条，不能算失败）。
    expect(await provider.remove(alice, ['minimal-1'])).toEqual({ results: [{ id: 'minimal-1', status: 'alreadyRemoved' }] })
  })
})
