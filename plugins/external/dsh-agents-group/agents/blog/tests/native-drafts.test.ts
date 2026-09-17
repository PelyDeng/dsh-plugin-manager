import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore,article } from '../src/store.ts'
import type { BlogRecord } from '../src/store.ts'
import { BlogApplication } from '../src/application.ts'

const actor={namespace:'test',userId:'writer',sessionId:'session'},owner='test:writer'

/** 夹具自己的身份字面量（`namespace` 是夹具口径，与 `OwnerActor` 的开放索引一致）。 */
interface FixtureActor { namespace: string; userId: string; sessionId: string }

/** 远端替身里一份快照：`version` 是乐观并发基线，两个版本按需出现（键随业务演进）。 */
interface RemoteSnapshot {
  version: string
  published: BlogRecord | null
  savedDraft: BlogRecord | null
  selectedVariant?: string
}

/**
 * 远端博客替身在本文件用到的面（`BlogApplication` 真的会调到的三个）。
 *
 * `records` 的 `cid` 由夹具自己编（从 10 起）⇒ 键按 `number` 声明；取到不存在的 `cid` 时
 * 与旧写法（`structuredClone(records.get(id))`）同值（`undefined`）。
 *
 * ⚠️ 这一份**不是** `BlogClientPort`：那三个方法在本夹具里只实现被测路径走到的那几支
 * （`list` 不返回分页字段、`call` 不接受 `signal`）。故在构造处**如实**越界一次
 * （`as unknown as BridgePort`），而不是把夹具面伪装成完整端口。
 */
interface NativeBlog {
  get(id: number): Promise<RemoteSnapshot | undefined>
  list(query: string, page: number, signal: AbortSignal | undefined, status: string): Promise<{ items: unknown[]; status: string; hasMore: boolean }>
  call(action: string, args: BlogRecord): Promise<unknown>
}

/** `BlogApplication` 的桥接器形参在本夹具里的收口（见 `NativeBlog` 的说明）。 */
interface BridgePort {
  call(action: string, args?: unknown, signal?: AbortSignal): Promise<any>
  get(cid: number, signal?: AbortSignal): Promise<any>
  list(query?: string, page?: number, signal?: AbortSignal, status?: string): Promise<any>
  search(input?: unknown, signal?: AbortSignal): Promise<any>
}

/**
 * `BlogApplication` 的写作任务形参（`src/application.ts` 的 `JobsPort`）。
 *
 * ⚠️ 本夹具只实现 `modelArticle`（用例不走任务那几条 action）⇒ 构造处按 `unknown` 越界一次，
 * 免得把"夹具比端口窄"这件事伪装成已满足（与 `BridgePort` 同一口径）。
 */
interface JobsPort {
  searchDrafts(owner: string, args: unknown, signal?: AbortSignal): Promise<unknown>
  start(actor: FixtureActor, request: unknown): Promise<unknown>
  get(actor: FixtureActor, id: string): Promise<unknown>
  cancel(actor: FixtureActor, id: string): Promise<unknown>
  modelArticle(article: unknown): unknown
}

/** `app.call()` 交回的几种结果：只声明各用例**真正读到**的字段（`call` 的声明面是 `unknown`）。 */
interface RemoteDraftVersion { cid: number; text?: string; categories?: number[]; allowComment?: boolean }
interface CreatedDraft { id: string; revision: number; blogNative: boolean; remote: { savedDraft: RemoteDraftVersion } }
interface ListedDraft { cid: number }
interface SavedDraft { text: string; revision: number; blogNative?: boolean; remote: { savedDraft: RemoteDraftVersion }; legacyRemote?: BlogRecord | null }
interface AppliedDraft { text: string; title: string; proposal: null; categories?: number[]; allowComment?: boolean }
interface MigratedDrafts { items: { cid: number }[]; remaining: number }

