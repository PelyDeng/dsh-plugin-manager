import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import {BlogStore} from '../src/store.mjs'
import {ChatStore} from '../src/chat-store.ts'
import {BlogJobs} from '../src/jobs.mjs'
import {BlogChat} from '../src/chat.ts'
import {BlogApplication,PendingOperationsMirror} from '../src/application.mjs'
import {projectChat} from '../src/chat-history.mjs'
// 协作入口在 P7 收敛到运行时（`src/participant.ts` 已删除）。这两条用例断言的是**协作路径**
// 上的行为，所以经构造胶水接回运行时入口——**用例体与断言一字未改**（`participant-harness.mjs`
// 的文件头写了它只做构造、以及为什么签名保持不变）。
import {createBlogParticipant,installTitleDelivery} from './participant-harness.mjs'
import {ConversationLifecycle} from '../../../packages/runtime/src/index.ts'
// 索引库切 PG 之后夹具换成运行时的内存端口（见 `index-fixture.mjs`）：`ChatStore` 不再自己开库，
// 所有读写都过端口（异步）。
import {memoryIndex,ownerActor} from './index-fixture.mjs'

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

async function fixture(t,{delayedOpen=false,delayedFlush=false,noPersistence=false,occupancy}={}){
  const root=new Context(),registry=root.plugin(AgentRegistry);await registry
  const runtimeJobs=root.plugin(LocalJobRegistry);await runtimeJobs
  const store=new BlogStore(':memory:');await store.init();const pending=new PendingOperationsMirror(),indexDb=memoryIndex(),index=new ChatStore(indexDb,()=>pending.ids()),handles=[],saved=new Map(),headers=new Map(),disposers=[],tools=new Map(),feedbackCalls=[]
  let revoked=false,releaseOpen,releaseFlush,flushCount=0,nextFlushGate;const releaseGates=[]
  const access={assert(a){assert.ok(!revoked&&a.sessionId==='login','revoked')}}
  const openGate=delayedOpen?new Promise(r=>{releaseOpen=r}):Promise.resolve()
  const flushGate=delayedFlush?new Promise(r=>{releaseFlush=r}):Promise.resolve()
  const archived=[]
  const ctx={root,jobs:root.jobs,effect:fn=>disposers.push(fn()),on:root.on.bind(root),get(key){return key==='agents'?root.agents:this[key]},
    workspaceRegistry:{archivedSessionIds:archived,async archiveSession(id){assert.ok(saved.has(id));if(!archived.includes(id))archived.push(id)}},
    tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
    agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{resolveModelInfo:async()=>({inputModalities:['text']}),resolveCallConfig:async value=>value},
    sessionController:{
      async modelCatalog(){return{groups:[{id:'test',name:'测试',models:[{id:'test',name:'文本模型'}]},{id:'glm-fixture',name:'视觉测试',models:[{id:'vision',name:'视觉模型'}]},{id:'new-provider',name:'新默认',models:[{id:'new-model',name:'新模型'}]}],failures:[]}},
      async selectModel({sessionId,...selected}){const h=handles.findLast(h=>h.agent.id===sessionId&&!h.disposed);assert.ok(h,'Agent must be open');h.emit('model/selection',selected);h.options.agentOptions={...selected};ctx.agentDefaultModel.currentSelection=()=>selected;return{selected}},
    },
    sessionProjections:{restore(_checkpoint,events){return{checkpoint:{modelSelection:{val:{pending:null,lastUsed:events.findLast(e=>e.type==='request/header')?.data.header.config??null}}}}}},
    sessions:{async flush(session){if(++flushCount===1)await flushGate;if(nextFlushGate){const gate=nextFlushGate;nextFlushGate=null;await gate}saved.set(String(session.id),session.snapshotEvents());headers.set(String(session.id),session.header);return !noPersistence}},
    sessionPersistence:{async stat(id){return headers.has(String(id))?{header:headers.get(String(id))}:undefined},async open(id){assert.ok(saved.has(String(id)));return{header:headers.get(String(id)),read:async()=>({events:saved.get(String(id)),eventState:"detached"}),close:async()=>{}}}},
    messageFeedback:Object.fromEntries(['list','put','delete'].map(action=>[action,async request=>{feedbackCalls.push({action,request});return{ok:true,value:action==='list'?{items:[]}:request}}])),
    agents:{async create(options){
      await openGate
      const scope=root.plugin(()=>{}),events=[...(options.seed??[])],session=Session.create(SessionId(options.sessionId))
      Object.defineProperty(session,'header',{value:headers.get(String(options.sessionId))??{id:options.sessionId,createdAt:Date.now(),cwd:process.cwd(),...options.meta}})
      headers.set(String(options.sessionId),session.header)
      session.snapshotEvents=()=>[...events]
      const agent={id:options.sessionId,ctx:scope.ctx,session,options:{},status:'idle',cancel(){handle.cancelled=true},whenIdle:async()=>{},followup(message){handle.message=message;handle.emit('user/message',message);handle.emit('turn/start',{turn:'turn-'+events.length});handle.emit('request/header',{header:{config:options.agentOptions}})}}
      const unregister=root.agents.register(agent)
      const handle={agent,options,events,cancelled:false,disposed:false,emit(type,data){const event={type,data,seq:events.length,time:1000+events.length*100};root.emit('session/event',session,event);events.push(event)},async dispose(){if(handle.disposed)return;handle.disposed=true;await unregister();await scope.dispose()}}
      handle.sections=[];handle.contexts=[];options.setup({systemPrompt:{section(s){handle.sections.push(s)},context(c){handle.contexts.push(c)}},tools:{restrict:rule=>{handle.allowed=rule.allow}}});handles.push(handle);return handle
    },async resume(options){return this.create({...options,sessionId:options.resumeSessionId,seed:saved.get(String(options.resumeSessionId))})}},
  }
  const nativeRecords=new Map();let nativeCid=900
  const attachments={freeze:()=>[]},blog={list:async()=>({items:[{cid:337,title:'现有文章'}]}),get:async id=>structuredClone(nativeRecords.get(id)),async call(action,args){if(action==='status')return{nativeDrafts:true};assert.equal(action,'save');const id=args.base?.savedDraft?.cid??nativeCid++,snapshot={published:null,savedDraft:{...args.content,cid:id},version:String(nativeCid),selectedVariant:'savedDraft'};nativeRecords.set(id,snapshot);return{cid:id,snapshot}}}
  const jobs=new BlogJobs(ctx,access,store,blog,attachments,3000),app=new BlogApplication(store,access,blog,null,null,jobs,attachments,pending)
  const chat=new BlogChat(ctx,access,store,index,attachments,jobs,app,sdk,3000,occupancy)
  /**
   * 标题订阅的**唯一**持有者：运行时的 `ConversationLifecycle`。
   *
   * ⚠️ 这是 P7 的一处**装配形状变化**，夹具必须照生产来：`BlogChat` 自本批起**不再自己订阅**
   * 标题（它只交出投递口 `chat.titleSink`），订阅由运行时的生命周期注册（`registerConversationTitles`），
   * 装配侧用 `titleSink: chat.titleSink` 把投递口接上去（`src/index.ts` 的同名那一行）。
   *
   * ⇒ 页面路径的夹具也**必须**有一个生命周期，否则 `session/title` 事件**没有任何订阅者**：
   * 迟到的官方标题不生效、`changed` 一次都不广播 —— 这正是"声明了却零接线"在夹具里的同一形状，
   * 而不是产品缺陷（生产侧那一行由 `createAgentRuntime` 做）。
   */
  const lifecycle=new ConversationLifecycle({ctx,definition:{id:'blog'},access,store:indexDb.conversations,allowedTools:()=>[],config:{routePrefix:'/blog',turnTimeoutMs:3000,authRecheckMs:1000,maxActiveConversations:4,reasoningEffort:''}})
  const uninstallTitle=installTitleDelivery('blog',chat.titleSink)
  t.after(async()=>{releaseOpen?.();releaseFlush?.();for(const release of releaseGates)release();await chat.close();await jobs.close();uninstallTitle();await lifecycle.dispose();for(const dispose of disposers.reverse())await dispose?.();store.close();await runtimeJobs.dispose();await registry.dispose()})
  const conversation=await chat.create(actor,'conversation-123')
  return{root,ctx,store,index,indexDb,lifecycle,chat,handles,tools,blog,feedbackCalls,conversation,releaseOpen,releaseFlush,
    holdModel(method){const target=method==='resolveCallConfig'?ctx.llm:ctx.sessionController,original=target[method],entered=Promise.withResolvers(),gate=Promise.withResolvers();releaseGates.push(gate.resolve);target[method]=async(...args)=>{entered.resolve();await gate.promise;return original.apply(target,args)};return{entered:entered.promise,release:gate.resolve}},
    holdNextFlush(){let release;nextFlushGate=new Promise(r=>{release=r});releaseGates.push(release);return release},revoke(){revoked=true},send:(extra={})=>chat.send(actor,{conversationId:conversation.id,requestId:'request-123',text:'看看博客最近情况',research:true,...extra})}
}

