/**
 * 牛马大总管与子 Agent 之间的最小调度协议。
 *
 * 设计边界（见 `.local/agent-console/docs/设计/` 的方向稿）：
 *
 * - 牛马大总管只负责理解目标、拆解、分发和汇总。
 * - 牛马大总管不决定子 Agent 用什么工具，也不创建子 Agent 的会话。
 * - 每个子 Agent 由它自己所属的插件注册一个 executor；那个插件负责创建、
 *   驱动和释放自己的 Agent，并决定它能看到哪些工具。
 *
 * 因此这里只约定“派什么活、什么时候算完成”这一层，不暴露任何工具、模型或
 * 提示词细节。协议通过 Cordis 事件总线传输，插件之间不需要互相导入源码。
 *
 * 字段形状本身**不在本文件定义**：它已经收进 kit 的 `execution.ts`，执行方（插件）和
 * 协调方（本插件）都从那里导入。两边各写一份时字段名靠人眼对齐，出现过协调方读
 * `stage`、执行方发 `text` 的静默失配 —— 类型检查全绿，第一条进度就抛 `TypeError`。
 * 这里保留历史上的 `Butler*` 名字，只作为本插件内部的别名，改形状必须改 kit。
 */

import type {
  AgentDispatchRequest,
  AgentExecutionPhase,
  AgentExecutionProgress,
  AgentExecutionResult,
  AgentExecutor,
  AgentReplyRequest,
} from '@dsh-plugin-manager/plugin-kit'

/** 插件目录里为子 Agent 声明的能力摘要之外的执行入口。 */
export type ButlerAgentExecutor = AgentExecutor

/** 牛马大总管交给执行方的一次子任务。 */
export type ButlerDispatchRequest = AgentDispatchRequest

/** 子任务结束时的结论。 */
export type ButlerDispatchResult = AgentExecutionResult

/** 用户对一位正在等待的成员的回复。 */
export type ButlerReplyRequest = AgentReplyRequest

/** 子任务当前处在哪个协作环节，页面据此点亮协同链路。 */
export type ButlerPhase = AgentExecutionPhase

/** 一次进度上报。文本会直接显示给用户，需要自行裁剪。 */
export type ButlerProgressUpdate = AgentExecutionProgress

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
  /** 执行入口声明的能力，牛马大总管据此决定派谁。 */
  readonly capabilities: readonly string[]
  /**
   * 此刻占着的活；空闲时为 `null`。
   *
   * **`online` 不等于可派活**，三件事要分开看：登记了执行入口（`online`）、当前用户有授权
   * （本插件判不了，由执行方自己鉴权）、以及这位成员是不是闲着（这里）。状态取子任务状态，
   * 所以「在干活」与「等着用户回话」也分得开。
   */
  readonly busy: { readonly taskId: string; readonly subtaskId: string; readonly state: string } | null
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
