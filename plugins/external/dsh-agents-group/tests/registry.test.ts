/**
 * 群组清单与端点推导的测试。
 *
 * 这里锁的是三条容易写错、错了又难查的约定：
 * 1. 路径、权限、id 三者必须由同一处推导，不允许各处手写不一致。
 * 2. 清单不允许重复 id（重复会让目录登记直接抛错）。
 * 3. 空清单是合法状态（P0 骨架就是空的），不能因此报错。
 */
import { describe, expect, it } from 'vitest'
import { assertUniqueManifests, AGENT_MANIFESTS, endpointsOf, type AgentManifest } from '../src/agents/registry.ts'

const sample: AgentManifest = {
  id: 'closedoff',
  displayName: '封闭化管理助手',
  directory: 'closedoff',
  category: '封闭化园区',
  description: '园区业务查询',
}

describe('Agent 清单', () => {
  it('P0 阶段清单可以为空，这是合法状态', () => {
    expect(Array.isArray(AGENT_MANIFESTS)).toBe(true)
    expect(() => assertUniqueManifests(AGENT_MANIFESTS)).not.toThrow()
  })

  it('拒绝重复的 id', () => {
    expect(() => assertUniqueManifests([sample, { ...sample, displayName: '另一个' }]))
      .toThrow(/Agent id 重复：closedoff/u)
  })

  it('不同 id 可以共存', () => {
    expect(() => assertUniqueManifests([sample, { ...sample, id: 'blog', directory: 'blog' }])).not.toThrow()
  })
})

describe('端点推导', () => {
  it('页面路径挂在群组前缀下', () => {
    expect(endpointsOf(sample, '/agents').entryPath).toBe('/agents/closedoff')
  })

  it('权限标识与 id 一致 —— 这是授权粒度所在', () => {
    const endpoints = endpointsOf(sample, '/agents')
    expect(endpoints.permission).toBe('closedoff:access')
    expect(endpoints.id).toBe(sample.id)
  })

  it('就绪路径是页面路径的子路径（前缀路由才能覆盖）', () => {
    const endpoints = endpointsOf(sample, '/agents')
    expect(endpoints.healthPath.startsWith(`${endpoints.entryPath}/`)).toBe(true)
  })

  it('支持多段前缀，例如把群组挂在 /agents 之下更深处', () => {
    expect(endpointsOf(sample, '/platform/agents').entryPath).toBe('/platform/agents/closedoff')
  })
})

describe('清单与装载 switch 的机器守护', () => {
  it('每个成员的 id 在 loadAgent 与 errorHandlerOf 的 switch 里都有 case（漏加=静默缺席）', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    for (const manifest of AGENT_MANIFESTS) {
      const cases = source.split(`case '${manifest.id}':`).length - 1
      expect(cases, `${manifest.id} 应同时出现在 loadAgent 与 errorHandlerOf 两个 switch`).toBeGreaterThanOrEqual(2)
    }
  })
})
