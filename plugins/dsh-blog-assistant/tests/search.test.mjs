import test from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.mjs'
import { normalizeSearch,searchContext,searchDrafts } from '../src/search.mjs'
import { BlogClient } from '../src/connectors.mjs'

test('remote search transports typed ranges and resolves native relative links',async()=>{
  let payload
  const client=new BlogClient({url:'https://blog.example',username:'fixture',password:'fixture'},async(_url,options)=>{payload=JSON.parse(options.body);return Response.json({ok:true,data:{items:[{cid:338,url:'/archives/338/'}],hasMore:false}})})
  const r=await client.search({dateFrom:'2026-09-07',dateTo:'2026-09-07',title:'测试',category:'笔记',tag:'测试',page:2})
  assert.equal(payload.action,'search');assert.equal(payload.start,Date.parse('2026-09-06T16:00:00Z')/1000);assert.equal(payload.end-payload.start,86400)
  assert.equal(payload.category,'笔记');assert.equal(payload.page,2);assert.equal(r.items[0].url,'https://blog.example/archives/338/')
})

test('Shanghai midnight resolves today separately from literal keyword and yesterday',()=>{
  const now=Date.parse('2026-09-07T16:00:49Z')
  assert.equal(searchContext(now).today,'2026-09-08')
  assert.equal(searchContext(now).yesterday,'2026-09-07')
  const today=normalizeSearch({period:'today'},now),yesterday=normalizeSearch({period:'yesterday'},now)
  assert.equal(today.start,Date.parse('2026-09-07T16:00:00Z'));assert.equal(yesterday.end,today.start)
  assert.equal(today.filters.query,'');assert.equal(normalizeSearch({query:'今天'},now).start,null)
  for(const input of [{dateFrom:'2026-02-30'},{dateFrom:'2026-09-08',dateTo:'2026-09-07'},{period:'today',dateFrom:'2026-09-07'},{page:0},{unknown:'x'}])assert.throws(()=>normalizeSearch(input,now))
})
test('combined draft filters retain ownership, dates, taxonomy, literal wildcards and pagination',t=>{
  const store=new BlogStore(':memory:');t.after(()=>store.close());const now=Date.parse('2026-09-07T16:00:49Z')
  for(let i=0;i<32;i++){const d=store.create('u',{title:'Java 日期 '+i,text:'今天说明 100%_ 原文',categories:[7],tags:['后端']},{published:{cid:338}});store.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify({...d,createdAt:now-86400000,updatedAt:now-100000}),d.id)}
  store.create('other',{title:'不允许泄露'})
  const args={period:'yesterday',title:'Java',content:'100%_',category:'技术',tag:'后端'}
  const r=searchDrafts(store,'u',args,now,[{id:7,name:'技术'}]);assert.equal(r.total,32);assert.equal(r.items.length,30);assert.equal(r.hasMore,true);assert.deepEqual(r,JSON.parse(JSON.stringify(r)))
  assert.equal(searchDrafts(store,'u',{...args,page:2},now,[{id:7,name:'技术'}]).items.length,2)
  assert.equal(searchDrafts(store,'u',{period:'today'},now).total,0)
  assert.equal(searchDrafts(store,'u',{...args,category:'未知'},now,[]).total,0)
  assert.equal(searchDrafts(store,'u',{status:'published'},now).total,0)
  const d=store.create('u',{title:'legacy'});const old={...d};delete old.createdAt;store.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(old),d.id)
  assert.equal(searchDrafts(store,'u',{dateField:'created',period:'today'},now).unknownDateCount,1)
})
