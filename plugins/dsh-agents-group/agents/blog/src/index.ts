import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage,ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-attachment'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { agentResource } from '@dsh-agents-group/common'
import { registerPlugin,registerConversations,AccessError,type Access,type ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type { ProtectedRoute } from '@dsh-plugin-manager/plugin-kit/http'
import { loadSettings } from './settings.mjs'
import { BlogStore } from './store.mjs'
import { BlogClient,ImageClient,BackupClient } from './connectors.mjs'
import { BlogJobs } from './jobs.mjs'
import { BlogApplication } from './application.mjs'
import { BlogAttachments, MAX_ATTACHMENT_BYTES } from './attachments.mjs'
import { ChatStore } from './chat-store.mjs'
import { BlogChat } from './chat.mjs'
import { createBlogParticipant } from './participant.ts'
import type { AgentParticipant } from 'dsh-pirate-command/protocol'
import {selectBlogModel} from './models.mjs'
import {ReasoningTranslations,reasoningOriginal} from './reasoning-translation.ts'
import type { Config } from './config.ts'
export { Config } from './config.ts'
/** 同 closedoff 的约定：适配层需要类型名 `PluginConfig`。 */
export type { Config as PluginConfig } from './config.ts'
export const name='blog'

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
  /** 群组级配置文件的路径；存在时业务凭据从它的 `blog` 小节读取。 */
  readonly groupConfigPath?: string
}

function json(res:ServerResponse,data:unknown){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function body(req:IncomingMessage,max:number){const chunks:Buffer[]=[];let size=0;for await(const b of req){const chunk=Buffer.from(b);size+=chunk.length;if(size>max)throw new AccessError(413,'请求超过大小限制');chunks.push(chunk)}return Buffer.concat(chunks)}

/**
 * 子包资源定位。
 *
 * 源码被打进群组 dist 后，代码与资源的相对位置在开发与发布两种形态下不同；解析统一交给
 * common 的 `agentResource`，这里不写死 `../` 层数（写死了换布局会静默错位）。
 */
const blogResource = (relative: string): URL => agentResource(import.meta.url, 'blog', relative)

/**
 * 装载博客工作台，返回群组用于卸载的释放函数与本次注册的工具条目。
 *
 * `access` 与 `http` 由群组注入：一个 Agent 只应有一套鉴权实例。业务逻辑未作改动。
 */
export async function mount(mountContext:AgentMountContext):Promise<{
  dispose():Promise<void>
  tools:readonly ToolDescriptor[]
  participant:AgentParticipant
}>{
  const {ctx,access,http}=mountContext
  const config=mountContext.config
  // 不再在这里断言 accessMode：群组会为强制认证的 Agent 建 authenticated 的 access。
  // 若把群组配成 standalone，它会以「认证不可用」如实报错，而不是被误判成装载失败。
  const settings=loadSettings(config.runtimeConfig||process.env.BLOG_CONFIG_PATH||'')
  const root=config.dataPath||dshHomePath('plugins','blog')
  const store=new BlogStore(join(root,'blog.sqlite'))
  const blog=new BlogClient(settings.blog),images=new ImageClient(settings.image,join(root,'image-token.json')),backups=new BackupClient(settings.backup,access)
  const conversations=new ChatStore(store)
  const attachments=new BlogAttachments(ctx,access,store,(owner:string,id:string)=>conversations.assertScope(owner,id))
  const jobs=new BlogJobs(ctx,access,store,blog,attachments,config.turnTimeoutMs,settings.models,mountContext.category)
  const app=new BlogApplication(store,access,blog,images,backups,jobs,attachments)
  const {chatSdk}=await import(blogResource('runtime/chat-sdk.mjs').href)
  const chat=new BlogChat(ctx,access,store,conversations,attachments,jobs,app,chatSdk,config.turnTimeoutMs)
  // 显式创建参与者再注册：群组要把同一个实例桥接成管家的执行入口，
  // 而 registerBlogParticipant 只在内部创建、不交出来。
  const participant=createBlogParticipant({access,chat,index:conversations,store,routePrefix:config.routePrefix})
  ctx.effect(()=>ctx.on('pirate/participants',accept=>accept(participant),{global:true}))
  ctx.effect(()=>registerConversations(ctx,chat.provider))
  const translations=new ReasoningTranslations({ctx,pluginId:'blog',path:join(root,'reasoning-translations.sqlite'),access,selectModel:signal=>selectBlogModel(ctx,settings.models,false,signal),readOriginal:async(actor,target)=>reasoningOriginal(await chat.events(actor,target.conversationId),target.sourceId)})
  const manifest=JSON.parse(await readFile(blogResource('package.json'),'utf8'))
  ctx.effect(()=>registerPlugin(ctx,{id:'blog',packageName:manifest.name,version:manifest.version,displayName:'博客智能体',description:manifest.description,entryPath:config.routePrefix,permissions:['blog:access'],tools:jobs.chatTools}))
  for(const [suffix,file,mime] of [['','web/index.html','text/html'],['/app.js','dist/web/app.js','text/javascript'],['/style.css','web/style.css','text/css'],['/writing.css','web/writing.css','text/css'],['/chat-base.css','web/chat-base.css','text/css'],['/chat-theme.css','web/chat-theme.css','text/css'],...['chevron-down','copy','check','like','dislike','branch','database','clock','think','api','send','user','chat','stop'].map(name=>[`/media/icon-${name}.svg`,`web/media/icon-${name}.svg`,'image/svg+xml']),['/icons.svg','web/icons.svg','image/svg+xml']] as const){
    // `file` 已是相对子包根的路径（web/... 或 dist/web/...），直接相对 agentRoot 解析。
    const content=(await readFile(blogResource(file),'utf8')).replaceAll('__BASE__',config.routePrefix)
    ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+suffix,surface:suffix?'asset':'page',handler(req,res){if(req.method!=='GET')throw new AccessError(405,'只支持 GET');res.writeHead(200,{'content-type':`${mime}; charset=utf-8`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"});res.end(content)}}))
  }
  // 存活与就绪探针由群组统一提供（/agents/health、/agents/ready 与 /agents/blog/ready），
  // 这里不再注册：容器级探针是群组的职责，重复一份还会因前缀来源不同而冲突。
  // `/backup-authorize` 不是探针而是业务端点（systemd 执行器用它换授权），所以保留。
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/backup-authorize',handler:async(req,res)=>{
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
      case 'chat-create':result=chat.create(actor,args.requestId);break
      case 'chat-list':result=chat.list(actor,args.offset??0,args.query??'');break
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
    const file=await chat.original(actor,query.get('conversationId'),query.get('requestId'),query.get('id'));access.assert(actor)
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
    const record=attachments.get(actor,query.get('draftId'),query.get('id'))
    const inline=query.get('inline')==='1'&&record.status==='ready'&&record.image&&['image/png','image/jpeg','image/webp','image/gif'].includes(record.kind)
    res.writeHead(200,{'content-type':inline?record.kind:'application/octet-stream','content-disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(file.bytes)
  }}))

  return {
    // 群组据此算「本分类 + 通用」的工具可见性限制，所以如实返回全部已注册工具。
    tools: jobs.chatTools,
    // 参与者交给群组桥接成管家的执行入口。
    participant,
    dispose: async () => {
      // 释放顺序与创建相反，与迁移前保持一致。
      await translations.close(); await chat.close(); await jobs.close(); await attachments.close(); store.close()
    },
  }
}
