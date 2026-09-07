/** Real HTTP requests with local fake Agents: no model or business gateway is contacted. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessError, createAccess, emitRevoked, installProvider, onRevoked, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { ConversationManager } from '../src/agent.ts'
import { ConversationStore } from '../src/conversation-store.ts'
import { Config } from '../src/config.ts'
import { installWeb } from '../src/web.ts'

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
    agents: { create: vi.fn(async () => ({ agent: { cancel, followup: vi.fn(), session: { snapshotEvents: () => [] } }, dispose: vi.fn(async () => undefined) })) },
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
  await installWeb(ctx, config, manager, access)
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
  it('redirects the page, rejects anonymous APIs and validates mutation origin', async () => {
    const { request } = await fixture()
    expect((await request('/closedoff-qa', '')).status).toBe(303)
    for (const path of ['/identity', '/conversations', '/history']) expect((await request('/closedoff-qa' + path, '')).status).toBe(401)
    expect((await request('/closedoff-qa/chat', 'alice', { message: 'q' }, { origin: 'https://foreign.test' })).status).toBe(403)
    expect((await request('/closedoff-qa/conversations?limit=100000')).status).toBe(400)
    expect((await request('/closedoff-qa/health', '')).status).toBe(200)
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
    expect((await authenticated.request('/closedoff-qa/ready', '')).status).toBe(503)
    expect((await authenticated.request('/closedoff-qa/health', '')).status).toBe(200)
    const standalone = await fixture('standalone')
    standalone.removeProvider()
    expect((await standalone.request('/closedoff-qa', '')).status).toBe(200)
    expect((await standalone.request('/closedoff-qa/conversations', '')).status).toBe(200)
    expect((await standalone.request('/closedoff-qa/ready', '')).status).toBe(200)
    expect(() => standalone.manager.authorizeAgent(undefined)).not.toThrow()
  })
})