test('official first-prompt titles update after the answer closes and never overwrite a manual name',async t=>{
  const f=await fixture(t)
  await f.send();await tick()
  const h=f.handles[0]
  h.emit('turn/end',{turn:'title-test',reason:{kind:'completed'}})
  await tick()
  assert.equal(f.chat.active.size,0)
  const data={title:'博客近况与文章整理',messageSeqs:[0],source:{kind:'provider',provider:'first-prompt-llm'}}
  h.emit('session/title',data)
  assert.equal((await f.chat.list(actor,0,'博客近况')).items[0].title,data.title)
  await f.chat.mutate(actor,{operation:'rename',ids:[f.conversation.id],title:'我的博客备忘'})
  h.emit('session/title',{...data,title:'迟到的自动标题'})
  assert.equal((await f.index.get(owner,f.conversation.id)).title,'我的博客备忘')
  h.emit('session/title',{title:'宿主再次手动更名',messageSeqs:[],source:{kind:'user'}})
  assert.equal((await f.index.get(owner,f.conversation.id)).title,'宿主再次手动更名')
  f.root.emit('session/event',{id:'another-plugin-session'},{type:'session/title',data})
  assert.equal((await f.chat.list(actor,0,'')).items.length,1)
})

test('title broadcasts happen exactly when the index accepts the write (M21 regression guard)',async t=>{
  // 设计 §10.1 点名要求的那条：**广播次数**断言。既有的标题用例只看"标题有没有写进索引"，
  // 它订阅不到 `changed`，所以**抓不住"总是广播"**——而那正是 `syncTitle` 一旦异步化之后的
  // 静默退化形态（返回值变恒真的 Promise ⇒ 守卫挡住也照样广播 ⇒ 页面无谓刷新）。
  const f=await fixture(t)
  await f.send();await tick()
  const h=f.handles[0]
  h.emit('turn/end',{turn:'title-broadcast',reason:{kind:'completed'}})
  await tick()
  let changed=0
  const unsubscribe=f.chat.subscribe(actor,f.conversation.id,value=>{if(value.type==='changed')changed++},()=>{})
  const data={title:'广播次数用例标题',messageSeqs:[0],source:{kind:'provider',provider:'first-prompt-llm'}}
  // ① 守卫接受 ⇒ 恰好广播一次。
  h.emit('session/title',data)
  // ⚠️ 广播现在晚**一个微任务**：订阅回调里的归属校验要 `await`（索引已切 PG），见
  // `BlogChat.subscribe` 的注释。多等一拍不改变被断言的东西（次数），少了它这条会以"0 次"红。
  await tick()
  assert.equal(changed,1,'标题写入被接受时必须广播一次')
  // ② 无关会话：绝不广播到本会话。
  f.root.emit('session/event',{id:'another-plugin-session'},{type:'session/title',data})
  await tick()
  assert.equal(changed,1,'无关会话的标题不该广播到本会话')
  // ③ **改坏就会红的那一条**：手动标题之后，迟到的自动标题会被索引的守卫挡住（`changes=0`），
  //    所以**不该**广播。把广播判据改成恒真（例如让 `syncTitle` 返回 true 或一个 Promise），
  //    这里会变成 1 ⇒ 红。
  await f.chat.mutate(actor,{operation:'rename',ids:[f.conversation.id],title:'手动名'})
  // ⚠️ 重置计数**之前**必须先把 mutate 自己那次广播落地：广播回调现在晚一个微任务
  //（`subscribe` 里的归属校验要 await），而"重置"与它同在一轮微任务里 ⇒ 少等这一拍，
  // 残留的 1 会被算进下面那条"守卫挡住 ⇒ 不广播"的断言（实测就是这样红的）。
  await tick()
  changed=0
  h.emit('session/title',{...data,title:'迟到的自动标题'})
  // ⚠️ 这一拍**不能省**：少了它，`changed` 恒为 0，而"0"在这里既是期望值也是"回调还没跑"，
  // 于是这条守卫断言变成**假绿**（改坏实现也照样过）。广播回调现在晚一个微任务（见 `subscribe`）。
  await tick()
  assert.equal(changed,0,'被守卫挡住的标题不该广播')
  // ④ 可信用户改名（source.kind==='user'）能改写入 ⇒ 仍要广播。
  h.emit('session/title',{title:'宿主再次手动更名',messageSeqs:[],source:{kind:'user'}})
  await tick()
  assert.equal(changed,1,'可信用户改名被接受时必须广播')
  unsubscribe()
})

test('sending after model validation preserves titles changed while validation was waiting',async t=>{
  for(const source of ['manual','provider'])await t.test(source,async t=>{
    const f=await fixture(t)
    await f.send();await tick();complete(f.handles[0]);await tick()
    const gate=f.holdModel('resolveCallConfig')
    const sending=f.send({requestId:'title-after-validation',modelSelection:{provider:'glm-fixture',model:'vision'}})
    await gate.entered
    const title=source==='manual'?'等待选模时手动保存的标题':'迟到的官方博客标题'
    if(source==='manual')await f.chat.mutate(actor,{operation:'rename',ids:[f.conversation.id],title})
    else f.handles[0].emit('session/title',{title,messageSeqs:[0],source:{kind:'provider',provider:'first-prompt-llm'}})
    assert.equal((await f.chat.list(actor,0,'')).items[0].title,title)
    gate.release();await sending;await tick()
    assert.equal((await f.chat.list(actor,0,'')).items[0].title,title)
  })
})
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
  const original=structuredClone(f.handles[0].events),before=f.index.record(ownerActor(owner),id),handles=f.handles.length
  const preview=await p.preview(actor,id)
  assert.ok(preview.messages.some(m=>m.text==='看看博客最近情况'))
  assert.ok(!JSON.stringify(preview).includes('MODEL-ONLY-FROZEN-ATTACHMENT'))
  assert.deepEqual(f.index.record(ownerActor(owner),id),before);assert.equal(f.handles.length,handles)
  await assert.rejects(p.preview({...actor,userId:'another'},id),e=>e.status===404)
  await f.chat.app.operationInsert({id:'pending',owner,draftId:'draft',revision:1,status:'prepared',expiresAt:Date.now()+60000,chat:{conversationId:id}})
  assert.equal((await p.list(actor,query)).items[0].canRemove,false)
  assert.equal((await p.remove(actor,[id])).results[0].status,'blocked')
  await f.chat.app.operationSave('pending',{status:'cancelled',chat:{conversationId:id}})
  assert.equal((await p.remove(actor,[id])).results[0].status,'removed')
  assert.equal((await p.remove(actor,[id])).results[0].status,'alreadyRemoved')
  assert.equal((await p.list(actor,query)).total,0)
  assert.deepEqual(f.handles[0].events,original)
})

test('publish tool prepares a private confirmation card; candidate is applied only after user confirmation',async t=>{
  const f=await fixture(t),draft=await f.store.create(owner,{title:'测试文章',text:'原文'}),proposal=await f.store.propose(owner,draft.id,1,{text:'候选正文'},[])
  let writes=0
  f.blog.call=async(action,args)=>{assert.equal(action,'save');assert.equal(args.content.text,'候选正文');writes++;return{cid:338,url:'https://example.test/338',snapshot:{version:'v2',published:{cid:338}}}}
  await f.send();await tick();const h=f.handles[0]
  const execute=args=>f.tools.get('blog_publish_draft').execute(args,{agent:h.agent})
  const args={draftId:draft.id,proposalId:proposal.id},prepared=await execute(args)
  assert.equal(writes,0);assert.equal((await f.store.get(owner,draft.id)).text,'原文');assert.equal(prepared.nonce,undefined)
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
  assert.equal((await f.store.get(owner,draft.id)).text,'候选正文');assert.equal((await f.store.get(owner,draft.id)).proposal,null)
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
  const card=(await f.chat.history(actor,f.conversation.id)).operations[0],draft=(await f.store.list(owner))[0]
  assert.equal(card.after.text,'保存稿正文');assert.equal(card.before.text,'公开正文')
  const request={conversationId:f.conversation.id,id:card.id,nonce:card.nonce,operation:'confirm'}
  await assert.rejects(f.chat.operationAction(actor,request),/消费现有博客保存稿/);assert.equal(writes,0)
  const confirming=f.chat.operationAction(actor,{...request,consumeSavedDraft:true});await tick()
  await assert.rejects(f.chat.app.prepare(actor,{id:draft.id,revision:1,mode:'publish'}),/提交待核对/)
  await f.store.save(owner,draft.id,1,{text:'请求期间继续手写'})
  release();assert.equal((await confirming).status,'succeeded');assert.equal(writes,1)
  assert.equal((await f.store.get(owner,draft.id)).text,'请求期间继续手写')
  assert.equal((await f.chat.history(actor,f.conversation.id)).operations[0].after.text,'保存稿正文')
})

test('confirmation rejects replaced proposals, another conversation, expired cards and revoked actors',async t=>{
  const f=await fixture(t),draft=await f.store.create(owner,{title:'标题',text:'原文'}),proposal=await f.store.propose(owner,draft.id,1,{text:'待发布'},[])
  let writes=0;f.blog.call=async()=>{writes++;throw new Error('must not execute')}
  await f.send();await tick();const h=f.handles[0]
  const prepared=await f.tools.get('blog_publish_draft').execute({draftId:draft.id,proposalId:proposal.id},{agent:h.agent})
  complete(h);await tick()
  const card=(await f.chat.history(actor,f.conversation.id)).operations[0],request={conversationId:f.conversation.id,id:prepared.id,nonce:card.nonce,operation:'confirm'}
  const other=await f.chat.create(actor,'another-conversation')
  await assert.rejects(f.chat.operationAction(actor,{...request,conversationId:other.id}),/不属于/)
  await f.store.propose(owner,draft.id,1,{text:'新的候选'},[])
  await assert.rejects(f.chat.operationAction(actor,request),/候选稿已变化/)
  const op=await f.chat.app.operation(owner,prepared.id);op.expiresAt=0;await f.chat.app.operationSave(op.id,op)
  await assert.rejects(f.chat.operationAction(actor,request),/失效/)
  f.revoke();await assert.rejects(f.chat.operationAction(actor,request),/revoked/)
  assert.equal(writes,0)
})

