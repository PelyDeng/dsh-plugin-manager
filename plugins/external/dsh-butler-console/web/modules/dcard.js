/**
 * 调度卡（拆分设计 v2 批 1b）：任务拆解的卡片视图（偏好、状态格、计时、结果只读、复制、
 * 结算挂靠）与描边脉冲。
 */

import { STATE_TEXT } from './config.js'
import { state } from './state.js'
import { avatarNode, displayNameOf, formatElapsed, make } from './dom.js'

/**
 * 调度卡的偏好（折叠状态 + 「只看结论」）。
 *
 * 跟着任务走并落在本机：刷新重建卡片时先读它再渲染，用户收起过的卡不会自己弹开。
 * 与座右铭、会话 id 同一套写法（隐私模式下读写都会抛，忽略即可）。
 */
export const CARD_PREF_PREFIX = 'butler.card.'

/** 卡片元素 id 的自增序号：tab 与它控制的结果格要成对，id 必须唯一。 */
export let cardSeq = 0

export function cardPrefs(taskId) {
  if (typeof taskId !== 'string' || taskId === '') return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(CARD_PREF_PREFIX + taskId) ?? 'null')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch { return {} }
}

export function saveCardPref(taskId, patch) {
  if (typeof taskId !== 'string' || taskId === '') return
  try { localStorage.setItem(CARD_PREF_PREFIX + taskId, JSON.stringify({ ...cardPrefs(taskId), ...patch })) } catch { /* 忽略。 */ }
}

/**
 * 成员状态 → 卡片上的短状态词。
 *
 * 比 `STATE_TEXT` 更短：格子里一行放得下，且与"在干活/已完成"这两个计数词能对上。
 */
export const CARD_STATE_TEXT = {
  queued: '排队',
  dispatched: '已收到',
  running: '进行中',
  waiting_user: '等你回话',
  external_pending: '待外部处理',
  partial: '部分完成',
  succeeded: '已完成',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  summarizing: '在总结',
}

export function cardStateText(value) {
  return CARD_STATE_TEXT[value] ?? STATE_TEXT[value] ?? String(value ?? '')
}

/** 有定论的状态：到了这些状态，秒数不再往上走。
 *
 * ⚠️ `waiting_user` 必须算在内：等你回话可能挂几个小时，秒数一直往上加是在骗人
 * （它已经不是"正在算"了）。`partial` 是任务级的收尾态，子任务层到不了，一并收进来无妨。
 */
export function cardSettled(value) {
  return ['succeeded', 'completed', 'failed', 'cancelled', 'external_pending', 'waiting_user', 'partial'].includes(value ?? '')
}

/**
 * 结果区里还没有内容时的说明。
 *
 * 不留空白框：排队/进行中都是有意义的状态，直接写清楚；成员的第一段输出到达后由
 * ttachToDispatch 撤掉这句话。
 */
export function emptySlotHint(value) {
  if (value === 'queued' || value === undefined) return '还没开始，等前一步交回材料。'
  if (value === 'waiting_user') return '在等你回话。'
  if (value === 'external_pending') return '材料交回来了，还有事在别处办。'
  return '正在做，还没有可看的内容。'
}

/** 结果区标题：跟着选中成员的状态变，用户不用猜自己在看什么。 */
export const CARD_RESULT_TITLE = {
  queued: '还没开始',
  dispatched: '正在做的事',
  running: '正在做的事',
  summarizing: '正在总结',
  succeeded: '交回的内容',
  completed: '交回的内容',
  external_pending: '交回的内容（还有事在外面办）',
  waiting_user: '等你回话',
  partial: '交回的部分',
  failed: '失败原因',
  cancelled: '已经停下',
}

/**
 * 已过时间：有结束时刻就定格，否则按当前时间走。
 *
 * 与 `formatElapsed` 同一条口径（结束时刻必须给，否则一个真实的 57 秒会一直往上加）。
 */
export function cardElapsedText(since, until) {
  if (typeof since !== 'number' || !Number.isFinite(since)) return ''
  if (typeof until === 'number' && Number.isFinite(until)) return formatElapsed(since, until)
  return formatElapsed(since)
}

