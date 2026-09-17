/**
 * 批 2 B2-2b 拆库接线专项：busy 进程内镜像（四耦合点之 2）与附件双路径 scope（之 4）。
 *
 * 用 SQLite 测试实现（与生产 PG 同一异步方法面）验证**接线语义**：
 * - 镜像与真实 pending 一致：写路径维护、并发翻转、prepared 过期、重启后从存储恢复一次；
 * - 附件的 draftId 既可以是草稿 id（业务存储核验）也可以是会话 id（索引侧核验），
 *   两路 scope 拒绝口径不回归。
 */
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlogStore } from '../src/store.ts'
import type { BlogRecord } from '../src/store.ts'
import { ChatStore } from '../src/chat-store.ts'
import { BlogApplication, PendingOperationsMirror } from '../src/application.ts'
import type { BlogOperation } from '../src/application.ts'
import { BlogAttachments } from '../src/attachments.ts'
// 索引库切 PG 之后夹具换成运行时的内存端口（见 `index-fixture.ts`）：`ChatStore` 不再自己开库。
import { memoryIndex } from './index-fixture.ts'

const owner='user:mirror'

/**
 * `BlogApplication` 的桥接器形参（`src/application.ts` 的 `BlogClientPort`）。
 *
 * ⚠️ 本文件的替身只实现一个"必炸"的 `call`（用例根本不走桥接路径）⇒ 构造处按 `unknown`
 * 越界一次，免得把"夹具比端口窄"伪装成已满足。
 */
interface BridgePort {
  call(action: string, args?: unknown, signal?: AbortSignal): Promise<any>
  get(cid: number, signal?: AbortSignal): Promise<any>
  list(query?: string, page?: number, signal?: AbortSignal, status?: string): Promise<any>
  search(input?: unknown, signal?: AbortSignal): Promise<any>
}

/** 夹具自己的身份字面量（`namespace: string` 是夹具口径，与 `OwnerActor` 的开放索引一致）。 */
interface FixtureActor { namespace: string; userId: string; sessionId: string }

/** 本文件真正读到的会话端口面（`blog-chat-*` 那一路的归属核验）。 */
interface ScopeConversations { assertScope(owner: string, id: string): Promise<unknown> }
/** 另半：业务存储侧的核验（草稿 id 那一路）。 */
interface ScopeStorage { get(owner: string, id: string): Promise<unknown> }

/**
 * `operationInsert` / `operationSave` 的入参。
 *
 * ⚠️ `src/application.ts` 的 `BlogOperation` 把 `mode` / `title` / `payload` 写成**必填**，
 * 而落库实现只整层写 JSON、不读这三项（`operationSave` 是"合并写"，见 `storage/pg.ts`）。
 * 本文件的镜像用例只需要 `id` / `chat` / `status` / `expiresAt` 四项，所以夹具按**真正用到**的
 * 字段声明，交给应用的边界处按 `unknown` 越界一次（见 `asOperation`）。
 */
interface MirrorOperation {
  id: string
  owner: string
  draftId: string
  revision: number
  status: string
  chat?: { conversationId: string }
  expiresAt?: number
}

/**
 * 归一到应用侧声明的形状（见 `MirrorOperation` 的说明：这一处是**夹具边界**）。
 *
 * 只在 `operationSave()` 上用：它的形参类型（读路径记录，`title` / `mode` 必填）比本夹具
 * 真正写的字段严。**不能**改成"补齐 `title`/`mode` 再传"——`BlogStore.operationSave` 是
 * **整层覆盖写**（`UPDATE … SET payload=?`），补字段就改掉了落库载荷。
 */
const asOperation = (op: unknown): BlogOperation => op as BlogOperation

/**
 * `operationSave()` 的形参类型（读路径记录，源侧未导出）从这里取。
 *
 * ⚠️ **不补齐字段**：`BlogStore.operationSave` 是整层覆盖写，补了就是改落库载荷；
 * 这里只在类型层把它标成"与形参同型"，运行期原样传。
 */
type SavedOperation = Parameters<BlogApplication['operationSave']>[1]
const asSavedOperation = (op: unknown): SavedOperation => op as SavedOperation

