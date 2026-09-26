import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { BusinessError, createAccess, createPluginHttp, installProvider } from '../src/index.ts'

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
  }, 20_000) // Covers native listener startup, HTTP requests and shutdown on CI.
  it('passes business errors through with their original status and message', async () => {
    const ctx = new Context()
    const server = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await server.await()
    const registrations: Array<() => void> = []
    try {
      const access = createAccess(ctx, { mode: 'standalone', pluginId: 'demo', publicOrigin: '' })
      const http = createPluginHttp(ctx, { routePrefix: '/demo', access })
      registrations.push(http.register({ kind: 'exact', path: '/demo/conflict', handler: () => { throw new BusinessError(409, '这篇文章正在保存，请稍后重试') } }))
      // 跨独立打包副本的形状识别：另一份代码抛的普通对象同样透传（与 isAccessError 同族协议）。
      const foreign: unknown = { code: 'DSH_BUSINESS_ERROR', name: 'BusinessError', status: 503, message: '上游不可用' }
      registrations.push(http.register({ kind: 'exact', path: '/demo/foreign', handler: () => { throw foreign } }))
      // 非业务错误仍落 500，不透传。
      registrations.push(http.register({ kind: 'exact', path: '/demo/boom', handler: () => { throw new Error('内部细节') } }))
      const base = `http://127.0.0.1:${ctx.webServer.port}`
      const conflict = await fetch(base + '/demo/conflict')
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toEqual({ error: '这篇文章正在保存，请稍后重试' })
      const upstream = await fetch(base + '/demo/foreign')
      expect(upstream.status).toBe(503)
      expect(await upstream.json()).toEqual({ error: '上游不可用' })
      const boom = await fetch(base + '/demo/boom')
      expect(boom.status).toBe(500)
      expect(await boom.json()).toEqual({ error: '请求处理失败' })
    } finally {
      registrations.reverse().forEach(dispose => dispose())
      await server.dispose()
    }
  }, 20_000)
})
