import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import {BlogStore} from '../src/store.mjs'
import {ChatStore} from '../src/chat-store.mjs'
import {BlogJobs} from '../src/jobs.mjs'
import {BlogChat} from '../src/chat.mjs'
import {BlogApplication} from '../src/application.mjs'
import {projectChat} from '../src/chat-history.mjs'

const actor={namespace:'user',userId:'writer',sessionId:'login'},owner='user:writer'
const tick=()=>new Promise(r=>setTimeout(r,10))
const sdk={isAppendSurfaceEvent:e=>['user/message','assistant/message'].includes(e.type),deriveEventMessage:e=>e.type==='user/message'?e.data:e.data.message,expandAssistantStream:s=>s??[],deriveTurnTokenUsage:()=>null}
test('language plugin snapshots preserve visible history without adding user bubbles',()=>{
  const events=[{type:'user/message',seq:1,time:1000,data:{id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'原用户问题'}]}},{type:'assistant/message',seq:2,time:2000,data:{message:{id:'a',role:'assistant',source:{model:'test',provider:'test'},content:[{type:'reasoning',text:'Earlier English reasoning.'},{type:'text',text:'旧回答'}]},stream:[]}}]
  const snapshot={type:'user/message',seq:3,time:3000,data:{id:'language',role:'user',source:{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt',form:'snapshot'},content:[{type:'text',text:'当前语言：简体中文'}]}}
  assert.deepEqual(projectChat([...events,snapshot],[],sdk),projectChat(events,[],sdk))
})

test('saved attempts display authoritative original blocks with a stable partial translation source',()=>{
  const original='Read the original source carefully and preserve every important detail.'
  const finalText='已保存的完整可见片段'
  const events=[
    {type:'turn/start',seq:0,time:1000,data:{turn:'turn-attempt'}},
    {type:'assistant/attempt',seq:1,time:2000,data:{turn:'turn-attempt',step:0,stream:[
      {chunk:{type:'reasoning-delta',index:0,text:'Earlier partial thinking.'}},
      {chunk:{type:'block-end',index:0,block:{type:'reasoning',text:original}}},
      {chunk:{type:'text-delta',index:1,text:'较早片段'}},
      {chunk:{type:'block-end',index:1,block:{type:'text',text:finalText}}},
      {chunk:{type:'finish',reason:{kind:'error',failure:{code:'MODEL',message:'interrupted fixture'}}}},
    ]}},
    {type:'turn/end',seq:2,time:3000,data:{turn:'turn-attempt',reason:{kind:'error'}}},
  ]
  const before=structuredClone(events),projection=projectChat(events,[],sdk)
  assert.equal(projection.messages.length,1)
  assert.deepEqual(
    Object.fromEntries(['id','seq','reasoning','text','interrupted','feedback'].map(key=>[key,projection.messages[0][key]])),
    {id:'attempt-1',seq:1,reasoning:original,text:finalText,interrupted:true,feedback:false},
  )
  assert.equal(projection.turns[0].status,'error')
  assert.deepEqual(events,before,'translation source projection must not rewrite the official event log')
})

async function fixture(t,{delayedOpen=false,delayedFlush=false,noPersistence=false}={}){
  const root=new Context(),registry=root.plugin(AgentRegistry);await registry
  const runtimeJobs=root.plugin(LocalJobRegistry);await runtimeJobs
  const store=new BlogStore(':memory:'),index=new ChatStore(store),handles=[],saved=new Map(),headers=new Map(),disposers=[],tools=new Map(),feedbackCalls=[]
  let revoked=false,releaseOpen,releaseFlush,flushCount=0,nextFlushGate;const releaseGates=[]
  const access={assert(a){assert.ok(!revoked&&a.sessionId==='login','revoked')}}
  const openGate=delayedOpen?new Promise(r=>{releaseOpen=r}):Promise.resolve()
  const flushGate=delayedFlush?new Promise(r=>{releaseFlush=r}):Promise.resolve()
  const archived=[]
  const ctx={root,jobs:root.jobs,effect:fn=>disposers.push(fn()),on:root.on.bind(root),get(key){return key==='agents'?root.agents:this[key]},
    workspaceRegistry:{archivedSessionIds:archived,async archiveSession(id){assert.ok(saved.has(id));if(!archived.includes(id))archived.push(id)}},
    tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
    agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{resolveModelInfo:async()=>({inputModalities:['text']})},
    sessionProjections:{restore(_checkpoint,events){return{checkpoint:{modelSelection:{val:{pending:null,lastUsed:events.findLast(e=>e.type==='request/header')?.data.header.config??null}}}}}},
    sessions:{async flush(session){if(++flushCount===1)await flushGate;if(nextFlushGate){const gate=nextFlushGate;nextFlushGate=null;await gate}saved.set(String(session.id),session.snapshotEvents());headers.set(String(session.id),session.header);return !noPersistence}},
    sessionPersistence:{async stat(id){return headers.has(String(id))?{header:headers.get(String(id))}:undefined},async open(id){assert.ok(saved.has(String(id)));return{header:headers.get(String(id)),read:async()=>saved.get(String(id)),close:async()=>{}}}},
    messageFeedback:Object.fromEntries(['list','put','delete'].map(action=>[action,async request=>{feedbackCalls.push({action,request});return{ok:true,value:action==='list'?{items:[]}:request}}])),
    agents:{async create(options){
      await openGate
      const scope=root.plugin(()=>{}),events=[...(options.seed??[])],session=Session.create(SessionId(options.sessionId))
      Object.defineProperty(session,'header',{value:headers.get(String(options.sessionId))??{id:options.sessionId,createdAt:Date.now(),cwd:process.cwd(),...options.meta}})
      headers.set(String(options.sessionId),session.header)
      session.snapshotEvents=()=>[...events]
      const agent={id:options.sessionId,ctx:scope.ctx,session,options:{},status:'idle',cancel(){handle.cancelled=true},whenIdle:async()=>{},followup(message){handle.message=message;handle.emit('user/message',message);handle.emit('turn/start',{turn:'turn-'+events.length});handle.emit('request/header',{header:{config:options.agentOptions}})}}
      const unregister=root.agents.register(agent)
      const handle={agent,options,events,cancelled:false,disposed:false,emit(type,data){const event={type,data,seq:events.length,time:1000+events.length*100};events.push(event);root.emit('session/event',session,event)},async dispose(){if(handle.disposed)return;handle.disposed=true;await unregister();await scope.dispose()}}
      handle.sections=[];handle.contexts=[];options.setup({systemPrompt:{section(s){handle.sections.push(s)},context(c){handle.contexts.push(c)}},tools:{restrict:rule=>{handle.allowed=rule.allow}}});handles.push(handle);return handle
    },async resume(options){return this.create({...options,sessionId:options.resumeSessionId,seed:saved.get(String(options.resumeSessionId))})}},
  }
  const attachments={freeze:()=>[]},blog={list:async()=>({items:[{cid:337,title:'现有文章'}]})}
  const jobs=new BlogJobs(ctx,access,store,blog,attachments,3000),app=new BlogApplication(store,access,blog,null,null,jobs,attachments)
  const chat=new BlogChat(ctx,access,store,index,attachments,jobs,app,sdk,3000)
  t.after(async()=>{releaseOpen?.();releaseFlush?.();for(const release of releaseGates)release();await chat.close();await jobs.close();for(const dispose of disposers.reverse())await dispose?.();store.close();await runtimeJobs.dispose();await registry.dispose()})
  const conversation=chat.create(actor,'conversation-123')
  return{root,store,index,chat,handles,tools,blog,feedbackCalls,conversation,releaseOpen,releaseFlush,holdNextFlush(){let release;nextFlushGate=new Promise(r=>{release=r});releaseGates.push(release);return release},revoke(){revoked=true},send:(extra={})=>chat.send(actor,{conversationId:conversation.id,requestId:'request-123',text:'看看博客最近情况',research:true,...extra})}
}
function complete(handle,id='answer-1'){
  const turn=handle.events.findLast(e=>e.type==='turn/start').data.turn
  handle.emit('assistant/message',{turn,message:{id,role:'assistant',source:{model:'test',provider:'test'},content:[{type:'text',text:'已查询博客'}]},stream:[]})
  handle.emit('turn/end',{turn,reason:{kind:'completed'}})
}

test('management previews without resuming and archives only owner sessions after pending operations finish',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const userEvent=f.handles[0].events.find(event=>event.type==='user/message')
  userEvent.data={...userEvent.data,content:[{type:'text',text:'MODEL-ONLY-FROZEN-ATTACHMENT'}]}
  const p=f.chat.provider,id=f.conversation.id,query={offset:0,limit:30,q:'',state:''}
  const original=structuredClone(f.handles[0].events),before=f.index.record(owner,id),handles=f.handles.length
  const preview=await p.preview(actor,id)
  assert.ok(preview.messages.some(m=>m.text==='看看博客最近情况'))
  assert.ok(!JSON.stringify(preview).includes('MODEL-ONLY-FROZEN-ATTACHMENT'))
  assert.deepEqual(f.index.record(owner,id),before);assert.equal(f.handles.length,handles)
  await assert.rejects(p.preview({...actor,userId:'another'},id),e=>e.status===404)
  f.store.db.prepare('INSERT INTO operations(id,owner,draftId,revision,data) VALUES(?,?,?,1,?)').run('pending',owner,'draft',JSON.stringify({status:'prepared',expiresAt:Date.now()+60000,chat:{conversationId:id}}))
  assert.equal((await p.list(actor,query)).items[0].canRemove,false)
  assert.equal((await p.remove(actor,[id])).results[0].status,'blocked')
  f.chat.app.operationSave('pending',{status:'cancelled',chat:{conversationId:id}})
  assert.equal((await p.remove(actor,[id])).results[0].status,'removed')
  assert.equal((await p.remove(actor,[id])).results[0].status,'alreadyRemoved')
  assert.equal((await p.list(actor,query)).total,0)
  assert.deepEqual(f.handles[0].events,original)
})

