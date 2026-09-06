import { readEvents } from './stream.js'

const $ = id => document.getElementById(id)
const base = document.body.dataset.base
const narrow = matchMedia('(max-width: 650px)')
const historyPanel = document.querySelector('.history-panel')
historyPanel.open = !narrow.matches
narrow.addEventListener('change', event => { historyPanel.open = !event.matches })
let conversationId
let controller
let resetAfterStop = false
let historyOffset = 0
let loadingHistory = false
const setStatus = text => { $('status').textContent = text }
const notice = text => { $('notice').textContent = text; $('notice').hidden = !text }
function busy(value) {
  $('send').hidden = value
  $('stop').hidden = !value
  $('prompt').disabled = value
  $('more-history').disabled = value
  for (const button of document.querySelectorAll('.history-item')) button.disabled = value
  for (const button of document.querySelectorAll('[data-question]')) button.disabled = value
}
function scroll() {
  const area = $('scroll-area')
  if (area.scrollHeight - area.scrollTop - area.clientHeight < 180) area.scrollTop = area.scrollHeight
}
function message(role, text, reasoning = '') {
  const article = document.createElement('article')
  article.className = `message ${role}`
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = role === 'user' ? '你' : '✳ 拾问'
  const content = document.createElement('div')
  content.className = 'text'
  content.textContent = text
  article.append(label)
  const thinking = document.createElement('details')
  thinking.className = 'thinking'; thinking.hidden = !reasoning
  const summary = document.createElement('summary')
  summary.textContent = '思考过程'
  const reasoningText = document.createElement('div')
  reasoningText.className = 'reasoning-text'; reasoningText.textContent = reasoning
  thinking.append(summary, reasoningText)
  if (role === 'assistant') article.append(thinking)
  article.append(content)
  if (role === 'assistant') {
    const copy = document.createElement('button')
    copy.type = 'button'; copy.className = 'copy'; copy.textContent = '复制回答'
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(content.textContent); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制回答' }, 1500) }
      catch { notice('无法访问剪贴板，请选中回答手动复制。') }
    }
    article.append(copy)
  }
  $('messages').append(article)
  return { article, content, thinking, summary, reasoningText }
}
async function send(text) {
  if (controller || !text.trim()) return
  notice('')
  $('welcome').hidden = true
  message('user', text)
  const answer = message('assistant', '')
  answer.article.classList.add('busy')
  answer.thinking.open = true
  $('prompt').value = ''
  const current = new AbortController()
  controller = current
  busy(true); setStatus('正在连接模型…')
  $('scroll-area').scrollTop = $('scroll-area').scrollHeight
  let failed = false
  try {
    const response = await fetch(base + '/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: current.signal,
      body: JSON.stringify({ message: text, ...(conversationId ? { conversationId } : {}) }),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error ?? `请求失败（${response.status}）`)
    }
    await readEvents(response, event => {
      if (event.type === 'session') conversationId = event.conversationId
      if (event.type === 'reasoning' && event.text) {
        answer.thinking.hidden = false; answer.reasoningText.textContent += event.text
        answer.summary.textContent = '正在思考…'; setStatus('正在思考…'); scroll()
      }
      if (event.type === 'delta') {
        answer.content.textContent += event.text; answer.summary.textContent = '思考过程'
        setStatus('正在回答…'); scroll()
      }
      if (event.type === 'answer') {
        answer.content.textContent = event.text
        if (event.reasoning) { answer.reasoningText.textContent = event.reasoning; answer.thinking.hidden = false }
        answer.summary.textContent = '思考过程'; scroll()
      }
      if (event.type === 'error') { failed = true; notice(event.message) }
      if (event.type === 'done') {
        failed ||= event.reason !== 'completed'
        setStatus(failed ? '回答未完成' : '回答完成 · 可以继续追问')
      }
    })
  } catch (error) {
    if (error.name === 'AbortError') setStatus('已停止 · 已保存的历史仍可继续')
    else { notice(error.message); setStatus('回答未完成'); $('prompt').value = text }
  } finally {
    answer.article.classList.remove('busy')
    answer.summary.textContent = '思考过程'
    controller = undefined
    busy(false)
    if (resetAfterStop) { resetAfterStop = false; reset() }
    await loadHistory()
    $('prompt').focus()
  }
}
$('chat-form').addEventListener('submit', event => { event.preventDefault(); void send($('prompt').value.trim()) })
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit() }
})
for (const button of document.querySelectorAll('[data-question]')) button.onclick = () => { void send(button.dataset.question) }
$('stop').onclick = () => controller?.abort()
function reset() {
  conversationId = undefined
  $('messages').replaceChildren(); $('welcome').hidden = false; $('prompt').value = ''
  notice(''); setStatus('新对话 · 之前的内容仍在历史中'); $('prompt').focus()
}
$('new-chat').onclick = () => {
  if (controller) { resetAfterStop = true; controller.abort(); return }
  if (loadingHistory) return
  reset(); void loadHistory()
}
async function loadHistory(append = false) {
  try {
    const response = await fetch(base + '/conversations?offset=' + (append ? historyOffset : 0))
    if (!response.ok) throw new Error('无法读取历史，请确认登录和插件权限。')
    const data = await response.json()
    if (!append) $('history-list').replaceChildren()
    for (const item of data.items) {
      const button = document.createElement('button')
      button.className = 'history-item' + (item.id === conversationId ? ' selected' : '')
      button.textContent = item.title || '新对话'; button.title = button.textContent
      button.disabled = Boolean(controller)
      button.onclick = () => { void openHistory(item.id) }
      $('history-list').append(button)
    }
    if (!$('history-list').childElementCount) {
      const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = '还没有对话，试着问一个问题'; $('history-list').append(empty)
    }
    historyOffset = data.nextOffset
    $('more-history').hidden = historyOffset === null
  } catch (error) { notice(error.message) }
}
async function openHistory(id) {
  if (controller || loadingHistory) return
  loadingHistory = true; busy(true); $('stop').hidden = true
  try {
    const response = await fetch(base + '/history?id=' + encodeURIComponent(id))
    if (!response.ok) { const error = await response.json(); throw new Error(error.error ?? '读取历史失败') }
    const data = await response.json()
    conversationId = data.conversationId
    if (narrow.matches) historyPanel.open = false
    $('messages').replaceChildren(); $('welcome').hidden = true
    for (const item of data.messages) message(item.role, item.text, item.reasoning)
    notice(data.busy ? '此会话仍在另一页面回答，请等待结束后刷新历史。' : '')
    setStatus('历史已恢复 · 可以继续追问')
    $('scroll-area').scrollTop = $('scroll-area').scrollHeight
    await loadHistory()
  } catch (error) { notice(error.message) }
  finally { loadingHistory = false; busy(false); $('prompt').focus() }
}
$('more-history').onclick = () => { void loadHistory(true) }
try {
  const response = await fetch(base + '/identity')
  if (!response.ok) throw new Error('无法验证访问状态，请重新登录。')
  const identity = await response.json()
  $('access-mode').textContent = identity.mode === 'authenticated' ? '已通过身份认证' : '独立体验模式'
  $('auth-link').hidden = identity.mode !== 'authenticated'
  $('history-label').textContent = identity.mode === 'authenticated' ? '我的历史对话' : '独立模式历史'
  $('prompt').maxLength = identity.maxMessageChars
  await loadHistory()
} catch (error) { notice(error.message); $('access-mode').textContent = '连接不可用' }
