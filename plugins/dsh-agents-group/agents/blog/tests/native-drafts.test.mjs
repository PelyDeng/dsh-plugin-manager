import test from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore,article } from '../src/store.mjs'
import { BlogApplication } from '../src/application.mjs'

const actor={namespace:'test',userId:'writer',sessionId:'session'},owner='test:writer'
function fixture(t){
  const store=new BlogStore(':memory:');t.after(()=>store.close())
  const records=new Map(),receipts=new Map(),writes=[];let cid=10,loseResponse=false
  const blog={async get(id){return structuredClone(records.get(id))},async list(q,page,signal,status){return{items:[...records].map(([cid,d])=>({cid,title:(d.savedDraft??d.published).title,hasPublished:!!d.published,hasSavedDraft:!!d.savedDraft})),status,hasMore:false}},async call(action,args){
    if(action==='status')return{nativeDrafts:true}
    if(action==='receipt')return receipts.has(args.requestId)?{status:'succeeded',result:receipts.get(args.requestId)}:{status:'unknown'}
    assert.equal(action,'save');writes.push(structuredClone(args))
    if(receipts.has(args.requestId))return structuredClone(receipts.get(args.requestId))
    const id=args.base?.published?.cid??args.base?.savedDraft?.cid??cid++,current=records.get(id)
    if(args.base&&current?.version!==args.base.version)throw Object.assign(Error('conflict'),{status:409})
    const savedDraft={...args.content,cid:current?.published?id+1000:id,type:'post_draft'},snapshot={published:current?.published??null,savedDraft,selectedVariant:'savedDraft',version:String(writes.length)}
    records.set(id,snapshot);const result={cid:id,snapshot,version:snapshot.version};receipts.set(args.requestId,result)
    if(loseResponse){loseResponse=false;throw Error('response lost')}
    return structuredClone(result)
  }}
  const app=new BlogApplication(store,{assert(){}},blog,null,null,{modelArticle:p=>p})
  return{store,app,blog,records,writes,loseNextResponse(){loseResponse=true}}
}
test('new and manually edited content lives in a native blog draft, not a second library',async t=>{
  const f=fixture(t),d=await f.app.call(actor,'create',{requestId:'new-article-1'})
  assert.ok(d.blogNative);assert.ok(d.remote.savedDraft.cid);assert.equal(f.records.size,1)
  assert.equal((await f.app.call(actor,'drafts'))[0].cid,d.remote.savedDraft.cid)
  const saved=await f.app.call(actor,'save',{id:d.id,revision:d.revision,content:{...article(d),title:'标题',text:'内容'}})
  assert.equal(f.records.get(d.remote.savedDraft.cid).savedDraft.text,'内容');assert.equal(saved.text,'内容')
  assert.equal(f.store.list(owner).length,1)
})
test('editing published content saves its native draft and leaves the public version intact',async t=>{
  const f=fixture(t);f.records.set(339,{version:'old',published:{cid:339,title:'标题',text:'公开原文',slug:'',format:'markdown',tags:[],categories:[]},savedDraft:null})
  const d=await f.app.importDraft(actor,339,'published')
  await f.app.call(actor,'save',{id:d.id,revision:d.revision,content:{...article(d),text:'未发布修改'}})
  assert.equal(f.records.get(339).published.text,'公开原文');assert.equal(f.records.get(339).savedDraft.text,'未发布修改')
})
test('a lost creation response retries the frozen receipt without creating another draft',async t=>{
  const f=fixture(t);f.loseNextResponse()
  await assert.rejects(f.app.call(actor,'create',{requestId:'lost-create-1'}),/lost/)
  const d=await f.app.call(actor,'create',{requestId:'lost-create-1'})
  assert.ok(d.blogNative);assert.equal(f.records.size,1);assert.equal(f.store.list(owner).length,1)
  assert.equal(f.writes[0].requestId,f.writes[1].requestId)
})
test('lost save response and foreign changes preserve editing data and prevent overwrites',async t=>{
  const f=fixture(t),d=await f.app.call(actor,'create',{requestId:'lost-save-01'})
  const args={id:d.id,revision:d.revision,content:{...article(d),text:'待保存'}};f.loseNextResponse()
  await assert.rejects(f.app.call(actor,'save',args),/lost/)
  assert.equal(f.store.get(owner,d.id).text,'');assert.equal(f.app.operations(owner).at(-1).payload.content.text,'待保存')
  const saved=await f.app.call(actor,'save',args);assert.equal(saved.text,'待保存')
  const remote=f.records.get(saved.remote.savedDraft.cid);remote.version='external';remote.savedDraft.text='别处修改'
  await assert.rejects(f.app.call(actor,'save',{...args,revision:saved.revision,content:{...args.content,text:'不能覆盖'}}),/变化/)
  assert.equal(remote.savedDraft.text,'别处修改');assert.equal(f.store.get(owner,d.id).text,'待保存')
})
test('migration retains blank, duplicate, linked and deleted copies as distinct blog drafts',async t=>{
  const f=fixture(t),legacy=[f.store.create(owner),f.store.create(owner,{title:'同名',text:'甲'}),f.store.create(owner,{title:'同名',text:'乙'},{published:{cid:339},deleted:true}),f.store.create(owner,{title:'旧文副本',text:'丙'},{published:{cid:339}})]
  f.store.create('test:other',{title:'其他人的内容'})
  const result=await f.app.call(actor,'migrate-drafts')
  assert.equal(result.items.length,4);assert.equal(result.remaining,0);assert.equal(f.records.size,4)
  assert.equal(new Set(result.items.map(x=>x.cid)).size,4)
  for(const d of legacy){const migrated=f.store.get(owner,d.id);assert.deepEqual(article(migrated),article(d));assert.deepEqual(migrated.legacyRemote,d.remote)}
  assert.equal((await f.app.call(actor,'migrate-drafts')).items.length,0)
  assert.equal(f.app.legacyDrafts('test:other').length,1)
})
test('AI proposals remain separate suggestions until selected fields are saved to the blog',async t=>{
  const f=fixture(t),d=await f.app.call(actor,'create',{requestId:'proposal-new'})
  const p=f.store.propose(owner,d.id,d.revision,{title:'AI 标题',text:'AI 正文'},[]),before=f.writes.length
  assert.equal(f.records.get(d.remote.savedDraft.cid).savedDraft.text,'')
  const result=await f.app.call(actor,'apply',{id:d.id,revision:d.revision,proposalId:p.id,fields:['text']})
  assert.equal(f.writes.length,before+1);assert.equal(result.text,'AI 正文');assert.equal(result.title,'');assert.equal(result.proposal,null)
})
test('old bridge refuses native draft creation before creating local orphan records',async t=>{
  const f=fixture(t);f.blog.call=async()=>({})
  await assert.rejects(f.app.call(actor,'create',{requestId:'old-bridge-1'}),/桥接扩展/)
  assert.equal(f.store.list(owner).length,0)
})


test('category and comment settings remain candidates until native draft application',async t=>{
  const f=fixture(t),d=await f.app.call(actor,'create',{requestId:'settings-test'})
  const p=f.store.propose(owner,d.id,d.revision,{categories:[4],allowComment:false},[])
  assert.deepEqual(f.records.get(d.remote.savedDraft.cid).savedDraft.categories,[])
  const saved=await f.app.call(actor,'apply',{id:d.id,revision:d.revision,proposalId:p.id,fields:['categories','allowComment']})
  assert.deepEqual(saved.categories,[4]);assert.equal(saved.allowComment,false)
  assert.equal(f.records.get(d.remote.savedDraft.cid).savedDraft.allowComment,false)
})
