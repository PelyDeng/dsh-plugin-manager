/**
 * Agent 发现与可调度性测试。
 *
 * 关键约束：已接入列表来自插件目录，不硬编码任何插件名；可调度性来自执行入口登记。
 * 目录里有但没有登记入口的 Agent 仍要展示，只是标为不可调度。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { agentCard, collectExecutors, listAgentCards, resolveExecutor } from '../src/agents.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'

interface FakePlugin {
  id: string
  packageName?: string
  version?: string
  displayName?: string
  description?: string
  entryPath?: string
  permissions?: string[]
  tools?: unknown[]
  /**
   * 插件分类。管家只把「智能体」分类当成可对话成员，所以夹具默认就声明成智能体；
   * 要表达「不该出现在成员名单里」的插件时显式传别的分类。
   */
  category?: string | undefined
}

/**
 * 一个只实现本插件实际用到的两个事件通道的假上下文。
 *
 * `agents.ts` 只通过 `ctx.root.emit` 读目录和执行入口，所以不需要完整的 Cordis 运行时。
 */
function fakeContext(plugins: readonly FakePlugin[], executors: readonly ButlerAgentExecutor[] = []): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'ecosystem/catalog') {
          for (const plugin of plugins) {
            accept({
              protocol: 1,
              plugin: {
                id: plugin.id,
                packageName: plugin.packageName ?? `dsh-${plugin.id}`,
                version: plugin.version ?? '1.0.0',
                displayName: plugin.displayName ?? plugin.id,
                description: plugin.description ?? '',
                entryPath: plugin.entryPath ?? `/${plugin.id}`,
                permissions: plugin.permissions ?? [],
                tools: plugin.tools ?? [],
                category: plugin.category === undefined ? 'agents' : plugin.category,
              },
            })
          }
          return
        }
        if (name === 'butler/executors') {
          for (const executor of executors) accept(executor)
        }
      },
    },
  } as unknown as Context
}

function executor(agentId: string, capabilities?: readonly string[]): ButlerAgentExecutor {
  return {
    protocol: 1,
    agentId,
    ...(capabilities === undefined ? {} : { capabilities }),
    dispatch: async () => ({ status: 'succeeded', summary: 'ok' }),
  }
}

describe('已接入 Agent 列表', () => {
  it('从插件目录读取，不依赖写死的名单', () => {
    const ctx = fakeContext([
      { id: 'closedoff', displayName: '园区助手', version: '0.6.1' },
      { id: 'blog', displayName: '博客助手' },
    ])
    // 目录按 id 排序返回，顺序由 kit 决定，这里与实现保持一致。
    expect(listAgentCards(ctx).map(card => card.id)).toEqual(['blog', 'closedoff'])
  })

  it('只收「智能体」分类，认证/控制台/工具集这类插件不算成员', () => {
    const ctx = fakeContext([
      { id: 'closedoff', category: 'agents' },
      { id: 'blog', category: 'agents' },
      { id: 'auth', category: 'system-default' },
      { id: 'universal', category: 'universal-tools' },
      { id: 'butler', category: 'web-services' },
    ])
    expect(listAgentCards(ctx).map(card => card.id)).toEqual(['blog', 'closedoff'])
  })

  it('分类带空白也按声明处理，不会被误判成智能体', () => {
    const ctx = fakeContext([{ id: 'auth', category: ' system-default ' }, { id: 'blog', category: ' agents ' }])
    expect(listAgentCards(ctx).map(card => card.id)).toEqual(['blog'])
  })

  it('保留名称、版本、入口和工具数量等展示字段', () => {
    const ctx = fakeContext([{
      id: 'closedoff',
      packageName: 'dsh-agents-group',
      version: '0.6.1',
      displayName: '封闭化园区助手',
      description: '园区业务查询',
      entryPath: '/agents/closedoff',
      permissions: ['closedoff:access'],
      tools: [{ name: 'closedoff_vehicle_track' }, { name: 'closedoff_vehicle_stream' }, { name: 'closedoff_device_page' }],
    }])
    expect(listAgentCards(ctx)[0]).toEqual({
      id: 'closedoff',
      displayName: '封闭化园区助手',
      packageName: 'dsh-agents-group',
      version: '0.6.1',
      description: '园区业务查询',
      entryPath: '/agents/closedoff',
      permissions: ['closedoff:access'],
      toolCount: 3,
      dispatchable: false,
      capabilities: [],
    })
  })

  it('没有登记执行入口的 Agent 照样展示，但标记为不可调度', () => {
    const ctx = fakeContext([{ id: 'blog' }])
    expect(listAgentCards(ctx)[0]?.dispatchable).toBe(false)
  })

  it('登记了执行入口的 Agent 标记为可调度', () => {
    const ctx = fakeContext([{ id: 'closedoff' }], [executor('closedoff')])
    expect(listAgentCards(ctx)[0]?.dispatchable).toBe(true)
  })

  it('执行入口与目录里的 id 不一致时不会被当成可调度', () => {
    const ctx = fakeContext([{ id: 'closedoff' }], [executor('some-other-agent')])
    expect(listAgentCards(ctx)[0]?.dispatchable).toBe(false)
  })

  it('目录为空时返回空列表，而不是回退到写死的名单', () => {
    expect(listAgentCards(fakeContext([]))).toEqual([])
  })
})

