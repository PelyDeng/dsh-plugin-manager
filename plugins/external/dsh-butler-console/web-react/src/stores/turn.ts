/**
 * 回合/流 store（方案 §3.3）：游标组（lastSeq/lastRunId/lastRunTaskId）、streaming/abort
 * 与 viewToken 是同一条 SSE 生命周期的三个面，收在这里；「切换会话」是**一个原子动作**
 * （bump viewToken + 清条目 + 重置游标 + abort），I09 守卫不复制到别处。
 *
 * 字段口径（评审 #18 治理后）：lastRunTaskId 是**本轮执行绑定任务**的唯一游标——
 * 补充（Composer）、喊停（stopTurn）、引擎宿主与 ask 卡兜底都读它；没有第二个
 * 「视图任务 id」字段（旧 taskId 已删：任务详情页渲染历史记录不得污染运行游标）。
 * subtask 条目按 subtaskId 从 entries 派生查找（subtaskEntryOf），无并行索引。
 *
 * 消息流渲染模型：`entries` 是按时间追加的条目数组（React 的主数据）；高频增量
 * （chat_delta/subtask_delta）先累积在**非响应式缓冲**里，按绘制帧合并提交（旧
 * events.js 的 framePending/scheduleFrame 语义在 store 层重做），terminal/live 的
 * 迟到帧丢弃守卫显式保留。
 */
import { create } from 'zustand'
import { rememberConversation } from '../lib/turn-event.ts'
import type { TurnEvent, AgentAction } from '../lib/turn-event.ts'
import type { TaskRecord } from '../lib/api.ts'
import { stateText } from '../lib/task-state.ts'
import { STREAM_RICH_LIMIT } from '../lib/config.ts'
import type { ThreadEntry, DispatchEntry, SubtaskEntry } from './thread-entries.ts'
import {
  subtaskEntryOf,
  TERMINAL_TASK_STATES, TERMINAL_SUBTASK_STATES, PAUSED_SUBTASK_STATES, SETTLED_SUBTASK_STATES,
} from './thread-entries.ts'

/** 条目类型独立在 thread-entries.ts（评审 #19）；此处 re-export 保持组件 import 路径稳定。 */
export type { ThreadEntry, UserEntry, ButlerEntry, SubtaskEntry, NoteEntry, ErrorEntry, SummaryEntry, TaskEntry, DispatchEntry } from './thread-entries.ts'

export interface TurnState {
  conversationId: string | null
  streaming: boolean
  abort: AbortController | null
  /**
   * 视图代次（势力范围，评审 挂账#26）：中栏所有「换内容」的动作必须 bump 它并对
   * 回包核对 token；左栏列表（chatList）与附件（按 conversationId）是自治域，不核对。
   * 任务详情页与会话视图共用同一 token 序列（popstate 返回键依赖）。
   */
  viewToken: number
  /** 发送时预渲染、等服务端回放确认的那条用户消息（批 3 发送路径用）。 */
  pendingUser: { text: string } | null
  /** 本轮事件消费进度：seq 用于断线重订的游标，lastRunTaskId 用于 reset 后取快照。 */
  lastSeq: number
  lastRunTaskId: string
  lastRunId: string
  /** 上一条落定的大总管正文：汇总卡与之相同时不再重复整段（S12）。 */
  lastChatText: string
  /** 消息流条目（渲染主数据）。 */
  entries: ThreadEntry[]
  /** 大总管流式那条的 key；落定的 `chat` 收走置 null。 */
  butlerSpeechKey: string | null
  /** 任务详情二级视图（openTask 进入，view-head/popstate 返回）。 */
  taskView: { taskId: string } | null
  /** 滚动跟随：用户上滚或选字时暂停，「回到最新」恢复。 */
  following: boolean
  selecting: boolean

