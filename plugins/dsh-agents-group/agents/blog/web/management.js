import {icon} from './icons.js'

const labels={category:'分类',tag:'标签',comment:'评论',create:'新建',update:'修改',delete:'删除',name:'名称',slug:'链接别名',description:'描述',parent:'上级 ID（0 表示无）',isDefault:'设为默认分类',author:'作者',text:'内容',mail:'邮箱',url:'网站',status:'状态',cid:'文章 ID',approved:'已批准（公开）',waiting:'待审核',spam:'垃圾评论'}
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n}
export function managementSummary(preview){
  const m=preview.management??{},rows=[`${labels[m.operation]}${labels[m.kind]}${m.id?' · ID '+m.id:''}`]
  for(const [key,value] of Object.entries(m.fields??{}))rows.push(`${labels[key]??key}：${key==='status'?labels[value]:typeof value==='boolean'?(value?'是':'否'):value}`)
  if(preview.impact?.relatedCount!==undefined)rows.push(`${m.kind==='comment'?'关联回复':'关联文章版本'}：${preview.impact.relatedCount}`)
  if(preview.impact?.childCategories)rows.push(`子分类：${preview.impact.childCategories}`)
  if(preview.impact?.note)rows.push(preview.impact.note)
  return rows.join('\n')
}

// Read every page before deriving hierarchy or usage counts; a parent may be on another page.
export async function readTaxonomy(api,kind,isCurrent=()=>true){
  const items=[]
  for(let page=1;page<=10000;page++){
    const result=await api('manage-list',{kind,page,query:''})
    if(!isCurrent())return null
    items.push(...result.items)
    if(!result.hasMore)return items
  }
  throw new Error('分类或标签数量超出读取范围，请缩小站点数据规模后重试。')
}
export function categoryPath(items,id){
  const byId=new Map(items.map(item=>[item.id,item])),path=[],seen=new Set()
  for(let item=byId.get(id);item&&!seen.has(item.id);item=byId.get(item.parent)){
    seen.add(item.id);path.unshift(item)
  }
  return path
}
export function parentChoices(items,id){
  return items.filter(item=>!categoryPath(items,item.id).some(parent=>parent.id===id))
}

