/**
 * 历史阅读与视图栈（拆分设计 v2 批 1c）：时间锚点/合并去重/插入定位、任务卡、翻页、
 * 会话与任务详情视图、History API 栈。与 panels 构成文档化环簇二。
 */

import { askCard, renderActionsInto, renderWelcome, summaryCard } from './cards.js'
import { STATE_TEXT } from './config.js'
import { attachToDispatch, cardPrefs, mountDispatch } from './dcard.js'
import { append, clear, formatElapsed, formatTime, make, resetFollowing, scrollToBottom, stabilizeViewport, threadInner } from './dom.js'
import { memberMessage, renderMemberContent, renderMemberMaterials, settleMarkdown } from './member.js'
import { applySummaryRail, resetRail } from './rail.js'
import { butlerMessage, userMessage } from './speech.js'
import { el, historyState, rememberConversation, state } from './state.js'
import { clearAttachments, hideAttachUrl, loadAttachments } from './attachments.js'
import { refreshChatList } from './panels.js'
import { TRANSCRIPT_PAGE_SIZE, api } from '../api.js'


/**
 * 视图状态压栈（会话 / 任务记录）。
 *
 * 支持 History API 时用真实栈，浏览器返回键与页面上的「← 返回会话」走同一条路径；
 * 不支持（测试替身、极老环境）时静默降级——页面上的返回按钮仍然直接切视图。
 */
export function pushViewState(value) {
  try { history.pushState(value, '', location.href) } catch { /* 忽略。 */ }
}

export function replaceViewState(value) {
  try { history.replaceState(value, '', location.href) } catch { /* 忽略。 */ }
}

/** 任务记录视图的顶部条：返回入口 + 面包屑（进去之后要能出来）。 */
export function viewHead() {
  const head = make('div', 'view-head')
  const back = make('button', 'btn btn--tiny view-head__back', '← 返回会话')
  back.type = 'button'
  back.addEventListener('click', () => {
    // 有栈就退栈（与浏览器返回键同一条路径），没有就按当前会话直接回。
    if (canGoBack()) history.back()
    else if (state.conversationId !== null) void openConversation(state.conversationId)
    else renderWelcome()
  })
  head.appendChild(back)
  head.appendChild(make('span', 'view-head__crumb', '会话 › 任务记录'))
  return head
}

/** 有没有可退的视图栈：拿上一次压入的标记判断，避免退到站外。 */
export function canGoBack() {
  try { return history.state?.butler === 'task' } catch { return false }
}

/** 历史条目的时间锚点：对话用消息时间，任务用收尾时间（摘要属于结局）。 */
export function timeOf(value) {
  const at = new Date(value).getTime()
  return Number.isNaN(at) ? 0 : at
}

/**
 * 历史条目的全局比较规则（初次加载与分页共用）。
 *
 * 先按时间；同刻的对话按事件序号**数值**比较——字符串比较会把 `t:10` 排到 `t:2`
 * 前面（复核 2）；任务按收尾时间锚定、属于结局，同刻排在对话之后，再按 id 决胜。
 */
export function compareHistoryEntries(a, b) {
  if (a.at !== b.at) return a.at - b.at
  const seqOf = entry => entry.kind === 'task' ? Number.POSITIVE_INFINITY : Number(entry.id.slice(2))
  const left = seqOf(a)
  const right = seqOf(b)
  if (Number.isNaN(left) || Number.isNaN(right)) return a.id < b.id ? -1 : 1
  if (left !== right) return left - right
  return a.id < b.id ? -1 : 1
}

/**
 * 把一页对话正文与一页任务摘要合成按时间排序的展示序列（纯数据，不碰 DOM）。
 *
 * 任务是摘要不是对话（S13）：在序列里以 `task` 出现，渲染成明确标注的摘要卡；
 * 被打断的管家答复标出来，不冒充完整结论。条目带稳定标识（事件序号 / 任务 id），
 * 供跨页去重与定位插入（复核 1）。
 */
