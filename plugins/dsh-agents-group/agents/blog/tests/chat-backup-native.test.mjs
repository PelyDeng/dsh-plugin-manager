import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {native,exportChat,stageChat,restoreSnapshot} from '../backup/chat-state.mjs'

const cwd='/data/workspace',id=()=> 'blog-chat-'+randomUUID()
const header=(id,parent)=>({version:3,delegationDepth:0,id,createdAt:1000,cwd,isSeeded:!!parent,...(parent?{parentSession:parent}:{})})
const events=[
  {type:'turn/start',seq:0,time:1001,data:{turn:1}},
  {type:'user/message',seq:1,time:1002,data:{id:'u1',role:'user',source:{kind:'user'},content:[{type:'text',text:'博客资料'}]},surfaceOp:'append'},
  {type:'step/start',seq:2,time:1003,data:{turn:1,step:1}},
  {type:'assistant/message',seq:3,time:1004,data:{turn:1,step:1,stream:[],usage:{inputTokens:11,outputTokens:5,totalTokens:16},message:{id:'a1',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'真实持久回答'}]}},surfaceOp:'append'},
  {type:'step/end',seq:4,time:1005,data:{turn:1,step:1}},
  {type:'turn/end',seq:5,time:1006,data:{turn:1,reason:{kind:'completed'}}},
]
const row=()=>({session:{createdAt:1000,cwd},items:[{messageId:'a1',rating:'positive',note:'保留版本和时间',version:randomUUID(),createdAt:1100,updatedAt:1200}]})
function index(database,items){
  const db=new DatabaseSync(database)
  try{
    db.exec('CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,owner TEXT,data TEXT)')
    for(const c of items)db.prepare('INSERT OR REPLACE INTO conversations VALUES(?,?,?)').run(c.id,c.owner,JSON.stringify(c))
  }finally{db.close()}
}
test('V2 backups migrate with official system heads and remapped inherited boundaries',async()=>{
  const root=await mkdtemp(join(tmpdir(),'blog-backup-v2-')),sdk=await native(),sessionId=id(),parent=id()
  try{
    const database=join(root,'saved.sqlite'),snapshot=join(root,'snapshot'),output=join(root,'staged')
    const c={id:sessionId,owner:'auth:user-a',requestId:sessionId,createdAt:900,ready:true,sessionCreatedAt:1000,parent}
    index(database,[c]);await mkdir(snapshot)
    const oldEvents=[events[0],events[2],events[1],...events.slice(3)].map((e,seq)=>({...e,seq}))
    const old={header:{...header(sessionId,parent),version:2},inheritedEventCount:oldEvents.length,
      events:[...oldEvents,{type:'session/end-seed',seq:oldEvents.length,time:1007,data:{inherited:true}}]}
    const migrated=restoreSnapshot(sdk,old)
    assert.equal(migrated.header.version,3)
    assert.equal(migrated.events[2].type,'system/message')
    assert.equal(migrated.inheritedEventCount,old.inheritedEventCount+1)
    assert.equal(migrated.events.find(e=>e.type==='assistant/message').data.message.id,'a1')
    const badCut=structuredClone(old);badCut.inheritedEventCount+=1
    assert.throws(()=>restoreSnapshot(sdk,badCut))
    await writeFile(join(snapshot,sessionId+'.json'),JSON.stringify({session:old,feedback:null}))
    await writeFile(join(snapshot,'index.json'),JSON.stringify({schemaVersion:1,cwd,entries:[{id:sessionId,owner:c.owner}]}))
    await stageChat({database,snapshot,output,cwd},sdk)
    const service=await mount(sdk,join(output,'sessions'),join(output,'storage'))
    try{
      const handle=await service.ctx.sessionPersistence.open(sessionId,'read')
      try{
        assert.deepEqual((await handle.read()).events,migrated.events)
        assert.equal(handle.inheritedEventCount,migrated.inheritedEventCount)
      }finally{await handle.close()}
    }finally{await service.close()}
  }finally{await rm(root,{recursive:true,force:true})}
})
async function mount(sdk,root){
  const ctx=new sdk.Context()
  await ctx.plugin(sdk.persistence.default,{root,compression:'zstd'})
  await ctx.plugin(sdk.session.SessionStore)
  await ctx.plugin(sdk.feedback.default,{maxNoteBytes:8192})
  return{ctx,close:()=>ctx.fiber.dispose()}
}
async function log(service,id){
  const h=await service.ctx.sessionPersistence.open(id,'read')
  try{return(await h.read()).events}finally{await h.close()}
}
async function items(service,id){
  const result=await service.ctx.messageFeedback.list({sessionId:id})
  assert.equal(result.ok,true);return result.value.items
}
async function putLog(ctx,h,seed=0){
  const handle=await ctx.sessionPersistence.create(h,{inheritedEventCount:seed})
  try{await handle.append(h.isSeeded?[...events,{type:'session/end-seed',seq:seed,time:1007,data:{inherited:true}}]:events);await handle.flush()}finally{await handle.close()}
}
async function putFeedback(service,id,item){
  const handle=await service.ctx.sessionPersistence.open(id,'write')
  try{
    const {events}=await handle.read()
    await handle.append([{type:'feedback/message-put',seq:events.length,time:item.updatedAt,data:{sessionId:id,item}}]);await handle.flush()
  }finally{await handle.close()}
}
test('native offline backup restores two owners, seeded logs, exact feedback and leaves unrelated state untouched',async()=>{
  const root=await mkdtemp(join(tmpdir(),'blog-backup-native-')),sdk=await native()
  try{
    const sessions=join(root,'sessions'),storage=join(root,'storage'),database=join(root,'blog.sqlite'),snapshot=join(root,'snapshot')
    await mkdir(sessions);await mkdir(storage)
    const legacyFile=join(storage,'message_feedback.json');await writeFile(legacyFile,'legacy sidecar remains untouched')
    const a=id(),b=id(),branch=id(),pending=id(),later=id(),other='example-'+randomUUID()
    const conv=(id,owner,parent=null)=>({id,owner,requestId:'request-'+id,createdAt:900,ready:true,sessionCreatedAt:1000,parent})
    const empty={...conv(pending,'auth:user-a'),ready:false};delete empty.sessionCreatedAt
    const saved=[conv(a,'auth:user-a'),conv(b,'auth:user-b'),conv(branch,'auth:user-a',a),empty]
    index(database,saved)
    let service=await mount(sdk,sessions)
    const feedbackA=row().items[0],feedbackOther=row().items[0],originalLogs=new Map()
    try{
      await putLog(service.ctx,header(a));await putLog(service.ctx,header(b));await putLog(service.ctx,header(branch,a),events.length)
      await putLog(service.ctx,header(other))
      await putFeedback(service,a,feedbackA);await putFeedback(service,other,feedbackOther)
      for(const id of [a,b,branch,other])originalLogs.set(id,await log(service,id))
    }finally{await service.close()}
    const cfg={database,sessionRoot:sessions,storageRoot:storage,output:snapshot,cwd}
    assert.equal((await exportChat(cfg,sdk)).sessions,4)
    assert.equal(JSON.parse(await readFile(join(snapshot,'index.json'))).schemaVersion,2)
    const savedDb=join(root,'saved.sqlite');await copyFile(database,savedDb)
    index(database,[conv(later,'auth:user-b'),conv(pending,'auth:user-a')])
    service=await mount(sdk,sessions)
    try{
      for(const id of [later,pending]){await putLog(service.ctx,header(id));await putFeedback(service,id,row().items[0])}
      await putFeedback(service,b,row().items[0]);await putFeedback(service,a,row().items[0])
    }finally{await service.close()}
    const output=join(root,'staged'),restore={...cfg,database:savedDb,currentDatabase:database,snapshot,output}
    const staged=await stageChat(restore,sdk)
    assert.equal(staged.sessions,4);assert.equal(staged.mappings.filter(m=>m.source===null).length,2)
    assert.equal(await readFile(legacyFile,'utf8'),'legacy sidecar remains untouched')
    service=await mount(sdk,join(output,'sessions'))
    try{
      assert.deepEqual(await items(service,a),[feedbackA]);assert.deepEqual(await items(service,b),[])
      assert.equal(await service.ctx.sessionPersistence.stat(later),undefined)
      assert.equal(await service.ctx.sessionPersistence.stat(pending),undefined)
      assert.equal(await service.ctx.sessionPersistence.stat(other),undefined,'unrelated logs never enter the replacement set')
      for(const id of [a,b,branch])assert.deepEqual(await log(service,id),originalLogs.get(id))
      const h=await service.ctx.sessionPersistence.open(branch,'read');assert.equal(h.inheritedEventCount,events.length);await h.close()
      const stale=await service.ctx.messageFeedback.put({sessionId:a,messageId:'a1',rating:'negative',ifVersion:null})
      assert.equal(stale.ok,false);assert.equal(stale.error.code,'version-conflict');assert.equal(stale.error.current.version,feedbackA.version)
      const updated=await service.ctx.messageFeedback.put({sessionId:a,messageId:'a1',rating:'negative',ifVersion:feedbackA.version})
      assert.equal(updated.ok,true,'restored feedback supports native CAS')
    }finally{await service.close()}
    index(database,[conv(a,'auth:someone-else')])
    await assert.rejects(stageChat({...restore,output:join(root,'bad-owner')},sdk),/another owner/)
    index(database,[conv(a,'auth:user-a')])
    const file=join(snapshot,a+'.json'),original=JSON.parse(await readFile(file,'utf8'))
    const invalid=structuredClone(original);invalid.session.events.at(-1).data.item.version='invalid'
    await writeFile(file,JSON.stringify(invalid));await assert.rejects(stageChat({...restore,output:join(root,'bad-feedback')},sdk))
    const badLog=structuredClone(original);badLog.session.events[3].seq=99
    await writeFile(file,JSON.stringify(badLog));await assert.rejects(stageChat({...restore,output:join(root,'bad-log')},sdk))
    service=await mount(sdk,sessions)
    try{assert.deepEqual(await log(service,other),originalLogs.get(other));assert.deepEqual(await items(service,other),[feedbackOther])}finally{await service.close()}
  }finally{await rm(root,{recursive:true,force:true})}
})
