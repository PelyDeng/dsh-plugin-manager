/** Cookie sessions and live access grants; never issues official DSH authentication tokens. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import { AccessError, emitRevoked, listPlugins, type Actor, type AuthProvider } from '@dsh-plugin/plugin-kit/access'
import { AuthStore, type User, type Session } from './store.ts'
import { hashPassword, verifyPassword, type PasswordHash } from './password.ts'

export const SESSION_COOKIE = 'dsh_auth_session'

/** Malformed browser cookies do not crash request handling. */
export function sessionCookie(request: IncomingMessage): string | undefined {
  const values = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`))
  if (values.length !== 1) return undefined
  const token = values[0]!.slice(SESSION_COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
}

export interface ServiceConfig { sessionTtlSeconds: number; maxAttempts: number; lockSeconds: number }
interface Failure { attempts: number; until: number }

export class AuthService implements AuthProvider {
  readonly protocol = 1 as const
  private readonly failures = new Map<string, Failure>()
  private readonly dummy: PasswordHash
  private pendingPasswords = 0
  private active = true

  private constructor(readonly ctx: Context, readonly store: AuthStore, readonly config: ServiceConfig, dummy: PasswordHash) { this.dummy = dummy }

  static async create(ctx: Context, store: AuthStore, config: ServiceConfig): Promise<AuthService> {
    return new AuthService(ctx, store, config, await hashPassword('unused-dummy-password'))
  }

  close(): void { this.active = false; this.failures.clear() }

  /** Database availability is independent of whether an administrator has been initialized. */
  ready(): void {
    if (!this.active) throw new AccessError(503, '认证服务不可用')
    try { this.store.initialized() } catch { throw new AccessError(503, '认证数据库不可用') }
  }

  resolve(request: IncomingMessage): Actor | undefined {
    this.ready()
    const token = sessionCookie(request)
    const session = token ? this.store.fromToken(token) : undefined
    return session ? { namespace: 'user', userId: session.userId, sessionId: session.id } : undefined
  }

  requireSession(actor: Actor): Session {
    this.ready()
    if (actor.namespace !== 'user') throw new AccessError(401, '请先登录')
    const session = this.store.session(actor.sessionId)
    if (!session || session.userId !== actor.userId) throw new AccessError(401, '登录已失效，请重新登录')
    return session
  }

  current(actor: Actor): User {
    const session = this.requireSession(actor)
    return this.effectiveUser(this.store.user(session.userId)!)
  }

  /** Administrators inherit all current and future registered entrances without editing stored grants. */
  effectiveUser(user: User): User {
    return user.role === 'admin' ? { ...user, grants: [...new Set([...user.grants, ...listPlugins(this.ctx).map(plugin => plugin.id), 'dsh-console'])] } : user
  }

  requirePasswordChanged(actor: Actor): void {
    if (this.current(actor).mustChangePassword) throw new AccessError(403, '必须先修改初始密码')
  }

  assertAccess(actor: Actor, pluginId: string): void {
    this.requirePasswordChanged(actor)
    const user = this.current(actor)
    if (!user.grants.includes(pluginId)) throw new AccessError(403, '没有访问此插件的权限')
  }

  requireAdmin(actor: Actor): User {
    this.requirePasswordChanged(actor)
    const user = this.current(actor)
    if (user.role !== 'admin') throw new AccessError(403, '需要管理员权限')
    return user
  }

  /** Bound expensive password work, including successful-login floods. */
  async passwordWork<T>(action: () => Promise<T>): Promise<T> {
    if (this.pendingPasswords >= 8) throw new AccessError(429, '登录请求繁忙，请稍后重试')
    this.pendingPasswords++
    try { return await action() } finally { this.pendingPasswords-- }
  }

  async login(username: string, password: string, clientIp: string): Promise<{ token: string; session: Session; user: User }> {
    if (!this.active) throw new AccessError(503, '认证服务不可用')
    const key = `${clientIp}:${username.toLowerCase()}`
    const now = Date.now()
    for (const [id, entry] of this.failures) if (entry.until <= now) this.failures.delete(id)
    if ((this.failures.get(key)?.attempts ?? 0) >= this.config.maxAttempts) throw new AccessError(429, '尝试次数过多，请稍后重试')
    const user = this.store.credentials(username)
    const valid = await this.passwordWork(() => verifyPassword(user?.password ?? this.dummy, password))
    if (!this.active) throw new AccessError(503, '认证服务不可用')
    if (!valid || !user?.enabled) {
      this.failures.set(key, { attempts: (this.failures.get(key)?.attempts ?? 0) + 1, until: Date.now() + this.config.lockSeconds * 1000 })
      while (this.failures.size > 10000) this.failures.delete(this.failures.keys().next().value!)
      throw new AccessError(401, '用户名或密码错误')
    }
    this.failures.delete(key)
    const result = this.store.createSession(user, this.config.sessionTtlSeconds)
    return { ...result, user: this.store.user(user.id)! }
  }

  logout(actor: Actor): void {
    const session = this.requireSession(actor)
    this.store.logout(session.id)
    emitRevoked(this.ctx, { sessionId: session.id })
  }

  async changePassword(actor: Actor, currentPassword: string, nextPassword: string): Promise<void> {
    const user = this.current(actor)
    const record = this.store.credentials(user.username)!
    await this.passwordWork(async () => {
      if (!await verifyPassword(record.password, currentPassword)) throw new AccessError(400, '当前密码错误')
      const hash = await hashPassword(nextPassword)
      this.requireSession(actor)
      this.store.changePassword(user.id, user.revision, hash)
    })
    emitRevoked(this.ctx, { userId: user.id })
  }
}
