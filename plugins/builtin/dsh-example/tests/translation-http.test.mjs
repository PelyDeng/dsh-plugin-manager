import {afterEach,expect,test} from 'vitest'
import {fixture} from './fixture.mjs'
const fixtures=[]
afterEach(async()=>{for(const f of fixtures.splice(0))await f.close()})
test('译文接口只读取当前用户拥有的精确原文，缓存仍校验权限且不写对话',async()=>{
 const logs=new Map(),f=await fixture({logs});fixtures.push(f)
 let calls=0,request
 f.ctx.llm={resolveModelInfo:async()=>({reasoning:{efforts:[{id:'off'}]}}),async *stream(options){calls++;request=options;yield{type:'text-delta',index:0,text:'先检查今天的日期，再读取近期文章并核实来源。'};yield{type:'usage',usage:{inputTokens:25,outputTokens:20,totalTokens:45}};yield{type:'finish',reason:{kind:'stop'}}}}
 const response=await f.request('/chat',{message:'查询文章'}),h=f.handles[0]
 f.emit(h,'assistant/message',{message:{id:'reasoning-a',content:[{type:'reasoning',text:'First check the current date, then read recent articles and verify all sources.'},{type:'text',text:'开始查询'}]}})
 f.emit(h,'assistant/message',{message:{id:'answer-b',content:[{type:'text',text:'结果正文'}]}})
 f.emit(h,'turn/end',{reason:{kind:'completed'}});await response.text()
 const target={conversationId:h.id,sourceId:'reasoning-a'},before=JSON.stringify(logs.get(h.id))
 expect((await f.request('/reasoning-translation',target,'')).status).toBe(401)
 expect((await f.request('/reasoning-translation',target,'bob')).status).toBe(404)
 expect((await f.request('/reasoning-translation',target,'alice',{origin:'https://foreign.invalid'})).status).toBe(403)
 expect((await f.request('/reasoning-translation',undefined)).status).toBe(405)
 expect((await f.request('/reasoning-translation',{...target,sourceId:'answer-b'})).status).toBe(404)
 expect(calls).toBe(0)
 const history=await(await f.request('/history?id='+h.id)).json()
 expect(history.messages.at(-1).reasoningSource).toBe('reasoning-a')
 const first=await f.request('/reasoning-translation',target);expect(first.status).toBe(200)
 const result=await first.json();expect(result.status).toBe('translated');expect(result.usage.totalTokens).toBe(45)
 expect(request.tools).toEqual([]);expect(request.reasoningEffort).toBe('off')
 expect((await(await f.request('/reasoning-translation',target)).json()).cached).toBe(true)
 expect((await f.request('/reasoning-translation',target,'bob')).status).toBe(404)
 f.revoked.add('login-a');expect((await f.request('/reasoning-translation',target)).status).toBe(403)
 expect(calls).toBe(1);expect(JSON.stringify(logs.get(h.id))).toBe(before)
})