test('delete confirmation preserves local copies and reconciles an uncertain remote result without another delete',async t=>{
  const f=await fixture(t),remote={version:'v1',published:{cid:338,title:'删除目标',text:'正文',type:'post'},savedDraft:{cid:339,title:'保存稿',text:'草稿',type:'post_draft'}}
  const draft=await f.store.create(owner,{title:'本地副本',text:'本地正文'},remote);let deletes=0
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
  assert.equal(deletes,1);assert.equal((await f.store.get(owner,draft.id)).text,'本地正文');assert.equal((await f.store.get(owner,draft.id)).remote.deleted,true)
  await assert.rejects(f.chat.app.prepare(actor,{id:draft.id,revision:2,mode:'publish'}),/原文已删除/)
})

test('cancelled cards cannot execute and unsupported bridges never prepare deletion',async t=>{
  const f=await fixture(t),draft=await f.store.create(owner,{title:'标题',text:'正文'})
  f.blog.call=async()=>({deleteArticle:false})
  await f.send();await tick();const h=f.handles[0]
  await assert.rejects(f.tools.get('blog_delete_post').execute({cid:338},{agent:h.agent}),/先更新/)
  await f.tools.get('blog_publish_draft').execute({draftId:draft.id},{agent:h.agent});complete(h);await tick()
  const card=(await f.chat.history(actor,f.conversation.id)).operations[0],request={conversationId:f.conversation.id,id:card.id,nonce:card.nonce}
  assert.equal((await f.chat.operationAction(actor,{...request,operation:'cancel'})).status,'cancelled')
  await assert.rejects(f.chat.operationAction(actor,{...request,operation:'confirm'}),/查询回执/)
})

test('history actions refuse active and finishing conversations before changing any selected row',async t=>{
  const f=await fixture(t),idle=await f.chat.create(actor,'history-idle')
  await f.send();await tick()
  for(const operation of ['rename','pin'])await assert.rejects(f.chat.mutate(actor,{operation,ids:[f.conversation.id],title:'不应改名',pinned:true}),e=>e.status===409)
  await assert.rejects(f.chat.mutate(actor,{operation:'delete',ids:[idle.id,f.conversation.id]}),e=>e.status===409)
  assert.equal((await f.index.get(owner,idle.id)).deletedAt,null)
  const release=f.holdNextFlush(),stopping=f.chat.stop(actor,f.conversation.id);await tick()
  await assert.rejects(f.chat.mutate(actor,{operation:'delete',ids:[f.conversation.id]}),e=>e.status===409)
  release();await stopping
  assert.deepEqual(await f.chat.mutate(actor,{operation:'rename',ids:[f.conversation.id],title:'保留的历史'}),{ok:true})
  assert.equal((await f.chat.list(actor,0,'保留的历史')).items[0].id,f.conversation.id)
})

test('fork source is protected during historical reads and both source and child remain protected until durable',async t=>{
  let releaseRead=()=>{};t.after(()=>releaseRead())
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const persistence=f.chat.ctx.sessionPersistence,open=persistence.open
  const readGate=new Promise(r=>{releaseRead=r})
  persistence.open=async(...args)=>{await readGate;return open(...args)}
  const pending=f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'history-fork'})
  await tick()
  await assert.rejects(f.chat.mutate(actor,{operation:'rename',ids:[f.conversation.id],title:'分支期间'}),e=>e.status===409)
  const releaseFlush=f.holdNextFlush();releaseRead();await tick()
  const child=(await f.chat.list(actor)).items.find(c=>c.id!==f.conversation.id)
  assert.ok(child)
  for(const id of [f.conversation.id,child.id])await assert.rejects(f.chat.mutate(actor,{operation:'delete',ids:[id]}),e=>e.status===409)
  releaseFlush();await pending
  assert.equal(f.chat.forkSources.size,0)
  const original=structuredClone(f.handles[0].events);let ended=0,changed=0
  const unsubscribe=f.chat.subscribe(actor,f.conversation.id,()=>{changed++},()=>{ended++})
  await f.chat.mutate(actor,{operation:'delete',ids:[f.conversation.id]})
  assert.equal(ended,1);assert.equal(changed,0);unsubscribe()
  await assert.rejects(f.chat.history(actor,f.conversation.id),e=>e.status===404)
  await assert.rejects(f.chat.create(actor,'conversation-123'),e=>e.status===404)
  assert.deepEqual(f.handles[0].events,original)
  assert.equal((await f.chat.history(actor,child.id)).messages.at(-1).id,'answer-1')
  await f.chat.mutate(actor,{operation:'delete',ids:[child.id]})
  await assert.rejects(f.chat.create(actor,'history-fork'),e=>e.status===404)
})

test('chat search tools preserve structured dates and return lossless imported draft references',async t=>{
  const f=await fixture(t),draft=await f.store.create(owner,{title:'时间检索稿'},{published:{cid:338}})
  await f.chat.app.applyResult({id:'delete-338',owner,mode:'delete',before:{published:{cid:338}}},{deleted:true})
  let received;f.blog.search=async args=>{received=args;return {items:[],hasMore:false}}
  await f.send();await tick();const agent=f.handles[0].agent
  const args={period:'yesterday',title:'测试',category:'摘抄笔记',page:2}
  await f.tools.get('blog_search_posts').execute(args,{agent});assert.deepEqual(received,args)
  const result=await f.tools.get('blog_list_drafts').execute({title:'时间检索稿'},{agent})
  assert.equal(result.items.length,0);assert.deepEqual(received,{title:'时间检索稿',status:'draft'})
  assert.deepEqual(result,JSON.parse(JSON.stringify(result)))
})

test('separate chat operations reuse the same imported version without losing a candidate',async t=>{
  const f=await fixture(t)
  f.blog.get=async()=>({published:{cid:338,title:'原文',text:'正文',slug:'338',format:'markdown',tags:[],categories:[]},savedDraft:null,version:'v'})
  await f.send();await tick()
  const tool=f.tools.get('blog_select_draft'),args={cid:338,variant:'published'}
  const first=await tool.execute(args,{agent:f.handles[0].agent})
  assert.deepEqual(first,JSON.parse(JSON.stringify(first)),'selected draft without an explicit comment setting must remain lossless JSON')
  const proposal=await f.store.propose(owner,first.draftId,first.revision,{text:'保留候选'},[])
  complete(f.handles[0]);await tick()
  await f.send({requestId:'request-second',text:'继续修改该文章'});await tick()
  const next=await tool.execute(args,{agent:f.handles.at(-1).agent})
  assert.deepEqual(next,JSON.parse(JSON.stringify(next)))
  assert.equal(next.draftId,first.draftId);assert.equal(next.proposalId,proposal.id)
  assert.equal((await f.store.list(owner)).length,1)
})

test('article tools preserve explicit false and omit unavailable optional values',async t=>{
  const f=await fixture(t),draft=await f.store.create(owner,{allowComment:false})
  await f.send();await tick();const execution={agent:f.handles[0].agent}
  const selected=await f.tools.get('blog_select_draft').execute({draftId:draft.id},execution)
  assert.equal(selected.allowComment,false);assert.deepEqual(selected,JSON.parse(JSON.stringify(selected)))
  for(const allowComment of [undefined,0]){
    f.blog.get=async()=>({published:{cid:338,title:'原文',text:'正文',format:'markdown',tags:[],categories:[],...(allowComment===undefined?{}:{raw:{allowComment}})},savedDraft:null})
    const read=await f.tools.get('blog_read_post').execute({cid:338},execution)
    assert.deepEqual(read,JSON.parse(JSON.stringify(read)))
    assert.equal(Object.hasOwn(read.published,'allowComment'),allowComment!==undefined)
    if(allowComment!==undefined)assert.equal(read.published.allowComment,false)
    assert.equal(Object.hasOwn(read.published,'url'),false)
  }
})

test('concurrent conversations sharing an import cannot replace each others candidates',async t=>{
  const f=await fixture(t)
  f.blog.get=async()=>({published:{cid:338,title:'原文',text:'正文',slug:'338',format:'markdown',tags:[],categories:[]},savedDraft:null,version:'v'})
  const second=await f.chat.create(actor,'conversation-second')
  await f.send();await f.send({conversationId:second.id,requestId:'request-second'});await tick()
  const select=f.tools.get('blog_select_draft'),propose=f.tools.get('blog_propose'),args={cid:338,variant:'published'}
  const a=await select.execute(args,{agent:f.handles[0].agent}),b=await select.execute(args,{agent:f.handles[1].agent})
  assert.equal(a.draftId,b.draftId)
  const first=await propose.execute({text:'先完成候选'},{agent:f.handles[0].agent})
  await assert.rejects(propose.execute({text:'后完成候选'},{agent:f.handles[1].agent}),/候选稿已被其他任务更新/)
  assert.equal((await f.store.get(owner,a.draftId)).proposal.id,first.proposalId)
  const continued=await propose.execute({text:'同一任务继续调整'},{agent:f.handles[0].agent})
  assert.equal((await f.store.get(owner,a.draftId)).proposal.id,continued.proposalId)
})