export function mergeHistoryEntries(transcriptItems, taskItems) {
  const entries = []
  for (const item of transcriptItems ?? []) {
    entries.push({
      id: `t:${item.seq}`,
      at: timeOf(item.time),
      interrupted: item.interrupted === true,
      kind: item.role,
      text: item.text,
      time: item.time,
    })
  }
  for (const task of taskItems ?? []) {
    entries.push({ id: `task:${task.id}`, at: timeOf(task.updatedAt ?? task.createdAt), kind: 'task', task })
  }
  entries.sort(compareHistoryEntries)
  return entries
}

/**
 * 把新页条目并入全局序列并给出定位插入计划（纯数据，复核 1）。
 *
 * 正文与任务的分页时间范围会交叉：只排新页再整体前插得不到全局时间序
 * （复核例：前插后成为 [800,100,900,1000]）。这里按稳定标识去重后用与初次加载
 * 同一套比较规则全局排序（幂等），新条目降序逐一「插到后继节点之前」——降序保证
 * 处理到某条时，比它晚的新条目都已就位，后继一定有节点可参照。
 */
export function planHistoryInsertion(existing, fresh) {
  const known = new Map(existing.map(entry => [entry.id, entry]))
  const additions = []
  for (const entry of fresh) {
    if (known.has(entry.id)) continue
    known.set(entry.id, entry)
    additions.push(entry)
  }
  const merged = [...existing, ...additions].sort(compareHistoryEntries)
  const position = new Map(merged.map((entry, index) => [entry.id, index]))
  const insertions = additions
    .slice()
    .sort((a, b) => -compareHistoryEntries(a, b))
    .map(entry => {
      const index = position.get(entry.id) ?? 0
      return { entry, beforeId: merged[index + 1]?.id ?? null }
    })
  return { merged, insertions }
}

/** 历史里的任务摘要卡：还没拿到任务详情时的占位，点开看完整记录，不冒充逐条对话。 */
export function taskSummaryCard(task) {
  const card = make('button', 'task-card')
  card.type = 'button'
  card.dataset.state = task.state
  const head = make('div', 'task-card__head')
  head.appendChild(make('span', 'task-card__badge', '任务摘要'))
  head.appendChild(make('span', 'task-card__state', STATE_TEXT[task.state] ?? task.state))
  head.appendChild(make('span', 'task-card__time', formatTime(task.updatedAt)))
  card.appendChild(head)
  card.appendChild(make('div', 'task-card__goal', task.goal))
  card.appendChild(make('div', 'task-card__meta', `${formatTime(task.createdAt)} 分派 · ${task.subtaskDone}/${task.subtaskTotal} 项收尾`))
  card.addEventListener('click', () => { void openTask(task.id) })
  return card
}

/**
 * 历史里的一个任务条目：先挂摘要卡，拿到任务详情后**原地**换成调度卡。
 *
 * 刷新之后看到的调度卡与执行时是同一个组件（同一段 `renderTaskCard`），这就是"刷新后样式还在"
 * 的那一半；换的是包装节点里的**内容**，条目节点本身不动——翻页定位按节点引用插到后继之前
 * （`planHistoryInsertion`），把节点换掉会让更早的记录插错位置。
 *
 * 详情读不到（网络、鉴权过期）就留着摘要卡并说明原因：那是"没有详情"的如实表达，不是空白。
 */
export function taskHistoryEntry(task) {
  const wrap = make('div', 'entry-task')
  wrap.appendChild(taskSummaryCard(task))
  void upgradeTaskEntry(wrap, task)
  return wrap
}

/**
 * 读一条任务详情，**只对并发的同一批请求去重**。
 *
 * ⚠️ 不能把已取到的结果长期留在表里：任务的结局会变，缓存住第一次的快照，用户切走再切回
 * 就会看到一张"永远进行中、秒数还在跳"的历史卡（同页的任务摘要卡却已经是收尾时间）。
 * 所以落地即删——下一次渲染重新问一次服务端。
 */
export const taskCardRequests = new Map()

