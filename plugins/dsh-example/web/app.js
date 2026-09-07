import { readEvents } from './stream.js'
import { renderMarkdown } from './markdown.js'
import {element,glyph,action,stat,compactTokens,keyboardSend,thinking as makeThinking,updateThinking} from './chat-ui.js'

const $ = id => document.getElementById(id)
const base = document.body.dataset.base
const narrow = matchMedia('(max-width: 650px)')
const historyPanel = $('history-dialog')
$('history-open').onclick=()=>historyPanel.showModal()
$('history-close').onclick=()=>historyPanel.close()
for(const node of document.querySelectorAll('[data-glyph]'))node.append(glyph(node.dataset.glyph))
const focusPrompt=()=>{if(!matchMedia('(pointer:coarse), (max-width:650px)').matches)$('prompt').focus()}
let feedbackAvailable=false,feedback=new Map()
const hint=()=>{$('input-hint').textContent=narrow.matches?'换行继续输入 · 点击箭头发送':'Enter 发送 · Shift+Enter 换行'};hint();narrow.addEventListener('change',hint)
const post=async(path,data)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),v=await r.json();if(!r.ok)throw Error(v.error??'操作失败，请重试');return v}
async function refreshFeedback(id){const r=await fetch(base+'/history?id='+encodeURIComponent(id));if(!r.ok)throw Error('无法读取评价状态');const data=await r.json();if(id===conversationId){feedback=new Map(data.feedback.map(f=>[f.messageId,f]));feedbackAvailable=data.feedbackAvailable}return data}
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
function message(role,text,reasoning='',meta){
 const article=element('article',undefined,'message qa-message '+(role==='user'?'qa-user':'qa-assistant')),avatar=element('div',undefined,'qa-avatar'),bubble=element('div',undefined,'qa-bubble'),content=element('div',undefined,'text qa-prose');avatar.append(glyph(role==='user'?'user':'chat'));article.append(avatar,bubble)
 let source=text,currentMeta=meta,targetId=conversationId
 const update=(value,append=false)=>{source=append?source+value:value;if(role==='assistant')content.innerHTML=renderMarkdown(source);else content.textContent=source};update(text)
 const thinking=makeThinking(reasoning,{className:'thinking'}),summary=thinking.querySelector('summary'),reasoningText=thinking.querySelector('.qa-thinking-body')
 const tools=element('section',undefined,'qa-tools');tools.hidden=true
 const setTools=items=>{tools.replaceChildren(element('h4','工具调用'));const list=element('div',undefined,'qa-tool-list');for(const item of items){const row=element('div',undefined,'qa-tool '+item.status);row.append(glyph('api'),element('span',({'example_search_framework':'检索框架源码','example_read_framework':'读取框架源码'})[item.name]??item.name),element('span',({running:'执行中',succeeded:'已完成',failed:'失败'})[item.status]??item.status));list.append(row)}tools.append(list);tools.hidden=!items.length}
 const actions=element('div',undefined,'qa-actions'),error=element('span',undefined,'qa-action-error');error.setAttribute('role','status')
 const guarded=fn=>async event=>{const control=event.currentTarget;control.disabled=true;error.textContent='';try{await fn()}catch(e){error.textContent=e.message}finally{if(control.isConnected)control.disabled=false}}
 const setMeta=value=>{currentMeta=value;targetId=conversationId;actions.replaceChildren();if(!source&&!value)return
 actions.append(action('copy','复制回答',guarded(async()=>{await navigator.clipboard.writeText(source);error.textContent='已复制'})))
 if(value?.status==='completed'&&value.messageId){for(const [rating,name,label]of [['positive','like','有帮助'],['negative','dislike','有待改进']]){const b=action(name,label,guarded(async()=>{await post('/feedback',{conversationId:targetId,messageId:value.messageId,rating,ifVersion:feedback.get(value.messageId)?.version??null});await refreshFeedback(targetId);if(article.isConnected)setMeta(value)}));b.disabled=!feedbackAvailable;b.setAttribute('aria-pressed',String(feedback.get(value.messageId)?.rating===rating));actions.append(b)}}
 if(Number.isSafeInteger(value?.branchSeq)){const b=action('branch','从这里创建新对话',guarded(async()=>{const original=targetId,c=await post('/branch',{conversationId:original,atSeq:value.branchSeq});if(conversationId===original)await openHistory(c.conversationId)}));b.disabled=!!controller;actions.append(b)}
 if(value?.usage){const u=value.usage;actions.append(stat('database','用量 '+compactTokens(u.totalTokens)+' tok',[['未缓存输入',u.uncachedInputTokens],['缓存命中',u.cacheReadTokens],['缓存写入',u.cacheWriteTokens],['输出',u.outputTokens],['其中思考',u.reasoningTokens],['合计',u.totalTokens]]))}
 if(Number.isFinite(value?.runMs))actions.append(stat('clock','用时 '+(value.runMs/1000).toFixed(1)+' 秒',[['总耗时',(value.runMs/1000).toFixed(2)+' 秒'],['首个输出',Number.isFinite(value.ttftMs)?(value.ttftMs/1000).toFixed(2)+' 秒':null]]))
 if(Number.isFinite(value?.completedAt))actions.append(element('time',new Date(value.completedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),'qa-clock'));actions.append(error)
 }
 if(role==='assistant')bubble.append(thinking,tools);bubble.append(content);if(role==='assistant'){bubble.append(actions);setMeta(meta)}
 $('messages').append(article);return {article,update,thinking,summary,reasoningText,setTools,setMeta,get meta(){return currentMeta}}
}
$('messages').addEventListener('click', async event => {
  const button = event.target.closest('.copy-code')
  if (!button) return
  try {
    await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent)
    button.textContent = '已复制'
    setTimeout(() => { button.textContent = '复制代码' }, 1500)
  } catch { notice('无法访问剪贴板，请选中代码手动复制。') }
})
async function send(text) {
  if (controller || !text.trim()) return
  notice('')
  $('welcome').hidden = true
  message('user', text)
  const answer = message('assistant', '')
  answer.article.classList.add('busy','qa-streaming');answer.thinking.classList.add('running')
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
      const area=$('scroll-area'),top=area.scrollTop,follow=area.scrollHeight-top-area.clientHeight<180
      if (event.type === 'session') conversationId = event.conversationId
      if (event.type === 'step') answer.update('')
      if (event.type === 'reasoning' && event.text) {
        answer.thinking.hidden = false; answer.reasoningText.textContent += event.text
        updateThinking(answer.thinking,answer.reasoningText.textContent,false); setStatus('正在思考…'); scroll()
      }
      if (event.type === 'delta') {
        answer.update(event.text, true); updateThinking(answer.thinking,answer.reasoningText.textContent)
        setStatus('正在回答…'); scroll()
      }
      if (event.type === 'answer') {
        answer.update(event.text)
        if (event.reasoning) { answer.reasoningText.textContent = event.reasoning; answer.thinking.hidden = false }
        updateThinking(answer.thinking,answer.reasoningText.textContent); scroll()
      }
      if (event.type === 'tools') answer.setTools(event.tools)
      if (event.type === 'meta') answer.setMeta(event.meta)
      if (event.type === 'error') { failed = true; notice(event.message) }
      if (event.type === 'done') {
        failed ||= event.reason !== 'completed'
        setStatus(failed ? '回答未完成' : '回答完成 · 可以继续追问')
      }
      area.scrollTop=follow?area.scrollHeight:top
    })
  } catch (error) {
    if (error.name === 'AbortError') setStatus('已停止 · 已保存的历史仍可继续')
    else { notice(error.message); setStatus('回答未完成'); $('prompt').value = text }
  } finally {
    answer.article.classList.remove('busy','qa-streaming');answer.thinking.classList.remove('running')
    updateThinking(answer.thinking,answer.reasoningText.textContent)
    controller = undefined
    busy(false);answer.setMeta(answer.meta)
    if (resetAfterStop) { resetAfterStop = false; reset() }
    await loadHistory()
    focusPrompt()
  }
}
$('chat-form').addEventListener('submit', event => { event.preventDefault(); void send($('prompt').value.trim()) })
$('prompt').addEventListener('keydown', event => {
  if (keyboardSend(event)) { event.preventDefault(); $('chat-form').requestSubmit() }
})
for (const button of document.querySelectorAll('[data-question]')) button.onclick = () => { void send(button.dataset.question) }
$('stop').onclick = () => controller?.abort()
function reset() {
  conversationId = undefined
  $('messages').replaceChildren(); $('welcome').hidden = false; $('prompt').value = ''
  notice(''); setStatus('新对话 · 之前的内容仍在历史中'); focusPrompt()
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
    historyPanel.close()
    $('messages').replaceChildren(); $('welcome').hidden = true
    feedback=new Map((data.feedback??[]).map(f=>[f.messageId,f]));feedbackAvailable=data.feedbackAvailable
    let turnIndex=0;for (const item of data.messages){const m=message(item.role,item.text,item.reasoning,item.role==='assistant'?data.turns?.[item.turn??turnIndex++]:undefined);if(item.role==='assistant'&&m.meta)m.setTools(m.meta.tools??[])}
    notice(data.busy ? '此会话仍在另一页面回答，请等待结束后刷新历史。' : '')
    setStatus('历史已恢复 · 可以继续追问')
    $('scroll-area').scrollTop = $('scroll-area').scrollHeight
    await loadHistory()
  } catch (error) { notice(error.message) }
  finally { loadingHistory = false; busy(false); focusPrompt() }
}
$('more-history').onclick = () => { void loadHistory(true) }
try {
  const response = await fetch(base + '/identity')
  if (!response.ok) throw new Error('无法验证访问状态，请重新登录。')
  const identity = await response.json()
  $('knowledge-version').textContent = `v${identity.version} · 知识 ${identity.knowledgeRevision}`
  $('knowledge-version').title = '知识摘要标识随包资料内容，不代表远程仓库实时状态'
  $('access-mode').textContent = identity.mode === 'authenticated' ? '已通过身份认证' : '独立体验模式'
  $('auth-link').hidden = identity.mode !== 'authenticated'
  $('history-label').textContent = identity.mode === 'authenticated' ? '我的历史对话' : '独立模式历史'
  feedbackAvailable=identity.feedbackAvailable
  $('prompt').maxLength = identity.maxMessageChars
  await loadHistory()
} catch (error) { notice(error.message); $('access-mode').textContent = '连接不可用' }

$('prompt').addEventListener('input',()=>{$('prompt').style.height='auto';$('prompt').style.height=Math.min(140,$('prompt').scrollHeight)+'px'})
document.addEventListener('click',e=>{for(const d of document.querySelectorAll('.qa-meta[open]'))if(!d.contains(e.target))d.open=false})
document.addEventListener('keydown',e=>{if(e.key==='Escape')for(const d of document.querySelectorAll('.qa-meta[open]'))d.open=false})
