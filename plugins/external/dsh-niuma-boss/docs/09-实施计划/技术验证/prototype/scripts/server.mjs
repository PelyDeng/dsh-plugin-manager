import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { installValidationRoutes, AccessError } from '../dist/index.mjs'

export async function startServer({ port = 0, staticRoot = fileURLToPath(new URL('../dist/', import.meta.url)), installRoutes = installValidationRoutes, streamFailures = 4, streamStatus = 0, readyFails = false } = {}) {
  const routes = []
  const counts = { requests: 0, executions: 0, writes: [], subscriptions: [], snapshots: 0 }
  const remembered = new Map()
  const ctx = { webServer: { register: route => { routes.push(route); return () => {} } }, effect: effect => effect() }
  const access = {
    ready() { if (readyFails) throw new Error('fixture_dependency_unavailable') }, assert() {},
    resolve(request) {
      if (request.headers['x-validation-deny'] === 'unauthorized') throw new AccessError(401, '需要登录')
      if (request.headers['x-validation-deny'] === 'forbidden') throw new AccessError(403, '无权限')
      return { namespace: 'user', userId: 'validation-only' }
    },
  }
  installRoutes(ctx, access, staticRoot)
  const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)) }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname
      if (path === '/butler/identity') return json(response, 200, { key: 'validation-only', routePrefix: '/fixture-butler', contractVersion: 1 })
      if (path === '/fixture-butler/conversations') return json(response, 200, { items: [] })
      if (path === '/fixture-butler/task') {
        if (url.searchParams.get('id') !== 'validation-task') return json(response, 400, { code: 'missing_task_id' })
        counts.snapshots++
        return json(response, 200, { task: { id: 'validation-task', state: 'running' } })
      }
      if (path === '/fixture-butler/events') {
        if (url.searchParams.get('conversationId') !== 'validation') return json(response, 400, { code: 'missing_conversation_id' })
        if (url.searchParams.get('probe') === '1') return json(response, 200, { run: { runId: 'validation-run', taskId: 'validation-task', seq: 7 } })
        counts.subscriptions.push(Number(url.searchParams.get('after') ?? 0))
        if (streamStatus) return json(response, streamStatus, { code: 'forbidden' })
        if (counts.subscriptions.length <= streamFailures) return json(response, 503, { code: 'temporary_failure' })
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if (counts.subscriptions.length === streamFailures + 1) {
          response.end('data: '+JSON.stringify({ type: 'reset', runId: 'validation-run', seq: 7 })+'\n\ndata: [DONE]\n\n')
          return
        }
        let seq = Math.max(7, counts.subscriptions.at(-1))
        const timer = setInterval(() => response.write('data: '+JSON.stringify({ type: 'subtask', taskId: 'validation-task', runId: 'validation-run', seq: ++seq, state: 'running' })+'\n\n'), 200)
        response.on('close', () => clearInterval(timer))
        return
      }
      if (path.startsWith('/fixture-butler/') && request.method === 'POST') {
        let text = ''
        for await (const data of request) { text += data; if (text.length > 16384) return json(response, 413, { code: 'too_large' }) }
        const payload = JSON.parse(text)
        const record = { path, requestId: payload.requestId, body: text }
        counts.requests++
        counts.writes.push(record)
        if (payload.validation?.status) return json(response, payload.validation.status, { code: payload.validation.code ?? 'expected_error' })
        if (payload.validation?.code) return json(response, 200, { code: payload.validation.code })
        const key = path + ':' + payload.requestId
        if (!remembered.has(key)) {
          remembered.set(key, text)
          counts.executions++
          if (payload.validation?.drop) { request.socket.destroy(); return }
        } else if (remembered.get(key) !== text) return json(response, 409, { code: 'request_id_conflict' })
        return json(response, 202, { accepted: true })
      }
      const route = routes.find(r => r.kind === 'exact' && r.path === path) ?? routes.find(r => r.kind === 'prefix' && path.startsWith(r.path))
      if (route) { await route.handler(request, response); return }
      json(response, 404, { code: 'not_found' })
    } catch { if (!response.headersSent) json(response, 500, { code: 'fixture_error' }); else response.destroy() }
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    origin: 'http://127.0.0.1:' + server.address().port, counts,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startServer({ port: Number(process.env.PORT || 4178) })
  console.log('validation server ' + fixture.origin + '/niuma-boss')
}