/**
 * 进行中成员秒数的**唯一**定时器（全页一个）。
 *
 * 每张卡各自起一个定时器的话，切会话、翻历史都会留下野定时器；这里只有一个，且没有
 * 在跳的格子时自己停掉。`data-live` 由卡片在状态更新时维护（终态清掉）。
 */
export let cardTicker = null

export function syncCardTicker() {
  const live = document.querySelectorAll('.dcard__elapsed[data-live="1"]')
  if (live.length === 0) {
    if (cardTicker !== null) { clearInterval(cardTicker); cardTicker = null }
    return
  }
  if (cardTicker !== null) return
  cardTicker = setInterval(() => {
    for (const node of document.querySelectorAll('.dcard__elapsed[data-live="1"]')) {
      const since = Number(node.dataset.since)
      if (!Number.isFinite(since)) { node.removeAttribute('data-live'); continue }
      node.textContent = cardElapsedText(since)
    }
    syncCardTicker()
  }, 1000)
}

/** 成员状态 → 面板小圆点的配色类名。 */
export const DISPATCH_TONE = {
  succeeded: 'ok',
  completed: 'ok',
  failed: 'error',
  cancelled: 'error',
  waiting_user: 'warn',
  external_pending: 'warn',
}

/**
 * 调度卡：**本次派活唯一的一张卡**。
 *
 * 它把同一个事实的三处重复（「已分派」计划贴纸、群里每位成员的一行状态、「本次已调度 N 个
 * 成员」面板）合成一个组件：一行状态条 + 一行最多三个成员格子 + 选中成员的结果区。
 * 格子是**唯一**的状态来源，成员真实在查什么、交回了什么都收在同一张卡的展开区里，
 * 大总管汇总时不必再复述成员原文。
 *
 * 交互（与设计文档 §7 一致）：点格子选中、点已选中的格子不变（要收起用卡片自己的折叠，
 * 避免"没有选中"这种半吊子态）、左右方向键换人、Esc 收起、格子整块可点。
 * 格子住进折叠头：**收起时也看得见谁被调了、干到什么状态**，收起来的只是交回的内容。
 * 因此默认收起——要细看过程再展开。折叠状态与「只看结论」按 `taskId` 存本机，刷新重建
 * 时先读偏好再渲染。
 */
