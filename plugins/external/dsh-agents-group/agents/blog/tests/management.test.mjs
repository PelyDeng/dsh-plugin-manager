import test from 'node:test'
import assert from 'node:assert/strict'
import {BlogStore} from '../src/store.mjs'
import {BlogApplication} from '../src/application.mjs'
import {BlogClient} from '../src/connectors.mjs'
const actor={namespace:'user',userId:'writer',sessionId:'session'},owner='user:writer'
test('all blog users share management with frozen confirmation, owner/session guard and receipt reconciliation',async t=>{
  const store=new BlogStore(':memory:');t.after(()=>store.close());let revoked=false,writes=0,lost=true
  const receipts=new Map(),blog={async call(action,args){
    if(action==='manage-preview')return{title:'分类',input:{...args,version:'frozen'},impact:{relatedCount:2}}
    if(action==='manage-write'){writes++;assert.equal(args.version,'frozen');const result={id:3,kind:'category'};receipts.set(args.requestId,result);if(lost){lost=false;throw Error('lost response')}return result}
    if(action==='receipt')return{status:'succeeded',result:receipts.get(args.requestId)}
  }}
  const app=new BlogApplication(store,{assert(){assert.ok(!revoked,'revoked')}},blog)
  const args={kind:'category',operation:'update',id:3,fields:{name:'改名'}}
  const p=await app.call(actor,'manage-prepare',args);args.fields.name='later';assert.equal(writes,0)
  await assert.rejects(app.confirm({...actor,userId:'other'},p),/无权/)
  await assert.rejects(app.confirm({...actor,sessionId:'other'},p),/失效/)
  await assert.rejects(app.confirm(actor,p),/lost/);assert.equal(writes,1)
  await assert.rejects(app.confirm(actor,p),/核对/)
  assert.equal((await app.reconcile(actor,p.id)).status,'succeeded');assert.equal(writes,1)
  assert.equal(app.operation(owner,p.id).payload.fields.name,'改名')
  revoked=true;await assert.rejects(app.call(actor,'manage-list',{kind:'tag'}),/revoked/)
})
test('conversation management can only be confirmed from its own conversation',async t=>{
  const store=new BlogStore(':memory:');t.after(()=>store.close());let writes=0
  const blog={async call(action,input){if(action==='manage-preview')return{input,title:'评论'};writes++;return{id:2}}}
  const app=new BlogApplication(store,{assert(){}},blog),chat={conversationId:'conversation'}
  const p=await app.prepareManagement(actor,{kind:'comment',operation:'delete',id:2},undefined,chat)
  await assert.rejects(app.confirm(actor,p),/原对话/)
  await assert.rejects(app.confirm(actor,p,'other'),/原对话/)
  assert.equal(writes,0);assert.equal((await app.confirm(actor,p,'conversation')).status,'succeeded');assert.equal(writes,1)
})
test('read-only connector actions cannot be replaced by fields supplied in arguments',async()=>{
  let body
  const blog=new BlogClient({url:'https://example.invalid',username:'fixture',password:'fixture'},async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({ok:true,data:{items:[]}}))})
  await blog.call('manage-list',{action:'manage-write',protocolVersion:999,kind:'comment'})
  assert.equal(body.action,'manage-list');assert.equal(body.protocolVersion,1)
})

test('category navigation retains ancestors across pages and excludes descendants from parent choices',async()=>{
  const {readTaxonomy,categoryPath,parentChoices}=await import('../web/management.js')
  const rows=[{id:3,parent:0,name:'摘抄笔记'},{id:5,parent:3,name:'算法小抄'},{id:9,parent:5,name:'排序'},{id:35,parent:0,name:'开发工具'}]
  const calls=[],api=async(action,args)=>{calls.push(args);return{items:rows.slice((args.page-1)*2,args.page*2),hasMore:args.page===1}}
  const items=await readTaxonomy(api,'category')
  assert.equal(items.length,4);assert.deepEqual(calls.map(c=>c.page),[1,2]);assert.ok(calls.every(c=>c.query===''))
  assert.deepEqual(categoryPath(items,9).map(item=>item.id),[3,5,9])
  assert.deepEqual(parentChoices(items,3).map(item=>item.id),[35])
  assert.deepEqual(parentChoices(items,5).map(item=>item.id),[3,35])
  assert.equal(await readTaxonomy(api,'category',()=>false),null)
  const cyclic=[{id:1,parent:2},{id:2,parent:1}]
  assert.equal(categoryPath(cyclic,1).length,2)
})