export function taskRecord(id) {
  const known = taskCardRequests.get(id)
  if (known !== undefined) return known
  const pending = api.task(id)
  taskCardRequests.set(id, pending)
  const forget = () => { taskCardRequests.delete(id) }
  pending.then(forget, forget)
  return pending
}

export async function upgradeTaskEntry(wrap, task) {
  try {
    const record = await taskRecord(task.id)
    // 换会话、翻页之后这个包装节点可能已经被丢弃：那就什么都不做（不往游离节点里写）。
    if (!wrap.isConnected) return
    // 还没终的任务是"活的"：等待中的成员要重新拿到回复入口（点开历史也能回话），
    // 调度卡也默认展开——收起会把确认按钮和等待输入框一起藏进折叠区，用户面对
    // "在等"的任务却找不到任何入口（#7/#16）。终态任务沿用用户自己的展开偏好。
    const active = !['completed', 'failed', 'cancelled', 'partial'].includes(record.state)
    const card = renderTaskCard(record, { live: false, liveResume: active, defaultOpen: active || cardPrefs(task.id).open === true })
    // 摘要卡换成调度卡是**高度变化**：用户正读到上面几屏时会被顶走，所以与翻页同一口径，
    // 在视口钉扎里替换（I11）。
    stabilizeViewport(() => { wrap.replaceChildren(card) }, { forceAnchor: true })
  } catch (error) {
    if (!wrap.isConnected) return
    stabilizeViewport(() => {
      wrap.replaceChildren(
        taskSummaryCard(task),
        make('p', 'history-head__error',
          `调度卡读不到：${error instanceof Error && error.message ? error.message : '网络异常'}，点上面的摘要看完整记录`),
      )
    }, { forceAnchor: true })
  }
}

/**
 * 创建一个历史条目的节点。打断标注收进消息内部（不另起游离节点），
 * 整个条目是一个节点，才能被定位插入整体搬移（复核 1）。
 */
export function createHistoryNode(entry) {
  if (entry.kind === 'user') return userMessage(entry.text, entry.time)
  if (entry.kind === 'butler') {
    const view = butlerMessage('', entry.time)
    settleMarkdown(view.body, entry.text)
    if (entry.interrupted) view.msg.lastElementChild.appendChild(make('div', 'msg__meta', '这一轮被打断，正文是已流出的部分'))
    return view.msg
  }
  return append(taskHistoryEntry(entry.task))
}

/** 按时间正序创建历史节点；创建即追加，并记到条目上供后续翻页定位。 */
export function renderHistorySlice(entries) {
  for (const entry of entries) entry.node = createHistoryNode(entry)
}

/** 「加载更早记录」入口：两个游标都到底后换成分界说明；失败保留重试。 */
export function updateLoadEarlier(error) {
  const control = threadInner().querySelector('.history-head')
  if (control === null) return
  clear(control)
  if (historyState.transcriptBefore === null && historyState.taskOffset === null) {
    control.appendChild(make('span', 'history-head__note', '没有更早的记录了'))
    return
  }
  const button = make('button', 'btn btn--tiny history-head__more', historyState.loading ? '正在读取…' : '加载更早记录')
  button.type = 'button'
  button.disabled = historyState.loading
  button.addEventListener('click', () => { void loadEarlier() })
  control.appendChild(button)
  if (error !== undefined && error !== null) {
    control.appendChild(make('span', 'history-head__error',
      `读取更早记录失败：${error instanceof Error && error.message ? error.message : '网络异常'}，可以重试`))
  }
}

/**
 * 加载一页更早的记录，按全局时间序定位插入（I10，复核 1）。
 *
 * 正文与任务分页范围交叉，新页条目可能要插到已显示内容中间而不是整体垫在最上面；
 * 插入与分界控件的更新（按钮换「没有更早」会改布局，复核 3）都在锚点保护内，
 * 加载旧页永远保持阅读位置。回包后核对视图代次与会话 id，旧回包不写进新会话（I09）；
 * **释放加载锁同样核对归属**（复核 3）——切走后旧请求的结束不得把新会话的加载状态解锁。
 */
