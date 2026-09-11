/** 实际 HTTP、权限、派单与存储；只替换模型驱动和业务系统，禁止网络业务访问。 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, Config } from '../dist/index.mjs'

export async function fixture({ model = async () => '船长回答', providers = [], beforeCreate, browserLogin = false, timeoutMs = 3000 } = {}) {
  const listeners = new Map(), routes = [], effects = [], tools = new Map(), handles = [], logs = new Map()
  const revoked = new Set()
  const models = {
    selected: { provider: 'fixture', model: 'captain' },
    groups: [{ id: 'fixture', name: '本地测试模型', models: [{ id: 'captain', name: '船长' }, { id: 'navigator', name: '领航员' }] }],
    failures: [], selections: [], routes: [],
  }
  const actors = {
    alice: { namespace: 'user', userId: 'alice', sessionId: 'alice-login' },
    bob: { namespace: 'user', userId: 'bob', sessionId: 'bob-login' },
  }
  const reject = () => { const error = new Error('访问已撤销'); error.code = 'DSH_ACCESS_ERROR'; error.status = 403; throw error }
  const ctx = {
    on(name, listener) { const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group); return () => group.delete(listener) },
    emit(name, ...args) { for (const listener of [...listeners.get(name) ?? []]) listener(...args) },
    effect(factory) { const cleanup = factory(); effects.push(cleanup); return cleanup },
    get(key) { return this[key] },
    webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    agentDefaultModel: { currentSelection: () => ({ ...models.selected }) },
    llm: { async resolveCallConfig(selection) { models.routes.push({ ...selection }); return selection } },
    sessionController: {
      async modelCatalog() { return { groups: models.groups, failures: models.failures, selected: models.selected } },
      async selectModel({ sessionId, ...selection }) {
        if (!logs.has(sessionId)) throw new Error('missing session')
        // 模拟官方 Session.append 的提交前同步校验；副作用必须位于其后。
        const event = { type: 'model/selection', data: selection }
        ctx.emit('internal/dispatch', 'emit', 'session/event', [{ id: sessionId }, event], null)
        logs.get(sessionId).push(event)
        ctx.emit('session/event', { id: sessionId }, event)
        handles.findLast(handle => handle.id === sessionId).selection = { ...selection }
        models.selections.push({ sessionId, ...selection })
        models.selected = { ...selection }
        return { selected: selection }
      },
    },
    sessionPersistence: { async open(id, access) {
      if (access !== 'read' || !logs.has(id)) throw new Error('missing readable session')
      return { header: { id }, async read() { return { events: logs.get(id), eventState: 'detached' } }, async close() {} }
    } },
    sessionProjections: { restore(_checkpoint, events) {
      const latest = events.findLast(event => ['model/selection', 'request/header'].includes(event.type))
      const selected = latest?.type === 'model/selection' ? latest.data : latest?.data.header.config
      return { checkpoint: { modelSelection: { val: { lastUsed: selected ?? null, pending: null } } } }
    } },
    agents: {
      async resume(options) { if (!logs.has(options.resumeSessionId)) throw new Error('missing session'); return this.create({ ...options, sessionId: options.resumeSessionId }) },
      async create(options) {
        await beforeCreate?.(options)
        if (!logs.has(options.sessionId)) logs.set(options.sessionId, [])
        const controller = new AbortController()
        let work = Promise.resolve()
        let processing = false
        const inbox = []
        const handle = { id: options.sessionId, disposed: false, messages: [], allowed: [], selection: { ...options.agentOptions },
          agent: {
            cancel() { controller.abort(); inbox.length = 0 },
            whenIdle() { return work },
            steer(message) { this.followup(message) },
            followup(message) {
              handle.messages.push(message)
              inbox.push(message)
              if (processing) return
              processing = true
              work = (async () => {
                while (inbox.length && !controller.signal.aborted) {
                  const message = inbox.shift()
                  emit(handle, 'user/message', message)
                  emit(handle, 'request/header', { header: { config: { ...handle.selection } } })
                try {
                  const answer = await model({ message, signal: controller.signal, handle,
                    assign: tasks => tools.get('pirate_assign').execute({ tasks }, { agent: handle.agent, signal: controller.signal, callId: randomUUID() }),
                    publishTopic: keywords => tools.get('pirate_topic').execute({ keywords }, { agent: handle.agent, signal: controller.signal, callId: randomUUID() }) })
                  if (controller.signal.aborted) return
                  emit(handle, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '不应进入界面的内部片段' }, { type: 'text', text: answer }] } })
                  emit(handle, 'turn/end', { reason: { kind: 'completed' } })
                } catch { if (!controller.signal.aborted) emit(handle, 'turn/end', { reason: { kind: 'error' } }) }
                }
                processing = false
              })()
            },
          },
          async dispose() { controller.abort(); await work; handle.disposed = true },
        }
        options.setup({ systemPrompt: { section() {} }, tools: { restrict({ allow }) { handle.allowed = allow } } })
        handles.push(handle)
        return handle
      },
    },
  }
  ctx.root = ctx
  function emit(handle, type, data) { const event = { type, data }; logs.get(handle.id).push(event); ctx.emit('session/event', { id: handle.id }, event) }
  ctx.on('ecosystem/providers', accept => accept({ protocol: 1, ready() {}, resolve(req) { return actors[req.headers.cookie] },
    assertAccess(actor) { if (revoked.has(actor.sessionId)) reject() },
  }))
  for (const provider of providers) ctx.on('pirate/participants', accept => accept({
    protocol: 1, displayName: provider.id, description: '业务替身', ...provider,
    assertAccess(actor) { if (revoked.has(actor.sessionId + ':' + provider.id)) reject(); provider.assertAccess?.(actor) },
  }))
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (browserLogin && pathname === '/fixture-login') {
      res.writeHead(302, { 'set-cookie': 'alice; Path=/; SameSite=Strict; HttpOnly', location: '/pirate' }); res.end(); return
    }
    const route = routes.find(route => route.kind === 'exact' && route.path === pathname)
      ?? routes.find(route => route.kind === 'prefix' && pathname.startsWith(route.path))
    if (!route) { res.writeHead(404); res.end(); return }
    void Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'pirate-http-'))
  try { await apply(ctx, Config({ accessMode: 'authenticated', publicOrigin: origin, historyPath: ':memory:', authRecheckMs: 100, turnTimeoutMs: timeoutMs })) }
  catch (error) {
    for (const effect of effects.reverse()) await effect?.()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    throw error
  }
  finally { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome }
  const request = (path, data, cookie = 'alice', headers = {}) => fetch(origin + '/pirate' + path, {
    method: data === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { cookie, origin, 'content-type': 'application/json', ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  return {
    ctx, tools, handles, revoked, actors, request, origin, models,
    async settled(id) {
      for (let i = 0; i < 100; i++) {
        const response = await request('/mission?id=' + id)
        if (response.status !== 200) throw new Error('read status ' + response.status)
        const value = await response.json()
        if (!['running', 'stopping'].includes(value.mission.state)) return value
        await delay(10)
      }
      throw new Error('mission did not settle')
    },
    async close() {
      for (const effect of effects.reverse()) await effect?.()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
