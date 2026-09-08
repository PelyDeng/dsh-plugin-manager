const labels={category:'分类',tag:'标签',comment:'评论',create:'新建',update:'修改',delete:'删除',name:'名称',slug:'链接别名',description:'描述',parent:'上级 ID（0 表示无）',isDefault:'设为默认分类',author:'作者',text:'内容',mail:'邮箱',url:'网站',status:'状态',cid:'文章 ID',approved:'已批准（公开）',waiting:'待审核',spam:'垃圾评论'}
const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
export function managementSummary(preview){
  const m=preview.management??{},rows=[`${labels[m.operation]}${labels[m.kind]}${m.id?' · ID '+m.id:''}`]
  for(const [key,value] of Object.entries(m.fields??{}))rows.push(`${labels[key]??key}：${key==='status'?labels[value]:typeof value==='boolean'?(value?'是':'否'):value}`)
  if(preview.impact?.relatedCount!==undefined)rows.push(`${m.kind==='comment'?'关联回复':'关联文章版本'}：${preview.impact.relatedCount}`)
  if(preview.impact?.childCategories)rows.push(`子分类：${preview.impact.childCategories}`)
  if(preview.impact?.note)rows.push(preview.impact.note)
  return rows.join('\n')
}
export function initManagement({api,flush,getDraft,refresh}){
  const dialog=node('dialog');dialog.className='blog-management';dialog.setAttribute('aria-label','分类、标签和评论管理')
  const head=node('div');head.className='dialog-head';const title=node('h2','博客管理'),close=node('button','关闭');head.append(title,close)
  const error=node('p');error.setAttribute('role','alert');error.tabIndex=-1;error.hidden=true
  const navigation=node('div'),filters=node('div'),query=node('input'),status=node('select'),cid=node('input'),search=node('button','查询'),create=node('button','新建'),list=node('div'),pager=node('div'),previous=node('button','上一页'),next=node('button','下一页'),pageText=node('span')
  query.placeholder='搜索名称或评论内容';query.setAttribute('aria-label','管理搜索');cid.type='number';cid.min='1';cid.placeholder='文章 ID（空为全站）';cid.setAttribute('aria-label','筛选文章 ID');status.setAttribute('aria-label','评论状态')
  for(const key of ['all','approved','waiting','spam']){const o=node('option',labels[key]??'全部状态');o.value=key;status.append(o)}
  filters.append(query,cid,status,search,create);pager.append(previous,pageText,next);dialog.append(head,error,navigation,filters,list,pager);document.body.append(dialog)
  let kind='category',page=1,epoch=0,busy=false
  const run=fn=>async()=>{error.hidden=true;try{await fn()}catch(e){error.textContent=e.message;error.hidden=false;error.focus()}}
  close.onclick=()=>dialog.close()
  for(const key of ['category','tag','comment']){const button=node('button','管理'+labels[key]);navigation.append(button);button.onclick=run(async()=>{kind=key;page=1;cid.value='';await load()})}
  async function load(){
    const current=++epoch;title.textContent='管理'+labels[kind];cid.hidden=status.hidden=kind!=='comment'
    const result=await api('manage-list',{kind,page,query:query.value,...(kind==='comment'?{status:status.value,...(cid.value?{cid:Number(cid.value)}:{})}:{})})
    if(current!==epoch)return
    list.replaceChildren();previous.disabled=page===1;next.disabled=!result.hasMore;pageText.textContent=`第 ${page} 页`
    if(!result.items.length)list.append(node('p','没有匹配的记录'))
    for(const item of result.items){const row=node('section');row.className='management-row';row.append(node('h3',`${item.name??item.author} · ID ${item.id}`),node('p',kind==='comment'?`文章 ${item.cid} · ${labels[item.status]??item.status} · ${item.text}`:`${item.slug} · ${item.description??''} · 上级 ${item.parent}`));const edit=node('button','编辑'),remove=node('button','删除');row.append(edit,remove);edit.onclick=run(()=>editItem(item.id));remove.onclick=run(()=>prepare({operation:'delete',id:item.id}));if(kind==='comment'){const reply=node('button','回复');row.append(reply);reply.onclick=run(()=>editItem(null,{cid:item.cid,parent:item.id}))}list.append(row)}
  }
  search.onclick=run(async()=>{page=1;await load()});query.onkeydown=e=>{if(e.key==='Enter')search.click()};previous.onclick=run(async()=>{page--;await load()});next.onclick=run(async()=>{page++;await load()});create.onclick=run(()=>editItem())
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
    if(busy)return;busy=true
    try{
      const op=await api('manage-prepare',{kind,...args});const preview=node('dialog');preview.setAttribute('aria-label','确认博客管理操作');const text=node('pre',managementSummary(op)),message=node('p'),confirm=node('button','确认执行'),reconcile=node('button','核对执行结果'),cancel=node('button','关闭');text.style.whiteSpace='pre-wrap';message.setAttribute('role','status');reconcile.hidden=true;cancel.onclick=()=>preview.close();preview.append(node('h2','确认'+op.title),text,message,confirm,reconcile,cancel);document.body.append(preview);preview.addEventListener('close',()=>preview.remove(),{once:true})
      const execute=async checking=>{confirm.disabled=true;reconcile.disabled=true;try{const result=await api(checking?'reconcile':'confirm',checking?{id:op.id}:{id:op.id,nonce:op.nonce});if(result.status==='succeeded'){message.textContent='已完成。若正在编辑受影响文章，请重新打开文章以读取最新设置。';confirm.hidden=reconcile.hidden=true;await refresh();await load()}else{message.textContent='暂未取得成功回执，请稍后核对，勿重复创建。';reconcile.hidden=false}}catch(e){message.textContent=e.message;confirm.hidden=true;reconcile.hidden=false}finally{reconcile.disabled=false}};confirm.onclick=()=>execute(false);reconcile.onclick=()=>execute(true);preview.showModal()
    }finally{busy=false}
  }
  return async(selected='category',articleOnly=false)=>{await flush();kind=selected;page=1;query.value='';status.value='all';const d=getDraft();cid.value=articleOnly?(d?.remote?.published?.cid??d?.remote?.savedDraft?.cid??''):'';dialog.showModal();await run(load)()}
}
