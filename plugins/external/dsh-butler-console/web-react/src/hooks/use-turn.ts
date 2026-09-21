/**
 * 回合驱动的应用层：把 turn-engine（纯控制流）与 turn store（状态面）绑定起来。
 *
 * 订阅幂等（StrictMode，方案 §3.3 批 0 决策的落地）：resumeLiveTurn 由 bootstrap effect
 * 调用，effect 双调用时第二次被 streaming 守卫与 viewToken 复核挡住；订阅本身挂 abort
 * controller，store.switchConversation 的原子动作负责完整 cleanup，after=lastSeq 保证
 * 重订不重复消费。
 */
import { api, eventsHead, ApiError, chat, reply } from '../lib/api.ts'
import { followUntilTerminal, productionLinks, type TurnEngineHost } from '../lib/turn-engine.ts'
import { newConversationId, recallConversation, rememberConversation } from '../lib/turn-event.ts'
import { mergeHistoryEntries, planHistoryInsertion } from '../lib/history-merge.ts'
import type { HistoryEntry } from '../lib/history-merge.ts'
import { useTurnStore, type ThreadEntry } from '../stores/turn.ts'
import { useSessionStore } from '../stores/session.ts'
import { announce } from '../lib/announce.ts'
import { attachmentsForSend, clearAttachments, loadAttachments, takeSentAttachments, useAttachmentsStore } from '../stores/attachments.ts'

let hostEntrySeq = 0

/** 把 turn store 装配成引擎的宿主（渲染副作用全部走 store 动作）。 */
function createHost(): TurnEngineHost {
  let terminalSeen = false
  return {
    apply: event => {
      if (event.type === 'summary') terminalSeen = true
      useTurnStore.getState().applyTurnEvent(event)
    },
    note: text => useTurnStore.getState().appendEntry({ key: `note-h${++hostEntrySeq}`, kind: 'note', text }),
    errorLine: text => useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text }),
    runTaskId: () => useTurnStore.getState().lastRunTaskId,
    setRunTaskId: taskId => { useTurnStore.setState({ lastRunTaskId: taskId }) },
    sawTerminal: () => terminalSeen,
    markTerminal: () => { terminalSeen = true },
    calibrate: record => {
      // 快照校准：只在没消费到 summary 时补一张终态卡（引擎已保证 terminal 语义）。
      if (terminalSeen) return
      useTurnStore.getState().appendEntry({
        key: `summary-h${++hostEntrySeq}`, kind: 'summary',
        state: record.state, text: record.summary ?? '',
      })
    },
    rebuild: record => {
      // 按快照重建（S05）：清空视图原子动作 + 重画任务记录 + 接续回跟随态。
      useTurnStore.getState().beginRebuild()
      useTurnStore.getState().renderTaskRecord(record, { liveResume: true })
      useTurnStore.setState({ streaming: true })
    },
  }
}

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
  if (head === null || head.state !== 'running') return
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
  const host = createHost()
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

let historyCursor: HistoryCursor = { transcriptBefore: null, taskOffset: null, loading: false, error: null, entriesCache: [] }
export const historyCursorOf = (): HistoryCursor => historyCursor

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
  // 附件跟着会话走：先立刻清空（别让上一个会话的待发文件挂在新会话上），再取回这一轮的。
  clearAttachments()
  void loadAttachments(id)
  const token = useTurnStore.getState().viewToken

  historyCursor = { transcriptBefore: null, taskOffset: null, loading: false, error: null, entriesCache: [] }
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
    historyCursor = { transcriptBefore: null, taskOffset: null, loading: false, error: null, entriesCache: [] }
    return
  }
  for (const item of merged) entries.push(historyEntryToThreadEntry(item))
  const store = useTurnStore.getState()
  for (const entry of entries) store.appendEntry(entry)
  historyCursor = {
    transcriptBefore: transcript?.prevBefore ?? null,
    taskOffset: taskPage?.nextOffset ?? null,
    loading: false,
    error: null,
    entriesCache: merged,
  }
}

/** 发送失败的用户可见呈现（旧 dom.js reportFailure 语义：中断≠任务停了）。 */
export function reportFailure(error: unknown, fallback: string): void {
  if ((error as Error)?.name === 'AbortError') {
    useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: '连接已中断，这一轮是否结束以右栏状态为准。' })
    return
  }
  useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: error instanceof Error && error.message !== '' ? error.message : fallback })
}

