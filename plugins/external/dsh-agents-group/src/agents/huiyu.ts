/**
 * 绘语在群组里的适配层。
 *
 * 与 closedoff、blog 的适配层同构：补上群组权威提供的公共字段、把该 Agent 自己的页面前缀
 * 传下去、把就绪探针与释放函数接出来。业务代码全在 `agents/huiyu/` 里，不要上移到这个文件，
 * 否则群组又会变成一个大泥球。
 */

import { Config as HuiyuConfigSchema, mount, renderHttpError, type PluginConfig } from '../../agents/huiyu/src/index.ts'
import type { AgentMount } from '../host.ts'
import { endpointsOf } from './registry.ts'

/**
 * 绘语自己的 HTTP 错误渲染。
 *
 * 交给群组注入到 HTTP 注册器上：只有这个子包知道哪些错误是可预期的（参数不对是 400、
 * 上游挂了是 502、没配置是 503），群组不能替它决定，否则参数校验失败会被报成 500。
 */
export const huiyuErrorHandler = renderHttpError

/**
 * 装载绘语。
 *
 * 配置合并顺序：子包 Schema 默认值 → 群组配置的 `agents.huiyu.config` → 群组注入的公共字段。
 * 公共字段放最后，因为它们由群组权威提供，不接受子包覆盖。
 *
 * `routePrefix` 用**该 Agent 自己的页面前缀**（不是群组根）：它与路由注册、目录条目、探针
 * 地址出自同一处推导（`endpointsOf`），避免出现"路由挂在 A 而子包以为是 B"。
 */
export const mountHuiyu: AgentMount = async context => {
  const manifest = context.manifest
  const entryPath = endpointsOf(manifest, context.config.routePrefix, context.config.accessMode).entryPath
  const defaults = HuiyuConfigSchema({} as never)
  const config: PluginConfig = {
    ...defaults,
    ...(context.agentConfig as Partial<PluginConfig>),
    routePrefix: entryPath,
    publicOrigin: context.config.publicOrigin,
    accessMode: 'authenticated',
  }

  const instance = await mount({
    ctx: context.ctx,
    access: context.access,
    http: context.http,
    config,
    toolCategory: context.toolCategory,
    memberCategory: context.memberCategory,
    allowedTools: context.allowedTools,
    ...(context.groupConfigPath === undefined ? {} : { groupConfigPath: context.groupConfigPath }),
  })

  return {
    tools: instance.tools,
    participant: instance.participant,
    // Q4 口径：缺配置 = 本 Agent 未就绪，装载照常。探针交给群组的 per-agent 汇总。
    health: instance.health,
    dispose: instance.dispose,
  }
}
