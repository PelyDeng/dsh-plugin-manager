/** SQLite owns users, explicit plugin grants and revocable browser sessions. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hashPassword, hashInitialPassword, parsePassword, type PasswordHash } from './password.ts'

export type Role = 'admin' | 'user'
export interface User {
  id: string
  username: string
  role: Role
  enabled: boolean
  revision: number
  createdAt: number
  grants: string[]
  mustChangePassword: boolean
}
export interface Credentials extends User { password: PasswordHash }
export interface Session { id: string; userId: string; csrf: string; expiresAt: number }
interface UserRow { id: string; username: string; password: string; role: Role; enabled: number; revision: number; created_at: number; must_change_password: number }

/** Shared location used by the plugin and restricted administration script. */
export function defaultDirectory(): string {
  return join(resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh')), 'auth')
}

/** Usernames have one canonical spelling independent of locale. */
export function normalizeUsername(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value)) throw new Error('用户名须为 3 至 64 位字母、数字、点、横线或下划线')
  return value.toLowerCase()
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

export class AuthStore {
  private readonly db: DatabaseSync

  constructor(directory = defaultDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const file = join(directory, 'auth.sqlite')
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (![0, 1, 2].includes(version.user_version)) {
      this.db.close()
      throw new Error('认证数据库版本不受支持')
    }
    if (version.user_version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE grants(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plugin_id TEXT NOT NULL,
        PRIMARY KEY(user_id,plugin_id));
      CREATE TABLE sessions(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX session_user ON sessions(user_id);
      PRAGMA user_version=1;
      COMMIT;
    `)
    if (version.user_version <= 1) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1));
      PRAGMA user_version=2;
      COMMIT;
    `)
  }

  close(): void { this.db.close() }
  initialized(): boolean { return Number(this.db.prepare('SELECT count(*) count FROM users').get()?.count) > 0 }
  hasDefaultAccount(): boolean { return !!this.db.prepare("SELECT 1 FROM users WHERE username='admin' LIMIT 1").get() }

  /** Recheck within the write transaction; never overwrite a pre-existing account. */
  ensureAdministrator(password: PasswordHash): void {
    this.transaction(() => {
      if (this.hasDefaultAccount()) return
      this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), 'admin', JSON.stringify(password), 'admin', 1, 1, Date.now(), 1)
    })
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private project(row: UserRow): User {
    return { id: row.id, username: row.username, role: row.role, enabled: row.enabled === 1,
      revision: row.revision, createdAt: row.created_at, mustChangePassword: row.must_change_password === 1,
      grants: this.db.prepare('SELECT plugin_id FROM grants WHERE user_id=? ORDER BY plugin_id').all(row.id).map(r => String(r.plugin_id)) }
  }

  user(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined
    return row && this.project(row)
  }

