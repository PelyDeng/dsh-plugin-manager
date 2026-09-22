/**
 * 消息流条目类型（评审 #19 拆分）：React 渲染的统一数据面（旧 DOM 追加模型的
 * 范式转换），八类条目与终态常集中在这一份——store 写入方与渲染组件共用，
 * 不再从 turn.ts 散装导入。subtask 条目按 subtaskId 直接从 entries 派生查找
 * （评审 #18：bubbleKeys 索引可派生冗余已删，entries 是唯一真相源）。
 */
import type { TaskSummary } from '../lib/api.ts'
import type { AgentAction } from '../lib/turn-event.ts'

/** 消息流条目：React 渲染的统一数据面。 */
export type ThreadEntry = UserEntry | ButlerEntry | SubtaskEntry | NoteEntry | ErrorEntry | SummaryEntry | TaskEntry | DispatchEntry

export interface UserEntry {
  key: string
  kind: 'user'
  text: string
  time?: number | undefined
  /** 随消息发出的附件芯片（发送时从输入框摘下画到这里）。 */
  attachments?: Array<{ key: string; name: string; size: number }> | undefined
}

/** 大总管气泡：streaming 期 text 逐帧增长，落定的 `chat` 收走（streaming=false）。 */
export interface ButlerEntry {
  key: string
  kind: 'butler'
  text: string
  thinking: string
  streaming: boolean
  /** 超长正文降级纯文本追加（STREAM_RICH_LIMIT 分级判断在渲染层执行）。 */
  time?: number | undefined
  /** 被打断的管家答复（S13：标注出来，不冒充完整结论）。 */
  interrupted?: boolean | undefined
}

/** 成员子任务气泡（批 3：含等待回话入口；调度卡在批 4b 收编）。 */
export interface SubtaskEntry {
  key: string
  kind: 'subtask'
  subtaskId: string
  /** 所属任务 id（subtask 事件自带；决策 /action 入参需要，避免渲染层再派生）。 */
  taskId?: string | undefined
  agentId: string
  goal: string
  state: string
  body: string
  thinking: string
  terminal: boolean
  /** live=false 表示已离开执行态（如等待）：迟到增量不再点亮光标。 */
  live: boolean
  toolLine: { tool?: string | undefined; detail?: string | undefined } | null
  artifacts: unknown[]
  startedAt?: number | string | null | undefined
  finishedAt?: number | string | null | undefined
  detail?: string | null | undefined
  error?: string | null | undefined
  /** waiting_user 的回话入口（ask 卡）：question 是卡面问题，detail 是正文口径。 */
  ask?: { taskId: string; question?: string | undefined; detail?: string | undefined } | undefined
  /** 待用户确认的操作卡（AgentAction 协议呈现面；prepared 态出确认/取消按钮）。 */
  actions?: ReadonlyArray<AgentAction> | undefined
  /** external_pending 的结构化说明：在等谁做什么（reason）/办完能做什么（next）。 */
  pending?: { reason: string; next?: string } | undefined
  /** 派单理由（plan 事件的 reason：为什么派给这位成员）。 */
  dispatchReason?: string | undefined
  /** 协调方质检裁决（accept/rework/replace/unverified）与理由——历史恢复与详情回放带出。 */
  verdict?: string | undefined
  verdictReason?: string | undefined
}

export interface NoteEntry {
  key: string
  kind: 'note'
  text: string
}

export interface ErrorEntry {
  key: string
  kind: 'error'
  text: string
  /** 发送失败的重试行：携带原文与幂等身份，重试复用同一 requestId（S07）。 */
  retryFor?: { requestText: string; requestId: string } | undefined
}

/** 汇总卡：text 已按 S12 去重（与最后一条 butler 正文相同时置空）。 */
export interface SummaryEntry {
  key: string
  kind: 'summary'
  state: string
  text: string
  /** 失败原因（评审 B2）：失败/部分完成的汇总卡要能回答「为什么」。 */
  error?: string | undefined
  time?: number | undefined
}

/**
 * 调度卡条目（批 4b，旧 mountDispatch 的声明式对应物）：**本次派活唯一的一张卡**。
 * 成员的输出数据仍在 subtask entries，本条目持顺序/选中/折叠——旧版靠「把成员
 * 消息 DOM 搬进 slot」的地方，React 版由 DispatchCard 按数据派生渲染。
 */
export interface DispatchEntry {
  key: string
  kind: 'dispatch'
  taskId: string
  /** 子任务顺序（卡片格子顺序）。 */
  order: string[]
  /** 当前选中的成员（点已选中的不变——收起用折叠，一条动作一个语义）。 */
  active: string | null
  /** 折叠态：偏好（butler.card.{taskId}.open）优先，缺省收起。 */
  open: boolean
  /** 只看结论偏好（butler.card.{taskId}.resultOnly）。 */
  resultOnly: boolean
  /** 「有更新」：收起后状态又变了（展开即清）。 */
  fresh: boolean
  /** 状态变化过但未读的成员（描边脉冲用，600ms 自清）。 */
  pulses: string[]
}

/** 历史任务摘要卡（点开看详情，批 3 完整调度卡回放）：列表投影形状。 */
export interface TaskEntry {
  key: string
  kind: 'task'
  task: TaskSummary
}

/** 任务的收尾状态：汇总事件带这些 state 之一时这一轮才算结束。 */
export const TERMINAL_TASK_STATES: ReadonlyArray<string> = ['completed', 'failed', 'cancelled', 'partial']

/** 子任务的定论状态（external_pending 是暂停不是终态，单列在 PAUSED_SUBTASK_STATES）。 */
export const TERMINAL_SUBTASK_STATES: ReadonlyArray<string> = ['succeeded', 'failed', 'cancelled', 'external_pending']

/** 子任务的暂停状态：这一轮还活着，收口的汇总不得把它们改写成「已停止」。 */
export const PAUSED_SUBTASK_STATES: ReadonlyArray<string> = ['waiting_user', 'external_pending']

/** subtask 事件的「不再追加增量」状态集：终态 + 等待回话（handleSubtaskEvent 主分支）。 */
export const SETTLED_SUBTASK_STATES: ReadonlyArray<string> = ['waiting_user', ...TERMINAL_SUBTASK_STATES]

/** 按 subtaskId 从 entries 找条目（评审 #18：替代 bubbleKeys 索引的派生查找）。 */
export function subtaskEntryOf(entries: ReadonlyArray<ThreadEntry>, subtaskId: string): SubtaskEntry | undefined {
  for (const entry of entries) {
    if (entry.kind === 'subtask' && entry.subtaskId === subtaskId) return entry
  }
  return undefined
}