test('chat starts without an article, preserves native history, resumes and deduplicates network requests',async t=>{
  const f=await fixture(t),request=await f.send();await tick()
  assert.equal((await f.store.list(owner)).length,0);assert.equal(f.handles.length,1)
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
  await f.store.save(owner,first.draftId,first.revision,{text:'手写内容'})
  await assert.rejects(execute('blog_propose',{text:'迟到的候选'}),/手动修改/)
  complete(h);await tick()
  await f.send({requestId:'request-retry',retryFrom:request.id,text:'重新给出候选'});await tick()
  const next=await f.tools.get('blog_select_draft').execute({newArticle:true},{agent:f.handles[1].agent})
  assert.equal(next.draftId,first.draftId);assert.equal(next.text,'手写内容');assert.equal((await f.store.list(owner)).length,1)
  const cards=(await f.index.results(owner,f.conversation.id));assert.equal(cards[0].proposal.fields.text,'第一版')
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
  const f=await fixture(t,{delayedOpen:true}),original=await f.send();await tick()
  let stopped=false;const stopping=f.chat.stop(actor,f.conversation.id).then(()=>{stopped=true})
  await tick();assert.equal(stopped,false)
  await assert.rejects(f.send({requestId:'request-456'}),/对话|上一轮/)
  f.releaseOpen();await stopping;assert.equal(f.handles[0].disposed,true);assert.equal(f.handles[0].message,undefined)
  assert.equal(f.chat.active.size,0)
  assert.equal((await f.index.get(owner,f.conversation.id)).ready,true)
  await f.send({requestId:'request-after-stop'});await tick();assert.equal(f.handles[1].options.resumeSessionId,f.conversation.id)
  await f.chat.settleAccepted(actor,f.conversation.id,original.id)
  assert.equal(f.chat.active.size,1);assert.equal(f.handles[1].cancelled,false);assert.equal(f.handles[1].disposed,false)
})

/**
 * ⚠️ **用例名变更登记（2026-09-17，期级评审判）**：原名
 * `participant revocation waits for original Agent creation and durability before rejecting`
 * 里的 **"and durability" 已不再成立**，故去掉。
 * **依据**：**载体切换**（页面路径 → 运行时入口）之后，撤销复查**紧跟 `agents.create` 就发生**，
 * 这一轮**走不到持久化检查点**（详见本用例中段的**行为差异登记**，
 * 以及 `packages/runtime/src/conversation.ts` 中 `open()` 的那条复查）。
 * **理由**：**一个断言了系统已不再具备的行为的用例名，就是套件里的一句假话**，会误导评审。
 * 新名字表达**被保留下来的两条语义**：①撤销不打断**进行中**的 Agent 创建；②**在开任何回合之前**就被拒绝。
 */
test('participant revocation does not interrupt an in-flight Agent creation and is rejected before any turn starts',async t=>{
  const f=await fixture(t,{delayedOpen:true,delayedFlush:true})
  const participant=createBlogParticipant({
    access:f.chat.access,chat:f.chat,index:f.index,storage:f.store,routePrefix:'/blog',
    // 运行时入口要**宿主的两个面**（旧的 `createBlogParticipant` 只要业务替身）：
    // `ctx` 是夹具那个近真假宿主，`database` 是运行时的存储端口（内存会话/轮次端口）。
    // 旧的 `index` 仍然收（投影按会话读产出记录要用它）——两者不是一回事，见 harness 的文件头。
    ctx:f.ctx ?? f.root,database:f.indexDb,lifecycle:f.lifecycle,
  })
  let settled=false
  const running=participant.run({actor,missionId:'mission-revoked',requestId:'request-revoked',message:'查询博客',signal:new AbortController().signal,onProgress(){}})
  const rejected=assert.rejects(running,/revoked/).then(()=>{settled=true})
  await tick()
  /**
   * ⚠️ **占用改读运行时，不再读 `chat.active`**（P7 入口改造后的形状变化，见 harness 文件头）：
   * 协作路径的句柄由 `lifecycle.open()` 建，而 `BlogChat` 的绑定**不进 `chat.active`** ——
   * `chat.ts` 在 `active` 的声明处写死了这件事："绑定不进 `this.active`：这一轮的占用与收尾
   * 归运行时（`lifecycle`），本类的 `active` 只装**页面路径**自己驱动的轮次"。
   * ⇒ 读 `chat.active` 拿到的是**空表**（旧写法在这里解构出 `undefined`，报
   * `TypeError: undefined is not iterable`）。运行时的**同源**读法是 `busyIds()`：
   * "活跃 ∪ 正在打开 ∪ 正在分支"，与 `isBusy()` 同一个判据（`conversation.ts` 里两者相邻且有注释说明）。
   */
  const [conversationId]=f.lifecycle.busyIds()
  assert.ok(conversationId,'运行时必须已把该会话登记为在飞（此刻正卡在 `agents.create` 上）')
  /**
   * 旧写法在这里调 `f.chat.settleAccepted(外来 actor, …)` 并断言 `b.stopped===false`。
   * 那两样都**只存在于页面路径**：`settleAccepted` 的实现第一步就是 `this.active.get(conversationId)`，
   * `b.stopped` 也是页面路径那个 `Turn` 的字段 ⇒ 对协作路径**恒为空操作/无对应物**。
   * 同一语义（"外来身份不能停掉这一轮"）在新架构里由运行时的 `cancel(id, actor)` 负责
   * （它先 `access.assert` 再 `assertConversation`），属**另一条**覆盖面，本用例不代它断言。
   */
  f.revoke()
  await tick()
  /* ① 创建完成前：撤销**不得**让这一轮提前拒绝 —— 这是本用例的核心语义，必须保留。 */
  assert.equal(settled,false);assert.ok(f.lifecycle.busyIds().includes(conversationId));assert.equal(f.handles.length,0)
  f.releaseOpen()
  /**
   * ② ⚠️ **行为差异登记（期级评审请重点看这一条）**：旧页面路径把**持久化检查点**也纳入撤销复查
   * ——"Agent 创建**与**一次持久化检查点都完成"之后才复查身份，所以旧注释的措辞是
   * "creation **and durability**"。运行时**复查得更早**：`lifecycle.open()` 在
   * `await agents.create` **之后紧接着**就复查身份
   * （`packages/runtime/src/conversation.ts` 里 `open()` 的那条 `this.host.access.assert(actor)`，
   * 即 TOCTOU 守卫）⇒ 这一轮**根本走不到持久化检查点**就带着 `/revoked/` 拒绝了，
   * 旧的第 ②③ 两步在这里合并成一步，`f.releaseFlush()` 已经没有人在等它。
   *
   * **我的判断**：就"不给已撤销的身份继续做事"这一点而言，**更早复查 = 更早 fail-closed，是更严的**
   * —— 它不必先替一个身份已经失效的轮次**完成一次持久化**，就把这轮打住。
   *
   * ⚠️ **但随之而来有一个窗口问题，必须一并记下**：**复查通过之后、持久化之前**若发生撤销，
   * **这一层不再兜**（运行时在那个窗口里不会再查一次身份）。
   * **该窗口是否有补偿守卫，需期级评审确认**——我**没有**核查运行时以外的其它层，
   * 因此**不断言"别处一定兜住了"**。这一条是留给评审的**核对项**，不是本用例要解决的问题。
   *
   * **被保留下来的语义**（①）仍然成立，而且它才是这个用例真正的价值：
   * **撤销不能打断正在进行中的 Agent 创建。**
   */
  await rejected
  assert.equal(f.handles[0].disposed,true,'拒绝之后运行时必须已经收尾掉那个句柄')
  assert.equal(f.handles[0].message,undefined,'被撤销的那一轮不得再给 Agent 补发消息')
  assert.equal(f.lifecycle.busyIds().includes(conversationId),false,'拒绝之后占用必须释放')
  f.releaseFlush()
  /**
   * ③ 旧写法在这里断言"业务索引里那条请求的状态为 `interrupted`"。运行时**没有对应物**：
   * 这一轮在 `lifecycle.open()` 的身份复查处就被拒绝，**压根没有 claim 过轮次行**
   * （`turnsOf` 为空、`turnStatus('request-revoked')` 为 `undefined`）。
   * **登记为"仅旧入口成立"**：新架构里"轮次行的 claim / 收尾"由运行时的轮次端口负责
   * （夹具是 `MemoryTurnStore`，生产是 `dsh_turns`），而**本路径下它从未开始**。
   * 换上的可观测断言比旧断言更强：**被拒绝的那一轮不得留下半写的轮次行。**
   */
  assert.deepEqual(await f.indexDb.turns.turnsOf(owner,conversationId),[],'被拒绝的那一轮不得留下半写的轮次行')
  assert.equal(await f.indexDb.turns.turnStatus(owner,'request-revoked'),undefined)
  assert.equal(f.chat.listeners.size,0,'协作路径不得在页面路径的订阅表上留下东西')
})

test('stopping during first durability checkpoint never follows up or registers a new Job',async t=>{
  const f=await fixture(t,{delayedFlush:true});await f.send();await tick()
  const stop=f.chat.stop(actor,f.conversation.id);await tick();f.releaseFlush();await stop;await tick()
  assert.equal(f.handles[0].message,undefined);assert.equal(f.handles[0].disposed,true);assert.equal(f.chat.active.size,0)
})

test('missing durability participation fails the turn before any model request',async t=>{
  const f=await fixture(t,{noPersistence:true}),request=await f.send();await tick()
  assert.equal((await f.index.request(owner,request.id)).status,'failed');assert.equal(f.handles[0].message,undefined)
  assert.equal((await f.index.get(owner,f.conversation.id)).ready,false)
})

