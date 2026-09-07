import test from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.mjs'
import { BlogApplication } from '../src/application.mjs'

test('manual edits cannot be overwritten by a stale model proposal',t=>{
  const s=new BlogStore(':memory:');t.after(()=>s.close())
  const d=s.create('u',{title:'first',text:'<!--raw--> body'})
  const candidate=s.propose('u',d.id,1,{text:'model'},[])
  s.edit('u',d.id,1,{...d,text:'handwritten'})
  assert.throws(()=>s.applyProposal('u',d.id,2,candidate.id,['text']),/基线/)
  assert.equal(s.get('u',d.id).text,'handwritten')
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
