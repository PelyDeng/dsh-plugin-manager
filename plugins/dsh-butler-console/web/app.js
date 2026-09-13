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

import { ApiError, api, avatarUrl, chat, reply, uploadAvatar } from './api.js'

/** 成员配色：按 agentId 稳定取色，所以同一个插件每次都是同一个颜色。 */
const PALETTE = ['#4d96ff', '#2ec4a6', '#ff6b57', '#9b5de5', '#ffb703', '#e8709a']

const STATE_TEXT = {
  queued: '排队中',
  dispatched: '刚收到活',
  running: '在干活',
  waiting_user: '等着你回话',
  succeeded: '交差了',
  failed: '翻车了',
  cancelled: '不干了',
  summarizing: '在写总结',
  completed: '收工',
}

/** 协同链路：页面上的每一步都能追到一次真实事件。 */
const RAIL_STEPS = [
  { key: 'ask', label: '老板发话' },
  { key: 'parse', label: '牛马大总管听懂' },
  { key: 'dispatch', label: '派活' },
  { key: 'work', label: '牛马干活' },
  { key: 'sum', label: '交差' },
]

const SUGGESTIONS = [
  '整理一篇园区封闭化管理介绍，再给点博客发布建议',
  '帮我查一下园区最近的通行情况，顺便说说异常',
  'DSH 插件接入要准备哪些声明文件？给我个清单',
]

const MOTTO_KEY = 'butler.motto'
const DEFAULT_MOTTO = '打工是不可能打工的，但派活可以'

