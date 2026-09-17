import {randomUUID} from 'node:crypto'
import {mkdirSync,chmodSync} from 'node:fs'
import {dirname} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {digest} from './store.mjs'
import {invariant} from './settings.mjs'
import {queryConversationIndex} from '@dsh-plugin-manager/plugin-kit'

/** 一条对话索引记录（`conversations.data` 列里的 JSON）。 */
export interface ChatConversation {
  id: string
  owner: string
  requestId: string
  title: string
  titleSource: 'automatic' | 'generated' | 'manual'
  ready: boolean
  pinned: boolean
  deletedAt: number | null
  createdAt: number
  updatedAt: number
  parent: string | null
  attachments: readonly ChatAttachmentRef[]
  /** 删除围栏标记；缺省（未标记）按空串处理。 */
  removalState?: string
  [key: string]: unknown
}

/** 对话携带的资料引用（继承自各轮请求）。 */
export interface ChatAttachmentRef {
  readonly requestId: string
  readonly id: string
}

/** 一条对话请求记录（`chat_requests.data` 列里的 JSON）。 */
export interface ChatRequestRecord {
  id: string
  owner: string
  conversationId: string
  requestId: string
  input: Record<string, unknown>
  status: string
  createdAt: number
  operationId: string
  draftId: string | null
  sources: readonly unknown[]
  attachments: readonly ChatAttachmentRef[]
  userSeq: number | null
  [key: string]: unknown
}

/** 侧栏一项（对外只暴露这几个字段）。 */
export interface ChatListItem {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly ready: boolean
  readonly pinned: boolean
}

/** 「对话操作」的入参（改名 / 置顶 / 删除）。 */
export interface ChatMutationInput {
  readonly operation: string
  readonly ids: readonly string[]
  readonly title?: string
  readonly pinned?: boolean
}

/**
 * Ownership and operation index; messages remain in official Session logs.
 *
 * 批 2 拆库后本库独立打开 blog.sqlite（索引 3 表 + participant 侧映射表），不再共享业务库：
 * 旧文件缺业务表时索引功能完好。`pendingOperations` 改为进程内镜像（四耦合点之 2）——
 * `pending` 由装载方注入（写路径维护 + 启动从业务存储恢复一次），满足 kit 的同步布尔契约。
 *
 * ## ⚠️ `syncTitle` 的返回值必须**同步**可得（这条是硬约束，不是风格）
 *
 * `chat.ts` 的标题回调是**同步**的（`registerConversationTitles` 的回调不能 await），它用
 * `syncTitle(...)` 的返回值决定"要不要广播 changed"：
 *
 * ```ts
 * if (index.syncTitle(id, title, manual, complete)) this.emit(id, { type: 'changed' })
 * ```
 *
 * 所以这个返回值**只能来自本地同步状态**（本文件是同步 SQLite，满足）。
 * ⚠️ 将来把索引库切到 PG 时，**不能**把这个方法改成 `async`：那样返回值会变成恒真的
 * Promise（truthy），"标题变了才广播"会**静默**退化成"总是广播"。
 * 正确方向与运行时的 `TitleSink` 同形：**同步更新本地镜像 + 投递到本队列**，返回值取自
 * 本地那一步；后台按 FIFO 补写 PG（见 `packages/runtime/src/storage/index.ts` 的 `titleSink()`）。
 */
export class ChatStore {
  readonly db: DatabaseSync
  private readonly pendingSource: () => readonly string[]

