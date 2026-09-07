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
