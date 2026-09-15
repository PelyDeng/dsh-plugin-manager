import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createAccess, createPluginHttp, type Access } from '@dsh-plugin-manager/plugin-kit'
export { AccessError } from '@dsh-plugin-manager/plugin-kit'

export function installValidationRoutes(ctx: Context, access: Access, staticRoot: string): void {
  const root = resolve(staticRoot)
  const http = createPluginHttp(ctx, { access, routePrefix: '/niuma-boss' })
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' }
  for (const probe of ['health', 'ready']) ctx.effect(() => http.registerPublic({
    kind: 'exact', path: '/niuma-boss/' + probe, handler: (_request, response) => {
      let ok = true
      try { if (probe === 'ready') access.ready() } catch { ok = false }
      response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok, validationOnly: true }))
    },
  }))
  for (const route of [
    { kind: 'exact' as const, path: '/niuma-boss', surface: 'page' as const },
    { kind: 'prefix' as const, path: '/niuma-boss/assets', surface: 'asset' as const },
    { kind: 'prefix' as const, path: '/niuma-boss/generated', surface: 'asset' as const },
  ]) ctx.effect(() => http.register({
    ...route, handler: async (request, response, actor) => {
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      let content: Buffer, suffix: string
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        suffix = decodeURIComponent(url.pathname.slice('/niuma-boss/'.length)) || 'index.html'
        if (route.kind === 'exact') suffix = 'index.html'
        const file = resolve(root, suffix)
        const local = relative(root, file)
        if (local.startsWith('..') || isAbsolute(local)) throw new Error('outside')
        content = await readFile(file)
      } catch { response.writeHead(404); response.end(); return }
      access.assert(actor)
      response.writeHead(200, { 'content-type': mime[extname(suffix!)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
      response.end(content)
    },
  }))
}

// 仅用于隔离包加载验证；宿主运行仍须另测。
export function apply(ctx: Context, config: { staticRoot: string; publicOrigin: string }): void {
  const access = createAccess(ctx, { mode: 'authenticated', pluginId: 'niuma-boss', publicOrigin: config.publicOrigin })
  installValidationRoutes(ctx, access, config.staticRoot)
}
