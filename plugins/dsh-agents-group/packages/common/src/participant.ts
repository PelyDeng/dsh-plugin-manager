/**
 * 子包 Agent 与群组之间的协作契约。
 *
 * 子包自己造 Agent、自己用工具、自己管会话和成果，只在“有人要派活”时把这一层交出来：
 * 群组把它桥接成牛马大总管的执行入口（`src/butler-bridge.ts`）。契约故意很窄 ——
 * 身份、消息、进度、结果，四样都是纯数据，子包不必知道接管它的是谁。
 *
 * 这里曾经放在一个独立的协作入口插件里；那个插件移除后契约搬进群组的共享包，
 * 因为**只剩群组这一个消费者**，而子包本来就已经依赖这个包（构建期内联）。
 */
import type { Actor } from '@dsh-plugin-manager/plugin-kit'

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
  readonly kind: 'conversation' | 'draft' | 'confirmation' | 'report'
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
}