  /** 原子切换会话：bump viewToken + 清条目 + 重置游标 + abort（一个 set 完成）。 */
  switchConversation: (id: string | null, opts?: { keepFollowing?: boolean }) => void
  /** 新视图接管（快照重建/新建会话）：只清条目与游标，会话 id 由调用方管。 */
  beginRebuild: () => void
  resetFollowing: () => void
  setFollowing: (following: boolean) => void
  setSelecting: (selecting: boolean) => void
  /** 追加历史条目（打开会话/加载更早：调用方已做 I09 核对）。 */
  prependEntries: (items: ThreadEntry[]) => void
  appendEntry: (entry: ThreadEntry) => void
  removeEntry: (key: string) => void
  /** 渲染一条任务记录（历史回放/快照重建的主体）。 */
  renderTaskRecord: (record: TaskRecord, opts?: { liveResume?: boolean }) => void
  /** consumeTurnEvent 语义：游标推进 + 事件分发（handleEvent）。 */
  applyTurnEvent: (event: TurnEvent) => void
  /** 把帧缓冲里的增量提交进 entries（rAF 节拍由 hooks 层驱动）。 */
  flushFrame: () => void
}

let entrySeq = 0
const nextKey = (prefix: string) => `${prefix}-${++entrySeq}`

/**
 * 帧缓冲（非响应式）：delta 先落这里，flushFrame 一次性并入 entries。
 * 两条规则与旧 events.js 一致：terminal（已校准）或 live=false 的气泡不再追加。
 */
interface FramePatch {
  butlerText?: string | undefined
  subtaskBody?: string | undefined
  subtaskId?: string | undefined
}

const frameBuffer = new Map<string, FramePatch>()
let frameScheduled = false

function scheduleFlush(): void {
  if (frameScheduled) return
  frameScheduled = true
  const run = () => {
    frameScheduled = false
    useTurnStore.getState().flushFrame()
  }
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(run)
  else setTimeout(run, 16)
}