const el = {
  thread: document.getElementById('thread'),
  rail: document.getElementById('rail'),
  composer: document.getElementById('composer'),
  input: document.getElementById('message-input'),
  send: document.getElementById('send-button'),
  stop: document.getElementById('stop-button'),
  hint: document.getElementById('composer-hint'),
  count: document.getElementById('composer-count'),
  chatList: document.getElementById('chat-list'),
  chatSearch: document.getElementById('chat-search'),
  crewFaces: document.getElementById('crew-faces'),
  crewLine: document.getElementById('crew-line'),
  crewNote: document.getElementById('crew-note'),
  groupSub: document.getElementById('group-sub'),
  memberList: document.getElementById('member-list'),
  metrics: document.getElementById('metrics'),
  statusList: document.getElementById('status-list'),
  failureList: document.getElementById('failure-list'),
  motto: document.getElementById('motto'),
  identity: document.getElementById('identity'),
  topStatus: document.getElementById('top-status'),
  newChat: document.getElementById('new-chat'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  drawerToggle: document.getElementById('drawer-toggle'),
  backdrop: document.getElementById('drawer-backdrop'),
}

const state = {
  conversationId: null,
  members: [],
  /** agentId → 头像版本号，用于破缓存。 */
  avatarStamps: new Map(),
  streaming: false,
  abort: null,
  /** 子任务 id → 该成员当前的气泡与状态节点，供流式增量原地更新。 */
  bubbles: new Map(),
  /** 大总管正在流式发言的那条气泡；落定的 `chat` 收它。 */
  butlerSpeech: null,
  /** 子任务 id → 等待中的提问卡，收到回复后移除。 */
  asks: new Map(),
  taskId: null,
  /** 当前任务的链路状态。 */
  rail: { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' },
  openMember: null,
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

function make(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date().toDateString()) return clock
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${clock}`
}

function formatElapsed(from) {
  if (!from) return ''
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/** 按 agentId 稳定取色；配过本地配色时优先用本地配色。 */
function accentOf(agentId) {
  const member = state.members.find(item => item.agentId === agentId)
  if (member?.accent) return member.accent
  let hash = 0
  for (const char of String(agentId)) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

function displayNameOf(agentId) {
  const member = state.members.find(item => item.agentId === agentId)
  return member?.displayName ?? agentId
}

function declaredNameOf(agentId) {
  const member = state.members.find(item => item.agentId === agentId)
  return member?.declaredName ?? agentId
}

/** 成员头像：上传过就用图片，否则用首字加配色。 */
function avatarNode(agentId, size = '') {
  const node = make('div', `avatar${size ? ` avatar--${size}` : ''}`)
  node.style.background = accentOf(agentId)
  const stamp = state.avatarStamps.get(agentId)
  if (stamp !== undefined) {
    const image = document.createElement('img')
    image.alt = ''
    image.src = avatarUrl(agentId, stamp)
    // 图片加载失败时退回首字，不让头像位空着。
    image.addEventListener('error', () => { image.remove() })
    node.appendChild(image)
  }
  node.appendChild(make('span', null, [...displayNameOf(agentId)][0] ?? '?'))
  return node
}

function threadInner() {
  let inner = el.thread.querySelector('.thread__inner')
  if (inner === null) {
    inner = make('div', 'thread__inner')
    el.thread.appendChild(inner)
  }
  return inner
}

function append(node) {
  threadInner().appendChild(node)
}

function scrollIfFollowing() {
  const near = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight
  if (near < 140) el.thread.scrollTop = el.thread.scrollHeight
}

/* ── 中栏：消息 ───────────────────────────────────────────────────────── */

function userMessage(text, time) {
  const msg = make('div', 'msg msg--user')
  const col = make('div', 'msg__col')
  col.appendChild(make('div', 'bubble', text))
  col.appendChild(make('div', 'msg__meta', formatTime(time)))
  msg.appendChild(col)
  msg.appendChild(avatarNode('__boss__', 'sm')).style.background = '#3d3630'
  append(msg)
}

/**
 * 牛马大总管发言。带着 bowtie 身份，和成员区分开。
 *
 * 返回句柄：`chat_delta` 用它原地续写同一条气泡，落定的 `chat` 再用最终正文替换预览。
 */
function butlerMessage(text, time) {
  const msg = make('div', 'msg msg--butler')
  const avatar = make('div', 'avatar avatar--sm')
  avatar.style.background = '#3d3630'
  avatar.appendChild(make('span', null, '牛'))
  msg.appendChild(avatar)
  const col = make('div', 'msg__col')
  const head = make('div', 'msg__head')
  head.appendChild(make('span', 'msg__name', '牛马大总管'))
  head.appendChild(make('span', 'msg__tag', '负责听你说人话'))
  col.appendChild(head)
  const bubble = make('div', 'bubble')
  const body = make('span', null, text)
  const caret = make('span', 'caret')
  caret.hidden = true
  bubble.appendChild(body)
  bubble.appendChild(caret)
  col.appendChild(bubble)
  if (time) col.appendChild(make('div', 'msg__meta', formatTime(time)))
  msg.appendChild(col)
  append(msg)
  return { msg, bubble, body, caret }
}

/** 大总管正在说的那条气泡：第一条增量开它，落定的 `chat` 收它。 */
function butlerSpeech() {
  if (state.butlerSpeech === null) {
    const view = butlerMessage('')
    view.caret.hidden = false
    state.butlerSpeech = { ...view, text: '' }
  }
  return state.butlerSpeech
}

function butlerDelta(text) {
  const speech = butlerSpeech()
  speech.text += text
  speech.body.textContent = speech.text
}

/**
 * 落定的发言。
 *
 * 有正在流的那条就替换它的正文并收起光标 —— 重试过的那一版不会留在页面上；
 * 没有（例如直接回答、历史恢复）就照旧新起一条。
 */
function butlerSettle(text, time) {
  const speech = state.butlerSpeech
  state.butlerSpeech = null
  if (speech === null) { butlerMessage(text, time); return }
  speech.body.textContent = text
  speech.caret.hidden = true
}

/** 计划贴纸：拆解结果，每条带 @ 句柄。 */
function planNote(event) {
  const note = make('div', 'plan-note')
  note.appendChild(make('div', 'plan-note__title', '活分好了 👇'))
  const list = make('ol')
  for (const subtask of event.subtasks) {
    const item = make('li')
    item.appendChild(document.createTextNode(subtask.goal))
    item.appendChild(document.createTextNode(' '))
    const handle = make('span', 'plan-note__handle', `@${subtask.agentId}`)
    handle.style.color = accentOf(subtask.agentId)
    item.appendChild(handle)
    list.appendChild(item)
  }
  note.appendChild(list)
  return note
}

/**
 * 一位成员的一条消息块。
 *
 * 返回的句柄让流式增量、状态变化、进度都能原地更新，不需要重绘整条消息。
 */
function memberMessage(agentId, handle) {
  const msg = make('div', 'msg')
  msg.appendChild(avatarNode(agentId))
  const col = make('div', 'msg__col')

  const head = make('div', 'msg__head')
  const name = make('span', 'msg__name', displayNameOf(agentId))
  name.style.color = accentOf(agentId)
  head.appendChild(name)
  head.appendChild(make('span', 'msg__handle', `@${agentId}`))
  const status = make('span', 'msg__tag', '刚收到活')
  head.appendChild(status)
  col.appendChild(head)

  const bubble = make('div', 'bubble')
  // 思考行：默认收起，只有执行方真的上报了快照才出现；正文照旧在它下面。
  const think = make('details', 'think')
  think.hidden = true
  const thinkSummary = make('summary', 'think__summary')
  thinkSummary.appendChild(make('span', 'think__title', '思考'))
  const thinkPreview = make('span', 'think__preview')
  thinkSummary.appendChild(thinkPreview)
  const thinkBody = make('div', 'think__body')
  think.appendChild(thinkSummary)
  think.appendChild(thinkBody)
  bubble.appendChild(think)
  const text = make('span')
  const caret = make('span', 'caret')
  caret.hidden = true
  bubble.appendChild(text)
  bubble.appendChild(caret)
  col.appendChild(bubble)

  const footer = make('div')
  col.appendChild(footer)

  msg.appendChild(col)
  append(msg)

  const view = {
    agentId,
    startedAt: Date.now(),
    msg,
    col,
    status,
    bubble,
    text,
    caret,
    footer,
    body: '',
    progress: null,
    think: { node: think, preview: thinkPreview, body: thinkBody },
  }
  state.bubbles.set(handle, view)
  return view
}

/**
 * 成员的可展示思考。
 *
 * 快照是**覆盖**语义：整行文本被替换，不做追加。默认收起，摘要行只留最新一行预览，
 * 免得长推理把气泡撑开、把正文挤下去。
 */
function setThinking(view, thinking) {
  if (view === undefined) return
  view.think.node.hidden = false
  view.think.body.textContent = thinking
  const lines = thinking.split('\n').map(line => line.trim()).filter(line => line !== '')
  const latest = lines.length === 0 ? '' : lines[lines.length - 1]
  view.think.preview.textContent = latest
  view.think.preview.hidden = latest === ''
}

function ensureProgress(view) {
  if (view.progress !== null) return view.progress
  const wrap = make('div', 'progress')
  const track = make('div', 'progress__track')
  const fill = make('div', 'progress__fill')
  fill.style.width = '12%'
  track.appendChild(fill)
  const label = make('span', 'progress__label', '')
  wrap.appendChild(track)
  wrap.appendChild(label)
  view.footer.appendChild(wrap)
  view.progress = { wrap, fill, label, value: 12 }
  return view.progress
}

/* ── 中栏：链路条 ─────────────────────────────────────────────────────── */

function renderRail() {
  clear(el.rail)
  RAIL_STEPS.forEach((step, index) => {
    if (index > 0) el.rail.appendChild(make('span', 'rail__arrow', '→'))
    const node = make('span', 'rail__step')
    node.dataset.state = step.key === 'ask' ? 'done' : (state.rail[step.key] ?? 'idle')
    node.appendChild(make('span', null, step.label))
    el.rail.appendChild(node)
  })
}

function setRail(key, value) {
  if (key === 'ask') return
  if (state.rail[key] === value) return
  state.rail[key] = value
  renderRail()
}

function resetRail() {
  state.rail = { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' }
  renderRail()
}

/* ── 中栏：事件分发 ───────────────────────────────────────────────────── */

function handleEvent(event) {
  switch (event.type) {
    case 'conversation':
      state.conversationId = event.conversationId
      rememberConversation(event.conversationId)
      return

    case 'user':
      state.butlerSpeech = null
      userMessage(event.text, event.time)
      break

    case 'chat':
      butlerSettle(event.text, event.time)
      break

    case 'chat_delta':
      butlerDelta(event.text)
      break

    case 'plan': {
      state.taskId = event.taskId
      state.bubbles.clear()
      state.asks.clear()
      setRail('parse', 'done')
      setRail('dispatch', 'active')
      // 计划贴纸是新的一条消息：先收掉可能还开着的大总管气泡，别把两段话并到一条里。
      state.butlerSpeech = null
      butlerMessage('收到老板，这活我拆成三份，已经喊人了。')
      append(planNote(event))
      break
    }

    case 'subtask':
      handleSubtask(event)
      break

    case 'subtask_delta': {
      const view = state.bubbles.get(event.id)
      if (view === undefined) break
      view.body += event.delta
      view.text.textContent = view.body
      view.caret.hidden = false
      const progress = ensureProgress(view)
      progress.value = Math.min(92, progress.value + 4)
      progress.fill.style.width = `${progress.value}%`
      break
    }

    case 'subtask_thinking':
      setThinking(state.bubbles.get(event.id), event.thinking)
      break

    case 'summary':
      resetRail()
      if (event.state === 'completed') setRail('sum', 'done')
      else if (event.state === 'waiting_user') setRail('work', 'active')
      for (const view of state.bubbles.values()) view.caret.hidden = true
      append(summaryCard(event))
      state.bubbles.clear()
      state.asks.clear()
      break

    case 'error':
      append(make('p', 'error-line', event.message))
      break

    default:
      break
  }
  scrollIfFollowing()
}

function handleSubtask(event) {
  const view = state.bubbles.get(event.id) ?? memberMessage(event.agentId, event.id)
  view.status.textContent = STATE_TEXT[event.state] ?? event.state
  view.status.style.color =
    event.state === 'failed' ? 'var(--bt-error)'
      : event.state === 'waiting_user' ? 'var(--bt-warn)'
        : event.state === 'succeeded' ? 'var(--bt-ok)'
          : 'var(--bt-ink-soft)'

  if (event.state === 'dispatched') {
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

  view.caret.hidden = true

  if (event.state === 'waiting_user') {
    view.bubble.classList.add('bubble--wait')
    if (view.body === '') view.text.textContent = event.question ?? event.detail
    setRail('work', 'active')
    askCard(view, event)
    return
  }

  if (event.state === 'succeeded') {
    view.bubble.classList.add('bubble--done')
    if (view.body === '') view.text.textContent = event.detail
    if (view.progress !== null) {
      view.progress.value = 100
      view.progress.fill.style.width = '100%'
      view.progress.label.textContent = '搞定'
    }
    view.footer.appendChild(make('div', 'msg__meta', `耗时 ${formatElapsed(view.startedAt)}`))
    return
  }

  if (event.state === 'failed' || event.state === 'cancelled') {
    view.bubble.classList.add(event.state === 'failed' ? 'bubble--fail' : '')
    if (view.body === '') view.text.textContent = event.detail
    else view.bubble.appendChild(make('div', 'msg__meta', event.detail))
    return
  }
}

/**
 * 请示卡：成员在等你回话时，就地给输入框和两个按钮。
 *
 * 「我来说」把话交回同一位成员；「你看着办」让它自己决定，不再追问。
 */
function askCard(view, event) {
  if (state.asks.has(event.id)) return
  const card = make('div', 'ask')
  card.appendChild(make('div', null, event.question ?? event.detail ?? '需要你补充点信息'))

  const row = make('div', 'ask__row')
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '补充点什么…'
  row.appendChild(input)

  const send = make('button', 'btn btn--tiny btn--amber', '我来说')
  send.type = 'button'
  const decide = make('button', 'btn btn--tiny', '你看着办')
  decide.type = 'button'
  row.appendChild(send)
  row.appendChild(decide)
  card.appendChild(row)
  view.footer.appendChild(card)

  const submit = async (text, decideByAgent) => {
    if (state.streaming) return
    card.remove()
    state.asks.delete(event.id)
    view.bubble.classList.remove('bubble--wait')
    await runReply({ taskId: event.taskId, subtaskId: event.id, text, decideByAgent })
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
  const title = event.state === 'completed' ? '老板，活干完了'
    : event.state === 'failed' ? '这次翻车了'
      : event.state === 'cancelled' ? '已喊停'
        : '还等你回话'
  card.appendChild(make('div', 'summary__title', title))
  card.appendChild(make('p', 'summary__body', event.text || event.error || '（没什么好说的）'))
  if (event.error && event.text) card.appendChild(make('div', 'msg__meta', event.error))
  return card
}

/* ── 中栏：空状态 ─────────────────────────────────────────────────────── */

function renderWelcome() {
  clear(el.thread)
  const box = make('div', 'welcome')
  box.appendChild(make('h2', null, '老板，今天想干点啥？'))
  box.appendChild(make('p', null, '把活说清楚就行。牛马大总管先听懂，再替你把人喊来，你只管收结果。'))
  const list = make('div', 'welcome__list')
  for (const text of SUGGESTIONS) {
    const item = make('button', 'welcome__item', text)
    item.type = 'button'
    item.addEventListener('click', () => {
      el.input.value = text
      autosize()
      el.input.focus()
    })
    list.appendChild(item)
  }
  box.appendChild(list)
  el.thread.appendChild(box)
  renderRail()
}

/* ── 发送与回复 ───────────────────────────────────────────────────────── */

function setBusy(on) {
  state.streaming = on
  el.send.disabled = on
  el.input.disabled = on
  el.stop.hidden = !on
  el.topStatus.textContent = on ? '正在处理' : '已上线'
  el.hint.textContent = on ? '牛马大总管正在安排，稍等' : '牛马大总管先听明白，再替你把人喊来'
}

function newConversationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('')
  return `butler-web-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function rememberConversation(id) {
  try { localStorage.setItem('butler.conversationId', id) } catch { /* 隐私模式下忽略。 */ }
}

async function sendMessage(text) {
  const trimmed = text.trim()
  if (trimmed === '' || state.streaming) return
  if (state.conversationId === null) state.conversationId = newConversationId()

  clear(el.thread)
  threadInner()
  resetRail()
  state.bubbles.clear()
  state.asks.clear()
  setRail('parse', 'active')
  setBusy(true)
  state.abort = new AbortController()
  el.input.value = ''
  autosize()

  try {
    for await (const event of chat({ conversationId: state.conversationId, message: trimmed, signal: state.abort.signal })) {
      handleEvent(event)
    }
  } catch (error) {
    reportFailure(error, '发送失败，再试一次？')
  } finally {
    finishTurn()
  }
}

async function runReply({ taskId, subtaskId, text, decideByAgent }) {
  setBusy(true)
  state.abort = new AbortController()
  try {
    for await (const event of reply({ taskId, subtaskId, text, decideByAgent, signal: state.abort.signal })) {
      handleEvent(event)
    }
  } catch (error) {
    reportFailure(error, '回复没送出去，再试一次？')
  } finally {
    finishTurn()
  }
}

function reportFailure(error, fallback) {
  if (error?.name === 'AbortError') {
    append(make('p', 'error-line', '已喊停。'))
    return
  }
  append(make('p', 'error-line', error instanceof Error && error.message ? error.message : fallback))
}

async function finishTurn() {
  setBusy(false)
  state.abort = null
  await refreshPanels()
  void refreshChatList()
  el.input.focus()
}

/* ── 右栏 ─────────────────────────────────────────────────────────────── */

function renderMembers() {
  clear(el.memberList)
  if (state.members.length === 0) {
    el.memberList.appendChild(make('p', 'empty', '还没有能派活的成员。'))
    return
  }
  for (const member of state.members) {
    const card = make('div', 'member')
    card.dataset.open = String(state.openMember === member.agentId)

    const avatarWrap = make('div', 'member__avatar')
    avatarWrap.appendChild(avatarNode(member.agentId, 'lg'))
    const camera = make('span', 'member__camera', '📷')
    camera.title = '换张脸'
    const picker = document.createElement('input')
    picker.type = 'file'
    picker.accept = 'image/png,image/jpeg,image/webp'
    picker.className = 'visually-hidden'
    camera.addEventListener('click', () => picker.click())
    picker.addEventListener('change', () => {
      const file = picker.files?.[0]
      if (file) void applyAvatar(member.agentId, file)
    })
    avatarWrap.appendChild(camera)
    avatarWrap.appendChild(picker)
    card.appendChild(avatarWrap)

    const body = make('div')
    const head = make('div', 'member__head')
    const titles = make('div')
    titles.style.minWidth = '0'
    titles.appendChild(make('div', 'member__name', member.displayName))
    titles.appendChild(make('div', 'member__declared', `插件声明：${member.declaredName}`))
    head.appendChild(titles)
    head.appendChild(make('span', 'spacer'))
    head.appendChild(make('span', `dot dot--${member.online ? 'online' : 'queued'}`))
    head.appendChild(make('span', 'member__chev', state.openMember === member.agentId ? '▴' : '▾'))
    body.appendChild(head)

    if (member.capabilities.length > 0) {
      const caps = make('div', 'member__caps')
      for (const cap of member.capabilities) caps.appendChild(make('span', 'member__cap', cap))
      body.appendChild(caps)
    }

    if (state.openMember === member.agentId) {
      const form = make('div', 'member__body')
      const nameField = make('div', 'field')
      nameField.appendChild(make('label', null, '外号'))
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.maxLength = 24
      nameInput.value = member.displayName
      nameInput.placeholder = member.declaredName
      nameField.appendChild(nameInput)
      form.appendChild(nameField)

      const colorField = make('div', 'field')
      colorField.appendChild(make('label', null, '配色'))
      const swatches = make('div', 'swatches')
      for (const color of PALETTE) {
        const swatch = make('button', 'swatch')
        swatch.type = 'button'
        swatch.style.background = color
        swatch.setAttribute('aria-pressed', String(accentOf(member.agentId).toLowerCase() === color))
        swatch.title = color
        swatch.addEventListener('click', () => { void applyAlias(member.agentId, nameInput.value, color) })
        swatches.appendChild(swatch)
      }
      colorField.appendChild(swatches)
      form.appendChild(colorField)

      const actions = make('div', 'ask__row')
      const save = make('button', 'btn btn--tiny btn--primary', '保存')
      save.type = 'button'
      save.addEventListener('click', () => { void applyAlias(member.agentId, nameInput.value) })
      actions.appendChild(save)
      if (state.avatarStamps.has(member.agentId)) {
        const reset = make('button', 'btn btn--tiny btn--ghost', '删掉头像')
        reset.type = 'button'
        reset.addEventListener('click', () => { void applyClearAvatar(member.agentId) })
        actions.appendChild(reset)
      }
      form.appendChild(actions)
      body.appendChild(form)
    }

    card.appendChild(body)
    card.addEventListener('click', event => {
      if (event.target.closest('input,button')) return
      state.openMember = state.openMember === member.agentId ? null : member.agentId
      renderMembers()
    })
    el.memberList.appendChild(card)
  }
}

function renderCrew() {
  clear(el.crewFaces)
  for (const member of state.members) {
    const face = avatarNode(member.agentId, 'sm')
    face.title = `${member.displayName}（@${member.agentId}）`
    el.crewFaces.appendChild(face)
  }
  const online = state.members.filter(member => member.online).length
  const total = state.members.length
  el.crewLine.textContent = `${total} 个牛马 · ${online} 个能干活`
  el.crewNote.textContent = `共 ${total} 位，${online} 位在场`
  el.groupSub.textContent = `${total} 位成员 · ${online} 位在场`
}

function renderMetrics(counts) {
  clear(el.metrics)
  const tiles = [
    { label: '在干活', value: counts.running },
    { label: '等你回话', value: counts.waitingUser },
    { label: '翻车', value: counts.failed },
    { label: '已交差', value: counts.completed },
  ]
  for (const tile of tiles) {
    const box = make('div', 'metric')
    box.appendChild(make('span', 'metric__value', tile.value))
    box.appendChild(make('span', 'metric__label', tile.label))
    el.metrics.appendChild(box)
  }
}

function renderStatuses() {
  clear(el.statusList)
  for (const member of state.members) {
    const row = make('div', 'status-row')
    row.appendChild(avatarNode(member.agentId, 'sm'))
    row.appendChild(make('span', 'status-row__name', member.displayName))
    row.appendChild(make('span', 'status-row__state', member.online ? '待命' : '不在场'))
    el.statusList.appendChild(row)
  }
}

function renderFailures(items) {
  clear(el.failureList)
  if (items.length === 0) {
    el.failureList.appendChild(make('p', 'empty', '暂无翻车记录，保持住'))
    return
  }
  for (const item of items) {
    const row = make('button', 'failure-row')
    row.type = 'button'
    row.appendChild(make('span', 'failure-row__goal', item.goal))
    row.appendChild(make('span', 'failure-row__meta', `${formatTime(item.updatedAt)} · ${item.error || '没给原因'}`))
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
    el.chatList.appendChild(make('p', 'empty', items.length === 0 ? '还没派过活，先来一单？' : '没找到，换个词？'))
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

async function applyAlias(agentId, displayName, accent) {
  try {
    const result = await api.setAlias(agentId, displayName, accent ?? accentOf(agentId))
    state.members = result.items
    renderMembers()
    renderCrew()
    renderStatuses()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '没保存成功')
  }
}

async function applyAvatar(agentId, file) {
  try {
    const result = await uploadAvatar(agentId, file)
    state.members = result.items
    state.avatarStamps.set(agentId, Date.now())
    renderMembers()
    renderCrew()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '头像没换上')
  }
}

async function applyClearAvatar(agentId) {
  try {
    const result = await api.clearAvatar(agentId)
    state.members = result.items
    state.avatarStamps.delete(agentId)
    renderMembers()
    renderCrew()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '没删掉')
  }
}

/* ── 数据刷新 ─────────────────────────────────────────────────────────── */

async function refreshPanels() {
  try {
    const [members, overview] = await Promise.all([api.members(), api.overview()])
    state.members = members.items
    for (const member of members.items) {
      if (!state.avatarStamps.has(member.agentId)) state.avatarStamps.set(member.agentId, 1)
    }
    renderMembers()
    renderCrew()
    renderMetrics(overview.counts)
    renderStatuses()
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
    const [conversations, history] = await Promise.all([api.conversations(), api.history({ limit: 40 })])
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
  } catch {
    el.chatList.replaceChildren(make('p', 'empty', '读取记录失败'))
  }
}

/** 打开一个历史会话：把它的任务按先后重建成消息流。 */
async function openConversation(id) {
  if (state.streaming) return
  state.conversationId = id
  rememberConversation(id)
  clear(el.thread)
  threadInner()
  state.bubbles.clear()
  state.asks.clear()
  resetRail()
  try {
    const page = await api.history({ limit: 40 })
    const mine = page.items.filter(task => task.conversationId === id).reverse()
    if (mine.length === 0) {
      renderWelcome()
      return
    }
    for (const task of mine) {
      const record = await api.task(task.id)
      renderTaskRecord(record)
    }
    el.thread.scrollTop = el.thread.scrollHeight
  } catch {
    renderWelcome()
  }
  void refreshChatList()
}

async function openTask(id) {
  try {
    const record = await api.task(id)
    state.conversationId = record.conversationId
    rememberConversation(record.conversationId)
    clear(el.thread)
    threadInner()
    state.bubbles.clear()
    resetRail()
    renderTaskRecord(record)
    el.thread.scrollTop = el.thread.scrollHeight
  } catch (error) {
    append(make('p', 'error-line', error instanceof Error ? error.message : '打不开这条记录'))
  }
}

/**
 * 把一条持久化的任务渲染成消息流。
 *
 * 刷新页面后走这条路径，所以显示的状态与数据库里的一致；原始对话正文由宿主的会话日志
 * 承载，这里只重建任务维度能确定的部分。
 */
function renderTaskRecord(record) {
  userMessage(record.goal, record.createdAt)
  butlerMessage(record.note ? `我按这个思路拆的：${record.note}` : '我按下面的方式拆了任务。', record.createdAt)
  append(planNote({
    subtasks: record.subtasks.map(item => ({ goal: item.goal, agentId: item.agentId })),
  }))
  state.taskId = record.id
  for (const subtask of record.subtasks) {
    const view = memberMessage(subtask.agentId, subtask.id)
    view.startedAt = subtask.startedAt ?? record.createdAt
    view.status.textContent = STATE_TEXT[subtask.state] ?? subtask.state
    const text = subtask.state === 'failed' || subtask.state === 'cancelled'
      ? (subtask.error || '没干成')
      : (subtask.result || STATE_TEXT[subtask.state] || '')
    view.text.textContent = text
    view.body = text
    if (subtask.state === 'succeeded') {
      view.bubble.classList.add('bubble--done')
      if (subtask.finishedAt && subtask.startedAt) {
        view.footer.appendChild(make('div', 'msg__meta', `耗时 ${formatElapsed(subtask.startedAt)}`))
      }
    }
    if (subtask.state === 'failed') view.bubble.classList.add('bubble--fail')
    if (subtask.state === 'waiting_user') {
      view.bubble.classList.add('bubble--wait')
      // 历史里的等待无法直接回复（进程已重启），只提示重新描述目标。
      view.footer.appendChild(make('div', 'msg__meta', '这次等待已经过去了，重新说一遍目标就能再接上'))
    }
  }
  append(summaryCard({
    state: record.state,
    text: record.summary,
    error: record.error,
  }))
}

/* ── 老板语录 ─────────────────────────────────────────────────────────── */

function renderMotto() {
  clear(el.motto)
  let current = DEFAULT_MOTTO
  try { current = localStorage.getItem(MOTTO_KEY) ?? DEFAULT_MOTTO } catch { /* 忽略。 */ }
  const button = make('button', null, `${current} ✏️`)
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

function openNewChat() {
  if (state.streaming) return
  state.conversationId = null
  state.taskId = null
  clear(el.thread)
  threadInner()
  state.bubbles.clear()
  resetRail()
  renderWelcome()
  void refreshChatList()
  el.input.focus()
}

function bind() {
  el.composer.addEventListener('submit', event => {
    event.preventDefault()
    void sendMessage(el.input.value)
  })

  el.input.addEventListener('input', autosize)
  el.input.addEventListener('keydown', event => {
    // Enter 派活，Shift+Enter 换行；输入法组合期间不拦截。
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendMessage(el.input.value)
    }
  })

  el.stop.addEventListener('click', () => {
    state.abort?.abort()
    if (state.conversationId) void api.stop(state.conversationId).catch(() => {})
  })

  el.newChat.addEventListener('click', openNewChat)

  let searchTimer = 0
  el.chatSearch.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { void refreshChatList() }, 200)
  })

  const setDrawer = open => {
    document.body.dataset.drawer = open ? 'open' : 'closed'
    el.drawerToggle.setAttribute('aria-expanded', String(open))
    el.backdrop.hidden = !open
  }
  el.drawerToggle.addEventListener('click', () => setDrawer(document.body.dataset.drawer !== 'open'))
  el.backdrop.addEventListener('click', () => setDrawer(false))

  el.sidebarToggle.addEventListener('click', () => {
    const open = document.body.dataset.sidebar !== 'open'
    document.body.dataset.sidebar = open ? 'open' : 'closed'
    el.sidebarToggle.setAttribute('aria-expanded', String(open))
  })
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
  renderMotto()
  renderWelcome()
  autosize()
  await loadIdentity()
  await refreshPanels()
  await refreshChatList()
  // 右栏状态会随别的会话变化，低频轮询即可；流式期间不打断。
  setInterval(() => { if (!state.streaming) void refreshPanels() }, 15000)
  el.input.focus()
}

void main()