export function initManagement({api,flush,getDraft,refresh}){
  const dialog=node('dialog',undefined,'blog-management');dialog.setAttribute('aria-label','分类、标签和评论管理')
  const head=node('div',undefined,'dialog-head'),heading=node('div'),title=node('h2','管理分类'),subtitle=node('p',undefined,'management-subtitle')
  const close=node('button','关闭');close.prepend(icon('close'));heading.append(title,subtitle);head.append(heading,close)
  const error=node('p',undefined,'management-error');error.setAttribute('role','alert');error.tabIndex=-1;error.hidden=true
  const navigation=node('nav',undefined,'management-tabs');navigation.setAttribute('aria-label','博客管理')
  const filters=node('div',undefined,'management-toolbar'),query=node('input'),status=node('select'),cid=node('input'),search=node('button','查询'),create=node('button','新增分类','management-primary'),sort=node('select')
  query.type='search';query.setAttribute('aria-label','管理搜索');cid.type='number';cid.min='1';cid.placeholder='文章 ID（空为全站）';cid.setAttribute('aria-label','筛选文章 ID');status.setAttribute('aria-label','评论状态');sort.setAttribute('aria-label','排序方式')
  for(const key of ['all','approved','waiting','spam']){const o=node('option',labels[key]??'全部状态');o.value=key;status.append(o)}
  for(const [value,label] of [['original','默认顺序'],['name','名称排序'],['count','文章数最多']]){const o=node('option',label);o.value=value;sort.append(o)}
  search.prepend(icon('search'));create.prepend(icon('new-chat'));filters.append(query,cid,status,search,sort,create)
  const context=node('div',undefined,'management-context'),body=node('div',undefined,'management-body'),list=node('div',undefined,'management-list'),editor=node('aside',undefined,'management-editor')
  editor.setAttribute('aria-label','分类与标签编辑');body.append(list,editor)
  const pager=node('div',undefined,'management-pager'),previous=node('button','上一页'),next=node('button','下一页'),pageText=node('span');pager.append(previous,pageText,next)
  const live=node('p',undefined,'management-footnote');live.setAttribute('role','status')
  dialog.append(head,navigation,error,filters,context,body,pager,live);document.body.append(dialog)
  let kind='category',page=1,epoch=0,editEpoch=0,busy=false,loading=false,ready=false,items=[],parent=0,selectedId=null,dirty=false,editorPending=false
  const run=fn=>async()=>{error.hidden=true;try{await fn()}catch(e){error.textContent=e.message;error.hidden=false;error.focus()}}
  const canLeave=()=>!dirty||window.confirm('当前修改尚未预览，确定放弃这些修改吗？')
  function resetEditor(){editEpoch++;selectedId=null;dirty=false;editorPending=false;editor.replaceChildren(node('p','选中左侧记录进行编辑，或新建'+labels[kind]+'。','management-empty'));markSelection();if(dialog.open&&window.matchMedia('(max-width: 800px)').matches)list.scrollIntoView({block:'start'})}
  function markSelection(){for(const el of list.querySelectorAll('[data-record]'))el.setAttribute('aria-pressed',String(Number(el.dataset.record)===selectedId))}
  function button(text,handler,className){const b=node('button',text,className);b.type='button';b.onclick=run(handler);return b}
  close.onclick=()=>{if(canLeave())dialog.close()}
  dialog.addEventListener('cancel',e=>{if(!canLeave())e.preventDefault()})
  dialog.addEventListener('close',()=>{epoch++;editEpoch++;dirty=false})
  for(const key of ['category','tag','comment']){
    const b=button('管理'+labels[key],async()=>{if(kind===key||!canLeave())return;kind=key;page=1;parent=0;query.value='';cid.value='';resetEditor();await load()});b.dataset.kind=key;navigation.append(b)
  }
  function chrome(){
    title.textContent='管理'+labels[kind]
    subtitle.textContent={category:'按层级整理内容，让每一篇文章各有所属。',tag:'用标签串联主题，快速找到并整理你的内容。',comment:'查看读者反馈，管理评论与回复。'}[kind]
    cid.hidden=status.hidden=kind!=='comment';sort.hidden=kind==='comment';editor.hidden=kind==='comment';pager.hidden=kind!=='comment';body.classList.toggle('comments',kind==='comment')
    query.placeholder=kind==='comment'?'搜索作者或评论内容':'搜索全部'+labels[kind]+'名称或别名'
    create.textContent=kind==='category'&&parent?'新增子分类':'新增'+labels[kind];create.prepend(icon('new-chat'))
    for(const b of navigation.children)b.setAttribute('aria-pressed',String(b.dataset.kind===kind))
  }
  async function load(){
    const current=++epoch,selectedKind=kind;loading=true;ready=false;items=[];chrome();list.replaceChildren(node('p','正在加载'+labels[kind]+'…','management-empty'));list.setAttribute('aria-busy','true');context.replaceChildren();create.disabled=true
    try{
      if(kind==='comment'){
        const result=await api('manage-list',{kind,page,query:query.value,status:status.value,...(cid.value?{cid:Number(cid.value)}:{})})
        if(current!==epoch)return
        renderComments(result)
      }else{
        const result=await readTaxonomy(api,selectedKind,()=>current===epoch)
        if(result===null)return
        items=result;ready=true
        if(parent&&!items.some(item=>item.id===parent))parent=0
        renderTaxonomy()
      }
    }catch(e){if(current!==epoch)return;list.replaceChildren(node('p','加载失败，请重试。','management-empty'),button('重新加载',load));throw e}
    finally{if(current===epoch){loading=false;list.setAttribute('aria-busy','false');create.disabled=kind!=='comment'&&!ready}}
  }
  function renderTaxonomy(){
    chrome();context.replaceChildren();list.replaceChildren()
    const q=query.value.trim().toLocaleLowerCase(),byId=new Map(items.map(item=>[item.id,item])),children=new Map()
    for(const item of items)children.set(item.parent,(children.get(item.parent)??0)+1)
    let visible=items.filter(item=>q?[item.name,item.slug].some(value=>String(value??'').toLocaleLowerCase().includes(q)):kind==='tag'||item.parent===parent||(!parent&&item.parent&&!byId.has(item.parent)))
    if(sort.value==='name')visible.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))
    if(sort.value==='count')visible.sort((a,b)=>(b.count??0)-(a.count??0))
    if(kind==='category'){
      const crumbs=node('nav',undefined,'management-breadcrumbs');crumbs.setAttribute('aria-label','分类层级')
      crumbs.append(button('全部分类',()=>enterCategory(0)))
      for(const item of categoryPath(items,parent)){const separator=icon('chevron-down');separator.classList.add('breadcrumb-separator');crumbs.append(separator,button(item.name,()=>enterCategory(item.id)))}
      crumbs.lastElementChild.setAttribute('aria-current','page');context.append(crumbs)
      if(parent)context.append(button('编辑当前分类',()=>editTaxonomy(parent),'management-link'))
      const table=node('table',undefined,'management-table'),thead=node('thead'),hr=node('tr'),tbody=node('tbody')
      for(const label of ['分类名称','子分类','链接别名','文章数','操作']){const th=node('th',label);th.scope='col';hr.append(th)}thead.append(hr);table.append(thead,tbody)
      for(const item of visible){
        const row=node('tr'),name=node('td'),child=node('td'),slug=node('td',item.slug||'—','management-slug'),count=node('td'),actions=node('td')
        const open=button(item.name,()=>enterCategory(item.id),'management-category-name');open.prepend(icon('article'));name.append(open)
        if(q)name.append(node('small',categoryPath(items,item.parent).map(p=>p.name).join(' / ')||'顶级分类','management-path'))
        else if(item.description)name.append(node('small',item.description,'management-path'))
        child.append(button(children.get(item.id)?`${children.get(item.id)} 个子分类`:'新增子分类',()=>children.get(item.id)?enterCategory(item.id):editTaxonomy(null,{parent:item.id}),'management-link'))
        count.append(node('span',String(item.count??0),'management-count'))
        const edit=button('编辑',()=>editTaxonomy(item.id),'management-link');edit.dataset.record=item.id;edit.setAttribute('aria-label','编辑分类：'+item.name)
        actions.append(edit);row.append(name,child,slug,count,actions);tbody.append(row)
      }
      if(visible.length)list.append(table)
    }else{
      context.append(node('p',q?`找到 ${visible.length} 个标签`:`全部标签 · ${items.length}`),node('span','点击标签，在右侧编辑','management-hint'))
      const cloud=node('div',undefined,'management-tag-cloud');cloud.setAttribute('aria-label','标签云')
      const max=items.reduce((max,item)=>Math.max(max,item.count??0),1)
      for(const item of visible){
        const tag=button(undefined,()=>editTaxonomy(item.id),'management-tag');tag.dataset.record=item.id;tag.setAttribute('aria-label',`${item.name}，${item.count??0} 篇文章`);tag.title=`${item.slug} · ${item.count??0} 篇文章`
        tag.style.setProperty('--tag-size',`${14+Math.round(5*Math.sqrt((item.count??0)/max))}px`);tag.append(node('span',item.name),node('small',String(item.count??0)));cloud.append(tag)
      }
      if(visible.length)list.append(cloud)
    }
    if(!visible.length)list.append(node('div',q?'没有匹配的'+labels[kind]+'，试试其他关键词。':parent?'这个分类还没有子分类。':'还没有'+labels[kind]+'。','management-empty'),button(q?'清除搜索':'新增'+(parent?'子分类':labels[kind]),()=>{if(q){query.value='';renderTaxonomy()}else return editTaxonomy(null,{parent})}))
    live.textContent=kind==='category'?`${q?'搜索结果':parent?'本级':'顶级'} ${visible.length} 个分类 · 全站 ${items.length} 个分类`:`共 ${items.length} 个标签 · 字号按文章数呈现`
    markSelection()
  }
  function enterCategory(id){if(!canLeave())return;parent=id;query.value='';resetEditor();renderTaxonomy();context.querySelector('[aria-current=page]')?.focus({preventScroll:true})}
  function renderComments(result){
    list.replaceChildren();previous.disabled=page===1;next.disabled=!result.hasMore;pageText.textContent=`第 ${page} 页`;live.textContent='评论变更在确认后生效。'
    if(!result.items.length)list.append(node('p','没有匹配的记录','management-empty'))
    for(const item of result.items){const row=node('section',undefined,'management-row');row.append(node('h3',`${item.author} · ID ${item.id}`),node('p',`文章 ${item.cid} · ${labels[item.status]??item.status} · ${item.text}`),button('编辑',()=>editItem(item.id)),button('删除',()=>prepare({operation:'delete',id:item.id})),button('回复',()=>editItem(null,{cid:item.cid,parent:item.id})));list.append(row)}
  }
  search.onclick=run(async()=>{if(loading)return;if(kind!=='comment'&&!ready)return load();if(kind==='comment'){page=1;await load()}else renderTaxonomy()})
  query.oninput=()=>{if(!loading&&ready&&kind!=='comment')renderTaxonomy()};query.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();search.click()}}
  sort.onchange=()=>{if(!loading&&ready)renderTaxonomy()};previous.onclick=run(async()=>{page--;await load()});next.onclick=run(async()=>{page++;await load()})
  create.onclick=run(()=>kind==='comment'?editItem():editTaxonomy(null,{parent}))

  async function editTaxonomy(id,initial={}){
    if(editorPending||!canLeave())return
    const current=++editEpoch,selectedKind=kind;dirty=false;selectedId=id;markSelection();editor.replaceChildren(node('p','正在读取…','management-empty'))
    let record
    try{record=id?await api('manage-get',{kind:selectedKind,id}):null}catch(e){if(current!==editEpoch)return;editor.replaceChildren(node('p','读取失败，请重新选择记录。','management-empty'));throw e}
    if(current!==editEpoch)return
    const item=record?.item??initial,form=node('form'),eyebrow=node('p',id?`${labels[selectedKind]}详情 · ID ${id}`:'创建新'+labels[selectedKind],'management-eyebrow'),formTitle=node('h3',id?'编辑'+labels[selectedKind]:'新增'+labels[selectedKind])
    editor.replaceChildren(eyebrow,formTitle,form);const fields={}
    if(id)form.append(node('p',`${item.count??0} 篇文章${record.impact?.defaultCategory?' · 默认分类':''}`,'management-hint'))
    for(const key of ['name','slug',...(selectedKind==='category'?['parent']:[]),'description',...(selectedKind==='category'?['isDefault']:[])]){
      const label=node('label',key==='parent'?'父分类':labels[key]+(key==='name'?' *':'')),input=node(key==='parent'?'select':key==='description'?'textarea':'input');fields[key]=input
      if(key==='parent'){
        const root=node('option','无（顶级分类）');root.value='0';input.append(root)
        for(const choice of parentChoices(items,id)){const o=node('option',categoryPath(items,choice.id).map(p=>p.name).join(' / '));o.value=choice.id;input.append(o)}
      }
      if(key==='isDefault'){input.type='checkbox';input.checked=!!record?.impact?.defaultCategory;input.disabled=input.checked;label.className='management-checkbox'}
      else {input.value=item[key]??(key==='parent'?0:'');input.required=key==='name';if(key!=='parent')input.maxLength={name:80,slug:200,description:1000}[key]}
      if(key==='description')input.rows=3
      input.oninput=()=>{dirty=true};label.append(input)
      if(key==='description'){const details=node('details',undefined,'management-description');details.open=!!item.description;details.append(node('summary','补充描述'),label);form.append(details)}else form.append(label)
      if(key==='slug')form.append(node('small','用于文章链接；留空时根据名称生成。','management-field-help'))
    }
    const formError=node('p',undefined,'management-error');formError.setAttribute('role','alert');formError.hidden=true
    const actions=node('div',undefined,'management-editor-actions'),submit=node('button','预览'+(id?'修改':'新增'),'management-primary'),cancel=button('取消',()=>{if(canLeave())resetEditor()});submit.type='submit';actions.append(submit,cancel);form.append(formError,actions)
    if(id){const remove=button('删除'+labels[selectedKind],()=>prepare({kind:selectedKind,operation:'delete',id,version:record.version}),'management-danger');if(record.impact?.defaultCategory){remove.disabled=true;remove.title='请先将其他分类设为默认分类'}form.append(remove)}
    form.onsubmit=async e=>{
      e.preventDefault();editorPending=true;submit.disabled=true;formError.hidden=true
      try{
        const values=Object.fromEntries(Object.entries(fields).filter(([key,input])=>key!=='isDefault'||input.checked&&!input.disabled).map(([key,input])=>[key,key==='parent'?Number(input.value):key==='isDefault'?input.checked:input.value]))
        await prepare({kind:selectedKind,operation:id?'update':'create',...(id?{id,version:record.version}:{}),fields:values})
      }catch(e){formError.textContent=e.message;formError.hidden=false}finally{editorPending=false;submit.disabled=false}
    }
    fields.name.focus({preventScroll:true});if(window.matchMedia('(max-width: 800px)').matches)editor.scrollIntoView({block:'start'})
  }
  async function editItem(id,initial={}){
    const selectedKind=kind,record=id?await api('manage-get',{kind,id}):null;let item=record?.item??initial
    const formDialog=node('dialog');formDialog.setAttribute('aria-label',(id?'编辑':'新建')+labels[kind]);const form=node('form'),fields={};form.append(node('h2',(id?'编辑':'新建')+labels[kind]))
    const keys=kind==='comment'?['author','text','mail','url','status',...(!id?['cid','parent']:[])]:['name','slug','description',...(kind==='category'?['parent','isDefault']:[])]
    for(const key of keys){const label=node('label',labels[key]);const input=node(key==='status'?'select':['text','description'].includes(key)?'textarea':'input');if(key==='status'){for(const state of ['waiting','approved','spam']){const o=node('option',labels[state]);o.value=state;input.append(o)}}else if(key==='isDefault')input.type='checkbox';else if(['parent','cid'].includes(key)){input.type='number';input.min=key==='cid'?'1':'0'}
      if(key!=='isDefault')input.value=item[key]??(key==='status'?'waiting':key==='parent'?0:key==='cid'?cid.value:'');if(['name','author','text','cid'].includes(key))input.required=true;fields[key]=input;label.append(input);form.append(label)}
    const formError=node('p');formError.setAttribute('role','alert');const submit=node('button','预览修改'),cancel=node('button','取消');submit.type='submit';cancel.type='button';cancel.onclick=()=>formDialog.close();form.append(formError,submit,cancel);formDialog.append(form);document.body.append(formDialog);formDialog.addEventListener('close',()=>formDialog.remove(),{once:true})
    form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{const values=Object.fromEntries(Object.entries(fields).filter(([k,n])=>k!=='isDefault'||n.checked).map(([k,n])=>[k,n.type==='checkbox'?n.checked:n.type==='number'?Number(n.value):n.value]));await prepare({kind:selectedKind,operation:id?'update':'create',...(id?{id,version:record.version}:{}),fields:values});formDialog.close()}catch(e){formError.textContent=e.message}finally{submit.disabled=false}};formDialog.showModal()
  }
  async function prepare(args){
    if(busy)return;busy=true;dialog.inert=true
    try{
      const op=await api('manage-prepare',{kind,...args});const preview=node('dialog');preview.className='management-confirm';preview.setAttribute('aria-label','确认博客管理操作');const text=node('pre',managementSummary(op)),message=node('p'),confirm=node('button','确认执行'),reconcile=node('button','核对执行结果'),cancel=node('button','关闭');text.style.whiteSpace='pre-wrap';message.setAttribute('role','status');reconcile.hidden=true;cancel.onclick=()=>preview.close();preview.append(node('h2','确认'+op.title),text,message,confirm,reconcile,cancel);document.body.append(preview);preview.addEventListener('close',()=>preview.remove(),{once:true})
      const execute=async checking=>{confirm.disabled=true;reconcile.disabled=true;try{const result=await api(checking?'reconcile':'confirm',checking?{id:op.id}:{id:op.id,nonce:op.nonce});if(result.status==='succeeded'){message.textContent='已完成。若正在编辑受影响文章，请重新打开文章以读取最新设置。';confirm.hidden=reconcile.hidden=true;resetEditor();await load();await refresh()}else{message.textContent='暂未取得成功回执，请稍后核对，勿重复创建。';reconcile.hidden=false}}catch(e){message.textContent=e.message;confirm.hidden=true;reconcile.hidden=false}finally{reconcile.disabled=false}};confirm.onclick=()=>execute(false);reconcile.onclick=()=>execute(true);preview.showModal()
    }finally{busy=false;dialog.inert=false}
  }
  return async(selected='category',articleOnly=false)=>{await flush();kind=selected;page=1;query.value='';status.value='all';const d=getDraft();cid.value=articleOnly?(d?.remote?.published?.cid??d?.remote?.savedDraft?.cid??''):'';parent=0;resetEditor();if(!dialog.open)dialog.showModal();await run(load)()}
}
