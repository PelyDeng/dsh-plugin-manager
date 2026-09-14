/**
 * 跨插件的「派活」契约：一个插件把自己的 Agent 交给另一个协调方使用。
 *
 * 这是**两个插件之间**的接口。双方不互相导入源码，只按事件名与字段对齐，所以字段名各写
 * 一份就会静默失配：本项目出现过协调方读 `stage`、执行方发 `text`，执行方的第一条进度就
 * 让协调方抛 `TypeError`，整轮子任务当场失败，而两侧的类型检查全绿。契约只在这里定义
 * 一次，双方都从这里导入，这类失配就变成**编译错误**。
 *
 * 事件名（谁向谁登记）不由本模块规定：那是协调方的事，它自己声明并用自己的契约测试守住。
 */
import type { Actor } from './access.ts'

/** 一次执行处于哪个协作环节，用于点亮协调方页面上的链路。 */
export type AgentExecutionPhase = 'analyzing' | 'tool' | 'waiting_user'

/**
 * 一次进度上报。
 *
 * `stage` 必填：协调方拿它当状态行显示，缺了会把整轮打成失败（不是显示空白）。
 */
export interface AgentExecutionProgress {
  /** 页面显示的状态行，例如「正在查询园区数据」。 */
  readonly stage: string
  /** 补充说明，可空。 */
  readonly detail?: string
  /** 当前协作环节；不传时只更新状态文字，不改变链路。 */
  readonly phase?: AgentExecutionPhase
  /** 正在调用的工具名，用于「正在翻阅资料：xxx」这类展示。 */
  readonly tool?: string
  /**
   * 新增的正文片段，按调用顺序拼接就是这一轮的完整发言。
   *
   * 传增量而不是整段：页面上是边说边出字的，整段覆盖会让气泡内容来回跳。
   */
  readonly delta?: string
  /**
   * 可展示的思考快照，**完整覆盖**而不是增量：消费方替换显示。
   *
   * 内容由执行方按自己的口径脱敏，只放稳定语句与公开信息，不放原始推理与内部标识。
   */
  readonly thinking?: string
  /** 声明需要用户补充信息；协调方据此进入等待状态并给出回复入口。 */
  readonly needsReply?: boolean
  /**
   * 执行方的业务会话标识，获得后**尽早**随进度交回。
   *
   * 协调方落库后，业务已开始、final 前失败或进程重启时仍能找回原会话引用；它只表示
   * 「能打开那个会话」，不表示业务完成。须与 `conversationArtifact` 同条上报。
   */
  readonly conversationId?: string
  /** 原插件核验归属后提供的会话材料定位，与 `conversationId` 同条交回。 */
  readonly conversationArtifact?: AgentArtifact & { readonly kind: 'conversation' }
}

/** 发起一次派活的请求。 */
export interface AgentDispatchRequest {
  readonly taskId: string
  readonly subtaskId: string
  readonly goal: string
  /** 完整简报：含整体目标、这位成员负责的部分和产出要求。 */
  readonly brief: string
  readonly taskGoal: string
  /** 协调方做数据归属用的稳定键；鉴权请用 `actor`。 */
  readonly owner: string
  /**
   * 发起者的完整身份。
   *
   * `owner` 不足以鉴权：它是单向压出来的键，丢失了登录会话标识，也没有接口能反推回
   * `Actor`，所以必须原样传这一份。
   */
  readonly actor: Actor
  /** 进度上报；执行方可以不调用，协调方会按派发与结束补全时间线。 */
  readonly onProgress?: (update: AgentExecutionProgress) => void
  /** 用户取消、超时或插件卸载时中止；执行方应尽快释放自己的 Agent。 */
  readonly signal: AbortSignal
}

