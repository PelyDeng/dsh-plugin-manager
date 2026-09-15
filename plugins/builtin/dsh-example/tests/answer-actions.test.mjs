import {test,expect} from 'vitest'
import {fixture} from './fixture.mjs'
import {projectTurns} from '../src/turns.ts'
import {Inject} from '@deepseek-ai/cordis'
import {inject} from '../src/index.ts'

test('Cordis resolves actual service names instead of dependency group labels',()=>{
 expect(Object.keys(Inject.resolve(inject))).toEqual(['agents','agentDefaultModel','webServer','systemPrompt','tools','sessionPersistence','messageFeedback','llm'])
})

const events=[
 {type:'turn/start',seq:0,time:1000,data:{turn:1}},
 {type:'step/start',seq:1,time:1050,data:{turn:1,step:1}},
 {type:'request/header',seq:2,time:1060,data:{header:{}}},
 {type:'assistant/message',seq:3,time:1400,data:{stream:[{type:'text-chunks',time0:1100,index:0,dt:[],texts:['回答']}],message:{id:'answer-1',content:[{type:'text',text:'回答'}]}}},
 {type:'turn/end',seq:4,time:1500,data:{turn:1,reason:{kind:'completed'}}},
]
test('completed boundaries and observed timings are disclosed without inventing token usage',()=>{
 const [turn]=projectTurns(events);expect(turn).toMatchObject({messageId:'answer-1',branchSeq:4,runMs:500,ttftMs:50,status:'completed'});expect(turn.usage).toBeUndefined()
 expect(projectTurns(events.slice(0,-1))[0].branchSeq).toBeUndefined()
})

test('interrupted V3 attempts retain the observed first token timing',()=>{
 const interrupted=events.map(event=>event.type==='assistant/message'?{...event,type:'assistant/attempt',data:{stream:event.data.stream}}:event.type==='turn/end'?{...event,data:{turn:1,reason:{kind:'cancelled'}}}:event)
 expect(projectTurns(interrupted)[0]).toMatchObject({runMs:500,ttftMs:50,status:'cancelled'})
 expect(projectTurns(interrupted)[0].branchSeq).toBeUndefined()
})
test('feedback and branch use official services behind ownership, final-message and version checks',async()=>{
 const logs=new Map(),rows=new Map();let writes=0,seed
 const service={async list(){return {ok:true,value:{items:[...rows.values()]}}},async put(x){writes++;rows.set(x.messageId,{messageId:x.messageId,rating:x.rating,version:'v1'});return {ok:true,value:{}}},async delete(x){writes++;rows.delete(x.messageId);return {ok:true,value:{}}}}
 const f=await fixture({logs,feedbackService:service,beforeCreate:async options=>{if(options.seed)seed=options}})
 try{
  const response=await f.request('/chat',{message:'问题'}),h=f.handles[0];logs.set(h.id,[...events]);f.ctx.emit('session/event',{id:h.id},events.at(-1));await response.text()
  const input={conversationId:h.id,messageId:'answer-1',rating:'positive',ifVersion:null}
  expect((await f.request('/feedback',input,'bob')).status).toBe(404)
  expect((await f.request('/feedback',{...input,messageId:'foreign'})).status).toBe(400)
  expect((await f.request('/feedback',input)).status).toBe(200);expect(writes).toBe(1)
  expect((await f.request('/feedback',input)).status).toBe(409);expect(writes).toBe(1)
  const history=await (await f.request('/history?id='+h.id)).json();expect(history.feedback[0].rating).toBe('positive')
  expect((await f.request('/branch',{conversationId:h.id,atSeq:3})).status).toBe(400)
  expect((await f.request('/branch',{conversationId:h.id,atSeq:4},'bob')).status).toBe(404)
  const fork=await (await f.request('/branch',{conversationId:h.id,atSeq:4})).json();expect(fork.conversationId).not.toBe(h.id);expect(seed.seed).toEqual(events);expect(seed.inheritedEventCount).toBe(events.length)
  expect((await f.request('/history?id='+fork.conversationId,undefined, 'bob')).status).toBe(404)
  expect(logs.get(h.id)).toEqual(events)
 }finally{await f.close()}
})
