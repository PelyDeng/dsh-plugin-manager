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

import { ApiError, api, avatarUrl, chat, events, eventsHead, reply, uploadAvatar, ROUTE_PREFIX } from './api.js'

/** 成员配色：按 agentId 稳定取色，所以同一个插件每次都是同一个颜色。 */
const PALETTE = ['#4d96ff', '#2ec4a6', '#ff6b57', '#9b5de5', '#ffb703', '#e8709a']

/**
 * 默认涂鸦头像：已知插件映射到 web/media/avatars/ 下的生成素材；上传过头像的用户看不到它们。
 * 没有映射的成员退回首字配色圆，页面不因为多接了一个插件就缺图。
 */
const DEFAULT_AVATAR_FILES = new Map([
  ['butler', 'avatar-butler.png'],
  ['blog', 'avatar-blog.png'],
  ['closedoff', 'avatar-closedoff.png'],
  ['example', 'avatar-example.png'],
  ['__boss__', 'avatar-boss.png'],
])

function defaultAvatarUrl(agentId) {
  const file = DEFAULT_AVATAR_FILES.get(String(agentId))
  return file === undefined ? null : `${ROUTE_PREFIX}/assets/media/avatars/${file}`
}

/** 内置头像清单：预生成的 15 个涂鸦形象，设置页里一键换上。 */
const BUILTIN_AVATARS = [
  { file: 'builtin-01.png', label: '柴犬' },
  { file: 'builtin-02.png', label: '猫咪' },
  { file: 'builtin-03.png', label: '熊猫' },
  { file: 'builtin-04.png', label: '兔子' },
  { file: 'builtin-05.png', label: '青蛙' },
  { file: 'builtin-06.png', label: '小鸡' },
  { file: 'builtin-07.png', label: '猫头鹰' },
  { file: 'builtin-08.png', label: '机器人' },
  { file: 'builtin-09.png', label: '云朵' },
  { file: 'builtin-10.png', label: '太阳' },
  { file: 'builtin-11.png', label: '咖啡' },
  { file: 'builtin-12.png', label: '书本' },
  { file: 'builtin-13.png', label: '信封' },
  { file: 'builtin-14.png', label: '蜗牛' },
  { file: 'builtin-15.png', label: '草莓' },
]

/** 换内置头像 = 把那张图当作上传头像交给现有接口，服务端逻辑零改动。 */
async function applyBuiltinAvatar(agentId, file) {
  try {
    const response = await fetch(`${ROUTE_PREFIX}/assets/media/avatars/builtin/${file}`)
    if (!response.ok) throw new Error('内置头像读取失败')
    const blob = await response.blob()
    await applyAvatar(agentId, new File([blob], file, { type: 'image/png' }))
  } catch (error) {
    window.alert(error instanceof Error && error.message ? error.message : '没换上，再试一次')
  }
}

const STATE_TEXT = {
  queued: '排队中',
  dispatched: '刚收到活',
  running: '在干活',
  waiting_user: '等着你回话',
  external_pending: '待外部处理',
  partial: '部分完成',
  succeeded: '交差了',
  failed: '翻车了',
  cancelled: '不干了',
  summarizing: '在写总结',
  completed: '收工',
}

/** 协同链路：页面上的每一步都能追到一次真实事件。 */
const RAIL_STEPS = [
  { key: 'ask', label: '说个活' },
  { key: 'parse', label: '总管听懂' },
  { key: 'dispatch', label: '派活' },
  { key: 'work', label: '牛马干活' },
  { key: 'sum', label: '交差' },
]

/** 链路徽章里的小图标：纯静态标记，不含任何用户数据。 */
const SVG_NS = 'http://www.w3.org/2000/svg'