/** 回合收尾：忙碌态落回 + 右栏低频数据刷新（I05 焦点归还随 composer 批 3/4a 落地）。 */
export async function finishTurn(): Promise<void> {
  useTurnStore.setState({ streaming: false, abort: null })
  useSessionStore.getState().setTopStatus('')
  await refreshPanelsData()
}

/** 右栏数据装配（批 2：401 时给「去登录」入口，其余错误置顶栏「读取失败」）。 */
export async function refreshPanelsData(): Promise<void> {
  try {
    const [members, overview] = await Promise.all([api.members(), api.overview()])
    const session = useSessionStore.getState()
    session.setMembers(members.items)
    session.setOverview(overview)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const session = useSessionStore.getState()
      session.setIdentity('')
      session.setTopStatus('没登录')
      return
    }
    useSessionStore.getState().setTopStatus('读取失败')
  }
}

/**
 * 左栏列表聚合（0.12.4/0.12.5：浏览=按页取；搜索=拉全量再本地过滤——只筛当页会漏掉
 * 后面页的记录；删后空页自动回退）。
 */
export async function refreshChatList(): Promise<void> {
  try {
    const session = useSessionStore.getState()
    const searching = session.chatKeyword !== ''
    const offset = searching ? 0 : session.chatPage * session.chatPageSize
    const [conversations, history] = await Promise.all([
      searching ? api.conversations(0, 200) : api.conversations(offset),
      api.history(),
    ])
    if (conversations.items.length === 0 && session.chatPage > 0 && !searching) {
      session.setChatPageMeta({ chatPage: session.chatPage - 1 })
      return await refreshChatList()
    }
    session.setChatPageMeta({ chatTotal: conversations.total ?? conversations.items.length })
    const byConversation = new Map<string, string>()
    for (const task of history.items) {
      if (!byConversation.has(task.conversationId)) byConversation.set(task.conversationId, task.goal)
    }
    session.setChatList(conversations.items.map(item => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      preview: byConversation.get(item.id) ?? '',
    })))
  } catch (error) {
    // 把服务端给的原因一并显示：只说「读取记录失败」，排查时等于什么都没有。
    const reason = error instanceof Error ? error.message : ''
    useSessionStore.getState().setChatList([])
    announce(reason === '' ? '读取记录失败' : `读取记录失败：${reason}`)
  }
}

/** 翻页（0.12.4）：切页清选中（跨页选中容易误删）。 */
export async function gotoChatPage(page: number): Promise<void> {
  const session = useSessionStore.getState()
  const pages = Math.max(1, Math.ceil(session.chatTotal / session.chatPageSize))
  const next = Math.min(Math.max(0, page), pages - 1)
  if (next === session.chatPage) return
  session.setChatPageMeta({ chatPage: next })
  session.clearPicked()
  await refreshChatList()
}

/** 行内改名提交（0.12.4）：空值视为取消；成功后刷新列表（服务端返回新标题）。 */
export async function renameConversation(id: string, title: string): Promise<void> {
  const trimmed = title.trim()
  if (trimmed === '') { await refreshChatList(); return }
  try {
    await api.renameConversation(id, trimmed)
    announce('已改名')
  } catch (error) {
    announce(error instanceof ApiError ? error.message : '改名失败，稍后再试')
  }
  useSessionStore.getState().clearPicked()
  await refreshChatList()
}

/** 失败记录的「删除所选」（0.12.7）：逐条删、按成功数播报、刷新右栏。 */
export async function removePickedFailures(): Promise<void> {
  const ids = useSessionStore.getState().failurePicked
  if (ids.length === 0) return
  let removed = 0
  for (const id of ids) {
    try {
      await api.removeTask(id)
      removed += 1
    } catch (error) {
      announce(error instanceof ApiError ? error.message : '删除失败，稍后再试')
    }
  }
  useSessionStore.getState().clearFailurePicked()
  if (removed > 0) announce(`已删除 ${removed} 条失败记录`)
  await refreshPanelsData()
}

/**
 * 批量/单条删除共用（旧 removeConversationsWithFeedback 语义）：调围栏接口、按结果
 * 播报；当前会话被删时回新会话，别让中栏挂在已删除的对话上。
 */