export const useTurnStore = create<TurnState>(set => ({
  conversationId: null,
  taskView: null,
  streaming: false,
  abort: null,
  viewToken: 0,
  pendingUser: null,
  lastSeq: 0,
  lastRunTaskId: '',
  lastRunId: '',
  lastChatText: '',
  entries: [],
  butlerSpeechKey: null,
  following: true,
  selecting: false,

  switchConversation: (id, opts = {}) => {
    // 原子动作：先断悬挂连接，再一次性置换视图状态——I09 守卫只有这一份。
    useTurnStore.getState().abort?.abort()
    set({
      viewToken: useTurnStore.getState().viewToken + 1,
      conversationId: id,
      entries: [],
      butlerSpeechKey: null,
      pendingUser: null,
      lastSeq: 0,
      lastRunId: '',
      lastRunTaskId: '',
      lastChatText: '',
      taskView: null,
      streaming: false,
      abort: null,
      following: opts.keepFollowing === true ? useTurnStore.getState().following : true,
    })
  },

  beginRebuild: () => {
    set({
      viewToken: useTurnStore.getState().viewToken + 1,
      entries: [],
      butlerSpeechKey: null,
      following: true,
    })
  },

  resetFollowing: () => set({ following: true }),
  setFollowing: following => set({ following }),
  setSelecting: selecting => set({ selecting }),

  prependEntries: items => {
    set(state => ({ entries: [...items, ...state.entries] }))
  },

  appendEntry: entry => {
    set(state => ({ entries: [...state.entries, entry] }))
  },

  removeEntry: key => {
    set(state => ({ entries: state.entries.filter(entry => entry.key !== key) }))
  },

  /** 渲染一条任务记录（历史回放/快照接续/任务详情页三处共用）：调度卡 + 成员数据面。 */
  renderTaskRecord: (record, opts = {}) => {
    const liveResume = opts.liveResume === true
    const terminalRecord = TERMINAL_TASK_STATES.includes(record.state)
    const prefs = readCardPrefs(record.id)
    const entries: ThreadEntry[] = []
    entries.push({ key: nextKey('user'), kind: 'user', text: record.goal, time: Number(record.createdAt) || undefined })
    entries.push({
      key: nextKey('butler'), kind: 'butler',
      text: record.note
        ? `我按这个思路拆的：${record.note}`
        : '我按下面的方式拆了任务。',
      thinking: '', streaming: false,
      time: Number(record.createdAt) || undefined,
    })
    // 成员数据面（与实时同一份结构）：快照接续时 waiting 成员重新拿到回话入口。
    const memberEntries: ThreadEntry[] = []
    const order: string[] = []
    for (const subtask of record.subtasks) {
      order.push(subtask.id)
      const terminalSub = TERMINAL_SUBTASK_STATES.includes(subtask.state)
      const waiting = subtask.state === 'waiting_user'
      memberEntries.push({
        key: nextKey('subtask'), kind: 'subtask', subtaskId: subtask.id, agentId: subtask.agentId,
        goal: subtask.goal, state: subtask.state,
        body: subtask.state === 'failed' || subtask.state === 'cancelled'
          ? (subtask.error || '失败')
          : (subtask.result || stateText(subtask.state) || ''),
        thinking: '', terminal: terminalSub, live: false, toolLine: null,
        artifacts: Array.isArray(subtask.artifacts) ? subtask.artifacts : [],
        actions: Array.isArray(subtask.actions) ? subtask.actions : undefined,
        pending: subtask.pending,
        verdict: subtask.verdict, verdictReason: subtask.verdictReason,
        startedAt: subtask.startedAt, finishedAt: subtask.finishedAt,
        detail: subtask.result, error: subtask.error,
        // 快照接续的等待是活的：回话入口重新给出（历史回放则提示重新描述目标）。
        ...(waiting && liveResume
          ? { ask: { taskId: record.id, question: subtask.result || '需要你补充点信息', detail: subtask.result ?? '' } }
          : {}),
      })
    }
    entries.push({
      key: `dispatch-${record.id}`, kind: 'dispatch', taskId: record.id,
      order, active: order[0] ?? null,
      // 未终任务是「活的」：默认展开（收起会把确认入口/等待输入藏进折叠区）；
      // 终态任务沿用用户自己的折叠偏好（刷新重建先读偏好再渲染）。
      open: !terminalRecord || prefs.open === true,
      resultOnly: prefs.resultOnly === true,
      fresh: false, pulses: [],
    })
    entries.push(...memberEntries)
    if (terminalRecord || !liveResume) {
      entries.push({ key: nextKey('summary'), kind: 'summary', state: record.state, text: record.summary ?? '', error: typeof record.error === 'string' && record.error !== '' ? record.error : undefined, time: Number(record.updatedAt) || undefined })
    }
    // 注意不写 lastRunTaskId：任务详情页（openTask）渲染的可能是历史记录，运行游标
    // 只属于活的一轮（resumeLiveTurn/openConversation 各自按头信息恢复，评审 #18）。
    set(state => ({ entries: [...state.entries, ...entries] }))
  },

  applyTurnEvent: event => {
    advanceTurnCursor(event)
    switch (event.type) {
      case 'conversation': return handleConversationEvent(event)
      case 'user': return handleUserEvent(event)
      case 'chat': return handleChatEvent(event)
      case 'chat_delta': return handleChatDelta(event)
      case 'chat_thinking': return handleChatThinking(event)
      case 'chat_reset': return handleChatReset(event)
      case 'input': return handleInputEvent(event)
      case 'plan': return handlePlanEvent(event)
      case 'subtask': return handleSubtaskEvent(event)
      case 'subtask_delta': return handleSubtaskDelta(event)
      case 'subtask_thinking': return handleSubtaskThinking(event)
      case 'summary': return handleSummaryEvent(event)
      case 'error': return handleErrorEvent(event)
      default:
        return
    }
  },

  flushFrame: () => {
    if (frameBuffer.size === 0) return
    const updates = new Map(frameBuffer)
    frameBuffer.clear()
    set(state => ({
      entries: state.entries.map(entry => {
        if (entry.kind === 'butler' && updates.has(entry.key)) {
          const patch = updates.get(entry.key)
          // 迟到帧守卫（flush 侧再查一次，与旧 events.js 帧回调同口径）：
          // 落定的 `chat` 已收走该条（streaming=false），残帧不得覆盖权威正文。
          if (patch?.butlerText !== undefined && entry.streaming) return { ...entry, text: patch.butlerText }
          return entry
        }
        if (entry.kind === 'subtask' && updates.has(entry.key)) {
          const patch = updates.get(entry.key)
          // terminal（已校准）或 live=false（已离开执行态）不写：迟到帧不把半截增量
          // 追加到 S09 权威结论上，也不把已收起的光标重新点亮。
          if (patch?.subtaskBody !== undefined && !entry.terminal && entry.live) return { ...entry, body: patch.subtaskBody }
          return entry
        }
        return entry
      }),
    }))
  },
}))