export function mountDispatch(subtasks, options = {}) {
  const taskId = typeof options.taskId === 'string' && options.taskId !== '' ? options.taskId : (state.taskId ?? '')
  const prefs = cardPrefs(taskId)
  const open = typeof prefs.open === 'boolean' ? prefs.open : options.defaultOpen === true
  const panelId = `c${++cardSeq}`
  const details = make('details', 'dcard')
  details.open = open
  if (taskId !== '') details.dataset.taskId = taskId
  const bar = make('summary', 'dcard__bar')
  /** 折叠头第一行：状态条 + 「有更新」+ 工具。格子网格也在折叠头里（第二行）。 */
  const barline = make('div', 'dcard__barline')
  const title = make('span', 'dcard__bar-text')
  /** 「有更新」提示：收起时才有东西可提示（展开时更新看得见）。文字 + 小圆点，不只是个点。 */
  const fresh = make('span', 'dcard__fresh')
  fresh.appendChild(make('span', 'dot dot--running'))
  fresh.appendChild(make('span', null, '有更新'))
  fresh.hidden = true
  fresh.title = '收起之后又有了新进展'
  const tools = make('div', 'dcard__tools')
  const grid = make('div', 'dcard__grid')
  grid.setAttribute('role', 'tablist')
  grid.setAttribute('aria-label', '本次派出的成员')
  const slots = make('div', 'dcard__slots')
  const result = make('div', 'dcard__result')
  const resultTitle = make('div', 'dcard__result-title')
  result.appendChild(resultTitle)
  result.appendChild(slots)
  const slots_ = new Map()
  const buttons = new Map()
  /** 成员 id → 结果区里那句"还没开始/正在做"的占位说明（成员输出到达时撤掉）。 */
  const empty = new Map()
  /** 每位成员当前可复制的正文：取的是它的累积正文（流式期间也成立）。 */
  const texts = new Map()

  const panel = {
    details,
    bar,
    barline,
    title,
    fresh,
    tools,
    grid,
    slots: slots_,
    body: slots,
    result,
    resultTitle,
    buttons,
    texts,
    /** 成员 id → 当前状态：状态条计数、结果区标题、秒数都从它读。 */
    states: new Map(),
    /** 与上面那个 `empty` 是同一张表（`attachToDispatch` 从面板对象上读它）。 */
    empty,
    /** 成员 id → 开始/结束时刻（重派会重置开始时刻）。 */
    since: new Map(),
    until: new Map(),
    taskId,
    order: subtasks.map(subtask => subtask.id),
    active: subtasks.length > 0 ? subtasks[0].id : null,
    resultOnly: prefs.resultOnly === true,
  }

  const select = id => selectDispatch(panel, id)
  // 卡片内的元素 id：tab 与它控制的结果格要成对（读屏才知道"这个选项对应哪一块内容"）。
  const idPrefix = `dcard-${panelId}`
  for (const subtask of subtasks) {
    const cell = make('button', 'dcard__cell')
    cell.type = 'button'
    cell.id = `${idPrefix}-tab-${subtask.id}`
    cell.dataset.id = subtask.id
    cell.dataset.handle = `@${subtask.agentId}`
    cell.setAttribute('role', 'tab')
    cell.setAttribute('aria-selected', 'false')
    cell.setAttribute('aria-controls', `${idPrefix}-panel-${subtask.id}`)
    const avatar = avatarNode(subtask.agentId)
    cell.appendChild(avatar)
    const col = make('span', 'dcard__col')
    const head = make('span', 'dcard__head')
    head.appendChild(make('span', 'dcard__name', displayNameOf(subtask.agentId)))
    head.appendChild(make('span', 'dcard__handle', `@${subtask.agentId}`))
    col.appendChild(head)
    // 第二行：目标（超长省略）+ 状态挤同一行——名称行必须独占，格子两行就够紧凑。
    const meta = make('span', 'dcard__meta')
    meta.appendChild(make('span', 'dcard__goal', subtask.goal ?? ''))
    const status = make('span', 'dcard__status')
    const dot = make('span', `dot dot--${DISPATCH_TONE[subtask.state] ?? 'queued'}`)
    status.appendChild(dot)
    status.appendChild(make('span', 'dcard__statetext', cardStateText(subtask.state)))
    const elapsed = make('span', 'dcard__elapsed')
    elapsed.hidden = true
    status.appendChild(elapsed)
    meta.appendChild(status)
    col.appendChild(meta)
    cell.appendChild(col)
    cell.title = `${subtask.goal ?? ''} @${subtask.agentId}`.trim()
    // 格子在折叠头里：点格子只换人，不能顺带把卡片展开/收起（同 tools 按钮的拦截口径）。
    cell.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      select(subtask.id)
    })
    grid.appendChild(cell)

    const slot = make('section', 'dcard__slot')
    slot.id = `${idPrefix}-panel-${subtask.id}`
    slot.setAttribute('role', 'tabpanel')
    slot.setAttribute('aria-labelledby', `${idPrefix}-tab-${subtask.id}`)
    slot.hidden = true
    // 还没有交回内容时不留空白框：写清楚现在是什么状况，内容一到就撤掉这句话。
    const hint = make('p', 'dcard__empty', emptySlotHint(subtask.state))
    slot.appendChild(hint)
    empty.set(subtask.id, hint)
    slots.appendChild(slot)

    panel.states.set(subtask.id, subtask.state ?? 'queued')
    if (typeof subtask.startedAt === 'number') panel.since.set(subtask.id, subtask.startedAt)
    if (typeof subtask.finishedAt === 'number') panel.until.set(subtask.id, subtask.finishedAt)
    buttons.set(subtask.id, cell)
    slots_.set(subtask.id, slot)
    updateCardCell(panel, subtask.id)
  }

  // 方向键换人（焦点跟着走），Esc 收起整卡 —— 不能只服务鼠标。
  grid.addEventListener('keydown', event => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    const index = panel.order.indexOf(panel.active)
    if (index < 0) return
    const next = panel.order[(index + step + panel.order.length) % panel.order.length]
    event.preventDefault()
    select(next)
    buttons.get(next)?.focus()
  })
  details.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !details.open) return
    event.preventDefault()
    details.open = false
    // 收起之后焦点不能留在看不见的格子里：交给还看得见的折叠按钮。
    fold.focus?.()
  })

  // 「只看结论」：过程行（思考、工具行、打字点）收起来，只留成员交回的结论。
  const resultOnly = make('button', 'dcard__tool')
  resultOnly.type = 'button'
  resultOnly.textContent = '只看结论'
  resultOnly.title = '隐藏成员的思考与工具过程，只留它交回的结论'
  resultOnly.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    toggleDispatchResultOnly(panel, !panel.resultOnly)
    saveCardPref(taskId, { resultOnly: panel.resultOnly })
  })
  panel.resultOnlyButton = resultOnly

  // 「复制」：把当前这位成员交回的内容拷走，粘到别处不用再手选。
  const copy = make('button', 'dcard__tool')
  copy.type = 'button'
  copy.textContent = '复制'
  copy.title = '复制当前这位成员交回的内容'
  copy.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    void copyDispatchText(panel, copy)
  })
  panel.copyButton = copy

  // 「折叠 / 展开」：与点状态条同一个动作，这里给一个看得见的按钮（键盘也能到）。
  const fold = make('button', 'dcard__tool')
  fold.type = 'button'
  fold.textContent = open ? '折叠' : '展开'
  fold.title = '收起或展开这张卡（Esc 也能收起）'
  // 折叠态同时挂在按钮上（`aria-expanded`）：原生 `<details>` 只把状态给状态条那一层，
  // 读屏走到这个按钮时得有同一份事实。
  fold.setAttribute('aria-expanded', open ? 'true' : 'false')
  fold.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    details.open = !details.open
  })
  panel.foldButton = fold

  tools.appendChild(resultOnly)
  tools.appendChild(copy)
  tools.appendChild(fold)

  barline.appendChild(title)
  barline.appendChild(fresh)
  barline.appendChild(tools)
  // 折叠头两行：状态条一行、成员格一行——**收起时格子仍在**，只藏交回的内容。
  bar.appendChild(barline)
  bar.appendChild(grid)
  details.appendChild(bar)
  details.appendChild(result)
  // 折叠状态落到本机偏好；重新展开时「有更新」提示收掉（更新已经看得见了）。
  details.addEventListener('toggle', () => {
    fold.textContent = details.open ? '折叠' : '展开'
    fold.setAttribute('aria-expanded', details.open ? 'true' : 'false')
    if (details.open) fresh.hidden = true
    saveCardPref(taskId, { open: details.open })
  })

  // 实时那一张卡要接管后续的成员事件；历史重建出来的卡不抢这个位置。
  if (options.live !== false) state.dispatch = panel
  // 卡片把自己的面板对象挂在节点上：同一张卡要按自己的格子收成员输出（历史那一页可能同时
  // 有好几张），不能靠"当前正在跑的那一张"这个全局位置去找。
  details.__dcard = panel
  renderDispatchHeader(panel)
  toggleDispatchResultOnly(panel, panel.resultOnly)
  if (panel.active !== null) select(panel.active)
  // 挂进线程之后那些 `data-live` 的格子才数得到；这里补一次，免得计时器要等第一个事件才起表。
  syncCardTicker()
  return details
}

