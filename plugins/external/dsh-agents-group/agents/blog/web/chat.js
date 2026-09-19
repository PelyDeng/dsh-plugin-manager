import './model-picker.js'
import {managementSummary} from './management.js'
import {transferredFiles,attachmentName} from './clipboard.js'
import {createConversationHistory} from './conversation-history.js'
import {chatTurns} from './chat-turns.js'
import {createThinkingTranslations} from './thinking-translation.js'
import {icon} from './icons.js'
import {glyph,stat,compactTokens,thinking} from './chat-ui.js'

export function shouldSendChatEnter(event,{touch=false,composing=false}={}){
  return event.key==='Enter'&&!touch&&!event.shiftKey&&!event.isComposing&&!composing&&event.keyCode!==229
}

/**
 * 深链接选中的会话 id：URL 里的 `conversationId` 优先，其次回落到调用方给的"上一次那条"。
 *
 * ⚠️ **`@param` 必须显式写**（`web/**` 是 `.js`，`checkJs:false`）：不写的话 TS 会**从默认值
 * `null` 推出** `previous: null` ⇒ 调用方按真实契约传字符串时过不了类型——本文件 `:334`
 * （`sessionStorage.getItem(...)` 是 `string | null`）与 `tests/participant.test.ts` 的
 * 两条"有效值优先于旧值/没有 conversationId 时回落"用例都会报 TS2345。
 * @param {string} search
 * @param {string|null} [previous]
 * @returns {string|null}
 */
export function chatConversationTarget(search,previous=null){
  return new URLSearchParams(search).get('conversationId')||previous||null
}

import { enhancePreviews } from './file-preview.js'

