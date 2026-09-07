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

const actor={namespace:'user',userId:'writer',sessionId:'login'},owner='user:writer'
const tick=()=>new Promise(r=>setTimeout(r,10))
const sdk={isAppendSurfaceEvent:e=>['user/message','assistant/message'].includes(e.type),deriveEventMessage:e=>e.type==='user/message'?e.data:e.data.message,expandAssistantStream:s=>s??[],deriveTurnTokenUsage:()=>null}
async function fixture(t,{delayedOpen=false,delayedFlush=false,noPersistence=false}={}){
  const root=new Context(),registry=root.plugin(AgentRegistry);await registry
  const runtimeJobs=root.plugin(LocalJobRegistry);await runtimeJobs
  const store=new BlogStore(':memory:'),index=new ChatStore(store),handles=[],saved=new Map(),headers=new Map(),disposers=[],tools=new Map(),feedbackCalls=[]
  let revoked=false,releaseOpen,releaseFlush,flushCount=0,nextFlushGate;const releaseGates=[]
  const access={assert(a){assert.ok(!revoked&&a.sessionId==='login','revoked')}}
  const openGate=delayedOpen?new Promise(r=>{releaseOpen=r}):Promise.resolve()
  const flushGate=delayedFlush?new Promise(r=>{releaseFlush=r}):Promise.resolve()
  const ctx={root,jobs:root.jobs,effect:fn=>disposers.push(fn()),on:root.on.bind(root),get:()=>undefined,
    tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
    agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{resolveModelInfo:async()=>({inputModalities:['text']})},
    sessions:{async flush(session){if(++flushCount===1)await flushGate;if(nextFlushGate){const gate=nextFlushGate;nextFlushGate=null;await gate}saved.set(String(session.id),session.snapshotEvents());headers.set(String(session.id),session.header);return !noPersistence}},
    sessionPersistence:{async stat(id){return headers.has(String(id))?{header:headers.get(String(id))}:undefined},async open(id){assert.ok(saved.has(String(id)));return{header:headers.get(String(id)),read:async()=>saved.get(String(id)),close:async()=>{}}}},
    messageFeedback:Object.fromEntries(['list','put','delete'].map(action=>[action,async request=>{feedbackCalls.push({action,request});return{ok:true,value:action==='list'?{items:[]}:request}}])),
    agents:{async create(options){
      await openGate
      const scope=root.plugin(()=>{}),events=[...(options.seed??[])],session=Session.create(SessionId(options.sessionId))
      Object.defineProperty(session,'header',{value:headers.get(String(options.sessionId))??{id:options.sessionId,createdAt:Date.now(),cwd:process.cwd(),...options.meta}})
      headers.set(String(options.sessionId),session.header)
      session.snapshotEvents=()=>[...events]
      const agent={id:options.sessionId,ctx:scope.ctx,session,options:{},status:'idle',cancel(){handle.cancelled=true},whenIdle:async()=>{},followup(message){handle.message=message;handle.emit('user/message',message);handle.emit('turn/start',{turn:'turn-'+events.length})}}
      const unregister=root.agents.register(agent)
      const handle={agent,options,events,cancelled:false,disposed:false,emit(type,data){const event={type,data,seq:events.length,time:1000+events.length*100};events.push(event);root.emit('session/event',session,event)},async dispose(){if(handle.disposed)return;handle.disposed=true;await unregister();await scope.dispose()}}
      options.setup({systemPrompt:{section(){}},tools:{restrict:rule=>{handle.allowed=rule.allow}}});handles.push(handle);return handle
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

test('chat search tools preserve structured dates and return lossless imported draft references',async t=>{
  const f=await fixture(t);f.store.create(owner,{title:'时间检索稿'},{published:{cid:338}})
  let received;f.blog.search=async args=>{received=args;return {items:[],hasMore:false}}
  await f.send();await tick();const agent=f.handles[0].agent
  const args={period:'yesterday',title:'测试',category:'摘抄笔记',page:2}
  await f.tools.get('blog_search_posts').execute(args,{agent});assert.deepEqual(received,args)
  const result=await f.tools.get('blog_list_drafts').execute({title:'时间检索稿'},{agent})
  assert.equal(result.items.length,1);assert.equal(result.items[0].remote.savedDraftCid,null)
  assert.deepEqual(result,JSON.parse(JSON.stringify(result)))
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
  await f.send();await tick();assert.equal(f.handles[0].options.agentOptions.model,'text');complete(f.handles[0],'text-answer');await tick()
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