test('an unpublished durable session is recovered by lifecycle, while a replaced lifecycle is rejected',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  await f.index.save(owner,f.conversation.id,{ready:false})
  const history=await f.chat.history(actor,f.conversation.id);assert.equal(history.messages.at(-1).id,'answer-1')
  await f.send({requestId:'request-resume'});await tick();assert.equal(f.handles[1].options.resumeSessionId,f.conversation.id)
  await f.chat.stop(actor,f.conversation.id)
  await f.index.save(owner,f.conversation.id,{ready:false,sessionCreatedAt:1})
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
  assert.equal(same.draftId,selected.draftId);assert.equal((await f.store.list(owner)).length,1)
  complete(f.handles[2],'answer-3');await tick()
  await f.send({requestId:'another-operation'});await tick()
  f.blog.get=async()=>({published:{...source,text:'x'.repeat(120001)}})
  await assert.rejects(f.tools.get('blog_select_draft').execute({cid:42,variant:'published'},{agent:f.handles[3].agent}),/正文过长/)
  assert.equal((await f.store.list(owner)).length,1)
  let release;f.blog.get=()=>new Promise(r=>{release=r})
  const abort=new AbortController(),pending=f.tools.get('blog_select_draft').execute({cid:42,variant:'published'},{agent:f.handles[3].agent,signal:abort.signal})
  await tick();abort.abort();release({published:source});await assert.rejects(pending);assert.equal((await f.store.list(owner)).length,1)
})

test('native draft receipt survives failed logical binding and retry reuses the same article',async t=>{
  const f=await fixture(t);await f.send();await tick()
  const update=f.index.updateRequest.bind(f.index);let fail=true
  f.index.updateRequest=(o,id,patch)=>{if(patch.draftId&&fail){fail=false;throw new Error('injected binding write failure')}return update(o,id,patch)}
  const execute=()=>f.tools.get('blog_select_draft').execute({newArticle:true},{agent:f.handles[0].agent})
  await assert.rejects(execute(),/injected/);assert.equal((await f.store.list(owner)).length,1);assert.ok((await f.store.get(owner,(await f.store.list(owner))[0].id)).blogNative)
  const selected=await execute();assert.ok(selected.draftId);assert.equal((await f.store.list(owner)).length,1)
})

test('image model survives removed selection, native history reopening and branch continuation',async t=>{
  const f=await fixture(t),chat=f.chat
  chat.jobs.models={text:{provider:'glm-fixture',model:'text'},vision:{provider:'glm-fixture',model:'vision'}}
  chat.ctx.llm.resolveModelInfo=async(provider,model)=>{assert.ok(['test','glm-fixture'].includes(provider));return{inputModalities:model==='vision'?['text','image']:['text']}}
  await f.send();await tick();assert.equal(f.handles[0].options.agentOptions.model,'test');complete(f.handles[0],'text-answer');await tick()
  chat.attachments.freeze=()=>[{id:'image-fixture',version:1,name:'image',image:{provider:'fixture',attachmentId:'image'}}]
  await f.send({requestId:'image-request',modelSelection:{provider:'glm-fixture',model:'vision'}});await tick();assert.equal(f.handles[1].options.agentOptions.model,'vision');complete(f.handles[1],'image-answer');await tick()
  chat.attachments.freeze=()=>[]
  await f.send({requestId:'text-after-image'});await tick();assert.equal(f.handles[2].options.agentOptions.model,'vision');complete(f.handles[2],'continued-answer');await tick()
  const branch=await chat.fork(actor,{conversationId:f.conversation.id,messageId:'continued-answer',requestId:'image-fork'})
  assert.equal(f.handles[3].options.agentOptions.model,'vision')
  await chat.close()
  const reopened=new BlogChat(chat.ctx,chat.access,chat.storage,chat.index,chat.attachments,chat.jobs,chat.app,chat.sdk,3000)
  t.after(()=>reopened.close())
  await reopened.send(actor,{conversationId:branch.id,requestId:'reopened-image-followup',text:'继续看前面的图',research:false})
  await tick();assert.equal(f.handles[4].options.agentOptions.model,'vision')
  assert.equal(chat.ctx.agentDefaultModel.currentSelection().model,'vision')
  complete(f.handles[4],'branch-answer');await tick()
})

test('new text chats follow the framework default while reopening and branching preserve their recorded model',async t=>{
  const f=await fixture(t),chat=f.chat
  chat.jobs.models={text:{provider:'dedicated',model:'writing'}}
  await f.send();await tick();assert.equal(f.handles[0].options.agentOptions.model,'test');complete(f.handles[0]);await tick()
  chat.ctx.agentDefaultModel.currentSelection=()=>({provider:'new-provider',model:'new-model'})
  await chat.close()
  const reopened=new BlogChat(chat.ctx,chat.access,chat.storage,chat.index,chat.attachments,chat.jobs,chat.app,chat.sdk,3000)
  t.after(()=>reopened.close())
  await reopened.send(actor,{conversationId:f.conversation.id,requestId:'resume-default-model',text:'继续',research:false})
  await tick();assert.equal(f.handles[1].options.agentOptions.model,'test');complete(f.handles[1],'old-answer');await tick()
  await reopened.fork(actor,{conversationId:f.conversation.id,messageId:'old-answer',requestId:'model-branch'})
  assert.equal(f.handles[2].options.agentOptions.model,'test')
  const fresh=await reopened.create(actor,'new-model-conversation')
  await reopened.send(actor,{conversationId:fresh.id,requestId:'fresh-default-model',text:'新对话',research:false})
  await tick();assert.equal(f.handles[3].options.agentOptions.model,'new-model');complete(f.handles[3],'new-answer');await tick()
})

test('history waits for a pending fork checkpoint instead of publishing ready from stat',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const release=f.holdNextFlush(),fork=f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'fork-delayed'})
  await tick();const id=String(f.handles[1].agent.id);assert.equal((await f.index.get(owner,id)).ready,false)
  let read=false;const history=f.chat.history(actor,id).then(result=>{read=true;return result})
  await tick();assert.equal(read,false);assert.equal((await f.index.get(owner,id)).ready,false)
  release();await fork;assert.equal((await history).messages.at(-1).id,'answer-1');assert.equal((await f.index.get(owner,id)).ready,true)
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
  const branch=(await f.index.list(owner,0)).items.find(c=>c.id!==f.conversation.id)
  assert.equal((await f.index.get(owner,branch.id)).ready,false)
})


test('unsupported image model blocks submission before request creation and preserves attachments',async t=>{
  const f=await fixture(t);f.chat.attachments.freeze=()=>[{id:'image',image:{attachmentId:'image'}}]
  const capability=await f.chat.imageCapability(actor,f.conversation.id)
  assert.equal(capability.available,false);assert.match(capability.message,/未声明支持图片/)
  await assert.rejects(f.send(),/未声明支持图片/)
  assert.equal(f.handles.length,0);assert.equal((await f.chat.requests(owner,f.conversation.id)).length,0)
  f.chat.jobs.models.vision={provider:'vision-provider',model:'vision'}
  f.chat.ctx.llm.resolveModelInfo=async(p,m)=>({inputModalities:m==='vision'?['text','image']:['text']})
  assert.equal((await f.chat.imageCapability(actor,f.conversation.id)).available,false)
  const modelSelection={provider:'glm-fixture',model:'vision'}
  const selected=await f.chat.imageCapability(actor,f.conversation.id,modelSelection)
  assert.equal(selected.available,true);assert.match(selected.message,/所选模型支持图片/)
  await f.send({modelSelection});await tick();assert.equal(f.handles[0].options.agentOptions.model,'vision')
  assert.ok(f.handles[0].message.content.some(c=>c.type==='image'));complete(f.handles[0]);await tick()
})

test('chat model choices reject foreign owners, stale models and changes during an active answer',async t=>{
  const f=await fixture(t)
  assert.deepEqual((await f.chat.models(actor)).default,{provider:'test',model:'test'})
  await assert.rejects(f.chat.models({...actor,userId:'another'},f.conversation.id),e=>e.status===404)
  await assert.rejects(f.send({modelSelection:{provider:'test',model:'missing'}}),e=>e.status===400)
  assert.equal(f.handles.length,0)
  await f.send({modelSelection:{provider:'test',model:'test'}});await tick()
  await assert.rejects(f.send({requestId:'concurrent-model',modelSelection:{provider:'glm-fixture',model:'vision'}}),e=>e.status===409)
  complete(f.handles[0]);await tick()
  f.chat.ctx.agentDefaultModel.currentSelection=()=>({provider:'glm-fixture',model:'vision'})
  assert.deepEqual((await f.chat.models(actor,f.conversation.id)).selected,{provider:'test',model:'test'})
})


test('conversation management tool prepares a card without nonce and executes only after user confirmation',async t=>{
  const f=await fixture(t);let writes=0
  f.blog.call=async(action,input)=>{if(action==='manage-preview')return{input,title:'测试标签',impact:{relatedCount:2}};assert.equal(action,'manage-write');writes++;return{id:4,kind:'tag'}}
  await f.send();await tick();const result=await f.tools.get('blog_manage_change').execute({kind:'tag',operation:'update',id:4,fields:{name:'新标签'}},{agent:f.handles[0].agent})
  assert.equal(result.requiresUserAction,true);assert.equal(result.nonce,undefined);assert.equal(writes,0)
  complete(f.handles[0]);await tick();const card=(await f.chat.history(actor,f.conversation.id)).operations[0]
  assert.equal(card.management.kind,'tag');assert.equal(card.impact.relatedCount,2);assert.equal(card.canConfirm,true)
  await f.chat.operationAction(actor,{conversationId:f.conversation.id,id:card.id,nonce:card.nonce,operation:'confirm'})
  assert.equal(writes,1)
})