test('publish tool prepares a private confirmation card; candidate is applied only after user confirmation',async t=>{
  const f=await fixture(t),draft=f.store.create(owner,{title:'测试文章',text:'原文'}),proposal=f.store.propose(owner,draft.id,1,{text:'候选正文'},[])
  let writes=0
  f.blog.call=async(action,args)=>{assert.equal(action,'save');assert.equal(args.content.text,'候选正文');writes++;return{cid:338,url:'https://example.test/338',snapshot:{version:'v2',published:{cid:338}}}}
  await f.send();await tick();const h=f.handles[0]
  const execute=args=>f.tools.get('blog_publish_draft').execute(args,{agent:h.agent})
  const args={draftId:draft.id,proposalId:proposal.id},prepared=await execute(args)
  assert.equal(writes,0);assert.equal(f.store.get(owner,draft.id).text,'原文');assert.equal(prepared.nonce,undefined)
  assert.equal((await execute(args)).id,prepared.id)
  let card=(await f.chat.history(actor,f.conversation.id)).operations[0]
  assert.equal(card.after.text,'候选正文');assert.equal(card.canConfirm,false)
  await assert.rejects(f.chat.operationAction(actor,{conversationId:f.conversation.id,id:card.id,nonce:card.nonce,operation:'confirm'}),/本轮/)
  complete(h);await tick();card=(await f.chat.history(actor,f.conversation.id)).operations[0]
  assert.equal(card.canConfirm,true)
  const request={conversationId:f.conversation.id,id:card.id,nonce:card.nonce,operation:'confirm'}
  await assert.rejects(f.chat.operationAction({...actor,userId:'other'},request),/无权/)
  await assert.rejects(f.chat.operationAction(actor,{...request,nonce:'invented'}),/失效/)
  await assert.rejects(f.chat.app.confirm(actor,request),/原对话/)
  assert.equal((await f.chat.operationAction(actor,request)).status,'succeeded')
  assert.equal((await f.chat.operationAction(actor,request)).status,'succeeded');assert.equal(writes,1)
  assert.equal(f.store.get(owner,draft.id).text,'候选正文');assert.equal(f.store.get(owner,draft.id).proposal,null)
  const history=await f.chat.history(actor,f.conversation.id);assert.equal(history.operations[0].status,'succeeded');assert.equal(history.operations[0].nonce,null)
  await f.send({requestId:'after-publish',text:'刚才发布成功了吗'});await tick()
  const context=f.handles[1].contexts.find(c=>c.name==='blog:operations')
  assert.match(context.text,/succeeded/);assert.ok(!context.text.includes(card.nonce))
  complete(f.handles[1],'answer-2');await tick()
  const branch=await f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-2',requestId:'publish-fork'})
  assert.deepEqual((await f.chat.history(actor,branch.id)).operations,[])
})

