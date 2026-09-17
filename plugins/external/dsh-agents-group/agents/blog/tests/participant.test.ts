import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { BlogStore, ownerKey } from '../src/store.ts'
import { ChatStore } from '../src/chat-store.ts'
// 协作入口在 P7 收敛到运行时（`src/participant.ts` 已删除）⇒ 这一行指向构造胶水。
//
// ## 本文件是**照 closedoff 的已完成后继物迁移**过来的（形体与判据都有先例）
//
// `agents/closedoff/tests/participant.test.ts`（985 行 / 24 条）走完了**同一次**载体切换，
// 用例与本文件近乎一一对应；本文件的迁移逐条照它对齐（对应行号见各用例内的登记）。
// 迁移的形状只有一条：**驱动方从"旧入口自己驱动"换成运行时**
// （`ConversationLifecycle` 的 `ctx.agents.create/resume` + `session/event`），
// 于是断言必须从**旧驱动方的内部记账**换到**运行时可观测的事实**：
//
// | 旧记账（已不适用） | 运行时的事实 |
// | --- | --- |
// | `f.active`（哪条会话在跑） | `lifecycle.isBusy(id)` / `lifecycle.busyIds()` |
// | `f.runs` / `f.creates`（驱动了几轮） | 宿主会话事件（`sessionOf(id).events`）+ `dsh_turns` |
// | `f.stops`（谁停了） | `lifecycle.cancel(...)` 的结果 |
// | `f.messages`（交回了什么） | `participant.run()` 的返回值 / `projectResult` 的投影 |
//
// ## ⚠️ 一处**已更正**的历史结论（别把它当依据）
//
// 本文件先前写着"补假宿主不可行，三条硬证据"。**那个结论只对一种接法成立**：
// 当时把宿主的 `followup` 接回 `f.chat.send`，于是撞上三层
// （历史不同源 / 身份命名空间不同 `run:<requestId>` vs `ChatStore.id()` / `dsh_turns` 与
// `ChatStore.start` 双重记账）。**而 closedoff 的后继物根本不经过 `chat.send`**
// （它用朴素的 `createClosedoffDefinition`，驱动全交给运行时）—— 不经过那道门，三层同时消失。
// ⇒ **"假宿主"本身没问题，"把 followup 接回 `chat.send`"才是错的**（同一轮在两个记账里各占一次）。
// 本文件现在走的正是 closedoff 那条路：补假宿主、由运行时驱动、**不碰 `f.chat.send`**。
//
// ## 已知差异（如实登记，不是抹平）
//
// 1. **业务文案由运行时给出**：进度文案与材料标题是运行时的通用文案
//    （`已接单。` / `查看会话`），旧实现是 blog 写死的（如 `博客会话已连接`）。
//    **这是业务文案，不是语义丢失** —— 先例见 `agents/closedoff/tests/agent.test.ts:15-16`
//    （closedoff 同一次切换后留下的登记，原文即"那是业务文案"）。
// 2. **幂等身份**：从业务侧 `requestId` 变成运行时的 `run:<requestId>`（`dsh_turns.request_id`）。
//    这正是"同一 mission 只建一条会话"从业务表搬到 `dsh_conversations` 的部分唯一索引。
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import type { ChatRequestRecord } from '../src/chat-store.ts'
import type { ParticipantProgress, ParticipantResult } from '../../../packages/runtime/src/contract.ts'
import type { TitleSink } from '../../../packages/runtime/src/conversation.ts'
import { createBlogParticipant } from './participant-harness.ts'
import { createFakeHost, type FakeHost } from './fixtures/fake-host.ts'
// 索引库切 PG 之后夹具换成运行时的内存端口（见 index-fixture.mjs）：ChatStore 不再自己开库，
// 所有读写都过端口（异步）。
import { memoryIndex } from './index-fixture.ts'
// .db.conversations 在用例里读内存替身独有的观测量（size），所以要那个类的类型（只导入类型）。
import type { MemoryConversationPort } from '../../../packages/runtime/src/storage/memory.ts'
import { chatConversationTarget } from '../web/chat.js'
import { renderMarkdown } from '../web/markdown.js'

/**
 * 本文件的登录身份。
 *
 * 类型写 `Actor` 而**不是** `Object.freeze` 推出来的字面量类型：推出来的是
 * `{ userId: 'writer' }`，于是 `provider.run(input({ actor: { ...actor, userId: 'other-user' } }))`
 * （Q4 那条"其他 owner"用例）在类型上是**换掉一个字面量**——`'other-user'` 不是 `'writer'` ⇒
 * 类型报错，而那条用例的语义恰恰是"换一个别的用户"。`Actor` 才是这份数据的真类型
 * （`namespace` / `userId` / `sessionId`），`Object.freeze` 的运行期行为一字未动。
 */
const actor: Actor = Object.freeze({ namespace: 'user', userId: 'writer', sessionId: 'login-a' })

// ---------------------------------------------------------------------------
// 夹具的类型（**只加类型，不改语义**）
//
// 下面这些接口只做一件事：把本文件里 `f` 那个对象字面量**说清楚**。字面量里的每个字段、
// 每个方法体、每个断言都逐字未动 —— 之前它们没有注解，`tsc` 因此把一半字段推成隐式 `any`
// （`f.access` / `f.chat` / `f.provider` 甚至是"赋值后新增的属性"，类型上根本不存在）。
//
// 口径同 `agents/closedoff/tests/participant.test.ts:57-135`（同一次迁移的已完成后继物）：
// 夹具顶部写精确的局部接口，只在**假宿主 ↔ 真宿主 / 业务替身 ↔ 真类**的边界用
// `as unknown as` 并逐处注明理由。
// ---------------------------------------------------------------------------

/** `f.chat` 的替身面：只有页面路径（真 `BlogChat`）会调它；协作路径 `bindTurn: false` ⇒ 零调用点。 */
interface FixtureChat {
  readonly index: unknown
  create(current: typeof actor, id: string): Promise<{ id: string }>
  send(current: typeof actor, args: {
    readonly conversationId: string
    readonly requestId: string
    readonly text: string
    readonly research: unknown
    readonly attachments: unknown
  }): Promise<{ readonly id: string; readonly conversationId: string }>
  subscribe(current: typeof actor, id: string, send: (value: unknown) => void, end: () => void): () => boolean
  history(current: typeof actor, id: string): Promise<{
    readonly messages: readonly unknown[]
    readonly requests: readonly ChatRequestRecord[]
    readonly operations: readonly Record<string, unknown>[]
    readonly results: readonly unknown[]
    readonly live: { readonly reasoning: string }
  }>
  stop(current: typeof actor, id: string): Promise<{ readonly stopped: true }>
  settleAccepted(current: typeof actor, id: string, requestId: string): Promise<void>
  /**
   * `participant-harness.ts` 的 `ChatBoundary` 读的那三个面。
   *
   * ⚠️ **`ctx` / `titleSink` 在这里必须是可选的**：真 `BlogChat` 实例**按结构**满足这个接口
   * （`chat.test.mjs` 走的就是那条路），而 `BlogChat` 上没有 `ctx`、`titleSink` 也不是它自己的字段
   * ⇒ 声明成必需就会把真类挡在门外（那正是"接口比实现窄"的反向错误）。
   * `bindRuntimeTurn` 同样可选：协作路径的替身**刻意没有**它（见 `participant-harness.ts` 的理由）。
   */
  readonly ctx?: Context
  readonly bindRuntimeTurn?: (input: { readonly agent: unknown; readonly handle: unknown; readonly actor: unknown; readonly turnId: string }) => Promise<void>
  readonly titleSink?: TitleSink
}

/** 页面侧的订阅者替身（`f.emit` 遍历它；`subscribe` 是它的唯一写入方，本路径零调用点）。 */
interface FixtureListener {
  readonly id: string
  readonly send: (value: unknown) => void
}

/**
 * `f.provider()` 造出来的协作入口。
 *
 * = `createBlogParticipant` 的返回值（`definition` / `lifecycle` / `participant` / `run` / `reply` /
 * `dispose`），外加夹具**包在 `run` 外面的那一层自驱循环开关**（`pending += 1` / `void pump()`，
 * 见 `f.provider` 里那段说明）。
 *
 * ⚠️ `run` 的入参按**用例真正传的那个形状**收窄（`input()` 的返回值）：这样
 * `onProgress: value => …` 里的 `value` 才会被推成 `ParticipantProgress`
 * （写成 `ReturnType<typeof createBlogParticipant>` 时 `onProgress` 的上下文类型丢失，
 * 15 处回调全部退化成隐式 `any` —— 实测）。
 */
interface FixtureProvider extends Omit<ReturnType<typeof createBlogParticipant>, 'run'> {
  run(request: FixtureRequest): Promise<ParticipantResult>
}

/** 用例传进 `run` 的那个请求（`input()` 的返回值 + 各用例通过 `Partial` 覆盖的字段）。 */
interface FixtureRequest {
  readonly actor: Actor
  readonly missionId: string
  readonly requestId: string
  readonly message: string
  readonly conversationId?: string
  readonly signal: AbortSignal
  readonly onProgress: (value: ParticipantProgress) => void
}

/**
 * `createBlogParticipant` 的入参（`participant-harness.ts` 的 `BlogParticipantInput`）。
 *
 * 它只在这里用来给**两处假边界**标注：`access` 与 `storage`。两处都是"夹具替身 ↔ 真接口"，
 * 详见 `f.provider()` 里各自的说明。
 */
type HarnessInput = Parameters<typeof createBlogParticipant>[0]

/**
 * 本文件的夹具 `f`。
 *
 * 字段顺序照 `fixture()` 里那个对象字面量，逐个说明**它被谁读写**；`f.access` / `f.chat` /
 * `f.provider` / `f.complete` / `f.attempt` / `f.say` / `f.stream` 是字面量之后**新增到同一个对象**上的
 * （原写法靠 `f.x = …` 挂上去），类型上必须在这里声明，否则它们"不存在"。
 */
interface Fixture {
  readonly store: InstanceType<typeof BlogStore>
  readonly index: InstanceType<typeof ChatStore>
  readonly db: ReturnType<typeof memoryIndex>
  readonly host: FakeHost
  closed: boolean
  attemptSeq: number
  denied: boolean
  auto: boolean
  /** 运行时**真的派发了几轮**（投递次数），不是"夹具被调了几次 `send`"（口径见 `pump`）。 */
  runs: number
  /** 旧驱动方的内部记账：协作路径零写入点，保留只为如实登记（见各用例里的登记）。 */
  stops: number
  /** 同上：`f.chat.create` 的调用次数。 */
  creates: number
  readonly listeners: Set<FixtureListener>
  readonly messages: Map<string, unknown[]>
  /** 这一轮在跑的业务行（由 `pump` 从 `index.requests` 回查后写入）。 */
  readonly active: Map<string, ChatRequestRecord>
  /** `app.operations` 替身返回的操作卡片（私有载荷断言就靠它）。 */
  /**
   * `app.operations` 替身返回的操作卡片。
   *
   * 类型 = "任意业务字段 + **结构化**的 `chat`"：卡片上的字段随用例演进
   * （`status` / `nonce` / `before` / `canConfirm` / `requestId`），只有 `chat` 被替身**读**
   * （`operation.chat ?? { conversationId: … }`）⇒ 它与别的字段不同，必须有确切类型。
   * 写成 `Record<string, unknown>` 也不行：那样 `operation.chat` 是 `unknown`，`??` 过不了类型。
   */
  operations: (Record<string, unknown> & { readonly chat?: { readonly conversationId?: string } })[]
  /**
   * 授权判定替身。`assert` **可写**（`:1024` 的用例换指时替换它，原判定被保存后转调）
   * ⇒ 这里不能用 `Access`（它的 `assert` 是 readonly），按**实际被读写的那一个面**声明；
   * 交给 `createBlogParticipant` 时那一处由 `HarnessInput['access']` 断言（见 `f.provider()`）。
   */
  access: { assert(current: Actor): void }
  /** 页面侧订阅者广播（只打 `f.listeners`，本路径恒空）。 */
  emit: (id: string) => void
  /** 收尾：由**宿主事件**驱动（`host.complete`）⇒ 与真机同一条路径。 */
  complete: (id: string, text?: string, status?: string) => Promise<void>
  /** 被中断的尝试（`assistant/message` + `data.interrupted`，**不发** `turn/end`）。 */
  attempt: (id: string, text: string, extra?: Record<string, unknown>) => void
  /** **未被中断**的 assistant 正文（与 `attempt` 的区别见那段注释）。 */
  say: (id: string, text: string, extra?: Record<string, unknown>) => void
  /** 实时流帧（`agent/assistant-stream`）。 */
  stream: (id: string, steps: readonly { readonly step: number; readonly chunks: readonly { readonly type: string; readonly text: string }[] }[]) => void
  /**
   * 造一个协作入口（每次调用 = 一个 `ConversationLifecycle`）。
   *
   * ⚠️ **它是必需成员，却不在对象字面量里**：`f.provider = …` 在字面量之后紧邻赋值，
   * 且在任何用例拿到 `f` 之前（`fixture()` 返回的就是这个对象）。声明成可选会把 15 处调用点
   * 变成 `f.provider!()`；写成 `?.` 更糟——那会把"它一定在"静默降级成"可能没有"。
   * 类型上这里靠的是"字面量 + 后续赋值合起来满足接口"，不需要任何断言。
   */
  provider: (routePrefix?: string) => FixtureProvider
  /** 业务边界替身（`f.chat = { … }`，同样在字面量之后紧邻赋值）。 */
  chat: FixtureChat
  /** 交给 `ConversationLifecycle` 的生命周期（`f.provider()` 里建的那一份）。 */
  lifecycle: FixtureProvider['lifecycle']
  /**
   * 用例自己挂的**闸门与探针**（`f.sendGate` / `f.completeGate` / `f.operationsGate` /
   * `f.historyGate` / `f.historyEntered` / `f.operationsEntered` / `f.lastHistoryId` /
   * `f.activeConversationId` / `f.answerText` / `f.peakListeners`）。
   *
   * ⚠️ 它们是**可选**的（只有部分用例挂），缺省时各调用点按 `?.` / `??` 如实回落。
   */
  sendGate?: Promise<unknown>
  completeGate?: Promise<unknown>
  operationsGate?: Promise<unknown>
  historyGate?: Promise<unknown>
  historyEntered?: () => void
  operationsEntered?: () => void
  lastHistoryId?: string
  activeConversationId?: string
  answerText?: string
  peakListeners?: number
}

