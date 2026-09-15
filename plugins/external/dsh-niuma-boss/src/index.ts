/**
 * 牛马-老板插件的入口。
 *
 * 它只做三件事：
 *
 * 1. 在插件目录里登记自己，让认证页面知道有这个应用。
 * 2. 建立自己的访问检查（登录身份 + `niuma-boss:access` 权限）。
 * 3. 提供游戏页面、静态资源与只读健康探针。
 *
 * 管家任务是唯一权威：这里没有游戏业务数据库，也不代理管家的任务接口。
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createAccess, registerPlugin } from '@dsh-plugin-manager/plugin-kit'
import { Config as ConfigSchema, type Config as PluginConfig } from './config.ts'
import { installWeb } from './routes.ts'

export { ConfigSchema as Config }
export type { PluginConfig }

/** Cordis 插件名，与 `cordis.patch.yml` 里的 id 保持一致。 */
export const name = 'niuma-boss'

export const inject = ['webServer'] as const

/** 装载游戏页面与静态资源。 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const manifestText = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(manifestText) as {
    name: string
    version: string
    description: string
    deepseekPlugin: { id: string; displayName: string; permissions: string[]; category?: string }
  }

  const access = createAccess(ctx, {
    mode: config.accessMode,
    pluginId: manifest.deepseekPlugin.id,
    publicOrigin: config.publicOrigin,
  })

  ctx.effect(() => registerPlugin(ctx, {
    id: manifest.deepseekPlugin.id,
    packageName: manifest.name,
    version: manifest.version,
    displayName: manifest.deepseekPlugin.displayName,
    description: manifest.description,
    entryPath: config.routePrefix,
    permissions: manifest.deepseekPlugin.permissions,
    ...(manifest.deepseekPlugin.category === undefined ? {} : { category: manifest.deepseekPlugin.category }),
    tools: [],
  }))

  await installWeb(ctx, config, access)
}
