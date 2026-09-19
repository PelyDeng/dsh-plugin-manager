/**
 * 运行时的协作契约（自 `@dsh-agents-group/common` 的 `src/participant.ts` 迁来）。
 *
 * 子包自己造 Agent、自己用工具、自己管会话和成果，只在“有人要派活”时把这一层交出来：
 * 群组把它桥接成牛马大总管的执行入口（`src/butler-bridge.ts`）。契约故意很窄 ——
 * 身份、消息、进度、结果，四样都是纯数据，子包不必知道接管它的是谁。
 *
 * 它现在住在运行时里，而不是共享组件包：协作机制（会话、工具、投影、交接）全在本包实现，
 * 契约与实现同包，机制只实现一次，业务只写 `AgentDefinition`。common 里的同名声明由本文件
 * 取代，common 的退役在 P4/P7 完成 import 切换后进行。
 */
import type { Actor, AgentAction, AgentActionDecision, AgentActionField, AgentActionState, AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'

/**
 * 待用户确认的操作：**直接复用 kit 的形状**，不再抄一份。
 *
 * 抄一份的下场在 `agent-resources` 那一批已经出现过：两边靠人眼对齐字段名，类型检查全绿而
 * 第一条数据就抛 `TypeError`。协调方（牛马大总管）与执行方必须看到同一个 `AgentAction`。
 */
export type ParticipantAction = AgentAction
export type ParticipantActionDecision = AgentActionDecision
export type ParticipantActionField = AgentActionField
export type ParticipantActionState = AgentActionState

/**
 * 协作契约的版本号。
 *
 * 接口里的 `protocol` 字段必须等于它；群组装载子包时核验，版本不匹配就直接失败 ——
 * 按错的约定派活比不派活更难查。
 */
export const PARTICIPANT_PROTOCOL = 1

/**
 * 一轮协作的结论状态。
 *
 * `waiting` 与 `external_pending` 都是「没跑完」，但不能混：前者等着用户在这里补一句话，
 * 后者是材料已经交回、剩下的事在别处办。合并成一个值之后，群组就没有依据告诉牛马大总管
 * 「这一轮能不能结束、能不能开新活」，只能靠猜。
 */
export type ParticipantStatus = 'completed' | 'waiting' | 'cancelled' | 'failed' | 'external_pending'
export interface ParticipantArtifact {
  readonly title: string
  /** 只允许本站插件内的路径，由发布方经过权限检查后提供。 */
  readonly path: string
  /**
   * 材料种类，由执行方自己定义（例如 `conversation`、`draft`、`article`）。
   *
   * 以前是封闭联合（`conversation` / `draft` / `confirmation` / `report`），改成开放字符串与
   * kit 的 `AgentArtifact` 对齐：新成员的业务产出（如「已发布的文章」）不需要来这里改一次
   * 联合再发版。`conversationArtifact` 用 `& { kind: 'conversation' }` 收窄，不受影响。
   */
  readonly kind: string
  /** 可核验的访问地址（如已发布文章的 URL）；渲染方白名单 http(s)，语义见 kit 的 `AgentArtifact`。 */
  readonly url?: string
  /** 材料状态标识（执行方自己的词表，如 `published` / `draft`）；供协调方程序对照。 */
  readonly state?: string
  /** 给人看的结构化行（复用 kit 的 `AgentActionField`），如「发布状态：已发布」。 */
  readonly fields?: readonly AgentActionField[]
}

/**
 * 材料已交回、还有事在别处等着办。
 *
 * 与 `status: 'waiting'` 的区别是「等谁」：这里等的是用户在**原页面**采用、确认或发布，
 * 不是在当前这条协作通道里补一句话。所以这一轮可以结束，但也不能算成功。
 */
export interface ParticipantExternalPending {
  /** 在等什么、由谁处理。这句会直接显示给用户。 */
  readonly reason: string
  /** 外部处理完之后可以做什么，可空。 */
  readonly next?: string
}
export interface ParticipantProgress {
  readonly kind: 'status' | 'message' | 'delta' | 'thinking'
  /** 状态或消息正文；`delta` 与 `thinking` 类型不带正文，分别只用各自的专用字段。 */
  readonly text?: string
  /**
   * 流式正文增量，只在 `kind: 'delta'` 时出现。
   *
   * 用途是让页面能边收边显示，而不是等回合结束一次性蹦出全部内容。生产者只发送
   * 面向用户的正文增量，不发送模型内部推理。
   */
  readonly delta?: string
  /**
   * 可展示的思考快照，只在 `kind: 'thinking'` 时出现。
   *
   * 是**完整覆盖**的最新快照，不是增量：消费方替换显示。生产者必须先按业务自己的口径
   * 脱敏，并且只发布稳定语句，不发布原始推理增量 —— 推理原文与内部标识都不外传。
   */
  readonly thinking?: string
  /** 获得业务会话标识后尽早交回；页面刷新不会丢失已开始的业务会话引用。 */
  readonly conversationId?: string
  /** 原插件核验归属后提供，须与 conversationId 同条返回；只表示可打开会话，不表示业务完成。 */
  readonly conversationArtifact?: ParticipantArtifact & { readonly kind: 'conversation' }
}
export interface ParticipantRequest {
  /** 来自入口认证服务，禁止从模型参数或请求 JSON 读取。 */
  readonly actor: Actor
  readonly missionId: string
  readonly requestId: string
  readonly message: string
  readonly conversationId?: string
  /**
   * 这一步的验收口径：交回什么才算完成。由协调方派单时给出，执行方拿它做本轮自检。
   *
   * 缺省表示没有声明口径（老协调方，或这一步本来就没有可核验的产出）——此时不施加
   * 「口径提到的产出物必须交回」那条校验，如实标记未核验，不判不达标。
   */
  readonly acceptance?: string
  /** 这一次派活是对哪一条尝试的重做：填被重做的子任务 id；缺省表示首次派活。 */
  readonly reworkOf?: string
  readonly signal: AbortSignal
  readonly onProgress: (progress: ParticipantProgress) => void
}
export interface ParticipantResult {
  readonly status: ParticipantStatus
  readonly conversationId: string
  readonly text: string
  readonly artifacts?: readonly ParticipantArtifact[]
  /**
   * `status: 'waiting'` 时要用户回答的问题。
   *
   * 与 `text` 分开：`text` 是已经拿到的阶段性成果，这个是等着用户回话的那一句。缺了它，
   * 群组会给用户一个没有问题的「等待」，用户不知道该回什么。
   */
  readonly question?: string
  /** `status: 'external_pending'` 时**必须**给出，理由见 {@link ParticipantExternalPending}。 */
  readonly externalPending?: ParticipantExternalPending
  /**
   * 等用户确认的操作（可空）。见 {@link ParticipantAction}。
   *
   * 与 `artifacts` 的分工：artifact 是"去那个页面看"，action 是"**在这里就能办**"。
   * 群组把它桥接成牛马大总管的执行入口结果，台账据此渲染一张确认卡——**新增一种操作
   * 不需要台账改一行代码**。
   */
  readonly actions?: readonly ParticipantAction[]
  /**
   * 对照 {@link ParticipantRequest.acceptance} 的自检结论；形状与语义沿用 kit 的定义。
   *
   * 缺省表示这一轮没有做自检（老参与者）——群组按未核验如实标记，不判不达标。
   */
  readonly selfCheck?: AgentSelfCheck
}
export interface AgentParticipant {
  readonly protocol: typeof PARTICIPANT_PROTOCOL
  /** 与插件清单 `deepseekPlugin.id` 一致，牛马大总管按它选择派给谁。 */
  readonly id: string
  readonly displayName: string
  readonly description: string
  /** 每次列出、运行和读取结果都重新检查原插件权限。 */
  assertAccess(actor: Actor): void
  run(request: ParticipantRequest): Promise<ParticipantResult>
  /**
   * 续问：沿原业务会话把用户的话交给同一位成员。
   *
   * **只有实现了它才暴露续问能力**——群组不因为「存在通用 run」就推断可以续问。
   * 请求里的 `conversationId` 是协调方落库的原会话引用，`requestId` 是这一次回话的
   * 幂等身份：同一次回话的重试复用同一 ID，新的回话用新 ID；同 ID 不同内容应拒绝。
   */
  reply?(request: ParticipantRequest): Promise<ParticipantResult>
  /**
   * 列出一位 owner 现在待确认的操作（刷新后补画用）。没实现时协调方只显示已收到的那一份。
   */
  listActions?(owner: string, actor: Actor): Promise<readonly ParticipantAction[]>
  /**
   * 执行用户对一条操作的决策。
   *
   * 与 `run`/`reply` 同一个身份链路：`request.actor` 是委派身份，实现方按它核验归属
   * （**不能**因为"协调方说可以"就放行）。**必须幂等**：同一 `actionId` 的重复确认返回同一结果。
   */
  applyAction?(request: ParticipantActionRequest): Promise<ParticipantResult>
}

/** 执行方收到的一次决策请求（由协调方转交）。 */
export interface ParticipantActionRequest extends ParticipantActionDecision {
  /** 这条操作属于哪一次派活：执行方用它核对归属，也用于日志与幂等。 */
  readonly taskId: string
  readonly subtaskId: string
  readonly actor: Actor
  /** 原业务会话引用；没有时缺省。 */
  readonly conversationId?: string
  readonly signal: AbortSignal
}
