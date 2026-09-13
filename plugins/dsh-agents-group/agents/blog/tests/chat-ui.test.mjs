import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createContext,runInContext} from 'node:vm'
import {chatConversationTarget,shouldSendChatEnter} from '../web/chat.js'
import {chatTurns} from '../web/chat-turns.js'
import {projectChat} from '../src/chat-history.mjs'

test('deep links follow switching, new conversations and deletion without changing other URL or history state',async()=>{
  const source=readFileSync(new URL('../web/chat.js',import.meta.url),'utf8')
  const block=source.slice(source.indexOf('  const sidebar=createConversationHistory('),source.indexOf('  function connect()'))
  assert.ok(block.startsWith('  const sidebar='))
  let href='https://example.invalid/blog?from=entry&conversationId=chat-a&keep=1#answer',options,modelRefresh=async()=>{},connects=0
  const saved=new Map(),historyState={scroll:17,external:{keep:true}},node={value:'',close(){},hidden:false}
  const browser={location:{get href(){return href}},history:{state:historyState,replaceState(state,_title,url){assert.equal(state,historyState);href=String(url)}},dispatchEvent(){}}
  const state={id:'chat-a',epoch:0,feedback:new Map()}
  const scope=createContext({URL,crypto:globalThis.crypto,window:browser,state,key:'blog-chat:alice',identity:{userId:'alice'},
    sessionStorage:{setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
    createConversationHistory:value=>{options=value;return{refresh:async()=>{},render(){}}},$:()=>node,
    inputs:new Map(),translations:{reset(){}},clearTimeout(){},refreshTimer:null,creating:null,
    CustomEvent:class{},picker:{refresh:(...args)=>modelRefresh(...args)},api:async()=>({id:'chat-c'}),
    connect(){connects++},refresh:async()=>{},loadFiles:async()=>{},render(){},renderFiles(){},controls(){},focusInput(){},error(error){throw error}})
  runInContext(block,scope)
  const expectTarget=id=>{
    const url=new URL(href)
    assert.equal(state.id,id)
    assert.equal(chatConversationTarget(url.search,saved.get('blog-chat:alice')),id)
    assert.equal(url.pathname,'/blog');assert.equal(url.searchParams.get('from'),'entry')
    assert.equal(url.searchParams.get('keep'),'1');assert.equal(url.hash,'#answer')
    assert.equal(browser.history.state,historyState)
  }
  await options.openConversation('chat-b');expectTarget('chat-b')
  // The real new-conversation callback deliberately does not return activate's promise.
  options.newConversation();await new Promise(resolve=>setImmediate(resolve));expectTarget(null)
  assert.equal(new URL(href).searchParams.has('conversationId'),false)
  assert.equal(await runInContext('ensureConversation()',scope),'chat-c');expectTarget('chat-c')
  await options.onDeleted(['chat-b']);expectTarget('chat-c')
  await options.onDeleted(['chat-c']);expectTarget(null)
  assert.equal(new URL(href).searchParams.has('conversationId'),false)
  await options.openConversation('chat-b');expectTarget('chat-b')
  const waiting=[]
  modelRefresh=()=>new Promise(resolve=>waiting.push(resolve))
  const late=options.openConversation('chat-b'),fresh=runInContext('activate(null)',scope)
  expectTarget(null)
  waiting[1]();await fresh;expectTarget(null)
  waiting[0]();await late;expectTarget(null)
  const beforeConnects=connects,older=options.openConversation('chat-b'),newer=options.openConversation('chat-b')
  waiting[2]();await older
  assert.equal(saved.has('blog-chat:alice'),false);assert.equal(connects,beforeConnects)
  waiting[3]();await newer;expectTarget('chat-b')
})

test('tool errors without optional diagnostic metadata stay failed in history and grouped answers',()=>{
  const events=[{type:'turn/start',seq:0,time:0,data:{turn:1}}]
  for(const [callId,isError,error] of [['delete',true,undefined],['legacy',false,{code:'FAIL'}],['search',false,undefined]]){
    events.push({type:'tool/call',seq:events.length,time:1,data:{turn:1,callId,name:callId}})
    events.push({type:'tool/result',seq:events.length,time:2,data:{turn:1,message:{source:{kind:'tool',callId},content:[{type:'tool-result',isError,content:[{type:'text',text:'PRIVATE-RESULT'}]}]},...(error?{error}:{})}})
  }
  const result=projectChat(events,[],{isAppendSurfaceEvent:()=>false})
  assert.deepEqual(result.messages.map(m=>m.status),['failed','failed','succeeded'])
  const grouped=chatTurns([{id:'user',role:'user',text:'操作'},...result.messages])
  assert.deepEqual(grouped[1].tools.map(m=>m.status),['failed','failed','succeeded'])
  assert.ok(!JSON.stringify(grouped).includes('PRIVATE-RESULT'))
})

test('one answer per user turn retains tools, final feedback target and exact reasoning source',()=>{
  const input=[{id:'u1',role:'user',text:'今天有哪些文章'},
    {id:'a1',role:'assistant',turn:1,text:'正在查找',reasoning:'第一段'},
    {id:'t1',role:'tool',turn:1,status:'succeeded',name:'blog_search_posts'},
    {id:'t2',role:'tool',turn:1,status:'failed',name:'blog_list_drafts'},
    {id:'a2',role:'assistant',turn:1,text:'最终结果',feedback:true,tail:true,forkCut:15}]
  const before=structuredClone(input),result=chatTurns(input)
  assert.equal(result.length,2);assert.deepEqual(input,before)
  assert.equal(result[1].id,'a2');assert.equal(result[1].text,'最终结果');assert.equal(result[1].reasoningSource,'a1');assert.equal(result[1].reasoning,'第一段')
  assert.deepEqual(result[1].tools.map(t=>t.status),['succeeded','failed']);assert.equal(result[1].steps.length,2)
  assert.equal(result[1].feedback,true);assert.equal(result[1].forkCut,15)
  const next=chatTurns([...input,{id:'u2',role:'user',text:'下一题'},{id:'a3',role:'assistant',turn:2,text:'下一答',reasoning:'最新思考'}])
  assert.equal(next.length,4);assert.equal(next[1].displayKey,result[1].displayKey);assert.equal(next[3].reasoningSource,'a3');assert.equal(next[3].tools.length,0)
})

test('pending and persisted answers share one stable presentation slot',()=>{
  const user={id:'u1',role:'user',time:123,turn:0}
  const pending=chatTurns([user],{busy:true}),saved=chatTurns([user,{id:'a1',role:'assistant',turn:1,text:'结果'}])
  assert.equal(pending.length,2);assert.equal(pending[1].displayKey,saved[1].displayKey)
  assert.equal(chatTurns([user]).length,1)
  const interrupted=chatTurns([user,{id:'attempt-3',role:'assistant',turn:1,text:'部分回答',reasoning:'部分思考',interrupted:true},{id:'a1',role:'assistant',turn:1,text:'完整回答',reasoning:'新的思考'}])
  assert.equal(interrupted.length,2);assert.equal(interrupted[1].reasoningSource,'a1');assert.equal(interrupted[1].steps[0].interrupted,true)
})

test('operation cards stay after their originating answer when later turns stream and history reloads',()=>{
  const messages=[{id:'u1',role:'user',requestId:'r1',text:'删除文章'},
    {id:'a1',role:'assistant',text:'请确认删除'},
    {id:'u2',role:'user',text:'发布草稿'},
    {id:'a2',role:'assistant',text:'请确认发布'},
    {id:'u3',role:'user',requestId:'r3',text:'新问题'}]
  const operations=[{id:'publish',requestId:'r2',mode:'publish',status:'prepared'},{id:'delete',requestId:'r1',mode:'delete',status:'succeeded'}]
  const requests=[{id:'r2',userMessageId:'u2'}],before=structuredClone({messages,operations})
  const timeline=chatTurns(messages,{busy:true,operations,requests})
  assert.deepEqual(timeline.map(m=>m.role==='operation'?m.operation.id:m.id),['u1','a1','delete','u2','a2','publish','u3','pending-u3'])
  const reloaded=chatTurns([...messages,{id:'a3',role:'assistant',text:'新回答'}],{operations:structuredClone(operations),requests})
  assert.deepEqual(reloaded.map(m=>m.role==='operation'?m.operation.id:m.id),['u1','a1','delete','u2','a2','publish','u3','a3'])
  assert.deepEqual({messages,operations},before)
})

test('operations without a matching request remain visible as unassociated history, not under the latest answer',()=>{
  const result=chatTurns([{id:'new',role:'user',text:'新问题'}],{busy:true,operations:[{id:'old',requestId:'missing'}]})
  assert.equal(result[0].role,'operation');assert.equal(result[0].unassociated,true)
  assert.equal(result[0].operation.id,'old');assert.equal(result[1].id,'new')
})

test('chat keyboard sends only desktop Enter and leaves mobile and multiline input untouched',()=>{
  const enter={key:'Enter',shiftKey:false,isComposing:false,keyCode:13}
  assert.equal(shouldSendChatEnter(enter),true)
  assert.equal(shouldSendChatEnter(enter,{touch:true}),false)
  assert.equal(shouldSendChatEnter({...enter,shiftKey:true}),false)
  assert.equal(shouldSendChatEnter({...enter,key:'a'}),false)
})

test('composition events and legacy IME key codes cannot send a chat message',()=>{
  const enter={key:'Enter',shiftKey:false,isComposing:false,keyCode:13}
  assert.equal(shouldSendChatEnter({...enter,isComposing:true}),false)
  assert.equal(shouldSendChatEnter({...enter,keyCode:229}),false)
  assert.equal(shouldSendChatEnter(enter,{composing:true}),false)
  assert.equal(shouldSendChatEnter(enter,{composing:false}),true)
})
