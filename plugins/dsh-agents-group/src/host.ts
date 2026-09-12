/**
 * 群组的宿主装配：把清单里的每个 Agent 装载起来，并保证互不拖累。
 *
 * 合并成一个插件之后，所有 Agent 都在同一个 Node 进程里，所以这里有一条硬要求：
 * **一个 Agent 装载失败或运行期崩溃，不能让整个群组不可用。** 逐个 try/catch，
 * 失败只标记该 Agent 不可用，探针如实反映。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createAccess, createPluginHttp, type Access } from '@dsh-plugin-manager/plugin-kit'
import type * as common from '@dsh-agents-group/common'
import { endpointsOf, type AgentManifest } from './agents/registry.ts'

/** 一个已装载的 Agent。 `dispose` 由群组在卸载时统一调用。 */
export interface MountedAgent {
  readonly manifest: AgentManifest
  readonly id: string
  readonly entryPath: string
  readonly healthPath: string
  readonly permission: string
  /** 装载失败时的可读原因；正常时为 undefined。 */
  readonly failure?: string
  dispose(): Promise<void>
}

/** 装载一个 Agent 需要的东西。共享对象在群组生命周期内复用。 */
export interface AgentMountContext {
  readonly ctx: Context
  readonly config: {
    readonly routePrefix: string
    readonly publicOrigin: string
    readonly accessMode: 'standalone' | 'authenticated'
  }
  /** 该 Agent 自己的访问校验器（按自己的 pluginId 授权）。 */
  readonly access: Access
  /** 一个只允许注册该 Agent 前缀下路由的 HTTP 注册器。 */
  readonly http: ReturnType<typeof createPluginHttp>
  /** 群组级的公共组件包。各 Agent 从这里取共享能力，不要各自复制。 */
  readonly common: typeof common
}

/** 一个 Agent 子包对外暴露的装载函数。 */
export type AgentMount = (context: AgentMountContext) => Promise<{
  dispose(): Promise<void>
}>

/**
 * 装载清单里的全部 Agent。
 *
 * 返回的列表顺序与清单一致，包含装载失败的条目（带 `failure`），
 * 便于探针与总览页如实展示「谁没起来、为什么」。
 */
export async function mountAgents(
  ctx: Context,
  manifests: readonly AgentManifest[],
  shared: Omit<AgentMountContext, 'ctx' | 'access' | 'http'>,
  loader: (manifest: AgentManifest) => Promise<AgentMount | undefined>,
): Promise<MountedAgent[]> {
  const mounted: MountedAgent[] = []
  for (const manifest of manifests) {
    const endpoints = endpointsOf(manifest, shared.config.routePrefix)
    const base = {
      manifest,
      id: endpoints.id,
      entryPath: endpoints.entryPath,
      healthPath: endpoints.healthPath,
      permission: endpoints.permission,
    }
    try {
      const mount = await loader(manifest)
      if (mount === undefined) {
        mounted.push({ ...base, failure: '子包未提供装载入口', dispose: async () => {} })
        continue
      }
      // 每个 Agent 用自己的 pluginId 建访问校验器：授权粒度就是条目 id。
      const access = createAccess(ctx, {
        mode: shared.config.accessMode,
        pluginId: endpoints.id,
        publicOrigin: shared.config.publicOrigin,
      })
      const http = createPluginHttp(ctx, {
        access,
        routePrefix: endpoints.entryPath,
        onError: (response, caught) => {
          const message = caught instanceof Error ? caught.message : '请求处理失败'
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ error: message }))
        },
      })
      const instance = await mount({ ...shared, ctx, access, http })
      mounted.push({ ...base, dispose: instance.dispose })
    } catch (error) {
      // 只标记这一个 Agent 失败，群组继续服务其他 Agent。
      const message = error instanceof Error ? error.message : String(error)
      console.error(`agents-group: ${manifest.id} 装载失败：${message}`)
      mounted.push({ ...base, failure: message, dispose: async () => {} })
    }
  }
  return mounted
}

/**
 * 群组就绪判定。
 *
 * **只要有一个 Agent 就绪就返回 200**，明细写在正文里。理由：如果任一 Agent 配置错
 * 就让整个群组 503，会把「某一个 Agent 挂了」升级成「全部不可用」，运维上更难判断。
 * 一个都没起来才算不就绪。
 */
export function readiness(mounted: readonly MountedAgent[]): {
  ok: boolean
  agents: { id: string; ready: boolean; entryPath: string; error?: string }[]
} {
  const agents = mounted.map(agent => ({
    id: agent.id,
    ready: agent.failure === undefined,
    entryPath: agent.entryPath,
    ...(agent.failure === undefined ? {} : { error: agent.failure }),
  }))
  return { ok: agents.some(agent => agent.ready), agents }
}
