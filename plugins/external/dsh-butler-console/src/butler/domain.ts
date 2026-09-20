/**
 * 编排领域类型（拆分 v2 批 2）：会话、计划提交、回合与四类 Prepared* 载荷的纯类型。
 */

import { modelTakesImages } from '../vision.ts'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import type { ConversationModel } from '@dsh-plugin-manager/plugin-kit/models'
import type { ButlerAgentExecutor } from '../protocol.ts'
import type { ButlerAttachmentRecord, SubtaskRecord } from '../storage/types.ts'
import type { SubtaskState } from '../task-model.ts'
import type { AgentCard } from '../agents.ts'

/** 一次牛马大总管的已打开会话。 */
export interface Conversation {
  readonly id: string
  readonly handle: AgentHandle
  /**
   * 这个会话当前用的模型路由。
   *
   * 留着它是为了回答一个只有这里知道的问题：**这个会话的模型收不收图片**。会话模型可以中途
   * 切换（页面上的模型选择器），所以判断要现查，不能缓存成布尔。
   */
  readonly selection: ConversationModel
  active: boolean
  lastUsedAt: number
}

/** 模型通过 `butler_plan` 交回的计划。 */
export interface PlannedSubtask {
  readonly goal: string
  readonly agentId: string
  readonly reason: string
  /**
   * 这一步自己的验收口径；**缺省就是这一步没有口径**（不沿用任务级口径——见下方
   * `dispatchSubtask` 的说明）。
   *
   * 与任务级分开：同一次任务里各步的产出物种类不同（一步交草稿、一步交发布确认），
   * 只留任务级口径会把它们按同一个标准核验。
   */
  readonly acceptance?: string
  /** 目标标识；沿用旧目标时由模型给出，新目标留空由管家分配。 */
  readonly logicalId?: string
  /** 替代哪一条子任务；首次尝试不填。 */
  readonly supersedes?: string
  /** 前置目标标识；派这一步之前按就绪表逐个核验。 */
  readonly dependsOn?: readonly string[]
  /** 这一步是否真的需要外部动作已经办完；不填按「材料够用」算。 */
  readonly requiresExternalAction?: boolean
}

export interface PlanSubmission {
  readonly reply: string
  readonly note: string
  /** 这一次的验收口径（顶层声明）；空串表示没有声明。 */
  readonly acceptance: string
  readonly subtasks: readonly PlannedSubtask[]
}

/** 收尾原因：正常结束、出错或被取消。 */
export type TurnOutcome = { readonly kind: 'completed' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'cancelled' }

/** 一轮的记录，事件到达时由 `observe()` 填充。 */
export interface Turn {
  /** 这一轮开始时在场且可调度的成员，用于渲染动态名单。 */
  readonly members: readonly AgentCard[]
  /**
   * 这一轮改的是哪个任务、它已有哪些尝试。
   *
   * 只有补充轮才有：新的一轮还没有任务，也就谈不上「替代某一条旧尝试」。派活工具用它校验
   * `supersedes`，让模型当场拿到错误并改正，而不是等计划落库之后才发现指向了不存在的东西。
   */
  readonly context?: { readonly taskId: string; readonly subtasks: readonly SubtaskRecord[] }
  plans: PlanSubmission[]
  text: string
  done: boolean
  outcome: TurnOutcome
  resolve: (outcome: TurnOutcome) => void
}

/** 子任务执行结论，供汇总阶段使用。 */
export interface SubtaskOutcome {
  readonly state: SubtaskState
  /** 交给牛马大总管汇总时使用的结果正文。 */
  readonly report: string
}

/** 一位正在等待用户回话的成员。 */
export interface WaitingMember {
  readonly executor: ButlerAgentExecutor
  readonly agentId: string
  readonly displayName: string
  /** 该成员原业务会话：进度早期上报或结果落库的引用，续问时沿它续接（G01/G02）。 */
  readonly conversationId?: string
}

