/**
 * 群组的宿主装配：把清单里的每个 Agent 装载起来，并保证互不拖累。
 *
 * 合并成一个插件之后，所有 Agent 都在同一个 Node 进程里，所以这里有一条硬要求：
 * **一个 Agent 装载失败或运行期崩溃，不能让整个群组不可用。** 逐个 try/catch，
 * 失败只标记该 Agent 不可用，探针如实反映。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createAccess, createPluginHttp, type Access, type ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type * as common from '@dsh-agents-group/common'
import { endpointsOf, type AgentManifest } from './agents/registry.ts'

/** 一个已装载的 Agent。 `dispose` 由群组在卸载时统一调用。 */
export interface MountedAgent {
  readonly manifest: AgentManifest
  readonly id: string
  readonly entryPath: string
  readonly healthPath: string
  readonly permission: string
  /** 该 Agent 需要的访问模式。 */
  readonly accessMode: 'standalone' | 'authenticated'
  /** 该 Agent 注册的工具条目。群组据此算「本分类 + 通用」的可见性限制。 */
  readonly tools: readonly ToolDescriptor[]
  /** 装载失败时的可读原因；正常时为 undefined。 */
  readonly failure?: string
  dispose(): Promise<void>
}

/** 装载一个 Agent 需要的东西。共享对象在群组生命周期内复用。 */
export interface AgentMountContext {
  readonly ctx: Context
  /** 该 Agent 的清单项。适配层用它推导自己的页面前缀等标识。 */
  readonly manifest: AgentManifest
  /**
   * 该 Agent 的工具分类标签。
   *
   * 由群组从清单注入，子包注册工具时原样使用。**分类只有这一个权威来源** —— 子包自己
   * 再写一份字符串就会与清单漂移，而漂移的后果是「该 Agent 的工具全部不可见」，
   * 且这种失效在界面上完全看不出来。
   */
  readonly category: string
  readonly config: {
    readonly routePrefix: string
    readonly publicOrigin: string
    readonly accessMode: 'standalone' | 'authenticated'
  }
  /** 该 Agent 自己的部署字段；来自群组配置的 `agents.<id>.config`。 */
  readonly agentConfig: Record<string, unknown>
  /** 该 Agent 自己的访问校验器（按自己的 pluginId 授权）。 */
  readonly access: Access
  /** 一个只允许注册该 Agent 前缀下路由的 HTTP 注册器。 */
  readonly http: ReturnType<typeof createPluginHttp>
  /** 群组级配置文件的路径，子包从这里取自己的业务凭据。 */
  readonly groupConfigPath?: string
  /** 群组级的公共组件包。各 Agent 从这里取共享能力，不要各自复制。 */
  readonly common: typeof common
}

/** 一个 Agent 子包对外暴露的装载函数。 */
export type AgentMount = (context: AgentMountContext) => Promise<{
  dispose(): Promise<void>
  /**
   * 本次装载注册的工具条目。
   *
   * 群组用它算「本分类 + 通用」的可见性限制，所以子包必须如实返回**全部**已注册工具；
   * 漏报会让对应工具对该 Agent 不可见，而那在界面上看不出来。
   */
  tools: readonly ToolDescriptor[]
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
  shared: Omit<AgentMountContext, 'ctx' | 'access' | 'http' | 'agentConfig' | 'manifest' | 'category'> & {
    /** 按 Agent id 取它自己的部署字段。 */
    readonly agentConfigOf: (agentId: string) => Record<string, unknown>
    /**
     * 该 Agent 自己的 HTTP 错误处理。
     *
     * 必须由子包提供：只有它知道哪些错误是可预期的（例如参数校验失败应当 400）。
     * 用通用的 500 兜底会让本该是 400 的响应变成 500，前端无法区分。
     */
    readonly onErrorOf?: (agentId: string) => ((response: import('node:http').ServerResponse, error: unknown) => void) | undefined
  },
  loader: (manifest: AgentManifest) => Promise<AgentMount | undefined>,
): Promise<MountedAgent[]> {
  const mounted: MountedAgent[] = []
  for (const manifest of manifests) {
    const endpoints = endpointsOf(manifest, shared.config.routePrefix, shared.config.accessMode)
    const base = {
      manifest,
      id: endpoints.id,
      entryPath: endpoints.entryPath,
      healthPath: endpoints.healthPath,
      permission: endpoints.permission,
      accessMode: endpoints.accessMode,
    }
    try {
      const mount = await loader(manifest)
      if (mount === undefined) {
        mounted.push({ ...base, tools: [], failure: '子包未提供装载入口', dispose: async () => {} })
        continue
      }
      // 每个 Agent 用自己的 pluginId 建访问校验器：授权粒度就是条目 id。
      // 访问模式取端点推导的结果：强制认证的 Agent 即使在 standalone 群里也用
      // authenticated，这样它报的是「认证不可用」，而不是被误判成装载失败。
      const access = createAccess(ctx, {
        mode: endpoints.accessMode,
        pluginId: endpoints.id,
        publicOrigin: shared.config.publicOrigin,
      })
      const onError = shared.onErrorOf?.(manifest.id)
      const http = createPluginHttp(ctx, {
        access,
        routePrefix: endpoints.entryPath,
        ...(onError === undefined ? {} : { onError }),
      })
      const instance = await mount({
        ctx,
        manifest,
        category: manifest.category,
        config: shared.config,
        agentConfig: shared.agentConfigOf(manifest.id),
        access,
        http,
        common: shared.common,
        ...(shared.groupConfigPath === undefined ? {} : { groupConfigPath: shared.groupConfigPath }),
      })
      mounted.push({ ...base, tools: instance.tools, dispose: instance.dispose })
    } catch (error) {
      // 只标记这一个 Agent 失败，群组继续服务其他 Agent。
      // 连栈一起记：只记 message 会让这类问题在运维时无从定位。
      const message = error instanceof Error ? error.message : String(error)
      console.error(`agents-group: ${manifest.id} 装载失败：${message}`, error instanceof Error ? error.stack : '')
      mounted.push({ ...base, tools: [], failure: message, dispose: async () => {} })
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