const RAIL_ICON_PATHS = {
  ask: '<path d="M2.5 6.8 9 3.4 9 12.6 2.5 9.4 Z" fill="currentColor"/><path d="M11 6.1 C 12.4 6.7, 12.4 9.3, 11 9.9 M4.6 9.9 5.3 13.2 7.1 12.8 6.4 10.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  parse: '<path d="M3 4.6 C 3 3.4, 3.9 2.6, 5 2.6 L 11 2.6 C 12.1 2.6, 13 3.4, 13 4.6 L 13 8.4 C 13 9.5, 12.1 10.4, 11 10.4 L 8.4 10.4 6 12.6 6.1 10.4 L 5 10.4 C 3.9 10.4, 3 9.5, 3 8.4 Z" fill="currentColor"/>',
  dispatch: '<rect x="4.2" y="3.2" width="7.6" height="10" rx="1.4" fill="currentColor"/><rect x="6" y="1.8" width="4" height="2.8" rx="1" fill="currentColor"/><path d="M6 7 10 7 M6 9.4 9.2 9.4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>',
  work: '<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1.8 8 3.4 M8 12.6 8 14.2 M1.8 8 3.4 8 M12.6 8 14.2 8 M3.6 3.6 4.7 4.7 M11.3 11.3 12.4 12.4 M12.4 3.6 11.3 4.7 M4.7 11.3 3.6 12.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  sum: '<path d="M3.5 8.6 6.6 11.6 12.6 4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
}

/** 静态涂鸦小件（都是固定标记，不含用户数据），集中一处方便核对。 */
const DOODLE_PATHS = {
  /** 使用者头像：简笔人脸 + 领带。 */
  bossFace: '<circle cx="12" cy="8.6" r="4.4" fill="#fff" stroke="#3d3630" stroke-width="1.6"/><path d="M10.4 8.2 10.4 8.3 M13.6 8.2 13.6 8.3" stroke="#3d3630" stroke-width="1.8" stroke-linecap="round"/><path d="M10.6 10.4 C 11.4 11, 12.6 11, 13.4 10.4" fill="none" stroke="#3d3630" stroke-width="1.2" stroke-linecap="round"/><path d="M5.2 20.4 C 6.6 16.8, 9 15.2, 12 15.2 C 15 15.2, 17.4 16.8, 18.8 20.4 Z" fill="#fff" stroke="#3d3630" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 15.4 10.9 16.9 12 19.2 13.1 16.9 Z" fill="#ff6b57" stroke="#3d3630" stroke-width="1"/>',
  /** 链路条之间的歪箭头。 */
  railArrow: '<path d="M1.5 6.5 C 6 5.4, 11 5.7, 20.5 6.2 M16.5 2.6 C 18.2 4, 19.7 5.2, 21.8 6.2 C 19.8 7.2, 18.2 8.4, 16.6 10" fill="none" stroke="#b9ad9c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
}

/** 造一个内联 SVG 小件；markup 是固定常量，见 DOODLE_PATHS / RAIL_ICON_PATHS。 */
function doodleSvg(markup, className) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  if (className) svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = markup
  return svg
}

const SUGGESTIONS = [
  '整理一篇园区封闭化管理介绍，再给点博客发布建议',
  '帮我查一下园区最近的通行情况，顺便说说异常',
  'DSH 插件接入要准备哪些声明文件？给我个清单',
]

const MOTTO_KEY = 'butler.motto'
const DEFAULT_MOTTO = '打工是不可能打工的，但派活可以'
/** 上次用过的会话。刷新后要拿它去问「这一轮还在跑吗」。 */
const CONVERSATION_KEY = 'butler.conversationId'

