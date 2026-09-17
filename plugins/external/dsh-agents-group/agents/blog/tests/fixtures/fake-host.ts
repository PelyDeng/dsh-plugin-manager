/**
 * **假宿主**：只提供运行时真的会用到的那几个宿主面（协作入口的测试夹具共用这一份）。
 *
 * ## 为什么要抽成一份
 *
 * `coordinator.test.ts` 与 `participant-harness.ts` 都要一个假宿主。本仓的教训是
 * **"两份等价实现的结局是某条路径改了另一条没改"**，所以这里只留一份，两边都 import 它。
 *
 * ## 它提供什么 / 边界在哪
 *
 * 它只做**构造**：造一个 `ctx`（`agents` / `on` / `effect` / `get` / `tools.register` / `llm` …）、
 * 一个会话-句柄表、一条事件通道，以及几个驱动便利函数（`emit` / `complete` / `accept`）。
 * **它不实现任何运行时机制**——回合驱动、投影、授权、落库全部由产品代码（运行时 + 业务）承担。
 * 评审时按这条判：本文件里出现"回合状态机 / 投影 / 绑定写入"就是越界。
 *
 * ## ⚠️ 两条必须守住的口径（都是踩过的坑，别改成"更简洁"的写法）
 *
 * 1. **事件必须"先写日志、再广播"**。真实宿主是两件事一起做的；运行时（与本夹具的订户）
 *    靠**广播**知道"这一轮开始了"。只往 `session.events` 里塞而不广播的后果是**静默挂死**：
 *    `turn/start` 没被广播 ⇒ 运行时把随后的 `assistant/message` 与 `turn/end` 全部丢掉 ⇒
 *    收尾循环永远等不到 `turn/end` ⇒ `participant.run()` 永不 settle。
 *    实测表现是 `node:test` 报 **`Promise resolution is still pending`**，而不是某条断言红——
 *    极难从红条定位，所以这里写死顺序。
 * 2. **`options.setup` 必须 `await`**（真实宿主也是在公布句柄之前调它）。不 await 会让
 *    persona / 工具限制的注册**晚于句柄公开**，表现为"偶发地少了 systemPrompt 段"。
 *
 * ## `tools.register` 为什么不能写成空壳
 *
 * `createPluginTools().register()` 内部做的是
 * `ctx.effect(() => ctx.tools.register(guardTool(definition, authorize)))` —— 授权就包在
 * **那个** `execute` 上。写成空壳的后果是：业务只拿得到**目录条目**（`ToolDescriptor`：
 * `{name, description, parameters}`，上面**没有** `execute`），执行时报
 * `tool.execute is not a function`，而那看起来像"工具没注册"，其实是看错了那一半。
 * ⇒ 可执行的那一份收在返回值的 `registeredTools` 里（测试用 `host.tool(name)` 取）。
 *
 * ## 登记：`access` 的三个面是为满足 `Access` 真接口补的，不是新增判据
 *
 * 本夹具原先的 `access` **只实现 `assert`**，而 `packages/plugin-kit` 的 `Access` 是
 * `{ mode, ready, resolve, assert }`（`access.ts:194-199`）——即**夹具比接口窄**。
 * 为让 `coordinator.test.ts` 的 `new BlogChat(ctx, access, …)` / `new BlogJobs(ctx, access, …)`
 * 通过类型检查，这里补齐了 `mode: 'authenticated'`、`ready()`（无副作用）、
 * `resolve()`（回**与本夹具 `assert` 接受的同一个 actor**）。
 *
 * ⚠️ **口径**：这是"夹具跟上真接口"，**不是放宽判据**；`assert` 的判定逻辑（`revoked` 与
 * `loginSessionId`）一个字未改。若哪条路径真的开始调用 `resolve` / `ready`，那要单独报告——
 * 那意味着它以前是"调了会炸"，只是没人走到过。
 */

import { setImmediate as tickImmediate } from 'node:timers/promises'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Access, Actor, ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'

const tick = () => tickImmediate()

/** 一个假会话事件（形状照真实日志：`type` / `data` / `time` / `seq`，见 `@deepseek-ai/dsh-session` 的 `SessionEvent`）。 */
interface FakeEvent {
  readonly type: string
  readonly data: unknown
  readonly time: number
  readonly seq: number
}

