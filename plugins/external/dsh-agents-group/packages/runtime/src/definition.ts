/**
 * Agent 的声明式定义。
 *
 * 这个文件是「机制在运行时、策略在业务」的分界线：业务把 persona、工具、输出变换与结果投影
 * 声明成钩子，**时序与状态由运行时代管**（何时调、按什么顺序调、失败了怎么办、按什么节奏发布）。
 *
 * ## 钩子为什么这样切
 *
 * 早期方案把 `redact` 设计成一个有状态签名 `(text, { opaqueValues, releaseTail }) => string`。
 * 那不是"参数不够"，而是**表达不了**：
 *
 * - `opaqueValues` 只在 `tool/result` 事件到达时产生（`closedoff/src/participant.ts:152-156`），
 *   而那个签名拿不到工具结果 → 它**恒为空** → 敏感值替换永不发生。这是**安全失效**，不是展示问题。
 * - `releaseTail` 在 `turn/end` 才翻转，签名同样拿不到那一刻。
 * - 思考快照要按 step 累积、并在 `assistant/attempt` 失败时**丢弃**该 step 的累积（`live-output.ts:122`
 *   的 `discard(step)`）——"删除已经发生的输入"用纯函数表达不了。
 *
 * 所以拆成三个钩子（`redact` / `opaqueFromToolResult` / `projectReasoning`），每个只做**纯文本变换**，
 * 触发权与按步状态都留在运行时。
 *
 * 同理，结果投影合并为一个 `projectResult`，而不是 `extractAnswer` / `classifyResult` /
 * `composeResult` / `artifacts` / `externalPending` 五个：它们共享同一份会话历史与业务状态
 * （blog 判候选稿要 `await storage.get()`，组装又要用同一批候选取长度预算），拆开会让业务在
 * 四处重复查询同一份数据。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type Schema from '@deepseek-ai/schemastery'
import type { ToolDescriptor, AgentSelfCheck, Actor } from '@dsh-plugin-manager/plugin-kit'
import type {
  ParticipantArtifact,
  ParticipantExternalPending,
  ParticipantStatus,
} from './contract.ts'
import type { AgentStoragePort, TurnResultRecord } from './storage/ports.ts'

/** 业务注册工具时拿到的上下文。 */
export interface AgentToolContext {
  /**
   * 业务自己的存储门面。
   *
   * 装配侧（`createAgentRuntime`）总是带着存储调用本钩子；`undefined` 只为"装配侧没有存储"
   * 这一种情况保留，业务要自己处理它。
   */
  readonly storage: AgentStoragePort | undefined
  /**
   * 会话 id。
   *
   * ⚠️ 注册发生在**装配期**、那时还没有任何会话，所以这里**恒为 `undefined`**。它留在签名里
   * 是因为同一个钩子在"每会话"语境下也说得通（工具执行时能拿到会话）；**不要**据此把注册
   * 挪到会话路径上去——见 {@link AgentDefinition.tools}。
   */
  readonly conversationId: string | undefined
  /**
   * 注册工具用的 cordis Context：装配侧传进来的那一份，也就是**这个 Agent 自己的作用域**。
   *
   * ⚠️ 它**不是**某个会话的 agent 作用域——那个要等 `ctx.agents.create()` 才存在，而注册在
   * 装配期只发生一次。所以 `ctx.effect(...)` 登记的东西跟着**装配**释放，不跟着某个会话释放；
   * 会话级的东西（人设段、工具限制）由运行时在 `setup()` 里做。
   */
  readonly ctx: Context
}

