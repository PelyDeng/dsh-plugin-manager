import test from 'node:test'
import assert from 'node:assert/strict'
import {BlogStore,ownerKey} from '../src/store.mjs'
import {ChatStore} from '../src/chat-store.ts'
import {BlogAttachments} from '../src/attachments.mjs'
import {memoryIndex,ownerActor,ownerOf} from './index-fixture.mjs'

/**
 * 索引库切 PG 之后，本文件的夹具从 `new ChatStore(':memory:')`（SQLite 三表）换成
 * **运行时的内存端口**（`tests/index-fixture.mjs`）。三处随之改变，都不是"顺手改改"：
 *
 * 1. **所有读写都是异步的**（PG 往返）⇒ 逐处 `await`；用 `assert.rejects` 取代 `assert.throws`。
 * 2. **`chats.db` 不存在了**：旧用例用 `db.prepare(...)` 往 `data` 列里塞"legacy 行"、用 SQL 触发器
 *    制造"改第二条时失败"。前者改为构造等价状态（见各用例的注释），后者**随语义消失**（批量只有
 *    `delete`，而删除已移交移除围栏——见 `chat-store.ts` 的 `mutate`）。
 * 3. **时间戳不能由 `create` 的入参指定**：`updated_at` 是列，端口只认 `touch`（且单调不减）。
 *    需要"按时间排序"的用例显式 `touch` 一个递增时刻（真实语义就是如此）。
 */

/** 造一份夹具：内存门面 + 建在它上面的 `ChatStore`。 */
function fixture() {
  const db = memoryIndex()
  const chats = new ChatStore(db, () => [])
  return { db, chats }
}

test('host titles complete new conversations without replacing manual, legacy or removed history',async()=>{
  const {chats}=fixture()
  const owner='user:alice'
  const c=await chats.create(owner,'title-conversation')
  // 未发布（还在创建握手里）⇒ 不广播：`syncTitle` 返回 `false`，标题投递仍会排队（PG 侧守卫兜底）。
  // ⚠️ 这一条是**自动标题**的口径；**人工改名**在未发布会话上要放行（见下面那条用例与 `chat-store.ts`
  // 的守卫注释：页面列表自 `e78e285` 起包含未发布会话，用户在页面上看得见它、也改得了它的名字）。
  assert.equal(chats.syncTitle(c.id,'尚未创建'),false)
  await chats.save(owner,c.id,{ready:true,title:'首句占位'})
  const updated=(await chats.get(owner,c.id)).updatedAt
  assert.equal(chats.syncTitle(c.id,'首句回退'),true)
  assert.equal(chats.syncTitle(c.id,'博客文章分类整理',false,true),true)
  assert.equal((await chats.get(owner,c.id)).titleSource,'generated')
  assert.equal((await chats.get(owner,c.id)).updatedAt,updated)
  assert.equal(chats.syncTitle(c.id,'迟到的回退'),false)
  assert.equal(chats.syncTitle(c.id,'官方手动标题',true,true),true)
  await chats.mutate(owner,{operation:'rename',ids:[c.id],title:'新对话'})
  assert.equal(chats.syncTitle(c.id,'迟到的自动标题',false,true),false)
  assert.equal((await chats.get(owner,c.id)).title,'新对话')
  assert.equal(chats.syncTitle(c.id,'再次在宿主手动更名',true,true),true)
  assert.equal((await chats.get(owner,c.id)).title,'再次在宿主手动更名')
  assert.equal(chats.syncTitle(c.id,'随后到达的自动标题',false,true),false)
  // 旧用例靠"删掉 `data.titleSource` 键"造一条 legacy 记录。新结构里 `title_source` 是
  // `NOT NULL DEFAULT 'automatic'`，表达不了"缺列"；而**建会话时就给了标题**（⇒ `manual`）
  // 正是那条断言的等价状态：自动标题不能覆盖它。
  const legacy=await chats.create(owner,'legacy-conversation',{ready:true,title:'旧索引标题'})
  assert.equal((await chats.get(owner,legacy.id)).titleSource,'manual')
  assert.equal(chats.syncTitle(legacy.id,'不能覆盖旧记录',false,true),false)
  const removed=await chats.create(owner,'removed-conversation',{ready:true})
  // `mark` 现在要 `Actor`（端口用它的 namespace/userId 做归属判定），owner 字符串进不来。
  chats.mark(ownerActor(owner),removed.id,'removed')
  assert.equal(chats.syncTitle(removed.id,'不能复活已删除记录',false,true),false)
  assert.equal(chats.syncTitle(removed.id,'手动事件也不能复活',true,true),false)
  assert.equal(chats.syncTitle('another-plugin-session','无关会话',false,true),false)
})

