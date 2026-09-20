import test from 'node:test'
import assert from 'node:assert/strict'
import {chatSdk} from '../runtime/chat-sdk.mjs'
import {projectChat} from '../src/chat-history.ts'

/** 会话事件：本文件喂给 `projectChat` 的那几项（`type` / `data` / `time` / `seq` / `surfaceOp`）。 */
type ProjectedEvent = {
  readonly type: string
  readonly data: Record<string, unknown>
  readonly time: number
  readonly seq: number
  readonly surfaceOp?: string
}

/** `projectChat()` 的第三个实参（`chat-history.ts` 的 `HistorySdk` 没有导出，从签名上取一次）。 */
type ProjectChatSdk = Parameters<typeof projectChat>[2]

/**
 * `projectChat()` 的产物形状（`chat-history.ts` 由实现推断）。本文件只读这几个面：消息的
 * `role` / `text` / `feedback` / `id`，以及每轮的用量、尝试次数与速率。
 *
 * ⚠️ `usage` 声明成**非空**：第一条用例的输入里每一轮都喂了 usage 帧（`:11` 与 `:19`），
 * 第二条用例断言"缺 provider usage 时是 `null`"—— 那条由 `assert.equal` 承载（它接受任意值）。
 */
type ChatProjection = {
  readonly messages: readonly { readonly id?: string; readonly role: string; readonly text?: string; readonly feedback?: boolean }[]
  readonly turns: readonly {
    readonly usage: { readonly totalTokens: number; readonly uncachedInputTokens: number }
    readonly attempts: number
    readonly ttftMs: number | null
    readonly tokensPerSecond: number | null
  }[]
}

test('official 0.1.6-alpha.2 surface and token fold preserve multi-step, retries and per-turn accounting',()=>{
  const events: ProjectedEvent[]=[],add=(type: string,data: Record<string, unknown>,surfaceOp?: string)=>{events.push({type,data,time:1000+events.length*100,seq:events.length,...(surfaceOp?{surfaceOp}:{})})}
  const usage={inputTokens:10,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:0,reasoningTokens:1,totalTokens:16}
  const stream=(text: string)=>[{type:'chunk',time:950+events.length*100,chunk:{type:'text-delta',text}}]
  const answer=(turn: number,step: number,id: string,text: string)=>add('assistant/message',{turn,step,stream:stream(text),usage,message:{id,role:'assistant',source:{provider:'test',model:'model'},content:[{type:'text',text}]}},'append')
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
  // `chat-sdk.mjs` 是 JS 实现：它推出来的 `deriveEventMessage` 返回 `dsh-session` 的 `Message`（interface），
  // 而 `HistorySdk` 声明的是 `Record<string, any>`（interface 不能赋给带索引签名的字典类型）⇒ 运行期是同一个
  // 实现，在调用点越过一次。
  const result=projectChat(events,[{id:'r1',userMessageId:'u1',input:{text:'请查看博客'},attachments:[]}],chatSdk as unknown as ProjectChatSdk) as unknown as ChatProjection
  assert.deepEqual(result.messages.filter(m=>m.role==='assistant').map(m=>m.text),['先查询文章','查询结果','部分回答','重试完成'])
  assert.equal(result.messages[0]!.text,'请查看博客')
  assert.deepEqual(result.turns.map(t=>t.usage.totalTokens),[32,32])
  assert.deepEqual(result.turns.map(t=>t.usage.uncachedInputTokens),[20,20])
  assert.deepEqual(result.turns.map(t=>t.attempts),[2,2])
  assert.equal(result.messages.find(m=>m.text==='部分回答')!.feedback,false)
  assert.equal(result.messages.find(m=>m.id==='a2')!.feedback,true)
  assert.equal(result.messages.find(m=>m.id==='a1')!.feedback,true)
  assert.equal(result.turns[0]!.ttftMs,50);assert.equal(result.turns[0]!.tokensPerSecond,80)
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
  // 同上（另一个用例）：`chat-sdk.mjs` 的推断签名与 `HistorySdk` 在 `deriveEventMessage` 的返回类型上不兼容。
  const result=projectChat(events,[],chatSdk as unknown as ProjectChatSdk) as unknown as ChatProjection
  assert.equal(result.messages.length,0);assert.equal(result.turns[0]!.usage,null);assert.equal(result.turns[0]!.tokensPerSecond,null)
})