/** 会话历史里的一条消息。 */
export interface TurnMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** 可展示的思考快照（已按业务口径脱敏）。 */
  readonly thinking?: string
  readonly time: number
  /**
   * 官方消息 id（`user/message` 的事件载荷本身就是消息，`assistant/message` 是
   * `{ message, … }` 包装）。
   *
   * 业务用它把自己的记录与消息对上（例如"这条用户消息对应我的哪一行请求"）。**不是**业务
   * 自己的 `requestId`：官方事件里没有那个字段，业务侧的对应关系要靠它自己去查。
   */
  readonly id?: string
  /**
   * 这条消息属于哪一回合（`turn/start` 的 `turn`）。
   *
   * 缺省表示历史里**没有** `turn/start` 事件（例如只发消息与 `turn/end` 的测试替身），
   * 此时全部消息同属一个**隐式回合**（`TurnHistory.turn` 也是 `undefined`）。
   *
   * ⚠️ "哪几条消息属于本轮"必须按它判定，**不要**拿 `finalText` 或"最后一条 assistant"近似：
   * 一轮里每一步的正文后面都跟着一次工具调用，只有**最后一条**才是答案。
   */
  readonly turn?: number
  /**
   * 这一条是**被中断**（或失败重试）的产出：官方 `assistant/message` 的 `data.interrupted`，
   * 以及 `assistant/attempt`（后者恒为 `true`）。
   *
   * ⚠️ 它**不**参与 `TurnHistory.tail`：被中断的正文不是这一轮的答案。但
   * {@link TurnHistory.finalText} **仍会取它**——"最后一条 message 的正文"与"算数的答案"
   * 是两件事，别拿前者当后者。
   */
  readonly interrupted?: boolean
}

/** 一轮会话的历史，供结果投影与自检使用。 */
export interface TurnHistory {
  readonly messages: readonly TurnMessage[]
  /** 会话 id；没有会话时为空串。 */
  readonly conversationId: string
  /** 本轮模型给出的最终正文（可能为空：模型只调了工具没说话）。 */
  readonly finalText: string
  /** 最后一轮的回合号（最后一次 `turn/start` 的 `turn`）；没有 `turn/start` 时为 `undefined`。 */
  readonly turn?: number
  /**
   * 这一轮**算数的正文**是哪一条：本回合内**最后一条未被中断、且有正文**的 assistant 消息。
   *
   * 它与 {@link finalText} 的区别是**刻意的**：`finalText` 取"最后一条 `assistant/message` 的
   * 正文"，被中断的那条也算；`tail` 只在**未被中断**的消息里取。所以
   * "最后一条 `assistant/message` 带了 `interrupted`"这种情形下，两者**不同**——拿 `finalText`
   * 当答案会**静默改变答案提取语义**（把一次被中断的产出当成最终回答交出去）。
   *
   * 没有可算数的正文（例如本轮被停止、或只调了工具没说话）时为 `undefined`；此时调用方按
   * 自己的口径兜底（运行时的兜底投影用 `finalText`）。
   */
  readonly tail?: TurnMessage
}

/** 结果投影的输入。 */
export interface ResultContext {
  readonly history: TurnHistory
  /**
   * **发起这一次派活**的 actor。
   *
   * ⚠️ 它必须在上下文里，而**不能由业务闭包捕获**：`definition` 是**每 Agent 一份**（装配期造
   * 一次），而 `actor` 是**每请求**的。闭包捕获只能拿到装配期的占位值、或"第一个请求的 actor"，
   * 于是业务的投影会拿它去查**别人的**数据（或者干脆查不到，静默返回空）。
   *
   * 需要"按 owner 读业务库"的投影（例如「这份候选稿是不是当前 owner 的」）必须用它派生 owner 键。
   * 转发给别人用之前先想一次：**鉴权用的是同一个 actor 吗**。
   */
  readonly actor: Actor
  /**
   * 派单时收到的请求。
   *
   * `acceptance` 是这一步的验收口径（可能没有）；`reworkOf` 表示这次是重做、填被重做的子任务 id。
   * 两者都由协调方给出，业务只用它们做自检与措辞，**不要**据此改变业务语义。
   */
  readonly request: {
    readonly message: string
    readonly acceptance?: string
    readonly reworkOf?: string
  }
  /** 业务自己的存储门面；「查候选稿」这类投影需要它读业务状态。 */
  readonly storage: AgentStoragePort | undefined
  /**
   * 读**本轮**交回的结果记录（`dsh_turn_results`）——本轮的结构化产出，例如
   * "这一轮准备了哪份候选稿"「这一轮留下了哪条待确认的操作」。
   *
   * ## 为什么是函数而不是数组
   *
   * **惰性**：不是每个 Agent 的投影都需要它（`closedoff` 就不需要），而每轮多一次查询对它们
   * 是纯开销。给一个读取函数，由业务按需 `await`。
   *
   * ## 口径
   *
   * - 只读**本轮**（按 `dsh_turns.id` 那一行筛）：跨轮查询没有上界，运行时不做；要跨轮就由
   *   业务用自己的业务表查。
   * - 没有存储门面、这一轮还没落地、或这一轮没落过结果时都返回**空数组**（都不抛错）：
   *   "没有结果"是常态（多数轮次只交一段正文），不是异常。
   * - 同一轮内按插入序（`seq`）返回。⚠️ 一轮里**同一次操作可以有多条结果**（不同 `kind` /
   *   `revision`），结果是**追加**的：同一个 `operationId` 出现多次是正常的，别假设唯一。
   */
  readonly loadResults: () => Promise<readonly TurnResultRecord[]>
}

