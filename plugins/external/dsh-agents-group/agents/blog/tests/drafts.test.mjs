import test from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.mjs'
import { BlogApplication } from '../src/application.mjs'
import { searchDrafts } from '../src/search.mjs'

/** 构造已 init 的 SQLite 业务存储（与生产 PG 存储同一异步方法面的测试实现）。 */
async function fixture(t){const s=new BlogStore(':memory:');t.after(()=>s.close());await s.init();return s}

test('deleted remote copies retain content and deletion state without becoming new writing activity',async t=>{
  const s=await fixture(t)
  const actor={namespace:'n',userId:'u',sessionId:'s'},app=new BlogApplication(s,{assert(){}})
  const yesterday=Date.parse('2026-09-07T12:00:00+08:00'),today=Date.parse('2026-09-08T12:00:00+08:00')
  const d=await s.create('n:u',{title:'保留副本',text:'未发布修改'},{published:{cid:338},version:'v'})
  s.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify({...d,createdAt:yesterday,updatedAt:yesterday,contentUpdatedAt:yesterday}),d.id)
  await app.applyResult({id:'delete-338',owner:'n:u',mode:'delete',before:{published:{cid:338}}},{deleted:true})
  const saved=await s.get('n:u',d.id),listed=(await s.list('n:u'))[0],searched=(await searchDrafts(s,'n:u',{},today)).items[0]
  assert.equal(saved.text,'未发布修改');assert.equal(saved.remote.deleted,true)
  assert.equal(listed.remote.deleted,true);assert.equal(searched.remote.deleted,true)
  assert.equal(listed.contentUpdatedAt,yesterday);assert.equal(searched.localTime.modified,'2026-09-07 12:00:00')
  assert.equal((await searchDrafts(s,'n:u',{period:'today'},today)).total,0)
  await assert.rejects(app.prepare(actor,{id:d.id,revision:saved.revision,mode:'publish'}),/原文已删除/)
  const edited=await s.edit('n:u',d.id,saved.revision,{...saved,text:'删除后继续手写'})
  assert.ok(edited.contentUpdatedAt>yesterday);assert.equal(edited.remote.deleted,true)
})

test('legacy deleted copies report unknown content time and missing creation counts are not extra drafts',async t=>{
  const s=await fixture(t);const now=Date.parse('2026-09-08T12:00:00+08:00')
  const d=await s.create('u',{title:'旧副本'},{savedDraft:{cid:337},deleted:true,deletedAt:now})
  const legacy={...d,updatedAt:now};delete legacy.createdAt;delete legacy.contentUpdatedAt
  s.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(legacy),d.id)
  const all=await searchDrafts(s,'u',{},now),dated=await searchDrafts(s,'u',{period:'today'},now)
  assert.equal(all.items[0].contentUpdatedAt,null);assert.equal(all.items[0].localTime.modified,null)
  assert.equal(all.items[0].contentTimeSource,'unknown')
  assert.equal(dated.total,0);assert.equal(dated.unknownDateCount,1)
  assert.match(dated.dateNote,/重叠/);assert.match(dated.dateNote,/原文已删除/)
  assert.deepEqual(all,JSON.parse(JSON.stringify(all)))
})

test('legacy record time remains labelled as approximate until a real content edit',async t=>{
  const s=await fixture(t)
  const d=await s.create('u',{title:'旧稿',text:'正文'}),legacy={...d};delete legacy.contentUpdatedAt
  s.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(legacy),d.id)
  assert.equal((await s.list('u'))[0].contentTimeSource,'legacy-record')
  const status=await s.save('u',d.id,d.revision,{proposal:null})
  assert.equal((await s.list('u'))[0].contentTimeSource,'legacy-record');assert.equal(status.contentUpdatedAt,d.updatedAt)
  await s.edit('u',d.id,status.revision,{...status,text:'实际修改'})
  assert.equal((await s.list('u'))[0].contentTimeSource,'content')
})

