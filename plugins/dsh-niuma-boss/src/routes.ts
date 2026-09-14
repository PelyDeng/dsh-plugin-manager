/**
 * 牛马-老板的 HTTP 面：自己的页面、静态资源和健康探针。
 *
 * 这里不代理管家的任何任务接口——浏览器直接同源调用管家；游戏后端只有静态资源与探针。
 * 受保护路由都经过 kit 的 `createPluginHttp`，每次访问重新核对登录身份与
 * `niuma-boss:access` 权限；未登录打开页面时由 kit 重定向到登录页并带回跳地址。
 */
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { AccessError, createPluginHttp, isAccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type { Config } from './config.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
}

const notFound = () => new AccessError(404, '资源不存在')

export async function installWeb(ctx: Context, config: Config, access: Access, staticRootOverride?: string): Promise<void> {
  // 页面产物随包发布在 web/（与 dist/ 的服务端入口同级）；测试可传入替身目录。
  const staticRoot = staticRootOverride ?? fileURLToPath(new URL('../web/', import.meta.url))
  // 构建产物里的 `/niuma-boss/...` 是包内默认前缀，部署改前缀时一并替换；
  // 运行配置注到 head 里，前端据此加载资源，不需要猜部署前缀。
  const pageConfig = { routePrefix: config.routePrefix }
  const injection = `<script>globalThis.__NIUMA_BOSS_CONFIG__=${JSON.stringify(pageConfig).replaceAll('<', '\\u003c')};</script>`
  const sourceHtml = await readFile(resolve(staticRoot, 'index.html'), 'utf8')
  const html = sourceHtml
    .replaceAll('/niuma-boss', config.routePrefix)
    .replace('</head>', `${injection}</head>`)

  const { register, registerPublic } = createPluginHttp(ctx, {
    access,
    routePrefix: config.routePrefix,
    onError: (response: ServerResponse, caught: unknown) => {
      const known = isAccessError(caught)
      if (!known) console.error('niuma-boss web request failed', caught)
      response.writeHead(known ? caught.status : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: known ? caught.message : '服务处理失败' }))
    },
  })

  const serveStatic = async (response: ServerResponse, suffixRaw: string, actor: Actor, base?: string): Promise<void> => {
    const suffix = decodeURIComponent(suffixRaw).replace(/^\/+/, '')
    if (suffix === '') throw notFound()
    const file = resolve(staticRoot, suffix)
    const local = relative(staticRoot, file).replaceAll('\\', '/')
    if (local.startsWith('..') || isAbsolute(local)) throw notFound()
    // 资源路由各自只服务自己声明的子目录，`assets/../x` 一律按 404 处理。
    if (base !== undefined && local !== base && !local.startsWith(base + '/')) throw notFound()
    let content: Buffer
    try {
      content = await readFile(file)
    } catch {
      throw notFound()
    }
    access.assert(actor)
    response.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
    response.end(content)
  }

  ctx.effect(() => registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/health`,
    handler: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true }))
    },
  }))

  ctx.effect(() => registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/ready`,
    handler: (_request, response) => {
      try {
        access.ready()
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true }))
      } catch {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false }))
      }
    },
  }))

  // 页面本体。登录与 niuma-boss:access 都核对；未登录时由 kit 重定向到登录页并带回跳地址。
  ctx.effect(() => register({
    kind: 'exact',
    path: config.routePrefix,
    surface: 'page',
    handler: (request, response, actor) => {
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      access.assert(actor)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      response.end(html)
    },
  }))

  // Vite 产物（assets/）与编译后的地图/图集（generated/）都在页面产物根下，均要求登录且持有 niuma-boss:access。
  for (const suffix of ['assets', 'generated']) ctx.effect(() => register({
    kind: 'prefix',
    path: `${config.routePrefix}/${suffix}`,
    handler: async (request, response, actor) => {
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      const url = new URL(request.url ?? '/', 'http://localhost')
      await serveStatic(response, suffix + url.pathname.slice(config.routePrefix.length + 1 + suffix.length), actor, suffix)
    },
  }))
}