/** 一轮会话投影出的交回结果。 */
export interface ProjectedResult {
  readonly status: ParticipantStatus
  readonly text: string
  readonly artifacts?: readonly ParticipantArtifact[]
  readonly externalPending?: ParticipantExternalPending
  /** `status: 'waiting'` 时要用户回答的问题。 */
  readonly question?: string
  /**
   * **业务自报的自检结论**（可选）。
   *
   * 它是 ⑦ 第 2 条的输入：只有 `passed` 算"自检通过"；`unverifiable`（这一轮没有可核验的
   * 产出）与缺省（**执行方没实现自检**）都如实标为"未核验"，**只有 `failed` 计入不达标**。
   *
   * ⚠️ 它**不是**回报给协调方的那一份：协调方拿到的是运行时跑完 ⑦ 之后的汇总结论
   * （`ParticipantResult.selfCheck`），由 `toSelfCheck()` 产出。两者方向相反，别混。
   */
  readonly selfCheck?: AgentSelfCheck
}

/** `judge` 的输入（⑧ 有界自修正用）。 */
export interface JudgeInput {
  readonly result: ProjectedResult
  /** 这一步的验收口径；没有声明时为 `undefined`。 */
  readonly acceptance: string | undefined
}

/** `judge` 的结论。 */
export interface JudgeResult {
  /** `true` 表示达标，不必重跑。 */
  readonly ok: boolean
  /** 不达标时交给下一次尝试的说明（会进重做请求）。 */
  readonly reason?: string
}

/** 思考投影的上下文。 */
export interface ReasoningProjectionContext {
  /**
   * 从工具结果里提取出的、**不可外传的标识**。
   *
   * 由运行时代管累积：每次 `tool/result` 到达就调一次
   * {@link AgentDefinition.opaqueFromToolResult}，把结果并进这个集合，再传给投影。
   */
  readonly opaqueValues: readonly string[]
  /** 本轮是否已收尾：`true` 时最后一段还没写完的内容也可以发布。 */
  readonly releaseTail: boolean
}

/** 一次回合的结局；只在 {@link AgentDefinition.onTurnFinish} 上出现。 */
export type TurnOutcome = 'completed' | 'cancelled' | 'failed'

/**
 * 回合**起止时点**给业务的上下文。
 *
 * 为什么需要这两个时点：`projectResult` / `judge` / `stageText` 都挂在"回合已经结束、要交回什么"
 * 这一点上，而有些业务在**回合开始时**就要做事（把宿主任务系统的句柄与本轮绑起来、落一条"本轮
 * 已受理"的镜像、预校验模型能力），在**回合结束时**还要做另一件（把最终状态写回自己的表、解除绑定）。
 *
 * ⚠️ 运行时**不知道**业务在这两个时点做什么，它只保证"**时点准确、拿到本轮的身份**"。例如 blog 会在
 * 这里绑宿主的任务句柄（`ctx.jobs`）——那是**业务语义**，不是运行时的概念，所以这个上下文里
 * **没有**任何"任务 / 作业"字段：业务用闭包拿自己的东西，只从运行时取**它才知道的东西**。
 */
