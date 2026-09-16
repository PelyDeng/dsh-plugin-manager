import test from 'node:test'
import assert from 'node:assert/strict'
import {chatSdk} from '../runtime/chat-sdk.mjs'
import {projectChat} from '../src/chat-history.mjs'

test('official 0.1.6-alpha.1 surface and token fold preserve multi-step, retries and per-turn accounting',()=>{
  const events=[],add=(type,data,surfaceOp)=>{events.push({type,data,time:1000+events.length*100,seq:events.length,...(surfaceOp?{surfaceOp}:{})})}
  const usage={inputTokens:10,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:0,reasoningTokens:1,totalTokens:16}
  const stream=text=>[{type:'chunk',time:950+events.length*100,chunk:{type:'text-delta',text}}]
  const answer=(turn,step,id,text)=>add('assistant/message',{turn,step,stream:stream(text),usage,message:{id,role:'assistant',source:{provider:'test',model:'model'},content:[{type:'text',text}]}},'append')
  add('user/message',{id:'u1',role:'user',source:{kind:'user'},content:[{type:'text',text:'MODEL-ONLY-FROZEN-ATTACHMENT'}]},'append')
  add('turn/start',{turn:1});add('step/start',{turn:1,step:1});answer(1,1,'a1','先查询文章')
  add('tool/call',{turn:1,step:1,callId:'c1',name:'blog_search_posts',arguments:{secret:'DO-NOT-EXPOSE'}})
  add('tool/result',{turn:1,step:1,message:{source:{kind:'tool',callId:'c1'},content:[{type:'text',text:'PRIVATE-TOOL-RESULT'}]}})
  add('step/end',{turn:1,step:1});add('step/start',{turn:1,step:2});answer(1,2,'a2','查询结果')
  add('step/end',{turn:1,step:2});add('turn/end',{turn:1,reason:{kind:'completed'}})
  add('user/message',{id:'u2',role:'user',source:{kind:'user'},content:[{type:'text',text:'继续'}]},'append')
  add('turn/start',{turn:2});add('step/start',{turn:2,step:1})
  add('assistant/attempt',{turn:2,step:1,stream:[...stream('部分回答'),{type:'chunk',time:2400,chunk:{type:'usage',usage}},{type:'chunk',time:2450,chunk:{type:'finish',reason:{kind:'error',failure:{code:'HTTP',message:'INTERNAL-ERROR'}}}}]})
  add('llm/retry',{turn:2,step:1});add('llm/retry-started',{turn:2,step:1,retry:1});answer(2,1,'a3','重试完成')
  add('step/end',{turn:2,step:1});add('turn/end',{turn:2,reason:{kind:'completed'}})
  const result=projectChat(events,[{id:'r1',userMessageId:'u1',input:{text:'请查看博客'},attachments:[]}],chatSdk)
  assert.deepEqual(result.messages.filter(m=>m.role==='assistant').map(m=>m.text),['先查询文章','查询结果','部分回答','重试完成'])
  assert.equal(result.messages[0].text,'请查看博客')
  assert.deepEqual(result.turns.map(t=>t.usage.totalTokens),[32,32])
  assert.deepEqual(result.turns.map(t=>t.usage.uncachedInputTokens),[20,20])
  assert.deepEqual(result.turns.map(t=>t.attempts),[2,2])
  assert.equal(result.messages.find(m=>m.text==='部分回答').feedback,false)
  assert.equal(result.messages.find(m=>m.id==='a2').feedback,true)
  assert.equal(result.messages.find(m=>m.id==='a1').feedback,true)
  assert.equal(result.turns[0].ttftMs,50);assert.equal(result.turns[0].tokensPerSecond,80)
  const serialized=JSON.stringify(result);for(const privateText of ['DO-NOT-EXPOSE','PRIVATE-TOOL-RESULT','INTERNAL-ERROR','MODEL-ONLY-FROZEN-ATTACHMENT'])assert.ok(!serialized.includes(privateText))
})

test('usage-only messages and missing provider usage never create a scoreable answer or invented tokens',()=>{
  const events=[
    {type:'turn/start',seq:0,time:1000,data:{turn:1}},
    {type:'step/start',seq:1,time:1100,data:{turn:1,step:1}},
    {type:'assistant/message',surfaceOp:'append',seq:2,time:1200,data:{turn:1,step:1,stream:[],message:{id:'empty',role:'assistant',source:{provider:'test',model:'test'},content:[]}}},
    {type:'step/end',seq:3,time:1300,data:{turn:1,step:1}},
    {type:'turn/end',seq:4,time:1400,data:{turn:1,reason:{kind:'completed'}}},
  ]
  const result=projectChat(events,[],chatSdk)
  assert.equal(result.messages.length,0);assert.equal(result.turns[0].usage,null);assert.equal(result.turns[0].tokensPerSecond,null)
})
