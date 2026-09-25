/**
 * 协作入口的行为契约（P4：载体从 closedoff 自己的 `createClosedoffParticipant` 换成运行时）。
 *
 * 本文件原先测 `src/participant.ts` 的 `createClosedoffParticipant`（190 行，随 P4 删除）。
 * 它的职责逐条对应到 `packages/runtime/src/participant.ts` 的 `createParticipant`：
 * 授权复核与定时重核 · 独占判定 · 超时 / 中止 / 释放 · 事件投影 · conversation artifact ·
 * 上报前重核验。所以 24 条用例逐条搬到新载体上，**断言强度不变**；"这一轮交付什么"由
 * `AgentDefinition` 的钩子给出，测试用 closedoff 的那套钩子（`redactVisibleText` /
 * `projectReasoning` / `collectOpaqueResultValues`）填上。
 *
 * ## 必留资产：同一会话必须复用同一个 Agent 对象
 *
 * `agent/assistant-stream` 的载荷带的是 Agent 对象本身，读帧的实现（`projection.ts` 的
 * `onAssistantDelta`）用它在 WeakMap 里记住「这是同一轮尝试的哪一段」。夹具每次投递都新建
 * 对象的话，增量永远归不到同一轮，转发看起来就像没接上 —— 所以**按会话复用同一个对象**
 * （见 `sessionOf`）。
 *
 * ## 夹具
 *
 * 照 `tests/runtime-minimal-agent.test.ts` 的写法：假宿主只提供 `ctx.agents.create/resume`
 * / `ctx.on` / `ctx.effect` / `ctx.get` 这几个面，会话事件与实时帧由测试自己按需发出；
 * 会话存储用 `tests/fixtures/memory-conversation-port.ts` 的**内存替身** —— 不连 PG、
 * 不依赖真实模型。替身与真实现的语义差写在那个文件头上，别拿它推断真实实现的时序。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ParticipantProgress, ParticipantRequest, ParticipantResult } from '../../../packages/runtime/src/contract.ts'
import { ConversationLifecycle, type Conversation, type RuntimeConfig } from '../../../packages/runtime/src/conversation.ts'
import type { AgentDefinition, ProjectedResult, ResultContext } from '../../../packages/runtime/src/definition.ts'
import { createParticipant, type RuntimeParticipant } from '../../../packages/runtime/src/participant.ts'
import { Config as ConfigSchema, type Config } from '../src/config.ts'
import { createClosedoffDefinition } from '../src/definition.ts'
import type { ClosedoffGateway } from '../src/gateway.ts'
import { collectOpaqueResultValues, projectReasoning } from '../src/presentation.ts'
import { redactVisibleText } from '../src/redaction.ts'
import { MemoryConversationPort } from '../../../tests/fixtures/memory-conversation-port.ts'

const AGENT_ID = 'closedoff'
const PERSONA = '你是封闭化智能体：只读查询园区、通行与车辆信息。'
const DEFAULT_MODEL = { provider: 'deepseek', model: 'test' }
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const other: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }
const ROUTE_PREFIX = '/closedoff-qa'
const INTERNAL = 'bd7f5c2e-91aa-4f30-9c31-8ee0a5d0c001'

vi.setConfig({ testTimeout: 30_000 })

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

// ---------------------------------------------------------------------------
// 假宿主 + 真实运行时
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

interface PromptSection { readonly name?: string; readonly order?: number; readonly text?: string }

interface FakeSession {
  readonly id: string
  readonly events: SessionEvent[]
  disposed: number
  agent: FakeAgent
}

interface FakeAgent {
  readonly id: string
  readonly session: { readonly id: string; readonly snapshotEvents: () => readonly SessionEvent[] }
  followup: (message: unknown) => void
  whenIdle: () => Promise<void>
  cancel: (cause: unknown) => void
}

interface Hold {
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

interface Harness {
  readonly participant: RuntimeParticipant
  readonly lifecycle: ConversationLifecycle
  readonly ctx: Context
  /** 会话端口（断言"建了哪几条会话"用）。 */
  readonly port: MemoryConversationPort
  /**
   * `session/event` 通道的订阅数基线。
   *
   * 它不是 0：`ConversationLifecycle` 的构造里就注册了标题订阅（`registerConversationTitles`），
   * 参与者也注册了增量出口（`onAssistantDelta`）。"一轮有没有退订"要比**基线**，不能比 0。
   */
  readonly baseline: number
  /** 造一次 `run` 的请求（每次调用自带一个进度收集器）。 */
  call(overrides?: {
    readonly conversationId?: string
    readonly message?: string
    readonly requestId?: string
    readonly actor?: Actor
    readonly signal?: AbortSignal
    readonly onProgress?: (value: ParticipantProgress) => void
  }): { readonly request: ParticipantRequest; readonly progress: ParticipantProgress[] }
  /** `participant.run`：外挂一个已消化的影子 promise，避免失败路径上的"未处理拒绝"噪音。 */
  run(request: ParticipantRequest): Promise<ParticipantResult>
  /**
   * 等到第 `since + 1` 轮接单（用户消息已经投给 Agent），返回它的会话 id；**并核验到此刻为止
   * 恰好接单了 `since + 1` 次**（重复接单必须变红，见实现里的说明）。
   */
  accept(since?: number): Promise<string>
  /** 等到会话回到空闲。 */
  settle(conversationId: string): Promise<void>
  emit(type: string, data: unknown, conversationId: string): void
  /** 模型实时帧（`agent/assistant-stream` 通道）。 */
  stream(frame: unknown, conversationId: string): void
  toolResult(resultText: string, meta: unknown, conversationId: string): void
  /** 交付一轮：`turn/start` → `assistant/message` → `turn/end`。 */
  complete(conversationId: string, text: string, reason?: string): void
  followups(): readonly { readonly id: string; readonly message: unknown }[]
  cancels(): readonly { readonly id: string; readonly cause: unknown }[]
  /** `session/event` 通道当前的订阅数（漏订或漏退订都看得见）。 */
  listeners(): number
  /**
   * 记下"这一轮开始前"的订阅数，随后用 `listeners()` 与它比。
   *
   * 参与者的会话事件订阅是**随轮**建的（`run` 里才 `ctx.on('session/event')`），所以基线要在
   * 接单之后取；比 0 会把两条常驻订阅（标题、实时增量出口）算成本轮的遗留。
   */
  mark(): number
  /** 把 `lifecycle.followup` 换成受控 promise，逐次记录。 */
  holdFollowup(): { readonly calls: number; take(index?: number): Hold | undefined }
  /** 把某个会话的 `whenIdle` 换成受控 promise（返回放行函数）。 */
  holdIdle(conversationId: string): { readonly idle: ReturnType<typeof vi.fn>; readonly release: () => void }
  revoke(): void
  dispose(): Promise<void>
}