export interface TurnHookContext {
  readonly conversationId: string
  readonly actor: Actor
  /** 本轮的 agent 句柄：交给宿主任务系统、或读会话事件时用它。 */
  readonly agent: Agent
  /**
   * 本轮所在会话的**宿主句柄**（`Conversation.handle`）。
   *
   * 与 {@link TurnHookContext.agent} 的关系：`agent` 就是 `handle.agent`；而句柄本身还要用来做
   * 别的事——读会话事件（`handle.read()`）、等宿主空闲、释放句柄。业务**按 Agent 建业务绑定**
   * （`WeakMap<Agent, …>`）时键取 `agent`，但绑定对象里往往也要留下句柄。
   *
   * ⚠️ **为什么必须由运行时给**：句柄是 `lifecycle.open()` 创建的，业务**拿不到创建点**，
   * 它只在钩子上被叫醒。少了这个字段，业务只能自己造一个"只有 `agent` 的假句柄"——那是**类型上
   * 的谎**：一旦有别的读点（`whenIdle` / `dispose` / `read`）就在运行期炸，而且指向别处。
   * 运行时调用钩子时手上正拿着这个会话 ⇒ 原样给出，零成本、无歧义。
   */
  readonly handle: AgentHandle
  /** 业务自己的存储门面；未注入时为 `undefined`。 */
  readonly storage: AgentStoragePort | undefined
  /**
   * 这一轮的**幂等身份**（协作入口驱动的一轮才有）。
   *
   * 它是这次派活的幂等键，也是落 `dsh_turns.request_id` 的那个值；协作入口用
   * `run:<requestId>` / `reply:<requestId>` 两个命名空间（见 `participant.ts` 的 `settledKey`），
   * 所以**续问与首次派活的身份不会互撞**。
   *
   * ⚠️ **两条驱动路径不一样，缺省是常态而不是异常**：
   * - **协作入口**（`participant.ts`）驱动的一轮：有。
   * - **页面路径**（`closedoff/src/web.ts` 直接调 `lifecycle.followup`）：**没有** —— 用户点一下
   *   发一条消息，没有可重放的幂等身份。这里是 `undefined`，运行时**不会**替它编一个
   *   （编出来的键会被业务当成稳定凭据）。
   */
  readonly requestId?: string
  /**
   * 这一轮在 `dsh_turns` 里的**行 id**（`TurnRecord.id`）。
   *
   * ## ⚠️ 它不是 `requestId`（DDL 专门写了这条"同名不同义"）
   * `dsh_turn_results.turn_id` 指向的是**行 id**，而幂等身份是
   * `(agent_id, owner_namespace, owner_id, request_id)` 上的**部分唯一索引**。两者可以完全不同。
   * 而 `claim` 只回答"认领成功 / 重复"、**不返回行 id** ⇒ 运行时用
   * `turns.turnId(owner, requestId)` **回查一次**、随三个钩子原样下传（不是每个钩子查一次 PG）。
   *
   * ## 什么时候是 `undefined`（三种，都不是异常）
   * 装配没注入存储门面 · 页面路径（没有幂等身份，无从回查） · 这一行还没落地。
   *
   * ## 业务为什么需要它
   * ①把**宿主任务系统的句柄与这一轮绑起来**（句柄是按 agent 索引的，而"这一轮是哪一行"只有它有）；
   * ②把结构化产出写进 `dsh_turn_results`（`turn_id` 要的正是行 id）。
   * 少了它，"按回合记账"的业务能力在运行时接管回合之后会**静默失效**：工具拿不到绑定就**全部 403**，
   * 结果一行都落不下 ⇒ 依赖结果记录的状态（例如"候选稿待采用"）永远不出现。
   */
  readonly turnId?: string
}

/**
 * 本轮要送进会话的内容。
 *
 * 缺省时运行时自己造"单块正文"——这与老口径逐字一致。业务要送**附件块 / 图片块**、或要按本轮
 * 状态决定送什么时，覆盖 {@link AgentDefinition.composeTurnInput}。
 */
export interface TurnInput {
  /** 调用方给的那句话（已 `trim`）。 */
  readonly text: string
  readonly conversationId: string
  readonly actor: Actor
}

