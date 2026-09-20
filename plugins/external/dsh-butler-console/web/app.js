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
import { accentOf, announce, append, avatarNode, clear, declaredNameOf, defaultAvatarUrl, displayNameOf, distanceFromBottom, formatElapsed, formatTime, make, noteStabilize, programmaticScroll, resetFollowing, scheduleFollowScroll, scheduleFrame, scrollToBottom, stabilizeViewport, streamTraceEnabled, threadInner, traceEvent, updateJumpLatest } from './modules/dom.js'
import { applySummaryRail, renderRail, resetRail, setRail } from './modules/rail.js'
import { appendPreviewText, butlerDelta, butlerMessage, butlerSettle, butlerThinking, dropThinkingOnlySpeech, userMessage } from './modules/speech.js'
import { ensureProgress, memberMessage, renderMemberContent, renderMemberMaterials, setThinking, settleMarkdown, settleMemberBody, settleMemberDynamics } from './modules/member.js'
import { attachToDispatch, cardPrefs, mountDispatch, settleCardForSummary } from './modules/dcard.js'




















/**
 * 待确认操作卡（**唯一**的渲染入口）。
 *
 * 这是"新增一种操作不用再写前端"的落点：卡片只认 `AgentAction` 的呈现字段
 * （`title` / `summary` / `detail` / `fields` / 按钮文案 / `state`），**不认 `kind`**——
 * 成员插件多做一种操作，这里一行都不用改。想加视觉差异时按 `kind` 前缀挑图标即可，
 * 那是装饰，不是分支逻辑。
 *
 * 确认与取消走同一个端点（`/butler/action`），**凭据从不经过前端**：这里只送出一个决策，
 * 执行方自己核验归属并从自己的记录里取凭据。
 */
function actionCard(action, context) {
  const card = make('section', 'act')
  card.dataset.actionId = action.id
  // 渲染时固化归属（2026-09-19）：卡片可能被复制/残留到别的步骤格子里，点击时若从
  // DOM 位置反推 subtaskId 就会提交错步骤（404「这条待办不存在」）。dataset 是权威。
  card.dataset.subtaskId = context.subtaskId
  card.dataset.taskId = context.taskId
  card.dataset.kind = action.kind ?? ''
  card.dataset.state = action.state ?? 'prepared'
  const head = make('div', 'act__head')
  head.appendChild(make('span', 'act__title', action.title ?? '待确认的操作'))
  head.appendChild(make('span', 'act__state', ACTION_STATE_TEXT[action.state] ?? action.state ?? ''))
  card.appendChild(head)
  if (typeof action.summary === 'string' && action.summary !== '') {
    card.appendChild(make('p', 'act__summary', action.summary))
  }
  if (typeof action.detail === 'string' && action.detail !== '') {
    const detail = make('div', 'act__detail md')
    richText(detail, action.detail, { variant: 'card' })
    card.appendChild(detail)
  }
  if (Array.isArray(action.fields) && action.fields.length > 0) {
    // 结构化字段走**同一套**表格样式（`.md table`），不另立一种表。
    const wrap = make('div', 'table-scroll')
    wrap.setAttribute('tabindex', '0')
    wrap.setAttribute('role', 'region')
    wrap.setAttribute('aria-label', '操作详情')
    const table = make('table')
    const body = make('tbody')
    for (const field of action.fields) {
      const row = make('tr')
      row.appendChild(make('th', null, field.label ?? ''))
      row.appendChild(make('td', null, field.value ?? ''))
      body.appendChild(row)
    }
    table.appendChild(body)
    wrap.appendChild(table)
    card.appendChild(wrap)
  }
  if (typeof action.resultText === 'string' && action.resultText !== '') {
    const result = make('div', 'act__result md')
    richText(result, action.resultText, { variant: 'card' })
    card.appendChild(result)
  }
  if (typeof action.errorText === 'string' && action.errorText !== '') {
    card.appendChild(make('p', 'act__error', action.errorText))
  }
  // 只有 `prepared` 才给按钮：执行中的、办完的、过期的都不该再点（点了也只会拿到 409）。
  if ((action.state ?? 'prepared') === 'prepared') {
    const expired = typeof action.expiresAt === 'number' && action.expiresAt <= Date.now()
    if (expired) {
      card.dataset.state = 'expired'
      card.appendChild(make('p', 'act__note', '这条确认已经过期，让它重新生成一次再确认。'))
    } else {
      if (typeof action.expiresAt === 'number') {
        card.appendChild(make('p', 'act__note', `请在 ${formatTime(action.expiresAt)} 之前确认`))
      }
      const row = make('div', 'act__row')
      const confirm = make('button', 'btn btn--tiny btn--primary', action.confirmLabel ?? '确认')
      confirm.type = 'button'
      const cancel = make('button', 'btn btn--tiny', action.cancelLabel ?? '先不办')
      cancel.type = 'button'
      row.appendChild(confirm)
      row.appendChild(cancel)
      card.appendChild(row)
      const lock = () => { confirm.disabled = true; cancel.disabled = true }
      confirm.addEventListener('click', () => { lock(); void runAction(action, 'confirm', context, card) })
      cancel.addEventListener('click', () => { lock(); void runAction(action, 'cancel', context, card) })
    }
  }
  return card
}

/** 操作状态 → 卡片上的短词。 */
const ACTION_STATE_TEXT = {
  prepared: '等你确认',
  executing: '正在办',
  succeeded: '已办完',
  failed: '没办成',
  cancelled: '先不办',
  expired: '已过期',
}

/** 把一次决策交给服务端，并把事件当成这一轮来消费（与 reply 同一条通道）。 */
async function runAction(action, decision, context, card) {
  const note = make('p', 'act__note', decision === 'confirm' ? '正在办理…' : '正在撤回…')
  card.appendChild(note)
  try {
    await runAct({
      taskId: card.dataset.taskId || context.taskId,
      subtaskId: card.dataset.subtaskId || context.subtaskId,
      actionId: action.id,
      decision,
      requestId: newConversationId(),
    })
  } catch (error) {
    // 失败不把卡片留在"点了没反应"的状态：解锁并如实说明。
    note.textContent = `${decision === 'confirm' ? '确认' : '撤回'}没成功：${error instanceof Error && error.message ? error.message : '网络异常'}`
    for (const button of card.querySelectorAll('.act__row button')) button.disabled = false
  }
}

/**
 * 把一位成员名下的待确认操作画进它的结果区（**唯一**的挂载点）。
 *
 * 挂 `view.footer`：它在成员消息内部，会跟着消息一起搬进调度卡的格子，所以"成员的结果 + 它的
 * 待办"永远在一起；结果区高度固定、区内滚动，多一张卡也不会把页面撑开。
 *
 * 每次调用**整块重画**：服务端返回的是这条操作的当前全量状态（`prepared` → `executing` →
 * `succeeded`/`failed`/`cancelled`/`expired`），局部改反而容易与服务端不一致。
 */
function renderActionsInto(view, actions, context) {
  const host = view.actionHost
  // 空清单也要**清掉旧卡**（2026-09-19 生产：s1 结算 succeeded 时 actions=[]，此处直接
  // return 让此前会话级清单里画下的第二张卡残留在 s1 名下，点它提交的是错步骤 → 404
  // 「这条待办不存在」）。host 还没建过时才无事可做。
  if (host === undefined || host.parentNode === null) {
    if (!Array.isArray(actions) || actions.length === 0) return
  } else if (!Array.isArray(actions) || actions.length === 0) {
    // 已有 host：整块清空（卡已办完/已从本步名下移除）。
    clear(host)
    return
  }
  const target = host ?? (() => {
    const made = make('div', 'act-host')
    view.footer.appendChild(made)
    view.actionHost = made
    return made
  })()
  clear(target)
  for (const action of actions) target.appendChild(actionCard(action, context))
}


/**
 * 视图状态压栈（会话 / 任务记录）。
 *
 * 支持 History API 时用真实栈，浏览器返回键与页面上的「← 返回会话」走同一条路径；
 * 不支持（测试替身、极老环境）时静默降级——页面上的返回按钮仍然直接切视图。
 */
function pushViewState(value) {
  try { history.pushState(value, '', location.href) } catch { /* 忽略。 */ }
}

function replaceViewState(value) {
  try { history.replaceState(value, '', location.href) } catch { /* 忽略。 */ }
}

