import {invariant} from './settings.ts'
import {normalizeSearch,searchParameters} from './search.ts'

/**
 * 一个统计参数的模式。**故意写得宽松**：这里的对象字面量混了两类形状——
 * 手写的 `{type:'integer'}` 之类，以及从 `searchParameters` 摊开的 `filters`（带 `properties`）。
 * 类型只用来说明"我们怎么读它"（`enum` / `type`），不试图复刻每个分支的字面量。
 */
interface ReportParam {
  readonly type?: string
  readonly enum?: readonly string[]
  readonly description?: string
  readonly additionalProperties?: boolean
  readonly properties?: Readonly<Record<string, unknown>>
}
interface ReportTool {
  readonly name: string
  readonly label: string
  readonly report: string
  readonly description: string
  readonly parameters: Readonly<Record<string, ReportParam>>
}

const {page,pageSize,sortBy,order,...searchFilters}=searchParameters
const filters={type:'object',additionalProperties:false,description:'组合条件；默认仅已公开文章。category/tag 精确名称，categoryId/tagId 可消除同名歧义。',properties:{...searchFilters,
  status:{type:'string',enum:['all','published','draft'],description:'默认published（post/publish）；all包含保存稿，draft包含保存稿及非公开状态。'},
  categoryId:{type:'integer'},tagId:{type:'integer'},includeDescendants:{type:'boolean',description:'分类筛选是否包含全部子级，默认 false'},
  missing:{type:'string',enum:['category','tag','either','both'],description:'仅查询缺分类、缺标签、缺任一或两者皆缺的文章'},
  hasSavedDraft:{type:'boolean',description:'是否有未发布保存稿或待发布独立草稿'},
}}
const paging={page:{type:'integer',description:'从1开始，按返回的 hasMore 决定是否继续'},pageSize:{type:'integer',description:'每页1至500条，默认500；统计总数不受分页影响'}}
export const reportTools: readonly ReportTool[] =[
  {name:'blog_get_statistics',label:'统计博客概况',report:'overview',description:'统计文章、版本、公开状态、保存稿、缺分类/标签及评论审核状态。只返回程序计算的数字，不拉取标题。问有多少篇、待处理多少、博客概况时优先使用；articleCount按rootCid去重，versionCount仅计算匹配当前筛选的版本；计入的保存稿数量以totals.savedDraftVersions为准，缺失不能当作0。',parameters:{filters}},
  {name:'blog_taxonomy_statistics',label:'统计分类与标签',report:'taxonomy',description:'查询分类树或标签及文章分布。返回完整路径、父级、直接关联文章数、含子级去重数；不依赖Typecho缓存count。空分类/标签指当前筛选范围没有匹配文章；组间可能重叠，不能相加。',parameters:{kind:{type:'string',enum:['category','tag']},emptyOnly:{type:'boolean'},...paging,filters}},
  {name:'blog_group_articles',label:'按维度整理文章标题',report:'catalog',description:'一次整理按分类、标签、年月或不分组的精简标题目录，已计算每组文章数及全局去重总数。需要“按分类整理博客并列标题”时直接用它，不再遍历普通搜索页手工分组。默认公开文章、分类分组、每页500条分组关联；有hasMore才续页。',parameters:{groupBy:{type:'string',enum:['category','tag','month','year','none']},...paging,filters}},
  {name:'blog_activity_statistics',label:'统计写作时间分布',report:'timeline',description:'按上海时区日/月/年统计所选版本的时间分布。默认modified，只代表各版本最后修改时间，不是修改次数；created是文章设定时间，不代表首次发布。无记录的时间桶不返回；需要总数无需拉取文章。',parameters:{groupBy:{type:'string',enum:['day','month','year']},...paging,filters}},
  {name:'blog_query_article_titles',label:'查询精简文章与排行',report:'ranking',description:'查询最近修改、最早文章、评论最多/最少、缺分类标签或有待发布修改的文章。只返回标题、ID、时间与评论数；评论只统计原生comment，不含pingback/trackback。不提供没有可靠来源的阅读量排行榜。',parameters:{sortBy:{type:'string',enum:['modified','created','comments']},order:{type:'string',enum:['asc','desc']},...paging,filters}},
]
export function normalizeReport(report: string,input: Readonly<Record<string, any>>={},now=Date.now()){
  const definition=reportTools.find(tool=>tool.report===report)
  invariant(definition&&input&&typeof input==='object'&&!Array.isArray(input),'统计参数无效')
  invariant(Object.keys(input).every(key=>Object.hasOwn(definition.parameters,key)),'不支持的统计条件')
  const filter: Record<string, any> = input.filters??{}
  invariant(filter&&typeof filter==='object'&&!Array.isArray(filter)&&Object.keys(filter).every(key=>Object.hasOwn(filters.properties,key)),'统计筛选条件无效')
  const {categoryId,tagId,includeDescendants,missing,hasSavedDraft,...search}=filter
  const normalized=normalizeSearch({...search,status:search.status??'published'} as any,now)
  for(const [key,value] of Object.entries({categoryId,tagId}))if(value!==undefined)invariant(Number.isSafeInteger(value)&&(value as number)>0,`${key}无效`)
  invariant(!(categoryId&&normalized.filters.category)&&!(tagId&&normalized.filters.tag),'名称和 ID 只能选择一种筛选方式')
  for(const value of [includeDescendants,hasSavedDraft])invariant(value===undefined||typeof value==='boolean','统计布尔条件无效')
  invariant(!includeDescendants||categoryId||normalized.filters.category,'包含子级需要指定分类')
  invariant(missing===undefined||['category','tag','either','both'].includes(missing),'缺失信息筛选无效')
  const options: Record<string, unknown>={}
  for(const [key,param] of Object.entries(definition.parameters)){
    if(key==='filters')continue
    const value=input[key]
    if(value===undefined)continue
    if(param.enum)invariant(param.enum.includes(value),`${key}统计参数无效`)
    if(param.type==='boolean')invariant(typeof value==='boolean',`${key}统计参数无效`)
    if(param.type==='integer')invariant(Number.isSafeInteger(value)&&value>=1&&value<=(key==='pageSize'?500:10000),`${key}统计参数无效`)
    options[key]=value
  }
  const {page:_,sortBy:__,order:___,pageSize:____,...base}=normalized.filters
  return {report,...options,filters:{...base,...Object.fromEntries(Object.entries({categoryId,tagId,includeDescendants,missing,hasSavedDraft}).filter(([,v])=>v!==undefined))},start:normalized.start===null?null:normalized.start/1000,end:normalized.end===null?null:normalized.end/1000,timeZone:normalized.timeZone}
}
