/**
 * 成员气泡与统一渲染落点（拆分设计 v2 批 1b）：memberMessage、思考区（窄变体渲染）、材料行、
 * settleMarkdown/renderMemberContent/settleMemberBody 三件套与进度收尾。
 */

import { state } from './state.js'
import { accentOf, append, avatarNode, clear, displayNameOf, make, scheduleFrame } from './dom.js'
import { richText } from '../markdown.js'

/** 落定正文换受控 Markdown（方案 5.4）：流式期间已被 richText 升级成 .md 容器的原地终态
 * 重渲（同一容器，图片池与引用都连续、不闪一次）；老调用（纯文本 span）按原状新建替换。 */
export function settleMarkdown(plainNode, text) {
  if (plainNode.classList !== undefined && plainNode.classList.contains('md')) return richText(plainNode, text)
  const body = make('div')
  richText(body, text)
  plainNode.replaceWith(body)
  return body
}

/** 材料状态标识 → 给人看的标签。不认识的值**原样显示**：那是执行方自己的词表，不猜语义。 */
export const MATERIAL_STATE_TEXT = { published: '已发布', draft: '草稿' }

/**
 * 材料链接只认 http(s)。
 *
 * `url` 由执行方提供，但渲染是本页的责任：协议不认识（`javascript:`、`data:` 等）一律按
 * 纯文本降级，绝不渲染成可点的链接。用 `URL` 解析后再看协议，不靠字符串前缀。
 */
