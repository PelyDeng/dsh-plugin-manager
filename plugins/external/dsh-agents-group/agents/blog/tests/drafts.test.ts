import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.ts'
import { BlogApplication } from '../src/application.ts'
import { searchDrafts } from '../src/search.ts'

/**
 * `BlogApplication.call` 按动作名分派、返回类型是 `unknown`（载荷形状由动作决定）：
 * 断言只读下面这些字段，在**返回值边界**上收窄一次，运行时值不变。
 */
interface AppCallResult {
  readonly id: string
  readonly nonce: string
  readonly source: string
  readonly text: string
  readonly title: string
  readonly proposal: unknown
  readonly after: { readonly text: string }
}

/**
 * `importDraft` 回的是**存储记录**，而 `application.ts` 的 `BlogDraft` 只声明应用自身读写的字段；
 * 断言还要读正文列与候选稿 id，所以按用到的字段在返回值边界上收窄一层。
 */
interface ImportedDraft {
  readonly id: string
  readonly revision: number
  readonly text: string
  readonly proposal?: { readonly id: string } | null
}

/** 桥接器替身记下的写回执：断言只读 `content.tags`。 */
interface BlogCallArgs { readonly content: { readonly tags: string[] } }
/** 桥接器替身：`call` 记回执，`get` 由用例在需要时替换（第一段流程里它本来就不存在）。 */
interface BlogBridgeStub {
  call(action: string, args: BlogCallArgs): Promise<{ snapshot: { version: string; published: { cid: number; tags: string[] } }; url: string }>
  get?(): Promise<unknown>
}

/** 远端文章替身（用例逐字段改它）。 */
interface RemoteArticleStub {
  cid: number
  title: string
  text: string
  tags: string[]
  categories: number[]
  raw: { text: string; views: number; modified: number; commentsNum: number }
  fields: { name: string; value: string }[]
}
/** 远端快照替身上的改动目标：`savedDraft` 允许被清成 null（真实桥接会这样返回）。 */
interface RemoteChangeTarget {
  version: string
  selectedVariant?: string
  published: RemoteArticleStub
  savedDraft: RemoteArticleStub | null
}

/**
 * `BlogApplication` 的桥接端口与 `applyResult` 的入参（`application.ts` 里这两个类型**未导出**）：
 * 夹具只实现用例真正走到的那几个面，所以在**调用边界**上按方法签名收窄一次，运行期值一个字没变。
 */
type BlogBridgePort = NonNullable<ConstructorParameters<typeof BlogApplication>[2]>
type ApplyResultOperation = Parameters<typeof BlogApplication.prototype.applyResult>[0]
/** `BlogApplication` 的写作任务端口（同样未导出）：夹具只给用例走到的那一个面（`modelArticle`）。 */
type AppJobsPort = NonNullable<ConstructorParameters<typeof BlogApplication>[5]>
/** `modelArticle` 的入参形状（`RemoteArticle` 也未导出，所以按方法签名取）。 */
type ModelArticleInput = Parameters<AppJobsPort['modelArticle']>[0]

/** 构造已 init 的 SQLite 业务存储（与生产 PG 存储同一异步方法面的测试实现）。 */
async function fixture(t: TestContext){const s=new BlogStore(':memory:');t.after(()=>s.close());await s.init();return s}

