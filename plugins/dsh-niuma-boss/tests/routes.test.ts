import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { installWeb } from '../src/routes.ts'

/**
 * 服务端路由行为：页面/静态资源要求登录与 niuma-boss:access，未登录重定向登录页，
 * 越界路径 404，内容只在断言通过后发出。路由注册走真实 kit `createPluginHttp`。
 */

interface Recorded {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

class ResponseStub {
  headersSent = false
  status = 0
  headers: Record<string, string | string[] | undefined> = {}
  chunks: Buffer[] = []
  destroyed = false
  writeHead(status: number, headers?: Record<string, string | string[] | undefined>): this {
    this.status = status
    this.headers = headers ?? {}
    this.headersSent = true
    return this
  }
  write(chunk: Buffer | string): void { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) }
  end(chunk?: Buffer | string): void { if (chunk !== undefined) this.write(chunk) }
  destroy(): void { this.destroyed = true }
  get body(): string { return Buffer.concat(this.chunks).toString('utf8') }
  get record(): Recorded { return { status: this.status, headers: this.headers, body: this.body } }
}

interface Route { kind: string; path: string; handler: (request: unknown, response: ResponseStub) => Promise<void> | void }

const actor: Actor = { namespace: 'user', userId: 'u1', sessionId: 's1' }

let routes: Route[]
let root: string
let assertCalls: number
let deny: 'none' | 'unauthorized' | 'forbidden' | 'ready'

beforeEach(async () => {
  routes = []
  assertCalls = 0
  deny = 'none'
  root = await mkdtemp(join(tmpdir(), 'niuma-web-'))
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'generated'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="/niuma-boss/assets/app.js"></script></body></html>', 'utf8')
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("app")', 'utf8')
  await writeFile(join(root, 'generated', 'office.runtime.json'), '{"id":"office"}', 'utf8')
  await writeFile(join(root, 'secret.txt'), 'top-secret', 'utf8')
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const access: Access = {
  mode: 'authenticated',
  ready() { if (deny === 'ready') throw new AccessError(503, '认证服务不可用') },
  resolve: () => actor,
  assert() {
    assertCalls++
    if (deny === 'unauthorized') throw new AccessError(401, '需要登录')
    if (deny === 'forbidden') throw new AccessError(403, '没有 niuma-boss:access 权限')
  },
}

async function install(routePrefix = '/niuma-boss'): Promise<void> {
  const ctx = {
    webServer: { register: (route: Route) => { routes.push(route); return () => {} } },
    effect: (effect: () => unknown) => effect(),
  } as unknown as Context
  await installWeb(ctx, { accessMode: 'authenticated', publicOrigin: 'http://localhost', routePrefix }, access, root)
}

const invoke = async (path: string, method = 'GET'): Promise<Recorded> => {
  const route = routes.find(r => r.kind === 'exact' && r.path === path) ?? routes.find(r => r.kind === 'prefix' && path.startsWith(r.path))
  if (!route) throw new Error('未注册路由：' + path)
  const response = new ResponseStub()
  await route.handler({ method, url: path }, response)
  return response.record
}

describe('公开探针', () => {
  beforeEach(async () => { await install() })

  it('health 不做身份断言直接 200', async () => {
    const record = await invoke('/niuma-boss/health')
    expect(record.status).toBe(200)
    expect(JSON.parse(record.body)).toEqual({ ok: true })
    expect(assertCalls).toBe(0)
  })

  it('ready 在依赖不可用时 503', async () => {
    deny = 'ready'
    const record = await invoke('/niuma-boss/ready')
    expect(record.status).toBe(503)
    expect(JSON.parse(record.body)).toEqual({ ok: false })
  })
})

describe('页面与静态资源', () => {
  beforeEach(async () => { await install() })

  it('页面注入运行配置并按部署前缀改写资源地址', async () => {
    const record = await invoke('/niuma-boss')
    expect(record.status).toBe(200)
    expect(record.headers['content-type']).toContain('text/html')
    expect(record.body).toContain('__NIUMA_BOSS_CONFIG__')
    expect(record.body).toContain('"/niuma-boss"')
  })

  it('未登录打开页面重定向登录页并带回跳地址', async () => {
    deny = 'unauthorized'
    const record = await invoke('/niuma-boss')
    expect(record.status).toBe(303)
    expect(record.headers.location).toBe('/auth?returnTo=%2Fniuma-boss')
  })

  it('静态资源在断言通过后发出，且断言一定发生在内容之前', async () => {
    const record = await invoke('/niuma-boss/assets/app.js')
    expect(record.status).toBe(200)
    expect(record.headers['content-type']).toContain('text/javascript')
    expect(record.body).toBe('console.log("app")')
    expect(assertCalls).toBe(1)
  })

  it('无权限（403）时返回 JSON 错误而不是内容', async () => {
    deny = 'forbidden'
    const record = await invoke('/niuma-boss/assets/app.js')
    expect(record.status).toBe(403)
    expect(record.body).not.toContain('console.log')
    expect(JSON.parse(record.body).error).toContain('权限')
  })

  it('越界与缺失路径一律 404，不泄露目录外文件', async () => {
    expect((await invoke('/niuma-boss/assets/..%2fsecret.txt')).status).toBe(404)
    expect((await invoke('/niuma-boss/assets/missing.js')).status).toBe(404)
    expect((await invoke('/niuma-boss/generated/office.runtime.json')).status).toBe(200)
  })

  it('非 GET 请求 405', async () => {
    expect((await invoke('/niuma-boss/assets/app.js', 'POST')).status).toBe(405)
  })
})

describe('部署前缀', () => {
  it('改 routePrefix 后页面与资源都按新前缀服务', async () => {
    await install('/game-x')
    const page = await invoke('/game-x')
    expect(page.status).toBe(200)
    expect(page.body).toContain('/game-x/assets/app.js')
    expect(page.body).not.toContain('/niuma-boss/')
    expect((await invoke('/game-x/generated/office.runtime.json')).status).toBe(200)
  })
})
