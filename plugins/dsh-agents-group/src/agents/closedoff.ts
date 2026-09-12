/**
 * 封闭化助手在群组里的适配层。
 *
 * 这一层很薄，只做两件事：把群组注入的公共字段补进子包配置、把子包的释放函数接出去。
 * 业务代码全在 `agents/closedoff/` 里，不要上移到这个文件，否则群组又会变成一个大泥球。
 */

import { Config as ClosedoffConfigSchema, mount, type PluginConfig } from '../../agents/closedoff/src/index.ts'
import { renderHttpError } from '../../agents/closedoff/src/web.ts'
import type { AgentMount } from '../host.ts'
import { endpointsOf } from './registry.ts'

/**
 * 封闭化助手自己的 HTTP 错误渲染。
 *
 * 交给群组注入到 HTTP 注册器上：只有这个子包知道哪些错误是可预期的。
 * 群组不能替它决定，否则参数校验失败会被报成 500。
 */
export const closedoffErrorHandler = renderHttpError

/**
 * 装载封闭化助手。
 *
 * 配置合并顺序：子包 Schema 默认值 → 群组配置的 `agents.closedoff.config` →
 * 群组注入的公共字段。公共字段放最后，因为它们由群组权威提供，不接受子包覆盖。
 *
 * 注意 `routePrefix` 用的是**该 Agent 自己的页面前缀**，不是群组根。它与路由注册、目录
 * 条目、探针地址出自同一处推导（`endpointsOf`），避免出现「路由挂在 A 而子包以为是 B」。
 */
export const mountClosedoff: AgentMount = async context => {
  const manifest = context.manifest
  const entryPath = endpointsOf(manifest, context.config.routePrefix).entryPath
  const defaults = { ...(ClosedoffConfigSchema.meta.default as PluginConfig) }
  const config: PluginConfig = {
    ...defaults,
    ...(context.agentConfig as Partial<PluginConfig>),
    routePrefix: entryPath,
    publicOrigin: context.config.publicOrigin,
    accessMode: context.config.accessMode,
  }

  const instance = await mount({
    ctx: context.ctx,
    access: context.access,
    http: context.http,
    config,
    ...(context.groupConfigPath === undefined ? {} : { groupConfigPath: context.groupConfigPath }),
  })

  return { dispose: instance.dispose }
}
