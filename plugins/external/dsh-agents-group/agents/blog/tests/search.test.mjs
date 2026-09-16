import test from 'node:test'
import assert from 'node:assert/strict'
import { BlogStore } from '../src/store.mjs'
import { normalizeSearch,searchContext,searchDrafts,searchLocalTime } from '../src/search.mjs'
import { BlogClient } from '../src/connectors.mjs'

test('remote search transports typed ranges and resolves native relative links',async()=>{
  let payload
  const client=new BlogClient({url:'https://blog.example',username:'fixture',password:'fixture'},async(_url,options)=>{payload=JSON.parse(options.body);return Response.json({ok:true,data:{items:[{cid:338,url:'/archives/338/',created:1788779537,modified:1788779537}],hasMore:false}})})
  const r=await client.search({dateFrom:'2026-09-07',dateTo:'2026-09-07',title:'测试',category:'笔记',tag:'测试',page:2})
  assert.equal(payload.action,'search');assert.equal(payload.start,Date.parse('2026-09-06T16:00:00Z')/1000);assert.equal(payload.end-payload.start,86400)
  assert.equal(payload.category,'笔记');assert.equal(payload.page,2);assert.equal(r.items[0].url,'https://blog.example/archives/338/')
  assert.equal(r.items[0].localTime.modified,'2026-09-07 19:12:17')
})

test('search accepts the observed pageSize argument and preserves bounded pagination',async()=>{
  const rows=Array.from({length:61},(_,i)=>({cid:i+1,title:'二叉树 '+i})),calls=[]
  const client=new BlogClient({url:'https://blog.example',username:'fixture',password:'fixture'},async(_url,options)=>{
    const p=JSON.parse(options.body);calls.push(p);const offset=(p.page-1)*p.pageSize
    return Response.json({ok:true,data:{items:rows.slice(offset,offset+p.pageSize),page:p.page,pageSize:p.pageSize,hasMore:offset+p.pageSize<rows.length}})
  })
  const first=await client.search({query:'二叉树',pageSize:50}),last=await client.search({query:'二叉树',pageSize:50,page:2})
  assert.equal(first.items.length,50);assert.equal(first.pageSize,50);assert.equal(first.filters.pageSize,50);assert.equal(first.hasMore,true)
  assert.equal(last.items.length,11);assert.equal(last.hasMore,false);assert.equal(last.pageSize,50)
  assert.deepEqual([...first.items,...last.items].map(r=>r.cid),rows.map(r=>r.cid));assert.equal(calls.length,2)
  assert.equal(calls[0].action,'search');assert.equal(calls[0].query,'二叉树');assert.equal(calls[0].pageSize,50)
  assert.equal(normalizeSearch().filters.pageSize,30)
  for(const pageSize of [1,100])assert.equal(normalizeSearch({pageSize}).filters.pageSize,pageSize)
  for(const pageSize of [0,101,1.5,'50',null,true,[],NaN])await assert.rejects(client.search({pageSize}),/每页条数/)
  assert.equal(calls.length,2,'invalid sizes never reach the bridge')
})

test('legacy search reports its actual fixed page size without extra requests or missing rows',async()=>{
  const rows=Array.from({length:61},(_,i)=>({cid:i+1})),calls=[]
  const client=new BlogClient({url:'https://blog.example',username:'fixture',password:'fixture'},async(_url,options)=>{
    const p=JSON.parse(options.body);calls.push(p);const offset=(p.page-1)*30
    return Response.json({ok:true,data:{items:rows.slice(offset,offset+30),page:p.page,hasMore:offset+30<rows.length}})
  })
  const pages=[]
  for(let page=1;page<=3;page++)pages.push(await client.search({query:'二叉树',pageSize:50,page}))
  assert.deepEqual(pages.map(p=>p.items.length),[30,30,1]);assert.deepEqual(pages.map(p=>p.hasMore),[true,true,false])
  for(const p of pages){assert.equal(p.pageSize,30);assert.equal(p.filters.pageSize,30);assert.match(p.pageSizeNote,/30/)}
  assert.deepEqual(pages.flatMap(p=>p.items.map(r=>r.cid)),rows.map(r=>r.cid));assert.equal(calls.length,3)
  for(const pageSize of [0,101,'30',null]){
    client.fetch=async()=>Response.json({ok:true,data:{items:[],pageSize,hasMore:false}})
    await assert.rejects(client.search(),e=>e.status===502&&/分页/.test(e.message))
  }
})

