/**
 * **假宿主**：只提供运行时真的会用到的那几个宿主面（协作入口的测试夹具共用这一份）。
 *
 * ## 为什么要抽成一份
 *
 * `coordinator.test.mjs` 与 `participant-harness.mjs` 都要一个假宿主。本仓的教训是
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
 */
import { setImmediate as tickImmediate } from 'node:timers/promises'

const tick = () => tickImmediate()

/**
 * 造一个假宿主。
 *
 * @param root 真的 cordis `Context`（需要它的 `agents` / `jobs` 两个 registry 已经 `await` 挂上）。
 * @param options.sessionId 授权核验认的登录会话 id（默认 `'login-a'`）。
 * @param options.stream 可选：把 `agent/assistant-stream` 帧也接上（给了才注册该通道）。
 */
export function createFakeHost(root, options = {}) {
  const loginSessionId = options.sessionId ?? 'login-a'

  const byEvent = new Map()
  const disposers = []
  const sessions = new Map()
  const followups = []
  const registeredTools = new Map()
  let seq = 0
  let revoked = false

  const sessionOf = id => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [] }
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

  /** 发一个会话事件：**先**写进事件日志（`historyOf` 读它），**再**广播（生命周期订阅它）。 */
  const emit = (type, data, conversationId) => {
    const session = sessionOf(conversationId)
    seq += 1
    const event = { type, data, time: 1000 + seq, seq }
    session.events.push(event)
    for (const listener of [...(byEvent.get('session/event') ?? [])]) listener(session, event)
  }

  const agents = {
    create: async options_ => {
      const session = sessionOf(String(options_.sessionId))
      const scope = root.plugin(() => { })
      const handle = {
        agent: session.agent, options: options_, cancelled: false, disposed: false,
        emit: (type, data) => { emit(type, data, session.id) },
        dispose: async () => { if (handle.disposed) return; handle.disposed = true; await scope.dispose() },
      }
      // agent 作用域：`ConversationLifecycle.setup` 只碰 `systemPrompt` 与 `tools` 这两个面
      // （照群组 `tests/runtime-minimal-agent.test.ts:214` 的假宿主写；`setup` 必须 await，见文件头 §⚠️2）。
      const agentCtx = {
        systemPrompt: { section: section => { handle.sections.push(section) }, context: context => { handle.contexts.push(context) } },
        tools: { restrict: input => { handle.allowed = [...input.allow] } },
        get: key => ctx[key],
      }
      handle.sections = []; handle.contexts = []
      await options_.setup?.(agentCtx, session.agent)
      return handle
    },
    resume: async options_ => agents.create({ ...options_, sessionId: options_.resumeSessionId }),
  }

  const ctx = {
    root,
    on: (name, listener) => {
      const group = byEvent.get(name) ?? new Set()
      group.add(listener)
      byEvent.set(name, group)
      return () => group.delete(listener)
    },
    effect: effect => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose); return dispose ?? (() => { }) },
    debugCount: name => (byEvent.get(name) ?? new Set()).size,
    get(key) { return key === 'agents' ? root.agents : this[key] },
    tools: { register: tool => { registeredTools.set(tool.name, tool); return () => registeredTools.delete(tool.name) } },
    agents,
    jobs: root.jobs,
    /**
     * 模型面。`llm` 用**属性访问**（`ctx.llm.x`）——运行时是这么用的；kit 那套用 `ctx.get('llm')`。
     * 两者都要给：少给属性面会在运行时报 `Cannot read properties of undefined (reading 'resolveModelInfo')`。
     */
    llm: {
      resolveCallConfig: async value => value,
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
      open: async sessionId => {
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

  const access = {
    assert(current) { if (revoked || current.sessionId !== loginSessionId) throw new Error('登录或授权已失效') },
  }

  /** 发一轮完整回合：`assistant/message` → `turn/end`。 */
  const complete = (conversationId, text, reason = 'completed') => {
    const turn = sessionOf(conversationId).events.findLast(event => event.type === 'turn/start')?.data.turn
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
  const accept = async (since = 0) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (followups.length > since) return followups[since].id
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
  const stream = (conversationId, steps) => {
    const agent = sessionOf(conversationId).agent
    const send = frame => {
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
    ctx, access, agents, sessionOf, emit, complete, accept, stream,
    followups, registeredTools, byEvent, disposers,
    /** 可执行的那一份工具（kit 交给 `ctx.tools.register` 的，带授权）。 */
    tool: name => registeredTools.get(name),
    /** `session/event` 通道当前订阅数（漏订/漏退订都看得见）。 */
    listenerCount: () => (byEvent.get('session/event') ?? new Set()).size,
    revoke: () => { revoked = true },
    /** 反序释放本宿主收集到的所有 disposer（调用方在 `t.after` 里 await 它）。 */
    disposeAll: async () => { for (const dispose of disposers.reverse()) await dispose?.() },
  }
}