/**
 * ⚠️ **未发布会话的人工改名**：镜像侧的判定也要放行，否则页面**不广播 `changed`**。
 *
 * 为什么：页面列表自 `e78e285` 起包含未发布会话（`includeUnready`），而 `mutate` 的改名路径
 * 只要求"未删除、无围栏" ⇒ 用户在页面上**看得见**"新建对话"、也**改得了**它的名字。
 * 此时若镜像这一份判定仍要求 `ready`，`syncTitle` 返回 `false` ⇒ 页面不刷新（改名要手动刷新
 * 才出现）；而 PG 那一侧同样会把它拒掉、**静默不落库**。两处（严格说是四处）守卫必须同改，
 * 真 PG 侧的对照在 `tests/storage-contract.test.ts` 的同名用例。
 *
 * ⚠️ 自动 / 生成标题**不受影响**：未发布会话上它们仍然返回 `false`（原始理由"避免侧栏提前可见"
 * 针对的正是宿主事件驱动的自动标题）。这条是"只有 manual 放宽"的护栏。
 */
test('未发布会话的人工改名在镜像侧也放行，自动/生成标题仍不放行',async()=>{
  const {chats}=fixture()
  const owner='user:alice'
  const c=await chats.create(owner,'unpublished-rename')
  assert.equal((await chats.get(owner,c.id)).ready,false)
  // 自动 / 生成：仍被 `ready` 挡住。
  assert.equal(chats.syncTitle(c.id,'迟到的自动标题',false,false),false)
  assert.equal(chats.syncTitle(c.id,'迟到的生成标题',false,true),false)
  assert.notEqual((await chats.get(owner,c.id)).title,'迟到的生成标题')
  // 人工改名：放行 ⇒ 页面会广播 `changed`，而且镜像里的标题真的变了。
  assert.equal(chats.syncTitle(c.id,'用户改的名字',true,false),true)
  const after=await chats.get(owner,c.id)
  assert.equal(after.title,'用户改的名字')
  assert.equal(after.titleSource,'manual')
  // 放行之后到达的自动 / 生成标题**不能覆盖**它（自动不覆盖手动那条约定的落点）。
  assert.equal(chats.syncTitle(c.id,'发布后的官方标题',false,true),false)
  assert.equal((await chats.get(owner,c.id)).title,'用户改的名字')
  // 围栏**不放宽**：已删除 / 待移除的会话上，人工改名仍然拒绝。
  const removed=await chats.create(owner,'unpublished-removed',{ready:true})
  chats.mark(ownerActor(owner),removed.id,'removed')
  assert.equal(chats.syncTitle(removed.id,'已删除会话的人工改名',true,false),false)
  const fenced=await chats.create(owner,'unpublished-fenced',{ready:true})
  chats.mark(ownerActor(owner),fenced.id,'pending')
  assert.equal(chats.syncTitle(fenced.id,'待移除会话的人工改名',true,false),false)
})

test('a conversation owns attachments before any article exists; sent references survive removal and stay private',async t=>{
  const store=new BlogStore(':memory:');await store.init()
  const {chats}=fixture()
  const actor={namespace:'user',userId:'alice',sessionId:'login-a'},owner=ownerKey(actor)
  t.after(()=>store.close())
  const conversation=await chats.create(owner,'create-chat-001')
  assert.equal((await chats.create(owner,'create-chat-001')).id,conversation.id)
  const bytes=Buffer.from('PRIVATE-CHAT-ATTACHMENT-9031')
  const effects=[],provider={async saveFileStream({data,name}){for await(const chunk of data)assert.deepEqual(chunk,bytes);return{attachmentId:'sha256:'+'c'.repeat(64),name}}}
  const ctx={effect(fn){effects.push(fn)},get(name){return name==='attachments'?provider:undefined}}
  const attachments=new BlogAttachments(ctx,{assert(){}},store,(o,id)=>chats.assertScope(o,id))
  try{
    const attachment=await attachments.upload(actor,conversation.id,'notes.txt',async()=>bytes)
    assert.equal((await store.list(owner)).length,0)
    const frozen=await attachments.freeze(actor,conversation.id,[{id:attachment.id,version:attachment.version}])
    const {request}=await chats.start(owner,conversation.id,'message-request-001',{text:'分析附件'})
    await chats.updateRequest(owner,request.id,{attachments:frozen,userSeq:3})
    await attachments.remove(actor,conversation.id,attachment.id)
    assert.equal((await chats.historyAttachment(owner,conversation.id,request.id,attachment.id)).original.name,'notes.txt')
    await assert.rejects(chats.historyAttachment('user:bob',conversation.id,request.id,attachment.id),/无权访问/)
    const sibling=await chats.create(owner,'create-chat-002')
    await assert.rejects(chats.historyAttachment(owner,sibling.id,request.id,attachment.id),/不属于/)
  }finally{await attachments.close()}
})

