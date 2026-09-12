/** Optional authentication and account-management plugin on the shared WebServer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { installProvider, registerPlugin } from '@dsh-plugin-manager/plugin-kit/access'
import { AuthStore, defaultDirectory, ensureDefaultAdministrator } from './store.ts'
import { AuthService } from './service.ts'
import { createHandler, validateOrigin } from './http.ts'

export const name = 'auth'
export const inject = ['webServer'] as const
export interface Config { publicOrigin: string; stateDir: string; sessionTtlSeconds: number; maxAttempts: number; lockSeconds: number }
export const Config: z<Config> = z.object({
  publicOrigin: z.string().required(),
  stateDir: z.string().default(defaultDirectory()),
  sessionTtlSeconds: z.natural().min(60).max(2592000).default(86400),
  maxAttempts: z.natural().min(1).max(100).default(6),
  lockSeconds: z.natural().min(1).max(3600).default(30),
})

/** Register independent auth routes without replacing DSH's official authentication. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  validateOrigin(config.publicOrigin)
  const store = new AuthStore(config.stateDir)
  ctx.effect(() => () => store.close())
  await ensureDefaultAdministrator(store)
  const service = await AuthService.create(ctx, store, config)
  const handler = await createHandler(ctx, service, config)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string; version: string; description: string
    deepseekPlugin: { id: string; displayName: string; entryPath: string; permissions: string[]; category?: string }
  }
  registerPlugin(ctx, { id: manifest.deepseekPlugin.id, packageName: manifest.name, version: manifest.version, description: manifest.description,
    displayName: manifest.deepseekPlugin.displayName, entryPath: manifest.deepseekPlugin.entryPath, permissions: manifest.deepseekPlugin.permissions,
    ...(manifest.deepseekPlugin.category === undefined ? {} : { category: manifest.deepseekPlugin.category }), tools: [] })
  const uninstall = installProvider(ctx, service)
  ctx.effect(() => () => { uninstall(); service.close() })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/auth', handler }))
}

export default { name, inject, Config, apply }
