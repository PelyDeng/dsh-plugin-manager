import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {native,exportChat,stageChat} from '../backup/chat-state.mjs'

const cwd='/data/workspace',id=()=> 'blog-chat-'+randomUUID()
const header=(id,parent)=>({version:2,id,createdAt:1000,cwd,isSeeded:!!parent,...(parent?{parentSession:parent}:{})})
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
async function mount(sdk,root,storage){
  const ctx=new sdk.Context()
  await ctx.plugin(sdk.persistence.default,{root,compression:'zstd'})
  await ctx.plugin(sdk.storage.default);await ctx.plugin(sdk.json,{root:storage});await ctx.plugin(sdk.domain,{backend:'json'})
  const domain=await ctx.storageDomain.open(sdk.feedback.messageFeedbackDomainSpec)
  return{ctx,domain,table:domain.table('sessions'),close:()=>ctx.fiber.dispose()}
}
async function putLog(ctx,h,seed=0){
  const handle=await ctx.sessionPersistence.create(h,{inheritedEventCount:seed})
  try{await handle.append(h.isSeeded?[...events,{type:'session/end-seed',seq:seed,time:1007,data:{inherited:true}}]:events);await handle.flush()}finally{await handle.close()}
}
test('native offline backup restores two owners, seeded logs, precise feedback and preserves unrelated live state',async()=>{
  const root=await mkdtemp(join(tmpdir(),'blog-backup-native-')),sdk=await native()
  const sessions=join(root,'sessions'),storage=join(root,'storage'),database=join(root,'blog.sqlite'),snapshot=join(root,'snapshot')
  await mkdir(sessions);await mkdir(storage)
  const a=id(),b=id(),branch=id(),pending=id(),later=id(),other='example-'+randomUUID()
  const conv=(id,owner,parent=null)=>({id,owner,requestId:'request-'+id,createdAt:900,ready:true,sessionCreatedAt:1000,parent})
  const empty={...conv(pending,'auth:user-a'),ready:false};delete empty.sessionCreatedAt
  const saved=[conv(a,'auth:user-a'),conv(b,'auth:user-b'),conv(branch,'auth:user-a',a),empty]
  index(database,saved)
  let service=await mount(sdk,sessions,storage)
  const feedbackA=row(),feedbackOther=row()
  try{
    await putLog(service.ctx,header(a));await putLog(service.ctx,header(b));await putLog(service.ctx,header(branch,a),events.length)
    await putLog(service.ctx,header(other))
    await service.table.put(a,feedbackA);await service.table.put(other,feedbackOther)
  }finally{await service.close()}
  try{
    const result=await exportChat({database,sessionRoot:sessions,storageRoot:storage,output:snapshot,cwd},sdk)
    assert.equal(result.sessions,4)
    const savedDb=join(root,'saved.sqlite');await copyFile(database,savedDb)
    index(database,[conv(later,'auth:user-b'),conv(pending,'auth:user-a')])
    service=await mount(sdk,sessions,storage)
    try{
      await putLog(service.ctx,header(later));await service.table.put(later,row())
      await putLog(service.ctx,header(pending));await service.table.put(pending,row())
      await service.table.put(b,row());await service.table.put(a,row())
    }finally{await service.close()}
    const before=await readFile(join(storage,'message_feedback.json'))
    const output=join(root,'staged'),cfg={database:savedDb,currentDatabase:database,sessionRoot:sessions,storageRoot:storage,snapshot,output,cwd}
    const staged=await stageChat(cfg,sdk)
    assert.equal(staged.sessions,4);assert.equal(staged.mappings.filter(m=>m.source===null).length,2)
    assert.deepEqual(await readFile(join(storage,'message_feedback.json')),before,'staging must not mutate the live shared domain')
    service=await mount(sdk,join(output,'sessions'),join(output,'storage'))
    try{
      assert.deepEqual(service.table.get(a),feedbackA)
      assert.equal(service.table.get(b),undefined,'restore explicit absent row')
      assert.equal(service.table.get(later),undefined,'post-backup blog row is removed')
      assert.equal(service.table.get(pending),undefined,'formerly empty conversation returns to absent feedback')
      assert.equal(await service.ctx.sessionPersistence.stat(pending),undefined,'formerly empty conversation has no restored log')
      assert.deepEqual(service.table.get(other),feedbackOther,'other plugin feedback survives')
      for(const c of saved){
        if(!c.ready)continue
        const handle=await service.ctx.sessionPersistence.open(c.id,'read')
        try{const restored=await handle.read();assert.deepEqual(restored.slice(0,events.length),events);assert.equal(restored.length,c.parent?events.length+1:events.length);assert.equal(handle.inheritedEventCount,c.parent?events.length:0)}finally{await handle.close()}
      }
      await service.domain.close()
      const require=createRequire('/opt/dsh-runtime/package.json')
      const {SessionStore}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')))
      await service.ctx.plugin(SessionStore)
      await service.ctx.plugin(sdk.feedback.default,{maxNoteBytes:4000})
      const listed=await service.ctx.messageFeedback.list({sessionId:a})
      assert.equal(listed.ok,true);assert.deepEqual(listed.value.items,feedbackA.items)
      const stale=await service.ctx.messageFeedback.put({sessionId:a,messageId:'a1',rating:'negative',ifVersion:null})
      assert.equal(stale.ok,false);assert.equal(stale.error.code,'version-conflict')
      assert.equal(stale.error.current.version,feedbackA.items[0].version)
      const updated=await service.ctx.messageFeedback.put({sessionId:a,messageId:'a1',rating:'negative',ifVersion:feedbackA.items[0].version})
      assert.equal(updated.ok,true,'restored feedback supports the real service CAS update')
    }finally{await service.close()}
    index(database,[conv(a,'auth:someone-else')])
    await assert.rejects(stageChat({...cfg,output:join(root,'bad-owner')},sdk),/another owner/)
    index(database,[conv(a,'auth:user-a')])
    const original=JSON.parse(await readFile(join(snapshot,a+'.json'),'utf8'))
    const invalid=structuredClone(original);invalid.feedback.items[0].version='not-a-version'
    await writeFile(join(snapshot,a+'.json'),JSON.stringify(invalid))
    await assert.rejects(stageChat({...cfg,output:join(root,'bad-row')},sdk))
    await writeFile(join(snapshot,a+'.json'),JSON.stringify(original))
    const badLog=structuredClone(original);badLog.session.events[3].seq=99
    await writeFile(join(snapshot,a+'.json'),JSON.stringify(badLog))
    await assert.rejects(stageChat({...cfg,output:join(root,'bad-log')},sdk))
    assert.deepEqual(await readFile(join(storage,'message_feedback.json')),before)
    // Both successful staging and rejected snapshots left the unrelated log readable.
    service=await mount(sdk,sessions,storage)
    try{const h=await service.ctx.sessionPersistence.open(other,'read');try{assert.deepEqual(await h.read(),events)}finally{await h.close()}}finally{await service.close()}
  }finally{await rm(root,{recursive:true,force:true})}
})
