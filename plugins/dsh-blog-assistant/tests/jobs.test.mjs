import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session,SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { BlogJobs } from '../src/jobs.mjs'
import { BlogStore } from '../src/store.mjs'

const tick=()=>new Promise(r=>setTimeout(r,5)),actor={namespace:'user',userId:'writer',sessionId:'login'}
async function fixture(t,{delayedIdle=false,images=false}={}) {
  const root=new Context();const agentPlugin=root.plugin(AgentRegistry);await agentPlugin;const jobsPlugin=root.plugin(LocalJobRegistry);await jobsPlugin
  const store=new BlogStore(':memory:'),draft=store.create('user:writer'),handles=[],tools=new Map(),disposers=[]
  let revoked=false,releaseIdle
  const access={assert(a){assert.ok(!revoked&&a.sessionId==='login','revoked')}}
  const ctx={root,jobs:root.jobs,get(name){return name==='web'?{search:async()=>({sources:[{url:'https://example.com'}]})}:undefined},
    effect(fn){disposers.push(fn())},on:root.on.bind(root),tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
    agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{resolveModelInfo:async()=>({inputModalities:['text']})},
    agents:{async create(options){
      const scope=root.plugin(()=>{});let idle=Promise.resolve()
      const agent={id:options.sessionId,ctx:scope.ctx,session:Session.create(SessionId(options.sessionId)),options:{},status:'idle',cancel(){handle.cancelled=true},whenIdle(){return idle},followup(message){handle.message=message;if(delayedIdle)idle=new Promise(r=>{releaseIdle=r})}}
      const unregister=root.agents.register(agent)
      const handle={agent,cancelled:false,disposed:false,async dispose(){handle.disposed=true;await unregister();await scope.dispose()}}
      handle.sections=[];handle.contexts=[];options.setup({systemPrompt:{section(s){handle.sections.push(s)},context(c){handle.contexts.push(c)}},tools:{restrict(rule){handle.allowed=rule.allow}}});handles.push(handle);return handle
    }},
  }
  const attachments={freeze:()=>images?[{id:'a',version:1,name:'image',image:{attachmentId:'x'}}]:[{id:'a',version:1,name:'private.txt',range:null,unit:'行',units:[{number:1,text:'READ-MARKER-829'}]}]}
  const jobs=new BlogJobs(ctx,access,store,{list:async()=>({items:[]})},attachments,1000)
  t.after(async()=>{releaseIdle?.();await jobs.close();for(const dispose of disposers.reverse())await dispose?.();store.close();await jobsPlugin.dispose();await agentPlugin.dispose()})
  const request={callerId:'router',requestId:'request-123',draftId:draft.id,expectedRevision:1,instruction:'read attachment',research:true}
  return {root,jobs,store,draft,handles,tools,request,access,release(){releaseIdle?.()},revoke(){revoked=true;jobs.recheck()}}
}
test('official Jobs owns settlement, reports completion and isolates the exact Agent owner',async t=>{
  const f=await fixture(t),job=await f.jobs.start(actor,f.request);await tick()
  assert.equal(f.handles.length,1);const handle=f.handles[0],runtime=f.root.jobs.list(handle.agent)[0]
  assert.equal(runtime.status,'running');assert.match(handle.sections.at(-1).text,/reasoning_content/);assert.ok(handle.sections.at(-1).order>handle.sections[0].order);assert.match(handle.contexts[0].text,/当前交互界面的语言是简体中文/);assert.ok(handle.message.content.some(c=>c.text?.includes('READ-MARKER-829')))
  assert.throws(()=>f.root.jobs.get(runtime.id),/another session/)
  const search=await f.tools.get('blog_web_search').execute({query:'source'},{agent:handle.agent})
  assert.equal(search.sources[0].title,'https://example.com');assert.doesNotThrow(()=>JSON.stringify(search))
  f.root.emit('session/event',{id:handle.agent.id},{type:'turn/end',data:{reason:{kind:'completed'}}})
  await tick();assert.equal(f.jobs.get(actor,job.id).status,'succeeded');assert.equal(handle.disposed,true)
  assert.equal(f.handles.length,1)
})
test('cancel does not release capacity or settle before Agent is idle; late tool cannot propose',async t=>{
  const f=await fixture(t,{delayedIdle:true}),job=await f.jobs.start(actor,f.request);await tick()
  const h=f.handles[0],runtime=f.root.jobs.list(h.agent)[0]
  f.jobs.cancel(actor,job.id);await tick()
  assert.equal(h.cancelled,true);assert.equal(h.disposed,false);assert.equal(f.jobs.active.size,1);assert.equal(f.root.jobs.get(runtime.id,h.agent).status,'stopping')
  await assert.rejects(f.tools.get('blog_propose').execute({text:'late'},{agent:h.agent}),/身份/)
  f.release();await tick();assert.equal(f.jobs.get(actor,job.id).status,'cancelled');assert.equal(h.disposed,true)
})
test('image-incompatible model fails before launching a turn',async t=>{
  const f=await fixture(t,{images:true}),job=await f.jobs.start(actor,f.request);await tick()
  assert.equal(f.handles.length,0);assert.match(f.jobs.get(actor,job.id).error.message,/支持图片/)
})
test('concurrent editor jobs cannot replace a candidate written after their input was frozen',async t=>{
  const f=await fixture(t)
  await f.jobs.start(actor,f.request);await f.jobs.start(actor,{...f.request,requestId:'request-second'});await tick()
  const tool=f.tools.get('blog_propose')
  const first=await tool.execute({text:'先完成候选'},{agent:f.handles[0].agent})
  await assert.rejects(tool.execute({text:'迟到候选'},{agent:f.handles[1].agent}),/候选稿已被其他任务更新/)
  assert.equal(f.store.get('user:writer',f.draft.id).proposal.id,first.proposalId)
  const continued=await tool.execute({text:'同任务继续调整'},{agent:f.handles[0].agent})
  assert.equal(f.store.get('user:writer',f.draft.id).proposal.id,continued.proposalId)
})