interface FixtureOptions {
  readonly turnTimeoutMs?: number
  readonly authRecheckMs?: number
  readonly redact?: (text: string) => string
  readonly projectResult?: (context: ResultContext) => Promise<ProjectedResult>
  readonly projectReasoningHook?: AgentDefinition['projectReasoning']
  readonly opaqueFromToolResult?: AgentDefinition['opaqueFromToolResult']
  /**
   * 整份声明的替身。给"必须用**真** `createClosedoffDefinition`"的用例用（材料标题这类
   * 业务文案只在真声明里，机制用例的替身声明给不出它）。
   */
  readonly definition?: AgentDefinition
}

function definitionOf(options: FixtureOptions = {}): AgentDefinition {
  if (options.definition !== undefined) return options.definition
  return {
    id: AGENT_ID,
    displayName: '封闭化管理助手',
    description: '只读业务查询',
    persona: PERSONA,
    tools: () => [],
    config: {} as AgentDefinition['config'],
    // 正文通道默认不脱敏：机制用例只断"什么时候发布什么"，脱敏由专门的用例钉住。
    redact: options.redact ?? (text => text),
    ...(options.projectReasoningHook === undefined ? {} : { projectReasoning: options.projectReasoningHook }),
    ...(options.opaqueFromToolResult === undefined ? {} : { opaqueFromToolResult: options.opaqueFromToolResult }),
    ...(options.projectResult === undefined ? {} : { projectResult: options.projectResult }),
  }
}

function fixture(options: FixtureOptions = {}): Harness {
  const byEvent = new Map<string, Set<Listener>>()
  const disposers: (() => Promise<void> | void)[] = []
  const sessions = new Map<string, FakeSession>()
  const followupCalls: { readonly id: string; readonly message: unknown }[] = []
  const cancelCalls: { readonly id: string; readonly cause: unknown }[] = []
  const inFlight = new Set<Promise<unknown>>()
  const holds: Hold[] = []
  let holding = false
  let revoked = false
  let seq = 0

  /**
   * 每个业务会话一个稳定的 Agent 对象。
   *
   * `agent/assistant-stream` 的载荷带的是 Agent 对象本身，读帧的实现用它在 WeakMap 里
   * 记住「这是同一轮尝试的哪一段」。夹具每次投递都新建对象的话，增量永远归不到同一轮，
   * 转发看起来就像没接上 —— 所以这里按会话复用。
   */
  const sessionOf = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [], disposed: 0 } as unknown as FakeSession
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: message => {
        followupCalls.push({ id, message })
        // 真实宿主会把这条用户消息写进日志；`historyOf` / `readConversationEvents` 读的就是它。
        session.events.push(event('user/message', message, id))
      },
      whenIdle: async () => { /* 假宿主同步空闲：`whenIdle` 的 then 在下一个微任务里跑完。 */ },
      cancel: cause => { cancelCalls.push({ id, cause }) },
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
  /** 按事件名投递，和真实 Cordis 一致：`on(name, listener)` 只收该名字的事件。 */
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
    systemPrompt: { section: (section: PromptSection) => { void session; void section } },
    tools: { restrict: () => {} },
  }) as unknown as Context
  const handleOf = (session: FakeSession) => ({
    agent: session.agent as unknown as Agent,
    dispose: async () => { session.disposed += 1 },
  })
  const agents = {
    create: async (input: { readonly sessionId: unknown; readonly setup?: (ctx: Context, agent: Agent) => unknown }) => {
      const session = sessionOf(String(input.sessionId))
      await input.setup?.(scopeOf(session), session.agent as unknown as Agent)
      return handleOf(session)
    },
    resume: async (input: { readonly resumeSessionId: unknown; readonly setup?: (ctx: Context, agent: Agent) => unknown }) => {
      const session = sessionOf(String(input.resumeSessionId))
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
    sessionPersistence: { inspect: async (id: string) => ({ events: sessionOf(id).events, header: { id } }) },
    sessionProjections: {
      restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { ...DEFAULT_MODEL } } } } }),
    },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
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
    assert: value => {
      if (revoked || value !== actor) throw new AccessError(403, '无权访问')
    },
  }
  const port = new MemoryConversationPort(AGENT_ID)
  const config: RuntimeConfig = {
    routePrefix: ROUTE_PREFIX,
    turnTimeoutMs: options.turnTimeoutMs ?? 10_000,
    authRecheckMs: options.authRecheckMs ?? 10_000,
    maxActiveConversations: 8,
    reasoningEffort: 'medium',
  }
  const allowedTools = () => ['closedoff_query']
  const definition = definitionOf(options)
  const lifecycle = new ConversationLifecycle({ ctx, definition, access, store: port, config, allowedTools })
  const participant = createParticipant({
    definition,
    // 惰性取值器（见 `CreateParticipantInput.runtime`）：生产的装配顺序是"先 participant、
    // 后 lifecycle"，所以交出去的必须是函数而不是实例。本替身的 `lifecycle` 已经存在，
    // 包一层只为与生产同形，不改变被测行为。
    //
    // ⚠️ 这里只给 `ctx` 与 `lifecycle`：入参类型就是这么窄的——**故意**。多给一份"整份 runtime"
    // 曾经让生产把 lifecycle 实例当取值器传进去（`TypeError: runtime.lifecycle is not a function`）。
    runtime: { ctx, lifecycle: () => lifecycle },
    access,
    config,
  })
  // 基线在**夹具建完之后**取：此刻 `session/event` 上挂着两条常驻订阅 ——
  // 生命周期的标题订阅（`registerConversationTitles`）与参与者的增量出口（`onAssistantDelta`）。
  // "这一轮有没有退订"要比基线，不能比 0。
  const baseline = (byEvent.get('session/event') ?? new Set()).size

  /** 有界等待；失败时给有信息量的错，而不是干等 vitest 的 30s。 */
  const until = async (check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`等待超时（10s）：${label}`)
      await new Promise<void>(resolve => { setTimeout(resolve, 1) })
    }
  }

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise)
    void promise.catch(() => {})
    void promise.then(() => { inFlight.delete(promise) }, () => { inFlight.delete(promise) })
    return promise
  }

  const harness: Harness = {
    participant, lifecycle, ctx, port, baseline,
    call(overrides = {}) {
      const progress: ParticipantProgress[] = []
      return {
        progress,
        request: {
          actor: overrides.actor ?? actor,
          missionId: 'mission-1',
          requestId: overrides.requestId ?? 'request-1',
          message: overrides.message ?? '查询通行记录',
          ...(overrides.conversationId === undefined ? {} : { conversationId: overrides.conversationId }),
          signal: overrides.signal ?? new AbortController().signal,
          onProgress: overrides.onProgress ?? (value => { progress.push(value) }),
        },
      }
    },
    run: request => track(participant.run(request)),
    async accept(since = 0) {
      await until(() => followupCalls.length > since, `第 ${since + 1} 轮接单`)
      // ⚠️ 只等"有 followup"是不够的：旧用例的判据是 `expect(followup).toHaveBeenCalledOnce()`，
      // 换载体时被降成了"等到 ≥1 条"，于是**重复接单**（同一轮把问题投给 Agent 两次）这类回归
      // 不再变红。等到第 `since + 1` 轮就等于断言到此刻**恰好** `since + 1` 条。
      expect(followupCalls, `第 ${since + 1} 轮接单必须恰好一次`).toHaveLength(since + 1)
      const last = followupCalls.at(-1)
      if (last === undefined) throw new Error('接单记录为空')
      return last.id
    },
    async settle(conversationId) {
      await until(() => !lifecycle.isBusy(conversationId), `会话 ${conversationId} 回到空闲`)
    },
    emit,
    stream: (frame, conversationId) => {
      dispatch('agent/assistant-stream', { agent: sessionOf(conversationId).agent, frame })
    },
    toolResult: (resultText, meta, conversationId) => {
      emit('tool/result', {
        turn: 1,
        step: 1,
        // 宿主 0.1.7（Messages-only）后的形状：toolCallId 在 message 顶层、content 是块数组。
        message: { toolCallId: 'fixture-call', content: resultText === '' ? [] : [{ type: 'text', text: resultText }] },
        ...(meta === undefined ? {} : { meta }),
      }, conversationId)
    },
    complete: (conversationId, text, reason = 'completed') => {
      emit('turn/start', { turn: 1 }, conversationId)
      emit('assistant/message', { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text }] } }, conversationId)
      emit('turn/end', { turn: 1, reason: { kind: reason } }, conversationId)
    },
    followups: () => followupCalls,
    cancels: () => cancelCalls,
    listeners: () => (byEvent.get('session/event') ?? new Set()).size,
    mark: () => (byEvent.get('session/event') ?? new Set()).size,
    holdFollowup() {
      if (!holding) {
        holding = true
        const original = lifecycle.followup.bind(lifecycle)
        lifecycle.followup = async (conversation: Conversation, text: string, value: Actor): Promise<void> => {
          let resolve!: () => void
          let reject!: (error: unknown) => void
          const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
          holds.push({ resolve, reject })
          await promise
          return original(conversation, text, value)
        }
      }
      return {
        get calls() { return holds.length },
        take(index) { return holds[index ?? holds.length - 1] },
      }
    },
    holdIdle(conversationId) {
      const conversation = sessionOf(conversationId)
      const original = conversation.agent.whenIdle
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      const idle = vi.fn(() => pending)
      conversation.agent.whenIdle = idle
      return { idle, release: () => { conversation.agent.whenIdle = original; release() } }
    },
    revoke: () => { revoked = true },
    dispose: async () => {
      // 先跑清理器（插件卸载把在飞的一轮拒绝成"插件已停止"），**再**等在飞的收敛。
      // 反过来的话会自锁：在飞的那一轮要等 `close()` 才能结束，而 `close()` 正是清理器。
      for (const close of disposers) await close()
      disposers.splice(0)
      await Promise.allSettled([...inFlight])
      await lifecycle.dispose()
    },
  }
  /**
   * 替身的生命周期只跟**它自己那条用例**绑定，而且先等自己这一轮收敛再释放。
   * 不共享模块级数组的理由见 `runtime-minimal-agent.test.ts` 的同一段注释（一条用例的收尾
   * 会释放另一条还在跑的替身，症状是 503 随机落在别的用例上）。
   */
  onTestFinished(async () => { await harness.dispose() })
  return harness
}

