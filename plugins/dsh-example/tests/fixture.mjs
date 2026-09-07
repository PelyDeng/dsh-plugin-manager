/** Isolated HTTP harness; only the model/Agent driver is simulated. No external APIs. */
import { createServer } from 'node:http'
import { apply, Config } from '../dist/index.mjs'

export async function fixture({ mode, autoReply = false, persistenceApi = 'handle', logs = new Map(), feedbackService, beforeCreate = async () => {}, beforeDispose = async () => {}, ...overrides } = {}) {
  const routes = new Map(), listeners = new Map(), effects = [], handles = [], timers = new Set()
  const tools = new Map()
  const revoked = new Set()
  let provider = true
  const actors = { alice: { namespace: 'user', userId: 'alice', sessionId: 'login-a' },
    other: { namespace: 'user', userId: 'alice', sessionId: 'login-b' }, bob: { namespace: 'user', userId: 'bob', sessionId: 'login-c' } }
  const ctx = {
    messageFeedback:feedbackService,
    on(name, listener) { const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group); return () => group.delete(listener) },
    emit(name, ...args) { for (const f of [...listeners.get(name) ?? []]) f(...args) },
    effect(factory) { const dispose = factory(); effects.push(dispose); return dispose },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    sessionPersistence: persistenceApi === 'inspection'
      ? { async inspect(id) { return { events: logs.get(id) ?? [] } } }
      : { async open(id) { return { async read() { return logs.get(id) ?? [] }, async close() {} } } },
    agents: { async resume(options) { return this.create({ ...options, sessionId: options.resumeSessionId }) }, async create(options) {
      await beforeCreate(options)
      if (!logs.has(options.sessionId)) logs.set(options.sessionId, [...options.seed??[]])
      const handle = { id: options.sessionId, cancelled: false, disposed: false, messages: [], sections: [], contexts: [], allowed: undefined,
        agent: { session: { snapshotEvents: () => logs.get(handle.id) }, cancel() { handle.cancelled = true }, followup(message) {
          handle.messages.push(message)
          logs.get(handle.id).push({ type: 'user/message', data: message })
          if (autoReply) {
            const text = '你好！这是隔离测试模型的流式回答。可以继续追问，或试试左侧的新建对话。'
            const reasoning = '这是隔离测试模型返回的思考片段：先理解问题，再组织回答。'
            let index = 0
            const timer = setInterval(() => {
              if (handle.cancelled) { clearInterval(timer); timers.delete(timer); return }
              if (index < reasoning.length + text.length) {
                const chunk = index < reasoning.length
                  ? { type: 'reasoning-delta', text: reasoning[index] }
                  : { type: 'text-delta', text: text[index - reasoning.length] }
                index++
                const event = { type: 'assistant/chunk', data: { chunk } }
                logs.get(handle.id).push(event); ctx.emit('session/event', { id: handle.id }, event)
              }
              else { clearInterval(timer); timers.delete(timer); ctx.emit('session/event', { id: handle.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }) }
            }, 35)
            timers.add(timer)
          }
        } },
        async dispose() { await beforeDispose(); handle.disposed = true },
      }
      options.setup({ systemPrompt: { section(value) { handle.sections.push(value) }, context(value) { handle.contexts.push(value) } }, tools: { restrict(value) { handle.allowed = value.allow } } })
      handles.push(handle)
      return handle
    } },
  }
  ctx.root = ctx
  ctx.on('ecosystem/providers', accept => {
    if (provider) accept({ protocol: 1, ready() {}, resolve(req) { return actors[req.headers.cookie] },
      assertAccess(actor, pluginId) {
        if (pluginId !== 'example' || revoked.has(actor.sessionId)) {
          const error = new Error('访问已撤销'); error.code = 'DSH_ACCESS_ERROR'; error.status = 403; throw error
        }
      },
    })
  })
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (!route) { res.writeHead(404); res.end(); return }
    void Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500); res.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  await apply(ctx, Config({ accessMode: mode, publicOrigin: origin, authRecheckMs: 100, historyPath: ':memory:', ...overrides }))
  return {
    origin, ctx, handles, revoked, tools,
    removeProvider() { provider = false; ctx.emit('ecosystem/revoked', {}) },
    emit(handle, type, data) { const event = { type, data }; logs.get(handle.id).push(event); ctx.emit('session/event', { id: handle.id }, event) },
    request(path, data, cookie = 'alice', headers = {}, signal) { return fetch(origin + '/example' + path, {
      ...(signal ? { signal } : {}),
      method: data === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { cookie, origin, 'content-type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }) },
    async close() {
      await Promise.all(effects.reverse().map(effect => effect()))
      for (const timer of timers) clearInterval(timer)
      listeners.clear(); server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
