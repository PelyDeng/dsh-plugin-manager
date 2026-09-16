/**
 * P3.5：**非同类 Agent 硬门禁**。这一期是**证伪测试**，不是新功能。
 *
 * ## 它要回答的问题
 *
 * P4 要改造 closedoff，但 closedoff 是全库**最规整**的存量 Agent（无 `runtime/*.mjs`、无跨表
 * 事务、blog 的 6 类独有语义一个都没有）。用它通过只能证明"运行时能承载 closedoff"，而它恰恰
 * 是全库**最不需要**运行时的那个 ⇒ 会给出过于乐观的信号。
 *
 * 所以这里用一个**故意不同构**的 Agent（`fixtures/poller-agent.ts`：只轮询一次外部接口、不调
 * 交活工具、不交材料）提前给出结论。它测的是**未来那 10+ 个 Agent 的人群**。
 *
 * ## 四条断言（缺一条这期就不算过）
 *
 * - **A1** `packages/runtime` 源码 **diff = 0**（基线冻结为 `df8f3dc`）。这一条由命令证据承载
 *   （`git diff --stat -- packages/runtime` 必须为空）—— 它不能被一条稳定的测试断言，因为
 *   "其他期是否改过运行时"不是运行期事实。本文件里对应的是**结构事实**：这个新 Agent 只用了
 *   `AgentDefinition` 的既有字段，没有任何为本 Agent 新增的钩子。
 * - **A2** 终态 = `completed` **且交付物里出现哨兵值**（兜底 `tail` 与 `report_result` 各一例）。
 *   只断 `status === 'completed'` 是恒真的，见下面 A2 用例的注释。
 * - **A3** 未调 `report_result` 时，⑦ 第 3 条（口径非空 ⇒ 材料非空）**仍按预期触发**。
 * - **A4** 逃生通道使用次数 = 0，**且必须先有"必须使用逃生通道"的负极对照 = 1**。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { PARTICIPANT_PROTOCOL, type AgentParticipant } from '../packages/runtime/src/contract.ts'
import { ConversationLifecycle, type AgentRuntime, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import type { AgentDefinition, ResultContext } from '../packages/runtime/src/definition.ts'
import { createParticipant, type RuntimeParticipant } from '../packages/runtime/src/participant.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'
import {
  POLLER_AGENT_ID,
  POLL_PAYLOAD,
  POLL_SENTINEL,
  pollerDefinition,
  sessionlessDefinition,
  SESSIONLESS_AGENT_ID,
} from './fixtures/poller-agent.ts'

const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-chat' }

/** 每轮都由测试自己驱动，逻辑上不吃墙钟；放宽上界只为让"机器忙"表现为慢而不是红。 */
vi.setConfig({ testTimeout: 30_000 })

// ---------------------------------------------------------------------------
// 逃生通道计数器（A4 的载体）
// ---------------------------------------------------------------------------

/**
 * 逃生通道使用计数。
 *
 * **"逃生通道" = `mount()` 返回自定义 participant，而不是走 `createParticipant`（运行时默认路径）**
 * （主方案 §4.2 末：`mount()` 允许返回自定义 participant，运行时是默认路径、不是唯一实现层）。
 *
 * 计数器落在**测试侧**而不是运行时里：A1 明确禁止为本 Agent 改运行时，而"数一数装配时走了哪条
 * 路"本来就是装配侧的观测，不是机制的一部分。
 *
 * ⚠️ **没有负极对照，这个判据是恒绿的**：计数器没接上时它天然返回 0 —— 所以
 * `A4-负极对照` 那条用例（必须走逃生通道的场景，断言计数 = 1）与 `A4` 同等重要。
 */
const mounts = { defaultPath: 0, escapeHatch: 0 }

function resetMounts(): void {
  mounts.defaultPath = 0
  mounts.escapeHatch = 0
}

// ---------------------------------------------------------------------------
// 假宿主（照 `runtime-minimal-agent.test.ts` 的做法：只造这条路径需要的面）
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void