export async function loadEarlier() {
  const id = historyState.conversationId
  if (historyState.loading || id === null) return
  if (historyState.transcriptBefore === null && historyState.taskOffset === null) { updateLoadEarlier(); return }
  const token = state.viewToken
  historyState.loading = true
  // 归属核对的口径：视图代次与会话都还是发起时的那一个，回包/解锁才属于这次请求。
  const stillOwns = () => token === state.viewToken && id === historyState.conversationId
  let failure = null
  try {
    updateLoadEarlier()
    const [page, tasks] = await Promise.all([
      historyState.transcriptBefore === null
        ? Promise.resolve(null)
        : api.transcript({ conversationId: id, before: historyState.transcriptBefore, limit: TRANSCRIPT_PAGE_SIZE }),
      // 任务分页数沿用服务端注入的默认（分页上限只有一个来源），不在这里写死。
      historyState.taskOffset === null
        ? Promise.resolve(null)
        : api.history({ conversationId: id, offset: historyState.taskOffset }),
    ])
    if (!stillOwns()) return
    const plan = planHistoryInsertion(historyState.entries, mergeHistoryEntries(page?.items, tasks?.items))
    const inner = threadInner()
    const nodeOf = new Map(plan.merged.map(entry => [entry.id, entry.node]))
    stabilizeViewport(() => {
      // 降序插入：处理到某条时，比它晚的条目（旧有或已插入的新条目）都已有节点。
      // 创建后必须同步写回索引，否则更早条目找不到刚插入的后继，只能落在末尾（复核 1）。
      for (const { entry, beforeId } of plan.insertions) {
        entry.node = createHistoryNode(entry)
        nodeOf.set(entry.id, entry.node)
        const successor = beforeId === null ? null : nodeOf.get(beforeId)
        if (successor !== undefined && successor !== null && successor.isConnected) inner.insertBefore(entry.node, successor)
        // 后继为空（它是最新一条）或尚未连接：留在创建时的追加位置，即线程末尾，同样正确。
      }
      if (page !== null) historyState.transcriptBefore = page.prevBefore
      if (tasks !== null) historyState.taskOffset = tasks.nextOffset
      // 游标与分界控件一并收进锚点保护：到底换文案也是布局变化（复核 3）。
      historyState.loading = false
      updateLoadEarlier()
    }, { forceAnchor: true })
    historyState.entries = plan.merged
    return
  } catch (error) {
    if (stillOwns()) failure = error
  }
  // 失败路径：解锁与错误提示同样在锚点保护内更新。
  if (stillOwns()) {
    stabilizeViewport(() => {
      historyState.loading = false
      updateLoadEarlier(failure)
    }, { forceAnchor: true })
  }
}

/**
 * 打开一个历史会话（C 批历史阅读）。
 *
 * 真实对话来自官方会话日志的 transcript（不另存副本）；任务只给明确标注的摘要卡（S13）。
 * 先取对话与任务的最新一页，「加载更早记录」往更早翻。所有 await 后核对视图代次（I09）；
 * 对话正文读不到时如实说明，不拿任务摘要冒充完整对话。
 */