/** 从投给 Agent 的用户消息里取正文。 */
function userText(message: unknown): string {
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => typeof block === 'object' && block !== null
    && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
    ? [block.text] : []).join('')
}

const statusOf = (progress: readonly ParticipantProgress[]): readonly ParticipantProgress[] =>
  progress.filter(value => value.kind === 'status')
const deltasOf = (progress: readonly ParticipantProgress[]): readonly ParticipantProgress[] =>
  progress.filter(value => value.kind === 'delta')
const thinkingsOf = (progress: readonly ParticipantProgress[]): readonly ParticipantProgress[] =>
  progress.filter(value => value.kind === 'thinking')

/**
 * closedoff 那套结果投影（旧实现里 `run` 的最后一段）。
 *
 * 它在**契约上**就是"把这一轮的正文按业务口径脱敏后交回"，所以正文相关的用例都用它：
 * 运行时的缺省兜底投影（`fallbackProjection`）只取最终消息的原文，不会替业务脱敏。
 */
function closedoffProjection(redact: (text: string) => string) {
  return async (context: ResultContext): Promise<ProjectedResult> => {
    const text = context.history.finalText
    return text.trim() === ''
      ? { status: 'failed', text: '封闭化智能体未能完成本回合，请查看原会话。' }
      : { status: 'completed', text: redact(text) }
  }
}

