/**
 * 回合/流 store（方案 §3.3）：游标组（lastSeq/lastRunId/lastRunTaskId）、streaming/abort
 * 与 viewToken 是同一条 SSE 生命周期的三个面，收在这里；「切换会话」是**一个原子动作**
 * （bump viewToken + 清条目 + 重置游标 + abort），I09 守卫不复制到别处。
 *
 * 消息流渲染模型：`entries` 是按时间追加的条目数组（React 的主数据）；高频增量
 * （chat_delta/subtask_delta）先累积在**非响应式缓冲**里，按绘制帧合并提交（旧
 * events.js 的 framePending/scheduleFrame 语义在 store 层重做），terminal/live 的
 * 迟到帧丢弃守卫显式保留。
 */
import { create } from 'zustand'
import { rememberConversation } from '../lib/turn-event.ts'
import type { TurnEvent } from '../lib/turn-event.ts'
import type { TaskRecord, TaskSummary } from '../lib/api.ts'
import { STATE_TEXT, STREAM_RICH_LIMIT } from '../lib/config.ts'

/** 消息流条目：React 渲染的统一数据面（旧 DOM 追加模型的范式转换）。 */
export type ThreadEntry = UserEntry | ButlerEntry | SubtaskEntry | NoteEntry | ErrorEntry | SummaryEntry | TaskEntry

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
  time?: number | undefined
}

/** 历史任务摘要卡（点开看详情，批 3 完整调度卡回放）：列表投影形状。 */
export interface TaskEntry {
  key: string
  kind: 'task'
  task: TaskSummary
}