/** 假宿主按会话复用同一个 Agent 对象（实时帧靠它在 WeakMap 里归段，见 `stream` 的说明）。 */
interface FakeAgent {
  readonly id: string
  readonly session: { readonly id: string; readonly snapshotEvents: () => readonly FakeEvent[] }
  readonly followup: (message: unknown) => void
  readonly whenIdle: () => Promise<void>
  readonly cancel: (cause?: unknown) => void
}

interface FakeSession {
  readonly id: string
  readonly events: FakeEvent[]
  agent: FakeAgent
}

/** `ctx.agents.create` / `resume` 实际收到的选项（真实类型是 `CreateAgentOptions`，这里只声明本夹具读的几个面）。 */
interface FakeAgentOptions {
  readonly sessionId?: unknown
  readonly resumeSessionId?: unknown
  readonly setup?: (agentCtx: unknown, agent: unknown) => unknown
}

/**
 * 一段实时流：`step` 是这一步的编号，`chunks` 是这一步**新到**的片段（增量语义，见 `stream` 的说明）。
 *
 * 形状照运行时的读法反推（`projection.ts:43-58` 读 `frame.attemptId` / `revision` / `step` / `chunk`，
 * `participant.ts:393-399` 读 `chunk.type` / `chunk.text`）——`chunk.type` 放开成 `string`
 * 是因为这里要能发**运行时认不出**的类型（那正是"帧类型不匹配 ⇒ 静默丢弃"的实验手段）。
 */
interface FakeStreamStep {
  readonly step: number
  readonly chunks: readonly { readonly type: string; readonly text: string }[]
}

/** `setup` 拿到的 agent 作用域替身：`ConversationLifecycle.setup` 只碰这两个面。 */
interface FakeAgentScope {
  readonly systemPrompt: {
    readonly section: (section: unknown) => void
    readonly context: (context: unknown) => void
  }
  readonly tools: { readonly restrict: (input: { readonly allow: readonly string[] }) => void }
  readonly get: (key: string) => unknown
}

/**
 * agent 句柄。运行时（`ConversationLifecycle`）只读 `agent` 与 `dispose()`；`options` / `cancelled` /
 * `emit` / `sections` / `contexts` / `allowed` 是**测试的观测量**（`coordinator` / `definition` 用例读它们），
 * 不在 `AgentHandle` 契约里 ⇒ 在交给运行时的那一处边界断言掉（见 `create`）。
 */
interface FakeAgentHandle {
  readonly agent: FakeAgent
  readonly options: FakeAgentOptions
  cancelled: boolean
  disposed: boolean
  readonly emit: (type: string, data: unknown) => void
  readonly dispose: () => Promise<void>
  readonly sections: unknown[]
  readonly contexts: unknown[]
  /**
   * `tools.restrict({allow})` 记下的那份白名单。
   *
   * ⚠️ 用 `| undefined` 而不是 `?`：本仓开着 `exactOptionalPropertyTypes`，"可选"与"值为 undefined"
   * 在类型上不等价，而这里**总是有**这个属性（构造时就写了 `undefined`）。
   */
  allowed: readonly string[] | undefined
}

/** `ConversationLifecycle` 读的宿主面（假宿主只提供这些；交给运行时处断言成 `Context`）。 */
interface FakeContext {
  readonly root: Context
  readonly on: (name: string, listener: (...args: readonly unknown[]) => void, options?: { readonly global?: boolean }) => () => void
  readonly effect: (effect: () => (() => unknown) | unknown) => (() => unknown) | undefined
  readonly debugCount: (name: string) => number
  /**
   * 服务登记处的取用口。返回 `unknown`（不是 `any`）：本仓 Lint 口径禁 `any`，
   * 调用点要拿到"各自那个服务"的真类型时，由**它自己**在该处断言（见 `participant-harness.ts` 的 `ctx`）。
   */
  readonly get: (key: string) => unknown
  readonly tools: { readonly register: (tool: ToolDescriptor & { readonly execute?: unknown }) => () => boolean }
  readonly agents: {
    readonly create: (options: FakeAgentOptions) => Promise<FakeAgentHandle>
    readonly resume: (options: FakeAgentOptions) => Promise<FakeAgentHandle>
  }
  readonly jobs: unknown
  readonly llm: unknown
  readonly agentDefaultModel: unknown
  readonly sessionController: unknown
  readonly sessionProjections: unknown
  readonly sessions: unknown
  readonly sessionPersistence: unknown
  readonly messageFeedback: unknown
  readonly workspaceRegistry: unknown
}