// ── 游标推进（consumeTurnEvent 语义，口径只有这一份）─────────────────────
// 游标契约（评审 #14，依赖两条服务端事实，改动前先读）：
//   ① 每条**渲染类**事件必带 seq（服务端 src/web.ts streamRun 落流时写入）；
//   ② 每次订阅开始必先发一条 run 头（run 归零=服务端 event-log 每轮从 seq 1 重计数，
//      这是权威语义不是 bug）。
// run 头把 lastSeq 归零、其余事件推进 lastSeq——engine 侧 after 与此同源，交接见
// lib/turn-engine.ts followUntilTerminal（重订时 from=store.lastSeq）。
function advanceTurnCursor(event: TurnEvent): void {
  if (event.type === 'run') {
    useTurnStore.setState(state => ({
      lastSeq: 0,
      lastRunId: event.runId ?? '',
      ...(event.taskId !== undefined && event.taskId !== '' ? { lastRunTaskId: event.taskId } : {}),
    }))
  } else if (event.seq !== undefined) {
    useTurnStore.setState({ lastSeq: event.seq })
  }
  if ((event.type === 'subtask' || event.type === 'plan') && event.taskId !== undefined && event.taskId !== '') {
    useTurnStore.setState({ lastRunTaskId: event.taskId })
  }
}

function handleConversationEvent(event: TurnEvent): void {
  if (typeof event.conversationId === 'string' && event.conversationId !== '') {
    useTurnStore.setState({ conversationId: event.conversationId })
    rememberConversation(event.conversationId)
  }
}

function handleUserEvent(event: TurnEvent): void {
  // 受理回放对得上预渲染的那条就不重复画（对不上：历史回放、其他入口，照常渲染）。
  // 与旧 events.js 同口径：user 到达即撤「只有思考」的预览并清思考快照。
  const store = useTurnStore.getState()
  const speechKey = store.butlerSpeechKey
  if (speechKey !== null) {
    const speech = store.entries.find(entry => entry.key === speechKey)
    if (speech?.kind === 'butler' && speech.text === '') {
      frameBuffer.delete(speechKey)
      useTurnStore.setState(st => ({ entries: st.entries.filter(entry => entry.key !== speechKey), butlerSpeechKey: null }))
    }
  }
  const pending = useTurnStore.getState().pendingUser
  if (pending !== null && pending.text === event.text) {
    useTurnStore.setState({ pendingUser: null })
    return
  }
  useTurnStore.getState().appendEntry({ key: nextKey('user'), kind: 'user', text: event.text ?? '', time: event.time })
}