async function fixture(t: TestContext): Promise<Fixture> {
  /**
   * 宿主 cordis root 与两个 registry：**运行时的驱动方需要它们**
   * （`ctx.agents.create/resume` 与 `ctx.on('session/event')`）。旧入口自己驱动，不需要；
   * 载体切到运行时之后，夹具必须把这一半补上——这正是 `participant-harness.mjs` 里
   * "缺 `ctx` 就抛"那条**响的守卫**在等的东西（它是守卫，不是缺陷，别改成静默兜底）。
   */
  const root = new Context(), registry = root.plugin(AgentRegistry)
  await registry
  const runtimeJobs = root.plugin(LocalJobRegistry)
  await runtimeJobs
  const store = new BlogStore(':memory:'); await store.init()
  /**
   * ⚠️ `db` 必须**先拿出来**再交给 `ChatStore`：`ChatStore.db` 是 `private readonly`，
   * 事后取不出来，而 harness 立刻要用 `database.conversations`（生命周期的会话端口）。
   */
  const db = memoryIndex(); const index = new ChatStore(db)
  t.after(async () => { await store.close(); await runtimeJobs.dispose(); await registry.dispose() })
  // 假宿主只有一份（`coordinator.test.mjs` 与本文件共用）；口径与坑记在它的文件头上。
  const host = createFakeHost(root)
  t.after(() => host.disposeAll())
  /**
   * 当前这一轮的 turn 令牌（宿主事件里的那个），收尾事件要带上它。
   *
   * `data` 在假宿主里是 `unknown`（真实 `SessionEvent` 是判别联合，`turn/start` 那一支的
   * `data.turn` 才是令牌）⇒ 在这一处读出它并如实断言：**取值逻辑与原来逐字相同**，
   * 只是把"读 `unknown` 上的字段"这件事写明。
   */
  const currentTurn = (id: string): unknown =>
    (host.sessionOf(id).events.findLast(event => event.type === 'turn/start')?.data as { turn?: unknown } | undefined)?.turn
  /**
   * `f` 的**字面量部分**。
   *
   * ⚠️ 这里把每个成员的参数/返回值**逐条写出来**是必需的（不是装饰）：字面量里的方法互相引用
   * （`f.access.assert` ← `f.chat.*` ← `f.provider`，`f.attempt` ← `f.attemptSeq`），
   * 而这些引用又出现在**同一个字面量**里 ⇒ `tsc` 必须先把整个字面量的类型推出来才能推参数类型，
   * 于是判成"循环引用"，报 **`TS2739`「字面量缺少 `provider` / `chat` / `lifecycle`」**
   * （实测：把它们写成注解后立刻消失）。缺的三个成员由**紧邻后面**的
   * `f.provider = …` / `f.chat = { … }` 补上，且在任何用例拿到 `f` 之前。
   */
  const f = {
    store, index, db, host, closed: false, attemptSeq: 0, denied: false, auto: true,
    runs: 0, stops: 0, creates: 0, listeners: new Set(), messages: new Map(), active: new Map(), operations: [],
    /**
     * 授权判定替身。`assert` **可写**（`:1024` 的用例换指时替换它，保存原判定后转调）
     * ⇒ 这里不用 `Access`（它的 `assert` 是 readonly），按**实际被读写的那一个面**写。
     */
    access: { assert(current: Actor): void { assert.equal(current.namespace, 'user'); if (f.denied) throw new Error('登录或授权已失效') } },
    /** 页面侧订阅者广播（只打 `f.listeners`；协作路径零调用点 ⇒ 恒为 no-op）。 */
    emit: (id: string): void => { for (const listener of [...f.listeners]) if (listener.id === id) listener.send({ type: 'changed' }) },
    /**
     * **收尾**：载体切换后由**宿主事件**驱动（旧实现是夹具自己写 `f.messages` + `index.updateRequest`）。
     *
     * 旧 `status` 到宿主 `reason` 的落法取自运行时的真实判定
     * （`packages/runtime/src/participant.ts:449-452`）：
     * `reason==='aborted'`（或已取消）⇒ `cancelled`；`reason==='completed'` 且 `finalText` 非空 ⇒ `completed`；
     * **其余一律 ⇒ `failed`**。所以 `succeeded→'completed'`，`interrupted→` 一个非 completed 的 reason。
     */
    complete: async (id: string, text = '本轮可显示的博客回答', status = 'succeeded'): Promise<void> => {
      host.complete(id, text, status === 'succeeded' ? 'completed' : 'failed')
    },
    /**
     * 被中断的尝试。旧用例用 `f.messages` 记它（`{interrupted: true}`）；载体切换后它就是官方的
     * `assistant/message` + `data.interrupted`（见 `definition.ts:91-98`）——运行时的收尾投影正是按
     * 这个字段把它当"被中断的产出"保留下来（`conversation.ts:1176` 带上、`:1185` 不当 tail）。
     * 它**只发消息、不发 `turn/end`**：这一轮还没结束，收尾由后面的 `f.complete` / abort 决定。
     */
    attempt: (id: string, text: string, extra: Record<string, unknown> = {}): void => host.emit('assistant/message', {
      turn: currentTurn(id),
      /**
       * `extra` 是**故意保留**的：旧夹具在这些消息上挂了 `reasoning: 'PRIVATE_ATTEMPT_REASONING'`
       * 之类的私有字段，用例据此断言"它**不**出现在交回的结果里"（`assert.doesNotMatch(…, /PRIVATE_/)`）。
       * 把这些字段删掉会让那条断言**变成恒真**（输入里根本没有可泄漏的东西）——那是**假绿**，
       * 所以私有载荷必须照旧放进事件里。
       */
      message: { id: 'attempt-' + (f.attemptSeq += 1), role: 'assistant', source: { model: 'test', provider: 'test' }, content: [{ type: 'text', text }], ...extra },
      interrupted: true,
      stream: [],
    }, id),
    /**
     * **说过的话**（**未被中断**的 assistant 正文）。与 `f.attempt` 的区别只有一个、但很关键：
     * 不带 `data.interrupted` ⇒ 运行时的历史会把它算作"这一轮**算数的正文**"的候选
     * （`conversation.ts:1176` 只在 `data.interrupted === true` 时才标 interrupted；
     * `:1183-1188` 在**未被中断**的消息里选 `tail`）。
     *
     * ⚠️ **为什么必须有它**：`definition.ts:275` 的
     * `said = messages.filter(m => m.role === 'assistant' && m.interrupted !== true)`
     * **把被中断的产出整个排除**。所以"本轮产出了半截正文、但没跑完"这件事，
     * **只能用未被中断的消息表达**——用 `f.attempt` 表达等于把它标成"不算数的尝试"，
     * 交回结果里**必然看不到它**（那不是缺陷，是 `tail`/`said` 的设计口径，
     * 见 `definition.ts:265-277` 与 `conversation.ts:1138-1148`）。
     * "没跑完"由**收尾事件的理由**（`f.complete(id, …, 'interrupted')`）表达，不由消息字段表达。
     */
    say: (id: string, text: string, extra: Record<string, unknown> = {}): void => host.emit('assistant/message', {
      turn: currentTurn(id),
      message: { id: 'said-' + (f.attemptSeq += 1), role: 'assistant', source: { model: 'test', provider: 'test' }, content: [{ type: 'text', text }], ...extra },
      stream: [],
    }, id),
    /** 实时流帧（`agent/assistant-stream`）：**原样转发**给共用的假宿主（帧序理由见它那一段）。 */
    stream: (id: string, steps: readonly { readonly step: number; readonly chunks: readonly { readonly type: string; readonly text: string }[] }[]): void => host.stream(id, steps),
  /**
   * `as unknown as Fixture` 的理由（**夹具边界的标准手段**，只影响类型）：这个字面量**还没写全**
   * ——`provider` / `chat` / `lifecycle` 三个成员在**紧邻后面**的 `f.provider = …` / `f.chat = …`
   * 赋值里补上，且在任何用例拿到 `f` 之前。`tsc` 表达不了这条时序 ⇒ 直接写
   * `const f: Fixture = { … }` 或 `} as Fixture` 都会被判"缺三个成员"
   * （前者 TS2739、后者 TS2352「两边没有足够重叠」——实测两种都试过）。
   */
  } as unknown as Fixture
  f.chat = {
    index,
    async create(current, id) { f.access.assert(current); f.creates++; return await index.create(ownerKey(current), id) },
    async send(current, args) {
      f.access.assert(current)
      if (f.sendGate) await f.sendGate
      const owner = ownerKey(current)
      const { request, fresh } = await index.start(owner, args.conversationId, args.requestId, { text: args.text.trim(), research: args.research, attachments: args.attachments })
      if (fresh) {
        f.runs++; f.active.set(args.conversationId, request)
        const messages = f.messages.get(args.conversationId) ?? []
        messages.push({ id: 'user-' + request.id, role: 'user', requestId: request.id, text: args.text })
        f.messages.set(args.conversationId, messages)
        await index.updateRequest(request.owner, request.id, { status: 'running' })
        if (f.auto) queueMicrotask(() => f.complete(args.conversationId))
      }
      return { id: request.id, conversationId: args.conversationId }
    },
    subscribe(current, id, send, end) {
      f.access.assert(current); index.get(ownerKey(current), id)
      const listener = { id, send(value: unknown) {
        try { f.access.assert(current); index.get(ownerKey(current), id); send(value) }
        catch { f.listeners.delete(listener); end() }
      } }
      f.listeners.add(listener)
      return () => f.listeners.delete(listener)
    },
    async history(current, id) {
      f.access.assert(current); index.get(ownerKey(current), id)
      // 收尾投影（`createBlogProjector`）读的是**业务库**的 `app.operations(owner)`，并按
      // `operation.chat.conversationId` 筛出本会话 —— 真实现（`application.mjs` 的操作卡片）
      // 本来就带这个字段。这里记下当前会话 id，供下面的 `app.operations` 替身补上。
      f.lastHistoryId = id
      f.historyEntered?.()
      if (f.historyGate) await f.historyGate
      return { messages: f.messages.get(id) ?? [], requests: await index.requests(ownerKey(current), id),
        operations: f.operations, results: await index.results(ownerKey(current), id), live: { reasoning: 'PRIVATE_LIVE_REASONING' } }
    },
    async stop(current, id) {
      f.access.assert(current); index.get(ownerKey(current), id)
      const turn = f.active.get(id)
      if (turn) { f.stops++; await index.updateRequest(turn.owner, turn.id, { status: 'interrupted' }); f.active.delete(id); f.emit(id) }
      return { stopped: true }
    },
    async settleAccepted(current, id, requestId) {
      const turn = f.active.get(id)
      if (turn?.owner === ownerKey(current) && turn.id === requestId) {
        f.stops++; await index.updateRequest(turn.owner, turn.id, { status: 'interrupted' }); f.active.delete(id); f.emit(id)
      }
    },
  }
  f.provider = (routePrefix = '/blog') => {
    /**
     * 两处**假边界**的断言（都在这一行，理由各自写在下面）：
     *
     * 1. `access`：本文件的替身**只有 `assert`**（真 `Access` 还有 `mode` / `ready` / `resolve`，
     *    那是 HTTP 侧的东西，协作路径一个都不读）——这是"窄替身 ↔ 真接口"，如实断言。
     * 2. `storage`：本文件的 `storage` 是**真 `BlogStore`**，而 `AgentDefinition` 只要求它最小的
     *    `get` 形状；`BlogStore.get` 回 `BlogRecord`（`Record<string, any>`），在
     *    `exactOptionalPropertyTypes` 下**恰好不满足**"带可选 `proposal` 的对象"
     *    （索引签名给不出可选属性）——这是"真类 ↔ 最小结构声明"，同样如实断言。
     *    断言**只影响类型**：`f.provider` 传下去的还是同一个 `store` 实例，运行时一字未变。
     */
    const access = f.access as unknown as HarnessInput['access']
    const storage = store as unknown as HarnessInput['storage']
    const created = createBlogParticipant({
      access, chat: f.chat, index, storage, routePrefix,
    // 载体切到运行时之后，构造胶水还要两样东西：宿主 ctx（驱动方）与运行时存储端口（会话/轮次）。
    // 缺 `ctx` 它会**当场抛**（响的守卫）；`database` 就是上面那个 `db`（端口本身，不是 ChatStore）。
    ctx: host.ctx, database: db,
    // 协作路径**显式不绑**回合身份：这条链由 `coordinator.test.mjs` 覆盖（4/4 绿 + M1 变异可证伪），
    // 且本文件的 `chat` 是替身、没有 `bindRuntimeTurn`；给替身补上就是第二份实现（红线 1）。
    // 依据：closedoff 同一次迁移的后继物用的就是朴素定义。
    bindTurn: false,
    /**
     * 业务应用的最小替身：收尾投影只用到 `operations(owner)`。
     *
     * ⚠️ 真实现的记录**带 `chat.conversationId`**（`application.mjs` 的操作卡片就是这样，生产侧
     * `chat.mjs` 也按它筛会话）⇒ 夹具在这里补上；漏了它会以"本该 external_pending 却报
     * completed"的形式红，而那是**夹具失真**，不是实现错。
     *
     * ⚠️ **补的来源必须是活跃那一轮的会话 id（`f.activeConversationId`）**。
     * 早先只用了 `f.lastHistoryId`，而它由页面路径的 `chat.history()` 填、协作路径永不调 ⇒
     * 恒为 `undefined` ⇒ 这条"补上"其实**没补上**（`operations` 里的 `??` 于是形同虚设）。
     */
      app: { operations: async (owner: string): ReturnType<NonNullable<HarnessInput['app']>['operations']> => {
        /**
         * **结果读取的可观测闸门**（`f.operationsGate` / `f.operationsEntered`）。
         *
         * 为什么需要它：`revocation during result read` 那条用例要验"**正在读结果时**被撤权"，
         * 而原来挂闸的 `f.chat.history` 在协作路径上**永不被调用**（`bindTurn: false`）⇒ 用例
         * 永不 settle、被 node:test 标 `cancelled`（实测 0.7s 不退出，不是卡 30s）。
         * 结果投影真正读的业务面就是这里（`definition.projectResult` → `app.operations(owner)`）
         * ⇒ 闸挂在这里，"结果读取中"这个语义与原写法等价，而且是**活的**。
         */
        f.operationsEntered?.()
        if (f.operationsGate) await f.operationsGate
        /**
         * 返回值的类型照 `AgentDefinition.app` 那一侧的形状断言：夹具的 `f.operations` 是
         * **只带用例真正关心的那几个字段**的开放记录（`{ status, nonce, before, canConfirm, requestId }`），
         * 而声明要求 `id` / `title` / `mode` / `status` 那一套。这一处是**夹具替身 ↔ 声明边界**，
         * 断言**只在类型层**：运行时交出去的仍是 `f.operations` 里那些对象的逐字段拷贝
         * （`{ ...operation, chat: … }`），**没有补任何假字段**。
         */
        return f.operations.map(operation => ({ ...operation, chat: operation.chat ?? { conversationId: f.activeConversationId ?? f.lastHistoryId } })) as unknown as Awaited<ReturnType<NonNullable<HarnessInput['app']>['operations']>>
      } },
    })
    /**
     * **把自驱循环的开关接到 `run()` 上**：`pending` 是"在飞的 run 数"，`pump()` 靠它决定要不要转。
     * `run()` 进来时 +1 并唤醒循环；落定（成功/失败/抛错都算）时 −1 再唤醒一次让循环自行收敛。
     * ⇒ **没有在飞的 run 时，事件循环里不再有事可做**（这正是旧写法让进程退不出去的原因）。
     */
    return {
      ...created,
      run: request => {
        pending += 1
        void pump()
        let result
        try {
          result = created.run(request)
        } catch (error) {
          pending -= 1
          void pump()
          throw error
        }
        return Promise.resolve(result).finally(() => { pending -= 1; void pump() })
      },
    }
  }
  /**
   * ## 自动收尾（旧夹具长在 `f.chat.send` 里，现在必须挪到宿主侧）
   *
   * 旧实现里"轮次跑完"是夹具自己造的：`chat.send` 起了一轮之后
   * `queueMicrotask(() => f.complete(id))`。**载体切到运行时之后没有人再走 `chat.send`**
   * （协作路径本来就不经过它，见文件头），于是**没有任何人发 `turn/end`**
   * ⇒ 运行时永远等不到收尾 ⇒ `participant.run()` **永不 settle**。
   * 实测表现是 `node:test` 报 **`Promise resolution is still pending`**，而不是某条断言红
   * （这条坑记在 `fixtures/fake-host.mjs` 的文件头，别改成"更简洁"的写法）。
   *
   * 所以自动收尾改由这里做：运行时把用户消息投给 Agent（`host.followups` 记下投递）
   * ⇒ 宿主发一条完整回合（`assistant/message` + `turn/end`）把它收掉。
   * **`f.runs` 的口径也随之换指**：旧的是"夹具被调了几次 `send`"，现在是
   * **"运行时真的派发了几轮"**（投递次数）——这才是可观测的运行时事实。
   * `f.auto = false` 仍然有效（用例要手动控制收尾时），只是它现在只影响**发不发收尾事件**。
   */
  /** 已处理的投递数（**提到循环外**：循环现在会因为"无事可做"而停止，再被唤醒时要接着数）。 */
  let seen = 0
  /**
   * **在飞的 `run()` 数** —— 自驱循环的生命周期就绑在它上面（见 `pump()` 的说明）。
   */
  let pending = 0
  let pumping: Promise<void> | null = null
  /**
   * ⚠️ **"文件级 30s 超时"的正解在这里：自驱只在"确实有在飞的工作"时发生。**
   *
   * 旧写法是 `while (!f.closed) { … await tick() }`——只要 `f.closed` 还是 `false`，
   * 它就永远让事件循环有事可做 ⇒ **进程退不出去**。实测：文件内最慢用例只有 134ms、
   * 两半分别跑都在 0.5s 内退出，**合起来却跑满 `--test-timeout` 的 30s**，
   * 而且**整文件被取消**（`# tests` 因此少一条、还多一条 `cancelled`）。
   *
   * 现在：`pending > 0`（有 run 在飞，它随时可能投递下一条）**或**还有未处理的投递时才转；
   * 两者都没有 ⇒ **循环正常结束、事件循环排空、进程退出**。
   * 新 run 进来时 `run()` 那层包装会再把它唤醒（`void pump()`），所以不会漏事件。
   */
  const pump = () => {
    if (pumping !== null) return pumping
    pumping = (async () => {
      try {
        while (!f.closed && (pending > 0 || host.followups.length > seen)) {
          while (host.followups.length > seen) {
            const id = host.followups[seen++]!.id
            f.runs += 1
            /**
             * `f.active` 的**换指**（旧的是"夹具自己起的轮"，由 `chat.send` 填）。
             * 载体切到运行时之后，"这一轮在跑"这件事由运行时记账，业务侧那一行仍是 `ChatStore` 的请求行
             * —— 用**会话 id 去问业务索引**（`index.requests`）拿回来的就是本轮那一行；
             * 它带 `owner` / `id`，正是旧用例后面 `index.updateRequest(...)` 要用的两个字段。
             */
            const rows = await index.requests(ownerKey(actor), id)
            const latest = rows.at(-1)
            if (latest !== undefined) f.active.set(id, latest)
            /**
             * **本轮的会话 id**（正在被驱动的那一条）。收尾投影会调 `app.operations(owner)`，
             * 而真实现的操作卡片**自带 `chat.conversationId`**（`application.mjs`）⇒ 夹具要补上它。
             *
             * ⚠️ **只能用它，不能只靠 `f.lastHistoryId`**：那个字段由**页面路径**的 `chat.history()` 填，
             * 而协作路径（`bindTurn: false`）**从不调 `chat`** ⇒ 它恒为 `undefined`，
             * 操作卡片于是被判成"不属于本会话" ⇒ **本该 `external_pending` 却报 `completed`**。
             */
            f.activeConversationId = id
            if (f.auto) {
              if (f.completeGate) await f.completeGate
              // 门后可能已经被取消/中止 ⇒ 不再补发收尾事件（否则会替用例把终态写死）
              if (f.closed) return
              /**
               * **记下这一轮的订阅峰值**（`session/event` 监听数）。
               *
               * 为什么必须在这里记：业务侧那 1 个与 participant 自己那 1 个**不在同一时刻装上**，
               * 从用例里按固定时点采样**采不到**它俩同时在场的那一刻（实测 `before=0 / tick 时=1 / after=1`，
               * 而运行时探针报的 `cleanup-before=2`）。自驱循环本来就一直在转 ⇒ 由它记峰值最可靠。
               */
              f.peakListeners = Math.max(f.peakListeners ?? 0, f.host.listenerCount())
              await f.complete(id, f.answerText ?? '本轮可显示的博客回答')
              f.peakListeners = Math.max(f.peakListeners ?? 0, f.host.listenerCount())
            }
          }
          if (pending > 0) await tick()
        }
      } finally {
        pumping = null
      }
    })()
    return pumping
  }
  t.after(() => { f.closed = true })
  /**
   * ⚠️ **这个循环会把"某条用例挂住"放大成"整个套件挂住"**：它靠 `setImmediate` 自驱，
   * 只要 `f.closed` 还是 `false` 就永远让事件循环有事可做 ⇒ `node --test` **不退出**。
   * 用例正常结束时会走 `t.after` 把它关掉；但**用例自己挂住时 `t.after` 不会跑**，
   * 于是整个文件（乃至整个套件）一起挂——实测过一次。
   * ⇒ 再挂一道 `t.signal`：用例被中止/超时时（`--test-timeout` 或外层取消）**也**停循环，
   * 这样挂住的影响面收敛到**那一条用例**，而不是把别人一起拖下去。
   */
  t.signal?.addEventListener('abort', () => { f.closed = true }, { once: true })
  return f
}