/**
 * 假宿主的公开面（`createFakeHost` 的返回值）。
 *
 * `ctx` 声明成**真** `Context`：运行时按 `ConversationLifecycle` 的入参读它（`host.ctx`），
 * 所以这是"本夹具提供的面**满足**宿主契约"的声明处。实现体只有上面那十几个面，
 * 缺的那些（`events` / `logger` / `reflect` / 注册表…）运行时一个都不读 —— 这是
 * **假宿主 ↔ 真宿主的边界**，在 `createFakeHost` 的返回处做**一次**断言，调用方各处不再重复。
 */
export interface FakeHost {
  readonly ctx: Context
  readonly access: Access
  readonly agents: FakeContext['agents']
  readonly sessionOf: (id: string) => FakeSession
  readonly emit: (type: string, data: unknown, conversationId: string) => void
  readonly complete: (conversationId: string, text: string, reason?: string) => void
  readonly accept: (since?: number) => Promise<string>
  readonly stream: (conversationId: string, steps: readonly FakeStreamStep[]) => void
  readonly followups: readonly { readonly id: string; readonly message: unknown }[]
  readonly registeredTools: ReadonlyMap<string, ToolDescriptor & { readonly execute?: unknown }>
  readonly byEvent: ReadonlyMap<string, ReadonlySet<(...args: readonly unknown[]) => void>>
  readonly disposers: readonly (() => unknown)[]
  /** 可执行的那一份工具（kit 交给 `ctx.tools.register` 的，带授权）。 */
  readonly tool: (name: string) => (ToolDescriptor & { readonly execute?: unknown }) | undefined
  /** `session/event` 通道当前订阅数（漏订/漏退订都看得见）。 */
  readonly listenerCount: () => number
  readonly revoke: () => void
  /** 反序释放本宿主收集到的所有 disposer（调用方在 `t.after` 里 await 它）。 */
  readonly disposeAll: () => Promise<void>
}

/**
 * 造一个假宿主。
 *
 * @param root 真的 cordis `Context`（需要它的 `agents` / `jobs` 两个 registry 已经 `await` 挂上）。
 * @param options.sessionId 授权核验认的登录会话 id（默认 `'login-a'`）。
 * @param options.stream 可选：把 `agent/assistant-stream` 帧也接上（给了才注册该通道）。
 */