test('publishing a blog saved draft requires consumption confirmation and preserves in-flight manual edits',async t=>{
  const f=await fixture(t),source={cid:339,title:'保存稿',text:'保存稿正文',slug:'saved',format:'markdown',tags:[],categories:[],type:'post_draft'}
  const remote={version:'v1',published:{...source,cid:338,text:'公开正文',type:'post'},savedDraft:source}
  f.blog.get=async()=>remote
  let release,writes=0
  f.blog.call=async(action,args)=>{assert.equal(action,'save');assert.equal(args.content.text,source.text);writes++;return new Promise(resolve=>{release=()=>resolve({cid:338,snapshot:{version:'v2',published:{...source,cid:338,type:'post'}}})})}
  await f.send();await tick();const h=f.handles[0]
  await f.tools.get('blog_publish_draft').execute({cid:338},{agent:h.agent})
  complete(h);await tick()
  const card=(await f.chat.history(actor,f.conversation.id)).operations[0],draft=f.store.list(owner)[0]
  assert.equal(card.after.text,'保存稿正文');assert.equal(card.before.text,'公开正文')
  const request={conversationId:f.conversation.id,id:card.id,nonce:card.nonce,operation:'confirm'}
  await assert.rejects(f.chat.operationAction(actor,request),/消费现有博客保存稿/);assert.equal(writes,0)
  const confirming=f.chat.operationAction(actor,{...request,consumeSavedDraft:true});await tick()
  await assert.rejects(f.chat.app.prepare(actor,{id:draft.id,revision:1,mode:'publish'}),/提交待核对/)
  f.store.save(owner,draft.id,1,{text:'请求期间继续手写'})
  release();assert.equal((await confirming).status,'succeeded');assert.equal(writes,1)
  assert.equal(f.store.get(owner,draft.id).text,'请求期间继续手写')
  assert.equal((await f.chat.history(actor,f.conversation.id)).operations[0].after.text,'保存稿正文')
})