/** 卡片格子的状态行：圆点 + 状态词 + 已过时间（排队不显示时间）。 */
export function updateCardCell(panel, id) {
  const cell = panel.buttons.get(id)
  if (cell === undefined) return
  const value = panel.states.get(id)
  const tone = DISPATCH_TONE[value] ?? 'queued'
  const dot = cell.querySelector('.dot')
  if (dot !== null) dot.className = `dot dot--${tone}`
  const text = cell.querySelector('.dcard__statetext')
  if (text !== null) text.textContent = cardStateText(value)
  const elapsed = cell.querySelector('.dcard__elapsed')
  if (elapsed === null) return
  const since = panel.since.get(id)
  const until = cardSettled(value) ? panel.until.get(id) : undefined
  const line = cardElapsedText(since, until)
  elapsed.textContent = line
  elapsed.hidden = line === ''
  if (line !== '' && until === undefined && typeof since === 'number') {
    elapsed.dataset.since = String(since)
    elapsed.dataset.live = '1'
  } else {
    elapsed.removeAttribute('data-live')
  }
  syncCardTicker()
}

/** 「只看结论」开关：过程行收起来，结论照旧。 */
export function toggleDispatchResultOnly(panel, on) {
  panel.resultOnly = on === true
  panel.body.classList.toggle('dcard__slots--result-only', panel.resultOnly)
  panel.resultOnlyButton.classList.toggle('dcard__tool--on', panel.resultOnly)
  panel.resultOnlyButton.textContent = panel.resultOnly ? '看完整过程' : '只看结论'
}