test('default, resumed history and fork keep valid reasoning effort without changing the default',async t=>{
  const f=await fixture(t),pinned={provider:'test',model:'test',reasoningEffort:'high'}
  f.chat.ctx.agentDefaultModel.currentSelection=()=>pinned
  await f.send();await tick();assert.deepEqual(f.handles[0].options.agentOptions,pinned);complete(f.handles[0]);await tick()
  const current={provider:'glm-fixture',model:'vision',reasoningEffort:'low'}
  f.chat.ctx.agentDefaultModel.currentSelection=()=>current
  await f.send({requestId:'reasoning-resume'});await tick();assert.deepEqual(f.handles[1].options.agentOptions,pinned);complete(f.handles[1],'reasoning-answer');await tick()
  await f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'reasoning-answer',requestId:'reasoning-fork'})
  assert.deepEqual(f.handles[2].options.agentOptions,pinned)
  assert.deepEqual(f.chat.ctx.agentDefaultModel.currentSelection(),current)
  assert.ok(f.handles.every(h=>!h.events.some(e=>e.type==='model/selection')))
  await f.send({requestId:'reasoning-explicit',modelSelection:{provider:'glm-fixture',model:'vision'}});await tick()
  assert.deepEqual(f.handles[3].options.agentOptions,{provider:'glm-fixture',model:'vision'})
  assert.deepEqual(f.chat.ctx.agentDefaultModel.currentSelection(),{provider:'glm-fixture',model:'vision'})
});

test('removed defaults and restored historical models fail before Agent creation with no fallback',async t=>{
  const f=await fixture(t)
  f.chat.ctx.agentDefaultModel.currentSelection=()=>({provider:'test',model:'removed'})
  const invalid=await f.send();await tick()
  assert.equal(f.handles.length,0);assert.match((await f.index.request(owner,invalid.id)).message,/不在当前目录/)
  f.chat.ctx.agentDefaultModel.currentSelection=()=>({provider:'test',model:'test'})
  await f.send({requestId:'valid-before-removal'});await tick();complete(f.handles[0]);await tick()
  f.chat.ctx.sessionController.modelCatalog=async()=>({groups:[{id:'glm-fixture',name:'Vision',models:[{id:'vision',name:'Vision'}]}],failures:[]})
  const current={provider:'glm-fixture',model:'vision'};f.chat.ctx.agentDefaultModel.currentSelection=()=>current
  const restored=await f.send({requestId:'removed-history'});await tick()
  assert.equal(f.handles.length,1);assert.match((await f.index.request(owner,restored.id)).message,/不在当前目录/)
  await assert.rejects(f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'removed-history-fork'}),/不在当前目录/)
  assert.equal(f.handles.length,1);assert.deepEqual(f.chat.ctx.agentDefaultModel.currentSelection(),current)
});

for(const method of ['modelCatalog','resolveCallConfig'])test(`revocation during ${method} prevents an implicit Agent start`,async t=>{
  const f=await fixture(t),gate=f.holdModel(method),sent=await f.send(),b=f.chat.active.get(f.conversation.id)
  await gate.entered;f.revoke();gate.release();await b.runPromise
  assert.equal(f.handles.length,0);assert.equal((await f.index.request(owner,sent.id)).status,'failed')
  assert.deepEqual(f.chat.ctx.agentDefaultModel.currentSelection(),{provider:'test',model:'test'})
});

test('a concurrent turn that starts during explicit route validation retains the busy guard',async t=>{
  const f=await fixture(t),gate=f.holdModel('resolveCallConfig')
  const pending=f.send({modelSelection:{provider:'glm-fixture',model:'vision'}})
  const rejected=assert.rejects(pending,/正在回答/)
  await gate.entered;await f.send({requestId:'concurrent-turn'});gate.release();await rejected;await tick()
  assert.equal(f.handles.length,1);assert.equal(f.handles[0].options.agentOptions.model,'test')
  assert.equal(f.handles[0].events.filter(e=>e.type==='model/selection').length,0)
});

// —— `occupancy` 端口（页面侧与运行时侧共用一个会话的接缝）——
// 三条一组：不注入时读数与改造前逐点一致；注入"本会话忙"要挡住并发；注入"别的会话忙"不许误伤。

test('without an occupancy port every busy reading stays exactly as before',async t=>{
  const f=await fixture(t)
  assert.deepEqual([...f.chat.occupancy.busyIds()],[])
  assert.equal(f.chat.occupancy.isBusy(f.conversation.id),false)
  assert.deepEqual([...f.chat.busyIds()],[])
  assert.equal(f.chat.busy(f.conversation.id),false)
  assert.equal(f.chat.busy(f.conversation.id,'local'),false)
  assert.equal((await f.chat.history(actor,f.conversation.id)).busy,false)
  const sent=await f.send();await tick()
  assert.equal(sent.status,'queued')
  assert.deepEqual([...f.chat.busyIds()],[f.conversation.id])
  assert.equal(f.chat.busy(f.conversation.id),true)
  assert.equal(f.chat.busy(f.conversation.id,'local'),true)
  assert.equal((await f.chat.history(actor,f.conversation.id)).busy,true)
  await assert.rejects(f.send({requestId:'while-busy'}),/正在结束上一轮/)
});

test('a conversation occupied on the runtime side is refused with the existing wording and reads busy',async t=>{
  const busy=new Set()
  const f=await fixture(t,{occupancy:{isBusy:id=>busy.has(id),busyIds:()=>[...busy]}})
  busy.add(f.conversation.id)
  await assert.rejects(f.send(),/正在结束上一轮/)
  assert.equal(f.handles.length,0)
  assert.equal(f.chat.busy(f.conversation.id),true)
  assert.equal(f.chat.busy(f.conversation.id,'local'),true)
  assert.deepEqual([...f.chat.busyIds()],[f.conversation.id])
  assert.equal((await f.chat.history(actor,f.conversation.id)).busy,true)
});

test('occupancy recorded for another conversation leaves this conversation usable',async t=>{
  const busy=new Set()
  const f=await fixture(t,{occupancy:{isBusy:id=>busy.has(id),busyIds:()=>[...busy]}})
  const other=await f.chat.create(actor,'conversation-other')
  assert.notEqual(other.id,f.conversation.id)
  busy.add(other.id)
  assert.deepEqual([...f.chat.busyIds()],[other.id])
  assert.equal(f.chat.busy(f.conversation.id),false)
  assert.equal((await f.chat.history(actor,f.conversation.id)).busy,false)
  const sent=await f.send();await tick()
  assert.equal(sent.status,'queued')
  assert.equal(f.handles.length,1)
  assert.equal([...f.chat.busyIds()].includes(other.id),true)
});

test('revocation inside official selection prevents session log and default writes before followup',async t=>{
  const f=await fixture(t),gate=f.holdModel('selectModel')
  await f.send({modelSelection:{provider:'glm-fixture',model:'vision'}});await gate.entered
  const b=f.chat.active.get(f.conversation.id),h=f.handles[0],otherDefault={provider:'test',model:'test',reasoningEffort:'low'}
  f.chat.ctx.agentDefaultModel.currentSelection=()=>otherDefault
  f.revoke();gate.release();await b.runPromise
  assert.equal(h.events.some(e=>e.type==='model/selection'),false)
  assert.deepEqual(f.chat.ctx.agentDefaultModel.currentSelection(),otherDefault)
  assert.equal(h.message,undefined);assert.equal(h.disposed,true)
  assert.doesNotThrow(()=>f.root.emit('session/event',h.agent.session,{type:'model/selection',data:{provider:'test',model:'test'}}),'selection guard must be disposed after rejection')
});

test('participant uses the same validated default and blocks an unroutable model before a native turn',async t=>{
  const f=await fixture(t)
  f.chat.ctx.llm.resolveCallConfig=async()=>{throw new Error('fixture route unavailable')}
  const participant=createBlogParticipant({access:f.chat.access,chat:f.chat,index:f.index,storage:f.store,routePrefix:'/blog',ctx:f.ctx??f.root,database:f.indexDb,lifecycle:f.lifecycle})
  /**
   * ⚠️ **入口契约变化（登记，见交付报告）——它是"两处"，不是一处整体变化。**
   *
   * 1. **入场期**失败（这里的"模型路由不可用"就是这一类）：旧入口把它**吞成** `run()` 的返回值
   *    `{status:'failed'}`；运行时**抛** `AccessError`（`code==='DSH_ACCESS_ERROR'`，由 kit 的
   *    `requestedConversationModel` 抛，位置在 `ConversationLifecycle` 的 `options()` →
   *    预留会话那一段，**早于 `agents.create`**）。
   * 2. **回合结束之后**的失败：**仍然返回** `{status:'failed'}`，这一类**没有变** ——
   *    `packages/runtime/src/participant.ts:828`（`fallbackProjection`）：
   *    正文为空 ⇒ `{status:'failed', text:'没有拿到可交付的结果。'}`。
   *
   * ⚠️ **不要把这条写成"失败态返回值 → 抛错"就完了**：那会让人以为**所有**失败都改成了抛错，
   * 从而漏掉第 2 类（回合后的失败仍走返回值）。**这是措辞层面的收窄，不是行为变更。**
   *
   * 所以这里断言的是**运行时真实且被认可的契约（拒绝）**，而不是把断言改松：
   * 用例名那句"**before a native turn**"的核心语义**原样保留**在下面 `f.handles.length===0` 上。
   * 第 1 类变化对协调方**可见**（butler 桥接不 catch ⇒ 协调方看到的仍是子任务失败），已单列登记。
   */
  await assert.rejects(async()=>participant.run({actor,missionId:'route-blocked-mission',requestId:'route-blocked-request',message:'查询博客',signal:new AbortController().signal,onProgress(){}}),
    error=>error?.code==='DSH_ACCESS_ERROR'&&/模型路由当前不可用/.test(String(error?.message)))
  assert.equal(f.handles.length,0,'路由不可用时不得开原生回合')
  assert.equal(f.chat.listeners.size,0);assert.deepEqual(f.chat.ctx.agentDefaultModel.currentSelection(),{provider:'test',model:'test'})
});

