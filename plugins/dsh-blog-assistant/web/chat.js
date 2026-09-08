import {icon} from './icons.js'
import {glyph,stat,compactTokens,thinking,updateThinking} from './chat-ui.js'

export function shouldSendChatEnter(event,{touch=false,composing=false}={}){
  return event.key==='Enter'&&!touch&&!event.shiftKey&&!event.isComposing&&!composing&&event.keyCode!==229
}

export function initChat({api,request,identity,openDraft,renderMarkdown}){
  const $=id=>document.getElementById(id),base=document.body.dataset.base
  const state={id:null,epoch:0,history:null,files:[],feedback:new Map(),feedbackReady:false,stream:null,offset:null,sending:false,stopping:false,uploading:false,liveClock:0,pending:null}
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
  function controls(){const busy=state.history?.busy||state.sending;$('chat-send').disabled=!!busy||state.uploading||state.stopping;$('chat-stop').hidden=!state.history?.busy&&!state.stopping;$('chat-stop').disabled=state.stopping;$('chat-stop').setAttribute('aria-label',state.stopping?'正在停止回答':'停止回答');$('chat-add-file').disabled=state.uploading||state.sending;$('chat-state').textContent=state.stopping?'正在停止，保留已生成内容…':state.uploading?'正在上传和解析资料…':busy?'正在回答 · 可随时停止':touchInput()?'换行继续输入 · 点击箭头发送 · 附件保持私有':'Enter 发送 · Shift+Enter 换行 · 附件保持私有'}
  async function conversations(append=false){
    const data=await api('chat-list',{offset:append?state.offset??0:0}),box=$('chat-conversations')
    if(!append)box.replaceChildren()
    for(const c of data.items){const b=button('',()=>activate(c.id));b.className='article-row';b.title=c.title;b.append(element('span',c.title,'conversation-title'),element('small',new Date(c.updatedAt).toLocaleString('zh-CN')));b.dataset.conversation=c.id;b.setAttribute('aria-current',String(c.id===state.id));box.append(b)}
    state.offset=data.nextOffset;$('chat-more').hidden=state.offset===null
  }
  async function ensureConversation(){
    if(state.id)return state.id
    const epoch=state.epoch
    if(creating?.epoch===epoch)return creating.promise
    const pending={epoch,promise:null};creating=pending
    pending.promise=(async()=>{const c=await api('chat-create',{requestId:crypto.randomUUID()});if(epoch!==state.epoch)throw new Error('对话已切换，请在当前对话重试');state.id=c.id;sessionStorage.setItem(key,c.id);connect();void conversations().catch(error);return c.id})()
    try{return await pending.promise}finally{if(creating===pending)creating=null}
  }
  async function activate(id){
    inputs.set(state.id??'new',$('chat-input').value)
    state.epoch++;state.stream?.close();state.stream=null;clearTimeout(refreshTimer);state.pending=null;state.sending=false;state.stopping=false;state.id=id;state.history=null;state.files=[];state.feedback.clear();state.feedbackReady=false;state.liveClock=0
    $('chat-feedback-dialog').close();$('chat-file-dialog').close()
    $('chat-input').value=inputs.get(id??'new')??'';$('chat-error').hidden=true;render();renderFiles();controls()
    window.dispatchEvent(new CustomEvent('blog:conversation',{detail:{id}}))
    if(id){sessionStorage.setItem(key,id);connect();await Promise.all([refresh(),loadFiles()])}else{sessionStorage.removeItem(key);focusInput()}
    if(id!==state.id)return
    for(const row of $('chat-conversations').children)row.setAttribute('aria-current',String(row.dataset.conversation===id))
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
    const wasBusy=state.history?.busy;state.history=data;render();controls()
    if(!data.busy){const feedback=await api('chat-feedback',{conversationId:id,operation:'list'});if(epoch!==state.epoch||version!==refreshVersion)return;if(feedback.ok){state.feedback=new Map(feedback.value.items.map(i=>[i.messageId,i]));state.feedbackReady=true;render()}}
    if(wasBusy&&!data.busy)void conversations().catch(error)
  }
  function prose(text){const el=element('div',undefined,'prose qa-prose');el.innerHTML=renderMarkdown(text??'');return el}
  function reasoning(text,id){const d=thinking(text,{className:'chat-reasoning'});d.dataset.detail=id;return d}
  function bubble(node,user=false){node.classList.add('qa-message');if(user)node.classList.add('qa-user');const avatar=element('span',undefined,'qa-avatar');avatar.setAttribute('aria-hidden','true');avatar.append(glyph(user?'user':'chat'));const content=element('div',undefined,'qa-bubble');node.append(avatar,content);return content}
  function renderLive(live=state.history?.live,{follow=nearBottom(),scrollTop=$('chat-scroll').scrollTop}={}){
    const box=$('chat-live');box.hidden=!live
    if(live){
      box.className='chat-message assistant-message qa-message qa-streaming';const content=box.querySelector('.qa-bubble')??bubble(box)
      let thought=box.querySelector('.chat-reasoning'),text=box.querySelector('.chat-live-text'),status=box.querySelector('.chat-stream-status')
      if(!thought){thought=reasoning('','live');content.append(thought)}
      updateThinking(thought,live.reasoning??'',!!live.text)
      if(!text){text=prose('');text.classList.add('chat-live-text');content.append(text)}
      text.innerHTML=renderMarkdown(live.text??'')
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
    const box=$('chat-messages'),follow=nearBottom(),scrollTop=$('chat-scroll').scrollTop,history=state.history
    const previous=new Map([...box.children].map(n=>[n.dataset.key,n])),nodes=[]
    const focused=document.activeElement,focusKey=focused?.closest('[data-key]')?.dataset.key,focusAction=focused?.dataset.action
    const append=(node,key,value)=>{
      const old=previous.get(key),version=JSON.stringify(value)
      if(old?.dataset.version===version){nodes.push(old);return}
      const opened=new Set([...(old?.matches('details[open]')?[old]:[]),...old?.querySelectorAll('details[open]')??[]].map(d=>d.dataset.detail))
      for(const detail of [...(node.matches('details')?[node]:[]),...node.querySelectorAll('details')])if(opened.has(detail.dataset.detail))detail.open=true
      node.dataset.key=key;node.dataset.version=version;nodes.push(node)
    }
    $('chat-welcome').hidden=!!history?.messages.length
    for(const message of history?.messages??[]){
      const node=element('section',undefined,`chat-message ${message.role}-message`);node.dataset.message=message.id
      if(message.role==='tool'){const chip=element('span',undefined,`qa-tool ${message.status}`);chip.append(glyph('api'),element('small',`${{blog_search_posts:'查询博客文章',blog_read_post:'读取文章',blog_list_drafts:'查找工作台草稿',blog_select_draft:'选择写作文章',blog_propose:'保存候选稿',blog_web_search:'搜索资料',blog_web_fetch:'阅读网页',blog_publish_draft:'准备发布',blog_delete_post:'准备删除'}[message.name]??'执行博客工具'} · ${{running:'进行中',succeeded:'完成',failed:'失败',interrupted:'已中断'}[message.status]??message.status}`));node.append(chip);append(node,'message-'+message.id,message);continue}
      if(message.role==='status'){node.textContent=message.text;append(node,'message-'+message.id,message);continue}
      const content=bubble(node,message.role==='user')
      if(message.reasoning)content.append(reasoning(message.reasoning,message.id))
      content.append(message.role==='user'?element('div',message.text,'chat-user-text'):prose(message.text))
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
        if(message.tail){const turn=history.turns.find(t=>t.turn===message.turn);if(turn)actions.append(usage(turn,message))}
      }
      if(message.role==='assistant'){actions.append(element('time',new Date(message.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),'qa-clock'));content.append(actions)}
      append(node,'message-'+message.id,{message,feedback:state.feedback.get(message.id),feedbackReady:state.feedbackReady,turn:message.tail?history.turns.find(t=>t.turn===message.turn):null})
    }
    for(const turn of history?.turns??[])if(turn.runMs!==null&&!history.messages.some(m=>m.tail&&m.turn===turn.turn)){const row=element('div',undefined,'chat-turn-summary qa-actions');row.append(usage(turn));append(row,'turn-'+turn.turn,turn)}
    for(const r of history?.requests??[]){
      if(['failed','interrupted'].includes(r.status)){const row=element('div',r.message??'本轮未完成','chat-status');row.append(button('继续本次请求',()=>send(`请基于前面的资料继续完成上一轮未完成的请求。`,r.id)));append(row,'request-'+r.id,{status:r.status,message:r.message})}
      if(r.sources?.length){const details=element('details',undefined,'chat-sources');details.dataset.detail='sources-'+r.id;details.append(element('summary',`查证来源（${r.sources.length}）`));for(const source of r.sources){const row=element('div'),href=url(source.url),link=element(href?'a':'span',source.title??source.url);if(href){link.href=href;link.target='_blank';link.rel='noopener noreferrer'}row.append(link,element('small',source.fetched?' · 已读取原文':' · 搜索摘要'));details.append(row)}append(details,'sources-'+r.id,r.sources)}
    }
    for(const card of history?.results??[]){
      const row=element('section',undefined,'chat-result chat-result-compact'),head=element('div',undefined,'chat-result-head');head.append(element('h3',card.proposal?.fields.title||card.title||'文章候选稿'),button('打开文章',async()=>{const epoch=state.epoch;await openDraft(card.draftId);if(epoch===state.epoch)view(false)}));row.append(head)
      const details=element('details');details.dataset.detail='card-'+card.id;details.append(element('summary',`候选快照 · 基于版本 ${card.revision}`),prose(card.proposal?.fields.text??''),element('small','历史候选快照，当前文章状态以编辑器为准','muted'));row.append(details);append(row,'card-'+card.id,card)
    }
    for(const op of history?.operations??[])append(operationCard(op),'operation-'+op.id,{op,busy:history.busy,pending:operationPending.has(op.id),error:operationErrors.get(op.id)})
    let cursor=box.firstElementChild
    for(const node of nodes){if(node===cursor)cursor=cursor.nextElementSibling;else box.insertBefore(node,cursor)}
    while(cursor){const next=cursor.nextElementSibling;cursor.remove();cursor=next}
    if(focusKey&&focusAction&&document.activeElement!==focused){const replacement=nodes.find(n=>n.dataset.key===focusKey);[...replacement?.querySelectorAll('[data-action]')??[]].find(n=>n.dataset.action===focusAction)?.focus({preventScroll:true})}
    renderLive(state.history?.live,{follow,scrollTop})
  }
  function operationCard(op){
    const row=element('section',undefined,'chat-result chat-operation'),deleting=op.mode==='delete',pending=operationPending.has(op.id)
    row.dataset.operation=op.id
    const label=deleting?'删除文章':'发布草稿'
    row.append(element('h3',`${label} · ${op.title}`))
    if(op.mode==='publish'){
      row.append(element('p',op.source==='proposal'?'发布内容：AI 候选稿（确认后应用并发布）':'发布内容：当前草稿'))
      const preview=element('details');preview.dataset.detail='operation-preview-'+op.id
      preview.append(element('summary','查看将发布的完整内容'),prose(op.after?.text),element('p',`标签：${op.after?.tags?.join('、')||'无'}`));row.append(preview)
    }else{
      row.append(element('p','确认后永久删除以下博客内容及关联评论。图床文件和工作台副本保留。'))
      const targets=element('ul');for(const p of op.deletedArticles??[])targets.append(element('li',`${p.title} · ${p.type==='post_draft'?'博客保存稿':'博客文章'} · ID ${p.cid}`));row.append(targets)
    }
    const status=element('p',pending?'正在处理…':({prepared:state.history?.busy?'请等待本轮回答完成后确认':op.canConfirm?'请核对内容后确认':'确认已失效，请重新发起操作',running:'执行结果待核对，请查询回执',uncertain:'执行结果待核对，请勿重复操作',succeeded:deleting?'已删除':'已发布',conflict:'文章已变化，请重新核对并发起操作',cancelled:'已取消'})[op.status]??op.status)
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
      const confirm=button(deleting?'确认删除':'确认发布',()=>act('confirm'));confirm.className='primary'
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
      const id=await ensureConversation(),input={conversationId:id,text,research:$('chat-research').checked,attachments:state.files.filter(a=>a.selected&&a.status==='ready').map(a=>({id:a.id,version:a.version,range:a.range})),...(retryFrom?{retryFrom}:{})}
      const fingerprint=JSON.stringify(input)
      if(state.pending?.fingerprint!==fingerprint)state.pending={fingerprint,input:{...input,requestId:crypto.randomUUID()}}
      await api('chat-send',state.pending.input)
      if(epoch!==state.epoch)return
      state.pending=null;if($('chat-input').value===text){$('chat-input').value='';$('chat-input').dispatchEvent(new Event('input'))}inputs.delete(id)
      await Promise.all(input.attachments.map(a=>api('attachment-select',{draftId:id,id:a.id,selected:false,range:a.range})))
      await Promise.all([refresh(),loadFiles(),conversations()]);bottom()
    }finally{if(epoch===state.epoch){state.sending=false;controls()}}
  }
  async function loadFiles(){if(!state.id)return;const id=state.id,epoch=state.epoch,files=await api('attachments',{draftId:id});if(epoch!==state.epoch)return;state.files=files;renderFiles()}
  function renderFiles(){const box=$('chat-files');box.replaceChildren();for(const a of state.files){const row=element('div',undefined,'attachment-row'),label=element('label'),check=element('input');check.type='checkbox';check.checked=a.selected;check.disabled=a.status!=='ready';check.setAttribute('aria-label',`发送 ${a.name}`);check.addEventListener('change',run(async()=>{await api('attachment-select',{draftId:state.id,id:a.id,selected:check.checked,range:a.range});await loadFiles()}));label.append(check,document.createTextNode(a.name));row.append(label,element('small',a.range?`${a.range.from}–${a.range.to} ${a.unit}`:a.message??({ready:'已就绪',failed:'解析失败',parsing:'解析中',uploading:'上传中'}[a.status]??a.status)),button('查看',()=>previewFile(a)),button('移除',async()=>{await api('attachment-remove',{draftId:state.id,id:a.id});await loadFiles()}));box.append(row)}}
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
  $('chat-file-input').addEventListener('change',run(async()=>{
    state.uploading=true;controls();const epoch=state.epoch,files=[...$('chat-file-input').files]
    try{const id=await ensureConversation();for(const file of files){if(file.size>20*1024*1024)throw new Error('单份资料不能超过 20 MiB');await request(`/attachment?${new URLSearchParams({draftId:id,name:file.name})}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});if(epoch!==state.epoch)return}}
    finally{try{if(epoch===state.epoch)await loadFiles()}finally{$('chat-file-input').value='';state.uploading=false;controls()}}
  }))
  $('chat-form').addEventListener('submit',run(async e=>{e.preventDefault();await send()}))
  $('chat-input').addEventListener('compositionstart',()=>{composing=true});$('chat-input').addEventListener('compositionend',()=>{composing=false})
  $('chat-input').addEventListener('keydown',e=>{if(shouldSendChatEnter(e,{touch:touchInput(),composing})){e.preventDefault();$('chat-form').requestSubmit()}})
  $('chat-stop').addEventListener('click',run(async()=>{if(state.stopping)return;const id=state.id,epoch=state.epoch;state.stopping=true;controls();renderLive();try{await api('chat-stop',{conversationId:id});if(epoch===state.epoch)await refresh()}finally{if(epoch===state.epoch){state.stopping=false;controls();renderLive()}}}))
  $('chat-new').addEventListener('click',run(()=>activate(null)));$('chat-more').addEventListener('click',run(()=>conversations(true)))
  for(const b of document.querySelectorAll('[data-prompt]'))b.addEventListener('click',()=>{$('chat-input').value=b.dataset.prompt;$('chat-input').dispatchEvent(new Event('input'));focusInput()})
  $('chat-messages').addEventListener('toggle',event=>{if(event.target.matches('.message-more[open], .qa-meta[open]'))for(const menu of $('chat-messages').querySelectorAll('.message-more[open], .qa-meta[open]'))if(menu!==event.target)menu.open=false},true)
  document.addEventListener('click',event=>{for(const menu of $('chat-messages').querySelectorAll('.message-more[open], .qa-meta[open]'))if(!menu.contains(event.target))menu.open=false})
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){const menu=$('chat-messages').querySelector('.message-more[open], .qa-meta[open]');if(menu){menu.open=false;menu.querySelector('summary').focus({preventScroll:true});event.preventDefault()}}})
  $('chat-scroll').addEventListener('scroll',()=>{$('chat-bottom').hidden=nearBottom()});$('chat-bottom').addEventListener('click',bottom)
  window.addEventListener('beforeunload',()=>state.stream?.close())
  window.addEventListener('resize',controls)
  void conversations().catch(error)
  controls()
  const previous=sessionStorage.getItem(key);if(previous)void activate(previous).catch(e=>{error(e);void activate(null)})
}
