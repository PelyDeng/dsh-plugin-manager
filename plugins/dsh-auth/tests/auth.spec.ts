/** Durable accounts and same-origin HTTP authorization regressions. */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { installProvider, registerPlugin, type Actor, type Revocation } from '@dsh-plugin-manager/plugin-kit'
import { AuthStore, bootstrap, migrateLegacy, ensureDefaultAdministrator } from '../src/store.ts'
import { hashPassword, verifyPassword, type PasswordHash } from '../src/password.ts'
import { AuthService } from '../src/service.ts'
import { createHandler, safeReturn, validateOrigin } from '../src/http.ts'

let hash: PasswordHash
const cleanup: (() => Promise<void> | void)[] = []
beforeAll(async () => { hash = await hashPassword('test-password-123') })
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-auth-test-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function storeFixture(): Promise<AuthStore> {
  const store = new AuthStore(await directory())
  cleanup.push(() => store.close())
  return store
}

function actor(userId: string, sessionId: string): Actor { return { namespace: 'user', userId, sessionId } }

async function httpFixture(initial = false) {
  const store = await storeFixture()
  if (initial) await ensureDefaultAdministrator(store)
  const admin = initial ? store.users()[0]! : store.create('Admin', hash, 'admin', [])
  const ctx = new Context()
  const config = { sessionTtlSeconds: 3600, maxAttempts: 3, lockSeconds: 30 }
  const service = await AuthService.create(ctx, store, config)
  const uninstall = installProvider(ctx, service)
  cleanup.push(() => { uninstall(); service.close() })
  registerPlugin(ctx, { id: 'demo', packageName: 'fixture-demo', version: 'test', displayName: '示例',
    description: '测试插件', entryPath: '/demo', permissions: ['demo:access'],
    tools: [{ name: 'test_query', description: '查询', parameters: { type: 'object', properties: {} }, permission: 'demo:access' }] })
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  handler = await createHandler(ctx, service, { ...config, publicOrigin: origin })
  const request = async (path: string, data?: unknown, cookie?: string, csrf = 'login', customOrigin = origin, extraHeaders: Record<string, string> = {}) => {
    return fetch(`${origin}${path}`, { ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
      headers: { origin: customOrigin, 'content-type': 'application/json', 'x-dsh-csrf': csrf, ...(cookie ? { cookie } : {}), ...extraHeaders } })
  }
  const login = async (username = 'admin', password = 'test-password-123') => {
    const response = await request('/auth/api/login', { username, password })
    const result = await response.json() as { csrf: string; user: { id: string } }
    return { response, result, cookie: response.headers.get('set-cookie')!.split(';')[0]! }
  }
  return { store, admin, ctx, service, config, origin, request, login }
}