/**
 * 一个 Agent 的全部业务声明。
 *
 * **身份与声明不在这里重复**：`id` / `displayName` / `description` / 分类由 `mount()` 从
 * `AgentMountContext` 取（`host.ts:51-57` 写明分类只有那一个权威来源，子包自己再写一份就会与
 * 清单漂移，而漂移的后果是本 Agent 的工具全部不可见、界面上还完全看不出来）。这里的三项是
 * 运行时需要的那一份，取值由 `mount()` 注入。
 */
export interface AgentDefinition {
  /** 与插件清单 `deepseekPlugin.id` 一致。 */
  readonly id: string
  readonly displayName: string
  readonly description: string

  // —— 业务内容 ——

  /** 系统提示词里这个 Agent 的人设。 */
  readonly persona: string
  /**
   * 业务工具。
   *
   * **注册**：由**装配侧**做——`createAgentRuntime()` 在装配期调用本钩子**一次**
   * （`{ ctx, storage, conversationId: undefined }`），把返回的描述符交回来，装配代码再用
   * `registerPlugin({ tools })` 登记。它发生在**插件级**、整条进程只发生一次。
   *
   * **限制**：由**运行时**在每个会话的 **agent 作用域**内做——
   * `ConversationLifecycle.setup()` 里的 `agentCtx.tools.restrict({ allow: allowedTools() })`。
   * 宿主不允许在插件上下文里做工具限制，落到插件级会波及所有 Agent 并被直接拒绝。
   *
   * ⚠️ 两件事都不在 `createParticipant()`（每会话路径）里。工具注册属于装配期，放进每会话
   * 路径会重复注册、改变工具的生命周期语义；本钩子此前**没有任何调用点**，工具因此不会被注册，
   * 而且不报错——唯一调用点就是 `createAgentRuntime()`。
   */
  readonly tools: (ctx: AgentToolContext) => readonly ToolDescriptor[]

  // —— 输出管线：三个独立钩子，时序与状态由运行时代管 ——

  /** 正文与状态行的**无状态**文本变换（脱敏）。缺省 = 不改写。 */
  readonly redact?: (text: string) => string

  /**
   * 从工具结果里提取**不可外传的标识**（业务主键、内部 id）。
   *
   * **这是安全钩子。** 运行时在每次 `tool/result` 到达时调用它，把结果累积进 opaque 集合，
   * 并据此替换思考快照里的敏感值。缺省 = 不替换。
   */
  readonly opaqueFromToolResult?: (resultText: string, meta: unknown) => readonly string[]

  /**
   * 思考投影：把模型原始推理转成可展示快照。
   *
   * 运行时负责全部时序（按 step 累积、废弃尝试丢弃、回合结束收尾补发），只把 `opaqueValues`
   * 与 `releaseTail` 传进来——业务做纯文本变换。
   */
  readonly projectReasoning?: (raw: string, ctx: ReasoningProjectionContext) => string

  /**
   * 实时通道语义。
   *
   * `'delta'`（缺省）：执行方发的是**增量**，运行时代管前缀单调与发布边界。
   * `'cumulative'`：执行方发的是**累计值**，运行时按前缀算差后再走同一条发布路径
   * （blog 的思考通道是累计值）。
   */
  readonly liveMode?: 'delta' | 'cumulative'

