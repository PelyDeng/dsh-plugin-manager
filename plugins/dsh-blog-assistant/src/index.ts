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
import { createAccess,createPluginHttp,registerPlugin,AccessError } from '@dsh-plugin-manager/plugin-kit'
import { loadSettings } from './settings.mjs'
import { BlogStore } from './store.mjs'
import { BlogClient,ImageClient,BackupClient } from './connectors.mjs'
import { BlogJobs } from './jobs.mjs'
import { BlogApplication } from './application.mjs'
import { BlogAttachments, MAX_ATTACHMENT_BYTES } from './attachments.mjs'
import { ChatStore } from './chat-store.mjs'
import { BlogChat } from './chat.mjs'
import {selectBlogModel} from './models.mjs'
import {ReasoningTranslations,reasoningOriginal} from './reasoning-translation.ts'
import type { Config } from './config.ts'
export { Config } from './config.ts'
export const name='blog'
export const inject=['agents','agentDefaultModel','webServer','systemPrompt','tools','attachments','jobs','llm','sessions','sessionPersistence','messageFeedback'] as const

function json(res:ServerResponse,data:unknown){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function body(req:IncomingMessage,max:number){const chunks:Buffer[]=[];let size=0;for await(const b of req){const chunk=Buffer.from(b);size+=chunk.length;if(size>max)throw new AccessError(413,'请求超过大小限制');chunks.push(chunk)}return Buffer.concat(chunks)}
export async function apply(ctx:Context,config:Config){
  if(config.accessMode!=='authenticated')throw new Error('博客工作台必须接入 auth')
  const settings=loadSettings(config.runtimeConfig||process.env.BLOG_CONFIG_PATH||'')
  const root=config.dataPath||dshHomePath('plugins','blog')
  const access=createAccess(ctx,{pluginId:'blog',mode:'authenticated',publicOrigin:config.publicOrigin})
  const http=createPluginHttp(ctx,{access,routePrefix:config.routePrefix})
  const store=new BlogStore(join(root,'blog.sqlite'))
  const blog=new BlogClient(settings.blog),images=new ImageClient(settings.image,join(root,'image-token.json')),backups=new BackupClient(settings.backup,access)
  const conversations=new ChatStore(store)
  const attachments=new BlogAttachments(ctx,access,store,(owner:string,id:string)=>conversations.assertScope(owner,id))
  const jobs=new BlogJobs(ctx,access,store,blog,attachments,config.turnTimeoutMs,settings.models)
  const app=new BlogApplication(store,access,blog,images,backups,jobs,attachments)
  const {chatSdk}=await import(new URL('../runtime/chat-sdk.mjs',import.meta.url).href)
  const chat=new BlogChat(ctx,access,store,conversations,attachments,jobs,app,chatSdk,config.turnTimeoutMs)
  const translations=new ReasoningTranslations({ctx,pluginId:'blog',path:join(root,'reasoning-translations.sqlite'),access,selectModel:signal=>selectBlogModel(ctx,settings.models,false,signal),readOriginal:async(actor,target)=>reasoningOriginal(await chat.events(actor,target.conversationId),target.sourceId)})
  ctx.effect(()=>async()=>{await translations.close();await chat.close();await jobs.close();await attachments.close();store.close()})
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
  ctx.effect(()=>registerPlugin(ctx,{id:'blog',packageName:manifest.name,version:manifest.version,displayName:'博客智能体',description:manifest.description,entryPath:config.routePrefix,permissions:['blog:access'],tools:jobs.chatTools}))
  for(const [suffix,file,mime] of [['','web/index.html','text/html'],['/app.js','dist/web/app.js','text/javascript'],['/style.css','web/style.css','text/css'],['/writing.css','web/writing.css','text/css'],['/chat-base.css','web/chat-base.css','text/css'],['/chat-theme.css','web/chat-theme.css','text/css'],...['copy','check','like','dislike','branch','database','clock','think','api','send','user','chat','stop'].map(name=>[`/media/icon-${name}.svg`,`web/media/icon-${name}.svg`,'image/svg+xml']),['/icons.svg','web/icons.svg','image/svg+xml']] as const){
    const content=(await readFile(new URL(`../${file}`,import.meta.url),'utf8')).replaceAll('__BASE__',config.routePrefix)
    ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+suffix,surface:suffix?'asset':'page',handler(req,res){if(req.method!=='GET')throw new AccessError(405,'只支持 GET');res.writeHead(200,{'content-type':`${mime}; charset=utf-8`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"});res.end(content)}}))
  }
  ctx.effect(()=>http.registerPublic({kind:'exact',path:config.routePrefix+'/ready',handler(_req,res){try{access.ready();json(res,{ok:true})}catch{res.writeHead(503);res.end()}}}))
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
      case 'chat-create':result=chat.create(actor,args.requestId);break
      case 'chat-list':result=chat.list(actor,args.offset??0);break
      case 'chat-history':result=await chat.history(actor,args.conversationId);break
      case 'chat-send':result=await chat.send(actor,args);break
      case 'chat-stop':result=await chat.stop(actor,args.conversationId);break
      case 'chat-fork':result=await chat.fork(actor,args);break
      case 'chat-feedback':result=await chat.feedback(actor,args.conversationId,args.operation,args);break
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
}
