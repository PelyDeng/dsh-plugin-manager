/** Real HTTP requests with local fake Agents: no model or business gateway is contacted. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessError, createAccess, createPluginHttp, emitRevoked, installProvider, onRevoked, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { ConversationManager } from '../src/agent.ts'
import { ConversationStore } from '../src/conversation-store.ts'
import { Config } from '../src/config.ts'
import { installWeb, renderHttpError } from '../src/web.ts'

type Route = { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
// The test bus hosts multiple event signatures and forwards the original argument tuple unchanged.
type Listener = (...args: any[]) => void
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture(mode: 'standalone' | 'authenticated' = 'authenticated') {
  const effects: (() => void)[] = []
  const listeners = new Map<string, Set<Listener>>()
  const routes = new Map<string, Route>()
  const revoked = new Set<string>()
  const actors = new Map<string, Actor>([
    ['alice', { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }],
    ['alice-other', { namespace: 'user', userId: 'alice', sessionId: 'alice-other-login' }],
    ['bob', { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }],
  ])
  const cancel = vi.fn()
  const feedback = vi.fn(async () => ({ ok: true, value: { items: [] } }))
  const bus = {
    get(key: string): unknown { return this[key as keyof typeof this] },
    llm: {resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low'}]}}),resolveCallConfig:async(value:unknown)=>value},
    sessionController: { modelCatalog: vi.fn(async () => ({ groups: [{ id: 'test', name: 'Test', models: [{ id: 'test', name: 'Test' }] }], failures: [] })) },
    on(name: string, listener: Listener) {
      const group = listeners.get(name) ?? new Set<Listener>()
      group.add(listener); listeners.set(name, group)
      const dispose = () => { group.delete(listener) }
      effects.push(dispose); return dispose
    },
    emit(name: string, ...args: unknown[]) { for (const listener of [...listeners.get(name) ?? []]) listener(...args) },
    effect(effect: () => (() => void)) { const dispose = effect(); effects.push(dispose); return dispose },
    webServer: { register(route: Route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
    messageFeedback: { list: feedback, put: vi.fn(), delete: vi.fn() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create: vi.fn(async () => ({ agent: { cancel, followup: vi.fn(), whenIdle: vi.fn(async () => {}), session: { snapshotEvents: () => [] } }, dispose: vi.fn(async () => undefined) })) },
  }
  const ctx = Object.assign(bus, { root: bus }) as unknown as Context
  const removeProvider = installProvider(ctx, {
    protocol: 1,
    ready: () => {},
    resolve: req => actors.get(req.headers.cookie ?? ''),
    assertAccess: actor => { if (actor.namespace !== 'user' || revoked.has(actor.sessionId)) throw new AccessError(401, '登录失效') },
  })
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.get(path) ?? [...routes.values()].find(item => item.kind === 'prefix' && path.startsWith(`${item.path}/`))
    if (!route) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const access = createAccess(ctx, { mode, pluginId: 'closedoff', publicOrigin: origin })
  const store = new ConversationStore(':memory:')
  const config = Config({ accessMode: mode, publicOrigin: origin, authRecheckMs: 100 } as Config)
  const manager = new ConversationManager(ctx, config, 'persona', [], access, store)
  onRevoked(ctx, () => manager.revokeInvalid())
  // installWeb 现在接收注入的 HTTP 注册器（由群组创建）。这里按群组的真实做法构造：
  // 带上本子包自己的错误渲染器，否则参数校验失败会被报成 500，前端无法区分输错和服务故障。
  const http = createPluginHttp(ctx, { access, routePrefix: config.routePrefix, onError: renderHttpError })
  await installWeb(ctx, config, manager, access, http)
  cleanup.push(async () => {
    for (const dispose of effects.reverse()) dispose()
    await manager.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const request = (path: string, cookie = 'alice', data?: unknown, extra: Record<string, string> = {}) => fetch(origin + path, {
    redirect: 'manual', method: data === undefined ? 'GET' : 'POST',
    headers: { cookie, origin, 'content-type': 'application/json', ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  return { request, actors, manager, bus, ctx, revoked, cancel, feedback, removeProvider }
}

describe('HTTP authentication and conversation ownership', () => {
  it('searches, pins and renames only owned idle sidebar conversations', async () => {
    const { request, actors, manager } = await fixture()
    const actor = actors.get('alice')!, first = (await manager.open(undefined, true, actor))!, second = (await manager.open(undefined, true, actor))!
    const action = (data: unknown, cookie = 'alice') => request('/closedoff-qa/conversation-action', cookie, data)
    expect((await action({ operation: 'rename', ids: [first.id], title: '园区概览' })).status).toBe(200)
    expect((await action({ operation: 'pin', ids: [first.id], pinned: true })).status).toBe(200)
    const list = await (await request('/closedoff-qa/conversations?q=' + encodeURIComponent('园区'))).json()
    expect(list.items).toEqual([expect.objectContaining({ id: first.id, title: '园区概览', pinned: 1 })])
    expect((await action({ operation: 'rename', ids: [first.id], title: '越权' }, 'bob')).status).toBe(404)
    expect((await action({ operation: 'rename', ids: [first.id], title: ' ' })).status).toBe(400)
    expect((await action({ operation: 'pin', ids: [first.id, second.id], pinned: true })).status).toBe(400)
    first.active = true
    expect((await action({ operation: 'rename', ids: [first.id], title: '忙碌' })).status).toBe(409)
    first.active = false
    expect((await action({ operation: 'rename', ids: [first.id], title: '拒绝' }, '')).status).toBe(401)
    expect((await request('/closedoff-qa/conversation-action', 'alice', { operation: 'pin', ids: [first.id], pinned: false }, { origin: 'https://foreign.test' })).status).toBe(403)
  })
  it('reports a removed cached model as an SSE error without dispatching a followup', async () => {
    const { request, actors, manager, bus } = await fixture()
    const c = (await manager.open(undefined, true, actors.get('alice')!))!
    bus.sessionController.modelCatalog.mockResolvedValueOnce({ groups: [], failures: [] })
    const response = await request('/closedoff-qa/chat', 'alice', { conversationId: c.id, message: '不可派发' })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('该模型不在当前目录中')
    expect(c.handle.agent.followup).not.toHaveBeenCalled()
    expect(c.active).toBe(false)
  })
  it('stopping during catalog await prevents the later HTTP continuation from calling the Agent', async () => {
    const { request, actors, manager, bus } = await fixture()
    const c = (await manager.open(undefined, true, actors.get('alice')!))!
    const catalog = await bus.sessionController.modelCatalog()
    let release!: (value: typeof catalog) => void
    bus.sessionController.modelCatalog.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const response = await request('/closedoff-qa/chat', 'alice', { conversationId: c.id, message: '等待目录' })
    const reader = response.body!.getReader()
    await reader.read()
    expect(c.active).toBe(true)
    expect((await request('/closedoff-qa/stop', 'alice', { conversationId: c.id })).status).toBe(200)
    release(catalog)
    let remaining = ''
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value) }
    expect(remaining).toContain('本轮操作已停止')
    expect(c.handle.agent.followup).not.toHaveBeenCalled()
    expect(c.active).toBe(false)
  })
  it('redirects the page, rejects anonymous APIs and validates mutation origin', async () => {
    const { request } = await fixture()
    expect((await request('/closedoff-qa', '')).status).toBe(303)
    for (const path of ['/identity', '/conversations', '/history']) expect((await request('/closedoff-qa' + path, '')).status).toBe(401)
    expect((await request('/closedoff-qa/chat', 'alice', { message: 'q' }, { origin: 'https://foreign.test' })).status).toBe(403)
    expect((await request('/closedoff-qa/conversations?limit=100000')).status).toBe(400)
    // 存活与就绪探针由群组统一提供（/agents/health、/agents/ready 与 /agents/<id>/ready）。
    // 子包不再注册自己的探针：容器级探针是群组的职责，重复一份还会因前缀来源不同而冲突。
    expect((await request('/closedoff-qa/health', '')).status).toBe(404)
    expect((await request('/closedoff-qa/ready', '')).status).toBe(404)
  })
  it('rejects every foreign conversation operation before reading history or feedback', async () => {
    const { request, actors, manager, feedback, cancel } = await fixture()
    const owned = (await manager.open(undefined, true, actors.get('alice')!))!
    expect((await request('/closedoff-qa/history?conversationId=' + owned.id, 'bob')).status).toBe(404)
    for (const route of ['chat', 'stop', 'branch', 'feedback']) {
      const response = await request('/closedoff-qa/' + route, 'bob', { conversationId: owned.id, message: 'q', atSeq: 2, messageId: 'm', rating: 'positive', userId: 'alice' })
      expect(response.status, route).toBe(404)
    }
    expect(feedback).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect((await (await request('/closedoff-qa/conversations', 'alice')).json()).items).toHaveLength(1)
    expect((await (await request('/closedoff-qa/conversations', 'bob')).json()).items).toEqual([])
  })
  it('ends an active SSE on revocation and never sends a late private event', async () => {
    const { request, revoked, ctx, bus, cancel } = await fixture()
    const response = await request('/closedoff-qa/chat', 'alice', { message: 'q' })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const initial = new TextDecoder().decode((await reader.read()).value)
    const id = JSON.parse(initial.slice(6).trim()).conversationId
    revoked.add('alice-login'); emitRevoked(ctx, { sessionId: 'alice-login' })
    bus.emit('session/event', { id }, { type: 'assistant/message', data: { step: 1, message: { id: 'm', content: [{ type: 'text', text: 'SECRET' }] } } })
    expect(await reader.read()).toEqual({ value: undefined, done: true })
    expect(cancel).toHaveBeenCalled()
    expect((await request('/closedoff-qa/chat', 'alice-other', { conversationId: id, message: 'new login' })).status).toBe(409)
    bus.emit('session/event', { id }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    const next = await request('/closedoff-qa/chat', 'alice-other', { conversationId: id, message: 'new login' })
    expect(next.status).toBe(200)
    await next.body!.cancel()
  })
  it('bounds session expiry even without a revocation event', async () => {
    const { request, revoked } = await fixture()
    const response = await request('/closedoff-qa/chat', 'alice', { message: 'q' })
    const reader = response.body!.getReader()
    await reader.read()
    revoked.add('alice-login')
    expect(await reader.read()).toEqual({ value: undefined, done: true })
  })
  it('fails closed when a provider is removed while standalone remains usable', async () => {
    const authenticated = await fixture()
    authenticated.removeProvider()
    expect((await authenticated.request('/closedoff-qa/history')).status).toBe(503)
    // 探针归群组所有；这里只确认业务接口在认证不可用时的失败关闭行为。
    const standalone = await fixture('standalone')
    standalone.removeProvider()
    expect((await standalone.request('/closedoff-qa', '')).status).toBe(200)
    expect((await standalone.request('/closedoff-qa/conversations', '')).status).toBe(200)
    expect(() => standalone.manager.authorizeAgent(undefined)).not.toThrow()
  })

  // 页面模块按文件名直接引用、没有内容指纹：长缓存会让回访浏览器跑「新 app.js + 旧 cards.js」。
  // 这里对真实响应头取证；`pnpm test` 会先跑 build:web 生成 web/assets。
  it.skipIf(!existsSync(fileURLToPath(new URL('../web/assets/cards.js', import.meta.url))))('revalidates first-party page modules and still long-caches vendored bundles', async () => {
    const { request } = await fixture()
    for (const asset of ['cards.js', 'app.js', 'app.css', 'labels.js', 'format.js', 'render-text.js', 'model-picker.js', 'trajectory.js']) {
      const response = await request(`/closedoff-qa/assets/${asset}`)
      expect(response.status, asset).toBe(200)
      expect(response.headers.get('cache-control'), asset).toBe('no-cache')
    }
    const vendored = await request('/closedoff-qa/assets/video-player/vue.global.prod.js')
    expect(vendored.status).toBe(200)
    expect(vendored.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    // 认证仍然在读取文件之后、写响应之前生效：未登录拿不到内容。
    expect((await request('/closedoff-qa/assets/cards.js', '')).status).toBe(401)
  })
})