function handleChatEvent(event: TurnEvent): void {
  // 落定：收走流式那条；没有就新起一条（直接回答、接续回放）。
  // 帧缓冲里该条的残留 delta 一并作废——落定正文是权威，不被残帧覆盖。
  const speechKey = useTurnStore.getState().butlerSpeechKey
  const text = event.text ?? ''
  if (speechKey !== null) frameBuffer.delete(speechKey)
  if (speechKey !== null) {
    useTurnStore.setState(st => ({
      butlerSpeechKey: null,
      lastChatText: text,
      entries: st.entries.map(entry => entry.key === speechKey && entry.kind === 'butler'
        ? { ...entry, text, streaming: false, time: event.time ?? entry.time }
        : entry),
    }))
  } else {
    useTurnStore.setState(st => ({ lastChatText: text }))
    useTurnStore.getState().appendEntry({ key: nextKey('butler'), kind: 'butler', text, thinking: '', streaming: false, time: event.time })
  }
}

function handleChatDelta(event: TurnEvent): void {
  const speechKey = useTurnStore.getState().butlerSpeechKey
  const key = speechKey ?? nextKey('butler')
  if (speechKey === null) {
    useTurnStore.setState(st => ({ butlerSpeechKey: key, entries: [...st.entries, { key, kind: 'butler', text: '', thinking: '', streaming: true, time: undefined }] }))
  }
  const buffer = frameBuffer.get(key) ?? {}
  buffer.butlerText = (buffer.butlerText ?? currentButlerText(key)) + (event.text ?? '')
  frameBuffer.set(key, buffer)
  scheduleFlush()
}

function handleChatThinking(event: TurnEvent): void {
  // 思考常早于第一段正文（模型先推理后说话）：只推理还没吐字时也开气泡，
  // 让「在想」可见；这条可能是会被重试掉的尝试（chat_reset 时撤，thinkingOnly 语义）。
  const thinking = event.thinking ?? ''
  if (thinking === '') return
  const speechKey = useTurnStore.getState().butlerSpeechKey
  if (speechKey === null) {
    const key = nextKey('butler')
    useTurnStore.setState(st => ({ butlerSpeechKey: key, entries: [...st.entries, { key, kind: 'butler', text: '', thinking, streaming: true, time: undefined }] }))
    return
  }
  useTurnStore.setState(st => ({ entries: st.entries.map(entry => entry.key === speechKey && entry.kind === 'butler' ? { ...entry, thinking } : entry) }))
}

function handleChatReset(_event: TurnEvent): void {
  // 模型重试（S08）：只有思考、还没吐字的那条预览撤掉，下一版从新气泡起头。
  const speechKey = useTurnStore.getState().butlerSpeechKey
  if (speechKey !== null) {
    const speech = useTurnStore.getState().entries.find(entry => entry.key === speechKey)
    if (speech?.kind === 'butler' && speech.text === '' && speech.thinking !== '') {
      useTurnStore.getState().removeEntry(speechKey)
      useTurnStore.setState({ butlerSpeechKey: null })
    }
  }
}

function handleInputEvent(event: TurnEvent): void {
  // input 是本轮的补充受理：taskId 属于活任务，写入运行游标（空值不写，与 advanceTurnCursor 同口径）。
  if (event.taskId !== undefined && event.taskId !== '') {
    useTurnStore.setState({ lastRunTaskId: event.taskId })
  }
  useTurnStore.getState().appendEntry({
    key: nextKey('note'), kind: 'note',
    text: event.source === 'supplement' ? `补充已收到（第 ${String(event.version)} 版）：${event.text ?? ''}` : event.text ?? '',
  })
}

