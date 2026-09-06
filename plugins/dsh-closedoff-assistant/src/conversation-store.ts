/** Business ownership and history index; DSH retains the conversation event log. */
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccessError, type Actor } from '@dsh-plugin/plugin-kit'

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
    if (version !== 0 && version !== 1) {
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
      PRAGMA user_version = 1;
    `)
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
    const row = this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_namespace=? AND owner_id=? AND ready=1')
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
      FROM conversations WHERE owner_namespace=? AND owner_id=? AND ready=1
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
      .all(actor.namespace, actor.userId, limit, offset) as unknown as ConversationSummary[]
  }

  /** Close this plugin's index without deleting user records. */
  close(): void { this.db.close() }
}