/** 假宿主的附件服务面（`ctx.attachments`）：本夹具真的会跑到的两个方法。 */
interface AttachmentProvider {
  saveFileStream(input: { data: AsyncIterable<Uint8Array>; name: string }): Promise<{ attachmentId: string; name: string; bytes: number }>
  readFileStream(ref: { name: string }): AsyncGenerator<Uint8Array>
}

/** 读回原文件：夹具只放得进已上传的那一个，取不到就是**用例缺陷**，如实抛（不静默 yield `undefined`）。 */
async function* readFixtureFile(files: Map<string, Buffer>, name: string): AsyncGenerator<Uint8Array> {
  const bytes = files.get(name)
  if (bytes === undefined) throw new Error(`夹具里没有名为 ${name} 的原文件`)
  yield bytes
}

/** 双路径 scope 谓词：与 blog index.ts 装配处同一组合方式。 */
function dualScope(conversations:ScopeConversations,storage:ScopeStorage){
  return (o:string,id:string)=>id.startsWith('blog-chat-')?conversations.assertScope(o,id):storage.get(o,id)
}

test('pending mirror tracks write paths, concurrent flips and prepared expiry like the old direct query',async t=>{
  const store=new BlogStore(':memory:');await store.init();t.after(()=>store.close())
  const pending=new PendingOperationsMirror()
  const index=new ChatStore(memoryIndex(),()=>pending.ids())
  const app=new BlogApplication(store,{assert(){}},{call:async()=>{throw new Error('unused')}} as unknown as BridgePort,null,null,null,null,pending)
  const op=(id:string,status:string,conversationId:string,expiresAt?:number):MirrorOperation=>({id,owner,draftId:'draft-x',revision:1,status,...(conversationId?{chat:{conversationId}}:{}),...(expiresAt===undefined?{}:{expiresAt})})
  // 初始为空：没有任何待核对操作。
  assert.deepEqual(index.pendingOperations(),[])
  // 写路径：prepared 未过期计入；running/uncertain 计入。
  await app.operationInsert(asOperation(op('o1','prepared','c1',Date.now()+60000)))
  await app.operationInsert(asOperation(op('o2','running','c2')))
  await app.operationInsert(asOperation(op('o3','uncertain','c3')))
  // 并发翻转：多个写同时进行，镜像最终状态与串行一致。
  await Promise.all([
    app.operationSave('o2',asSavedOperation({status:'succeeded',chat:{conversationId:'c2'}})),
    app.operationSave('o3',asSavedOperation({status:'conflict',chat:{conversationId:'c3'}})),
    app.operationInsert(asOperation(op('o4','prepared','c4',Date.now()-1000))),
  ])
  assert.deepEqual(index.pendingOperations(),['c1'])
  // 与存储直查同口径（镜像 vs 真实 pending 集合一致）。
  assert.deepEqual([...(await store.pendingOperations())].sort(),['c1'])
  await app.operationSave('o1',asSavedOperation({status:'cancelled',chat:{conversationId:'c1'}}))
  assert.deepEqual(index.pendingOperations(),[])
  assert.deepEqual(await store.pendingOperations(),[])
})