test('chat requests reject changed replay and concurrency; regeneration reuses its article and old cards remain snapshots',async t=>{
  const store=new BlogStore(':memory:');await store.init()
  const {chats}=fixture()
  const owner='user:alice',conversation=await chats.create(owner,'create-chat-003')
  t.after(()=>store.close())
  const {request}=await chats.start(owner,conversation.id,'message-request-003',{text:'写一篇文章'})
  assert.equal((await chats.start(owner,conversation.id,'message-request-003',{text:'写一篇文章'})).fresh,false)
  await assert.rejects(chats.start(owner,conversation.id,'message-request-003',{text:'改成另一篇'}),/不能更改/)
  await assert.rejects(chats.start(owner,conversation.id,'message-request-004',{text:'并发问题'}),/另一页面/)
  let draft=await store.create(owner,{title:'文章'});await store.propose(owner,draft.id,draft.revision,{text:'第一版'},[]);draft=await store.get(owner,draft.id)
  const card=await chats.result(owner,request,'candidate',draft)
  await chats.updateRequest(owner,request.id,{draftId:draft.id,status:'succeeded'})
  const branch=await chats.create(owner,'create-chat-004',{parent:conversation.id})
  const regenerated=(await chats.start(owner,branch.id,'message-request-005',{text:'重新生成',operationId:request.operationId})).request
  // `operationDraft` 按 **owner 全表**查（跨会话）：这一个操作是在 `branch` 会话里继续的，绑定却
  // 落在上一轮所在的会话——只在当前会话里找会漏掉它，结果是新建第二份草稿。
  assert.equal(await chats.operationDraft(owner,regenerated.operationId),draft.id)
  await store.propose(owner,draft.id,draft.revision,{text:'第二版'},[])
  assert.equal((await chats.results(owner,conversation.id))[0].proposal.fields.text,'第一版')
  assert.equal(card.proposal.fields.text,'第一版')
  assert.equal((await store.list(owner)).length,1)
  assert.equal(await chats.operationDraft('user:bob',request.operationId),null)
})

/**
 * **并发受理同一个 `requestId`**：只有一个能赢，败者必须**不是 `fresh`**。
 *
 * 为什么这条必须单独钉（红队评审 `e78e285` 第 1 条）：`start` 前面那道
 * `existing !== undefined` 幂等预检隔着三次 PG 往返，**挡不住并发** —— 两次受理会同时越过它，
 * 然后在 `claim` 上分胜负。而 `claim` 的返回值一旦被丢掉，败者也返回 `fresh: true`，
 * 调用方（`chat.ts:559` 的 `if (!fresh) return`）就会在同一轮上**起第二次执行**（副作用两遍）。
 * 旧实现靠 SQLite 的 `UNIQUE(owner, requestId)` **抛约束错**，所以这是切库引入的
 * **loud → silent 回归**；修复方式是"用 `claim` 的返回值"，不是"相信库会拦"。
 *
 * ⚠️ 断言刻意**不看行数**：`claim` 的 `ON CONFLICT DO NOTHING` 让"两行"这件事在存储层
 * 根本不可能发生，只断行数的话变异不会红（败者照样只留一行）。红的是 `fresh`。
 */
