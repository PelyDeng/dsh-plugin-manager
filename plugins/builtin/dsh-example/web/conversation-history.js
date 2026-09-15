import {element} from './chat-ui.js'

const shapes={search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',panel:'M4 3h16v18H4zM9 3v18',plus:'M12 5v14M5 12h14',more:'M5 12h.01M12 12h.01M19 12h.01',edit:'M15 5l4 4M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16z',pin:'M9 3h6l-1 6 4 4v2H6v-2l4-4zM12 15v6',share:'M12 16V3m-5 5 5-5 5 5M5 14v7h14v-7',select:'M4 5h2m4 0h10M4 12h2m4 0h10M4 19h2m4 0h10',trash:'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',close:'M5 5l14 14M19 5 5 19'}
export function historyIcon(name){const n=element('span',undefined,'qh-icon');n.setAttribute('aria-hidden','true');n.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${shapes[name]??shapes.more}"/></svg>`;return n}
export function historyGroup(item,now=Date.now()){
  if(item.pinned)return '置顶'
  const day=new Date(now);day.setHours(0,0,0,0)
  const age=Math.floor((day.getTime()-new Date(item.updatedAt).setHours(0,0,0,0))/86400000)
  if(age<=0)return '今天';if(age===1)return '昨天';if(age<7)return '7 天内';if(age<30)return '30 天内';return '更早'
}
export function conversationMarkdown(title,messages){return `# ${String(title||'对话记录').replace(/[\r\n]/g,' ')}\n\n`+messages.filter(m=>['user','assistant'].includes(m.role)&&m.text?.trim()).map(m=>`## ${m.role==='user'?'我':'助手'}\n\n${m.text}`).join('\n\n---\n\n')+'\n'}

// The host may save its first title after the answer stream has closed.
export function createConversationTitleRefresh({currentId,refresh}){
  let id,timer,deadline
  function stop(){clearTimeout(timer);timer=undefined;id=undefined}
  function active(){return id&&currentId()===id&&Date.now()<deadline}
  return{
    start(conversationId){stop();id=conversationId;deadline=Date.now()+65000;void refresh()},
    observe(items){
      if(!id)return
      clearTimeout(timer)
      if(!active()||items.find(item=>item.id===id)?.titleSource!=='automatic'){stop();return}
      timer=setTimeout(()=>{if(active())void refresh();else stop()},Math.min(2000,deadline-Date.now()))
    },
    title(event){
      if(event.conversationId!==currentId())return
      if(event.titleSource==='generated'||event.titleSource==='manual')stop()
      void refresh()
    },
    stop,
  }
}

/** Sidebar owns only navigation UI. Hosts provide authenticated list/update/read operations. */
export function createConversationHistory({mount,toggle,newConversation,openConversation,currentId,list,mutate,read,onDeleted,onRefreshed,label='历史对话',storageKey='chat-history'}){
  const panel=element('dialog',undefined,'qa-history'),heading=element('strong',label),head=element('div',undefined,'qh-head'),tools=element('div',undefined,'qh-head-tools'),search=button('search','搜索对话'),collapse=button('panel','收起历史对话'),create=button('plus','开启新对话',false),searchBox=element('input'),rows=element('div',undefined,'qh-rows'),status=element('p',undefined,'qh-status'),more=element('button','加载更多','qh-more'),batch=element('div',undefined,'qh-batch'),footer=element('p','对话按最近活动时间分组','qh-footer')
  panel.setAttribute('aria-label',label);searchBox.type='search';searchBox.placeholder='搜索对话标题';searchBox.maxLength=120;searchBox.setAttribute('aria-label','搜索对话标题');searchBox.className='qh-search';searchBox.hidden=true
  status.setAttribute('role','status');status.hidden=true;tools.append(search,collapse);head.append(heading,tools);panel.append(head,create,searchBox,batch,status,rows,more,footer);mount.prepend(panel)
  const mobile=matchMedia('(max-width: 960px)'),selected=new Set(),dialogs=new Set();let items=[],offset=null,query='',version=0,loading=false,multi=false,mutating=false,blocked=false,timer,disposed=false
  let collapsed=false;try{collapsed=localStorage.getItem(storageKey)==='collapsed'}catch{}
  const menu=element('div',undefined,'qh-menu');menu.setAttribute('popover','auto');menu.setAttribute('aria-label','对话操作');panel.append(menu)
  function button(icon,label,iconOnly=true){const b=element('button',undefined,iconOnly?'qh-icon-button':'qh-new');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.append(historyIcon(icon));if(!iconOnly)b.append(document.createTextNode(label));return b}
  function syncToggle(){toggle?.setAttribute('aria-expanded',String(panel.open));toggle?.setAttribute('aria-label',panel.open?'收起历史对话':'展开历史对话');document.body.classList.toggle('qh-expanded',panel.open&&!mobile.matches)}
  function show(){if(!panel.open){if(mobile.matches)panel.showModal();else panel.show()}syncToggle()}
  function hide(){panel.close();syncToggle()}
  function layout(){hide();if(!mobile.matches&&!collapsed)show()}
  function remember(value){collapsed=value;try{localStorage.setItem(storageKey,value?'collapsed':'expanded')}catch{}}
  collapse.onclick=()=>{if(!mobile.matches)remember(true);hide()};if(toggle)toggle.onclick=()=>{if(panel.open){if(!mobile.matches)remember(true);hide()}else{if(!mobile.matches)remember(false);show()}}
  panel.addEventListener('close',syncToggle);mobile.addEventListener('change',layout)
  search.onclick=()=>{searchBox.hidden=false;searchBox.focus()};searchBox.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>{query=searchBox.value.trim();void refresh()},200)})
  create.onclick=()=>{if(mobile.matches)hide();newConversation()}
  more.onclick=()=>refresh(true)
  function report(text){status.textContent=text;status.hidden=!text}
  async function refresh(append=false){
    const ticket=++version;loading=true;more.disabled=true;report('')
    try{const data=await list({offset:append?offset??0:0,query});if(ticket!==version||disposed)return;items=append?[...items,...data.items.filter(i=>!items.some(old=>old.id===i.id))]:data.items;offset=data.nextOffset;for(const id of selected)if(!items.some(i=>i.id===id))selected.delete(id);render();onRefreshed?.(items)}
    catch(error){if(ticket===version){report(error.message);if(!append){items=[];offset=null;render()}}}
    finally{if(ticket===version){loading=false;more.disabled=false}}
  }
  function render(){
    const scrollTop=rows.scrollTop;rows.replaceChildren();let group
    for(const item of items){const next=historyGroup(item);if(next!==group){group=next;rows.append(element('h3',group))}
      const row=element('div',undefined,'qh-row');row.dataset.conversation=item.id;row.classList.toggle('current',currentId()===item.id)
      if(multi){const check=element('input');check.type='checkbox';check.checked=selected.has(item.id);check.disabled=!check.checked&&selected.size>=100;check.setAttribute('aria-label','选择 '+item.title);check.onchange=()=>{check.checked?selected.add(item.id):selected.delete(item.id);render()};row.append(check)}
      const link=element('button',item.title||'新对话','qh-title');link.type='button';link.disabled=blocked;link.title=blocked?'请等待回答完成或先停止':item.title;link.setAttribute('aria-current',String(currentId()===item.id));link.onclick=async()=>{try{await openConversation(item.id);if(mobile.matches)hide();render()}catch(e){report(e.message)}};row.append(link)
      const options=button('more','操作 '+(item.title||'新对话'));options.setAttribute('aria-haspopup','menu');options.onclick=()=>openMenu(item,options);row.append(options);rows.append(row)
    }
    if(!items.length)rows.append(element('p',query?'没有匹配的对话':'还没有历史对话','qh-empty'));rows.scrollTop=scrollTop;more.hidden=offset===null;renderBatch()
  }
  function renderBatch(){batch.replaceChildren();batch.hidden=!multi;if(!multi)return;batch.append(element('span',`已选 ${selected.size} 条`));for(const [label,fn] of [['选择已加载',()=>{items.slice(0,100).forEach(i=>selected.add(i.id));render()}],['导出',()=>exportItems(items.filter(i=>selected.has(i.id)))],['删除',()=>confirmDelete([...selected])],['取消',()=>{multi=false;selected.clear();render()}]]){const b=element('button',label);b.type='button';b.disabled=mutating||(['导出','删除'].includes(label)&&!selected.size);b.onclick=fn;batch.append(b)}}
  function openMenu(item,anchor){
    menu.replaceChildren();for(const [icon,label,fn] of [['edit','重命名',()=>rename(item)],['pin',item.pinned?'取消置顶':'置顶',()=>update({operation:'pin',ids:[item.id],pinned:!item.pinned})],['share','分享 / 导出',()=>exportItems([item])],['select','多选',()=>{multi=true;selected.add(item.id);render()}],['trash','删除',()=>confirmDelete([item.id])]]){const b=button(icon,label,false);b.className='qh-menu-item'+(icon==='trash'?' danger':'');b.setAttribute('role','menuitem');b.disabled=mutating;b.onclick=()=>{menu.hidePopover();void fn()};menu.append(b)}
    menu.showPopover();const r=anchor.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(innerWidth-200,r.left))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,r.bottom+5))+'px';menu.querySelector('button').focus()
  }
  async function update(input){mutating=true;renderBatch();try{await mutate(input);if(input.operation==='delete'){await onDeleted?.(input.ids);input.ids.forEach(id=>selected.delete(id))}await refresh();return true}catch(e){report(e.message);return false}finally{mutating=false;renderBatch()}}
  function dialog(title){const d=element('dialog',undefined,'qh-dialog'),h=element('div',undefined,'qh-dialog-head'),close=button('close','关闭'),body=element('div',undefined,'qh-dialog-body'),actions=element('div',undefined,'qh-dialog-actions');const titleNode=element('h2',title);titleNode.id='qh-title-'+crypto.randomUUID();d.setAttribute('aria-labelledby',titleNode.id);h.append(titleNode,close);d.append(h,body,actions);document.body.append(d);dialogs.add(d);close.onclick=()=>d.close();d.addEventListener('close',()=>{dialogs.delete(d);d.remove()},{once:true});return{d,body,actions}}
  function rename(item){const {d,body,actions}=dialog('重命名对话'),input=element('input'),save=element('button','保存'),error=element('p',undefined,'qh-error');input.value=item.title;input.maxLength=100;input.setAttribute('aria-label','对话标题');error.setAttribute('role','alert');body.append(input,error);actions.append(save);const submit=async()=>{if(!input.value.trim()){error.textContent='请输入标题';return}save.disabled=true;if(await update({operation:'rename',ids:[item.id],title:input.value.trim()}))d.close();else{error.textContent=status.textContent;save.disabled=false}};save.onclick=submit;input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();void submit()}};d.showModal();input.select()}
  function confirmDelete(ids){if(!ids.length)return;const {d,body,actions}=dialog(`删除 ${ids.length} 条对话？`),cancel=element('button','取消'),remove=element('button','删除','danger'),error=element('p',undefined,'qh-error');body.append(element('p','将从历史列表移除，无法从此页面恢复。业务数据、附件文件和官方留存日志不会被删除。'),error);error.setAttribute('role','alert');actions.append(cancel,remove);cancel.onclick=()=>d.close();remove.onclick=async()=>{remove.disabled=true;if(await update({operation:'delete',ids}))d.close();else{error.textContent=status.textContent;remove.disabled=false}};d.showModal();cancel.focus()}
  async function exportItems(chosen){
    if(!chosen.length)return;const {d,body,actions}=dialog('分享对话'),intro=element('p','仅导出问答正文，不包含思考原文、附件文件或工具记录。不会生成公开链接。'),preview=element('textarea'),error=element('p',undefined,'qh-error'),copy=element('button','复制 Markdown'),download=element('button','下载 .md');preview.readOnly=true;preview.setAttribute('aria-label','导出内容预览');preview.value='正在读取…';error.setAttribute('role','status');body.append(intro,preview,error);actions.append(copy,download);copy.disabled=download.disabled=true;d.showModal();try{const all=[];for(const item of chosen){if(!d.open)return;const data=await read(item.id);all.push(conversationMarkdown(item.title,data.messages))}if(!d.open)return;preview.value=all.join('\n\n---\n\n');copy.disabled=download.disabled=false}catch(e){preview.value='';error.textContent=e.message}
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(preview.value);error.textContent='已复制'}catch{error.textContent='无法访问剪贴板，请选择上方文本复制'}};download.onclick=()=>{const url=URL.createObjectURL(new Blob([preview.value],{type:'text/markdown;charset=utf-8'})),a=element('a');a.href=url;a.download=(chosen.length===1?chosen[0].title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,60):'对话记录')+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  }
  layout();return{refresh,render,show,hide,setBusy(value){blocked=!!value;for(const b of rows.querySelectorAll('.qh-title')){b.disabled=blocked;b.title=blocked?'请等待回答完成或先停止':b.textContent}},get loading(){return loading},dispose(){disposed=true;version++;clearTimeout(timer);mobile.removeEventListener('change',layout);hide();for(const d of dialogs){d.close();d.remove()}dialogs.clear();if(toggle)toggle.onclick=null;panel.remove();menu.remove()}}
}
