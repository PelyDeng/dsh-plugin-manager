import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage,ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-attachment'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { agentResource } from '@dsh-agents-group/common'
import { registerPlugin,registerConversations,AccessError,isAccessError,type Access,type ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type { ProtectedRoute } from '@dsh-plugin-manager/plugin-kit/http'
import { loadSettings } from './settings.mjs'
import { BlogApplication, PendingOperationsMirror } from './application.mjs'
import { BlogClient,ImageClient,BackupClient } from './connectors.mjs'
import { BlogJobs } from './jobs.mjs'
import { BlogAttachments, MAX_ATTACHMENT_BYTES } from './attachments.mjs'
import { ChatStore } from './chat-store.ts'
import { BlogChat } from './chat.ts'
import { createBlogParticipant } from './participant.ts'
import type { AgentParticipant } from '../../../packages/common/src/participant.ts'
import {selectBlogModel} from './models.mjs'
import {ReasoningTranslations,reasoningOriginal} from './reasoning-translation.ts'
// DSN 来源解析用**运行时那一份**：blog 的 `storage/dsn.mjs` 文件头自述"复制管家 butler-console
// 的 dsn.ts 模式"，而 P4 已把它迁进运行时（`packages/runtime/src/storage/dsn.ts`）。两处各留一份
// 的代价是**语义会漂移**，而这一段的判据恰恰是最容易漂的地方：缺文件算"没配置"（不是错误）、
// 非法 JSON 要如实抛、**绝不静默回退 SQLite**。副本已删。
import { resolveStorageDsn } from '../../../packages/runtime/src/storage/dsn.ts'
// 会话 / 轮次 / 结果三张表走运行时端口：门面把「本地同步围栏面」与「PG 异步面」组合起来，
// 启动顺序（排空 outbox → PG 清理 → 按 PG 收敛镜像）也在它里面，blog 只调 `open()`。
import { createAgentDatabase } from '../../../packages/runtime/src/storage/index.ts'
import type { AgentDatabasePort } from '../../../packages/runtime/src/storage/ports.ts'
import { StorageError, isStorageError } from './storage/errors.mjs'
import { BlogPgStorage } from './storage/pg.mjs'
import type { Config } from './config.ts'
export { Config } from './config.ts'
/** 同 closedoff 的约定：适配层需要类型名 `PluginConfig`。 */
export type { Config as PluginConfig } from './config.ts'
export const name='blog'

/** 存储层故障到 HTTP 的映射（对齐管家 butler-console 的 §3 错误分类层）。 */
const STORAGE_STATUS: Record<string,{status:number,message?:string}> = {
  storage_unreachable: { status: 503 },
  storage_auth: { status: 503 },
  storage_schema_missing: { status: 503 },
  storage_schema_version: { status: 503 },
  storage_unconfigured: { status: 503 },
  storage_timeout: { status: 503 },
  storage_closed: { status: 503 },
  storage_transaction: { status: 503 },
  storage_constraint: { status: 409 },
  storage_unknown: { status: 500, message: '服务处理请求失败' },
}

/**
 * blog 路由的 HTTP 错误渲染（群组经 `onError` 注入 createPluginHttp）。
 *
 * 存储层故障按稳定码归类：可用性类 503、约束冲突 409、未知 500，稳定码进响应体；
 * 其余错误保持 kit 默认渲染（AccessError 原状态、未知 500），对外契约不变。
 *
 * ⚠️ **存储故障用结构识别（`isStorageError`），不是 `instanceof`**：本边界要处理的错误
 * **来自两侧** —— 未配置占位抛的是 `./storage/errors.mjs` 那一份类，而配好之后索引侧的故障
 * 全部由 **运行时那一份**（`packages/runtime/src/storage/errors.ts`）抛出。`instanceof` 认不出
 * 对方 ⇒ 本该 **503 + 稳定码** 的故障掉进"未知错误"分支变成 **500「请求处理失败」**，
 * 而 runbook 第 5 步恰恰要求运维"任一 503 都要看它的稳定码"（`storage_schema_missing` /
 * `storage_schema_version` / `storage_unreachable`）—— 降级成 500 等于把那条诊断路径**整条抹掉**。
 */
export function blogStorageErrorHandler(response: ServerResponse, error: unknown): void {
  const storage = isStorageError(error)
  const known = isAccessError(error)
  if (!storage && !known) {
    console.error('agents-group/blog: 请求处理失败', error)
    response.writeHead(500, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
    response.end(JSON.stringify({error:'请求处理失败'}))
    return
  }
  if (!storage) {
    response.writeHead((error as {status:number}).status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
    response.end(JSON.stringify({error:(error as Error).message}))
    return
  }
  const code = (error as {code:string}).code
  const mapped = STORAGE_STATUS[code] ?? STORAGE_STATUS.storage_unknown!
  if (mapped.status >= 500) console.error('agents-group/blog: 存储请求失败', error)
  response.writeHead(mapped.status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
  response.end(JSON.stringify({error:mapped.message ?? (error as Error).message,code}))
}

/** 未配置连接时占位的业务存储：任何读写都以 `storage_unconfigured` 拒绝（blog 未就绪，Q4）。 */
function unconfiguredBusinessStorage(hint: string): BlogPgStorage {
  const reject = () => { throw new StorageError('storage_unconfigured', `博客业务存储未就绪：${hint}`) }
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined // 不当 thenable 被 await 意外消费
      return reject
    },
  }) as unknown as BlogPgStorage
}

/**
 * 未配置连接时占位的**索引端口**（`dsh_conversations` / `dsh_turns` / `dsh_turn_results`）。
 *
 * 与 `unconfiguredBusinessStorage` 同一套口径，但多一层：索引面是"门面 → conversations / turns"
 * 两层结构，所以两层都要拒绝，否则 `index.conversations.list(...)` 会先拿到 `undefined` 再炸在
 * 别处（错误码就丢了，页面拿到的是 500 而不是 503 + 稳定码）。
 *
 * ⚠️ **同步面**（`record` / `mark` / `fenceOf`）在这里抛的也必须是 `StorageError`：它们由 kit 的
 * 移除围栏在**同步**上下文里调用，抛出别的类型就是一次未归类的 500。`titleSink` 返回 `undefined`
 * （标题投递口是可选成员，未就绪时没有队列——投递被静默丢弃好过把它塞进一个假队列）。
 */
function unconfiguredIndex(): AgentDatabasePort {
  const reject = () => {
    throw new StorageError('storage_unconfigured',
      '博客索引存储未就绪：需要在私有配置里提供 PostgreSQL 连接（环境变量 AGENTS_GROUP_PG_DSN 或 storage.json）；不会回退 SQLite。')
  }
  const nested = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === 'agentId') return 'blog'
      return reject
    },
  })
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === 'conversations' || property === 'turns') return nested
      if (property === 'titleSink') return undefined
      if (property === 'close') return async () => {}
      return reject
    },
  }) as unknown as AgentDatabasePort
}