test('confirmation rejects replaced proposals, another conversation, expired cards and revoked actors',async t=>{
  const f=await fixture(t),draft=f.store.create(owner,{title:'标题',text:'原文'}),proposal=f.store.propose(owner,draft.id,1,{text:'待发布'},[])
  let writes=0;f.blog.call=async()=>{writes++;throw new Error('must not execute')}
  await f.send();await tick();const h=f.handles[0]
  const prepared=await f.tools.get('blog_publish_draft').execute({draftId:draft.id,proposalId:proposal.id},{agent:h.agent})
  complete(h);await tick()
  const card=(await f.chat.history(actor,f.conversation.id)).operations[0],request={conversationId:f.conversation.id,id:prepared.id,nonce:card.nonce,operation:'confirm'}
  const other=f.chat.create(actor,'another-conversation')
  await assert.rejects(f.chat.operationAction(actor,{...request,conversationId:other.id}),/不属于/)
  f.store.propose(owner,draft.id,1,{text:'新的候选'},[])
  await assert.rejects(f.chat.operationAction(actor,request),/候选稿已变化/)
  const op=f.chat.app.operation(owner,prepared.id);op.expiresAt=0;f.chat.app.operationSave(op.id,op)
  await assert.rejects(f.chat.operationAction(actor,request),/失效/)
  f.revoke();await assert.rejects(f.chat.operationAction(actor,request),/revoked/)
  assert.equal(writes,0)
})

test('delete confirmation preserves local copies and reconciles an uncertain remote result without another delete',async t=>{
  const f=await fixture(t),remote={version:'v1',published:{cid:338,title:'删除目标',text:'正文',type:'post'},savedDraft:{cid:339,title:'保存稿',text:'草稿',type:'post_draft'}}
  const draft=f.store.create(owner,{title:'本地副本',text:'本地正文'},remote);let deletes=0
  f.blog.get=async()=>remote
  f.blog.call=async(action,args)=>{
    if(action==='status')return{deleteArticle:true}
    if(action==='delete'){assert.equal(args.cid,338);deletes++;throw new Error('response lost')}
    if(action==='receipt')return{status:'succeeded',result:{cid:338,deleted:true,deletedCids:[338,339],url:null,snapshot:null}}
    throw new Error(action)
  }
  await f.send();await tick();const h=f.handles[0]
  await assert.rejects(f.tools.get('blog_delete_post').execute({cid:339},{agent:h.agent}),/主文章/)
  const prepared=await f.tools.get('blog_delete_post').execute({cid:338},{agent:h.agent})
  assert.equal(deletes,0);assert.equal(prepared.nonce,undefined)
  complete(h);await tick();const card=(await f.chat.history(actor,f.conversation.id)).operations[0]
  assert.deepEqual(card.deletedArticles.map(p=>p.cid),[338,339])
  const request={conversationId:f.conversation.id,id:card.id,nonce:card.nonce,operation:'confirm'}
  await assert.rejects(f.chat.operationAction(actor,request),/response lost/)
  await assert.rejects(f.chat.operationAction(actor,request),/查询回执/)
  assert.equal((await f.chat.operationAction(actor,{...request,operation:'reconcile'})).status,'succeeded')
  assert.equal(deletes,1);assert.equal(f.store.get(owner,draft.id).text,'本地正文');assert.equal(f.store.get(owner,draft.id).remote.deleted,true)
  await assert.rejects(f.chat.app.prepare(actor,{id:draft.id,revision:2,mode:'publish'}),/原文已删除/)
})

test('cancelled cards cannot execute and unsupported bridges never prepare deletion',async t=>{
  const f=await fixture(t),draft=f.store.create(owner,{title:'标题',text:'正文'})
  f.blog.call=async()=>({deleteArticle:false})
  await f.send();await tick();const h=f.handles[0]
  await assert.rejects(f.tools.get('blog_delete_post').execute({cid:338},{agent:h.agent}),/先更新/)
  await f.tools.get('blog_publish_draft').execute({draftId:draft.id},{agent:h.agent});complete(h);await tick()
  const card=(await f.chat.history(actor,f.conversation.id)).operations[0],request={conversationId:f.conversation.id,id:card.id,nonce:card.nonce}
  assert.equal((await f.chat.operationAction(actor,{...request,operation:'cancel'})).status,'cancelled')
  await assert.rejects(f.chat.operationAction(actor,{...request,operation:'confirm'}),/查询回执/)
})

test('history actions refuse active and finishing conversations before changing any selected row',async t=>{
  const f=await fixture(t),idle=f.chat.create(actor,'history-idle')
  await f.send();await tick()
  for(const operation of ['rename','pin'])assert.throws(()=>f.chat.mutate(actor,{operation,ids:[f.conversation.id],title:'不应改名',pinned:true}),e=>e.status===409)
  await assert.rejects(f.chat.mutate(actor,{operation:'delete',ids:[idle.id,f.conversation.id]}),e=>e.status===409)
  assert.equal(f.index.get(owner,idle.id).deletedAt,null)
  const release=f.holdNextFlush(),stopping=f.chat.stop(actor,f.conversation.id);await tick()
  await assert.rejects(f.chat.mutate(actor,{operation:'delete',ids:[f.conversation.id]}),e=>e.status===409)
  release();await stopping
  assert.deepEqual(f.chat.mutate(actor,{operation:'rename',ids:[f.conversation.id],title:'保留的历史'}),{ok:true})
  assert.equal(f.chat.list(actor,0,'保留的历史').items[0].id,f.conversation.id)
})

