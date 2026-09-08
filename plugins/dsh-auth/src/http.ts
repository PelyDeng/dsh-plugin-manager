/** Same-port authentication routes and static, independent management UI. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { AccessError, emitRevoked, isAccessError, listPlugins, type Actor } from '@dsh-plugin-manager/plugin-kit/access'
import { ModelKeyError, modelKeyStatus, setModelKey } from '@dsh-plugin-manager/plugin-kit/model-key'
import { AuthService, SESSION_COOKIE } from './service.ts'
import { conversationProviders, conversationQuery, conversationIds } from '@dsh-plugin-manager/plugin-kit/conversations'
import { hashPassword, validatePassword } from './password.ts'
import { normalizeUsername, type Role } from './store.ts'

export interface HttpConfig { publicOrigin: string; sessionTtlSeconds: number }

/** Console access is an explicit gateway permission, not a running business plugin. */
export const CONSOLE_ACCESS_TARGET = {
  id: 'dsh-console', displayName: 'DSH 控制台', entryPath: '/',
  description: '访问 DSH 官方控制台；仍须通过官方认证，可能涉及宿主设置和全部 DSH 会话。',
} as const

/** Validate the explicit browser origin, without trusting forwarded headers. */
export function validateOrigin(origin: string): void {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('publicOrigin 必须为不带路径的 HTTP(S) 来源地址')
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new AccessError(415, '需要 JSON 请求')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 16384) throw new AccessError(413, '请求内容过大')
    chunks.push(bytes)
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new AccessError(400, '无效 JSON 请求') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AccessError(400, '请求必须为 JSON 对象')
  return parsed as Record<string, unknown>
}

function text(data: Record<string, unknown>, key: string, limit = 256): string {
  const value = data[key]
  if (typeof value !== 'string' || value.length > limit || value.length === 0) throw new AccessError(400, `字段 ${key} 无效`)
  return value
}

function validated<T>(action: () => T): T {
  try { return action() } catch (error) { throw new AccessError(400, error instanceof Error ? error.message : '请求无效') }
}

