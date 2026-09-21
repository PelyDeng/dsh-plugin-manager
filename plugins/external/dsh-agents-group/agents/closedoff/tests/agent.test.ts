/**
 * 会话生命周期的行为契约（P4：载体从 closedoff 自己的 `ConversationManager` 换成运行时）。
 *
 * 本文件原先测 `src/agent.ts` 的 `ConversationManager` 与 `src/conversation-store.ts` 的
 * `ConversationStore`。P4 把这两个机制删掉，改由 `packages/runtime/src/conversation.ts` 的
 * `ConversationLifecycle` 承载 —— 那是**所有 Agent 共用的那一份** —— 所以用例逐条搬到新载体上，
 * 断言强度一律不变（原来断"恰好一次"的仍然是"恰好一次"）。
 *
 * 夹具照 `tests/runtime-minimal-agent.test.ts` 的写法**移植**：假宿主只提供
 * `ctx.agents.create/resume` / `ctx.on` / `ctx.effect` / `ctx.get` 这几个面，会话事件由测试自己
 * 按需发出；会话存储用 `tests/fixtures/memory-conversation-port.ts` 的内存替身 ——
 * **不连 PG、不依赖真实模型与计时器**。替身与真实现的语义差写在那个文件头上，别拿它推断真实现
 * 的时序。
 *
 * 载体切换后**唯一**与旧用例不同的地方是进度文案与材料标题由运行时给出（"已接单。"/"查看会话"），
 * 旧实现是 closedoff 写死的（"封闭化智能体已接单。"/"查看封闭化会话"）。那是业务文案，见
 * `participant.test.ts`；本文件只断机制。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentDefinition } from '../../../packages/runtime/src/definition.ts'
import { ConversationLifecycle, installTitleSink, type RuntimeConfig } from '../../../packages/runtime/src/conversation.ts'
import { createConversationProvider } from '../../../packages/runtime/src/storage/adapter.ts'
import type { ConversationQueryShape, OwnerKey } from '../../../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from '../../../tests/fixtures/memory-conversation-port.ts'

const AGENT_ID = 'closedoff'
const PERSONA = '你是封闭化智能体：只读查询园区、通行与车辆信息。'
const DEFAULT_MODEL = { provider: 'deepseek', model: 'test' }
const alice: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-1' }
const otherLogin: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-2' }
const bob: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-1' }
const local: Actor = { namespace: 'standalone', userId: 'local' }
const unknownId = 'closedoff-web-01234567-89ab-4cde-8fab-0123456789ab'
const owner: OwnerKey = { namespace: 'user', userId: 'alice' }

/** 单条用例超时放宽：这一批不吃墙钟时间，但整套并行跑时机器可能被别的用例占满。 */
vi.setConfig({ testTimeout: 30_000 })

afterEach(() => { vi.restoreAllMocks() })

// ---------------------------------------------------------------------------
// 假宿主 + 真实运行时
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

interface PromptSection { readonly name?: string; readonly order?: number; readonly text?: string }