export function createFakeHost(root: Context, options: { readonly sessionId?: string; readonly stream?: unknown } = {}): FakeHost {
  const loginSessionId = options.sessionId ?? 'login-a'

  const byEvent = new Map<string, Set<(...args: readonly unknown[]) => void>>()
  const disposers: (() => unknown)[] = []
  const sessions = new Map<string, FakeSession>()
  const followups: { readonly id: string; readonly message: unknown }[] = []
  const registeredTools = new Map<string, ToolDescriptor & { readonly execute?: unknown }>()
  let seq = 0
  let revoked = false

  const sessionOf = (id: string): FakeSession => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    /**
     * 先造壳、再挂 `agent`（它闭包引用 `session` 自己）⇒ `agent` 在会话构造完成前缺席，
     * 这里如实断言成 `FakeSession`，与 closedoff 夹具的同一处写法一致。
     */
    const session = { id, events: [] } as unknown as FakeSession
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: message => {
        followups.push({ id, message })
        // 顺序见文件头 §⚠️1：先写日志（`emit` 里做）再广播，缺广播会静默挂死。
        emit('user/message', message, id)
        emit('turn/start', { turn: 'turn-' + (seq + 1) }, id)
      },
      whenIdle: async () => { },
      cancel: () => { },
    }
    sessions.set(id, session)
    return session
  }

  /**
   * agent 句柄：运行时只读 `agent` / `dispose()`（其余几个是测试自己的观测量）。
   * `scope` 是 `root.plugin` 返回的 fiber，释放它就是真实的 fiber 释放。
   */
  const handleOf = (session: FakeSession, options_: FakeAgentOptions, scope: Fiber): FakeAgentHandle => {
    const handle = {
      agent: session.agent, options: options_, cancelled: false, disposed: false,
      emit: (type: string, data: unknown) => { emit(type, data, session.id) },
      dispose: async () => { if (handle.disposed) return; handle.disposed = true; await scope.dispose() },
      sections: [] as unknown[], contexts: [] as unknown[],
      allowed: undefined as readonly string[] | undefined,
    }
    return handle
  }

  /** 发一个会话事件：**先**写进事件日志（`historyOf` 读它），**再**广播（生命周期订阅它）。 */
  const emit = (type: string, data: unknown, conversationId: string): void => {
    const session = sessionOf(conversationId)
    seq += 1
    const event: FakeEvent = { type, data, time: 1000 + seq, seq }
    session.events.push(event)
    /**
     * 广播的载荷是**真** `SessionEvent` 与**真** `Session`：本夹具的会话只有 `id` / `agent` 两个面，
     * 而运行时的订户只读 `session.id`（`participant.ts:661`）与 `event.type` / `event.data`，
     * 所以在这里（假宿主 ↔ 真宿主事件总线的**唯一边界**）如实断言，形状与运行时读法一致。
     */
    for (const listener of [...(byEvent.get('session/event') ?? [])]) {
      listener(session as unknown as { readonly id: string }, event as unknown as SessionEvent)
    }
  }

  const agents = {
    create: async (options_: FakeAgentOptions): Promise<FakeAgentHandle> => {
      const session = sessionOf(String(options_.sessionId))
      const scope = root.plugin(() => { })
      const handle = handleOf(session, options_, scope)
      // agent 作用域：`ConversationLifecycle.setup` 只碰 `systemPrompt` 与 `tools` 这两个面
      // （照群组 `tests/runtime-minimal-agent.test.ts:214` 的假宿主写；`setup` 必须 await，见文件头 §⚠️2）。
      const agentCtx: FakeAgentScope = {
        systemPrompt: { section: section => { handle.sections.push(section) }, context: context => { handle.contexts.push(context) } },
        tools: { restrict: input => { handle.allowed = [...input.allow] } },
        get: key => ctx.get(key),
      }
      /**
       * `agentCtx` / `session.agent` 交给业务声明的 `setup`：它们的形状由真实
       * `CreateAgentOptions.setup`（`(agentCtx: Context, agent: Agent) => …`）规定，而本夹具只提供
       * `systemPrompt` / `tools` / `get` 三个面（`ConversationLifecycle.setup` 的全部读法）——
       * 这是**假宿主 ↔ 真宿主作用域**的边界，如实断言，不把夹具面伪装成完整 `Context`。
       */
      await options_.setup?.(agentCtx as unknown as Context, session.agent as unknown as Agent)
      return handle
    },
    resume: async (options_: FakeAgentOptions): Promise<FakeAgentHandle> => agents.create({ ...options_, sessionId: options_.resumeSessionId }),
  }

  const ctx = {
    root,
    on: (name: string, listener: (...args: readonly unknown[]) => void) => {
      const group = byEvent.get(name) ?? new Set<(...args: readonly unknown[]) => void>()
      group.add(listener)
      byEvent.set(name, group)
      return () => group.delete(listener)
    },
    effect: (effect: () => (() => unknown) | unknown) => {
      const dispose = effect()
      // `typeof dispose === 'function'` 之后 TS 只知道它是 `Function`；disposer 的调用签名是
      // 本夹具自己约定的（`disposeAll` 里 `await dispose()`）⇒ 在这一处如实收窄成那个签名。
      if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
      return dispose ?? (() => { })
    },
    debugCount: (name: string) => (byEvent.get(name) ?? new Set()).size,
    get(key: string): unknown { return key === 'agents' ? root.agents : (ctx as unknown as Context)[key as 'root'] },
    tools: { register: (tool: ToolDescriptor & { readonly execute?: unknown }) => { registeredTools.set(tool.name, tool); return () => registeredTools.delete(tool.name) } },
    agents,
    jobs: root.jobs,
    /**
     * 模型面。`llm` 用**属性访问**（`ctx.llm.x`）——运行时是这么用的；kit 那套用 `ctx.get('llm')`。
     * 两者都要给：少给属性面会在运行时报 `Cannot read properties of undefined (reading 'resolveModelInfo')`。
     */
    llm: {
      resolveCallConfig: async (value: unknown) => value,
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    sessionController: {
      modelCatalog: async () => ({
        groups: [{ id: 'test', name: '测试', models: [{ id: 'test', name: '文本模型' }] }],
        failures: [], selected: { provider: 'test', model: 'test' },
      }),
    },
    // `conversationModel()` 走宿主的模型投影：**有 id** 的路径（既有会话）从这里恢复上一次的选择。
    // 它会回落到 `agentDefaultModel`，但 `restore()` 的**形状**必须对。
    sessionProjections: {
      restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { provider: 'test', model: 'test' } } } } }),
    },
    sessions: { flush: async () => true },
    /**
     * ⚠️ **这个面必须是"够真"的**（2026-09-17 修，起因见下）——它原先是个只回空数组的桩：
     * `sessionPersistence: { stat: async () => undefined, open: async () => ({ read: async () => ({ events: [] }) }) }`
     *
     * 两个后果（都是实测出来的）：
     * 1. **`chat.ts:504-505` 的 `persistedEvents` 会崩**：它 `await handle.close()`（在 `finally` 里），
     *    而桩没有 `close` ⇒ `handle.close is not a function`。
     * 2. **更实质的**：`read()` 恒回 `[]` ⇒ **任何"读已持久化的事件"的路径都读到空**
     *    （`chat.ts:503-506` 是"没有活跃绑定"时读历史的唯一通道，跨轮/durable 读取全靠它）
     *    ⇒ 投影出来的是"本轮没跑完"这类**假象**，而不是真实事件流。
     *
     * 现在按真契约补齐：`header` 要满足 `chat.ts:450` 的 `assertLifecycle`
     * （`String(header.id) === c.id`、`header.cwd === process.cwd()`、`parentSession` / `isSeeded` 与 `c.parent` 一致、
     * `createdAt` 落在会话的 opening 窗口内），`read()` 回**宿主自己那份事件日志**（与 `snapshotEvents()` 同源）。
     */
    sessionPersistence: {
      stat: async () => undefined,
      open: async (sessionId: string) => {
        const session = sessionOf(String(sessionId))
        return {
          header: { id: session.id, cwd: process.cwd(), createdAt: Date.now() },
          read: async () => ({ events: session.events }),
          close: async () => { },
        }
      },
    },
    messageFeedback: {},
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => { } },
  }

  const access: Access = {
    assert(current: Actor) { if (revoked || current.namespace !== 'user' || current.sessionId !== loginSessionId) throw new Error('登录或授权已失效') },
    mode: 'authenticated',
    ready: () => { },
    resolve: () => ({ namespace: 'user', userId: 'writer', sessionId: loginSessionId }),
  }

  /** 发一轮完整回合：`assistant/message` → `turn/end`。 */
  const complete = (conversationId: string, text: string, reason = 'completed'): void => {
    const turn = sessionOf(conversationId).events.findLast(event => event.type === 'turn/start')?.data
    emit('assistant/message', {
      turn,
      message: { id: 'answer-' + String(turn), role: 'assistant', source: { model: 'test', provider: 'test' }, content: [{ type: 'text', text }] },
      stream: [],
    }, conversationId)
    emit('turn/end', { turn, reason: { kind: reason } }, conversationId)
  }

  /**
   * 等第 `since + 1` 轮**接单**（用户消息已投给 Agent），返回它的会话 id。
   *
   * ⚠️ 按**投递次数**算，不按"会话 id 去重后有几个"算：续问落在**同一条**会话上，
   * 去重之后永远只有一个 ⇒ 第二轮的等待会以"等待接单超时"红，而真相是它早就接单了。
   */
  const accept = async (since = 0): Promise<string> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      // `length > since` 刚判过 ⇒ 这一项一定在（`noUncheckedIndexedAccess` 看不见这条关系）。
      if (followups.length > since) return followups[since]!.id
      await tick()
    }
    throw new Error('等待接单超时')
  }

  /**
   * 发**实时流**（`agent/assistant-stream` 帧）——运行时靠它产出 `kind:'thinking'` / `'delta'` 进度。
   *
   * **帧序与字段是"照运行时的读法反推"的，不是猜的**（依据两处源码，均已读过）：
   * - `packages/runtime/src/projection.ts:43-58`（`onAssistantDelta`）：
   *   `ctx.on('agent/assistant-stream', ({agent, frame}) => …)`；
   *   `frame === undefined` 直接返回；`frame.type === 'start'` 时把
   *   `{attemptId, revision, step}` 记进以 **agent** 为键的 WeakMap 并返回；
   *   之后 `attemptId` 不符、或 `attempt.revision >= frame.revision` 的帧**静默丢弃**；
   *   `frame.type === 'end'` 删掉该 attempt；**其余类型**都当作 chunk 载体 →
   *   `receive(agent.session.id, { time: frame.time, step: attempt.step, chunk: frame.chunk })`。
   *   ⇒ **`step` 取自 `start` 帧**（不是 chunk 帧）⇒ **换段必须另开一次 `start`**。
   * - `packages/runtime/src/participant.ts:393-399`（`sink`）：`chunk.type === 'text-delta'` ⇒ `visible.push`；
   *   `chunk.type === 'reasoning-delta'` ⇒ `thinking.push(delta.step, chunk.text)`。
   *
   * ⚠️ **帧序是协议要求，不是可选风格**：
   *   1. 每段先发 `start`（带 `attemptId` / `revision` / **`step`**）——运行时用 WeakMap 记住这次尝试，
   *      而且**`step` 取自 `start` 帧**（不是取自 chunk 帧）⇒ **换段必须另开一次 `start`**；
   *   2. 再发同 `attemptId`、`revision` **严格递增**的 `chunk` 帧；
   *   3. 最后 `end`（运行时会删掉这次尝试）。
   * **缺 `start`、或 `revision` 不递增 ⇒ 帧被静默丢弃**（表现为"进度为空"，不是报错）。
   *
   * @param steps `[{ step, chunks: [{ type, text }, …] }, …]`
   *   `chunk.text` 是**增量**（服务端 delta 语义，与 DSH 的 `StreamChunk`
   *   `{ type: 'reasoning-delta'; text }` 一致）⇒ **传"这一步新到的片段"**，不要传"本步到目前为止的全文"。
   *   blog 声明 `liveMode: 'delta'`（`definition.ts:159`，**2026-09-17 由 `'cumulative'` 更正**），
   *   运行时按 step **追加**（`projection.ts:191`）。
   *   ⚠️ 曾经传累计值是为了迁就那个错的声明——那会让**真机上**（宿主只发增量）每一步的思考
   *   只剩最后一个片段，而测试却是绿的（"替身迁就实现"掩盖真问题的又一例）。
   */
  const stream = (conversationId: string, steps: readonly FakeStreamStep[]): void => {
    const agent = sessionOf(conversationId).agent
    const send = (frame: unknown): void => {
      for (const listener of [...(byEvent.get('agent/assistant-stream') ?? [])]) listener({ agent, frame })
    }
    let attempt = 0
    for (const segment of steps) {
      const attemptId = `attempt-${++attempt}-${++seq}`
      let revision = 0
      send({ type: 'start', attemptId, revision: revision++, step: segment.step, time: Date.now() })
      for (const chunk of segment.chunks) {
        send({ type: 'chunk', attemptId, revision: revision++, step: segment.step, time: Date.now(), chunk })
      }
      send({ type: 'end', attemptId, revision: revision++, step: segment.step, time: Date.now() })
    }
  }

  return {
    /**
     * 假宿主 ↔ 真宿主的边界：实现体只有 `FakeContext` 那十几个面，而运行时按 `Context` 读它。
     * 真实宿主会多出 `events` / `logger` / `reflect` / 注册表等一堆本夹具不提供的东西 ——
     * 那些运行时**一个都不读**（本文件头的"边界"那段就是这条判据），所以在这一处如实断言。
     */
    ctx: ctx as unknown as Context,
    access, agents, sessionOf, emit, complete, accept, stream,
    followups, registeredTools, byEvent, disposers,
    /** 可执行的那一份工具（kit 交给 `ctx.tools.register` 的，带授权）。 */
    tool: (name: string) => registeredTools.get(name),
    /** `session/event` 通道当前订阅数（漏订/漏退订都看得见）。 */
    listenerCount: () => (byEvent.get('session/event') ?? new Set()).size,
    revoke: () => { revoked = true },
    /** 反序释放本宿主收集到的所有 disposer（调用方在 `t.after` 里 await 它）。 */
    disposeAll: async () => { for (const dispose of disposers.reverse()) await dispose?.() },
  }
}