describe('administrator DeepSeek credentials', () => {
  it('shares the protected UI contract with Zhipu without overwriting DeepSeek or accepting arbitrary refs', async () => {
    const f = await httpFixture(), values = new Map<string, string>([['DEEPSEEK_API_KEY', 'sk-original']])
    f.ctx.provide('credentials', {
      describe: async () => ({ writable: true }),
      resolve: async (ref: string) => values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined,
      set: async (ref: string, value: string) => { values.set(ref, value) },
    })
    const path = '/auth/api/model-key/zhipu'
    expect((await f.request(path)).status).toBe(401)
    f.store.create('reader', hash, 'user', ['demo'])
    const reader = await f.login('reader')
    expect((await f.request(path, undefined, reader.cookie)).status).toBe(403)
    expect((await f.request(path, { apiKey: 'id.refused' }, reader.cookie, reader.result.csrf)).status).toBe(403)
    const admin = await f.login()
    expect((await f.request(path, { apiKey: 'id.refused' }, admin.cookie)).status).toBe(403)
    for (const invalid of ['constructor', '__proto__', 'OTHER_API_KEY']) expect((await f.request(`/auth/api/model-key/${invalid}`, { apiKey: 'id.refused' }, admin.cookie, admin.result.csrf)).status).toBe(404)
    const response = await f.request(path, { apiKey: 'id.zhipu-fixture' }, admin.cookie, admin.result.csrf)
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain('id.zhipu-fixture')
    expect(values.get('DEEPSEEK_API_KEY')).toBe('sk-original')
    expect(values.get('ZHIPU_API_KEY')).toBe('id.zhipu-fixture')
    expect(await (await f.request('/auth/api/deepseek-key', undefined, admin.cookie)).json()).toEqual(await (await f.request('/auth/api/model-key/deepseek', undefined, admin.cookie)).json())
  })
  it('protects reads and writes, returns fingerprints only, and updates the runtime service', async () => {
    const f = await httpFixture()
    let value: string | undefined
    const writes: string[] = []
    f.ctx.provide('credentials', {
      describe: async () => ({ writable: true }),
      resolve: async () => value ? { value, source: 'file' } : undefined,
      set: async (ref: string, key: string) => { writes.push(ref); value = key },
    })
    const path = '/auth/api/deepseek-key'
    expect((await f.request(path)).status).toBe(401)
    f.store.create('reader', hash, 'user', ['demo'])
    const reader = await f.login('reader')
    expect((await f.request(path, undefined, reader.cookie)).status).toBe(403)
    expect((await f.request(path, { apiKey: 'sk-refused' }, reader.cookie, reader.result.csrf)).status).toBe(403)
    const admin = await f.login()
    expect(await (await f.request(path, undefined, admin.cookie)).json()).toMatchObject({ configured: false })
    expect((await f.request(path, { apiKey: 'sk-refused' }, admin.cookie)).status).toBe(403)
    expect((await f.request(path, { apiKey: 'sk-refused' }, admin.cookie, admin.result.csrf, 'https://other.invalid')).status).toBe(403)
    expect((await f.request(path, { apiKey: 'sk-bad\nINJECT=1' }, admin.cookie, admin.result.csrf)).status).toBe(400)
    expect(writes).toEqual([])
    const saved = await f.request(path, { apiKey: 'sk-first-fixture' }, admin.cookie, admin.result.csrf)
    expect(saved.status).toBe(200)
    expect(saved.headers.get('cache-control')).toBe('no-store')
    const first = await saved.json()
    expect(first).toMatchObject({ configured: true, writable: true, source: 'file' })
    expect(JSON.stringify(first)).not.toContain('sk-first-fixture')
    const replaced = await (await f.request(path, { apiKey: 'sk-second-fixture' }, admin.cookie, admin.result.csrf)).json()
    expect(replaced.fingerprint).not.toBe(first.fingerprint)
    expect(value).toBe('sk-second-fixture')
    expect(writes).toEqual(['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'])
  })
  it('requires the initial password change and refuses a missing credential service', async () => {
    const f = await httpFixture(true), admin = await f.login('admin', '123456')
    expect((await f.request('/auth/api/deepseek-key', undefined, admin.cookie)).status).toBe(403)
    expect((await f.request('/auth/api/deepseek-key', { apiKey: 'sk-fixture' }, admin.cookie, admin.result.csrf)).status).toBe(403)
    const ready = await httpFixture(), owner = await ready.login()
    expect(await (await ready.request('/auth/api/deepseek-key', undefined, owner.cookie)).json()).toMatchObject({ supported: false, writable: false })
  })
  it('rechecks a revoked administrator after asynchronous credential reads before writing', async () => {
    const f = await httpFixture(), admin = await f.login()
    let writes = 0
    f.ctx.provide('credentials', {
      describe: async () => ({ writable: true }),
      resolve: async () => { f.service.logout(f.service.resolve({ headers: { cookie: admin.cookie } } as IncomingMessage)!); return undefined },
      set: async () => { writes++ },
    })
    expect((await f.request('/auth/api/deepseek-key', { apiKey: 'sk-fixture' }, admin.cookie, admin.result.csrf)).status).toBe(401)
    expect(writes).toBe(0)
  })
})

