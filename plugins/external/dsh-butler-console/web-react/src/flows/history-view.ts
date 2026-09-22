/**
 * 历史与视图路由域（评审 #10 拆分）：会话打开/任务详情/刷新接续/加载更早/
 * popstate 绑定/身份加载。
 */
import { api, eventsHead } from '../lib/api.ts'
import { recallConversation, newConversationId } from '../lib/turn-event.ts'
import { rememberConversation } from '../lib/turn-event.ts'
import { mergeHistoryEntries, mergeTaskDetails, planHistoryInsertion, EMPTY_HISTORY_CURSOR } from '../lib/history-merge.ts'
import type { HistoryEntry } from '../lib/history-merge.ts'
import type { TaskRecord } from '../lib/api.ts'
import { useSessionStore } from '../stores/session.ts'
import { useTurnStore } from '../stores/turn.ts'
import { refreshChatList } from './panels.ts'
import { createTurnEngineHost, finishTurn, reportFailure } from './turn-flow.ts'
import { followUntilTerminal, productionLinks } from '../lib/turn-engine.ts'
import { announce } from '../lib/announce.ts'
import { errorTextOf } from '../lib/error-text.ts'

let hostEntrySeq = 0

import type { ThreadEntry } from '../stores/turn.ts'
import { clearAttachments, loadAttachments } from '../stores/attachments.ts'

/** 把 turn store 装配成引擎的宿主（渲染副作用全部走 store 动作）。 */
/**
 * 刷新或重新打开页面时，接上正在跑的那一轮（语义对齐 send.js resumeLiveTurn）。
 *
 * 关掉页面不再等于取消任务，所以「活还在干，页面得能看」是这套语义的另一半。
 * 幂等：streaming 中直接返回；探测有网络往返，回包后复核视图代次（I09）。
 */
export async function resumeLiveTurn(): Promise<void> {
  const conversationId = recallConversation()
  if (conversationId === null || conversationId === '' || useTurnStore.getState().streaming) return

  const tokenAtProbe = useTurnStore.getState().viewToken
  let head
  try {
    head = await eventsHead(conversationId)
  } catch (error) {
    if (tokenAtProbe !== useTurnStore.getState().viewToken) return
    // 接续检查失败不能静默吞掉（S04）：用户会以为一切正常，其实连不上。
    useTurnStore.getState().appendEntry({
      key: `error-h${++hostEntrySeq}`, kind: 'error',
      text: `接续检查失败：${error instanceof Error ? error.message : '网络异常'}；刷新页面可重试`,
    })
    return
  }
  if (head === null || head.state !== 'running') {
    // 没有活轮：刷新不能把用户扔回空白新会话（0.13.6 用户反馈）——恢复上次会话的
    // 历史视图，确认卡/状态框随 openConversation 的任务详情一并回来。
    await openConversation(conversationId)
    return
  }
  if (tokenAtProbe !== useTurnStore.getState().viewToken || useTurnStore.getState().streaming) return

  const controller = new AbortController()
  // 接管视图：作废之前还在路上的历史读取回包，它们的结论属于旧视图。
  useTurnStore.setState({
    viewToken: useTurnStore.getState().viewToken + 1,
    conversationId,
    abort: controller,
    entries: [],
    bubbleKeys: new Map(),
    butlerSpeechKey: null,
    streaming: true,
    following: true,
    lastSeq: 0,
    lastRunId: head.runId,
    lastRunTaskId: head.taskId ?? '',
  })
  const host = await createTurnEngineHost()
  try {
    // 只读订阅接续：reset 时按快照校准并从窗口头续订，断线有界重订（S05/S06）。
    await followUntilTerminal(conversationId, { from: 0, expectedRunId: head.runId, signal: controller.signal }, productionLinks, host)
  } catch (error) {
    reportFailure(error, '接续正在执行的任务失败')
  } finally {
    void finishTurn()
  }
}