test('opening an unchanged remote version reuses the owner draft and preserves edits and candidates',async t=>{
  const s=await fixture(t);const actor={namespace:'n',userId:'u',sessionId:'s'}
  let remote={version:'v1',published:{cid:338,title:'原文',text:'正文',slug:'338',format:'markdown',tags:[],categories:[]},savedDraft:null}
  const app=new BlogApplication(s,{assert(){}},{get:async()=>structuredClone(remote)})
  const first=await app.importDraft(actor,338,'published'),edited=await s.edit('n:u',first.id,first.revision,{...first,text:'手写未发布'})
  const p=await s.propose('n:u',first.id,edited.revision,{text:'候选'},[])
  const again=await app.importDraft(actor,338,'published')
  assert.equal(again.id,first.id);assert.equal(again.text,'手写未发布');assert.equal(again.proposal.id,p.id)
  assert.equal((await s.list('n:u')).length,1)
  const other=await app.importDraft({...actor,userId:'other'},338,'published');assert.notEqual(other.id,first.id)
  remote={...remote,version:'v2',published:{...remote.published,text:'博客已更新'}}
  const fresh=await app.importDraft(actor,338,'published');assert.notEqual(fresh.id,first.id)
  assert.equal((await s.get('n:u',first.id)).text,'手写未发布');assert.equal(fresh.text,'博客已更新')
})

test('draft listing is lossless JSON when only one remote variant exists',async t=>{
  const s=await fixture(t)
  await s.create('u',{title:'昨天的文章'}, {published:{cid:338},savedDraft:null})
  await s.create('u',{title:'博客草稿'}, {published:null,savedDraft:{cid:337}})
  const rows=await s.list('u')
  assert.deepEqual(rows,JSON.parse(JSON.stringify(rows)))
})

test('manual edits cannot be overwritten by a stale model proposal',async t=>{
  const s=await fixture(t)
  const d=await s.create('u',{title:'first',text:'<!--raw--> body'})
  const candidate=await s.propose('u',d.id,1,{text:'model'},[])
  await s.edit('u',d.id,1,{...d,text:'handwritten'})
  await assert.rejects(s.applyProposal('u',d.id,2,candidate.id,['text']),/基线/)
  assert.equal((await s.get('u',d.id)).text,'handwritten')
})

test('discarding a candidate preserves article content and rejects stale or foreign deletes',async t=>{
  const s=await fixture(t)
  const actor={namespace:'n',userId:'u',sessionId:'s'},app=new BlogApplication(s,{assert(){}})
  const d=await s.create('n:u',{title:'文章',text:'保留正文'}),p=await s.propose('n:u',d.id,1,{text:'候选正文'},[])
  await assert.rejects(app.call({...actor,userId:'other'},'discard-proposal',{id:d.id,revision:1,proposalId:p.id}),/无权/)
  const newer=await s.propose('n:u',d.id,1,{text:'新候选'},[])
  await assert.rejects(app.call(actor,'discard-proposal',{id:d.id,revision:1,proposalId:p.id}),/候选稿已变化/)
  const edited=await s.edit('n:u',d.id,1,{...d,text:'手动修改'})
  await assert.rejects(app.call(actor,'discard-proposal',{id:d.id,revision:1,proposalId:newer.id}),/其他窗口/)
  const result=await app.call(actor,'discard-proposal',{id:d.id,revision:edited.revision,proposalId:newer.id})
  assert.equal(result.proposal,null);assert.equal(result.text,'手动修改');assert.equal(result.title,d.title)
  assert.equal((await s.get('n:u',d.id)).proposal,null)
})