describe('能力声明：新增 Agent 靠它被自动识别', () => {
  it('原样带上执行方声明的能力', () => {
    const ctx = fakeContext([{ id: 'closedoff' }], [executor('closedoff', ['园区数据查询', '车辆轨迹'])])
    expect(listAgentCards(ctx)[0]?.capabilities).toEqual(['园区数据查询', '车辆轨迹'])
  })

  it('没声明能力时为空数组，管家自行按语义判断', () => {
    const ctx = fakeContext([{ id: 'blog' }], [executor('blog')])
    expect(listAgentCards(ctx)[0]?.capabilities).toEqual([])
  })

  it('规整声明：去空白、去空项、去重、按 60 字上限截断，最多 12 条', () => {
    const noisy = [' 园区数据 ', '', '园区数据', 'x'.repeat(80), '车辆轨迹', '通行记录', '设备状态', '告警', '预约', '危化品', '统计', '报表', '多余的一条', '再多一条']
    const ctx = fakeContext([{ id: 'closedoff' }], [executor('closedoff', noisy)])
    const caps = listAgentCards(ctx)[0]?.capabilities ?? []
    expect(caps).not.toContain('')
    expect(caps).not.toContain('园区数据 ')   // 已去空白
    expect(caps.filter(cap => cap === '园区数据')).toHaveLength(1)  // 已去重
    expect(caps.some(cap => cap.length > 60)).toBe(false)           // 超长项被丢弃
    expect(caps.length).toBeLessThanOrEqual(12)
    expect(caps).toContain('车辆轨迹')
  })

  it('新增的插件带上能力就会被纳入可调度集合，管家侧无需改代码', () => {
    const before = listAgentCards(fakeContext([{ id: 'closedoff' }], [executor('closedoff', ['园区数据查询'])]))
    const after = listAgentCards(fakeContext(
      [{ id: 'closedoff' }, { id: 'newcomer' }],
      [executor('closedoff', ['园区数据查询']), executor('newcomer', ['排班'])],
    ))
    expect(before.filter(card => card.dispatchable).map(card => card.id)).toEqual(['closedoff'])
    expect(after.filter(card => card.dispatchable).map(card => card.id)).toEqual(['closedoff', 'newcomer'])
    expect(after.find(card => card.id === 'newcomer')?.capabilities).toEqual(['排班'])
  })
})

describe('执行入口登记', () => {
  it('按 agentId 建立索引', () => {
    const ctx = fakeContext([], [executor('closedoff'), executor('blog')])
    expect([...collectExecutors(ctx).keys()]).toEqual(['closedoff', 'blog'])
  })

  it('拒绝重复登记同一个 id', () => {
    const ctx = fakeContext([], [executor('blog'), executor('blog')])
    expect(() => collectExecutors(ctx)).toThrow(/重复登记/u)
  })

  it('拒绝协议版本不兼容的登记', () => {
    const ctx = fakeContext([], [{ protocol: 2, agentId: 'blog', dispatch: async () => ({ status: 'succeeded', summary: '' }) } as unknown as ButlerAgentExecutor])
    expect(() => collectExecutors(ctx)).toThrow(/协议版本/u)
  })

  it('拒绝缺少 agentId 的登记', () => {
    const ctx = fakeContext([], [executor('   ')])
    expect(() => collectExecutors(ctx)).toThrow(/agentId/u)
  })
})

describe('解析一个具体 Agent', () => {
  it('可调度时返回执行入口', () => {
    const target = executor('closedoff')
    const ctx = fakeContext([{ id: 'closedoff' }], [target])
    expect(resolveExecutor(ctx, 'closedoff')).toBe(target)
  })

  it('未登记入口时不返回执行入口', () => {
    const ctx = fakeContext([{ id: 'closedoff' }])
    expect(resolveExecutor(ctx, 'closedoff')).toBeUndefined()
  })

  it('不在目录中的 Agent 不会被解析出来', () => {
    const ctx = fakeContext([], [executor('ghost')])
    expect(resolveExecutor(ctx, 'ghost')).toBeUndefined()
  })

  it('agentCard 按 id 找到卡片', () => {
    const ctx = fakeContext([{ id: 'blog', displayName: '博客助手' }])
    expect(agentCard(ctx, 'blog')?.displayName).toBe('博客助手')
    expect(agentCard(ctx, 'missing')).toBeUndefined()
  })
})