test('concurrent claims with one request id: exactly one is fresh, the loser replays the same row',async()=>{
  const {chats}=fixture()
  const owner='user:alice',conversation=await chats.create(owner,'concurrent-claim')
  const same=[...await Promise.all([
    chats.start(owner,conversation.id,'concurrent-request',{text:'同一句'}),
    chats.start(owner,conversation.id,'concurrent-request',{text:'同一句'}),
  ])]
  assert.deepEqual(same.map(r=>r.fresh).sort(),[false,true])
  assert.equal(same[0].request.id,same[1].request.id)
  assert.equal((await chats.requests(owner,conversation.id)).length,1)
  // 并发且**正文不同**：败者必须报 409，不能拿自己的正文起跑。
  // ⚠️ 两条路径的文案**不同，是刻意的**：串行重放换正文走 `start` 预检里的业务那一句
  // （`相同请求标识不能更改问题或附件`，见上面 `assert.rejects(...)`）；并发时那一行还不存在，
  // 判定落在 `claim` 里，报的是存储层那句 `同一个请求标识不能换正文`。这里断言**并发那一句**，
  // 免得有人以为两处该一致而把其中一处改掉。
  const other=await chats.create(owner,'concurrent-claim-2')
  await assert.rejects(Promise.all([
    chats.start(owner,other.id,'concurrent-request-2',{text:'甲'}),
    chats.start(owner,other.id,'concurrent-request-2',{text:'乙'}),
  ]),/不能换正文/)
  assert.equal((await chats.requests(owner,other.id)).length,1)
})

/**
 * 页面列表的**口径**：围栏态（`pending` / `failed`）与已软删除（`deleted_at` 非空）的会话
 * **不进页面列表**，而**未发布**的会话照旧要看得见（`includeUnready`）。
 *
 * 这三条是一组，缺一条就会让"修好一条、弄坏另一条"看不出来：
 * 旧 SQLite 页面列表的口径是 `deletedAt IS NULL AND removalState = ''`，
 * 而端口侧的 `state: ''` 是"**不**过滤状态" ⇒ 换成端口时这一条口径整体丢了（红队评审
 * `e78e285` 第 2 条报的是 `pending`/`failed` 那一半；`deleted_at` 那一半是本用例补上的）。
 */
test('page list hides fenced and soft-deleted conversations while keeping unpublished ones',async()=>{
  const {chats}=fixture()
  const owner='user:alice'
  const visible=await chats.create(owner,'list-visible')
  const unpublished=await chats.create(owner,'list-unpublished')
  const fenced=await chats.create(owner,'list-fenced')
  const failed=await chats.create(owner,'list-failed')
  const removed=await chats.create(owner,'list-removed')
  chats.mark(ownerActor(owner),fenced.id,'pending')
  chats.mark(ownerActor(owner),failed.id,'failed')
  chats.mark(ownerActor(owner),removed.id,'removed')
  const ids=(await chats.list(owner)).items.map(item=>item.id)
  assert.ok(ids.includes(visible.id),'普通会话必须在列表里')
  // `includeUnready: true`：新建对话是两段的，用户打完第一条消息之前也不能"消失"。
  assert.ok(ids.includes(unpublished.id),'未发布的会话仍必须在列表里（includeUnready）')
  assert.ok(!ids.includes(fenced.id),'移除中途的会话不该出现在页面列表（点进去只能 404）')
  assert.ok(!ids.includes(failed.id),'移除失败的会话不该出现在页面列表（它没有清除路径，会永久赖着）')
  assert.ok(!ids.includes(removed.id),'已移除的会话不该出现在页面列表')
  // 逐条复核"打不开"这件事本身没变：围栏态与已删除都是 404。
  await assert.rejects(chats.get(owner,fenced.id),/不存在或无权访问/)
  await assert.rejects(chats.get(owner,removed.id),/不存在或无权访问/)
})

