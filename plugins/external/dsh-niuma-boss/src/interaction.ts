/**
 * 就近交互与对白呈现：作者机制 interaction_rules.yaml 与 npc_rules.yaml 里本切片实现的
 * 那部分——就近判定（按格距离）、触发器全序优先级、同一时刻只有一个提示、
 * `authored_lines` 打开**无自由输入**的对白面板、员工只给名牌与真实状态。
 *
 * 职责隔离写在这里而不是散在界面里：
 * - 业务员工（staff）没有独立搭话通道（adr/0001 第三节：首版无独立通道，不能据注册
 *   判定能搭话），走到他们身边只显示名牌与权威状态，活只能经牛马大总管派；
 * - 普通 NPC 只有作者预写对白（npc_rules.yaml#dialogue.authored_lines）或明确不可用
 *   （`unavailable`：名牌可展示，不提供自然语言输入，不回退到员工通道）；
 * - 两个通路都不产生任务、不调用模型、不调用业务工具：本文件没有任何网络或工具入口。
 *
 * 本切片实现的触发器是作者表里与「就近提示 + 对白」直接相关的一部分；未实现的
 * （dialogue_typing 100、dialogue_closing 90、dialogue_panel 95、portal_hint 30、
 * poi_hint 20）见报告，不在代码里假装存在。每个触发器的 `requires.input_open: false`
 * 已经实现：任务本或对白面板开着时一个提示都不生效（selection.session_owner）。
 */
import type { DialogueMode } from './world-runtime.ts'

/**
 * balance_params.yaml#interaction.interact_radius_tiles：就近交互范围（格）。
 * 同一文件里的 hint_radius_tiles（3.0）属于本切片未实现的提示范围：提示只在交互范围
 * 内出现，界面上没有第二套范围。
 */
export const INTERACT_RADIUS_TILES = 1.5
/**
 * balance_params.yaml#interaction.walk_away_tiles：走远判定（3.5，必须大于交互半径，
 * 否则站在边界上会让提示反复闪）。仅用于**关闭**已经打开的对白/名牌——就近提示本身
 * 只在交互半径内出现（interaction_rules.yaml#selection.walk_away）。
 */
export const WALK_AWAY_TILES = 3.5

/** interaction_rules.yaml#hotkey.interact_key（另有 Space/Enter 备用键，本切片只用 E）。 */
export const INTERACT_KEY = 'KeyE'

export interface NpcAutoBubble {
  readonly id: string
  readonly label: string
  readonly line: string
  readonly more: number
}

/**
 * 靠近的预写台词 NPC 的自动气泡内容(F4):半径内的最近者,取第一句台词;
 * 弹层打开(gateOpen)时返回 null——纯函数,会话层只负责把结果写进 store。
 */
export function pickNpcAutoBubble(
  targets: readonly NearTarget[],
  radius: number,
  gateOpen: boolean,
): NpcAutoBubble | null {
  if (gateOpen) return null
  const candidate = targets
    .filter(t => t.kind === 'npc' && t.authoredLines?.length && t.distanceTiles <= radius)
    .sort((a, b) => a.distanceTiles - b.distanceTiles)[0]
  if (!candidate || !candidate.authoredLines?.length) return null
  return {
    id: candidate.id,
    label: candidate.label,
    line: candidate.authoredLines[0],
    more: Math.max(0, candidate.authoredLines.length - 1),
  }
}

export type PromptId =
  | 'butler_reply_hint' | 'supplement_hint' | 'butler_busy_hint' | 'butler_idle_hint'
  | 'staff_busy_nametag' | 'npc_talk_hint' | 'npc_status_hint'

/** 提示的点击/按键动作；「打开任务本」复用常驻入口，不新建输入通道。 */
export type PromptAction = 'open_task_book' | 'staff_nameplate' | 'authored_dialogue' | 'npc_status' | 'hint_only'

export interface Prompt {
  readonly id: PromptId
  /** interaction_rules.yaml#triggers 的 priority（只用于排序，不代表时间）。 */
  readonly priority: number
  /** 作者给的提示文案（派活/补充一句/正在收尾/搭话/交谈/名牌）。 */
  readonly label: string
  readonly target: string
  readonly kind: 'butler' | 'staff' | 'npc'
  readonly action: PromptAction
}