function handlePlanEvent(event: TurnEvent): void {
  // 调度卡（批 4b）：一张卡 + 每个子任务一条 subtask entry（数据面），格子即那一行。
  const taskId = event.taskId ?? useTurnStore.getState().lastRunTaskId ?? ''
  const entryKey = nextKey('dispatch')
  const subtasks = Array.isArray(event.subtasks) ? event.subtasks as Array<{ id: string; agentId: string; goal?: string; state?: string; startedAt?: number; reason?: string }> : []
  const prefs = readCardPrefs(taskId)
  const dispatch: DispatchEntry = {
    key: entryKey, kind: 'dispatch', taskId,
    order: subtasks.map(subtask => subtask.id),
    active: subtasks.length > 0 ? subtasks[0]?.id ?? null : null,
    open: typeof prefs.open === 'boolean' ? prefs.open : false,
    resultOnly: prefs.resultOnly === true,
    fresh: false, pulses: [],
  }
  useTurnStore.setState(st => {
    const memberEntries: ThreadEntry[] = subtasks.map(subtask => ({
      key: nextKey('subtask'), kind: 'subtask', subtaskId: subtask.id, agentId: subtask.agentId ?? '', goal: subtask.goal ?? '',
      state: subtask.state ?? 'queued', body: '', thinking: '', terminal: false, live: true,
      toolLine: null, artifacts: [], startedAt: subtask.startedAt ?? null, detail: null, error: null,
      dispatchReason: subtask.reason,
    }))
    return { entries: [...st.entries, dispatch, ...memberEntries] }
  })
}

/** subtask 事件（旧 handleSubtask 的 store 面）：状态机 dispatched/running/终态。 */
function handleSubtaskEvent(event: TurnEvent): void {
  const subtaskId = event.id ?? ''
  const existing = subtaskEntryOf(useTurnStore.getState().entries, subtaskId)
  const key = existing?.key ?? nextKey('subtask')
  if (existing === undefined) {
    useTurnStore.getState().appendEntry({
      key, kind: 'subtask', subtaskId, taskId: event.taskId ?? undefined, agentId: event.agentId ?? '', goal: '',
      state: event.state ?? '', body: '', thinking: '', terminal: false, live: true,
      toolLine: null, artifacts: [], startedAt: event.startedAt, detail: null, error: null,
      actions: Array.isArray(event.actions) ? (event.actions as ReadonlyArray<AgentAction>) : undefined,
    })
  }

  const apply = (patch: (entry: SubtaskEntry) => SubtaskEntry) => {
    useTurnStore.setState(st => ({
      entries: st.entries.map(entry => {
        if (entry.key === key && entry.kind === 'subtask') return patch(entry)
        // 只有状态**真变化**才标注到调度卡（旧 attachToDispatch 的 changed 口径）：
        // running 的工具行更新不算变化，不反复点亮「有更新」与脉冲。
        if (entry.kind === 'dispatch' && entry.order.includes(subtaskId)) {
          const before = subtaskEntryOf(st.entries, subtaskId)
          const changed = before === undefined || before.state !== (event.state ?? '')
          if (!changed) return entry
          // 脉冲 600ms 自清（旧 pulseCardCell 的 setTimeout 语义）；timer 仅在
          // 状态真变化（会点亮脉冲）时安排，不空转（评审 #20）。
          window.setTimeout(() => {
            useTurnStore.setState(st => ({
              entries: st.entries.map(entry => entry.kind === 'dispatch'
                ? { ...entry, pulses: entry.pulses.filter(id => id !== subtaskId) }
                : entry),
            }))
          }, 600)
          return { ...entry, fresh: !entry.open, pulses: entry.pulses.includes(subtaskId) ? entry.pulses : [...entry.pulses, subtaskId] }
        }
        return entry
      }),
    }))
  }

  if (event.state === 'dispatched') {
    // 新一次尝试从头开始（S08）：清掉上次的预览与终态标记，旧尝试的迟到增量不串进新版。
    apply(entry => ({ ...entry, body: '', state: 'dispatched', terminal: false, live: true, artifacts: [], startedAt: event.startedAt ?? null }))
    return
  }
  if (event.state === 'running') {
    apply(entry => ({
      ...entry,
      state: 'running',
      taskId: event.taskId ?? entry.taskId,
      toolLine: event.tool !== undefined || event.detail !== undefined
        ? { tool: event.tool, detail: event.detail ?? undefined }
        : entry.toolLine,
      actions: Array.isArray(event.actions) ? (event.actions as ReadonlyArray<AgentAction>) : entry.actions,
      startedAt: entry.startedAt ?? event.startedAt ?? null,
    }))
    return
  }
  // 终态/半终态：光标收起（live=false），正文以服务端那份为权威（S09——空串判断不是 ??）。
  if (event.state === 'waiting_user') {
    // 回话入口必须可见：卡收着时等待卡被折叠区藏住（不可点）。自动展开一次。
    useTurnStore.setState(st => ({
      entries: st.entries.map(entry => entry.kind === 'dispatch' && entry.order.includes(subtaskId) && !entry.open
        ? { ...entry, open: true }
        : entry),
    }))
  }
  if (event.state !== undefined && SETTLED_SUBTASK_STATES.includes(event.state)) {
    const authoritative = typeof event.detail === 'string' ? event.detail.trim() : ''
    const finalText = authoritative !== '' ? event.detail ?? '' : undefined
    apply(entry => ({
      ...entry,
      state: event.state ?? entry.state,
      // running 事件往往不带 taskId、终态才带——不在终态补一次，/action 会带空 taskId 404。
      taskId: event.taskId ?? entry.taskId,
      terminal: true,
      live: false,
      body: finalText !== undefined ? finalText : entry.body,
      detail: event.detail ?? entry.detail,
      error: event.error ?? entry.error,
      finishedAt: event.finishedAt ?? undefined,
      artifacts: Array.isArray(event.artifacts) ? event.artifacts : entry.artifacts,
      // 终态（尤其 external_pending）才带 prepared 操作卡——确认按钮全靠它；
      // running 事件不带 actions，这里不透传会让 deck 永远派生不出确认项。
      actions: Array.isArray(event.actions) ? (event.actions as ReadonlyArray<AgentAction>) : entry.actions,
      pending: typeof event.pending === 'object' && event.pending !== null && typeof (event.pending as { reason?: unknown }).reason === 'string' ? event.pending as { reason: string; next?: string } : entry.pending,
      // 等你回话不是在计算：给回复入口（ask 卡）。卡面问题用 question，正文用 detail，
      // 混用会让「正文」变成一句提问（旧 handleSubtask 的告诫）。
      ask: event.state === 'waiting_user'
        ? { taskId: event.taskId ?? useTurnStore.getState().lastRunTaskId ?? '', question: event.question as string | undefined, detail: event.detail ?? undefined }
        : undefined,
    }))
  }
}

