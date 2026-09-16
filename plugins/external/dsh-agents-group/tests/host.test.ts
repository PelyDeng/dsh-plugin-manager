/**
 * 群组装载与就绪判定的测试。
 *
 * 核心契约是**失败隔离**：一个 Agent 装载失败不能让整个群组不可用。
 * 这是合并成一个进程之后新增的运维要求，必须有测试守着。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type * as common from '@dsh-agents-group/common'
import type { AgentManifest } from '../src/agents/registry.ts'
import { mountAgents, readiness, type AgentMount, type MountedAgent } from '../src/host.ts'

/** 只提供 mountAgents 实际用到的那点上下文。 */
function fakeContext(): Context {
  return { effect: () => () => {} } as unknown as Context
}

const noAccess = () => ({
  mode: 'standalone',
  ready: () => {},
  assert: () => {},
  resolve: () => ({ namespace: 'standalone' as const, userId: 'local' }),
})

const shared = {
  config: { routePrefix: '/agents', publicOrigin: '', accessMode: 'standalone' as const },
  common: {} as typeof common,
  // 各 Agent 自己的部署字段；测试里不关心，统一给空对象。
  agentConfigOf: () => ({}),
}

const manifests: AgentManifest[] = [
  { id: 'closedoff', displayName: '封闭化', directory: 'closedoff', category: '园区', description: '' },
  { id: 'blog', displayName: '博客', directory: 'blog', category: '博客', description: '' },
]

/** 走一遍真实的装载流程，但把 webServer 换成可预测的假实现。 */
async function mount(loader: (m: AgentManifest) => Promise<AgentMount | undefined>) {
  // host.ts 内部调用 createAccess/createPluginHttp；两者都会用 ctx。
  // 这里给一个最小可用的假上下文：effect 返回空的 disposer，webServer.register 记录但不真注册。
  const ctx = {
    effect: () => () => {},
    webServer: { register: () => () => {} },
  } as unknown as Context
  return await mountAgents(ctx, manifests, shared, loader)
}

/** 一个什么都不做的装载函数，用来表达「子包正常起来了」。 */
const okMount: AgentMount = async () => ({
  dispose: async () => {},
  tools: [],
  participant: {
    protocol: 1, id: 'closedoff', displayName: 'x', description: '',
    assertAccess: () => {},
    run: async () => ({ status: 'completed', conversationId: 'c', text: '' }),
  } as never,
})

describe('装载失败隔离', () => {
  it('一个 Agent 抛错时，其他 Agent 照常装载', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mounted = await mount(async m => {
      if (m.id === 'closedoff') throw new Error('子包坏了')
      return okMount
    })
    spy.mockRestore()

    expect(mounted).toHaveLength(2)
    const closedoff = mounted.find(a => a.id === 'closedoff')
    const blog = mounted.find(a => a.id === 'blog')
    expect(closedoff?.failure).toContain('子包坏了')
    expect(blog?.failure).toBeUndefined()
  })

  it('子包没有提供装载入口时记为失败，而不是静默跳过', async () => {
    const mounted = await mount(async () => undefined)
    expect(mounted.every(a => a.failure !== undefined)).toBe(true)
  })

  it('失败条目的端点仍然推导出来，便于探针如实展示', async () => {
    const mounted = await mount(async () => undefined)
    const closedoff = mounted.find(a => a.id === 'closedoff')
    expect(closedoff?.entryPath).toBe('/agents/closedoff')
    expect(closedoff?.permission).toBe('closedoff:access')
  })
})

describe('就绪判定', () => {
  const base: Omit<MountedAgent, 'id' | 'failure'> = {
    manifest: manifests[0]!,
    entryPath: '/agents/x',
    healthPath: '/agents/x/ready',
    permission: 'x:access',
    accessMode: 'standalone',
    tools: [],
    dispose: async () => {},
  }

  it('只要有一个 Agent 就绪就算就绪 —— 避免一个 Agent 拖垮整组判定', async () => {
    const state = await readiness([
      { ...base, id: 'closedoff', failure: '坏了' },
      { ...base, id: 'blog' },
    ])
    expect(state.ok).toBe(true)
    expect(state.agents.find(a => a.id === 'closedoff')?.ready).toBe(false)
    expect(state.agents.find(a => a.id === 'blog')?.ready).toBe(true)
  })

  it('全部失败时才不就绪', async () => {
    expect((await readiness([{ ...base, id: 'closedoff', failure: '坏了' }])).ok).toBe(false)
  })

  it('空群组不就绪：没有可用 Agent 时不应报正常', async () => {
    expect((await readiness([])).ok).toBe(false)
  })

  it('明细里带上失败原因，便于运维定位', async () => {
    const state = await readiness([{ ...base, id: 'closedoff', failure: '缺少 gateway 配置' }])
    expect(state.agents[0]?.error).toBe('缺少 gateway 配置')
  })

  it('装载成功但运行期探针报未就绪时如实计入（blog 存储的 Q4 口径）', async () => {
    const state = await readiness([
      { ...base, id: 'closedoff' },
      { ...base, id: 'blog', health: async () => ({ ok: false, error: '博客业务存储不可用（storage_unreachable）' }) },
    ])
    expect(state.ok).toBe(true)
    expect(state.agents.find(a => a.id === 'blog')?.ready).toBe(false)
    expect(state.agents.find(a => a.id === 'blog')?.error).toContain('storage_unreachable')
  })
})