/** 历史条目 → 消息流条目（渲染模型转换；任务卡批 3 升级为完整调度卡回放）。 */
export function historyEntryToThreadEntry(entry: HistoryEntry): ThreadEntry {
  if (entry.kind === 'task' && entry.task !== undefined) {
    return { key: `task-${entry.task.id}`, kind: 'task', task: entry.task }
  }
  if (entry.kind === 'subtask' && entry.subtask !== undefined) {
    const { taskId, sub } = entry.subtask
    // subtaskId 必须是纯子任务 id：决策 /action 的入参用它，拼前缀会重演 taskId 404。
    // key 才承担跨任务去重（含任务 id 与时间锚点）。
    return {
      key: entry.id, kind: 'subtask', subtaskId: sub.id, taskId, agentId: sub.agentId, goal: sub.goal,
      state: sub.state,
      body: sub.state === 'failed' || sub.state === 'cancelled'
        ? (sub.error || '失败')
        : (sub.result || ''),
      thinking: '', terminal: true, live: false,
      toolLine: null, artifacts: Array.isArray(sub.artifacts) ? sub.artifacts : [],
      startedAt: sub.startedAt ?? null, finishedAt: sub.finishedAt ?? null,
      detail: sub.result ?? null, error: sub.error ?? null,
      pending: sub.pending,
      verdict: sub.verdict, verdictReason: sub.verdictReason,
      actions: Array.isArray(sub.actions) ? sub.actions : undefined,
      // 会话视图里恢复的等待是活的：回话入口重新给出（taskId 从详情投影带来）。
      ...(sub.state === 'waiting_user'
        ? { ask: { taskId, question: sub.result || '需要你补充点信息', detail: sub.result ?? undefined } }
        : {}),
    }
  }
  if (entry.kind === 'butler') {
    return {
      key: entry.id, kind: 'butler', text: entry.text, thinking: '', streaming: false,
      time: Number(entry.time) || undefined, interrupted: entry.interrupted,
    }
  }
  return { key: entry.id, kind: 'user', text: entry.text, time: Number(entry.time) || undefined }
}

/** 历史翻页游标（首屏 + 「加载更早」，entriesCache 供翻页合并的全局序列）。 */
export interface HistoryCursor {
  transcriptBefore: string | null
  taskOffset: number | null
  loading: boolean
  error: string | null
  entriesCache: HistoryEntry[]
}


/**
 * 打开一个历史会话（语义对齐 history.js openConversation 的守卫与 I09 核对）。
 *
 * 执行中禁止切换（旧语义）；切换本身是 store 的原子动作；两路回包都核对视图代次，
 * 旧回包不写进新会话。对话正文读不到时如实说明，不拿任务摘要冒充完整对话。
 */
