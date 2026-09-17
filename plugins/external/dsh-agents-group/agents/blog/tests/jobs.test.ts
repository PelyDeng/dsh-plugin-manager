import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session,SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { BlogJobs } from '../src/jobs.ts'
import { BlogStore,type OwnerActor } from '../src/store.ts'

/** `ctx.effect` 登记下来的清理函数。 */
type Disposer = () => unknown
/** 提示词段 / 上下文片段：断言只读 `text` 与 `order`。 */
interface FakeSection { text?: string; order?: number }
/** 假工具的回执：断言只读这几个字段（`sources` 是联网检索、`proposalId` 是候选稿）。 */
interface FakeToolResult { sources: { url: string; title?: string }[]; proposalId?: string }
interface FakeTool { name: string; execute(args: Record<string, unknown>, extra: { agent: Agent }): Promise<FakeToolResult> }
/** `agents.create` 的入参（夹具只碰这几个字段）。 */
interface FakeAgentOptions { sessionId: string; agentOptions?: unknown; setup(scope: FakeScope): void }
/** agent 作用域：`BlogJobs` 的 `setup` 只碰 `systemPrompt` 与 `tools` 两个面。 */
interface FakeScope {
  systemPrompt: { section(section: FakeSection): void; context(section: FakeSection): void }
  tools: { restrict(rule: { allow: readonly string[] }): void }
}
/** 假 agent 句柄：`BlogJobs` 交给宿主的那一个对象，断言读它的取消/释放与两个作用域落点。 */
interface FakeHandle {
  readonly agent: Agent
  readonly options: FakeAgentOptions
  cancelled: boolean
  disposed: boolean
  sections: FakeSection[]
  contexts: FakeSection[]
  allowed?: readonly string[]
  message?: { content: { text?: string }[] }
  dispose(): Promise<void>
}
/** `holdModel` 只按方法名替换一个夹具方法：两个面在这里按同一形状看待。 */
type ModelMethod = 'modelCatalog' | 'resolveCallConfig'