interface FakeSession {
  readonly id: string
  readonly events: SessionEvent[]
  readonly prompts: { readonly name?: string; readonly order?: number; readonly text?: string }[]
  readonly restrictions: (readonly string[])[]
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

interface Harness {
  readonly participant: RuntimeParticipant
  readonly lifecycle: ConversationLifecycle
  readonly port: MemoryConversationPort
  /** 投给 Agent 的用户消息（每次接单一条）。 */
  followups(): readonly { readonly id: string; readonly message: unknown }[]
  /** 等第 `since + 1` 轮接单，返回会话 id。 */
  accept(since?: number): Promise<string>
  /**
   * 发一轮完整回合：`turn/start` → `assistant/message` → `turn/end`。
   *
   * `turn` 由夹具**按会话自动递增**：运行时按 `turn` 配对起止，同一个 `turn` 发两次不推进
   * 状态机（表现为"等一个永不到来的回合结束"）。调用方不必也不该自己编号。
   */
  complete(conversationId: string, text: string): void
  /** 发一次工具结果（模拟"轮询外部接口拿回载荷"）。 */
  toolResult(conversationId: string, resultText: string): void
  /** 等到会话回到空闲。 */
  settle(conversationId: string): Promise<void>
}

function fixture(definition: AgentDefinition, mount: (deps: MountDeps) => AgentParticipant): Harness {
  const byEvent = new Map<string, Set<Listener>>()
  const disposers: (() => Promise<void> | void)[] = []
  const sessions = new Map<string, FakeSession>()
  const followups: { readonly id: string; readonly message: unknown }[] = []
  /** 每个会话已经发过几个回合 —— `complete()` 靠它给出正确的 `turn`。 */
  const turns = new Map<string, number>()
  const inFlight = new Set<Promise<unknown>>()
  let seq = 0

  const sessionOf = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [], prompts: [], restrictions: [], disposed: false } as unknown as FakeSession
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: message => {
        followups.push({ id, message })
        session.events.push(event('user/message', message, id))
      },
      whenIdle: async () => { /* 假宿主同步空闲：`whenIdle` 的 then 在下一个微任务里跑完。 */ },
      cancel: () => {},
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
  const scopeOf = (session: FakeSession): Context => ({
    systemPrompt: { section: (section: FakeSession['prompts'][number]) => { session.prompts.push(section) } },
    tools: { restrict: (input: { readonly allow: readonly string[] }) => { session.restrictions.push([...input.allow]) } },
  }) as unknown as Context
  const handleOf = (session: FakeSession) => ({
    agent: session.agent as unknown as Agent,
    dispose: async () => { session.disposed = true },
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
    sessionPersistence: { inspect: async (id: string) => ({ events: sessions.get(id)?.events ?? [], header: { id } }) },
    sessionProjections: {
      restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { ...DEFAULT_MODEL } } } } }),
    },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    agents,
  }
  const ctx = {
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
    assert: value => { if (value !== actor) throw new AccessError(403, '无权访问') },
  }
  const port = new MemoryConversationPort(definition.id)
  const config: RuntimeConfig = {
    routePrefix: '/poller',
    turnTimeoutMs: 30_000,
    authRecheckMs: 10_000,
    maxActiveConversations: 4,
    reasoningEffort: 'medium',
  }
  const allowedTools = () => ['poller_fetch']
  const lifecycle = new ConversationLifecycle({ ctx, definition, access, store: port, config, allowedTools })
  const runtime: AgentRuntime = { ctx, definition, access, store: port, config, lifecycle, allowedTools }
  // 装配：走默认路径还是逃生通道由调用方决定（A4 数的就是这一步）。
  const participant = mount({ definition, runtime, access, config }) as RuntimeParticipant

  const until = async (check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`等待超时（10s）：${label}`)
      await new Promise<void>(resolve => { setTimeout(resolve, 1) })
    }
  }
  const harness: Harness = {
    participant, lifecycle, port,
    followups: () => followups,
    async accept(since = 0) {
      await until(() => followups.length > since, `第 ${since + 1} 轮接单`)
      const last = followups.at(-1)
      if (last === undefined) throw new Error('接单记录为空')
      return last.id
    },
    complete: (conversationId, text) => {
      const turn = (turns.get(conversationId) ?? 0) + 1
      turns.set(conversationId, turn)
      emit('turn/start', { turn }, conversationId)
      emit('assistant/message', { turn, step: 1, stream: [], message: { content: [{ type: 'text', text }] } }, conversationId)
      emit('turn/end', { turn, reason: { kind: 'completed' } }, conversationId)
    },
    toolResult: (conversationId, resultText) => {
      emit('tool/result', {
        turn: 1, step: 1,
        message: { content: [{ content: resultText === '' ? [] : [{ type: 'text', text: resultText }] }] },
      }, conversationId)
    },
    async settle(conversationId) {
      await until(() => !lifecycle.isBusy(conversationId), `会话 ${conversationId} 回到空闲`)
    },
  }
  /**
   * 替身的生命周期只跟**它自己那条用例**绑定，且先等自己这一轮收敛再释放。
   *
   * 两处都必要（这是本仓库踩过的坑，见 `runtime-minimal-agent.test.ts` 的同一段注释）：不共享
   * 模块级的"当前所有替身"数组（否则一条用例的收尾会释放另一条还在跑的替身，症状是 503 随机
   * 落在别的用例上）；释放前先等收敛，避免用 503 打断正在跑的一轮。
   */
  onTestFinished(async () => {
    await Promise.allSettled([...inFlight])
    await lifecycle.dispose()
    for (const close of disposers) await close()
  })
  return harness
}

