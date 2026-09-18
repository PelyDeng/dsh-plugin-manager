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
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 子任务或任务是否已经结束，结束时不再接受新的状态事件。 */
export function isTerminal(state: SubtaskState | TaskState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
    || state === 'completed' || state === 'external_pending' || state === 'partial'
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

/**
 * 全部子任务状态取值（就是迁移表的键，不另造一份）。
 *
 * 回读持久化数据时用它核验取值：库里出现表外的状态说明这份记录不是本版本写的，按未知处理。
 */
export const SUBTASK_STATES: readonly SubtaskState[] = Object.keys(SUBTASK_TRANSITIONS) as SubtaskState[]

const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting_user', 'summarizing', 'external_pending', 'partial', 'completed', 'failed', 'cancelled'],
  waiting_user: ['running', 'summarizing', 'external_pending', 'partial', 'completed', 'failed', 'cancelled'],
  // `summarizing` 可以回到 `running`：汇总跑到一半又进来一条补充时，这份结论作废，任务回到
  // 执行中，由那条补充自己的回合继续 —— 停在「在写总结」会让大家以为还有人在写。
  summarizing: ['running', 'external_pending', 'partial', 'completed', 'failed', 'cancelled'],
  external_pending: [],
  partial: [],
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

/** 依赖核验的结论。 */
export type DependencyVerdict = 'dispatch' | 'wait' | 'fail'

/**
 * 依赖就绪判定 —— 与游戏侧 `task_protocol.yaml#scheduling.ready_rules` 同一张表。
 *
 * 输入是三类事实，输出只有三种动作：
 *
 * - `dispatch`：前置的条件够了，可以派；
 * - `wait`：前置**还没终结**，这一步留在队列里等它，既不派也不判失败；
 * - `fail`：前置已经确定帮不上这一步了。
 *
 * 两条容易被写错的地方，这里按既定机制钉住：
 *
 * 1. **上游尚未终结时始终等待**，不因为途中已经有部分材料就提前派单，也不因为「还没轮到」
 *    就提前判失败 —— 员工还没机会干，凭什么说他干不成。
 * 2. 上游交了材料但还有外部动作没办完（`external_pending`）时，**按这一步自己的需求判**：
 *    材料够用、这一步也不依赖外部采用或发布，就可以继续；确需已办完的外部结果时才不满足。
 *    `requiresExternalAction` 由这一步的声明给出，不是从材料内容猜的 ——「拿候选稿写个摘要」
 *    不需要外部采用，「报道一下已经发布的版本」才需要。
 */
export function dependencyVerdict(facts: {
  /** 前置尝试的状态。 */
  readonly upstream: SubtaskState
  /** 前置是否交回了可用的完整材料。 */
  readonly materialsReady: boolean
  /** 这一步是否真的需要外部动作（采用、确认、发布）已经办完。 */
  readonly requiresExternalAction: boolean
}): DependencyVerdict {
  const { upstream, materialsReady, requiresExternalAction } = facts
  if (upstream === 'succeeded') return materialsReady ? 'dispatch' : 'fail'
  if (upstream === 'external_pending') {
    // 上游材料都没交回：那确实没戏，别让下游空等。
    if (!materialsReady) return 'fail'
    // 材料够用、下游也不要外部动作：照派。
    if (!requiresExternalAction) return 'dispatch'
    /**
     * 上游交回了材料、正**等人去办**那件事（确认、采用、发布），而这一步要的正是"已经办完的结果"。
     *
     * ⚠️ 这里从 `'fail'` 改成 `'wait'`（2026-09-18 生产事故）：原来判失败，于是"等人点确认"被当成
     * "前置永远完不成"，把后面排队的每一步都**判死**。可"等你确认"分明是**用户随时能点掉**的中间
     * 状态——它跟"等你回话"一样会被人往前推，唯一的区别只是那个人在哪个页面点。
     *
     * 真实现场：一次「把六篇草稿删掉」被拆成 g1→g2→…→g6 一条链，g1 停在等确认，后五步全判 failed；
     * 用户点掉 g1 之后，那五步再也没人回头看，只能重新派活。
     */
    return 'wait'
  }
  if (upstream === 'failed' || upstream === 'cancelled') return 'fail'
  // 其余都是还没终结：排队中、已派出、正在干、等人回话。
  return 'wait'
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
  readonly result: string
  /** 可展示的失败原因，不含路径、Token 和内部堆栈。 */
  readonly error: string
}