/**
 * 本子包需要宿主提供的服务。
 *
 * 列出它是为了让「这个 Agent 依赖哪些宿主能力」保持可读；群组在装载前统一等待这些服务。
 * `attachments`、`jobs`、`sessions` 也在其中，缺任何一个都会让装载失败。
 */
export const inject=['agents','agentDefaultModel','webServer','systemPrompt','tools','attachments','jobs','llm','sessions','sessionPersistence','messageFeedback'] as const

/** 本子包只用到 Actor 的这两个字段（备份授权端点用）。 */
interface ActorLike { readonly userId?:string; readonly sessionId?:string }

/** 群组注入给子包的东西。只依赖这个最小接口，不依赖群组内部实现。 */
export interface AgentMountContext {
  readonly ctx: Context
  /** 已绑定本 Agent 的 pluginId 与授权范围的访问校验器。 */
  readonly access: Access
  /**
   * 只允许注册本 Agent 前缀下路由的 HTTP 注册器。
   *
   * 直接复用 kit 的 `ProtectedRoute`：路由契约不该在各子包里各写一份，写偏了会在
   * 类型层看不出来、运行时才以「actor 缺字段」的形式炸掉。
   */
  readonly http: {
    register(route: ProtectedRoute): () => void
    /**
     * 注册**显式公开**的路由（不走登录 cookie 的那一类）。
     *
     * 群组给的就是 kit 的 `createPluginHttp` 那个对象，它本来就带这个方法（群组自己的
     * `/agents/health`、`/agents/ready` 也走它，见 `src/index.ts:231/240/264`），此前这里的接口
     * 只是写得比实际窄。宽度不够的代价是实打实的：备份执行器是 systemd 拉起的进程，**没有 cookie
     * 也不带 Origin**，走 `register` 会在进入处理器之前就被 `access.resolve` 挡成 401
     * （`packages/plugin-kit/src/http.ts:42`、`access.ts:236`）——它的凭据是下面那条
     * `Authorization: Bearer <备份 token>`，只能由处理器自己核验。
     */
    registerPublic(route: WebRoute): () => void
  }
  /** 群组解析后的完整配置。 */
  readonly config: Config
  /**
   * 本 Agent 的工具分类标签，由群组从清单注入。
   *
   * 子包注册工具时原样使用，**不要自己写字符串**：两处各写一份会漂移，而漂移的后果是
   * 本 Agent 的工具全部对其不可见，且这种失效在界面上完全看不出来。
   */
  readonly category: string
  /** 本 Agent 能用的工具名（本分类 + 通用集）。惰性取值，理由同 category。 */
  readonly allowedTools: () => readonly string[]
  /** 群组级配置文件的路径；存在时业务凭据从它的 `blog` 小节读取。 */
  readonly groupConfigPath?: string
}

