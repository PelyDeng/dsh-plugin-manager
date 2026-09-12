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
import { agentConfig, Config as ConfigSchema, isAgentEnabled, type Config as PluginConfig } from './config.ts'
import { mountAgents, readiness, type AgentMount } from './host.ts'

export { ConfigSchema as Config }
export type { PluginConfig }
export { AGENT_MANIFESTS, endpointsOf } from './agents/registry.ts'
export type { AgentManifest, AgentEndpoints } from './agents/registry.ts'

export const name = 'agents-group'

/**
 * 群组需要宿主提供的服务。
 *
 * 群组自身只用到 `webServer`；但装载的子包会用到 agents、llm、会话持久化等，
 * 所以在群组这一层一并声明 —— 少声明会让子包在运行时才发现缺能力。
 */
export const inject = [
  'webServer',
  'agents',
  'agentDefaultModel',
  'llm',
  'messageFeedback',
  'sessionPersistence',
  'systemPrompt',
  'tools',
  // 以下三项只有部分子包需要（博客用到），但群组统一声明：
  // 少声明会让子包在运行时才发现缺能力。
  'attachments',
  'jobs',
  'sessions',
] as const

/**
 * 按清单装载一个 Agent 子包。
 *
 * 用显式 switch 而不是按 id 拼动态路径：构建产物要能静态分析，打包后动态路径不可靠。
 * 每个 Agent 同时提供自己的 HTTP 错误处理 —— 只有它知道哪些错误是可预期的。
 */
async function loadAgent(manifest: AgentManifest): Promise<AgentMount | undefined> {
  switch (manifest.id) {
    case 'closedoff': return (await import('./agents/closedoff.ts')).mountClosedoff
    case 'blog': return (await import('./agents/blog.ts')).mountBlog
    default: return undefined
  }
}

/** 取一个 Agent 的错误渲染函数；没有提供时由群组用通用兜底。 */
async function errorHandlerOf(agentId: string) {
  switch (agentId) {
    case 'closedoff': return (await import('./agents/closedoff.ts')).closedoffErrorHandler
    default: return undefined
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

  // 群组只有一个 runtimeConfig（管理器要求变量名全局唯一），各 Agent 的凭据从它的
  // 对应小节读取。变量未设置时留空，子包回落到自己的旧来源，切换期不会中断。
  const runtimeConfigPath = (process.env.AGENTS_GROUP_CONFIG ?? '').trim()

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

  // 被显式关闭的 Agent 不装载：它的页面与目录条目都不应出现。
  const enabled = AGENT_MANIFESTS.filter(item => isAgentEnabled(config, item.id))

  // 各 Agent 的错误渲染函数要先取好，装载时按 id 注入。
  const mountedErrorHandlers = new Map<string, (response: import('node:http').ServerResponse, error: unknown) => void>()
  for (const item of enabled) {
    const handler = await errorHandlerOf(item.id)
    if (handler !== undefined) mountedErrorHandlers.set(item.id, handler)
  }

  const mounted = await mountAgents(ctx, enabled, {
    config: {
      routePrefix: config.routePrefix,
      publicOrigin: config.publicOrigin,
      accessMode: config.accessMode,
    },
    // 各 Agent 自己的部署字段来自 agents.<id>.config；群组不重复描述子包的字段。
    agentConfigOf: agentId => agentConfig(config, agentId).config,
    // 各 Agent 自己的错误分类；返回 undefined 时由群组用通用兜底。
    onErrorOf: agentId => mountedErrorHandlers.get(agentId),
    // 群组唯一的一份业务配置文件；各子包从自己的小节读凭据。
    ...(runtimeConfigPath === '' ? {} : { groupConfigPath: runtimeConfigPath }),
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

  /**
   * 每个 Agent 一条就绪探针，地址就是它目录条目声明的 `healthPath`。
   *
   * 由群组注册而不是子包自己注册：容器级探针是群组的职责，而且子包只知道自己 config 里的
   * 前缀，与注入的页面前缀可能不一致。声明与实现由同一处产生，才不会对不上。
   */
  for (const agent of mounted) {
    ctx.effect(() => groupHttp.registerPublic({
      kind: 'exact',
      path: agent.healthPath,
      handler: (_request, response) => {
        const ok = agent.failure === undefined
        response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({
          ok,
          id: agent.id,
          entryPath: agent.entryPath,
          ...(agent.failure === undefined ? {} : { error: agent.failure }),
        }))
      },
    }))
  }

  if (mounted.some(agent => agent.failure !== undefined)) {
    const failed = mounted.filter(agent => agent.failure !== undefined).map(agent => agent.id)
    console.warn(`agents-group: 以下 Agent 未就绪：${failed.join('、')}`)
  }
}