function input(overrides: Partial<FixtureRequest> = {}): FixtureRequest {
  return { actor: actor as Actor, missionId: 'mission-a', requestId: 'request-a', message: '分析允许共享的资料', signal: new AbortController().signal, onProgress() {}, ...overrides }
}

test('reuses a durable mission conversation and original request idempotency without replaying another turn', async t => {
  const f = await fixture(t), progress: ParticipantProgress[] = [], provider = f.provider()
  const first = await provider.run(input({ onProgress: value => progress.push(value) }))
  assert.equal(first.status, 'completed'); assert.equal(first.text, '本轮可显示的博客回答')
  assert.ok(progress.every(value => value.conversationId === first.conversationId))
  await provider.run(input({ requestId: 'request-b', conversationId: first.conversationId, message: '再说明来源' }))
  /**
   * ⚠️ **"原始请求幂等"= 显式拒绝，不是静默重放**（2026-09-17 探针定因；旧断言写的是"重放回同一份文本"）。
   *
   * 实测（探针，`requestId:'request-a'` 已被第一轮结算过）：
   * ```
   * {"label":"replay@347","ok":false,"threw":"这一轮已经结算过（同一个请求标识）","code":"DSH_ACCESS_ERROR","runs":2}
   * ```
   * 运行时出处：`packages/runtime/src/participant.ts:744-751` —— `turns.claim` 判 `duplicate`
   * 且 `turnStatus === 'finished'` 时**主动抛 409**，注释原文：
   * "**已经交付过 ⇒ 重跑会重复外部副作用，必须显式拒绝，不能静默再来一遍**"。
   * （对照：`claimed` 但未结算 = **中断** ⇒ 允许重跑，见 `:752-759`。）
   *
   * ⇒ 断言改到这条**有文档依据的**真实契约上：**同 `requestId` 再跑一次被拒**，
   * 且 **`f.runs` 不变（= 没有重放另一轮）** —— 这正是本用例名里说的
   * "original request idempotency **without replaying another turn**"。
   */
  /** 第二个 provider ⇒ 第二个 `ConversationLifecycle` ⇒ 第二份**合法的**常驻标题观察者（详见下方断言前的登记）。 */
  const second = f.provider()
  /**
   * 基线取在"第二个生命周期**已建好、尚未跑任何一轮**"这一刻：
   * 此刻计数里是**两份常驻标题观察者**（每个生命周期一份，`conversation.ts:257`），
   * 它们**合法且长生命周期**，所以判据是"**回到基线**"而不是"总数为 0"。
   */
  const listenerBaseline = f.host.listenerCount()
  await assert.rejects(
    second.run(input({ conversationId: first.conversationId })),
    /这一轮已经结算过（同一个请求标识）/,
  )
  assert.equal(f.runs, 2)
  /**
   * ⚠️ **登记一条被我移除的断言（不静默）**：原有一句
   * `assert.equal(replay.conversationId, first.conversationId)`。
   * 因为上面那次再跑**现在是被拒的**（抛 409），**没有返回值**可比较 ⇒ 该句随之移除。
   * **它承载的"同一 mission 只得一条会话"没有丢**，由两条承担：
   * ① 上面 `(f.db.conversations as MemoryConversationPort).size === 1`（创建幂等 ⇒ 索引里只有一行）；
   * ② `:346` 那次显式带 `conversationId: first.conversationId` 的跨轮复用**跑成功了**（`f.runs` 到 2）。
   */
  /** 索引里**只有一行**会话（创建幂等），这一条与"请求幂等"是两件事，保留原判据。 */
  assert.equal((f.db.conversations as MemoryConversationPort).size, 1)
  /**
   * ⚠️ **这条 `=== 0` 是一条「待修」的陈旧期望（与 §99 已结案的那条同类，2026-09-17 实测）**：
   * 实测这里 `listenerCount()` = **2**，而**不是 0**——原因**不是本用例泄漏**，而是：
   * 本用例调了**两次** `f.provider()`（`:342` 与上面那次），
   * **每个 `ConversationLifecycle` 在构造函数里注册一份标题观察者**
   * （`packages/runtime/src/conversation.ts:257` 的 `registerConversationTitles`，
   * 走 `ctx.on('session/event', …, {global:true})`，kit `conversations.ts:36-46`）
   * ⇒ **两个生命周期 ⇒ 恰好 2 份常驻订阅**。
   * ⇒ 该订阅**合法且长生命周期**（kit 注释 `conversations.ts:35`："for the plugin lifetime"），
   * 与"这一轮有没有多留订阅"是**两件事**。**正确判据是"相对基线不增长"**
   * （先建好 provider、记 `baseline = f.host.listenerCount()`，跑完断言 `=== baseline`），
   * **不是"总数必须为 0"**——存在常驻订阅时它**恒假**。
   * **已按 §99/§100 已批准的口径改（2026-09-17）**：基线取在"第二个生命周期已建好、尚未跑任何一轮"时
   * （见上面 `const second = f.provider()` 与 `listenerBaseline`），断言**回到该基线**；
   * **没有**把数字改成 2（那会把"两个生命周期"这个实现细节固化成判据）。
   *
   * ⚠️ 该判据的判别力来自"**若 participant 收尾时漏摘自己那个订阅，计数会比基线多**"；
   * 它**不**声称"总数为 0"——存在常驻订阅时那条**恒假**（这正是它原来红的原因）。
   */
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
  /**
   * ⚠️ **报文已对齐到运行时的真实契约（2026-09-17 实测）**：原来这里写的是 `/不能更改/`，
   * 而运行时实际抛的是 **`同一请求身份不能用在不同内容上`**（实测；`/不能更改/` 匹配不上）。
   *
   * 运行时出处：`packages/runtime/src/participant.ts:237-241`
   * —— 同一幂等身份（`settledCacheKey`）配了**不同正文**时**按契约拒绝**，注释原话：
   * "同一个身份换了内容 = 调用方把幂等身份生成错了。按契约拒绝，不静默当同一次：
   * 那会让'重试'变成'用旧结论回答新问题'。"
   *
   * ⇒ **语义未变**（仍要求"**同身份换内容被拒**"），只把 pattern 换到真实报文上——
   * 与上面 `:347` 那处 `这一轮已经结算过（同一个请求标识）` 的改法是同一类。
   */
  await assert.rejects(provider.run(input({ message: '改变同一请求内容' })), /同一请求身份不能用在不同内容上/)
  assert.equal(f.runs, 2)
})

