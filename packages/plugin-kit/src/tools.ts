/** Shared tool authorization and metadata derived from actual host registrations. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolDescriptor } from './access.ts'

/** Check the server-bound Agent identity; callers never obtain an identity from tool arguments. */
export type ToolAuthorizer = (agent: object | undefined) => void

/** Check access before dispatch and again before a pending result is released. */
export function guardTool(tool: ToolDefinition, authorize: ToolAuthorizer): ToolDefinition {
  return {
    ...tool,
    async execute(args, execution) {
      authorize(execution.agent)
      const result = await tool.execute(args, execution)
      authorize(execution.agent)
      return result
    },
  }
}

/**
 * 约定好的通用工具标签。
 *
 * 带这个标签的工具对每个 Agent 都可见，不受「只允许调用自己标签的工具」限制。
 * 标签值集中在这里定义，避免各插件各写一份字符串而拼错。
 */
export const UNIVERSAL_TOOL_CATEGORY = '通用工具'

/** Mount authorized tools in the current plugin lifecycle and return their catalog entries. */
export function createPluginTools(ctx: Context, options: { readonly permission: string; readonly authorize: ToolAuthorizer }) {
  return {
    /**
     * 注册一个工具并返回目录条目。
     *
     * @param definition 工具定义。
     * @param displayName 认证页面显示名，留空则回落到工具名。
     * @param category 分类标签，由本插件自己决定；通用工具用 {@link UNIVERSAL_TOOL_CATEGORY}。
     *   不传表示不参与分类——它仍可用，只是不参与按标签的可见性限制。
     */
    register(definition: ToolDefinition, displayName?: string, category?: string): ToolDescriptor {
      const tool = guardTool(definition, options.authorize)
      ctx.effect(() => ctx.tools.register(tool))
      const label = category?.trim()
      return {
        name: tool.name,
        ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
        description: tool.description,
        parameters: tool.parameters,
        permission: options.permission,
        ...(label ? { category: label } : {}),
      }
    },
  }
}

/**
 * 按分类标签算出某个 Agent 应当可见的工具名。
 *
 * 规则：**本分类的工具 + 通用工具**。两个细节容易写错：
 *
 * - 通用集必须并进来，否则 Agent 连约定好的公共工具都调不了；
 * - 没有标签的工具**不**自动放行 —— 它们不参与分类体系，交给调用方显式决定
 *   （通常是不做限制，而不是悄悄把它们塞进每个 Agent 的 allow 列表）。
 */
export function toolsForCategory(
  descriptors: readonly ToolDescriptor[],
  category: string,
  universal: string = UNIVERSAL_TOOL_CATEGORY,
): string[] {
  return descriptors
    .filter(tool => tool.category === category || tool.category === universal)
    .map(tool => tool.name)
}
