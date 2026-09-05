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

/** Mount authorized tools in the current plugin lifecycle and return their catalog entries. */
export function createPluginTools(ctx: Context, options: { readonly permission: string; readonly authorize: ToolAuthorizer }) {
  return {
    register(definition: ToolDefinition): ToolDescriptor {
      const tool = guardTool(definition, options.authorize)
      ctx.effect(() => ctx.tools.register(tool))
      return { name: tool.name, description: tool.description, parameters: tool.parameters, permission: options.permission }
    },
  }
}