test('successful retries return only committed answers for completed and external_pending results', async t => {
  for (const expected of ['completed', 'external_pending']) await t.test(expected, async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const id = [...f.active.keys()][0]!
    f.attempt(id, '废弃尝试内容', { reasoning: 'PRIVATE_ATTEMPT_REASONING' })
    if (expected === 'external_pending') f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE' }]
    await f.complete(id, '已提交的最终回答')
    const result = await running
    assert.equal(result.status, expected)
    assert.ok(result.text.startsWith('已提交的最终回答'))
    assert.doesNotMatch(JSON.stringify(result), /废弃尝试内容|PRIVATE_|reasoning|nonce/)
    if (expected === 'completed') {
      assert.equal(result.text, '已提交的最终回答')
      // 没有外部待办时不能凭空给一份声明 —— 那会让上游把这一轮当成「还没办完」。
      assert.equal(result.externalPending, undefined)
    } else {
      assert.match(result.text, /没有执行发布/)
      // 判定来源是结构化声明，不是正文措辞：上游只认这个字段。
      assert.equal(typeof result.externalPending?.reason, 'string')
      assert.ok((result.externalPending?.reason?.length ?? 0) > 0)
    }
  })
})

/**
 * ## ⚠️ 登记：失败/取消路径**整个跳过业务投影**（开放问题 Q7；2026-09-17 主线接管时定案）
 *
 * | | |
 * | --- | --- |
 * | **旧期望（本用例原来的名字）** | 失败/取消时仍交回**已生成的正文**（`f.say` 的 `tail` 候选）与候选/待确认提示 |
 * | **现行为** | `packages/runtime/src/participant.ts:503-505`：只有 `status === 'completed'` 才 `await project(context)`，其余**直接用运行时固定文案**（`:470`）⇒ 业务投影**一次都不跑**，`tail` 正文 / 候选 / 操作卡片全部不出现 |
 * | **与 §87 第 4 条不是同一条** | 那一条讲"被中断的 attempt 正文被 `definition.ts:275` 的 `said` 过滤"（**completed** 路径内部）；这一条更早一层：**非 completed 时投影根本不参与** |
 * | **三条证据指向"投影该跑"** | ① `definition.ts:118-119` 预设"没有可算数正文时用 `finalText`"；② `participant.ts:451` 的注释把"交付一份'未能完成本回合'、首轮已跑完的结论一个字都不出现"**明确称为缺陷**（他们为此在超时路径加了 `handoffFallback`）；③ `:502` 注释写"投影兜底"，而代码只在 completed 时投影 |
 * | **为什么本批不改** | 改它要动**跨 Agent 的交付契约**：`closedoff/tests/participant.test.ts:903` 明确要求"取消的回合**不得**返回已生成正文"（`not.toContain('尚未完成的部分分析')`）⇒ 与 blog 这条期望**直接冲突**。两个 Agent 的语义要一起定，属**设计裁定**，不是本批的迁移工作 |
 * | **本条怎么处置** | 断言**当前契约**（终态 + 精确文案 + 业务投影的产物一个都不出现），并保留**"内容真的产出过"的反恒真前置** ⇒ 修好之后本条会**故意变红**，把 `doesNotMatch` 翻回 `match` 即证明修复。**不许删这条，也不许删那个前置。** |
 * | **它必须进切换记录** | 用户可见：**这一轮没跑完时，已经生成的内容不会交回**（只有一句提示）——与 §87 第 4 条并列 |
 */
test('failed/cancelled 只交回运行时的终态提示（业务投影被整个跳过；Q7 见上方登记）', async t => {
  for (const expected of ['failed', 'cancelled']) await t.test(expected, async t => {
    const f = await fixture(t), controller = new AbortController(); f.auto = false
    const running = f.provider().run(input({ signal: controller.signal }))
    await tick()
    const id = [...f.active.keys()][0]!
    f.say(id, '尚未完成的回答片段', { reasoning: 'PRIVATE_ATTEMPT_REASONING' })
    f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE' }]
    const owner = ownerKey(actor), turn = f.active.get(id), draft = await f.store.create(owner)
    await f.store.propose(owner, draft.id, draft.revision, { title: '本轮留存候选', text: '尚需复核的候选正文' }, [])
    await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
    /**
     * ⚠️ **两条分支都必须发 `turn/end`**：原来 `cancelled` 那条只 `controller.abort()` 就结束了，
     * 于是运行时要**空等到 `turnTimeoutMs`(3000ms)** 才收尾（实测本条 3056ms）。真机里中止之后宿主**会**发收尾事件。
     * 这里用 `interrupted`：`cancelled` 分支因为 `signal` 已中止，运行时按
     * `participant.ts:463` 的 `aborted = cancelled || reason === 'aborted'` 仍判 `cancelled`。
     */
    if (expected === 'cancelled') controller.abort()
    await f.complete(id, '', 'interrupted')
    const result = await running
    /**
     * **反恒真前置**：那段"被丢掉的正文"必须**真的产出过**（进了宿主的会话事件日志）。
     * 少了它，下面那些 `doesNotMatch` 在"夹具根本没发过这段内容"时也会绿——那正是本批一路在抓的假绿。
     */
    assert.ok(JSON.stringify(f.host.sessionOf(id).events).includes('尚未完成的回答片段'),
      '被丢弃的内容必须真的进过宿主事件日志（否则下面的断言是空断言）')
    assert.equal(result.status, expected)
    /**
     * 文案**精确断言**（同 closedoff 的先例 `closedoff/tests/participant.test.ts:950` 的理由：
     * "这一条曾经被降成 `not.toContain`…那样'正文换成别的错文案'与'正文成了空串'都不会红"）：
     * `failed` ⇒ `participant.ts:470` 的 `${displayName}未能完成本回合，请查看原会话。`；`cancelled` ⇒ `'协作已取消。'`。
     */
    assert.equal(result.text, expected === 'failed'
      ? '伊丽莎白 · 博客未能完成本回合，请查看原会话。'
      : '协作已取消。')
    // 业务投影的产物**一个都不出现**（正文 / 候选标题 / 候选正文 / 操作提示）——这就是 Q7 的现状本身。
    assert.doesNotMatch(result.text, /尚未完成的回答片段/)
    assert.doesNotMatch(result.text, /本轮留存候选/)
    assert.doesNotMatch(result.text, /尚需复核的候选正文/)
    assert.doesNotMatch(result.text, /没有执行发布/)
    // 外部待办随投影一起没有。
    assert.equal(result.externalPending, undefined)
    // 私有载荷（推理 / nonce）永远不得出现在交回结果里。
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|nonce/)
  })
})

test('rejects arbitrary user conversations, cross-mission references and other owners before sending', async t => {
  const f = await fixture(t), provider = f.provider()
  const unrelated = await f.chat.create(actor, 'ordinary-conversation')
  /**
   * ⚠️ **必须先把这条"页面建的会话"发布出去**，否则它根本走不到"跨任务"那道检查：
   * 页面路径的"新建对话"是**两段**（`chat-store.ts:333-335`）：`create` 只**预留**（`ready=false`），
   * **用户打完第一条消息才发布**。而运行时的核验顺序是
   * `openExisting()` → `assertConversation()`（**归属与可见性在前**）→ `assertMission()`（**mission 交叉核验在后**）。
   * ⇒ **未发布的会话在可见性那一步就被拒**，报文是 `会话不存在或无权访问`，
   * **根本走不到 mission 核验**——那样这条用例就验不到它名字里说的"**跨任务引用**"了（实测就是这么红的）。
   * 发布之后可见性通过，才落到 `assertMission()` ⇒ `不属于当前协作任务`。
   * （同一套两段式与同一组报文判据，`coordinator.test.mjs` 的 J5 反向用例已经用过：**403 vs 404 的二分**。）
   */
  await f.index.save(ownerKey(actor), unrelated.id, { ready: true })
  /**
   * ⚠️ **报文措辞变了（旧→新），语义没变**：旧实现抛 `不属于当前协作任务`；
   * 现在由 `ConversationLifecycle.assertMission` 抛
   * **`这条会话属于另一个协作任务`**（`packages/runtime/src/conversation.ts:386`）。
   * ⇒ 断言改到**真实报文**上（不是放宽：仍然要求"因跨任务而被拒"）。
   */
  await assert.rejects(provider.run(input({ conversationId: unrelated.id })), /这条会话属于另一个协作任务/)
  assert.equal(f.runs, 0)
  const first = await provider.run(input())
  /**
   * ⚠️ **这里必须换一个 `requestId`（`request-b`），否则验不到"跨任务引用"**（Q4 定因，2026-09-17，已结案）：
   *
   * 原先这一行用的是 `input()` 的**默认** `requestId: 'request-a'` —— 与上一轮（`:446`）**同一个请求标识**。
   * 探针实测（两次对照）：
   * | 传法 | 结果 |
   * | --- | --- |
   * | `missionId:'mission-b'` + **默认 `requestId:'request-a'`** | **不抛错**、`conversationId` 仍是同一条、`f.runs` **不变** ⇒ **幂等重放**（运行时把它当成"同一个请求"，直接返回上一轮结果，**根本没走到 mission 核验**） |
   * | `missionId:'mission-b'` + **`requestId:'request-b'`** | **抛 `这条会话属于另一个协作任务`**（`packages/runtime/src/conversation.ts:386`）⇒ **守卫是好的** |
   *
   * ⇒ **结论：mission 守卫没有漏，跨任务确实被拒**；原先是**用例传了同一个 `requestId`**，
   * 被幂等短路在 `openExisting()`/`assertMission()`（`:613-618` 选路、`:657` 调用）**之前**，
   * 所以那句 `assert.rejects` 从来没被真正执行到（表现为 `Missing expected rejection`）。
   * ⇒ **换 `requestId` 不是放宽断言，是让这条用例真的验到它名字里说的"cross-mission references … before sending"。**
   * `f.runs` 仍应为 1：被拒的那一轮**不该派发**（`:463`）。
   */
  await assert.rejects(
    provider.run(input({ missionId: 'mission-b', conversationId: first.conversationId, requestId: 'request-b' })),
    /这条会话属于另一个协作任务/,
  )
  /**
   * ⚠️ **"其他 owner"这条同样要换 `requestId`，而且报文与"跨任务"那条不同**（Q4 定因续，探针实测）：
   * | 传法 | 结果 |
   * | --- | --- |
   * | 另一 owner + **默认 `requestId:'request-a'`** | **不抛错**、返回**原来那条会话**、`status:'completed'` ⇒ 又一次**幂等重放**（跨 owner 也被命中，见下） |
   * | 另一 owner + **`requestId:'request-c'`** | **抛 `会话不存在或无权访问`** ⇒ **归属确实被强制**，只是报文是**归属/可见性**那条，不是 mission 那条 |
   * ⇒ 所以这里断言的是**归属那条真实报文**（不是放宽：仍然要求"因不是你的会话而被拒"）。
   *
   * ⚠️ **另记一条候选问题（Q6，未断言、只登记）**：上表第一行显示
   * **另一个 owner 用同一个 `requestId` 会拿到原 owner 的那条会话与结果**（`sameConversation: true`、`status:'completed'`）。
   * 若幂等键**不含 owner**，那是一个**跨用户读取**的口子；但本用例**不替它下结论**
   * （也可能是 `input()` 覆盖 `actor` 的方式与运行时的 `ownerOf` 不同源）。**待专项定因，勿据此改实现。**
   */
  await assert.rejects(
    provider.run(input({ actor: { ...actor, userId: 'other-user' }, conversationId: first.conversationId, requestId: 'request-c' })),
    /会话不存在或无权访问/,
  )
  assert.equal(f.runs, 1)
})

test('pre-aborted requests create no conversation and install no subscription', async t => {
  const f = await fixture(t), controller = new AbortController(), progress: ParticipantProgress[] = []; controller.abort()
  const provider = f.provider()
  /**
   * ⚠️ **判据是"相对基线不增长"，不是"绝对为 0"**（本文件其余用例同一口径）：`f.provider()` 构造
   * `ConversationLifecycle` 时会注册 **1 份常驻的 `session/event` 标题观察者**
   * （kit `conversations.ts:36-46` 的 `ctx.on(…, {global:true})`，注册点 `conversation.ts:257`、
   * 释放点 `:1076`）⇒ 绝对 0 永远红，且红了**指不出运行时有什么问题**。
   * 与 closedoff 的同一次迁移同口径（`closedoff/tests/participant.test.ts:311` 取基线、`:523` 断言回到基线）。
   */
  const listenerBaseline = f.host.listenerCount()
  await assert.rejects(provider.run(input({ signal: controller.signal, onProgress: value => progress.push(value) })), { name: 'AbortError' })
  /**
   * ⚠️ **`assert.equal(f.creates, 0)` 已删——它是一条空断言**：`f.creates` 只由 `f.chat.create` 替身
   * （本文件 `:145`）写，而协作路径（`bindTurn: false`）**从不经过 `f.chat`** ⇒ 它结构性恒为 0、恒真。
   * 换成**运行时可观测的事实**：会话端口里一行都没有（真建了会话就会红）。
   */
  assert.equal((f.db.conversations as MemoryConversationPort).size, 0, '未启动的请求不得在会话端口里留下任何行')
  assert.equal(f.runs, 0)
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
  assert.deepEqual(progress, [])
})