  /** @param path 索引库文件路径（':memory:' 为内存库）
   *  @param pendingOperations 待核对会话 id 的同步镜像读取（四耦合点之 2） */
  constructor(path: string, pendingOperations: () => readonly string[] = () => []) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    this.pendingSource = pendingOperations
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,requestId TEXT NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner,requestId));
      CREATE INDEX IF NOT EXISTS chat_owner ON conversations(owner,updated DESC);
      CREATE TABLE IF NOT EXISTS chat_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,inputHash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner,requestId));
      CREATE TABLE IF NOT EXISTS chat_results(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,operationId TEXT NOT NULL,data TEXT NOT NULL);`)
    for(const row of this.db.prepare('SELECT id,data FROM chat_requests').all()){
      const request=JSON.parse(String(row!.data)) as ChatRequestRecord
      if(['queued','running','stopping'].includes(request.status))this.updateRequest(String(row.id),{status:'interrupted',message:'服务已重启；已保存的对话可以继续'})
    }
    this.db.exec("UPDATE conversations SET data=json_set(data,'$.removalState','failed') WHERE json_extract(data,'$.removalState')='pending'")
  }
  close(): void {this.db.close()}
  id(value: unknown): string {invariant(typeof value==='string'&&/^[\w-]{8,100}$/.test(value),'请求标识无效');return value as string}
  create(owner: string,requestId: string,initial: Partial<ChatConversation>={}): ChatConversation {
    this.id(requestId)
    const old=this.db.prepare('SELECT data FROM conversations WHERE owner=? AND requestId=?').get(owner,requestId)
    if(old)return this.get(owner,(JSON.parse(String(old.data)) as ChatConversation).id)
    const value: ChatConversation={id:'blog-chat-'+randomUUID(),owner,requestId,title:'新对话',titleSource:initial.title?'manual':'automatic',ready:false,pinned:false,deletedAt:null,createdAt:Date.now(),updatedAt:Date.now(),parent:null,attachments:[],...initial}
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(value.id,owner,requestId,value.updatedAt,JSON.stringify(value));return value
  }
  get(owner: string,id: string): ChatConversation {const value=this.record(owner,id);invariant(!value.deletedAt&&!value.removalState,'对话不存在或无权访问',404);return value}
  record(owner: string,id: string): ChatConversation {const row=this.db.prepare('SELECT data FROM conversations WHERE owner=? AND id=?').get(owner,id);invariant(row,'对话不存在或无权访问',404);return{removalState:'',...(JSON.parse(String(row!.data)) as ChatConversation)}}
  mark(owner: string,id: string,removalState: string): void {const value=this.record(owner,id);value.removalState=removalState;if(removalState==='removed')value.deletedAt??=Date.now();this.db.prepare('UPDATE conversations SET data=? WHERE id=? AND owner=?').run(JSON.stringify(value),id,owner)}
  managed(owner: string,query: unknown,archived: readonly string[],busy: readonly string[]) {return queryConversationIndex(this.db,"SELECT id,json_extract(data,'$.title') AS title,updated AS updatedAt,json_extract(data,'$.deletedAt') AS deletedAt,COALESCE(json_extract(data,'$.removalState'),'') AS removalState FROM conversations WHERE owner=? AND json_extract(data,'$.ready')=1",[owner],query as never,archived,busy)}
  pendingOperations(): readonly string[] {return this.pendingSource()}
  save(owner: string,id: string,patch: Partial<ChatConversation>): ChatConversation {const old=this.get(owner,id),value={...old,...patch,id,owner,updatedAt:Date.now()} as ChatConversation;this.db.prepare('UPDATE conversations SET updated=?,data=? WHERE id=? AND owner=?').run(value.updatedAt,JSON.stringify(value),id,owner);return value}
  /**
   * Automatic titles preserve manual names; trusted user renames can update them again.
   *
   * ⚠️ 返回值是「这次调用**真的**写进去了吗」，它**必须同步可得**——调用方（`chat.ts` 的标题
   * 回调）是同步的，用它在"标题变了才广播"里做判断。改成异步（返回 Promise）会让那个判断恒真、
   * 静默退化成"总是广播"。详见类注释。
   */
  syncTitle(id: string,title: string,manual=false,complete=false): boolean {
    return this.db.prepare("UPDATE conversations SET data=json_set(data,'$.title',?,'$.titleSource',?) WHERE id=? AND json_extract(data,'$.ready')=1 AND json_extract(data,'$.deletedAt') IS NULL AND COALESCE(json_extract(data,'$.removalState'),'')='' AND (json_extract(data,'$.titleSource')='automatic' OR ?=1)")
      .run(title,manual?'manual':complete?'generated':'automatic',id,manual?1:0).changes>0
  }
  list(owner: string,offset=0,query=''): {items: readonly ChatListItem[];nextOffset: number | null} {
    invariant(Number.isSafeInteger(offset)&&offset>=0,'分页参数无效')
    invariant(typeof query==='string'&&query.length<=120,'搜索文字应不超过 120 个字符')
    const items=this.db.prepare("SELECT data FROM conversations WHERE owner=? AND json_extract(data,'$.deletedAt') IS NULL AND COALESCE(json_extract(data,'$.removalState'),'')='' AND instr(lower(json_extract(data,'$.title')),lower(?))>0 ORDER BY COALESCE(json_extract(data,'$.pinned'),0) DESC,updated DESC,id LIMIT 31 OFFSET ?").all(owner,query.trim(),offset).map(r=>JSON.parse(String(r.data)) as ChatConversation)
    return{items:items.slice(0,30).map(({id,title,updatedAt,ready,pinned})=>({id,title,updatedAt,ready,pinned:!!pinned})),nextOffset:items.length>30?offset+30:null}
  }
  mutate(owner: string,input: ChatMutationInput,assertIdle: (id: string) => void=()=>{}): void {
    invariant(input&&['rename','pin','delete'].includes(input.operation)&&Array.isArray(input.ids)&&input.ids.length>0&&input.ids.length<=100&&input.ids.every(id=>typeof id==='string')&&new Set(input.ids).size===input.ids.length,'对话操作无效')
    invariant(input.operation==='delete'||input.ids.length===1,'请选择一条对话')
    if(input.operation==='rename')invariant(typeof input.title==='string'&&input.title.trim()&&input.title.trim().length<=100,'标题应为 1–100 个字符')
    if(input.operation==='pin')invariant(typeof input.pinned==='boolean','置顶参数无效')
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const items=input.ids.map(id=>this.get(owner,id))
      for(const item of items)assertIdle(item.id)
      const patch: Partial<ChatConversation>=input.operation==='rename'?{title:(input.title as string).trim(),titleSource:'manual'}:input.operation==='pin'?{pinned:input.pinned as boolean}:{deletedAt:Date.now()}
      for(const item of items)this.db.prepare('UPDATE conversations SET data=? WHERE id=? AND owner=?').run(JSON.stringify({...item,...patch}),item.id,owner)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  /** 会话路径的 scope 校验（blog-chat-* 前缀判定，索引侧只管会话；草稿路径由业务存储核验）。 */
  assertScope(owner: string,id: string): ChatConversation {invariant(typeof id==='string'&&id.startsWith('blog-chat-'),'会话标识无效');return this.get(owner,id)}
  request(owner: string,id: string): ChatRequestRecord {const row=this.db.prepare('SELECT data FROM chat_requests WHERE owner=? AND id=?').get(owner,id);invariant(row,'对话请求不存在或无权访问',404);return JSON.parse(String(row!.data)) as ChatRequestRecord}
  hasRequest(owner: string,requestId: string): boolean {return this.db.prepare('SELECT id FROM chat_requests WHERE owner=? AND requestId=?').get(owner,requestId)!==undefined}
  requests(owner: string,conversationId: string,includeRemoved=false): readonly ChatRequestRecord[] {includeRemoved?this.record(owner,conversationId):this.get(owner,conversationId);return this.db.prepare('SELECT data FROM chat_requests WHERE owner=? AND conversationId=? ORDER BY rowid').all(owner,conversationId).map(r=>JSON.parse(String(r.data)) as ChatRequestRecord)}
  start(owner: string,conversationId: string,requestId: string,input: Record<string, unknown>): {request: ChatRequestRecord;fresh: boolean} {
    this.id(requestId);this.get(owner,conversationId)
    const hash=digest({conversationId,...input}),old=this.db.prepare('SELECT inputHash,data FROM chat_requests WHERE owner=? AND requestId=?').get(owner,requestId)
    if(old){invariant(old.inputHash===hash,'相同请求标识不能更改问题或附件',409);return{request:JSON.parse(String(old.data)) as ChatRequestRecord,fresh:false}}
    invariant(!this.requests(owner,conversationId).some(r=>['queued','running','stopping'].includes(r.status)),'此对话正在另一页面回答，请等待或停止当前任务',409)
    const request: ChatRequestRecord={id:randomUUID(),owner,conversationId,requestId,input,status:'queued',createdAt:Date.now(),operationId:(input.operationId as string|undefined)??randomUUID(),draftId:null,sources:[],attachments:[],userSeq:null}
    this.db.prepare('INSERT INTO chat_requests VALUES(?,?,?,?,?,?)').run(request.id,owner,conversationId,requestId,hash,JSON.stringify(request));return{request,fresh:true}
  }
  updateRequest(id: string,patch: Record<string, unknown>): ChatRequestRecord {const row=this.db.prepare('SELECT data FROM chat_requests WHERE id=?').get(id);invariant(row,'对话请求不存在',404);const value={...(JSON.parse(String(row!.data)) as ChatRequestRecord),...patch,id,updatedAt:Date.now()} as ChatRequestRecord;this.db.prepare('UPDATE chat_requests SET data=? WHERE id=?').run(JSON.stringify(value),id);return value}
  operationDraft(owner: string,operationId: string): string | null {const row=this.db.prepare('SELECT data FROM chat_requests WHERE owner=? ORDER BY rowid DESC').all(owner).map(r=>JSON.parse(String(r.data)) as ChatRequestRecord).find(r=>r.operationId===operationId&&r.draftId);return row?.draftId??null}
  result(owner: string,request: ChatRequestRecord,kind: string,draft: {id: string;revision: unknown;title: string;proposal?: unknown}) {
    const value={id:randomUUID(),kind,draftId:draft.id,revision:draft.revision,title:draft.title,proposal:draft.proposal?structuredClone(draft.proposal):null,createdAt:Date.now()}
    this.db.prepare('INSERT INTO chat_results VALUES(?,?,?,?,?,?)').run(value.id,owner,request.conversationId,request.id,request.operationId,JSON.stringify(value));return value
  }
  results(owner: string,conversationId: string): readonly (Record<string, unknown> & {requestId: string})[] {this.get(owner,conversationId);return this.db.prepare('SELECT requestId,data FROM chat_results WHERE owner=? AND conversationId=? ORDER BY rowid').all(owner,conversationId).map(r=>({...(JSON.parse(String(r.data)) as Record<string, unknown>),requestId:String(r.requestId)}))}
  historyAttachment(owner: string,conversationId: string,requestId: string,attachmentId: string): unknown {const conversation=this.get(owner,conversationId);const request=this.request(owner,requestId);const inherited=conversation.attachments?.find(a=>a.requestId===requestId&&a.id===attachmentId);invariant(request.conversationId===conversationId||inherited,'资料不属于当前对话',404);const attachment=request.attachments.find(a=>a.id===attachmentId);invariant(attachment,'此消息没有这份资料',404);return structuredClone(attachment)}
}