test('deleted remote copies retain content and deletion state without becoming new writing activity',async t=>{
  const s=await fixture(t)
  const actor={namespace:'n',userId:'u',sessionId:'s'},app=new BlogApplication(s,{assert(){}})
  const yesterday=Date.parse('2026-09-07T12:00:00+08:00'),today=Date.parse('2026-09-08T12:00:00+08:00')
  const d=await s.create('n:u',{title:'保留副本',text:'未发布修改'},{published:{cid:338},version:'v'})
  s.db.prepare('UPDATE blog_drafts SET payload=? WHERE id=?').run(JSON.stringify({...d,createdAt:yesterday,updatedAt:yesterday,contentUpdatedAt:yesterday}),d.id)
  await app.applyResult({id:'delete-338',owner:'n:u',mode:'delete',before:{published:{cid:338}}} as unknown as ApplyResultOperation,{deleted:true} as unknown as Parameters<typeof app.applyResult>[1])
  const saved=await s.get('n:u',d.id),listed=(await s.list('n:u'))[0]!,searched=(await searchDrafts(s,'n:u',{},today)).items[0]!
  assert.equal(saved.text,'未发布修改');assert.equal(saved.remote.deleted,true)
  assert.equal(listed.remote?.deleted,true);assert.equal(searched.remote?.deleted,true)
  assert.equal(listed.contentUpdatedAt,yesterday);assert.equal(searched.localTime.modified,'2026-09-07 12:00:00')
  assert.equal((await searchDrafts(s,'n:u',{period:'today'},today)).total,0)
  await assert.rejects(app.prepare(actor,{id:d.id,revision:saved.revision,mode:'publish'}),/原文已删除/)
  const edited=await s.edit('n:u',d.id,saved.revision,{...saved,text:'删除后继续手写'})
  assert.ok(edited.contentUpdatedAt!>yesterday);assert.equal(edited.remote.deleted,true)
})

test('legacy deleted copies report unknown content time and missing creation counts are not extra drafts',async t=>{
  const s=await fixture(t);const now=Date.parse('2026-09-08T12:00:00+08:00')
  const d=await s.create('user:u',{title:'旧副本'},{savedDraft:{cid:337},deleted:true,deletedAt:now})
  const legacy={...d,updatedAt:now};delete legacy.createdAt;delete legacy.contentUpdatedAt
  s.db.prepare('UPDATE blog_drafts SET payload=? WHERE id=?').run(JSON.stringify(legacy),d.id)
  const all=await searchDrafts(s,'user:u',{},now),dated=await searchDrafts(s,'user:u',{period:'today'},now)
  assert.equal(all.items[0]!.contentUpdatedAt,null);assert.equal(all.items[0]!.localTime.modified,null)
  assert.equal(all.items[0]!.contentTimeSource,'unknown')
  assert.equal(dated.total,0);assert.equal(dated.unknownDateCount,1)
  assert.match(dated.dateNote,/重叠/);assert.match(dated.dateNote,/原文已删除/)
  assert.deepEqual(all,JSON.parse(JSON.stringify(all)))
})

test('legacy record time remains labelled as approximate until a real content edit',async t=>{
  const s=await fixture(t)
  const d=await s.create('user:u',{title:'旧稿',text:'正文'}),legacy={...d};delete legacy.contentUpdatedAt
  s.db.prepare('UPDATE blog_drafts SET payload=? WHERE id=?').run(JSON.stringify(legacy),d.id)
  assert.equal((await s.list('user:u'))[0]!.contentTimeSource,'legacy-record')
  const status=await s.save('user:u',d.id,d.revision,{proposal:null})
  assert.equal((await s.list('user:u'))[0]!.contentTimeSource,'legacy-record');assert.equal(status.contentUpdatedAt,d.updatedAt)
  await s.edit('user:u',d.id,status.revision,{...status,text:'实际修改'})
  assert.equal((await s.list('user:u'))[0]!.contentTimeSource,'content')
})

test('opening an unchanged remote version reuses the owner draft and preserves edits and candidates',async t=>{
  const s=await fixture(t);const actor={namespace:'n',userId:'u',sessionId:'s'}
  let remote={version:'v1',published:{cid:338,title:'原文',text:'正文',slug:'338',format:'markdown',tags:[],categories:[]},savedDraft:null}
  // 夹具只给 `get` 一个面（`list`/`search` 这些用例走不到）：按构造函数签名在装配边界上收窄一次。
  const app=new BlogApplication(s,{assert(){}},{get:async()=>structuredClone(remote)} as unknown as BlogBridgePort)
  const first=await app.importDraft(actor,338,'published'),edited=await s.edit('n:u',first.id,first.revision,{...first,text:'手写未发布'})
  const p=await s.propose('n:u',first.id,edited.revision,{text:'候选'},[])
  const again=await app.importDraft(actor,338,'published') as ImportedDraft
  assert.equal(again.id,first.id);assert.equal(again.text,'手写未发布');assert.equal(again.proposal?.id,p.id)
  assert.equal((await s.list('n:u')).length,1)
  const other=await app.importDraft({...actor,userId:'user:other'},338,'published');assert.notEqual(other.id,first.id)
  remote={...remote,version:'v2',published:{...remote.published,text:'博客已更新'}}
  const fresh=await app.importDraft(actor,338,'published') as ImportedDraft;assert.notEqual(fresh.id,first.id)
  assert.equal((await s.get('n:u',first.id)).text,'手写未发布');assert.equal(fresh.text,'博客已更新')
})