test('fork source is protected during historical reads and both source and child remain protected until durable',async t=>{
  let releaseRead=()=>{};t.after(()=>releaseRead())
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const persistence=f.chat.ctx.sessionPersistence,open=persistence.open
  const readGate=new Promise(r=>{releaseRead=r})
  persistence.open=async(...args)=>{await readGate;return open(...args)}
  const pending=f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'history-fork'})
  await tick()
  assert.throws(()=>f.chat.mutate(actor,{operation:'rename',ids:[f.conversation.id],title:'分支期间'}),e=>e.status===409)
  const releaseFlush=f.holdNextFlush();releaseRead();await tick()
  const child=f.chat.list(actor).items.find(c=>c.id!==f.conversation.id)
  assert.ok(child)
  for(const id of [f.conversation.id,child.id])await assert.rejects(f.chat.mutate(actor,{operation:'delete',ids:[id]}),e=>e.status===409)
  releaseFlush();await pending
  assert.equal(f.chat.forkSources.size,0)
  const original=structuredClone(f.handles[0].events);let ended=0,changed=0
  const unsubscribe=f.chat.subscribe(actor,f.conversation.id,()=>{changed++},()=>{ended++})
  await f.chat.mutate(actor,{operation:'delete',ids:[f.conversation.id]})
  assert.equal(ended,1);assert.equal(changed,0);unsubscribe()
  await assert.rejects(f.chat.history(actor,f.conversation.id),e=>e.status===404)
  assert.throws(()=>f.chat.create(actor,'conversation-123'),e=>e.status===404)
  assert.deepEqual(f.handles[0].events,original)
  assert.equal((await f.chat.history(actor,child.id)).messages.at(-1).id,'answer-1')
  await f.chat.mutate(actor,{operation:'delete',ids:[child.id]})
  assert.throws(()=>f.chat.create(actor,'history-fork'),e=>e.status===404)
})

test('chat search tools preserve structured dates and return lossless imported draft references',async t=>{
  const f=await fixture(t),draft=f.store.create(owner,{title:'时间检索稿'},{published:{cid:338}})
  f.chat.app.applyResult({id:'delete-338',owner,mode:'delete',before:{published:{cid:338}}},{deleted:true})
  let received;f.blog.search=async args=>{received=args;return {items:[],hasMore:false}}
  await f.send();await tick();const agent=f.handles[0].agent
  const args={period:'yesterday',title:'测试',category:'摘抄笔记',page:2}
  await f.tools.get('blog_search_posts').execute(args,{agent});assert.deepEqual(received,args)
  const result=await f.tools.get('blog_list_drafts').execute({title:'时间检索稿'},{agent})
  assert.equal(result.items.length,1);assert.equal(result.items[0].remote.savedDraftCid,null)
  assert.equal(result.items[0].remote.deleted,true);assert.equal(result.items[0].contentUpdatedAt,draft.contentUpdatedAt)
  assert.deepEqual(result,JSON.parse(JSON.stringify(result)))
})

test('separate chat operations reuse the same imported version without losing a candidate',async t=>{
  const f=await fixture(t)
  f.blog.get=async()=>({published:{cid:338,title:'原文',text:'正文',slug:'338',format:'markdown',tags:[],categories:[]},savedDraft:null,version:'v'})
  await f.send();await tick()
  const tool=f.tools.get('blog_select_draft'),args={cid:338,variant:'published'}
  const first=await tool.execute(args,{agent:f.handles[0].agent})
  const proposal=f.store.propose(owner,first.draftId,first.revision,{text:'保留候选'},[])
  complete(f.handles[0]);await tick()
  await f.send({requestId:'request-second',text:'继续修改该文章'});await tick()
  const next=await tool.execute(args,{agent:f.handles.at(-1).agent})
  assert.equal(next.draftId,first.draftId);assert.equal(next.proposalId,proposal.id)
  assert.equal(f.store.list(owner).length,1)
})