function cookie(config: HttpConfig, token: string, clear = false): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : config.sessionTtlSeconds}${config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`
}

/** Console permission allows only the exact root path; its opaque query is preserved. */
export function safeReturn(value: string | null, allowed: readonly string[], consoleAccess = false): string {
  if (!value) return '/auth'
  let pathname: string
  try { pathname = requestPath(value) } catch { return '/auth' }
  const permitted = pathname === '/'
    ? consoleAccess
    : allowed.some(path => path !== '/' && (pathname === path || pathname.startsWith(`${path}/`)))
  return permitted ? value : '/auth'
}

/** Match Nginx's single percent decode, slash merging, and dot-segment normalization. */
function requestPath(uri: string): string {
  if (!uri.startsWith('/') || uri.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(uri)) throw new AccessError(403, '请求路径无效')
  let path: string
  try { path = decodeURIComponent(uri.split(/[?#]/, 1)[0]!) } catch { throw new AccessError(403, '请求路径无效') }
  if (path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path)) throw new AccessError(403, '请求路径无效')
  return posix.normalize(path)
}

/** The proxy overwrites this header with its request URI; only station-local paths are accepted. */
function originalRequest(req: IncomingMessage): { uri: string; pathname: string } {
  const uri = req.headers['x-original-uri'] ?? '/'
  if (typeof uri !== 'string') throw new AccessError(403, '请求路径无效')
  return { uri, pathname: requestPath(uri) }
}

/** Build a handler with only explicit /auth resources; no filesystem path interpolation. */
export async function createHandler(ctx: Context, service: AuthService, config: HttpConfig): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  validateOrigin(config.publicOrigin)
  const assets = new Map([
    ['/auth', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/auth/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/auth/login', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/auth/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/auth/catalog-view.js', { file: 'catalog-view.js', type: 'text/javascript; charset=utf-8' }],
    ['/auth/conversations.js', { file: 'conversations.js', type: 'text/javascript; charset=utf-8' }],
    ['/auth/icons.svg', { file: 'icons.svg', type: 'image/svg+xml' }],
    ['/auth/deepseek.svg', { file: 'deepseek.svg', type: 'image/svg+xml' }],
    ['/auth/zhipu.svg', { file: 'zhipu.svg', type: 'image/svg+xml' }],
    ['/auth/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ])
  const content = new Map<string, { bytes: Buffer; type: string }>()
  for (const [path, asset] of assets) content.set(path, { bytes: await readFile(new URL(`../web/${asset.file}`, import.meta.url)), type: asset.type })
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', config.publicOrigin)
      const path = url.pathname
      if (path === '/auth/api/console-access') {
        let status = 204
        let loginPath: string | undefined
        try {
          if (req.method !== 'GET') throw new AccessError(405, '请求方法不支持')
          const original = originalRequest(req)
          const pluginRoute = listPlugins(ctx).some(plugin => plugin.entryPath && plugin.entryPath !== '/'
            && (original.pathname === plugin.entryPath || original.pathname.startsWith(`${plugin.entryPath}/`)))
          if (!pluginRoute) {
            loginPath = `/auth?returnTo=${encodeURIComponent(original.uri)}`
            const actor = service.resolve(req)
            if (!actor) throw new AccessError(401, '请先登录')
            service.assertAccess(actor, CONSOLE_ACCESS_TARGET.id)
          }
        } catch (error) { status = isAccessError(error) ? error.status : 503 }
        res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          ...(status === 401 && loginPath ? { 'x-dsh-login': loginPath } : {}) })
        res.end(); return
      }
      if (req.method === 'GET' && path === '/auth/health') { service.ready(); json(res, 200, { status: 'ok' }); return }
      const asset = content.get(path)
      if (asset) {
        if (req.method !== 'GET') throw new AccessError(405, '请求方法不支持')
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" })
        res.end(asset.bytes); return
      }
      if (!path.startsWith('/auth/api/')) throw new AccessError(404, '页面不存在')
      if (req.method !== 'GET' && req.method !== 'POST') throw new AccessError(405, '请求方法不支持')
      if (req.method === 'POST' && req.headers.origin !== config.publicOrigin) throw new AccessError(403, '请求来源不受信任')
      if (path === '/auth/api/login' && req.method === 'POST') {
        if (req.headers['x-dsh-csrf'] !== 'login') throw new AccessError(403, '缺少登录请求校验')
        const data = await body(req)
        const login = await service.login(text(data, 'username', 64), text(data, 'password'), req.socket.remoteAddress ?? 'unknown')
        const previous = service.resolve(req)
        if (previous) service.logout(previous)
        res.setHeader('set-cookie', cookie(config, login.token))
        json(res, 200, { user: login.user, csrf: login.session.csrf }); return
      }
      const actor = service.resolve(req)
      if (path === '/auth/api/session' && req.method === 'GET') {
        if (!actor) { json(res, 200, { initialized: service.store.initialized(), user: null }); return }
        const user = service.current(actor)
        if (user.mustChangePassword) {
          json(res, 200, { initialized: true, user, csrf: service.requireSession(actor).csrf, plugins: [], accessTargets: [], returnTo: '/auth' }); return
        }
        const plugins = listPlugins(ctx).filter(plugin => user.grants.includes(plugin.id))
        const consoleAccess = user.grants.includes(CONSOLE_ACCESS_TARGET.id)
        json(res, 200, { initialized: true, user, csrf: service.requireSession(actor).csrf,
          plugins, accessTargets: consoleAccess ? [CONSOLE_ACCESS_TARGET] : [],
          returnTo: safeReturn(url.searchParams.get('returnTo'), plugins.flatMap(plugin => plugin.entryPath ? [plugin.entryPath] : []), consoleAccess) }); return
      }
      if (!actor) throw new AccessError(401, '请先登录')
      if (req.method === 'POST' && req.headers['x-dsh-csrf'] !== service.requireSession(actor).csrf) throw new AccessError(403, '请求校验失效，请刷新页面')
      if (path === '/auth/api/logout' && req.method === 'POST') {
        service.logout(actor); res.setHeader('set-cookie', cookie(config, '', true)); json(res, 200, { ok: true }); return
      }
      if (path === '/auth/api/password' && req.method === 'POST') {
        const data = await body(req)
        const password = text(data, 'newPassword')
        validated(() => validatePassword(password))
        await service.changePassword(actor, text(data, 'currentPassword'), password)
        res.setHeader('set-cookie', cookie(config, '', true)); json(res, 200, { ok: true }); return
      }
      if (path === '/auth/api/plugins' && req.method === 'GET') {
        service.requirePasswordChanged(actor)
        const user = service.current(actor)
        json(res, 200, {
          plugins: listPlugins(ctx).filter(plugin => user.role === 'admin' || user.grants.includes(plugin.id)),
          accessTargets: user.role === 'admin' || user.grants.includes(CONSOLE_ACCESS_TARGET.id) ? [CONSOLE_ACCESS_TARGET] : [],
        }); return
      }
      if (path === '/auth/api/conversation-plugins' && req.method === 'GET') {
        service.requirePasswordChanged(actor)
        const providers = conversationProviders(ctx)
        const plugins = await Promise.all(listPlugins(ctx).filter(plugin => plugin.id !== 'auth' && service.current(actor).grants.includes(plugin.id)).map(async plugin => {
          const provider = providers.get(plugin.id)
          if (!provider) return { id: plugin.id, displayName: plugin.displayName, supported: false }
          try {
            const result = await provider.list(actor, { offset: 0, limit: 1, q: '', state: '' })
            return { id: plugin.id, displayName: plugin.displayName, supported: true, total: result.total }
          } catch { return { id: plugin.id, displayName: plugin.displayName, supported: true, error: '会话服务暂不可用' } }
        }))
        for (const plugin of plugins) service.assertAccess(actor, plugin.id)
        json(res, 200, { plugins }); return
      }
      if (['/auth/api/conversations', '/auth/api/conversations/preview', '/auth/api/conversations/remove'].includes(path)) {
        const removing = path.endsWith('/remove')
        if (req.method !== (removing ? 'POST' : 'GET')) throw new AccessError(405, '请求方法不支持')
        const input = removing ? await body(req) : Object.fromEntries(url.searchParams)
        const pluginId = text(input, 'pluginId', 160)
        service.assertAccess(actor, pluginId)
        const provider = conversationProviders(ctx).get(pluginId)
        if (!provider) throw new AccessError(503, '该插件暂不支持会话管理')
        let result: unknown
        if (removing) result = await provider.remove(actor, conversationIds(input.ids))
        else if (path.endsWith('/preview')) {
          const before = url.searchParams.get('before')
          if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))) throw new AccessError(400, '预览分页参数无效')
          result = await provider.preview(actor, text(input, 'id', 160), before === null ? undefined : Number(before))
        } else result = await provider.list(actor, conversationQuery(url.searchParams))
        service.assertAccess(actor, pluginId)
        json(res, 200, result); return
      }
      service.requireAdmin(actor)
      if (['/auth/api/deepseek-key', '/auth/api/model-key/deepseek', '/auth/api/model-key/zhipu'].includes(path)) {
        if (!['GET', 'POST'].includes(req.method ?? '')) throw new AccessError(405, '只支持 GET 或 POST')
        const kind = path.endsWith('/zhipu') ? 'zhipu' : 'deepseek'
        const provider: unknown = ctx.get('credentials')
        const status = req.method === 'POST'
          ? await setModelKey(provider, kind, (await body(req)).apiKey, () => service.requireAdmin(actor))
          : await modelKeyStatus(provider, kind)
        service.requireAdmin(actor)
        json(res, 200, status); return
      }
      if (path === '/auth/api/users' && req.method === 'GET') { json(res, 200, { users: service.store.users().map(user => service.effectiveUser(user)) }); return }
      if (path === '/auth/api/users' && req.method === 'POST') {
        await mutateUser(ctx, service, actor, await body(req)); json(res, 200, { ok: true }); return
      }
      throw new AccessError(404, '接口不存在')
    } catch (error) {
      if (error instanceof ModelKeyError) json(res, 400, { error: error.message })
      else if (isAccessError(error)) json(res, error.status, { error: error.message })
      else { ctx.logger('auth').error('认证请求失败，详情仅记录错误类型', error instanceof Error ? error.name : 'unknown'); json(res, 500, { error: '认证服务处理失败' }) }
    }
  }
}

async function mutateUser(ctx: Context, service: AuthService, actor: Actor, data: Record<string, unknown>): Promise<void> {
  const role = data.role
  if (role !== 'admin' && role !== 'user') throw new AccessError(400, '用户角色无效')
  if (!Array.isArray(data.grants) || data.grants.length > 1000 || !data.grants.every(value => typeof value === 'string')) throw new AccessError(400, '插件授权无效')
  const plugins = new Set([...listPlugins(ctx).map(plugin => plugin.id), CONSOLE_ACCESS_TARGET.id])
  const grants = role === 'admin' ? [...plugins] : data.grants as string[]
  const id = data.id === undefined ? undefined : text(data, 'id', 64)
  const previous = id ? service.store.user(id) : undefined
  if (id && !previous) throw new AccessError(404, '用户不存在')
  if (grants.some(grant => !plugins.has(grant) && !previous?.grants.includes(grant))) throw new AccessError(400, '插件未注册')
  const password = data.password === undefined || data.password === '' ? undefined : text(data, 'password')
  if (!id && !password) throw new AccessError(400, '新用户需要密码')
  if (password) validated(() => validatePassword(password))
  const hash = password ? await service.passwordWork(() => hashPassword(password)) : undefined
  service.requireAdmin(actor)
  if (!id) {
    const username = validated(() => normalizeUsername(text(data, 'username', 64)))
    validated(() => service.store.create(username, hash!, role, grants)); return
  }
  if (typeof data.enabled !== 'boolean') throw new AccessError(400, '账号状态无效')
  validated(() => service.store.update(id, { role: role as Role, enabled: data.enabled as boolean, grants, ...(hash ? { password: hash } : {}) }))
  emitRevoked(ctx, { userId: id })
}
