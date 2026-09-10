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
  assert.equal(r.filters.page,undefined);assert.equal(r.filters.sortBy,undefined);assert.equal(r.filters.period,undefined)
  for(const report of reportTools)assert.equal(normalizeReport(report.report,{filters:{status:'all'}}).filters.status,'all')
})
test('report validation rejects unsupported filters, invalid pages and ambiguous names before transport',async()=>{
  const client=new BlogClient(config,()=>assert.fail('invalid queries must not reach the bridge'))
  for(const args of [{action:'save'},{constructor:'x'},{filters:{constructor:'x'}},{filters:[]},{filters:{page:2}},
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