test('publishing a candidate freezes latest text and tags, applies only after confirmation, and rejects deleted candidates',async t=>{
  const s=await fixture(t);const writes=[]
  const actor={namespace:'n',userId:'u',sessionId:'s'},blog={call:async(action,args)=>{writes.push(args);return{snapshot:{version:'v2',published:{cid:339,...args.content}},url:'https://example.invalid/339'}}}
  const app=new BlogApplication(s,{assert(){}},blog,null,null,{modelArticle:p=>p})
  const d=await s.create('n:u',{title:'文章',text:'原文'}),p=await s.propose('n:u',d.id,1,{text:'新正文',tags:['新标签']},[])
  const prepared=await app.call(actor,'prepare',{id:d.id,revision:1,mode:'publish',proposalId:p.id})
  assert.equal(p.before.text,'原文');assert.equal(p.before.title,d.title);
  assert.equal(prepared.after.text,'新正文');assert.equal(prepared.source,'proposal');assert.equal(writes.length,0);assert.equal((await s.get('n:u',d.id)).text,'原文')
  await app.call(actor,'confirm',{id:prepared.id,nonce:prepared.nonce})
  assert.equal(writes.length,1);assert.deepEqual(writes[0].content.tags,['新标签']);assert.equal((await s.get('n:u',d.id)).text,'新正文');assert.equal((await s.get('n:u',d.id)).proposal,null)
  const updated=await s.get('n:u',d.id);blog.get=async()=>updated.remote
  const next=await s.propose('n:u',d.id,updated.revision,{text:'应删除的候选'},[])
  const stale=await app.call(actor,'prepare',{id:d.id,revision:updated.revision,mode:'publish',proposalId:next.id})
  await app.call(actor,'discard-proposal',{id:d.id,revision:updated.revision,proposalId:next.id})
  await assert.rejects(app.call(actor,'confirm',{id:stale.id,nonce:stale.nonce}),/已变化/)
  assert.equal(writes.length,1)
})
test('two confirmations for a new draft cannot create concurrent duplicate posts',async t=>{
  const s=await fixture(t);let finish,calls=0
  const blog={call(){calls++;return new Promise(r=>{finish=r})}},actor={namespace:'n',userId:'u',sessionId:'s'}
  const app=new BlogApplication(s,{assert(){}},blog,null,null,{modelArticle:p=>p})
  const d=await s.create('n:u',{title:'new',text:'new article'})
  const one=await app.prepare(actor,{id:d.id,revision:1,mode:'publish'}),two=await app.prepare(actor,{id:d.id,revision:1,mode:'publish'})
  const pending=app.confirm(actor,{id:one.id,nonce:one.nonce})
  await assert.rejects(app.confirm(actor,{id:two.id,nonce:two.nonce}),/已有提交/)
  assert.equal(calls,1)
  finish({version:'v',snapshot:{version:'v',published:{cid:1}}});await pending
  const replay=await app.confirm(actor,{id:one.id,nonce:one.nonce});assert.equal(replay.status,'succeeded');assert.equal(calls,1)
})
test('delegation idempotency is owner/caller scoped and rejects changed inputs',async t=>{
  const s=await fixture(t)
  const a=(await s.jobStart('u','router','request-123',{draftId:'one'},{})).job
  assert.equal((await s.jobStart('u','router','request-123',{draftId:'one'},{})).fresh,false)
  await assert.rejects(s.jobStart('u','router','request-123',{draftId:'two'},{}),/不同输入/)
  await assert.rejects(s.jobGet('other',a.id),/无权/)
})

test('legacy blog snapshots tolerate page views while preserving edits and rejecting real remote changes',async t=>{
  const s=await fixture(t)
  const actor={namespace:'n',userId:'u',sessionId:'s'}
  const variant={cid:339,title:'原文',text:'原正文',tags:[],categories:[],raw:{text:'原正文',views:10,modified:100,commentsNum:0},fields:[]}
  const base={published:variant,savedDraft:{...structuredClone(variant),cid:340},version:'legacy-with-views',selectedVariant:'published'}
  let remote=structuredClone(base),writes=0
  remote.version='current';remote.published.raw.views=12;remote.savedDraft.raw.views=11
  delete remote.selectedVariant
  const blog={get:async()=>structuredClone(remote),call:async()=>{writes++;return{snapshot:structuredClone(remote)}}}
  const app=new BlogApplication(s,{assert(){}},blog,null,null,{modelArticle:p=>p})
  const d=await s.create('n:u',{title:'我的修改',text:'保留手写正文'},base)
  const proposal=await s.propose('n:u',d.id,1,{text:'保留候选正文'},[])
  const prepared=await app.prepare(actor,{id:d.id,revision:1,mode:'publish',proposalId:proposal.id})
  assert.equal(prepared.after.text,'保留候选正文');assert.equal(writes,0)
  assert.deepEqual((await s.get('n:u',d.id)).remote,base);assert.equal((await s.get('n:u',d.id)).text,'保留手写正文')
  assert.equal((await app.operation('n:u',prepared.id)).payload.base.version,'current')
  assert.equal((await app.operation('n:u',prepared.id)).payload.base.published.raw.views,12)
  const unchanged=structuredClone(remote)
  for(const change of [
    r=>{r.published.text='别人改了正文'},r=>{r.published.title='别人改了标题'},
    r=>{r.published.tags=['新标签']},r=>{r.published.categories=[2]},
    r=>{r.published.fields=[{name:'custom',value:'changed'}]},
    r=>{r.published.raw.modified++},r=>{r.published.raw.commentsNum++},
    r=>{r.savedDraft.text='别人改了保存稿'},r=>{r.savedDraft=null},
  ]){
    remote=structuredClone(unchanged);change(remote)
    await assert.rejects(app.prepare(actor,{id:d.id,revision:1,mode:'publish',proposalId:proposal.id}),/博客.*变化|博客.*修改/)
  }
  assert.equal((await s.get('n:u',d.id)).proposal.id,proposal.id);assert.equal(writes,0)
})
