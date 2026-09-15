/**
 * 管家契约 v1 的只读消费侧类型与任务投影。
 *
 * 投影是纯函数：快照建立基准，事件按契约语义增量更新。追加与覆盖不弄反——
 * `chat_delta`/`subtask_delta` 追加，`chat` 落定时整体替换，`subtask_thinking`
 * 每次都是完整快照。任务终态只来自权威快照与 `summary` 事件，不从演出推算。
 *
 * ## 恢复模型：正文所属轮次与事件覆盖边界
 *
 * 换轮与刷新恢复都从 0 重放当前轮（事件日志每个会话只留最近一轮），所以重放里既有
 * 已经落库的历史事件，也有恢复之后才发生的新事件。只看「result 是否为空」或「状态
 * 是否变化」区分不了这两者：同一个子任务可能在历史里完成过一次（succeeded 落库了
 * AB），也可能在恢复时就是 running 却带着上一轮的 result（`prepareReply` 先把子任务
 * 置为 running，落库用的是 `COALESCE`，旧 result 会保留）。这里改为显式记账：
 *
 * - `base`：正文基准，取快照的 result（同任务重读快照且没有 result 时保留事件期累积）；
 * - `coverage.runId`/`coverage.boundary`：probe 给出的当前轮身份与头部序号。序号不大于
 *   `boundary` 的是重放的历史区间，大于的是恢复之后的新事件；
 * - `coverage.through`：基准正文已经覆盖到的序号，不大于它的增量不再重复计入；
 * - `replaying`：本轮收到的增量按序入账，正文始终由 `base` 与它按覆盖边界重算——因此
 *   「先重放历史增量、后收到 succeeded」的真实顺序不会重复计入，重读快照换基准、覆盖边界
 *   推进时也不会把已经取回的片段弄丢。
 *
 * `through` 只由**可证明写了正文的落库迁移**推进，不做状态推算，也不用文本相似推断因果：
 * `succeeded` 与 `external_pending` 是 `applyMemberResult` 唯一确定写正文的两类迁移（都写在
 * emit 之前），所以序号不晚于恢复边界的这类迁移，其正文必然已在快照里。`waiting_user`、
 * `failed`、`cancelled` 这类同名状态既可能是结果落库，也可能只是进度上报或错误上报
 * （进度型 `waiting_user` 只改状态，普通失败与取消只写 error 而 result 沿用旧值），事件载荷
 * 分不出来——这类迁移一律**不动覆盖边界**：已经取回的增量照常保留（宁可重复，不可丢字），
 * 只把子任务标成 `uncertain`，由界面如实提示可能重复。文本相等或前缀相同都不算证据：
 * 新内容完全可能恰好与旧正文相同。
 *
 * ## 事件窗口滚出时的降级
 *
 * 一轮事件超过 `maxConversationEvents`（默认 2000）时，窗口左边缘会右移。窗口外的事件
 * 拿不回来：如果那段正文还没落库，界面上就真的缺内容。因此恢复上下文里带 `truncated`：
 * 置位时 `incomplete` 为真，界面如实提示「正文可能不完整」，同时把窗口内还留着的片段
 * 照常计入；本轮结束后用 `final` 重读一次快照，但只有**能证明 result 属于本轮**的子任务
 * （`succeeded`/`external_pending`，且每个有正文的子任务都如此）才替换正文并清除提示；
 * 普通失败/取消留下的旧 result 一概不当成本轮正文。**不承诺窗口滚出后仍能无损恢复**，
 * 也**不把「GET 成功」或「本轮已结束」当作正文已完整的证据**。
 */

/** 本客户端认得的管家契约版本；`/identity` 返回不同版本时拒绝继续。 */
export const CONTRACT_VERSION = 1

export type ButlerTaskState =
  | 'queued' | 'running' | 'summarizing' | 'waiting_user'
  | 'external_pending' | 'partial' | 'completed' | 'failed' | 'cancelled'

export type RunState = 'running' | 'finished' | 'cancelled' | 'failed' | 'idle'