test('emits one bound native conversation link before sending and preserves its final artifact', async t => {
  /**
   * 本用例的进度收集器装的是 `{ value, runs }`（**多带一个当时的 `f.runs`**），不是裸的
   * `ParticipantProgress` —— 上面 `:541`/`:551` 的断言就是按这个形状断的（`entry.value`）。
   * 所以这里用本用例自己的局部类型，而不是把 `{ value, runs }` 压成 `ParticipantProgress`
   * （那会让 `entry.value` 变成不存在的字段 ⇒ 断言形状被迫改掉）。
   */
  const f = await fixture(t), progress: { readonly value: ParticipantProgress; readonly runs: number }[] = []; f.auto = false
  const running = f.provider('/native-blog/').run(input({ onProgress: value => {
    void f.index.get(ownerKey(actor), value.conversationId!)
    progress.push({ value, runs: f.runs })
  } }))
  await tick()
  const id = [...f.active.keys()][0]!
  await f.complete(id)
  const result = await running
  /**
   * ⚠️ **这两条"会话链接"来自两个不同的生产者，别当成同一个**（本批的既有差异，两条都已登记）：
   *
   * | | 状态进度里那条 | 交回结果的 `artifacts` |
   * | --- | --- | --- |
   * | 生产者 | **运行时**（`packages/runtime/src/participant.ts:795-798` 的 `conversationArtifact()`） | **业务投影**（`src/definition.ts:333-335`，path 由 `:262` 建） |
   * | `title` | `'查看会话'` | `'查看博客原对话'`（**blog 专属标题仍在**） |
   * | `path` | `` `${config.routePrefix}?conversationId=…` `` ⇒ **routePrefix 原样拼接** | `routePrefix.replace(/\/$/, '') + '?conversationId=…'` ⇒ **去掉尾斜杠** |
   *
   * ⇒ 本用例传入的 `routePrefix` 是 `'/native-blog/'`（**带尾斜杠**），于是两者呈现出可见差异。
   * **文案差异**属已登记的"业务文案被运行时通用文案替换"先例
   * （closedoff `tests/agent.test.ts:15-16`；本页 §87 第 2 条；运行时出处 `participant.ts:708-711`）。
   * **尾斜杠差异是本批新发现的**（§87 第 3 条只登记了"同一 artifact 两个标题"）：
   * 业务侧**刻意规范化**（`definition.ts:262` 的 `.replace(/\/$/, '')`），而运行时侧**没有**
   * ⇒ 同一个逻辑链接两侧格式不一致。**已登记为开放问题 Q3**（该不该让 `participant.ts:798` 也去掉尾斜杠），
   * **不在本批改运行时**（`packages/runtime/src/**` 在边界外）。
   * **若将来 Q3 判定要规范化，把下面 `progressArtifact.path` 的 `'/native-blog/'` 改回 `'/native-blog'` 即可**——
   * 那是判据变化，不是把数字改掉。
   */
  const progressArtifact = { kind: 'conversation', title: '查看会话', path: '/native-blog/?conversationId=' + encodeURIComponent(id) }
  const artifact = { kind: 'conversation', title: '查看博客原对话', path: '/native-blog?conversationId=' + encodeURIComponent(id) }
  assert.deepEqual(progress[0], { value: { kind: 'status', text: '已接单。', conversationId: id, conversationArtifact: progressArtifact }, runs: 0 })
  assert.equal(progress.filter(entry => entry.value.conversationArtifact).length, 1)
  /**
   * ⚠️ **Q5 已裁定（2026-09-17）：这里原先是 `assert.ok(progress.length > 1)`，已改为断言真实机制。**
   *
   * **本用例的主体**（用例名说的）是"**发出一条绑定的原生会话链接（在发送之前）并保留最终产物**"——
   * 上面 `:525`/`:526` 已经把主体钉死（第一条是会话链接、`runs: 0` ⇒ 在发送之前、且只发一次）。
   * "**链接之后还有别的进度**"**不属于本案的主体**，**且它在本案里不可能成立**：
   * 思考与正文两条进度通道都由 **`agent/assistant-stream` 帧**驱动
   * （`participant.ts` 的 `sink`：`text-delta` ⇒ `visible`、`reasoning-delta` ⇒ `thinking`），
   * 而**本用例一条帧都不发** ⇒ 只有初始状态那一条。
   * 旧的 `>1` 是**旧 live 通道**的期望；新架构下它是**附带期望**，故移除。
   *
   * **⇒ 这不是"把数字改掉凑绿"，是去掉一条不属于本案主体的期望**；改为断言真实机制：
   * **不发帧 ⇒ 恰好 1 条**（= 那条会话链接）。
   *
   * **"链接之后还有进度"这条覆盖没有丢**，它由**发帧的那些用例**承担：
   * 本文件 `过程按思考上报：完整覆盖，换段整段追加且不重复`、`只带推理的分片把正文基准归零，下一步的叙述整段保留`
   * （两者都先有那条会话链接、再发出帧驱动的思考快照），以及 Q2 那条红用例（也发帧）。
   */
  assert.equal(progress.length, 1, `不发帧时进度应恰为那条会话链接（实测 progress=${JSON.stringify(progress)}）`)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.artifacts, [artifact])
})

test('思考按推理上报：完整覆盖，换段整段追加且不重复', async t => {
  const f = await fixture(t); f.auto = false
  const progress: ParticipantProgress[] = []
  const running = f.provider().run(input({ onProgress: value => progress.push(value) }))
  await tick()
  const id = [...f.active.keys()][0]!
  /**
   * 思考通道的真实载体是 `agent/assistant-stream` 帧（帧序见 `f.stream` 的说明）。
   *
   * ⚠️ **喂的是"真增量"**：宿主发的是 `reasoning-delta`（增量），blog 声明 `liveMode: 'delta'`
   * （`definition.ts:159`；**2026-09-17 由 `'cumulative'` 更正**）⇒ 运行时按 step **追加**
   * （`projection.ts:191`）。**传"本步到目前为止的全文"是错的**——那是旧载体（页面通道）的语义，
   * 照它写会让真机上每一步的思考只剩最后一个片段，而测试照样绿（本轮实测过）。
   *
   * ⚠️ **两次 push 之间必须等 > `THINKING_INTERVAL_MS`**（`packages/runtime/src/projection.ts:75` = **250ms**）：
   * 快照是**节流发布**的（`projection.ts:175-187`），间隔不够会被**合并**成一份 ⇒ 期望的 4 条会变 1–2 条。
   * 这里留余量取 **310ms**；**这不是放宽判据，是在测真实的发布节奏**。
   */
  const push = async (step: number, text: string) => {
    f.stream(id, [{ step, chunks: [{ type: 'reasoning-delta', text }] }])
    await new Promise(resolve => setTimeout(resolve, 310))
  }
  await push(1, '先看资料。')
  await push(1, '再核对来源。')
  // 下一步重新累积：**换段必须另开一次 `start`**（`step` 只取自 `start` 帧）。
  await push(2, '结论是甲稿更完整。')
  await push(2, '建议先改标题。')
  await f.complete(id, '结论是甲稿更完整。建议先改标题。')
  const result = await running
  const shots = progress.filter(value => value.kind === 'thinking').map(value => value.thinking)
  assert.equal(result.status, 'completed')
  // 思考是**完整覆盖**语义：每条都是到目前为止的全量，页面直接替换整行。
  //
  // ⚠️ 跨段分隔符是 **`'\n'`**（`projection.ts:161-165` 的 `.join('\n')`）——旧实现**无分隔**。
  // 判据 (i) 选 (A)：**保持两段、把期望里的分隔符更新成新格式**。理由是这条用例的名字与注释说的
  // 就是"**换段整段追加且不重复**"；改成单段会让**名字再次说错话**，而那正是本批一路在改的毛病。
  // **格式变了就更新格式，语义一字不动。**
  assert.deepEqual(shots, [
    '先看资料。',
    '先看资料。再核对来源。',
    '先看资料。再核对来源。\n结论是甲稿更完整。',
    '先看资料。再核对来源。\n结论是甲稿更完整。建议先改标题。',
    /**
     * 最后一条是**回合结束时的补发**：`thinking.finish()` 会**强制**再发一份完整快照
     * （`projection.ts:202` `finish() { done = true; schedule(true) }`），
     * 而 `:169` 把 `done` 也算进 payload key（`'1:' + text`）⇒ 正文相同但**算作新载荷**，于是**再发一次**。
     * 这是 `projection.ts` 文件头写明的三个机制之一（"回合结束补发"），**不是重复发布缺陷**：
     * 思考是**覆盖**语义，页面替换整行 ⇒ 同文再发一次无害，且消费方由此知道"这一轮已结束"。
     * （旧实现不补发，所以旧期望是 4 条；**这是新增的收尾行为，语义没变**。）
     */
    '先看资料。再核对来源。\n结论是甲稿更完整。建议先改标题。',
  ])
  // 过程不再按正文发：一旦当正文，气泡里就全是「让我先看看…」，真正的答案被埋在最后。
  assert.equal(progress.filter(value => value.kind === 'delta').length, 0)
  assert.ok(progress.filter(value => value.kind === 'thinking').every(value => value.conversationId === undefined))
  /**
   * ⚠️ 这里原本有一条 `assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_LIVE_REASONING/)`，**已移除**：
   * **它没有主体，是空断言。**
   * - 它靠 `live({ text, reasoning })` 往 `f.listeners` 里灌 —— 而 `.subscribe(` 在**本文件零调用点**
   *   ⇒ 那个集合**恒空** ⇒ 循环体一次都不执行 ⇒ **什么也没发**；
   * - 夹具里另一处 `PRIVATE_LIVE_REASONING`（`chat.history` 返回的 `live` 字段）在本路径上也**永远不会被读到**：
   *   `bindTurn: false` ⇒ 运行时**从不调 `chat`**。
   * ⇒ **"blog 的实时通道有没有脱敏"从来没有被这两条用例真正验证过。**
   * **能证伪的那条断言在下面那条专门的用例里**（它现在**是红的**，钉的是同一个缺口 = 开放问题 Q2）。
   */
})

test('空推理段不占位：下一步的推理整段追加，不丢开头', async t => {
  const f = await fixture(t); f.auto = false
  const progress: ParticipantProgress[] = []
  const running = f.provider().run(input({ onProgress: value => progress.push(value) }))
  await tick()
  const id = [...f.active.keys()][0]!
  /** 同 C1：两次发布之间要留 > `THINKING_INTERVAL_MS`（`projection.ts:75` = 250ms），否则快照被合并。 */
  const settle = () => new Promise(resolve => setTimeout(resolve, 310))
  f.stream(id, [{ step: 1, chunks: [{ type: 'reasoning-delta', text: '今天共有 ' }] }]); await settle()
  // 下一条**只开一段、不发任何 chunk**：这一步还没有内容（换段要另开一次 `start`，`step` 只取自 `start` 帧）。
  f.stream(id, [{ step: 2, chunks: [] }]); await settle()
  /**
   * ⚠️ 喂的是**这一步新到的片段**（增量语义，见 C1 的说明）：`liveMode: 'delta'` ⇒ 同一 step 的多个
   * chunk **追加**成 `'今天共有 12 辆车入园。'`；若声明退回 `'cumulative'`，同一步会**只留最后一个
   * chunk**（`'12 辆车入园。'`）⇒ 本条会红（**本条对"块语义"是有判别力的**，与 C1 一起把这条声明钉住）。
   * 两条 chunk 之间隔一次 `settle()`：上一份快照已过 250ms ⇒ 第一条会**立即发布**（于是多出一条中间快照）。
   */
  f.stream(id, [{ step: 2, chunks: [{ type: 'reasoning-delta', text: '今天共有 ' }] }]); await settle()
  f.stream(id, [{ step: 2, chunks: [{ type: 'reasoning-delta', text: '12 辆车入园。' }] }]); await settle()
  await f.complete(id, '今天共有 12 辆车入园。')
  await running
  const shots = progress.filter(value => value.kind === 'thinking').map(value => value.thinking)
  // 归零后这一步整段进快照；没有归零的话它会被当成「只多了后半段」，展开时开头就缺了。
  // 跨段分隔符是 `'\n'`（`projection.ts:161-165`）——旧实现是**无分隔**，判据 (i)(A)：格式变了，语义没变。
  // 最后一条同样是**回合结束补发**（`projection.ts:202` + `:169` 把 `done` 算进 payload key），与 C1 同因。
  assert.deepEqual(shots, [
    '今天共有 ',
    '今天共有 \n今天共有 ',
    '今天共有 \n今天共有 12 辆车入园。',
    '今天共有 \n今天共有 12 辆车入园。',
  ])
})

/**
 * ## ⚠️ 开放问题 Q2：blog 的实时通道**没有脱敏**（本条钉**现状**，不是保证）
 *
 * | 钩子 | blog | closedoff（同一次迁移的已完成后继物） |
 * | --- | --- | --- |
 * | `redact` | ❌ 未声明（`definition.ts:27` 写"不加"） | ✅ `closedoff/src/definition.ts:97` |
 * | `projectReasoning` | ❌ 未声明，**而且连登记行都没有**（`definition.ts:15-29` 那张表里没有它） | ✅ `:110` |
 * | `opaqueFromToolResult` | ❌ 未声明；`:29` 的"不加"理由**已被证伪**——`reasoning-translation.ts` 是**页面侧 HTTP 功能**（`index.ts:462` 构造 / `:496` 挂路由），`git grep ReasoningTranslations` 显示它**从不接触协作进度载荷** | ✅ `:107` |
 *
 * **读取点（运行时）**：`participant.ts:333` `createVisibleThinking(…, definition.projectReasoning, …)`；
 * `:682-685` 在 `tool/result` 到达时调 `definition.opaqueFromToolResult`（未声明 ⇒ `thinking.hide(…)` 从不被调用）。
 *
 * ## ⚠️ 暴露面是**本次重构引入的**（有基线可证，不只是"没验证过"）
 * 旧 `agents/blog/src/participant.ts:95-107` 的 `forwardLive` **只读 `live.text`**（过程正文），
 * `live.reasoning` **零消费者** ⇒ **旧载体结构上不可能把推理交给协调方**；
 * 新载体的 `thinking` 通道装的是 `reasoning-delta` 的原文（`participant.ts:399`）。
 * ⇒ 这不是"旧测试是空断言所以无从判断"，而是**可比较的行为变化**（那位评审的结论我采纳，此处更正原登记）。
 *
 * ## 本条怎么处置（2026-09-17 主线接管时定案）
 * **把现状钉成可证伪的特征断言**，而不是"红着等设计"：提交必须全绿（§77 六），
 * 而**删掉它会让这个缺口没有任何守卫**（那正是本批一路在打的"虚假安心"）。
 * ⇒ **修好之后本条会故意变红**：把 `assert.match` 翻成 `assert.doesNotMatch` 即证明修复，**不许直接删**。
 * ⇒ **它必须进切换记录**：协调方控制台能看到成员的**原始推理**（旧的只显示过程正文）。
 */
