/**
 * 左右栏运维域（评审 #10 拆分）：成员档案/运行状态刷新、任务记录列表分页与
 * 删除/改名、失败记录清理。错误通道遵循 use-turn 头部的四通道对照表。
 */
import { api, ApiError } from '../lib/api.ts'
import { errorTextOf } from '../lib/error-text.ts'
import { announce } from '../lib/announce.ts'
import { useSessionStore } from '../stores/session.ts'
import { useTurnStore } from '../stores/turn.ts'
import { clearAttachments } from '../stores/attachments.ts'

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
