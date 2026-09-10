import {randomUUID} from 'node:crypto'
import {digest} from './store.mjs'
import {invariant} from './settings.mjs'
import {queryConversationIndex} from '@dsh-plugin-manager/plugin-kit'

/** Ownership and operation index; messages remain in official Session logs. */
export class ChatStore {
  constructor(store) {
    this.store=store;this.db=store.db
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,requestId TEXT NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner,requestId));
      CREATE INDEX IF NOT EXISTS chat_owner ON conversations(owner,updated DESC);
      CREATE TABLE IF NOT EXISTS chat_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,inputHash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner,requestId));
      CREATE TABLE IF NOT EXISTS chat_results(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,operationId TEXT NOT NULL,data TEXT NOT NULL);`)
    for(const row of this.db.prepare('SELECT id,data FROM chat_requests').all()){
      const request=JSON.parse(row.data)
      if(['queued','running','stopping'].includes(request.status))this.updateRequest(row.id,{status:'interrupted',message:'服务已重启；已保存的对话可以继续'})
    }
    this.db.exec("UPDATE conversations SET data=json_set(data,'$.removalState','failed') WHERE json_extract(data,'$.removalState')='pending'")
  }
  id(value){invariant(typeof value==='string'&&/^[\w-]{8,100}$/.test(value),'请求标识无效');return value}
  create(owner,requestId,initial={}) {
    this.id(requestId)
    const old=this.db.prepare('SELECT data FROM conversations WHERE owner=? AND requestId=?').get(owner,requestId)
    if(old)return this.get(owner,JSON.parse(old.data).id)
    const value={id:'blog-chat-'+randomUUID(),owner,requestId,title:'新对话',titleSource:initial.title?'manual':'automatic',ready:false,pinned:false,deletedAt:null,createdAt:Date.now(),updatedAt:Date.now(),parent:null,attachments:[],...initial}
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(value.id,owner,requestId,value.updatedAt,JSON.stringify(value));return value
  }
  get(owner,id){const value=this.record(owner,id);invariant(!value.deletedAt&&!value.removalState,'对话不存在或无权访问',404);return value}
  record(owner,id){const row=this.db.prepare('SELECT data FROM conversations WHERE owner=? AND id=?').get(owner,id);invariant(row,'对话不存在或无权访问',404);return{removalState:'',...JSON.parse(row.data)}}
  mark(owner,id,removalState){const value=this.record(owner,id);value.removalState=removalState;if(removalState==='removed')value.deletedAt??=Date.now();this.db.prepare('UPDATE conversations SET data=? WHERE id=? AND owner=?').run(JSON.stringify(value),id,owner)}
  managed(owner,query,archived,busy){return queryConversationIndex(this.db,"SELECT id,json_extract(data,'$.title') AS title,updated AS updatedAt,json_extract(data,'$.deletedAt') AS deletedAt,COALESCE(json_extract(data,'$.removalState'),'') AS removalState FROM conversations WHERE owner=? AND json_extract(data,'$.ready')=1",[owner],query,archived,busy)}
  pendingOperations(){return this.db.prepare("SELECT DISTINCT json_extract(data,'$.chat.conversationId') AS id FROM operations WHERE json_extract(data,'$.status') IN ('running','uncertain') OR (json_extract(data,'$.status')='prepared' AND json_extract(data,'$.expiresAt')>?)").all(Date.now()).map(row=>row.id).filter(Boolean)}
  save(owner,id,patch){const old=this.get(owner,id),value={...old,...patch,id,owner,updatedAt:Date.now()};this.db.prepare('UPDATE conversations SET updated=?,data=? WHERE id=? AND owner=?').run(value.updatedAt,JSON.stringify(value),id,owner);return value}
  /** Automatic titles preserve manual names; trusted user renames can update them again. */
  syncTitle(id,title,manual=false,complete=false){
    return this.db.prepare("UPDATE conversations SET data=json_set(data,'$.title',?,'$.titleSource',?) WHERE id=? AND json_extract(data,'$.ready')=1 AND json_extract(data,'$.deletedAt') IS NULL AND COALESCE(json_extract(data,'$.removalState'),'')='' AND (json_extract(data,'$.titleSource')='automatic' OR ?=1)")
      .run(title,manual?'manual':complete?'generated':'automatic',id,manual?1:0).changes>0
  }
  list(owner,offset=0,query=''){
    invariant(Number.isSafeInteger(offset)&&offset>=0,'分页参数无效')
    invariant(typeof query==='string'&&query.length<=120,'搜索文字应不超过 120 个字符')
    const items=this.db.prepare("SELECT data FROM conversations WHERE owner=? AND json_extract(data,'$.deletedAt') IS NULL AND COALESCE(json_extract(data,'$.removalState'),'')='' AND instr(lower(json_extract(data,'$.title')),lower(?))>0 ORDER BY COALESCE(json_extract(data,'$.pinned'),0) DESC,updated DESC,id LIMIT 31 OFFSET ?").all(owner,query.trim(),offset).map(r=>JSON.parse(r.data))
    return{items:items.slice(0,30).map(({id,title,updatedAt,ready,pinned})=>({id,title,updatedAt,ready,pinned:!!pinned})),nextOffset:items.length>30?offset+30:null}
  }
  mutate(owner,input,assertIdle=()=>{}){
    invariant(input&&['rename','pin','delete'].includes(input.operation)&&Array.isArray(input.ids)&&input.ids.length>0&&input.ids.length<=100&&input.ids.every(id=>typeof id==='string')&&new Set(input.ids).size===input.ids.length,'对话操作无效')
    invariant(input.operation==='delete'||input.ids.length===1,'请选择一条对话')
    if(input.operation==='rename')invariant(typeof input.title==='string'&&input.title.trim()&&input.title.trim().length<=100,'标题应为 1–100 个字符')
    if(input.operation==='pin')invariant(typeof input.pinned==='boolean','置顶参数无效')
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const items=input.ids.map(id=>this.get(owner,id))
      for(const item of items)assertIdle(item.id)
      const patch=input.operation==='rename'?{title:input.title.trim(),titleSource:'manual'}:input.operation==='pin'?{pinned:input.pinned}:{deletedAt:Date.now()}
      for(const item of items)this.db.prepare('UPDATE conversations SET data=? WHERE id=? AND owner=?').run(JSON.stringify({...item,...patch}),item.id,owner)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  assertScope(owner,id){return typeof id==='string'&&id.startsWith('blog-chat-')?this.get(owner,id):this.store.get(owner,id)}
  request(owner,id){const row=this.db.prepare('SELECT data FROM chat_requests WHERE owner=? AND id=?').get(owner,id);invariant(row,'对话请求不存在或无权访问',404);return JSON.parse(row.data)}
  requests(owner,conversationId,includeRemoved=false){includeRemoved?this.record(owner,conversationId):this.get(owner,conversationId);return this.db.prepare('SELECT data FROM chat_requests WHERE owner=? AND conversationId=? ORDER BY rowid').all(owner,conversationId).map(r=>JSON.parse(r.data))}
  start(owner,conversationId,requestId,input) {
    this.id(requestId);this.get(owner,conversationId)
    const hash=digest({conversationId,...input}),old=this.db.prepare('SELECT inputHash,data FROM chat_requests WHERE owner=? AND requestId=?').get(owner,requestId)
    if(old){invariant(old.inputHash===hash,'相同请求标识不能更改问题或附件',409);return{request:JSON.parse(old.data),fresh:false}}
    invariant(!this.requests(owner,conversationId).some(r=>['queued','running','stopping'].includes(r.status)),'此对话正在另一页面回答，请等待或停止当前任务',409)
    const request={id:randomUUID(),owner,conversationId,requestId,input,status:'queued',createdAt:Date.now(),operationId:input.operationId??randomUUID(),draftId:null,sources:[],attachments:[],userSeq:null}
    this.db.prepare('INSERT INTO chat_requests VALUES(?,?,?,?,?,?)').run(request.id,owner,conversationId,requestId,hash,JSON.stringify(request));return{request,fresh:true}
  }
  updateRequest(id,patch){const row=this.db.prepare('SELECT data FROM chat_requests WHERE id=?').get(id);invariant(row,'对话请求不存在',404);const value={...JSON.parse(row.data),...patch,id,updatedAt:Date.now()};this.db.prepare('UPDATE chat_requests SET data=? WHERE id=?').run(JSON.stringify(value),id);return value}
  operationDraft(owner,operationId){const row=this.db.prepare('SELECT data FROM chat_requests WHERE owner=? ORDER BY rowid DESC').all(owner).map(r=>JSON.parse(r.data)).find(r=>r.operationId===operationId&&r.draftId);return row?.draftId??null}
  result(owner,request,kind,draft) {
    const value={id:randomUUID(),kind,draftId:draft.id,revision:draft.revision,title:draft.title,proposal:draft.proposal?structuredClone(draft.proposal):null,createdAt:Date.now()}
    this.db.prepare('INSERT INTO chat_results VALUES(?,?,?,?,?,?)').run(value.id,owner,request.conversationId,request.id,request.operationId,JSON.stringify(value));return value
  }
  results(owner,conversationId){this.get(owner,conversationId);return this.db.prepare('SELECT requestId,data FROM chat_results WHERE owner=? AND conversationId=? ORDER BY rowid').all(owner,conversationId).map(r=>({...JSON.parse(r.data),requestId:r.requestId}))}
  historyAttachment(owner,conversationId,requestId,attachmentId){const conversation=this.get(owner,conversationId);const request=this.request(owner,requestId);const inherited=conversation.attachments?.find(a=>a.requestId===requestId&&a.id===attachmentId);invariant(request.conversationId===conversationId||inherited,'资料不属于当前对话',404);const attachment=request.attachments.find(a=>a.id===attachmentId);invariant(attachment,'此消息没有这份资料',404);return structuredClone(attachment)}
}