test('fork model lookup rechecks the original actor before creating its Agent',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const gate=f.holdModel('resolveCallConfig')
  const pending=f.chat.fork(actor,{conversationId:f.conversation.id,messageId:'answer-1',requestId:'fork-revoked-route'})
  const rejected=assert.rejects(pending,/revoked/)
  await gate.entered;f.revoke();gate.release();await rejected
  assert.equal(f.handles.length,1);assert.equal(f.chat.forks.size,0);assert.equal(f.chat.forkSources.size,0)
});

test('chat taxonomy tools support category/tag reads and all writes through versioned user confirmation',async t=>{
  for(const kind of ['category','tag'])for(const operation of ['create','update','delete'])await t.test(`${kind} ${operation}`,async t=>{
    const f=await fixture(t),calls=[];let writes=0
    const item={id:4,name:'原名称',slug:'original',parent:0,count:2},version='taxonomy-v1'
    f.blog.call=async(action,input)=>{
      calls.push({action,input})
      if(action==='manage-list')return{items:[item],hasMore:false}
      if(action==='manage-get')return{item,version,impact:{relatedCount:2}}
      if(action==='manage-preview'){if(operation!=='create')assert.equal(input.version,version);return{input,title:'测试'+kind,impact:{relatedCount:2}}}
      assert.equal(action,'manage-write');writes++;return{id:4,kind}
    }
    await f.send();await tick();const execution={agent:f.handles[0].agent}
    for(const name of ['blog_manage_list','blog_manage_get','blog_manage_change'])assert.ok(f.handles[0].allowed.includes(name),`${name} must be available in chat`)
    const list=await f.tools.get('blog_manage_list').execute({kind,page:1,query:'原名称'},execution)
    const detail=await f.tools.get('blog_manage_get').execute({kind,id:list.items[0].id},execution)
    const args={kind,operation,...(operation==='create'?{}:{id:detail.item.id,version:detail.version}),...(operation==='delete'?{}:{fields:{name:'新名称',...(kind==='category'?{parent:8}:{})}})}
    const result=await f.tools.get('blog_manage_change').execute(args,execution)
    assert.equal(result.requiresUserAction,true);assert.equal(result.nonce,undefined);assert.equal(writes,0)
    complete(f.handles[0]);await tick();const card=(await f.chat.history(actor,f.conversation.id)).operations[0]
    assert.equal(card.management.kind,kind);assert.equal(card.management.operation,operation)
    await f.chat.operationAction(actor,{conversationId:f.conversation.id,id:card.id,nonce:card.nonce,operation:'confirm'})
    assert.equal(writes,1);assert.deepEqual(calls.at(-1).input.fields,args.fields)
  })
})

test('all five report tools are available in chat and read without preparing mutations',async t=>{
  const f=await fixture(t),calls=[]
  f.blog.report=async(mode,args,signal)=>{calls.push({mode,args});return {reportVersion:1,report:mode,complete:true,totals:{articleCount:145,versionCount:146}}}
  f.blog.call=async()=>assert.fail('reports must not use a write or ordinary list')
  await f.send();await tick();const h=f.handles[0]
  for(const [name,mode] of [['blog_get_statistics','overview'],['blog_taxonomy_statistics','taxonomy'],['blog_group_articles','catalog'],['blog_activity_statistics','timeline'],['blog_query_article_titles','ranking']]){
    assert.ok(h.allowed.includes(name));const args={filters:{status:'all'}},result=await f.tools.get(name).execute(args,{agent:h.agent})
    assert.equal(result.report,mode);assert.deepEqual(calls.at(-1),{mode,args})
  }
  assert.equal(calls.length,5);assert.deepEqual((await f.chat.history(actor,f.conversation.id)).operations,[])
  f.revoke();await assert.rejects(f.tools.get('blog_get_statistics').execute({},{agent:h.agent}),/revoked/);assert.equal(calls.length,5)
})
test('report results are withheld when access expires during the request',async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),gate=Promise.withResolvers()
  f.blog.report=async()=>{entered.resolve();return gate.promise}
  await f.send();await tick();const h=f.handles[0],result=f.tools.get('blog_group_articles').execute({},{agent:h.agent})
  const rejected=assert.rejects(result,/revoked/);await entered.promise;f.revoke();gate.resolve({complete:true,groups:[{name:'private'}]});await rejected
})

test('binding two-step after the split: a failed index write retries onto the same imported article',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const source={cid:77,title:'绑定基线',text:'原始正文',slug:'post',format:'markdown',tags:[],categories:[]}
  let remote={published:source,version:'v1'}
  f.blog.get=async()=>remote
  const select=requestId=>f.send({requestId}).then(async()=>{await tick();return f.tools.get('blog_select_draft').execute({cid:77,variant:'published'},{agent:f.handles.at(-1).agent})})
  const first=await select('binding-first')
  complete(f.handles.at(-1),'binding-a1');await tick()
  // 新一轮操作：PG 侧建稿成功、索引侧 updateRequest 失败（注入）。
  const update=f.index.updateRequest.bind(f.index);let fail=true
  f.index.updateRequest=(o,id,patch)=>{if(patch.draftId&&fail){fail=false;throw new Error('injected index failure')}return update(o,id,patch)}
  await assert.rejects(select('binding-retry'),/injected index failure/)
  await tick();complete(f.handles.at(-1),'binding-a2');await tick()
  // 重试（远端内容未变）：cid 幂等去重，复用同一草稿，不产生第二份。
  fail=true
  f.index.updateRequest=(o,id,patch)=>{if(patch.draftId&&fail){fail=false;throw new Error('injected index failure again')}return update(o,id,patch)}
  await assert.rejects(select('binding-retry-2'),/injected index failure again/)
  await tick();complete(f.handles.at(-1),'binding-a3');await tick()
  const recovered=await select('binding-retry-3')
  assert.equal(recovered.draftId,first.draftId)
  assert.equal((await f.store.list(owner)).length,1)
})

test('binding retry with drifted remote content keeps the current dedup semantics (documented residual window)',async t=>{
  const f=await fixture(t);await f.send();await tick();complete(f.handles[0]);await tick()
  const source={cid:78,title:'漂移基线',text:'原始正文',slug:'post',format:'markdown',tags:[],categories:[]}
  let remote={published:source,version:'v1'}
  f.blog.get=async()=>remote
  const select=requestId=>f.send({requestId}).then(async()=>{await tick();return f.tools.get('blog_select_draft').execute({cid:78,variant:'published'},{agent:f.handles.at(-1).agent})})
  const first=await select('drift-first')
  complete(f.handles.at(-1),'drift-a1');await tick()
  const update=f.index.updateRequest.bind(f.index);let fail=true
  f.index.updateRequest=(o,id,patch)=>{if(patch.draftId&&fail){fail=false;throw new Error('injected drift failure')}return update(o,id,patch)}
  // 绑定失败期间远端内容漂移：重试导入时 sameBlogContent 不再匹配，按现行语义生成第二份副本
  //（方案 §2.1 声明的残余窗口，保持现状不加守卫）。
  remote={published:{...source,text:'远端已修改'},version:'v2'}
  await assert.rejects(select('drift-retry'),/injected drift failure/)
  assert.equal((await f.store.list(owner)).length,2,'失败尝试已按现行语义生成第二份副本')
  await tick();complete(f.handles.at(-1),'drift-a2');await tick()
  // 内容稳定后的重试命中第二份副本（cid+内容去重），不会继续累积。
  const recovered=await select('drift-retry-2')
  assert.notEqual(recovered.draftId,first.draftId)
  assert.equal(recovered.text,'远端已修改')
  assert.equal((await f.store.list(owner)).length,2)
})

/**
 * 以下三条钉住 `.mjs → .ts` 转换里**测试套件原本抓不到**的漂移（都不在类型层，纯文本/形状问题）。
 * 它们不是新增功能断言，而是把"转换必须逐字保真"这条要求变成可回归的判据：
 * 每条都在改造过程中**真的红过**（见 `git log`/交接文档记录），改动上面任一处实现都会重新变红。
 */
test('persona keeps the tag capability and the bridge field name the model was told to use',async t=>{
  const f=await fixture(t)
  await f.send();await tick()
  const persona=f.handles[0].sections.find(s=>s.name==='blog:persona')
  assert.ok(persona,'persona section must be installed')
  assert.equal(persona.order,600)
  // 「标签」是查询能力的提示；`remote关联ID` 是桥接返回的字段名，不能意译。
  assert.match(persona.text,/标题、正文、关键词、分类、标签、时间可组合查询/)
  assert.match(persona.text,/只有明确的共同rootCid或remote关联ID才能去重/)
})

test('the first automatic title is cut from the trimmed text, not the raw input',async t=>{
  const f=await fixture(t)
  await f.send({requestId:'title-trim',text:'  你好  '});await tick()
  assert.equal((await f.index.get(owner,f.conversation.id)).title,'你好')
})

