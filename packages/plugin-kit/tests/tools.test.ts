import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createPluginTools, guardTool, listPlugins, registerPlugin, toolsForCategory, UNIVERSAL_TOOL_CATEGORY } from '../src/index.ts'
import type { ToolDescriptor } from '../src/index.ts'

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
        permissions: ['example:access'], tools: [tools.register(raw, ' 查询示例 ')],
      })
    })
    await plugin.await()
    try {
      const tool = registered.get(raw.name)!
      expect(tool).not.toBe(raw)
      expect(listPlugins(root)[0]?.tools).toEqual([{
        name: tool.name, displayName: '查询示例', description: tool.description, parameters: tool.parameters, permission: 'example:access',
      }])
      expect(tool.name).toBe('example_query')
      expect(tool).not.toHaveProperty('displayName')
      await expect(tool.execute({}, execution)).resolves.toEqual({ value: 'private' })
      allowed = false
      await expect(tool.execute({}, execution)).rejects.toThrow('denied')
    } finally { await plugin.dispose() }
    expect(registered.size).toBe(0)
    expect(listPlugins(root)).toEqual([])
  })
})

describe('工具分类标签', () => {
  it('分类由注册方提供，缺省时不写入字段', async () => {
    const root = new Context()
    const registered = new Map<string, ToolDefinition>()
    const plugin = root.plugin(ctx => {
      ctx.effect(() => ctx.provide('tools', {
        register(tool: ToolDefinition) { registered.set(tool.name, tool); return () => {} },
      } as never))
      const tools = createPluginTools(ctx, { permission: 'example:access', authorize: () => {} })
      registerPlugin(ctx, {
        id: 'example', packageName: 'dsh-example', version: '1.0.0', displayName: '示例', description: '',
        permissions: ['example:access'],
        tools: [
          tools.register(definition(), '封闭化查询', '封闭化园区'),
          tools.register({ ...definition(), name: 'plain_query' }, '无标签工具'),
        ],
      })
    })
    await plugin.await()
    try {
      const tools = listPlugins(root)[0]?.tools ?? []
      const categorized = tools.find(tool => tool.name === 'example_query')
      const plain = tools.find(tool => tool.name === 'plain_query')
      expect(categorized?.category).toBe('封闭化园区')
      // 不传分类时不写字段：既有插件不受影响，且不参与按标签的可见性限制。
      expect(plain).not.toHaveProperty('category')
    } finally { await plugin.dispose() }
  })

  it('空白分类视为未分类', async () => {
    const root = new Context()
    const plugin = root.plugin(ctx => {
      ctx.effect(() => ctx.provide('tools', { register: () => () => {} } as never))
      const tools = createPluginTools(ctx, { permission: 'example:access', authorize: () => {} })
      registerPlugin(ctx, {
        id: 'example', packageName: 'dsh-example', version: '1.0.0', displayName: '示例', description: '',
        permissions: ['example:access'], tools: [tools.register(definition(), '查询', '   ')],
      })
    })
    await plugin.await()
    try {
      expect(listPlugins(root)[0]?.tools[0]).not.toHaveProperty('category')
    } finally { await plugin.dispose() }
  })
})

describe('按分类取可见工具', () => {
  const descriptors: ToolDescriptor[] = [
    { name: 'closedoff_track', description: '', parameters: {}, permission: 'p', category: '封闭化园区' },
    { name: 'blog_write', description: '', parameters: {}, permission: 'p', category: '博客工作台' },
    { name: 'weather_query', description: '', parameters: {}, permission: 'p', category: UNIVERSAL_TOOL_CATEGORY },
    { name: 'legacy_query', description: '', parameters: {}, permission: 'p' },
  ]

  it('包含本分类与通用工具', () => {
    expect(toolsForCategory(descriptors, '封闭化园区').sort()).toEqual(['closedoff_track', 'weather_query'])
  })

  it('不含其他分类的工具 —— 这是「只能调自己标签」的核心', () => {
    expect(toolsForCategory(descriptors, '封闭化园区')).not.toContain('blog_write')
  })

  it('未分类的工具不自动放行', () => {
    // 它们不参与分类体系；把无标签工具悄悄塞给每个 Agent 会让限制形同虚设。
    expect(toolsForCategory(descriptors, '封闭化园区')).not.toContain('legacy_query')
  })

  it('每个分类都能拿到通用工具', () => {
    expect(toolsForCategory(descriptors, '博客工作台')).toContain('weather_query')
  })

  it('未知分类只拿到通用工具', () => {
    expect(toolsForCategory(descriptors, '不存在的分类')).toEqual(['weather_query'])
  })

  it('通用标签可以自定义', () => {
    const custom: ToolDescriptor[] = [
      { name: 'a', description: '', parameters: {}, permission: 'p', category: 'X' },
      { name: 'b', description: '', parameters: {}, permission: 'p', category: 'COMMON' },
    ]
    expect(toolsForCategory(custom, 'X', 'COMMON').sort()).toEqual(['a', 'b'])
  })
})