/**
 * 一次已经受理、准备执行的回合。
 *
 * 校验和执行分开写，是为了让「提交」这一步能同步拿到 `400`／`409` 这类可预期的失败。
 * 如果校验也挪进后台，页面与游戏侧只会看到一条 SSE 错误，分不清是自己参数写错了、
 * 还是前一轮还没跑完、还是服务本身坏了。
 */
/**
 * 一轮执行的可选挂接。
 *
 * 参数从"七个位置参数"改成对象，是因为这一轮要加第五件可选的东西（随消息发出去的图片）：
 * 位置参数的调用点已经要看注释才知道第几个是什么，再加一个只会更糟。
 */
export interface RunHooks {
  /** 正文增量：页面边说边出字。 */
  readonly onDelta?: (text: string) => void
  /** 这一轮的正文要重置（重试换了尝试）：页面清掉旧预览。 */
  readonly onReset?: () => void
  /** 补充轮才传：这一轮改的是哪个已存在的任务。 */
  readonly context?: { readonly taskId: string; readonly subtasks: readonly SubtaskRecord[] }
  /** 思考快照（覆盖语义），由调用方脱敏后展示。 */
  readonly onThinking?: (thinking: string) => void
  /**
   * 随这条消息一起发给模型的图片。
   *
   * **只在当前对话模型收图片时才会非空**：调用方先问过 `modelTakesImages`。模型收不了图片时
   * 宿主在发请求前会直接拒（`llm/src/index.ts:1052`），整轮对话会当场失败。
   */
  readonly images?: readonly ImageAttachmentRef[]
}

export interface PreparedTurn {
  readonly conversationId: string
  readonly conversation: Conversation
  /** 老板的原话。页面上显示的是它，任务的目标也是它——附件不往里掺。 */
  readonly text: string
  /** 发给模型的正文：原话 + 附件正文段。图片另走 {@link PreparedTurn.images}。 */
  readonly prompt: string
  /** 这一轮带的附件（可能为空）。落库后要绑到任务上，所以留在这里。 */
  readonly attachments: readonly ButlerAttachmentRecord[]
  /** 随消息直接交给模型的图片；**只有当前模型收图片时才非空**。 */
  readonly images: readonly ImageAttachmentRef[]
  readonly actor: Actor
  readonly runId: string
  readonly abort: AbortController
}

/** 一次已经受理的补话。 */
export interface PreparedReply {
  readonly conversationId: string
  readonly taskId: string
  readonly subtaskId: string
  readonly text: string
  readonly decideByAgent: boolean
  readonly actor: Actor
  readonly executor: ButlerAgentExecutor
  readonly agentId: string
  readonly displayName: string
  /** 成员原业务会话引用：来自早期上报或结果落库，交给执行方续接（可为空）。 */
  readonly memberConversationId?: string
  /**
   * 这一步的验收口径；空/缺省表示这一步没有可核验的口径。
   *
   * 续问沿用派单时那一份：口径描述的是「交回什么才算完成」，用户补一句话不会改变它。
   */
  readonly acceptance?: string
  readonly runId: string
  readonly abort: AbortController
}

/** 一次已经受理的操作决策：确认或取消某一条待办。 */
export interface PreparedAction {
  readonly conversationId: string
  readonly taskId: string
  readonly subtaskId: string
  readonly actionId: string
  readonly decision: 'confirm' | 'cancel'
  readonly note?: string
  readonly actor: Actor
  readonly executor: ButlerAgentExecutor
  readonly agentId: string
  readonly displayName: string
  readonly memberConversationId?: string
  readonly runId: string
  readonly abort: AbortController
}

/** 一次已经受理的补充：改的是当前这一轮的目标，不是另开一轮。 */
export interface PreparedSupplement {
  readonly conversationId: string
  readonly conversation: Conversation
  readonly taskId: string
  readonly text: string
  /** 这次补充被接受之后，任务所处的输入版本。 */
  readonly version: number
  readonly actor: Actor
  readonly runId: string
  readonly abort: AbortController
}
