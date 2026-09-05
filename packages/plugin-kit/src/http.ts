/** HTTP registration with one declared plugin namespace and explicit public exceptions. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isAccessError, type Access, type Actor } from './access.ts'
import { isPluginPath } from './route-path.mjs'

export interface ProtectedRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly surface?: 'page' | 'api' | 'asset'
  readonly handler: (request: IncomingMessage, response: ServerResponse, actor: Actor) => void | Promise<void>
}

/** Plugins register every HTTP route through this owner; exact routes cannot bypass authentication. */
export function createPluginHttp(ctx: Context, options: {
  readonly access: Access
  readonly routePrefix: string
  readonly onError?: (response: ServerResponse, error: unknown) => void
}) {
  const prefix = options.routePrefix
  const canonical = isPluginPath
  if (!canonical(prefix)) throw new Error('插件路由前缀必须是规范的绝对路径')
  const check = (path: string) => {
    if (!canonical(path) || path !== prefix && !path.startsWith(`${prefix}/`)) {
      throw new Error(`路由不属于声明的插件前缀：${path}`)
    }
  }
  const reject = (response: ServerResponse, caught: unknown) => {
    if (response.headersSent) { response.destroy(); return }
    if (options.onError) { options.onError(response, caught); return }
    const known = isAccessError(caught)
    response.writeHead(known ? caught.status : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: known ? caught.message : '请求处理失败' }))
  }
  return {
    register(route: ProtectedRoute): () => void {
      check(route.path)
      return ctx.webServer.register({ kind: route.kind, path: route.path, handler: async (request, response) => {
        try {
          await route.handler(request, response, options.access.resolve(request))
        } catch (caught: unknown) {
          if (!response.headersSent && request.method === 'GET' && route.surface === 'page' && isAccessError(caught) && caught.status === 401) {
            response.writeHead(303, { location: `/auth?returnTo=${encodeURIComponent(route.path)}`, 'cache-control': 'no-store' })
            response.end()
          } else reject(response, caught)
        }
      } })
    },
    /** Only explicitly public endpoints such as non-sensitive health probes use this method. */
    registerPublic(route: WebRoute): () => void {
      check(route.path)
      return ctx.webServer.register(route)
    },
  }
}
