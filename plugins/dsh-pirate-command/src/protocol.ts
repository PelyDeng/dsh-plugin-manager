/** 插件间只交换公开契约；业务插件保留自己的 Agent、身份和成果存储。 */
import type { Context } from '@deepseek-ai/cordis'
import { AccessError, type Actor } from '@dsh-plugin-manager/plugin-kit'

export type CrewId = 'closedoff' | 'blog'
export type ParticipantStatus = 'completed' | 'waiting' | 'cancelled' | 'failed'
export interface ParticipantArtifact {
  readonly title: string
  /** 只允许本站插件内的路径，由发布方经过权限检查后提供。 */
  readonly path: string
  readonly kind: 'conversation' | 'draft' | 'confirmation' | 'report'
}
export interface ParticipantProgress {
  readonly kind: 'status' | 'message' | 'delta' | 'thinking'
  /** 状态或消息正文；`delta` 与 `thinking` 类型不带正文，分别只用各自的专用字段。 */
  readonly text?: string
  /**
   * 流式正文增量，只在 `kind: 'delta'` 时出现。
   *
   * 用途是让协作视图能边收边显示，而不是等回合结束一次性蹦出全部内容。生产者只发送
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
}
export interface AgentParticipant {
  readonly protocol: 1
  readonly id: CrewId
  readonly displayName: string
  readonly description: string
  /** 每次列出、运行和读取结果都重新检查原插件权限。 */
  assertAccess(actor: Actor): void
  run(request: ParticipantRequest): Promise<ParticipantResult>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'pirate/participants': (accept: (participant: AgentParticipant) => void) => void
  }
}

export function participants(ctx: Context): Map<CrewId, AgentParticipant> {
  const result = new Map<CrewId, AgentParticipant>()
  ctx.root.emit('pirate/participants', participant => {
    if (participant.protocol !== 1 || !['blog', 'closedoff'].includes(participant.id) || result.has(participant.id)) {
      throw new AccessError(503, '协作插件协议不兼容或重复登记')
    }
    result.set(participant.id, participant)
  })
  return result
}

export function registerParticipant(ctx: Context, participant: AgentParticipant): () => void {
  if (participants(ctx).has(participant.id)) throw new Error('协作插件重复登记：' + participant.id)
  return ctx.on('pirate/participants', accept => accept(participant), { global: true })
}