test('delete refuses a non-array ids instead of splitting it into single characters',async t=>{
  const f=await fixture(t)
  let error
  // ⚠️ 这个字符串里的字符**必须互不相同**（且每个字符都满足 kit 的 `/^[\w-]{1,160}$/`），否则判据无效：
  // 被拆成数组后若含重复字符，`conversationIds` 的"互不相同"这一条也会把它挡回同一个 400，
  // 于是"先浅拷贝"这个漂移在测试里看不出来（本文件第一版就是这么写的，变异不红才发现）。
  try{await f.chat.mutate(actor,{operation:'delete',ids:'blogchat0123456789'})}catch(caught){error=caught}
  // `mutate` 的 delete 分支不经过 `index.mutate` 的入参校验，唯一的类型校验在 kit 的 `conversationIds`：
  // 先做浅拷贝会把「400 请选择 1–100 条不同的有效会话」静默降级成逐字符查找后的 404/409。
  assert.equal(error?.status,400)
  assert.match(String(error?.message),/请选择 1–100 条不同的有效会话/)
  assert.equal((await f.chat.list(actor,0,'')).items.length,1,'非法入参不得移除任何会话')
})

/**
 * ③-B 批次 B（一）：**起轮窗口**。守卫 → `index.start`（内部三次 PG 往返）→ `active.set`
 * 之间全是挂起点，两次并发 `send` 因此可以都越过守卫：各自的 `claim` 用的是**不同**的
 * `requestId`，谁也拦不住谁。
 *
 * 修复前实测：两条都返回 `{status:'queued'}`、落下**两行**轮次、`active` 只记得后一条
 * （前一条的 `b` 被覆盖 ⇒ `assertTurn` 把它判成"本次请求已结束"）⇒ **两条消息一起失败**。
 *
 * 断言刻意落在"**只起一轮**"上：只断"有一条被拒"是不够的 —— 修复前的形态里两条都成功。
 * 变异：把 `starting` 的登记（或那道原子检查）去掉 ⇒ 本用例必须红。
 */
test('两条并发 send 不能在同一个会话上各起一轮（起轮窗口）',async t=>{
  const f=await fixture(t)
  const results=await Promise.allSettled([
    f.chat.send(actor,{conversationId:f.conversation.id,requestId:'window-a',text:'第一条',research:true}),
    f.chat.send(actor,{conversationId:f.conversation.id,requestId:'window-b',text:'第二条',research:true}),
  ])
  const rejected=results.filter(r=>r.status==='rejected'),accepted=results.filter(r=>r.status==='fulfilled')
  assert.equal(rejected.length,1,'后到的那条必须在守卫上被挡下，而不是也排上队')
  assert.equal(rejected[0].reason.status,409)
  assert.match(String(rejected[0].reason.message),/正在回答|正在结束上一轮/)
  assert.equal(accepted[0].value.status,'queued')
  await tick()
  assert.equal(f.handles.length,1,'同一会话只允许起一轮')
  const rows=await f.index.requests(owner,f.conversation.id)
  assert.equal(rows.length,1,'被挡下的那条不许在索引里留下轮次行')
  assert.equal(f.chat.active.size,1)
  // 留下的是**被接受**的那条（先前那种"两条都留下、`active` 只记得后一条"的形态下，这条会红）。
  assert.equal(rows[0].id,accepted[0].value.id)
})

/**
 * ③-B 批次 B（二）：**移除被接受之后的 `release` 真的要收起本实例的回合**。
 *
 * 顺序照 kit（`packages/plugin-kit/src/conversations.ts:141-149`）：
 * `mark(pending)` → `await release(id)` → `archiveSession(id)` → `mark(removed)`。
 * 而 blog 原先传的 `release` 是**空函数** ⇒ 移除已生效、本实例仍攥着那一轮。
 *
 * ⚠️ 本用例**直接调 `releaseConversation`**，因为链级走不到这个状态：`remove` 在 `:134`/`:140`
 * 有两道 busy 守卫，而 `busy()` 已经算了 `active` ⇒ "有一轮在跑"的会话**根本进不到 `release`**。
 * 这一点在下半段用链级断言钉住（如实登记，而不是假装链级也覆盖了）。
 *
 * ⚠️ 关键的第二条断言是 `status === 'interrupted'`：那一刻会话已被 `mark(pending)`，
 * `durable` 里的 `index.get` 必然 404，`finish` 的 catch 会把状态降级成 `failed` 并把消息换成
 * "对话持久化未完成…" ⇒ 一次**正常**的移除会在页面上留下误导性的失败。
 * 变异：`release` 退回空函数 ⇒ 第一条断言红；`finish(..., {persist:false})` 去掉 ⇒ 第二条红。
 */
test('移除被接受后的 release 真的收起本实例的回合，且不把正常移除写成失败',async t=>{
  const f=await fixture(t)
  await f.send();await tick()
  const id=f.conversation.id
  assert.equal(f.chat.active.size,1,'前置：有一轮在跑')
  f.index.mark(ownerActor(owner),id,'pending')
  // 那一刻会话已经不可见 —— 这正是 `release` 里不能走 `durable`（它会 `index.get`）的原因。
  await assert.rejects(f.index.get(owner,id),/不存在或无权访问/)
  await f.chat.releaseConversation(id)
  assert.equal(f.chat.active.size,0,'release 之后本实例不再攥着这一轮')
  assert.equal(f.handles[0].disposed,true)
  const row=(await f.index.requests(owner,id,true))[0]
  assert.equal(row.status,'interrupted','正常移除不得被降级成 failed')
  assert.equal(row.message,'会话已移除')
  // 链级：有一轮在跑时 `remove` 在 kit 的 busy 守卫上就被挡下 ⇒ 走不到"release 时还在跑"。
  const g=await fixture(t)
  await g.send();await tick()
  assert.equal((await g.chat.remove(actor,[g.conversation.id])).results[0].status,'blocked')
  assert.equal(g.chat.active.size,1,'被挡下时不得动到那一轮')
})

/**
 * ③-B 批次 B（三）：**`stop` 不再谎报成功**。
 *
 * 外部驱动方（运行时的会话生命周期）占着会话时，本实例**没有东西可停** —— 那要
 * `lifecycle.abort`，属装配之后的事（批次 C）。原先恒返回 `{stopped:true}` 会让页面显示
 * "已停止"，而那一轮还在跑。
 *
 * `occupancy` 今天缺省恒假（批次 A 留的接缝）⇒ 这里**显式注入**来构造"只有外部忙"的状态。
 * 变异：`stop` 恒返回 `{stopped:true}` ⇒ 本条红。
 */
test('stop 不再谎报：只有外部驱动方忙而本实例无物可停时返回 stopped:false',async t=>{
  let target=''
  const f=await fixture(t,{occupancy:{isBusy:id=>id===target,busyIds:()=>target?[target]:[]}})
  target=f.conversation.id
  const before=await f.index.requests(owner,f.conversation.id)
  assert.deepEqual(await f.chat.stop(actor,f.conversation.id),{stopped:false})
  assert.equal(f.chat.active.size,0)
  assert.equal(f.handles.length,0,'本实例没起过 Agent ⇒ 确实没有可停的东西')
  assert.deepEqual(await f.index.requests(owner,f.conversation.id),before,'谎报之外也不许顺手改状态')
  // 反面：本实例真的有一轮时，必须如实报 true 并把它收掉。
  const g=await fixture(t)
  const started=await g.send();await tick()
  assert.deepEqual(await g.chat.stop(actor,g.conversation.id),{stopped:true})
  assert.equal(g.chat.active.size,0)
  assert.equal((await g.index.request(owner,started.id)).status,'interrupted')
})
/**
 * ③-B 批次 B（一·补）：**起轮窗口内，这个会话必须已经被算作忙**。
 *
 * 上面那条测的是"不许起两轮"，靠的是那道**原子检查并登记**；而登记还必须在 `busy()` 里可见 ——
 * 否则窗口里（`start` 正在跑、`active` 还没设）改名与移除都能插进来：移除一旦被接受
 * （`mark(pending)`），这一轮随后照样会跑起来，落在一个已经被移除的会话上。
 *
 * 怎么把那个窗口**稳定地**撑开：把 `index.start` 本身挡在门上（纯测试侧打桩，不改生产代码）。
 * 打桩是必要的——那个窗口在生产里只有几次 PG 往返那么长，靠 `Promise.all` 抢不到稳定观测。
 *
 * 变异：`busy()`/`busyIds()` 不再算 `starting` ⇒ 本条红。
 */
test('起轮窗口内该会话已经算忙：改名与侧栏移除判定都插不进来',async t=>{
  const f=await fixture(t)
  const id=f.conversation.id
  // 先跑完一轮：会话只有在 `durable`（发布）之后才会出现在**侧栏**口径里（`managed` 过滤 `ready`），
  // 而"起轮窗口"这条断言要的正是"一个用户在侧栏看得见、正准备再发一条"的会话。
  await f.send();await tick();complete(f.handles[0]);await tick()
  assert.equal(f.chat.active.size,0,'前置：上一轮已经收尾')
  const original=f.index.start.bind(f.index)
  const entered=Promise.withResolvers(),gate=Promise.withResolvers()
  f.index.start=async(...args)=>{entered.resolve();await gate.promise;return original(...args)}
  const sending=f.send({requestId:'window-inside'})
  await entered.promise
  assert.equal(f.chat.active.size,0,'前置：这一轮还没进 active（窗口就开在这里）')
  assert.equal(f.chat.busy(id),true,'窗口内必须已经算忙')
  assert.ok(f.chat.busyIds().includes(id),'侧栏的忙集合也要带上它')
  const page=await f.chat.provider.list(actor,{offset:0,limit:30,q:'',state:''})
  assert.equal(page.items[0].canRemove,false,'起轮当中不许被移除')
  await assert.rejects(f.chat.mutate(actor,{operation:'rename',ids:[id],title:'窗口里改名'}),/仍在回答|请先停止/)
  gate.resolve()
  await sending
  await tick()
  assert.equal(f.chat.active.size,1)
  assert.equal(f.handles.length,2)
})