async function fixture(t: TestContext){
  const store=new BlogStore(':memory:');t.after(()=>store.close());await store.init()
  const records=new Map<number,RemoteSnapshot>(),receipts=new Map<string,unknown>(),writes:BlogRecord[]=[];let cid=10,loseResponse=false
  const blog:NativeBlog={async get(id){return structuredClone(records.get(id))},async list(q,page,signal,status){return{items:[...records].map(([cid,d])=>({cid,title:((d.savedDraft??d.published) as BlogRecord).title,hasPublished:!!d.published,hasSavedDraft:!!d.savedDraft})),status,hasMore:false}},async call(action,args){
    if(action==='status')return{nativeDrafts:true}
    if(action==='receipt')return receipts.has(String(args.requestId))?{status:'succeeded',result:receipts.get(String(args.requestId))}:{status:'unknown'}
    assert.equal(action,'save');writes.push(structuredClone(args))
    if(receipts.has(String(args.requestId)))return structuredClone(receipts.get(String(args.requestId)))
    const base=args.base as RemoteSnapshot | undefined
    const id=base?.published?.cid??base?.savedDraft?.cid??cid++,current=records.get(id)
    if(args.base&&current?.version!==(args.base as RemoteSnapshot).version)throw Object.assign(Error('conflict'),{status:409})
    const savedDraft={...args.content as BlogRecord,cid:current?.published?id+1000:id,type:'post_draft'},snapshot:RemoteSnapshot={published:current?.published??null,savedDraft,selectedVariant:'savedDraft',version:String(writes.length)}
    records.set(id,snapshot);const result={cid:id,snapshot,version:snapshot.version};receipts.set(String(args.requestId),result)
    if(loseResponse){loseResponse=false;throw Error('response lost')}
    return structuredClone(result)
  }}
  const app=new BlogApplication(store,{assert(){}},blog as unknown as BridgePort,null,null,{modelArticle:(p: unknown)=>p} as unknown as JobsPort)
  return{store,app,blog,records,writes,loseNextResponse(){loseResponse=true}}
}
test('new and manually edited content lives in a native blog draft, not a second library',async t=>{
  const f=await fixture(t),d=await f.app.call(actor,'create',{requestId:'new-article-1'}) as CreatedDraft
  assert.ok(d.blogNative);assert.ok(d.remote.savedDraft.cid);assert.equal(f.records.size,1)
  assert.equal((await f.app.call(actor,'drafts') as ListedDraft[])[0]!.cid,d.remote.savedDraft.cid)
  const saved=await f.app.call(actor,'save',{id:d.id,revision:d.revision,content:{...article(d),title:'标题',text:'内容'}}) as SavedDraft
  assert.equal(f.records.get(d.remote.savedDraft.cid)!.savedDraft!.text,'内容');assert.equal(saved.text,'内容')
  assert.equal((await f.store.list(owner)).length,1)
})
test('editing published content saves its native draft and leaves the public version intact',async t=>{
  const f=await fixture(t);f.records.set(339,{version:'old',published:{cid:339,title:'标题',text:'公开原文',slug:'',format:'markdown',tags:[],categories:[]},savedDraft:null})
  const d=await f.app.importDraft(actor,339,'published')
  await f.app.call(actor,'save',{id:d.id,revision:d.revision,content:{...article(d),text:'未发布修改'}})
  assert.equal((f.records.get(339)!.published as BlogRecord).text,'公开原文');assert.equal((f.records.get(339)!.savedDraft as BlogRecord).text,'未发布修改')
})
test('a lost creation response retries the frozen receipt without creating another draft',async t=>{
  const f=await fixture(t);f.loseNextResponse()
  await assert.rejects(f.app.call(actor,'create',{requestId:'lost-create-1'}),/lost/)
  const d=await f.app.call(actor,'create',{requestId:'lost-create-1'}) as CreatedDraft
  assert.ok(d.blogNative);assert.equal(f.records.size,1);assert.equal((await f.store.list(owner)).length,1)
  assert.equal(f.writes[0]!.requestId,f.writes[1]!.requestId)
})
test('lost save response and foreign changes preserve editing data and prevent overwrites',async t=>{
  const f=await fixture(t),d=await f.app.call(actor,'create',{requestId:'lost-save-01'}) as CreatedDraft
  const args={id:d.id,revision:d.revision,content:{...article(d),text:'待保存'}};f.loseNextResponse()
  await assert.rejects(f.app.call(actor,'save',args),/lost/)
  assert.equal((await f.store.get(owner,d.id)).text,'');assert.equal(((await f.app.operations(owner)).at(-1)!.payload.content as BlogRecord).text,'待保存')
  const saved=await f.app.call(actor,'save',args) as SavedDraft;assert.equal(saved.text,'待保存')
  const remote=f.records.get(saved.remote.savedDraft.cid)!;remote.version='external';(remote.savedDraft as BlogRecord).text='别处修改'
  await assert.rejects(f.app.call(actor,'save',{...args,revision:saved.revision,content:{...(args.content as BlogRecord),text:'不能覆盖'}}),/变化/)
  assert.equal((remote.savedDraft as BlogRecord).text,'别处修改');assert.equal((await f.store.get(owner,d.id)).text,'待保存')
})
test('migration retains blank, duplicate, linked and deleted copies as distinct blog drafts',async t=>{
  const f=await fixture(t),legacy=[await f.store.create(owner),await f.store.create(owner,{title:'同名',text:'甲'}),await f.store.create(owner,{title:'同名',text:'乙'},{published:{cid:339},deleted:true}),await f.store.create(owner,{title:'旧文副本',text:'丙'},{published:{cid:339}})]
  await f.store.create('test:other',{title:'其他人的内容'})
  const result=await f.app.call(actor,'migrate-drafts') as MigratedDrafts
  assert.equal(result.items.length,4);assert.equal(result.remaining,0);assert.equal(f.records.size,4)
  assert.equal(new Set(result.items.map(x=>x.cid)).size,4)
  for(const d of legacy){const migrated=await f.store.get(owner,d.id);assert.deepEqual(article(migrated),article(d));assert.deepEqual(migrated.legacyRemote,d.remote)}
  assert.equal((await f.app.call(actor,'migrate-drafts') as MigratedDrafts).items.length,0)
  assert.equal((await f.app.legacyDrafts('test:other')).length,1)
})
test('saving a legacy draft migrates it in place with the editor content',async t=>{
  const f=await fixture(t),legacy=await f.store.create(owner,{title:'旧稿',text:'旧文'})
  const saved=await f.app.call(actor,'save',{id:legacy.id,revision:legacy.revision,content:{...article(legacy),text:'编辑器内容'}}) as SavedDraft
  assert.ok(saved.blogNative);assert.equal(saved.remote.savedDraft.text,'编辑器内容')
  assert.equal(f.writes.length,1);assert.equal((f.writes[0]!.content as BlogRecord).text,'编辑器内容')
  const stored=await f.store.get(owner,legacy.id)
  assert.equal(stored.id,legacy.id);assert.deepEqual(stored.legacyRemote,legacy.remote)
  assert.equal((await f.app.legacyDrafts(owner)).length,0)
})
test('a lost legacy save retries the frozen migration receipt and still lands newer edits',async t=>{
  const f=await fixture(t),legacy=await f.store.create(owner,{title:'旧稿',text:'旧文'})
  const args={id:legacy.id,revision:legacy.revision,content:{...article(legacy),text:'第一版'}}
  f.loseNextResponse()
  await assert.rejects(f.app.call(actor,'save',args),/lost/)
  const again=await f.app.call(actor,'save',args) as SavedDraft
  assert.ok(again.blogNative);assert.equal(again.remote.savedDraft.text,'第一版')
  assert.equal(f.records.size,1);assert.equal(f.writes[0]!.requestId,f.writes[1]!.requestId)
  const newer=await f.app.call(actor,'save',{...args,revision:again.revision,content:{...(args.content as BlogRecord),text:'第二版'}}) as SavedDraft
  assert.equal(newer.text,'第二版');assert.equal((await f.store.get(owner,legacy.id)).text,'第二版')
})
test('saving an unchanged linked legacy copy keeps the original article untouched',async t=>{
  const f=await fixture(t);f.records.set(339,{version:'old',published:{cid:339,title:'原文',text:'公开原文',slug:'',format:'markdown',tags:[],categories:[]},savedDraft:null})
  const legacy=await f.store.create(owner,{title:'副本',text:'公开原文'},{published:{cid:339}})
  const saved=await f.app.call(actor,'save',{id:legacy.id,revision:legacy.revision,content:article(legacy)}) as SavedDraft
  assert.ok(saved.blogNative);assert.deepEqual(saved.legacyRemote,{published:{cid:339}})
  assert.equal((f.records.get(339)!.published as BlogRecord).text,'公开原文');assert.equal(f.records.size,2);assert.equal(f.writes.length,1)
})
test('AI proposals remain separate suggestions until selected fields are saved to the blog',async t=>{
  const f=await fixture(t),d=await f.app.call(actor,'create',{requestId:'proposal-new'}) as CreatedDraft
  const p=await f.store.propose(owner,d.id,d.revision,{title:'AI 标题',text:'AI 正文'},[]),before=f.writes.length
  assert.equal((f.records.get(d.remote.savedDraft.cid)!.savedDraft as BlogRecord).text,'')
  const result=await f.app.call(actor,'apply',{id:d.id,revision:d.revision,proposalId:p.id,fields:['text']}) as AppliedDraft
  assert.equal(f.writes.length,before+1);assert.equal(result.text,'AI 正文');assert.equal(result.title,'');assert.equal(result.proposal,null)
})
test('old bridge refuses native draft creation before creating local orphan records',async t=>{
  const f=await fixture(t);f.blog.call=async()=>({})
  await assert.rejects(f.app.call(actor,'create',{requestId:'old-bridge-1'}),/桥接扩展/)
  assert.equal((await f.store.list(owner)).length,0)
})


test('category and comment settings remain candidates until native draft application',async t=>{
  const f=await fixture(t),d=await f.app.call(actor,'create',{requestId:'settings-test'}) as CreatedDraft
  const p=await f.store.propose(owner,d.id,d.revision,{categories:[4],allowComment:false},[])
  assert.deepEqual((f.records.get(d.remote.savedDraft.cid)!.savedDraft as BlogRecord).categories,[])
  const saved=await f.app.call(actor,'apply',{id:d.id,revision:d.revision,proposalId:p.id,fields:['categories','allowComment']}) as AppliedDraft
  assert.deepEqual(saved.categories,[4]);assert.equal(saved.allowComment,false)
  assert.equal((f.records.get(d.remote.savedDraft.cid)!.savedDraft as BlogRecord).allowComment,false)
})