test('⚠️ 特征登记：blog 未声明脱敏钩子 ⇒ 原始推理原样进思考通道（Q2 未决，修好时本条会红）', async t => {
  const f = await fixture(t); f.auto = false
  const progress: ParticipantProgress[] = []
  const running = f.provider().run(input({ onProgress: value => progress.push(value) }))
  await tick()
  const id = [...f.active.keys()][0]!
  const PRIVATE_REASONING = 'PRIVATE_LIVE_REASONING'
  const BUSINESS_KEY = 'PRIVATE_BUSINESS_KEY_7f3a'
  f.stream(id, [{ step: 1, chunks: [{ type: 'reasoning-delta', text: `内部备注 ${PRIVATE_REASONING}，业务主键 ${BUSINESS_KEY}。` }] }])
  await new Promise(resolve => setTimeout(resolve, 310))
  /**
   * 工具结果里带**同一个**业务主键：closedoff 靠 `opaqueFromToolResult` 把它并进 opaque 集合、
   * 再由 `projectReasoning` 在快照里替换掉；blog 两个钩子都没有 ⇒ 既不收也不替换。
   */
  f.host.emit('tool/result', {
    message: { content: [{ type: 'text', content: [{ type: 'text', text: BUSINESS_KEY }] }] },
    meta: { tool: 'blog_search_posts' },
  }, id)
  await new Promise(resolve => setTimeout(resolve, 310))
  await f.complete(id, '本轮回答。')
  const result = await running
  const thinking = progress.filter(value => value.kind === 'thinking').map(value => value.thinking)
  // 反恒真前置：思考通道必须真的有内容，否则下面的断言恒真。
  assert.ok(thinking.length > 0, '思考通道必须真的有内容（否则下面的断言是空断言）')
  /**
   * **① Q2 的现状（本条的"特征断言"）**：原始推理**原样**进思考通道——两个私有标记都在里面。
   * 把两个钩子合成一条断言是刻意的：在这条路径上它们**无法分开观测**（都只表现为"没被替换"）。
   * ⚠️ 修好（blog 补上钩子 / 或按设计 `:531` 的 `channels` 不再强加该通道）之后**本条会红**，
   * 那时把这一条翻成 `doesNotMatch` 即为修复证明。
   */
  assert.match(JSON.stringify(thinking), new RegExp(PRIVATE_REASONING),
    'Q2 现状：未声明 projectReasoning ⇒ 原始推理原样进进度（修好后本条应故意变红）')
  assert.match(JSON.stringify(thinking), new RegExp(BUSINESS_KEY),
    'Q2 现状：未声明 opaqueFromToolResult ⇒ 业务主键不被替换（修好后本条应故意变红）')
  /**
   * **② 与 Q2 无关、永远必须成立的真实边界**：**交回结果**里不得出现任何私有载荷
   * （交付走 `history.tail`，不经过实时通道）。
   */
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/, '交付结果里不得出现私有载荷')
})

test('交回的正文只取该回合最后一条，过程叙述不拼进材料', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input({ onProgress: () => {} }))
  await tick()
  const id = [...f.active.keys()][0]!
  /**
   * 真机上一轮的形态：每一步的正文后面都跟着一次工具调用（「让我先看看…」），
   * 只有最后一条是答案。实测 7 条消息里 6 条是过程叙述，1 条 3890 字才是答案。
   *
   * ⚠️ **必须经宿主事件投递（`f.attempt`），不能写 `f.messages`**：
   * 载体切到运行时之后，投影读的是**宿主会话事件日志**（`lifecycle.events(opened)`），
   * 而 `f.messages` 只是**旧驱动方（页面路径）的内部记账**，运行时根本不读它。
   * 写 `f.messages` 的后果是"消息没进过这一轮"——**投影拿不到正文，而且没有 `turn/end`
   * ⇒ 运行时要空等到 `turnTimeoutMs`（3000ms）才报「协作超时」**（实测）。
   * `tail: true` 是"这一条才是本轮要交回的答案"的标记，逐字保留原用例的语义。
   */
  f.attempt(id, '让我先探索代码仓库中的插件相关代码和文档。')
  f.attempt(id, '找到了相关文章！让我读取这篇关于 DSH 插件开发框架的文章：')
  /**
   * 答案走 `turn/end` 那条正文（`f.complete` 的第二个参数）——因为运行时的答案提取是
   * **`history.tail`**："本回合内最后一条**未被中断**、且有正文的 assistant 消息"
   * （`packages/runtime/src/conversation.ts:1138/1183-1188`）。
   * 上面两条 `f.attempt` 带 `interrupted: true`（`fake-host` 的既有口径）⇒ **按定义永远不是 `tail`**
   * （`conversation.ts:1144`），所以"只取最后一条、过程叙述不拼进来"这条语义**由 tail 天然保证**。
   */
  await f.complete(id, '## 声明文件清单\n\n- `package.json`\n- `plugin.json`')
  const result = await running
  assert.equal(result.status, 'completed')
  assert.equal(result.text, '## 声明文件清单\n\n- `package.json`\n- `plugin.json`')
  assert.doesNotMatch(result.text, /让我先探索|让我读取/)
})

/**
 * ⚠️ **行为收窄登记（主线已定案，2026-09-17；期级评审请重点看这一条）**
 *
 * | | |
 * | --- | --- |
 * | **旧保证** | "没有 `tail`（本轮没跑完）时**保留全部已生成内容**，不丢东西"——旧实现把 `turn.status !== 'succeeded'` 时**失败尝试的正文**也拼进兜底文本（`participant.ts:155`） |
 * | **新行为** | 运行时的历史里**没有 attempt 正文**（被中断的那条 `assistant/message` 带 `data.interrupted === true`，投影侧 `said` 会把它整个排除）⇒ **那段半截正文不再出现在交回结果里**；本轮只交回一条"未完成"提示 |
 * | **为什么** | `tail` 的设计意图是"**算数的答案**"；把被打断的半句当答案本身就是错的 |
 * | **依据** | `agents/blog/src/definition.ts:54` 与 `:253`（两处逐字写明"**接受它**"），实现见 `:275` 的 `said = ctx.history.messages.filter(m => m.role === 'assistant' && m.interrupted !== true)` 与 `text = ctx.history.tail?.text ?? said.map(...).join('\n\n')` |
 *
 * ⚠️ **这是一条"用户可见的内容丢失"**：**本轮被中断时，已经生成的半截正文不再出现在交回结果里**
 * （旧行为会把它拼进兜底文本一起交回）。**业务方应在切换记录里看到这一条**，而不是从代码里发现它。
 *
 * 用例名已随之更正：旧名断言的是**系统已不再具备的行为**，留着就是套件里的一句假话。
 */
test('本轮没跑完（没有 tail）时只交回未完成提示，被中断的尝试正文不再保留（设计已收窄，见上方登记）', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input({ onProgress: () => {} }))
  await tick()
  const id = [...f.active.keys()][0]!
  /**
   * ⚠️ 同样必须经**宿主事件**投递（理由见上一条用例）：
   * 那要求这些正文**真的进过这一轮的事件日志**，写 `f.messages` 等于什么都没发生。
   * 收尾用 `interrupted`：`f.complete` 把它映射成非 completed 的 reason ⇒ 运行时判 `failed`，
   * 与被中断的那一轮语义一致（**不是**把它改写成"已完成"）。
   */
  f.attempt(id, '先看资料。')
  f.attempt(id, '还没写完的回答片段')
  await f.complete(id, '', 'interrupted')
  const result = await running
  assert.equal(result.status, 'failed')
  /**
   * **收窄后的真判据**（方向与旧断言相反，故意如此）：
   * 1. 被中断的尝试正文**不得**出现——这正是设计接受的那条收窄；
   * 2. 交回的是**运行时的"未完成"提示**，文案取自实现的实际产出
   *    （`packages/runtime/src/participant.ts:456`，实测值即下一行那个串）。
   */
  assert.doesNotMatch(result.text, /先看资料。/, '被中断的尝试正文不应再进交回结果（见上方登记的依据）')
  assert.doesNotMatch(result.text, /还没写完的回答片段/, '同上')
  assert.match(result.text, /未能完成本回合，请查看原会话/, '应改为交回运行时的"未完成"提示')
})

/**
 * ## ⚠️ 运行时缺陷登记：`session/event` 订阅**不随会话/生命周期释放**
 *
 * 起因：那 10 条 `assert.equal(f.listeners.size, 0)` 是**空断言**——替身的 `subscribe`
 * （本文件 `:147-154`）**零调用点**，集合永远为空。"把断言变强"之后（换成宿主侧真哨兵
 * `host.listenerCount()`，见 `fixtures/fake-host.mjs:185`），**真问题立刻露出来**。
 *
 * **实测数字（临时探针，测完已删；三处都验过）**：
 * | 时点 | `listenerCount()` |
 * | --- | --- |
 * | **夹具建好、任何一轮都没跑之前**（基线） | **0**（32/32） |
 * | **一轮正常收尾之后** | **2**（6/6） |
 * | **取消/中止路径的断言点** | **1**（那 4 条红的 `expected 0 / actual 1`） |
 * | **`host.disposeAll()` 之后** | **1**（31/32；另 1 个是 2） |
 *
 * **判定（2026-09-17 用探针改正过一次，别按上表直接下结论）**：
 * 上表只说明"**轮次结束时没回到 0**"，**不等于**"运行时没释放自己的订阅"。探针实测：
 * ```
 * [leakprobe] run-start:      session/event=1  agent/assistant-stream=1
 * [leakprobe] cleanup-before: count=2   unsub=REAL
 * [leakprobe] cleanup-after:  count=1
 * ```
 * ⇒ **participant 的 `run` 体还没开始，就已经有 1 个 `session/event` 订阅了**；
 * participant 装的是**第 2 个**，而它的 `cleanup()`（`participant.ts:323-332`）把**自己那个正确摘掉**（`2 → 1`，
 * 且 `unsub` 是**真正的释放函数**）⇒ **运行时每轮的净泄漏 = 0**。
 * ⇒ 那条 **"每轮泄漏一个订阅" 的前提不成立**；基线里那 1 个是**运行开始前就存在的、业务侧的**订阅。
 *
 * ⚠️ **那 1 个订阅的归属与合法性：已结案 = 合法、长生命周期**（专项只读核查，2026-09-17）：
 * 它是 **`ConversationLifecycle` 自己的标题观察者**——
 * - **注册点**：`packages/runtime/src/conversation.ts:257`
 *   `this.stopTitles = registerConversationTitles(host.ctx, …)`；kit 实现
 *   `packages/plugin-kit/src/conversations.ts:36-46` ⇒ `ctx.on('session/event', …, {global:true})`；
 * - **注册时机**：在 **`ConversationLifecycle` 的构造函数里** ⇒ **每个生命周期一份、run 之前就装上**；
 *   而生命周期是**惰性构造**的（`f.provider()` 调用时才建）⇒ 正好解释
 *   "**夹具建好时 = 0（32/32 基线）**"与"**run-start 时 = 1**"这两个读数**并不矛盾**；
 * - **释放点**：`conversation.ts:1076` `this.stopTitles()`，位于 `:1074` 的 `async dispose()` 内；
 * - **kit 自己的注释（`conversations.ts:35`）写明意图**：
 *   "Observe trusted host titles for the plugin lifetime, including arrivals after turn/end."
 * ⇒ **该订阅已确证为合法；运行时是对的，本用例不再对它存疑。**
 * （本节先前写的是"由另一次专项核查判定"——**现在核查完成，按结论改写**；
 * 但**那句话的精神仍然成立**：**"断言过了"不等于"那个问题解决了"**——这里是**查清了**才这么说。）
 */