  credentials(username: string): Credentials | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(username.toLowerCase()) as UserRow | undefined
    return row && { ...this.project(row), password: parsePassword(JSON.parse(row.password)) }
  }

  users(): User[] { return (this.db.prepare('SELECT * FROM users ORDER BY created_at,id').all() as unknown as UserRow[]).map(row => this.project(row)) }

  /** Insert an account. Bootstrap atomically requires an empty database. */
  create(username: string, password: PasswordHash, role: Role, grants: readonly string[], bootstrap = false): User {
    username = normalizeUsername(username)
    return this.transaction(() => {
      if (bootstrap && this.initialized()) throw new Error('管理员已经初始化')
      if (this.credentials(username)) throw new Error('用户名已被使用')
      const id = randomUUID()
      this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id, username, JSON.stringify(password), role, 1, 1, Date.now(), 0)
      for (const pluginId of new Set(grants)) this.db.prepare('INSERT INTO grants VALUES(?,?)').run(id, pluginId)
      return this.user(id)!
    })
  }

  /** Update roles/grants atomically and revoke old sessions. */
  update(id: string, update: { role: Role; enabled: boolean; grants: readonly string[]; password?: PasswordHash }): User {
    return this.transaction(() => {
      const user = this.user(id)
      if (!user) throw new Error('用户不存在')
      const admins = Number(this.db.prepare("SELECT count(*) count FROM users WHERE role='admin' AND enabled=1").get()?.count)
      if (user.role === 'admin' && user.enabled && (!update.enabled || update.role !== 'admin') && admins <= 1) throw new Error('不能停用或降级最后一个管理员')
      this.db.prepare('UPDATE users SET role=?, enabled=?, revision=revision+1 WHERE id=?').run(update.role, Number(update.enabled), id)
      if (update.password) this.db.prepare('UPDATE users SET password=? WHERE id=?').run(JSON.stringify(update.password), id)
      this.db.prepare('DELETE FROM grants WHERE user_id=?').run(id)
      for (const pluginId of new Set(update.grants)) this.db.prepare('INSERT INTO grants VALUES(?,?)').run(id, pluginId)
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)
      return this.user(id)!
    })
  }

  /** Password changes cannot overwrite a concurrent administrative change. */
  changePassword(id: string, revision: number, password: PasswordHash): void {
    this.transaction(() => {
      const result = this.db.prepare('UPDATE users SET password=?,must_change_password=0,revision=revision+1 WHERE id=? AND revision=? AND enabled=1').run(JSON.stringify(password), id, revision)
      if (result.changes !== 1) throw new Error('账号已变更，请重新登录')
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id)
    })
  }

  createSession(user: User, ttlSeconds: number): { token: string; session: Session } {
    return this.transaction(() => {
      const current = this.user(user.id)
      if (!current?.enabled || current.revision !== user.revision) throw new Error('账号已变更，请重新登录')
      this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now())
      const token = randomBytes(32).toString('base64url')
      const session = { id: randomUUID(), userId: user.id, csrf: randomBytes(24).toString('base64url'), expiresAt: Date.now() + ttlSeconds * 1000 }
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(session.id, digest(token), user.id, user.revision, session.csrf, session.expiresAt)
      return { token, session }
    })
  }

  session(id: string): Session | undefined {
    const row = this.db.prepare(`SELECT s.id,s.user_id,s.csrf,s.expires_at FROM sessions s JOIN users u ON s.user_id=u.id
      WHERE s.id=? AND s.expires_at>? AND u.enabled=1 AND s.revision=u.revision`).get(id, Date.now())
    return row ? { id: String(row.id), userId: String(row.user_id), csrf: String(row.csrf), expiresAt: Number(row.expires_at) } : undefined
  }

  fromToken(token: string): Session | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const row = this.db.prepare('SELECT id FROM sessions WHERE token_hash=?').get(digest(token))
    return row ? this.session(String(row.id)) : undefined
  }

  logout(id: string): void { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id) }
}

/** Only the fixed username admin prevents creation; existing accounts remain untouched. */
export async function ensureDefaultAdministrator(store: AuthStore): Promise<void> {
  if (!store.hasDefaultAccount()) store.ensureAdministrator(await hashInitialPassword())
}

/** Restricted script API: initialize an empty database; never reset an existing user. */
export async function bootstrap(username: string, password: string, directory = defaultDirectory(), grants: readonly string[] = []): Promise<User> {
  const hash = await hashPassword(password)
  const store = new AuthStore(directory)
  try { return store.create(username, hash, 'admin', grants, true) } finally { store.close() }
}

/** Explicit legacy migration preserves the original password hash, never the IP bypass. */
export function migrateLegacy(directory = defaultDirectory(), grants: readonly string[] = []): User {
  const legacy: unknown = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
  if (!legacy || typeof legacy !== 'object' || !('version' in legacy) || legacy.version !== 1
    || !('username' in legacy) || typeof legacy.username !== 'string' || !('password' in legacy)) throw new Error('旧认证文件格式不受支持')
  const password = parsePassword(legacy.password)
  const store = new AuthStore(directory)
  try { return store.create(legacy.username, password, 'admin', grants, true) } finally { store.close() }
}
