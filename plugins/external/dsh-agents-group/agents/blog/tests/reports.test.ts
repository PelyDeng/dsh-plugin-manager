import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeReport,reportTools} from '../src/reports.ts'
import {BlogClient} from '../src/connectors.ts'

const config={url:'https://blog.example',username:'fixture',password:'fixture'}

/**
 * `normalizeReport()` 的产物形状。
 *
 * ⚠️ `reports.ts` 是**由实现推断**的（没有显式返回类型注解），推出来的 `filters` 只是 `{}`，
 * 而本文件要读它落下的那几个键。这里按"本文件真正读到的键"写一份最小形状，用一次
 * `as unknown as` 越过推断边界 —— 不断言实现内部的类型。`start` / `end` 声明成 `number`：
 * 本文件两处调用都给了显式时间范围（`period:'today'` / 顶层 `pageSize`），实现不会返回 `null`。
 */
type NormalizedReport = {
  readonly start: number
  readonly end: number
  readonly pageSize?: number
  readonly filters: {
    readonly status?: string
    readonly dateFrom?: string
    readonly tag?: string
    readonly categoryId?: number
    readonly includeDescendants?: boolean
    readonly hasSavedDraft?: boolean
    readonly page?: number
    readonly pageSize?: number
    readonly sortBy?: string
    readonly period?: string
  }
}

/** 桥接器请求体：本文件只读这三个键（`action` / `protocolVersion` / `filters.status`）。 */
type BridgeBody = { readonly action?: string; readonly protocolVersion?: number; readonly filters: { readonly status?: string } }

/**
 * `BlogClient` 在本文件用到的面。
 *
 * ⚠️ `connectors.ts` 的 `report(kind,input={},signal)` 里 `signal` **没有缺省值**，所以推断出来的
 * 签名要求三个实参，而用例按"有 signal 才传"调用（运行时 `requestSignal(undefined)` 自己兜底）。
 * 返回形状按本文件读到的键写：`totals` / `hasMore` / `timeZone` 只进 `assert`（`unknown` 足够），
 * `countScopeNote` 会被 `assert.match`／`.includes` 读，故声明成 `string`。
 */
