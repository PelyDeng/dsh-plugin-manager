/**
 * 管家与子 Agent 之间的最小调度协议。
 *
 * 设计边界（见 `.local/agent-console/docs/设计/` 的方向稿）：
 *
 * - 管家只负责理解目标、拆解、分发和汇总。 * - 管家不决定子 Agent 用什么工具，也不创建子 Agent 的会话。
 * - 每个子 Agent 由它自己所属的插件注册一个 executor；那个插件负责创建、
 *   驱动和释放自己的 Agent，并决定它能看到哪些工具。
 *
 * 因此这里只约定“派什么活、什么时候算完成”这一层，不暴露任何工具、模型或
 * 提示词细节。协议通过 Cordis 事件总线传输，插件之间不需要互相导入源码。
 */

import type { Actor } from '@dsh-plugin-manager/plugin-kit'

/** 插件目录里为子 Agent 声明的能力摘要之外的执行入口。 */
export interface ButlerAgentExecutor {
  /** 协议版本。当前只支持 1，不兼容的注册会被拒绝。 */
  readonly protocol: 1
  /** 稳定标识，必须与插件目录登记的应用 id 一致。 */
  readonly agentId: string
  /**
   * 这位成员能接哪些类型的活，例如 `['园区数据查询', '车辆轨迹']`。
   *
   * 管家把这份说明写进自己的提示词，用来决定把子任务派给谁；也因此新增插件只要声明
   * 能力就会被自动识别，管家侧不需要改代码。留空表示「什么都能接」，管家会按子任务
   * 语义自行判断。
   */
  readonly capabilities?: readonly string[]
  /**
   * 执行一个子任务。
   *
   * 实现方负责创建或复用自己的 Agent、驱动它跑完这一轮，并在 settle 时返回
   * 结论。抛出的错误会被管家裁剪成用户可读的失败摘要，不要把内部路径或
   * 凭据放进错误消息。
   */
  dispatch(request: ButlerDispatchRequest): Promise<ButlerDispatchResult>
  /**
   * 接收用户对一次 `waiting_user` 子任务的回复。
   *
   * 可选：不实现时管家会在页面上说明「这位成员不接受中途回复」，用户只能等它跑完或
   * 重新表述。实现方拿到的 `text` 已经裁剪过，`decideByAgent` 为 true 表示用户让你
   * 自己拿主意。
   */
  reply?(request: ButlerReplyRequest): Promise<ButlerDispatchResult>
}

/** 管家交给执行方的一次子任务。 */
export interface ButlerDispatchRequest {
  /** 本次任务的标识，便于执行方在自己的历史里串联。 */
  readonly taskId: string
  /** 计划内子任务编号，从 1 开始。 */
  readonly subtaskId: string
  /** 子任务目标，已经是可直接交给子 Agent 的一句话。 */
  readonly goal: string
  /**
   * 发给子 Agent 的完整简报：整体目标、它负责的部分和产出要求。
   *
   * 管家在这里只写“做什么”，不写“用哪个工具怎么做”。执行方可以原样使用，也可以
   * 按自己的业务改写。
   */
  readonly brief: string
  /** 用户原始目标，供执行方补充上下文。 */
  readonly taskGoal: string
  /**
   * 该登录用户的业务归属键，格式为 `<namespace>:<userId>`，与 kit 的
   * `actorKey` 一致。执行方用它做数据归属，不要用它做长期存储的主键。
   */
  readonly owner: string
  /**
   * 发起这次协作的完整身份。
   *
   * `owner` 不足以鉴权：它是单向压出来的键，**丢失了 sessionId**，而且没有接口能从它反推回
   * `Actor`（kit 的 `Access.resolve` 只接受 HTTP 请求）。执行方要用原始用户身份、自己的权限
   * 和会话，所以必须拿到完整身份，而不是从字符串重建 —— 重建写错就是越权。
   *
   * 与 `owner` 并存而不是替换：`owner` 是插件做数据归属用的稳定键，`actor` 是鉴权用的身份，
   * 两者用途不同。
   */
  readonly actor: Actor
  /** 子任务进度上报。执行方可以不调用，管家会按派发和结束补全时间线。 */
  readonly onProgress?: (update: ButlerProgressUpdate) => void
  /** 用户取消、超时或插件卸载时中止。执行方应尽快释放自己的 Agent。 */
  readonly signal: AbortSignal
}

