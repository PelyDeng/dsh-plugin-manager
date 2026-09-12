/**
 * 已接入 Agent 的发现与可调度性判定。
 *
 * 两个来源各自回答一个问题，不互相替代：
 *
 * 1. 插件目录（kit 的 `ecosystem/catalog`）说明生态里有哪些应用，提供名称、版本、
 *    入口、权限和工具数量。这是所有已接入 Agent 的真实来源，页面不硬编码任何
 *    插件名。
 * 2. 调度入口（本插件的 `butler/executors` 事件）说明哪些应用愿意并且能够接收
 *    子任务。目录里有但没登记执行入口的应用照样展示，只是标记为不可调度。
 *
 * ## 为什么只列「智能体」分类
 *
 * 目录里同时有认证、控制台、工具集这类插件，它们不是可以对话的对象。牛马大总管页面是
 * 成员名单，不是插件清单，所以只收 `category` 声明为「智能体」的插件。分类取自
 * 插件自己的清单声明，所以新增一个 Agent 只要声明分类就会自动出现，牛马大总管侧不用改。
 */

import type { Context } from '@deepseek-ai/cordis'
import { AGENT_PLUGIN_CATEGORY, listPlugins } from '@dsh-plugin-manager/plugin-kit'
import { BUTLER_EXECUTORS_EVENT, type ButlerAgentExecutor } from './protocol.ts'

/** 页面上一张 Agent 卡片需要的全部信息，全部来自真实声明或注册，不含配置值。 */
export interface AgentCard {
  /** 插件登记的应用 id，也是任务计划里引用的 id。 */
  readonly id: string
  /** 页面显示名，来自插件声明的 displayName。 */
  readonly displayName: string
  /** 包名，用于排查问题时对照归档。 */
  readonly packageName: string
  readonly version: string
  /** 插件自述的能力摘要，可能是空字符串。 */
  readonly description: string
  /** 页面入口路径，可用于跳转到该 Agent 自己的页面。 */
  readonly entryPath: string
  /** 声明的权限标识。只展示，不代表当前用户一定被授权。 */
  readonly permissions: readonly string[]
  /** 该 Agent 登记的工具数量，用于说明它的能力规模。 */
  readonly toolCount: number
  /** 是否登记了调度执行入口；为 false 时牛马大总管不会把子任务派给它。 */
  readonly dispatchable: boolean
  /**
   * 执行入口自己声明能接的活。
   *
   * 与 `description` 分开：`description` 是插件的自我介绍，这个是**可派活的边界**，
   * 牛马大总管按它决定把子任务交给谁。新增插件只要声明就会被自动纳入，牛马大总管侧无需改代码。
   */
  readonly capabilities: readonly string[]
}

/**
 * 收集当前登记的调度入口。
 *
 * 同一个 id 重复登记按错误处理：静默覆盖会让页面显示一个实际从未被使用的入口。
 * 协议版本不兼容同样拒绝，避免用错误的约定去派活。
 */
export function collectExecutors(ctx: Context): Map<string, ButlerAgentExecutor> {
  const executors = new Map<string, ButlerAgentExecutor>()
  ctx.root.emit(BUTLER_EXECUTORS_EVENT, (executor: ButlerAgentExecutor) => {
    if (executor.protocol !== 1) throw new Error(`调度协议版本不兼容：${String(executor.protocol)}`)
    const id = executor.agentId.trim()
    if (id === '') throw new Error('调度执行入口缺少 agentId')
    if (executors.has(id)) throw new Error(`调度执行入口重复登记：${id}`)
    executors.set(id, executor)
  })
  return executors
}

/** 读取一张指定 Agent 的卡片；不存在时返回 undefined。 */
export function agentCard(ctx: Context, id: string): AgentCard | undefined {
  return listAgentCards(ctx).find(card => card.id === id)
}

/**
 * 列出全部已接入 Agent（只含声明为「智能体」分类的插件）。
 *
 * 目录读取失败时直接抛出：宁可在页面上显示“读取失败”，也不要退化成一份写死的
 * 名单，那样用户会以为三个插件就是全部。
 */
export function listAgentCards(ctx: Context): AgentCard[] {
  const executors = collectExecutors(ctx)
  return listPlugins(ctx)
    .filter(plugin => plugin.category?.trim() === AGENT_PLUGIN_CATEGORY)
    .map(plugin => {
      const executor = executors.get(plugin.id)
      return {
        id: plugin.id,
        displayName: plugin.displayName,
        packageName: plugin.packageName,
        version: plugin.version,
        description: plugin.description,
        entryPath: plugin.entryPath ?? '',
        permissions: plugin.permissions,
        toolCount: plugin.tools.length,
        dispatchable: executor !== undefined,
        capabilities: normalizeCapabilities(executor?.capabilities),
      }
    })
}

/**
 * 规整执行方声明的能力。
 *
 * 去空白、去空项、去重并限量，避免把一段失控的长文本塞进牛马大总管的提示词里。
 */
function normalizeCapabilities(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || text.length > 60 || seen.has(text)) continue
    seen.add(text)
    if (seen.size >= 12) break
  }
  return [...seen]
}

/**
 * 取出一个可调度的执行入口，同时校验它仍在目录中。
 *
 * 只在目录里登记的应用才能被调度：否则子任务会被派给一个页面上根本看不到的
 * Agent，用户无法追踪。
 */
export function resolveExecutor(ctx: Context, id: string): ButlerAgentExecutor | undefined {
  const known = listAgentCards(ctx).some(card => card.id === id && card.dispatchable)
  if (!known) return undefined
  return collectExecutors(ctx).get(id)
}
