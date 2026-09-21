/**
 * 牛马大总管群聊前端。
 *
 * 数据来源有三处，各管一件事：
 *
 * - 消息流：`/chat` 与 `/reply` 的 SSE 事件，按到达顺序追加，不整体重绘。
 * - 右栏：`/members` 与 `/overview`，低频轮询。
 * - 左栏：`/conversations` 与 `/history`，会话标题来自宿主首句标题服务。
 *
 * 所有用户可见文本都用 textContent 写入，不使用 innerHTML，避免把模型输出当成标记解析。
 */

import {
  ApiError, api, attachFromUrl, avatarUrl, act, chat, events, eventsHead, reply, uploadAttachment, uploadAvatar,
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, ROUTE_PREFIX, TRANSCRIPT_PAGE_SIZE,
} from './api.js'
import { richText } from './markdown.js'
import { BUILTIN_AVATARS, DEFAULT_MOTTO, DOODLE_PATHS, MOTTO_KEY, PALETTE, RAIL_ICON_PATHS, RAIL_STEPS, STATE_TEXT, SUGGESTIONS, SVG_NS } from './modules/config.js'
import { el, historyState, newConversationId, recallConversation, rememberConversation, state } from './modules/state.js'
import { accentOf, announce, append, avatarNode, clear, declaredNameOf, defaultAvatarUrl, autosize, displayNameOf, distanceFromBottom, formatElapsed, formatTime, make, noteStabilize, programmaticScroll, resetFollowing, scheduleFollowScroll, scheduleFrame, scrollToBottom, stabilizeViewport, streamTraceEnabled, threadInner, traceEvent, updateJumpLatest } from './modules/dom.js'
import { applySummaryRail, renderRail, resetRail, setRail } from './modules/rail.js'
import { appendPreviewText, butlerDelta, butlerMessage, butlerSettle, butlerThinking, dropThinkingOnlySpeech, userMessage } from './modules/speech.js'
import { ensureProgress, memberMessage, renderMemberContent, renderMemberMaterials, setThinking, settleMarkdown, settleMemberBody, settleMemberDynamics } from './modules/member.js'
import { attachToDispatch, cardPrefs, mountDispatch, settleCardForSummary } from './modules/dcard.js'
import { attachmentChipsRow, attachmentsForSend, bindAttachments, clearAttachments, hideAttachUrl, renderAttachments, takeSentAttachments } from './modules/attachments.js'
import { deletePickedConversations, refreshChatList, refreshPanels, setChatManage, setOpenSettings } from './modules/panels.js'
import { bindViewHistory, renderTaskRecord } from './modules/history.js'
import { renderWelcome } from './modules/cards.js'
import { resumeLiveTurn, sendMessage } from './modules/send.js'
import { acceptMention, bindMention, closeMention, mention, openMention, openNewChat, paintMentionActive, renderMotto } from './modules/composer.js'























/* ── 中栏：链路条 ─────────────────────────────────────────────────────── */






/* ── 座右铭 ─────────────────────────────────────────────────────────── */

/* ── 交互绑定 ─────────────────────────────────────────────────────────── */