export async function openConversation(id) {
  if (state.streaming) return
  // 视图代次：先点 A 再点 B、A 响应更晚时，只显示 B，旧回包不许写入（方案 I09）。
  const token = ++state.viewToken
  state.conversationId = id
  rememberConversation(id)
  // 附件跟着会话走：先立刻清空（别让上一个会话的待发文件挂在新会话上），再去服务端把这一轮的
  // 待发附件取回来。取的过程是异步的，所以上面那句"立刻清空"不能省。
  hideAttachUrl()
  clearAttachments()
  void loadAttachments()
  clear(el.thread)
  threadInner()
  state.bubbles.clear()
  state.asks.clear()
  resetRail()
  resetFollowing()
  historyState.conversationId = id
  historyState.transcriptBefore = null
  historyState.taskOffset = null
  historyState.loading = false
  historyState.entries = []
  const placeholder = append(make('p', 'msg__meta', '正在读取记录…'))
  let transcript = null
  let taskPage = null
  let transcriptError = null
  let taskError = null
  ;[transcript, taskPage] = await Promise.all([
    api.transcript({ conversationId: id, tail: true, limit: TRANSCRIPT_PAGE_SIZE })
      .catch(error => { transcriptError = error; return null }),
    // 任务分页数沿用服务端注入的默认（分页上限只有一个来源），不在这里写死。
    api.history({ conversationId: id, offset: 0 })
      .catch(error => { taskError = error; return null }),
  ])
  if (token !== state.viewToken) return
  placeholder.remove()
  // 会话视图是"底"：进入时**替换**当前状态（不是压栈），免得栈里堆满同一个会话。
  replaceViewState({ butler: 'conversation', conversationId: id })
  const head = make('div', 'history-head')
  threadInner().prepend(head)
  if (transcriptError !== null) {
    append(make('p', 'error-line', `对话正文读不到：${transcriptError instanceof Error && transcriptError.message ? transcriptError.message : '网络异常'}；下面只有任务摘要。`))
  }
  if (taskError !== null) {
    append(make('p', 'error-line', `任务记录读不到：${taskError instanceof Error && taskError.message ? taskError.message : '网络异常'}`))
  }
  const entries = mergeHistoryEntries(transcript?.items, taskPage?.items)
  if (entries.length === 0 && transcriptError === null && taskError === null) {
    renderWelcome()
    return
  }
  renderHistorySlice(entries)
  // 记入全局序列：后续「加载更早记录」据此去重与定位插入（复核 1）。
  historyState.entries = entries
  historyState.transcriptBefore = transcript?.prevBefore ?? null
  historyState.taskOffset = taskPage?.nextOffset ?? null
  updateLoadEarlier()
  scrollToBottom()
  void refreshChatList()
}

export async function openTask(id) {
  // 与 openConversation 同一保护（方案 I08）：右栏失败记录也是换视图入口，
  // 执行中切换会替换全局会话与线程，不能没有守卫。
  if (state.streaming) return
  const token = ++state.viewToken
  try {
    const record = await api.task(id)
    if (token !== state.viewToken) return
    state.conversationId = record.conversationId
    rememberConversation(record.conversationId)
    // 视图压栈：进来之后要能出去。浏览器返回键与页面上的「← 返回会话」都退这一栈。
    pushViewState({ butler: 'task', taskId: record.id, conversationId: record.conversationId })
    clear(el.thread)
    const inner = threadInner()
    inner.appendChild(viewHead())
    state.bubbles.clear()
    resetRail()
    resetFollowing()
    renderTaskRecord(record)
    scrollToBottom()
  } catch (error) {
    if (token !== state.viewToken) return
    append(make('p', 'error-line', error instanceof Error ? error.message : '打不开这条记录'))
  }
}

/**
 * 浏览器返回键：按栈里的视图状态回到上一层。
 *
 * 只认自己压入的标记（`state.butler`）；不是自己的状态就什么都不做，绝不接管站内的其它历史。
 */
export function bindViewHistory() {
  window.addEventListener('popstate', event => {
    const value = event.state
    if (value === null || typeof value !== 'object') return
    if (value.butler === 'task' && typeof value.taskId === 'string') { void openTask(value.taskId); return }
    if (value.butler === 'conversation' && typeof value.conversationId === 'string') { void openConversation(value.conversationId) }
  })
}

/**
 * 把一个任务记录渲染成一张调度卡（并返回它）。
 *
 * **实时视图与刷新重建共用这一条**：群里看到的卡片、任务记录页、历史里的卡片来自同一段代码，
 * 所以刷新之后不会变成另一副样子（改造前历史走的是"任务摘要卡"，样式与交互都对不上）。
 * `liveResume` 为真表示这一轮还在跑（快照接续）：等待中的成员重新给回复入口，而不是宣告过期。
 */
