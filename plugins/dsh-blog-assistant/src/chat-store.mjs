import {randomUUID} from 'node:crypto'
import {digest} from './store.mjs'
import {invariant} from './settings.mjs'

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
  }
  id(value){invariant(typeof value==='string'&&/^[\w-]{8,100}$/.test(value),'请求标识无效');return value}
  create(owner,requestId,initial={}) {
    this.id(requestId)
    const old=this.db.prepare('SELECT data FROM conversations WHERE owner=? AND requestId=?').get(owner,requestId)
    if(old)return JSON.parse(old.data)
    const value={id:'blog-chat-'+randomUUID(),owner,requestId,title:'新对话',ready:false,createdAt:Date.now(),updatedAt:Date.now(),parent:null,attachments:[],...initial}
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(value.id,owner,requestId,value.updatedAt,JSON.stringify(value));return value
  }
  get(owner,id){const row=this.db.prepare('SELECT data FROM conversations WHERE owner=? AND id=?').get(owner,id);invariant(row,'对话不存在或无权访问',404);return JSON.parse(row.data)}
  save(owner,id,patch){const old=this.get(owner,id),value={...old,...patch,id,owner,updatedAt:Date.now()};this.db.prepare('UPDATE conversations SET updated=?,data=? WHERE id=? AND owner=?').run(value.updatedAt,JSON.stringify(value),id,owner);return value}
  list(owner,offset=0){invariant(Number.isSafeInteger(offset)&&offset>=0,'分页参数无效');const items=this.db.prepare('SELECT data FROM conversations WHERE owner=? ORDER BY updated DESC,id LIMIT 31 OFFSET ?').all(owner,offset).map(r=>JSON.parse(r.data));return{items:items.slice(0,30).map(({id,title,updatedAt,ready})=>({id,title,updatedAt,ready})),nextOffset:items.length>30?offset+30:null}}
  assertScope(owner,id){return typeof id==='string'&&id.startsWith('blog-chat-')?this.get(owner,id):this.store.get(owner,id)}
  request(owner,id){const row=this.db.prepare('SELECT data FROM chat_requests WHERE owner=? AND id=?').get(owner,id);invariant(row,'对话请求不存在或无权访问',404);return JSON.parse(row.data)}
  requests(owner,conversationId){this.get(owner,conversationId);return this.db.prepare('SELECT data FROM chat_requests WHERE owner=? AND conversationId=? ORDER BY rowid').all(owner,conversationId).map(r=>JSON.parse(r.data))}
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
