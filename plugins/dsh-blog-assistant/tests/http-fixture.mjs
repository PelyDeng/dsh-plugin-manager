import { createServer } from 'node:http'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash,randomBytes } from 'node:crypto'
import { apply,Config } from '../dist/index.mjs'

export async function httpFixture(hostname='127.0.0.1'){
  const directory=await mkdtemp(join(tmpdir(),'dsh-blog-http-')),routes=new Map(),listeners=new Map(),effects=[],files=new Map(),revoked=new Set()
  const actors={alice:{namespace:'user',userId:'alice',sessionId:'session-a'},bob:{namespace:'user',userId:'bob',sessionId:'session-b'},eve:{namespace:'user',userId:'eve',sessionId:'session-e'}}
  const token=randomBytes(32).toString('hex'),configPath=join(directory,'config.json')
  await writeFile(configPath,JSON.stringify({schemaVersion:1,blog:{url:'https://example.invalid',username:'fixture',password:'fixture'},image:{url:'https://example.invalid',username:'fixture',password:'fixture',strategyId:2},backup:{token,url:'http://127.0.0.1:1',allowedUserIds:['alice']}}))
  const attachments={async saveFileStream({data,name}){const parts=[];for await(const p of data)parts.push(p);const b=Buffer.concat(parts),attachmentId=createHash('sha256').update(b).digest('hex');files.set(attachmentId,b);return{attachmentId,name,bytes:b.length}},async *readFileStream(ref){yield files.get(ref.attachmentId)}}
  const ctx={on(event,fn){const group=listeners.get(event)??new Set();group.add(fn);listeners.set(event,group);return()=>group.delete(fn)},emit(event,...args){for(const f of [...listeners.get(event)??[]])f(...args)},effect(fn){effects.push(fn())},get(name){return name==='attachments'?attachments:undefined},attachments,jobs:{attachController(){return()=>{}}},tools:{register(){return()=>{}}},webServer:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}}}
  ctx.root=ctx
  ctx.on('ecosystem/providers',accept=>accept({protocol:1,ready(){},resolve(req){return actors[req.headers.cookie]},assertAccess(actor,pluginId){if(pluginId!=='blog'||!Object.values(actors).some(a=>a.userId===actor.userId&&a.sessionId===actor.sessionId)||actor.userId==='eve'||revoked.has(actor.sessionId)){const error=new Error('没有授权');error.code='DSH_ACCESS_ERROR';error.status=403;throw error}}}))
  const server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(path==='/fixture-login'){res.writeHead(302,{'set-cookie':'alice','location':'/blog'});res.end();return}
    const route=routes.get(path);if(!route){res.writeHead(404);res.end();return}
    void Promise.resolve(route.handler(req,res)).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end()})
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://${hostname}:${server.address().port}`
  try{await apply(ctx,Config({runtimeConfig:configPath,dataPath:join(directory,'data'),publicOrigin:origin}))}
  catch(error){server.closeAllConnections();await new Promise(r=>server.close(r));for(const cleanup of effects.reverse())await cleanup?.();throw error}
  return{origin,ctx,actors,revoked,token,
    request(path,{actor='alice',method='GET',body,headers={}}={}){return fetch(origin+'/blog'+path,{method,redirect:'manual',headers:{origin,...actor?{cookie:actor}:{},...headers},...body===undefined?{}:{body}})},
    api(action,args={},actor='alice'){return this.request('/api',{method:'POST',actor,headers:{'content-type':'application/json'},body:JSON.stringify({action,args})})},
    async close(){server.closeAllConnections();await new Promise(r=>server.close(r));for(const cleanup of effects.reverse())await cleanup?.();await rm(directory,{recursive:true,force:true})},
  }
}