/** 复制当前成员交回的正文；剪贴板不可用（非安全上下文等）时如实报失败，不假装成功。 */
export async function copyDispatchText(panel, button) {
  const text = panel.active === null ? '' : (panel.texts.get(panel.active)?.() ?? '')
  const original = button.textContent
  try {
    if (text.trim() === '') throw new Error('还没有可复制的内容')
    await navigator.clipboard.writeText(text)
    button.textContent = '已复制'
  } catch {
    button.textContent = '复制失败'
  }
  setTimeout(() => { button.textContent = original }, 1500)
}

/**
 * 状态条：几位成员、几个还在干、几个排队、几个在等、几个交回了——一行看完。
 *
 * 用词与格子里的状态词**对齐**（进行中 / 排队 / 已完成 / 失败），免得同一件事在两个地方
 * 各叫各的；没有的那几档不出现，所以一两句话就能读完。
 */
export function renderDispatchHeader(panel) {
  const states = panel.order.map(id => panel.states.get(id))
  const running = states.filter(value => ['dispatched', 'running', 'summarizing'].includes(value ?? '')).length
  const queued = states.filter(value => value === 'queued' || value === undefined).length
  const waiting = states.filter(value => value === 'waiting_user' || value === 'external_pending').length
  const done = states.filter(value => value === 'succeeded' || value === 'completed').length
  const failed = states.filter(value => value === 'failed' || value === 'cancelled').length
  const parts = [`${panel.order.length} 位成员`]
  if (running > 0) parts.push(`${running} 位进行中`)
  if (queued > 0) parts.push(`${queued} 位排队`)
  if (waiting > 0) parts.push(`${waiting} 位在等`)
  if (done > 0) parts.push(`${done} 位已交回`)
  if (failed > 0) parts.push(`${failed} 位没成`)
  // 「已交回」带红笔下划线（原型 C 的批注）：用 span 包住末段，textContent 保持不变。
  const text = parts.join(' · ')
  const idx = text.lastIndexOf('位已交回')
  if (idx === -1) { panel.title.textContent = text; return }
  panel.title.replaceChildren(
    document.createTextNode(text.slice(0, idx)),
    make('span', 'red-wavy', '位已交回'),
    document.createTextNode(text.slice(idx + '位已交回'.length)),
  )
}

/**
 * 切到某位成员：只显示它的那一格，其余隐藏。
 *
 * 再点已经选中的那一格**不取消选中**：要收起整卡用卡片自己的折叠，一条动作一个语义；
 * 否则会多出一个"没有选中"的空态，刷新后也不知道该恢复成什么。
 */