export async function removeConversationsWithFeedback(ids: string[]): Promise<Array<{ id: string; status: string; message?: string }> | null> {
  let results
  try {
    results = (await api.removeConversations(ids)).results
  } catch (error) {
    announce(error instanceof ApiError ? error.message : '删除失败，稍后再试')
    return null
  }
  const removed = results.filter(result => result.status === 'removed')
  const blocked = results.filter(result => result.status === 'blocked')
  if (removed.length > 0) announce(`已删除 ${removed.length} 条任务记录`)
  if (blocked.length > 0) announce(blocked.length === 1 ? '有 1 条正在执行，先停止再删' : `有 ${blocked.length} 条正在执行，先停止再删`)
  if (removed.some(result => result.id === useTurnStore.getState().conversationId)) {
    useSessionStore.getState().clearPicked()
    await openNewChat()
    return results
  }
  useSessionStore.getState().clearPicked()
  await refreshChatList()
  return results
}

/** 管理模式的「删除所选」（确认态在按钮上，两段式）。 */
export async function deletePickedConversations(): Promise<void> {
  const ids = useSessionStore.getState().chatPicked
  if (ids.length === 0) return
  await removeConversationsWithFeedback(ids)
}

/** 新建会话（旧 openNewChat 语义）：执行中禁止；原子切换到 null 会话并刷新列表。 */
export async function openNewChat(): Promise<void> {
  if (useTurnStore.getState().streaming) return
  useTurnStore.getState().switchConversation(null)
  // 新会话没有待发附件：上一个会话攒下的那些跟着上一个会话走。
  clearAttachments()
  await refreshChatList()
}

/* ── 基础发送链路（批 3：直发+停止+失败重试，无 @提及/附件）──────────────── */

/** 发送失败时把草稿交回输入框的出口（composer 组件注册，避免 hook 反向依赖 UI）。 */
let draftRestore: ((text: string) => void) | null = null
export function registerDraftRestore(restore: (text: string) => void): void {
  draftRestore = restore
}

/** 重试入口渲染（error-line + 重试按钮），由 Thread 按 entry 渲染。 */
export interface RetryEntry {
  key: string
  text: string
  requestText: string
  requestId: string
}

