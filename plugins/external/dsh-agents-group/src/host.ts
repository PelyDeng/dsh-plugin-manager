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
/**
 * 协作契约按**源码相对路径**引入，不走包名。
 *
 * `@dsh-agents-group/common` 只提供源码、不产出声明文件；打包器生成声明时按包名找不到
 * `.d.ts`，会把契约类型当成「没有这个导出」直接报错。相对路径是源码图里的普通模块，
 * 声明生成能正常跟随；运行时的 `agentResource` 等仍按包名引入（它们会被内联进产物）。
 */
import type { AgentParticipant } from '../packages/common/src/participant.ts'
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
  /** 该 Agent 的协作参与者；装载失败时为 undefined。群组据此桥接牛马大总管的执行入口。 */
  readonly participant?: AgentParticipant
  /** 装载失败时的可读原因；正常时为 undefined。 */
  readonly failure?: string
  /**
   * 运行期就绪探针（可选）：装载成功 ≠ 永远就绪（例如 blog 的业务存储可配置但运行中不可达）。
   * 返回 `{ok:false,error}` 时该 Agent 按未就绪计，探针 503；实现必须自带有界超时。
   */
  readonly health?: () => Promise<{ ok: boolean; error?: string }>
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
   * 再写一份字符串就会与清单漂移，而漂移的后果是「该 Agent 的工具全部不可见」，   * 且这种失效在界面上完全看不出来。
   */
  readonly category: string
  /**
   * 该 Agent 能用的工具名（本分类 + 通用集）。
   *
   * **惰性**：函数体内取值，因为子包创建 Agent 的时刻晚于群组注册通用工具。子包必须在
   * 自己创建 Agent 时（agent 作用域内）用它做 `agentCtx.tools.restrict({ allow })`，
   * 不能在插件上下文里限制 —— 宿主会拒绝那样做。
   */
  readonly allowedTools: () => readonly string[]
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
   * 漏报会让对应工具对该 Agent 不可见，而那种失效在界面上看不出来。
   */
  tools: readonly ToolDescriptor[]
  /**
   * 该 Agent 的协作参与者。
   *
   * 群组把它桥接成牛马大总管的执行入口 —— 参与者已经实现了「派一轮活、拿回结论」，桥接只做字段
   * 翻译。漏报会让该 Agent 在牛马大总管的名单里变成「不可调度」，牛马大总管于是不会把专业活派给它。
   */
  participant: AgentParticipant
  /**
   * 运行期就绪探针（可选）：装载成功后仍可能未就绪（blog 的 Q4 口径——业务存储缺配置
   * 或运行中不可达）。群组的 healthPath 与 /ready 汇总都会调用它；实现必须自带有界超时。
   */
  health?: () => Promise<{ ok: boolean; error?: string }>
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
  shared: Omit<AgentMountContext, 'ctx' | 'access' | 'http' | 'agentConfig' | 'manifest' | 'category' | 'allowedTools'> & {
    /** 按 Agent id 取它自己的部署字段。 */
    readonly agentConfigOf: (agentId: string) => Record<string, unknown>
    /**
     * 该 Agent 能用的工具名（本分类 + 通用集）。
     *
     * 群组算好后注入，子包在**自己创建 Agent 时的 agent 作用域**里应用它。不能由群组在插件
     * 上下文里直接 `ctx.tools.restrict` —— 宿主明确拒绝那种写法：
     *
     * > tools.restrict() requires a scoped context (agent.ctx): a context-global restriction
     * > would mask every agent
     *
     * 惰性求值：子包在 dispatch 时才创建 Agent，那时通用工具已经注册完毕。
     */
    readonly allowedToolsOf?: (agentId: string) => readonly string[]
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
        // 惰性包装：真实取值发生在子包创建 Agent 时，那时通用工具已注册。
        allowedTools: () => shared.allowedToolsOf?.(manifest.id) ?? [],
        config: shared.config,
        agentConfig: shared.agentConfigOf(manifest.id),
        access,
        http,
        common: shared.common,
        ...(shared.groupConfigPath === undefined ? {} : { groupConfigPath: shared.groupConfigPath }),
      })
      mounted.push({
        ...base,
        tools: instance.tools,
        participant: instance.participant,
        ...(instance.health === undefined ? {} : { health: instance.health }),
        dispose: instance.dispose,
      })
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
 *
 * 异步：提供 `health` 探针的 Agent（如 blog 的业务存储）在判定时要核实当前状态；
 * 探针实现自带有界超时，不会拖住整个判定。
 */
export async function readiness(mounted: readonly MountedAgent[]): Promise<{
  ok: boolean
  agents: { id: string; ready: boolean; entryPath: string; error?: string }[]
}> {
  const agents = []
  for (const agent of mounted) {
    let ready = agent.failure === undefined
    let error: string | undefined = agent.failure
    if (ready && agent.health !== undefined) {
      try {
        const state = await agent.health()
        if (!state.ok) {
          ready = false
          error = state.error ?? 'Agent 未就绪'
        }
      } catch (caught) {
        ready = false
        error = caught instanceof Error ? caught.message : String(caught)
      }
    }
    agents.push({ id: agent.id, ready, entryPath: agent.entryPath, ...(error === undefined ? {} : { error }) })
  }
  return { ok: agents.some(agent => agent.ready), agents }
}