const el = {
  thread: document.getElementById('thread'),
  rail: document.getElementById('rail'),
  composer: document.getElementById('composer'),
  input: document.getElementById('message-input'),
  send: document.getElementById('send-button'),
  at: document.getElementById('at-button'),
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
  settingsButton: document.getElementById('settings-button'),
  settingsBack: document.getElementById('settings-back'),
  settings: document.getElementById('settings'),
  settingsMembers: document.getElementById('settings-members'),
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
  /** 视图代次：所有会话切换入口共用，异步回包先核对它，旧响应不许写进新视图。 */
  viewToken: 0,
  /** 发送时预渲染、等服务端回放确认的那条用户消息；失败时用它恢复草稿。 */
  pendingUser: null,
  /** 本轮事件消费进度：seq 用于断线重订的游标，taskId 用于 reset 后取快照。 */
  lastSeq: 0,
  lastRunTaskId: '',
  /** 本轮受理的 runId：重订时的预期对象（S06 不混轮次）。 */
  lastRunId: '',
  /** 上一条落定的大总管正文：汇总卡与之相同时不再重复整段（S12）。 */
  lastChatText: '',
  /** 子任务 id → 该成员当前的气泡与状态节点，供流式增量原地更新。 */
  bubbles: new Map(),
  /** 大总管正在流式发言的那条气泡；落定的 `chat` 收它。 */
  butlerSpeech: null,
  /** 子任务 id → 等待中的提问卡，收到回复后移除。 */
  asks: new Map(),
  taskId: null,
  /** 当前任务的链路状态。 */
  rail: { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' },
  settingsOpen: false,
}

/**
 * 流式诊断（方案 S01）：地址带 `?trace=stream` 打开。
 *
 * 只记录层级、事件类型、序号与本机单调时间，不记录正文、推理内容或凭据；跨机器时间
 * 不可直接相减。服务端对应观测点由 `BUTLER_STREAM_DEBUG=1` 打开，两边对同一轮 runId
 * 才能拼出「宿主帧 → 应用写出 → 客户端接收 → 绘制」四段。
 */
const streamTraceEnabled = new URLSearchParams(location.search).get('trace') === 'stream'
const streamTrace = []
function traceEvent(layer, event) {
  if (!streamTraceEnabled) return
  const record = {
    t: Math.round(performance.now()), layer, type: event.type,
    seq: event.seq ?? null, runId: event.runId ?? null,
    len: typeof event.text === 'string' ? event.text.length : typeof event.delta === 'string' ? event.delta.length : null,
  }
  streamTrace.push(record)
  console.debug('[butler-stream]', layer, record.type, `seq=${record.seq} len=${record.len} t=${record.t}`)
  if (streamTrace.length > 2000) streamTrace.shift()
}
globalThis.__butlerStreamTrace = streamTrace

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

/**
 * 已经过的时间。
 *
 * `to` 要给「结束时刻」，不能只按当前时间算：那样做完的活会一直往上加——隔十几分钟再打开，
 * 一个真实的 57 秒会被显示成 12 分钟。只有还在跑的时候才用当前时间。
 */
function formatElapsed(from, to = Date.now()) {
  // 实时流里是毫秒数，历史记录里是 ISO 字符串；直接相减会得到 NaN。
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (!from || Number.isNaN(start) || Number.isNaN(end)) return ''
  const seconds = Math.max(0, Math.round((end - start) / 1000))
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

/** 成员头像：上传过就用图片，失败或没上传时落到默认涂鸦，最后才是首字配色圆。 */
function avatarNode(agentId, size = '') {
  const node = make('div', `avatar${size ? ` avatar--${size}` : ''}`)
  node.style.background = accentOf(agentId)
  const stamp = state.avatarStamps.get(agentId)
  const defaultUrl = defaultAvatarUrl(agentId)
  const image = document.createElement('img')
  image.alt = ''
  image.addEventListener('error', () => {
    // 上传图的加载失败先落到默认涂鸦；默认图也没有才退回首字。
    if (image.dataset.fallback === 'default' || defaultUrl === null) { image.remove(); return }
    image.dataset.fallback = 'default'
    image.src = defaultUrl
  })
  if (stamp !== undefined) image.src = avatarUrl(agentId, stamp)
  else if (defaultUrl !== null) image.src = defaultUrl
  if (image.getAttribute('src') !== null) node.appendChild(image)
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
  return node
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
  const boss = make('div', 'avatar avatar--sm avatar--boss')
  boss.appendChild(doodleSvg(DOODLE_PATHS.bossFace))
  const bossImage = document.createElement('img')
  bossImage.alt = ''
  bossImage.src = defaultAvatarUrl('__boss__')
  // 加载成功就盖过简笔 SVG；失败时 SVG 留着兜底。
  bossImage.addEventListener('load', () => { boss.querySelector('svg')?.remove() })
  bossImage.addEventListener('error', () => { bossImage.remove() })
  boss.appendChild(bossImage)
  msg.appendChild(boss)
  append(msg)
  return msg
}

/**
 * 牛马大总管发言。带着 bowtie 身份，和成员区分开。
 *
 * 返回句柄：`chat_delta` 用它原地续写同一条气泡，落定的 `chat` 再用最终正文替换预览。
 */
function butlerMessage(text, time) {
  const msg = make('div', 'msg msg--butler')
  const avatar = make('div', 'avatar avatar--sm avatar--butler')
  const butlerImage = document.createElement('img')
  butlerImage.alt = ''
  butlerImage.src = defaultAvatarUrl('butler')
  // 默认涂鸦缺席时（资源没带上）退回「牛」字，不让头像位空着。
  butlerImage.addEventListener('error', () => { butlerImage.remove() })
  avatar.appendChild(butlerImage)
  avatar.appendChild(make('span', null, '牛'))
  msg.appendChild(avatar)
  const col = make('div', 'msg__col')
  const head = make('div', 'msg__head')
  const name = make('span', 'msg__name', '牛马大总管')
  name.style.color = 'var(--bt-mint)'
  head.appendChild(name)
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
    if (index > 0) el.rail.appendChild(doodleSvg(DOODLE_PATHS.railArrow, 'rail__arrow'))
    const node = make('span', 'rail__step')
    node.dataset.state = step.key === 'ask' ? 'done' : (state.rail[step.key] ?? 'idle')
    node.dataset.key = step.key
    const badge = make('span', 'rail__badge')
    badge.appendChild(doodleSvg(RAIL_ICON_PATHS[step.key] ?? ''))
    node.appendChild(badge)
    node.appendChild(make('span', 'rail__label', step.label))
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

/** 按任务结果推进链路条：实时汇总与历史回放共用一套语义，避免两种口径。 */
function applySummaryRail(taskState) {
  if (taskState === 'completed') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'done' }
  else if (taskState === 'waiting_user' || taskState === 'external_pending' || taskState === 'partial') state.rail = { parse: 'done', dispatch: 'done', work: 'active', sum: 'idle' }
  else if (taskState === 'failed' || taskState === 'cancelled') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'idle' }
  else state.rail = { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' }
  renderRail()
}

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
      state.butlerSpeech = null
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

    case 'chat_reset':
      // 模型重试开始（S08）：当前预览作废，下一段增量从新气泡起头，
      // 两次尝试的正文不拼在一起。
      state.butlerSpeech = null
      break

    case 'input': {
      // 使用者改了目标。先留一行痕迹，随后的派活与汇总照旧走原来的分支。
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
      // 计划贴纸是新的一条消息：先收掉可能还开着的大总管气泡，别把两段话并到一条里。
      // 这里不替大总管编话：拆了几份、派给谁、有没有喊到人，由下面的计划贴纸和后续
      // subtask 事件按服务端事实呈现（方案 S02）。
      state.butlerSpeech = null
      append(planNote(event))
      break
    }

    case 'subtask':
      handleSubtask(event)
      break

    case 'subtask_delta': {
      const view = state.bubbles.get(event.id)
      // 终态之后不再追加（S08）：迟到帧不把已校准的结论再改掉。
      if (view === undefined || view.terminal === true) break
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
      // 汇总是这一轮的定论：链路条按最终状态推进，已走过的步骤保持点亮。
      applySummaryRail(event.state)
      for (const view of state.bubbles.values()) view.caret.hidden = true
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
  scrollIfFollowing()
}

function handleSubtask(event) {
  const view = state.bubbles.get(event.id) ?? memberMessage(event.agentId, event.id)
  view.status.textContent = STATE_TEXT[event.state] ?? event.state
  view.status.style.color =
    event.state === 'failed' ? 'var(--bt-error)'
      : event.state === 'waiting_user' || event.state === 'external_pending' ? 'var(--bt-warn)'
        : event.state === 'succeeded' ? 'var(--bt-ok)'
          : 'var(--bt-ink-soft)'

  if (event.state === 'dispatched') {
    // 新一次尝试从头开始（S08）：同一子任务重派时清掉上次的预览与终态标记，
    // 旧尝试的迟到增量不串进新版。
    view.body = ''
    view.text.textContent = ''
    view.terminal = false
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

  if (event.state === 'external_pending') {
    // 材料交回来了，但还有事在外面办。这里**不给回复入口**：要办的事不在这一页，
    // 让用户在这里写一句话并不能把候选稿采用掉。也不显示成「搞定」。
    view.bubble.classList.add('bubble--wait')
    if (view.body === '') view.text.textContent = event.detail
    view.footer.appendChild(make('div', 'msg__meta', '待外部处理，办好之后可以新开一轮'))
    return
  }

  if (event.state === 'succeeded') {
    view.bubble.classList.add('bubble--done')
    view.terminal = true
    // 终态正文是权威结论（S09）：增量预览无论收到多少，成功那一刻按它校准，
    // 丢段或重试残留的预览不会一直留在页面上。
    view.text.textContent = event.detail ?? view.body
    view.body = view.text.textContent
    if (view.progress !== null) {
      view.progress.value = 100
      view.progress.fill.style.width = '100%'
      view.progress.label.textContent = '搞定'
    }
    view.footer.appendChild(make('div', 'msg__meta', `耗时 ${formatElapsed(view.startedAt, event.time)}`))
    return
  }

  if (event.state === 'failed' || event.state === 'cancelled') {
    view.terminal = true
    // classList.add('') 会抛 TypeError（取消态没样式类）：错误文本曾因此漏进线程。
    if (event.state === 'failed') view.bubble.classList.add('bubble--fail')
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
  const title = event.state === 'completed' ? '活干完了！'
    : event.state === 'failed' ? '这次翻车了'
      : event.state === 'cancelled' ? '已喊停'
        // 「待外部处理」不是「办完了」：材料在这，那件事还在外面等着。
        : event.state === 'external_pending' ? '材料交回了，还有事在外面等着'
          : event.state === 'partial' ? '有些活没干成，成果在这儿'
          : '还等你回话'
  card.appendChild(make('div', 'summary__title', title))
  // 正文去重后为空（总结气泡已承载）时不显示占位——那会像「没有结论」。
  if (event.text || event.error) card.appendChild(make('p', 'summary__body', event.text || event.error))
  if (event.error && event.text) card.appendChild(make('div', 'msg__meta', event.error))
  return card
}

/* ── 中栏：空状态 ─────────────────────────────────────────────────────── */

function renderWelcome() {
  clear(el.thread)
  const box = make('div', 'welcome')
  const mascot = document.createElement('img')
  mascot.className = 'welcome__mascot'
  mascot.alt = ''
  mascot.src = `${ROUTE_PREFIX}/assets/media/avatars/mascot-welcome.png`
  mascot.addEventListener('error', () => { mascot.remove() })
  box.appendChild(mascot)
  box.appendChild(make('h2', null, '今天想干点啥？'))
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
  try { localStorage.setItem(CONVERSATION_KEY, id) } catch { /* 隐私模式下忽略。 */ }
}

function recallConversation() {
  try { return localStorage.getItem(CONVERSATION_KEY) } catch { return null /* 隐私模式下当作没有。 */ }
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
  setBusy(true)
  // 只读订阅接续：reset 时按快照校准并从窗口头续订，断线有界重订（S05/S06）。
  try {
    await followUntilTerminal(conversationId, { from: 0, expectedRunId: head.runId, signal: controller.signal })
  } catch (error) {
    reportFailure(error, '接上正在跑的任务失败')
  } finally {
    finishTurn()
  }
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
  el.input.value = ''
  autosize()
  // 提交内容先就地呈现，配一行「正在发送」：受理与否是服务端事实，客户端不编（方案 S03）。
  const bubble = userMessage(trimmed, Date.now())
  const note = append(make('p', 'msg__meta', '正在发送…'))
  state.pendingUser = { text: trimmed, bubble }
  let sawTerminal = false
  try {
    for await (const event of chat({ conversationId: state.conversationId, message: trimmed, requestId, signal: state.abort.signal })) {
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
      // 重试复用同一个 requestId，不会把活再派一遍。
      state.pendingUser = null
      if (el.input.value.trim() === '') { el.input.value = trimmed; autosize() }
      retryEntry(trimmed, error instanceof Error && error.message ? error.message : '没送出去', bubble, requestId)
    } else {
      // 已受理后连接断掉：这一轮还在服务端跑，重订事件流跟到终态，不自动重发。
      reportFailure(error, '发送失败')
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
    scrollIfFollowing()
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

async function runReply(input, hooks = {}) {
  setBusy(true)
  state.abort = new AbortController()
  // 与 sendMessage 同一套回合重置：runId 不清会让新一轮回话顶着上一轮的身份。
  state.lastSeq = 0
  state.lastRunId = ''
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
    if (event.type === 'conversation') note.textContent = '正在理解目标…'
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
    scrollIfFollowing()
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
    el.thread.scrollTop = el.thread.scrollHeight
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
  const giveUp = () => { append(make('p', 'error-line', '这一轮的后续跟不上了；已收到的内容保留，终态以右栏为准。')) }
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
  el.input.focus()
}

/* ── 右栏 ─────────────────────────────────────────────────────────────── */

/** 右栏的紧凑成员行：只看是谁、在不在场；改名换脸去设置页。 */
function renderMembers() {
  clear(el.memberList)
  if (state.members.length === 0) {
    el.memberList.appendChild(make('p', 'empty', '还没有能派活的成员。'))
    return
  }
  for (const member of state.members) {
    const row = make('div', 'member member--compact')
    row.appendChild(avatarNode(member.agentId, 'sm'))
    const col = make('div', 'member__col')
    col.appendChild(make('div', 'member__name', member.displayName))
    col.appendChild(make('div', 'member__declared', member.declaredName))
    row.appendChild(col)
    row.appendChild(make('span', 'spacer'))
    row.appendChild(make('span', `dot dot--${member.online ? 'online' : 'queued'}`))
    row.title = `${member.displayName}（@${member.agentId}）`
    el.memberList.appendChild(row)
  }
}

/* ── 设置页 ───────────────────────────────────────────────────────────── */

/** 设置页里的成员卡：外号、配色、头像集中在这张卡上编辑。 */
function renderSettingsMembers() {
  clear(el.settingsMembers)
  if (state.members.length === 0) {
    el.settingsMembers.appendChild(make('p', 'empty', '还没有能派活的成员。'))
    return
  }
  for (const member of state.members) {
    const card = make('div', 'set-card')

    const head = make('div', 'set-card__head')
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
    head.appendChild(avatarWrap)

    const titles = make('div', 'set-card__titles')
    titles.appendChild(make('div', 'member__name', member.displayName))
    titles.appendChild(make('div', 'member__declared', `插件声明：${member.declaredName}`))
    head.appendChild(titles)
    card.appendChild(head)

    const nameField = make('div', 'field')
    nameField.appendChild(make('label', null, '外号'))
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.maxLength = 24
    nameInput.value = member.displayName
    nameInput.placeholder = member.declaredName
    nameField.appendChild(nameInput)
    card.appendChild(nameField)

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
    card.appendChild(colorField)

    const builtinField = make('div', 'field')
    builtinField.appendChild(make('label', null, '内置头像'))
    const strip = make('div', 'builtin-strip')
    for (const item of BUILTIN_AVATARS) {
      const pick = make('button', 'builtin-strip__item')
      pick.type = 'button'
      pick.title = item.label
      const thumb = document.createElement('img')
      thumb.alt = item.label
      thumb.loading = 'lazy'
      thumb.src = `${ROUTE_PREFIX}/assets/media/avatars/builtin/${item.file}`
      pick.appendChild(thumb)
      pick.addEventListener('click', () => { void applyBuiltinAvatar(member.agentId, item.file) })
      strip.appendChild(pick)
    }
    builtinField.appendChild(strip)
    card.appendChild(builtinField)

    const actions = make('div', 'set-card__actions')
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
    card.appendChild(actions)

    el.settingsMembers.appendChild(card)
  }
}

/** 打开/关闭设置页：关掉时右栏紧凑行要用最新数据重画。 */
function setOpenSettings(open) {
  state.settingsOpen = open
  document.body.dataset.settings = open ? 'open' : 'closed'
  el.settingsButton.setAttribute('aria-expanded', String(open))
  el.settings.hidden = !open
  if (open) {
    renderSettingsMembers()
  } else {
    renderMembers()
    el.input.focus()
  }
}

function renderCrew() {
  clear(el.crewFaces)
  for (const member of state.members) {
    const face = avatarNode(member.agentId, 'sm')
    // 在场与在忙是两件事：在场只说「登记了执行入口」，手上有没有活看 busy。
    const working = member.busy === null ? '' : ` · ${STATE_TEXT[member.busy.state] ?? '在忙'}`
    face.title = `${member.displayName}（@${member.agentId}）${working}`
    el.crewFaces.appendChild(face)
  }
  const online = state.members.filter(member => member.online).length
  const busy = state.members.filter(member => member.busy !== null).length
  const total = state.members.length
  const working = busy > 0 ? ` · ${busy} 位在忙` : ''
  el.crewLine.textContent = `${total} 个牛马 · ${online} 个能干活${working}`
  el.crewNote.textContent = `共 ${total} 位，${online} 位在场${working}`
  el.groupSub.textContent = `${total} 位成员 · ${online} 位在场${working}`
}

function renderMetrics(counts) {
  clear(el.metrics)
  const tiles = [
    { label: '在干活', value: counts.running },
    { label: '等你回话', value: counts.waitingUser },
    { label: '待外部处理', value: counts.externalPending },
    { label: '部分完成', value: counts.partial },
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
    // 有活报活的状态，没活只报在不在场。
    const stateText = member.busy === null
      ? (member.online ? '待命' : '不在场')
      : (STATE_TEXT[member.busy.state] ?? '在忙')
    const stateCell = make('span', 'status-row__state', stateText)
    const dotClass = member.busy === null
      ? (member.online ? 'online' : 'queued')
      : (member.busy.state ?? 'queued')
    stateCell.prepend(make('span', `dot dot--${dotClass}`))
    row.appendChild(stateCell)
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
    if (state.settingsOpen) renderSettingsMembers()
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
    if (state.settingsOpen) renderSettingsMembers()
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
    if (state.settingsOpen) renderSettingsMembers()
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
    // 设置页开着时不重画右栏成员卡，免得把没保存的外号冲掉。
    if (!state.settingsOpen) renderMembers()
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

/** 打开一个历史会话：把它的任务按先后重建成消息流。 */
async function openConversation(id) {
  if (state.streaming) return
  // 视图代次：先点 A 再点 B、A 响应更晚时，只显示 B，旧回包不许写入（方案 I09）。
  const token = ++state.viewToken
  state.conversationId = id
  rememberConversation(id)
  clear(el.thread)
  threadInner()
  state.bubbles.clear()
  state.asks.clear()
  resetRail()
  append(make('p', 'msg__meta', '正在读取记录…'))
  try {
    // 按会话取，不在页面上筛：会话一多，更早的那个就会落在第一页之外，
    // 打开它只会看到欢迎语 —— 记录明明在库里，只是没被取到。
    const page = await api.history({ conversationId: id })
    if (token !== state.viewToken) return
    const mine = page.items.slice().reverse()
    if (mine.length === 0) {
      renderWelcome()
      return
    }
    for (const task of mine) {
      const record = await api.task(task.id)
      if (token !== state.viewToken) return
      renderTaskRecord(record)
    }
    el.thread.scrollTop = el.thread.scrollHeight
  } catch (error) {
    if (token !== state.viewToken) return
    // 拉不到就如实说，不装成「这里没派过活」——那样看起来像记录丢了。
    append(make('p', 'error-line', error instanceof Error ? error.message : '打不开这个会话'))
  }
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
    clear(el.thread)
    threadInner()
    state.bubbles.clear()
    resetRail()
    renderTaskRecord(record)
    el.thread.scrollTop = el.thread.scrollHeight
  } catch (error) {
    if (token !== state.viewToken) return
    append(make('p', 'error-line', error instanceof Error ? error.message : '打不开这条记录'))
  }
}

/**
 * 把一条持久化的任务渲染成消息流。
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
  // 换新视图同样作废在途回包（方案 I09）。
  state.viewToken += 1
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
        scrollIfFollowing()
      })
      .catch(() => {
        el.topStatus.textContent = '停止请求失败'
        append(make('p', 'error-line', '停止请求没送到，可以再试一次；取消不能回滚已经发生的操作。'))
        scrollIfFollowing()
      })
      .finally(() => { el.stop.disabled = !state.streaming })
  })

  // 在光标处插一个 @：派活时点名成员用的，不是装饰。
  el.at?.addEventListener('click', () => {
    const start = el.input.selectionStart ?? el.input.value.length
    const end = el.input.selectionEnd ?? start
    el.input.value = el.input.value.slice(0, start) + '@' + el.input.value.slice(end)
    el.input.setSelectionRange(start + 1, start + 1)
    el.input.focus()
    autosize()
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
  // 不 await：它要跟到那一轮结束，不能把页面启动卡在这里。
  void resumeLiveTurn()
}

void main()