export function initChat({api,request,identity,openDraft,renderMarkdown}){
  const $=id=>document.getElementById(id),base=document.body.dataset.base
  const state={id:null,epoch:0,history:null,files:[],feedback:new Map(),feedbackReady:false,stream:null,offset:null,sending:false,stopping:false,uploading:false,liveClock:0,pending:null}
  const picker=globalThis.createModelPicker({mount:$('chat-model-picker'),iconBase:base+'/media/',load:id=>api('chat-models',{conversationId:id}),onChange:()=>void showImageCapability()})
  const translations=createThinkingTranslations(base)
  const liveBox=$('chat-live'),liveAnchor=document.createComment('live-output');liveBox.before(liveAnchor)
  const inputs=new Map(),key=`blog-chat:${identity.userId}`
  const operationPending=new Set(),operationErrors=new Map()
  let refreshTimer,refreshVersion=0,feedbackTarget,fileTarget,composing=false,creating
  const element=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el}
  const error=(e,id='chat-error')=>{if(id==='chat-error'&&$('navigation-dialog').open)id='navigation-error';const el=$(id);el.textContent=e.message??String(e);el.hidden=false;el.focus()}
  const run=(fn,id='chat-error')=>async event=>{try{$(id).hidden=true;$('navigation-error').hidden=true;await fn(event)}catch(e){error(e,id)}}
  const button=(label,fn)=>{const b=element('button',label);b.type='button';b.addEventListener('click',run(fn));return b}
  const iconButton=(name,label,fn)=>{const b=button('',fn);b.className='qa-action';b.setAttribute('aria-label',label);b.title=label;b.dataset.action=label;b.append(glyph(name));return b}
  const touchInput=()=>matchMedia('(pointer: coarse), (max-width: 760px)').matches
  const focusInput=()=>{if(!touchInput())$('chat-input').focus({preventScroll:true})}
  const url=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null}catch{return null}}
  const nearBottom=()=>{const el=$('chat-scroll');return el.scrollHeight-el.scrollTop-el.clientHeight<90}
  const bottom=()=>$('chat-scroll').scrollTo({top:$('chat-scroll').scrollHeight,behavior:'instant'})
  const formatTime=n=>Number.isFinite(n)?`${(n/1000).toFixed(2)} 秒`:'未提供'
  function view(chat){$('chat-home').hidden=!chat;document.querySelector('.workspace').hidden=chat;document.body.dataset.view=chat?'chat':'writing';$('chat-view').setAttribute('aria-pressed',String(chat));$('writing-view').setAttribute('aria-pressed',String(!chat));window.dispatchEvent(new CustomEvent('blog:view',{detail:{chat}}));if(chat)focusInput()}
  $('chat-view').addEventListener('click',()=>view(true));$('writing-view').addEventListener('click',()=>view(false))
  function controls(){const busy=state.history?.busy||state.sending;picker.setBusy(busy||state.stopping);$('chat-send').disabled=!!busy||state.uploading||state.stopping;$('chat-stop').hidden=!state.history?.busy&&!state.stopping;$('chat-stop').disabled=state.stopping;$('chat-stop').setAttribute('aria-label',state.stopping?'正在停止回答':'停止回答');$('chat-add-file').disabled=state.uploading||state.sending;$('chat-state').textContent=state.stopping?'正在停止，保留已生成内容…':state.uploading?'正在上传和解析资料…':busy?'正在回答 · 可随时停止':touchInput()?'换行继续输入 · 点击箭头发送 · 附件保持私有':'Enter 发送 · Shift+Enter 换行 · 附件保持私有'}
  const sidebar=createConversationHistory({mount:$('chat-home'),toggle:$('workspace-menu'),currentId:()=>state.id,
    newConversation:()=>{void activate(null).catch(error)},openConversation:activate,
    list:args=>api('chat-list',args),mutate:args=>api('chat-update',args),read:id=>api('chat-history',{conversationId:id}),
    onDeleted:async ids=>{if(ids.includes(state.id))await activate(null)},storageKey:'blog-history:'+identity.userId})
  async function conversations(append=false){await sidebar.refresh(append)}
  function syncConversationUrl(id){
    const url=new URL(window.location.href)
    if(id)url.searchParams.set('conversationId',id);else url.searchParams.delete('conversationId')
    window.history.replaceState(window.history.state,'',url)
  }
  async function ensureConversation(){
    if(state.id)return state.id
    const epoch=state.epoch
    if(creating?.epoch===epoch)return creating.promise
    const pending={epoch,promise:null};creating=pending
    pending.promise=(async()=>{const c=await api('chat-create',{requestId:crypto.randomUUID()});if(epoch!==state.epoch)throw new Error('对话已切换，请在当前对话重试');state.id=c.id;sessionStorage.setItem(key,c.id);syncConversationUrl(c.id);connect();void conversations().catch(error);return c.id})()
    try{return await pending.promise}finally{if(creating===pending)creating=null}
  }
  async function activate(id){
    translations.reset()
    inputs.set(state.id??'new',$('chat-input').value)
    const epoch=++state.epoch
    state.stream?.close();state.stream=null;clearTimeout(refreshTimer);state.pending=null;state.sending=false;state.stopping=false;state.id=id;state.history=null;state.files=[];state.feedback.clear();state.feedbackReady=false;state.liveClock=0
    syncConversationUrl(id)
    if(!id)sessionStorage.removeItem(key)
    $('chat-feedback-dialog').close();$('chat-file-dialog').close()
    $('chat-image-capability').hidden=true;$('chat-input').value=inputs.get(id??'new')??'';$('chat-error').hidden=true;render();renderFiles();controls()
    window.dispatchEvent(new CustomEvent('blog:conversation',{detail:{id}}))
    await picker.refresh(id)
    if(epoch!==state.epoch)return
    if(id){sessionStorage.setItem(key,id);connect();await Promise.all([refresh(),loadFiles()])}else focusInput()
    if(epoch!==state.epoch)return
    sidebar.render()
  }
  function connect(){
    state.stream?.close();const id=state.id,epoch=state.epoch
    if(!id)return
    const stream=new EventSource(`${base}/chat-events?conversationId=${encodeURIComponent(id)}`);state.stream=stream
    stream.onmessage=event=>{
      if(epoch!==state.epoch||id!==state.id)return
      try{const data=JSON.parse(event.data)
        if(data.type==='live'){state.liveClock++;if(state.history){state.history.live=data.live;state.history.busy=true}renderLive(data.live);controls()}
        if(data.type==='snapshot'||data.type==='changed'){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refresh().catch(error),60)}
      }catch{error(new Error('对话流返回异常，请重新打开此对话'))}
    }
    stream.onerror=()=>{if(epoch===state.epoch)$('chat-state').textContent='连接中断，正在重新连接；已提交的任务可在历史中查看'}
  }
  async function refresh(){
    if(!state.id)return
    const id=state.id,epoch=state.epoch,version=++refreshVersion,clock=state.liveClock
    const data=await api('chat-history',{conversationId:id})
    if(epoch!==state.epoch||version!==refreshVersion)return
    if(data.busy&&clock!==state.liveClock)data.live=state.history?.live??data.live
    const wasBusy=state.history?.busy,titleChanged=state.history?.conversation?.title!==data.conversation?.title;state.history=data;render();controls()
    if(!data.busy){const feedback=await api('chat-feedback',{conversationId:id,operation:'list'});if(epoch!==state.epoch||version!==refreshVersion)return;if(feedback.ok){state.feedback=new Map(feedback.value.items.map(i=>[i.messageId,i]));state.feedbackReady=true;render()}}
    if(titleChanged||wasBusy&&!data.busy)void conversations().catch(error)
  }
  function prose(text){const el=element('div',undefined,'prose qa-prose');el.innerHTML=renderMarkdown(text??'');enhancePreviews(el);return el}
  function reasoning(text,id){const d=thinking(text,{className:'chat-reasoning'});d.dataset.detail=id;d.dataset.originalText=text;return d}
  function bubble(node,user=false){node.classList.add('qa-message');if(user)node.classList.add('qa-user');const avatar=element('span',undefined,'qa-avatar');avatar.setAttribute('aria-hidden','true');avatar.append(glyph(user?'user':'chat'));const content=element('div',undefined,'qa-bubble');node.append(avatar,content);return content}
  function renderLive(live=state.history?.live,{follow=nearBottom(),scrollTop=$('chat-scroll').scrollTop}={}){
    const box=liveBox;box.hidden=!live
    const last=state.history?.messages.at(-1)
    if(live&&last?.role==='user'&&![...$('chat-messages').querySelectorAll('.qa-assistant-turn')].some(n=>n.dataset.message==='pending-'+last.id)){render();return}
    // Live can arrive before the next user-message snapshot. Never write it into a completed turn.
    const lastCard=[...$('chat-messages').querySelectorAll('.qa-assistant-turn')].at(-1),card=lastCard?.dataset.complete==='true'?null:lastCard,inline=!!card
    if(live&&card)card.querySelector('.qa-bubble').append(box);else liveAnchor.after(box)
    for(const node of $('chat-messages').querySelectorAll('.qa-turn-answer,.chat-message-actions'))node.hidden=!!live?.text&&node.closest('.qa-assistant-turn')===card
    if(live){
      if(box.dataset.inline!==String(inline)){box.replaceChildren();box.dataset.inline=String(inline)}
      box.className=inline?'chat-live-inline qa-streaming':'chat-message assistant-message qa-message qa-streaming';const content=inline?box:box.querySelector('.qa-bubble')??bubble(box)
      let thought=inline?card.querySelector('.chat-reasoning'):box.querySelector('.chat-reasoning'),text=box.querySelector('.chat-live-text'),status=box.querySelector('.chat-stream-status')
      if(!thought){thought=reasoning('','live');(inline?card.querySelector('.qa-bubble'):content).prepend(thought)}
      if(live.reasoning)translations.watch(thought,{text:live.reasoning,conversationId:state.id,done:!!live.text})
      if(!text){text=prose('');text.classList.add('chat-live-text');content.append(text)}
      text.innerHTML=renderMarkdown(live.text??'');enhancePreviews(text)
      if(!status){status=element('small',undefined,'chat-stream-status');status.setAttribute('role','status');content.append(status)}
      status.textContent=state.stopping?'正在停止，保留已生成内容…':live.text?'正在回答…':live.reasoning?'正在思考…':'正在连接模型…'
    }else box.replaceChildren()
    if(follow)bottom();else $('chat-scroll').scrollTop=scrollTop
    $('chat-bottom').hidden=nearBottom()
  }
  function usage(turn,message){
    const fragment=document.createDocumentFragment(),u=turn.usage,rows=[]
    for(const [key,label] of [['uncachedInputTokens','未缓存输入'],['outputTokens','输出'],['cacheReadTokens','缓存读取'],['cacheWriteTokens','缓存写入'],['reasoningTokens','其中推理']])if(['uncachedInputTokens','outputTokens'].includes(key)||u?.[key]!==undefined)rows.push([label,u?.[key]?.toLocaleString()??'未提供'])
    const tokens=stat('database',`用量 ${compactTokens(u?.totalTokens)} tok`,rows);tokens.dataset.detail='tokens-'+turn.turn
    const time=stat('clock',`用时 ${formatTime(turn.runMs)}`,[['总用时',formatTime(turn.runMs)],['首 Token 等待',formatTime(turn.ttftMs)],['输出速度',Number.isFinite(turn.tokensPerSecond)?`${turn.tokensPerSecond.toFixed(1)} Token/秒`:'未提供'],['模型尝试',turn.attempts],['模型',message?.model?`${message.provider} / ${message.model}`:null]]);time.dataset.detail='time-'+turn.turn
    fragment.append(tokens,time);return fragment
  }
  function render(){
    const thoughtScroll=new Map([...$('chat-messages').querySelectorAll('.qa-thinking-body,.qa-thinking-original pre')].map(el=>[el,el.scrollTop]))
    const box=$('chat-messages'),follow=nearBottom(),scrollTop=$('chat-scroll').scrollTop,history=state.history,displayMessages=chatTurns(history?.messages??[],{busy:!!history?.busy,operations:history?.operations??[],requests:history?.requests??[]})
    const previous=new Map([...box.children].map(n=>[n.dataset.key,n])),nodes=[]
    const focused=document.activeElement,focusKey=focused?.closest('[data-key]')?.dataset.key,focusAction=focused?.dataset.action
    const append=(node,key,value)=>{
      const old=previous.get(key),version=JSON.stringify(value)
      if(old?.dataset.version===version){nodes.push(old);return}
      for(const newThought of node.querySelectorAll('.chat-reasoning')){const oldThought=[...old?.querySelectorAll('.chat-reasoning')??[]].find(d=>d.dataset.detail===newThought.dataset.detail&&d.dataset.originalText===newThought.dataset.originalText);if(oldThought)newThought.replaceWith(oldThought)}
      const opened=new Set([...(old?.matches('details[open]')?[old]:[]),...old?.querySelectorAll('details[open]')??[]].map(d=>d.dataset.detail))
      for(const detail of [...(node.matches('details')?[node]:[]),...node.querySelectorAll('details')])if(opened.has(detail.dataset.detail))detail.open=true
      node.dataset.key=key;node.dataset.version=version;nodes.push(node)
    }
    $('chat-welcome').hidden=!!history?.messages.length
    for(const message of displayMessages){
      if(message.role==='operation'){
        const op=message.operation,node=operationCard(op)
        if(message.unassociated)node.prepend(element('small','历史操作（原轮次暂不可用）','muted'))
        append(node,'operation-'+op.id,{op,unassociated:message.unassociated,busy:history.busy,pending:operationPending.has(op.id),error:operationErrors.get(op.id)});continue
      }
      const node=element('section',undefined,`chat-message ${message.role}-message`);node.dataset.message=message.id;if(message.role==='assistant'){node.classList.add('qa-assistant-turn');node.dataset.complete=String(!!message.tail||Number.isFinite(history?.turns?.find(t=>t.turn===message.turn)?.runMs))}
      if(message.role==='tool'){const chip=element('span',undefined,`qa-tool ${message.status}`);chip.append(glyph('api'),element('small',`${{blog_search_posts:'查询博客文章',blog_read_post:'读取文章',blog_list_drafts:'查询博客草稿',blog_select_draft:'选择写作文章',blog_propose:'保存候选稿',blog_web_search:'搜索资料',blog_web_fetch:'阅读网页',blog_publish_draft:'准备发布',blog_delete_post:'准备删除',blog_manage_list:'查询分类标签评论',blog_manage_get:'读取管理条目',blog_manage_change:'准备管理修改'}[message.name]??'执行博客工具'} · ${{running:'进行中',succeeded:'完成',failed:'失败',interrupted:'已中断'}[message.status]??message.status}`));node.append(chip);append(node,'message-'+message.id,message);continue}
      if(message.role==='status'){node.textContent=message.text;append(node,'message-'+message.id,message);continue}
      const content=bubble(node,message.role==='user')
      if(message.reasoning)content.append(reasoning(message.reasoning,message.reasoningSource??message.id))
      if(message.tools?.length){const tools=element('section',undefined,'qa-tools'),head=element('h4','工具调用'),list=element('div',undefined,'qa-tool-list');for(const tool of message.tools){const chip=element('span',undefined,'qa-tool '+tool.status);chip.append(glyph('api'),element('span',({blog_search_posts:'查询博客文章',blog_read_post:'读取文章',blog_list_drafts:'查询博客草稿',blog_select_draft:'选择写作文章',blog_propose:'保存候选稿',blog_web_search:'搜索资料',blog_web_fetch:'阅读网页',blog_publish_draft:'准备发布',blog_delete_post:'准备删除',blog_manage_list:'查询分类标签评论',blog_manage_get:'读取管理条目',blog_manage_change:'准备管理修改'})[tool.name]??'博客工具'),element('span',({running:'进行中',succeeded:'完成',failed:'失败',interrupted:'已中断'})[tool.status]??tool.status));list.append(chip)}tools.append(head,list);content.append(tools)}
      if(message.statuses?.length)content.append(element('p',message.statuses.at(-1),'chat-stream-status'))
      const answer=message.role==='user'?element('div',message.text,'chat-user-text'):prose(message.text);if(message.role==='assistant')answer.classList.add('qa-turn-answer');content.append(answer)
      if(message.steps?.length>1){const process=element('details',undefined,'chat-step-history');process.dataset.detail='steps-'+message.displayKey;process.append(element('summary','本轮过程（'+message.steps.length+' 个模型步骤）'));for(const step of message.steps.slice(0,-1)){const section=element('section');if(step.reasoning&&step.id!==message.reasoningSource){const thought=reasoning(step.reasoning,step.id);thought.dataset.source=step.id;section.append(thought)}if(step.text)section.append(prose(step.text));process.append(section)}content.append(process)}
      for(const a of message.attachments??[]){const link=element('a',undefined,'chat-file-link');link.append(icon('paperclip'),document.createTextNode(`${a.name}${a.range?`（${a.range.from}–${a.range.to}）`:''}`));link.href=`${base}/chat-attachment?${new URLSearchParams({conversationId:state.id,requestId:message.requestId,id:a.id})}`;content.append(link)}
      const actions=element('div',undefined,'chat-message-actions qa-actions')
      if(message.role==='assistant'){
        actions.append(iconButton('copy','复制回答',async event=>{const control=event.currentTarget;await navigator.clipboard.writeText(message.text);control.title='已复制';control.setAttribute('aria-label','已复制回答');setTimeout(()=>{if(control.isConnected){control.title='复制回答';control.setAttribute('aria-label','复制回答')}},1500)}))
        if(message.feedback){
          const current=state.feedback.get(message.id)
          for(const [rating,name,label] of [['positive','like','有帮助'],['negative','dislike','有待改进']]){const b=iconButton(name,label,()=>rate(message,rating));b.disabled=!state.feedbackReady;b.setAttribute('aria-pressed',String(current?.rating===rating));actions.append(b)}
        }
        if(message.forkCut)actions.append(iconButton('branch','在新对话中继续',()=>branch(message,false)))
        if(message.feedback||message.forkCut){
          const more=element('details',undefined,'message-more');more.dataset.detail='more-'+message.id
          const summary=element('summary',undefined,'qa-action');summary.setAttribute('aria-label','更多回答操作');summary.title='更多回答操作';summary.dataset.action='更多回答操作';summary.append(icon('more'))
          const menu=element('div',undefined,'message-menu'),item=(name,label,fn)=>{const b=button('',async()=>{more.open=false;await fn()});b.dataset.action=label;b.append(icon(name),document.createTextNode(label));menu.append(b);return b}
          if(message.feedback)item('comment','评价备注',()=>openFeedback(message)).disabled=!state.feedbackReady
          if(message.forkCut){item('refresh','重新生成',()=>branch(message,true)).title='保留原回答与文章，在新分支重新生成'}
          more.append(summary,menu);actions.append(more)
        }
        if(message.interrupted)actions.append(element('small','本段回答已中断','muted'))
        const turn=history.turns.find(t=>t.turn===message.turn);if(Number.isFinite(turn?.runMs))actions.append(usage(turn,message))
      }
      if(message.role==='assistant'){actions.append(element('time',new Date(message.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),'qa-clock'));content.append(actions)}
      append(node,message.displayKey??'message-'+message.id,{message,complete:node.dataset.complete,feedback:state.feedback.get(message.id),feedbackReady:state.feedbackReady,turn:message.role==='assistant'?history.turns.find(t=>t.turn===message.turn):null})
    }
    for(const turn of history?.turns??[])if(Number.isFinite(turn.runMs)&&!displayMessages.some(m=>m.role==='assistant'&&m.turn===turn.turn)){const row=element('div',undefined,'chat-turn-summary qa-actions');row.append(usage(turn));append(row,'turn-'+turn.turn,turn);const user=history.messages.findLast(m=>m.role==='user'&&m.seq<turn.startSeq),position=nodes.findIndex(n=>n.dataset.message===user?.id);if(position>=0){const summary=nodes.pop();nodes.splice(position+1,0,summary)}}
    for(const r of history?.requests??[]){
      if(['failed','interrupted'].includes(r.status)){const row=element('div',r.message??'本轮未完成','chat-status');row.append(button('继续本次请求',()=>send(`请基于前面的资料继续完成上一轮未完成的请求。`,r.id)));append(row,'request-'+r.id,{status:r.status,message:r.message})}
      if(r.sources?.length){const details=element('details',undefined,'chat-sources');details.dataset.detail='sources-'+r.id;details.append(element('summary',`查证来源（${r.sources.length}）`));for(const source of r.sources){const row=element('div'),href=url(source.url),link=element(href?'a':'span',source.title??source.url);if(href){link.href=href;link.target='_blank';link.rel='noopener noreferrer'}row.append(link,element('small',source.fetched?' · 已读取原文':' · 搜索摘要'));details.append(row)}append(details,'sources-'+r.id,r.sources)}
    }
    for(const card of history?.results??[]){
      const row=element('section',undefined,'chat-result chat-result-compact'),head=element('div',undefined,'chat-result-head');head.append(element('h3',card.proposal?.fields.title||card.title||'文章候选稿'),button('打开文章',async()=>{const epoch=state.epoch;await openDraft(card.draftId,{proposal:card.proposal});if(epoch===state.epoch)view(false)}));row.append(head)
      const details=element('details');details.dataset.detail='card-'+card.id;details.append(element('summary',`候选快照 · 基于版本 ${card.revision}`),prose(card.proposal?.fields.text??''),element('small','历史候选快照，当前文章状态以编辑器为准','muted'));row.append(details);append(row,'card-'+card.id,card)
    }
    let cursor=box.firstElementChild
    for(const node of nodes){if(node===cursor)cursor=cursor.nextElementSibling;else box.insertBefore(node,cursor)}
    while(cursor){const next=cursor.nextElementSibling;cursor.remove();cursor=next}
    for(const message of displayMessages){if(message.role!=='assistant')continue;const node=nodes.find(n=>n.dataset.message===message.id),thought=node?.querySelector('.qa-bubble > .chat-reasoning');if(thought)translations.watch(thought,{text:message.reasoning,conversationId:state.id,sourceId:message.reasoningSource,done:true});for(const step of message.steps?.slice(0,-1)??[]){const prior=[...node?.querySelectorAll('[data-source]')??[]].find(n=>n.dataset.source===step.id);if(prior)translations.watch(prior,{text:step.reasoning,conversationId:state.id,sourceId:step.id,done:true})}}
    translations.sweep()
    for(const [el,top] of thoughtScroll)el.scrollTop=top
    if(focusKey&&focusAction&&document.activeElement!==focused){const replacement=nodes.find(n=>n.dataset.key===focusKey);[...replacement?.querySelectorAll('[data-action]')??[]].find(n=>n.dataset.action===focusAction)?.focus({preventScroll:true})}
    renderLive(state.history?.live,{follow,scrollTop})
  }
  function operationCard(op){
    const row=element('section',undefined,'chat-result chat-operation'),deleting=op.mode==='delete',pending=operationPending.has(op.id)
    row.dataset.operation=op.id
    const label=op.mode==='manage'?'博客管理':deleting?'删除文章':'发布草稿'
    row.append(element('h3',`${label} · ${op.title}`))
    if(op.mode==='publish'){
      row.append(element('p',op.source==='proposal'?'发布内容：AI 候选稿（确认后应用并发布）':'发布内容：当前草稿'))
      const preview=element('details');preview.dataset.detail='operation-preview-'+op.id
      preview.append(element('summary','查看将发布的完整内容'),prose(op.after?.text),element('p',`标签：${op.after?.tags?.join('、')||'无'}；分类 ID：${op.after?.categories?.join('、')||'无'}；允许评论：${op.after?.allowComment===undefined?'沿用原设置':op.after.allowComment?'是':'否'}`));row.append(preview)
    }else if(op.mode==='manage'){
      const detail=element('pre',managementSummary(op));detail.style.whiteSpace='pre-wrap';row.append(detail)
    }else{
      row.append(element('p','确认后永久删除以下博客内容及关联评论。图床文件和编辑恢复数据保留。'))
      const targets=element('ul');for(const p of op.deletedArticles??[])targets.append(element('li',`${p.title} · ${p.type==='post_draft'?'博客保存稿':'博客文章'} · ID ${p.cid}`));row.append(targets)
    }
    const status=element('p',pending?'正在处理…':({prepared:state.history?.busy?'请等待本轮回答完成后确认':op.canConfirm?'请核对内容后确认':'确认已失效，请重新发起操作',running:'执行结果待核对，请查询回执',uncertain:'执行结果待核对，请勿重复操作',succeeded:op.mode==='manage'?'已完成':deleting?'已删除':'已发布',conflict:'文章已变化，请重新核对并发起操作',cancelled:'已取消'})[op.status]??op.status)
    status.setAttribute('role','status');row.append(status)
    const href=url(op.result?.url);if(href){const link=element('a','查看博客文章');link.href=href;link.target='_blank';link.rel='noopener noreferrer';row.append(link)}
    let consent
    if(op.status==='prepared'&&!deleting&&op.hasSavedDraft){const label=element('label',undefined,'check');consent=element('input');consent.type='checkbox';label.append(consent,document.createTextNode('我确认此次发布会替换现有博客保存稿'));row.append(label)}
    const act=async operation=>{
      if(operationPending.has(op.id))return
      const id=state.id,epoch=state.epoch,consumeSavedDraft=!!consent?.checked
      operationPending.add(op.id);operationErrors.delete(op.id);render()
      try{await api('chat-operation',{conversationId:id,id:op.id,nonce:op.nonce,operation,consumeSavedDraft})}
      catch(e){operationErrors.set(op.id,e.message??String(e))}
      finally{operationPending.delete(op.id);if(epoch===state.epoch){await refresh();render()}}
    }
    const actions=element('div',undefined,'chat-operation-actions')
    if(op.status==='prepared'){
      const confirm=button(op.mode==='manage'?'确认执行':deleting?'确认删除':'确认发布',()=>act('confirm'));confirm.className='primary'
      confirm.disabled=pending||!op.canConfirm||!!consent;consent?.addEventListener('change',()=>{confirm.disabled=pending||!op.canConfirm||!consent.checked})
      const cancel=button('取消',()=>act('cancel'));cancel.disabled=pending||!op.canConfirm;actions.append(confirm,cancel)
    }
    if(['running','uncertain'].includes(op.status)){const reconcile=button('核对操作结果',()=>act('reconcile'));reconcile.disabled=pending||state.history?.busy;actions.append(reconcile)}
    row.append(actions)
    if(operationErrors.has(op.id)){const error=element('p',operationErrors.get(op.id),'error');error.setAttribute('role','alert');row.append(error)}
    return row
  }
  async function rate(message,rating){
    const id=state.id,epoch=state.epoch,old=state.feedback.get(message.id)
    const result=await api('chat-feedback',{conversationId:id,operation:old?.rating===rating?'delete':'put',messageId:message.id,rating,ifVersion:old?.version??null,...(old?.note?{note:old.note}:{})})
    if(epoch!==state.epoch)return
    checkFeedback(result,message.id);rememberFeedback(result,message.id,id);await refresh()
  }
  function checkFeedback(result,messageId,conversationId=state.id){
    if(result.ok)return
    if(result.error.code==='version-conflict'){const current=result.error.current;if(conversationId===state.id){refreshVersion++;if(current)state.feedback.set(messageId,current);else state.feedback.delete(messageId);render()}throw new Error('评价已在其他窗口变化，已刷新当前版本，请核对后再提交')}
    throw new Error(({ 'note-too-large':'评价备注过长，请缩短','note-blank':'评价备注不能只有空格','session-not-found':'对话尚未完成持久化，请稍后重试','target-not-found':'回答不存在或尚未完成' })[result.error.code]??'评价未能保存')
  }
  function rememberFeedback(result,messageId,conversationId){
    if(state.id!==conversationId)return
    refreshVersion++
    if(result.value.absent)state.feedback.delete(messageId)
    else state.feedback.set(messageId,result.value)
    render()
  }
  function openFeedback(message){feedbackTarget={conversationId:state.id,messageId:message.id,version:state.feedback.get(message.id)?.version??null};const old=state.feedback.get(message.id);$('chat-rating').value=old?.rating??'positive';$('chat-feedback-note').value=old?.note??'';$('chat-feedback-error').hidden=true;$('chat-feedback-delete').disabled=!old;$('chat-feedback-dialog').showModal()}
  async function saveFeedback(operation){const target=feedbackTarget,note=$('chat-feedback-note').value;const result=await api('chat-feedback',{...target,operation,ifVersion:target.version,rating:$('chat-rating').value,...(note.trim()?{note}:{})});if(!result.ok&&result.error.code==='version-conflict'){target.version=result.error.current?.version??null;if(feedbackTarget===target){$('chat-rating').value=result.error.current?.rating??'positive';$('chat-feedback-note').value=result.error.current?.note??'';$('chat-feedback-delete').disabled=!result.error.current}}checkFeedback(result,target.messageId,target.conversationId);rememberFeedback(result,target.messageId,target.conversationId);if(feedbackTarget===target)$('chat-feedback-dialog').close();if(state.id===target.conversationId)await refresh()}
  $('chat-feedback-save').addEventListener('click',run(()=>saveFeedback('put'),'chat-feedback-error'))
  $('chat-feedback-delete').addEventListener('click',run(()=>saveFeedback('delete'),'chat-feedback-error'))
  async function branch(message,regenerate){
    const id=state.id,epoch=state.epoch,prior=state.history.messages.filter(m=>m.role==='user'&&m.seq<message.seq).at(-1)
    const c=await api('chat-fork',{conversationId:id,messageId:message.id,requestId:crypto.randomUUID()})
    if(epoch!==state.epoch)return
    const branchEpoch=state.epoch+1
    await activate(c.id);if(state.id!==c.id||state.epoch!==branchEpoch)return
    await conversations();if(state.id!==c.id||state.epoch!==branchEpoch)return
    if(regenerate)await send('请基于上一轮资料重新给出回答或文章候选。沿用已关联文章；原回答与文章不回滚，不重复创建文章。',prior?.requestId)
  }
  async function send(text=$('chat-input').value,retryFrom=null){
    if(state.sending||state.uploading||state.stopping||state.history?.busy)return
    if(!text.trim())throw new Error('请输入消息')
    state.sending=true;controls();const epoch=state.epoch
    try{
      const id=await ensureConversation(),input={conversationId:id,text,...picker.payload(),research:$('chat-research').checked,attachments:state.files.filter(a=>a.selected&&a.status==='ready').map(a=>({id:a.id,version:a.version,range:a.range})),...(retryFrom?{retryFrom}:{})}
      const fingerprint=JSON.stringify(input)
      if(state.pending?.fingerprint!==fingerprint)state.pending={fingerprint,input:{...input,requestId:crypto.randomUUID()}}
      const accepted=await api('chat-send',state.pending.input)
      if(epoch===state.epoch)picker.accept(accepted.model)
      if(epoch!==state.epoch)return
      state.pending=null;if($('chat-input').value===text){$('chat-input').value='';$('chat-input').dispatchEvent(new Event('input'))}inputs.delete(id)
      await Promise.all(input.attachments.map(a=>api('attachment-select',{draftId:id,id:a.id,selected:false,range:a.range})))
      await Promise.all([refresh(),loadFiles(),conversations()]);bottom()
    }finally{if(epoch===state.epoch){state.sending=false;controls()}}
  }
  async function loadFiles(){if(!state.id)return;const id=state.id,epoch=state.epoch,files=await api('attachments',{draftId:id});if(epoch!==state.epoch)return;state.files=files;renderFiles();void showImageCapability()}
  async function showImageCapability(){
    const tip=$('chat-image-capability'),epoch=state.epoch
    if(!state.files.some(a=>a.selected&&a.kind.startsWith('image/'))){tip.hidden=true;return}
    tip.hidden=false;tip.textContent='正在检查图片模型…'
    try{const result=await api('chat-image-capability',{conversationId:state.id,...picker.payload()});if(epoch!==state.epoch||!state.files.some(a=>a.selected&&a.kind.startsWith('image/')))return;tip.textContent=result.message;tip.classList.toggle('warning',!result.available||!result.currentSupportsImages)}catch(e){if(epoch===state.epoch)tip.textContent='暂时无法检查图片模型：'+e.message}
  }
  function renderFiles(){const box=$('chat-files');box.replaceChildren();for(const a of state.files){const row=element('div',undefined,'attachment-row'),label=element('label'),check=element('input');check.type='checkbox';check.checked=a.selected;check.disabled=a.status!=='ready';check.setAttribute('aria-label',`发送 ${a.name}`);check.addEventListener('change',run(async()=>{await api('attachment-select',{draftId:state.id,id:a.id,selected:check.checked,range:a.range});await loadFiles()}));label.append(check,document.createTextNode(a.name));if(a.kind.startsWith('image/')&&a.status==='ready'){const thumb=element('img');thumb.className='chat-attachment-thumbnail';thumb.alt=a.name;thumb.src=`${base}/attachment-download?${new URLSearchParams({draftId:state.id,id:a.id,inline:'1'})}`;row.append(thumb)}row.append(label,element('small',a.range?`${a.range.from}–${a.range.to} ${a.unit}`:a.message??({ready:'已就绪',failed:'解析失败',parsing:'解析中',uploading:'上传中'}[a.status]??a.status)),button('查看',()=>previewFile(a)),button('移除',async()=>{await api('attachment-remove',{draftId:state.id,id:a.id});await loadFiles()}));box.append(row)}}
  async function previewFile(a){
    const id=state.id,epoch=state.epoch,content=await api('attachment-content',{draftId:id,id:a.id});if(epoch!==state.epoch)return
    fileTarget={draftId:id,id:a.id};$('chat-file-title').textContent=a.name;$('chat-file-description').textContent=`${content.partial?'部分解析；请明确选择范围':'解析完成'}${content.totalUnits?`，共 ${content.totalUnits} ${content.unit}`:''}`
    $('chat-file-text').textContent=(content.units??[]).map(u=>`[${content.unit} ${u.number}] ${u.text}`).join('\n');$('chat-file-range').hidden=!content.units?.length
    $('chat-range-from').value=a.range?.from??1;$('chat-range-to').value=a.range?.to??content.units?.length??1
    const path=`${base}/attachment-download?${new URLSearchParams({draftId:id,id:a.id})}`;$('chat-file-download').href=path;$('chat-file-image').hidden=!a.kind.startsWith('image/');if(a.kind.startsWith('image/'))$('chat-file-image').src=path+'&inline=1'
    $('chat-file-error').hidden=true;$('chat-file-dialog').showModal()
  }
  $('chat-range-save').addEventListener('click',run(async()=>{await api('attachment-select',{...fileTarget,selected:true,range:{from:Number($('chat-range-from').value),to:Number($('chat-range-to').value)}});$('chat-file-dialog').close();await loadFiles()},'chat-file-error'))
  $('chat-add-file').addEventListener('click',()=>$('chat-file-input').click())
  async function uploadFiles(files){
    if(!files.length)return
    if(state.uploading||state.sending)throw new Error('正在处理资料，请稍后再粘贴或选择文件')
    state.uploading=true;controls();const epoch=state.epoch
    try{const id=await ensureConversation();for(const [index,file] of files.entries()){if(epoch!==state.epoch)return;if(file.size>20*1024*1024)throw new Error('单份资料不能超过 20 MiB');await request(`/attachment?${new URLSearchParams({draftId:id,name:attachmentName(file,index)})}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});if(epoch!==state.epoch)return}}
    finally{try{if(epoch===state.epoch)await loadFiles()}finally{$('chat-file-input').value='';state.uploading=false;controls()}}
  }
  $('chat-file-input').addEventListener('change',run(()=>uploadFiles([...$('chat-file-input').files])))
  $('chat-input').addEventListener('paste',e=>{
    const files=transferredFiles(e.clipboardData);if(!files.length)return
    e.preventDefault();const text=e.clipboardData.getData('text/plain');if(text){$('chat-input').setRangeText(text,$('chat-input').selectionStart,$('chat-input').selectionEnd,'end');$('chat-input').dispatchEvent(new Event('input'))}
    void run(()=>uploadFiles(files))()
  })
  $('chat-form').addEventListener('dragover',e=>{if([...e.dataTransfer?.types??[]].includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy'}})
  $('chat-form').addEventListener('drop',e=>{const files=transferredFiles(e.dataTransfer);if(!files.length)return;e.preventDefault();void run(()=>uploadFiles(files))()})
  $('chat-form').addEventListener('submit',run(async e=>{e.preventDefault();await send()}))
  $('chat-input').addEventListener('compositionstart',()=>{composing=true});$('chat-input').addEventListener('compositionend',()=>{composing=false})
  $('chat-input').addEventListener('keydown',e=>{if(shouldSendChatEnter(e,{touch:touchInput(),composing})){e.preventDefault();$('chat-form').requestSubmit()}})
  $('chat-stop').addEventListener('click',run(async()=>{if(state.stopping)return;const id=state.id,epoch=state.epoch;state.stopping=true;controls();renderLive();try{await api('chat-stop',{conversationId:id});if(epoch===state.epoch)await refresh()}finally{if(epoch===state.epoch){state.stopping=false;controls();renderLive()}}}))
  window.addEventListener('blog:new-conversation',run(()=>activate(null)))
  window.addEventListener('blog:view',({detail})=>{if(!detail.chat&&matchMedia('(max-width:960px)').matches)sidebar.hide()})
  for(const b of document.querySelectorAll('[data-prompt]'))b.addEventListener('click',()=>{$('chat-input').value=b.dataset.prompt;$('chat-input').dispatchEvent(new Event('input'));focusInput()})
  $('chat-messages').addEventListener('toggle',event=>{if(event.target.matches('.message-more[open], .qa-meta[open]'))for(const menu of $('chat-messages').querySelectorAll('.message-more[open], .qa-meta[open]'))if(menu!==event.target)menu.open=false;requestAnimationFrame(()=>{$('chat-bottom').hidden=nearBottom()})},true)
  document.addEventListener('click',event=>{for(const menu of $('chat-messages').querySelectorAll('.message-more[open], .qa-meta[open]'))if(!menu.contains(event.target))menu.open=false})
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=$('chat-messages').querySelector('.message-more[open], .qa-meta[open]');if(menu){menu.open=false;menu.querySelector('summary').focus({preventScroll:true});event.preventDefault()}}})
  $('chat-scroll').addEventListener('scroll',()=>{$('chat-bottom').hidden=nearBottom()});$('chat-bottom').addEventListener('click',bottom)
  window.addEventListener('beforeunload',()=>state.stream?.close())
  window.addEventListener('resize',controls)
  void conversations().catch(error)
  controls()
  const target=chatConversationTarget(window.location.search,sessionStorage.getItem(key))
  if(new URLSearchParams(window.location.search).has('conversationId'))view(true)
  void activate(target).catch(e=>{error(e);void activate(null)})
}