test('concurrent conversations sharing an import cannot replace each others candidates',async t=>{
  const f=await fixture(t)
  f.blog.get=async()=>({published:{cid:338,title:'原文',text:'正文',slug:'338',format:'markdown',tags:[],categories:[]},savedDraft:null,version:'v'})
  const second=f.chat.create(actor,'conversation-second')
  await f.send();await f.send({conversationId:second.id,requestId:'request-second'});await tick()
  const select=f.tools.get('blog_select_draft'),propose=f.tools.get('blog_propose'),args={cid:338,variant:'published'}
  const a=await select.execute(args,{agent:f.handles[0].agent}),b=await select.execute(args,{agent:f.handles[1].agent})
  assert.equal(a.draftId,b.draftId)
  const first=await propose.execute({text:'先完成候选'},{agent:f.handles[0].agent})
  await assert.rejects(propose.execute({text:'后完成候选'},{agent:f.handles[1].agent}),/候选稿已被其他任务更新/)
  assert.equal(f.store.get(owner,a.draftId).proposal.id,first.proposalId)
  const continued=await propose.execute({text:'同一任务继续调整'},{agent:f.handles[0].agent})
  assert.equal(f.store.get(owner,a.draftId).proposal.id,continued.proposalId)
})

test('chat starts without an article, preserves native history, resumes and deduplicates network requests',async t=>{
  const f=await fixture(t),request=await f.send();await tick()
  assert.equal(f.store.list(owner).length,0);assert.equal(f.handles.length,1)
  assert.ok(f.handles[0].allowed.includes('blog_select_draft'))
  assert.deepEqual(await f.send(),{id:request.id,status:'running',conversationId:f.conversation.id})
  await assert.rejects(f.send({requestId:'request-456'}),/对话|上一轮/)
  complete(f.handles[0]);await tick()
  await assert.rejects(f.chat.feedback(actor,f.conversation.id,'put',{messageId:'answer-1',rating:'positive',ifVersion:null,note:'中'.repeat(1334)}),/4000/)
  assert.equal(f.feedbackCalls.length,0)
  const history=await f.chat.history(actor,f.conversation.id)
  assert.equal(history.busy,false);assert.equal(history.messages.filter(m=>m.role==='assistant').length,1)
  assert.equal(history.messages[0].text,'看看博客最近情况')
  assert.equal(f.handles[0].disposed,true)
  await f.send({requestId:'request-456',text:'继续'});await tick()
  assert.equal(f.handles[1].events[0].data.id,f.handles[0].message.id)
  for(const h of f.handles){assert.match(h.sections.at(-1).text,/reasoning_content/);assert.ok(h.sections.at(-1).order>h.sections[0].order);assert.match(h.contexts[0].text,/当前交互界面的语言是简体中文/)}
  assert.equal(f.handles[1].message.content[0].text,'继续')
  await assert.rejects(f.chat.history({...actor,userId:'other'},f.conversation.id),/无权/)
})

test('new draft and retry share one logical article; manual changes reject stale proposals',async t=>{
  const f=await fixture(t),request=await f.send();await tick()
  const h=f.handles[0],execute=(name,args)=>f.tools.get(name).execute(args,{agent:h.agent})
  const first=await execute('blog_select_draft',{newArticle:true}),second=await execute('blog_select_draft',{newArticle:true})
  assert.equal(first.draftId,second.draftId)
  await execute('blog_propose',{title:'标题',text:'第一版'})
  f.store.save(owner,first.draftId,1,{text:'手写内容'})
  await assert.rejects(execute('blog_propose',{text:'迟到的候选'}),/手动修改/)
  complete(h);await tick()
  await f.send({requestId:'request-retry',retryFrom:request.id,text:'重新给出候选'});await tick()
  const next=await f.tools.get('blog_select_draft').execute({newArticle:true},{agent:f.handles[1].agent})
  assert.equal(next.draftId,first.draftId);assert.equal(next.text,'手写内容');assert.equal(f.store.list(owner).length,1)
  const cards=f.index.results(owner,f.conversation.id);assert.equal(cards[0].proposal.fields.text,'第一版')
})

test('feedback checks owner and completed message before the official service; branch uses a closed prefix',async t=>{
  const f=await fixture(t);await f.send();await tick()
  await assert.rejects(f.chat.feedback(actor,f.conversation.id,'put',{messageId:'invented',rating:'positive',ifVersion:null}),/完成/)
  assert.equal(f.feedbackCalls.length,0)
  complete(f.handles[0]);await tick()
  await f.chat.feedback(actor,f.conversation.id,'put',{messageId:'answer-1',rating:'positive',ifVersion:null})
  assert.equal(f.feedbackCalls[0].request.sessionId,f.conversation.id)
  await assert.rejects(f.chat.feedback({...actor,userId:'other'},f.conversation.id,'list'),/无权/)
  const branch=await f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'fork-12345'})
  const handle=f.handles.at(-1)
  assert.equal(handle.options.seed.at(-1).type,'turn/end');assert.equal(handle.options.inheritedEventCount,handle.options.seed.length)
  assert.equal(handle.options.meta.parentSession,f.conversation.id);assert.equal(handle.options.meta.isSeeded,true)
  assert.ok(handle.allowed.includes('blog_select_draft'));assert.equal(handle.disposed,true)
  const history=await f.chat.history(actor,branch.id);assert.equal(history.requests.length,1)
  const same=await f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'fork-12345'})
  assert.equal(same.id,branch.id);assert.equal(f.handles.length,2)
})

