import { invariant } from './settings.ts'
import { draftContentUpdatedAt,draftSummary,type BlogDraft,type BlogDraftSummary } from './store.ts'

export const searchTimeZone='Asia/Shanghai'

/**
 * 未校验的检索输入。
 *
 * 每个字段都由 `normalizeSearch` 逐条校验，所以这里的声明值类型只是"能读成什么"；索引签名
 * 保留既有行为：多余键先收进来，再由 `searchParameters` 判非法。
 */
export interface SearchInput {
  readonly [key: string]: unknown
  readonly query?: string | undefined
  readonly title?: string | undefined
  readonly content?: string | undefined
  readonly category?: string | undefined
  readonly tag?: string | undefined
  readonly period?: string | undefined
  readonly dateFrom?: string | undefined
  readonly dateTo?: string | undefined
  readonly dateField?: string | undefined
  readonly status?: string | undefined
  readonly sortBy?: string | undefined
  readonly order?: string | undefined
  readonly page?: number | undefined
  readonly pageSize?: number | undefined
}

/**
 * 归一化后的筛选条件。
 *
 * 字段顺序与赋值顺序一致（键的插入顺序对 `JSON.stringify` 可见）；`reports.ts` 会解构读
 * `category` / `tag` / `status` / `pageSize`，所以这层形状是跨文件的契约。
 */
export interface SearchFilters {
  query: string
  title: string
  content: string
  category: string
  tag: string
  dateField: string
  status: string
  sortBy: string
  order: string
  page: number
  pageSize: number
  dateFrom: string
  dateTo: string
}

/** `normalizeSearch` 的产出：筛选条件 + 时间基准 + 毫秒级区间（`[start, end)`）。 */
export interface NormalizedSearch {
  readonly filters: SearchFilters
  readonly timeZone: string
  readonly start: number | null
  readonly end: number | null
}

/** 本轮时间基准（系统提示、检索回执与草稿检索共用）。 */
export interface SearchContext {
  readonly now: string
  readonly timeZone: string
  readonly today: string
  readonly yesterday: string
}