export async function sendMessage(text: string, reuseRequestId?: string): Promise<void> {
  const trimmed = text.trim()
  const before = useTurnStore.getState()
  if (trimmed === '' || before.streaming) return
  const fresh = before.conversationId === null
  if (fresh) {
    useTurnStore.setState({ conversationId: newConversationId() })
    rememberConversation(useTurnStore.getState().conversationId ?? '')
  }
  // 同一会话的新回合追加在原线程后；第一次发送（或欢迎页）才换新视图（I01）。
  const state = useTurnStore.getState()
  if (fresh || state.entries.length === 0) {
    // switchConversation 会重置会话 id——这里只重置视图面（beginRebuild 语义+保 id）。
    useTurnStore.setState({
      viewToken: state.viewToken + 1,
      entries: [],
      bubbleKeys: new Map(),
      butlerSpeechKey: null,
      lastSeq: 0,
      lastRunId: '',
      lastRunTaskId: '',
      lastChatText: '',
      taskId: null,
      following: true,
    })
  }
  // 无论换不换视图，提交就回到跟随；回合级状态每轮换新（runId 不清会接错轮，B 轮教训）。
  useTurnStore.setState({
    streaming: true,
    abort: new AbortController(),
    lastSeq: 0,
    lastRunId: '',
    lastRunTaskId: '',
    following: true,
    pendingUser: { text: trimmed },
  })
  // 提交幂等身份（S07）：重试复用，新提交换新 ID。
  const requestId = reuseRequestId ?? newConversationId()
  const abortSignal = useTurnStore.getState().abort?.signal
  // 这一轮带的附件。**空数组也照发**：老客户端不带这个字段，服务端按「没有附件」处理。
  const attachmentIds = attachmentsForSend()
  // 受理与否是服务端事实：先就地呈现这句话与「正在发送…」（S03），正文不本地编。
  const userKey = `user-send-${requestId}`
  const noteKey = `note-send-${requestId}`
  // 附件随用户消息一起出现：发完就从输入框挪到消息里，不留重复的一份。
  const sentEntries = attachmentIds.length === 0 ? [] : takeSentAttachments(attachmentIds)
  useTurnStore.getState().appendEntry({
    key: userKey, kind: 'user', text: trimmed, time: Date.now(),
    ...(sentEntries.length > 0 ? { attachments: sentEntries } : {}),
  })
  useTurnStore.getState().appendEntry({ key: noteKey, kind: 'note', text: '正在发送…' })
  if (sentEntries.length > 0) {
    useAttachmentsStore.getState().setUrlInputVisible(false)
  }
  let sawTerminal = false
  try {
    for await (const event of chat({ conversationId: useTurnStore.getState().conversationId ?? '', message: trimmed, requestId, signal: abortSignal })) {
      if (event.type === 'summary') sawTerminal = true
      useTurnStore.getState().applyTurnEvent(event)
      // 占位 note 的撤除口径与旧 consumeTurnEvent 一致：受理（conversation）推进文案，
      // 正文/计划/异常到达才撤；run/reset/user 是流元事件不撤。
      if (event.type === 'conversation') {
        useTurnStore.setState(st => ({ entries: st.entries.map(entry => entry.key === noteKey ? { ...entry, text: '正在理解目标…' } : entry) }))
        announce('已受理，正在安排')
      } else if (event.type !== 'user' && event.type !== 'run' && event.type !== 'reset') {
        useTurnStore.getState().removeEntry(noteKey)
      }
    }
    useTurnStore.setState({ pendingUser: null })
    useTurnStore.getState().removeEntry(noteKey)
    // 连接自然结束但终态没来（S06）：断连窗口里可能已收尾或仍在跑，跟到终态为止。
    if (!sawTerminal && useTurnStore.getState().abort?.signal.aborted !== true) {
      const s = useTurnStore.getState()
      await followUntilTerminal(s.conversationId ?? '', { from: s.lastSeq, expectedRunId: s.lastRunId, signal: s.abort?.signal }, productionLinks, await makeEngineHost())
    }
  } catch (error) {
    useTurnStore.getState().removeEntry(noteKey)
    const pending = useTurnStore.getState().pendingUser
    if (pending !== null) {
      // 还没受理就失败：草稿回输入框（用户后来打过字就不覆盖），附件退回输入框上方；
      // 重试入口复用同一幂等身份，不会把活再派一遍。
      useTurnStore.setState({ pendingUser: null })
      draftRestore?.(trimmed)
      if (sentEntries.length > 0) {
        useAttachmentsStore.getState().add(sentEntries.map(entry => ({
          key: entry.key, name: entry.name, size: entry.size,
          phase: 'ready' as const, message: '', item: null,
        })))
      }
      useTurnStore.getState().appendEntry({
        key: `error-${requestId}`, kind: 'error',
        text: `${error instanceof Error && error.message !== '' ? error.message : '没送出去'}`,
        retryFor: { requestText: trimmed, requestId },
      })
    } else {
      // 已受理后连接断掉：这一轮还在服务端跑，重订事件流跟到终态，不自动重发。
      reportFailure(error, '发送失败')
      const s = useTurnStore.getState()
      await followUntilTerminal(s.conversationId ?? '', { from: s.lastSeq, expectedRunId: s.lastRunId, signal: s.abort?.signal }, productionLinks, await makeEngineHost())
    }
  } finally {
    void finishTurn()
  }
}

/** 喊停（I04/I08）：停止对象绑定当前会话；先发请求、继续观察终态，不本地断流冒充已停。 */
export async function stopTurn(): Promise<void> {
  const conversationId = useTurnStore.getState().conversationId
  if (conversationId === null) return
  useSessionStore.getState().setTopStatus('正在请求停止')
  try {
    const outcome = await api.stop(conversationId, AbortSignal.timeout(10000))
    if (outcome.accepted) {
      // 服务端已接受中止：终态由随后的 summary 事件落定，这里不再多说。
      return
    }
    useSessionStore.getState().setTopStatus('已上线')
    useTurnStore.getState().appendEntry({ key: `note-stop-${Date.now()}`, kind: 'note', text: `没有停止：${outcome.reason || '这一轮已经不在执行'}` })
  } catch {
    useSessionStore.getState().setTopStatus('停止请求失败')
    useTurnStore.getState().appendEntry({ key: `error-stop-${Date.now()}`, kind: 'error', text: '停止请求没送到，可以再试一次；取消不能回滚已经发生的操作。' })
    announce('停止请求没送到，可以再试一次')
  }
}

