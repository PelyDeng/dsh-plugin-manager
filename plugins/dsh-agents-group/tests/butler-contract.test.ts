/**
 * 跨插件契约：群组的执行入口必须被牛马大总管真正接受。
 *
 * 两个插件靠事件名与字段对齐，不互相导入源码；这种松耦合最容易静默失配 —— 名字拼错、
 * 版本号不匹配、agentId 对不上目录，都不会在各自仓库的类型检查里暴露。所以这里把两边
 * 同时装进一个假上下文，验证**牛马大总管真的能把群组的 Agent 列成可调度成员**。
 *
 * 没有这条链路，牛马大总管的名单恒为空，它每轮收到的提示词是「没有能接活的成员，这一轮只能你
 * 自己回答」—— 于是「协调对应智能体」完全不通。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentParticipant } from 'dsh-pirate-command/protocol'
import { collectExecutors, listAgentCards } from '../../dsh-butler-console/src/agents.ts'
import { executorFor, BUTLER_EXECUTORS_EVENT } from '../src/butler-bridge.ts'
import type { AgentManifest } from '../src/agents/registry.ts'

const manifests: AgentManifest[] = [
  { id: 'closedoff', displayName: '封闭化管理智能助手', directory: 'closedoff', category: '封闭化园区', description: '园区业务查询、车辆轨迹' },
  { id: 'blog', displayName: '博客智能体', directory: 'blog', category: '博客工作台', description: '写作、发布、图床与备份' },
]

/**
 * 只实现这两个模块实际用到的事件通道。
 *
 * 目录条目默认补上「智能体」分类：牛马大总管只把这一类插件当成可对话成员，本测试关心的
 * 是跨插件契约（群组的 Agent 能否被牛马大总管列成可调度成员），不是分类过滤本身。
 */
function fakeContext(executors: readonly unknown[], plugins: readonly unknown[] = []): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === BUTLER_EXECUTORS_EVENT) { for (const executor of executors) accept(executor); return }
        if (name === 'ecosystem/catalog') {
          for (const plugin of plugins) {
            const entry = plugin as { category?: string }
            accept({ protocol: 1, plugin: { ...entry, category: entry.category ?? 'agents' } })
          }
        }
      },
    },
  } as unknown as Context
}

/** 参与者替身：本测试只关心契约形状，不跑真实对话。 */
function participant(id: string): AgentParticipant {
  return {
    protocol: 1, id, displayName: id, description: '',
    assertAccess: () => {},
    run: async () => ({ status: 'completed', conversationId: 'c', text: '' }),
  } as unknown as AgentParticipant
}

const catalogEntry = (manifest: AgentManifest) => ({
  id: manifest.id,
  packageName: `dsh-${manifest.id}`,
  version: '1.0.0',
  displayName: manifest.displayName,
  description: manifest.description,
  entryPath: `/agents/${manifest.id}`,
  permissions: [`${manifest.id}:access`],
  tools: [],
})

describe('群组执行入口被牛马大总管接受', () => {
  const executors = manifests.map(manifest => executorFor(manifest, participant(manifest.id)))
  const ctx = fakeContext(executors, manifests.map(catalogEntry))

  it('牛马大总管能收集到两个执行入口', () => {
    const collected = collectExecutors(ctx)
    expect([...collected.keys()].sort()).toEqual(['blog', 'closedoff'])
  })

  it('牛马大总管能把两个 Agent 列成可调度成员', () => {
    const cards = listAgentCards(ctx)
    expect(cards.map(card => card.id).sort()).toEqual(['blog', 'closedoff'])
    // dispatchable=false 的成员不会进牛马大总管的派活名单，等于没接通。
    expect(cards.every(card => card.dispatchable)).toBe(true)
  })

  it('能力摘要进入卡片，牛马大总管据此选人', () => {
    const closedoff = listAgentCards(ctx).find(card => card.id === 'closedoff')
    expect(closedoff?.capabilities).toContain('封闭化园区')
    expect(closedoff?.capabilities).toContain('园区业务查询、车辆轨迹')
  })

  it('卡片上的显示信息来自清单，不是群组代写', () => {
    const blog = listAgentCards(ctx).find(card => card.id === 'blog')
    expect(blog?.displayName).toBe('博客智能体')
    expect(blog?.entryPath).toBe('/agents/blog')
  })

  it('协议版本不匹配时牛马大总管明确拒绝，而不是静默忽略', () => {
    // 静默忽略会让「插件装了但牛马大总管看不见」变成一个查不出原因的现象。
    const wrong = [{ ...executors[0]!, protocol: 2 }]
    expect(() => collectExecutors(fakeContext(wrong))).toThrow(/协议版本不兼容/u)
  })

  it('缺少 agentId 时牛马大总管明确拒绝', () => {
    const broken = [{ ...executors[0]!, agentId: '  ' }]
    expect(() => collectExecutors(fakeContext(broken))).toThrow(/缺少 agentId/u)
  })

  it('重复登记时牛马大总管明确拒绝', () => {
    const duplicated = [executors[0]!, executors[0]!]
    expect(() => collectExecutors(fakeContext(duplicated))).toThrow(/重复登记/u)
  })

  it('群组按清单登记，不会产生重复 agentId', () => {
    // 重复登记会让牛马大总管直接抛错、整个名单不可用，所以这里守住清单的 id 唯一性。
    const ids = executors.map(executor => executor.agentId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