test('draft listing is lossless JSON when only one remote variant exists',async t=>{
  const s=await fixture(t)
  await s.create('user:u',{title:'昨天的文章'}, {published:{cid:338},savedDraft:null})
  await s.create('user:u',{title:'博客草稿'}, {published:null,savedDraft:{cid:337}})
  const rows=await s.list('user:u')
  assert.deepEqual(rows,JSON.parse(JSON.stringify(rows)))
})

test('manual edits cannot be overwritten by a stale model proposal',async t=>{
  const s=await fixture(t)
  const d=await s.create('user:u',{title:'first',text:'<!--raw--> body'})
  const candidate=await s.propose('user:u',d.id,1,{text:'model'},[])
  await s.edit('user:u',d.id,1,{...d,text:'handwritten'})
  await assert.rejects(s.applyProposal('user:u',d.id,2,candidate.id,['text']),/基线/)
  assert.equal((await s.get('user:u',d.id)).text,'handwritten')
})

test('discarding a candidate preserves article content and rejects stale or foreign deletes',async t=>{
  const s=await fixture(t)
  const actor={namespace:'n',userId:'u',sessionId:'s'},app=new BlogApplication(s,{assert(){}})
  const d=await s.create('n:u',{title:'文章',text:'保留正文'}),p=await s.propose('n:u',d.id,1,{text:'候选正文'},[])
  await assert.rejects(app.call({...actor,userId:'user:other'},'discard-proposal',{id:d.id,revision:1,proposalId:p.id}),/无权/)
  const newer=await s.propose('n:u',d.id,1,{text:'新候选'},[])
  await assert.rejects(app.call(actor,'discard-proposal',{id:d.id,revision:1,proposalId:p.id}),/候选稿已变化/)
  const edited=await s.edit('n:u',d.id,1,{...d,text:'手动修改'})
  await assert.rejects(app.call(actor,'discard-proposal',{id:d.id,revision:1,proposalId:newer.id}),/其他窗口/)
  const result=await app.call(actor,'discard-proposal',{id:d.id,revision:edited.revision,proposalId:newer.id}) as AppCallResult
  assert.equal(result.proposal,null);assert.equal(result.text,'手动修改');assert.equal(result.title,d.title)
  assert.equal((await s.get('n:u',d.id)).proposal,null)
})