/** 回应等待中的成员（runReply 语义：受理确认才收卡，失败卡内恢复，输入不丢）。 */
export async function runReply(input: { taskId: string; subtaskId: string; text: string; decideByAgent: boolean }, hooks: {
  onAccepted?: () => void
  onRejected?: (error: unknown) => void
}): Promise<void> {
  if (useTurnStore.getState().streaming) return
  useTurnStore.setState({
    streaming: true,
    abort: new AbortController(),
    lastSeq: 0,
    lastRunId: '',
    following: true,
  })
  let accepted = false
  let sawTerminal = false
  const host = await makeEngineHost()
  try {
    for await (const event of reply({ ...input, requestId: newConversationId(), signal: useTurnStore.getState().abort?.signal })) {
      if (event.type === 'summary') sawTerminal = true
      if (!accepted) {
        accepted = true
        hooks.onAccepted?.()
      }
      useTurnStore.getState().applyTurnEvent(event)
    }
    const s = useTurnStore.getState()
    if (!sawTerminal && accepted && s.abort?.signal.aborted !== true && s.conversationId !== null) {
      await followUntilTerminal(s.conversationId, { from: s.lastSeq, expectedRunId: s.lastRunId, signal: s.abort?.signal }, productionLinks, host)
    }
  } catch (error) {
    reportFailure(error, '回复没送出去')
    if (!accepted) hooks.onRejected?.(error)
  } finally {
    void finishTurn()
  }
}

/** 引擎宿主（发送/回话/接续共用；apply 走 store，markTerminal 由 apply 顺带维护）。 */
async function makeEngineHost(): Promise<TurnEngineHost> {
  let terminalSeen = false
  return {
    apply: event => {
      if (event.type === 'summary') terminalSeen = true
      useTurnStore.getState().applyTurnEvent(event)
    },
    note: text => useTurnStore.getState().appendEntry({ key: `note-h${++hostEntrySeq}`, kind: 'note', text }),
    errorLine: text => useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text }),
    runTaskId: () => useTurnStore.getState().lastRunTaskId,
    setRunTaskId: taskId => { useTurnStore.setState({ lastRunTaskId: taskId }) },
    sawTerminal: () => terminalSeen,
    markTerminal: () => { terminalSeen = true },
    calibrate: record => {
      if (terminalSeen) return
      useTurnStore.getState().appendEntry({
        key: `summary-h${++hostEntrySeq}`, kind: 'summary',
        state: record.state, text: record.summary ?? '',
      })
    },
    rebuild: record => {
      useTurnStore.getState().beginRebuild()
      useTurnStore.getState().renderTaskRecord(record, { liveResume: true })
      useTurnStore.setState({ streaming: true })
    },
  }
}

/** 加载一页更早的记录（I10/复核 1/复核 3）：定位插入、归属核对、失败保留重试。 */
export async function loadEarlier(): Promise<void> {
  const cursor = historyCursorOf()
  const id = useTurnStore.getState().conversationId
  if (cursor.loading || id === null) return
  if (cursor.transcriptBefore === null && cursor.taskOffset === null) {
    useSessionStore.getState().setEarlier({ phase: 'done' })
    return
  }
  const token = useTurnStore.getState().viewToken
  historyCursor = { ...cursor, loading: true, error: null }
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
    const existing: HistoryEntry[] = historyCursor.entriesCache
    const plan = planHistoryInsertion(existing, mergeHistoryEntries(page?.items ?? null, tasks?.items ?? null))
    const additions = plan.insertions.map(({ entry }) => historyEntryToThreadEntry(entry))
    useTurnStore.getState().prependEntries(additions)
    historyCursor = {
      transcriptBefore: page?.prevBefore ?? cursor.transcriptBefore,
      taskOffset: tasks?.nextOffset ?? cursor.taskOffset,
      loading: false,
      error: null,
      entriesCache: plan.merged,
    }
    const done = plan.merged.length > 0 && historyCursor.transcriptBefore === null && historyCursor.taskOffset === null
    useSessionStore.getState().setEarlier(done ? { phase: 'done' } : { phase: 'idle' })
    return
  } catch (error) {
    if (stillOwns()) failure = error
  }
  if (stillOwns()) {
    const message = failure instanceof Error ? failure.message : '网络异常'
    historyCursor = { ...historyCursorOf(), loading: false, error: message }
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