/**
 * 统一的 JSON 响应写法。
 *
 * ⚠️ 响应体是 thenable ⇒ **当场抛**，绝不 `JSON.stringify` 它：`JSON.stringify(Promise)` 得到的是
 * `'{}'`，而 HTTP 状态仍是 **200**，于是页面上看到的是"空结果"而不是错误（侧栏显示"没有会话"、
 * 操作"点了没反应"），日志里也一行都没有。这正是 `/api` 的 `chat-list` 那一支漏 `await` 时的
 * 实际表现（响应体 `{}`、状态 200）。
 *
 * 抛出的错误走群组注入的 `onError`：`blogStorageErrorHandler` 对非存储 / 非访问错误落
 * **500 + 一条 error 日志**，所以这一道把"静默的空响应"变成了"响亮的 500"。
 */
function json(res:ServerResponse,data:unknown){
  if(data!==null&&typeof data==='object'&&typeof (data as {then?:unknown}).then==='function')throw new Error('响应体是 Promise：路由处理器漏了 await')
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))
}
async function body(req:IncomingMessage,max:number){const chunks:Buffer[]=[];let size=0;for await(const b of req){const chunk=Buffer.from(b);size+=chunk.length;if(size>max)throw new AccessError(413,'请求超过大小限制');chunks.push(chunk)}return Buffer.concat(chunks)}

/**
 * 子包资源定位。
 *
 * 源码被打进群组 dist 后，代码与资源的相对位置在开发与发布两种形态下不同；解析统一交给
 * common 的 `agentResource`，这里不写死 `../` 层数（写死了换布局会静默错位）。
 */
const blogResource = (relative: string): URL => agentResource(import.meta.url, 'blog', relative)