  /**
   * 会话寻址方式：协调方给的 `missionId` 能不能**直接寻址到会话**，缺省 `'per-dispatch'`。
   *
   * - `'per-dispatch'`（缺省）：**每次打开都铸一个新 id**。要再开同一个任务的会话，调用方得自己
   *   记住上一次那个 `conversationId`（`ParticipantRequest.conversationId` 就是干这个的）。
   * - `'derived'`：会话由 `missionRequestId(owner, missionId)` **派生**——它是 `missionId` 的纯函数，
   *   在 `dsh_conversations` 的部分唯一索引（`WHERE request_id <> ''`）上保证"**同一 mission 只有
   *   一条会话**"，跨进程、跨重启都成立，**不需要任何映射表**。命中既有行时恢复那一条，绝不再建。
   *
   * ⚠️ **为什么是一条声明，而不是 `if (agentId === 'blog')`**：这条统一**只对 blog 成立**
   * （设计 §3.2 line 359）：closedoff 首次派活时拿不到协调方给的 id（它自己铸），管家也自己铸；
   * 而 blog 的 `blog-chat-` 前缀被备份/恢复的正则硬绑（`conversation.ts` 的 `CONVERSATION_PREFIX`），
   * 只有"会话 id 仍由 Agent 自己铸、幂等键由 mission 派生"这个组合能同时满足两边。写成按 agentId
   * 的分支，等于让"下一个 Agent 要不要派生"变成没人知道该改哪里的隐式约定。
   *
   * ⚠️ **它只改"新建与恢复的寻址"，不改会话 id 的格式**：id 永远由 Agent 自己的前缀 + v4 UUID
   * 铸（`newConversationId`），派生出来的是**幂等键（`requestId`）而不是 id**。两者不是一回事，
   * 混起来会以为"会话 id 变成可重算的了"。
   */
  readonly conversationAddressing?: 'derived' | 'per-dispatch'

  // —— 结果投影：一个钩子，覆盖四件事 ——

  /**
   * 把一轮会话投影成交回结果：答案抽取 / 状态判定 / 文本组装 / 产物声明。
   *
   * 缺省时运行时用**兜底投影**：正文取最终消息、状态按回合结局判定、材料为空。
   * 这条兜底必须存在——"没调交活工具"不等于失败（见 §4.3）。
   */
  readonly projectResult?: (ctx: ResultContext) => Promise<ProjectedResult>

  /** ⑧ 有界自修正的判定；缺省 = 不做业务判定（只跑程序性校验）。 */
  readonly judge?: (input: JudgeInput) => Promise<JudgeResult>

  /** 会话事件 → 状态行文案。缺省 = 不发状态行。 */
  readonly stageText?: (event: SessionEvent) => string | undefined

  /**
   * 会话事件 → 侧栏预览消息（缺省只取用户与助手的正文）。
   *
   * 有自己展示口径的业务要覆盖它：closedoff 的 `projectHistory` 会带上设备轨迹半径、
   * 工具调用摘要与思考快照，blog 的是另一套。缺省实现的强度刻意很弱——**宁可少显示，
   * 也不替业务编一份它没要求的预览**。
   */
  readonly projectHistory?: (events: readonly SessionEvent[]) => readonly {
    readonly role: 'user' | 'assistant'
    readonly text: string
    readonly reasoning?: string
    readonly time: number
  }[]

  // —— 交互与呈现 ——

  /**
   * 本轮是否需要用户补一句话才能继续。
   *
   * 这是 `status: 'waiting'` 的**唯一来源**。缺省 = 永不等待。
   * 协调侧要求子任务确实进入 `waiting_user`，且**重启后仍能恢复"在等什么"**，所以运行时
   * 必须把它持久化（`dsh_turns` 的待答问题列），不能只留在内存。
   */
  readonly needsReply?: (ctx: ResultContext) => boolean

  /** 会话标题的来源与更新；运行时复用 kit 的 `registerConversationTitles`。 */
  readonly title?: (history: TurnHistory) => string | undefined

  // —— 回合的起止时点与输入组合（业务可选，缺省行为与老口径逐字一致）——

  /**
   * **回合开始时**（用户消息注入**之前**）调一次，见 {@link TurnHookContext}。
   *
   * 抛错 ⇒ 这一轮按失败收尾（不会把消息注入进去）。这就是"回合开始时的业务记账/预校验"该在的位置：
   * 放在这里失败还来得及，放在消息注入之后就只剩"收拾残局"。
   */
  readonly onTurnStart?: (ctx: TurnHookContext) => void | Promise<void>

  /**
   * **回合结束时**调一次（成功 / 取消 / 失败**三条路都会调**），见 {@link TurnHookContext}。
   *
   * ⚠️ **它的失败不改变已经定下的结论**：收尾路径上的钩子如果能把回合改成失败，就等于给业务一个
   * "在终态之后翻案"的口子，协调方可能已经按前一个结论记过账了。所以抛错只记日志。
   * ⚠️ 调用是**不等待**的（`finish` 是同步方法）：业务要保证自己做过的事不依赖它完成。
   */
  readonly onTurnFinish?: (ctx: TurnHookContext & { readonly outcome: TurnOutcome }) => void | Promise<void>