test('history search is literal and case insensitive, with pin ordering and filtered pagination',async t=>{
  const {db,chats}=fixture()
  const owner='user:alice'
  // `updated_at` 是列，端口只认 `touch`（单调不减）⇒ 时间戳在创建之后显式推进。用**递增**的
  // 未来时刻（`GREATEST` 才会采纳），这正是真实语义：不能把时间戳"改小"。
  const base=Date.now()+1000
  const rows=[]
  for(let i=0;i<32;i+=1){
    const c=await chats.create(owner,'history-page-'+i,{title:'Topic '+i})
    // ⚠️ 还要 `publish`：端口（与 kit 侧栏）按 `ready = TRUE` 过滤，未发布的会话**不在列表里**
    //（旧 SQLite 实现的页面列表不过滤 —— 这是切库带来的一处口径变化，见 `ChatStore.list` 的注释）。
    await db.conversations.publish(ownerOf(owner),c.id)
    await db.conversations.touch(ownerOf(owner),c.id,base+i*1000)
    rows.push(c)
  }
  const special=await chats.create(owner,'history-literal',{title:'DSH 100%_完成'})
  await db.conversations.publish(ownerOf(owner),special.id)
  await db.conversations.touch(ownerOf(owner),special.id,base+90000)
  const other=await chats.create('user:bob','history-other',{title:'DSH 100%_完成'})
  await db.conversations.publish(ownerOf('user:bob'),other.id)
  await chats.mutate(owner,{operation:'pin',ids:[rows[0].id],pinned:true})
  chats.mark(ownerActor(owner),rows[31].id,'removed')
  const first=await chats.list(owner,0,' topic '),second=await chats.list(owner,first.nextOffset,'TOPIC')
  assert.equal(first.items.length,30);assert.equal(first.items[0].id,rows[0].id);assert.equal(first.items[0].pinned,true)
  assert.equal(second.items.length,1);assert.equal(second.nextOffset,null)
  assert.equal(new Set([...first.items,...second.items].map(c=>c.id)).size,31)
  assert.deepEqual((await chats.list(owner,0,'%_')).items.map(c=>c.id),[special.id])
  assert.deepEqual((await chats.list(owner,0,'dsh')).items.map(c=>c.id),[special.id])
  await chats.mutate(owner,{operation:'rename',ids:[special.id],title:'  新标题  '})
  assert.equal((await chats.get(owner,special.id)).title,'新标题')
  // `syncTitle` **不碰** `updated_at`（守卫只认 title / title_source）⇒ 改名之后排序键不变。
  assert.equal((await chats.get(owner,special.id)).updatedAt,base+90000)
  assert.equal((await chats.list(owner,0,'dsh')).items.length,0)
  await chats.mutate(owner,{operation:'pin',ids:[rows[0].id],pinned:false})
  assert.equal((await chats.list(owner,0,'topic')).items[0].id,rows[30].id)
  // 旧用例用 `db.prepare` 塞一条"没有 pinned / deletedAt 键"的 legacy 行。新结构里这两列
  // `NOT NULL`/可空由库定义，表达不了"缺键"；等价状态是"建行之后从没置顶、也没删除"——
  // 那一行就是 `rows[1]`，它的 `pinned`/`deletedAt` 本来就是缺省值。
  assert.equal((await chats.list(owner,0,'Topic 1')).items.find(c=>c.id===rows[1].id).pinned,false)
  await assert.rejects(chats.list(owner,-1),e=>e.status===400)
  await assert.rejects(chats.list(owner,0,123),e=>e.status===400)
  await assert.rejects(chats.list(owner,0,'x'.repeat(121)),e=>e.status===400)
})