export interface ArtifactRef {
  readonly kind: string
  readonly title: string
  readonly path: string
}

export interface SubtaskSnapshot {
  readonly id: string
  readonly logicalId?: string
  readonly goal: string
  readonly state: string
  readonly agentId?: string
  readonly displayName?: string
  readonly detail?: string
  readonly result?: string
  readonly artifacts?: readonly ArtifactRef[]
  readonly pending?: { reason: string; next?: string }
  readonly conversationId?: string
  readonly finishedAt?: number | null
}

export interface TaskSnapshot {
  readonly id: string
  readonly conversationId: string
  readonly goal: string
  readonly state: ButlerTaskState
  readonly summary?: string
  readonly error?: string
  readonly finishedAt?: number | null
  readonly subtasks: readonly SubtaskSnapshot[]
}

export interface ConversationSummary {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly taskCount: number
}

export interface RunInfo {
  readonly runId: string
  readonly state: RunState
  readonly taskId: string
  readonly startedAt?: number
  readonly finishedAt?: number | null
  readonly seq?: number
  readonly windowStart?: number
}

export interface IdentityInfo {
  readonly mode: string
  readonly key: string
  readonly label: string
  readonly authPath: string
  readonly routePrefix: string
  readonly contractVersion: number
}

/** 管家事件流里会出现的事件；只声明本切片消费的字段。 */
export interface ButlerEvent {
  readonly type: 'run' | 'user' | 'chat' | 'chat_delta' | 'plan' | 'subtask' | 'subtask_delta' | 'subtask_thinking' | 'summary' | 'error' | 'reset'
  readonly seq?: number
  readonly runId?: string
  readonly taskId?: string
  readonly state?: string
  readonly text?: string
  readonly message?: string
  readonly role?: string
  readonly goal?: string
  readonly note?: string
  readonly id?: string
  readonly agentId?: string
  readonly displayName?: string
  readonly detail?: string
  readonly delta?: string
  readonly thinking?: string
  readonly error?: string
  readonly subtasks?: readonly { id: string; goal?: string; agentId?: string; reason?: string; displayName?: string }[]
  readonly artifacts?: readonly ArtifactRef[]
  readonly pending?: { reason: string; next?: string }
  readonly windowStart?: number
}

/** 恢复上下文：probe 给出的当前轮身份与头部序号。 */
export interface RecoveryContext {
  /** 当前轮标识；空串表示未知。 */
  readonly runId: string
  /** 当前轮头部序号；负数表示未知，此时不划分重放区间，也不做覆盖排除。 */
  readonly seq: number
  /**
   * 事件窗口已经滚出过：本轮更早的事件不在日志里，未落库的正文片段补不回来。
   * 置位时界面要如实提示「正文可能不完整」，并在本轮结束后重读快照补齐。
   */
  readonly truncated?: boolean
  /** 本轮已经结束：本轮结束时重读一次快照，看能否证明正文已完整落库。 */
  readonly final?: boolean
}

/** 正文基准属于哪一轮、覆盖到哪条事件。 */
export interface TextCoverage {
  /** 基准正文所属执行轮；空串表示轮次未知。 */
  readonly runId: string
  /** 恢复边界（probe 头部序号，含）：不大于它的事件属于重放的历史区间。 */
  readonly boundary: number
  /** 基准正文覆盖到的序号（含）：该轮内不大于它的增量不再重复计入。 */
  through: number
}

/** 恢复区间内收到的一条增量；覆盖边界推进后据此重算正文。 */
export interface ReplayDelta {
  readonly seq: number
  readonly text: string
}

