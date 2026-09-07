/** Offline, scoped snapshot adapter for the locked official JSONL/zstd and JSON backends. */
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {mkdir,readFile,writeFile,stat,lstat,readdir,realpath,copyFile} from 'node:fs/promises'

const ID=/^blog-chat-[a-f0-9-]{36}$/
const MAX_SESSIONS=10000,MAX_BYTES=64*1024*1024,MAX_EVENTS=100000,MAX_TOTAL=2*1024*1024*1024
const FEEDBACK='message_feedback.json'
// The manager's locked runtime retains pnpm's shared public-package links as well as root links.
const resolvers=[createRequire('/opt/dsh-runtime/package.json'),createRequire('/opt/dsh-runtime/node_modules/.pnpm/runtime-helper.cjs')]
export async function native(){
  const names=['cordis','dsh-session-persistence-jsonl','dsh-storage','dsh-storage-json','dsh-storage-domain','dsh-message-feedback']
  const modules=[]
  for(const name of names){
    const pkg='@deepseek-ai/'+name
    const require=resolvers.find(r=>{try{r.resolve(pkg+'/package.json');return true}catch{return false}})
    assert.ok(require,'official offline package is missing: '+pkg)
    const metadata=JSON.parse(await readFile(require.resolve(pkg+'/package.json'),'utf8'))
    assert.equal(metadata.version,name==='cordis'?'4.0.2':'0.1.3-alpha.1','offline runtime must match the locked host packages')
    modules.push(await import(pathToFileURL(require.resolve(pkg))))
  }
  const [cordis,persistence,storage,json,domain,feedback]=modules
  return{...cordis,persistence,storage,json,domain,feedback}
}
export function conversations(database){
  const db=new DatabaseSync(database,{readOnly:true})
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversations'").get())return new Map()
    const rows=db.prepare('SELECT id,owner,data FROM conversations ORDER BY id LIMIT ?').all(MAX_SESSIONS+1)
    assert.ok(rows.length<=MAX_SESSIONS,'too many blog sessions for one snapshot')
    return new Map(rows.map(row=>{
      const data=JSON.parse(row.data)
      assert.ok(ID.test(row.id)&&data.id===row.id&&data.owner===row.owner&&typeof row.owner==='string'&&row.owner.length>0&&typeof data.requestId==='string'&&Number.isSafeInteger(data.createdAt),'invalid blog session ownership')
      return[row.id,data]
    }))
  }finally{db.close()}
}
function lifecycle(c,header,cwd){
  assert.ok(header.id===c.id&&header.cwd===cwd&&(header.parentSession??null)===(c.parent??null)&&!!header.isSeeded===!!c.parent,'blog session source differs')
  if(c.sessionCreatedAt!==undefined)assert.equal(header.createdAt,c.sessionCreatedAt,'blog session lifecycle differs')
  else assert.ok(Number.isFinite(c.openingAt)&&header.createdAt>=c.openingAt&&header.createdAt<=c.openingUntil,'unpublished blog session cannot be identified')
}
function feedbackRow(sdk,row,header){
  if(row===null)return null
  const value=sdk.feedback.messageFeedbackRowSchema.parse(row)
  assert.ok(header&&value.session.createdAt===header.createdAt&&value.session.cwd===header.cwd,'feedback session lifecycle differs')
  return value
}
async function jsonFile(path,limit=MAX_BYTES){
  assert.ok((await lstat(path)).isFile()&&(await stat(path)).size<=limit,'snapshot file exceeds limit or is not a regular file')
  return JSON.parse(await readFile(path,'utf8'))
}
async function save(path,value){
  const data=JSON.stringify(value);assert.ok(Buffer.byteLength(data)<=MAX_BYTES,'session snapshot exceeds byte limit')
  await writeFile(path,data,{flag:'wx',mode:0o600});return Buffer.byteLength(data)
}
async function exists(path){try{await lstat(path);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
async function mount(sdk,sessionRoot,storageRoot){
  const ctx=new sdk.Context()
  try{
    await ctx.plugin(sdk.persistence.default,{root:sessionRoot,compression:'zstd'})
    await ctx.plugin(sdk.storage.default)
    await ctx.plugin(sdk.json,{root:storageRoot})
    await ctx.plugin(sdk.domain,{backend:'json'})
    const domain=await ctx.storageDomain.open(sdk.feedback.messageFeedbackDomainSpec)
    return{ctx,persistence:ctx.sessionPersistence,table:domain.table('sessions'),close:()=>ctx.fiber.dispose()}
  }catch(error){await ctx.fiber.dispose();throw error}
}
/** Locate only a validated blog ID; the native backend owns project naming and file format. */
async function sessionDirectory(root,id){
  assert.ok(ID.test(id))
  const matches=[]
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue
    const candidate=join(root,entry.name,id)
    if(await exists(candidate)){
      const info=await lstat(candidate),rel=relative(await realpath(root),await realpath(candidate))
      assert.ok(info.isDirectory()&&!info.isSymbolicLink()&&!rel.startsWith('..')&&!isAbsolute(rel),'unsafe session directory')
      matches.push(join(entry.name,id))
    }
  }
  assert.ok(matches.length<=1,'ambiguous session directories')
  return matches[0]??null
}
async function readSession(service,c,cwd){
  const known=await service.stat(c.id)
  if(!known){assert.ok(!c.ready,'indexed session log is missing');return null}
  assert.ok((known.sizeBytes??0)<=MAX_BYTES&&(known.eventCount??0)<=MAX_EVENTS,'session exceeds snapshot limits')
  lifecycle(c,known.header,cwd)
  const handle=await service.open(c.id,'read')
  try{
    lifecycle(c,handle.header,cwd)
    const events=await handle.read(0,MAX_EVENTS+1)
    assert.ok(events.length<=MAX_EVENTS,'session exceeds event limit')
    return{header:handle.header,inheritedEventCount:handle.inheritedEventCount,events}
  }finally{await handle.close()}
}
export async function exportChat(config,sdk=undefined){
  sdk??=await native()
  const index=conversations(config.database)
  await mkdir(config.output,{mode:0o700})
  const service=await mount(sdk,config.sessionRoot,config.storageRoot),entries=[]
  let bytes=0
  try{
    for(const [id,c] of index){
      const session=await readSession(service.persistence,c,config.cwd)
      const directory=await sessionDirectory(config.sessionRoot,id)
      assert.ok(session?directory:!directory,'session directory and native log disagree')
      const feedback=feedbackRow(sdk,service.table.get(id)??null,session?.header)
      bytes+=await save(join(config.output,id+'.json'),{session,feedback})
      assert.ok(bytes<=MAX_TOTAL,'chat snapshot exceeds total byte limit')
      entries.push({id,owner:c.owner})
    }
    await save(join(config.output,'index.json'),{schemaVersion:1,cwd:config.cwd,entries})
    return{sessions:entries.length,bytes}
  }finally{await service.close()}
}
/** Generate new native logs and a feedback merge in isolation. No live file is written here. */
export async function stageChat(config,sdk=undefined){
  sdk??=await native()
  const saved=conversations(config.database),current=config.currentDatabase?conversations(config.currentDatabase):new Map()
  const manifest=await jsonFile(join(config.snapshot,'index.json'))
  assert.ok(manifest.schemaVersion===1&&manifest.cwd===config.cwd&&Array.isArray(manifest.entries)&&manifest.entries.length===saved.size,'chat manifest and restored index differ')
  const entries=new Map()
  for(const entry of manifest.entries){
    assert.ok(ID.test(entry.id)&&!entries.has(entry.id)&&saved.get(entry.id)?.owner===entry.owner,'chat manifest ownership differs')
    entries.set(entry.id,entry)
  }
  await mkdir(config.output,{mode:0o700})
  const sessions=join(config.output,'sessions'),storage=join(config.output,'storage')
  await mkdir(sessions,{mode:0o700});await mkdir(storage,{mode:0o700})
  if(config.currentDatabase&&await exists(join(config.storageRoot,FEEDBACK))){
    assert.ok((await lstat(join(config.storageRoot,FEEDBACK))).isFile(),'unsafe feedback medium')
    await copyFile(join(config.storageRoot,FEEDBACK),join(storage,FEEDBACK))
  }
  const target=await mount(sdk,sessions,storage)
  let source=null
  const mappings=[],checked=new Map();let bytes=0
  try{
    if(config.currentDatabase)source=await mount(sdk,config.sessionRoot,config.storageRoot)
    // Validate current owned logs before modifying the staged feedback domain.
    for(const [id,c] of current){
      const session=await readSession(source.persistence,c,config.cwd)
      const directory=await sessionDirectory(config.sessionRoot,id)
      assert.ok(session?directory:!directory,'current session directory and log disagree')
      feedbackRow(sdk,source.table.get(id)??null,session?.header)
      checked.set(id,{c,session,directory})
    }
    for(const [id,c] of saved){
      const file=join(config.snapshot,id+'.json');bytes+=(await stat(file)).size
      assert.ok(bytes<=MAX_TOTAL,'chat snapshot exceeds total byte limit')
      const snapshot=await jsonFile(file),{session}=snapshot
      assert.ok(Object.hasOwn(snapshot,'feedback')&&Object.hasOwn(snapshot,'session'),'chat snapshot is incomplete')
      if(session){
        lifecycle(c,session.header,config.cwd)
        assert.ok(Array.isArray(session.events)&&session.events.length<=MAX_EVENTS,'invalid session event list')
      }else assert.ok(!c.ready,'ready session cannot have an absent snapshot')
      const feedback=feedbackRow(sdk,snapshot.feedback,session?.header)
      const existing=checked.get(id)
      if(existing){
        assert.equal(existing.c.owner,c.owner,'cannot restore another owner over a current session')
        const identity=v=>({id:v.id,owner:v.owner,requestId:v.requestId,createdAt:v.createdAt,parent:v.parent??null})
        assert.deepEqual(identity(existing.c),identity(c),'conversation creation identity differs')
        if(session&&existing.session)assert.deepEqual(session.header,existing.session.header,'cannot restore a different session lifecycle')
      }else if(source){
        assert.ok(!await source.persistence.stat(id)&&!await sessionDirectory(config.sessionRoot,id)&&!source.table.get(id),'unowned session or feedback collides with restore')
      }
      let directory=null
      if(session){
        const handle=await target.persistence.create(session.header,{inheritedEventCount:session.inheritedEventCount})
        try{await handle.append(session.events);await handle.flush()}finally{await handle.close()}
        const verified=await readSession(target.persistence,c,config.cwd)
        assert.deepEqual(verified,session,'native restored log differs')
        directory=await sessionDirectory(sessions,id);assert.ok(directory,'native restored directory is missing')
      }
      if(feedback===null)await target.table.delete(id)
      else await target.table.put(id,feedback)
      if(source){
        if(directory&&existing?.directory)assert.equal(directory,existing.directory,'native session directory changed')
        if(directory||existing?.directory)mappings.push({source:directory?join('sessions',directory):null,target:directory??existing.directory})
      }
    }
    for(const [id,item] of checked){
      if(saved.has(id))continue
      await target.table.delete(id)
      if(item.directory)mappings.push({source:null,target:item.directory})
    }
    // Other plugin/user rows come from the current domain, never from the backup.
    if(source)for(const [id,row] of source.table.entries())if(!current.has(id)&&!saved.has(id))assert.deepEqual(target.table.get(id),row,'unrelated feedback changed')
    await save(join(config.output,'result.json'),{schemaVersion:1,sessions:saved.size,mappings,feedback:await exists(join(storage,FEEDBACK))?join('storage',FEEDBACK):null})
    return{sessions:saved.size,mappings}
  }finally{await source?.close();await target.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  try{
    const request=await jsonFile('/work/request.json')
    assert.ok(['export','stage'].includes(request.operation),'unsupported offline operation')
    const result=await(request.operation==='export'?exportChat:stageChat)(request.config)
    process.stdout.write(JSON.stringify({ok:true,sessions:result.sessions})+'\n')
  }catch(error){process.stderr.write('Chat snapshot failed: '+error.message+'\n');process.exitCode=1}
}