test('history mutation validates every owner and input before writing',async t=>{
  const {db,chats}=fixture()
  const owner='user:alice'
  const first=await chats.create(owner,'mutate-first'),second=await chats.create(owner,'mutate-second'),foreign=await chats.create('user:bob','mutate-foreign')
  // 列表只列已发布的会话（端口口径）⇒ 这两个要能被 `list` 看到就得先发布。
  await db.conversations.publish(ownerOf(owner),first.id)
  await db.conversations.publish(ownerOf(owner),second.id)
  await db.conversations.publish(ownerOf('user:bob'),foreign.id)
  const unchanged=async()=>assert.equal((await chats.get(owner,first.id)).title,'新对话')
  for(const input of [null,{operation:'delete',ids:[]},{operation:'delete',ids:[first.id,first.id]},
    {operation:'delete',ids:Array.from({length:101},(_,i)=>'id-'+i)},{operation:'delete',ids:[42]},
    {operation:'restore',ids:[first.id]},{operation:'rename',ids:[first.id],title:' '},
    {operation:'rename',ids:[first.id],title:'中'.repeat(101)},{operation:'rename',ids:[first.id,second.id],title:'批量'},
    {operation:'pin',ids:[first.id],pinned:1}])await assert.rejects(chats.mutate(owner,input),e=>e.status===400)
  await unchanged()
  // 归属核验：别人的会话 / 不存在的会话都是 404，且**一条都没改**。
  await assert.rejects(chats.mutate(owner,{operation:'rename',ids:[foreign.id],title:'偷改'}),e=>e.status===404)
  await assert.rejects(chats.mutate(owner,{operation:'rename',ids:['missing-id'],title:'不存在'}),e=>e.status===404)
  await unchanged()
  assert.equal((await chats.list(owner)).items.length,2)
  // `delete` 已移交**移除围栏**（`chat.ts` 的 `mutate` 在 delete 时走 `conversationRemover`），
  // 这里必须明确拒绝而不是静默写 `deleted_at`：绕过围栏会让宿主归档与围栏状态脱节（幽灵会话）。
  await assert.rejects(chats.mutate(owner,{operation:'delete',ids:[first.id,second.id]}),e=>e.status===409)
  assert.equal((await chats.list(owner)).items.length,2)
  // ⚠️ 旧用例用 SQL 触发器制造"改第二条时失败 ⇒ 回滚"。新语义下**这个场景不存在**：批量只有
  // `delete`（已移交围栏），而 `rename` / `pin` 都只允许一条 id ⇒ 根本没有"写第二条"。
  // 所以这里如实删掉那条断言，而不是换一个测不到回滚的方式留着它——真 PG 的事务由
  // `storage-contract.test.ts` 覆盖（那里的 `transaction()` 是真 `BEGIN` / `ROLLBACK`）。
  await chats.mutate(owner,{operation:'rename',ids:[first.id],title:'中'.repeat(100)})
  assert.equal((await chats.get(owner,first.id)).title.length,100)
  // 删除走围栏：逐条 `mark('removed')`（生产由 `conversationRemover` 批量调用它）。
  for(const id of [first.id,second.id])chats.mark(ownerActor(owner),id,'removed')
  assert.equal((await chats.list(owner)).items.length,0);assert.equal((await chats.list('user:bob')).items.length,1)
  const batch=[]
  for(let i=0;i<100;i+=1)batch.push((await chats.create(owner,'delete-batch-'+i)).id)
  for(const id of batch)chats.mark(ownerActor(owner),id,'removed')
  assert.equal((await chats.list(owner)).items.length,0)
})

test('soft delete keeps linked article and request records but cannot reopen by id or replayed requestId',async t=>{
  const store=new BlogStore(':memory:');await store.init()
  const {db,chats}=fixture()
  const owner='user:alice'
  t.after(()=>store.close())
  const conversation=await chats.create(owner,'delete-preserve'),draft=await store.create(owner,{title:'仍需保留的文章'})
  const {request}=await chats.start(owner,conversation.id,'delete-request',{text:'写作'})
  await chats.updateRequest(owner,request.id,{status:'succeeded',draftId:draft.id,attachments:[{id:'attachment-id',original:{attachmentId:'official-file'}}]})
  await chats.result(owner,request,'candidate',draft)
  chats.mark(ownerActor(owner),conversation.id,'removed')
  await assert.rejects(chats.get(owner,conversation.id),e=>e.status===404)
  // 幂等命中已删除的行时，`create` 也必须 404：否则一次重放就能"复活"已删除会话（那条判定在
  // `create` 末尾统一走 `get`）。
  await assert.rejects(chats.create(owner,'delete-preserve'),e=>e.status===404)
  await assert.rejects(chats.save(owner,conversation.id,{deletedAt:null}),e=>e.status===404)
  await assert.rejects(chats.start(owner,conversation.id,'delete-request',{text:'写作'}),e=>e.status===404)
  assert.equal((await store.get(owner,draft.id)).title,'仍需保留的文章')
  // 轮次与结果**留着**（软删除不删业务产出），按行 id 直接读仍读得回。
  assert.equal((await chats.request(owner,request.id)).attachments[0].original.attachmentId,'official-file')
  assert.equal((await db.turns.turnResultsOf(ownerOf(owner),conversation.id)).length,1)
  // 行本身还在，`deleted_at` 已补（旧用例直接查 SQLite，现在走端口的整行读）。
  const retained=await db.conversations.detail(ownerOf(owner),conversation.id)
  assert.ok(Number.isFinite(retained.deletedAt));assert.equal(retained.id,conversation.id)
})
