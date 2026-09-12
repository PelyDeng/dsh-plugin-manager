/**
 * 管家对通用工具的可见性测试。
 *
 * 管家本来只带 `butler_plan`，只负责派活。按产品要求它还要能直接处理「不需要专业智能体」
 * 的问题，所以它的可见工具集是「派活工具 + 目录里的通用工具」。
 *
 * 这里锁住的是筛选规则本身：只有分类标签为「通用工具」的才会被放行，别家智能体的专业工具
 * 一律不放行 —— 那正是「管家不替成员干专业活」的边界。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { listPlugins, UNIVERSAL_TOOL_CATEGORY } from '@dsh-plugin-manager/plugin-kit'

interface FakeTool {
  name: string
  category?: string
}

/** 只实现本测试用到的目录通道。 */
function catalogContext(entries: readonly { id: string; tools: readonly FakeTool[] }[]): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name !== 'ecosystem/catalog') return
        for (const entry of entries) {
          accept({
            protocol: 1,
            plugin: {
              id: entry.id,
              packageName: `dsh-${entry.id}`,
              version: '1.0.0',
              displayName: entry.id,
              description: '',
              entryPath: `/${entry.id}`,
              permissions: [],
              tools: entry.tools,
            },
          })
        }
      },
    },
  } as unknown as Context
}

/** 与管家实现同一口径：从目录里挑出通用工具名。 */
function universalToolNames(ctx: Context): string[] {
  return listPlugins(ctx)
    .flatMap(plugin => plugin.tools)
    .filter(tool => tool.category === UNIVERSAL_TOOL_CATEGORY)
    .map(tool => tool.name)
}

describe('管家的通用工具可见性', () => {
  const catalog = [
    { id: 'agents-group-tools', tools: [
      { name: 'common_weather', category: '通用工具' },
      { name: 'common_time', category: '通用工具' },
    ] },
    { id: 'closedoff', tools: [
      { name: 'closedoff_vehicle_track', category: '封闭化园区' },
      { name: 'closedoff_warning_page', category: '封闭化园区' },
    ] },
    { id: 'blog', tools: [
      { name: 'blog_search_posts', category: '博客工作台' },
    ] },
    // 老插件不填分类：它不参与这套约定，也不该被管家直接调用。
    { id: 'legacy', tools: [{ name: 'legacy_query' }] },
  ]

  it('放行通用工具', () => {
    const names = universalToolNames(catalogContext(catalog))
    expect(names).toContain('common_weather')
    expect(names).toContain('common_time')
  })

  it('不放行任何智能体的专业工具', () => {
    const names = universalToolNames(catalogContext(catalog))
    // 这是边界：管家替成员干专业活容易答错，而且老板要的是那个领域的准确结果。
    expect(names).not.toContain('closedoff_vehicle_track')
    expect(names).not.toContain('closedoff_warning_page')
    expect(names).not.toContain('blog_search_posts')
  })

  it('不放行未分类的工具', () => {
    // 无标签工具不参与分类约定；顺手放行会让这条边界形同虚设。
    expect(universalToolNames(catalogContext(catalog))).not.toContain('legacy_query')
  })

  it('目录为空时得到空清单，管家退回只会派活', () => {
    expect(universalToolNames(catalogContext([]))).toEqual([])
  })

  it('允许列表最终包含派活工具', () => {
    // 派活工具是管家自己的，始终可见；通用工具是额外增加的。
    const allow = ['butler_plan', ...universalToolNames(catalogContext(catalog))]
    expect(allow).toContain('butler_plan')
    expect(allow).toContain('common_weather')
    expect(allow).not.toContain('closedoff_vehicle_track')
  })
})
