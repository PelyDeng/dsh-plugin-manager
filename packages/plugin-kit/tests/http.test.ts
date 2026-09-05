import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { createAccess, createPluginHttp, installProvider } from '../src/index.ts'

describe('plugin HTTP registration', () => {
  it('rejects noncanonical plugin namespaces and child paths', () => {
    const ctx = new Context()
    const access = createAccess(ctx, { mode: 'standalone', pluginId: 'demo', publicOrigin: '' })
    const http = createPluginHttp(ctx, { routePrefix: '/demo', access })
    for (const path of ['/', '//demo', '/demo/', '/demo//child', '/demo/.', '/demo/..', '/demo/%2e%2e', '/demo?next=1', '/demo#tab', '/demo\\child']) {
      expect(() => createPluginHttp(ctx, { routePrefix: path, access })).toThrow('规范')
      expect(() => http.registerPublic({ kind: 'exact', path, handler: (_req, res) => { res.end() } })).toThrow('不属于')
    }
  })
  it('protects exact API and asset routes as well as pages, with explicit health access', async () => {
    const ctx = new Context()
    const server = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await server.await()
    const registrations: Array<() => void> = []
    try {
      installProvider(ctx, {
        protocol: 1,
        ready() {},
        resolve: req => req.headers.cookie === 'test=valid' ? { namespace: 'user', userId: 'a', sessionId: 's' } : undefined,
        assertAccess() {},
      })
      const access = createAccess(ctx, { mode: 'authenticated', pluginId: 'example', publicOrigin: 'https://example.test' })
      const http = createPluginHttp(ctx, { routePrefix: '/example', access })
      let executed = 0
      const handler = (_req: unknown, res: import('node:http').ServerResponse) => { executed++; res.end('private') }
      registrations.push(http.register({ kind: 'exact', path: '/example', surface: 'page', handler }))
      registrations.push(http.register({ kind: 'exact', path: '/example/history', handler }))
      registrations.push(http.register({ kind: 'prefix', path: '/example/assets', surface: 'asset', handler }))
      registrations.push(http.registerPublic({ kind: 'exact', path: '/example/health', handler: (_req, res) => { res.end('ok') } }))
      const base = `http://127.0.0.1:${ctx.webServer.port}`
      const page = await fetch(base + '/example', { redirect: 'manual' })
      expect(page.status).toBe(303)
      expect(page.headers.get('location')).toBe('/auth?returnTo=%2Fexample')
      expect((await fetch(base + '/example/history')).status).toBe(401)
      expect((await fetch(base + '/example/assets/app.js')).status).toBe(401)
      expect((await fetch(base + '/example/health')).status).toBe(200)
      expect(executed).toBe(0)
      expect((await fetch(base + '/example/history', { headers: { cookie: 'test=valid' } })).status).toBe(200)
      expect(executed).toBe(1)
      expect(() => http.register({ kind: 'exact', path: '/example-other', handler })).toThrow('不属于')
      expect(() => http.register({ kind: 'exact', path: '/example/../auth', handler })).toThrow('不属于')
    } finally {
      registrations.reverse().forEach(dispose => dispose())
      await server.dispose()
    }
  })
})