function handleSubtaskDelta(event: TurnEvent): void {
  // 终态之后不再追加（S08）：迟到帧不把已校准的结论再改掉。
  const entry = subtaskEntryOf(useTurnStore.getState().entries, event.id ?? '')
  if (entry === undefined || entry.terminal || !entry.live) return
  const buffer: FramePatch = frameBuffer.get(entry.key) ?? { subtaskId: event.id }
  buffer.subtaskBody = (buffer.subtaskBody ?? entry.body) + (event.delta ?? '')
  frameBuffer.set(entry.key, buffer)
  scheduleFlush()
}

function handleSubtaskThinking(event: TurnEvent): void {
  const entry = subtaskEntryOf(useTurnStore.getState().entries, event.id ?? '')
  if (entry === undefined) return
  useTurnStore.setState(st => ({ entries: st.entries.map(candidate => candidate.key === entry.key && candidate.kind === 'subtask' ? { ...candidate, thinking: event.thinking ?? '' } : candidate) }))
}

function handleSummaryEvent(event: TurnEvent): void {
  // 汇总是这一轮的定论：正文只展示一次（S12）——与最后一条 butler 正文相同时置空。
  const text = event.text ?? ''
  const dedup = text !== '' && text === useTurnStore.getState().lastChatText
  // 所有流式条目此刻收口：帧缓冲里的残留增量全部作废。
  frameBuffer.clear()
  useTurnStore.getState().appendEntry({
    key: nextKey('summary'), kind: 'summary', state: event.state ?? '', text: dedup ? '' : text, error: typeof event.error === 'string' && event.error !== '' ? event.error : undefined, time: event.time,
    ...(Array.isArray(event.followups) ? { followups: event.followups as string[] } : {}),
  })
  // 调度卡收口（settleCardForSummary 完整语义）：只有**收尾**的汇总才收口——
  // waiting_user/external_pending 是暂停（这一轮还活着），说成「已停止」是假话；
  // 还没定论的格子改写为 cancelled 并定格 finishedAt：结束的一轮里不能有永远在
  // 干活的成员+秒数在跳；成功成员（已有终态）一律不动——不把真实结果改成别的说法。
  const summaryState = event.state ?? ''
  const at = typeof event.time === 'number' ? event.time : Date.now()
  const isFinal = TERMINAL_TASK_STATES.includes(summaryState)
  useTurnStore.setState(st => ({
    entries: st.entries.map(entry => {
      if (entry.kind === 'subtask' && isFinal) {
        if (entry.terminal) return entry
        if (PAUSED_SUBTASK_STATES.includes(entry.state)) return { ...entry, live: false }
        return { ...entry, live: false, state: 'cancelled', finishedAt: at }
      }
      if (entry.kind === 'dispatch' && isFinal) {
        return { ...entry, fresh: !entry.open }
      }
      return entry
    }),
    butlerSpeechKey: null,
  }))
}