const tick=()=>new Promise(r=>setTimeout(r,5)),actor={namespace:'user',userId:'writer',sessionId:'login'}
async function fixture(t: TestContext,{delayedIdle=false,images=false}: { delayedIdle?: boolean; images?: boolean }={}) {
  const root=new Context();const agentPlugin=root.plugin(AgentRegistry);await agentPlugin;const jobsPlugin=root.plugin(LocalJobRegistry);await jobsPlugin
  const store=new BlogStore(':memory:');await store.init();const draft=await store.create('user:writer'),handles: FakeHandle[]=[],tools=new Map<string,FakeTool>(),disposers: (Disposer|undefined)[]=[]
  let revoked=false,releaseIdle: ((value?: unknown) => void) | undefined;const releaseGates: ((value?: void) => void)[]=[]
  // 存储侧的 `OwnerActor` 只有 namespace/userId（没有 sessionId），而这条夹具的断言恰恰要查登录会话 ⇒ 按它的口径求交。
  const access: { assert(a: OwnerActor & { readonly sessionId?: string }): void }={assert(a){assert.ok(!revoked&&a.sessionId==='login','revoked')}}
  /**
   * 用例自造的假事件载荷不是宿主事件表的成员（事件表按事件名收窄重载）：投递时收窄一次，
   * 运行期原样转给 `root.emit`。
   */
  const emit=(name: string,...args: unknown[]): void=>{(root.emit as unknown as (name: string,...args: unknown[]) => void)(name,...args)}
  /**
   * 假宿主：`get` 按名字取夹具自身的其他面（等价于原来的 `this[name]`，只在取值处收窄一次）；
   * 整个 `ctx` 在构造 `BlogJobs` 时按 `Context` 收窄 —— 夹具只提供真实宿主用到的那些面。
   */
  const ctx={root,jobs:root.jobs,get(name: string){return name==='web'?{search:async()=>({sources:[{url:'https://example.com'}]})}:(this as unknown as Record<string,unknown>)[name]},
    effect(fn: () => Disposer|undefined){disposers.push(fn())},on:root.on.bind(root),tools:{register(tool: FakeTool){tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
    agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{resolveModelInfo:async()=>({inputModalities:['text']}),resolveCallConfig:async(selection: unknown)=>selection},
    sessionController:{async modelCatalog(){return{groups:[{id:'test',name:'Test',models:[{id:'test',name:'Test'}]}],failures:[]}},selectModel(){assert.fail('article jobs must not change the default')}},
    agents:{async create(options: FakeAgentOptions){
      const scope=root.plugin(()=>{});let idle: Promise<unknown>=Promise.resolve()
      // 假 agent 只提供 `BlogJobs` 用到的那几个面：注册给官方 registry 时收窄一次。
      const agent={id:options.sessionId,ctx:scope.ctx,session:Session.create(SessionId(options.sessionId)),options:{},status:'idle',cancel(){handle.cancelled=true},whenIdle(){return idle},followup(message: { content: { text?: string }[] }){handle.message=message;if(delayedIdle)idle=new Promise(r=>{releaseIdle=r})}} as unknown as Agent
      const unregister=root.agents.register(agent)
      const handle: FakeHandle={agent,options,cancelled:false,disposed:false,sections:[],contexts:[],async dispose(){handle.disposed=true;await unregister();await scope.dispose()}}
      handle.sections=[];handle.contexts=[];options.setup({systemPrompt:{section(s){handle.sections.push(s)},context(c){handle.contexts.push(c)}},tools:{restrict(rule){handle.allowed=rule.allow}}});handles.push(handle);return handle
    }},
  }
  const attachments={freeze:()=>images?[{id:'a',version:1,name:'image',image:{attachmentId:'x'}}]:[{id:'a',version:1,name:'private.txt',range:null,unit:'行',units:[{number:1,text:'READ-MARKER-829'}]}]}
  // 夹具只给 `BlogJobs` 用到的那个面（`list`）：按构造函数签名在装配边界上收窄一次，运行期值不变。
  const jobs=new BlogJobs(ctx as unknown as Context,access,store,{list:async()=>({items:[]})} as unknown as ConstructorParameters<typeof BlogJobs>[3],attachments as unknown as ConstructorParameters<typeof BlogJobs>[4],1000)
  t.after(async()=>{releaseIdle?.();for(const release of releaseGates)release();await jobs.close();for(const dispose of disposers.reverse())await dispose?.();store.close();await jobsPlugin.dispose();await agentPlugin.dispose()})
  const request={callerId:'router',requestId:'request-123',draftId:draft.id,expectedRevision:1,instruction:'read attachment',research:true}
  return {root,ctx,jobs,store,draft,handles,tools,request,access,emit,
    holdModel(method: ModelMethod){const target: Partial<Record<ModelMethod,(...args: unknown[]) => unknown>>=method==='resolveCallConfig'?ctx.llm:ctx.sessionController,original=target[method]!,entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();releaseGates.push(gate.resolve);target[method]=async(...args: unknown[])=>{entered.resolve();await gate.promise;return original.apply(target,args)};return{entered:entered.promise,release:gate.resolve}},
    release(){releaseIdle?.()},revoke({recheck=true}={}){revoked=true;if(recheck)jobs.recheck()}}
}
test('official Jobs owns settlement, reports completion and isolates the exact Agent owner',async t=>{
  const f=await fixture(t),job=await f.jobs.start(actor,f.request);await tick()
  assert.equal(f.handles.length,1);const handle=f.handles[0]!,runtime=f.root.jobs.list(handle.agent)[0]!
  assert.equal(runtime.status,'running');assert.match(handle.sections.at(-1)!.text!,/reasoning_content/);assert.ok(handle.sections.at(-1)!.order!>handle.sections[0]!.order!);assert.match(handle.contexts[0]!.text!,/当前交互界面的语言是简体中文/);assert.ok(handle.message!.content.some(c=>c.text?.includes('READ-MARKER-829')))
  assert.throws(()=>f.root.jobs.get(runtime.id),/another session/)
  const search=await f.tools.get('blog_web_search')!.execute({query:'source'},{agent:handle.agent})
  assert.equal(search.sources[0]!.title,'https://example.com');assert.doesNotThrow(()=>JSON.stringify(search))
  f.emit('session/event',{id:handle.agent.id},{type:'turn/end',data:{reason:{kind:'completed'}}})
  await tick();assert.equal((await f.jobs.get(actor,job.id)).status,'succeeded');assert.equal(handle.disposed,true)
  assert.equal(f.handles.length,1)
})
test('reasoning and step narration fold into a cumulative thinking trail without duplicating the answer',async t=>{
  const f=await fixture(t),job=await f.jobs.start(actor,f.request);await tick()
  const h=f.handles[0]!,stream=(type: string,text: string)=>f.emit('agent/assistant-stream',{agent:h.agent,frame:{type:'chunk',chunk:{type,text}}})
  const message=(text: string,reasoning?: string)=>f.emit('session/event',{id:h.agent.id},{type:'assistant/message',data:{message:{content:[{type:'text',text}],...(reasoning!==undefined?{reasoning}:{})}}})
  stream('reasoning-delta','先查定价来源。')
  await tick();assert.match((await f.jobs.get(actor,job.id)).thinking,/先查定价来源/)
  stream('text-delta','正文被截断，换个来源。')
  message('正文被截断，换个来源。','先查定价来源。')
  await tick()
  const mid=await f.jobs.get(actor,job.id)
  assert.match(mid.thinking,/先查定价来源/);assert.match(mid.thinking,/正文被截断/);assert.equal(mid.text,'正文被截断，换个来源。')
  stream('reasoning-delta','综合后作答。')
  stream('text-delta','最终答案')
  message('最终答案','综合后作答。')
  f.emit('session/event',{id:h.agent.id},{type:'turn/end',data:{reason:{kind:'completed'}}})
  await tick()
  const done=await f.jobs.get(actor,job.id)
  assert.equal(done.status,'succeeded');assert.equal(done.text,'最终答案')
  assert.match(done.thinking,/先查定价来源/);assert.match(done.thinking,/正文被截断/);assert.match(done.thinking,/综合后作答/)
  assert.ok(!done.thinking.includes('最终答案'),'收尾后的思考不应重复最终答案')
})
test('cancel does not release capacity or settle before Agent is idle; late tool cannot propose',async t=>{
  const f=await fixture(t,{delayedIdle:true}),job=await f.jobs.start(actor,f.request);await tick()
  const h=f.handles[0]!,runtime=f.root.jobs.list(h.agent)[0]!
  f.jobs.cancel(actor,job.id);await tick()
  assert.equal(h.cancelled,true);assert.equal(h.disposed,false);assert.equal(f.jobs.active.size,1);assert.equal(f.root.jobs.get(runtime.id,h.agent).status,'stopping')
  await assert.rejects(f.tools.get('blog_propose')!.execute({text:'late'},{agent:h.agent}),/身份/)
  f.release();await tick();assert.equal((await f.jobs.get(actor,job.id)).status,'cancelled');assert.equal(h.disposed,true)
})
test('image-incompatible model fails before launching a turn',async t=>{
  const f=await fixture(t,{images:true}),job=await f.jobs.start(actor,f.request);await tick()
  assert.equal(f.handles.length,0);assert.match((await f.jobs.get(actor,job.id)).error.message,/支持图片/)
})
test('concurrent editor jobs cannot replace a candidate written after their input was frozen',async t=>{
  const f=await fixture(t)
  await f.jobs.start(actor,f.request);await f.jobs.start(actor,{...f.request,requestId:'request-second'});await tick()
  const tool=f.tools.get('blog_propose')!
  const first=await tool.execute({text:'先完成候选'},{agent:f.handles[0]!.agent})
  await assert.rejects(tool.execute({text:'迟到候选'},{agent:f.handles[1]!.agent}),/候选稿已被其他任务更新/)
  assert.equal((await f.store.get('user:writer',f.draft.id)).proposal.id,first.proposalId)
  const continued=await tool.execute({text:'同任务继续调整'},{agent:f.handles[0]!.agent})
  assert.equal((await f.store.get('user:writer',f.draft.id)).proposal.id,continued.proposalId)
})

test('configured article models retain reasoning effort and validate without changing the default',async t=>{
  const f=await fixture(t),selected={provider:'test',model:'test',reasoningEffort:'high'}
  f.jobs.models={text:selected};await f.jobs.start(actor,f.request);await tick()
  assert.deepEqual(f.handles[0]!.options.agentOptions,selected)
  assert.deepEqual(f.ctx.agentDefaultModel.currentSelection(),{provider:'test',model:'test'})
})

test('article jobs reject removed configured models and failed routes without falling back',async t=>{
  const f=await fixture(t);f.jobs.models={text:{provider:'test',model:'removed'}}
  const removed=await f.jobs.start(actor,f.request);await tick()
  assert.equal(f.handles.length,0);assert.match((await f.jobs.get(actor,removed.id)).error.message,/不在当前目录/)
  f.jobs.models={};f.ctx.llm.resolveCallConfig=async()=>{throw new Error('fixture route unavailable')}
  const unroutable=await f.jobs.start(actor,{...f.request,requestId:'unroutable'});await tick()
  assert.equal(f.handles.length,0);assert.match((await f.jobs.get(actor,unroutable.id)).error.message,/路由当前不可用/)
})

for(const method of ['modelCatalog','resolveCallConfig'] as const)test(`article actor is rechecked after ${method} without relying on the revocation timer`,async t=>{
  const f=await fixture(t),gate=f.holdModel(method),job=await f.jobs.start(actor,f.request),b=f.jobs.active.get(job.id)!
  await gate.entered;f.revoke({recheck:false});gate.release();await b.runPromise
  assert.equal(f.handles.length,0);assert.equal(f.jobs.active.size,0)
  assert.equal((await f.store.jobGet('user:writer',job.id)).status,'failed')
})

test('cancelling an article job during model validation never starts a late Agent',async t=>{
  const f=await fixture(t),gate=f.holdModel('resolveCallConfig'),job=await f.jobs.start(actor,f.request),b=f.jobs.active.get(job.id)!
  await gate.entered;f.jobs.cancel(actor,job.id);gate.release();await b.runPromise
  assert.equal(f.handles.length,0);assert.equal((await f.jobs.get(actor,job.id)).status,'cancelled')
})
