/**
 * 批 2 B2-2b 拆库接线专项：busy 进程内镜像（四耦合点之 2）与附件双路径 scope（之 4）。
 *
 * 用 SQLite 测试实现（与生产 PG 同一异步方法面）验证**接线语义**：
 * - 镜像与真实 pending 一致：写路径维护、并发翻转、prepared 过期、重启后从存储恢复一次；
 * - 附件的 draftId 既可以是草稿 id（业务存储核验）也可以是会话 id（索引侧核验），
 *   两路 scope 拒绝口径不回归。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlogStore } from '../src/store.mjs'
import { ChatStore } from '../src/chat-store.ts'
import { BlogApplication, PendingOperationsMirror } from '../src/application.mjs'
import { BlogAttachments } from '../src/attachments.mjs'
// 索引库切 PG 之后夹具换成运行时的内存端口（见 `index-fixture.mjs`）：`ChatStore` 不再自己开库。
import { memoryIndex } from './index-fixture.mjs'

const owner='user:mirror'

/** 双路径 scope 谓词：与 blog index.ts 装配处同一组合方式。 */
function dualScope(conversations,storage){
  return (o,id)=>id.startsWith('blog-chat-')?conversations.assertScope(o,id):storage.get(o,id)
}

test('pending mirror tracks write paths, concurrent flips and prepared expiry like the old direct query',async t=>{
  const store=new BlogStore(':memory:');await store.init();t.after(()=>store.close())
  const pending=new PendingOperationsMirror()
  const index=new ChatStore(memoryIndex(),()=>pending.ids())
  const app=new BlogApplication(store,{assert(){}},{call:async()=>{throw new Error('unused')}},null,null,null,null,pending)
  const op=(id,status,conversationId,expiresAt)=>({id,owner,draftId:'draft-x',revision:1,status,...(conversationId?{chat:{conversationId}}:{}),...(expiresAt===undefined?{}:{expiresAt})})
  // 初始为空：没有任何待核对操作。
  assert.deepEqual(index.pendingOperations(),[])
  // 写路径：prepared 未过期计入；running/uncertain 计入。
  await app.operationInsert(op('o1','prepared','c1',Date.now()+60000))
  await app.operationInsert(op('o2','running','c2'))
  await app.operationInsert(op('o3','uncertain','c3'))
  // 并发翻转：多个写同时进行，镜像最终状态与串行一致。
  await Promise.all([
    app.operationSave('o2',{status:'succeeded',chat:{conversationId:'c2'}}),
    app.operationSave('o3',{status:'conflict',chat:{conversationId:'c3'}}),
    app.operationInsert(op('o4','prepared','c4',Date.now()-1000)),
  ])
  assert.deepEqual(index.pendingOperations(),['c1'])
  // 与存储直查同口径（镜像 vs 真实 pending 集合一致）。
  assert.deepEqual([...(await store.pendingOperations())].sort(),['c1'])
  await app.operationSave('o1',{status:'cancelled',chat:{conversationId:'c1'}})
  assert.deepEqual(index.pendingOperations(),[])
  assert.deepEqual(await store.pendingOperations(),[])
})

test('pending mirror restores once from storage on restart, including prepared not yet expired',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'blog-mirror-'))
  const file=join(directory,'business.sqlite')
  const first=new BlogStore(file);await first.init()
  const conversations=new ChatStore(memoryIndex())
  try{
    const app=new BlogApplication(first,{assert(){}},{call:async()=>{throw new Error('unused')}},null,null,null,null,new PendingOperationsMirror())
    const op=(id,status,conversationId,expiresAt)=>({id,owner,draftId:'draft-y',revision:1,status,chat:{conversationId},expiresAt})
    await app.operationInsert(op('p1','running','k1',Date.now()+60000))
    await app.operationInsert(op('p2','prepared','k2',Date.now()+60000))
    await app.operationInsert(op('p3','prepared','k3',Date.now()-1000))
    await app.operationInsert(op('p4','succeeded','k4',Date.now()+60000))
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
  restoredIndex.pendingSource=()=>mirror.ids()
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
  const effects=[],files=new Map()
  const provider={async saveFileStream({data,name}){const parts=[];for await(const chunk of data)parts.push(chunk);const b=Buffer.concat(parts);files.set(name,b);return{attachmentId:name,name,bytes:b.length}},async *readFileStream(ref){yield files.get(ref.name)}}
  const ctx={effect(fn){effects.push(fn())},on(){return()=>{}},get(name){return name==='attachments'?provider:undefined},attachments:provider}
  const attachments=new BlogAttachments(ctx,{assert(){}},store,dualScope(index,store))
  t.after(async()=>{await attachments.close();for(const dispose of effects)await dispose?.()})
  const bytes=Buffer.from('资料内容')
  // 草稿 id 路径：归属自己的草稿可上传、可读取。
  const onDraft=await attachments.upload(actor,draft.id,'draft.txt',async()=>bytes)
  assert.equal(onDraft.status,'ready')
  // 会话 id 路径：blog-chat-* 前缀由索引侧核验，同样可上传、可读取。
  const onConversation=await attachments.upload(actor,conversation.id,'notes.txt',async()=>bytes)
  assert.equal(onConversation.status,'ready')
  assert.deepEqual((await attachments.list(actor,draft.id)).map(a=>a.id),[onDraft.id])
  assert.deepEqual((await attachments.list(actor,conversation.id)).map(a=>a.id),[onConversation.id])
  // 双路径拒绝口径：草稿路径的 404 来自业务存储（草稿不存在或无权访问）。
  await assert.rejects(attachments.upload(actor,'missing-draft','x.txt',async()=>bytes),/草稿不存在或无权访问/)
  await assert.rejects(attachments.list(foreign,draft.id),/草稿不存在或无权访问/)
  await assert.rejects(attachments.get(foreign,draft.id,onDraft.id),/草稿不存在或无权访问/)
  // 会话路径的 404 来自索引侧（对话不存在或无权访问）。
  await assert.rejects(attachments.upload(actor,'blog-chat-missing','x.txt',async()=>bytes),/对话不存在或无权访问/)
  await assert.rejects(attachments.list(foreign,conversation.id),/对话不存在或无权访问/)
  await assert.rejects(attachments.get(actor,conversation.id,'missing-attachment'),/附件不存在或无权访问/)
})