test('publishing a candidate freezes latest text and tags, applies only after confirmation, and rejects deleted candidates',async t=>{
  const s=await fixture(t);const writes: BlogCallArgs[]=[]
  const actor={namespace:'n',userId:'u',sessionId:'s'},blog: BlogBridgeStub={call:async(action,args)=>{writes.push(args);return{snapshot:{version:'v2',published:{cid:339,...args.content}},url:'https://example.invalid/339'}}}
  // 两个替身都只给用例走到的面（桥接器 `call`/`get`，写作任务只有 `modelArticle`）：在装配边界上各收窄一次。
  const app=new BlogApplication(s,{assert(){}},blog as unknown as BlogBridgePort,null,null,{modelArticle:(p: ModelArticleInput)=>p} as unknown as AppJobsPort)
  const d=await s.create('n:u',{title:'文章',text:'原文'}),p=await s.propose('n:u',d.id,1,{text:'新正文',tags:['新标签']},[])
  const prepared=await app.call(actor,'prepare',{id:d.id,revision:1,mode:'publish',proposalId:p.id}) as AppCallResult
  assert.equal(p.before.text,'原文');assert.equal(p.before.title,d.title);
  assert.equal(prepared.after.text,'新正文');assert.equal(prepared.source,'proposal');assert.equal(writes.length,0);assert.equal((await s.get('n:u',d.id)).text,'原文')
  await app.call(actor,'confirm',{id:prepared.id,nonce:prepared.nonce})
  assert.equal(writes.length,1);assert.deepEqual(writes[0]!.content.tags,['新标签']);assert.equal((await s.get('n:u',d.id)).text,'新正文');assert.equal((await s.get('n:u',d.id)).proposal,null)
  const updated=await s.get('n:u',d.id);blog.get=async()=>updated.remote
  const next=await s.propose('n:u',d.id,updated.revision,{text:'应删除的候选'},[])
  const stale=await app.call(actor,'prepare',{id:d.id,revision:updated.revision,mode:'publish',proposalId:next.id}) as AppCallResult
  await app.call(actor,'discard-proposal',{id:d.id,revision:updated.revision,proposalId:next.id})
  await assert.rejects(app.call(actor,'confirm',{id:stale.id,nonce:stale.nonce}),/已变化/)
  assert.equal(writes.length,1)
})
test('two confirmations for a new draft cannot create concurrent duplicate posts',async t=>{
  const s=await fixture(t);let finish!: (value: unknown) => void,calls=0
  const blog={call(){calls++;return new Promise(r=>{finish=r})}},actor={namespace:'n',userId:'u',sessionId:'s'}
  // 两个替身都只给用例走到的面（桥接器 `call`/`get`，写作任务只有 `modelArticle`）：在装配边界上各收窄一次。
  const app=new BlogApplication(s,{assert(){}},blog as unknown as BlogBridgePort,null,null,{modelArticle:(p: ModelArticleInput)=>p} as unknown as AppJobsPort)
  const d=await s.create('n:u',{title:'new',text:'new article'})
  const one=await app.prepare(actor,{id:d.id,revision:1,mode:'publish'}),two=await app.prepare(actor,{id:d.id,revision:1,mode:'publish'})
  const pending=app.confirm(actor,{id:one.id,nonce:one.nonce})
  await assert.rejects(app.confirm(actor,{id:two.id,nonce:two.nonce}),/已有提交/)
  assert.equal(calls,1)
  finish({version:'v',snapshot:{version:'v',published:{cid:1}}});await pending
  const replay=await app.confirm(actor,{id:one.id,nonce:one.nonce});assert.equal(replay.status,'succeeded');assert.equal(calls,1)
})
test('delegation idempotency is owner/caller scoped and rejects changed inputs',async t=>{
  const s=await fixture(t)
  const a=(await s.jobStart('user:u','router','request-123',{draftId:'one'},{})).job
  assert.equal((await s.jobStart('user:u','router','request-123',{draftId:'one'},{})).fresh,false)
  await assert.rejects(s.jobStart('user:u','router','request-123',{draftId:'two'},{}),/不同输入/)
  await assert.rejects(s.jobGet('user:other',a.id),/无权/)
})