/** 同一个地图上、在老板就近范围内的一个可交互对象。 */
export interface NearTarget {
  readonly id: string
  readonly label: string
  readonly kind: 'butler' | 'staff' | 'npc'
  /** 与老板所在格的格距离（表现层按格算，不做像素级判定）。 */
  readonly distanceTiles: number
  readonly dialogueMode?: DialogueMode
  /** authored_lines 的作者预写台词全文：靠近时的自动台词气泡直接展示（对话呈现升级 F4）。 */
  readonly authoredLines?: readonly string[]
}

/** 交互判定需要的**权威**任务事实；没有任务事实时按「空闲」处理。 */
export interface InteractionState {
  /** 有员工在等文本回复（task_protocol.yaml#subtask.waiting_user）。 */
  readonly staffReplyPending: boolean
  /** 本轮还在进行（含理解、派单、等待与汇总；终态与没有轮次时为 false）。 */
  readonly taskActive: boolean
  /** 已经请求停止、还没收到权威终态：只提示不开入口。 */
  readonly stopping: boolean
  /**
   * 已经有一个输入/会话视图开着（任务本、对白面板或员工名牌）。
   * interaction_rules.yaml 的每个就近触发器都写着 `requires.input_open: false`：
   * 打开着任务本或对白时不再渲染任何就近提示（同一时刻只有一个会话，
   * 见 selection.session_owner）。
   */
  readonly inputOpen: boolean
}

const PRIORITY: Record<PromptId, number> = {
  butler_reply_hint: 85,
  supplement_hint: 80,
  butler_busy_hint: 70,
  butler_idle_hint: 60,
  staff_busy_nametag: 45,
  npc_talk_hint: 40,
  npc_status_hint: 35,
}

const LABELS: Record<PromptId, string> = {
  butler_reply_hint: '回答员工的问题',
  supplement_hint: '补充一句',
  butler_busy_hint: '正在收尾',
  butler_idle_hint: '派活',
  staff_busy_nametag: '看名牌',
  npc_talk_hint: '交谈',
  npc_status_hint: '看名牌',
}

const ACTIONS: Record<PromptId, PromptAction> = {
  butler_reply_hint: 'open_task_book',
  supplement_hint: 'open_task_book',
  butler_busy_hint: 'hint_only',
  butler_idle_hint: 'open_task_book',
  staff_busy_nametag: 'staff_nameplate',
  npc_talk_hint: 'authored_dialogue',
  npc_status_hint: 'npc_status',
}

/**
 * 就近提示解析：先按 requires 判定候选，再取最高 priority；同类多个对象按距离、
 * 稳定对象 id 排序（interaction_rules.yaml#selection.rule），同一时刻只返回一个。
 * 老板同时站在牛马大总管和一个员工旁边时，牛马大总管的提示赢（conflicts 里写明）。
 */
export function resolvePrompt(near: readonly NearTarget[], state: InteractionState): Prompt | null {
  // requires.input_open: false：任务本或对白面板开着时，一个就近提示都不生效。
  if (state.inputOpen) return null
  const candidates: { id: PromptId; target: NearTarget }[] = []
  for (const target of near) {
    if (target.distanceTiles > INTERACT_RADIUS_TILES) continue
    const id = promptIdOf(target, state)
    if (id !== null) candidates.push({ id, target })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) =>
    PRIORITY[b.id] - PRIORITY[a.id]
    || a.target.distanceTiles - b.target.distanceTiles
    || (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0))
  const best = candidates[0]!
  // 交谈提示带上对象名（轮1 评审 P2）：只有「交谈」两个字无法分辨指的是哪一位。
  // 看名牌/交谈类提示带对象名(轮2):移动端无悬停,名字必须直接可见。
  const NAMED = new Set(['npc_talk_hint', 'npc_status_hint', 'staff_busy_nametag'])
  const label = NAMED.has(best.id) ? LABELS[best.id] + '·' + best.target.label : LABELS[best.id]
  return {
    id: best.id,
    priority: PRIORITY[best.id],
    label,
    target: best.target.id,
    kind: best.target.kind,
    action: ACTIONS[best.id],
  }
}