/** 子任务当前处在哪个协作环节，页面据此点亮协同链路。 */
export type ButlerPhase =
  /** 正在理解目标或准备执行。 */
  | 'analyzing'
  /** 正在挑选或调用工具。 */
  | 'tool'
  /** 正在请求用户补充信息。 */
  | 'waiting_user'

/** 一次进度上报。文本会直接显示给用户，需要自行裁剪。 */
export interface ButlerProgressUpdate {
  /** 页面显示的阶段名，例如“正在查询园区数据”。 */
  readonly stage: string
  /** 补充说明，可空。 */
  readonly detail?: string
  /** 当前协作环节；不传时页面上只更新状态文字，不改变链路。 */
  readonly phase?: ButlerPhase
  /**
   * 新增的正文片段，按调用顺序拼接就是这位成员这一轮的完整发言。
   *
   * 传增量而不是整段：群聊里成员是边说边出字的，整段覆盖会让气泡内容来回跳。
   */
  readonly delta?: string
  /** 正在调用的工具名，用于「正在翻阅资料：xxx」这类展示。 */
  readonly tool?: string
  /**
   * 声明需要用户补充信息。
   *
   * 置位后子任务进入 `waiting_user`，页面给出回复入口；用户回复会通过
   * {@link ButlerAgentExecutor.reply} 交回执行方。执行方不置位就不会进入这个状态。
   */
  readonly needsReply?: boolean
}

/** 子任务结束时的结论。 */
export interface ButlerDispatchResult {
  /** `succeeded` 表示拿到了可用结果；其余情况按失败处理并在页面显示原因。 */
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_user'
  /** 子 Agent 的最终回答，或失败时给用户看的短说明。 */
  readonly summary: string
  /** 子 Agent 实际使用的插件内会话 id，便于用户跳到那个页面继续追问。 */
  readonly conversationId?: string
  /**
   * `waiting_user` 时页面要显示的问题。
   *
   * 与 `summary` 分开：`summary` 是已经拿到的阶段性成果，这个是等着用户回答的问题。
   */
  readonly question?: string
}

/** 用户对一位正在等待的成员的回复。 */
export interface ButlerReplyRequest {
  readonly taskId: string
  readonly subtaskId: string
  /** 用户补充的内容。 */
  readonly text: string
  /** 用户选择「你看着办」时为 true，执行方自行决定，不必再追问。 */
  readonly decideByAgent: boolean
  readonly owner: string
  /** 完整身份，理由同 `ButlerDispatchRequest.actor`。 */
  readonly actor: Actor
  readonly onProgress?: (update: ButlerProgressUpdate) => void
  readonly signal: AbortSignal
}

/**
 * 群聊里一位成员的可展示身份。
 *
 * 显示名优先取本地别名，插件声明的名称始终保留在 `declaredName`，页面上以次要文字
 * 显示，保证「页面上这个昵称对应哪个插件」永远可追溯。
 */
export interface ButlerMember {
  /** 插件登记的应用 id，也是任务计划里引用的 id。 */
  readonly agentId: string
  /** 页面显示名。 */
  readonly displayName: string
  /** 插件自己声明的名称。 */
  readonly declaredName: string
  /** 该成员此刻是否在场（登记了执行入口）。 */
  readonly online: boolean
  /** 本地配色；没配过时为空字符串，由前端按 agentId 稳定推导。 */
  readonly accent: string
  /** 执行入口声明的能力，管家据此决定派谁。 */
  readonly capabilities: readonly string[]
}

/**
 * 注册一个执行入口。插件在自己的 `ctx.effect` 生命周期内调用，释放时自动注销。
 */
export const BUTLER_EXECUTORS_EVENT = 'butler/executors'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 子 Agent 所属插件登记自己的执行入口。 */
    [BUTLER_EXECUTORS_EVENT]: (accept: (executor: ButlerAgentExecutor) => void) => void
  }
}