export async function openConversation(id: string): Promise<void> {
  const turn = useTurnStore.getState()
  if (turn.streaming) return
  turn.switchConversation(id)
  rememberConversation(id)
  // 会话视图是「底」：进入时替换当前状态（不是压栈）。有了这个标记，任务详情返回键
  // 的 popstate 才能命中 conversation 分支恢复会话（批 4b 复验指出的断链修复）。
  try { history.replaceState({ butler: 'conversation', conversationId: id }, '', location.href) } catch { /* 不支持即静默降级。 */ }
  // 附件跟着会话走：先立刻清空（别让上一个会话的待发文件挂在新会话上），再取回这一轮的。
  clearAttachments()
  void loadAttachments(id)
  const token = useTurnStore.getState().viewToken

  useSessionStore.getState().setHistoryCursor({ transcriptBefore: null, taskOffset: null, loading: false, error: null, entriesCache: [] })
  const placeholderKey = `note-h${++hostEntrySeq}`
  useTurnStore.getState().appendEntry({ key: placeholderKey, kind: 'note', text: '正在读取记录…' })

  let transcript: Awaited<ReturnType<typeof api.transcript>> | null = null
  let taskPage: Awaited<ReturnType<typeof api.history>> | null = null
  let transcriptError: unknown = null
  let taskError: unknown = null
  ;[transcript, taskPage] = await Promise.all([
    api.transcript({ conversationId: id, tail: true }).catch(error => { transcriptError = error; return null }),
    api.history({ conversationId: id, offset: 0 }).catch(error => { taskError = error; return null }),
  ])
  if (token !== useTurnStore.getState().viewToken) return

  const entries: ThreadEntry[] = []
  const removePlaceholder = useTurnStore.getState().entries.some(entry => entry.key === placeholderKey)
  if (removePlaceholder) useTurnStore.getState().removeEntry(placeholderKey)

  if (transcriptError !== null) {
    entries.push({
      key: `error-h${++hostEntrySeq}`, kind: 'error',
      text: `对话正文读不到：${transcriptError instanceof Error && transcriptError.message !== '' ? transcriptError.message : '网络异常'}；下面只有任务摘要。`,
    })
  }
  if (taskError !== null) {
    entries.push({
      key: `error-h${++hostEntrySeq}`, kind: 'error',
      text: `任务记录读不到：${taskError instanceof Error && taskError.message !== '' ? taskError.message : '网络异常'}`,
    })
  }
  const merged = mergeHistoryEntries(transcript?.items ?? null, taskPage?.items ?? null)
  if (merged.length === 0 && transcriptError === null && taskError === null) {
    // 空会话：欢迎板由 Thread 按 entries 为空渲染，这里无需占位。
    useSessionStore.getState().setHistoryCursor({ transcriptBefore: null, taskOffset: null, loading: false, error: null, entriesCache: [] })
    return
  }
  // 刷新/切会话后确认卡要能重画（0.13.6）：对本会话的任务拉详情（子任务终态+确认操作
  // 投影），按各自时间锚点插回消息流——第 3 条记录后面返回的确认框，恢复后还在那里。
  // 详情读不到的单个任务跳过（摘要卡仍在），不阻塞会话打开。
  const records = await loadTaskDetails(taskPage?.items ?? [])
  if (token !== useTurnStore.getState().viewToken) return
  const withSubs = mergeTaskDetails(merged, records)
  // 恢复最近一个非终态任务的 id：补充入口（Composer「补充」开关）依赖它——
  // lastRunTaskId 平时由实时事件设置，刷新后只剩这条路径能恢复。
  const liveTask = [...records].reverse().find(record => !['completed', 'failed', 'cancelled'].includes(record.state))
  if (liveTask !== undefined) useTurnStore.setState({ lastRunTaskId: liveTask.id })
  for (const item of withSubs) entries.push(historyEntryToThreadEntry(item))
  const store = useTurnStore.getState()
  for (const entry of entries) store.appendEntry(entry)
  useSessionStore.getState().setHistoryCursor({
    transcriptBefore: transcript?.prevBefore ?? null,
    taskOffset: taskPage?.nextOffset ?? null,
    loading: false,
    error: null,
    entriesCache: withSubs,
  })
}

/** 详情防御上限：会话里任务再多也只恢复最近这些（摘要卡不受影响，翻页可及）。 */
const TASK_DETAIL_LIMIT = 8

/** 拉一页任务摘要对应的详情（并行，单个失败静默跳过）。 */
async function loadTaskDetails(items: ReadonlyArray<{ id: string }>): Promise<TaskRecord[]> {
  const picked = items.slice(-TASK_DETAIL_LIMIT)
  const records = await Promise.all(picked.map(item => api.task<TaskRecord>(item.id).catch(() => null)))
  return records.filter((record): record is TaskRecord => record !== null)
}

/** 发送失败的用户可见呈现（旧 dom.js reportFailure 语义：中断≠任务停了）。 */


/**
 * 任务详情视图（旧 openTask）：点失败记录/任务摘要卡进来，view-head 返回。
 * 守卫与 openConversation 同款（I08：执行中禁止切换；视图代次核对）。
 * History API 压栈：浏览器返回键与「← 返回会话」走同一条路径。
 */
export async function openTask(id: string): Promise<void> {
  if (useTurnStore.getState().streaming) return
  const token = useTurnStore.getState().viewToken + 1
  useTurnStore.setState({ viewToken: token })
  let record: import('../lib/api.ts').TaskRecord
  try {
    record = await api.task(id)
  } catch (error) {
    if (token !== useTurnStore.getState().viewToken) return
    useTurnStore.getState().appendEntry({ key: `error-task-${id}`, kind: 'error', text: error instanceof Error ? error.message : '打不开这条记录' })
    return
  }
  if (token !== useTurnStore.getState().viewToken) return
  useTurnStore.setState({ conversationId: record.conversationId })
  rememberConversation(record.conversationId)
  try { history.pushState({ butler: 'task', taskId: record.id, conversationId: record.conversationId }, '', location.href) } catch { /* 不支持即静默降级。 */ }
  useTurnStore.getState().beginRebuild()
  // 视图头（返回入口 + 面包屑）由 Thread 按 taskView 状态渲染。
  useTurnStore.setState({ taskView: { taskId: record.id } })
  useTurnStore.getState().renderTaskRecord(record)
  useTurnStore.setState({ following: true })
}