/** 任务本里的一个子任务。 */
export interface SubtaskView {
  readonly id: string
  readonly goal: string
  readonly state: string
  readonly agentId: string
  readonly displayName: string
  /** 正文基准：已落库的快照 result，或同任务上一轮已经显示出来的正文。 */
  base: string
  /** 展示正文 = `base` + 覆盖边界之后的新增量。 */
  text: string
  /** `base` 的轮次与事件覆盖边界，见文件头说明。 */
  coverage: TextCoverage
  /** 本轮收到的增量（按 seq 升序）；正文始终由 `base` 与它按覆盖边界重算，随时可重算。 */
  replaying: readonly ReplayDelta[]
  /**
   * 已显示的正文可能包含与基准正文重复的部分：该子任务在重放区间里出现过
   * 「无法证明是否写了正文」的落库形态（`waiting_user`/`failed`/`cancelled` 等），
   * 而那些增量被如实保留了。界面据此如实提示，不用文本相似推断因果。
   */
  uncertain: boolean
  /** 最近一次状态迁移的说明（等待原因等）；每次 subtask 事件整体替换。 */
  note: string
  /** 成员思考快照；每次事件整体覆盖。 */
  thinking: string
  readonly artifacts: ArtifactRef[]
  pending?: { reason: string; next?: string }
}

/** 任务本里一轮任务的全部可见状态；只来自权威快照与管家事件。 */
export interface TaskView {
  taskId: string
  conversationId: string
  goal: string
  state: ButlerTaskState | ''
  /** 这一轮观察流的头部状态；空串表示还没收到 run 头。 */
  runState: RunState | ''
  /** 当前轮标识；用于识别换轮，换轮后旧投影整体作废。 */
  lastRunId: string
  summary: string
  error: string
  subtasks: SubtaskView[]
  /** 牛马大总管最近一次落定的发言（chat 替换、chat_delta 追加）。 */
  butlerText: string
  /**
   * 本轮正文可能不完整：事件窗口滚出后，未落库的增量无法从日志恢复。
   * 由恢复上下文置位，本轮结束重读快照补齐后清除；界面据此如实提示，不静默展示残缺正文。
   */
  incomplete: boolean
  updatedAt: number
}

/**
 * 结果落库的迁移状态：管家 `applyMemberResult` 在这两类下一定把正文写进 result，
 * 而且都写在 emit 之前。
 */
const CERTAIN_RESULT_STATES: ReadonlySet<string> = new Set(['succeeded', 'external_pending'])

/** 执行中的状态：当前尝试还没结束，落库迁移与覆盖边界都不看它们。 */
const ACTIVE_STATES: ReadonlySet<string> = new Set(['queued', 'dispatched', 'running'])

export function emptyTaskView(conversationId = ''): TaskView {
  return { taskId: '', conversationId, goal: '', state: '', runState: '', lastRunId: '', summary: '', error: '', subtasks: [], butlerText: '', incomplete: false, updatedAt: 0 }
}

/** 新建条目的覆盖边界：还没有落库基准，轮内增量全部计入。 */
function freshCoverage(runId: string): TextCoverage {
  return { runId, boundary: -1, through: -1 }
}

/**
 * 按覆盖边界重算正文：基准正文之后、未被覆盖的增量全部计入。增量一直保留，所以覆盖边界
 * 推进、重读快照换基准时都能重算，不会把已经取回的片段弄丢。
 */
function derive(sub: SubtaskView): SubtaskView {
  let text = sub.base
  for (const delta of sub.replaying) if (delta.seq > sub.coverage.through) text += delta.text
  return { ...sub, text }
}

/** 恢复区间（重放历史）里当前计入正文的增量条数：覆盖边界推进后可能清零。 */
function keptReplayCount(sub: SubtaskView): number {
  let kept = 0
  for (const delta of sub.replaying) if (delta.seq > sub.coverage.through && delta.seq <= sub.coverage.boundary) kept++
  return kept
}

/** 追加一条成员发言增量：只入账，正文按覆盖边界重算（历史区间与实时区间同一套账）。 */
function appendDelta(sub: SubtaskView, seq: number, delta: string): SubtaskView {
  return derive({ ...sub, replaying: [...sub.replaying, { seq, text: delta }] })
}