interface FakeSession {
  readonly id: string
  /** 持久事件日志（`agent.session.snapshotEvents()` 与 `sessionPersistence.inspect` 读它）。 */
  readonly events: SessionEvent[]
  /** agent 作用域里注册过的提示词段与工具限制（`ConversationLifecycle.setup` 的落点）。 */
  readonly prompts: PromptSection[]
  readonly restrictions: (readonly string[])[]
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

/** 一次 `create` / `resume` 收到的入参（`resume` 走 `resumeSessionId`，`create` 走 `sessionId`）。 */
interface AgentScopeCall {
  readonly via: 'create' | 'resume'
  readonly id: string
  readonly agentOptions: unknown
  readonly meta: unknown
  readonly seed: unknown
  readonly inheritedEventCount: unknown
}

interface Harness {
  readonly lifecycle: ConversationLifecycle
  readonly ctx: Context
  readonly access: Access
  /** 本次夹具建过的全部会话端口（断言"归属落到哪一侧"用）。 */
  readonly ports: readonly MemoryConversationPort[]
  /** 主端口（`open` 用的那个）。 */
  readonly port: MemoryConversationPort
  /** 每次 `agents.create` / `resume` 的入参。 */
  readonly calls: AgentScopeCall[]
  /** 投给 Agent 的用户消息。 */
  readonly followups: { readonly id: string; readonly message: unknown }[]
  /** Agent 被 `cancel` 的记录（按会话）。 */
  readonly cancels: { readonly id: string; readonly cause: unknown }[]
  /** 每个会话被 `dispose` 的次数（"恰好一次"就断它）。 */
  readonly disposals: Map<string, number>
  creates(): readonly AgentScopeCall[]
  resumes(): readonly AgentScopeCall[]
  session(id: string): FakeSession
  events(id: string): readonly SessionEvent[]
  /** 造一条会话事件并投递给 `session/event` 的订阅者。 */
  sessionEvent(type: string, data: unknown, id: string): void
  /** 把一个会话的 `whenIdle` 换成受控 promise（返回放行函数）。 */
  holdIdle(id: string): () => void
  /** 让下一次 `create` 挂起（返回放行函数）。 */
  holdCreate(): () => void
  /** 让下一次 `resume` 挂起（返回放行函数）；用来观察"在飞恢复被别的身份共享之前"的判定。 */
  holdResume(): () => void
  /** 让 `agents.resume` 抛官方的具名 not-found（模拟宿主里没有这条持久日志）。 */
  resumeMissing(): void
  /** 侧栏入口：唯一装配点是 adapter（`conversationRemover` 的进程内互斥只能有一份）。 */
  provider(): ReturnType<typeof createConversationProvider>
  /** 撤销全部登录。 */
  revoke(): void
  /** 只撤销某一个登录会话（复核"当前回合属于哪一次登录"用）。 */
  revokeSession(sessionId: string): void
  dispose(): Promise<void>
}

function definitionOf(): AgentDefinition {
  return {
    id: AGENT_ID,
    displayName: '封闭化管理助手',
    description: '只读业务查询',
    persona: PERSONA,
    tools: () => [],
    config: {} as AgentDefinition['config'],
  }
}

/** 只有一个模型的目录（用于"路由不可用"这类只换一处变量的用例）。 */
function singleModelCatalog(): { groups: unknown[]; failures: unknown[] } {
  return { groups: [{ id: 'deepseek', name: 'Only', models: [{ id: 'test', name: 'Only' }] }], failures: [] }
}

interface FixtureOptions {
  readonly maxActiveConversations?: number
  /** 宿主认可的 reasoning effort（决定创建选项里带哪一个）。 */
  readonly efforts?: readonly string[]
  readonly reasoningEffort?: string
}

function fixture(options: FixtureOptions = {}): Harness {
  const byEvent = new Map<string, Set<Listener>>()
  const disposers: (() => Promise<void> | void)[] = []
  const sessions = new Map<string, FakeSession>()
  const calls: AgentScopeCall[] = []
  const followups: { readonly id: string; readonly message: unknown }[] = []
  const cancels: { readonly id: string; readonly cause: unknown }[] = []
  const disposals = new Map<string, number>()
  const ports: MemoryConversationPort[] = []
  const archivedSessionIds: string[] = []
  const revoked = new Set<string>()
  let revokeAll = false
  let seq = 0
  let gate: Promise<void> | undefined
  let releaseGate: (() => void) | undefined
  let resumeGate: Promise<void> | undefined
  let releaseResume: (() => void) | undefined
  let resumeNotFound = false

  const sessionOf = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [], prompts: [], restrictions: [], disposed: 0 } as unknown as FakeSession
    const agent: FakeAgent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: message => {
        followups.push({ id, message })
        // 真实宿主会把这条用户消息写进日志；`historyOf` / `readConversationEvents` 读的就是它。
        session.events.push(event('user/message', message, id))
      },
      // 缺省同步空闲：`whenIdle` 的 then 在下一个微任务里跑完。
      whenIdle: async () => {},
      cancel: cause => { cancels.push({ id, cause }) },
    }
    session.agent = agent
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
  const sessionEvent = (type: string, data: unknown, id: string): void => {
    const session = sessionOf(id)
    const value = event(type, data, id)
    session.events.push(value)
    dispatch('session/event', { id }, value)
  }

  /** agent 作用域：`ConversationLifecycle.setup` 只碰这两个面。 */
  const scopeOf = (session: FakeSession): Context => ({
    systemPrompt: { section: (section: PromptSection) => { session.prompts.push(section) } },
    tools: { restrict: (input: { readonly allow: readonly string[] }) => { session.restrictions.push([...input.allow]) } },
  }) as unknown as Context

  const handleOf = (session: FakeSession): AgentHandle => ({
    agent: session.agent as unknown as Agent,
    dispose: async () => {
      session.disposed += 1
      disposals.set(session.id, (disposals.get(session.id) ?? 0) + 1)
    },
  } as unknown as AgentHandle)

  interface ScopeInput {
    readonly sessionId?: unknown
    readonly resumeSessionId?: unknown
    readonly agentOptions?: unknown
    readonly meta?: unknown
    readonly seed?: unknown
    readonly inheritedEventCount?: unknown
    readonly setup?: (agentCtx: Context, agent: Agent) => unknown
  }
  const agents = {
    create: async (input: ScopeInput) => {
      const session = sessionOf(String(input.sessionId))
      calls.push({
        via: 'create', id: session.id, agentOptions: input.agentOptions, meta: input.meta,
        seed: input.seed, inheritedEventCount: input.inheritedEventCount,
      })
      // 真实宿主在公布之前调用 setup 组装 agent 作用域（persona 段 + 工具限制）。
      await input.setup?.(scopeOf(session), session.agent as unknown as Agent)
      if (gate !== undefined) await gate
      return handleOf(session)
    },
    resume: async (input: ScopeInput) => {
      const session = sessionOf(String(input.resumeSessionId))
      calls.push({ via: 'resume', id: session.id, agentOptions: input.agentOptions, meta: undefined, seed: undefined, inheritedEventCount: undefined })
      await input.setup?.(scopeOf(session), session.agent as unknown as Agent)
      if (resumeGate !== undefined) await resumeGate
      // 会话持久化里没有这条会话时，官方实现抛这个具名错误；`ConversationLifecycle` 只认它。
      if (resumeNotFound) throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' })
      return handleOf(session)
    },
    list: () => [],
    get: () => undefined,
  }

  const selected = { ...DEFAULT_MODEL }
  const efforts = options.efforts ?? ['low', 'high']
  const catalog = async () => ({
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'test', name: 'Test' }, { id: 'second', name: 'Second' }] },
      { id: 'new-provider', name: 'New', models: [{ id: 'new-model', name: 'New' }] },
    ],
    failures: [],
  })
  const resolveModelInfo = async () => ({ reasoning: { efforts: efforts.map(id => ({ id })) } })
  const selectModel = async (input: { readonly provider: string; readonly model: string }) => {
    selected.provider = input.provider
    selected.model = input.model
    return { selected: { provider: input.provider, model: input.model } }
  }
  const persistence = { inspect: async (id: string) => ({ events: sessionOf(id).events, header: { id } }) }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ ...selected }) },
    sessionController: { modelCatalog: catalog, selectModel },
    llm: { resolveCallConfig: async (value: unknown) => value, resolveModelInfo },
    sessionPersistence: persistence,
    sessionProjections: {
      restore: (_checkpoint: unknown, events: readonly SessionEvent[]) => ({
        checkpoint: {
          modelSelection: {
            val: {
              pending: null,
              // 与旧夹具同一口径：从最后一条 `request/header` 恢复"这一会话上次用的模型"。
              lastUsed: [...events].reverse().find(value => value.type === 'request/header')?.data.header.config ?? null,
            },
          },
        },
      }),
    },
    workspaceRegistry: { archivedSessionIds, archiveSession: async (id: string) => { archivedSessionIds.push(id) } },
    agents,
  }
  const ctx = {
    // cordis 的 `effect` 立即执行一次，把返回的清理函数登记给 fiber。
    effect: (effect: () => () => Promise<void> | void) => { disposers.push(effect()) },
    on,
    get: (name: string) => services[name],
    llm: services.llm,
    agents,
    root: { emit: () => {} },
  } as unknown as Context

  const access: Access = {
    mode: 'authenticated',
    ready: () => {},
    resolve: () => alice,
    assert: value => {
      // `Actor` 是联合类型：独立身份没有 `sessionId`（它的撤销由部署方处理）。
      const sessionId = (value as { readonly sessionId?: string }).sessionId
      if (revokeAll || (sessionId !== undefined && revoked.has(sessionId))) throw new AccessError(401, '已退出登录')
      if (value !== alice && value !== otherLogin && value !== bob && value !== local) throw new AccessError(403, '无权访问')
    },
  }
  const port = new MemoryConversationPort(AGENT_ID)
  ports.push(port)
  const config: RuntimeConfig = {
    routePrefix: '/closedoff-qa',
    turnTimeoutMs: 10_000,
    authRecheckMs: 100,
    maxActiveConversations: options.maxActiveConversations ?? 2,
    reasoningEffort: options.reasoningEffort ?? 'low',
  }
  const allowedTools = () => ['closedoff_query']
  const definition = definitionOf()
  // 标题投递口是**进程级**的（`installTitleSink`），由装配侧在挂载时接上存储的 `titleSink()`。
  // 本夹具按同一口径接：投递 → 端口落库。**当前装配侧还没有这一处接线**（P4 之前的缺口），
  // 所以这一句是夹具替装配做的，不是运行时的既有行为。
  installTitleSink({
    submit: (agentId, conversationId, title, source) => {
      if (agentId !== AGENT_ID) return
      // 真实替身（`AgentDatabaseFacade.titleSink()`）自己按会话解析归属；本夹具只有 alice 一个 owner。
      // 标题可能指向别的 Agent 的会话（那条在端口里不存在）：投递口是同步的，落库失败只吞掉。
      void port.syncTitle(owner, conversationId, title, source).catch(() => {})
    },
  })
  const lifecycle = new ConversationLifecycle({ ctx, definition, access, store: port, config, allowedTools })

  return {
    lifecycle, ctx, access, ports, port, calls, followups, cancels, disposals,
    creates: () => calls.filter(value => value.via === 'create'),
    resumes: () => calls.filter(value => value.via === 'resume'),
    session: sessionOf,
    events: id => sessionOf(id).events,
    sessionEvent,
    holdIdle(id) {
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      // 只改**同一个** Agent 对象的 `whenIdle`：句柄里的 Agent 就是它，换成新对象的话观察点会脱钩。
      const agent = sessionOf(id).agent
      const idle = agent.whenIdle
      agent.whenIdle = () => pending
      return () => { agent.whenIdle = idle; release() }
    },
    holdCreate() {
      if (gate !== undefined) throw new Error('已经有挂起的 create')
      gate = new Promise<void>(resolve => { releaseGate = resolve })
      return () => {
        const release = releaseGate
        gate = undefined
        releaseGate = undefined
        release?.()
      }
    },
    holdResume() {
      if (resumeGate !== undefined) throw new Error('已经有挂起的 resume')
      resumeGate = new Promise<void>(resolve => { releaseResume = resolve })
      return () => {
        const release = releaseResume
        resumeGate = undefined
        releaseResume = undefined
        release?.()
      }
    },
    resumeMissing: () => { resumeNotFound = true },
    provider: () => createConversationProvider({
      ctx,
      port,
      access,
      // 本实例的忙判定与侧栏列表同源（`isBusy` / `busyIds` 都看活跃、正在打开、正在分支）。
      busy: id => lifecycle.isBusy(id),
      list: (actor, query, scope) => lifecycle.list(actor, query, scope),
      release: async () => {},
      stopping: () => lifecycle.stopped,
      projectHistory: events => lifecycle.previewOf(events).map(message => ({
        role: message.role, text: message.text, time: message.time,
      })),
    }),
    revoke: () => { revokeAll = true },
    revokeSession: sessionId => { revoked.add(sessionId) },
    dispose: async () => {
      await lifecycle.dispose()
      for (const close of disposers) await close()
      disposers.splice(0)
    },
  }
}