test('legacy blog snapshots tolerate page views while preserving edits and rejecting real remote changes',async t=>{
  const s=await fixture(t)
  const actor={namespace:'n',userId:'u',sessionId:'s'}
  const variant={cid:339,title:'原文',text:'原正文',tags:[],categories:[],raw:{text:'原正文',views:10,modified:100,commentsNum:0},fields:[]}
  const base: { published: RemoteArticleStub; savedDraft: RemoteArticleStub; version: string; selectedVariant?: string }={published:variant,savedDraft:{...structuredClone(variant),cid:340},version:'legacy-with-views',selectedVariant:'published'}
  let remote=structuredClone(base),writes=0
  remote.version='current';remote.published.raw.views=12;remote.savedDraft.raw.views=11
  delete remote.selectedVariant
  const blog={get:async()=>structuredClone(remote),call:async()=>{writes++;return{snapshot:structuredClone(remote)}}}
  // 两个替身都只给用例走到的面（桥接器 `call`/`get`，写作任务只有 `modelArticle`）：在装配边界上各收窄一次。
  const app=new BlogApplication(s,{assert(){}},blog as unknown as BlogBridgePort,null,null,{modelArticle:(p: ModelArticleInput)=>p} as unknown as AppJobsPort)
  const d=await s.create('n:u',{title:'我的修改',text:'保留手写正文'},base)
  const proposal=await s.propose('n:u',d.id,1,{text:'保留候选正文'},[])
  const prepared=await app.prepare(actor,{id:d.id,revision:1,mode:'publish',proposalId:proposal.id})
  assert.equal(prepared.after?.text,'保留候选正文');assert.equal(writes,0)
  assert.deepEqual((await s.get('n:u',d.id)).remote,base);assert.equal((await s.get('n:u',d.id)).text,'保留手写正文')
  assert.equal((await app.operation('n:u',prepared.id)).payload.base?.version,'current')
  assert.equal((await app.operation('n:u',prepared.id)).payload.base?.published?.raw?.views,12)
  const unchanged=structuredClone(remote)
  for(const change of [
    (r: RemoteChangeTarget)=>{r.published.text='别人改了正文'},(r: RemoteChangeTarget)=>{r.published.title='别人改了标题'},
    (r: RemoteChangeTarget)=>{r.published.tags=['新标签']},(r: RemoteChangeTarget)=>{r.published.categories=[2]},
    (r: RemoteChangeTarget)=>{r.published.fields=[{name:'custom',value:'changed'}]},
    (r: RemoteChangeTarget)=>{r.published.raw.modified++},(r: RemoteChangeTarget)=>{r.published.raw.commentsNum++},
    (r: RemoteChangeTarget)=>{r.savedDraft!.text='别人改了保存稿'},(r: RemoteChangeTarget)=>{r.savedDraft=null},
  ]){
    remote=structuredClone(unchanged);change(remote)
    await assert.rejects(app.prepare(actor,{id:d.id,revision:1,mode:'publish',proposalId:proposal.id}),/博客.*变化|博客.*修改/)
  }
  assert.equal((await s.get('n:u',d.id)).proposal.id,proposal.id);assert.equal(writes,0)
})

/**
 * ⚠️ **归属是两列，"同名不同域"必须互相看不见。**
 *
 * `owner` 字符串（`ownerKey(actor)` 的产物）被切成 `owner_namespace` + `owner_id` 两列存储，
 * 而 `n:u` 与 `user:u` 的 **`owner_id` 都是 `u`**：只比 `owner_id` 的实现会让这两个不同命名空间的
 * 用户**共享同一份草稿**，而页面上完全看不出来（查询"成功"、拿到的却是别人的数据）。
 *
 * 为什么必须有这一条：`pg-smoke.test.ts` 那边就是因为原有的"跨 owner"用例**全部只差 `userId`**
 * （`u1` vs `u2`），**只比一列时照样全绿**，才补了同名不同域；替身这边此前**一条都没有**
 * —— 形状对齐之后这个洞会在替身上同样露出来。
 */
test('归属是两列：同名不同域（n:u 与 user:u）互相看不见',async t=>{
  const s=await fixture(t)
  const mine=await s.create('user:u',{title:'我的稿',text:'我的正文'})
  const other=await s.create('n:u',{title:'别人的稿',text:'别人的正文'})
  assert.deepEqual((await s.list('user:u')).map(d=>d.id),[mine.id])
  assert.deepEqual((await s.list('n:u')).map(d=>d.id),[other.id])
  await assert.rejects(s.get('n:u',mine.id),/不存在或无权访问/)
  await assert.rejects(s.save('n:u',mine.id,1,{text:'改别人的'}),/不存在或无权访问/)
  // 任务表（`blog_jobs`）的幂等键是 `(owner_namespace, owner_id, caller, request_id)`，同理。
  const job=(await s.jobStart('user:u','router','request-abcdefgh',{draftId:'d1'},{})).job
  assert.equal(await s.jobLookup('n:u','router','request-abcdefgh'),undefined)
  await assert.rejects(s.jobGet('n:u',job.id),/不存在或无权访问/)
  assert.ok(await s.jobLookup('user:u','router','request-abcdefgh'))
})