/**
 * 这条状态迁移对覆盖边界与不确定标记的影响。证据只用**生产端可证明的落库关系**：
 * `succeeded` 与 `external_pending` 是 `applyMemberResult` 唯一确定写正文的两类迁移，
 * 落库又写在 emit 之前，所以序号不晚于恢复边界的这类迁移，其正文必然已在快照里；
 * 其余已结束状态（`waiting_user`/`failed`/`cancelled`…）无法从事件载荷证明是否写了正文
 * ——同名状态既可能是结果落库，也可能只改状态或只写 error——因此**不依据文本相似推进
 * 边界**：保留已经取回的增量，只把子任务标成 `uncertain`，由界面如实提示可能重复。
 * 执行中状态（`queued`/`dispatched`/`running`）说明当前尝试还没结束，一律不动。
 * 没有基准正文（base 为空）时既不排除也不标记。
 */
function coverageAfter(sub: SubtaskView, event: ButlerEvent): SubtaskView {
  const coverage = sub.coverage
  if (sub.base === '' || event.state === undefined || ACTIVE_STATES.has(event.state)) return sub
  if (typeof event.seq !== 'number' || coverage.boundary < 0 || event.seq > coverage.boundary) return sub
  if (event.runId !== undefined && coverage.runId !== '' && event.runId !== coverage.runId) return sub
  if (!CERTAIN_RESULT_STATES.has(event.state)) {
    // 可能写了正文，也可能没写：保留增量并如实标记，不猜。
    return keptReplayCount(sub) > 0 ? { ...sub, uncertain: true } : sub
  }
  const through = Math.max(coverage.through, event.seq)
  const advanced = { ...sub, coverage: { ...coverage, through } }
  // 覆盖边界推进后，被排除掉的增量不再可能重复；还有剩余增量时保留不确定标记。
  return { ...advanced, uncertain: sub.uncertain && keptReplayCount(advanced) > 0 }
}

/**
 * 换执行轮后重新锚定覆盖边界：已显示的正文保留为基准（上一轮未落库的增量只存在于
 * 事件日志，换轮后拿不回来），但序号从 1 重新计数，旧边界不能沿用。
 */
function reanchor(sub: SubtaskView, runId: string): SubtaskView {
  if (sub.coverage.runId === runId) return sub
  const text = sub.text
  return { ...sub, base: text, text, coverage: { runId, boundary: -1, through: -1 }, replaying: [] }
}

/**
 * 用权威快照整体替换投影；事件投影永远以它为基准，不做本地推算。
 * `recovery` 是 probe 给出的当前轮身份与头部序号，缺失时不划分重放区间
 * （此时不做覆盖排除，正文只按增量累加，不会因为边界判断出错而丢字）。
 */