/** 浏览器返回键：按栈里的视图状态回层（只认自己压入的标记）。 */
export function bindViewHistory(): void {
  window.addEventListener('popstate', event => {
    const value = event.state
    if (value === null || typeof value !== 'object') return
    if (value.butler === 'task' && typeof value.taskId === 'string') { void openTask(value.taskId); return }
    if (value.butler === 'conversation' && typeof value.conversationId === 'string') { void openConversation(value.conversationId) }
  })
}

/** 加载一页更早的记录（I10/复核 1/复核 3）：定位插入、归属核对、失败保留重试。 */
export async function loadEarlier(): Promise<void> {
  const cursor = useSessionStore.getState().historyCursor
  const id = useTurnStore.getState().conversationId
  if (cursor.loading || id === null) return
  if (cursor.transcriptBefore === null && cursor.taskOffset === null) {
    useSessionStore.getState().setEarlier({ phase: 'done' })
    return
  }
  const token = useTurnStore.getState().viewToken
  useSessionStore.getState().setHistoryCursor({ ...cursor, loading: true, error: null })
  useSessionStore.getState().setEarlier({ phase: 'loading' })
  const stillOwns = () => token === useTurnStore.getState().viewToken && id === useTurnStore.getState().conversationId
  let failure: unknown = null
  try {
    const [page, tasks] = await Promise.all([
      cursor.transcriptBefore === null
        ? Promise.resolve(null)
        : api.transcript({ conversationId: id, before: cursor.transcriptBefore }),
      cursor.taskOffset === null
        ? Promise.resolve(null)
        : api.history({ conversationId: id, offset: cursor.taskOffset }),
    ])
    if (!stillOwns()) return
    // 全局序列重排（React 版：entries 直接按 merged 重排，插入计划由渲染顺序表达）。
    const existing: HistoryEntry[] = useSessionStore.getState().historyCursor.entriesCache
    const plan = planHistoryInsertion(existing, mergeHistoryEntries(page?.items ?? null, tasks?.items ?? null))
    const additions = plan.insertions.map(({ entry }) => historyEntryToThreadEntry(entry))
    useTurnStore.getState().prependEntries(additions)
    useSessionStore.getState().setHistoryCursor({
      transcriptBefore: page?.prevBefore ?? cursor.transcriptBefore,
      taskOffset: tasks?.nextOffset ?? cursor.taskOffset,
      loading: false,
      error: null,
      entriesCache: plan.merged,
    })
    const fresh = useSessionStore.getState().historyCursor
    const done = plan.merged.length > 0 && fresh.transcriptBefore === null && fresh.taskOffset === null
    useSessionStore.getState().setEarlier(done ? { phase: 'done' } : { phase: 'idle' })
    return
  } catch (error) {
    if (stillOwns()) failure = error
  }
  if (stillOwns()) {
    const message = failure instanceof Error ? failure.message : '网络异常'
    const fresh = useSessionStore.getState().historyCursor
    useSessionStore.getState().setHistoryCursor({ ...fresh, loading: false, error: message })
    useSessionStore.getState().setEarlier({ phase: 'error', message })
  }
}

export async function loadIdentity(): Promise<void> {
  try {
    const identity = await api.identity()
    useSessionStore.getState().setIdentity(identity.label)
    // 任务记录分页大小是部署配置（identity 下发），页面只跟着它走。
    if (typeof identity.chatPageSize === 'number' && identity.chatPageSize > 0) {
      useSessionStore.getState().setChatPageMeta({ chatPageSize: identity.chatPageSize })
    }
  } catch {
    useSessionStore.getState().setIdentity('')
  }
}

export { newConversationId }
