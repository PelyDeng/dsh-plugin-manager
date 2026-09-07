export function initChat({api,request,identity,openDraft,renderMarkdown}){
  const $=id=>document.getElementById(id),base=document.body.dataset.base
  const state={id:null,epoch:0,history:null,files:[],feedback:new Map(),feedbackReady:false,stream:null,offset:null,sending:false,uploading:false,liveClock:0,pending:null}
  const inputs=new Map(),key=`blog-chat:${identity.userId}`
  let refreshTimer,refreshVersion=0,feedbackTarget,fileTarget,composing=false,creating
  const element=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el}
  const error=(e,id='chat-error')=>{const el=$(id);el.textContent=e.message??String(e);el.hidden=false;el.focus()}
  const run=(fn,id='chat-error')=>async event=>{try{$(id).hidden=true;await fn(event)}catch(e){error(e,id)}}
  const button=(label,fn)=>{const b=element('button',label);b.type='button';b.addEventListener('click',run(fn));return b}
  const url=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null}catch{return null}}
  const nearBottom=()=>{const el=$('chat-scroll');return el.scrollHeight-el.scrollTop-el.clientHeight<90}
  const bottom=()=>$('chat-scroll').scrollTo({top:$('chat-scroll').scrollHeight,behavior:'instant'})
  const formatTime=n=>Number.isFinite(n)?`${(n/1000).toFixed(2)} 秒`:'未提供'
  function view(chat){$('chat-home').hidden=!chat;document.querySelector('.workspace').hidden=chat;$('chat-view').setAttribute('aria-pressed',String(chat));$('writing-view').setAttribute('aria-pressed',String(!chat));if(chat)$('chat-input').focus()}
  $('chat-view').addEventListener('click',()=>view(true));$('writing-view').addEventListener('click',()=>view(false))
  function controls(){const busy=state.history?.busy||state.sending;$('chat-send').disabled=!!busy||state.uploading;$('chat-stop').hidden=!state.history?.busy;$('chat-add-file').disabled=state.uploading||state.sending;$('chat-state').textContent=state.uploading?'正在上传和解析资料…':busy?'正在回答，可停止；切换文章视图不会丢失对话':'Enter 发送 · Shift+Enter 换行 · 附件保持私有'}
  async function conversations(append=false){
    const data=await api('chat-list',{offset:append?state.offset??0:0}),box=$('chat-conversations')
    if(!append)box.replaceChildren()
    for(const c of data.items){const b=button(c.title,()=>activate(c.id));b.className='article-row';b.append(element('small',new Date(c.updatedAt).toLocaleString('zh-CN')));b.dataset.conversation=c.id;b.setAttribute('aria-current',String(c.id===state.id));box.append(b)}
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
    state.epoch++;state.stream?.close();state.stream=null;clearTimeout(refreshTimer);state.pending=null;state.sending=false;state.id=id;state.history=null;state.files=[];state.feedback.clear();state.feedbackReady=false;state.liveClock=0
    $('chat-feedback-dialog').close();$('chat-file-dialog').close()
    $('chat-input').value=inputs.get(id??'new')??'';$('chat-error').hidden=true;render();renderFiles();controls()
    if(id){sessionStorage.setItem(key,id);connect();await Promise.all([refresh(),loadFiles()])}else{sessionStorage.removeItem(key);$('chat-input').focus()}
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
  function prose(text){const el=element('div',undefined,'prose');el.innerHTML=renderMarkdown(text??'');return el}
  function reasoning(text,id){const d=element('details',undefined,'chat-reasoning');d.dataset.detail=id;d.append(element('summary','查看思考过程'),element('pre',text));return d}
  function renderLive(live=state.history?.live){const box=$('chat-live'),follow=nearBottom(),opened=box.querySelector('details')?.open;box.replaceChildren();box.hidden=!live;if(live){box.className='chat-message assistant-message';if(live.reasoning){const detail=reasoning(live.reasoning,'live');detail.open=!!opened;box.append(detail)}box.append(prose(live.text),element('small','正在回答…','muted'))}if(follow)bottom();$('chat-bottom').hidden=nearBottom()}
  function usage(turn){
    const details=element('details',undefined,'chat-usage');details.dataset.detail='usage-'+turn.turn
    details.append(element('summary',`Token ${turn.usage?.totalTokens?.toLocaleString()??'未提供'} · ${formatTime(turn.runMs)}`))
    const list=element('dl'),add=(name,value)=>{list.append(element('dt',name),element('dd',value))},u=turn.usage
    for(const [key,label] of [['uncachedInputTokens','未缓存输入'],['outputTokens','输出'],['cacheReadTokens','缓存读取'],['cacheWriteTokens','缓存写入'],['reasoningTokens','其中推理']])if(['uncachedInputTokens','outputTokens'].includes(key)||u?.[key]!==undefined)add(label,u?.[key]?.toLocaleString()??'未提供')
    add('总用时',formatTime(turn.runMs));add('首 Token 等待',formatTime(turn.ttftMs));add('输出速度',turn.tokensPerSecond===null?'未提供':`${turn.tokensPerSecond.toFixed(1)} Token/秒`);add('模型尝试',String(turn.attempts));details.append(list)
    return details
  }
  function render(){
    const box=$('chat-messages'),follow=nearBottom(),opened=new Set([...box.querySelectorAll('details[open]')].map(d=>d.dataset.detail)),history=state.history
    box.replaceChildren();$('chat-welcome').hidden=!!history?.messages.length
    for(const message of history?.messages??[]){
      const node=element('section',undefined,`chat-message ${message.role}-message`);node.dataset.message=message.id
      if(message.role==='tool'){node.append(element('small',`${{blog_search_posts:'查询博客文章',blog_read_post:'读取文章',blog_list_drafts:'查找工作台草稿',blog_select_draft:'选择写作文章',blog_propose:'保存候选稿',blog_web_search:'搜索资料',blog_web_fetch:'阅读网页'}[message.name]??'执行博客工具'} · ${{running:'进行中',succeeded:'完成',failed:'失败',interrupted:'已中断'}[message.status]??message.status}`));box.append(node);continue}
      if(message.role==='status'){node.textContent=message.text;box.append(node);continue}
      node.append(element('small',message.role==='user'?'你':'博客智能体','chat-author'))
      if(message.reasoning)node.append(reasoning(message.reasoning,message.id))
      node.append(message.role==='user'?element('div',message.text,'chat-user-text'):prose(message.text))
      for(const a of message.attachments??[]){const link=element('a',`📎 ${a.name}${a.range?`（${a.range.from}–${a.range.to}）`:''}`,'chat-file-link');link.href=`${base}/chat-attachment?${new URLSearchParams({conversationId:state.id,requestId:message.requestId,id:a.id})}`;node.append(link)}
      const actions=element('div',undefined,'chat-message-actions');actions.append(element('time',new Date(message.time).toLocaleTimeString('zh-CN'), 'muted'))
      if(message.role==='assistant'){
        actions.append(button('复制',()=>navigator.clipboard.writeText(message.text)))
        if(message.model)actions.append(element('small',`${message.provider} / ${message.model}`,'muted'))
        if(message.feedback){
          const current=state.feedback.get(message.id)
          for(const [rating,label] of [['positive','赞'],['negative','踩']]){const b=button(label,()=>rate(message,rating));b.disabled=!state.feedbackReady;b.setAttribute('aria-pressed',String(current?.rating===rating));actions.append(b)}
          const note=button('评价备注',()=>openFeedback(message));note.disabled=!state.feedbackReady;actions.append(note)
        }
        if(message.forkCut){actions.append(button('在新对话中继续',()=>branch(message,false)),button('重新生成',()=>branch(message,true)))}
        if(message.interrupted)actions.append(element('small','本段回答已中断','muted'))
        if(message.tail){const turn=history.turns.find(t=>t.turn===message.turn);if(turn)actions.append(usage(turn))}
      }
      node.append(actions);box.append(node)
    }
    for(const r of history?.requests??[]){
      if(['failed','interrupted'].includes(r.status)){const row=element('div',r.message??'本轮未完成','chat-status');row.append(button('继续本次请求',()=>send(`请基于前面的资料继续完成上一轮未完成的请求。`,r.id)));box.append(row)}
      if(r.sources?.length){const details=element('details',undefined,'chat-sources');details.dataset.detail='sources-'+r.id;details.append(element('summary',`查证来源（${r.sources.length}）`));for(const source of r.sources){const row=element('div'),href=url(source.url),link=element(href?'a':'span',source.title??source.url);if(href){link.href=href;link.target='_blank';link.rel='noopener noreferrer'}row.append(link,element('small',source.fetched?' · 已读取原文':' · 搜索摘要'));details.append(row)}box.append(details)}
    }
    for(const card of history?.results??[]){
      const row=element('section',undefined,'chat-result');row.append(element('h3',card.proposal?.fields.title||card.title||'文章候选稿'),element('p',`基于工作台版本 ${card.revision} 的历史候选快照 · 当前文章状态请打开编辑器查看`,'muted'))
      const details=element('details');details.dataset.detail='card-'+card.id;details.append(element('summary','查看本次候选快照'),prose(card.proposal?.fields.text??''));row.append(details,button('打开文章编辑',async()=>{await openDraft(card.draftId);view(false)}));box.append(row)
    }
    for(const details of box.querySelectorAll('details'))if(opened.has(details.dataset.detail))details.open=true
    renderLive();if(follow)bottom();$('chat-bottom').hidden=nearBottom()
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
    if(state.sending||state.uploading||state.history?.busy)return
    if(!text.trim())throw new Error('请输入消息')
    state.sending=true;controls();const epoch=state.epoch
    try{
      const id=await ensureConversation(),input={conversationId:id,text,research:$('chat-research').checked,attachments:state.files.filter(a=>a.selected&&a.status==='ready').map(a=>({id:a.id,version:a.version,range:a.range})),...(retryFrom?{retryFrom}:{})}
      const fingerprint=JSON.stringify(input)
      if(state.pending?.fingerprint!==fingerprint)state.pending={fingerprint,input:{...input,requestId:crypto.randomUUID()}}
      await api('chat-send',state.pending.input)
      if(epoch!==state.epoch)return
      state.pending=null;if($('chat-input').value===text)$('chat-input').value='';inputs.delete(id)
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
  $('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing&&e.keyCode!==229){e.preventDefault();$('chat-form').requestSubmit()}})
  $('chat-stop').addEventListener('click',run(async()=>{const id=state.id;await api('chat-stop',{conversationId:id});if(id===state.id)await refresh()}))
  $('chat-new').addEventListener('click',run(()=>activate(null)));$('chat-more').addEventListener('click',run(()=>conversations(true)))
  for(const b of document.querySelectorAll('[data-prompt]'))b.addEventListener('click',()=>{$('chat-input').value=b.dataset.prompt;$('chat-input').focus()})
  $('chat-scroll').addEventListener('scroll',()=>{$('chat-bottom').hidden=nearBottom()});$('chat-bottom').addEventListener('click',bottom)
  window.addEventListener('beforeunload',()=>state.stream?.close())
  void conversations().catch(error)
  const previous=sessionStorage.getItem(key);if(previous)void activate(previous).catch(e=>{error(e);void activate(null)})
}