export function applySnapshot(view: TaskView, snapshot: TaskSnapshot, now = Date.now(), recovery?: RecoveryContext): TaskView {
  const existing = new Map(view.subtasks.map(s => [s.id, s]))
  const sameTask = snapshot.id === view.taskId
  const runId = recovery?.runId ?? (sameTask ? view.lastRunId : '')
  const boundary = recovery !== undefined && recovery.seq >= 0 ? recovery.seq : -1
  const priorOf = (id: string): SubtaskView | undefined => snapshot.id === view.taskId ? existing.get(id) : undefined
  // 补齐用的重读只有在**每个子任务都能证明没有缺口**时才敢清掉不完整提示：
  // `succeeded`/`external_pending` 的 result 一定是本轮写的；普通失败/取消只写 error，
  // result 可能还是上一轮的，同样不能当成本轮正文。result 为空时只有 `queued`（还没派发，
  // 生产端派发之后才可能产生增量）能证明「本来就没有正文」——**当前显示为空不算证据**：
  // 那些增量可能已经随事件窗口滚出、且从未落库。
  const proven = recovery?.final === true && snapshot.subtasks.every(s =>
    (s.result ?? '') !== '' ? CERTAIN_RESULT_STATES.has(s.state) : s.state === 'queued')
  return {
    taskId: snapshot.id,
    conversationId: snapshot.conversationId,
    goal: snapshot.goal,
    state: snapshot.state,
    runState: view.runState,
    lastRunId: view.lastRunId,
    summary: snapshot.summary ?? '',
    error: snapshot.error ?? '',
    // 换任务后旧一轮的管家发言不再属于当前展示，一并作废。
    butlerText: snapshot.id === view.taskId ? view.butlerText : '',
    // 恢复上下文说明事件窗口是否滚出过；补齐用的重读要看是否证明得了本轮完整。
    incomplete: recovery?.final === true ? !proven : recovery?.truncated === true,
    subtasks: snapshot.subtasks.map(s => {
      // 只有确属同一任务时才保留事件期累积的内容；已落库的 result 是权威基准。
      const prior = priorOf(s.id)
      const result = s.result ?? ''
      const sameRun = prior !== undefined && runId !== '' && prior.coverage.runId === runId
      // 正文基准：已落库的 result 优先；同一轮重读且快照还没有 result 时沿用原基准（增量另记），
      // 换轮重读时把上一轮已显示的正文整段接过来（上一轮未落库的增量只在日志里，换轮后拿不回来）。
      const basis = result !== '' ? result : sameRun ? prior?.base ?? '' : prior?.text ?? ''
      // 只有能证明 result 属于本轮正文的形态才以恢复边界为覆盖边界：其余形态（运行中带旧
      // result、普通失败/取消留下上一轮 result…）保留已取回的增量，不用文本相似去推断。
      const adopted = result !== '' && CERTAIN_RESULT_STATES.has(s.state)
      return derive({
        id: s.id,
        goal: s.goal,
        state: s.state,
        agentId: s.agentId ?? '',
        displayName: s.displayName ?? s.agentId ?? s.id,
        base: basis,
        text: basis,
        coverage: {
          runId,
          boundary,
          through: Math.max(adopted ? boundary : -1, sameRun ? prior.coverage.through : -1),
        },
        // 同一轮保留已有增量（覆盖边界推进后据此重算）；换轮只留新轮的账。
        replaying: sameRun ? prior.replaying : [],
        // 权威正文替换掉整段正文时不确定标记一并消除，否则沿用已有标记。
        uncertain: adopted ? false : prior?.uncertain ?? false,
        note: prior?.note ?? '',
        thinking: prior?.thinking ?? '',
        artifacts: [...(s.artifacts ?? [])],
        ...(s.pending === undefined ? {} : { pending: { ...s.pending } }),
      })
    }),
    updatedAt: now,
  }
}

/**
 * 按契约语义应用一条事件；不认识的事件类型原样返回，不报错。
 * 换任务（taskId 变化）时整体作废旧投影——管家每轮的子任务编号从 s1 重新计数，
 * 跨任务复用同号子任务的正文是错的。换执行轮（runId 变化但 taskId 不变）只作废
 * 轮内发言，不丢权威快照。
 */