function bind() {
  bindMention()
  bindAttachments()
  el.composer.addEventListener('submit', event => {
    event.preventDefault()
    // 送出去的正文里 @ 词已随发送定稿，点名簿不再悬着。
    closeMention()
    void sendMessage(el.input.value)
  })

  el.input.addEventListener('input', autosize)
  el.input.addEventListener('keydown', event => {
    // 点名簿开着先服务导航：↑↓ 移动、Enter/Tab 选中、Esc 关闭；输入法组合期间一概不拦（选字要用这些键）。
    if (mention !== null && !event.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const count = mention.items.length
        if (count > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1
          mention.index = (mention.index + delta + count) % count
          paintMentionActive()
        }
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        acceptMention()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMention()
        return
      }
    }
    // Enter 发送，Shift+Enter 换行；输入法组合期间不拦截。
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendMessage(el.input.value)
    }
  })

  el.stop.addEventListener('click', () => {
    // 停止对象绑定点击那一刻的会话（方案 I04/I08）：浏览对象后来怎么切，都不改变这次
    // 停止发给谁。先发停止请求、继续观察终态；不在本地断流冒充「已停止」。
    const conversationId = state.conversationId
    if (conversationId === null || el.stop.disabled) return
    el.stop.disabled = true
    el.topStatus.textContent = '正在请求停止'
    el.hint.textContent = '停止请求已发出，结果以这一轮的最终状态为准'
    api.stop(conversationId, AbortSignal.timeout(10000))
      .then(outcome => {
        if (outcome.accepted) {
          // 服务端已接受中止：终态由随后的 summary 事件落定，这里不再多说。
          return
        }
        el.topStatus.textContent = '已上线'
        append(make('p', 'msg__meta', `没有停止：${outcome.reason || '这一轮已经不在执行'}`))
        scheduleFollowScroll()
      })
      .catch(() => {
        el.topStatus.textContent = '停止请求失败'
        append(make('p', 'error-line', '停止请求没送到，可以再试一次；取消不能回滚已经发生的操作。'))
        announce('停止请求没送到，可以再试一次')
        scheduleFollowScroll()
      })
      .finally(() => { el.stop.disabled = !state.streaming })
  })

  // 滚动跟随只认用户的手（I11）：上滚离开底部就暂停跟随并露出「回到最新」，
  // 回到底部自动恢复；选字复制期间不强拉滚动。
  el.thread.addEventListener('scroll', () => {
    if (programmaticScroll) { noteStabilize({ branch: 'scroll-event', ignored: 'programmatic', top: Math.round(el.thread.scrollTop) }); return }
    const distance = distanceFromBottom()
    if (distance > 160) state.following = false
    else if (distance < 40) state.following = true
    noteStabilize({ branch: 'scroll-event', distance: Math.round(distance), following: state.following })
    updateJumpLatest()
  }, { passive: true })

  el.jumpLatest.addEventListener('click', () => {
    state.following = true
    updateJumpLatest()
    scrollToBottom()
  })

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection()
    state.selecting = selection !== null && !selection.isCollapsed && el.thread.contains(selection.anchorNode)
  })

  // 在光标处插一个 @：分派时点名成员用的，不是装饰。插完顺手把点名簿翻出来。
  el.at?.addEventListener('click', () => {
    const start = el.input.selectionStart ?? el.input.value.length
    const end = el.input.selectionEnd ?? start
    el.input.value = el.input.value.slice(0, start) + '@' + el.input.value.slice(end)
    el.input.setSelectionRange(start + 1, start + 1)
    el.input.focus()
    autosize()
    openMention({ start, query: '' })
  })

  el.newChat.addEventListener('click', openNewChat)

  // 任务记录管理：开关、全选、批量删除（两段式确认）、退出。
  el.chatManageToggle.addEventListener('click', () => { setChatManage(!state.chatManage) })
  el.chatManageExit.addEventListener('click', () => { setChatManage(false) })
  el.chatManageAll.addEventListener('click', () => {
    const rows = [...el.chatList.querySelectorAll('.chat-row__check')]
    const allPicked = rows.length > 0 && rows.every(check => check.checked)
    for (const check of rows) { check.checked = !allPicked; check.dispatchEvent(new Event('change')) }
  })
  el.chatManageDelete.addEventListener('click', () => {
    if (state.chatPicked.size === 0) return
    const button = el.chatManageDelete
    if (button.dataset.armed === '1') {
      delete button.dataset.armed
      button.textContent = '删除所选'
      void deletePickedConversations()
      return
    }
    button.dataset.armed = '1'
    const count = state.chatPicked.size
    button.textContent = `确认删除 ${count} 条`
    setTimeout(() => {
      if (button.dataset.armed === '1') { delete button.dataset.armed; button.textContent = '删除所选' }
    }, 3000)
  })

  // 设置页开关：右上角齿轮进，左上角「回群聊」出。
  el.settingsButton.addEventListener('click', () => setOpenSettings(!state.settingsOpen))
  el.settingsBack.addEventListener('click', () => setOpenSettings(false))

  let searchTimer = 0
  el.chatSearch.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { void refreshChatList() }, 200)
  })

  /* ── 窄屏抽屉（方案 I17）：一次只开一个、共享遮罩、Escape 关闭、焦点进入与返回 ── */

  const centerColumn = document.querySelector('.column--center')

  /**
   * 按断点与开合状态结算面板的键盘可达性（复核 2）。
   *
   * 两条规则叠加：**自身离屏**（窄屏断点下该栏平时移出屏幕，关闭即离屏）与
   * **被另一抽屉的遮罩盖住**（如 1000px 开右抽屉时，常驻的左栏是背景）。
   * 离屏或属于背景都 inert，Tab 才不会落进看不见或被盖住的控件；桌面无抽屉
   * 打开时两栏常驻可达。
   */
  const applyOverlayInert = () => {
    const drawerOpen = document.body.dataset.drawer === 'open'
    const sidebarOpen = document.body.dataset.sidebar === 'open'
    const drawerNarrow = window.matchMedia('(max-width: 1200px)').matches
    const sidebarNarrow = window.matchMedia('(max-width: 880px)').matches
    el.rightPanel.inert = drawerNarrow && !drawerOpen
    el.leftPanel.inert = (sidebarNarrow && !sidebarOpen) || (drawerNarrow && drawerOpen)
    centerColumn.inert = (drawerNarrow && drawerOpen) || (sidebarNarrow && sidebarOpen)
  }

  let drawerReturnFocus = null
  let sidebarReturnFocus = null

  const setDrawer = open => {
    if (open) {
      // 先记住真正的触发按钮，再互斥关另一侧——那一侧静默收起，不回焦点、不清遮罩
      // （复核 2：否则焦点会被另一侧的关闭动作抢走，返回到错误的按钮）。
      drawerReturnFocus = document.activeElement
      if (document.body.dataset.sidebar === 'open') {
        document.body.dataset.sidebar = 'closed'
        el.sidebarToggle.setAttribute('aria-expanded', 'false')
        sidebarReturnFocus = null
      }
      document.body.dataset.drawer = 'open'
      el.drawerToggle.setAttribute('aria-expanded', 'true')
      applyOverlayInert()
      el.backdrop.hidden = false
      el.rightPanel.focus()
    } else {
      document.body.dataset.drawer = 'closed'
      el.drawerToggle.setAttribute('aria-expanded', 'false')
      applyOverlayInert()
      // 遮罩是否还亮着取决于另一侧是否开着（共享遮罩）。
      el.backdrop.hidden = document.body.dataset.sidebar !== 'open'
      // 焦点送回开门的那颗按钮，绝不留在屏外控件上。
      drawerReturnFocus?.focus?.()
      drawerReturnFocus = null
    }
  }

  const setSidebar = open => {
    if (open) {
      sidebarReturnFocus = document.activeElement
      if (document.body.dataset.drawer === 'open') {
        document.body.dataset.drawer = 'closed'
        el.drawerToggle.setAttribute('aria-expanded', 'false')
        drawerReturnFocus = null
      }
      document.body.dataset.sidebar = 'open'
      el.sidebarToggle.setAttribute('aria-expanded', 'true')
      applyOverlayInert()
      el.backdrop.hidden = false
      el.leftPanel.focus()
    } else {
      document.body.dataset.sidebar = 'closed'
      el.sidebarToggle.setAttribute('aria-expanded', 'false')
      applyOverlayInert()
      el.backdrop.hidden = document.body.dataset.drawer !== 'open'
      sidebarReturnFocus?.focus?.()
      sidebarReturnFocus = null
    }
  }

  el.drawerToggle.addEventListener('click', () => setDrawer(document.body.dataset.drawer !== 'open'))
  el.sidebarToggle.addEventListener('click', () => setSidebar(document.body.dataset.sidebar !== 'open'))
  el.backdrop.addEventListener('click', () => {
    if (document.body.dataset.drawer === 'open') setDrawer(false)
    else if (document.body.dataset.sidebar === 'open') setSidebar(false)
  })

  // Escape 依次收起浮层：设置页 → 右抽屉 → 左抽屉；输入法组合期间不抢键。
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing) return
    if (state.settingsOpen) { event.preventDefault(); setOpenSettings(false); return }
    if (document.body.dataset.drawer === 'open') { event.preventDefault(); setDrawer(false); return }
    if (document.body.dataset.sidebar === 'open') { event.preventDefault(); setSidebar(false) }
  })

  // 初始化与跨断点都重新结算：关闭时离屏面板拦在键盘外，跨回桌面放开常驻栏。
  applyOverlayInert()
  window.matchMedia('(max-width: 1200px)').addEventListener('change', applyOverlayInert)
  window.matchMedia('(max-width: 880px)').addEventListener('change', applyOverlayInert)
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */

async function loadIdentity() {
  try {
    el.identity.textContent = (await api.identity()).label
  } catch {
    el.identity.textContent = ''
  }
}

async function main() {
  bind()
  // 浏览器返回键与页面上的「← 返回会话」走同一条栈（见 `bindViewHistory`）。
  bindViewHistory()
  renderMotto()
  renderWelcome()
  autosize()
  await loadIdentity()
  await refreshPanels()
  await refreshChatList()
  // 右栏状态会随别的会话变化，低频轮询即可；流式期间不打断。
  setInterval(() => { if (!state.streaming) void refreshPanels() }, 15000)
  el.input.focus()
  // 不 await：它要跟到那一轮结束，不能把页面启动卡在这里。
  void resumeLiveTurn()
}

void main()