function handleErrorEvent(event: TurnEvent): void {
  // 稳定码区分（评审 中14）：流断了要刷新重开，业务失败等下一轮即可。
  const hint = event.code === 'stream_broken'
    ? '连接断了；请刷新页面重开，这一轮的结果以右栏任务记录为准。'
    : event.message ?? ''
  useTurnStore.getState().appendEntry({ key: nextKey('error'), kind: 'error', text: hint })
}

function currentButlerText(key: string): string {
  const entry = useTurnStore.getState().entries.find(candidate => candidate.key === key)
  return entry?.kind === 'butler' ? entry.text : ''
}

/**
 * 决策受理后本地摘卡（乐观更新）：确认/先不办已受理，prepared 操作卡从 deck 撤下，
 * 不等后端把子任务重新调度完（分钟级）才收——挂着只会诱导重复点击。
 * 后端后续事件若再带同 id 操作卡会按事件重建，本地摘除不与事件流冲突。
 */
export function resolveActionLocally(subtaskId: string, actionId: string): void {
  if (subtaskId === '' || actionId === '') return
  useTurnStore.setState(st => ({
    entries: st.entries.map(entry => entry.kind === 'subtask' && entry.subtaskId === subtaskId && Array.isArray(entry.actions)
      ? { ...entry, actions: entry.actions.filter(action => action.id !== actionId) }
      : entry),
  }))
}

/** 回话受理后本地摘卡：waiting_user 提问卡撤下（runReply 的 onAccepted 语义配套）。 */
export function resolveAskLocally(subtaskId: string): void {
  if (subtaskId === '') return
  useTurnStore.setState(st => ({
    entries: st.entries.map(entry => entry.kind === 'subtask' && entry.subtaskId === subtaskId && entry.ask !== undefined
      ? { ...entry, ask: undefined }
      : entry),
  }))
}

/** 卡片偏好（butler.card.{taskId}）：折叠与只看结论，键名与格式与旧前端一致（方案批 5）。 */
export function readCardPrefs(taskId: string): { open?: boolean; resultOnly?: boolean } {
  if (taskId === '') return {}
  try {
    const parsed = JSON.parse(localStorage.getItem('butler.card.' + taskId) ?? 'null')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch { return {} }
}

export function saveCardPref(taskId: string, patch: { open?: boolean; resultOnly?: boolean }): void {
  if (taskId === '') return
  try { localStorage.setItem('butler.card.' + taskId, JSON.stringify({ ...readCardPrefs(taskId), ...patch })) } catch { /* 隐私模式忽略。 */ }
}

/** 判断超长降级（渲染层用）：与旧前端同一阈值与语义。 */
export function isOverRichLimit(text: string): boolean {
  return text.length > STREAM_RICH_LIMIT
}