export interface TurnState {
  conversationId: string | null
  streaming: boolean
  abort: AbortController | null
  /** 视图代次：所有会话切换入口共用，异步回包先核对它，旧响应不许写进新视图。 */
  viewToken: number
  /** 发送时预渲染、等服务端回放确认的那条用户消息（批 3 发送路径用）。 */
  pendingUser: { text: string } | null
  /** 本轮事件消费进度：seq 用于断线重订的游标，taskId 用于 reset 后取快照。 */
  lastSeq: number
  lastRunTaskId: string
  lastRunId: string
  /** 上一条落定的大总管正文：汇总卡与之相同时不再重复整段（S12）。 */
  lastChatText: string
  /** 消息流条目（渲染主数据）。 */
  entries: ThreadEntry[]
  /** 子任务 id → 条目 key：流式增量原地更新。 */
  bubbleKeys: Map<string, string>
  /** 大总管流式那条的 key；落定的 `chat` 收走置 null。 */
  butlerSpeechKey: string | null
  taskId: string | null
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

function scheduleFlush(getState: () => TurnState): void {
  if (frameScheduled) return
  frameScheduled = true
  const run = () => {
    frameScheduled = false
    getState().flushFrame()
  }
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(run)
  else setTimeout(run, 16)
}

export const useTurnStore = create<TurnState>((set, get) => ({
  conversationId: null,
  streaming: false,
  abort: null,
  viewToken: 0,
  pendingUser: null,
  lastSeq: 0,
  lastRunTaskId: '',
  lastRunId: '',
  lastChatText: '',
  entries: [],
  bubbleKeys: new Map(),
  butlerSpeechKey: null,
  taskId: null,
  following: true,
  selecting: false,

  switchConversation: (id, opts = {}) => {
    // 原子动作：先断悬挂连接，再一次性置换视图状态——I09 守卫只有这一份。
    get().abort?.abort()
    set({
      viewToken: get().viewToken + 1,
      conversationId: id,
      entries: [],
      bubbleKeys: new Map(),
      butlerSpeechKey: null,
      pendingUser: null,
      lastSeq: 0,
      lastRunId: '',
      lastRunTaskId: '',
      lastChatText: '',
      taskId: null,
      streaming: false,
      abort: null,
      following: opts.keepFollowing === true ? get().following : true,
    })
  },

  beginRebuild: () => {
    set({
      viewToken: get().viewToken + 1,
      entries: [],
      bubbleKeys: new Map(),
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

  renderTaskRecord: (record, opts = {}) => {
    const liveResume = opts.liveResume === true
    const terminalRecord = ['completed', 'failed', 'cancelled', 'partial'].includes(record.state)
    const entries: ThreadEntry[] = []
    // 与旧 renderTaskRecord 同序：目标 → 拆解说明 → 调度卡（批 1 以降级成员行呈现）→ 终态卡。
    entries.push({ key: nextKey('user'), kind: 'user', text: record.goal, time: Number(record.createdAt) || undefined })
    entries.push({
      key: nextKey('butler'), kind: 'butler',
      text: record.note ? `我按这个思路拆的：${record.note}` : '我按下面的方式拆了任务。',
      thinking: '', streaming: false,
      time: Number(record.createdAt) || undefined,
    })
    for (const subtask of record.subtasks) {
      entries.push({
        key: nextKey('subtask'), kind: 'subtask', subtaskId: subtask.id, agentId: subtask.agentId,
        goal: subtask.goal, state: subtask.state,
        // 与实时同一入口的正文口径：服务端没给结论时回落状态词（旧 history.js 同语义）。
        body: subtask.state === 'failed' || subtask.state === 'cancelled'
          ? (subtask.error || '失败')
          : (subtask.result || STATE_TEXT[subtask.state] || ''),
        thinking: '', terminal: ['succeeded', 'failed', 'cancelled', 'external_pending'].includes(subtask.state),
        live: false, toolLine: null,
        artifacts: Array.isArray(subtask.artifacts) ? subtask.artifacts : [],
        startedAt: subtask.startedAt,
        detail: subtask.result, error: subtask.error,
      })
    }
    if (terminalRecord || !liveResume) {
      entries.push({ key: nextKey('summary'), kind: 'summary', state: record.state, text: record.summary ?? '', time: Number(record.updatedAt) || undefined })
    }
    set(state => ({ entries: [...state.entries, ...entries], taskId: record.id, bubbleKeys: new Map(state.bubbleKeys) }))
  },

  applyTurnEvent: event => {
    const state = get()
    // ── 游标推进（consumeTurnEvent 语义，口径只有这一份）─────────────────
    if (event.type === 'run') {
      state.lastSeq = 0
      state.lastRunId = event.runId ?? ''
      if (event.taskId !== undefined && event.taskId !== '') state.lastRunTaskId = event.taskId
    }
    if (event.seq !== undefined) state.lastSeq = event.seq
    if ((event.type === 'subtask' || event.type === 'plan') && event.taskId !== undefined) state.lastRunTaskId = event.taskId

    // ── 分发（handleEvent 语义；调度卡/请示卡批 3/4b 完整化，批 1 降级视图）──
    switch (event.type) {
      case 'conversation': {
        if (typeof event.conversationId === 'string' && event.conversationId !== '') {
          set({ conversationId: event.conversationId })
          rememberConversation(event.conversationId)
        }
        return
      }
      case 'user': {
        // 受理回放对得上预渲染的那条就不重复画（对不上：历史回放、其他入口，照常渲染）。
        // 与旧 events.js 同口径：user 到达即撤「只有思考」的预览并清思考快照。
        const speechKey = get().butlerSpeechKey
        if (speechKey !== null) {
          const speech = get().entries.find(entry => entry.key === speechKey)
          if (speech?.kind === 'butler' && speech.text === '') {
            frameBuffer.delete(speechKey)
            set(st => ({ entries: st.entries.filter(entry => entry.key !== speechKey), butlerSpeechKey: null }))
          }
        }
        const pending = get().pendingUser
        if (pending !== null && pending.text === event.text) {
          set({ pendingUser: null })
          return
        }
        get().appendEntry({ key: nextKey('user'), kind: 'user', text: event.text ?? '', time: event.time })
        return
      }
      case 'chat': {
        // 落定：收走流式那条；没有就新起一条（直接回答、接续回放）。
        // 帧缓冲里该条的残留 delta 一并作废——落定正文是权威，不被残帧覆盖。
        const speechKey = get().butlerSpeechKey
        const text = event.text ?? ''
        if (speechKey !== null) frameBuffer.delete(speechKey)
        if (speechKey !== null) {
          set(st => ({
            butlerSpeechKey: null,
            lastChatText: text,
            entries: st.entries.map(entry => entry.key === speechKey && entry.kind === 'butler'
              ? { ...entry, text, streaming: false, time: event.time ?? entry.time }
              : entry),
          }))
        } else {
          set(st => ({ lastChatText: text }))
          get().appendEntry({ key: nextKey('butler'), kind: 'butler', text, thinking: '', streaming: false, time: event.time })
        }
        return
      }
      case 'chat_delta': {
        const speechKey = get().butlerSpeechKey
        const key = speechKey ?? nextKey('butler')
        if (speechKey === null) {
          set(st => ({ butlerSpeechKey: key, entries: [...st.entries, { key, kind: 'butler', text: '', thinking: '', streaming: true, time: undefined }] }))
        }
        const buffer = frameBuffer.get(key) ?? {}
        buffer.butlerText = (buffer.butlerText ?? currentButlerText(get(), key)) + (event.text ?? '')
        frameBuffer.set(key, buffer)
        scheduleFlush(get)
        return
      }
      case 'chat_thinking': {
        // 思考常早于第一段正文（模型先推理后说话）：只推理还没吐字时也开气泡，
        // 让「在想」可见；这条可能是会被重试掉的尝试（chat_reset 时撤，thinkingOnly 语义）。
        const thinking = event.thinking ?? ''
        if (thinking === '') return
        const speechKey = get().butlerSpeechKey
        if (speechKey === null) {
          const key = nextKey('butler')
          set(st => ({ butlerSpeechKey: key, entries: [...st.entries, { key, kind: 'butler', text: '', thinking, streaming: true, time: undefined }] }))
          return
        }
        set(st => ({ entries: st.entries.map(entry => entry.key === speechKey && entry.kind === 'butler' ? { ...entry, thinking } : entry) }))
        return
      }
      case 'chat_reset': {
        // 模型重试（S08）：只有思考、还没吐字的那条预览撤掉，下一版从新气泡起头。
        const speechKey = get().butlerSpeechKey
        if (speechKey !== null) {
          const speech = get().entries.find(entry => entry.key === speechKey)
          if (speech?.kind === 'butler' && speech.text === '' && speech.thinking !== '') {
            get().removeEntry(speechKey)
            set({ butlerSpeechKey: null })
          }
        }
        return
      }
      case 'input': {
        if (event.taskId !== undefined) set({ taskId: event.taskId })
        get().appendEntry({
          key: nextKey('note'), kind: 'note',
          text: event.source === 'supplement' ? `补充已收到（第 ${String(event.version)} 版）：${event.text ?? ''}` : event.text ?? '',
        })
        return
      }
      case 'plan': {
        // 调度卡批 4b；批 1 降级：按计划为每个子任务开成员行（ queued 态），后续
        // subtask 事件原地更新——成员的真实输出不丢。
        set(st => ({ taskId: event.taskId ?? st.taskId, bubbleKeys: new Map(), entries: st.entries }))
        return
      }
      case 'subtask': {
        handleSubtaskEvent(get, event)
        return
      }
      case 'subtask_delta': {
        // 终态之后不再追加（S08）：迟到帧不把已校准的结论再改掉。
        const key = get().bubbleKeys.get(event.id ?? '')
        if (key === undefined) return
        const entry = get().entries.find(candidate => candidate.key === key)
        if (entry?.kind !== 'subtask' || entry.terminal || !entry.live) return
        const buffer: FramePatch = frameBuffer.get(key) ?? { subtaskId: event.id }
        buffer.subtaskBody = (buffer.subtaskBody ?? entry.body) + (event.delta ?? '')
        frameBuffer.set(key, buffer)
        scheduleFlush(get)
        return
      }
      case 'subtask_thinking': {
        const key = get().bubbleKeys.get(event.id ?? '')
        if (key === undefined) return
        set(st => ({ entries: st.entries.map(entry => entry.key === key && entry.kind === 'subtask' ? { ...entry, thinking: event.thinking ?? '' } : entry) }))
        return
      }
      case 'summary': {
        // 汇总是这一轮的定论：正文只展示一次（S12）——与最后一条 butler 正文相同时置空。
        const text = event.text ?? ''
        const dedup = text !== '' && text === get().lastChatText
        // 所有流式条目此刻收口：帧缓冲里的残留增量全部作废。
        frameBuffer.clear()
        get().appendEntry({ key: nextKey('summary'), kind: 'summary', state: event.state ?? '', text: dedup ? '' : text, time: event.time })
        set(st => ({
          entries: st.entries.map(entry => entry.kind === 'subtask' && !entry.terminal ? { ...entry, live: false } : entry),
          bubbleKeys: new Map(),
          butlerSpeechKey: null,
        }))
        return
      }
      case 'error': {
        get().appendEntry({ key: nextKey('error'), kind: 'error', text: event.message ?? '' })
        return
      }
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

function currentButlerText(state: TurnState, key: string): string {
  const entry = state.entries.find(candidate => candidate.key === key)
  return entry?.kind === 'butler' ? entry.text : ''
}

/** subtask 事件（旧 handleSubtask 的 store 面）：状态机 dispatched/running/终态。 */
function handleSubtaskEvent(get: () => TurnState, event: TurnEvent): void {
  const subtaskId = event.id ?? ''
  const keys = get().bubbleKeys
  let key = keys.get(subtaskId)
  if (key === undefined) {
    key = nextKey('subtask')
    const next = new Map(keys)
    next.set(subtaskId, key)
    useTurnStore.setState({ bubbleKeys: next })
    get().appendEntry({
      key, kind: 'subtask', subtaskId, agentId: event.agentId ?? '', goal: '',
      state: event.state ?? '', body: '', thinking: '', terminal: false, live: true,
      toolLine: null, artifacts: [], startedAt: event.startedAt, detail: null, error: null,
    })
  }

  const apply = (patch: (entry: SubtaskEntry) => SubtaskEntry) => {
    useTurnStore.setState(st => ({ entries: st.entries.map(entry => entry.key === key && entry.kind === 'subtask' ? patch(entry) : entry) }))
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
      toolLine: event.tool !== undefined || event.detail !== undefined
        ? { tool: event.tool, detail: event.detail ?? undefined }
        : entry.toolLine,
      startedAt: entry.startedAt ?? event.startedAt ?? null,
    }))
    return
  }
  // 终态/半终态：光标收起（live=false），正文以服务端那份为权威（S09——空串判断不是 ??）。
  if (event.state === 'waiting_user' || event.state === 'external_pending' || event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled') {
    const authoritative = typeof event.detail === 'string' ? event.detail.trim() : ''
    const finalText = authoritative !== '' ? event.detail ?? '' : undefined
    apply(entry => ({
      ...entry,
      state: event.state ?? entry.state,
      terminal: true,
      live: false,
      body: finalText !== undefined ? finalText : entry.body,
      detail: event.detail ?? entry.detail,
      error: event.error ?? entry.error,
      finishedAt: event.finishedAt ?? undefined,
      artifacts: Array.isArray(event.artifacts) ? event.artifacts : entry.artifacts,
      // 等你回话不是在计算：给回复入口（ask 卡）。卡面问题用 question，正文用 detail，
      // 混用会让「正文」变成一句提问（旧 handleSubtask 的告诫）。
      ask: event.state === 'waiting_user'
        ? { taskId: event.taskId ?? get().taskId ?? '', question: event.question as string | undefined, detail: event.detail ?? undefined }
        : undefined,
    }))
  }
}

/** 判断超长降级（渲染层用）：与旧前端同一阈值与语义。 */
export function isOverRichLimit(text: string): boolean {
  return text.length > STREAM_RICH_LIMIT
}
