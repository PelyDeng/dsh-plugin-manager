/**
 * 牛马大总管任务计划的纯数据模型与状态机。
 *
 * 状态取值与设计文档第 4 节一致，页面、存储和后端事件共用同一套值，不在别处另造。
 * 这里不依赖 Cordis、HTTP 或数据库，因此可以被单独测试。
 */

/** 单个子任务的状态。 */
export type SubtaskState =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'waiting_user'
  | 'external_pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/**
 * 整个牛马大总管任务的状态。
 *
 * `external_pending` 与 `waiting_user` 是两种不同的「没办完」：前者是材料已经交回、剩下的事
 * 在别处办（去原页面采用、确认或发布），本轮到此结束、可以开新活；后者是等着用户在这里补
 * 一句话，不补就进行不下去。前者**不是**成功 —— 那件事没有办完。
 */
export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'summarizing'
  | 'external_pending'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 子任务或任务是否已经结束，结束时不再接受新的状态事件。 */
export function isTerminal(state: SubtaskState | TaskState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
    || state === 'completed' || state === 'external_pending'
}

/**
 * 允许的状态迁移表。表里没有的迁移一律拒绝，避免前端渲染出来的状态和真实执行脱节。
 *
 * - `waiting_user` 可以继续执行，也可以被取消或被判定失败。
 * - `external_pending` 是终态：材料已经交回，这一轮到此为止，后续跟进是新任务。
 * - 结束态之间不能互相迁移，重试是新建子任务，不是改写旧状态。
 */
const SUBTASK_TRANSITIONS: Readonly<Record<SubtaskState, readonly SubtaskState[]>> = {
  queued: ['dispatched', 'cancelled', 'failed'],
  dispatched: ['running', 'waiting_user', 'external_pending', 'succeeded', 'failed', 'cancelled'],
  running: ['waiting_user', 'external_pending', 'succeeded', 'failed', 'cancelled'],
  waiting_user: ['running', 'dispatched', 'external_pending', 'succeeded', 'failed', 'cancelled'],
  external_pending: [],
  succeeded: [],
  failed: [],
  cancelled: [],
}

const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting_user', 'summarizing', 'external_pending', 'completed', 'failed', 'cancelled'],
  waiting_user: ['running', 'summarizing', 'external_pending', 'completed', 'failed', 'cancelled'],
  summarizing: ['external_pending', 'completed', 'failed', 'cancelled'],
  external_pending: [],
  completed: [],
  failed: [],
  cancelled: [],
}

/** 判断一次子任务状态迁移是否合法。相同状态视为合法，便于重复事件幂等处理。 */
export function canTransitionSubtask(from: SubtaskState, to: SubtaskState): boolean {
  return from === to || SUBTASK_TRANSITIONS[from].includes(to)
}

/** 判断一次任务状态迁移是否合法。 */
export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to)
}

/** 一次非法迁移。带上双方状态，便于定位是哪个真实事件与预期不符。 */
export class StateTransitionError extends Error {
  readonly code = 'BUTLER_STATE_TRANSITION'
  constructor(
    readonly subject: 'subtask' | 'task',
    readonly from: string,
    readonly to: string,
  ) {
    super(`${subject} 不能从 ${from} 迁移到 ${to}`)
    this.name = 'StateTransitionError'
  }
}

/** 校验并返回迁移结果，非法时抛错。 */
export function assertSubtaskTransition(from: SubtaskState, to: SubtaskState): SubtaskState {
  if (!canTransitionSubtask(from, to)) throw new StateTransitionError('subtask', from, to)
  return to
}

/** 校验并返回任务迁移结果，非法时抛错。 */
export function assertTaskTransition(from: TaskState, to: TaskState): TaskState {
  if (!canTransitionTask(from, to)) throw new StateTransitionError('task', from, to)
  return to
}

/** 牛马大总管生成的一个子任务。 */
export interface Subtask {
  /** 计划内稳定编号，从 1 开始，供页面和时间线引用。 */
  readonly id: string
  /** 子任务目标，页面直接显示。 */
  readonly goal: string
  /** 目标 Agent 的注册 id；调度前无法确定时为空字符串。 */
  readonly agentId: string
  /** 调度前由牛马大总管写下的选择理由，便于用户理解为什么派给这个 Agent。 */
  readonly reason: string
  state: SubtaskState
  /** 最近一次状态变化的时间戳，用于计算耗时。 */
  readonly startedAt: number | null
  updatedAt: number
  finishedAt: number | null
  /** 子 Agent 最终回答或失败摘要，已经裁剪为可展示文本。 */
  result: string
  /** 可展示的失败原因，不含路径、Token 和内部堆栈。 */
  error: string
}

/** 牛马大总管生成的一份任务计划。 */
export interface TaskPlan {
  /** 计划面向用户的目标摘要，通常等于用户原话的收敛表达。 */
  readonly goal: string
  /** 牛马大总管用于拆分任务的说明，可空。 */
  readonly note: string
  readonly subtasks: readonly Subtask[]
}

/** 计划里传给子 Agent 的执行指令。 */
export interface SubtaskBrief {
  readonly id: string
  readonly goal: string
  readonly agentId: string
}
