import test from 'node:test'
import assert from 'node:assert/strict'
import {BlogStore,ownerKey} from '../src/store.mjs'
import {ChatStore} from '../src/chat-store.ts'
import {BlogAttachments} from '../src/attachments.mjs'

test('host titles complete new conversations without replacing manual, legacy or removed history',()=>{
  const chats=new ChatStore(':memory:'),owner='user:alice'
  try{
    const c=chats.create(owner,'title-conversation')
    assert.equal(chats.syncTitle(c.id,'尚未创建'),false)
    chats.save(owner,c.id,{ready:true,title:'首句占位'})
    const updated=chats.get(owner,c.id).updatedAt
    assert.equal(chats.syncTitle(c.id,'首句回退'),true)
    assert.equal(chats.syncTitle(c.id,'博客文章分类整理',false,true),true)
    assert.equal(chats.get(owner,c.id).titleSource,'generated')
    assert.equal(chats.get(owner,c.id).updatedAt,updated)
    assert.equal(chats.syncTitle(c.id,'迟到的回退'),false)
    assert.equal(chats.syncTitle(c.id,'官方手动标题',true,true),true)
    chats.mutate(owner,{operation:'rename',ids:[c.id],title:'新对话'})
    assert.equal(chats.syncTitle(c.id,'迟到的自动标题',false,true),false)
    assert.equal(chats.get(owner,c.id).title,'新对话')
    assert.equal(chats.syncTitle(c.id,'再次在宿主手动更名',true,true),true)
    assert.equal(chats.get(owner,c.id).title,'再次在宿主手动更名')
    assert.equal(chats.syncTitle(c.id,'随后到达的自动标题',false,true),false)
    const legacy=chats.create(owner,'legacy-conversation',{ready:true,title:'旧索引标题'})
    chats.db.prepare("UPDATE conversations SET data=json_remove(data,'$.titleSource') WHERE id=?").run(legacy.id)
    assert.equal(chats.syncTitle(legacy.id,'不能覆盖旧记录',false,true),false)
    const removed=chats.create(owner,'removed-conversation',{ready:true})
    chats.mark(owner,removed.id,'removed')
    assert.equal(chats.syncTitle(removed.id,'不能复活已删除记录',false,true),false)
    assert.equal(chats.syncTitle(removed.id,'手动事件也不能复活',true,true),false)
    assert.equal(chats.syncTitle('another-plugin-session','无关会话',false,true),false)
  }finally{chats.close()}
})

test('a conversation owns attachments before any article exists; sent references survive removal and stay private',async t=>{
  const store=new BlogStore(':memory:');await store.init()
  const chats=new ChatStore(':memory:'),actor={namespace:'user',userId:'alice',sessionId:'login-a'},owner=ownerKey(actor)
  t.after(()=>{chats.close();store.close()})
  const conversation=chats.create(owner,'create-chat-001')
  assert.equal(chats.create(owner,'create-chat-001').id,conversation.id)
  const bytes=Buffer.from('PRIVATE-CHAT-ATTACHMENT-9031')
  const effects=[],provider={async saveFileStream({data,name}){for await(const chunk of data)assert.deepEqual(chunk,bytes);return{attachmentId:'sha256:'+'c'.repeat(64),name}}}
  const ctx={effect(fn){effects.push(fn)},get(name){return name==='attachments'?provider:undefined}}
  const attachments=new BlogAttachments(ctx,{assert(){}},store,(o,id)=>chats.assertScope(o,id))
  try{
    const attachment=await attachments.upload(actor,conversation.id,'notes.txt',async()=>bytes)
    assert.equal((await store.list(owner)).length,0)
    const frozen=await attachments.freeze(actor,conversation.id,[{id:attachment.id,version:attachment.version}])
    const {request}=chats.start(owner,conversation.id,'message-request-001',{text:'分析附件'})
    chats.updateRequest(request.id,{attachments:frozen,userSeq:3})
    await attachments.remove(actor,conversation.id,attachment.id)
    assert.equal(chats.historyAttachment(owner,conversation.id,request.id,attachment.id).original.name,'notes.txt')
    assert.throws(()=>chats.historyAttachment('user:bob',conversation.id,request.id,attachment.id),/无权访问/)
    const sibling=chats.create(owner,'create-chat-002')
    assert.throws(()=>chats.historyAttachment(owner,sibling.id,request.id,attachment.id),/不属于/)
  }finally{await attachments.close()}
})