test('stop during Agent creation waits for that handle and does not release the conversation early',async t=>{
  const f=await fixture(t,{delayedOpen:true});await f.send();await tick()
  let stopped=false;const stopping=f.chat.stop(actor,f.conversation.id).then(()=>{stopped=true})
  await tick();assert.equal(stopped,false)
  await assert.rejects(f.send({requestId:'request-456'}),/对话|上一轮/)
  f.releaseOpen();await stopping;assert.equal(f.handles[0].disposed,true);assert.equal(f.handles[0].message,undefined)
  assert.equal(f.chat.active.size,0)
  assert.equal(f.index.get(owner,f.conversation.id).ready,true)
  await f.send({requestId:'request-after-stop'});await tick();assert.equal(f.handles[1].options.resumeSessionId,f.conversation.id)
})

test('stopping during first durability checkpoint never follows up or registers a new Job',async t=>{
  const f=await fixture(t,{delayedFlush:true});await f.send();await tick()
  const stop=f.chat.stop(actor,f.conversation.id);await tick();f.releaseFlush();await stop;await tick()
  assert.equal(f.handles[0].message,undefined);assert.equal(f.handles[0].disposed,true);assert.equal(f.chat.active.size,0)
})

test('missing durability participation fails the turn before any model request',async t=>{
  const f=await fixture(t,{noPersistence:true}),request=await f.send();await tick()
  assert.equal(f.index.request(owner,request.id).status,'failed');assert.equal(f.handles[0].message,undefined)
  assert.equal(f.index.get(owner,f.conversation.id).ready,false)
})

test('an unpublished durable session is recovered by lifecycle, while a replaced lifecycle is rejected',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  f.index.save(owner,f.conversation.id,{ready:false})
  const history=await f.chat.history(actor,f.conversation.id);assert.equal(history.messages.at(-1).id,'answer-1')
  await f.send({requestId:'request-resume'});await tick();assert.equal(f.handles[1].options.resumeSessionId,f.conversation.id)
  await f.chat.stop(actor,f.conversation.id)
  f.index.save(owner,f.conversation.id,{ready:false,sessionCreatedAt:1})
  await assert.rejects(f.chat.history(actor,f.conversation.id),/生命周期/)
})

test('remote import is deduplicated across retries, rejects oversize before writing and honors tool abort',async t=>{
  const f=await fixture(t),request=await f.send();await tick();complete(f.handles[0]);await tick()
  const source={cid:42,title:'已有文章',text:'正文',slug:'post',format:'markdown',tags:[],categories:[]}
  f.blog.get=async()=>({published:source,version:'v1'})
  await f.send({requestId:'retry-first',retryFrom:request.id});await tick()
  const selected=await f.tools.get('blog_select_draft').execute({cid:42,variant:'published'},{agent:f.handles[1].agent})
  complete(f.handles[1],'answer-2');await tick()
  await f.send({requestId:'retry-second',retryFrom:request.id});await tick()
  const same=await f.tools.get('blog_select_draft').execute({cid:42,variant:'published'},{agent:f.handles[2].agent})
  assert.equal(same.draftId,selected.draftId);assert.equal(f.store.list(owner).length,1)
  complete(f.handles[2],'answer-3');await tick()
  await f.send({requestId:'another-operation'});await tick()
  f.blog.get=async()=>({published:{...source,text:'x'.repeat(120001)}})
  await assert.rejects(f.tools.get('blog_select_draft').execute({cid:42,variant:'published'},{agent:f.handles[3].agent}),/正文过长/)
  assert.equal(f.store.list(owner).length,1)
  let release;f.blog.get=()=>new Promise(r=>{release=r})
  const abort=new AbortController(),pending=f.tools.get('blog_select_draft').execute({cid:42,variant:'published'},{agent:f.handles[3].agent,signal:abort.signal})
  await tick();abort.abort();release({published:source});await assert.rejects(pending);assert.equal(f.store.list(owner).length,1)
})

test('draft creation rolls back if the logical request binding cannot be persisted',async t=>{
  const f=await fixture(t);await f.send();await tick()
  const update=f.index.updateRequest.bind(f.index);let fail=true
  f.index.updateRequest=(id,patch)=>{if(patch.draftId&&fail){fail=false;throw new Error('injected binding write failure')}return update(id,patch)}
  const execute=()=>f.tools.get('blog_select_draft').execute({newArticle:true},{agent:f.handles[0].agent})
  await assert.rejects(execute(),/injected/);assert.equal(f.store.list(owner).length,0)
  const selected=await execute();assert.ok(selected.draftId);assert.equal(f.store.list(owner).length,1)
})