/** 上海时区本地时间；时间戳不可用时为 null（调用方会直接传记录里缺省/已删的时间字段）。 */
export const searchLocalTime=(ms: number|null|undefined): string|null=>Number.isFinite(ms)?new Intl.DateTimeFormat('sv-SE',{timeZone:searchTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(ms as number)):null
const day=(ms: number): string=>new Intl.DateTimeFormat('en-CA',{timeZone:searchTimeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms))
export function searchContext(now: number=Date.now()): SearchContext { return {now:new Date(now).toISOString(),timeZone:searchTimeZone,today:day(now),yesterday:day(now-86400000)} }
export const searchParameters={
  query:{type:'string',description:'标题或正文包含的字面关键词；时间词不要放这里。空字符串查询全部。'},
  title:{type:'string',description:'标题包含'},content:{type:'string',description:'正文包含'},
  category:{type:'string',description:'分类名称，精确匹配'},tag:{type:'string',description:'标签名称，精确匹配'},
  period:{type:'string',enum:['today','yesterday'],description:'上海时区今天/昨天；不能同时传日期范围'},
  dateFrom:{type:'string',description:'起始日期 YYYY-MM-DD，含当日'},dateTo:{type:'string',description:'结束日期 YYYY-MM-DD，含当日'},
  dateField:{type:'string',enum:['created','modified'],description:'默认 modified（写作/修改活动）；created 为文章设定时间，不能当成首次写作证据'},
  status:{type:'string',enum:['all','published','draft'],description:'博客的全部/已公开/未公开稿；工作台内容始终属于私有草稿'},
  page:{type:'integer',description:'从1开始；hasMore=true时仍有更多结果'},
  pageSize:{type:'integer',description:'每页1至100条，默认30；以返回的实际pageSize为准，续页保持相同大小'},
  sortBy:{type:'string',enum:['created','modified']},order:{type:'string',enum:['asc','desc']},
}
/** 一组枚举式检索条件：键名、允许值、缺省值。 */
type OptionKey='dateField'|'status'|'sortBy'|'order'
type OptionGroup=readonly [OptionKey, readonly string[], string]

export function normalizeSearch(input: SearchInput={},now: number=Date.now()): NormalizedSearch {
  invariant(input&&typeof input==='object'&&!Array.isArray(input),'检索条件无效')
  invariant(Object.keys(input).every(k=>k in searchParameters),'不支持的检索条件')
  // 十三个键在后面都被**无条件**赋值，初值只为拿到 `SearchFilters` 的形状（键序与赋值序逐字一致）。
  const f: SearchFilters={query:'',title:'',content:'',category:'',tag:'',dateField:'',status:'',sortBy:'',order:'',page:0,pageSize:0,dateFrom:'',dateTo:''}
  for(const key of ['query','title','content','category','tag'] as const){const v=input[key]??'';invariant(typeof v==='string'&&v.length<=200,`${key} 检索条件无效`);f[key]=v.trim()}
  for(const [key,values,fallback] of [['dateField',['created','modified'],'modified'],['status',['all','published','draft'],'all'],['sortBy',['created','modified'],'modified'],['order',['asc','desc'],'desc']] as readonly OptionGroup[]){f[key]=input[key]??fallback;invariant(values.includes(f[key]),`${key} 检索条件无效`)}
  f.page=input.page??1;invariant(Number.isSafeInteger(f.page)&&f.page>0&&f.page<=10000,'页码无效')
  f.pageSize=input.pageSize===undefined?30:input.pageSize;invariant(Number.isSafeInteger(f.pageSize)&&f.pageSize>=1&&f.pageSize<=100,'每页条数应为1至100的整数')
  f.dateFrom=input.dateFrom??'';f.dateTo=input.dateTo??''
  // `period` 的键名由本行 invariant 校验，所以类型层按校验后的两个字面量收窄（取值与改造前同一表达式）。
  if(input.period!==undefined){invariant(['today','yesterday'].includes(input.period)&&!f.dateFrom&&!f.dateTo,'相对日期与日期范围不能混用');f.dateFrom=f.dateTo=searchContext(now)[input.period as 'today'|'yesterday']}
  const date=(value: string): number=>{invariant(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='2000-01-01','日期应为2000年起的有效 YYYY-MM-DD');const ms=Date.parse(value+'T00:00:00+08:00');invariant(Number.isFinite(ms)&&day(ms)===value,'日期无效');return ms}
  const start=f.dateFrom?date(f.dateFrom):null,end=f.dateTo?date(f.dateTo)+86400000:null
  invariant(start===null||end===null||start<end,'起始日期不能晚于结束日期')
  return {filters:f,timeZone:searchTimeZone,start,end}
}

/** 业务库里的草稿记录：用 `store.ts` 的 `BlogDraft`（本函数只读其中一部分字段）。 */

/** 本函数用到的存储面：SQLite 替身与 PG 实现都满足（`draftRecords` 返回**可变**数组，下面要原地排序）。 */
export interface DraftRecordsSource {
  draftRecords(owner: string): Promise<BlogDraft[]>
}

/** 分类的最小面：按名称匹配、按 id 过滤。 */
export interface CategoryRef {
  readonly id: number
  readonly name: string
}

/** 工作台草稿检索结果的一项（`draftSummary` 的投影 + 会话内状态 + 上海本地时间）。 */
export interface SearchDraftItem extends BlogDraftSummary {
  readonly status: string
  readonly localTime: { readonly created: string | null; readonly modified: string | null; readonly deleted: string | null }
}

/** 草稿检索回执（`dateNote` 与 `unknownDateCount` 是给模型的口径说明）。 */
export interface DraftSearchResult {
  readonly items: readonly SearchDraftItem[]
  readonly page: number
  readonly pageSize: number
  readonly hasMore: boolean
  readonly total: number
  readonly unknownDateCount: number
  readonly filters: SearchFilters
  readonly timeZone: string
  readonly dateNote: string
}

export async function searchDrafts(storage: DraftRecordsSource,owner: string,input: SearchInput={},now: number=Date.now(),categories: readonly CategoryRef[]=[]): Promise<DraftSearchResult> {
  const {filters:f,timeZone,start,end}=normalizeSearch(input,now)
  const categoryIds=categories.filter(c=>c.name===f.category).map(c=>c.id)
  const contains=(s: string,q: string): boolean=>!q||s.toLowerCase().includes(q.toLowerCase())
  let unknownDateCount=0
  const rows=(await storage.draftRecords(owner)).filter(d=>{
    if(f.status==='published')return false
    if(!(contains(d.title,f.query)||contains(d.text,f.query))||!contains(d.title,f.title)||!contains(d.text,f.content))return false
    if(f.category&&!d.categories.some(id=>categoryIds.includes(id)))return false
    if(f.tag&&!d.tags.includes(f.tag))return false
    // `draftContentUpdatedAt` 可能返回 `null`（原文已删且没有内容时间），`createdAt` 在旧记录上可能缺失。
    // 两处比较要么在 `Number.isFinite(at)` 之后、要么被 `start/end===null` 短路 ⇒ 走到比较时恒为有限数字，
    // 这里用**真实的 `typeof` 判空**（不是 `!`）把这一点写进类型。
    const at=f.dateField==='created'?d.createdAt:draftContentUpdatedAt(d)
    if((start!==null||end!==null)&&!Number.isFinite(at)){unknownDateCount++;return false}
    return (start===null||typeof at==='number'&&at>=start)&&(end===null||typeof at==='number'&&at<end)
  })
  const timestamp=(d: BlogDraft): number=>f.sortBy==='created'?d.createdAt??0:draftContentUpdatedAt(d)??0
  rows.sort((a,b)=>(timestamp(a)-timestamp(b))*(f.order==='asc'?1:-1)||a.id.localeCompare(b.id))
  const offset=(f.page-1)*f.pageSize,items=rows.slice(offset,offset+f.pageSize).map(d=>({...draftSummary(d),status:'workspace-draft'}))
  return {items:items.map(d=>({...d,localTime:{created:searchLocalTime(d.createdAt),modified:searchLocalTime(d.contentUpdatedAt),deleted:searchLocalTime(d.remote?.deletedAt)}})),page:f.page,pageSize:f.pageSize,hasMore:offset+f.pageSize<rows.length,total:rows.length,unknownDateCount,filters:f,timeZone,dateNote:'localTime是上海时间。modified筛选和排序使用contentUpdatedAt（工作台内容修改时间）；updatedAt是记录状态更新时间，删除标记不算写作。contentTimeSource为legacy-record时仅沿用旧记录更新时间，不能证明是正文修改；content为已记录的内容时间，unknown为未知。历史缺失时间返回null，不推断创建或修改日期。unknownDateCount是符合其他条件但缺少所选日期字段的记录数，可能与其他查询重叠，不可相加。remote.deleted=true表示原文已删除，保留的是工作台副本；关联ID是历史快照，不能证明原文当前仍存在或已发布。同名且没有共同关联ID的草稿不能合并计数。'}
}