export function selectDispatch(panel, id) {
  if (panel === null || !panel.slots.has(id)) return
  panel.active = id
  for (const [key, slot] of panel.slots) slot.hidden = key !== id
  for (const [key, button] of panel.buttons) {
    const on = key === id
    button.classList.toggle('dcard__cell--active', on)
    button.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  const value = panel.states.get(id)
  panel.resultTitle.textContent = `《${panel.buttons.get(id)?.dataset.handle ?? ''}》${CARD_RESULT_TITLE[value] ?? ''}`
}

/**
 * 把一位成员的输出挂进调度卡对应的格子，并更新它在卡片上的状态。
 *
 * 成员的**整条消息**（`view.msg`：气泡、等待回话卡、页脚）只搬一次——`appendChild` 保留同一批
 * 节点，所以搬完之后流式增量照旧写进同一个气泡，不需要为卡片再做一套渲染。群里因此不再有
 * "每位成员一行状态"：格子就是那一行。
 *
 * `state` 只在真的变化时才重算状态条与「有更新」提示；重派（`dispatched`）会把开始时刻重置，
 * 终态记下结束时刻，秒数才不会再往上走。
 */
export function attachToDispatch(view, event, panel = state.dispatch) {
  if (panel === null || panel === undefined || !panel.slots.has(event.id)) return
  // 卡片已经被清掉（切会话、开新对话把线程整棵子树移走了）就不再往里写：`state.dispatch`
  // 不会自己归零，只靠调用方的守卫不够。重建路径在卡片挂进线程**之前**就在填内容，
  // 所以那时用 `building` 显式放行。
  if (panel.details.isConnected === false && panel.building !== true) return
  const slot = panel.slots.get(event.id)
  if (view.msg.parentNode !== slot) slot.appendChild(view.msg)
  // 内容到了，"还没开始/正在做"那句占位说明就撤掉（否则它会一直躺在结果区顶上）。
  const hint = panel.empty?.get(event.id)
  if (hint !== undefined) {
    hint.remove()
    panel.empty.delete(event.id)
  }
  // 卡片「复制」按成员取正文：`view.body` 是累积正文，流式期间也在长。
  panel.texts.set(event.id, () => view.body ?? '')
  const value = event.state ?? 'queued'
  const changed = panel.states.get(event.id) !== value
  panel.states.set(event.id, value)
  const at = typeof event.time === 'number' ? event.time : Date.now()
  if (value === 'dispatched') {
    // 新一次尝试从头开始（S08）：上一次的结束时刻作废，否则秒数会显示成负数或定格。
    panel.since.set(event.id, event.startedAt ?? at)
    panel.until.delete(event.id)
  } else if (value !== 'queued' && !panel.since.has(event.id)) {
    panel.since.set(event.id, event.startedAt ?? at)
  }
  if (cardSettled(value)) panel.until.set(event.id, event.finishedAt ?? at)
  updateCardCell(panel, event.id)
  if (changed) {
    renderDispatchHeader(panel)
    // 选中哪一位是用户的决定：状态更新不抢选中、不滚动、只把变化标在那一格上。
    const cell = panel.buttons.get(event.id)
    if (cell !== undefined) pulseCardCell(cell)
    if (!panel.details.open) panel.fresh.hidden = false
    if (panel.active === event.id) selectDispatch(panel, event.id)
  }
}

/**
 * 一轮汇总到达时收口卡片：还在动的格子按这一轮的结局收尾。
 *
 * 成员各自的终态事件不一定都到得了（取消、失败、连接断了），留着"进行中 + 秒数在跳"会让
 * 用户在已经结束的一轮里看到一个永远在干活的成员。这里只动还没定论的格子：成功的成员
 * （已经有终态）一律不动——不能把真实结果改成别的说法。
 */
export function settleCardForSummary(state_, at) {
  const panel = state.dispatch
  if (panel === null || panel === undefined) return
  // 只有**收尾**的汇总才收口：`waiting_user` / `external_pending` 是暂停（这一轮还活着，
  // 成员真的还在等），把它们说成"已停止"是假话。
  if (!['completed', 'failed', 'cancelled', 'partial'].includes(state_)) return
  for (const id of panel.order) {
    const value = panel.states.get(id)
    if (cardSettled(value)) continue
    // 明确说"已停止"：这一轮结束了，而这一格没有交回结果，不去替它编一个成功。
    panel.states.set(id, 'cancelled')
    panel.until.set(id, at)
    updateCardCell(panel, id)
  }
  renderDispatchHeader(panel)
  syncCardTicker()
}

/** 状态刚变化的那一格做一次描边脉冲：看得见变化，但不打断阅读（不动滚动、不抢焦点）。 */
export function pulseCardCell(cell) {
  cell.classList.remove('dcard__cell--pulse')
  // 读一次布局属性，保证连续两次变化都能重新触发动画（否则类名重加不会重放）。
  void cell.offsetWidth
  cell.classList.add('dcard__cell--pulse')
  setTimeout(() => { cell.classList.remove('dcard__cell--pulse') }, 600)
}