/**
 * 装载博客工作台，返回群组用于卸载的释放函数、本次注册的工具条目、协作参与者与就绪探针。
 *
 * `access` 与 `http` 由群组注入：一个 Agent 只应有一套鉴权实例。
 *
 * 业务存储只有 PostgreSQL 一种（Q4 口径）：缺配置或 init 失败都算 **blog 未就绪**——
 * 装载继续（页面、目录条目、参与者照常注册，探针 503），业务读写一律以稳定码拒绝，
 * 绝不静默回退 SQLite，也不把失败抛给群组拖累其他 Agent。`health` 供群组的
 * per-agent 就绪探针在运行期核实 PG 此刻可达。
 */
export async function mount(mountContext:AgentMountContext):Promise<{
  dispose():Promise<void>
  tools:readonly ToolDescriptor[]
  participant:AgentParticipant
  health():Promise<{ok:boolean;error?:string}>
}>{
  const {ctx,access,http}=mountContext
  const config=mountContext.config
  // 不再在这里断言 accessMode：群组会为强制认证的 Agent 建 authenticated 的 access。
  // 若把群组配成 standalone，它会以「认证不可用」如实报错，而不是被误判成装载失败。
  const settings=loadSettings(config.runtimeConfig||process.env.BLOG_CONFIG_PATH||'')
  const root=config.dataPath||dshHomePath('plugins','blog')
  // ---- 业务存储（PG；Q4：无配置=blog 未就绪而非抛群组） ----
  const dsnSource=await resolveStorageDsn(process.env,dshHomePath('plugins','agents-group','storage.json'),(path:string)=>readFile(path,'utf8'))
  const unconfiguredHint='设置环境变量 AGENTS_GROUP_PG_DSN，或在私有配置文件（环境变量 AGENTS_GROUP_PG_CONFIG 指定路径，缺省 <DSH 主目录>/plugins/agents-group/storage.json）里写 {"dsn":"postgres://…"}。不会回退其他存储后端。'
  const storage=dsnSource?new BlogPgStorage(dsnSource.dsn):unconfiguredBusinessStorage(`缺少 PostgreSQL 存储配置。${unconfiguredHint}`)
  if(dsnSource){
    try{await storage.init()}
    catch(error){
      // init 失败同样是 blog 未就绪：探针与业务端点都会如实反映，群组照常装载。
      console.warn(`agents-group/blog: 业务存储未就绪（${error instanceof Error?error.message:String(error)}）`)
    }
  }
  const health=async():Promise<{ok:boolean;error?:string}>=>{
    if(!dsnSource)return{ok:false,error:`博客业务存储未配置。${unconfiguredHint}`}
    try{await storage.readyProbe();return{ok:true}}
    catch(error){
      const code=error instanceof StorageError?error.code:'storage_unknown'
      return{ok:false,error:`博客业务存储不可用（${code}）：${error instanceof Error?error.message:String(error)}`}
    }
  }
  // ---- 索引库切 PG：会话 / 轮次 / 结果三张表走运行时端口，本地 SQLite 降级为镜像 + outbox ----
  //
  // ⚠️ **本地 SQLite 没有消失**，它换了角色：`blog.sqlite` 现在是运行时门面的"会话行镜像 +
  // 同步围栏标记 + 持久 outbox"（`LocalFenceStore`）。它保证 `record` / `mark` / `syncTitle`
  // 这三个**同步契约**仍能同步回答（kit 的移除围栏与官方标题回调不能 await）。
  //
  // ⚠️ 未配置 PG 时**照常装载**（页面、目录条目、参与者都注册），索引侧的任何读写都以
  // `storage_unconfigured` 拒绝并映射成 503——**绝不回退 SQLite**。所以这里不抛给群组。
  const pending=new PendingOperationsMirror()
  if(dsnSource)await pending.restore(storage).catch(error=>console.warn('agents-group/blog: 恢复待核对操作镜像失败',error))
  const index=dsnSource?createAgentDatabase({dsn:dsnSource.dsn,agentId:'blog',localPath:join(root,'blog.sqlite')}):undefined
  if(index){
    try{await index.open()}
    catch(error){
      // 与业务存储同一条口径：结构核验 / 启动收敛失败 = blog 未就绪，索引读写按存储错误码拒绝。
      console.warn(`agents-group/blog: 索引存储未就绪（${error instanceof Error?error.message:String(error)}）`)
    }
  }
  const conversations=new ChatStore(index??unconfiguredIndex(),()=>pending.ids())
  const blog=new BlogClient(settings.blog),images=new ImageClient(settings.image,join(root,'image-token.json')),backups=new BackupClient(settings.backup,access)
  // ⚠️ 这个谓词在 `BlogAttachments` 里一律被 `await`（见其 `get` / `list` / `guard`）。
  // 会话路径走索引侧的**同步**核验（`assertScope` 直接返回记录），草稿路径走存储的异步查询
  // ⇒ 两条分支的返回类型不同，转 TS 时被暴露出来。统一成 `async` 让类型自洽：调用方本来就
  // `await` 异步分支，行为不变（同步分支也只是多一个微任务）。
  const attachments=new BlogAttachments(ctx,access,storage,async(owner:string,id:string)=>id.startsWith('blog-chat-')?conversations.assertScope(owner,id):storage.get(owner,id))
  const jobs=new BlogJobs(ctx,access,storage,blog,attachments,config.turnTimeoutMs,settings.models,mountContext.category,mountContext.allowedTools)
  const app=new BlogApplication(storage,access,blog,images,backups,jobs,attachments,pending)
  const {chatSdk}=await import(blogResource('runtime/chat-sdk.mjs').href)
  const chat=new BlogChat(ctx,access,storage,conversations,attachments,jobs,app,chatSdk,config.turnTimeoutMs)
  // 群组直接把这个实例桥接成牛马大总管的执行入口，不再经过额外的发现事件。
  const participant=createBlogParticipant({access,chat,index:conversations,storage,app,routePrefix:config.routePrefix})
  ctx.effect(()=>registerConversations(ctx,chat.provider))
  const translations=new ReasoningTranslations({ctx,pluginId:'blog',storage,access,selectModel:signal=>selectBlogModel(ctx,settings.models,false,signal),readOriginal:async(actor,target)=>reasoningOriginal(await chat.events(actor,target.conversationId),target.sourceId)})
  const manifest=JSON.parse(await readFile(blogResource('package.json'),'utf8'))
  ctx.effect(()=>registerPlugin(ctx,{id:'blog',packageName:manifest.name,version:manifest.version,displayName:'博客智能体',description:manifest.description,entryPath:config.routePrefix,permissions:['blog:access'],category:'agents',tools:jobs.chatTools}))
  for(const [suffix,file,mime] of [['','web/index.html','text/html'],['/app.js','dist/web/app.js','text/javascript'],['/style.css','web/style.css','text/css'],['/writing.css','web/writing.css','text/css'],['/chat-base.css','web/chat-base.css','text/css'],['/chat-theme.css','web/chat-theme.css','text/css'],...['chevron-down','copy','check','like','dislike','branch','database','clock','think','api','send','user','chat','stop'].map(name=>[`/media/icon-${name}.svg`,`web/media/icon-${name}.svg`,'image/svg+xml']),['/icons.svg','web/icons.svg','image/svg+xml']] as const){
    // `file` 已是相对子包根的路径（web/... 或 dist/web/...），直接相对 agentRoot 解析。
    const content=(await readFile(blogResource(file),'utf8')).replaceAll('__BASE__',config.routePrefix)
    ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+suffix,surface:suffix?'asset':'page',handler(req,res){if(req.method!=='GET')throw new AccessError(405,'只支持 GET');res.writeHead(200,{'content-type':`${mime}; charset=utf-8`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"});res.end(content)}}))
  }
  // 存活与就绪探针由群组统一提供（/agents/health、/agents/ready 与 /agents/blog/ready），
  // 这里不再注册：容器级探针是群组的职责，重复一份还会因前缀来源不同而冲突。
  // `/backup-authorize` 不是探针而是业务端点（systemd 执行器用它换授权），所以保留。
  // ⚠️ 必须走 `registerPublic`：调用它的是**没有登录 cookie、也没有 Origin 头**的执行器进程，
  // 走受保护注册会在进入处理器之前就被挡成 401（或 Origin 校验的 403），而处理器里那条
  // `Bearer <备份 token>` 的定长比较才是它真正的凭据。端点自身仍然只认 POST + 正确 token。
  ctx.effect(()=>http.registerPublic({kind:'exact',path:config.routePrefix+'/backup-authorize',handler:async(req,res)=>{
    const expected=settings.backup.token?`Bearer ${settings.backup.token}`:''
    const supplied=req.headers.authorization??''
    if(req.method!=='POST'||!expected||!timingSafeEqual(createHash('sha256').update(expected).digest(),createHash('sha256').update(supplied).digest())){res.writeHead(403);res.end();return}
    try{const input=JSON.parse((await body(req,4096)).toString('utf8'));backups.assert({namespace:'user',userId:input.actor?.userId,sessionId:input.actor?.sessionId});json(res,{ok:true})}catch{res.writeHead(403);res.end()}
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/identity',handler(_req,res,actor){json(res,{userId:actor.userId,version:manifest.version,backupAdmin:settings.backup.allowedUserIds.includes(actor.userId),maxImageBytes:settings.image.maxBytes,blogUrl:settings.blog.url})}}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/reasoning-translation',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    if(!req.headers['content-type']?.startsWith('application/json'))throw new AccessError(415,'需要 JSON 请求')
    let input
    try{input=JSON.parse((await body(req,8192)).toString('utf8'))}catch(e){if(e instanceof AccessError)throw e;throw new AccessError(400,'无效 JSON')}
    if(!input||typeof input.conversationId!=='string'||typeof input.sourceId!=='string')throw new AccessError(400,'思考定位无效')
    const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel)
    try{const value=await translations.translate(actor,input,controller.signal);access.assert(actor);if(!res.destroyed)json(res,value)}finally{res.off('close',cancel)}
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/api',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    if(!req.headers['content-type']?.startsWith('application/json'))throw new AccessError(415,'需要 JSON 请求')
    let input
    try{input=JSON.parse((await body(req,3*1024*1024)).toString('utf8'))}catch(e){if(e instanceof AccessError)throw e;throw new AccessError(400,'无效 JSON')}
    if(!input||typeof input.action!=='string'||!input.args||typeof input.args!=='object'||Array.isArray(input.args))throw new AccessError(400,'请求格式无效')
    const args=input.args
    let result
    switch(input.action){
      case 'chat-create':result=await chat.create(actor,args.requestId);break
      // ⚠️ `list` 在 P7 ③-A 步骤 3 跟着 `chat-store.ts` 一起变成 async（三表全走运行时端口），
      // 这里的 `await` 是那次转换漏掉的一处。少了它响应体是 `Promise` 序列化出来的 `{}`
      // （HTTP 仍然 200）：侧栏拿到空对象、`items` 是 undefined，看起来像"没有会话"而不是报错。
      // 其余分支本来就已经 await，所以这是补齐，不是语义变更。
      case 'chat-list':result=await chat.list(actor,args.offset??0,args.query??'');break
      case 'chat-models':result=await chat.models(actor,args.conversationId);break
      case 'chat-update':result=await chat.mutate(actor,args);break
      case 'chat-history':result=await chat.history(actor,args.conversationId);break
      case 'chat-send':result=await chat.send(actor,args);break
      case 'chat-image-capability':result=await chat.imageCapability(actor,args.conversationId,args.modelSelection);break
      case 'chat-stop':result=await chat.stop(actor,args.conversationId);break
      case 'chat-fork':result=await chat.fork(actor,args);break
      case 'chat-feedback':result=await chat.feedback(actor,args.conversationId,args.operation,args);break
      case 'chat-operation':result=await chat.operationAction(actor,args);break
      default:result=await app.call(actor,input.action,args)
    }
    json(res,result)
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/chat-events',handler:async(req,res,actor)=>{
    if(req.method!=='GET')throw new AccessError(405,'只支持 GET')
    const id=new URL(req.url!,'http://localhost').searchParams.get('conversationId')!
    // Validate ownership before opening an authenticated stream.
    await chat.history(actor,id);access.assert(actor)
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'});res.flushHeaders()
    let closed=false
    const send=(value:unknown)=>{if(closed)return;if(!res.write(`data: ${JSON.stringify(value)}\n\n`))res.destroy()}
    const unsubscribe=chat.subscribe(actor,id,send,()=>res.end())
    res.once('close',()=>{closed=true;unsubscribe()})
    try{send({type:'snapshot',value:await chat.history(actor,id)})}catch{res.end()}
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/chat-attachment',handler:async(req,res,actor)=>{
    if(req.method!=='GET')throw new AccessError(405,'只支持 GET')
    const query=new URL(req.url!,'http://localhost').searchParams
    const file=await chat.original(actor,query.get('conversationId')!,query.get('requestId')!,query.get('id')!);access.assert(actor)
    res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(file.bytes)
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/upload',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    json(res,await app.upload(actor,await body(req,settings.image.maxBytes)))
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/attachment',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    const query=new URL(req.url!,'http://localhost').searchParams
    const result=await attachments.upload(actor,query.get('draftId'),query.get('name'),async(signal:AbortSignal)=>{
      const cancel=()=>req.destroy();signal.addEventListener('abort',cancel,{once:true})
      try{return await body(req,MAX_ATTACHMENT_BYTES)}finally{signal.removeEventListener('abort',cancel)}
    });access.assert(actor);json(res,result)
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/attachment-download',handler:async(req,res,actor)=>{
    if(req.method!=='GET')throw new AccessError(405,'只支持 GET')
    const query=new URL(req.url!,'http://localhost').searchParams
    const file=await attachments.original(actor,query.get('draftId'),query.get('id'));access.assert(actor)
    const record=await attachments.get(actor,query.get('draftId'),query.get('id'))
    const inline=query.get('inline')==='1'&&record.status==='ready'&&record.image&&['image/png','image/jpeg','image/webp','image/gif'].includes(record.kind)
    res.writeHead(200,{'content-type':inline?record.kind:'application/octet-stream','content-disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(file.bytes)
  }}))

  return {
    // 群组据此算「本分类 + 通用」的工具可见性限制，所以如实返回全部已注册工具。
    tools: jobs.chatTools,
    // 参与者交给群组桥接成牛马大总管的执行入口。
    participant,
    // Q4 口径的就绪探针：群组的 healthPath 与 /ready 汇总据此如实反映 blog 状态。
    health,
    dispose: async () => {
      // 释放顺序与创建相反，与迁移前保持一致；业务存储与索引库句柄都纳入释放链
      // （索引库拆库后独立开库，句柄泄漏会以 database is locked 或目录占用暴露）。
      await translations.close(); await chat.close(); await jobs.close(); await attachments.close()
      // 索引门面的 `close()` 会**先排空 outbox 再关连接**（顺序反了，刚标记的删除与刚投递的标题
      // 会留在本地队列里，用户看到的是"删了还在、标题没变"），所以必须 await 到它返回。
      if(index)try{await index.close()}catch{/* PG 池与本地句柄已在 close 内部各自收尾 */}
      try{await storage.close()}catch{/* 未配置占位没有可关闭的池 */}
    },
  }
}
