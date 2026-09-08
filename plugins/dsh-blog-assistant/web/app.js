import DOMPurify from 'dompurify'
import { renderMarkdown } from './markdown.js'
import { initChat } from './chat.js'
import { initLayout } from './layout.js'

const $=id=>document.getElementById(id), base=document.body.dataset.base
const S={draft:null,dirty:false,saving:null,tab:'local',page:1,mode:'ai',view:'split',job:null,identity:null,attachments:[],selected:new Set(),prepared:null,metadataReady:false}
let saveTimer,pollTimer,searchTimer,applying,applyBusy=false,listVersion=0,draftVersion=0,sourceMode='task',sourceSignature='',cursor={start:0,end:0}
const instructions=new Map()
const selectAssistantTab=name=>window.dispatchEvent(new CustomEvent('blog:assistant-tab',{detail:name}))
const content=()=>({title:$('title').value,text:$('text').value,slug:$('slug').value,format:S.draft.format,tags:$('tags').value.split(/[,，]/).map(v=>v.trim()).filter(Boolean),categories:S.metadataReady?[...$('categories').selectedOptions].map(v=>Number(v.value)):S.draft.categories})
const safeURL=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null}catch{return null}}
function notice(error,target='notice'){if(target==='notice')target=$('metadata-dialog').open?'metadata-error':$('operations-dialog').open?'operations-error':$('assistant-dialog').open?'assistant-error':$('navigation-dialog').open?'navigation-error':target;const el=$(target);el.textContent=error?.message??String(error);el.hidden=false;el.focus()}
function clearNotice(){for(const id of ['notice','assistant-error','navigation-error','metadata-error','operations-error'])$(id).hidden=true}
async function request(path,options={}){const r=await fetch(base+path,{credentials:'same-origin',...options});let data;try{data=await r.json()}catch{throw new Error('服务返回异常，请检查登录状态')}if(!r.ok)throw new Error(data.error??data.message??`请求失败（${r.status}）`);return data}
const api=(action,args={})=>request('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args})})
const action=(fn,target='notice')=>async e=>{try{clearNotice();await fn(e)}catch(err){notice(err,target)}}
function render(){if(!S.draft)return;$('assistant-context').textContent=$('title').value||'未命名草稿';$('assistant-context').title=$('title').value||'未命名草稿';$('word-count').textContent=`${$('text').value.length.toLocaleString()} 字符`;$('preview').innerHTML=S.draft.format==='html'?DOMPurify.sanitize($('text').value,{USE_PROFILES:{html:true}}):renderMarkdown($('text').value)}
function changed(){if(!S.draft)return;S.dirty=true;$('save-state').textContent='有未保存修改';render();clearTimeout(saveTimer);saveTimer=setTimeout(()=>flush().catch(notice),900)}
async function flush(){
  if(applying)await applying
  clearTimeout(saveTimer)
  if(S.saving)return S.saving
  S.saving=(async()=>{while(S.dirty&&S.draft){const id=S.draft.id,payload=content();$('save-state').textContent='保存中…';const result=await api('save',{id,revision:S.draft.revision,content:payload});if(S.draft?.id!==id)return;S.draft=result;S.dirty=JSON.stringify(payload)!==JSON.stringify(content());$('save-state').textContent=S.dirty?'还有修改待保存':'已保存';showProposal()}})()
  try{await S.saving;await loadList()}catch(err){$('save-state').textContent='保存失败 · 内容仍在编辑器';throw err}finally{S.saving=null}
}
function fill(draft){if(S.draft)instructions.set(S.draft.id,$('instruction').value);$('instruction').value=instructions.get(draft.id)??'';S.draft=draft;S.dirty=false;$('empty').hidden=true;$('editor').hidden=false;for(const key of ['title','text','slug'])$(key).value=draft[key];$('tags').value=draft.tags.join('，');for(const option of $('categories').options)option.selected=draft.categories.includes(Number(option.value));$('operations').replaceChildren();$('format-label').textContent=draft.format==='html'?'HTML 原文 · 原格式保留':'Markdown 原文';$('save-state').textContent='已保存';$('answer').innerHTML='';delete $('answer').dataset.text;$('task-state').textContent='';S.job=null;$('ask').disabled=false;$('cancel-task').hidden=true;$('answer-empty').hidden=false;$('copy-answer').hidden=true;$('assistant-context').textContent=draft.title||'未命名草稿';$('assistant-context').title=draft.title||'未命名草稿';sourceMode='task';showSources([]);clearTimeout(pollTimer);render();showProposal();sessionStorage.setItem(`blog-draft:${S.identity.userId}`,draft.id);$('library').classList.remove('open');window.dispatchEvent(new Event('blog:draft'))}
async function openDraft(id){const version=++draftVersion;await flush();const draft=await api('draft',{id});if(version!==draftVersion)return;fill(draft);await Promise.all([loadAttachments(),loadTasks(),loadOperations()]);await loadList()}
async function createDraft(){const version=++draftVersion;await flush();const draft=await api('create');if(version!==draftVersion)return;S.tab='local';tabs();fill(draft);S.attachments=[];S.selected.clear();showAttachments();await loadList()}
async function loadList(){const version=++listVersion,tab=S.tab,page=S.page,list=$('article-list');list.setAttribute('aria-busy','true');for(const b of list.querySelectorAll('button'))b.disabled=true;$('more-articles').hidden=true;const query=$('search').value.trim();let items,hasMore=false
  try{if(tab==='local')items=await api('drafts',{query})
  else{const result=await api('articles',{query,page});items=result.items;hasMore=result.hasMore}}catch(err){if(version!==listVersion)return;list.replaceChildren();const note=document.createElement('p');note.className='muted';note.textContent='文章列表读取失败，请重试。';const retry=document.createElement('button');retry.textContent='重新加载';retry.addEventListener('click',action(loadList));list.append(note,retry);throw err}finally{if(version===listVersion)list.removeAttribute('aria-busy')}
  if(version!==listVersion)return;list.replaceChildren();$('more-articles').hidden=!hasMore
  for(const d of items){const button=document.createElement('button');button.className=`article-row ${S.draft?.id===d.id?'active':''}`;const title=document.createElement('span');title.textContent=d.title||'未命名草稿';const small=document.createElement('small');small.textContent=tab==='local'?new Date(d.updatedAt).toLocaleString('zh-CN'):`${d.hasPublished?'已发布':'草稿'}${d.hasSavedDraft?' · 有保存稿':''}`;button.append(title,small);button.addEventListener('click',action(async()=>{if(tab==='local')await openDraft(d.id);else{await flush();const imported=await api('import',{cid:d.cid,variant:d.hasSavedDraft&&!d.hasPublished?'savedDraft':'published'});S.tab='local';tabs();fill(imported);await Promise.all([loadAttachments(),loadOperations(),loadList()])}}));list.append(button)
    if(tab==='remote'&&d.hasPublished&&d.hasSavedDraft){const saved=document.createElement('button');saved.textContent='导入该文的保存稿';saved.className='article-row';saved.addEventListener('click',action(async()=>{await flush();const imported=await api('import',{cid:d.cid,variant:'savedDraft'});S.tab='local';tabs();fill(imported);await Promise.all([loadList(),loadAttachments(),loadOperations()])}));list.append(saved)}}
  if(!items.length){const p=document.createElement('p');p.className='muted';p.textContent='还没有匹配的文章';list.append(p)}
}
function tabs(){for(const t of ['local','remote'])$(`${t}-tab`).setAttribute('aria-pressed',String(S.tab===t))}
function mode(value){S.mode=value;document.querySelector('.workspace').classList.toggle('manual',value==='manual');$('mode-ai').setAttribute('aria-pressed',String(value==='ai'));$('mode-manual').setAttribute('aria-pressed',String(value==='manual'))}
function insert(text){if(!S.draft)throw new Error('请先新建或选择草稿');const area=$('text');area.focus();area.setSelectionRange(cursor.start,cursor.end);area.setRangeText(text,cursor.start,cursor.end,'end');cursor={start:area.selectionStart,end:area.selectionEnd};changed()}
function showSources(sources=[]){const signature=JSON.stringify(sources);if(signature===sourceSignature)return;sourceSignature=signature;$('source-count').textContent=String(sources.length);$('source-summary').textContent=sources.length?`${sources.length} 条来源 · ${sources.filter(s=>s.fetched).length} 条已读原文，${sources.filter(s=>!s.fetched).length} 条仅搜索摘要`:'尚无本次查证来源；启用联网后，真实链接将在这里显示。';const box=$('sources');box.replaceChildren();for(const s of sources){const item=document.createElement('div');item.className='source';const url=safeURL(s.url);const title=document.createElement(url?'a':'span');title.textContent=s.title||s.url;if(url){title.href=url;title.target='_blank';title.rel='noopener noreferrer'}const meta=document.createElement('small');meta.textContent=`${s.fetched?'已抓取原文':'仅搜索摘要'} · ${s.retrievedAt?new Date(s.retrievedAt).toLocaleString('zh-CN'):''}${s.publishedAt?' · 发布于 '+s.publishedAt:''}`;item.append(title,meta);box.append(item)}if(!sources.length){const p=document.createElement('p');p.className='muted';p.textContent='尚无查证来源';box.append(p)}}
function renderSources(){const proposal=S.draft?.proposal;$('source-scope').querySelector('[value=proposal]').disabled=!proposal;$('source-scope').querySelector('[value=task]').disabled=!S.job;if(!S.job&&proposal)sourceMode='proposal';if(!proposal&&sourceMode==='proposal')sourceMode='task';$('source-scope').value=sourceMode;showSources(sourceMode==='proposal'?proposal?.sources??[]:S.job?.sources??[]);$('source-heading').textContent=sourceMode==='proposal'?'当前候选的来源':'最近任务的来源'}
function showProposal(){const p=S.draft?.proposal;$('proposal').hidden=!p;$('proposal-empty').hidden=!!p;$('proposal-count').textContent=p?'1':'0';renderSources();if(!p)return;$('proposal-context').textContent=`生成于 ${new Date(p.createdAt).toLocaleString('zh-CN')}${S.job&&S.job.proposalId!==p.id?' · 保留的上一份候选，本次任务尚未替换':''}`;$('proposal-sources').textContent=`查看此稿来源（${p.sources.length}）`;const box=$('proposal-text');box.replaceChildren();const title=document.createElement('h2');title.textContent=p.fields.title;const body=document.createElement('div');body.innerHTML=S.draft.format==='html'?DOMPurify.sanitize(p.fields.text,{USE_PROFILES:{html:true}}):renderMarkdown(p.fields.text);const tags=document.createElement('p');tags.textContent='标签：'+p.fields.tags.join('、');box.append(title,body,tags);const conflict=p.baseRevision!==S.draft.revision;$('proposal-conflict').hidden=!conflict;$('apply-proposal').disabled=conflict||applyBusy;renderSources()}
async function loadTasks(){if(!S.draft)return;const draftId=S.draft.id,jobs=await api('tasks',{draftId});if(S.draft?.id!==draftId)return;if(jobs.length){S.job=jobs[0];sourceMode='task';showProposal();if(!instructions.has(draftId)&&!$('instruction').value)$('instruction').value=S.job.input.instruction;showJob();if(['queued','running'].includes(S.job.status))poll()}}
function showJob(){const j=S.job;if(!j)return;const busy=['queued','running'].includes(j.status);$('ask').disabled=busy;$('cancel-task').hidden=!busy;const names={queued:'等待开始',running:'正在整理与写作',succeeded:'本次写作完成',failed:'本次写作未完成',cancelled:'已停止'};$('task-state').textContent=`${names[j.status]??j.status}${j.error?' · '+j.error.message:''}${j.input.research&&!j.sources.some(s=>s.fetched)?' · 未完成原文查证':''}`;const panel=$('assistant-panel-answer'),top=panel.scrollTop,follow=panel.scrollHeight-top-panel.clientHeight<80;if($('answer').dataset.text!==j.text){$('answer').innerHTML=renderMarkdown(j.text||'');$('answer').dataset.text=j.text;}$('answer-empty').hidden=!!j.text||busy;$('copy-answer').hidden=!j.text;panel.scrollTop=follow?panel.scrollHeight:top;renderSources()}
async function poll(){clearTimeout(pollTimer);const id=S.job?.id;if(!id)return;try{const j=await api('task',{id});if(S.job?.id!==id)return;S.job=j;showJob();if(['queued','running'].includes(j.status))pollTimer=setTimeout(poll,900);else if(S.draft){const d=await api('draft',{id:S.draft.id});if(S.draft?.id===d.id){S.draft.proposal=d.proposal;showProposal()}}}catch(err){notice(err);$('ask').disabled=false}}
async function loadOperations(){if(!S.draft)return;const draftId=S.draft.id,rows=await api('operations',{draftId});if(S.draft?.id!==draftId)return;const box=$('operations');box.replaceChildren();if(!rows.length){const p=document.createElement('p');p.className='muted';p.textContent='这篇文章还没有发布或同步记录。';box.append(p)}for(const op of rows){const item=document.createElement('div');const status={prepared:'等待确认',running:'提交中',uncertain:'结果待核对',succeeded:'已确认成功',conflict:'版本冲突'};item.textContent=`${op.mode==='publish'?'发布/更新':'同步草稿'} · ${status[op.status]??op.status}`;if(safeURL(op.url)){const link=document.createElement('a');link.href=safeURL(op.url);link.target='_blank';link.rel='noopener';link.textContent=' 查看文章 ↗';item.append(link)}if(['running','uncertain'].includes(op.status)){const b=document.createElement('button');b.textContent='核对回执';b.addEventListener('click',action(async()=>{const r=await api('reconcile',{id:op.id});if(r.status==='uncertain')notice(r.message);await loadOperations()}));item.append(b)}box.append(item)}}
let publishBusy=false
function publishStatus(text,success=false){$('publish-status').textContent=text;$('publish-status').hidden=!text;$('publish-status').dataset.success=String(success)}
function publishControls(busy){
  publishBusy=busy;$('confirm-publish').disabled=busy||(!$('consume-label').hidden&&!$('consume-draft').checked)
  $('confirm-publish').textContent=busy?'正在发布…':'确认发布'
  for(const el of document.querySelectorAll('[data-close="publish-dialog"],#reconcile-publish,#retry-publish'))el.disabled=busy
  $('publish-dialog').setAttribute('aria-busy',String(busy))
}
async function prepare(){
  if(publishBusy)return
  $('publish').disabled=true
  try{
    await flush();if(!S.draft)throw new Error('请先选择草稿')
    const id=S.draft.id,latest=await api('draft',{id})
    if(S.draft?.id!==id)throw new Error('文章已切换，请重新预览')
    if(latest.revision!==S.draft.revision)throw new Error('文章已在其他窗口修改，请重新打开文章后预览')
    S.draft.proposal=latest.proposal;showProposal()
    if(latest.proposal&&latest.proposal.baseRevision!==latest.revision)throw new Error('候选稿与当前文章有冲突，请先合并或删除候选稿，再预览发布')
    const prepared=await api('prepare',{id,revision:latest.revision,mode:'publish',...(latest.proposal?{proposalId:latest.proposal.id}:{})})
    if(S.draft?.id!==id)throw new Error('文章已切换，请重新预览')
    S.prepared={...prepared,draftId:id}
    $('publish-error').hidden=true;publishStatus('');$('publish-link').hidden=true;$('publish-link').removeAttribute('href')
    $('confirm-publish').hidden=false;$('reconcile-publish').hidden=true;$('retry-publish').hidden=true;$('publish-close').textContent='继续编辑'
    $('publish-heading').textContent=prepared.before?'确认更新公开文章':'确认发布文章'
    $('publish-description').textContent=`《${prepared.title}》 · ${prepared.source==='proposal'?'本次发布最新候选稿，确认成功后同步到工作台':'本次发布当前编辑器已保存的内容'}。请核对正文与标签。`
    $('before-text').textContent=prepared.before?`${prepared.before.title}\n\n${prepared.before.text}`:'尚无公开版本'
    $('after-text').textContent=`${prepared.after.title}\n\n${prepared.after.text}\n\n标签：${prepared.after.tags.join('、')}`
    $('consume-label').hidden=!prepared.hasSavedDraft;$('consume-draft').checked=false;publishControls(false);$('publish-dialog').showModal()
  }finally{$('publish').disabled=false}
}
async function published(op,result){
  if(result.status!=='succeeded')throw new Error(result.message??'发布结果待核对，请查询操作回执')
  publishStatus(op.before?'文章更新成功':'发布成功',true);$('publish-status').focus()
  $('publish-heading').textContent='发布结果';$('publish-description').textContent=`《${op.title}》已提交到博客，可点击“查看博客文章”核对。`
  $('confirm-publish').hidden=true;$('reconcile-publish').hidden=true;$('retry-publish').hidden=true;$('consume-label').hidden=true;$('publish-close').textContent='完成'
  const href=safeURL(result.result?.url);$('publish-link').hidden=!href;if(href)$('publish-link').href=href
  try{if(S.draft?.id===op.draftId)await openDraft(op.draftId)}catch(err){notice('发布已成功，但工作台刷新失败：'+err.message,'publish-error')}
}
async function checkPublishFailure(op,err){
  notice(err,'publish-error');publishStatus('')
  // A lost response may still have written the article. Inspect the receipt before offering a new submission.
  let state
  try{state=(await api('operations',{draftId:op.draftId})).find(row=>row.id===op.id)?.status}catch{}
  $('confirm-publish').hidden=true
  $('reconcile-publish').hidden=['prepared','conflict'].includes(state)
  $('retry-publish').hidden=!['prepared','conflict'].includes(state)
  if(!$('reconcile-publish').hidden)publishStatus('发布结果待核对，请点击“核对操作结果”，避免重复发布。')
}
async function loadAttachments(){if(!S.draft)return;const draftId=S.draft.id,attachments=await api('attachments',{draftId});if(S.draft?.id!==draftId)return;S.attachments=attachments;S.selected=new Set(S.attachments.filter(a=>a.selected!==false&&a.status==='ready').map(a=>a.id));showAttachments()}
function showAttachments(){$('attachment-count').textContent=String(S.attachments.length);$('attachment-empty').hidden=!!S.attachments.length;const box=$('attachment-list');box.replaceChildren();for(const a of S.attachments){
  const row=document.createElement('div');row.className='attachment-row';const check=document.createElement('input');check.type='checkbox';check.checked=S.selected.has(a.id);check.disabled=a.status!=='ready'||(a.partial&&!a.range);check.setAttribute('aria-label',`本次阅读 ${a.name}`)
  check.addEventListener('change',action(async()=>{await api('attachment-select',{draftId:S.draft.id,id:a.id,selected:check.checked,range:a.range});await loadAttachments()}))
  const label=document.createElement('span');label.textContent=`${a.name} · ${a.status==='ready'?(a.partial?'部分解析':a.characters?`${a.characters} 字符`:'图片可阅读'):a.message||a.status}${a.range?` · ${a.range.from}–${a.range.to} ${a.unit}`:''}`
  const view=document.createElement('button');view.textContent='查看';view.disabled=a.status!=='ready';view.addEventListener('click',action(()=>viewAttachment(a),'attachment-error'))
  const remove=document.createElement('button');remove.textContent='移除';remove.addEventListener('click',action(async()=>{await api('attachment-remove',{draftId:S.draft.id,id:a.id});await loadAttachments()}));row.append(check,label,view,remove);box.append(row)
}}
async function viewAttachment(a){
  S.attachmentView={draftId:S.draft.id,id:a.id};$('attachment-dialog').showModal();$('attachment-error').hidden=true;$('attachment-image').hidden=true;$('attachment-image').removeAttribute('src');$('attachment-text').textContent='加载中…'
  const data=await api('attachment-content',S.attachmentView);$('attachment-title').textContent=data.name;$('attachment-description').textContent=data.message||`已提取 ${data.parsedUnits}/${data.totalUnits} ${data.unit}，共 ${data.characters} 字符`;$('attachment-text').textContent=data.units.map(u=>`[${data.unit} ${u.number}] ${u.text}`).join('\n');$('attachment-range').hidden=!data.units.length;$('range-from').value=data.range?.from??1;$('range-to').value=data.range?.to??data.parsedUnits
  const url=`${base}/attachment-download?draftId=${encodeURIComponent(S.attachmentView.draftId)}&id=${encodeURIComponent(a.id)}`;$('attachment-download').href=url
  if(data.kind.startsWith('image/')){$('attachment-image').src=url+'&inline=1';$('attachment-image').hidden=false}
}
async function loadBackups(){const d=await api('backup-status');$('backup-enabled').checked=d.schedule.enabled;$('backup-time').value=d.schedule.time;$('backup-daily').value=d.schedule.daily;$('backup-weekly').value=d.schedule.weekly;
  const labels={running:'进行中',succeeded:'已完成',failed:'失败',complete:'完整',writing:'写入中'}
  $('backup-status').textContent=`下次计划：${d.nextRun||'未启用'}\n当前：${labels[d.current?.status]??'空闲'} ${d.current?.message??d.current?.note??''}\n最近：${d.last?.id??d.last?.backupId??'暂无'} · ${labels[d.last?.status]??''}${d.recoveryPending?'\n服务恢复尚未确认，请检查运维状态':''}`
  const box=$('backup-list');box.replaceChildren();for(const b of d.backups??[]){const row=document.createElement('div');row.className='operations';row.textContent=`${b.id} · ${labels[b.status]??b.status} `;const verify=document.createElement('button');verify.textContent='校验';verify.addEventListener('click',action(async()=>{const r=await api('backup-verify',{id:b.id});$('backup-status').textContent=`${r.id}：${r.components} 个组件校验通过`},'backup-error'));row.append(verify)
    for(const [mode,label] of [['isolated','隔离恢复演练'],['production','恢复到生产']]){const button=document.createElement('button');button.textContent=label;button.disabled=b.status!=='complete';button.addEventListener('click',action(async()=>{S.restore=await api('backup-restore-prepare',{id:b.id,mode});$('restore-title').textContent=label;$('restore-description').textContent=mode==='production'?'将先备份当前状态，再恢复所选博客版本、工作台草稿和 pelyblog 图片。过程会短暂停止相关服务；原目录与数据库会保留。其他图床策略不会被覆盖。':'将备份还原到独立目录与数据库，核验文件和数据。不会覆盖生产网站。';$('restore-id').textContent=b.id;$('restore-check').value='';$('restore-error').hidden=true;$('restore-dialog').showModal()},'backup-error'));row.append(button)}box.append(row)
  }
}

for(const id of ['title','text','slug','tags','categories'])$(id).addEventListener('input',changed)
for(const event of ['keyup','mouseup','select','blur'])$('text').addEventListener(event,()=>{cursor={start:$('text').selectionStart,end:$('text').selectionEnd}})
$('new-draft').addEventListener('click',action(createDraft));$('empty-new').addEventListener('click',action(createDraft));$('save').addEventListener('click',action(flush))
$('mode-ai').addEventListener('click',()=>mode('ai'));$('mode-manual').addEventListener('click',()=>mode('manual'))
for(const b of document.querySelectorAll('button[data-view]'))b.addEventListener('click',()=>{S.view=b.dataset.view;$('document').className=`document ${S.view}`;for(const el of document.querySelectorAll('button[data-view]'))el.setAttribute('aria-pressed',String(el===b))})
for(const b of document.querySelectorAll('[data-insert]'))b.addEventListener('click',action(()=>{if(S.draft?.format==='html')throw new Error('当前是 HTML 原文，请直接编辑标签，避免隐式转换格式');const selected=$('text').value.slice(cursor.start,cursor.end);insert({heading:'\n## '+(selected||'小标题')+'\n',bold:'**'+(selected||'重点')+'**',italic:'*'+(selected||'文字')+'*',code:'\n```text\n'+(selected||'代码')+'\n```\n',link:'['+(selected||'链接文字')+'](https://)',list:'\n- '+(selected||'列表项')+'\n'}[b.dataset.insert])}))
for(const tab of ['local','remote'])$(`${tab}-tab`).addEventListener('click',action(async()=>{S.tab=tab;S.page=1;tabs();await loadList()}))
$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{S.page=1;loadList().catch(notice)},300)})
$('more-articles').addEventListener('click',action(async()=>{S.page++;await loadList()}))
$('insert-image').addEventListener('click',()=>{if(S.draft)$('image-file').click();else notice('请先选择草稿')})
$('image-file').addEventListener('change',action(async()=>{const file=$('image-file').files[0];if(!file)return;const draftId=S.draft.id;const r=await request('/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});if(S.draft?.id!==draftId)throw new Error('图片上传成功，但草稿已切换，请回原草稿插入');insert(S.draft.format==='html'?`<img src="${r.url.replaceAll('"','&quot;')}" alt="">`:`\n![图片说明](${r.url})\n`);$('image-file').value=''}))
$('ask').addEventListener('click',action(async()=>{if(!S.draft)throw new Error('请先新建或选择草稿');const draftId=S.draft.id;await flush();if(S.draft?.id!==draftId)throw new Error('草稿已切换，请在当前稿重新开始');$('ask').disabled=true;try{const job=await api('task-start',{requestId:crypto.randomUUID(),draftId:S.draft.id,expectedRevision:S.draft.revision,instruction:$('instruction').value,research:$('research').checked,attachments:S.attachments.filter(a=>S.selected.has(a.id)).map(a=>({id:a.id,version:a.version,range:a.range}))});if(S.draft?.id!==draftId)return;S.job=job;sourceMode='task';showProposal();selectAssistantTab('answer');showJob();poll()}finally{if(S.draft?.id===draftId)$('ask').disabled=['queued','running'].includes(S.job?.status)}}))
$('copy-answer').addEventListener('click',action(async()=>{await navigator.clipboard.writeText(S.job?.text??'');$('copy-answer').textContent='已复制';setTimeout(()=>$('copy-answer').textContent='复制回答',1800)}))
$('source-scope').addEventListener('change',()=>{sourceMode=$('source-scope').value;renderSources()})
$('proposal-sources').addEventListener('click',()=>{sourceMode='proposal';renderSources();selectAssistantTab('sources')})
$('instruction').addEventListener('input',()=>{if(S.draft)instructions.set(S.draft.id,$('instruction').value)})
$('cancel-task').addEventListener('click',action(async()=>{if(S.job){const id=S.job.id,draftId=S.draft?.id;const job=await api('task-cancel',{id});if(S.job?.id!==id||S.draft?.id!==draftId)return;S.job=job;showJob()}}))
$('apply-proposal').addEventListener('click',action(async()=>{
  if(applyBusy)return
  applyBusy=true;$('apply-proposal').disabled=true
  try{
  const id=S.draft.id;await flush();if(S.draft?.id!==id)return
  const before=content(),revision=S.draft.revision,proposalId=S.draft.proposal.id,fields=[...document.querySelectorAll('[name=apply-field]:checked')].map(v=>v.value)
  $('apply-proposal').disabled=true
  applying=(async()=>{
    const d=await api('apply',{id,revision,proposalId,fields});if(S.draft?.id!==id)return
    const current=content(),changedFields=Object.keys(before).filter(key=>JSON.stringify(current[key])!==JSON.stringify(before[key]))
    const merged={...d};for(const key of changedFields)merged[key]=current[key]
    fill(merged);if(changedFields.length){S.dirty=true;$('save-state').textContent='已保留等待期间的修改，正在保存…'}
  })()
  try{await applying}finally{applying=null;showProposal()}
  if(S.draft?.id!==id)return
  await flush();await Promise.all([loadTasks(),loadAttachments(),loadOperations()]);selectAssistantTab('proposal')
  }finally{applyBusy=false;showProposal()}
}))
$('discard-proposal').addEventListener('click',action(async()=>{
  if(applyBusy||!S.draft?.proposal)return
  if(!window.confirm('删除当前候选稿？工作台正文和博客文章会保留。'))return
  applyBusy=true;$('discard-proposal').disabled=true
  try{
    const id=S.draft.id;await flush();if(S.draft?.id!==id||!S.draft.proposal)return
    const {revision,proposal}=S.draft
    applying=(async()=>{const d=await api('discard-proposal',{id,revision,proposalId:proposal.id});if(S.draft?.id===id){S.draft=d;showProposal()}})()
    try{await applying}finally{applying=null}
    await flush()
  }finally{applyBusy=false;$('discard-proposal').disabled=false;showProposal()}
}))
$('insert-proposal').addEventListener('click',action(()=>insert(S.draft.proposal.fields.text)))
$('publish').addEventListener('click',action(prepare))
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$(b.dataset.close).close())
$('consume-draft').addEventListener('change',()=>publishControls(publishBusy))
$('publish-dialog').addEventListener('cancel',e=>{if(publishBusy)e.preventDefault()})
$('retry-publish').addEventListener('click',action(prepare,'publish-error'))
$('confirm-publish').addEventListener('click',async()=>{
  if(publishBusy||$('confirm-publish').disabled)return
  const op=S.prepared;publishControls(true);$('publish-error').hidden=true;publishStatus('正在发布，请稍候…')
  try{await published(op,await api('confirm',{id:op.id,nonce:op.nonce,consumeSavedDraft:$('consume-draft').checked}))}
  catch(err){await checkPublishFailure(op,err)}finally{publishControls(false)}
})
$('reconcile-publish').addEventListener('click',async()=>{
  if(publishBusy)return
  const op=S.prepared;publishControls(true);$('publish-error').hidden=true;publishStatus('正在核对发布结果…')
  try{await published(op,await api('reconcile',{id:op.id}))}
  catch(err){await checkPublishFailure(op,err)}finally{publishControls(false)}
})
$('attachment-add').addEventListener('click',()=>{if(S.draft)$('attachment-files').click();else notice('请先新建或选择草稿')})
$('attachment-files').addEventListener('change',action(async()=>{await flush();const draftId=S.draft.id;$('attachment-add').disabled=true;try{for(const file of $('attachment-files').files){if(file.size>20*1024*1024)throw new Error('单文件不能超过 20 MiB');$('attachment-add').textContent='资料处理中…';await request(`/attachment?draftId=${encodeURIComponent(draftId)}&name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file})}}finally{if(S.draft?.id===draftId)await loadAttachments();$('attachment-files').value='';$('attachment-add').disabled=false;$('attachment-add').textContent='添加资料'}}))
$('range-save').addEventListener('click',action(async()=>{await api('attachment-select',{...S.attachmentView,selected:true,range:{from:Number($('range-from').value),to:Number($('range-to').value)}});await loadAttachments();$('attachment-dialog').close()},'attachment-error'))
$('backup-open').addEventListener('click',action(async()=>{$('backup-dialog').showModal();await loadBackups()},'backup-error'))
$('backup-refresh').addEventListener('click',action(loadBackups,'backup-error'))
$('backup-run').addEventListener('click',action(async()=>{await api('backup-run');await loadBackups()},'backup-error'))
$('restore-confirm').addEventListener('click',action(async()=>{if($('restore-check').value!==S.restore.backupId)throw new Error('请输入与所选版本一致的完整备份标识');$('restore-confirm').disabled=true;try{await api('backup-restore-confirm',{id:S.restore.id,nonce:S.restore.nonce,backupId:S.restore.backupId});$('restore-dialog').close();$('backup-status').textContent='恢复任务已提交，点击刷新查看状态；生产恢复期间服务会短暂停止。'}finally{$('restore-confirm').disabled=false}},'restore-error'))
$('schedule').addEventListener('submit',action(async e=>{e.preventDefault();await api('backup-schedule',{enabled:$('backup-enabled').checked,time:$('backup-time').value,daily:Number($('backup-daily').value),weekly:Number($('backup-weekly').value)});await loadBackups()},'backup-error'))
document.addEventListener('click',action(async e=>{if(e.target.matches('.copy-code')){const code=e.target.closest('.code-block').querySelector('code');await navigator.clipboard.writeText(code.textContent);e.target.textContent='已复制'}}))
window.addEventListener('beforeunload',e=>{if(S.dirty){e.preventDefault();e.returnValue=''}})
async function loadMetadata(){try{const meta=await api('metadata');for(const c of meta.categories){const option=document.createElement('option');option.value=c.id;option.textContent=c.name;option.selected=S.draft?.categories.includes(c.id)??false;$('categories').append(option)}S.metadataReady=true;$('categories').disabled=false;$('category-help').textContent='可多选已有分类'}catch(err){$('category-help').textContent='分类加载失败，保存时保留原分类';notice(err)}}
async function start(){S.identity=await request('/identity');$('backup-open').hidden=!S.identity.backupAdmin;$('blog-link').href=S.identity.blogUrl;initChat({api,request,identity:S.identity,openDraft,flush,renderMarkdown});void loadMetadata();await loadList();const id=sessionStorage.getItem(`blog-draft:${S.identity.userId}`);if(id)await openDraft(id)}
initLayout()
start().catch(notice)
