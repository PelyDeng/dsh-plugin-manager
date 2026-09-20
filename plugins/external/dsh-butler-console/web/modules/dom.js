/**
 * DOM 与帧工具（拆分设计 v2 批 1a）：节点工厂、时间/人名格式化、头像、滚动跟随、
 * 视口锚定（stabilizeViewport）、rAF 合帧与流式诊断 trace。依赖 config/state/api（叶子边）。
 */

import { DEFAULT_AVATAR_FILES, PALETTE } from './config.js'
import { el, state } from './state.js'
import { ROUTE_PREFIX, api, avatarUrl } from '../api.js'
export function defaultAvatarUrl(agentId) {
  const file = DEFAULT_AVATAR_FILES.get(String(agentId))
  return file === undefined ? null : `${ROUTE_PREFIX}/assets/media/avatars/${file}`
}

/**
 * 流式诊断（方案 S01）：地址带 `?trace=stream` 打开。
 *
 * 只记录层级、事件类型、序号与本机单调时间，不记录正文、推理内容或凭据；跨机器时间
 * 不可直接相减。服务端对应观测点由 `BUTLER_STREAM_DEBUG=1` 打开，两边对同一轮 runId
 * 才能拼出「宿主帧 → 应用写出 → 客户端接收 → 绘制」四段。
 */
export const streamTraceEnabled = new URLSearchParams(location.search).get('trace') === 'stream'
export const streamTrace = []
export function traceEvent(layer, event) {
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

export function make(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

/**
 * 关键状态播报（方案 6.2）：写入专门的礼貌 live 区域，只报提交、等待、停止和收尾
 * 这类有意义的变化；正文增量绝不进这里，避免逐 token 打断屏幕阅读器。
 */
export function announce(text) {
  if (text === '') return
  el.srStatus.textContent = ''
  // 清空后下一轮任务再写，保证同名变化也能再次触发播报。
  nextFrame(() => { el.srStatus.textContent = text })
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function formatTime(value) {
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
export function formatElapsed(from, to = Date.now()) {
  // 实时流里是毫秒数，历史记录里是 ISO 字符串；直接相减会得到 NaN。
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (!from || Number.isNaN(start) || Number.isNaN(end)) return ''
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/** 按 agentId 稳定取色；配过本地配色时优先用本地配色。 */
export function accentOf(agentId) {
  const member = state.members.find(item => item.agentId === agentId)
  if (member?.accent) return member.accent
  let hash = 0
  for (const char of String(agentId)) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export function displayNameOf(agentId) {
  const member = state.members.find(item => item.agentId === agentId)
  return member?.displayName ?? agentId
}

export function declaredNameOf(agentId) {
  const member = state.members.find(item => item.agentId === agentId)
  return member?.declaredName ?? agentId
}

/** 上传头像 404 过一次的成员（本页生命周期内）：右栏轮询会反复重渲染头像，不记住的话
 *  一张 404 的图每十秒就再请求一遍（实测后台十分钟重试 174 次）。 */
export const avatarFailed = new Set()

/** 成员头像：上传过就用图片，失败或没上传时落到默认涂鸦，最后才是首字配色圆。 */
export function avatarNode(agentId, size = '') {
  const node = make('div', `avatar${size ? ` avatar--${size}` : ''}`)
  node.style.background = accentOf(agentId)
  const stamp = state.avatarStamps.get(agentId)
  const defaultUrl = defaultAvatarUrl(agentId)
  const image = document.createElement('img')
  image.alt = ''
  image.addEventListener('error', () => {
    // 上传图的加载失败先落到默认涂鸦；默认图也没有才退回首字。
    avatarFailed.add(agentId)
    if (image.dataset.fallback === 'default' || defaultUrl === null) { image.remove(); return }
    image.dataset.fallback = 'default'
    image.src = defaultUrl
  })
  // 本页已经 404 过的不再发请求：直接走默认涂鸦，直到本页刷新重置。
  const wantUpload = stamp !== undefined && !avatarFailed.has(agentId)
  if (wantUpload) image.src = avatarUrl(agentId, stamp)
  else if (defaultUrl !== null) image.src = defaultUrl
  if (image.getAttribute('src') !== null) node.appendChild(image)
  node.appendChild(make('span', null, [...displayNameOf(agentId)][0] ?? '?'))
  return node
}

export function threadInner() {
  let inner = el.thread.querySelector('.thread__inner')
  if (inner === null) {
    inner = make('div', 'thread__inner')
    el.thread.appendChild(inner)
  }
  return inner
}

export function append(node) {
  threadInner().appendChild(node)
  return node
}

/* ── 滚动跟随（I11）与绘制帧合并（I12）────────────────────────────────── */

export function distanceFromBottom() {
  return el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight
}

export function updateJumpLatest() {
  el.jumpLatest.hidden = state.following
}

/** 新视图接管时恢复跟随：从欢迎页、别的会话或快照重建切过来都贴底。 */
export function resetFollowing() {
  state.following = true
  updateJumpLatest()
}

export function scrollIfFollowing() {
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
export function nextFrame(callback) {
  if (typeof globalThis.requestAnimationFrame !== 'function') { setTimeout(callback, 0); return }
  let done = false
  const run = () => { if (done) return; done = true; clearTimeout(timer); callback() }
  const timer = setTimeout(run, 250)
  globalThis.requestAnimationFrame(run)
}

/** 自己写 scrollTop 不算用户滚动：跟随判定只认用户的手。 */
export let programmaticScroll = false
export function scrollToBottom() {
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
export const stabilizeTraceEnabled = new URLSearchParams(location.search).get('trace') === 'stabilize'
export const stabilizeTrace = []
globalThis.__butlerStabilizeTrace = stabilizeTrace
export function noteStabilize(record) {
  if (!stabilizeTraceEnabled) return
  stabilizeTrace.push({ t: Math.round(performance.now()), ...record })
  if (stabilizeTrace.length > 200) stabilizeTrace.shift()
}

export function stabilizeViewport(mutate, opts = {}) {
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

export const frameJobs = []
export let frameScheduled = false

/** 每绘制帧合并一次 DOM 写入与一次滚动测量（I12）：增量正文不再逐 token 全量重建，
 * 也不为每个事件读布局。终态落定在回调里自查 terminal，迟到帧不覆盖已校准的结论。
 */
export function scheduleFrame(job) {
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
export function scheduleFollowScroll() {
  scheduleFrame(() => {})
}