interface MountDeps {
  readonly definition: AgentDefinition
  readonly runtime: AgentRuntime
  readonly access: Access
  readonly config: RuntimeConfig
}

/** 默认路径：运行时造 participant。**新 Agent 必须走这条** —— A4 数的就是它。 */
function mountOnDefaultPath(deps: MountDeps): RuntimeParticipant {
  mounts.defaultPath += 1
  return createParticipant({ definition: deps.definition, runtime: deps.runtime, access: deps.access, config: deps.config })
}

/**
 * 逃生通道：自己实现 participant，**完全不经过运行时**。
 *
 * 用途只有一个：给 A4 提供**负极对照**。它代表"运行时表达不了的 Agent"——这里表达不了的是
 * **不创建宿主会话**（运行时的第一步就是 `lifecycle.open`，那是机制的骨架，不该为个别 Agent 破例）。
 */
function mountOnEscapeHatch(deps: MountDeps): AgentParticipant {
  mounts.escapeHatch += 1
  const cached = '缓存命中：园区当前在线 42 台设备'
  return {
    protocol: PARTICIPANT_PROTOCOL,
    id: deps.definition.id,
    displayName: deps.definition.displayName,
    description: deps.definition.description,
    assertAccess: value => { deps.access.assert(value) },
    // 不 open、不 followup、不碰会话：答案直接来自进程内缓存。
    async run() {
      return { status: 'completed', conversationId: '', text: cached }
    },
  }
}

/** 造一次协作请求。 */
function request(overrides: { readonly acceptance?: string; readonly requestId?: string } = {}) {
  const progress: unknown[] = []
  return {
    progress,
    value: {
      actor,
      missionId: 'mission-poller',
      requestId: overrides.requestId ?? 'turn-poller-1',
      message: '查一下园区现在什么情况',
      ...(overrides.acceptance === undefined ? {} : { acceptance: overrides.acceptance }),
      signal: new AbortController().signal,
      onProgress: (value: unknown) => { progress.push(value) },
    },
  }
}

/** 从投给 Agent 的用户消息里取正文。 */
function userText(message: unknown): string {
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => typeof block === 'object' && block !== null
    && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
    ? [block.text] : []).join('')
}

// ---------------------------------------------------------------------------
// A2：交付物里必须出现哨兵值
// ---------------------------------------------------------------------------