/** 单个对象当前生效的触发器；不满足任何 requires 时返回 null（静默让位）。 */
export function promptIdOf(target: NearTarget, state: InteractionState): PromptId | null {
  if (target.kind === 'butler') {
    if (state.stopping) return 'butler_busy_hint'
    if (state.staffReplyPending) return 'butler_reply_hint'
    // 补充只对应「还在跑且没在收尾」；终态或没有轮次时才是派活（两者互斥）。
    return state.taskActive ? 'supplement_hint' : 'butler_idle_hint'
  }
  // 员工：本切片没有独立搭话通道（staff_can_talk 恒为 false），只给名牌与真实状态。
  if (target.kind === 'staff') return 'staff_busy_nametag'
  return target.dialogueMode === 'authored_lines' ? 'npc_talk_hint' : 'npc_status_hint'
}

/** 对白面板/名牌的呈现模型；普通 NPC 只有作者预写内容，绝不带自由输入。 */
export interface DialogueView {
  readonly kind: 'npc' | 'staff'
  readonly id: string
  readonly title: string
  readonly role: string
  readonly mode: DialogueMode | 'staff'
  /** 普通 NPC 的预写台词；员工恒为空（搭话要另开通道，本切片不做）。 */
  readonly lines: readonly string[]
  /** 员工名牌上的**权威**状态文案；普通 NPC 为职责说明。 */
  readonly stateLabel: string
  /** 通道不可用时的说明；员工名牌下说明为什么没有搭话入口。 */
  readonly detail: string
  /** 本切片一律 false：不新增闲聊模型通道，也没有自由输入框。 */
  readonly inputAllowed: false
}

export interface DialogueCharacter {
  readonly id: string
  readonly label: string
  readonly dialogue?: {
    readonly mode: DialogueMode
    readonly name: string
    readonly role: string
    readonly lines: readonly string[]
  }
}

/** 普通 NPC 的对白面板：`authored_lines` 播放作者预写内容，其余只给名牌。 */
export function npcDialogue(character: DialogueCharacter): DialogueView {
  const dialogue = character.dialogue
  const name = dialogue?.name || character.label
  if (dialogue?.mode === 'authored_lines') {
    return {
      kind: 'npc', id: character.id, title: name, role: dialogue.role, mode: 'authored_lines',
      lines: [...dialogue.lines], stateLabel: dialogue.role,
      detail: '这是场景预写对白，不是模型回答；要办的工作交给牛马大总管。', inputAllowed: false,
    }
  }
  return {
    kind: 'npc', id: character.id, title: name, role: dialogue?.role ?? '', mode: 'unavailable',
    lines: [], stateLabel: dialogue?.role ?? '场景角色',
    detail: '这个角色当前没有可用的对白通道，只能查看名牌与职责。', inputAllowed: false,
  }
}

/**
 * 已经打开的对白/名牌是否还该留着（interaction_rules.yaml#selection.npc_switch、
 * npc_rules.yaml#dialogue.interruption）：老板走远（大于 walk_away_tiles）、切到别的
 * 地图、或被搭话的角色已经离场（不在当前地图的近邻事实里）时自动关闭。
 * 这里只判**表现事实**，不涉及任务状态：对白关闭不改变任何业务进度。
 */
export function dialogueStillInReach(
  near: readonly NearTarget[],
  id: string,
  mapChanged: boolean,
): boolean {
  if (mapChanged) return false
  const target = near.find(entry => entry.id === id)
  if (target === undefined) return false
  return target.distanceTiles <= WALK_AWAY_TILES
}

/**
 * 员工名牌：只展示真实可用状态（adr/0001：没接口或正在干活时只给名牌）。
 * 状态文案一律来自权威投影，界面不猜「在忙什么」。
 */
export function staffNameplate(character: { id: string; label: string }, stateLabel: string): DialogueView {
  return {
    kind: 'staff', id: character.id, title: character.label, role: '业务员工', mode: 'staff',
    lines: [], stateLabel,
    detail: '这位员工不接受直接派活，也没有独立搭话通道；工作经牛马大总管安排，结果在任务本里。',
    inputAllowed: false,
  }
}