test('image model survives removed selection, native history reopening and branch continuation',async t=>{
  const f=await fixture(t),chat=f.chat
  chat.jobs.models={text:{provider:'glm-fixture',model:'text'},vision:{provider:'glm-fixture',model:'vision'}}
  chat.ctx.llm.resolveModelInfo=async(provider,model)=>{assert.equal(provider,'glm-fixture');return{inputModalities:model==='vision'?['text','image']:['text']}}
  await f.send();await tick();assert.equal(f.handles[0].options.agentOptions.model,'test');complete(f.handles[0],'text-answer');await tick()
  chat.attachments.freeze=()=>[{id:'image-fixture',version:1,name:'image',image:{provider:'fixture',attachmentId:'image'}}]
  await f.send({requestId:'image-request'});await tick();assert.equal(f.handles[1].options.agentOptions.model,'vision');complete(f.handles[1],'image-answer');await tick()
  chat.attachments.freeze=()=>[]
  await f.send({requestId:'text-after-image'});await tick();assert.equal(f.handles[2].options.agentOptions.model,'vision');complete(f.handles[2],'continued-answer');await tick()
  const branch=await chat.fork(actor,{conversationId:f.conversation.id,messageId:'continued-answer',requestId:'image-fork'})
  assert.equal(f.handles[3].options.agentOptions.model,'vision')
  await chat.close()
  const reopened=new BlogChat(chat.ctx,chat.access,chat.store,chat.index,chat.attachments,chat.jobs,chat.app,chat.sdk,3000)
  t.after(()=>reopened.close())
  await reopened.send(actor,{conversationId:branch.id,requestId:'reopened-image-followup',text:'继续看前面的图',research:false})
  await tick();assert.equal(f.handles[4].options.agentOptions.model,'vision')
  assert.equal(chat.ctx.agentDefaultModel.currentSelection().model,'test')
  complete(f.handles[4],'branch-answer');await tick()
})

test('new text chats follow the framework default while reopening and branching preserve their recorded model',async t=>{
  const f=await fixture(t),chat=f.chat
  chat.jobs.models={text:{provider:'dedicated',model:'writing'}}
  await f.send();await tick();assert.equal(f.handles[0].options.agentOptions.model,'test');complete(f.handles[0]);await tick()
  chat.ctx.agentDefaultModel.currentSelection=()=>({provider:'new-provider',model:'new-model'})
  await chat.close()
  const reopened=new BlogChat(chat.ctx,chat.access,chat.store,chat.index,chat.attachments,chat.jobs,chat.app,chat.sdk,3000)
  t.after(()=>reopened.close())
  await reopened.send(actor,{conversationId:f.conversation.id,requestId:'resume-default-model',text:'继续',research:false})
  await tick();assert.equal(f.handles[1].options.agentOptions.model,'test');complete(f.handles[1],'old-answer');await tick()
  await reopened.fork(actor,{conversationId:f.conversation.id,messageId:'old-answer',requestId:'model-branch'})
  assert.equal(f.handles[2].options.agentOptions.model,'test')
  const fresh=reopened.create(actor,'new-model-conversation')
  await reopened.send(actor,{conversationId:fresh.id,requestId:'fresh-default-model',text:'新对话',research:false})
  await tick();assert.equal(f.handles[3].options.agentOptions.model,'new-model');complete(f.handles[3],'new-answer');await tick()
})

test('history waits for a pending fork checkpoint instead of publishing ready from stat',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const release=f.holdNextFlush(),fork=f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'fork-delayed'})
  await tick();const id=String(f.handles[1].agent.id);assert.equal(f.index.get(owner,id).ready,false)
  let read=false;const history=f.chat.history(actor,id).then(result=>{read=true;return result})
  await tick();assert.equal(read,false);assert.equal(f.index.get(owner,id).ready,false)
  release();await fork;assert.equal((await history).messages.at(-1).id,'answer-1');assert.equal(f.index.get(owner,id).ready,true)
})

test('closing aborts pending fork model lookup and cannot create an Agent after it resolves',async t=>{
  const f=await fixture(t),chat=f.chat
  chat.ctx.llm.resolveModelInfo=async()=>({inputModalities:['text','image']})
  chat.attachments.freeze=()=>[{id:'image-fixture',version:1,name:'image',image:{provider:'fixture',attachmentId:'image'}}]
  await f.send();await tick();complete(f.handles[0]);await tick()
  let entered,release,lookupSignal
  const lookupStarted=new Promise(resolve=>{entered=resolve})
  // Even an adapter that resolves after cancellation must not open a new Agent.
  chat.ctx.llm.resolveModelInfo=(_provider,_model,signal)=>new Promise(resolve=>{lookupSignal=signal;release=()=>resolve({inputModalities:['text','image']});entered()})
  const fork=chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'fork-close-pending'})
  const rejected=assert.rejects(fork,/abort|停止/i)
  await lookupStarted
  const closing=chat.close()
  assert.equal(lookupSignal.aborted,true)
  assert.equal(f.handles.length,1)
  release();await Promise.all([closing,rejected])
  assert.equal(f.handles.length,1)
  assert.equal(chat.forks.size,0)
  const branch=f.index.list(owner,0).items.find(c=>c.id!==f.conversation.id)
  assert.equal(f.index.get(owner,branch.id).ready,false)
})
