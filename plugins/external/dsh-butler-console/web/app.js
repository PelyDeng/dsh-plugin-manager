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

import { ApiError, api, avatarUrl, chat, events, eventsHead, reply, uploadAvatar, ROUTE_PREFIX, TRANSCRIPT_PAGE_SIZE } from './api.js'
import { renderMarkdownInto } from './markdown.js'

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

const STATE_TEXT = {
  queued: '排队中',
  dispatched: '已收到',
  running: '在干活',
  waiting_user: '等你回话',
  external_pending: '待外部处理',
  partial: '部分完成',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已停止',
  summarizing: '在写总结',
  completed: '已完成',
}

/** 协同链路：页面上的每一步都能追到一次真实事件。 */
const RAIL_STEPS = [
  { key: 'ask', label: '提需求' },
  { key: 'parse', label: '听懂' },
  { key: 'dispatch', label: '分派' },
  { key: 'work', label: '执行' },
  { key: 'sum', label: '汇总' },
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

/** 开场示例话题：只写群里真有人能接的活，免得用户照着问了却没人接。 */
const SUGGESTIONS = [
  '整理一篇园区封闭化管理介绍，再给点博客发布建议',
  '帮我查一下园区最近的通行情况，顺便说说异常',
]

const MOTTO_KEY = 'butler.motto'
const DEFAULT_MOTTO = '你负责说清楚，牛马负责干明白'
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
  failureList: document.getElementById('failure-list'),
  motto: document.getElementById('motto'),
  identity: document.getElementById('identity'),
  topStatus: document.getElementById('top-status'),
  newChat: document.getElementById('new-chat'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  drawerToggle: document.getElementById('drawer-toggle'),
  backdrop: document.getElementById('drawer-backdrop'),
  jumpLatest: document.getElementById('jump-latest'),
  srStatus: document.getElementById('sr-status'),
  leftPanel: document.getElementById('left-panel'),
  rightPanel: document.getElementById('drawer'),
  settingsTitle: document.getElementById('settings-title'),
  settingsLive: document.getElementById('settings-live-note'),
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
  /**
   * 大总管这一轮的思考快照（覆盖语义）。
   *
   * 思考通常先于正文到达，所以它先存在这里；等气泡真的出现（第一段增量或落定正文）再挂上去，
   * 换尝试（`chat_reset`）或开新一轮时清空。
   */
  butlerThinking: '',
  /**
   * 本次「已调度成员」面板：成员的真实在查什么、交回了什么，都收在这里。
   *
   * `null` 表示这一轮没分派（大总管自己答的）。新一轮开始时整体重建，见 `mountDispatch`。
   */
  dispatch: null,
  /** 子任务 id → 等待中的提问卡，收到回复后移除。 */
  asks: new Map(),
  taskId: null,
  /** 当前任务的链路状态。 */
  rail: { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' },
  settingsOpen: false,
  /** 滚动跟随（I11）：用户上滚或选字时暂停，「回到最新」恢复；跟随判断在 DOM 增长前做。 */
  following: true,
  selecting: false,
}

/**
 * 历史阅读的翻页状态（I10）：会话 id + 两个游标（对话正文 seq、任务 offset）。
 * 「加载更早记录」时核对会话与视图代次，旧回包不写进新会话（I09）。
 */
const historyState = {
  conversationId: null,
  transcriptBefore: null,
  taskOffset: null,
  loading: false,
  /** 已加载的历史条目（全局时间序，带节点引用）：翻页去重与定位插入的依据（复核 1）。 */
  entries: [],
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

/**
 * 关键状态播报（方案 6.2）：写入专门的礼貌 live 区域，只报提交、等待、停止和收尾
 * 这类有意义的变化；正文增量绝不进这里，避免逐 token 打断屏幕阅读器。
 */
function announce(text) {
  if (text === '') return
  el.srStatus.textContent = ''
  // 清空后下一轮任务再写，保证同名变化也能再次触发播报。
  nextFrame(() => { el.srStatus.textContent = text })
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

/* ── 滚动跟随（I11）与绘制帧合并（I12）────────────────────────────────── */

function distanceFromBottom() {
  return el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight
}

function updateJumpLatest() {
  el.jumpLatest.hidden = state.following
}

/** 新视图接管时恢复跟随：从欢迎页、别的会话或快照重建切过来都贴底。 */
function resetFollowing() {
  state.following = true
  updateJumpLatest()
}

function scrollIfFollowing() {
  if (state.following && !state.selecting) {
    // 同样要挂程序化标记：滚动事件是异步投递的，事件晚到时正文可能已经又长了，
    // 不标记会把我们自己的贴底误判成用户上滚（浏览器实测发现的竞态）。
    programmaticScroll = true
    el.thread.scrollTop = el.thread.scrollHeight
    noteStabilize({ branch: 'follow-write', top: Math.round(el.thread.scrollTop) })
    nextFrame(() => { programmaticScroll = false })
  }
}

/**
 * 下一绘制帧。页面不可见时 rAF 会停摆（浏览器实测：后台窗格里永不回调），
 * 用 250ms 计时器兜底——帧合并在可见时照常走 rAF，不可见时退化为有界定时写入，
 * 程序化滚动标记也不会因停摆而滞留、误吞用户回前台后的第一次滚动。
 */
function nextFrame(callback) {
  if (typeof globalThis.requestAnimationFrame !== 'function') { setTimeout(callback, 0); return }
  let done = false
  const run = () => { if (done) return; done = true; clearTimeout(timer); callback() }
  const timer = setTimeout(run, 250)
  globalThis.requestAnimationFrame(run)
}

/** 自己写 scrollTop 不算用户滚动：跟随判定只认用户的手。 */
let programmaticScroll = false
function scrollToBottom() {
  programmaticScroll = true
  el.thread.scrollTop = el.thread.scrollHeight
  nextFrame(() => { programmaticScroll = false })
}

/**
 * 改动可能移动内容的 DOM 时钉住视口（I11）：Markdown 落定、大表格出现、旧页插入之后，
 * 用户正在看的内容停在原地。跟随中（新内容追加在底部）则直接贴底。
 *
 * 锚点是**用户正在看的内容**（视口上沿起第一个还露着的节点），不是被改的节点：
 * 上方节点向下增高时它自己的 top 不变，锚在被改节点上会整屏漂移（复核 2 的几何替身：
 * 上方消息增高 400px 未补偿）。锚定可见内容后按锚点位移补偿滚动。
 * `forceAnchor` 用于前插旧内容：加载旧页永远保持阅读位置（I10），不因跟随状态跳回底部。
 *
 * `?trace=stabilize` 打开时把每次调用（分支、锚点位移、补偿量）记到
 * `globalThis.__butlerStabilizeTrace`，供浏览器验证对账；不记录正文。
 */
const stabilizeTraceEnabled = new URLSearchParams(location.search).get('trace') === 'stabilize'
const stabilizeTrace = []
globalThis.__butlerStabilizeTrace = stabilizeTrace
function noteStabilize(record) {
  if (!stabilizeTraceEnabled) return
  stabilizeTrace.push({ t: Math.round(performance.now()), ...record })
  if (stabilizeTrace.length > 200) stabilizeTrace.shift()
}

function stabilizeViewport(mutate, opts = {}) {
  const thread = el.thread
  if (!opts.forceAnchor && state.following && !state.selecting) {
    noteStabilize({ branch: 'following' })
    mutate()
    scrollToBottom()
    return
  }
  const base = thread.getBoundingClientRect()
  const topOf = node => node.getBoundingClientRect().top - base.top + thread.scrollTop
  let anchor = null
  for (const child of threadInner().children) {
    if (child.classList?.contains('history-head')) continue
    // 底边超过视口上沿的第一个节点：在视口内或延伸进视口，就是用户看的内容。
    if (topOf(child) + child.getBoundingClientRect().height > thread.scrollTop) { anchor = child; break }
  }
  const before = anchor === null ? thread.scrollTop : topOf(anchor)
  mutate()
  if (anchor === null) {
    noteStabilize({ branch: 'anchor', anchor: null })
    return
  }
  const after = topOf(anchor)
  if (after !== before) {
    programmaticScroll = true
    thread.scrollTop += after - before
    nextFrame(() => { programmaticScroll = false })
  }
  noteStabilize({ branch: 'anchor', shift: Math.round(after - before), top: Math.round(thread.scrollTop), following: state.following })
}

const frameJobs = []
let frameScheduled = false

/** 每绘制帧合并一次 DOM 写入与一次滚动测量（I12）：增量正文不再逐 token 全量重建，
 * 也不为每个事件读布局。终态落定在回调里自查 terminal，迟到帧不覆盖已校准的结论。
 */
function scheduleFrame(job) {
  frameJobs.push(job)
  if (frameScheduled) return
  frameScheduled = true
  nextFrame(() => {
    frameScheduled = false
    for (const run of frameJobs.splice(0, frameJobs.length)) run()
    scrollIfFollowing()
  })
}

/** 追加内容后安排一次跟随滚动：与同帧的增量写在一起，只测一次布局。 */
function scheduleFollowScroll() {
  scheduleFrame(() => {})
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
    state.butlerSpeech = { ...view, text: '', rendered: '' }
  }
  return state.butlerSpeech
}

/**
 * 流式增量写正文：只追加新后缀，不整体替换 textContent。
 *
 * 整体替换会销毁文本节点——用户正在选的字、正要复制的那段会随着下一帧消失
 * （浏览器实测发现）。只有追加不了（重置、前缀变了）才整体重建。
 */
function appendPreviewText(node, book, text) {
  if (book.rendered !== undefined && text.startsWith(book.rendered) && node.firstChild !== null) {
    if (text.length > book.rendered.length) node.appendChild(document.createTextNode(text.slice(book.rendered.length)))
  } else {
    node.textContent = text
  }
  book.rendered = text
}

function butlerDelta(text) {
  const speech = butlerSpeech()
  // 气泡真的出现了，才把这一轮的思考挂上去（思考通常先于正文到达）。
  attachButlerThinking(speech)
  speech.text += text
  // 按帧合并（I12）：正文累积在内存里，一帧只写一次 DOM；气泡已被落定收走就不再写。
  if (speech.framePending === true) return
  speech.framePending = true
  scheduleFrame(() => {
    speech.framePending = false
    if (state.butlerSpeech !== speech) return
    appendPreviewText(speech.body, speech, speech.text)
  })
}

/** 落定正文换受控 Markdown（方案 5.4）：预览是纯文本，终态统一排版。 */
function settleMarkdown(plainNode, text) {
  const body = make('div', 'md')
  renderMarkdownInto(body, text)
  plainNode.replaceWith(body)
  return body
}

/**
 * 落定的发言。
 *
 * 有正在流的那条就替换它的正文并收起光标 —— 重试过的那一版不会留在页面上；
 * 没有（例如直接回答、历史恢复）就照旧新起一条。落定走受控 Markdown（C 批），
 * 布局变化不抢阅读位置（I11）。
 */
function butlerSettle(text, time) {
  const speech = state.butlerSpeech
  state.butlerSpeech = null
  if (speech === null) {
    const view = butlerMessage('', time)
    // 只有落定正文、没有流式增量时（例如直接回答、历史恢复）思考也挂在这条上。
    attachButlerThinking(view)
    stabilizeViewport(() => { settleMarkdown(view.body, text) })
    return
  }
  stabilizeViewport(() => { settleMarkdown(speech.body, text) })
  speech.caret.hidden = true
}

/**
 * 调度卡的偏好（折叠状态 + 「只看结论」）。
 *
 * 跟着任务走并落在本机：刷新重建卡片时先读它再渲染，用户收起过的卡不会自己弹开。
 * 与座右铭、会话 id 同一套写法（隐私模式下读写都会抛，忽略即可）。
 */
const CARD_PREF_PREFIX = 'butler.card.'

/** 卡片元素 id 的自增序号：tab 与它控制的结果格要成对，id 必须唯一。 */
let cardSeq = 0

function cardPrefs(taskId) {
  if (typeof taskId !== 'string' || taskId === '') return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(CARD_PREF_PREFIX + taskId) ?? 'null')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch { return {} }
}

function saveCardPref(taskId, patch) {
  if (typeof taskId !== 'string' || taskId === '') return
  try { localStorage.setItem(CARD_PREF_PREFIX + taskId, JSON.stringify({ ...cardPrefs(taskId), ...patch })) } catch { /* 忽略。 */ }
}

/**
 * 成员状态 → 卡片上的短状态词。
 *
 * 比 `STATE_TEXT` 更短：格子里一行放得下，且与"在干活/已完成"这两个计数词能对上。
 */
const CARD_STATE_TEXT = {
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

function cardStateText(value) {
  return CARD_STATE_TEXT[value] ?? STATE_TEXT[value] ?? String(value ?? '')
}

/** 有定论的状态：到了这些状态，秒数不再往上走。
 *
 * ⚠️ `waiting_user` 必须算在内：等你回话可能挂几个小时，秒数一直往上加是在骗人
 * （它已经不是"正在算"了）。`partial` 是任务级的收尾态，子任务层到不了，一并收进来无妨。
 */
function cardSettled(value) {
  return ['succeeded', 'completed', 'failed', 'cancelled', 'external_pending', 'waiting_user', 'partial'].includes(value ?? '')
}

/**
 * 结果区里还没有内容时的说明。
 *
 * 不留空白框：排队/进行中都是有意义的状态，直接写清楚；成员的第一段输出到达后由
 * ttachToDispatch 撤掉这句话。
 */
function emptySlotHint(value) {
  if (value === 'queued' || value === undefined) return '还没开始，等前一步交回材料。'
  if (value === 'waiting_user') return '在等你回话。'
  if (value === 'external_pending') return '材料交回来了，还有事在别处办。'
  return '正在做，还没有可看的内容。'
}

/** 结果区标题：跟着选中成员的状态变，用户不用猜自己在看什么。 */
const CARD_RESULT_TITLE = {
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
function cardElapsedText(since, until) {
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
let cardTicker = null

function syncCardTicker() {
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
const DISPATCH_TONE = {
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
 * 避免"没有选中"这种半吊子态）、左右方向键换人、Esc 收起、格子整块可点且 ≥44px。
 * 折叠状态与「只看结论」按 `taskId` 存本机，刷新重建时先读偏好再渲染。
 */
function mountDispatch(subtasks, options = {}) {
  const taskId = typeof options.taskId === 'string' && options.taskId !== '' ? options.taskId : (state.taskId ?? '')
  const prefs = cardPrefs(taskId)
  const open = typeof prefs.open === 'boolean' ? prefs.open : options.defaultOpen !== false
  const panelId = `c${++cardSeq}`
  const details = make('details', 'dcard')
  details.open = open
  if (taskId !== '') details.dataset.taskId = taskId
  const bar = make('summary', 'dcard__bar')
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
    const avatar = avatarNode(subtask.agentId, 'sm')
    cell.appendChild(avatar)
    const col = make('span', 'dcard__col')
    const head = make('span', 'dcard__head')
    head.appendChild(make('span', 'dcard__name', displayNameOf(subtask.agentId)))
    head.appendChild(make('span', 'dcard__handle', `@${subtask.agentId}`))
    col.appendChild(head)
    col.appendChild(make('span', 'dcard__goal', subtask.goal ?? ''))
    const status = make('span', 'dcard__status')
    const dot = make('span', `dot dot--${DISPATCH_TONE[subtask.state] ?? 'queued'}`)
    status.appendChild(dot)
    status.appendChild(make('span', 'dcard__statetext', cardStateText(subtask.state)))
    const elapsed = make('span', 'dcard__elapsed')
    elapsed.hidden = true
    status.appendChild(elapsed)
    col.appendChild(status)
    cell.appendChild(col)
    cell.title = `${subtask.goal ?? ''} @${subtask.agentId}`.trim()
    cell.addEventListener('click', () => { select(subtask.id) })
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

  bar.appendChild(title)
  bar.appendChild(fresh)
  bar.appendChild(tools)
  details.appendChild(bar)
  details.appendChild(grid)
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
function updateCardCell(panel, id) {
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
function toggleDispatchResultOnly(panel, on) {
  panel.resultOnly = on === true
  panel.body.classList.toggle('dcard__slots--result-only', panel.resultOnly)
  panel.resultOnlyButton.classList.toggle('dcard__tool--on', panel.resultOnly)
  panel.resultOnlyButton.textContent = panel.resultOnly ? '看完整过程' : '只看结论'
}

/** 复制当前成员交回的正文；剪贴板不可用（非安全上下文等）时如实报失败，不假装成功。 */
async function copyDispatchText(panel, button) {
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
function renderDispatchHeader(panel) {
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
  panel.title.textContent = parts.join(' · ')
}

/**
 * 切到某位成员：只显示它的那一格，其余隐藏。
 *
 * 再点已经选中的那一格**不取消选中**：要收起整卡用卡片自己的折叠，一条动作一个语义；
 * 否则会多出一个"没有选中"的空态，刷新后也不知道该恢复成什么。
 */
function selectDispatch(panel, id) {
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
function attachToDispatch(view, event, panel = state.dispatch) {
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
function settleCardForSummary(state_, at) {
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

/**
 * 成员交回内容的**唯一**渲染入口。
 *
 * 成功、失败、等你回话、待外部处理——四种结论的正文都从这里过受控 Markdown：
 * 以前只有"成功"走渲染，其余走 `textContent`，于是成员交回的表格会被当成一行一竖线的
 * 纯文本显示（业务方实测就是这么看到的）。**过程行**（工具行/进度）仍保持纯文本：
 * 工具输出里的符号不该被解析成结构。
 */
function renderMemberContent(view, text) {
  const body = typeof text === 'string' ? text : ''
  if (body !== '') view.text = settleMarkdown(view.text, body)
  else view.text.textContent = ''
  view.body = body
  return view
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

/** 状态刚变化的那一格做一次描边脉冲：看得见变化，但不打断阅读（不动滚动、不抢焦点）。 */
function pulseCardCell(cell) {
  cell.classList.remove('dcard__cell--pulse')
  // 读一次布局属性，保证连续两次变化都能重新触发动画（否则类名重加不会重放）。
  void cell.offsetWidth
  cell.classList.add('dcard__cell--pulse')
  setTimeout(() => { cell.classList.remove('dcard__cell--pulse') }, 600)
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
  const status = make('span', 'msg__tag', '已收到')
  head.appendChild(status)
  col.appendChild(head)

  const bubble = make('div', 'bubble')
  // 思考行：默认收起，只有执行方真的上报了快照才出现；正文照旧在它下面。
  const think = thinkingArea()
  bubble.appendChild(think.node)
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
    /** 流式已写进 DOM 的前缀长度基准：与 `body` 同步重置（S08 重派）。 */
    rendered: '',
    framePending: false,
    /** 是否还在执行态：等待/终态置 false，在途增量帧回调据此放弃写入。 */
    live: true,
    progress: null,
    think: { node: think.node, preview: think.preview, body: think.body },
  }
  state.bubbles.set(handle, view)
  return view
}

/**
 * 思考行：默认收起，只有真的上报了快照才出现。
 *
 * 成员与大总管共用同一份结构（`.think`），两者的差别只在内容来源：成员是执行方上报的
 * 脱敏投影，大总管是它自己这一轮的推理。
 */
function thinkingArea() {
  const node = make('details', 'think')
  node.hidden = true
  const summary = make('summary', 'think__summary')
  summary.appendChild(make('span', 'think__title', '思考'))
  const preview = make('span', 'think__preview')
  summary.appendChild(preview)
  const body = make('div', 'think__body')
  node.appendChild(summary)
  node.appendChild(body)
  return { node, preview, body }
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

/**
 * 大总管这一轮的思考。
 *
 * 思考常常**早于第一段正文**到达（模型先推理、后说话）。这里就把它显示出来：只把快照存进
 * `state.butlerThinking`、等正文到了再挂，页面上就是"卡着一动不动、结果突然出现"——用户看不到
 * 任何在想的迹象（这正是改造前的问题）。所以第一条快照就开一条气泡，把思考行挂上去。
 *
 * 代价是"只推理、还没吐字的尝试"会在页面上留下一条气泡，而这一版可能是会被重试掉的：所以
 * 这种**只有思考、还没有正文**的气泡记成 `thinkingOnly`，在 `chat_reset`（模型重试）与新一轮
 * 开始时把它撤掉，不留一条空消息。
 */
function butlerThinking(thinking) {
  state.butlerThinking = thinking
  if (thinking === '' || thinking === undefined) return
  const speech = state.butlerSpeech ?? butlerSpeech()
  speech.thinkingOnly = speech.text === ''
  speech.caret.hidden = false
  attachButlerThinking(speech)
}

/** 撤掉"只有思考、还没有正文"的那条气泡（换尝试、开新一轮、出错时用）。 */
function dropThinkingOnlySpeech() {
  const speech = state.butlerSpeech
  state.butlerSpeech = null
  if (speech === null || speech.thinkingOnly !== true || speech.text !== '') return
  speech.msg.remove()
}

/**
 * 把当前思考快照挂到一条已存在的大总管气泡上。
 *
 * 思考行按需创建、位置在正文之前；`state.butlerThinking` 为空（这一轮没有思考、或已换尝试）
 * 时什么都不做。
 */
function attachButlerThinking(speech) {
  const thinking = state.butlerThinking
  if (speech === null || speech === undefined || thinking === '' || thinking === undefined) return
  if (speech.think === undefined) {
    speech.think = thinkingArea()
    speech.bubble.insertBefore(speech.think.node, speech.body)
  }
  setThinking(speech, thinking)
}

function ensureProgress(view) {
  if (view.progress !== null) return view.progress
  const wrap = make('div', 'progress')
  const track = make('div', 'progress__track')
  const fill = make('div', 'progress__fill progress__fill--indeterminate')
  track.appendChild(fill)
  const label = make('span', 'progress__label', '')
  wrap.appendChild(track)
  wrap.appendChild(label)
  view.footer.appendChild(wrap)
  view.progress = { wrap, fill, label }
  return view.progress
}

/**
 * 成员离开执行态时收掉动态痕迹（方案 I06）：工具行改过去式、进度条停住并给出
 * 该状态的说法。等待与终态都不再呈现「还在算」的样子。
 */
function settleMemberDynamics(view, state) {
  // 离开执行态：在途的增量帧回调到此为止（等待中光标复亮的根因）。
  view.live = false
  const line = view.bubble.querySelector('.tool-line')
  if (line !== null && line.classList.contains('tool-line--past') === false) {
    const name = line.querySelector('.tool-line__name')?.textContent ?? ''
    clear(line)
    line.classList.add('tool-line--past')
    line.appendChild(make('span', null, '翻过资料：'))
    line.appendChild(make('span', 'tool-line__name', name))
  }
  if (view.progress === null) return
  view.progress.fill.classList.remove('progress__fill--indeterminate')
  const label = PROGRESS_SETTLE_TEXT[state]
  if (label !== undefined) view.progress.label.textContent = label
  if (state === 'waiting_user' || state === 'external_pending') view.progress.fill.style.width = '100%'
  // 失败/取消不再展示「进行中」的填充条：收掉宽度，只留状态文字。
  if (state === 'failed' || state === 'cancelled') view.progress.fill.style.width = '0%'
}

/** 离开执行态后进度条与工具行的静态说法；undefined 表示保持现状。 */
const PROGRESS_SETTLE_TEXT = {
  waiting_user: '等你回话',
  external_pending: '待外部处理',
  failed: '失败',
  cancelled: '已停止',
  succeeded: '完成',
}

/* ── 中栏：链路条 ─────────────────────────────────────────────────────── */

/**
 * 链路条结构只建一次，状态变化只改 `data-state`（方案 6.1）。
 *
 * 整体重建会让未变化的 active 徽章重新起播动画——「进行中」的转动被打断重来的观感
 * 就是这么来的。节点按 key 缓存，更新走 `applyRailStates` 一条路。
 */
const railNodes = new Map()

function renderRail() {
  if (el.rail.childElementCount === 0) {
    RAIL_STEPS.forEach((step, index) => {
      if (index > 0) el.rail.appendChild(doodleSvg(DOODLE_PATHS.railArrow, 'rail__arrow'))
      const node = make('span', 'rail__step')
      node.dataset.key = step.key
      const badge = make('span', 'rail__badge')
      badge.appendChild(doodleSvg(RAIL_ICON_PATHS[step.key] ?? ''))
      node.appendChild(badge)
      node.appendChild(make('span', 'rail__label', step.label))
      el.rail.appendChild(node)
      railNodes.set(step.key, node)
    })
  }
  applyRailStates()
}

/** 只更新各步状态：`ask` 恒为 done，其余跟 state.rail。 */
function applyRailStates() {
  for (const [key, node] of railNodes) node.dataset.state = key === 'ask' ? 'done' : (state.rail[key] ?? 'idle')
}

function setRail(key, value) {
  if (key === 'ask') return
  if (state.rail[key] === value) return
  state.rail[key] = value
  applyRailStates()
}

function resetRail() {
  state.rail = { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' }
  applyRailStates()
}

/**
 * 按任务结果推进链路条：实时汇总与历史回放共用一套语义，避免两种口径。
 *
 * 等待不是执行（方案 6.1「等待仍旋转」的纠正）：waiting_user/external_pending 用静态的
 * `waiting` 态（琥珀、不转），partial 收在 `partial` 态；转动只留给真正执行中的 active。
 */
function applySummaryRail(taskState) {
  if (taskState === 'completed') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'done' }
  else if (taskState === 'waiting_user' || taskState === 'external_pending') state.rail = { parse: 'done', dispatch: 'done', work: 'waiting', sum: 'idle' }
  else if (taskState === 'partial') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'partial' }
  else if (taskState === 'failed' || taskState === 'cancelled') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'idle' }
  else state.rail = { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' }
  applyRailStates()
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
        appendPreviewText(view.text, view, view.body)
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
  // 成员的真实输出收进分派面板；群里这行只剩状态与入口。
  attachToDispatch(view, event)
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
    view.rendered = ''
    view.text.textContent = ''
    view.terminal = false
    view.live = true
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
    if (view.body === '') renderMemberContent(view, event.question ?? event.detail)
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
    if (view.body === '') renderMemberContent(view, event.detail)
    view.footer.appendChild(make('div', 'msg__meta', '待外部处理，办好之后可以新开一轮'))
    announce(`${displayNameOf(event.agentId)} 交回材料，还有事待外部处理`)
    return
  }

  if (event.state === 'succeeded') {
    view.bubble.classList.add('bubble--done')
    view.terminal = true
    // 终态正文是权威结论（S09）：成功那一刻按它校准并落成受控 Markdown（C 批）——
    // 丢段或重试残留的预览不会留在页面上；落定前后的布局变化不抢阅读位置（I11）。
    const finalText = event.detail ?? view.body
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
    // 已经有正文时，失败原因另起一行。这一行带 `msg__meta--keep`：**「只看结论」不能把它藏掉**
    // ——那正是用户最需要看到的一句话（同一失败在"还没吐字"时走正文，本来就不会被藏）。
    if (view.body === '') renderMemberContent(view, event.detail)
    else view.bubble.appendChild(make('div', 'msg__meta msg__meta--keep', event.detail))
    announce(event.state === 'failed' ? `${displayNameOf(event.agentId)} 失败：${event.detail ?? '原因不明'}` : `${displayNameOf(event.agentId)} 的活已取消`)
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
    renderMarkdownInto(body, event.text || event.error)
    card.appendChild(body)
  }
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
  box.appendChild(make('h2', null, '说说你要做什么'))
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
  el.stop.hidden = !on
  el.topStatus.textContent = on ? '正在处理' : '已上线'
  // 只锁发送不锁输入（I02/C 批预编辑）：执行中可以写下一句，输入法组合不受影响；
  // 这句草稿也不会被异步完成、恢复或视图切换清掉——清空只发生在真正送出的那次提交。
  el.hint.textContent = on ? '正在处理；下一句可以先写好，这轮完事再发' : '牛马大总管先听明白，再替你把人喊来'
  // 执行中进设置页的提示随状态同步（方案 I18）。
  el.settingsLive.hidden = !(state.settingsOpen && on)
  el.settingsLive.textContent = state.settingsOpen && on ? '有任务正在执行：回群聊可查看进度或喊停' : ''
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
  const inConversationArea = active === null || active === document.body
    || el.composer.contains(active) || el.thread.contains(active) || el.rail.contains(active)
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
    const face = avatarNode(member.agentId, 'sm')
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
    const card = renderTaskCard(record, { live: false, liveResume: false, defaultOpen: cardPrefs(task.id).open === true })
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
    { taskId: record.id, live: opts.live !== false, defaultOpen: opts.defaultOpen !== false },
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
  el.composer.addEventListener('submit', event => {
    event.preventDefault()
    void sendMessage(el.input.value)
  })

  el.input.addEventListener('input', autosize)
  el.input.addEventListener('keydown', event => {
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

  // 在光标处插一个 @：分派时点名成员用的，不是装饰。
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
