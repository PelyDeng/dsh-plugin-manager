import test from 'node:test'
import assert from 'node:assert/strict'
import {BlogStore,ownerKey} from '../src/store.mjs'
import {ChatStore} from '../src/chat-store.mjs'
import {BlogAttachments} from '../src/attachments.mjs'

test('a conversation owns attachments before any article exists; sent references survive removal and stay private',async()=>{
  const store=new BlogStore(':memory:'),chats=new ChatStore(store),actor={namespace:'user',userId:'alice',sessionId:'login-a'},owner=ownerKey(actor)
  const conversation=chats.create(owner,'create-chat-001')
  assert.equal(chats.create(owner,'create-chat-001').id,conversation.id)
  const bytes=Buffer.from('PRIVATE-CHAT-ATTACHMENT-9031')
  const effects=[],provider={async saveFileStream({data,name}){for await(const chunk of data)assert.deepEqual(chunk,bytes);return{attachmentId:'sha256:'+'c'.repeat(64),name}}}
  const ctx={effect(fn){effects.push(fn)},get(name){return name==='attachments'?provider:undefined}}
  const attachments=new BlogAttachments(ctx,{assert(){}},store,(o,id)=>chats.assertScope(o,id))
  try{
    const attachment=await attachments.upload(actor,conversation.id,'notes.txt',async()=>bytes)
    assert.equal(store.list(owner).length,0)
    const frozen=attachments.freeze(actor,conversation.id,[{id:attachment.id,version:attachment.version}])
    const {request}=chats.start(owner,conversation.id,'message-request-001',{text:'分析附件'})
    chats.updateRequest(request.id,{attachments:frozen,userSeq:3})
    attachments.remove(actor,conversation.id,attachment.id)
    assert.equal(chats.historyAttachment(owner,conversation.id,request.id,attachment.id).original.name,'notes.txt')
    assert.throws(()=>chats.historyAttachment('user:bob',conversation.id,request.id,attachment.id),/无权访问/)
    const sibling=chats.create(owner,'create-chat-002')
    assert.throws(()=>chats.historyAttachment(owner,sibling.id,request.id,attachment.id),/不属于/)
  }finally{await attachments.close();store.close()}
})

test('chat requests reject changed replay and concurrency; regeneration reuses its article and old cards remain snapshots',()=>{
  const store=new BlogStore(':memory:'),chats=new ChatStore(store),owner='user:alice',conversation=chats.create(owner,'create-chat-003')
  try{
    const {request}=chats.start(owner,conversation.id,'message-request-003',{text:'写一篇文章'})
    assert.equal(chats.start(owner,conversation.id,'message-request-003',{text:'写一篇文章'}).fresh,false)
    assert.throws(()=>chats.start(owner,conversation.id,'message-request-003',{text:'改成另一篇'}),/不能更改/)
    assert.throws(()=>chats.start(owner,conversation.id,'message-request-004',{text:'并发问题'}),/另一页面/)
    let draft=store.create(owner,{title:'文章'});store.propose(owner,draft.id,draft.revision,{text:'第一版'},[]);draft=store.get(owner,draft.id)
    const card=chats.result(owner,request,'candidate',draft)
    chats.updateRequest(request.id,{draftId:draft.id,status:'succeeded'})
    const branch=chats.create(owner,'create-chat-004',{parent:conversation.id})
    const regenerated=chats.start(owner,branch.id,'message-request-005',{text:'重新生成',operationId:request.operationId}).request
    assert.equal(chats.operationDraft(owner,regenerated.operationId),draft.id)
    store.propose(owner,draft.id,draft.revision,{text:'第二版'},[])
    assert.equal(chats.results(owner,conversation.id)[0].proposal.fields.text,'第一版')
    assert.equal(card.proposal.fields.text,'第一版')
    assert.equal(store.list(owner).length,1)
    assert.equal(chats.operationDraft('user:bob',request.operationId),null)
  }finally{store.close()}
})

test('history search is literal and case insensitive, with pin ordering and filtered pagination',t=>{
  const store=new BlogStore(':memory:'),chats=new ChatStore(store),owner='user:alice';t.after(()=>store.close())
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
  store.db.prepare('UPDATE conversations SET data=? WHERE id=?').run(JSON.stringify(legacy),legacy.id)
  assert.equal(chats.list(owner,0,'Topic 1').items.find(c=>c.id===legacy.id).pinned,false)
  assert.throws(()=>chats.list(owner,-1),e=>e.status===400)
  assert.throws(()=>chats.list(owner,0,123),e=>e.status===400)
  assert.throws(()=>chats.list(owner,0,'x'.repeat(121)),e=>e.status===400)
})

test('history mutation validates every owner and input before writing and rolls back a partial database failure',t=>{
  const store=new BlogStore(':memory:'),chats=new ChatStore(store),owner='user:alice';t.after(()=>store.close())
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
  store.db.exec("CREATE TRIGGER fail_second_history_update BEFORE UPDATE ON conversations WHEN OLD.requestId='mutate-second' BEGIN SELECT RAISE(ABORT,'forced transaction failure'); END")
  assert.throws(()=>chats.mutate(owner,{operation:'delete',ids:[first.id,second.id]}),/forced transaction failure/)
  assert.equal(chats.list(owner).items.length,2)
  store.db.exec('DROP TRIGGER fail_second_history_update')
  chats.mutate(owner,{operation:'rename',ids:[first.id],title:'中'.repeat(100)})
  assert.equal(chats.get(owner,first.id).title.length,100)
  chats.mutate(owner,{operation:'delete',ids:[first.id,second.id]})
  assert.equal(chats.list(owner).items.length,0);assert.equal(chats.list('user:bob').items.length,1)
  const batch=Array.from({length:100},(_,i)=>chats.create(owner,'delete-batch-'+i).id)
  chats.mutate(owner,{operation:'delete',ids:batch})
  assert.equal(chats.list(owner).items.length,0)
})

test('soft delete keeps linked article and request records but cannot reopen by id or replayed requestId',t=>{
  const store=new BlogStore(':memory:'),chats=new ChatStore(store),owner='user:alice';t.after(()=>store.close())
  const conversation=chats.create(owner,'delete-preserve'),draft=store.create(owner,{title:'仍需保留的文章'})
  const {request}=chats.start(owner,conversation.id,'delete-request',{text:'写作'})
  chats.updateRequest(request.id,{status:'succeeded',draftId:draft.id,attachments:[{id:'attachment-id',original:{attachmentId:'official-file'}}]})
  chats.result(owner,request,'candidate',draft)
  chats.mutate(owner,{operation:'delete',ids:[conversation.id]})
  assert.throws(()=>chats.get(owner,conversation.id),e=>e.status===404)
  assert.throws(()=>chats.create(owner,'delete-preserve'),e=>e.status===404)
  assert.throws(()=>chats.save(owner,conversation.id,{deletedAt:null}),e=>e.status===404)
  assert.throws(()=>chats.start(owner,conversation.id,'delete-request',{text:'写作'}),e=>e.status===404)
  assert.equal(store.get(owner,draft.id).title,'仍需保留的文章')
  assert.equal(chats.request(owner,request.id).attachments[0].original.attachmentId,'official-file')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_results').get().count,1)
  const retained=JSON.parse(store.db.prepare('SELECT data FROM conversations WHERE id=?').get(conversation.id).data)
  assert.ok(Number.isFinite(retained.deletedAt));assert.equal(retained.id,conversation.id)
})
