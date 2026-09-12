/**
 * 智能体群组插件入口。
 *
 * 群组本身不做业务：它只负责把清单里的 Agent 装载起来、给每个 Agent 各自的页面前缀
 * 与授权标识，并提供群组级的存活/就绪探针。
 *
 * 一个关键约束：**每个 Agent 在插件目录里是一条独立条目**（`registerPlugin`），
 * 而不是把工具堆在群组一条 idd 下。这样授权粒度、会话管理 key、页面路径三件事
 * 才会自然成立，改动量也最小。细节见设计文档 §2。
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createAccess, createPluginHttp, registerPlugin } from '@dsh-plugin-manager/plugin-kit'
import * as common from '@dsh-agents-group/common'
import { assertUniqueManifests, AGENT_MANIFESTS, type AgentManifest } from './agents/registry.ts'
import { Config as ConfigSchema, type Config as PluginConfig } from './config.ts'
import { mountAgents, readiness, type AgentMount } from './host.ts'

export { ConfigSchema as Config }
export type { PluginConfig }
export { AGENT_MANIFESTS, endpointsOf } from './agents/registry.ts'
export type { AgentManifest, AgentEndpoints } from './agents/registry.ts'

export const name = 'agents-group'

export const inject = ['webServer'] as const

/**
 * 按清单装载一个 Agent 子包。
 *
 * P0 阶段清单为空，所以这里只返回 undefined；P1/P2 会把 closedoff、blog 的装载函数
 * 接进来。用显式 switch 而不是动态 import：构建产物要能静态分析，打包后动态路径不可靠。
 */
async function loadAgent(manifest: AgentManifest): Promise<AgentMount | undefined> {
  switch (manifest.id) {
    // P1: case 'closedoff': return (await import('./agents/closedoff.ts')).mount
    // P2: case 'blog':      return (await import('./agents/blog.ts')).mount
    default:
      return undefined
  }
}

/** 安装群组：登记自身条目、装载各 Agent、挂上探针。 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const manifestText = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(manifestText) as {
    name: string
    version: string
    description: string
    deepseekPlugin: { id: string; displayName: string; permissions: string[] }
  }

  assertUniqueManifests(AGENT_MANIFESTS)

  // 群组自身登记为一条目录条目。注意它的权限命名空间必须是自己（agents-group:*）,
  // 而各 Agent 的授权标识在各自的条目上 —— 包 id 与授权标识是两层，别混。
  ctx.effect(() => registerPlugin(ctx, {
    id: manifest.deepseekPlugin.id,
    packageName: manifest.name,
    version: manifest.version,
    displayName: manifest.deepseekPlugin.displayName,
    description: manifest.description,
    entryPath: config.routePrefix,
    permissions: manifest.deepseekPlugin.permissions,
    tools: [],
  }))

  const mounted = await mountAgents(ctx, AGENT_MANIFESTS, {
    config: {
      routePrefix: config.routePrefix,
      publicOrigin: config.publicOrigin,
      accessMode: config.accessMode,
    },
    common,
  }, loadAgent)

  // 群组卸载时按装载逆序释放，保证后起的先关。
  ctx.effect(() => () => Promise.allSettled([...mounted].reverse().map(agent => agent.dispose())))

  // 群组级探针。用正式的 createAccess，而不是手写一个空 assert ——
  // 空实现会让探针绕过认证状态检查，那是真实缺陷不是简化。
  const groupAccess = createAccess(ctx, {
    mode: config.accessMode,
    pluginId: manifest.deepseekPlugin.id,
    publicOrigin: config.publicOrigin,
  })
  const groupHttp = createPluginHttp(ctx, { access: groupAccess, routePrefix: config.routePrefix })

  ctx.effect(() => groupHttp.registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/health`,
    handler: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true }))
    },
  }))

  ctx.effect(() => groupHttp.registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/ready`,
    handler: (_request, response) => {
      // 就绪探针无需登录，但认证模式不对时要如实报不就绪，不能假装正常。
      let ready = true
      try { groupAccess.ready() } catch { ready = false }
      const state = readiness(mounted)
      const ok = ready && state.ok
      response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok, authReady: ready, agents: state.agents }))
    },
  }))

  if (mounted.some(agent => agent.failure !== undefined)) {
    const failed = mounted.filter(agent => agent.failure !== undefined).map(agent => agent.id)
    console.warn(`agents-group: 以下 Agent 未就绪：${failed.join('、')}`)
  }
}
