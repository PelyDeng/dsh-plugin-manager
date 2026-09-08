/** Business ownership and history index; DSH retains the conversation event log. */
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccessError, queryConversationIndex, type ConversationRecord, type ConversationQuery, type Actor } from '@dsh-plugin-manager/plugin-kit'

/** One owner-visible history item, without conversation content. */
export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** Persists ownership before creating a DSH session; incomplete rows stay inaccessible. */
export class ConversationStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close()
      throw new Error('Unsupported closedoff ownership schema version')
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner_namespace TEXT NOT NULL, owner_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0,1))
      );
      CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(owner_namespace, owner_id, updated_at DESC, id);
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (version !== 2) this.db.exec("ALTER TABLE conversations ADD COLUMN deletedAt INTEGER; ALTER TABLE conversations ADD COLUMN removalState TEXT NOT NULL DEFAULT '';")
      this.db.exec("UPDATE conversations SET removalState='failed' WHERE removalState='pending'; PRAGMA user_version=2; COMMIT;")
    } catch(error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
  }

  /** Reserve an immutable owner for a fresh server-generated id. */
  reserve(id: string, actor: Actor): void {
    const now = Date.now()
    this.db.prepare('INSERT INTO conversations(id,owner_namespace,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, actor.namespace, actor.userId, now, now)
  }

  /** Publish a successfully created conversation to its owner. */
  publish(id: string): void {
    this.db.prepare('UPDATE conversations SET ready=1 WHERE id=?').run(id)
  }

  /** Refuse unknown, incomplete and foreign conversations with the same response. */
  assertOwner(id: string, actor: Actor): void {
    const row = this.db.prepare("SELECT 1 FROM conversations WHERE id=? AND owner_namespace=? AND owner_id=? AND ready=1 AND deletedAt IS NULL AND removalState=''")
      .get(id, actor.namespace, actor.userId)
    if (row === undefined) throw new AccessError(404, '会话不存在或无权访问')
  }

  /** Update a history summary after an accepted user message. */
  touch(id: string, title?: string): void {
    this.db.prepare("UPDATE conversations SET updated_at=?, title=CASE WHEN title='' THEN ? ELSE title END WHERE id=? AND ready=1")
      .run(Date.now(), title?.slice(0, 80) ?? '', id)
  }

  /** Page through one owner's ready records without loading other users' logs. */
  list(actor: Actor, offset: number, limit: number): ConversationSummary[] {
    return this.db.prepare(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
      FROM conversations WHERE owner_namespace=? AND owner_id=? AND ready=1 AND deletedAt IS NULL AND removalState=''
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
      .all(actor.namespace, actor.userId, limit, offset) as unknown as ConversationSummary[]
  }

  record(actor: Actor, id: string): ConversationRecord {
    const row = this.db.prepare('SELECT id,title,updated_at AS updatedAt,deletedAt,removalState FROM conversations WHERE id=? AND owner_namespace=? AND owner_id=? AND ready=1').get(id,actor.namespace,actor.userId)
    if (!row) throw new AccessError(404,'会话不存在或无权访问')
    return row as unknown as ConversationRecord
  }
  mark(actor: Actor, id: string, state: 'pending' | 'failed' | 'removed'): void {
    this.record(actor,id)
    this.db.prepare("UPDATE conversations SET removalState=?,deletedAt=CASE WHEN ?='removed' THEN COALESCE(deletedAt,?) ELSE deletedAt END WHERE id=? AND owner_namespace=? AND owner_id=?").run(state,state,Date.now(),id,actor.namespace,actor.userId)
  }
  managed(actor: Actor, query: ConversationQuery, archived: readonly string[], busy: readonly string[]) {
    return queryConversationIndex(this.db,'SELECT id,title,updated_at AS updatedAt,deletedAt,removalState FROM conversations WHERE owner_namespace=? AND owner_id=? AND ready=1',[actor.namespace,actor.userId],query,archived,busy)
  }

  /** Close this plugin's index without deleting user records. */
  close(): void { this.db.close() }
}