export function safeMaterialUrl(url) {
  if (typeof url !== 'string' || url === '') return null
  try {
    const parsed = new URL(url, location.href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/** 一份材料（`AgentArtifact`）画成一行：标题、状态标签、可点的链接、结构化字段表。 */
export function materialRow(artifact) {
  const row = make('section', 'mat')
  row.dataset.kind = artifact.kind ?? ''
  if (typeof artifact.state === 'string' && artifact.state !== '') row.dataset.state = artifact.state
  const head = make('div', 'mat__head')
  head.appendChild(make('span', 'mat__title', typeof artifact.title === 'string' && artifact.title !== '' ? artifact.title : '交回的材料'))
  if (typeof artifact.state === 'string' && artifact.state !== '') {
    head.appendChild(make('span', 'mat__state', MATERIAL_STATE_TEXT[artifact.state] ?? artifact.state))
  }
  row.appendChild(head)
  const url = safeMaterialUrl(artifact.url)
  if (url !== null) {
    const link = make('a', 'mat__link', url)
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    let external = false
    try { external = new URL(url).origin !== location.origin } catch { /* 解析失败上面已经拦掉了 */ }
    if (external) link.title = '这个链接不在本站，点开前请确认来源'
    row.appendChild(link)
  } else if (typeof artifact.url === 'string' && artifact.url !== '') {
    // 协议不认识：照给用户看（能复制），但不可点。
    row.appendChild(make('span', 'mat__link mat__link--plain', artifact.url))
  }
  if (Array.isArray(artifact.fields) && artifact.fields.length > 0) {
    // 与操作卡的 fields 同一套表格样式，不另立一种表。
    const wrap = make('div', 'table-scroll')
    wrap.setAttribute('tabindex', '0')
    wrap.setAttribute('role', 'region')
    wrap.setAttribute('aria-label', '材料详情')
    const table = make('table')
    const body = make('tbody')
    for (const field of artifact.fields) {
      const tr = make('tr')
      tr.appendChild(make('th', null, field.label ?? ''))
      tr.appendChild(make('td', null, field.value ?? ''))
      body.appendChild(tr)
    }
    table.appendChild(body)
    wrap.appendChild(table)
    row.appendChild(wrap)
  }
  if (typeof artifact.path === 'string' && artifact.path.startsWith('/')) {
    const open = make('a', 'mat__path', '在成员页面打开 ↗')
    open.href = artifact.path
    open.target = '_blank'
    open.rel = 'noopener noreferrer'
    row.appendChild(open)
  }
  return row
}

/**
 * 成员交回的材料（产出区）。
 *
 * 与待确认卡同一套挂法：host 常驻、每次**整块重画**（服务端给的是全量清单），并排在
 * 待确认卡**上方**——先看产出了什么，再看还有什么要办的。
 *
 * 空数组是权威信号（这一步没有材料），要清掉旧材料；`undefined`（老事件/老记录没这个
 * 字段）什么都不做，不倒退成"擦掉"。
 */
export function renderMemberMaterials(view, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    if (Array.isArray(artifacts) && view.materialHost !== undefined) clear(view.materialHost)
    return
  }
  if (view.materialHost === undefined || view.materialHost.parentNode === null) {
    view.materialHost = make('div', 'mat-host')
    // 已有待确认卡时插到它前面：产出在上、待办在下。
    view.footer.insertBefore(view.materialHost, view.actionHost ?? null)
  }
  clear(view.materialHost)
  for (const artifact of artifacts) view.materialHost.appendChild(materialRow(artifact))
}

/**
 * 落定一条成员发言的正文。
 *
 * ## 取值顺序：**服务端给的正文优先**（2026-09-18 生产截图改正）
 *
 * 卡片正文在流式期间是客户端一段段攒出来的（`subtask_delta`），攒的是**模型在回合里说过的话**
 * ——包括它中途的分析、自我怀疑、"我再看看"这类过程发言。而**权威结论**是服务端在终态事件里
 * 给的 `detail`（落库那一份，也是刷新后重新读到的那一份）。
 *
 * 原来这里是反的：`view.body` 优先，服务端正文只在"客户端一个字都没攒到"时才用。后果是同一张
 * 卡片**刷新前显示模型的自言自语、刷新后显示真正的结论**——用户报了两次，我上一轮只改了服务端
 * 两条路（落库与推送），把客户端这第三条路漏了。
 *
 * 现在：终态一律以服务端正文为准；它为空（例如取消、或者成员什么都没交回）时才回落到攒下来的
 * 内容，不让卡片变成空白。
 *
 * ⚠️ 判断要用"非空字符串"而不是 `??`：`''` 是合法值，`??` 不会把它当成缺失。
 */
export function settleMemberBody(view, fallback) {
  const authoritative = typeof fallback === 'string' ? fallback.trim() : ''
  const body = authoritative !== '' ? fallback : view.body
  if (body !== '') renderMemberContent(view, body)
  return body
}

/** 成员交回内容的**唯一**渲染入口。
 *
 * 成功、失败、等你回话、待外部处理——四种结论的正文都从这里过受控 Markdown：
 * 以前只有"成功"走渲染，其余走 `textContent`，于是成员交回的表格会被当成一行一竖线的
 * 纯文本显示（业务方实测就是这么看到的）。**过程行**（工具行/进度）仍保持纯文本：
 * 工具输出里的符号不该被解析成结构。
 */
export function renderMemberContent(view, text) {
  const body = typeof text === 'string' ? text : ''
  if (body !== '') view.text = settleMarkdown(view.text, body)
  else view.text.textContent = ''
  view.body = body
  return view
}

/**
 * 一位成员的一条消息块。
 *
 * 返回的句柄让流式增量、状态变化、进度都能原地更新，不需要重绘整条消息。
 */
export function memberMessage(agentId, handle) {
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
export function thinkingArea() {
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
 * 快照是**覆盖**语义：整行文本被替换，不做追加。快照高频到达且 Markdown 渲染是全量
 * 重渲——渲染并入 `scheduleFrame` 合帧（一帧最多渲一次），摘要行的提取同帧更新。
 * 默认收起，摘要行只留最新一行预览，免得长推理把气泡撑开、把正文挤下去。
 */
export function setThinking(view, thinking) {
  if (view === undefined) return
  view.think.node.hidden = false
  view.thinkLatest = thinking
  if (view.thinkPending === true) return
  view.thinkPending = true
  scheduleFrame(() => {
    view.thinkPending = false
    const snapshot = view.thinkLatest
    // thinking 变体：窄解析（4 空格缩进不是代码块）+ 无图卡——思考是半结构化密度最高的地方。
    view.think.body = richText(view.think.body, snapshot, { variant: 'thinking' })
    const lines = snapshot.split('\n').map(line => line.trim()).filter(line => line !== '')
    const latest = lines.length === 0 ? '' : lines[lines.length - 1]
    view.think.preview.textContent = latest
    view.think.preview.hidden = latest === ''
  })
}

export function ensureProgress(view) {
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
export function settleMemberDynamics(view, state) {
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
export const PROGRESS_SETTLE_TEXT = {
  waiting_user: '等你回话',
  external_pending: '待外部处理',
  failed: '失败',
  cancelled: '已停止',
  succeeded: '完成',
}

