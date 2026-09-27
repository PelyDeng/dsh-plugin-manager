/**
 * 表现命令：把**权威任务投影**翻译成表现层唯一要消费的东西。
 *
 * 方向只有一个：权威 → 命令 → 表现。命令是纯函数的结果（`deriveStaffCommands`），
 * 不读计时器、不读逐帧坐标、不累积本地状态；表现层（GameWorld / GameUI）只消费命令，
 * 没有任何回写通路。由此得到两条硬性质：
 *
 * - **无进度事件也能正确收尾**：命令只看当前投影（快照 + 事件折叠后的状态）。整轮只
 *   收到一条终态（例如只剩 `succeeded` 的权威快照）时，命令直接收敛到「交回并回工位」，
 *   不依赖任何中间演出事件；
 * - **终态不从演出推算**：本文件不产生、不修改任务状态；演出缺失、重复或乱序都不影响
 *   权威终态（见 ADR 0003 与 task-projection 的确定状态集合）。
 *
 * 员工的两条并行区域按 agent_fsm.yaml#staff：`work`（后端子任务在页面的投影）与
 * `locomotion`（位置）。命令同时给出两者，表现层按作者锚点到位，不自己判断业务。
 */
import { stateLabel } from './labels.ts'
import type { TaskView, SubtaskView } from './task-projection.ts'

/**
 * 会合点语义目标（interaction_rules.yaml#rendezvous.kinds），几何由表现层解析。
 * 本切片的命令只能产生 `butler` 与 `workstation`：`boss`（当面跟老板说清楚）没有任何
 * 权威状态会选择它，作者表里的这一项属于未实现的语义，这里不假装它存在。
 */
export type RendezvousKind = 'butler' | 'workstation'

/** work 区状态（agent_fsm.yaml#staff.regions.work）。 */
export type StaffWork = 'free' | 'assigned' | 'running' | 'waiting_user'

/**
 * 表现动作：本切片实际驱动画面的五种命令。语义目标与实际位移分开：命令只说到哪里、
 * 干什么（`rendezvous` 只说 butler/workstation），逐格位移与走帧由表现层按作者速度解析
 * （见 GameWorld）；命令本身不携带本地计时或逐帧坐标，也不用动画推算业务。
 */
export type StaffAction = 'walk_to_rendezvous' | 'start_work' | 'wait_for_reply' | 'hand_back' | 'at_post'

export interface StaffCommand {
  /** 业务员工 id（作者数据里的 staff，见 adr/0001）。 */
  readonly agentId: string
  readonly taskId: string
  /** 这一位当前有效的子任务；空串表示本轮没有派给他。 */
  readonly subtaskId: string
  /** 子任务状态原文（权威），空串表示没有。 */
  readonly state: string
  readonly work: StaffWork
  readonly action: StaffAction
  /** 会合点语义目标；`at_post`/`hand_back` 一律回自己的工位。 */
  readonly rendezvous: RendezvousKind
  /**
   * 派单顺序：投影里子任务的先后（plan 的 subtasks 顺序 + 事件到达顺序，就是派单顺序；
   * 投影没有单独保留每条派单事件的 seq）。多个员工同时去同一个会合点时按它开槽位，
   * 再按员工 id 收尾（interaction_rules.yaml#slots）；没派活的排到最后。
   */
  readonly dispatchOrder: number
  /** 走到会合点、开工、等待时展示的权威说明（等待原因等）。 */
  readonly note: string
}

/** 表现层要显示的一个员工条目：命令 + 权威状态文案 + 气泡正文。 */
export interface StaffDialogueView {
  readonly id: string
  readonly label: string
  readonly action: StaffAction
  readonly actionLabel: string
  readonly stateLabel: string
  /** 权威正文气泡（按 balance_params.yaml#text.max_bubble_chars 截断）。 */
  readonly bubble: string
  readonly truncated: boolean
}

/** balance_params.yaml#text.max_bubble_chars：气泡最多显示多少字，超出截断并给省略号。 */
export const MAX_BUBBLE_CHARS = 48

const ACTION_LABELS: Record<StaffAction, string> = {
  walk_to_rendezvous: '走向会合点',
  start_work: '开工',
  wait_for_reply: '等待回话',
  hand_back: '交回成果,返回工位',
  at_post: '工位待命',
}