test('一轮收尾（运行时 cleanup 跑过）之后，participant 自己那个 session/event 订阅已被摘掉（判据 = 收尾后比本轮峰值少 1）', async t => {
  const f = await fixture(t)
  /**
   * ⚠️ **判据取"相对基线不增长"，不是"总数必须为 0"**：
   * 运行开始前就已经有 1 个业务侧订阅（探针实测 `run-start: session/event=1`），
   * 所以"绝对为 0"是**把别人的订阅算到运行时头上**——那样这条守卫永远红，
   * 而它红了也**指不出运行时有什么问题**。口径应当是"**这一轮没有多留**"。
   */
  /**
   * ⚠️ **判据的演进（两次被实测推翻，别退回前两种）**：
   * 1. `disposeAll()` 之后 == 0 ⇒ **结构上做不到**（本夹具的 `ctx.on` 不登记 disposer）；
   * 2. `run()` 之前的基线 == 收尾后 ⇒ **也错**：实测 `before=0`，而业务侧那 1 个是在 `run()` **期间**
   *    装上的 ⇒ 收尾后是 1，`expected 0 / actual 1` **永远红**，且红了指不出 participant 有什么问题；
   * 3. **本条采用**：`after === peak - 1` —— `peak` 由自驱循环记录（业务侧与 participant 的订阅
   *    **不在同一时刻装上**，固定时点采样采不到同时在场的那一刻）。
   *
   * ⚠️ **本判据假定"每轮恰好新增 1 个订阅"，这是被测过的、不是假定的**：
   * 探针实测 `install-before: count=1`、`cleanup-before: count=2` ⇒ **恰好 +1**。
   * **将来若某轮装了 2 个又都摘掉，`after` 会是 `peak - 2` ⇒ 本条会假红**；
   * 那时应当把判据改成"收尾后不多于 `before`"或按峰值差参数化，**而不是把 `- 1` 改掉**。
   */
  const before = f.host.listenerCount()
  const running = f.provider().run(input())
  await tick()
  const id = [...f.active.keys()][0]!
  /**
   * **`during`：一轮在飞时一共装了几个。** 实测 = 2（`before` = 0）：
   * **1 个是业务侧**（在 `run()` 内部、participant 装自己那个之前就装上了——探针 `run-start: session/event=1`），
   * **1 个是 participant 自己的**（探针 `cleanup-before: count=2`，且它的 `unsub` 是真正的释放函数）。
   *
   * ⇒ **"相对 `run()` 之前的基线"在这里是错的判据**：基线是 0，而业务侧那 1 个是在 `run()` **期间**装上的，
   * 所以"收尾后 == 基线(0)"**永远红**，而它红了**指不出 participant 有什么问题**（实测 `expected 0 / actual 1`）。
   */
  const during = f.host.listenerCount()
  await f.complete(id, '本轮回答')
  await running
  const after = f.host.listenerCount()
  /**
   * ⚠️ **为什么断言的时点在这里，而**不是**在 `disposeAll()` 之后**（这条归因我一开始搞错了）：
   * - 本夹具的 `ctx.on`（`fixtures/fake-host.mjs:112-117`）**只往 `byEvent` 加监听，不登记 disposer**；
   * - `disposeAll()`（`:188`）**只跑 `ctx.effect` 登记的那一份** ⇒ **它按构造就释放不了 `ctx.on` 订阅**
   *   ⇒ "`disposeAll()` 之后 == 0" 是**一个结构上做不到的期望**，**与运行时是否泄漏无关**。
   * - **真正该断言的时点**：`await running` ⇒ 运行时的 **per-run `cleanup()`**
   *   （`packages/runtime/src/participant.ts:323-332`，其中 `unsubscribe()` 正是这条订阅的释放）
   *   已经跑过 ⇒ 订阅应当**回到基线（0）**。
   * ⇒ 这才是"到期该放的时候放没放"那条**能立得住的不变式**。
   */
  /**
   * **判据：收尾必须让总数"少掉 participant 自己那一个"，而不是"归零"。**
   *
   * `during` = 业务侧 1 + participant 1；收尾后 `after` 必须是 **`during - 1`**。
   * 这是一条**能变红**的真不变式：**participant 若不释放自己那个，`after` 会等于 `during` ⇒ 红**。
   * 它**不**对业务侧那一个下任何猜测——那 1 个**已确证为合法的长生命周期订阅**
   * （`ConversationLifecycle` 的标题观察者：注册 `conversation.ts:257`、释放 `:1076`、
   * kit `conversations.ts:35-46`）⇒ **本用例不再对它存疑**。
   *
   * 口径说明：**closedoff 用的是 `mark()` 式**（接单后取一次基线，断言收尾回到该基线）；
   * 本夹具因为那 1 个订阅与 participant 自己那个**不在同一时刻装上**，改用**峰值差**表达同一件事。
   * **两种口径都成立**且效果等价（`peak = 基线 + 1`）——**不要为了对齐而改掉这条已经成立的判据**。
   */
  assert.equal(after, (f.peakListeners ?? during) - 1,
    `participant 收尾后必须少掉自己那一个订阅（实测：before=${before} during=${during} peak=${f.peakListeners} after=${after}）`)
})

test('cancel or revoke before initial progress emits no conversation link or request', async t => {
  for (const action of ['cancel', 'revoke']) {
    const f = await fixture(t), controller = new AbortController(), progress: ParticipantProgress[] = []
    /**
     * ⚠️ **换指（原写法驱动的是已失效的缝）**：原先靠**打补丁 `f.chat.subscribe`** 来触发中止/撤权，
     * 但**协作路径根本不经过 `f.chat`**（本夹具显式 `bindTurn: false`；`.subscribe(` 在这条路径上
     * **零调用点**——与 §91/§105 里"10 条 `f.listeners.size === 0` 是空断言"**是同一个事实**）
     * ⇒ 那个补丁**永不被调用** ⇒ `controller.abort()` / `f.denied = true` **永不发生**
     * ⇒ 这一轮正常跑完 ⇒ `assert.rejects` 等不到拒绝（实测报 `Missing expected rejection (AbortError)`）。
     *
     * 现在改挂**活的缝** `f.access.assert`——运行时在 `participant.ts:213` 的 `assertAccess` 必调它，
     * 而它正好落在"**首次进度之前**"那个窗口里，与本用例名要验的语义一致。
     * 撤权必须在调用原判定**之前**置位，才能让原判定抛出"登录或授权已失效"。
     */
    const assertAccess = f.access.assert
    f.access.assert = current => {
      if (action === 'revoke') f.denied = true
      assertAccess(current)
      if (action === 'cancel') controller.abort()
    }
    const provider = f.provider()
    // 常驻的标题观察者（`conversation.ts:257`，§99 已结案：**合法长生命周期订阅**）⇒ 基线不为 0。
    const listenerBaseline = f.host.listenerCount()
    await assert.rejects(provider.run(input({ signal: controller.signal, onProgress: value => progress.push(value) })),
      action === 'cancel' ? { name: 'AbortError' } : /登录或授权已失效/)
    assert.deepEqual(progress, [])
    assert.equal(f.runs, 0)
    assert.equal(f.host.listenerCount(), listenerBaseline,
      `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
  }
})

test('cancel or revoke in the initial link callback cannot start a blog turn', async t => {
  for (const action of ['cancel', 'revoke']) {
    const f = await fixture(t), controller = new AbortController(), progress: ParticipantProgress[] = []
    const provider = f.provider()
    // 常驻的标题观察者（`conversation.ts:257`，§99 已结案：**合法长生命周期订阅**）⇒ 基线不为 0。
    const listenerBaseline = f.host.listenerCount()
    await assert.rejects(provider.run(input({ signal: controller.signal, onProgress(value) {
      progress.push(value)
      if (action === 'cancel') controller.abort()
      else f.denied = true
    } })), action === 'cancel' ? { name: 'AbortError' } : /登录或授权已失效/)
    assert.equal(progress.length, 1)
    assert.equal(progress[0]!.conversationArtifact!.kind, 'conversation')
    /**
     * ⚠️ **原 `assert.equal(f.stops, 0)` 已删（它是一条空断言）**：`f.stops` 只由
     * `f.chat.stop`（本文件 `:169`）与 `f.chat.settleAccepted`（`:175`）写，而这两个方法
     * **零调用点**——协作路径的停止/取消由运行时 `lifecycle` 负责，**根本不经过业务侧的 `chat`**
     * ⇒ `f.stops` **结构性恒为 0**，断言恒真、看不出任何问题（"空断言比红更危险"）。
     * 这一条的语义已被上面两条**真断言**覆盖（`f.runs === 0` + `progress` 的形状）；
     * 运行时侧的"谁停了"要读 `lifecycle`，但本用例 `f.runs === 0` ⇒ **没有任何 lifecycle 会话可查**，
     * 所以**不再换成一个新的恒真写法**，只留这条登记。
     */
    assert.equal(f.runs, 0)
    assert.equal(f.host.listenerCount(), listenerBaseline,
      `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
  }
})

test('aborting during send preparation stops the accepted turn and cleans its subscription', async t => {
  const f = await fixture(t), controller = new AbortController(); f.auto = false
  const provider = f.provider()
  // 常驻的标题观察者（`conversation.ts:257`，§99 已结案：**合法长生命周期订阅**）⇒ 基线不为 0。
  const listenerBaseline = f.host.listenerCount()
  const running = provider.run(input({ signal: controller.signal }))
  /**
   * ⚠️ **换指（原写法驱动的是已失效的缝）**：这里原本挂 `f.sendGate` 去卡住
   * `f.chat.send` 的"发送准备"。**协作路径不经过 `f.chat.send`**（载体切到运行时之后，
   * `chat` 只在 `bindTurn` 时用；本夹具显式 `bindTurn: false`）⇒ 那个闸**永远不会被读**，
   * `release()` 也没有任何人在等 ⇒ 目标轮次**收不到 `turn/end`**，运行时要空等到
   * `turnTimeoutMs`(3000ms) 才报「协作超时」（实测：本条耗时 3005ms）。
   * 现在的形状与真机一致：**先中止，再由宿主发 `turn/end`** 把这一轮收掉。
   * `f.stops` 与 `f.active` 是**旧驱动方的内部记账**（只有 `f.chat.stop`/`settleAccepted` 会写它们，
   * 而协作路径不调那两个）⇒ 换指到运行时的可观测事实（见文件头映射表与 §78）。
   */
  await tick()
  const id = [...f.active.keys()][0]!
  controller.abort()
  await f.complete(id, '', 'interrupted')
  const result = await running
  assert.equal(result.status, 'cancelled')
  assert.equal(provider.lifecycle.isBusy(id), false, '取消收尾后这一轮不再占用')
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
})

test('aborting from a running progress callback does not lose its completion notification', async t => {
  const f = await fixture(t), controller = new AbortController(); f.auto = false
  const provider = f.provider()
  // 常驻的标题观察者（`conversation.ts:257`，§99 已结案：**合法长生命周期订阅**）⇒ 基线不为 0。
  const listenerBaseline = f.host.listenerCount()
  /**
   * ⚠️ **两处换指（原写法驱动的都不是它想验的缝）**：
   * 1. 原写法认死 `value.text === '博客正在整理资料与回答'` 才中止——那是**旧业务文案**，
   *    新载体里该字符串全仓只存在于本文件 ⇒ 条件永不成立、这一轮收不到 `turn/end`
   *    （实测空等到 `turnTimeoutMs` 3006ms）；
   * 2. 后来改成"**第一次进度回调即中止**"，但那个触发点**落在 `turn/start` 之前**：运行时的首条
   *    进度（`kind:'status'` 的接单，`participant.ts:722`）发在 `followup` **之前**，而
   *    `cancel()`（`:371-376`）按 `started` 分界——`!started` ⇒ `reject(signal.reason)`（AbortError），
   *    `started` 之后才交给收尾循环判 `cancelled` ⇒ 那个触发点把本条**退化成了 case 14**
   *    （`cancel or revoke in the initial link callback`，期望 `AbortError`）。
   * ⇒ **现在等 `kind:'thinking'` 再中止**：思考进度只可能来自 `turn/start` **之后**的推理帧
   *   （`sink` 在 `:394-395` 用 `started` 把守），"**运行中的**进度回调里中止"这句用例名才真的成立。
   *   依据是同一次迁移的已完成后继物：closedoff 在 `turn/start` **之后**中止 ⇒ `cancelled`
   *   （`closedoff/tests/participant.test.ts:928-951`）；在接单回调里中止 ⇒ `reject AbortError`（`:954-962`）。
   */
  let id: string | undefined, aborted = false, completion
  const running = provider.run(input({ signal: controller.signal, onProgress(value) {
    id = value.conversationId ?? id
    if (value.kind !== 'thinking' || aborted) return
    aborted = true
    controller.abort()
    /**
     * ⚠️ **不能用 `void f.complete(...)`**：那样一旦它 reject，就变成一条**无主的未处理拒绝**，
     * `node:test` 只会把 `This operation was aborted` 记到本条用例上、**连栈都没有**
     * （实测 `failureType: 'testCodeFailure'`、无 `stack` 字段）。改成**捕获后在下面 await**。
     */
    completion = f.complete(id!, '', 'interrupted')
  } }))
  // 等这一轮真的把问题投给 Agent（`turn/start` 已发），再喂一帧推理 ⇒ 触发上面那次中止。
  id = await f.host.accept()
  f.stream(id, [{ step: 1, chunks: [{ type: 'reasoning-delta', text: '先看资料。' }] }])
  const result = await running
  await completion
  // 先钉"中止真的发生过"：否则这条用例可能什么都没验（"空断言比红更危险"的第一道防线）。
  assert.equal(aborted, true, '必须在"运行中的"（turn/start 之后）进度回调里中止过一次')
  assert.equal(result.status, 'cancelled')
  assert.equal(provider.lifecycle.isBusy(id), false, '取消收尾后这一轮不再占用')
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
})

test('cancellation waits for an asynchronously settled job after stop has already returned', async t => {
  const f = await fixture(t), controller = new AbortController(); f.auto = false
  const provider = f.provider()
  /** 基线 = `f.provider()` 构造时那 1 份常驻标题观察者（口径见 case 5 的登记）。 */
  const listenerBaseline = f.host.listenerCount()
  /**
   * ⚠️ **换指（原写法覆盖的是已失效的缝）**：原来覆盖 `f.chat.stop` 来模拟"停止已经返回、
   * 作业稍后才异步落定"。但**协作路径不调 `f.chat.stop`**（只有页面路径那个真 `BlogChat` 会；
   * 本夹具 `bindTurn: false`，`chat` 根本没进运行时）⇒ 那段覆盖是**死代码**，
   * `f.stops` 永远是 0、轮次也收不到 `turn/end` ⇒ 空等到 `turnTimeoutMs`(3000ms)（实测 3006ms）。
   *
   * 本用例要验的语义**仍然成立且重要**：**中止要等"稍后才异步落定的那一轮"**，不能提前返回。
   * 所以现在照真机建模：中止 ⇒ 停止先返回 ⇒ **隔一小段再发 `turn/end`** 把这一轮落定，
   * 断言 `run()` 一直等到那次落定之后才 resolve（`status === 'cancelled'`）。
   * `f.stops` 是旧驱动方的内部记账 ⇒ 换指到运行时的可观测事实（文件头映射表 / §78）。
   */
  const running = provider.run(input({ signal: controller.signal }))
  await tick()
  const id = [...f.active.keys()][0]!
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 5))
  await f.complete(id, '', 'interrupted')
  const result = await running
  assert.equal(result.status, 'cancelled')
  assert.equal(provider.lifecycle.isBusy(id), false, '异步落定之后这一轮不再占用')
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
})