test('Shanghai midnight resolves today separately from literal keyword and yesterday',()=>{
  const now=Date.parse('2026-09-07T16:00:49Z')
  assert.equal(searchContext(now).today,'2026-09-08')
  assert.equal(searchContext(now).yesterday,'2026-09-07')
  assert.equal(searchLocalTime(now),'2026-09-08 00:00:49');assert.equal(searchLocalTime(now-50000),'2026-09-07 23:59:59');assert.equal(searchLocalTime(null),null)
  const today=normalizeSearch({period:'today'},now),yesterday=normalizeSearch({period:'yesterday'},now)
  assert.equal(today.start,Date.parse('2026-09-07T16:00:00Z'));assert.equal(yesterday.end,today.start)
  assert.equal(today.filters.query,'');assert.equal(normalizeSearch({query:'今天'},now).start,null)
  for(const input of [{dateFrom:'2026-02-30'},{dateFrom:'2026-09-08',dateTo:'2026-09-07'},{period:'today',dateFrom:'2026-09-07'},{page:0},{unknown:'x'}])assert.throws(()=>normalizeSearch(input,now))
})
test('combined draft filters retain ownership, dates, taxonomy, literal wildcards and pagination',async t=>{
  const store=new BlogStore(':memory:');t.after(()=>store.close());await store.init();const now=Date.parse('2026-09-07T16:00:49Z')
  for(let i=0;i<32;i++){const d=await store.create('u',{title:'Java 日期 '+i,text:'今天说明 100%_ 原文',categories:[7],tags:['后端']},{published:{cid:338}});store.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify({...d,createdAt:now-86400000,updatedAt:now-100000,contentUpdatedAt:now-100000}),d.id)}
  await store.create('other',{title:'不允许泄露'})
  const args={period:'yesterday',title:'Java',content:'100%_',category:'技术',tag:'后端'}
  const r=await searchDrafts(store,'u',args,now,[{id:7,name:'技术'}]);assert.equal(r.total,32);assert.equal(r.items.length,30);assert.equal(r.hasMore,true);assert.deepEqual(r,JSON.parse(JSON.stringify(r)))
  assert.equal(r.items[0].localTime.modified,'2026-09-07 23:59:09')
  assert.equal((await searchDrafts(store,'u',{...args,page:2},now,[{id:7,name:'技术'}])).items.length,2)
  const pages=[]
  for(const page of [1,2,3,4])pages.push(await searchDrafts(store,'u',{...args,page,pageSize:10},now,[{id:7,name:'技术'}]))
  assert.deepEqual(pages.map(p=>p.items.length),[10,10,10,2]);assert.deepEqual(pages.map(p=>p.hasMore),[true,true,true,false])
  assert.ok(pages.every(p=>p.pageSize===10&&p.filters.pageSize===10&&p.total===32))
  assert.equal(new Set(pages.flatMap(p=>p.items.map(d=>d.id))).size,32)
  assert.equal((await searchDrafts(store,'u',{period:'today'},now)).total,0)
  assert.equal((await searchDrafts(store,'u',{...args,category:'未知'},now,[])).total,0)
  assert.equal((await searchDrafts(store,'u',{status:'published'},now)).total,0)
  const d=await store.create('u',{title:'legacy'});const old={...d};delete old.createdAt;store.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(old),d.id)
  assert.equal((await searchDrafts(store,'u',{dateField:'created',period:'today'},now)).unknownDateCount,1)
})


test('library passes status and page to bridge and rejects silently ignored filters',async()=>{
  let payload
  const client=new BlogClient({url:'https://example.invalid',username:'u',password:'p'},async(url,options)=>{payload=JSON.parse(options.body);return Response.json({ok:true,data:{items:[],hasMore:false,status:payload.status}})})
  await client.list('文章',2,undefined,'published')
  assert.equal(payload.status,'published');assert.equal(payload.page,2);assert.equal(payload.query,'文章')
  await assert.rejects(client.list('',1,undefined,'other'),/检索参数/)
  client.fetch=async()=>Response.json({ok:true,data:{items:[],hasMore:false}})
  await assert.rejects(client.list('',1,undefined,'draft'),/0.3.1/)
})