/** task_protocol.yaml#subtask.terminal：子任务终态。 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['succeeded', 'external_pending', 'failed', 'cancelled'])

/** 运行中状态（还没结束的尝试）；`queued` 是投影里「计划已登记但还没派出」的占位，不占员工。 */
const WORKING_STATES: ReadonlySet<string> = new Set(['running', 'executing'])

/** 这一位当前有效的子任务：同一执行者最多一个非终态子任务（task_protocol.yaml#claim）。 */
export function activeSubtask(view: TaskView, agentId: string): SubtaskView | null {
  let fallback: SubtaskView | null = null
  for (const subtask of view.subtasks) {
    if (subtask.agentId !== agentId) continue
    fallback = subtask
    if (!TERMINAL_STATES.has(subtask.state)) return subtask
  }
  return fallback
}

/**
 * 权威投影 → 表现命令。纯函数：同一份投影永远得到同一组命令，与到达顺序、事件多少无关。
 * 表现层不在这条链上，终态也不从这里产生。
 */
export function deriveStaffCommands(view: TaskView, staffIds: readonly string[]): StaffCommand[] {
  return staffIds.map(agentId => commandFor(view, agentId))
}

/** 派单顺序：投影里子任务先后的下标；投影没有这一条（没派活/已滚出）时排到最后。 */
function dispatchOf(view: TaskView, subtask: SubtaskView | null): number {
  if (subtask === null) return Number.MAX_SAFE_INTEGER
  const index = view.subtasks.findIndex(entry => entry.id === subtask.id)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

function commandFor(view: TaskView, agentId: string): StaffCommand {
  const subtask = activeSubtask(view, agentId)
  if (subtask === null) {
    return {
      agentId, taskId: view.taskId, subtaskId: '', state: '', work: 'free',
      action: 'at_post', rendezvous: 'workstation', dispatchOrder: Number.MAX_SAFE_INTEGER, note: '',
    }
  }
  const state = subtask.state
  const base = {
    agentId, taskId: view.taskId, subtaskId: subtask.id, state,
    dispatchOrder: dispatchOf(view, subtask), note: subtask.note,
  }
  if (TERMINAL_STATES.has(state)) {
    // terminal-releases-presentation：终态立即 free，不等待交差动画；回自己工位。
    return { ...base, work: 'free', action: 'hand_back', rendezvous: 'workstation' }
  }
  if (WORKING_STATES.has(state)) {
    return { ...base, work: 'running', action: 'start_work', rendezvous: 'butler' }
  }
  if (state === 'waiting_user') {
    return { ...base, work: 'waiting_user', action: 'wait_for_reply', rendezvous: 'butler' }
  }
  if (state === 'dispatched') {
    return { ...base, work: 'assigned', action: 'walk_to_rendezvous', rendezvous: 'butler' }
  }
  // queued/planned：已登记但还没派出，不占员工（task_protocol.yaml#scheduling.planned_wait）。
  return { ...base, work: 'free', action: 'at_post', rendezvous: 'workstation' }
}

/**
 * 员工对话呈现（GameUI 用）：动作、权威状态文案与正文气泡都来自命令与投影，
 * 逐帧坐标与本地计时不参与。`label` 由作者角色名册给出。
 */
export function staffDialogueViews(
  view: TaskView,
  commands: readonly StaffCommand[],
  roster: readonly { id: string; label: string }[],
): StaffDialogueView[] {
  const labels = new Map(roster.map(entry => [entry.id, entry.label]))
  return commands.map(command => {
    const subtask = view.subtasks.find(s => s.id === command.subtaskId) ?? null
    const text = subtask?.text ?? ''
    const bubble = text.length > MAX_BUBBLE_CHARS ? text.slice(0, MAX_BUBBLE_CHARS) + '…' : text
    return {
      id: command.agentId,
      label: labels.get(command.agentId) ?? command.agentId,
      action: command.action,
      actionLabel: ACTION_LABELS[command.action],
      stateLabel: subtask === null ? '本轮没有派活' : stateLabel(subtask.state),
      bubble,
      truncated: text.length > MAX_BUBBLE_CHARS,
    }
  })
}
