/** Offline, scoped snapshot adapter for the locked official JSONL/zstd backend. */
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {mkdir,readFile,writeFile,stat,lstat,readdir,realpath} from 'node:fs/promises'

const ID=/^blog-chat-[a-f0-9-]{36}$/
const MAX_SESSIONS=10000,MAX_BYTES=64*1024*1024,MAX_EVENTS=100000,MAX_TOTAL=2*1024*1024*1024
// The manager's locked runtime retains pnpm's shared public-package links as well as root links.
const resolvers=[createRequire('/opt/dsh-runtime/package.json'),createRequire('/opt/dsh-runtime/node_modules/.pnpm/runtime-helper.cjs')]
export async function native(){
  const names=['cordis','dsh-session-persistence-jsonl','dsh-session','dsh-message-feedback','dsh-session-format-catalog','dsh-session-format-v2-to-v3']
  const modules=[]
  for(const name of names){
    const pkg='@deepseek-ai/'+name
    const require=resolvers.find(r=>{try{r.resolve(pkg+'/package.json');return true}catch{return false}})
    assert.ok(require,'official offline package is missing: '+pkg)
    const metadata=JSON.parse(await readFile(require.resolve(pkg+'/package.json'),'utf8'))
    assert.equal(metadata.version,name==='cordis'?'4.0.2':'0.1.5-alpha.2','offline runtime must match the locked host packages')
    modules.push(await import(pathToFileURL(require.resolve(pkg))))
  }
  const [cordis,persistence,session,feedback,formats,codecs]=modules
  const manager=createRequire('/opt/plugin-manager/package.json')
  const snapshots=await import(pathToFileURL(manager.resolve('@dsh-plugin-manager/plugin-manager/session-snapshot')))
  return{...cordis,persistence,session,feedback,formats,codecs,snapshots}
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
async function jsonFile(path,limit=MAX_BYTES){
  assert.ok((await lstat(path)).isFile()&&(await stat(path)).size<=limit,'snapshot file exceeds limit or is not a regular file')
  return JSON.parse(await readFile(path,'utf8'))
}
async function save(path,value){
  const data=JSON.stringify(value);assert.ok(Buffer.byteLength(data)<=MAX_BYTES,'session snapshot exceeds byte limit')
  await writeFile(path,data,{flag:'wx',mode:0o600});return Buffer.byteLength(data)
}
async function exists(path){try{await lstat(path);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
async function mount(sdk,sessionRoot){
  const ctx=new sdk.Context()
  try{
    await ctx.plugin(sdk.persistence.default,{root:sessionRoot,compression:'zstd'})
    await ctx.plugin(sdk.session.SessionStore)
    await ctx.plugin(sdk.feedback.default,{maxNoteBytes:8192})
    return{ctx,persistence:ctx.sessionPersistence,feedback:ctx.messageFeedback,close:()=>ctx.fiber.dispose()}
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
async function readSession(mounted,c,cwd){
  const service=mounted.persistence
  const known=await service.stat(c.id)
  if(!known){assert.ok(!c.ready,'indexed session log is missing');return null}
  assert.ok((known.sizeBytes??0)<=MAX_BYTES&&(known.eventCount??0)<=MAX_EVENTS,'session exceeds snapshot limits')
  lifecycle(c,known.header,cwd)
  const handle=await service.open(c.id,'read')
  try{
    lifecycle(c,handle.header,cwd)
    const {events}=await handle.read(0,MAX_EVENTS+1)
    assert.ok(events.length<=MAX_EVENTS,'session exceeds event limit')
    const feedback=await mounted.feedback.list({sessionId:c.id})
    assert.ok(feedback.ok,'session feedback is invalid')
    return{header:handle.header,inheritedEventCount:handle.inheritedEventCount,events}
  }finally{await handle.close()}
}
/** Restore the snapshot with the official released codec before creating current native logs. */
export function restoreSnapshot(sdk,session){
  const result=sdk.snapshots.restoreSessionSnapshot(session,formatOptions(sdk))
  assert.ok(result.events.length<=MAX_EVENTS,'migrated snapshot exceeds event limit')
  return result
}
const formatOptions=sdk=>({catalog:sdk.formats.sessionFormatCatalog,v2:sdk.codecs.releasedV2SessionFormatCodec,v3:sdk.codecs.releasedV3SessionFormatCodec})
export async function exportChat(config,sdk=undefined){
  sdk??=await native()
  const index=conversations(config.database)
  await mkdir(config.output,{mode:0o700})
  const service=await mount(sdk,config.sessionRoot),entries=[]
  let bytes=0
  try{
    for(const [id,c] of index){
      const session=await readSession(service,c,config.cwd)
      const directory=await sessionDirectory(config.sessionRoot,id)
      assert.ok(session?directory:!directory,'session directory and native log disagree')
      bytes+=await save(join(config.output,id+'.json'),{session})
      assert.ok(bytes<=MAX_TOTAL,'chat snapshot exceeds total byte limit')
      entries.push({id,owner:c.owner})
    }
    await save(join(config.output,'index.json'),{schemaVersion:2,cwd:config.cwd,entries})
    return{sessions:entries.length,bytes}
  }finally{await service.close()}
}
/** Generate new native logs including feedback in isolation. No live file is written here. */
export async function stageChat(config,sdk=undefined){
  sdk??=await native()
  const saved=conversations(config.database),current=config.currentDatabase?conversations(config.currentDatabase):new Map()
  const manifest=await jsonFile(join(config.snapshot,'index.json'))
  assert.ok([1,2].includes(manifest.schemaVersion)&&manifest.cwd===config.cwd&&Array.isArray(manifest.entries)&&manifest.entries.length===saved.size,'chat manifest and restored index differ')
  const entries=new Map()
  for(const entry of manifest.entries){
    assert.ok(ID.test(entry.id)&&!entries.has(entry.id)&&saved.get(entry.id)?.owner===entry.owner,'chat manifest ownership differs')
    entries.set(entry.id,entry)
  }
  await mkdir(config.output,{mode:0o700})
  const sessions=join(config.output,'sessions')
  await mkdir(sessions,{mode:0o700})
  const target=await mount(sdk,sessions)
  let source=null
  const mappings=[],checked=new Map();let bytes=0
  try{
    if(config.currentDatabase)source=await mount(sdk,config.sessionRoot)
    // Validate every currently owned log before staging replacements.
    for(const [id,c] of current){
      const session=await readSession(source,c,config.cwd)
      const directory=await sessionDirectory(config.sessionRoot,id)
      assert.ok(session?directory:!directory,'current session directory and log disagree')
      checked.set(id,{c,session,directory})
    }
    for(const [id,c] of saved){
      const file=join(config.snapshot,id+'.json');bytes+=(await stat(file)).size
      assert.ok(bytes<=MAX_TOTAL,'chat snapshot exceeds total byte limit')
      const snapshot=await jsonFile(file)
      let {session}=snapshot
      assert.ok(Object.hasOwn(snapshot,'session')&&(manifest.schemaVersion===2||Object.hasOwn(snapshot,'feedback')),'chat snapshot is incomplete')
      if(session){
        lifecycle(c,session.header,config.cwd)
        assert.ok(Array.isArray(session.events)&&session.events.length<=MAX_EVENTS,'invalid session event list')
        session=restoreSnapshot(sdk,session)
        if(manifest.schemaVersion===1)session=sdk.snapshots.mergeLegacyFeedback(session,snapshot.feedback,formatOptions(sdk))
        assert.ok(session.events.length<=MAX_EVENTS,'migrated snapshot exceeds event limit')
      }else assert.ok(!c.ready,'ready session cannot have an absent snapshot')
      assert.ok(session||snapshot.feedback==null,'absent session cannot have feedback')
      const existing=checked.get(id)
      if(existing){
        assert.equal(existing.c.owner,c.owner,'cannot restore another owner over a current session')
        const identity=v=>({id:v.id,owner:v.owner,requestId:v.requestId,createdAt:v.createdAt,parent:v.parent??null})
        assert.deepEqual(identity(existing.c),identity(c),'conversation creation identity differs')
        if(session&&existing.session)assert.deepEqual(session.header,existing.session.header,'cannot restore a different session lifecycle')
      }else if(source){
        assert.ok(!await source.persistence.stat(id)&&!await sessionDirectory(config.sessionRoot,id),'unowned session collides with restore')
      }
      let directory=null
      if(session){
        const handle=await target.persistence.create(session.header,{inheritedEventCount:session.inheritedEventCount})
        try{await handle.append(session.events);await handle.flush()}finally{await handle.close()}
        const verified=await readSession(target,c,config.cwd)
        assert.deepEqual(verified,session,'native restored log differs')
        directory=await sessionDirectory(sessions,id);assert.ok(directory,'native restored directory is missing')
      }
      if(source){
        if(directory&&existing?.directory)assert.equal(directory,existing.directory,'native session directory changed')
        if(directory||existing?.directory)mappings.push({source:directory?join('sessions',directory):null,target:directory??existing.directory})
      }
    }
    for(const [id,item] of checked){
      if(saved.has(id))continue
      if(item.directory)mappings.push({source:null,target:item.directory})
    }
    await save(join(config.output,'result.json'),{schemaVersion:1,sessions:saved.size,mappings,feedback:null})
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