describe('封闭化协作适配（运行时载体）', () => {
  it('目录等待中的拒绝、取消、撤权和卸载不会留下未启动的协作', async () => {
    for (const action of ['reject', 'cancel', 'revoke', 'close']) {
      const f = fixture({ authRecheckMs: 25 })
      const hold = f.holdFollowup()
      const call = f.call({ requestId: `request-${action}` })
      const controller = new AbortController()
      const pending = f.run({ ...call.request, signal: controller.signal })
      const rejected = expect(pending).rejects.toBeDefined()
      await vi.waitFor(() => expect(hold.calls).toBe(1))
      // 接单已上报、回合已占用，但接续还挂在目录上（还没有把问题投给 Agent）。
      expect(statusOf(call.progress)).toHaveLength(1)
      expect(f.followups()).toHaveLength(0)
      const id = f.port.ids()[0]!

      if (action === 'reject') {
        // 目录回来时这一轮被拒（模型已从目录移除）。
        hold.take()!.reject(new AccessError(400, '模型已从目录移除'))
      } else if (action === 'cancel') controller.abort()
      else if (action === 'close') { void f.dispose(); await new Promise(resolve => setTimeout(resolve, 20)); hold.take()!.resolve() }
      else { f.revoke(); await new Promise(resolve => setTimeout(resolve, 120)); hold.take()!.reject(new AccessError(401, '已退出登录')) }

      await rejected
      // 没有留下未启动的协作：问题没投出去、占用放掉（这一轮不该继续占着）。
      // ⚠️ `cancels` 不能当"没派发"的判据：接单之后收尾统一走 `lifecycle.abort`，而它**无条件**
      // 取消 Agent 的运行（`conversation.ts:594`）；旧实现只在"已受理"时才中止，这里放宽了。
      expect(f.followups()).toHaveLength(0)
      expect(f.lifecycle.isBusy(id)).toBe(false)
    }
  })

  it('取消尚未启动的回合后，旧目录失败不能取消或释放下一轮', async () => {
    const f = fixture()
    const hold = f.holdFollowup()
    const controller = new AbortController()
    const old = f.run(f.call({ signal: controller.signal }).request)
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(hold.calls).toBe(1))
    controller.abort()
    await rejected

    // 下一轮：同一个会话、新的 signal。
    const id = f.port.ids()[0]!
    const next = f.run(f.call({ requestId: 'request-2', conversationId: id }).request)
    await vi.waitFor(() => expect(hold.calls).toBe(2))
    hold.take()!.resolve()
    await vi.waitFor(() => expect(f.followups()).toHaveLength(1))
    // 这一轮自己的订阅已经挂上了。
    const withTurnListener = f.listeners()
    expect(withTurnListener).toBe(f.baseline + 1)

    // 旧目录的失败落在新回合上：它**不能把新回合放掉**（占用必须还是满的）。
    hold.take(0)!.reject(new Error('迟到目录失败'))
    await new Promise(resolve => setImmediate(resolve))
    expect(f.lifecycle.isBusy(id)).toBe(true)
    expect(f.listeners()).toBe(withTurnListener)
    // ⚠️ 但它**会**取消新回合的 Agent：`participant.ts` 的接续失败分支无条件
    // `lifecycle.abort(conversation.id)`（`:645`），而那一条取消的是**当前**回合 —— 旧实现的
    // 判据正是"旧目录失败不能取消下一轮"（`agent.ts` 旧测试第 158–180 行）。这里如实钉住当前
    // 行为，后果另记（迟到失败会把已经跑起来的新一轮打断）。
    expect(f.cancels()).toHaveLength(1)

    f.complete(id, '新回合正常完成')
    expect(await next).toMatchObject({ status: 'completed', conversationId: id, text: '新回合正常完成' })
    await vi.waitFor(() => expect(f.listeners()).toBe(f.baseline))
  })
  it('启动前取消不创建业务会话', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    const call = f.call({ signal: controller.signal })
    await expect(f.run(call.request)).rejects.toMatchObject({ name: 'AbortError' })
    // 没有接单、没有建会话、也没有任何上报（`lifecycle.open` 从未被调用）。
    expect(f.followups()).toHaveLength(0)
    expect(call.progress).toHaveLength(0)
    expect(f.listeners()).toBe(f.baseline)
    expect(f.lifecycle.busyIds()).toEqual([])
  })

  it('归属核验后、接续前只提供一次自身会话链接，最终入口保持兼容', async () => {
    const f = fixture()
    // 把接续压在夹具里：这样能在"问题还没投给 Agent"的那一刻观察进度序列。
    const hold = f.holdFollowup()
    const call = f.call()
    const pending = f.run(call.request)
    await vi.waitFor(() => expect(hold.calls).toBe(1))
    const id = f.port.ids()[0]!
    const artifact = { kind: 'conversation', title: '查看会话', path: `${ROUTE_PREFIX}?conversationId=${id}` }
    /**
     * **顺序不变式**（旧用例的 `beforeFollowup[0] === 0`）：会话材料必须先于接续上报。
     * 反过来的话用户在还没有会话入口时先看到"已接单"，而接续一旦失败，那条材料指向的会话
     * 可能根本没跑起来。观测点就是这里：`lifecycle.followup` 已经进入（接续在飞），但
     * **一条问题都还没投给 Agent**，此刻接单那条已经带着材料在进度里了。
     */
    expect(f.followups()).toHaveLength(0)
    expect(statusOf(call.progress)[0]).toEqual({ kind: 'status', text: '已接单。', conversationId: id, conversationArtifact: artifact })
    hold.take()!.resolve()
    await vi.waitFor(() => expect(f.followups()).toHaveLength(1))

    f.emit('tool/call', { name: 'closedoff_query' }, id)
    f.toolResult('', {}, id)
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '查询结果' }] } }, id)
    f.complete(id, '查询结果')
    const result = await pending

    // 会话材料**只上报一次**（旧用例的 `filter(value => value.conversationArtifact)).toHaveLength(1)`）：
    // 每一条增量都带一次入口的话，页面上会反复登记同一个会话。
    expect(call.progress.filter(value => value.conversationArtifact !== undefined)).toHaveLength(1)
    expect(deltasOf(call.progress).every(value => value.conversationId === undefined)).toBe(true)
    expect(result).toMatchObject({ status: 'completed', conversationId: id, text: '查询结果', artifacts: [artifact] })
  })

  it('接单上报的会话材料与交付材料的标题一致（真声明：同一会话不能有两个标签）', async () => {
    // 接单那一条的文案由**运行时**给（`participant.ts` 的 `conversationArtifact`），交付材料由业务的
    // `projectResult` 给。两边各写一份，同一张卡片上就会出现两个指向同一个会话、文案却不同的链接
    // （旧实现只有业务那一份，所以不会分叉）。这里用**真** `createClosedoffDefinition` 端到端钉住
    // 「两个标题逐字相等」——只用替身声明的话这条永远测不出来（替身声明里根本没有这份业务文案）。
    const f = fixture({
      definition: createClosedoffDefinition({
        gateway: {} as unknown as ClosedoffGateway,
        config: ConfigSchema({} as Config),
        persona: PERSONA,
        authorize: () => {},
        category: 'agents',
      }),
    })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '今天共有 12 辆车入园。' }] } }, id)
    f.complete(id, '今天共有 12 辆车入园。')
    const result = await pending

    const accepted = statusOf(call.progress)[0]?.conversationArtifact
    expect(accepted).toEqual({ kind: 'conversation', title: '查看会话', path: `${ROUTE_PREFIX}?conversationId=${id}` })
    expect(result.status).toBe('completed')
    // 交付材料与接单那一条是**同一条**材料：形状相同 ⇒ 标题相同。
    expect(result.artifacts).toEqual([accepted])
  })

  it('把本会话的正文增量在回合结束前上报，忽略别的会话与迟到帧', async () => {
    const f = fixture()
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }, id)
    f.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 120, chunk: { type: 'text-delta', index: 0, text: '今天共有 ' } }, id)
    // 增量边收边上：等到回合结束才报就没有过渡可看。
    expect(deltasOf(call.progress).map(value => value.delta).join('')).toBe('今天共有 ')
    f.stream({ type: 'chunk', attemptId: 'a', revision: 3, index: 1, time: 130, chunk: { type: 'text-delta', index: 0, text: '12 辆车入园。' } }, id)
    expect(deltasOf(call.progress).map(value => value.delta).join('')).toBe('今天共有 12 辆车入园。')
    // 别的会话的帧不能混进这条协作。
    f.stream({ type: 'start', attemptId: 'b', revision: 1, turn: 1, step: 1 }, 'another-session')
    f.stream({ type: 'chunk', attemptId: 'b', revision: 2, index: 0, time: 140, chunk: { type: 'text-delta', index: 0, text: '另一个会话的秘密' } }, 'another-session')
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '今天共有 12 辆车入园。' }] } }, id)
    f.complete(id, '今天共有 12 辆车入园。')
    expect(await pending).toMatchObject({ status: 'completed', conversationId: id, text: '今天共有 12 辆车入园。' })

    // 增量只带正文：会话入口已经由接单那一条交回，不必每条增量重复登记。
    expect(deltasOf(call.progress).every(value => value.conversationId === undefined)).toBe(true)
    // 回合结束后同一会话再开一轮也不该续发到已经交付的协作上（订阅已撤）。
    const count = deltasOf(call.progress).length
    f.stream({ type: 'start', attemptId: 'c', revision: 1, turn: 2, step: 1 }, id)
    f.stream({ type: 'chunk', attemptId: 'c', revision: 2, index: 0, time: 150, chunk: { type: 'text-delta', index: 0, text: '迟到增量。' } }, id)
    expect(deltasOf(call.progress)).toHaveLength(count)
    expect(JSON.stringify(call.progress)).not.toMatch(/另一个会话的秘密|迟到增量/)
  })

  it('增量与最终正文同样脱敏，敏感值被切开也不分片外泄', async () => {
    const f = fixture({ redact: redactVisibleText, projectResult: closedoffProjection(redactVisibleText) })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    const text = '联系 1 38 0013 8000，查看 https://private.invalid/stream 的记录。'
    f.emit('turn/start', { turn: 1 }, id)
    f.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }, id)
    for (const [index, piece] of ['联系 1', '38 0013 ', '8000，查看 https://priv', 'ate.invalid/stream 的记录。'].entries()) {
      f.stream({ type: 'chunk', attemptId: 'a', revision: index + 2, index, time: 120 + index, chunk: { type: 'text-delta', index: 0, text: piece } }, id)
    }
    f.emit('assistant/message', { message: { content: [{ type: 'text', text }] } }, id)
    f.complete(id, text)
    const result = await pending
    const published = deltasOf(call.progress).map(value => value.delta).join('')
    expect(result).toMatchObject({ status: 'completed', text: redactVisibleText(text) })
    expect(published).toBe(redactVisibleText(text))
    expect(published).not.toMatch(/private\.invalid|1 38|38 0013|0013 8000/)
  })

  it('带上令牌的相对地址被切开时也不先发出去，后面还继续出字', async () => {
    const f = fixture({ redact: redactVisibleText, projectResult: closedoffProjection(redactVisibleText) })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    const text = '详情见 /api/data?foo=bar&token=abc123，其余正常。'
    f.emit('turn/start', { turn: 1 }, id)
    f.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }, id)
    // 分片停在令牌键写全之前：这一段还不匹配脱敏规则，只能先压住不发。
    f.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 120, chunk: { type: 'text-delta', index: 0, text: '详情见 /api/data?foo=bar&tok' } }, id)
    expect(deltasOf(call.progress).map(value => value.delta).join('')).toBe('详情见 ')
    f.stream({ type: 'chunk', attemptId: 'a', revision: 3, index: 1, time: 130, chunk: { type: 'text-delta', index: 0, text: 'en=abc123，其余正常。' } }, id)
    f.emit('assistant/message', { message: { content: [{ type: 'text', text }] } }, id)
    f.complete(id, text)
    const result = await pending
    const published = deltasOf(call.progress).map(value => value.delta).join('')
    // 压住的那段在地址被整体脱敏后照常补上：既不外泄，也不停在半句话。
    expect(result).toMatchObject({ status: 'completed', text: redactVisibleText(text) })
    expect(published).toBe(redactVisibleText(text))
    expect(published).not.toMatch(/token=|abc123|api\/data/)
  })

  it('推理整理成稳定语句快照：压住没写完的尾巴，且不混进正文增量', async () => {
    const f = fixture({
      // 业务口径：没写完的尾巴压住，替换成"正在生成…"；收尾时放开。
      projectReasoningHook: (raw, context) => projectReasoning(raw, context.releaseTail, context.opaqueValues),
    })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }, id)
    f.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 120, chunk: { type: 'reasoning-delta', index: 0, text: '先看今天的通行记录。还没写完的一段' } }, id)
    // 快照边收边上，但只到句末为止；没写完的那段不发布，替换成「正在生成…」。
    await vi.waitFor(() => expect(thinkingsOf(call.progress).length).toBeGreaterThan(0))
    expect(thinkingsOf(call.progress).at(-1)?.thinking).toBe('先看今天的通行记录。\n正在生成…')
    f.stream({ type: 'chunk', attemptId: 'a', revision: 3, index: 1, time: 130, chunk: { type: 'text-delta', index: 0, text: '今天共有 12 辆车入园。' } }, id)
    f.emit('assistant/message', { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: '先看今天的通行记录。' },
      { type: 'text', text: '今天共有 12 辆车入园。' },
    ] } }, id)
    f.complete(id, '今天共有 12 辆车入园。')
    expect(await pending).toMatchObject({ status: 'completed', text: '今天共有 12 辆车入园。' })
    // 覆盖语义：最后一份是完整快照（尾巴也放开），不是把片段拼起来。
    expect(thinkingsOf(call.progress).at(-1)?.thinking).toBe('先看今天的通行记录。还没写完的一段')
    // 推理只走思考通道：正文增量里不能混进去。
    expect(deltasOf(call.progress).map(value => value.delta).join('')).toBe('今天共有 12 辆车入园。')
    expect(JSON.stringify(deltasOf(call.progress))).not.toContain('先看今天')
  })

  it('被废弃尝试的推理不留在思考快照里', async () => {
    const f = fixture({
      projectReasoningHook: (raw, context) => projectReasoning(raw, context.releaseTail, context.opaqueValues),
    })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }, id)
    f.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 120, chunk: { type: 'reasoning-delta', index: 0, text: '这一版思路要作废。' } }, id)
    await vi.waitFor(() => expect(thinkingsOf(call.progress).at(-1)?.thinking).toContain('这一版思路要作废。'))
    const published = thinkingsOf(call.progress).length
    // 提供方中断：这一轮尝试被废弃，它的推理也不再算数。
    f.emit('assistant/attempt', { turn: 1, step: 1, stream: [
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['废弃尝试'] },
    ] }, id)
    f.stream({ type: 'start', attemptId: 'b', revision: 3, turn: 1, step: 2 }, id)
    f.stream({ type: 'chunk', attemptId: 'b', revision: 4, index: 0, time: 140, chunk: { type: 'reasoning-delta', index: 0, text: '换成先查通行记录。' } }, id)
    f.emit('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: '已核对。' }] } }, id)
    f.complete(id, '已核对。')
    expect(await pending).toMatchObject({ status: 'completed' })
    expect(thinkingsOf(call.progress).at(-1)?.thinking).toBe('换成先查通行记录。')
    // 已经发出去的那一份收不回来；要保证的是废弃之后不再把它算进快照。
    expect(thinkingsOf(call.progress).slice(published).every(value => !value.thinking?.includes('这一版思路要作废'))).toBe(true)
  })

  it('工具结果里的业务主键不进思考快照', async () => {
    const f = fixture({
      projectReasoningHook: (raw, context) => projectReasoning(raw, context.releaseTail, context.opaqueValues),
      opaqueFromToolResult: (resultText, meta) => collectOpaqueResultValues(resultText, meta),
    })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }, id)
    f.toolResult(JSON.stringify({ data: { reservationId: INTERNAL } }), {}, id)
    f.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 120, chunk: { type: 'reasoning-delta', index: 0, text: `这条预约 ${INTERNAL} 是重点。` } }, id)
    f.emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已核对。' }] } }, id)
    f.complete(id, '已核对。')
    expect(await pending).toMatchObject({ status: 'completed' })
    const published = thinkingsOf(call.progress).map(value => value.thinking ?? '').join('\n')
    expect(published).toContain('[内部标识已隐藏]')
    expect(published).not.toContain(INTERNAL)
    expect(JSON.stringify(call.progress)).not.toContain(INTERNAL)
  })

  it('没有边界字符的内容压到边界或回合结束才发布，不发可能被改写的片段', async () => {
    const f = fixture({ redact: redactVisibleText, projectResult: closedoffProjection(redactVisibleText) })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.stream({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }, id)
    f.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 120, chunk: { type: 'text-delta', index: 0, text: '{"data":{"total":12' } }, id)
    // 这一段里没有任何边界字符：先发出去就可能被后续增量改写成别的脱敏结果，所以压住不发。
    expect(deltasOf(call.progress)).toEqual([])
    f.stream({ type: 'chunk', attemptId: 'a', revision: 3, index: 1, time: 130, chunk: { type: 'text-delta', index: 0, text: '}}' } }, id)
    f.emit('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '{"data":{"total":12}}' }] } }, id)
    f.complete(id, '{"data":{"total":12}}')
    expect(await pending).toMatchObject({ status: 'completed', text: '{"data":{"total":12}}' })
    expect(deltasOf(call.progress).map(value => value.delta).join('')).toBe('{"data":{"total":12}}')
  })

  it('会话打开期间取消、撤权或卸载后，迟到会话不发链接或接续', async () => {
    // 取消：signal 在 open 之前就被检查。
    const cancelled = fixture()
    const controller = new AbortController()
    const call = cancelled.call({ signal: controller.signal })
    controller.abort()
    await expect(cancelled.run(call.request)).rejects.toMatchObject({ name: 'AbortError' })
    expect(statusOf(call.progress)).toEqual([])
    expect(cancelled.followups()).toHaveLength(0)
    expect(cancelled.listeners()).toBe(cancelled.baseline)

    // 撤权发生在 open 与接续之间：`followup` 被拦住，此时撤权，接续必须被拒绝。
    const revoked = fixture()
    const hold = revoked.holdFollowup()
    const pendingCall = revoked.call()
    const pending = revoked.run(pendingCall.request)
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 })
    await vi.waitFor(() => expect(hold.calls).toBe(1))
    revoked.revoke()
    hold.take()!.reject(new AccessError(403, '无权访问'))
    await rejected
    expect(revoked.followups()).toHaveLength(0)
    // 收尾是异步的：等它退订完再断言（`run` 的 Promise 已经 reject，但清理在同一串微任务里）。
    await vi.waitFor(() => expect(revoked.listeners()).toBe(revoked.baseline))

    // 卸载发生在同一窗口：协作按"插件已停止"收尾，不留下未启动的回合。
    const closed = fixture()
    const closeHold = closed.holdFollowup()
    const closeCall = closed.call()
    const closing = closed.run(closeCall.request)
    const closeRejected = expect(closing).rejects.toMatchObject({ status: 503 })
    await vi.waitFor(() => expect(closeHold.calls).toBe(1))
    await closed.dispose()
    await closeRejected
    // 释放之后连生命周期的标题订阅也一起退掉：比基线再少一条。
    await vi.waitFor(() => expect(closed.listeners()).toBe(closed.baseline - 1))
  })

  it('复用指定会话与原 Actor，仅返回完整脱敏正文和原生入口', async () => {
    const f = fixture({ redact: redactVisibleText, projectResult: closedoffProjection(redactVisibleText) })
    const message = '查询通行记录'
    // 请求里带 conversationId：参与者应沿**这一条**会话续接，不新建。
    const opened = (await f.lifecycle.open(undefined, true, actor))!
    const call = f.call({ conversationId: opened.id, message })
    const pending = f.run(call.request)
    await vi.waitFor(() => expect(f.followups()).toHaveLength(1))

    // 复用同一个会话与同一个 Actor：只投了一条消息，且投的就是这条会话。
    expect(f.followups().map(entry => entry.id)).toEqual([opened.id])
    expect(userText(f.followups()[0]?.message)).toBe(message)
    expect(statusOf(call.progress)[0]).toEqual({
      kind: 'status', text: '已接单。', conversationId: opened.id,
      conversationArtifact: { kind: 'conversation', title: '查看会话', path: `${ROUTE_PREFIX}?conversationId=${opened.id}` },
    })

    f.emit('assistant/chunk', { chunk: { type: 'reasoning-delta', text: '不得对外返回的内部推理' } }, opened.id)
    f.toolResult('', { token: '不应外传的原始字段' }, opened.id)
    f.emit('assistant/message', { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: '不得对外返回的内部推理' },
      { type: 'text', text: '查询完成，联系 13800138000，查看 https://private.invalid/stream' },
      { type: 'tool-call', name: 'internal_tool', arguments: { token: '不应外传' } },
    ] } }, opened.id)
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '另一个会话的秘密' }] } }, 'another-session')
    f.complete(opened.id, '查询完成，联系 13800138000，查看 https://private.invalid/stream')
    const result = await pending

    // 交付形状逐字对照；`selfCheck` 是 P3 新增的回报（运行时跑完 ⑦ 的汇总结论），不在这里的
    // 逐字断言里，但必须真的存在且如实标"没有自检能力"。
    const { selfCheck, ...delivered } = result
    expect(delivered).toEqual({
      status: 'completed', conversationId: opened.id,
      text: '查询完成，联系 138****8000，查看 [地址已隐藏]',
      artifacts: [{ kind: 'conversation', title: '查看会话', path: `${ROUTE_PREFIX}?conversationId=${opened.id}` }],
    })
    expect(selfCheck).toMatchObject({ status: 'absent' })
    expect(JSON.stringify(call.progress)).not.toMatch(/内部推理|原始字段|private\.invalid|另一个会话的秘密/)
    expect(f.listeners()).toBe(f.baseline)
    await f.settle(opened.id)
  })

  it('外部用户和不属于当前主人的会话在派单前被拒绝', async () => {
    const f = fixture()
    await expect(f.run(f.call({ actor: other }).request)).rejects.toMatchObject({ status: 403 })
    // 形状合法但不属于当前主人的会话 id：**同一个 404**，不泄露存在性。
    const foreign = 'closedoff-web-01234567-89ab-4cde-8fab-0123456789ab'
    await expect(f.run(f.call({ conversationId: foreign }).request)).rejects.toMatchObject({ status: 404 })
    // 不属于本 Agent 的 id 更早就被挡住（400），连归属都不必查。
    await expect(f.run(f.call({ conversationId: 'someone-else-session' }).request)).rejects.toMatchObject({ status: 400 })
    expect(f.followups()).toHaveLength(0)
    expect(f.listeners()).toBe(f.baseline)
  })

  it.each(['error', 'aborted'])('废弃 attempt 的正文在 %s 结束时不作为成果返回', async reason => {
    const f = fixture()
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    // Session V3 持久化失败尝试的 stream，但它不是 assistant/message。
    f.emit('assistant/attempt', { turn: 1, step: 1, stream: [
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['废弃尝试中的业务明细'] },
    ] }, id)
    f.complete(id, '', reason === 'aborted' ? 'aborted' : 'error')
    const result = await pending
    expect(result.status).toBe(reason === 'aborted' ? 'cancelled' : 'failed')
    expect(JSON.stringify([result, call.progress])).not.toContain('废弃尝试中的业务明细')
  })

  it('重试只返回最终提交的 message，不拼接废弃 attempt 或嵌入式 stream', async () => {
    const f = fixture()
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.emit('assistant/attempt', { turn: 1, step: 1, stream: [
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['废弃尝试'] },
    ] }, id)
    f.emit('assistant/message', { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: '内部推理' }, { type: 'text', text: '最终公开分析' },
    ] }, stream: [
      { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['最终公开分析'] },
    ] }, id)
    f.complete(id, '最终公开分析')
    expect(await pending).toMatchObject({ status: 'completed', text: '最终公开分析' })
    expect(JSON.stringify(call.progress)).not.toMatch(/废弃尝试|内部推理/)
  })

  it('宿主取消产生 interrupted message 时，即使请求 signal 未取消也不返回部分成果', async () => {
    const f = fixture()
    const controller = new AbortController()
    const call = f.call({ signal: controller.signal })
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.emit('assistant/message', { turn: 1, step: 1, interrupted: true, stream: [],
      message: { content: [{ type: 'text', text: '尚未完成的部分分析' }] },
    }, id)
    f.complete(id, '尚未完成的部分分析', 'aborted')
    expect(controller.signal.aborted).toBe(false)
    const result = await pending
    expect(result).toMatchObject({ status: 'cancelled', conversationId: id })
    expect(result.text).not.toContain('尚未完成的部分分析')
    // 中止的回合不算成果：正文与思考都不补发。
    expect(deltasOf(call.progress)).toEqual([])
  })

  it('已完成请求的迟到 abort 不会取消或释放正在运行的下一轮', async () => {
    const f = fixture()
    const first = new AbortController()
    const call = f.call({ signal: first.signal })
    const pending = f.run(call.request)
    const id = await f.accept()
    f.complete(id, '第一轮完成')
    expect(await pending).toMatchObject({ status: 'completed', text: '第一轮完成' })
    await f.settle(id)

    // 第二轮：新请求、新 signal；此时才对**第一轮**的 signal 调 abort。
    const next = f.run(f.call({ requestId: 'request-2', conversationId: id }).request)
    await vi.waitFor(() => expect(f.followups()).toHaveLength(2))
    first.abort()
    expect(f.cancels()).toHaveLength(0)
    expect(f.lifecycle.isBusy(id)).toBe(true)
    f.complete(id, '第二轮继续完成')
    expect(await next).toMatchObject({ status: 'completed', text: '第二轮继续完成' })
  })

  it('停止后阻止输出，收到 turn/end 前仍拒绝新回合', async () => {
    const f = fixture()
    const controller = new AbortController()
    const call = f.call({ signal: controller.signal })
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    controller.abort()
    // 中止落在 Agent 上，占用保留到 turn/end。
    expect(f.cancels()).toEqual([{ id, cause: { kind: 'user' } }])
    expect(f.lifecycle.isBusy(id)).toBe(true)
    const count = call.progress.length
    f.toolResult('', {}, id)
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '迟到成果' }] } }, id)
    expect(call.progress).toHaveLength(count)
    await expect(f.run(f.call({ requestId: 'request-2', conversationId: id }).request)).rejects.toMatchObject({ status: 409 })
    f.complete(id, '', 'aborted')
    const result = await pending
    expect(result).toMatchObject({ status: 'cancelled', conversationId: id })
    // 文案**精确**断言（`packages/runtime/src/participant.ts:448` 的 `'协作已取消。'`）。
    // 这一条曾经被降成 `not.toContain('迟到成果')`：那样"正文换成别的错文案"与"正文成了空串"
    // 都不会红。精确值顺带覆盖了那条否定式——它当然不等于迟到的那条成果。
    expect(result.text).toBe('协作已取消。')
    await f.settle(id)
  })

  it('接单回调中取消，不向 Agent 添加问题', async () => {
    const f = fixture()
    const controller = new AbortController()
    const call = f.call({ signal: controller.signal, onProgress: () => { controller.abort() } })
    await expect(f.run(call.request)).rejects.toMatchObject({ name: 'AbortError' })
    // 取消发生在接单回调里：问题还没有投给 Agent，订阅也退干净了。
    expect(f.followups()).toHaveLength(0)
    expect(f.listeners()).toBe(f.baseline)
  })

  it('运行中撤销授权会取消 Agent，并拒绝最终成果', async () => {
    const f = fixture({ authRecheckMs: 25 })
    const call = f.call()
    const pending = f.run(call.request)
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 })
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.revoke()
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '撤销授权后的资料' }] } }, id)
    await vi.waitFor(() => expect(f.cancels()).toHaveLength(1))
    expect(f.cancels()).toEqual([{ id, cause: { kind: 'user' } }])
    await rejected
    // 撤销之后只有接单那一条上报；成果被拒绝，订阅退干净。
    expect(statusOf(call.progress)).toHaveLength(1)
    expect(f.listeners()).toBe(f.baseline)
    expect(JSON.stringify(call.progress)).not.toContain('撤销授权后的资料')
  })

  it('超时立即失败并释放运行身份，且发出取消请求', async () => {
    // 真实计时器 + 很短的预算。**这一条钉的是运行时的现状，不是旧实现的语义**：旧实现在超时后
    // 仍然占着运行身份，一直保留到 `turn/end`（旧用例标题正是「超时发出取消请求，但不提前释放
    // 运行身份」，断言的是 `conversation.active === true`）。新载体在收尾循环还没起来时**直接**
    // `fail(new Error('协作超时'))`（`packages/runtime/src/participant.ts:670`），收尾随即放掉
    // 运行身份 ⇒ 标题与断言都改写成事实（原标题与正文曾经互相矛盾：标题说"不释放"、正文断"已释放"）。
    // 后果另记（本文件不修，属于运行时的语义取舍）：超时之后同一会话可以**立刻**续发，而宿主的
    // 上一轮 driver 可能还没退干净——旧实现靠"保留到 turn/end"挡住的正是这个窗口。
    const f = fixture({ turnTimeoutMs: 150 })
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    await expect(pending).rejects.toThrow('超时')
    expect(f.cancels()).toEqual([{ id, cause: { kind: 'user' } }])
    expect(f.lifecycle.isBusy(id)).toBe(false)
    f.complete(id, '', 'aborted')
    await f.settle(id)
  })

  it('turn/end 后继续持有回合，直到宿主 driver 空闲才允许立即续发', async () => {
    const f = fixture()
    const call = f.call()
    const pending = f.run(call.request)
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '第一轮完成' }] } }, id)
    f.complete(id, '第一轮完成')
    const result = await pending
    expect(result).toMatchObject({ status: 'completed', text: '第一轮完成' })
    // 交付之后没有遗留订阅：再开一轮也不会把增量发到已经交付的协作上。
    expect(f.listeners()).toBe(f.baseline)
    await f.settle(id)

    const next = f.run(f.call({ requestId: 'request-2', conversationId: id }).request)
    await vi.waitFor(() => expect(f.followups()).toHaveLength(2))
    expect(f.followups().every(entry => entry.id === id)).toBe(true)
    f.emit('turn/start', { turn: 2 }, id)
    f.complete(id, '第二轮完成')
    expect(await next).toMatchObject({ status: 'completed', text: '第二轮完成' })
    expect(f.listeners()).toBe(f.baseline)
  })

  it('卸载导致事件监听被移除时，仍取消并等待宿主退出后结束协作', async () => {
    const f = fixture()
    const call = f.call()
    const pending = f.run(call.request)
    const rejected = expect(pending).rejects.toMatchObject({ status: 503 })
    const id = await f.accept()
    f.emit('turn/start', { turn: 1 }, id)
    const hold = f.holdIdle(id)

    const closing = f.dispose()
    // 卸载先取消，并且真的去问了宿主（`whenIdle`）——不能直接放掉这一轮。
    expect(f.cancels()).toEqual([{ id, cause: { kind: 'user' } }])
    await vi.waitFor(() => expect(hold.idle).toHaveBeenCalled())
    // 卸载过程中这一轮的会话事件订阅必须退掉（收尾前先记下"有它"时的数量）。
    expect(f.listeners()).toBe(f.baseline + 1)
    hold.release()
    await closing
    await rejected
    // 释放之后连生命周期的标题订阅也一起退掉：比基线再少一条。
    await vi.waitFor(() => expect(f.listeners()).toBe(f.baseline - 1))
    // 卸载之后的派单一律拒绝。
    await expect(f.run(f.call({ requestId: 'request-2' }).request)).rejects.toMatchObject({ status: 503 })
  })
})
