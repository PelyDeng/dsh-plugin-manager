import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createPluginTools, guardTool, listPlugins, registerPlugin } from '../src/index.ts'

function definition(execute = vi.fn(async () => ({ value: 'private' }))): ToolDefinition {
  return {
    name: 'example_query', description: '查询示例', parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }
}
// Only identity and cancellation are consumed by the shared guard and this inert tool.
const execution = { agent: {}, signal: new AbortController().signal } as unknown as ToolRunContext

describe('shared plugin tool registration', () => {
  it('blocks before dispatch and again before releasing a pending result', async () => {
    const body = vi.fn(async () => ({ value: 'private' }))
    const denied = guardTool(definition(body), () => { throw new Error('denied') })
    await expect(denied.execute({}, execution)).rejects.toThrow('denied')
    expect(body).not.toHaveBeenCalled()

    let allowed = true
    const authorize = vi.fn((agent: object | undefined) => { expect(agent).toBe(execution.agent); if (!allowed) throw new Error('revoked') })
    const raw = definition(vi.fn(async () => { allowed = false; return { value: 'private' } }))
    const guarded = guardTool(raw, authorize)
    expect(guarded.parameters).toBe(raw.parameters)
    expect(guarded.output).toBe(raw.output)
    await expect(guarded.execute({}, execution)).rejects.toThrow('revoked')
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('registers the guarded definition and removes both the real tool and its catalog with the plugin', async () => {
    const root = new Context()
    const registered = new Map<string, ToolDefinition>()
    root.provide('tools', { register(tool: ToolDefinition) {
      registered.set(tool.name, tool)
      return () => { registered.delete(tool.name) }
    } } as unknown as Context['tools'])
    let allowed = true
    const raw = definition()
    const plugin = root.plugin(ctx => {
      const tools = createPluginTools(ctx, { permission: 'example:access', authorize: () => { if (!allowed) throw new Error('denied') } })
      registerPlugin(ctx, {
        id: 'example', packageName: 'dsh-example', version: '1.0.0', displayName: '示例', description: '示例插件',
        permissions: ['example:access'], tools: [tools.register(raw)],
      })
    })
    await plugin.await()
    try {
      const tool = registered.get(raw.name)!
      expect(tool).not.toBe(raw)
      expect(listPlugins(root)[0]?.tools).toEqual([{
        name: tool.name, description: tool.description, parameters: tool.parameters, permission: 'example:access',
      }])
      await expect(tool.execute({}, execution)).resolves.toEqual({ value: 'private' })
      allowed = false
      await expect(tool.execute({}, execution)).rejects.toThrow('denied')
    } finally { await plugin.dispose() }
    expect(registered.size).toBe(0)
    expect(listPlugins(root)).toEqual([])
  })
})
