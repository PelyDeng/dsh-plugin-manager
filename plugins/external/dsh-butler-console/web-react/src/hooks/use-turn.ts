import { errorTextOf } from '../lib/error-text.ts'
import type { TurnEvent } from '../lib/turn-event.ts'
/**
 * 回合驱动的应用层：把 turn-engine（纯控制流）与 turn store（状态面）绑定起来。
 *
 * ── 错误呈现四通道对照表（评审 #17，新错误先查这张表再选通道）──────────
 * │ 通道            │ 视觉可见 │ 何时用                                     │ 例
 * │ 流内 error 行   │ 是(持久) │ 回合内业务失败/连接中断，属于对话叙事        │ sendMessage catch
 * │ 卡内 note       │ 是(随卡) │ 只属于这张卡的局部失败（决策/回话没送出）    │ ActionDeck.runDecision
 * │ 顶栏 topStatus  │ 是(全局) │ 全局数据源故障（左右栏读不到/未登录）        │ refreshPanelsData
 * │ announce        │ 否(读屏) │ 补充无障碍播报，或视觉无害的状态变化         │ 已补充给当前任务
 * 原则：能就地（卡内）不全局（顶栏）；announce 永不作为视觉用户的唯一告知。
 *
 * 订阅幂等（StrictMode，方案 §3.3 批 0 决策的落地）：resumeLiveTurn 由 bootstrap effect
 * 调用，effect 双调用时第二次被 streaming 守卫与 viewToken 复核挡住；订阅本身挂 abort
 * controller，store.switchConversation 的原子动作负责完整 cleanup，after=lastSeq 保证
 * 重订不重复消费。
 */
import { api, eventsHead, ApiError, chat, reply, act, supplement } from '../lib/api.ts'
import type { TaskRecord } from '../lib/api.ts'
export { act }
import { followUntilTerminal, productionLinks, type TurnEngineHost } from '../lib/turn-engine.ts'
import { newConversationId, recallConversation, rememberConversation } from '../lib/turn-event.ts'
import { mergeHistoryEntries, mergeTaskDetails, planHistoryInsertion } from '../lib/history-merge.ts'
import type { HistoryEntry } from '../lib/history-merge.ts'
import { useTurnStore, type ThreadEntry } from '../stores/turn.ts'
import { useSessionStore } from '../stores/session.ts'
import { announce } from '../lib/announce.ts'
import { attachmentsForSend, clearAttachments, loadAttachments, takeSentAttachments, useAttachmentsStore } from '../stores/attachments.ts'

let hostEntrySeq = 0

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
export function reportFailure(error: unknown, fallback: string): void {
  if ((error as Error)?.name === 'AbortError') {
    useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: '连接已中断，这一轮是否结束以右栏状态为准。' })
    return
  }
  useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: errorTextOf(error, fallback) })
}

/** 回合收尾：忙碌态落回 + 右栏低频数据刷新（I05 焦点归还随 composer 批 3/4a 落地）。 */
export async function finishTurn(): Promise<void> {
  useTurnStore.setState({ streaming: false, abort: null })
  useSessionStore.getState().setTopStatus('')
  await refreshPanelsData()
  void refreshChatList()
}

/** 右栏数据装配（批 2：401 时给「去登录」入口，其余错误置顶栏「读取失败」）。 */
/**
 * 左右栏运维数据刷新（成员档案+运行状态）。
 *
 * `silent`（评审 #3）：AppShell 轮询走静默——失败不置顶栏（避免一次网络抖动把错误
 * 钉在顶栏直到无关动作），成功时顺手清掉已有的错误标记（自愈）；显式调用（进入页面、
 * 回合收尾）不带 silent，失败照旧置顶栏提示。
 */