describe('durable accounts', () => {
  it('persists multiple accounts, hashed sessions and explicit grants across reopening', async () => {
    const dir = await directory()
    let store = new AuthStore(dir)
    try {
      const first = store.create('Owner', hash, 'admin', [])
      const user = store.create('Alice', hash, 'user', ['demo'])
      expect(first.grants).toEqual([])
      expect(() => store.create('ALICE', hash, 'user', [])).toThrow('用户名已被使用')
      const issued = store.createSession(user, 3600)
      store.close(); store = new AuthStore(dir)
      expect(store.fromToken(issued.token)?.userId).toBe(user.id)
      expect(store.user(user.id)?.grants).toEqual(['demo'])
      expect((await readFile(join(dir, 'auth.sqlite'))).includes(Buffer.from(issued.token))).toBe(false)
      store.logout(issued.session.id)
      expect(store.fromToken(issued.token)).toBeUndefined()
    } finally { store.close() }
  })

  it('last administrator protection is transactional and another enabled administrator permits changes', async () => {
    const store = await storeFixture()
    const admin = store.create('owner', hash, 'admin', [])
    expect(() => store.update(admin.id, { role: 'user', enabled: true, grants: ['demo'] })).toThrow('最后一个管理员')
    expect(store.user(admin.id)).toMatchObject({ role: 'admin', revision: 1, grants: [] })
    store.create('second', hash, 'admin', [])
    expect(store.update(admin.id, { role: 'user', enabled: false, grants: [] }).enabled).toBe(false)
  })

  it('revokes sessions on account updates and rejects stale credential snapshots', async () => {
    const store = await storeFixture()
    const user = store.create('alice', hash, 'user', ['demo'])
    const issued = store.createSession(user, 60)
    store.update(user.id, { role: 'user', enabled: true, grants: [] })
    expect(store.session(issued.session.id)).toBeUndefined()
    expect(() => store.createSession(user, 60)).toThrow('账号已变更')
    expect(() => store.changePassword(user.id, user.revision, hash)).toThrow('账号已变更')
  })

  it('bootstrap refuses to reset an existing account and migration preserves its hash', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, username: 'legacy', password: hash, whitelist: ['0.0.0.0/0'] }))
    const user = migrateLegacy(dir)
    expect(user).toMatchObject({ username: 'legacy', role: 'admin', grants: [] })
    await expect(bootstrap('other', 'another-password', dir)).rejects.toThrow('已经初始化')
    const store = new AuthStore(dir)
    try { expect(await verifyPassword(store.credentials('legacy')!.password, 'test-password-123')).toBe(true) }
    finally { store.close() }
  })

  it('expired sessions and malformed cookies do not resolve', async () => {
    const store = await storeFixture()
    const user = store.create('alice', hash, 'user', [])
    const issued = store.createSession(user, -1)
    expect(store.fromToken(issued.token)).toBeUndefined()
    expect(store.fromToken('%malformed')).toBeUndefined()
  })
})

