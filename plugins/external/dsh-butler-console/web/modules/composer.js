/**
 * 输入区（拆分设计 v2 批 1d）：座右铭、自动增高、@提及选择器与开新会话。
 */

import { clearAttachments, hideAttachUrl } from './attachments.js'
import { DEFAULT_MOTTO, MOTTO_KEY } from './config.js'
import { autosize, avatarNode, clear, make, resetFollowing, threadInner } from './dom.js'
import { refreshChatList } from './panels.js'
import { resetRail } from './rail.js'
import { el, historyState, state } from './state.js'
import { renderWelcome } from './cards.js'


export function renderMotto() {
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

/* ── @ 提及选择器：输入 @ 翻出点名簿，键盘上下选 ─────────────────────── */

/** 提及会话：null=关着；否则 { start: 「@」的下标, query: @ 到光标之间的词, index: 高亮项, items: 过滤结果 }。 */
export let mention = null

/** 光标前是否有一个未闭合的 @：「@」之前须是行首、空白或非 ASCII 字符（中文书写不打空格），
 *  「@」与光标之间不许再出现空白；唯独英文/数字后不触发，免得邮箱被当点名。 */
export function detectMention() {
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
export function mentionCandidates(query) {
  const q = query.trim().toLowerCase()
  return state.members.filter(member =>
    member.displayName.toLowerCase().includes(q)
    || member.declaredName.toLowerCase().includes(q)
    || member.agentId.toLowerCase().includes(q))
}

export function openMention(hit) {
  mention = { start: hit.start, query: hit.query, index: 0, items: [] }
  renderMention()
}

export function closeMention() {
  if (mention === null) return
  mention = null
  el.mentionPop.hidden = true
  el.mentionPop.removeAttribute('aria-activedescendant')
}

export function renderMention() {
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
export function paintMentionActive() {
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
export function updateMention() {
  const hit = detectMention()
  if (hit === null) { closeMention(); return }
  if (mention === null || hit.start !== mention.start) { openMention(hit); return }
  mention.query = hit.query
  mention.index = 0
  renderMention()
}

/** 落纸用外号：服务端成员清单就是「id（外号）」的对照表，外号即点名。 */
export function acceptMention() {
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

export function bindMention() {
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

export function openNewChat() {
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