/** 用户对一位正在等待的成员的回复。 */
export interface AgentReplyRequest {
  readonly taskId: string
  readonly subtaskId: string
  /**
   * 本次回复的幂等身份：同一次受理（含其重试）复用同一 ID，新的回复用新 ID。
   *
   * 与 `subtaskId` 是两回事：后者标识子任务，前者标识「这一次回话」。执行方按它去重，
   * 同 ID 不同内容应拒绝，避免重试把同一句话派两遍。
   *
   * **必填，缺失即拒绝**：本仓库公共侧当前没有 `reply` 的实现方或消费方（已核对
   * example/doc/integrations），但这只是仓库内的核对事实，不推断为外部没有未审计的
   * 使用者；任何实现都不应接受缺失的 requestId 或用其他字段伪造幂等身份——回落会
   * 让同一子任务的多次回话撞同一个键。
   */
  readonly requestId: string
  readonly text: string
  /** 用户选择「你看着办」时为 true，执行方自行决定，不必再追问。 */
  readonly decideByAgent: boolean
  /**
   * 该成员原业务会话：来自协调方落库的早期引用，执行方沿它续接，不再新建会话。
   * 没有引用时缺省，由执行方按自己的规则处理。
   */
  readonly conversationId?: string
  readonly owner: string
  readonly actor: Actor
  readonly onProgress?: (update: AgentExecutionProgress) => void
  readonly signal: AbortSignal
}

/**
 * 一次派活的结论状态。
 *
 * `waiting_user` 与 `external_pending` 都是「这一轮没跑完」，但等的东西不一样，不能混用：
 *
 * - `waiting_user`：等着用户在这里补一句话才能继续。协调方会给出回复入口，任务停在等待。
 * - `external_pending`：材料已经交回，剩下的事在**别处**办（去原页面采用、确认或发布）。
 *   这一轮可以结束，用户可以去开新任务；但那件事没有办完，所以也**不是**成功。
 */
export type AgentExecutionStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting_user'
  | 'external_pending'

/**
 * 执行方交回的一份材料。
 *
 * 只带位置，不带内容：正文由执行方自己的页面负责呈现与鉴权，协调方只做定位，
 * 不复制一份可能已经过期的副本。
 */
export interface AgentArtifact {
  /** 给用户看的标题，例如「在博客查看并采用候选稿」。 */
  readonly title: string
  /** 材料所在位置，只允许本站插件内的路径，由执行方核验归属后提供。 */
  readonly path: string
  /** 材料种类，由执行方自己定义（例如 `draft`、`confirmation`）。 */
  readonly kind: string
}

/**
 * 材料已交回、还有事在别处等着办。
 *
 * 这份声明是协调方判定 `external_pending` 的**唯一依据**：没有它，协调方不会因为
 * 「结果里带着材料」就自行推断这一轮可以在外部收尾。
 */
export interface AgentExternalPending {
  /** 在等什么、由谁处理。这句会直接显示给用户。 */
  readonly reason: string
  /** 外部处理完之后可以做什么，可空。 */
  readonly next?: string
}

/** 一次派活的结论。 */
export interface AgentExecutionResult {
  /** `succeeded` 表示拿到了可用结果；其余按失败、取消或等待处理。 */
  readonly status: AgentExecutionStatus
  /** 最终回答，或失败时给用户看的短说明。 */
  readonly summary: string
  /** 执行方实际使用的会话标识，便于用户跳到那个页面继续追问。 */
  readonly conversationId?: string
  /** `waiting_user` 时要显示的问题；与 `summary` 分开，后者是已拿到的阶段性成果。 */
  readonly question?: string
  /** 本轮交回的材料。 */
  readonly artifacts?: readonly AgentArtifact[]
  /** `external_pending` 时必填，理由见 {@link AgentExternalPending}。 */
  readonly externalPending?: AgentExternalPending
}

/** 协调方登记的单个执行入口。 */
export interface AgentExecutor {
  readonly protocol: 1
  /** 与插件清单 `deepseekPlugin.id` 一致，协调方按它选择派给谁。 */
  readonly agentId: string
  /** 执行方声明自己能接的活；协调方只在这个范围内派活，不猜。 */
  readonly capabilities?: readonly string[]
  dispatch(request: AgentDispatchRequest): Promise<AgentExecutionResult>
  /** 可选：实现了才允许用户中途追问。 */
  reply?(request: AgentReplyRequest): Promise<AgentExecutionResult>
}