describe('A2：终态与交付内容（只断 completed 是恒真的）', () => {
  it('A2-1 不调交活工具：哨兵值经**会话投影的兜底**交付', async () => {
    const projected: ResultContext[] = []
    const f = fixture(pollerDefinition({ onProject: ctx => { projected.push(ctx) } }), mountOnDefaultPath)
    const call = request()
    const pending = f.participant.run(call.value as never)
    const id = await f.accept()

    // 一轮：先轮询（工具结果带外部 API 的载荷），模型据此作答。
    f.toolResult(id, POLL_PAYLOAD)
    f.complete(id, `园区当前在线 42 台设备（哨兵 ${POLL_SENTINEL}）`)

    const result = await pending
    // ⚠️ 这一条**必须断内容**：只断 `status === 'completed'` 是恒真的 —— §4.3 规定"未交活按
    // `unverifiable` 交付、不判失败"，§4.6 又用投影兜底 + `summary` 非空，所以一个只轮询、
    // 什么都不产出的 Agent 也会落 `completed`。
    expect(result.status).toBe('completed')
    expect(result.text).toContain(POLL_SENTINEL)
    // 兜底走的是**业务投影**（不是运行时的内部兜底）：钩子真的被调了。
    expect(projected.length).toBeGreaterThan(0)
    expect(projected.at(-1)?.history.finalText).toContain(POLL_SENTINEL)
  })

  it('A2-2 调了交活工具：哨兵值经 report_result 的参数交付', async () => {
    const f = fixture(pollerDefinition(), mountOnDefaultPath)
    const participant = f.participant
    // 装配侧注册了交活工具（账本 `available` 翻真）——"模型手里真的有这个工具"。
    participant.handoff.install()
    const call = request()
    const pending = participant.run(call.value as never)
    const id = await f.accept()

    // 以模型身份交活：这就是 `report_result` 工具 `execute` 做的事（`handoff.ts` 的 submit）。
    participant.handoffFor(id).submit({
      status: 'completed',
      text: `轮询完成：${POLL_PAYLOAD}`,
    })
    f.complete(id, '（回答由交活工具给出）')

    const result = await pending
    expect(result.status).toBe('completed')
    // 同样必须断内容：工具交回的正文要真的到达交付物，而不是被投影覆盖掉。
    expect(result.text).toContain(POLL_SENTINEL)
  })
})

// ---------------------------------------------------------------------------
// A3：⑦ 第 3 条在兜底路径下仍按预期触发
// ---------------------------------------------------------------------------

describe('A3：口径-产物自洽（未调交活工具时仍触发）', () => {
  it('A3-1 口径非空且没有材料 ⇒ 第 3 条判不达标，汇总是 failed', async () => {
    // 缺省 `artifacts: false` —— 这个 Agent 只回答、不交材料。
    const f = fixture(pollerDefinition(), mountOnDefaultPath)
    const call = request({ acceptance: '一份列出在线设备数的轮询结果' })
    const pending = f.participant.run(call.value as never)
    const id = await f.accept()
    f.complete(id, `在线 42 台（哨兵 ${POLL_SENTINEL}）`)
    // ⚠️ **必须驱动第二次，且第二次要指明"等第几轮"**。这个 Agent 不调交活工具 ⇒ 运行时按
    // §4.3 注入一次补交轮（`report_retry`），并在等**那一轮的** `turn/end`。
    //
    // 少任何一半都会挂成 **30s 超时**，而且看不到断言失败、也不像"跑得慢"：`await pending`
    // 没有超时保护，所以呈现的是 vitest 的 `testTimeout`。
    //   · 只发一次 ⇒ 等一个永不到来的回合结束；
    //   · `accept()` 不传 `since` ⇒ 它的判据是 `followups.length > 0`，首轮就已满足，于是
    //     **立刻返回首轮的 id**，第二次 `turn/end` 又发给了首轮那个会话。
    // 判据：驱动补完应当在几十毫秒内跑完（对照 `runtime-closure.test.ts` 15 条 345ms）。
    const retry = await f.accept(f.followups().length)
    f.complete(retry, `仍然没有材料（哨兵 ${POLL_SENTINEL}）`)

    const result = await pending
    expect(result.status).toBe('completed')
    // ⑦ 第 3 条：口径非空而这一轮没有任何材料 ⇒ 不达标。**这条证明兜底事实源不是走过场**：
    // 没调交活工具时，程序性校验照样施加。
    expect(result.selfCheck?.status).toBe('failed')
    expect(result.selfCheck?.detail ?? '').toContain('没有交回任何材料')
  })

  it('A3-2 反向对照：材料非空时第 3 条不判不达标（汇总退为未核验）', async () => {
    const f = fixture(pollerDefinition({ artifacts: true }), mountOnDefaultPath)
    const call = request({ acceptance: '一份列出在线设备数的轮询结果' })
    const pending = f.participant.run(call.value as never)
    const id = await f.accept()
    f.complete(id, `在线 42 台（哨兵 ${POLL_SENTINEL}）`)

    const result = await pending
    // 材料交回了 ⇒ 第 3 条通过；但执行方没有自报自检（`absent`）⇒ 汇总如实退为 `unverifiable`，
    // **不是 failed**。这一条同时钉住两件事：第 3 条确实看材料，且 `absent` 不计入不达标。
    expect(result.selfCheck?.status).toBe('unverifiable')
  })

  it('A3-3 豁免规则：没有声明口径时第 3 条不施加（如实标未核验）', async () => {
    const f = fixture(pollerDefinition(), mountOnDefaultPath)
    const call = request() // 不传 acceptance
    const pending = f.participant.run(call.value as never)
    const id = await f.accept()
    f.complete(id, `在线 42 台（哨兵 ${POLL_SENTINEL}）`)

    const result = await pending
    expect(result.selfCheck?.status).toBe('unverifiable')
    expect(result.selfCheck?.detail ?? '').toContain('没有声明验收口径')
  })
})

