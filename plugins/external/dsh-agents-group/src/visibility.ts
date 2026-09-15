/**
 * 每个 Agent 的工具可见范围。
 *
 * 分工是刻意的：**群组只算规则，应用限制是子包的事**。宿主要求 `tools.restrict` 只能落在
 * agent 作用域里（宿主原话：`requires a scoped context (agent.ctx): a context-global
 * restriction would mask every agent`）—— 插件级限制会波及所有 Agent，包括牛马大总管自己的，
 * 而牛马大总管需要 `butler_plan` 才能派活。
 *
 * 所以群组把算好的 allow 列表注入子包（`AgentMountContext.allowedTools`），子包创建 Agent 时
 * 在自己的 `setup(agentCtx)` 里应用。这个模块只负责「算什么」，不碰限制的施加时机。
 */

import type { ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import { toolsForCategory } from '@dsh-plugin-manager/plugin-kit'
import type { AgentManifest } from './agents/registry.ts'

/**
 * 算出某个 Agent 能看到的工具名。
 *
 * 规则是「本分类 + 通用集」，由 kit 的 `toolsForCategory` 实现。这里只做两件群组才知道的事：
 * 把通用工具与**该 Agent 自己的**工具合起来当输入，以及在该 Agent 不存在时给出空清单。
 *
 * 空清单是安全的失败方向：拿不到工具总好过拿到不该有的。而**未分类的工具不自动放行**这条
 * 由 `toolsForCategory` 保证 —— 顺手放行会让限制形同虚设。
 */
export function allowedToolsFor(
  manifest: AgentManifest | undefined,
  universal: readonly ToolDescriptor[],
  agentTools: readonly ToolDescriptor[],
): readonly string[] {
  if (manifest === undefined) return []
  return toolsForCategory([...universal, ...agentTools], manifest.category)
}

/**
 * 按 id 建一个取值函数，供子包在创建 Agent 时惰性调用。
 *
 * 惰性求值是必需的：子包在 dispatch 时才创建 Agent，那时通用工具已经注册完毕；若在装载期
 * 就固定下来，通用工具可能还没进目录。
 */
export function allowedToolsLookup(
  manifests: readonly AgentManifest[],
  descriptorsOf: (agentId: string) => readonly ToolDescriptor[],
  universal: readonly ToolDescriptor[],
): (agentId: string) => readonly string[] {
  return agentId => allowedToolsFor(
    manifests.find(manifest => manifest.id === agentId),
    universal,
    descriptorsOf(agentId),
  )
}