test('chat requests reject changed replay and concurrency; regeneration reuses its article and old cards remain snapshots',async t=>{
  const store=new BlogStore(':memory:');await store.init()
  const chats=new ChatStore(':memory:'),owner='user:alice',conversation=chats.create(owner,'create-chat-003')
  t.after(()=>{chats.close();store.close()})
  const {request}=chats.start(owner,conversation.id,'message-request-003',{text:'写一篇文章'})
  assert.equal(chats.start(owner,conversation.id,'message-request-003',{text:'写一篇文章'}).fresh,false)
  assert.throws(()=>chats.start(owner,conversation.id,'message-request-003',{text:'改成另一篇'}),/不能更改/)
  assert.throws(()=>chats.start(owner,conversation.id,'message-request-004',{text:'并发问题'}),/另一页面/)
  let draft=await store.create(owner,{title:'文章'});await store.propose(owner,draft.id,draft.revision,{text:'第一版'},[]);draft=await store.get(owner,draft.id)
  const card=chats.result(owner,request,'candidate',draft)
  chats.updateRequest(request.id,{draftId:draft.id,status:'succeeded'})
  const branch=chats.create(owner,'create-chat-004',{parent:conversation.id})
  const regenerated=chats.start(owner,branch.id,'message-request-005',{text:'重新生成',operationId:request.operationId}).request
  assert.equal(chats.operationDraft(owner,regenerated.operationId),draft.id)
  await store.propose(owner,draft.id,draft.revision,{text:'第二版'},[])
  assert.equal(chats.results(owner,conversation.id)[0].proposal.fields.text,'第一版')
  assert.equal(card.proposal.fields.text,'第一版')
  assert.equal((await store.list(owner)).length,1)
  assert.equal(chats.operationDraft('user:bob',request.operationId),null)
})

test('history search is literal and case insensitive, with pin ordering and filtered pagination',t=>{
  const chats=new ChatStore(':memory:'),owner='user:alice';t.after(()=>chats.close())
  const rows=Array.from({length:32},(_,i)=>chats.create(owner,'history-page-'+i,{title:'Topic '+i,updatedAt:100+i}))
  const special=chats.create(owner,'history-literal',{title:'DSH 100%_完成',updatedAt:1000})
  chats.create('user:bob','history-other',{title:'DSH 100%_完成',updatedAt:2000})
  chats.mutate(owner,{operation:'pin',ids:[rows[0].id],pinned:true})
  chats.mutate(owner,{operation:'delete',ids:[rows[31].id]})
  const first=chats.list(owner,0,' topic '),second=chats.list(owner,first.nextOffset,'TOPIC')
  assert.equal(first.items.length,30);assert.equal(first.items[0].id,rows[0].id);assert.equal(first.items[0].pinned,true)
  assert.equal(second.items.length,1);assert.equal(second.nextOffset,null)
  assert.equal(new Set([...first.items,...second.items].map(c=>c.id)).size,31)
  assert.deepEqual(chats.list(owner,0,'%_').items.map(c=>c.id),[special.id])
  assert.deepEqual(chats.list(owner,0,'dsh').items.map(c=>c.id),[special.id])
  chats.mutate(owner,{operation:'rename',ids:[special.id],title:'  新标题  '})
  assert.equal(chats.get(owner,special.id).title,'新标题');assert.equal(chats.get(owner,special.id).updatedAt,1000)
  assert.equal(chats.list(owner,0,'dsh').items.length,0)
  chats.mutate(owner,{operation:'pin',ids:[rows[0].id],pinned:false})
  assert.equal(chats.list(owner,0,'topic').items[0].id,rows[30].id)
  const legacy=chats.get(owner,rows[1].id);delete legacy.pinned;delete legacy.deletedAt
  chats.db.prepare('UPDATE conversations SET data=? WHERE id=?').run(JSON.stringify(legacy),legacy.id)
  assert.equal(chats.list(owner,0,'Topic 1').items.find(c=>c.id===legacy.id).pinned,false)
  assert.throws(()=>chats.list(owner,-1),e=>e.status===400)
  assert.throws(()=>chats.list(owner,0,123),e=>e.status===400)
  assert.throws(()=>chats.list(owner,0,'x'.repeat(121)),e=>e.status===400)
})

