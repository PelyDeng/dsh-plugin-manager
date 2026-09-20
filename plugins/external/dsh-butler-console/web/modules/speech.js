/**
 * 大总管气泡（拆分设计 v2 批 1b）：用户消息、流式增量（richText 每帧重渲）、落定与思考挂载。
 * settleMarkdown/renderMemberContent 在 member 域（页面渲染的统一落点）。
 */

import { DOODLE_PATHS, STREAM_RICH_LIMIT } from './config.js'
import { state } from './state.js'
import { append, defaultAvatarUrl, formatTime, make, scheduleFrame, stabilizeViewport } from './dom.js'
import { chat } from '../api.js'
import { richText } from '../markdown.js'
import { doodleSvg } from './rail.js'
import { setThinking, settleMarkdown, thinkingArea } from './member.js'

/* ── 中栏：消息 ───────────────────────────────────────────────────────── */

export function userMessage(text, time) {
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
export function butlerMessage(text, time) {
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
  name.style.color = 'var(--bt-ink)'
  head.appendChild(name)
  head.appendChild(make('span', 'msg__tag', '负责听懂你的意图'))
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
export function butlerSpeech() {
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
export function appendPreviewText(node, book, text) {
  if (book.rendered !== undefined && text.startsWith(book.rendered) && node.firstChild !== null) {
    if (text.length > book.rendered.length) node.appendChild(document.createTextNode(text.slice(book.rendered.length)))
  } else {
    node.textContent = text
  }
  book.rendered = text
}

export function butlerDelta(text) {
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
    // 流式与终态同一格式（richText 每帧全量重渲）；超长正文降级纯文本追加（STREAM_RICH_LIMIT）。
    // richText 可能首帧把 span 升级成 div——用返回值更新引用，光标是 body 的兄弟不受影响。
    if (speech.text.length > STREAM_RICH_LIMIT) appendPreviewText(speech.body, speech, speech.text)
    else speech.body = richText(speech.body, speech.text, { streaming: true })
  })
}

/**
 * 落定的发言。
 *
 * 有正在流的那条就替换它的正文并收起光标 —— 重试过的那一版不会留在页面上；
 * 没有（例如直接回答、历史恢复）就照旧新起一条。落定走受控 Markdown（C 批），
 * 布局变化不抢阅读位置（I11）。
 */
export function butlerSettle(text, time) {
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
export function butlerThinking(thinking) {
  state.butlerThinking = thinking
  if (thinking === '' || thinking === undefined) return
  const speech = state.butlerSpeech ?? butlerSpeech()
  speech.thinkingOnly = speech.text === ''
  speech.caret.hidden = false
  attachButlerThinking(speech)
}

/** 撤掉"只有思考、还没有正文"的那条气泡（换尝试、开新一轮、出错时用）。 */
export function dropThinkingOnlySpeech() {
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
export function attachButlerThinking(speech) {
  const thinking = state.butlerThinking
  if (speech === null || speech === undefined || thinking === '' || thinking === undefined) return
  if (speech.think === undefined) {
    speech.think = thinkingArea()
    speech.bubble.insertBefore(speech.think.node, speech.body)
  }
  setThinking(speech, thinking)
}
