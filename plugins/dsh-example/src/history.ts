/** Ownership index only; message content remains in the DSH session event log. */
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as llm from '@deepseek-ai/dsh-llm'
import { AccessError, actorKey, queryConversationIndex, type Actor, type ConversationRecord, type ConversationQuery } from '@dsh-plugin-manager/plugin-kit'

export class HistoryStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4) { this.db.close(); throw new Error('Unsupported example history schema') }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        title TEXT NOT NULL, updatedAt INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,deletedAt INTEGER);
      CREATE INDEX IF NOT EXISTS history_owner ON conversations(owner,updatedAt DESC,id);
      `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if(version===1)this.db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0; ALTER TABLE conversations ADD COLUMN deletedAt INTEGER;')
      if (version !== 3 && version !== 4) this.db.exec("ALTER TABLE conversations ADD COLUMN removalState TEXT NOT NULL DEFAULT '';")
      if (version !== 4) this.db.exec("ALTER TABLE conversations ADD COLUMN titleSource TEXT NOT NULL DEFAULT 'manual';")
      this.db.exec("UPDATE conversations SET removalState='failed' WHERE removalState='pending'; PRAGMA user_version=4; COMMIT;")
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
  }
  /** Reserve ownership before creating a DSH session; failed creations stay unpublished. */
  reserve(id: string, actor: Actor, title: string, titleSource: 'automatic' | 'manual' = 'automatic'): void {
    this.db.prepare('INSERT INTO conversations(id,owner,title,updatedAt,titleSource) VALUES(?,?,?,?,?)').run(id, actorKey(actor), [...title.replace(/\s+/gu, ' ').trim()].slice(0, 100).join('').trim(), Date.now(), titleSource)
  }
  /** Host events update existing ownership only; completed and manual titles fence later automation. */
  syncTitle(id: string, title: string, manual: boolean, complete: boolean): boolean {
    const normalized = [...title.replace(/\s+/gu, ' ').trim()].slice(0, 100).join('').trim()
    if (!normalized) return false
    return this.db.prepare("UPDATE conversations SET title=?,titleSource=? WHERE id=? AND owner!='' AND ready=1 AND deletedAt IS NULL AND removalState='' AND (titleSource='automatic' OR ?=1)")
      .run(normalized, manual ? 'manual' : complete ? 'generated' : 'automatic', id, manual ? 1 : 0).changes > 0
  }
  publish(id: string): void { this.db.prepare('UPDATE conversations SET ready=1,updatedAt=? WHERE id=?').run(Date.now(), id) }
  assertOwner(id: string, actor: Actor): void {
    if (!this.db.prepare("SELECT 1 FROM conversations WHERE id=? AND owner=? AND ready=1 AND deletedAt IS NULL AND removalState='' ").get(id, actorKey(actor))) {
      throw new AccessError(404, '会话不存在或无权访问')
    }
  }
  list(actor: Actor, offset: number, limit: number, query=''): unknown[] {
    return this.db.prepare("SELECT id,title,titleSource,updatedAt,pinned FROM conversations WHERE owner=? AND ready=1 AND deletedAt IS NULL AND removalState='' AND instr(lower(title),lower(?))>0 ORDER BY pinned DESC,updatedAt DESC,id LIMIT ? OFFSET ?")
      .all(actorKey(actor), query, limit, offset)
  }
  record(actor: Actor, id: string): ConversationRecord {
    const row = this.db.prepare('SELECT id,title,updatedAt,deletedAt,removalState FROM conversations WHERE id=? AND owner=? AND ready=1').get(id, actorKey(actor))
    if (!row) throw new AccessError(404, '会话不存在或无权访问')
    return row as unknown as ConversationRecord
  }
  mark(actor: Actor, id: string, state: 'pending' | 'failed' | 'removed'): void {
    this.record(actor, id)
    this.db.prepare("UPDATE conversations SET removalState=?,deletedAt=CASE WHEN ?='removed' THEN COALESCE(deletedAt,?) ELSE deletedAt END WHERE id=? AND owner=?").run(state,state,Date.now(),id,actorKey(actor))
  }
  managed(actor: Actor, query: ConversationQuery, archived: readonly string[], busy: readonly string[]) {
    return queryConversationIndex(this.db, 'SELECT id,title,updatedAt,deletedAt,removalState FROM conversations WHERE owner=? AND ready=1', [actorKey(actor)], query, archived, busy)
  }
  mutate(actor:Actor,input:{operation:string;ids:string[];title?:string;pinned?:boolean}):void {
    if(!['rename','pin','delete'].includes(input.operation)||!Array.isArray(input.ids)||!input.ids.length||input.ids.length>100||input.ids.some(id=>typeof id!=='string')||new Set(input.ids).size!==input.ids.length)throw new AccessError(400,'对话操作无效')
    if(input.operation!=='delete'&&input.ids.length!==1)throw new AccessError(400,'请选择一条对话')
    if(input.operation==='rename'&&(typeof input.title!=='string'||!input.title.trim()||[...input.title.trim()].length>100))throw new AccessError(400,'标题应为 1–100 个字符')
    if(input.operation==='pin'&&typeof input.pinned!=='boolean')throw new AccessError(400,'置顶参数无效')
    this.db.exec('BEGIN IMMEDIATE')
    try{
      for(const id of input.ids)this.assertOwner(id,actor)
      for(const id of input.ids){
        if(input.operation==='rename')this.db.prepare("UPDATE conversations SET title=?,titleSource='manual' WHERE id=?").run(input.title!.trim(),id)
        if(input.operation==='pin')this.db.prepare('UPDATE conversations SET pinned=? WHERE id=?').run(input.pinned?1:0,id)
        if(input.operation==='delete')this.db.prepare('UPDATE conversations SET deletedAt=? WHERE id=?').run(Date.now(),id)
      }
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  close(): void { this.db.close() }
}

/** Project model reasoning and answer text, retaining durable interrupted output. */
export function projectHistory(events: readonly SessionEvent[]): { role: 'user' | 'assistant'; text: string; reasoning?: string;reasoningSource?:string;turn?:number }[] {
  const messages: { role: 'user' | 'assistant'; text: string; reasoning?: string;reasoningSource?:string;turn?:number }[] = []
  let answer: { role: 'assistant'; text: string; reasoning?: string;reasoningSource?:string;turn?:number } | undefined,turn=-1
  const current = () => { if (!answer) { answer = { role: 'assistant', text: '',...(turn<0?{}:{turn}) }; messages.push(answer) } return answer }
  for (const event of events) {
    if(event.type==='turn/start')turn++
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      messages.push({ role: 'user', text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('') })
      answer = undefined
    } else if (event.type === 'assistant/message') {
      current().text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const reasoning = event.data.message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
      if (reasoning) { current().reasoning = reasoning; if(event.data.message.id)current().reasoningSource = String(event.data.message.id);else delete current().reasoningSource }
    }
    else if (event.type === 'assistant/attempt') {
      const chunks = llm.expandAssistantStream(event.data.stream)
      const assembler = new llm.BlockAssembler()
      for (const {chunk} of chunks) assembler.push(chunk)
      const blocks = assembler.blocks()
      current().text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      const reasoning = blocks.filter(block => block.type === 'reasoning').map(block => block.text).join('')
      if (reasoning) { current().reasoning = reasoning; if(Number.isSafeInteger(event.seq))current().reasoningSource = 'attempt-'+event.seq;else delete current().reasoningSource }
    }
  }
  return messages.filter(message => message.text !== '' || message.reasoning)
}