  /**
   * 组合本轮要送进会话的**内容块**，见 {@link TurnInput}。
   *
   * 缺省 = `[{ type: 'text', text }]`（与老口径逐字一致）。业务要送附件块 / 图片块时覆盖它。
   * 抛错 ⇒ 这一轮按失败收尾（与 {@link onTurnStart} 同理，此时消息还没注入）。
   */
  readonly composeTurnInput?: (input: TurnInput) => Promise<readonly unknown[]> | readonly unknown[]

  /**
   * 这一轮的**系统提示动态上下文**（资料性，不是指令），见 {@link TurnHookContext}。
   *
   * 运行时在**注入消息之前**求值，把它交给宿主作为系统提示的动态上下文（DSH 的
   * `systemPrompt.context`，其 `text` 可以是**每次装配时求值**的 provider）⇒ 模型看到的是
   * **这一轮**的快照，而不是"打开会话那一次"的那份。返回空串表示这一轮不贡献上下文。
   *
   * ⚠️ **它存在的理由**：业务原来可以"一轮一命"（每轮 `create`/`resume`、每轮跑一遍 `setup`）把
   * 每轮才有的资料（操作快照、时间基准）注册进系统提示；换成运行时的**长驻句柄复用**之后，
   * `setup` 只在打开会话时跑一次，那条路就没了。这个钩子就是那座桥——**内容与是否贡献由业务决定，
   * 而"每轮求值"由运行时保证**。
   *
   * ⚠️ 抛错 ⇒ 这一轮按失败收尾（与 {@link onTurnStart} 同理：此时消息还没注入，还来得及）。
   */
  readonly turnContext?: (ctx: TurnHookContext) => Promise<string> | string

  // —— 存储与配置 ——

  /** 业务表迁移（PG，按版本顺序）。机制表由运行时管理。 */
  readonly businessMigrations?: readonly string[]

  /**
   * 业务配置 schema；运行时用它校验 `mount()` 收到的原始配置。
   *
   * 类型参数刻意留空（= `Schema<any, any>`）而不是写 `Schema<unknown>`：`Schemastery<S, T>`
   * 的调用签名在 `S` 上是**逆变**的，写成 `Schema<unknown>` 会让**任何**真实 schema
   * （`Schema<Config>`、`Schema<BlogConfig>`）都不可赋值——那等于这个字段只收得下手造的值。
   */
  readonly config: Schema

  /**
   * ⑥ 观察的声明位，缺省 `'signal'`（本期只给信号：进度、耗时、重试次数）。
   *
   * 它**不改契约**：跨边界进度契约是封闭枚举 + 白名单投影，`'process'` 要真正生效需要另开通道。
   */
  readonly observe?: 'signal' | 'process'

  /**
   * ⑧ 有界自修正的重跑次数上限：**默认 1、上限 3**（写死在这里，不接受更大的值）。
   *
   * 上限是硬约束，不是保守估计：每次自修正都要**再跑一整轮**（注入一条 user message、
   * 等模型重新作答），没有上界时"再试一次"会变成不受控的循环，而它烧的是同一份超时预算。
   *
   * **一次自修正按 0.5 次重做预算折算** —— 那是内环预算的记账口径：协调侧按"重做次数"
   * 分配预算，而自修正是执行侧内部的局部循环，按半次折算才不会让某个 Agent 的内部重试
   * 吃掉整条链路的预算。这个折算只影响记账，不影响这里实际跑几轮。
   *
   * ⚠️ **这条折算目前没有任何代码实现**（别以为已经有了）：runtime 不向协调侧报"这一轮跑了几
   * 次自修正"，协调侧也就无从按半次记账 —— 结果是自修正对预算**是免费的**，协调侧看到的仍
   * 是一次重做。P5 做协调侧预算时必须二选一：在结果里报出自修正轮数让它折算，或删掉这条规则。
   */
  readonly maxSelfRetries?: number
}
