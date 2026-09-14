/**
 * 本地回环验证服务（不进入发布包）：装载真实构建产物 dist/index.mjs 的 apply()，
 * 用 kit 的 installProvider 装一个本地认证替身（恒为已登录、允许 niuma-boss:access），
 * 再把管家契约桩挂在同源的 /butler 下，满足「游戏与管家同站」的部署前提。
 *
 * 用法：node scripts/local-verify.mjs [--serve]
 *   --serve 打印地址并保持运行，供人工浏览器检查；缺省供 browser-check.mjs 编程调用。
 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createButlerHandler, startButlerStub } from './local-butler.mjs'


export async function startVerifyServer() {
  const { installProvider } = await import('@dsh-plugin-manager/plugin-kit')
  const plugin = await import('../dist/index.mjs')

  const routes = []
  // 迷你事件总线：kit 的 installProvider/registerPlugin 都经 ctx.on 注册、ctx.root.emit 收集。
  const listeners = new Map()
  const ctx = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (effect) => effect(),
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel).add(listener)
      return () => { listeners.get(channel)?.delete(listener) }
    },
    root: { emit: (channel, accept) => { for (const listener of listeners.get(channel) ?? []) listener(accept) } },
  }

  const localProvider = {
    protocol: 1,
    ready() {},
    resolve(_request) { return { namespace: 'user', userId: 'local-verify', sessionId: 'local-verify' } },
    assertAccess(_actor, pluginId) { if (pluginId !== 'niuma-boss') throw new Error('本地替身只服务 niuma-boss') },
  }
  installProvider(ctx, localProvider)

  const server = createServer((request, response) => { void dispatch(request, response) })
  const butler = await startButlerStub()
  const butlerHandler = createButlerHandler()

  async function dispatch(request, response) {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      const route = routes.find(r => r.kind === 'exact' && r.path === path) ?? routes.find(r => r.kind === 'prefix' && path.startsWith(r.path))
      if (route) { await route.handler(request, response); return }
      // 同站管家桩：认证、身份与归属都由桩自答。
      butlerHandler(request, response)
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'fixture_error' }))
      } else response.destroy()
    }
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = server.address().port
  const origin = 'http://127.0.0.1:' + port
  await plugin.apply(ctx, { accessMode: 'authenticated', publicOrigin: origin, routePrefix: '/niuma-boss' })

  return {
    origin,
    butler,
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(() => resolve()))
      await butler.close()
    },
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const fixture = await startVerifyServer()
  console.log('本地验证服务：' + fixture.origin + '/niuma-boss（管家桩：' + fixture.butler.origin + '）')
  if (!process.argv.includes('--serve')) {
    console.log('提示：加 --serve 保持运行；缺省 30 秒后自动退出。')
    setTimeout(() => void fixture.close(), 30_000).unref?.()
  }
}