type ReportClient = {
  report(kind: string, input?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{
    readonly totals?: unknown
    readonly hasMore?: unknown
    readonly timeZone?: unknown
    readonly countScopeNote: string
    readonly [key: string]: unknown
  }>
}

/** 造一个桥接器客户端：`BlogClient` 由实现推断（见 {@link ReportClient}），在此收窄一次。 */
const reportClient = (transport: typeof fetch): ReportClient => new BlogClient(config, transport) as unknown as ReportClient
test('report filters normalize Shanghai dates and preserve explicit scope without search pagination',()=>{
  const r=normalizeReport('catalog',{filters:{period:'today',categoryId:7,includeDescendants:true,tag:' 后端 ',hasSavedDraft:false}},Date.parse('2026-09-07T16:00:01Z')) as unknown as NormalizedReport
  assert.equal(r.filters.status,'published');assert.equal(r.filters.dateFrom,'2026-09-08');assert.equal(r.end-r.start,86400)
  assert.equal(r.start,Date.parse('2026-09-07T16:00:00Z')/1000);assert.equal(r.filters.tag,'后端')
  assert.equal(r.filters.categoryId,7);assert.equal(r.filters.includeDescendants,true);assert.equal(r.filters.hasSavedDraft,false)
  assert.equal(r.filters.page,undefined);assert.equal(r.filters.pageSize,undefined);assert.equal(r.filters.sortBy,undefined);assert.equal(r.filters.period,undefined)
  const paged=normalizeReport('catalog',{pageSize:500}) as unknown as NormalizedReport;assert.equal(paged.pageSize,500);assert.equal(paged.filters.pageSize,undefined)
  for(const report of reportTools)assert.equal((normalizeReport(report.report,{filters:{status:'all'}}) as unknown as NormalizedReport).filters.status,'all')
})
test('report validation rejects unsupported filters, invalid pages and ambiguous names before transport',async()=>{
  const client=reportClient(()=>assert.fail('invalid queries must not reach the bridge'))
  for(const args of [{action:'save'},{constructor:'x'},{filters:{constructor:'x'}},{filters:[]},{filters:{page:2}},{filters:{pageSize:50}},
    {pageSize:0},{pageSize:501},{page:1.1},{groupBy:'unknown'},{filters:{categoryId:'1'}},{filters:{categoryId:1,category:'技术'}},
    {filters:{tagId:1,tag:'后端'}},{filters:{includeDescendants:true}},{filters:{hasSavedDraft:'true'}},{filters:{missing:'all'}},
    {filters:{dateFrom:'2026-02-30'}},{filters:{period:'today',dateTo:'2026-09-08'}},{filters:{title:['x']}}])await assert.rejects(client.report('catalog',args))
  await assert.rejects(client.report('unknown',{}));await assert.rejects(client.report('overview',{page:1}))
})
test('every report travels in one bounded read request and retains paging and authoritative totals',async()=>{
  const calls: BridgeBody[]=[],controller=new AbortController()
  // transport 的 `init` 由 `typeof fetch` 推出 `RequestInit | undefined`（`call()` 总会传它）
  // ⇒ 就地收窄一次；请求体在本文件里始终是 JSON 字符串。
  const client=reportClient(async(_url,options)=>{const init=options as RequestInit;const body=JSON.parse(init.body as string);calls.push(body);assert.ok(init.signal);return Response.json({ok:true,data:{reportVersion:1,report:body.report,complete:true,totals:{articleCount:145,versionCount:146},hasMore:true,items:[]}})})
  for(const definition of reportTools){const result=await client.report(definition.report,{filters:{status:'all'}},controller.signal);assert.deepEqual(result.totals,{articleCount:145,versionCount:146});assert.equal(result.hasMore,true);assert.equal(result.timeZone,'Asia/Shanghai')}
  assert.equal(calls.length,5);assert.ok(calls.every(c=>c.action==='report'&&c.protocolVersion===1&&c.filters.status==='all'))
})
test('published report distinguishes a saved-draft marker from counted versions and keeps original evidence',async()=>{
  const data={reportVersion:1,report:'ranking',complete:true,scope:{status:'published',articleUnit:'distinct rootCid',versionUnit:'cid'},
    totals:{articleCount:145,versionCount:145,publishedArticles:145,savedDraftVersions:0,statusVersions:{publish:145}},
    note:'文章数按 rootCid 去重，版本数包含匹配的保存稿。',page:1,pageSize:1,totalItems:145,hasMore:true,items:[{cid:1,title:'Fixture',hasSavedDraft:true}]}
  let calls=0
  const client=reportClient(async(_url,options)=>{const init=options as RequestInit;calls++;const request=JSON.parse(init.body as string);assert.equal(request.action,'report');assert.equal(request.filters.status,'published');return Response.json({ok:true,data})})
  const result=await client.report('ranking',{page:1,pageSize:1})
  assert.equal(calls,1)
  // `Object.keys()` 的类型是 `string[]`，而这里遍历的正是 `data` 自己的键 ⇒ 就地收窄一次。
  for(const key of Object.keys(data))assert.deepEqual(result[key],data[key as keyof typeof data],key)
  assert.match(result.countScopeNote,/本次统计计入保存稿版本 0 个/)
  assert.match(result.countScopeNote,/hasSavedDraft.*不代表该稿件版本已计入 totals/)
  assert.match(result.countScopeNote,/不表示已读取全部明细.*hasMore/)
})
test('all-scope report explains the actual saved-draft count without inferring it from version or article counts',async()=>{
  for(const totals of [{articleCount:8,versionCount:8,savedDraftVersions:0},{articleCount:8,versionCount:10,savedDraftVersions:3}]){
    const data={reportVersion:1,report:'overview',complete:true,scope:{status:'all'},totals}
    const client=reportClient(async()=>Response.json({ok:true,data}))
    const result=await client.report('overview',{filters:{status:'all'}})
    assert.deepEqual(result.totals,data.totals)
    assert.ok(result.countScopeNote.includes(`本次统计计入保存稿版本 ${totals.savedDraftVersions} 个`))
  }
})
test('missing or invalid saved-draft counts stay unknown even when published scope or equal totals suggest zero',async()=>{
  for(const value of [undefined,null,'0',-1,0.5]){
    const totals={articleCount:145,versionCount:145,...(value===undefined?{}:{savedDraftVersions:value})}
    const client=reportClient(async()=>Response.json({ok:true,data:{reportVersion:1,report:'ranking',complete:true,scope:{status:'published'},totals}}))
    const result=await client.report('ranking')
    assert.deepEqual(result.totals,totals)
    assert.match(result.countScopeNote,/无法确认/)
    assert.doesNotMatch(result.countScopeNote,/本次统计计入保存稿版本 0 个/)
  }
})
test('unsupported, incomplete and oversized reports never trigger expensive search fallback',async()=>{
  for(const data of [{},{reportVersion:1,report:'catalog',complete:false},{reportVersion:1,report:'overview',complete:true}]){
    let calls=0;const client=reportClient(async()=>{calls++;return Response.json({ok:true,data})})
    // `assert.rejects` 的谓词拿到的是 `unknown`（`@types/node` 的 `AssertPredicate`）⇒ 就地收窄成
    // 桥接器错误的形状（`BlogError` 带 `status`，`message` 是文案）。
    await assert.rejects(client.report('catalog'),(e: unknown)=>{const error=e as Error & {status?: number};return error.status===503&&/桥接器/.test(error.message)});assert.equal(calls,1)
  }
  for(const [code,status,message] of [['invalid',400,/reports=1/],['report-too-large',413,/未返回部分结果/],['invalid-hierarchy',409,/分类层级/],['forbidden',403,/权限/]] as [string, number, RegExp][]){
    let calls=0;const client=reportClient(async()=>{calls++;return Response.json({ok:false,code},{status})})
    await assert.rejects(client.report('overview'),(e: unknown)=>{const error=e as Error & {status?: number};return error.status===(code==='invalid'?503:status)&&message.test(error.message)});assert.equal(calls,1)
  }
})
