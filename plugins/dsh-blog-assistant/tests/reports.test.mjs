import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeReport,reportTools} from '../src/reports.mjs'
import {BlogClient} from '../src/connectors.mjs'

const config={url:'https://blog.example',username:'fixture',password:'fixture'}
test('report filters normalize Shanghai dates and preserve explicit scope without search pagination',()=>{
  const r=normalizeReport('catalog',{filters:{period:'today',categoryId:7,includeDescendants:true,tag:' 后端 ',hasSavedDraft:false}},Date.parse('2026-09-07T16:00:01Z'))
  assert.equal(r.filters.status,'published');assert.equal(r.filters.dateFrom,'2026-09-08');assert.equal(r.end-r.start,86400)
  assert.equal(r.start,Date.parse('2026-09-07T16:00:00Z')/1000);assert.equal(r.filters.tag,'后端')
  assert.equal(r.filters.categoryId,7);assert.equal(r.filters.includeDescendants,true);assert.equal(r.filters.hasSavedDraft,false)
  assert.equal(r.filters.page,undefined);assert.equal(r.filters.pageSize,undefined);assert.equal(r.filters.sortBy,undefined);assert.equal(r.filters.period,undefined)
  const paged=normalizeReport('catalog',{pageSize:500});assert.equal(paged.pageSize,500);assert.equal(paged.filters.pageSize,undefined)
  for(const report of reportTools)assert.equal(normalizeReport(report.report,{filters:{status:'all'}}).filters.status,'all')
})
test('report validation rejects unsupported filters, invalid pages and ambiguous names before transport',async()=>{
  const client=new BlogClient(config,()=>assert.fail('invalid queries must not reach the bridge'))
  for(const args of [{action:'save'},{constructor:'x'},{filters:{constructor:'x'}},{filters:[]},{filters:{page:2}},{filters:{pageSize:50}},
    {pageSize:0},{pageSize:501},{page:1.1},{groupBy:'unknown'},{filters:{categoryId:'1'}},{filters:{categoryId:1,category:'技术'}},
    {filters:{tagId:1,tag:'后端'}},{filters:{includeDescendants:true}},{filters:{hasSavedDraft:'true'}},{filters:{missing:'all'}},
    {filters:{dateFrom:'2026-02-30'}},{filters:{period:'today',dateTo:'2026-09-08'}},{filters:{title:['x']}}])await assert.rejects(client.report('catalog',args))
  await assert.rejects(client.report('unknown',{}));await assert.rejects(client.report('overview',{page:1}))
})
test('every report travels in one bounded read request and retains paging and authoritative totals',async()=>{
  const calls=[],controller=new AbortController()
  const client=new BlogClient(config,async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);assert.ok(options.signal);return Response.json({ok:true,data:{reportVersion:1,report:body.report,complete:true,totals:{articleCount:145,versionCount:146},hasMore:true,items:[]}})})
  for(const definition of reportTools){const result=await client.report(definition.report,{filters:{status:'all'}},controller.signal);assert.deepEqual(result.totals,{articleCount:145,versionCount:146});assert.equal(result.hasMore,true);assert.equal(result.timeZone,'Asia/Shanghai')}
  assert.equal(calls.length,5);assert.ok(calls.every(c=>c.action==='report'&&c.protocolVersion===1&&c.filters.status==='all'))
})
test('published report distinguishes a saved-draft marker from counted versions and keeps original evidence',async()=>{
  const data={reportVersion:1,report:'ranking',complete:true,scope:{status:'published',articleUnit:'distinct rootCid',versionUnit:'cid'},
    totals:{articleCount:145,versionCount:145,publishedArticles:145,savedDraftVersions:0,statusVersions:{publish:145}},
    note:'文章数按 rootCid 去重，版本数包含匹配的保存稿。',page:1,pageSize:1,totalItems:145,hasMore:true,items:[{cid:1,title:'Fixture',hasSavedDraft:true}]}
  let calls=0
  const client=new BlogClient(config,async(_url,options)=>{calls++;const request=JSON.parse(options.body);assert.equal(request.action,'report');assert.equal(request.filters.status,'published');return Response.json({ok:true,data})})
  const result=await client.report('ranking',{page:1,pageSize:1})
  assert.equal(calls,1)
  for(const key of Object.keys(data))assert.deepEqual(result[key],data[key],key)
  assert.match(result.countScopeNote,/本次统计计入保存稿版本 0 个/)
  assert.match(result.countScopeNote,/hasSavedDraft.*不代表该稿件版本已计入 totals/)
  assert.match(result.countScopeNote,/不表示已读取全部明细.*hasMore/)
})
test('all-scope report explains the actual saved-draft count without inferring it from version or article counts',async()=>{
  for(const totals of [{articleCount:8,versionCount:8,savedDraftVersions:0},{articleCount:8,versionCount:10,savedDraftVersions:3}]){
    const data={reportVersion:1,report:'overview',complete:true,scope:{status:'all'},totals}
    const client=new BlogClient(config,async()=>Response.json({ok:true,data}))
    const result=await client.report('overview',{filters:{status:'all'}})
    assert.deepEqual(result.totals,data.totals)
    assert.ok(result.countScopeNote.includes(`本次统计计入保存稿版本 ${totals.savedDraftVersions} 个`))
  }
})
test('missing or invalid saved-draft counts stay unknown even when published scope or equal totals suggest zero',async()=>{
  for(const value of [undefined,null,'0',-1,0.5]){
    const totals={articleCount:145,versionCount:145,...(value===undefined?{}:{savedDraftVersions:value})}
    const client=new BlogClient(config,async()=>Response.json({ok:true,data:{reportVersion:1,report:'ranking',complete:true,scope:{status:'published'},totals}}))
    const result=await client.report('ranking')
    assert.deepEqual(result.totals,totals)
    assert.match(result.countScopeNote,/无法确认/)
    assert.doesNotMatch(result.countScopeNote,/本次统计计入保存稿版本 0 个/)
  }
})
test('unsupported, incomplete and oversized reports never trigger expensive search fallback',async()=>{
  for(const data of [{},{reportVersion:1,report:'catalog',complete:false},{reportVersion:1,report:'overview',complete:true}]){
    let calls=0;const client=new BlogClient(config,async()=>{calls++;return Response.json({ok:true,data})})
    await assert.rejects(client.report('catalog'),e=>e.status===503&&/桥接器/.test(e.message));assert.equal(calls,1)
  }
  for(const [code,status,message] of [['invalid',400,/reports=1/],['report-too-large',413,/未返回部分结果/],['invalid-hierarchy',409,/分类层级/],['forbidden',403,/权限/]]){
    let calls=0;const client=new BlogClient(config,async()=>{calls++;return Response.json({ok:false,code},{status})})
    await assert.rejects(client.report('overview'),e=>e.status===(code==='invalid'?503:status)&&message.test(e.message));assert.equal(calls,1)
  }
})
