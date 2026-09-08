import test from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.mjs'
import { BlogApplication } from '../src/application.mjs'

test('draft listing is lossless JSON when only one remote variant exists',t=>{
  const s=new BlogStore(':memory:');t.after(()=>s.close())
  s.create('u',{title:'昨天的文章'}, {published:{cid:338},savedDraft:null})
  s.create('u',{title:'博客草稿'}, {published:null,savedDraft:{cid:337}})
  const rows=s.list('u')
  assert.deepEqual(rows,JSON.parse(JSON.stringify(rows)))
})

test('manual edits cannot be overwritten by a stale model proposal',t=>{
  const s=new BlogStore(':memory:');t.after(()=>s.close())
  const d=s.create('u',{title:'first',text:'<!--raw--> body'})
  const candidate=s.propose('u',d.id,1,{text:'model'},[])
  s.edit('u',d.id,1,{...d,text:'handwritten'})
  assert.throws(()=>s.applyProposal('u',d.id,2,candidate.id,['text']),/基线/)
  assert.equal(s.get('u',d.id).text,'handwritten')
})

test('discarding a candidate preserves article content and rejects stale or foreign deletes',async t=>{
  const s=new BlogStore(':memory:');t.after(()=>s.close())
  const actor={namespace:'n',userId:'u',sessionId:'s'},app=new BlogApplication(s,{assert(){}})
  const d=s.create('n:u',{title:'文章',text:'保留正文'}),p=s.propose('n:u',d.id,1,{text:'候选正文'},[])
  await assert.rejects(app.call({...actor,userId:'other'},'discard-proposal',{id:d.id,revision:1,proposalId:p.id}),/无权/)
  const newer=s.propose('n:u',d.id,1,{text:'新候选'},[])
  await assert.rejects(app.call(actor,'discard-proposal',{id:d.id,revision:1,proposalId:p.id}),/候选稿已变化/)
  const edited=s.edit('n:u',d.id,1,{...d,text:'手动修改'})
  await assert.rejects(app.call(actor,'discard-proposal',{id:d.id,revision:1,proposalId:newer.id}),/其他窗口/)
  const result=await app.call(actor,'discard-proposal',{id:d.id,revision:edited.revision,proposalId:newer.id})
  assert.equal(result.proposal,null);assert.equal(result.text,'手动修改');assert.equal(result.title,d.title)
  assert.equal(s.get('n:u',d.id).proposal,null)
})

test('publishing a candidate freezes latest text and tags, applies only after confirmation, and rejects deleted candidates',async t=>{
  const s=new BlogStore(':memory:');t.after(()=>s.close());const writes=[]
  const actor={namespace:'n',userId:'u',sessionId:'s'},blog={call:async(action,args)=>{writes.push(args);return{snapshot:{version:'v2',published:{cid:339,...args.content}},url:'https://example.invalid/339'}}}
  const app=new BlogApplication(s,{assert(){}},blog,null,null,{modelArticle:p=>p})
  const d=s.create('n:u',{title:'文章',text:'原文'}),p=s.propose('n:u',d.id,1,{text:'新正文',tags:['新标签']},[])
  const prepared=await app.call(actor,'prepare',{id:d.id,revision:1,mode:'publish',proposalId:p.id})
  assert.equal(prepared.after.text,'新正文');assert.equal(prepared.source,'proposal');assert.equal(writes.length,0);assert.equal(s.get('n:u',d.id).text,'原文')
  await app.call(actor,'confirm',{id:prepared.id,nonce:prepared.nonce})
  assert.equal(writes.length,1);assert.deepEqual(writes[0].content.tags,['新标签']);assert.equal(s.get('n:u',d.id).text,'新正文');assert.equal(s.get('n:u',d.id).proposal,null)
  const updated=s.get('n:u',d.id);blog.get=async()=>updated.remote
  const next=s.propose('n:u',d.id,updated.revision,{text:'应删除的候选'},[])
  const stale=await app.call(actor,'prepare',{id:d.id,revision:updated.revision,mode:'publish',proposalId:next.id})
  await app.call(actor,'discard-proposal',{id:d.id,revision:updated.revision,proposalId:next.id})
  await assert.rejects(app.call(actor,'confirm',{id:stale.id,nonce:stale.nonce}),/已变化/)
  assert.equal(writes.length,1)
})
test('two confirmations for a new draft cannot create concurrent duplicate posts',async t=>{
  const s=new BlogStore(':memory:');t.after(()=>s.close());let finish,calls=0
  const blog={call(){calls++;return new Promise(r=>{finish=r})}},actor={namespace:'n',userId:'u',sessionId:'s'}
  const app=new BlogApplication(s,{assert(){}},blog,null,null,{modelArticle:p=>p})
  const d=s.create('n:u',{title:'new',text:'new article'})
  const one=await app.prepare(actor,{id:d.id,revision:1,mode:'publish'}),two=await app.prepare(actor,{id:d.id,revision:1,mode:'publish'})
  const pending=app.confirm(actor,{id:one.id,nonce:one.nonce})
  await assert.rejects(app.confirm(actor,{id:two.id,nonce:two.nonce}),/已有提交/)
  assert.equal(calls,1)
  finish({version:'v',snapshot:{version:'v',published:{cid:1}}});await pending
  const replay=await app.confirm(actor,{id:one.id,nonce:one.nonce});assert.equal(replay.status,'succeeded');assert.equal(calls,1)
})
test('delegation idempotency is owner/caller scoped and rejects changed inputs',t=>{
  const s=new BlogStore(':memory:');t.after(()=>s.close())
  const a=s.jobStart('u','router','request-123',{draftId:'one'},{}).job
  assert.equal(s.jobStart('u','router','request-123',{draftId:'one'},{}).fresh,false)
  assert.throws(()=>s.jobStart('u','router','request-123',{draftId:'two'},{}),/不同输入/)
  assert.throws(()=>s.jobGet('other',a.id),/无权/)
})
