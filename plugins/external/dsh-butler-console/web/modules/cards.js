/**
 * 待确认操作卡、提问卡、汇总卡与欢迎板（拆分设计 v2 批 1d）。
 * 与 send/events 构成文档化环簇一：卡片 UI 触发回合（runAction→runAct、askCard→runReply）。
 */

import { SUGGESTIONS } from './config.js'
import { autosize, clear, formatTime, make } from './dom.js'
import { renderRail } from './rail.js'
import { el, newConversationId, state } from './state.js'
import { runAct, runReply } from './send.js'
import { ROUTE_PREFIX, act, reply } from '../api.js'
import { richText } from '../markdown.js'

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
export function actionCard(action, context) {
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
export const ACTION_STATE_TEXT = {
  prepared: '等你确认',
  executing: '正在办',
  succeeded: '已办完',
  failed: '没办成',
  cancelled: '先不办',
  expired: '已过期',
}

/** 把一次决策交给服务端，并把事件当成这一轮来消费（与 reply 同一条通道）。 */
export async function runAction(action, decision, context, card) {
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
export function renderActionsInto(view, actions, context) {
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
 * 一位成员的输出挂进卡片之后，把它名下的待确认操作画出来。
 *
 * 单独一步、两种状态都走它（`external_pending` 与"succeeded 但还有后续待办"）：画的是服务端
 * 给的**全量**列表，所以确认完一张、剩下还在的会自然留下，全部办完则整块消失。
 */
export function mountMemberActions(view, event) {
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
export function askCard(view, event) {
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

export function summaryCard(event) {
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

export function renderWelcome() {
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
