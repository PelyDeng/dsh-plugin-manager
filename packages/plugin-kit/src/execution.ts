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
  readonly text: string
  /** 用户选择「你看着办」时为 true，执行方自行决定，不必再追问。 */
  readonly decideByAgent: boolean
  readonly owner: string
  readonly actor: Actor
  readonly onProgress?: (update: AgentExecutionProgress) => void
  readonly signal: AbortSignal
}

/** 一次派活的结论。 */
export interface AgentExecutionResult {
  /** `succeeded` 表示拿到了可用结果；其余按失败、取消或等待处理。 */
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_user'
  /** 最终回答，或失败时给用户看的短说明。 */
  readonly summary: string
  /** 执行方实际使用的会话标识，便于用户跳到那个页面继续追问。 */
  readonly conversationId?: string
  /** `waiting_user` 时要显示的问题；与 `summary` 分开，后者是已拿到的阶段性成果。 */
  readonly question?: string
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
