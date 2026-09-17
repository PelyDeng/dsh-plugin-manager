import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {BlogStore} from '../src/store.ts'
import {BlogApplication} from '../src/application.ts'
import {BlogClient} from '../src/connectors.ts'
const actor={namespace:'user',userId:'writer',sessionId:'session'},owner='user:writer'

/** 夹具自己的身份字面量（`namespace: string` 是夹具口径，与 `OwnerActor` 的开放索引一致）。 */
interface FixtureActor { namespace: string; userId: string; sessionId: string }

/**
 * `BlogApplication` 的桥接器形参（`src/application.ts` 的 `BlogClientPort`）。
 *
 * ⚠️ 本文件的替身**只实现被测分支真的会调到的动作**（`manage-preview` / `manage-write` /
 * `receipt`），另外三个方法只在别的路径上用得到 ⇒ 构造处按 `unknown` 越界一次，
 * 免得把"夹具比端口窄"伪装成已满足。
 */
interface BridgePort {
  call(action: string, args?: unknown, signal?: AbortSignal): Promise<any>
  get(cid: number, signal?: AbortSignal): Promise<any>
  list(query?: string, page?: number, signal?: AbortSignal, status?: string): Promise<any>
  search(input?: unknown, signal?: AbortSignal): Promise<any>
}

/** `app.call(actor,'manage-prepare',…)` 交回的那一份（用例只读 `id` 与 `nonce`）。 */
interface ManagementPreview { id: string; nonce?: string }

/** 分类树的一行（`web/management.js` 的 `readTaxonomy` / `categoryPath` 读的字段）。 */
interface TaxonomyItem { id: number; parent: number; name: string }

/** `readTaxonomy` 每次分页请求带的那一份参数（用例按 `page` / `query` 核验）。 */
interface TaxonomyCall { kind: string; page: number; query: string }

/**
 * `prepareManagement()` 的 `chat` 形参（源侧 `ChatBindingPort`）。
 *
 * ⚠️ 夹具只给 `conversationId`（本用例验的是"只能从**原对话**确认"），而源侧把 `requestId`
 * 写成必填（真装配一定带它）⇒ 在**构造替身处**按形参类型收口一次，运行期原样传。
 */
type ChatBinding = NonNullable<Parameters<BlogApplication['prepareManagement']>[3]>

test('all blog users share management with frozen confirmation, owner/session guard and receipt reconciliation',async t=>{
  const store=new BlogStore(':memory:');await store.init();t.after(()=>store.close());let revoked=false,writes=0,lost=true
  const receipts=new Map<string,unknown>(),blog={async call(action:string,args:Record<string,any>):Promise<unknown>{
    if(action==='manage-preview')return{title:'分类',input:{...args,version:'frozen'},impact:{relatedCount:2}}
    if(action==='manage-write'){writes++;assert.equal(args.version,'frozen');const result={id:3,kind:'category'};receipts.set(args.requestId,result);if(lost){lost=false;throw Error('lost response')}return result}
    if(action==='receipt')return{status:'succeeded',result:receipts.get(args.requestId)}
  }}
  const app=new BlogApplication(store,{assert(){assert.ok(!revoked,'revoked')}},blog as unknown as BridgePort)
  const args={kind:'category',operation:'update',id:3,fields:{name:'改名'}}
  const p=await app.call(actor,'manage-prepare',args) as ManagementPreview;args.fields.name='later';assert.equal(writes,0)
  await assert.rejects(app.confirm({...actor,userId:'other'},p),/无权/)
  await assert.rejects(app.confirm({...actor,sessionId:'other'},p),/失效/)
  await assert.rejects(app.confirm(actor,p),/lost/);assert.equal(writes,1)
  await assert.rejects(app.confirm(actor,p),/核对/)
  assert.equal((await app.reconcile(actor,p.id)).status,'succeeded');assert.equal(writes,1)
  assert.equal((await app.operation(owner,p.id)).payload.fields.name,'改名')
  revoked=true;await assert.rejects(app.call(actor,'manage-list',{kind:'tag'}),/revoked/)
})
test('conversation management can only be confirmed from its own conversation',async t=>{
  const store=new BlogStore(':memory:');await store.init();t.after(()=>store.close());let writes=0
  const blog={async call(action:string,input:Record<string,any>):Promise<unknown>{if(action==='manage-preview')return{input,title:'评论'};writes++;return{id:2}}}
  const app=new BlogApplication(store,{assert(){}},blog as unknown as BridgePort),chat={conversationId:'conversation'} as unknown as ChatBinding
  const p=await app.prepareManagement(actor,{kind:'comment',operation:'delete',id:2},undefined,chat)
  await assert.rejects(app.confirm(actor,p),/原对话/)
  await assert.rejects(app.confirm(actor,p,'other'),/原对话/)
  assert.equal(writes,0);assert.equal((await app.confirm(actor,p,'conversation')).status,'succeeded');assert.equal(writes,1)
})
test('read-only connector actions cannot be replaced by fields supplied in arguments',async()=>{
  /**
   * 夹具截获的那份请求体（`BlogClient` 交给 transport 的 JSON）。
   *
   * 按**开放字典**声明而不是留空：留空时 TS 在"赋值发生在回调里"这点上只能把它当成
   * `undefined`（`body.action` 报 TS18048）。这个袋子按字段取值，要守的是断言而不是它。
   */
  let body:Record<string,unknown>={}
  const blog=new BlogClient({url:'https://example.invalid',username:'fixture',password:'fixture'},async(url,options)=>{body=JSON.parse(String(options?.body));return new Response(JSON.stringify({ok:true,data:{items:[]}}))})
  await blog.call('manage-list',{action:'manage-write',protocolVersion:999,kind:'comment'})
  assert.equal(body.action,'manage-list');assert.equal(body.protocolVersion,1)
})

test('category navigation retains ancestors across pages and excludes descendants from parent choices',async()=>{
  const {readTaxonomy,categoryPath,parentChoices}=await import('../web/management.js')
  const rows:TaxonomyItem[]=[{id:3,parent:0,name:'摘抄笔记'},{id:5,parent:3,name:'算法小抄'},{id:9,parent:5,name:'排序'},{id:35,parent:0,name:'开发工具'}]
  const calls:TaxonomyCall[]=[],api=async(action:string,args:TaxonomyCall)=>{calls.push(args);return{items:rows.slice((args.page-1)*2,args.page*2),hasMore:args.page===1}}
  // `readTaxonomy` 的第三参（`isCurrent`）缺省是 `()=>true` ⇒ 本次调用**不会**走到那个 `null` 分支。
  const items=await readTaxonomy(api,'category') as TaxonomyItem[]
  assert.equal(items.length,4);assert.deepEqual(calls.map(c=>c.page),[1,2]);assert.ok(calls.every(c=>c.query===''))
  assert.deepEqual(categoryPath(items,9).map(item=>item.id),[3,5,9])
  assert.deepEqual(parentChoices(items,3).map((item:TaxonomyItem)=>item.id),[35])
  assert.deepEqual(parentChoices(items,5).map((item:TaxonomyItem)=>item.id),[3,35])
  assert.equal(await readTaxonomy(api,'category',()=>false),null)
  const cyclic=[{id:1,parent:2},{id:2,parent:1}]
  assert.equal(categoryPath(cyclic,1).length,2)
})
