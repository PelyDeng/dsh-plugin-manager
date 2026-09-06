/** Ownership index only; message content remains in the DSH session event log. */
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as llm from '@deepseek-ai/dsh-llm'
import { AccessError, actorKey, type Actor } from '@dsh-plugin/plugin-kit'

export class HistoryStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported example history schema') }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        title TEXT NOT NULL, updatedAt INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS history_owner ON conversations(owner,updatedAt DESC,id);
      PRAGMA user_version=1;`)
  }
  /** Reserve ownership before creating a DSH session; failed creations stay unpublished. */
  reserve(id: string, actor: Actor, title: string): void {
    this.db.prepare('INSERT INTO conversations(id,owner,title,updatedAt) VALUES(?,?,?,?)').run(id, actorKey(actor), title.slice(0, 80), Date.now())
  }
  publish(id: string): void { this.db.prepare('UPDATE conversations SET ready=1,updatedAt=? WHERE id=?').run(Date.now(), id) }
  assertOwner(id: string, actor: Actor): void {
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner=? AND ready=1').get(id, actorKey(actor))) {
      throw new AccessError(404, '会话不存在或无权访问')
    }
  }
  list(actor: Actor, offset: number, limit: number): unknown[] {
    return this.db.prepare('SELECT id,title,updatedAt FROM conversations WHERE owner=? AND ready=1 ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?')
      .all(actorKey(actor), limit, offset)
  }
  close(): void { this.db.close() }
}

/** Project model reasoning and answer text, retaining durable interrupted output. */
export function projectHistory(events: readonly SessionEvent[]): { role: 'user' | 'assistant'; text: string; reasoning?: string }[] {
  const messages: { role: 'user' | 'assistant'; text: string; reasoning?: string }[] = []
  let answer: { role: 'assistant'; text: string; reasoning?: string } | undefined
  const current = () => { if (!answer) { answer = { role: 'assistant', text: '' }; messages.push(answer) } return answer }
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      messages.push({ role: 'user', text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('') })
      answer = undefined
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') current().text += event.data.chunk.text
    else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'reasoning-delta') current().reasoning = (current().reasoning ?? '') + event.data.chunk.text
    else if (event.type === 'assistant/message') {
      current().text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const reasoning = event.data.message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
      if (reasoning) current().reasoning = reasoning
    }
    else if ((event.type as string) === 'assistant/attempt') {
      // Decode the installed runtime's durable format through its public API.
      const runtime = llm as unknown as { expandAssistantStream?: (stream: unknown) => readonly { chunk: llm.StreamChunk }[] }
      if (!runtime.expandAssistantStream) throw new Error('The DSH runtime cannot read its assistant attempt stream')
      const { stream } = event.data as unknown as { stream: unknown }
      const chunks = runtime.expandAssistantStream(stream)
      current().text = chunks.map(({ chunk }) => chunk.type === 'text-delta' ? chunk.text : '').join('')
      const reasoning = chunks.map(({ chunk }) => chunk.type === 'reasoning-delta' ? chunk.text : '').join('')
      if (reasoning) current().reasoning = reasoning
    }
  }
  return messages.filter(message => message.text !== '' || message.reasoning)
}