export async function refreshPanelsData(options: { silent?: boolean } = {}): Promise<void> {
  try {
    const [members, overview] = await Promise.all([api.members(), api.overview()])
    const session = useSessionStore.getState()
    session.setMembers(members.items)
    session.setOverview(overview)
    if (options.silent === true && session.topStatus === '读取失败') session.setTopStatus('')
  } catch (error) {
    if (options.silent === true && !(error instanceof ApiError && error.status === 401)) return
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
    // 失败可见可重试（评审 #4）：视觉上落在 ChatList 的错误行（含原因与重试按钮），
    // announce 保留为屏幕阅读器补充；不再清空列表冒充「还没有任务记录」。
    const reason = error instanceof Error ? error.message : ''
    useSessionStore.getState().setChatListError(reason === '' ? '读取记录失败' : `读取记录失败：${reason}`)
    announce('读取记录失败')
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
  // 失败走顶栏（四通道对照表）：右栏删除失败此前只进 announce，视觉用户以为删掉了。
  const ids = useSessionStore.getState().failurePicked
  if (ids.length === 0) return
  let removed = 0
  for (const id of ids) {
    try {
      await api.removeTask(id)
      removed += 1
    } catch (error) {
      // 顶栏可见（四通道对照表）：announce 对视觉用户不可见，删失败会被当成删掉了。
      const reason = error instanceof ApiError ? error.message : '删除失败，稍后再试'
      useSessionStore.getState().setTopStatus(`失败记录${reason === '' ? '' : `：${reason}`}`)
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
  try {
    // 附件随消息送出（S-attach）：空数组也照发，后端按「没有附件」处理（老客户端兼容形态）。
    const host = await createTurnEngineHost()
    const { sawTerminal } = await consumeTurnStream(
      chat({ conversationId: useTurnStore.getState().conversationId ?? '', message: trimmed, requestId, attachmentIds, signal: abortSignal }),
      host,
      {
        // 占位 note 的撤除口径与旧 consumeTurnEvent 一致：受理（conversation）推进文案，
        // 正文/计划/异常到达才撤；run/reset/user 是流元事件不撤。
        onEvent: event => {
          if (event.type === 'conversation') {
            useTurnStore.setState(st => ({ entries: st.entries.map(entry => entry.key === noteKey ? { ...entry, text: '正在理解目标…' } : entry) }))
            announce('已受理，正在安排')
          } else if (event.type !== 'user' && event.type !== 'run' && event.type !== 'reset') {
            useTurnStore.getState().removeEntry(noteKey)
          }
        },
      },
    )
    useTurnStore.setState({ pendingUser: null })
    useTurnStore.getState().removeEntry(noteKey)
    // 连接自然结束但终态没来（S06）：断连窗口里可能已收尾或仍在跑，跟到终态为止。
    await settleOrFollow(host, { sawTerminal, accepted: true })
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
        text: errorTextOf(error, '没送出去'),
        retryFor: { requestText: trimmed, requestId },
      })
    } else {
      // 已受理后连接断掉：这一轮还在服务端跑，重订事件流跟到终态，不自动重发。
      reportFailure(error, '发送失败')
      await settleOrFollow(await createTurnEngineHost(), { sawTerminal: false, accepted: true })
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

/**
 * 等待当前跟随收尾（streaming 复位）。确认卡出现（subtask 终态）先于回合收尾
 * （summary + run finished + finishTurn）——用户看到卡立即点击会撞进这个窗口，
 * 静默丢弃点击等于按钮坏了；等待复位后再发起，超时抛错让卡面提示。
 */
async function waitForTurnIdle(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (useTurnStore.getState().streaming) {
    if (Date.now() > deadline) throw new Error('上一轮还没收尾，稍等一下再点')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** 操作卡决策入口（ActionDeck 用）：走 /action，requestId 幂等；跟随到终态。 */
export async function runActionDecision(input: {
  taskId: string
  subtaskId: string
  actionId: string
  decision: 'confirm' | 'cancel'
  /** 决策补充说明（评审 B4：如「换成 5 月再发」），后端 /action 原生支持。 */
  note?: string | undefined
  requestId?: string | undefined
}, hooks: { onAccepted?: () => void; onRejected?: (error: unknown) => void } = {}): Promise<void> {
  await waitForTurnIdle()
  useTurnStore.setState({ streaming: true, abort: new AbortController(), lastSeq: 0, lastRunId: '', following: true })
  const host = await createTurnEngineHost()
  try {
    let accepted = false
    for await (const event of act({ ...input, requestId: input.requestId ?? newConversationId(), signal: useTurnStore.getState().abort?.signal })) {
      // 决策流的第一个事件即受理回执：deck 卡就地摘下（乐观更新），不等执行期结束。
      if (!accepted) {
        accepted = true
        hooks.onAccepted?.()
      }
      useTurnStore.getState().applyTurnEvent(event)
    }
    const st = useTurnStore.getState()
    if (st.abort?.signal.aborted !== true && st.conversationId !== null) {
      await followUntilTerminal(st.conversationId, { from: st.lastSeq, expectedRunId: st.lastRunId, signal: st.abort?.signal }, productionLinks, host)
    }
  } catch (error) {
    reportFailure(error, '操作没送出去')
    // 卡面也要知道失败：否则 note 停在「正在办理…」、按钮锁死，用户以为点了没反应。
    hooks.onRejected?.(error)
  } finally {
    void finishTurn()
  }
}

/**
 * 给进行中的一轮补充目标/材料（/supplement，后端幂等）。受理即回调；事件进 store，
 * 跟随到终态——补充后的界面变化由服务端事件驱动，与回话同一管线。
 */
export async function runSupplement(input: { taskId: string; text: string; expectVersion?: number; requestId?: string | null }, hooks: {
  onAccepted?: () => void
  onRejected?: (error: unknown) => void
} = {}): Promise<void> {
  await waitForTurnIdle()
  useTurnStore.setState({ streaming: true, abort: new AbortController(), lastSeq: 0, lastRunId: '', following: true })
  const host = await createTurnEngineHost()
  try {
    // 受理判定：流内第一条事件即回执（deck 卡就地摘下），后续状态变化交给服务端事件。
    const { sawTerminal } = await consumeTurnStream(
      supplement({ taskId: input.taskId, text: input.text, expectVersion: input.expectVersion, requestId: input.requestId ?? newConversationId(), signal: useTurnStore.getState().abort?.signal }),
      host,
      { onFirstEvent: hooks.onAccepted },
    )
    await settleOrFollow(host, { sawTerminal, accepted: true })
  } catch (error) {
    reportFailure(error, '补充没送出去')
    hooks.onRejected?.(error)
  } finally {
    void finishTurn()
  }
}

/** 回应等待中的成员（runReply 语义：受理确认才收卡，失败卡内恢复，输入不丢）。 */
export async function runReply(input: { taskId: string; subtaskId: string; text: string; decideByAgent: boolean; requestId?: string | null }, hooks: {
  onAccepted?: () => void
  onRejected?: (error: unknown) => void
}): Promise<void> {
  await waitForTurnIdle()
  useTurnStore.setState({
    streaming: true,
    abort: new AbortController(),
    lastSeq: 0,
    lastRunId: '',
    following: true,
  })
  const host = await createTurnEngineHost()
  let sawTerminal = false
  let accepted = false
  try {
    const requestId = input.requestId ?? newConversationId()
    // 受理判定：流内第一条事件；requireAccepted——未受理的失败不重订（回复没进系统）。
    const consumed = await consumeTurnStream(
      reply({ taskId: input.taskId, subtaskId: input.subtaskId, text: input.text, decideByAgent: input.decideByAgent, requestId, signal: useTurnStore.getState().abort?.signal }),
      host,
      { onFirstEvent: hooks.onAccepted },
    )
    sawTerminal = consumed.sawTerminal
    accepted = consumed.accepted
    await settleOrFollow(host, { sawTerminal, accepted: true }, { requireAccepted: true })
  } catch (error) {
    reportFailure(error, '回复没送出去')
    if (!accepted) {
      hooks.onRejected?.(error)
    } else {
      // 已受理后断连：这一轮还在服务端跑，重订事件流跟到终态，不自动重发（S06）。
      await settleOrFollow(host, { sawTerminal: false, accepted: true })
    }
  } finally {
    void finishTurn()
  }
}

/** 引擎宿主（发送/回话/接续共用；apply 走 store，markTerminal 由 apply 顺带维护）。 */
/**
 * 回合流公共消费层（评审 #9：五条路径——sendMessage/runSupplement/runReply/
 * runActionDecision/resumeLiveTurn——各自的「for await + 逐条 apply + sawTerminal
 * 计数 + 受理回调」骨架收拢为一份实现）。
 *
 * - onFirstEvent：流内第一条事件到达时触发一次。runReply/runActionDecision/
 *   runSupplement 以它作「受理回执」（deck 卡就地摘下）；sendMessage 不用（它的
 *   受理信号是 conversation 事件，走 onEvent 专属钩改占位文案）。
 * - onEvent：每条事件 apply 之后触发。sendMessage 用它撤占位 note；多数路径不传。
 */
interface ConsumeHooks {
  onFirstEvent?: (() => void) | undefined
  onEvent?: ((event: TurnEvent) => void) | undefined
}

async function consumeTurnStream(
  stream: AsyncGenerator<TurnEvent>,
  host: TurnEngineHost,
  hooks: ConsumeHooks = {},
): Promise<{ sawTerminal: boolean; accepted: boolean }> {
  let sawTerminal = false
  let accepted = false
  let first = true
  for await (const event of stream) {
    if (event.type === 'summary') sawTerminal = true
    if (first) {
      first = false
      accepted = true
      hooks.onFirstEvent?.()
    }
    host.apply(event)
    hooks.onEvent?.(event)
  }
  return { sawTerminal, accepted }
}

/**
 * 收尾统一（评审 #9）：流自然结束后没看到终态、连接没被取消、受理已发生、会话可寻址
 * ——四个条件满足才跟着事件流到终态。此前五处四种写法，终态守卫已漂移出三种。
 * requireAccepted：runReply 语义（未受理的失败不重订）；sendMessage 不要求（它的
 * 受理与否看 conversation 事件，断连窗口里已受理的轮次照样要跟）。
 */
async function settleOrFollow(
  host: TurnEngineHost,
  consume: { sawTerminal: boolean; accepted: boolean },
  options: { requireAccepted: boolean } = { requireAccepted: false },
): Promise<void> {
  const st = useTurnStore.getState()
  if (consume.sawTerminal) return
  if (options.requireAccepted && !consume.accepted) return
  if (st.abort?.signal.aborted === true) return
  if (st.conversationId === null) return
  await followUntilTerminal(st.conversationId, { from: st.lastSeq, expectedRunId: st.lastRunId, signal: st.abort?.signal }, productionLinks, host)
}

export async function createTurnEngineHost(): Promise<TurnEngineHost> {
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