/** 侧栏列表查询的形状（端口直传，不需要 URL 解析）。 */
function query(overrides: Partial<ConversationQueryShape> = {}): ConversationQueryShape {
  return { offset: 0, limit: 30, q: '', state: '', ...overrides }
}

/** 侧栏/存储端口那一侧的两个宿主集合：内存替身场景里是空的（宿主侧由 adapter 补）。 */
const noScope = { hostBusy: [], archived: [] } as const

describe('owned business conversation lifecycle', () => {
  it('accepts a first-prompt title after the turn and protects manual names and unrelated sessions', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    await f.lifecycle.followup(conversation, '帮我查最近一辆车的轨迹', alice)
    f.lifecycle.finish(conversation.id)
    await vi.waitFor(() => expect(conversation.active).toBe(false))

    // 首条用户消息先压成自动标题（`followup` 里的 `syncTitle(..., 'automatic')`）。
    expect(f.port.rawOf(conversation.id)).toMatchObject({ title: '帮我查最近一辆车的轨迹', titleSource: 'automatic' })

    const data = { title: '车辆近期轨迹查询', messageSeqs: [0], source: { kind: 'provider', provider: 'first-prompt-llm' } }
    f.sessionEvent('session/title', data, conversation.id)
    // 标题经持久队列异步落库（`TitleSink` 的投递是同步的、落库不是），侧栏最终看到的是它。
    await vi.waitFor(() => expect(f.port.rawOf(conversation.id)).toMatchObject({ title: data.title }))
    expect((await f.lifecycle.list(alice, query(), noScope)).items[0]).toMatchObject({ title: data.title })
    expect(f.port.rawOf(conversation.id)).toMatchObject({ titleSource: 'generated' })

    // 手动改名后，迟到的官方标题不能再覆盖它（守卫在端口上：自动/生成都覆盖不了 manual）。
    await f.port.syncTitle(owner, conversation.id, '我的车辆记录', 'manual')
    f.sessionEvent('session/title', { ...data, title: '迟到的标题' }, conversation.id)
    expect(f.port.rawOf(conversation.id)).toMatchObject({ title: '我的车辆记录', titleSource: 'manual' })

    // 宿主自己发的用户改名照样生效（source.kind === 'user'）。
    f.sessionEvent('session/title', { title: '宿主再次手动更名', messageSeqs: [], source: { kind: 'user' } }, conversation.id)
    expect(f.port.rawOf(conversation.id)).toMatchObject({ title: '宿主再次手动更名', titleSource: 'manual' })

    // 别处（别的插件）的会话标题落不到这条会话上：它在本 Agent 的端口里根本不存在。
    f.sessionEvent('session/title', data, 'another-plugin-session')
    expect(f.port.rawOf('another-plugin-session')).toBeUndefined()
    expect((await f.lifecycle.list(alice, query(), noScope)).items).toHaveLength(1)
  })

  it('shares an in-flight removal between the sidebar and central conversation management', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    // 协作入口持有这一回合（`retainTurn`）：移除围栏必须看见它。
    const release = f.lifecycle.retainTurn(conversation, alice)
    await f.lifecycle.followup(conversation, '协作中', alice)
    f.lifecycle.finish(conversation.id)
    expect(f.lifecycle.isBusy(conversation.id), '被持有的回合必须算忙').toBe(true)

    const provider = f.provider()
    const blocked = await provider.remove(alice, [conversation.id])
    expect(blocked.results[0]).toMatchObject({ id: conversation.id, status: 'blocked' })
    // 被挡住时没有任何归档副作用，会话也没被标记。
    expect(f.port.record(alice, conversation.id)).toMatchObject({ removalState: '', deletedAt: null })

    release()
    await vi.waitFor(() => expect(conversation.active).toBe(false))
    const removed = await provider.remove(alice, [conversation.id])
    expect(removed.results[0]).toMatchObject({ id: conversation.id, status: 'removed' })
    expect(f.port.record(alice, conversation.id).removalState).toBe('removed')
    expect(f.port.record(alice, conversation.id).deletedAt).not.toBeNull()
    expect((await provider.list(alice, query())).items).toEqual([])
  })

  it('opens a fresh conversation inside the declared Cordis service scope', async () => {
    const { Context: Cordis } = await import('@deepseek-ai/cordis')
    const root = new Cordis()
    const create = vi.fn(async (input: { readonly sessionId: unknown }) => ({
      agent: {
        id: String(input.sessionId),
        session: { id: String(input.sessionId), snapshotEvents: () => [] },
        followup: () => {}, whenIdle: async () => {}, cancel: () => {},
      },
      dispose: async () => {},
    }))
    const services: Record<string, unknown> = {
      agents: { create, resume: async () => { throw new Error('不该走 resume') }, list: () => [], get: () => undefined },
      agentDefaultModel: { currentSelection: () => ({ ...DEFAULT_MODEL }) },
      sessionController: { modelCatalog: async () => ({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'test', name: '测试模型' }] }], failures: [] }) },
      llm: { resolveCallConfig: async (value: unknown) => value, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }) },
      sessionPersistence: { inspect: async (id: string) => ({ events: [], header: { id } }) },
      sessionProjections: { restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: null } } } }) },
    }
    // 与真实装配一致：服务由**外层**（宿主或群组插件）提供。
    const provider = root.plugin(ctx => {
      for (const [key, value] of Object.entries(services)) ctx.provide(key, value as never)
    })
    await provider.await()

    let lifecycle!: ConversationLifecycle
    // ctx.plugin() 返回的是 Fiber（它只是 PromiseLike，没有 Plugin 上的静态面）：wait 与 dispose 都在 Fiber 上。
    const plugin = root.plugin({
      inject: ['agents', 'agentDefaultModel', 'sessionController', 'llm', 'sessionPersistence', 'sessionProjections'],
      apply(ctx: Context) {
        const access: Access = { mode: 'authenticated', ready() {}, resolve: () => alice, assert() {} }
        lifecycle = new ConversationLifecycle({
          ctx,
          definition: definitionOf(),
          access,
          store: new MemoryConversationPort(AGENT_ID),
          config: { routePrefix: '/closedoff-qa', turnTimeoutMs: 10_000, authRecheckMs: 100, maxActiveConversations: 2, reasoningEffort: 'low' },
          allowedTools: () => [],
        })
      },
    })
    await plugin.await()
    try {
      const conversation = await lifecycle.open(undefined, true, alice)
      expect(conversation?.id).toMatch(/^closedoff-web-/)
      expect(create).toHaveBeenCalledOnce()
    } finally {
      await lifecycle.dispose()
      await plugin.dispose()
      await provider.dispose()
    }
  })

  it('rejects defaults and historical models outside the Auth catalog before create or resume', async () => {
    const f = fixture()
    // 默认模型不在目录里：`requestedConversationModel` 在预留段就拒绝，不建 Agent。
    const defaults = f.ctx.get('agentDefaultModel') as { currentSelection: () => unknown }
    vi.spyOn(defaults, 'currentSelection').mockReturnValue({ provider: 'missing', model: 'missing' })
    await expect(f.lifecycle.open(undefined, true, alice)).rejects.toThrow('目录')
    expect(f.creates()).toHaveLength(0)
    expect(f.resumes()).toHaveLength(0)
    vi.restoreAllMocks()

    // 历史模型不在目录里：恢复路径在 resume 之前就拒绝（归属行照旧存在）。
    const controller = f.ctx.get('sessionController') as { modelCatalog: () => Promise<unknown> }
    await f.port.create(owner, unknownId, '')
    await f.port.publish(owner, unknownId)
    vi.spyOn(controller, 'modelCatalog').mockResolvedValue({ groups: [], failures: [] })
    await expect(f.lifecycle.open(unknownId, false, alice)).rejects.toThrow('目录')
    expect(f.resumes()).toHaveLength(0)
    expect(f.creates()).toHaveLength(0)
  })

  it('rechecks cached handles against the current directory and route without dispatching', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    const controller = f.ctx.get('sessionController') as { modelCatalog: () => Promise<unknown> }
    vi.spyOn(controller, 'modelCatalog').mockResolvedValue({ groups: [], failures: [] })
    // 缓存句柄仍然返回同一个对象（打开不重新建会话），但**不能**往会话里派发。
    expect(await f.lifecycle.open(conversation.id, false, alice)).toBe(conversation)
    await expect(f.lifecycle.followup(conversation, '不能派发', alice)).rejects.toThrow('目录')

    // 路由不可用：同一个拒绝，且仍然不派发。
    const llm = f.ctx.get('llm') as { resolveCallConfig: (value: unknown) => Promise<unknown> }
    vi.spyOn(controller, 'modelCatalog').mockResolvedValue(singleModelCatalog())
    vi.spyOn(llm, 'resolveCallConfig').mockRejectedValue(new Error('unavailable'))
    await expect(f.lifecycle.followup(conversation, '不能派发', alice)).rejects.toThrow('路由')
    expect(f.followups).toHaveLength(0)
    expect(conversation.active).toBe(false)
  })

  it('keeps creation effort and model before the first log without selecting or changing the default', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    // 宿主认可 'low'，所以创建选项带的是配置里的 effort（不是目录默认）。
    expect(f.creates()[0]?.agentOptions).toMatchObject({ provider: 'deepseek', model: 'test', reasoningEffort: 'low' })

    // 默认模型换成另一个：没有模型日志之前，这一会话仍按创建时的选项。
    const defaults = f.ctx.get('agentDefaultModel') as { currentSelection: () => unknown }
    vi.spyOn(defaults, 'currentSelection').mockReturnValue({ provider: 'new-provider', model: 'new-model' })
    expect((await f.lifecycle.models(alice, conversation.id)).selected)
      .toEqual({ provider: 'deepseek', model: 'test', reasoningEffort: 'low' })

    const controller = f.ctx.get('sessionController') as { selectModel: unknown }
    const selectModel = vi.fn()
    const original = controller.selectModel
    controller.selectModel = selectModel
    try {
      await f.lifecycle.followup(conversation, '沿用创建选项', alice)
    } finally { controller.selectModel = original }
    expect(selectModel).not.toHaveBeenCalled()
    expect(defaults.currentSelection()).toEqual({ provider: 'new-provider', model: 'new-model' })
  })

  it('updates the no-log fallback after an explicit model selection', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    const chosen = { provider: 'deepseek', model: 'second' }
    await f.lifecycle.selectModel(conversation, chosen, alice)
    // 显式选择同时落到宿主默认上（夹具的 `selectModel` 会改它），这一会话不再回到创建选项。
    const defaults = f.ctx.get('agentDefaultModel') as { currentSelection: () => unknown }
    vi.spyOn(defaults, 'currentSelection').mockReturnValue({ provider: 'new-provider', model: 'new-model' })
    expect((await f.lifecycle.models(alice, conversation.id)).selected).toEqual(chosen)
    await f.lifecycle.followup(conversation, '沿用显式选择', alice)
    expect(f.followups).toHaveLength(1)
  })

  it('uses the official projection once model history exists and rejects an evicted handle', async () => {
    const f = fixture({ maxActiveConversations: 1 })
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    // 有模型日志之后交给宿主投影恢复（旧实现里那条分支的等价物）。
    f.sessionEvent('request/header', { header: { config: { provider: 'deepseek', model: 'second', reasoningEffort: 'high' } } }, conversation.id)
    expect((await f.lifecycle.models(alice, conversation.id)).selected)
      .toEqual({ provider: 'deepseek', model: 'second', reasoningEffort: 'high' })

    // 开第二条把第一条挤出活跃表：旧句柄必须被拒绝，且不能再派发。
    await f.lifecycle.open(undefined, true, alice)
    await expect(f.lifecycle.followup(conversation, '过期句柄', alice)).rejects.toThrow('已关闭')
    expect(() => f.lifecycle.retainTurn(conversation, alice)).toThrow('已关闭')
    expect(f.followups).toHaveLength(0)
  })

  it('reserves before catalog await, rejects concurrent sends, and invalidates cancelled continuations precisely', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    const controller = f.ctx.get('sessionController') as { modelCatalog: () => Promise<unknown> }
    const real = controller.modelCatalog
    let release!: (value: unknown) => void
    const catalog = vi.fn(() => new Promise(resolve => { release = resolve }))
    vi.spyOn(controller, 'modelCatalog').mockImplementation(catalog as never)

    const old = f.lifecycle.followup(conversation, '旧等待', alice)
    const rejected = expect(old).rejects.toThrow('已停止')
    // 占用在"等目录"之前就置上了：否则并发请求会双双放行，同一个 Agent 收到两条问题。
    expect(conversation.active).toBe(true)
    await expect(f.lifecycle.followup(conversation, '并发请求', otherLogin)).rejects.toThrow('上一条')
    await vi.waitFor(() => expect(catalog).toHaveBeenCalled())

    f.lifecycle.cancel(conversation.id, alice)
    vi.restoreAllMocks()
    await f.lifecycle.followup(conversation, '新一轮', otherLogin)
    release(await real())
    await rejected
    // 旧等待的 catch 不能再动新回合的状态（否则新一轮会被提前放掉）。
    expect(f.followups).toHaveLength(1)
    expect(conversation.active, '旧等待的catch不能清除新回合').toBe(true)
    expect(() => f.lifecycle.authorizeAgent(conversation.handle.agent)).not.toThrow()
  })

  it('rechecks the original login and disposed manager after catalog await', async () => {
    for (const action of ['revoke', 'dispose']) {
      const f = fixture()
      const conversation = (await f.lifecycle.open(undefined, true, alice))!
      const controller = f.ctx.get('sessionController') as { modelCatalog: () => Promise<unknown> }
      const real = controller.modelCatalog
      let release!: (value: unknown) => void
      const catalog = vi.fn(() => new Promise(resolve => { release = resolve }))
      vi.spyOn(controller, 'modelCatalog').mockImplementation(catalog as never)
      const pending = f.lifecycle.followup(conversation, '迟到目录', alice)
      // 停止之后旧回合的归属仍然由实例自己回答，所以报的是"插件正在停止"（503）而不是 409。
      const rejected = expect(pending).rejects.toThrow(action === 'revoke' ? '退出登录' : /已停止|插件正在停止/u)
      await vi.waitFor(() => expect(catalog).toHaveBeenCalled())
      if (action === 'revoke') { f.revoke(); f.lifecycle.revokeInvalid() }
      else await f.dispose()
      release(await real())
      await rejected
      expect(f.followups).toHaveLength(0)
    }
  })

  it('waits for the new driver after synchronous turn/end instead of consuming an earlier idle promise', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    const release = f.holdIdle(conversation.id)
    const agent = f.session(conversation.id).agent
    const originalFollowup = agent.followup
    const cancel = vi.spyOn(agent, 'cancel')
    const followup = vi.spyOn(agent, 'followup')
    followup.mockImplementationOnce(message => {
      // 真正派发中的同步取消必须等 driver 空闲：保留占用，不能提前放掉。
      f.lifecycle.cancel(conversation.id, alice)
      expect(conversation.active, '真正派发中的同步取消必须等driver空闲').toBe(true)
      // 取消已经落在 driver 上（这是唯一一次），但 `finish` **不能**在这里再去取空闲承诺。
      expect(cancel).toHaveBeenCalledTimes(1)
      f.lifecycle.finish(conversation.id)
      expect(cancel, 'finish不能提前取driver的空闲承诺').toHaveBeenCalledTimes(1)
      // 宿主该做的写入照旧（`followup` 只被观察，行为不变）。
      originalFollowup(message)
    })
    await f.lifecycle.followup(conversation, '同步结束事件', alice)
    expect(cancel).toHaveBeenCalledTimes(1)
    // 回合结束但 driver 还没空闲：占用必须保留到 `whenIdle` 落地。
    expect(conversation.active).toBe(true)
    release()
    await vi.waitFor(() => expect(conversation.active).toBe(false))
  })

  it('opens a business Agent through the declared Cordis service boundary', async () => {
    const { Context: Cordis } = await import('@deepseek-ai/cordis')
    const root = new Cordis()
    const resolveModelInfo = vi.fn(async () => ({ reasoning: { efforts: [{ id: 'low' }] } }))
    const create = vi.fn(async (input: { readonly sessionId: unknown }) => ({
      agent: {
        id: String(input.sessionId),
        session: { id: String(input.sessionId), snapshotEvents: () => [] },
        followup: () => {}, whenIdle: async () => {}, cancel: () => {},
      },
      dispose: async () => {},
    }))
    const services: Record<string, unknown> = {
      agentDefaultModel: { currentSelection: () => ({ ...DEFAULT_MODEL }) },
      llm: { resolveModelInfo, resolveCallConfig: async (value: unknown) => value },
      agents: { create, resume: async () => { throw new Error('不该走 resume') }, list: () => [], get: () => undefined },
      sessionController: { modelCatalog: async () => ({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'test', name: 'Test' }] }], failures: [] }) },
      sessionPersistence: { inspect: async (id: string) => ({ events: [], header: { id } }) },
      sessionProjections: { restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: null } } } }) },
    }
    const provider = root.plugin(ctx => {
      for (const [key, value] of Object.entries(services)) ctx.provide(key, value as never)
    })
    await provider.await()
    let lifecycle!: ConversationLifecycle
    // ctx.plugin() 返回的是 Fiber（它只是 PromiseLike，没有 Plugin 上的静态面）：wait 与 dispose 都在 Fiber 上。
    const plugin = root.plugin({
      inject: ['agents', 'agentDefaultModel', 'sessionController', 'llm', 'sessionPersistence', 'sessionProjections'],
      apply(ctx: Context) {
        const access: Access = { mode: 'authenticated', ready() {}, resolve: () => alice, assert() {} }
        lifecycle = new ConversationLifecycle({
          ctx,
          definition: definitionOf(),
          access,
          store: new MemoryConversationPort(AGENT_ID),
          config: { routePrefix: '/closedoff-qa', turnTimeoutMs: 10_000, authRecheckMs: 100, maxActiveConversations: 2, reasoningEffort: 'low' },
          allowedTools: () => [],
        })
      },
    })
    await plugin.await()
    try {
      const conversation = await lifecycle.open(undefined, true, alice)
      expect(conversation?.id).toMatch(/^closedoff-web-/)
      // 模型信息是通过**注入的服务**问宿主的：没读到就不会有这次调用。
      expect(resolveModelInfo).toHaveBeenCalledWith('deepseek', 'test')
      expect(create).toHaveBeenCalledOnce()
    } finally {
      await lifecycle.dispose()
      await plugin.dispose()
      await provider.dispose()
    }
  })

  it('keeps a delegated turn busy after the HTTP turn/end listener until its owner releases it', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    const release = f.lifecycle.retainTurn(conversation, alice)
    await f.lifecycle.followup(conversation, '协作查询', alice)
    f.lifecycle.finish(conversation.id)
    // 回合结束但协作方还持有：仍然算忙，续发被拒。
    expect(conversation.active).toBe(true)
    await expect(f.lifecycle.followup(conversation, '不能提前续发', otherLogin)).rejects.toThrow('上一条')
    expect(() => f.lifecycle.retainTurn(conversation, otherLogin)).toThrow('上一条')
    release()
    await vi.waitFor(() => expect(conversation.active).toBe(false))
    // 释放之后同一会话可以续发；第二次 retain 返回的那个释放函数**不能**把新回合放掉。
    await f.lifecycle.followup(conversation, '下一轮', otherLogin)
    release()
    expect(conversation.active).toBe(true)
  })

  it('selects through the official controller only for the owner and while idle', async () => {
    const f = fixture()
    const chosen = { provider: 'deepseek', model: 'second' }
    const controller = f.ctx.get('sessionController') as { selectModel: (input: unknown) => Promise<unknown> }
    const selectModel = vi.spyOn(controller, 'selectModel')
    const conversation = (await f.lifecycle.open(undefined, true, alice))!

    await expect(f.lifecycle.selectModel(conversation, chosen, bob)).rejects.toThrow('无权')
    expect(selectModel).not.toHaveBeenCalled()
    await expect(f.lifecycle.selectModel(conversation, { provider: 'unknown', model: 'second' }, alice)).rejects.toThrow('目录')
    expect(conversation.active).toBe(false)

    await f.lifecycle.selectModel(conversation, chosen, alice)
    expect(selectModel).toHaveBeenCalledWith({ sessionId: conversation.id, ...chosen })

    const pending = f.lifecycle.followup(conversation, 'hello', alice)
    await expect(f.lifecycle.selectModel(conversation, chosen, alice)).rejects.toThrow('上一条')
    await pending
    expect(selectModel).toHaveBeenCalledTimes(1)
    await expect(f.lifecycle.models(bob, conversation.id)).rejects.toThrow('无权')
  })

  it('keeps the recorded model on cold resume and follows the changed default only for a fresh session', async () => {
    const f = fixture({ maxActiveConversations: 2 })
    const first = (await f.lifecycle.open(undefined, true, alice))!
    f.sessionEvent('request/header', { header: { config: { provider: 'deepseek', model: 'test', reasoningEffort: 'high' } } }, first.id)

    // 换成新默认：**新**会话跟随它。
    const defaults = f.ctx.get('agentDefaultModel') as { currentSelection: () => unknown }
    vi.spyOn(defaults, 'currentSelection').mockReturnValue({ provider: 'new-provider', model: 'new-model' })
    const fresh = (await f.lifecycle.open(undefined, true, alice))!
    expect(fresh.id).not.toBe(first.id)
    expect(f.creates().at(-1)?.agentOptions).toMatchObject({ provider: 'new-provider', model: 'new-model' })

    // 再开一条把最久没用过的挤出去（归属行还在），于是下面这一次是**冷恢复**：
    // 活跃表里没有它 ⇒ 走 `agents.resume`，且模型取日志里记录的那一个。
    await f.lifecycle.open(undefined, true, alice)
    expect(f.lifecycle.isBusy(first.id)).toBe(false)
    const release = f.holdResume()
    const reopened = f.lifecycle.open(first.id, false, alice)
    await vi.waitFor(() => expect(f.resumes()).toHaveLength(1))
    release()
    expect((await reopened)?.id).toBe(first.id)
    expect(f.resumes().at(-1)?.agentOptions).toMatchObject({ provider: 'deepseek', model: 'test', reasoningEffort: 'high' })
  })

  it('previews read-only, fences failed removal and retries official archival without resurrecting history', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    f.sessionEvent('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '预览问题' }] }, conversation.id)

    let closed = 0
    let fail = true
    const archived: string[] = []
    // 预览走**只读**句柄（`sessionPersistence.open(id, 'read')`）：读完必须关掉。
    const persistence = f.ctx.get('sessionPersistence') as { inspect?: unknown; open?: unknown }
    persistence.inspect = undefined
    persistence.open = async (id: string, mode: string) => {
      expect(mode).toBe('read')
      return {
        header: { id },
        read: async () => ({ events: f.events(id) }),
        close: async () => { closed += 1 },
      }
    }
    // 归档成功/失败由本用例控制；归档清单跟着同一份真值走。
    const registry = f.ctx.get('workspaceRegistry') as { archivedSessionIds: readonly string[]; archiveSession: (id: string) => Promise<void> }
    vi.spyOn(registry, 'archivedSessionIds', 'get').mockReturnValue(archived)
    vi.spyOn(registry, 'archiveSession').mockImplementation(async (id: string) => {
      if (fail) throw new Error('storage')
      archived.push(id)
    })

    const provider = f.provider()
    const before = f.port.record(alice, conversation.id)
    expect((await provider.preview(alice, conversation.id)).messages)
      .toEqual([{ role: 'user', text: '预览问题', time: expect.any(Number) }])
    // 预览只读：关掉读句柄、不动归属、不建新 Agent、也不改围栏状态。
    expect(closed).toBe(1)
    expect(f.creates()).toHaveLength(1)
    expect(f.resumes()).toHaveLength(0)
    expect(f.port.record(alice, conversation.id)).toEqual(before)
    await expect(provider.preview(bob, conversation.id)).rejects.toMatchObject({ status: 404 })

    // 归档失败 ⇒ failed，并留下围栏（重试走同一条路，不是另开一条）。
    expect((await provider.remove(alice, [conversation.id])).results[0]?.status).toBe('failed')
    await expect(f.lifecycle.open(conversation.id, true, alice)).rejects.toMatchObject({ status: 404 })
    fail = false
    expect((await provider.remove(alice, [conversation.id])).results[0]?.status).toBe('removed')
    expect((await provider.remove(alice, [conversation.id])).results[0]?.status).toBe('alreadyRemoved')
    expect(archived).toEqual([conversation.id])
    expect((await f.lifecycle.list(alice, query(), noScope)).items).toEqual([])
  })

  it('rejects foreign namespaces, unknown and unassigned ids instead of claiming them', async () => {
    const f = fixture()
    expect(() => f.lifecycle.validateId('session-other')).toThrow('not a closedoff')
    await expect(f.lifecycle.open(unknownId, true, alice)).rejects.toMatchObject({ status: 404 })
    expect(f.creates()).toHaveLength(0)
    expect(f.resumes()).toHaveLength(0)
  })

  it('creates only server ids and rejects other owners before cache access', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    expect(conversation.id).toMatch(/^closedoff-web-/)
    expect(f.resumes()).toHaveLength(0)
    expect(f.creates()).toHaveLength(1)
    await expect(f.lifecycle.open(conversation.id, false, bob)).rejects.toMatchObject({ status: 404 })
    expect(() => f.lifecycle.cancel(conversation.id, bob)).toThrow()
    expect((await f.lifecycle.list(bob, query(), noScope)).items).toEqual([])
    // 同一个人的**另一次登录**仍然看得到这条会话：归属是 namespace + userId，不是登录会话。
    expect((await f.lifecycle.list(otherLogin, query(), noScope)).items[0]?.id).toBe(conversation.id)
    await expect(f.lifecycle.open(conversation.id, false, local)).rejects.toMatchObject({ status: 404 })
  })

  it('does not recreate missing durable history even when ownership exists', async () => {
    const f = fixture()
    await f.port.create(owner, unknownId, '')
    await f.port.publish(owner, unknownId)
    // 归属行在、宿主里却没有这条会话的持久日志：恢复返回 undefined，**不**新建。
    f.resumeMissing()
    await expect(f.lifecycle.open(unknownId, false, alice)).resolves.toBeUndefined()
    expect(f.resumes()).toHaveLength(1)
    expect(f.creates()).toHaveLength(0)
  })

  it('evicts only an idle handle while retaining owner history', async () => {
    const f = fixture()
    const first = (await f.lifecycle.open(undefined, true, alice))!
    const second = (await f.lifecycle.open(undefined, true, alice))!
    first.lastUsedAt = 1
    second.lastUsedAt = 2
    await f.lifecycle.open(undefined, true, alice)
    // 只回收最久没用过的那个句柄，另一个照旧；归属历史一行都不少。
    expect(f.disposals.get(first.id)).toBe(1)
    expect(f.disposals.get(second.id)).toBeUndefined()
    expect((await f.lifecycle.list(alice, query(), noScope)).items).toHaveLength(3)
  })

  it('reserves capacity before concurrent creations complete', async () => {
    const f = fixture({ maxActiveConversations: 1 })
    const first = f.lifecycle.open(undefined, true, alice)
    // 预留是同步的：第一条还在建，第二条就已经撞上上限。
    await expect(f.lifecycle.open(undefined, true, bob)).rejects.toThrow('active conversation limit 1')
    await expect(first).resolves.toBeDefined()
  })

  it('checks ownership before sharing an in-flight resume promise', async () => {
    const f = fixture()
    await f.port.create(owner, unknownId, '')
    await f.port.publish(owner, unknownId)
    const release = f.holdResume()
    const pending = f.lifecycle.open(unknownId, false, alice)
    // 别的身份在**共享同一个在飞 promise 之前**就被挡住：不能靠 promise 的结果做鉴权。
    await expect(f.lifecycle.open(unknownId, false, bob)).rejects.toMatchObject({ status: 404 })
    await vi.waitFor(() => expect(f.resumes()).toHaveLength(1))
    release()
    await expect(pending).resolves.toBeDefined()
  })

  it('reserves capacity before restoring distinct durable Agents', async () => {
    const f = fixture({ maxActiveConversations: 1 })
    const secondId = unknownId.replace('01234567', '11234567')
    for (const id of [unknownId, secondId]) { await f.port.create(owner, id, ''); await f.port.publish(owner, id) }
    const release = f.holdResume()
    const pending = f.lifecycle.open(unknownId, false, alice)
    // 恢复路径也先占位：否则两条恢复会各自建一个 Agent，上限形同不存在。
    await expect(f.lifecycle.open(secondId, false, alice)).rejects.toThrow('active conversation limit 1')
    await vi.waitFor(() => expect(f.resumes()).toHaveLength(1))
    release()
    await expect(pending).resolves.toBeDefined()
  })

  it('does not rebind an active Agent to a different login session', async () => {
    const f = fixture()
    const conversation = (await f.lifecycle.open(undefined, true, alice))!
    await f.lifecycle.followup(conversation, 'first', alice)
    // 另一次登录打开同一条会话：缓存句柄照旧返回，但当前回合仍属于 alice-1。
    await f.lifecycle.open(conversation.id, false, otherLogin)
    await expect(f.lifecycle.followup(conversation, 'second', otherLogin)).rejects.toThrow('上一条')

    f.revokeSession(alice.sessionId)
    expect(() => f.lifecycle.authorizeAgent(conversation.handle.agent)).toThrow('已退出')
    f.lifecycle.revokeInvalid()
    expect(f.cancels.filter(value => value.id === conversation.id)).toHaveLength(1)
    // 撤销只中止在跑的回合，不改绑到另一次登录。
    f.lifecycle.finish(conversation.id)
    await vi.waitFor(() => expect(conversation.active).toBe(false))
    await f.lifecycle.followup(conversation, 'new turn', otherLogin)
    expect(() => f.lifecycle.authorizeAgent(conversation.handle.agent)).not.toThrow()
    // 没有登记过身份的 Agent 一律拒绝（不能默认可信）。
    expect(() => f.lifecycle.authorizeAgent(undefined)).toThrow('可信用户')
    expect(() => f.lifecycle.authorizeAgent({})).toThrow('可信用户')
    // 第一次登录的撤销没有波及第二次登录的回合。
    expect(f.cancels.filter(value => value.id === conversation.id)).toHaveLength(1)
  })

  it('disposes an Agent created during revocation without publishing history', async () => {
    const f = fixture()
    const release = f.holdCreate()
    const pending = f.lifecycle.open(undefined, true, alice)
    const rejected = expect(pending).rejects.toMatchObject({ status: 401 })
    await vi.waitFor(() => expect(f.creates()).toHaveLength(1))
    const created = f.creates()[0]!.id
    // 只撤这一次登录：插件与别的会话照常工作，收尾也不受它的影响。
    f.revokeSession(alice.sessionId)
    release()
    await rejected
    expect(f.disposals.get(created)).toBe(1)
    // 没有发布：预留行还在但在侧栏看不到，也不留下可见的历史。
    expect(f.port.record(alice, created).ready).toBe(false)
    // 用**没被撤销的另一次登录**看列表：这条未发布的会话不在里面。
    expect((await f.lifecycle.list(otherLogin, query(), noScope)).items).toEqual([])
  })

  it('disposes a handle created during plugin unloading', async () => {
    const f = fixture()
    const release = f.holdCreate()
    const pending = f.lifecycle.open(undefined, true, alice)
    const rejected = expect(pending).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(f.creates()).toHaveLength(1))
    const closing = f.lifecycle.dispose()
    release()
    await rejected
    await closing
    expect(f.disposals.get(f.creates()[0]!.id)).toBe(1)
  })

  it('disposes an unpublished Agent when ownership publication fails', async () => {
    const f = fixture()
    // 第一条先占用那个预留位（`publish` 只失败一次）：失败的那次是**第二条**。
    await f.lifecycle.open(undefined, true, alice)
    vi.spyOn(f.port, 'publish').mockRejectedValueOnce(new Error('disk full'))
    await expect(f.lifecycle.open(undefined, true, alice)).rejects.toThrow('disk full')
    expect(f.disposals.get(f.creates()[1]!.id)).toBe(1)
    // 没有发布：失败的那条在侧栏看不到（第一条在）。
    expect((await f.lifecycle.list(alice, query(), noScope)).items.map(item => item.id)).toEqual([f.creates()[0]!.id])
    // 失败留下的预留行不会被误用：下一次打开照常建一条新会话。
    await expect(f.lifecycle.open(undefined, true, alice)).resolves.toBeDefined()
  })

  it('branches only a completed turn and persists the source owner', async () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: '查询' }] } } },
      { type: 'turn/end', seq: 2, time: 3, data: { reason: { kind: 'completed' } } },
      { type: 'turn/end', seq: 3, time: 4, data: { reason: { kind: 'aborted' } } },
    ] as unknown as SessionEvent[]
    const f = fixture()
    const source = (await f.lifecycle.open(undefined, true, alice))!
    f.session(source.id).events.push(...events)

    // 别人的会话：先按归属拒绝，连边界都不必看。
    await expect(f.lifecycle.fork(source, events[2]!.seq as never, bob)).rejects.toMatchObject({ status: 404 })
    // 边界必须落在一个**已完成**回合上。
    await expect(f.lifecycle.fork(source, events[3]!.seq as never, alice)).rejects.toThrow('completed turn')
    const child = await f.lifecycle.fork(source, events[2]!.seq as never, alice)
    expect(child.id).not.toBe(source.id)
    expect(child.id).toMatch(/^closedoff-web-/)
    expect((await f.lifecycle.list(alice, query(), noScope)).items).toHaveLength(2)
    // 子会话的归属是发起人：别的身份看不到它。
    await expect(f.lifecycle.open(child.id, false, bob)).rejects.toMatchObject({ status: 404 })
    // 只继承那个已完成回合为止的事件（3 条）。
    expect(f.creates()[1]?.seed).toHaveLength(3)
    expect(f.creates()[1]?.inheritedEventCount).toBe(3)
    expect(f.creates()[1]?.meta).toMatchObject({ isSeeded: true, parentSession: source.id })
  })

  it('disposes an unpublished branch when ownership publication fails', async () => {
    const f = fixture()
    const source = (await f.lifecycle.open(undefined, true, alice))!
    f.session(source.id).events.push({
      type: 'turn/end', seq: 0, time: 1, data: { reason: { kind: 'completed' } },
    } as unknown as SessionEvent)
    // 源会话那条已经发布成功，所以下面这一次失败一定落在分支的发布段上。
    vi.spyOn(f.port, 'publish').mockRejectedValueOnce(new Error('disk full'))
    await expect(f.lifecycle.fork(source, 0 as never, alice)).rejects.toThrow('disk full')
    const branch = f.creates()[1]!
    // 归属行确实落过（`fork` 先预留再发布），只是没发布成功：列表里看不到它。
    expect(f.port.record(alice, branch.id).ready).toBe(false)
    expect(f.port.ids()).toContain(branch.id)
    expect((await f.lifecycle.list(alice, query(), noScope)).items.map(item => item.id)).toEqual([source.id])
    // ✅ 与 `openReserved` 一致：发布失败时**必须回收那个 Agent**。这一步曾经缺失，于是分支发布
    // 失败后那个 handle 既不进活跃表、也无人引用，**没有任何路径回收它**（进程里留下一个永不释放
    // 的 driver）。本断言原先如实钉的是"未回收"的缺陷现状，修复后改成"必须回收"——这是**收紧**，
    // 不是放宽；把 `fork` 里的 `handle.dispose()` 去掉，本行必须重新变红。
    expect(f.disposals.get(branch.id)).toBe(1)
  })
})