test('pending mirror restores once from storage on restart, including prepared not yet expired',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'blog-mirror-'))
  const file=join(directory,'business.sqlite')
  const first=new BlogStore(file);await first.init()
  const conversations=new ChatStore(memoryIndex())
  try{
    const app=new BlogApplication(first,{assert(){}},{call:async()=>{throw new Error('unused')}} as unknown as BridgePort,null,null,null,null,new PendingOperationsMirror())
    const op=(id:string,status:string,conversationId:string,expiresAt:number):MirrorOperation=>({id,owner,draftId:'draft-y',revision:1,status,chat:{conversationId},expiresAt})
    await app.operationInsert(asOperation(op('p1','running','k1',Date.now()+60000)))
    await app.operationInsert(asOperation(op('p2','prepared','k2',Date.now()+60000)))
    await app.operationInsert(asOperation(op('p3','prepared','k3',Date.now()-1000)))
    await app.operationInsert(asOperation(op('p4','succeeded','k4',Date.now()+60000)))
    assert.deepEqual([...(await first.pendingOperations())].sort(),['k1','k2'])
  }finally{first.close()}
  // “重启”：新开业务库与索引侧实例，镜像从存储恢复一次后与直查一致。
  //
  // ⚠️ 索引侧这里用的是**另一个内存门面**，不是"重开同一个 SQLite 文件"：内存端口不持久
  //（`storage/memory.ts` 文件头那张表写着）。本用例真正要验的是 `PendingOperationsMirror` 从
  // **业务库**恢复一次之后与直查一致，索引侧只是"有一个 pendingSource 的持有者"。
  const second=new BlogStore(file);await second.init();t.after(()=>second.close())
  const restoredIndex=new ChatStore(memoryIndex())
  const mirror=await new PendingOperationsMirror().restore(second)
  // `pendingSource` 是 `ChatStore` 的私有字段，运行期可写（TS 的 `private`/`readonly` 不落到 JS）。
  // ⇒ 这一处按**运行期可写**如实越界一次（类型层它是私有的、只读的）。
  ;(restoredIndex as unknown as { pendingSource: () => readonly string[] }).pendingSource=()=>mirror.ids()
  assert.deepEqual([...restoredIndex.pendingOperations()].sort(),['k1','k2'])
  assert.deepEqual([...(await second.pendingOperations())].sort(),['k1','k2'])
})

test('attachment scope keeps both draft-id and conversation-id paths with unchanged rejection wording',async t=>{
  const store=new BlogStore(':memory:');await store.init();t.after(()=>store.close())
  const index=new ChatStore(memoryIndex(),()=>[])
  const actor={namespace:'user',userId:'mirror',sessionId:'login'}
  const foreign={...actor,userId:'other'}
  const draft=await store.create(owner)
  const conversation=await index.create(owner,'scope-conversation')
  const effects:(() => unknown)[]=[],files=new Map<string,Buffer>()
  const provider:AttachmentProvider={async saveFileStream({data,name}){const parts:Uint8Array[]=[];for await(const chunk of data)parts.push(chunk);const b=Buffer.concat(parts);files.set(name,b);return{attachmentId:name,name,bytes:b.length}},readFileStream(ref){return readFixtureFile(files,ref.name)}}
  const ctx={effect(fn:() => unknown){effects.push(fn)},on(){return()=>{}},get(name:string){return name==='attachments'?provider:undefined},attachments:provider}
  const attachments=new BlogAttachments(ctx,{assert(){}},store,dualScope(index,store))
  t.after(async()=>{await attachments.close();for(const dispose of effects)await dispose?.()})
  const bytes=Buffer.from('资料内容')
  // 草稿 id 路径：归属自己的草稿可上传、可读取。
  const onDraft=await attachments.upload(actor,draft.id,'draft.txt',async()=>bytes)
  assert.equal(onDraft.status,'ready')
  // 会话 id 路径：blog-chat-* 前缀由索引侧核验，同样可上传、可读取。
  const onConversation=await attachments.upload(actor,conversation.id,'notes.txt',async()=>bytes)
  assert.equal(onConversation.status,'ready')
  assert.deepEqual((await attachments.list(actor,draft.id)).map((a:{id:string})=>a.id),[onDraft.id])
  assert.deepEqual((await attachments.list(actor,conversation.id)).map((a:{id:string})=>a.id),[onConversation.id])
  // 双路径拒绝口径：草稿路径的 404 来自业务存储（草稿不存在或无权访问）。
  await assert.rejects(attachments.upload(actor,'missing-draft','x.txt',async()=>bytes),/草稿不存在或无权访问/)
  await assert.rejects(attachments.list(foreign,draft.id),/草稿不存在或无权访问/)
  await assert.rejects(attachments.get(foreign,draft.id,onDraft.id),/草稿不存在或无权访问/)
  // 会话路径的 404 来自索引侧（对话不存在或无权访问）。
  await assert.rejects(attachments.upload(actor,'blog-chat-missing','x.txt',async()=>bytes),/对话不存在或无权访问/)
  await assert.rejects(attachments.list(foreign,conversation.id),/对话不存在或无权访问/)
  await assert.rejects(attachments.get(actor,conversation.id,'missing-attachment'),/附件不存在或无权访问/)
})