/** 任务记录视图的顶部条：返回入口 + 面包屑（进去之后要能出来）。 */
function viewHead() {
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
function canGoBack() {
  try { return history.state?.butler === 'task' } catch { return false }
}




/* ── 中栏：链路条 ─────────────────────────────────────────────────────── */

/* ── 中栏：事件分发 ───────────────────────────────────────────────────── */

function handleEvent(event) {
  switch (event.type) {
    case 'conversation':
      state.conversationId = event.conversationId
      rememberConversation(event.conversationId)
      return

    case 'user': {
      // 发送时已经预渲染过同一条：受理回放对得上就不重复画。对不上（历史回放、
      // 其他入口）照常渲染。任务数量与派发事实只由 plan 与 subtask 事件表达。
      if (state.pendingUser !== null && state.pendingUser.text === event.text) {
        state.pendingUser = null
        break
      }
      dropThinkingOnlySpeech()
      state.butlerThinking = ''
      userMessage(event.text, event.time)
      break
    }

    case 'chat':
      butlerSettle(event.text, event.time)
      // 落定正文记下来：汇总与之相同就不再整段重复（S12）。
      state.lastChatText = event.text
      break

    case 'chat_delta':
      butlerDelta(event.text)
      break

    case 'chat_thinking':
      butlerThinking(event.thinking)
      break

    case 'chat_reset':
      // 模型重试开始（S08）：当前预览作废，下一段增量从新气泡起头，
      // 两次尝试的正文不拼在一起；被重试掉那一版的思考也不该留在页面上
      // ——只有思考、还没吐字的那条气泡在这里撤掉（有正文的留给落定替换）。
      dropThinkingOnlySpeech()
      state.butlerThinking = ''
      break

    case 'input': {
      // 使用者改了目标。先留一行痕迹，随后的分派与汇总照旧走原来的分支。
      state.taskId = event.taskId
      append(make('p', 'msg__meta',
        event.source === 'supplement'
          ? `补充已收到（第 ${event.version} 版）：${event.text}`
          : event.text))
      break
    }

    case 'plan': {
      state.taskId = event.taskId
      state.bubbles.clear()
      state.asks.clear()
      setRail('parse', 'done')
      setRail('dispatch', 'active')
      // 调度卡是新的一条消息：先收掉可能还开着的大总管气泡，别把两段话并到一条里。
      // 这里不替大总管编话：拆了几份、派给谁、有没有喊到人，由卡片和后续 subtask 事件
      // 按服务端事实呈现（方案 S02）。用户的折叠偏好按 taskId 记着，重建时先读偏好再渲染。
      dropThinkingOnlySpeech()
      append(mountDispatch(event.subtasks, { taskId: event.taskId, live: true }))
      break
    }

    case 'subtask':
      handleSubtask(event)
      break

    case 'subtask_delta': {
      const view = state.bubbles.get(event.id)
      // 终态之后不再追加（S08）：迟到帧不把已校准的结论再改掉。
      if (view === undefined || view.terminal === true || view.live === false) break
      view.body += event.delta
      // 按帧合并（I12）：增量先累积，一帧只写一次 DOM、推进一次进度。
      if (view.framePending === true) break
      view.framePending = true
      scheduleFrame(() => {
        view.framePending = false
        // terminal（已校准）或 live=false（已离开执行态，如等待）都不再写：
        // 迟到帧会把刚收起的光标重新点亮（浏览器验证发现的等待态复亮）。
        if (view.terminal === true || view.live === false) return
        // 流式与终态同一格式；超长正文降级纯文本追加（与 butlerDelta 同一分级）。
        if (view.body.length > STREAM_RICH_LIMIT) appendPreviewText(view.text, view, view.body)
        else view.text = richText(view.text, view.body, { streaming: true })
        view.caret.hidden = false
        // 不确定指示（复核 3）：增量不再换算百分比——没有可信分母不显示伪精度，
        // 真实阶段由工具行文字表达。
        ensureProgress(view)
      })
      break
    }

    case 'subtask_thinking':
      setThinking(state.bubbles.get(event.id), event.thinking)
      break

    case 'summary':
      // 汇总是这一轮的定论：链路条按最终状态推进，已走过的步骤保持点亮。
      applySummaryRail(event.state)
      for (const view of state.bubbles.values()) view.caret.hidden = true
      // 还在"进行中/排队"的格子在这一刻一律收口：这一轮已经有了定论，不能让某一格继续
      // 显示进行中、秒数还往上跳（成员自己那条终态事件可能因为取消/失败没有到达）。
      settleCardForSummary(event.state, event.time ?? Date.now())
      announce(`这一轮${
        event.state === 'completed' ? '已完成' : event.state === 'failed' ? '失败' : event.state === 'cancelled' ? '已喊停' : event.state === 'partial' ? '部分完成' : event.state === 'waiting_user' ? '等你回话' : '待外部处理'}`)
      // 正文只展示一次（S12）：总结气泡已经承载的正文，汇总卡不再整段重复；
      // 历史回放没有对应气泡时（renderTaskRecord），卡片照常承载。
      append(summaryCard(event.text !== '' && event.text === state.lastChatText
        ? { ...event, text: '' }
        : event))
      state.bubbles.clear()
      state.asks.clear()
      break

    case 'error':
      append(make('p', 'error-line', event.message))
      break

    default:
      break
  }
  scheduleFollowScroll()
}

function handleSubtask(event) {
  const view = state.bubbles.get(event.id) ?? memberMessage(event.agentId, event.id)
  // 成员的真实输出收进调度卡；成员名下待确认的操作也画在同一个结果区里。
  attachToDispatch(view, event)
  mountMemberActions(view, event)
  // 材料行（产出区）：终态事件带 artifacts 时整块重画；undefined（老事件）不动。
  renderMemberMaterials(view, event.artifacts)
  view.status.textContent = STATE_TEXT[event.state] ?? event.state
  view.status.style.color =
    event.state === 'failed' ? 'var(--bt-error)'
      : event.state === 'waiting_user' || event.state === 'external_pending' ? 'var(--bt-warn)'
        : event.state === 'succeeded' ? 'var(--bt-ok)'
          : 'var(--bt-ink-soft)'

  if (event.state === 'dispatched') {
    // 新一次尝试从头开始（S08）：同一子任务重派时清掉上次的预览与终态标记，
    // 旧尝试的迟到增量不串进新版。上一轮交回的材料也一并撤下——它属于被重做的那次尝试。
    view.body = ''
    view.rendered = ''
    view.text.textContent = ''
    view.terminal = false
    view.live = true
    renderMemberMaterials(view, [])
    view.bubble.appendChild(make('div', 'typing')).appendChild(make('i'))
    const typing = view.bubble.querySelector('.typing')
    typing.appendChild(make('i'))
    typing.appendChild(make('i'))
    view.bubble.appendChild(make('div', 'msg__meta', `刚把活交给 ${displayNameOf(event.agentId)}`))
    setRail('work', 'active')
    return
  }

  view.bubble.querySelector('.typing')?.remove()

  if (event.state === 'running') {
    // 有增量正文时不要再塞状态文字，否则会和正文打架。
    if (view.body === '' && event.detail) {
      let line = view.bubble.querySelector('.tool-line')
      if (line === null) {
        line = make('div', 'tool-line')
        view.bubble.appendChild(line)
      }
      clear(line)
      line.appendChild(make('span', null, event.phase === 'tool' ? '正在翻资料：' : ''))
      line.appendChild(make('span', 'tool-line__name', event.tool ?? event.detail))
    } else if (event.tool !== undefined) {
      let line = view.bubble.querySelector('.tool-line')
      if (line === null) {
        line = make('div', 'tool-line')
        view.bubble.appendChild(line)
      }
      clear(line)
      line.appendChild(make('span', null, '正在翻资料：'))
      line.appendChild(make('span', 'tool-line__name', event.tool))
    }
    view.caret.hidden = false
    ensureProgress(view)
    setRail('work', 'active')
    return
  }

  // 到不了 running 往下的都是「不再执行」的状态：光标收起，动态痕迹一次清完（方案 I06）。
  view.caret.hidden = true
  settleMemberDynamics(view, event.state)

  if (event.state === 'waiting_user') {
    view.bubble.classList.add('bubble--wait')
    // 卡片正文用服务端给的正文（`detail`），**不要用 `question`**：问题是请示卡的内容
    // （`askCard` 自己会渲染），混进正文会让"正文"变成一句提问，与刷新后读到的不一样。
    settleMemberBody(view, event.detail)
    // 等你回话不是在计算：链路条给静态的等待态，不再转圈（方案 6.1）。
    setRail('work', 'waiting')
    announce(`${displayNameOf(event.agentId)} 等你回话`)
    askCard(view, event)
    return
  }

  if (event.state === 'external_pending') {
    // 材料交回来了，但还有事在外面办。这里**不给回复入口**：要办的事不在这一页，
    // 让用户在这里写一句话并不能把候选稿采用掉。也不显示成「完成」。
    view.bubble.classList.add('bubble--wait')
    settleMemberBody(view, event.detail)
    view.footer.appendChild(make('div', 'msg__meta', '待外部处理，办好之后可以新开一轮'))
    announce(`${displayNameOf(event.agentId)} 交回材料，还有事待外部处理`)
    return
  }

  if (event.state === 'succeeded') {
    view.bubble.classList.add('bubble--done')
    view.terminal = true
    // 终态正文是权威结论（S09）：成功那一刻按它校准并落成受控 Markdown（C 批）——
    // 丢段或重试残留的预览不会留在页面上；落定前后的布局变化不抢阅读位置（I11）。
    // ⚠️ 用"非空"判断而不是 `??`：服务端给的正文是空串时 `??` 不会回落，卡片会被清空。
    const authoritative = typeof event.detail === 'string' ? event.detail.trim() : ''
    const finalText = authoritative !== '' ? event.detail : view.body
    stabilizeViewport(() => {
      view.text = settleMarkdown(view.text, finalText)
      if (view.progress !== null) {
        view.progress.fill.classList.remove('progress__fill--indeterminate')
        view.progress.fill.style.width = '100%'
        view.progress.label.textContent = '完成'
      }
      // 耗时行也是这次落定的一部分：一并收进钉扎范围，别在补偿之后又顶开视口。
      view.footer.appendChild(make('div', 'msg__meta', `耗时 ${formatElapsed(view.startedAt, event.time)}`))
    })
    view.body = finalText
    return
  }

  if (event.state === 'failed' || event.state === 'cancelled') {
    view.terminal = true
    // classList.add('') 会抛 TypeError（取消态没样式类）：错误文本曾因此漏进线程。
    if (event.state === 'failed') view.bubble.classList.add('bubble--fail')
    /**
     * 正文同样以**服务端那一份**为准（它才是刷新后会重新读到的内容）。
     *
     * 失败/取消时服务端给的 `detail` 是这一轮的结论正文（可能是一句兜底话术），而攒下来的
     * 内容常常只是模型半路说的话——两者不一致正是"刷新前后不一样"的来源之一。
     * 只在服务端什么都没给时，才回落到攒下来的内容，别让卡片空着。
     */
    const settled = settleMemberBody(view, event.detail)
    // 「只看结论」不能把这一行藏掉——那是用户最需要看到的一句话。
    if (settled !== '' && typeof event.detail === 'string' && event.detail.trim() !== '' && event.detail.trim() !== settled) {
      view.bubble.appendChild(make('div', 'msg__meta msg__meta--keep', event.detail))
    }
    announce(event.state === 'failed' ? `${displayNameOf(event.agentId)} 失败：${event.detail ?? '原因不明'}` : `${displayNameOf(event.agentId)} 的活已取消`)
    return
  }
}

/**
 * 一位成员的输出挂进卡片之后，把它名下的待确认操作画出来。
 *
 * 单独一步、两种状态都走它（`external_pending` 与"succeeded 但还有后续待办"）：画的是服务端
 * 给的**全量**列表，所以确认完一张、剩下还在的会自然留下，全部办完则整块消失。
 */
function mountMemberActions(view, event) {
  if (!Array.isArray(event.actions)) return
  // 空清单也要送进 renderActionsInto：它会**清掉**此前挂在名下的卡（会话级清单曾把别的
  // 步骤的卡带进来，结算成功后 own=[] 正是"本步已无卡"的权威信号——不送就残留可点的
  // 死卡，点了提交错步骤 → 404（2026-09-19 两卡 404 的前端根因）。
  renderActionsInto(view, event.actions, { taskId: event.taskId ?? state.taskId ?? '', subtaskId: event.id })
}

/**
 * 请示卡：成员在等你回话时，就地给输入框和两个按钮。
 *
 * 「我来说」把话交回同一位成员；「你看着办」让它自己决定，不再追问。
 */
function askCard(view, event) {
  if (state.asks.has(event.id)) return
  const card = make('div', 'ask')
  // 提问正文也走统一渲染（ask 变体：无图卡——等待卡里出可点缩略图/文件卡是交互噪音）。
  const question = make('div')
  richText(question, event.question ?? event.detail ?? '需要你补充点信息', { variant: 'ask' })
  card.appendChild(question)

  const row = make('div', 'ask__row')
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '补充说明'
  row.appendChild(input)

  const send = make('button', 'btn btn--tiny btn--primary', '我来说')
  send.type = 'button'
  const decide = make('button', 'btn btn--tiny', '你看着办')
  decide.type = 'button'
  row.appendChild(send)
  row.appendChild(decide)
  card.appendChild(row)
  view.footer.appendChild(card)

  const lock = locked => { for (const node of [send, decide, input]) node.disabled = locked }
  // 回话的幂等身份（S07）：同一次回话（含失败后原样重试）复用同一个 ID；用户改了
  // 措辞就是新的一次回话，换新 ID——服务端按 ID 去重，重试不会把同一句话送两遍。
  let replyRequestId = null
  let lastTriedText = null
  const submit = async (text, decideByAgent) => {
    if (state.streaming) return
    // 空文本不提交（方案 I03）：「你看着办」是显式语义，单独走按钮。
    if (!decideByAgent && text === '') { input.focus(); return }
    if (replyRequestId === null || lastTriedText !== text) {
      replyRequestId = newConversationId()
      lastTriedText = text
    }
    lock(true)
    const note = card.appendChild(make('div', 'msg__meta', '正在送出回话…'))
    await runReply({ taskId: event.taskId, subtaskId: event.id, text, decideByAgent, requestId: replyRequestId }, {
      // 受理成功才收起卡片；之前失败都在卡内恢复，输入不丢。
      onAccepted: () => {
        card.remove()
        state.asks.delete(event.id)
        view.bubble.classList.remove('bubble--wait')
      },
      onRejected: error => {
        note.remove()
        lock(false)
        card.appendChild(make('div', 'error-line', `${error instanceof Error && error.message ? error.message : '没送出去'}；输入还在，改一下再试。`))
        input.focus()
      },
    })
  }

  send.addEventListener('click', () => { void submit(input.value.trim(), false) })
  decide.addEventListener('click', () => { void submit('', true) })
  input.addEventListener('keydown', key => {
    if (key.key === 'Enter' && !key.isComposing) {
      key.preventDefault()
      void submit(input.value.trim(), false)
    }
  })
  state.asks.set(event.id, card)
}

function summaryCard(event) {
  const card = make('div', 'summary')
  card.dataset.state = event.state
  const title = event.state === 'completed' ? '已完成'
    : event.state === 'failed' ? '这一轮失败'
      : event.state === 'cancelled' ? '已喊停'
        // 「待外部处理」不是「办完了」：材料在这，那件事还在外面等着。
        : event.state === 'external_pending' ? '材料交回了，还有事在外面等着'
          : event.state === 'partial' ? '部分任务失败，成果已保留'
          : '等你回话'
  card.appendChild(make('div', 'summary__title', title))
  // 正文去重后为空（总结气泡已承载）时不显示占位——那会像「没有结论」。
  // 汇总正文与错误信息都走受控 Markdown（C 批）；同帧排版，不逐字重建。
  if (event.text || event.error) {
    const body = make('div', 'summary__body md')
    richText(body, event.text || event.error, { variant: 'card' })
    card.appendChild(body)
  }
  if (event.error && event.text) card.appendChild(make('div', 'msg__meta', event.error))
  return card
}

/* ── 中栏：空状态 ─────────────────────────────────────────────────────── */

function renderWelcome() {
  clear(el.thread)
  // 告示可撕条（E3 一比一复刻，绘语纯净底版资产）：底色由绘语直接出成均一米白
  // （容器底色对齐图的底色采样值，边缘零色差），标题/说明/撕条文字是真实 DOM
  // ——任何分辨率下文字都清晰，窗口缩放时容器整体等比跟随。
  const box = make('div', 'welcome welcome--board')
  const board = make('div', 'board')
  const top = make('div', 'board__top')
  top.style.backgroundImage = `url(${ROUTE_PREFIX}/assets/media/welcome/clean-top.png)`
  board.appendChild(top)
  const title = make('h2', 'board__title')
  // 红波浪压「做什么」三个字（E3 设计稿的强调方式，砖红）。
  title.appendChild(document.createTextNode('说说你要'))
  title.appendChild(Object.assign(make('span', 'red-wavy'), { textContent: '做什么' }))
  // 标题两侧的竖排批注（E3 设计稿的手写边注，位图纯净底没带，用 DOM 补）。
  board.appendChild(Object.assign(make('p', 'board__note board__note--left'), { textContent: '一些想法，也许就是下一个好的开始。' }))
  board.appendChild(Object.assign(make('p', 'board__note board__note--right'), { textContent: '好的开始，就是把想法说出来。' }))
  const sub = make('p', 'board__sub')
  sub.appendChild(document.createTextNode('查资料、理思路、写文案、做总结'))
  sub.appendChild(make('br'))
  sub.appendChild(document.createTextNode('也可以盯进展、提建议，陪你把事做成'))
  board.appendChild(title)
  board.appendChild(sub)
  const tears = make('div', 'board__tears')
  SUGGESTIONS.forEach((item, index) => {
    const tear = make('button', 'board__tear')
    tear.type = 'button'
    tear.title = item.text
    tear.style.backgroundImage = `url(${ROUTE_PREFIX}/assets/media/welcome/clean-tear-${index + 1}.png)`
    tear.appendChild(make('span', 'board__tear-text', item.text))
    tear.addEventListener('click', () => {
      el.input.value = item.text
      autosize()
      el.input.focus()
    })
    tears.appendChild(tear)
  })
  board.appendChild(tears)
  box.appendChild(board)
  el.thread.appendChild(box)
  renderRail()
}

/* ── 发送与回复 ───────────────────────────────────────────────────────── */

function setBusy(on) {
  state.streaming = on
  el.send.disabled = on
  el.stop.hidden = !on
  el.topStatus.textContent = on ? '正在处理' : '已上线'
  // 只锁发送不锁输入（I02/C 批预编辑）：执行中可以写下一句，输入法组合不受影响；
  // 这句草稿也不会被异步完成、恢复或视图切换清掉——清空只发生在真正送出的那次提交。
  // 提示带红笔批注（空闲态「先听明白需求」红波浪）：固定文案走 DOM 构建，不拼 HTML。
  if (on) el.hint.textContent = '正在处理；下一句可以先写好，这轮完事再发'
  else el.hint.replaceChildren(
    document.createTextNode('牛马大总管'),
    Object.assign(make('span', 'red-wavy'), { textContent: '先听明白需求' }),
    document.createTextNode('，再替你分派成员'),
  )
  // 执行中进设置页的提示随状态同步（方案 I18）。
  el.settingsLive.hidden = !(state.settingsOpen && on)
  el.settingsLive.textContent = state.settingsOpen && on ? '有任务正在执行：回群聊可查看进度或喊停' : ''
}


/**
 * 刷新或重新打开页面时，接上正在跑的那一轮。
 *
 * 关掉页面不再等于取消任务（见服务端 `/events` 的说明），所以「活还在干，页面得能看」
 * 是这套语义的另一半。先问一句有没有在跑的一轮：没有就直接返回，什么都不改 ——
 * 历史照旧由左栏按需渲染，不在这里抢界面，也不为一个没在跑的任务白拉整轮事件。
 *
 * 确认在跑之后才接管中栏，从这一轮的第一条事件重放回来并继续跟随。
 */
async function resumeLiveTurn() {
  const conversationId = recallConversation()
  if (conversationId === null || conversationId === '' || state.streaming) return

  // 探测有网络往返：等回包的这段时间里用户可能已经打开了别的会话或发起了新消息。
  // 先记下当前视图代次，回包后复核——不是当前视图就不接管（方案 I09）。
  const tokenAtProbe = state.viewToken
  let head
  try {
    head = await eventsHead(conversationId)
  } catch (error) {
    if (tokenAtProbe !== state.viewToken) return
    // 接续检查失败不能静默吞掉（方案 S04）：用户会以为一切正常，其实连不上。
    append(make('p', 'error-line', `接续检查失败：${error instanceof Error ? error.message : '网络异常'}；刷新页面可重试`))
    return
  }
  if (head === null || head.state !== 'running') return
  if (tokenAtProbe !== state.viewToken || state.streaming) return

  const controller = new AbortController()
  // 接管视图：作废之前还在路上的历史读取回包，它们的结论属于旧视图。
  state.viewToken += 1
  state.conversationId = conversationId
  state.abort = controller
  clear(el.thread)
  threadInner()
  state.bubbles.clear()
  state.asks.clear()
  resetRail()
  resetFollowing()
  setBusy(true)
  // 只读订阅接续：reset 时按快照校准并从窗口头续订，断线有界重订（S05/S06）。
  try {
    await followUntilTerminal(conversationId, { from: 0, expectedRunId: head.runId, signal: controller.signal })
  } catch (error) {
    reportFailure(error, '接续正在执行的任务失败')
  } finally {
    finishTurn()
  }
}

/* ── 待发附件 ──────────────────────────────────────────────────────────── */
/**
 * 附件的三个来源最后都落到同一个地方：**一份服务端记录**。
 *
 * - 选文件 / 拖进来 / 粘贴文件 → `uploadAttachment`（裸字节 POST）；
 * - 粘链接 → `attachFromUrl`（服务端去抓，页面不管地址合不合法、能跳几跳、多大）。
 *
 * 页面自己不解析文件、不判断类型：那些规则只有一处实现才不会两边不一致。页面只负责把
 * "上传中 / 就绪 / 读不出来"画出来，以及把用户的选择如实送出去。
 */

/** 页面的附件身份。上传中还没有服务端 id，所以不能拿 id 当键。 */
function attachmentKey() {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 字节数的人话说法；与服务端 `sizeText` 同一口径。 */
function fileSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 一条附件的状态行文字。空串表示"没什么要说的"。 */
function attachmentNote(entry) {
  if (entry.phase === 'uploading') return entry.message === '' ? '上传中…' : entry.message
  if (entry.phase === 'failed') return entry.message === '' ? '没成' : entry.message
  return entry.message
}

function attachmentChip(entry) {
  const chip = make('span', 'attach__item')
  chip.dataset.phase = entry.phase
  chip.appendChild(make('span', 'attach__name', entry.name))
  const size = fileSizeText(entry.size)
  if (size !== '') chip.appendChild(make('span', 'attach__size', size))
  const note = attachmentNote(entry)
  if (note !== '') chip.appendChild(make('span', 'attach__note', note))
  const remove = make('button', 'attach__remove', '×')
  remove.type = 'button'
  remove.title = '移除'
  remove.setAttribute('aria-label', `移除 ${entry.name}`)
  remove.addEventListener('click', () => { void dropAttachment(entry.key) })
  chip.appendChild(remove)
  return chip
}

/** 附件条为空时整块收起来，不白占输入框上方的地方。 */
function syncAttachStrip() {
  el.attachStrip.hidden = state.attachments.length === 0 && el.attachUrl.hidden
}

function renderAttachments() {
  clear(el.attachItems)
  for (const entry of state.attachments) el.attachItems.appendChild(attachmentChip(entry))
  syncAttachStrip()
}

/** 把已经发出去的那几条画在用户消息下面：发完就从输入框挪到消息里，不留一份重复的。 */
function attachmentChipsRow(entries) {
  const row = make('div', 'attach attach--sent')
  const items = make('div', 'attach__items')
  for (const entry of entries) items.appendChild(attachmentChip({ ...entry, phase: 'ready' }))
  row.appendChild(items)
  return row
}

/** 收下服务端回来的那条记录；期间附件被移除时结果直接丢弃。 */
function settleAttachment(key, item) {
  const current = state.attachments.find(value => value.key === key)
  if (current === undefined) return
  current.item = item
  current.name = item.name
  current.size = item.bytes
  current.message = item.message ?? ''
  // 服务端说读不出内容（`failed`）时页面照实标出来：它还是能交出去的，只是管家看不到里面写了什么。
  current.phase = item.status === 'ready' ? 'ready' : 'failed'
  renderAttachments()
}

function failAttachment(key, message) {
  const current = state.attachments.find(value => value.key === key)
  if (current === undefined) return
  current.phase = 'failed'
  current.message = message
  renderAttachments()
}

/** 还能再收几个。上限是服务端配置，页面只跟着它走。 */
function attachmentRoom() {
  return MAX_ATTACHMENTS_PER_MESSAGE - state.attachments.length
}

/**
 * 收下一批文件。
 *
 * **一次只传一个**（按选择顺序）：并发上传时服务端那边的"待发附件"计数会被几个请求同时读到
 * 同一个旧值，多出来的会被 413 拒掉，而页面上的失败顺序还跟选择顺序对不上。
 */
async function addFiles(files) {
  const list = [...files]
  if (list.length === 0) return
  const room = attachmentRoom()
  if (room <= 0) {
    reportFailure(new Error(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`), '没加上')
    return
  }
  for (const file of list.slice(0, room)) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      state.attachments.push({
        key: attachmentKey(), name: file.name, size: file.size, phase: 'failed',
        message: `超过 ${fileSizeText(MAX_ATTACHMENT_BYTES)}`, item: null,
      })
      renderAttachments()
      continue
    }
    const entry = { key: attachmentKey(), name: file.name, size: file.size, phase: 'uploading', message: '', item: null }
    state.attachments.push(entry)
    renderAttachments()
    try {
      settleAttachment(entry.key, await uploadAttachment(file, state.conversationId ?? ''))
    } catch (error) {
      failAttachment(entry.key, error instanceof Error && error.message ? error.message : '上传失败')
    }
  }
  if (list.length > room) {
    reportFailure(new Error(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件，多出来的没有加`), '没全加上')
  }
}

/** 从一个链接取回附件。地址的合法性由服务端判断，页面只做"看起来是不是个 http 地址"的预检。 */
async function addUrl(raw) {
  const url = raw.trim()
  if (url === '') return
  if (!/^https?:\/\/\S+$/iu.test(url)) {
    reportFailure(new Error('只支持 http 或 https 链接'), '没取回来')
    return
  }
  if (attachmentRoom() <= 0) {
    reportFailure(new Error(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`), '没取回来')
    return
  }
  const entry = { key: attachmentKey(), name: url, size: 0, phase: 'uploading', message: '取回中…', item: null }
  state.attachments.push(entry)
  renderAttachments()
  try {
    settleAttachment(entry.key, await attachFromUrl(url, state.conversationId ?? ''))
  } catch (error) {
    failAttachment(entry.key, error instanceof Error && error.message ? error.message : '取回失败')
  }
}

/** 移除一条。有服务端记录的顺手通知服务端删掉；删不掉也不假装成功，下次刷新它还会出现。 */
async function dropAttachment(key) {
  const index = state.attachments.findIndex(value => value.key === key)
  if (index < 0) return
  const [entry] = state.attachments.splice(index, 1)
  renderAttachments()
  if (entry.item === null) return
  try {
    await api.removeAttachment(entry.item.id)
  } catch { /* 服务端没删掉：那是服务端的事实，下次打开会话它会回来。 */ }
}

/** 这一轮要带上的附件 id：只带服务端已经收下、而且读得出内容的那几条。 */
function attachmentsForSend() {
  return state.attachments
    .filter(entry => entry.item !== null && entry.item.status === 'ready')
    .map(entry => entry.item.id)
}

/** 发送时把已经交出去的那几条从输入框上摘掉（它们随即画到用户消息下面）。 */
function takeSentAttachments(ids) {
  const sent = new Set(ids)
  const taken = state.attachments.filter(entry => entry.item !== null && sent.has(entry.item.id))
  state.attachments = state.attachments.filter(entry => !(entry.item !== null && sent.has(entry.item.id)))
  renderAttachments()
  return taken
}

function clearAttachments() {
  state.attachments = []
  renderAttachments()
}

function hideAttachUrl() {
  el.attachUrl.hidden = true
  el.attachUrlInput.value = ''
  syncAttachStrip()
}

/**
 * 从服务端重建附件条。
 *
 * 附件是服务端的事实，不是页面的内存：刷新、换个入口、另一台设备打开同一个会话，看到的都该是
 * 同一份"还没发出去的文件"。
 */
async function loadAttachments() {
  const conversationId = state.conversationId
  clearAttachments()
  if (conversationId === null) return
  try {
    const { items } = await api.attachments(conversationId)
    // 期间切了会话：这份结果作废，不许写进新视图。
    if (state.conversationId !== conversationId) return
    state.attachments = (items ?? []).map(item => ({
      key: attachmentKey(),
      name: item.name,
      size: item.bytes,
      phase: item.status === 'ready' ? 'ready' : 'failed',
      message: item.message ?? '',
      item,
    }))
    renderAttachments()
  } catch { /* 读不到就当没有待发附件：不因为这一条失败挡住整个页面。 */ }
}

/**
 * 附件入口：回形针、链接、拖拽、粘贴。
 *
 * 拖拽区挂在**整块输入区**（`el.composer`）上，不是只挂那个按钮：用户拖文件时瞄的是"输入框
 * 那一片"，而按钮只有二十几像素宽，要求精确落在它上面等于让功能时灵时不灵。
 */
function bindAttachments() {
  el.attachButton.addEventListener('click', () => { el.attachInput.click() })
  el.attachInput.addEventListener('change', () => {
    const files = [...(el.attachInput.files ?? [])]
    // 清空 value：同一个文件选第二次也要能触发 change，否则第二次什么都不发生。
    el.attachInput.value = ''
    void addFiles(files)
  })

  el.attachLinkButton.addEventListener('click', () => {
    el.attachUrl.hidden = false
    syncAttachStrip()
    el.attachUrlInput.focus()
  })
  el.attachUrlCancel.addEventListener('click', () => { hideAttachUrl() })
  el.attachUrlInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      hideAttachUrl()
      return
    }
    if (event.key !== 'Enter' || event.isComposing) return
    // 回车是"取回这个链接"，不是"发送"：这里只是在填一个链接，不该把还没写完的消息发出去。
    event.preventDefault()
    const url = el.attachUrlInput.value
    hideAttachUrl()
    void addUrl(url)
  })

  el.composer.addEventListener('dragover', event => {
    if (event.dataTransfer?.types?.includes('Files') !== true) return
    event.preventDefault()
    el.composer.classList.add('composer--drop')
  })
  el.composer.addEventListener('dragleave', event => {
    // 在子元素之间移动也会触发 dragleave：只有真的离开整块区域时才撤掉反馈。
    const next = event.relatedTarget
    if (next !== null && next instanceof Node && el.composer.contains(next)) return
    el.composer.classList.remove('composer--drop')
  })
  el.composer.addEventListener('drop', event => {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    el.composer.classList.remove('composer--drop')
    void addFiles(files)
  })

  // 粘贴：截图与复制过来的文件走同一条路。纯文字粘贴不拦——用户很可能就是在贴一段话。
  el.composer.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    void addFiles(files)
  })
}

async function sendMessage(text, reuseRequestId) {
  const trimmed = text.trim()
  if (trimmed === '' || state.streaming) return
  const fresh = state.conversationId === null
  if (fresh) state.conversationId = newConversationId()
  // 同一会话的新回合追加在原线程后面；只有第一次发送（或欢迎页还在）才换新视图（方案 I01）。
  if (fresh || el.thread.querySelector('.welcome') !== null) {
    state.viewToken += 1
    clear(el.thread)
    threadInner()
  }
  // 无论换不换视图，提交就回到跟随：用户发出的话和这一轮的回复要出现在眼前，
  // 不能沿用上次读完历史留下的暂停状态（浏览器复验发现的缺口）。
  resetFollowing()
  // 回合级状态每轮都换新：链路条不能带着上一轮的进度开跑，runId 也要清——
  // 新请求未收到回执就断流时，不能还顶着上一轮的身份去跟随（B 轮会接错 A 轮）。
  state.bubbles.clear()
  state.asks.clear()
  state.lastSeq = 0
  state.lastRunTaskId = ''
  state.lastRunId = ''
  resetRail()
  setRail('parse', 'active')
  setBusy(true)
  state.abort = new AbortController()
  // 提交幂等身份（S07）：同一次提交的重试复用，新的提交换新 ID——服务端按它认出
  // 「同一句话」，重试不会把活再派一遍。
  const requestId = reuseRequestId ?? newConversationId()
  // 这一轮带的附件。**空数组也照发**：老客户端不带这个字段，服务端按"没有附件"处理，
  // 与加这个功能之前逐字一致。
  const attachmentIds = attachmentsForSend()
  el.input.value = ''
  autosize()
  // 提交内容先就地呈现，配一行「正在发送」：受理与否是服务端事实，客户端不编（方案 S03）。
  const bubble = userMessage(trimmed, Date.now())
  // 附件随用户消息一起出现：它们和这句话是同一件事，分开放会让人以为文件还没交出去。
  const sentEntries = attachmentIds.length === 0 ? [] : takeSentAttachments(attachmentIds)
  if (sentEntries.length > 0) {
    const column = bubble.querySelector('.msg__col')
    const meta = column?.querySelector('.msg__meta')
    if (column !== null && meta !== null) column.insertBefore(attachmentChipsRow(sentEntries), meta)
    hideAttachUrl()
  }
  const note = append(make('p', 'msg__meta', '正在发送…'))
  state.pendingUser = { text: trimmed, bubble }
  let sawTerminal = false
  try {
    for await (const event of chat({ conversationId: state.conversationId, message: trimmed, requestId, attachmentIds, signal: state.abort.signal })) {
      if (event.type === 'summary') sawTerminal = true
      consumeTurnEvent(event, note)
    }
    state.pendingUser = null
    if (note.isConnected) note.remove()
    // 连接自然结束但终态没来（S06）：断连窗口里可能已收尾或仍在跑，跟到终态为止。
    if (!sawTerminal && state.abort.signal.aborted === false) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } catch (error) {
    if (note.isConnected) note.remove()
    if (state.pendingUser !== null) {
      // 还没受理就失败了：草稿回到输入框（用户后来打过字就不覆盖），并给出重试入口；
      // 重试复用同一个 requestId，不会把活再派一遍。附件也一并退回输入框上方——它们确实还没交出去。
      state.pendingUser = null
      if (el.input.value.trim() === '') { el.input.value = trimmed; autosize() }
      if (sentEntries.length > 0) {
        state.attachments = [...sentEntries, ...state.attachments]
        renderAttachments()
      }
      retryEntry(trimmed, error instanceof Error && error.message ? error.message : '没送出去', bubble, requestId)
    } else {
      // 已受理后连接断掉：这一轮还在服务端跑，重订事件流跟到终态，不自动重发。
      reportFailure(error, '发送失败')
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
    scheduleFollowScroll()
  } finally {
    finishTurn()
  }
}

/** 提交失败后的重试入口：撤掉失败的痕迹，原样重发同一句话（同一幂等身份）。 */
function retryEntry(text, message, staleBubble, requestId) {
  const row = make('div', 'error-line error-line--retry')
  row.appendChild(make('span', null, `${message}。`))
  const button = make('button', 'btn btn--tiny', '重试')
  button.type = 'button'
  button.addEventListener('click', () => {
    staleBubble?.remove()
    row.remove()
    void sendMessage(text, requestId)
  })
  row.appendChild(button)
  append(row)
}

/**
 * 把一条操作决策交给服务端，并跟完这一轮（与 `runReply` 同一条消费路径）。
 *
 * 差别只在事件源：`act` 送的是一个结构化决策，服务端受理之后执行在后台跑，这条连接只把事件
 * 推回来。**不受理任何凭据**：卡片上只有呈现数据，执行方从自己的记录里取确认凭据。
 */
async function runAct(input) {
  setBusy(true)
  state.abort = new AbortController()
  state.lastSeq = 0
  state.lastRunId = ''
  resetFollowing()
  let accepted = false
  let sawTerminal = false
  try {
    for await (const event of act({ ...input, signal: state.abort.signal })) {
      if (event.type === 'summary') sawTerminal = true
      traceEvent('receive', event)
      accepted = true
      consumeTurnEvent(event)
    }
    if (!sawTerminal && accepted && state.abort.signal.aborted === false && state.conversationId !== null) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } finally {
    finishTurn()
  }
}

async function runReply(input, hooks = {}) {
  setBusy(true)
  state.abort = new AbortController()
  // 与 sendMessage 同一套回合重置：runId 不清会让新一轮回话顶着上一轮的身份；
  // 回话也回到跟随，用户要看到成员接下来的答复。
  state.lastSeq = 0
  state.lastRunId = ''
  resetFollowing()
  let accepted = false
  let sawTerminal = false
  try {
    for await (const event of reply({ ...input, signal: state.abort.signal })) {
      if (event.type === 'summary') sawTerminal = true
      traceEvent('receive', event)
      if (!accepted) {
        accepted = true
        // 受理确认：请示卡到这一步才收起，之前失败都还能改（方案 I03）。
        hooks.onAccepted?.()
      }
      consumeTurnEvent(event)
    }
    // 与提交同一条恢复路径（S06）：没看到终态就跟到终态。
    if (!sawTerminal && accepted && state.abort.signal.aborted === false && state.conversationId !== null) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } catch (error) {
    reportFailure(error, '回复没送出去')
    if (!accepted) hooks.onRejected?.(error)
    else if (state.conversationId !== null && state.abort.signal.aborted === false) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } finally {
    finishTurn()
  }
}

function reportFailure(error, fallback) {
  if (error?.name === 'AbortError') {
    // 连接被本地中断只说明「不再观察」，不等于任务停了；终态以服务端事件为准。
    append(make('p', 'error-line', '连接已中断，这一轮是否结束以右栏状态为准。'))
    return
  }
  append(make('p', 'error-line', error instanceof Error && error.message ? error.message : fallback))
}

/* ── 恢复一致性（B 批 S05/S06/S09/S12）────────────────────────────────── */

/**
 * 消费一条本轮事件：更新游标与任务标识，正文/汇总按现有分发渲染。
 * 三条流（提交、回话、只读接续）共用，保证断线重订时游标口径只有一份。
 */
function consumeTurnEvent(event, note) {
  traceEvent('receive', event)
  if (event.type === 'run') {
    // 新一轮开始：seq 空间按轮重置，游标跟着归零；runId 是断线重订的「预期对象」，
    // 必须在消费回执时记下——没有它，重订无法证明跟随的还是原受理的那一轮。
    state.lastSeq = 0
    state.lastRunId = event.runId
    if (event.taskId) state.lastRunTaskId = event.taskId
  }
  if (event.seq !== undefined) state.lastSeq = event.seq
  if (event.type === 'subtask' && event.taskId) state.lastRunTaskId = event.taskId
  if (event.type === 'plan' && event.taskId) state.lastRunTaskId = event.taskId
  if (note !== null && note !== undefined) {
    // 受理确认只推进占位；正文、计划或异常到达才撤（方案 S03）。run/reset 是流元事件，
    // 不代表「已经有内容」——B 批曾让 run 误撤占位，退回了 A 批修过的行为。
    if (event.type === 'conversation') {
      note.textContent = '正在理解目标…'
      announce('已受理，正在安排')
    }
    else if (event.type !== 'user' && event.type !== 'run' && event.type !== 'reset') note.remove()
  }
  handleEvent(event)
  if (streamTraceEnabled) requestAnimationFrame(() => traceEvent('draw', event))
}

/**
 * 按服务端快照校准终态（S06/S09）：断连期间这轮可能已经收尾，权威结论在任务记录里。
 * 快照只在没消费到 summary 时补一张终态卡，不重放整条线程（那会重复已显示的内容）。
 * 读取挂调用方的截止信号：整个恢复过程共用一个硬期限。
 */
async function calibrateFromSnapshot(conversationId, stop) {
  try {
    if (state.lastRunTaskId === '') return
    const record = await api.task(state.lastRunTaskId, stop)
    if (record.conversationId !== conversationId) return
    if (!['completed', 'failed', 'cancelled', 'partial'].includes(record.state)) return
    applySummaryRail(record.state)
    append(summaryCard({ state: record.state, text: record.summary, error: record.error }))
    scheduleFollowScroll()
  } catch { /* 快照拿不到就保持现状：已有内容不因校准失败而清空。 */ }
}

/**
 * 按快照**重建**一轮还在跑的任务（S05 reset 校准）。
 *
 * 之前这里只处理终态：运行中的快照直接返回，随后却把游标推进到窗口头——尚未恢复的
 * 成员状态、正文和引用全被跳过。现在运行中同样重建：线程按快照重画，等待中的成员
 * 重新拿到回复入口，游标以重建时点之后的窗口头为准（快照读取到重订之间存在极小的
 * 事件窗口，由随后的事件逐步覆盖，不假装无缝）。读取同样挂截止信号。
 */
async function rebuildFromSnapshot(conversationId, stop) {
  try {
    if (state.lastRunTaskId === '') return null
    const record = await api.task(state.lastRunTaskId, stop)
    if (record.conversationId !== conversationId) return null
    state.viewToken += 1
    clear(el.thread)
    threadInner()
    state.bubbles.clear()
    state.asks.clear()
    resetRail()
    renderTaskRecord(record, { liveResume: true })
    resetFollowing()
    scrollToBottom()
    return record
  } catch {
    append(make('p', 'error-line', '按快照重建失败；已收到的内容保留，终态以右栏为准。'))
    return null
  }
}

/**
 * 只读跟随一轮事件直到终态（S05/S06）：断线重订、reset 后按快照重建再从窗口头续订、
 * 无终态结束时按运行状态选择重订或按快照补终态卡。全部复用现有 /events 与 /task 接口。
 *
 * 不混轮次：跟随对象由 `expectedRunId` **预先指定**（本轮 run 头的消费回执或恢复探测）。
 * 没有回执时不跟随——探测到的「当前最新一轮」无法证明属于原提交，归属未知就如实
 * 说明，不把别人的轮次接进本次视图。重放的旧 seq 直接丢弃；快照读取失败不推进游标，
 * 保留原位按预算重试。
 * 硬期限：订阅、探测、快照读取与退避共用同一个截止信号（AbortSignal.any 组合调用方
 * 取消与剩余期限），悬挂中的任何一步到期即中止，退避可被截止提前唤醒；预算（2s 起、
 * 封顶 4s、最多 4 次、总长 120s）耗尽后如实放弃，不无限重试。
 */
async function followUntilTerminal(conversationId, { from, expectedRunId, signal }) {
  let after = from
  if (expectedRunId === undefined || expectedRunId === '') {
    // 归属未知（例如提交流断在 run 头之前）：明确说明并按快照尽量收尾，
    // 不用「当前最新一轮」冒充原受理。
    append(make('p', 'msg__meta', '这次提交的受理回执没有收到，无法确认还在跑的那一轮是否属于它；结果请以右栏任务记录为准。'))
    return
  }
  const followedRunId = expectedRunId
  const deadline = Date.now() + 120000
  let reconnects = 0
  const giveUp = () => { append(make('p', 'error-line', '事件流已断开；已收到的内容保留，终态以右栏为准。')) }
  // 可中断退避：截止或取消提前唤醒；进入时信号已取消则立即退出，不空等计时器。
  // timer 先声明再赋值：done 可能被同步调度器立即调用，不能踩到初始化之前。
  const backoff = stop => new Promise(resolve => {
    if (stop.aborted) { resolve(); return }
    let timer
    const done = () => { clearTimeout(timer); stop.removeEventListener('abort', done); resolve() }
    timer = setTimeout(done, Math.min(1000 * 2 ** reconnects, 4000))
    stop.addEventListener('abort', done, { once: true })
  })
  for (;;) {
    let sawTerminal = false
    let sawReset = false
    // 截止信号：每轮按剩余期限重建，取消与到期都能中断订阅、探测与快照读取。
    const remaining = deadline - Date.now()
    if (remaining <= 0) { giveUp(); return }
    const timeout = AbortSignal.timeout(remaining)
    const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      for await (const event of events({ conversationId, after, signal: stop })) {
        if (event.type === 'run') {
          // 轮次边界：与预期不符（服务端已换轮）立即按快照收尾，不消费新轮任何事件。
          if (event.runId !== followedRunId) {
            await calibrateFromSnapshot(conversationId, stop)
            return
          }
          state.lastSeq = 0
          if (event.taskId) state.lastRunTaskId = event.taskId
          continue
        }
        if (event.type === 'reset') {
          // 滚出窗口的事件补不回来：按快照重建（运行中同样重建），再从窗口头续订。
          sawReset = true
          continue
        }
        // 不混轮次：别的轮次的重放事件不应用；同一轮内重放的旧序号直接丢弃。
        if (event.runId !== undefined && event.runId !== followedRunId) continue
        if (event.seq !== undefined) {
          if (after > 0 && event.seq <= after) continue
          after = event.seq
        }
        if (event.type === 'summary') sawTerminal = true
        consumeTurnEvent(event)
      }
      if (sawTerminal) return
      const head = await eventsHead(conversationId, stop)
      if (head === null || head.state !== 'running') {
        // 连接自然结束但没看到终态：终态多半在断连窗口里发生，按快照补结论（S06）。
        await calibrateFromSnapshot(conversationId, stop)
        return
      }
      if (head.runId !== followedRunId) {
        // 跟随的那一轮已被新的一轮接替：按快照收尾，不把新轮内容混进本次视图。
        await rebuildFromSnapshot(conversationId, stop)
        return
      }
      if (sawReset) {
        // 重建要用快照：任务标识从探测头部取——reset 流本身不带 run 头（浏览器实测发现），
        // 刷新接续时 lastRunTaskId 还是空，不补这一步重建会空转。
        if (head.taskId) state.lastRunTaskId = head.taskId
        const rebuilt = await rebuildFromSnapshot(conversationId, stop)
        // 快照读取失败不推进游标：保留原位，本轮按预算退避后重试重建（重订还会得到
        // reset，重建再次尝试）；只有重建成功才对齐到探测头部的窗口位置。重建成功后
        // 从 head.seq 续订——探测与重建之间产生的事件 seq 必然更大，续订会带上，
        // 不丢也不重复重放（head.seq 之前的事件不重放）。
        if (rebuilt !== null) after = head.seq
      }
    } catch (error) {
      if (signal?.aborted) return
      if (error?.name === 'AbortError') {
        if (timeout.aborted) { giveUp(); return }
        continue
      }
    }
    // 自然 EOF 后仍在跑（或断线）：同一份退避预算，不因「流正常结束」就零等待重连。
    reconnects += 1
    if (reconnects >= 4 || Date.now() > deadline) {
      giveUp()
      return
    }
    await backoff(stop)
    if (stop.aborted && !signal?.aborted) { giveUp(); return }
  }
}

async function finishTurn() {
  setBusy(false)
  state.abort = null
  await refreshPanels()
  void refreshChatList()
  // 异步结束不抢焦点（方案 I05）：只在用户仍停留在会话区域时回到输入框；
  // 正在设置页、开着抽屉或选着字，都保持他现在的位置。
  const active = document.activeElement
  // 链路条节点已从页面移除（UI 重设计）：el.rail 为 null，contains 前必须判空。
  const inConversationArea = active === null || active === document.body
    || el.composer.contains(active) || el.thread.contains(active) || (el.rail !== null && el.rail.contains(active))
  const selection = document.getSelection()
  const selecting = selection !== null && !selection.isCollapsed
  if (!state.settingsOpen && document.body.dataset.drawer !== 'open' && document.body.dataset.sidebar !== 'open'
    && !selecting && inConversationArea) el.input.focus()
}

/* ── 右栏 ─────────────────────────────────────────────────────────────── */

/** 右栏的紧凑成员行：只看是谁；改名换脸去设置页。名单上的人都能接活，所以这里**没有状态**。 */
function renderMembers() {
  clear(el.memberList)
  if (state.members.length === 0) {
    el.memberList.appendChild(make('p', 'empty', '还没有可分派的成员。'))
    return
  }
  for (const member of state.members) {
    const row = make('div', 'member member--compact')
    row.appendChild(avatarNode(member.agentId, 'sm'))
    const col = make('div', 'member__col')
    col.appendChild(make('div', 'member__name', member.displayName))
    col.appendChild(make('div', 'member__declared', member.declaredName))
    row.appendChild(col)
    row.title = `${member.displayName}（@${member.agentId}）`
    el.memberList.appendChild(row)
  }
}

/* ── 设置页 ───────────────────────────────────────────────────────────── */

/**
 * 设置卡片的局部视图（方案 I14/I15/I16）：外号与配色是**草稿**，显式保存才提交；
 * 头像上传是独立动作。每张卡自带状态行（未保存 / 保存中 / 已保存 / 失败），保存或换脸
 * 只更新自己这张卡，不再整页重建——其他卡里没保存的输入不会被冲掉。
 */
const settingsCards = new Map()

function renderSettingsMembers() {
  clear(el.settingsMembers)
  settingsCards.clear()
  if (state.members.length === 0) {
    el.settingsMembers.appendChild(make('p', 'empty', '还没有可分派的成员。'))
    return
  }
  for (const member of state.members) el.settingsMembers.appendChild(buildSettingsCard(member))
}

/** 卡内状态行：kind 决定配色，文本给人看。 */
function setCardStatus(view, kind, text) {
  view.status.dataset.kind = kind
  view.status.textContent = text
  view.status.hidden = text === ''
}

/**
 * 草稿变更：递增版本号（保存回包按它核对），状态行如实回落到「未保存」——
 * 包括刚显示「已保存/失败」之后再次编辑的情况（复核 1）；保存中不打断文案。
 */
function markCardDirty(view) {
  view.draftVersion += 1
  view.dirty = true
  if (view.status.dataset.kind !== 'busy') setCardStatus(view, 'dirty', '未保存的改动')
}

/** 保存一张卡的外号与配色：按**提交时的草稿版本**确认（复核 1）。 */
async function saveMemberCard(agentId) {
  const view = settingsCards.get(agentId)
  if (view === undefined || view.busy) return
  // 只提交发起那一刻的草稿；保存期间用户继续编辑不中断、也不会被回包吞掉。
  const submittedName = view.nameInput.value
  const submittedAccent = view.pendingAccent ?? accentOf(agentId)
  const submittedVersion = view.draftVersion
  view.busy = true
  view.save.disabled = true
  setCardStatus(view, 'busy', '保存中…可以先继续改')
  try {
    const result = await api.setAlias(agentId, submittedName, submittedAccent)
    state.members = result.items
    view.save.disabled = false
    // 基线更新到已提交的那版：标题跟提交值对齐。
    view.titles.replaceChildren(
      make('div', 'member__name', displayNameOf(agentId)),
      make('div', 'member__declared', `插件声明：${declaredNameOf(agentId)}`),
    )
    if (view.draftVersion === submittedVersion) {
      // 回包时草稿还停在提交版本：这次保存覆盖了全部改动，状态干净。
      view.pendingAccent = null
      view.dirty = false
      for (const [color, swatch] of view.swatches) swatch.setAttribute('aria-pressed', String(submittedAccent.toLowerCase() === color))
      setCardStatus(view, 'ok', '已保存')
      announce(`已保存 ${displayNameOf(agentId)} 的设置`)
    } else {
      // 保存期间又改了：刚提交的已存上，但新改动仍是未保存草稿（配色草稿保留）；
      // 色块选中态跟**当前草稿**对齐，不能被提交值覆盖（复核 1：选中态与草稿不一致）。
      view.dirty = true
      const draftAccent = view.pendingAccent ?? accentOf(agentId)
      for (const [color, swatch] of view.swatches) swatch.setAttribute('aria-pressed', String(draftAccent.toLowerCase() === color))
      setCardStatus(view, 'dirty', '刚提交的已存上；之后的新改动还没保存')
    }
    // 右栏与头像栏的公共投影照旧重画：它们不在设置页里，没有草稿可丢。
    renderMembers()
    renderCrew()
  } catch (error) {
    view.save.disabled = false
    setCardStatus(view, 'error', `没保存成功：${error instanceof Error && error.message ? error.message : '网络异常'}；改动还在，再试一次`)
  } finally {
    view.busy = false
  }
}

/** 头像上传/删除/内置换脸共用：卡内状态 + 本卡头像位刷新，不重建列表。 */
async function runAvatarAction(agentId, action, doing, done) {
  const view = settingsCards.get(agentId)
  if (view !== undefined) setCardStatus(view, 'busy', doing)
  try {
    await action()
    if (view !== undefined) {
      view.avatarSlot.replaceChildren(avatarNode(agentId, 'lg'))
      setCardStatus(view, 'ok', done)
    }
    renderMembers()
    renderCrew()
    announce(done)
  } catch (error) {
    if (view !== undefined) {
      setCardStatus(view, 'error', `${done}没成：${error instanceof Error && error.message ? error.message : '再试一次'}`)
    }
  }
}

function buildSettingsCard(member) {
  const agentId = member.agentId
  const card = make('div', 'set-card')
  card.dataset.agentId = agentId

  const head = make('div', 'set-card__head')
  const avatarWrap = make('div', 'member__avatar')
  const avatarSlot = make('div', 'member__avatar-slot')
  avatarSlot.appendChild(avatarNode(agentId, 'lg'))
  // 相机是按钮不是贴纸（方案 I16）：键盘可达、有名字。
  const camera = make('button', 'member__camera', '📷')
  camera.type = 'button'
  camera.title = '换头像'
  camera.setAttribute('aria-label', `给 ${displayNameOf(agentId)} 换头像`)
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = 'image/png,image/jpeg,image/webp'
  picker.className = 'visually-hidden'
  picker.setAttribute('aria-hidden', 'true')
  picker.tabIndex = -1
  camera.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    const file = picker.files?.[0]
    if (file) void runAvatarAction(agentId, async () => {
      await uploadAvatar(agentId, file)
      state.avatarStamps.set(agentId, Date.now())
    }, '上传中…', '头像已更新')
    picker.value = ''
  })
  avatarWrap.appendChild(avatarSlot)
  avatarWrap.appendChild(camera)
  avatarWrap.appendChild(picker)
  head.appendChild(avatarWrap)

  const titles = make('div', 'set-card__titles')
  titles.appendChild(make('div', 'member__name', member.displayName))
  titles.appendChild(make('div', 'member__declared', `插件声明：${member.declaredName}`))
  head.appendChild(titles)
  card.appendChild(head)

  // 外号输入与 label 关联（方案 I16）：读屏点「外号」就能落进输入框。
  const nameField = make('div', 'field')
  const nameLabel = make('label', null, '外号')
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.maxLength = 24
  nameInput.id = `alias-${agentId}`
  nameInput.value = member.displayName
  nameInput.placeholder = member.declaredName
  nameLabel.setAttribute('for', nameInput.id)
  nameField.appendChild(nameLabel)
  nameField.appendChild(nameInput)
  card.appendChild(nameField)

  // 配色只改草稿（方案 I15）：点选高亮未保存状态，与外号一起显式保存，
  // 不再携带未保存的外号立即提交。
  const colorField = make('div', 'field')
  const colorLabel = make('label', null, '配色')
  colorField.appendChild(colorLabel)
  const swatches = make('div', 'swatches')
  const swatchViews = new Map()
  for (const color of PALETTE) {
    const swatch = make('button', 'swatch')
    swatch.type = 'button'
    swatch.style.background = color
    swatch.setAttribute('aria-pressed', String(accentOf(agentId).toLowerCase() === color))
    swatch.title = color
    swatch.addEventListener('click', () => {
      view.pendingAccent = color
      for (const [each, node] of swatchViews) node.setAttribute('aria-pressed', String(each === color))
      markCardDirty(view)
    })
    swatchViews.set(color, swatch)
    swatches.appendChild(swatch)
  }
  colorField.appendChild(swatches)
  card.appendChild(colorField)

  const builtinField = make('div', 'field')
  const builtinLabel = make('label', null, '内置头像')
  builtinField.appendChild(builtinLabel)
  const strip = make('div', 'builtin-strip')
  for (const item of BUILTIN_AVATARS) {
    const pick = make('button', 'builtin-strip__item')
    pick.type = 'button'
    pick.title = item.label
    pick.setAttribute('aria-label', `换上${item.label}头像`)
    const thumb = document.createElement('img')
    thumb.alt = ''
    thumb.loading = 'lazy'
    thumb.src = `${ROUTE_PREFIX}/assets/media/avatars/builtin/${item.file}`
    pick.appendChild(thumb)
    pick.addEventListener('click', () => {
      void runAvatarAction(agentId, async () => {
        const response = await fetch(`${ROUTE_PREFIX}/assets/media/avatars/builtin/${item.file}`)
        if (!response.ok) throw new Error('内置头像读取失败')
        const blob = await response.blob()
        await uploadAvatar(agentId, new File([blob], item.file, { type: 'image/png' }))
        state.avatarStamps.set(agentId, Date.now())
      }, '换头像中…', '头像已更新')
    })
    strip.appendChild(pick)
  }
  builtinField.appendChild(strip)
  card.appendChild(builtinField)

  const actions = make('div', 'set-card__actions')
  const save = make('button', 'btn btn--tiny btn--primary', '保存')
  save.type = 'button'
  save.addEventListener('click', () => { void saveMemberCard(agentId) })
  actions.appendChild(save)
  if (state.avatarStamps.has(agentId)) {
    const reset = make('button', 'btn btn--tiny btn--ghost', '删除头像')
    reset.type = 'button'
    reset.addEventListener('click', () => { void runAvatarAction(agentId, async () => {
      await api.clearAvatar(agentId)
      state.avatarStamps.delete(agentId)
    }, '删除中…', '已删除头像，恢复默认') })
    actions.appendChild(reset)
  }
  card.appendChild(actions)

  const status = make('div', 'set-card__status')
  status.dataset.kind = ''
  card.appendChild(status)

  const view = { card, agentId, nameInput, titles, swatches: swatchViews, save, status, avatarSlot, pendingAccent: null, dirty: false, busy: false, draftVersion: 0 }
  nameInput.addEventListener('input', () => markCardDirty(view))
  settingsCards.set(agentId, view)
  return card
}

/**
 * 打开/关闭设置页（方案 I18）：页面切换，不是模态——焦点落到标题上（返回按钮也行，
 * 标题更稳），关闭时送回齿轮按钮，不误抢焦点到主输入。执行中进来时给出「回群聊」
 * 提示：停止入口在被隐藏的三栏里，这条路得留着。
 */
function setOpenSettings(open) {
  state.settingsOpen = open
  document.body.dataset.settings = open ? 'open' : 'closed'
  el.settingsButton.setAttribute('aria-expanded', String(open))
  el.settings.hidden = !open
  el.settingsLive.hidden = !(open && state.streaming)
  el.settingsLive.textContent = open && state.streaming ? '有任务正在执行：回群聊可查看进度或喊停' : ''
  if (open) {
    renderSettingsMembers()
    el.settingsTitle.focus()
  } else {
    renderMembers()
    el.settingsButton.focus()
  }
}

function renderCrew() {
  clear(el.crewFaces)
  for (const member of state.members) {
    // 「我的成员」用大头像（贴原型 C 的比例），带墨色描边圆框。
    const face = avatarNode(member.agentId)
    // 头像只说"这是谁"：**逐人本轮状态只在调度卡的格子上**（唯一来源）。这里再挂一份来自
    // `members[].busy` 快照的状态，会和卡片的事件流各说各话，用户看到两处不一致。
    face.title = `${member.displayName}（@${member.agentId}）`
    el.crewFaces.appendChild(face)
  }
  const busy = state.members.filter(member => member.busy !== null).length
  const total = state.members.length
  // ⚠️ 这里的计数是**页面级事实**（名单上此刻手上有活的人，跨任务，来自 `/members` 快照），
  // 与调度卡里"本次派活有几位进行中"（本轮事件流）不是同一件事，所以用词也不同：
  // 「手上有活」对名单，「进行中」对本次派活。混用会让用户在两处看到不同的数字。
  const working = busy > 0 ? ` · ${busy} 位手上有活` : ''
  el.crewLine.textContent = `${total} 个牛马${working}`
  el.crewNote.textContent = `共 ${total} 位${working}`
  el.groupSub.textContent = `${total} 位成员${working}`
}

function renderMetrics(counts) {
  clear(el.metrics)
  const tiles = [
    { label: '在干活', value: counts.running },
    { label: '等你回话', value: counts.waitingUser },
    { label: '待外部处理', value: counts.externalPending },
    { label: '部分完成', value: counts.partial },
    { label: '失败', value: counts.failed },
    { label: '已完成', value: counts.completed },
  ]
  for (const tile of tiles) {
    const box = make('div', 'metric')
    box.appendChild(make('span', 'metric__value', tile.value))
    box.appendChild(make('span', 'metric__label', tile.label))
    el.metrics.appendChild(box)
  }
}

/**
 * 右栏「运行状态」**只有计数，没有逐人状态行**。
 *
 * 改造前这里还有一列"谁此刻在干什么"，与群里每位成员的一行状态、调度卡的格子重复了同一件事，
 * 而三处口径还各有可能不一致（一个来自 `members[].busy` 快照，两个来自本轮事件）。现在本次派活
 * 的事实只有一个来源：**调度卡的格子**；这里只留一眼能看完的计数（下面 `renderMetrics`）。
 * 成员名单那一栏本来就不带状态点（见 `renderMembers` 的说明），两栏合起来正好不重复。
 */
function renderFailures(items) {
  clear(el.failureList)
  if (items.length === 0) {
    el.failureList.appendChild(make('p', 'empty', '暂无失败记录'))
    return
  }
  for (const item of items) {
    const row = make('button', 'failure-row')
    row.type = 'button'
    // 头行=「时间 任务名」（原型 C 与 Figma 稿均为日期在前），正文=失败原因。
    row.appendChild(make('span', 'failure-row__goal', `${formatTime(item.updatedAt)}　${item.goal}`))
    row.appendChild(make('span', 'failure-row__meta', item.error || '没给原因'))
    row.addEventListener('click', () => { void openTask(item.id) })
    el.failureList.appendChild(row)
  }
}

function renderChatList(items, keyword) {
  clear(el.chatList)
  const filtered = keyword === ''
    ? items
    : items.filter(item =>
      (item.title ?? '').toLowerCase().includes(keyword) ||
      (item.preview ?? '').toLowerCase().includes(keyword))
  if (filtered.length === 0) {
    el.chatList.appendChild(make('p', 'empty', items.length === 0 ? '还没有任务记录' : '没有匹配结果'))
    return
  }
  for (const item of filtered) {
    const row = make('button', 'chat-row')
    row.type = 'button'
    if (item.id === state.conversationId) row.setAttribute('aria-current', 'true')
    const left = make('span')
    left.appendChild(make('span', 'chat-row__title', item.title || '（还没起名）'))
    if (item.preview) left.appendChild(make('span', 'chat-row__preview', item.preview))
    row.appendChild(left)
    row.appendChild(make('span', 'chat-row__time', formatTime(item.updatedAt)))
    row.addEventListener('click', () => { void openConversation(item.id) })
    el.chatList.appendChild(row)
  }
}

/* ── 右栏操作 ─────────────────────────────────────────────────────────── */

/* 设置保存与头像操作在设置卡内局部处理（saveMemberCard / runAvatarAction），
 * 不再走整页重建；右栏常规刷新由 refreshPanels 负责。 */

/* ── 数据刷新 ─────────────────────────────────────────────────────────── */

async function refreshPanels() {
  try {
    const [members, overview] = await Promise.all([api.members(), api.overview()])
    state.members = members.items
    for (const member of members.items) {
      if (!state.avatarStamps.has(member.agentId)) state.avatarStamps.set(member.agentId, 1)
    }
    // 名单变了（新成员、换外号），开着的点名簿跟着换页。
    renderMention()
    // 设置页开着时不重画右栏成员卡，免得把没保存的外号冲掉。
    if (!state.settingsOpen) renderMembers()
    renderCrew()
    renderMetrics(overview.counts)
    renderFailures(overview.failures)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      el.topStatus.textContent = '没登录'
      clear(el.identity)
      const link = make('a', null, '去登录')
      link.href = '/auth'
      el.identity.appendChild(link)
      return
    }
    el.topStatus.textContent = '读取失败'
  }
}

/**
 * 左栏列表。
 *
 * 会话标题与预览来自牛马大总管会话记录：标题由宿主首句标题服务生成，预览取该会话最近一条
 * 任务的目标或汇总，所以每行都能看出「这次派的是什么活」。
 */
async function refreshChatList() {
  try {
    const [conversations, history] = await Promise.all([api.conversations(), api.history()])
    const byConversation = new Map()
    for (const task of history.items) {
      if (!byConversation.has(task.conversationId)) byConversation.set(task.conversationId, task)
    }
    const items = conversations.items.map(item => {
      const task = byConversation.get(item.id)
      return {
        ...item,
        preview: task === undefined ? '' : task.goal,
      }
    })
    renderChatList(items, el.chatSearch.value.trim().toLowerCase())
  } catch (error) {
    // 把服务端给的原因一并显示：只说「读取记录失败」，排查时等于什么都没有。
    const reason = error instanceof Error ? error.message : ''
    el.chatList.replaceChildren(make('p', 'empty', reason === '' ? '读取记录失败' : `读取记录失败：${reason}`))
  }
}

/** 历史条目的时间锚点：对话用消息时间，任务用收尾时间（摘要属于结局）。 */
function timeOf(value) {
  const at = new Date(value).getTime()
  return Number.isNaN(at) ? 0 : at
}

/**
 * 历史条目的全局比较规则（初次加载与分页共用）。
 *
 * 先按时间；同刻的对话按事件序号**数值**比较——字符串比较会把 `t:10` 排到 `t:2`
 * 前面（复核 2）；任务按收尾时间锚定、属于结局，同刻排在对话之后，再按 id 决胜。
 */
function compareHistoryEntries(a, b) {
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
function mergeHistoryEntries(transcriptItems, taskItems) {
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
function planHistoryInsertion(existing, fresh) {
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
function taskSummaryCard(task) {
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
function taskHistoryEntry(task) {
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
const taskCardRequests = new Map()

function taskRecord(id) {
  const known = taskCardRequests.get(id)
  if (known !== undefined) return known
  const pending = api.task(id)
  taskCardRequests.set(id, pending)
  const forget = () => { taskCardRequests.delete(id) }
  pending.then(forget, forget)
  return pending
}

async function upgradeTaskEntry(wrap, task) {
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
function createHistoryNode(entry) {
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
function renderHistorySlice(entries) {
  for (const entry of entries) entry.node = createHistoryNode(entry)
}

/** 「加载更早记录」入口：两个游标都到底后换成分界说明；失败保留重试。 */
function updateLoadEarlier(error) {
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
async function loadEarlier() {
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
async function openConversation(id) {
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

async function openTask(id) {
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
function bindViewHistory() {
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
function renderTaskCard(record, opts = {}) {
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
function renderTaskRecord(record, opts = {}) {
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

/* ── 座右铭 ─────────────────────────────────────────────────────────── */

function renderMotto() {
  clear(el.motto)
  let current = DEFAULT_MOTTO
  try { current = localStorage.getItem(MOTTO_KEY) ?? DEFAULT_MOTTO } catch { /* 忽略。 */ }
  const button = make('button', null, `${current} ☺`)
  button.type = 'button'
  button.title = '点一下改掉'
  button.addEventListener('click', () => {
    clear(el.motto)
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = 24
    input.value = current
    el.motto.appendChild(input)
    input.focus()
    input.select()
    const commit = () => {
      const next = input.value.trim() || DEFAULT_MOTTO
      try { localStorage.setItem(MOTTO_KEY, next) } catch { /* 忽略。 */ }
      renderMotto()
    }
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); commit() }
    })
  })
  el.motto.appendChild(button)
}

/* ── 交互绑定 ─────────────────────────────────────────────────────────── */

function autosize() {
  el.input.style.height = 'auto'
  el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`
  const length = [...el.input.value].length
  el.count.textContent = length > 0 ? `${length} 字` : ''
}

/* ── @ 提及选择器：输入 @ 翻出点名簿，键盘上下选 ─────────────────────── */

/** 提及会话：null=关着；否则 { start: 「@」的下标, query: @ 到光标之间的词, index: 高亮项, items: 过滤结果 }。 */
let mention = null

/** 光标前是否有一个未闭合的 @：「@」之前须是行首、空白或非 ASCII 字符（中文书写不打空格），
 *  「@」与光标之间不许再出现空白；唯独英文/数字后不触发，免得邮箱被当点名。 */
function detectMention() {
  const text = el.input.value
  const pos = el.input.selectionStart ?? text.length
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === '@') {
      const prev = i === 0 ? '' : text[i - 1]
      if (prev === '' || /[^\x00-\x7f]/.test(prev) || /\s/.test(prev)) {
        return { start: i, query: text.slice(i + 1, pos) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** 过滤口径：外号、报名名、agentId 任一命中即可。 */
function mentionCandidates(query) {
  const q = query.trim().toLowerCase()
  return state.members.filter(member =>
    member.displayName.toLowerCase().includes(q)
    || member.declaredName.toLowerCase().includes(q)
    || member.agentId.toLowerCase().includes(q))
}

function openMention(hit) {
  mention = { start: hit.start, query: hit.query, index: 0, items: [] }
  renderMention()
}

function closeMention() {
  if (mention === null) return
  mention = null
  el.mentionPop.hidden = true
  el.mentionPop.removeAttribute('aria-activedescendant')
}

function renderMention() {
  if (mention === null) return
  mention.items = mentionCandidates(mention.query)
  if (mention.index >= mention.items.length) mention.index = 0
  clear(el.mentionItems)
  if (mention.items.length === 0) {
    // 留着浮层说一声而不是直接关：空名单（还没装成员）和打错过滤词是两种情况，关了就说不出来。
    el.mentionItems.appendChild(make('p', 'mention__none',
      state.members.length === 0 ? '还没有可点名的成员' : '没有对得上的成员'))
    el.mentionPop.hidden = false
    el.mentionPop.removeAttribute('aria-activedescendant')
    return
  }
  mention.items.forEach((member, index) => {
    const item = make('div', 'mention__item')
    item.id = `mention-option-${index}`
    item.dataset.index = String(index)
    item.setAttribute('role', 'option')
    item.appendChild(avatarNode(member.agentId, 'sm'))
    const col = make('div', 'member__col')
    col.appendChild(make('div', 'member__name', member.displayName))
    col.appendChild(make('div', 'member__declared', member.declaredName))
    item.appendChild(col)
    item.appendChild(make('span', 'mention__handle', `@${member.agentId}`))
    el.mentionItems.appendChild(item)
  })
  el.mentionPop.hidden = false
  paintMentionActive()
}

/** 只切高亮不重建：键盘连按时文字不闪。 */
function paintMentionActive() {
  if (mention === null) return
  for (const item of el.mentionItems.children) {
    const active = Number(item.dataset.index) === mention.index
    item.setAttribute('aria-selected', active ? 'true' : 'false')
    item.classList.toggle('mention__item--active', active)
    if (active) {
      el.mentionPop.setAttribute('aria-activedescendant', item.id)
      item.scrollIntoView({ block: 'nearest' })
    }
  }
}

/** input 事件入口：光标挪走、补空格都等于放弃这次提及。 */
function updateMention() {
  const hit = detectMention()
  if (hit === null) { closeMention(); return }
  if (mention === null || hit.start !== mention.start) { openMention(hit); return }
  mention.query = hit.query
  mention.index = 0
  renderMention()
}

/** 落纸用外号：服务端成员清单就是「id（外号）」的对照表，外号即点名。 */
function acceptMention() {
  if (mention === null) return
  const member = mention.items[mention.index]
  if (member === undefined) { closeMention(); return }
  const text = el.input.value
  const pos = el.input.selectionStart ?? text.length
  const insert = `@${member.displayName} `
  el.input.value = text.slice(0, mention.start) + insert + text.slice(pos)
  const caret = mention.start + insert.length
  el.input.setSelectionRange(caret, caret)
  closeMention()
  autosize()
  el.input.focus()
}

function bindMention() {
  el.input.addEventListener('input', updateMention)
  el.input.addEventListener('blur', closeMention)
  // 点名簿上的交互：悬停即高亮，点击即选中；按下先拦默认，别让输入框失焦。
  el.mentionItems.addEventListener('mouseover', event => {
    if (mention === null) return
    const item = event.target.closest('.mention__item')
    if (item === null) return
    const index = Number(item.dataset.index)
    if (mention.index !== index) { mention.index = index; paintMentionActive() }
  })
  el.mentionItems.addEventListener('mousedown', event => event.preventDefault())
  el.mentionItems.addEventListener('click', event => {
    if (mention === null) return
    const item = event.target.closest('.mention__item')
    if (item === null) return
    mention.index = Number(item.dataset.index)
    acceptMention()
  })
}

function openNewChat() {
  if (state.streaming) return
  // 换新视图同样作废在途回包（方案 I09）。
  state.viewToken += 1
  state.conversationId = null
  state.taskId = null
  // 新会话没有待发附件：上一个会话攒下的那些跟着上一个会话走。
  hideAttachUrl()
  clearAttachments()
  historyState.conversationId = null
  historyState.transcriptBefore = null
  historyState.taskOffset = null
  historyState.entries = []
  clear(el.thread)
  threadInner()
  state.bubbles.clear()
  resetRail()
  resetFollowing()
  renderWelcome()
  void refreshChatList()
  el.input.focus()
}

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