describe('same-port auth HTTP', () => {
  it('serves the independent page and directory with no public bootstrap', async () => {
    const f = await httpFixture()
    const page = await f.request('/auth')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('id="tool-dialog"')
    expect((await f.request('/auth/api/bootstrap', {})).status).toBe(401)
    expect((await f.request('/auth/health')).status).toBe(200)
    const login = await f.login()
    expect(login.response.status).toBe(200)
    expect(login.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Max-Age=3600')
    const plugins = await f.request('/auth/api/plugins', undefined, login.cookie)
    expect(await plugins.json()).toMatchObject({ plugins: [{ id: 'demo', tools: [{ name: 'test_query' }] }] })
    expect((await f.request('/auth/api/session', undefined, login.cookie)).status).toBe(200)
  })

  it('requires fixed origin and per-session CSRF for mutations', async () => {
    const f = await httpFixture()
    expect((await f.request('/auth/api/login', { username: 'admin', password: 'test-password-123' }, undefined, 'login', 'https://evil.example')).status).toBe(403)
    expect((await f.request('/auth/api/login', { username: 'admin', password: 'test-password-123' }, undefined, '')).status).toBe(403)
    const login = await f.login()
    expect((await f.request('/auth/api/logout', {}, login.cookie, 'login')).status).toBe(403)
    expect((await f.request('/auth/api/logout', undefined, login.cookie)).status).toBe(404)
    expect((await f.request('/auth/api/logout', {}, login.cookie, login.result.csrf)).status).toBe(200)
    expect((await f.request('/auth/api/plugins', undefined, login.cookie)).status).toBe(401)
  })

  it('gives administrators every entrance and denies ordinary administration', async () => {
    const f = await httpFixture()
    const login = await f.login()
    const session = f.store.fromToken(login.cookie.split('=')[1]!)!
    expect(() => f.service.assertAccess(actor(f.admin.id, session.id), 'demo')).not.toThrow('没有访问')
    f.store.create('alice', hash, 'user', ['demo'])
    const alice = await f.login('alice')
    expect((await f.request('/auth/api/users', undefined, alice.cookie)).status).toBe(403)
    const aSession = f.store.fromToken(alice.cookie.split('=')[1]!)!
    expect(() => f.service.assertAccess(actor(alice.result.user.id, aSession.id), 'demo')).not.toThrow()
    expect(() => f.service.assertAccess(actor(f.admin.id, aSession.id), 'demo')).toThrow('登录已失效')
  })

  it('creates users, updates grants, notifies revocation and invalidates current cookies', async () => {
    const f = await httpFixture()
    const admin = await f.login()
    const changes: Revocation[] = []
    f.ctx.on('ecosystem/revoked', change => { changes.push(change) })
    expect((await f.request('/auth/api/users', { username: 'alice', password: 'test-password-123', role: 'user', grants: ['demo'] }, admin.cookie, admin.result.csrf)).status).toBe(200)
    const alice = await f.login('alice')
    expect((await f.request('/auth/api/users', { id: alice.result.user.id, role: 'user', enabled: true, grants: [] }, admin.cookie, admin.result.csrf)).status).toBe(200)
    expect(changes).toContainEqual({ userId: alice.result.user.id })
    expect(await (await f.request('/auth/api/session', undefined, alice.cookie)).json()).toMatchObject({ user: null })
    expect((await f.request('/auth/api/users', { username: 'bad', password: 'test-password-123', role: 'user', grants: ['missing'] }, admin.cookie, admin.result.csrf)).status).toBe(400)
  })

  it('password change revokes all sessions but logout only revokes its session', async () => {
    const f = await httpFixture()
    const first = await f.login()
    const second = await f.login()
    await f.request('/auth/api/logout', {}, first.cookie, first.result.csrf)
    expect((await f.request('/auth/api/users', undefined, second.cookie)).status).toBe(200)
    expect((await f.request('/auth/api/password', { currentPassword: 'test-password-123', newPassword: 'replacement-password' }, second.cookie, second.result.csrf)).status).toBe(200)
    expect((await f.request('/auth/api/users', undefined, second.cookie)).status).toBe(401)
    expect((await f.login('admin', 'replacement-password')).response.status).toBe(200)
  })

  it('bounds login failures and request bodies without disclosing account existence', async () => {
    const f = await httpFixture()
    for (let index = 0; index < 3; index++) {
      const response = await f.request('/auth/api/login', { username: 'unknown', password: 'incorrect-password' })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: '用户名或密码错误' })
    }
    expect((await f.request('/auth/api/login', { username: 'unknown', password: 'test-password-123' })).status).toBe(429)
    expect((await f.request('/auth/api/login', { username: 'admin', password: 'test-password-123' })).status).toBe(200)
    expect((await f.request('/auth/api/login', { padding: 'x'.repeat(17000) })).status).toBe(413)
  })

  it('limits return destinations to granted plugin entry routes', () => {
    for (const path of ['//evil.example', '/\\evil.example', '/?token=secret', '/auth', '/demo-evil', 'https://evil.example']) expect(safeReturn(path, ['/demo'])).toBe('/auth')
    expect(safeReturn('/demo?conversation=x', ['/demo'])).toBe('/demo?conversation=x')
    expect(() => validateOrigin('https://example.com/path')).toThrow()
    expect(() => validateOrigin('https://example.com')).not.toThrow()
  })

  it('health rejects a stopped provider but an empty available database is ready', async () => {
    const empty = await storeFixture()
    const service = await AuthService.create(new Context(), empty, { sessionTtlSeconds: 60, maxAttempts: 3, lockSeconds: 30 })
    expect(() => service.ready()).not.toThrow()
    service.close()
    expect(() => service.ready()).toThrow('认证服务不可用')
    const f = await httpFixture()
    f.service.close()
    expect((await f.request('/auth/health')).status).toBe(503)
  })

  it('requires an explicit console grant, returns no credentials and observes revocation', async () => {
    const f = await httpFixture()
    const anonymous = await f.request('/auth/api/console-access')
    expect(anonymous.status).toBe(401)
    expect(await anonymous.text()).toBe('')
    expect(anonymous.headers.get('x-dsh-login')).toBe('/auth?returnTo=%2F')
    const admin = await f.login()
    const denied = await f.request('/auth/api/console-access', undefined, admin.cookie)
    expect(denied.status).toBe(204)
    expect(await denied.text()).toBe('')
    expect((await f.request('/auth/api/users', { username: 'console-user', password: 'test-password-123', role: 'user', grants: ['dsh-console'] }, admin.cookie, admin.result.csrf)).status).toBe(200)
    const consoleUser = await f.login('console-user')
    const permitted = await f.request('/auth/api/console-access', undefined, consoleUser.cookie)
    expect(permitted.status).toBe(204)
    expect(await permitted.text()).toBe('')
    expect(permitted.headers.get('set-cookie')).toBeNull()
    expect(permitted.headers.get('cache-control')).toBe('no-store')
    expect((await f.request('/auth/api/users', { id: consoleUser.result.user.id, role: 'user', enabled: true, grants: [] }, admin.cookie, admin.result.csrf)).status).toBe(200)
    expect((await f.request('/auth/api/console-access', undefined, consoleUser.cookie)).status).toBe(401)
    const renewed = await f.login('console-user')
    expect((await f.request('/auth/api/console-access', undefined, renewed.cookie)).status).toBe(403)
    f.service.close()
    const unavailable = await f.request('/auth/api/console-access', undefined, renewed.cookie)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.text()).toBe('')
  })

  it('delegates registered plugin namespaces to their own guards without opening console paths', async () => {
    const f = await httpFixture()
    const check = (uri: string) => f.request('/auth/api/console-access', undefined, undefined, 'login', f.origin, { 'x-original-uri': uri })
    for (const path of ['/demo', '/demo/health', '/demo/chat?key=value', '/demo%2fhealth', '/demo//health']) expect((await check(path)).status).toBe(204)
    for (const path of ['/api', '/api/socket', '/demo-evil', '/demo/../api', '/demo/%2e%2e/api', '/demo/%2e%2e%2fapi', '/demo/.%2e%2Fapi', '/demo%2f..%2fapi', '/api/%252e%252e/demo']) expect((await check(path)).status).toBe(401)
    for (const path of ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/%2fevil.example/', '/demo/%5c../api', '/demo/%00', '/demo/%zz']) expect((await check(path)).status).toBe(403)
    expect(safeReturn('/demo/%2e%2e%2fapi', ['/demo'])).toBe('/auth')
    const remove = registerPlugin(f.ctx, { id: 'future', packageName: 'dsh-future', version: 'test', displayName: '未来插件', description: '测试', entryPath: '/future', permissions: [], tools: [] })
    expect((await check('/future/health')).status).toBe(204)
    remove()
    expect((await check('/future/health')).status).toBe(401)
    const original = '/?token=opaque%2Blaunch%3D&view=home'
    const unauthenticated = await check(original)
    expect(unauthenticated.headers.get('x-dsh-login')).toBe(`/auth?returnTo=${encodeURIComponent(original)}`)
    expect(await unauthenticated.text()).toBe('')
    expect((await f.request('/auth/api/console-access', {})).status).toBe(405)
  })

  it('filters ordinary catalog access and keeps console targets distinct from running plugins', async () => {
    const f = await httpFixture()
    registerPlugin(f.ctx, { id: 'private-plugin', packageName: 'dsh-private', version: 'test', displayName: '另一个插件', description: '测试', permissions: [], tools: [] })
    f.store.create('alice', hash, 'user', ['demo'])
    f.store.create('console-user', hash, 'user', ['dsh-console'])
    const alice = await f.login('alice')
    const visible = await (await f.request('/auth/api/plugins', undefined, alice.cookie)).json()
    expect(visible.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(['demo'])
    expect(visible.accessTargets).toEqual([])
    const consoleUser = await f.login('console-user')
    const consoleCatalog = await (await f.request('/auth/api/plugins', undefined, consoleUser.cookie)).json()
    expect(consoleCatalog.plugins).toEqual([])
    expect(consoleCatalog.accessTargets).toMatchObject([{ id: 'dsh-console', entryPath: '/' }])
    const admin = await f.login()
    const full = await (await f.request('/auth/api/plugins', undefined, admin.cookie)).json()
    expect(full.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(['demo', 'private-plugin'])
    expect(full.accessTargets).toMatchObject([{ id: 'dsh-console' }])
    const original = '/?token=opaque%2Blaunch%3D&view=home'
    const suffix = `?returnTo=${encodeURIComponent(original)}`
    expect(await (await f.request('/auth/api/session' + suffix, undefined, consoleUser.cookie)).json()).toMatchObject({ returnTo: original, accessTargets: [{ id: 'dsh-console' }] })
    expect(await (await f.request('/auth/api/session' + suffix, undefined, admin.cookie)).json()).toMatchObject({ returnTo: original, accessTargets: [{ id: 'dsh-console' }] })
    for (const path of ['/api', '/settings', '/other/path']) expect(safeReturn(path, [], true)).toBe('/auth')
    expect(safeReturn('/', ['/'], false)).toBe('/auth')
  })
})


describe('initial administrator and inherited access', () => {
  it('creates a restricted default once and preserves all existing administrator data', async () => {
    const store = await storeFixture()
    await Promise.all([ensureDefaultAdministrator(store), ensureDefaultAdministrator(store)])
    expect(store.users()).toHaveLength(1)
    const first = store.credentials('admin')!
    expect(first).toMatchObject({ role: 'admin', mustChangePassword: true })
    expect(await verifyPassword(first.password, '123456')).toBe(true)
    await ensureDefaultAdministrator(store)
    expect(store.credentials('admin')).toEqual(first)
    const existing = await storeFixture()
    existing.create('owner', hash, 'admin', ['existing'])
    const before = existing.credentials('owner')
    await ensureDefaultAdministrator(existing)
    expect(existing.credentials('owner')).toEqual(before)
    expect(existing.users()).toHaveLength(2)
    expect(existing.credentials('admin')).toMatchObject({ role: 'admin', mustChangePassword: true })
    expect(await verifyPassword(existing.credentials('admin')!.password, '123456')).toBe(true)
  })

  it('does not overwrite an ordinary account that occupies the default name', async () => {
    const store = await storeFixture()
    const user = store.create('admin', hash, 'user', ['existing'])
    store.update(user.id, { role: 'user', enabled: false, grants: user.grants })
    const before = store.credentials('admin')
    await ensureDefaultAdministrator(store)
    expect(store.credentials('admin')).toEqual(before)
    expect(store.users()).toHaveLength(1)
  })

  it('blocks all privileged and business access until initial password replacement', async () => {
    const f = await httpFixture(true)
    const login = await f.login('admin', '123456')
    expect(login.response.status).toBe(200)
    const state = await (await f.request('/auth/api/session', undefined, login.cookie)).json()
    expect(state).toMatchObject({ user: { mustChangePassword: true }, plugins: [], accessTargets: [], returnTo: '/auth' })
    for (const path of ['/auth/api/users', '/auth/api/plugins', '/auth/api/console-access']) expect((await f.request(path, undefined, login.cookie)).status).toBe(403)
    expect((await f.request('/auth/api/users', { username: 'blocked', password: 'test-password-123', role: 'admin', grants: [] }, login.cookie, login.result.csrf)).status).toBe(403)
    const session = f.store.fromToken(login.cookie.split('=')[1]!)!
    expect(() => f.service.assertAccess(actor(f.admin.id, session.id), 'demo')).toThrow('修改初始密码')
    expect((await f.request('/auth/api/password', { currentPassword: '123456', newPassword: '123456' }, login.cookie, login.result.csrf)).status).toBe(400)
    expect((await f.request('/auth/api/password', { currentPassword: '123456', newPassword: 'changed-password-123' }, login.cookie, login.result.csrf)).status).toBe(200)
    expect(f.store.user(f.admin.id)?.mustChangePassword).toBe(false)
    expect(f.store.fromToken(login.cookie.split('=')[1]!)).toBeUndefined()
    const renewed = await f.login('admin', 'changed-password-123')
    expect((await f.request('/auth/api/plugins', undefined, renewed.cookie)).status).toBe(200)
    expect((await f.request('/auth/api/console-access', undefined, renewed.cookie)).status).toBe(204)
  })

  it('ignores forged partial administrator grants and includes newly registered entrances', async () => {
    const f = await httpFixture()
    const login = await f.login()
    expect((await f.request('/auth/api/users', { username: 'manager', password: 'test-password-123', role: 'admin', grants: [] }, login.cookie, login.result.csrf)).status).toBe(200)
    const manager = await f.login('manager')
    registerPlugin(f.ctx, { id: 'future', packageName: 'future', version: 'test', displayName: '新增', description: '新增', entryPath: '/future', permissions: [], tools: [] })
    const state = await (await f.request('/auth/api/session', undefined, manager.cookie)).json()
    expect(state.user.grants).toEqual(expect.arrayContaining(['demo', 'future', 'dsh-console']))
    const session = f.store.fromToken(manager.cookie.split('=')[1]!)!
    expect(() => f.service.assertAccess(actor(manager.result.user.id, session.id), 'future')).not.toThrow()
  })
})


it('migrates v1 without changing passwords or login sessions and persists the initial-password flag', async () => {
  const dir = await directory()
  let store = new AuthStore(dir)
  const user = store.create('owner', hash, 'admin', ['demo'])
  const issued = store.createSession(user, 3600)
  store.close()
  const old = new DatabaseSync(join(dir, 'auth.sqlite'))
  old.exec('ALTER TABLE users DROP COLUMN must_change_password; PRAGMA user_version=1;')
  old.close()
  store = new AuthStore(dir)
  expect(store.user(user.id)).toEqual(user)
  expect(store.fromToken(issued.token)?.userId).toBe(user.id)
  expect(await verifyPassword(store.credentials('owner')!.password, 'test-password-123')).toBe(true)
  store.close()
  const emptyDir = await directory()
  store = new AuthStore(emptyDir)
  await ensureDefaultAdministrator(store)
  store.close()
  store = new AuthStore(emptyDir)
  try { expect(store.credentials('admin')?.mustChangePassword).toBe(true) } finally { store.close() }
})