export function applyEvent(view: TaskView, event: ButlerEvent, now = Date.now()): TaskView {
  let base = view
  if (event.taskId && view.taskId && event.taskId !== view.taskId) {
    base = emptyTaskView(view.conversationId)
  }
  const next: TaskView = { ...base, subtasks: base.subtasks, updatedAt: now }
  switch (event.type) {
    case 'run': {
      const runId = event.runId ?? ''
      if (runId && base.lastRunId && runId !== base.lastRunId) {
        // 同任务换执行轮（回复/补话）：只清轮内发言与错误；跨任务轮换已整体重置。
        next.butlerText = ''
        next.error = ''
      }
      next.runState = (event.state as RunState | undefined) ?? ''
      if (runId) next.lastRunId = runId
      if (event.taskId) next.taskId = event.taskId
      // 覆盖边界按轮重新锚定：新轮的序号从 1 重新计数，旧轮的边界不能沿用。
      if (runId) next.subtasks = base.subtasks.map(s => reanchor(s, runId))
      return next
    }
    case 'plan': {
      if (event.taskId) next.taskId = event.taskId
      if (event.goal) next.goal = event.goal
      next.state = next.state === '' ? 'running' : next.state
      const known = new Map(base.subtasks.map(s => [s.id, s]))
      // 同一任务的追加计划只带新增条目：按 id 合并。已有条目保留正文基准与覆盖边界
      // ——重放里的历史 plan 事件不得解除已落库正文的覆盖，否则历史增量会重复计入。
      const incoming = (event.subtasks ?? []).map(s => {
        const prior = known.get(s.id)
        if (prior === undefined) {
          return {
            id: s.id, goal: s.goal ?? '', state: 'queued', agentId: s.agentId ?? '', displayName: s.displayName ?? s.agentId ?? s.id,
            base: '', text: '', coverage: freshCoverage(event.runId ?? base.lastRunId), replaying: [], uncertain: false,
            note: '', thinking: '', artifacts: [],
          }
        }
        return { ...prior, goal: s.goal ?? '', agentId: s.agentId ?? '', displayName: s.displayName ?? s.agentId ?? s.id }
      })
      const incomingIds = new Set(incoming.map(s => s.id))
      next.subtasks = [...base.subtasks.filter(s => !incomingIds.has(s.id)), ...incoming]
      return next
    }
    case 'subtask': {
      if (!event.id) return view
      const index = base.subtasks.findIndex(s => s.id === event.id)
      const prior: SubtaskView = index >= 0 ? base.subtasks[index] : {
        id: event.id, goal: '', state: '', agentId: event.agentId ?? '', displayName: event.displayName ?? event.agentId ?? event.id,
        base: '', text: '', coverage: freshCoverage(event.runId ?? base.lastRunId), replaying: [], uncertain: false,
        note: '', thinking: '', artifacts: [],
      }
      const merged = derive({
        ...coverageAfter(prior, event),
        state: event.state ?? prior.state,
        agentId: event.agentId ?? prior.agentId,
        displayName: event.displayName ?? prior.displayName,
        note: event.detail ?? prior.note,
        artifacts: event.artifacts === undefined ? prior.artifacts : [...event.artifacts],
        ...(event.pending === undefined ? (prior.pending === undefined ? {} : { pending: prior.pending }) : { pending: { ...event.pending } }),
      })
      next.subtasks = index >= 0
        ? base.subtasks.map((s, i) => i === index ? merged : s)
        : [...base.subtasks, merged]
      return next
    }
    case 'subtask_delta': {
      if (!event.id) return view
      next.subtasks = base.subtasks.map(s => {
        if (s.id !== event.id) return s
        // 没带序号的事件按「恢复之后的新事件」处理：一律计入，不参与覆盖排除。
        return appendDelta(s, typeof event.seq === 'number' ? event.seq : Number.MAX_SAFE_INTEGER, event.delta ?? '')
      })
      return next
    }
    case 'subtask_thinking': {
      if (!event.id) return view
      next.subtasks = base.subtasks.map(s => s.id === event.id ? { ...s, thinking: event.thinking ?? '' } : s)
      return next
    }
    case 'chat':
      next.butlerText = event.text ?? ''
      return next
    case 'chat_delta':
      next.butlerText = view.butlerText + (event.text ?? '')
      return next
    case 'summary':
      if (event.taskId) next.taskId = event.taskId
      next.summary = event.text ?? ''
      if (event.state) next.state = event.state as ButlerTaskState
      if (event.error !== undefined && event.error !== '') next.error = event.error
      return next
    case 'error':
      next.error = event.message ?? event.error ?? '执行出错'
      return next
    default:
      return view
  }
}

/** 游戏态展示映射：管家的内部执行阶段在任务本里合并展示，不复制业务判断。 */
export function taskStateLabel(state: string): string {
  const labels: Record<string, string> = {
    '': '尚未生成任务',
    queued: '排队中',
    running: '进行中',
    summarizing: '汇总中',
    waiting_user: '等你回话',
    external_pending: '待外部处理',
    partial: '部分完成',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return labels[state] ?? state
}