export function renderTaskCard(record, opts = {}) {
  const liveResume = opts.liveResume === true
  const card = mountDispatch(
    record.subtasks.map(item => ({ id: item.id, goal: item.goal, agentId: item.agentId, state: item.state, startedAt: item.startedAt, finishedAt: item.finishedAt })),
    { taskId: record.id, live: opts.live !== false, defaultOpen: opts.defaultOpen === true },
  )
  const panel = card.__dcard
  // 卡片这时还没挂进线程（调用方负责挂）：显式放行往它里面填内容（见 `attachToDispatch` 的守卫）。
  panel.building = true
  for (const subtask of record.subtasks) {
    const view = memberMessage(subtask.agentId, subtask.id)
    // 恢复出来的成员输出同样收进卡片：与实时视图一致，群里不再有单独的成员行。
    attachToDispatch(view, { id: subtask.id, state: subtask.state, startedAt: subtask.startedAt ?? undefined, finishedAt: subtask.finishedAt ?? undefined }, panel)
    view.startedAt = subtask.startedAt ?? record.createdAt
    view.status.textContent = STATE_TEXT[subtask.state] ?? subtask.state
    const text = subtask.state === 'failed' || subtask.state === 'cancelled'
      ? (subtask.error || '失败')
      : (subtask.result || STATE_TEXT[subtask.state] || '')
    // 与实时同一个入口：成功、失败、等你回话、待外部处理的正文都走受控 Markdown
    // （表格/列表/代码才显示成它本来的样子）。
    renderMemberContent(view, text)
    // 交回的材料（产出区）与实时同一条路：刷新重建后照样能看到链接、状态与字段表。
    renderMemberMaterials(view, subtask.artifacts)
    // 刷新重建同样画出待确认的操作（`/task` 里带的是留存投影出来的那一份）。
    renderActionsInto(view, subtask.actions, { taskId: record.id, subtaskId: subtask.id })
    if (['succeeded', 'failed', 'cancelled', 'external_pending'].includes(subtask.state)) view.terminal = true
    if (subtask.state === 'succeeded') {
      view.bubble.classList.add('bubble--done')
      if (subtask.finishedAt && subtask.startedAt) {
        view.footer.appendChild(make('div', 'msg__meta', `耗时 ${formatElapsed(subtask.startedAt, subtask.finishedAt)}`))
      }
    }
    if (subtask.state === 'failed') view.bubble.classList.add('bubble--fail')
    if (subtask.state === 'waiting_user') {
      view.bubble.classList.add('bubble--wait')
      if (liveResume) {
        // 快照接续的等待是活的：等待上下文仍在服务端，重新给回复入口而不是宣告过期。
        askCard(view, { taskId: record.id, id: subtask.id, question: subtask.result || '需要你补充点信息', detail: subtask.result ?? '' })
      } else {
        // 历史里的等待无法直接回复（进程已重启），只提示重新描述目标。
        view.footer.appendChild(make('div', 'msg__meta', '这次等待已经过去了，重新说一遍目标就能再接上'))
      }
    }
  }
  panel.building = false
  return card
}

/**
 * 把一条持久化的任务渲染成消息流（点开一条任务记录、快照接续）。
 *
 * 刷新页面后走这条路径，所以显示的状态与数据库里的一致；原始对话正文由宿主的会话日志
 * 承载，这里只重建任务维度能确定的部分。
 */
export function renderTaskRecord(record, opts = {}) {
  /** `liveResume`：从快照接续一轮还在跑的任务（S05 reset 校准），不是历史回放。 */
  const liveResume = opts.liveResume === true
  const terminalRecord = ['completed', 'failed', 'cancelled', 'partial'].includes(record.state)
  userMessage(record.goal, record.createdAt)
  butlerMessage(record.note ? `我按这个思路拆的：${record.note}` : '我按下面的方式拆了任务。', record.createdAt)
  state.taskId = record.id
  append(renderTaskCard(record, { liveResume, live: true }))
  // 运行中的快照没有定论：终态卡只在终态或历史回放时出现，否则链路条如实反映进行中。
  if (terminalRecord || !liveResume) {
    append(summaryCard({
      state: record.state,
      text: record.summary,
      error: record.error,
    }))
  }
  // 历史回放也要让链路条反映这一轮走到哪了，与实时汇总共用同一套语义。
  applySummaryRail(record.state)
}
