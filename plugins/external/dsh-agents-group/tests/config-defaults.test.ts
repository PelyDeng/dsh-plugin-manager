/**
 * 子包配置默认值的测试。
 *
 * 这里守的是一个踩过的坑：`Schema.meta.default` 在 schemastery 里是**空对象**，不是计算出的
 * 默认值集合。依赖它会让所有未在部署 patch 里显式配置的字段变成 `undefined`，而且失效方式
 * 很隐蔽 —— 各组件的单测都跑源码、各自传自己的配置，看不见「原来少了默认值」。
 *
 * 实际症状：closedoff 的 `maxActiveConversations` 变成 undefined，派发子任务时抛出
 * `active conversation limit undefined reached` 这种看不出原因的信息。
 */

import { describe, expect, it } from 'vitest'
import { Config as ClosedoffConfig } from '../agents/closedoff/src/config.ts'
import { Config as BlogConfig } from '../agents/blog/src/config.ts'
import { Config as GroupConfig, agentConfig, isAgentEnabled } from '../src/config.ts'

describe('Schema 默认值必须靠解析空对象拿到', () => {
  it('meta.default 是空对象 —— 所以不能依赖它', () => {
    // 这条断言本身就是文档：一旦 schemastery 改了行为，这里会先失败，提醒可以简化实现。
    expect(Object.keys(ClosedoffConfig.meta.default ?? {}).length).toBe(0)
    expect(Object.keys(GroupConfig.meta.default ?? {}).length).toBe(0)
  })

  it('closedoff 解析空对象后字段齐全且是可用值', () => {
    const config = ClosedoffConfig({} as never)
    // 关键项逐个点名，避免将来新增字段时又漏掉默认值而没人发现。
    expect(config.maxActiveConversations).toBeGreaterThan(0)
    expect(config.routePrefix).toMatch(/^\//u)
    expect(typeof config.reasoningEffort).toBe('string')
    expect(Number.isFinite(config.tilesetHeight)).toBe(true)
    expect(Number.isFinite(config.trackDeviceRadiusMeters)).toBe(true)
    // 不能有 undefined：那正是这个坑的表现。
    for (const [key, value] of Object.entries(config)) {
      expect(value, `${key} 不应是 undefined`).toBeDefined()
    }
  })

  it('blog 解析空对象后字段齐全', () => {
    const config = BlogConfig({} as never)
    expect(config.accessMode).toBe('authenticated')
    expect(config.turnTimeoutMs).toBeGreaterThan(0)
    expect(config.routePrefix).toMatch(/^\//u)
    for (const [key, value] of Object.entries(config)) {
      expect(value, `${key} 不应是 undefined`).toBeDefined()
    }
  })

  it('群组解析空对象后字段齐全', () => {
    const config = GroupConfig({} as never)
    expect(config.routePrefix).toBe('/agents')
    expect(config.accessMode).toBe('authenticated')
    expect(config.authRecheckMs).toBeGreaterThan(0)
    expect(config.agents).toEqual({})
  })
})

describe('群组按 Agent 取配置', () => {
  it('未声明的 Agent 拿到可用的默认值，而不是 undefined', () => {
    // 返回 undefined 会让子包在读取时崩，且报错位置离原因很远。
    const config = GroupConfig({} as never)
    const entry = agentConfig(config, 'never-configured')
    expect(entry.enabled).toBe(true)
    expect(entry.config).toEqual({})
    expect(entry.models).toEqual({ allow: [], deny: [] })
  })

  it('未声明的 Agent 默认启用', () => {
    // 否则新增 Agent 会「装了但不出现」，很难查。
    expect(isAgentEnabled(GroupConfig({} as never), 'brand-new')).toBe(true)
  })

  it('显式关闭的 Agent 不启用', () => {
    const config = GroupConfig({ agents: { closedoff: { enabled: false } } } as never)
    expect(isAgentEnabled(config, 'closedoff')).toBe(false)
  })

  it('子包自己的字段原样带出，不被群组改写', () => {
    const config = GroupConfig({
      agents: { closedoff: { config: { tilesetHeight: 123, reasoningEffort: 'high' } } },
    } as never)
    expect(agentConfig(config, 'closedoff').config).toMatchObject({ tilesetHeight: 123, reasoningEffort: 'high' })
  })
})

describe('子包访问模式的推导', () => {
  it('强制认证的 Agent 在 standalone 群里也拿到 authenticated', async () => {
    const { endpointsOf } = await import('../src/agents/registry.ts')
    const { AGENT_MANIFESTS } = await import('../src/agents/registry.ts')
    const blog = AGENT_MANIFESTS.find(manifest => manifest.id === 'blog')!
    const closedoff = AGENT_MANIFESTS.find(manifest => manifest.id === 'closedoff')!
    // blog 的业务前提是可信身份，所以它的访问模式不受群组影响。
    expect(endpointsOf(blog, '/agents', 'standalone').accessMode).toBe('authenticated')
    // closedoff 跟随群组。
    expect(endpointsOf(closedoff, '/agents', 'standalone').accessMode).toBe('standalone')
    expect(endpointsOf(closedoff, '/agents', 'authenticated').accessMode).toBe('authenticated')
  })

  it('页面前缀用该 Agent 自己的入口，不是群组根', async () => {
    const { endpointsOf, AGENT_MANIFESTS } = await import('../src/agents/registry.ts')
    for (const manifest of AGENT_MANIFESTS) {
      const endpoints = endpointsOf(manifest, '/agents', 'authenticated')
      expect(endpoints.entryPath).toBe(`/agents/${manifest.id}`)
      expect(endpoints.healthPath).toBe(`/agents/${manifest.id}/ready`)
    }
  })
})