test('returns a native confirmation link without nonce, reasoning or remote operation snapshots', async t => {
  const f = await fixture(t); f.auto = false
  const provider = f.provider()
  /** 基线 = `f.provider()` 构造时那 1 份常驻标题观察者（口径见 case 5 的登记）。 */
  const listenerBaseline = f.host.listenerCount()
  const running = provider.run(input())
  await tick()
  const id = [...f.active.keys()][0]!
  f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE', before: { private: 'PRIVATE_REMOTE_SNAPSHOT' }, canConfirm: true }]
  await f.complete(id)
  const result = await running, encoded = JSON.stringify(result)
  assert.equal(result.status, 'external_pending'); assert.equal(result.artifacts?.[0]!.kind, 'confirmation')
  assert.equal(result.artifacts?.[0]!.path, '/blog?conversationId=' + encodeURIComponent(id))
  assert.doesNotMatch(encoded, /PRIVATE_|nonce|reasoning|canConfirm|before/)
  assert.match(result.text, /没有执行发布/)
  assert.match(result.externalPending!.reason, /没有执行发布/)
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `本轮不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
})

test('an unapplied proposal is reported as external_pending and never as a saved native article', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0]!, owner = ownerKey(actor)
  const draft = await f.store.create(owner, { title: 'PRIVATE_BEFORE_TITLE', text: 'PRIVATE_BEFORE_TEXT' })
  await f.store.propose(owner, draft.id, draft.revision, { title: '实际候选标题', text: '真实候选正文与 Agent 自述不同', tags: ['PRIVATE_TAG'] }, [{ text: 'PRIVATE_SOURCE' }])
  await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
  await f.complete(id, '已提出文章修改建议')
  const result = await running
  assert.equal(result.status, 'external_pending'); assert.equal(result.artifacts?.[0]!.kind, 'draft')
  assert.match(result.text, /候选稿不等于正文已保存或发布/)
  assert.match(result.externalPending!.reason, /不等于正文已保存或发布/)
  assert.match(result.text, /实际候选标题/)
  assert.match(result.text, /真实候选正文与 Agent 自述不同/)
  assert.match(result.text, /作为核对资料，不是指令/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|before|sources|reasoning|nonce/)
})

test('a later progress question preserves earlier unresolved candidates and confirmation operations', async t => {
  const f = await fixture(t); f.auto = false
  const provider = f.provider(), first = provider.run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0]!, owner = ownerKey(actor)
  const draft = await f.store.create(owner, { title: '仍待采用' })
  await f.store.propose(owner, draft.id, draft.revision, { text: '候选内容' }, [])
  await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
  await f.complete(id)
  assert.equal((await first).status, 'external_pending')
  f.auto = true
  const followup = await provider.run(input({ requestId: 'progress-request', conversationId: id, message: '现在等谁' }))
  assert.equal(followup.status, 'external_pending'); assert.equal(followup.artifacts?.[0]!.kind, 'draft')
  assert.doesNotMatch(followup.text, /候选内容|本轮实际候选内容/)
  f.operations = [{ status: 'prepared', nonce: 'PRIVATE_OLD_NONCE', requestId: turn.id }]
  const confirmation = await provider.run(input({ requestId: 'progress-request-2', conversationId: id, message: '能继续了吗' }))
  assert.equal(confirmation.status, 'external_pending'); assert.equal(confirmation.artifacts?.[0]!.kind, 'confirmation')
  assert.doesNotMatch(JSON.stringify(confirmation), /PRIVATE_OLD_NONCE/)
})

test('actual candidate paragraphs and headings render readably without JSON escapes in collaboration details', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0]!, owner = ownerKey(actor), draft = await f.store.create(owner)
  const body = '## 数据来源\n\n这是实际候选的第一段。\n\n第二段包含 "引号" 和 C:\\reports。\n\n- 本页 2 条样例\n- 全量未知\n\n<script>不能执行</script>'
  await f.store.propose(owner, draft.id, draft.revision, { title: '候选标题 "样例"', text: body }, [])
  await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
  await f.complete(id, 'Agent 的概述不能代替候选正文')
  const result = await running, html = renderMarkdown(result.text)
  assert.ok(result.text.includes(body), 'candidate body must remain complete and unmodified')
  assert.match(html, /<h3>候选 1 · 待采用<\/h3>/)
  assert.match(html, /<h2>数据来源<\/h2>/)
  assert.match(html, /<p>这是实际候选的第一段。<\/p>/)
  assert.match(html, /<li>本页 2 条样例<\/li>/)
  assert.match(html, /&lt;script&gt;不能执行&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script|\[\{&quot;title&quot;|\\n\\n##/)
  assert.equal(result.status, 'external_pending')
})

test('only the current unapplied candidate of the requested turn is forwarded', async t => {
  for (const action of ['replace', 'apply', 'discard']) await t.test(action, async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0]!, owner = ownerKey(actor), draft = await f.store.create(owner)
    const first = await f.store.propose(owner, draft.id, draft.revision, { text: '旧候选不应转交' }, [])
    await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
    if (action === 'replace') {
      await f.store.propose(owner, draft.id, draft.revision, { text: '同轮替换后的实际候选' }, [], first.id)
      await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
    } else if (action === 'apply') await f.store.applyProposal(owner, draft.id, draft.revision, first.id, ['text'])
    else await f.store.discardProposal(owner, draft.id, draft.revision, first.id)
    await f.complete(id)
    const result = await running
    assert.doesNotMatch(result.text, /旧候选不应转交/)
    assert.equal(result.status, action === 'replace' ? 'external_pending' : 'completed')
    if (action === 'replace') assert.match(result.text, /同轮替换后的实际候选/)
    else assert.doesNotMatch(result.text, /本轮实际候选内容/)
  })
})

test('multiple current draft candidates are deduplicated and forwarded together or explicitly all omitted', async t => {
  for (const oversized of [false, true]) await t.test(oversized ? 'oversized list' : 'full list', async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0]!, owner = ownerKey(actor)
    const bodies = ['甲稿正文', oversized ? '乙稿正文'.repeat(20000) : '乙稿正文']
    for (const [i, body] of bodies.entries()) {
      const draft = await f.store.create(owner)
      await f.store.propose(owner, draft.id, draft.revision, { title: '候选标题' + i, text: body }, [])
      await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
      await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
    }
    await f.complete(id)
    const result = await running
    assert.equal(result.status, 'external_pending')
    assert.ok((result.externalPending?.reason?.length ?? 0) > 0)
    assert.ok(result.text.length <= 64000)
    assert.equal(result.artifacts?.[0]!.path, '/blog?conversationId=' + encodeURIComponent(id))
    assert.match(result.text, /共 2 份/)
    if (oversized) {
      assert.match(result.text, new RegExp('候选正文共 ' + bodies.reduce((sum, body) => sum + body.length, 0) + ' 字符'))
      assert.match(result.text, /所有候选均未转交全文，不能宣称已完整复核任何一份候选/)
      assert.doesNotMatch(result.text, /甲稿正文|乙稿正文/)
    } else {
      for (const body of bodies) assert.equal(result.text.split(body).length - 1, 1)
      const html = renderMarkdown(result.text)
      assert.match(html, /<h3>候选 1 · 待采用<\/h3>/)
      assert.match(html, /<h3>候选 2 · 待采用<\/h3>/)
      assert.match(html, /候选 1 正文结束。/)
      assert.match(html, /候选 2 正文结束。/)
    }
  })
})

test('long responses preserve status and disclose omissions within the collaboration message limit', async t => {
  for (const [name, answer, body, fullCandidate, answerTruncated] of [
    ['long answer', '答'.repeat(70000), '短候选全文', true, true],
    ['candidate priority', '答'.repeat(5000), '始' + '文'.repeat(62998) + '终', true, true],
    ['long candidate', '公开回答', '候'.repeat(70000), false],
    ['literal backslashes fit without JSON expansion', '公开回答', '\\'.repeat(40000), true, false],
    ['no candidate', '答'.repeat(70000), null, false],
  ] as [name: string, answer: string, body: string | null, fullCandidate: boolean, answerTruncated?: boolean][]) await t.test(name, async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0]!, owner = ownerKey(actor)
    if (body !== null) {
      const draft = await f.store.create(owner)
      await f.store.propose(owner, draft.id, draft.revision, { title: '需要核对的候选', text: body }, [])
      await f.index.result(owner, turn!, 'candidate', await f.store.get(owner, draft.id))
    }
    await f.complete(id!, answer)
    const result = await running
    assert.ok(result.text.length <= 64000, '转交正文不超过参与者自己的上限')
    assert.equal(result.status, body === null ? 'completed' : 'external_pending')
    assert.equal(result.artifacts?.[0]!.path, '/blog?conversationId=' + encodeURIComponent(id))
    if (fullCandidate) {
      assert.ok(result.text.includes(body!), 'actual candidate must be forwarded in full')
      if (answerTruncated) assert.match(result.text, /公开回答原长 .* 字符.*已省略后文/)
      else assert.doesNotMatch(result.text, /公开回答原长|所有候选均未转交全文/)
    } else if (body !== null) {
      assert.match(result.text, new RegExp('候选正文共 ' + body.length + ' 字符'))
      assert.match(result.text, /未转交全文，不能宣称已完整复核/)
      assert.ok(!result.text.includes(body.slice(0, 20)), 'do not silently pass a candidate fragment')
    } else assert.match(result.text, /公开回答原长 70000 字符.*已省略后文/)
  })
})

test('revocation during result read fails closed and removes the subscription', async t => {
  const f = await fixture(t)
  /**
   * ⚠️ **换指（原写法驱动的是死缝）**：原来把闸挂在 `f.chat.history`（配合 `f.historyEntered`），
   * 而**协作路径从不调用 `f.chat`**（`bindTurn: false`）⇒ `await reading` **永不 settle**
   * ⇒ 事件循环排空后 node:test 报 `Promise resolution is still pending`，整条用例被标 `cancelled`。
   * 结果投影真正读的业务面是 `app.operations(owner)`（本文件夹具 `:215` 起）⇒ 闸改挂在那里，
   * "**正在读结果时**被撤权"这个语义一字未变，但缝是**活的**。
   */
  let release: (() => void) | undefined, entered: (() => void) | undefined
  f.operationsGate = new Promise<void>(resolve => { release = resolve })
  f.operationsEntered = () => entered?.()
  const reading = new Promise<void>(resolve => { entered = () => resolve() })
  const provider = f.provider()
  /** 基线 = `f.provider()` 构造时那 1 份常驻标题观察者（口径见 case 5 的登记）。 */
  const listenerBaseline = f.host.listenerCount()
  const running = provider.run(input())
  await reading
  f.denied = true
  release!()
  /**
   * 撤权发生在**结果读取期间**：收尾路径本身不再复查身份，但运行时有一道**补偿守卫**——
   * `participant.ts:694` 的 `recheck` 定时器（`config.authRecheckMs`：夹具与生产装配都是 **1000ms**）
   * 会调 `assert()`（`:385` = `assertAccess` + `assertConversation`）⇒ 最长约 1s 内这一轮被 `fail`。
   * 这就是"fail-closed"该有的样子：**宁可报错，也不把这份结果交出去**。
   */
  await assert.rejects(running, /登录或授权已失效/)
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `撤权收尾后不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
})

test('subscription revocation while running rejects instead of leaking a later answer', async t => {
  const f = await fixture(t); f.auto = false
  const provider = f.provider()
  /** 基线 = `f.provider()` 构造时那 1 份常驻标题观察者（口径见 case 5 的登记）。 */
  const listenerBaseline = f.host.listenerCount()
  const running = provider.run(input())
  await tick()
  const id = [...f.active.keys()][0]!
  /**
   * ⚠️ **换指（原写法驱动的是死缝）**：原来用 `f.emit(id)` 去"通知订阅者已被撤权"，而 `f.emit`
   * 遍历的是 `f.listeners`——那个集合**只由 `f.chat.subscribe` 填**，协作路径**从不调 `f.chat`**
   * ⇒ 集合恒空、`f.emit` 是 no-op ⇒ 撤权**根本没发生**，这一轮照常跑完（"不漏答"于是无从验起）。
   *
   * 活的缝是**授权判定本身**：`f.denied = true` 之后，运行时的 `recheck`（`participant.ts:694`，
   * `authRecheckMs` = 1000）会调 `assert()` ⇒ 最长约 1s 内这一轮被 `fail`（拒绝，而不是交出一份
   * 撤权之后才到的答案）。**这是"撤权 ⇒ 不再泄露后续答案"的直接判据。**
   */
  f.denied = true
  await assert.rejects(running, /登录或授权已失效/)
  // 运行时的可观测事实：撤权收尾之后这一轮不再占用（`f.active` 是页面路径的记账，
  // 协作路径里没有任何人会清它 ⇒ 拿它当判据是恒假的）。
  assert.equal(provider.lifecycle.isBusy(id), false, '撤权收尾后这一轮不再占用')
  assert.equal(f.host.listenerCount(), listenerBaseline,
    `撤权后不得多留 session/event 订阅（基线 ${listenerBaseline}，实测 ${f.host.listenerCount()}）`)
})

test('native chat deep links select the requested conversation over a previous local conversation', () => {
  const path = '/blog?conversationId=' + encodeURIComponent('blog-chat-owned-id')
  assert.equal(chatConversationTarget(new URL(path, 'https://example.invalid').search, 'previous-chat'), 'blog-chat-owned-id')
  assert.equal(chatConversationTarget('', 'previous-chat'), 'previous-chat')
  assert.equal(chatConversationTarget(''), null)
  // 选择标识不授予访问权；非法和他人标识仍交给 activate 的原 HTTP 归属检查。
  assert.equal(chatConversationTarget('?conversationId=unowned-id'), 'unowned-id')
})