test('history mutation validates every owner and input before writing and rolls back a partial database failure',t=>{
  const chats=new ChatStore(':memory:'),owner='user:alice';t.after(()=>chats.close())
  const first=chats.create(owner,'mutate-first'),second=chats.create(owner,'mutate-second'),foreign=chats.create('user:bob','mutate-foreign')
  const unchanged=()=>assert.equal(chats.get(owner,first.id).title,'新对话')
  for(const input of [null,{operation:'delete',ids:[]},{operation:'delete',ids:[first.id,first.id]},
    {operation:'delete',ids:Array.from({length:101},(_,i)=>'id-'+i)},{operation:'delete',ids:[42]},
    {operation:'restore',ids:[first.id]},{operation:'rename',ids:[first.id],title:' '},
    {operation:'rename',ids:[first.id],title:'中'.repeat(101)},{operation:'rename',ids:[first.id,second.id],title:'批量'},
    {operation:'pin',ids:[first.id],pinned:1}])assert.throws(()=>chats.mutate(owner,input),e=>e.status===400)
  unchanged()
  assert.throws(()=>chats.mutate(owner,{operation:'delete',ids:[first.id,foreign.id]}),e=>e.status===404)
  assert.throws(()=>chats.mutate(owner,{operation:'delete',ids:[first.id,'missing-id']}),e=>e.status===404)
  assert.equal(chats.list(owner).items.length,2)
  chats.db.exec("CREATE TRIGGER fail_second_history_update BEFORE UPDATE ON conversations WHEN OLD.requestId='mutate-second' BEGIN SELECT RAISE(ABORT,'forced transaction failure'); END")
  assert.throws(()=>chats.mutate(owner,{operation:'delete',ids:[first.id,second.id]}),/forced transaction failure/)
  assert.equal(chats.list(owner).items.length,2)
  chats.db.exec('DROP TRIGGER fail_second_history_update')
  chats.mutate(owner,{operation:'rename',ids:[first.id],title:'中'.repeat(100)})
  assert.equal(chats.get(owner,first.id).title.length,100)
  chats.mutate(owner,{operation:'delete',ids:[first.id,second.id]})
  assert.equal(chats.list(owner).items.length,0);assert.equal(chats.list('user:bob').items.length,1)
  const batch=Array.from({length:100},(_,i)=>chats.create(owner,'delete-batch-'+i).id)
  chats.mutate(owner,{operation:'delete',ids:batch})
  assert.equal(chats.list(owner).items.length,0)
})

test('soft delete keeps linked article and request records but cannot reopen by id or replayed requestId',async t=>{
  const store=new BlogStore(':memory:');await store.init()
  const chats=new ChatStore(':memory:'),owner='user:alice'
  t.after(()=>{chats.close();store.close()})
  const conversation=chats.create(owner,'delete-preserve'),draft=await store.create(owner,{title:'仍需保留的文章'})
  const {request}=chats.start(owner,conversation.id,'delete-request',{text:'写作'})
  chats.updateRequest(request.id,{status:'succeeded',draftId:draft.id,attachments:[{id:'attachment-id',original:{attachmentId:'official-file'}}]})
  chats.result(owner,request,'candidate',draft)
  chats.mutate(owner,{operation:'delete',ids:[conversation.id]})
  assert.throws(()=>chats.get(owner,conversation.id),e=>e.status===404)
  assert.throws(()=>chats.create(owner,'delete-preserve'),e=>e.status===404)
  assert.throws(()=>chats.save(owner,conversation.id,{deletedAt:null}),e=>e.status===404)
  assert.throws(()=>chats.start(owner,conversation.id,'delete-request',{text:'写作'}),e=>e.status===404)
  assert.equal((await store.get(owner,draft.id)).title,'仍需保留的文章')
  assert.equal(chats.request(owner,request.id).attachments[0].original.attachmentId,'official-file')
  assert.equal(chats.db.prepare('SELECT COUNT(*) AS count FROM chat_results').get().count,1)
  const retained=JSON.parse(chats.db.prepare('SELECT data FROM conversations WHERE id=?').get(conversation.id).data)
  assert.ok(Number.isFinite(retained.deletedAt));assert.equal(retained.id,conversation.id)
})