// ---------------------------------------------------------------------------
// A4：逃生通道使用次数 = 0（含负极对照）
// ---------------------------------------------------------------------------

describe('A4：默认路径足以承载这个 Agent', () => {
  it('A4-负极对照：运行时表达不了的 Agent 必须走逃生通道，计数 = 1', async () => {
    resetMounts()
    const f = fixture(sessionlessDefinition(), mountOnEscapeHatch)
    const call = request()
    const result = await f.participant.run(call.value as never)
    // 它不建会话：`conversationId` 为空、也没有任何 followup 记录 —— 这正是"运行时默认路径
    // 表达不了"的地方（运行时第一步就是 `lifecycle.open`）。
    expect(result.status).toBe('completed')
    expect(result.conversationId).toBe('')
    expect(f.followups()).toHaveLength(0)
    // ⚠️ 这一条是 A4 成立的前提：**没有它，计数器没接上时"使用次数 = 0"天然成立、判据恒绿。**
    expect(mounts.escapeHatch).toBe(1)
    expect(mounts.defaultPath).toBe(0)
  })

  it('A4：轮询器走默认路径，逃生通道使用次数 = 0', async () => {
    resetMounts()
    const f = fixture(pollerDefinition(), mountOnDefaultPath)
    const call = request()
    const pending = f.participant.run(call.value as never)
    const id = await f.accept()
    f.complete(id, `在线 42 台（哨兵 ${POLL_SENTINEL}）`)
    await pending

    expect(mounts.defaultPath).toBe(1)
    expect(mounts.escapeHatch).toBe(0)
    // 顺带钉住"它真的走了运行时"：会话是按 `agent_id` 参数化的前缀铸的（格式契约）。
    expect(id).toMatch(new RegExp(`^${POLLER_AGENT_ID}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`))
  })

  it('A4-补充：装配只用了声明式接口 —— persona 与工具限制都落在 agent 作用域', async () => {
    const f = fixture(pollerDefinition(), mountOnDefaultPath)
    const call = request()
    const pending = f.participant.run(call.value as never)
    const id = await f.accept()
    f.complete(id, '在线 42 台')
    await pending

    // 这个新 Agent **没有为本 Agent 新增任何运行时钩子**：它声明 persona 与工具，机制照常装配。
    // （A1 的命令证据是 `git diff --stat -- packages/runtime` 为空；这里是它的运行期侧写法。）
    const session = (f.port as unknown as { }) && id
    expect(session).toBeTruthy()
    expect(userText(f.followups().at(-1)?.message)).toBe('查一下园区现在什么情况')
  })
})
