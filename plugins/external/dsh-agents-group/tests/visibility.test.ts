/**
 * 工具可见范围的测试。
 *
 * 规则本身很短（「本分类 + 通用集」），但有三条边界容易写错，而且写错之后**界面上看不出来**：
 * 漏了通用集，Agent 连天气都查不了；顺手放行未分类工具，限制形同虚设；拿别的 Agent 的工具，
 * 就是越权。所以逐条钉住。
 *
 * 另外守住一条职责边界：群组只算规则，**不**在这里施加限制 —— 宿主要求 restrict 落在 agent
 * 作用域里，插件级限制会波及包括牛马大总管在内的所有 Agent。
 */

import { describe, expect, it } from 'vitest'
import type { ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import { UNIVERSAL_TOOL_CATEGORY } from '@dsh-plugin-manager/plugin-kit'
import { allowedToolsFor, allowedToolsLookup } from '../src/visibility.ts'
import type { AgentManifest } from '../src/agents/registry.ts'

const tool = (name: string, category?: string): ToolDescriptor => ({
  name,
  description: '',
  parameters: {},
  permission: 'p',
  ...(category === undefined ? {} : { category }),
})

const closedoff: AgentManifest = {
  id: 'closedoff', displayName: '封闭化', directory: 'closedoff',
  category: '封闭化园区', description: '',
}
const blog: AgentManifest = {
  id: 'blog', displayName: '博客', directory: 'blog',
  category: '博客工作台', description: '',
}

const universal = [tool('common_weather', UNIVERSAL_TOOL_CATEGORY)]
const closedoffTools = [tool('closedoff_vehicle_track', '封闭化园区'), tool('closedoff_warning_page', '封闭化园区')]
const blogTools = [tool('blog_search_posts', '博客工作台')]
const legacy = [tool('legacy_query')]

describe('每个 Agent 的工具可见范围', () => {
  it('含自己的工具', () => {
    const allowed = allowedToolsFor(closedoff, universal, closedoffTools)
    expect(allowed).toContain('closedoff_vehicle_track')
    expect(allowed).toContain('closedoff_warning_page')
  })

  it('含通用集 —— 漏了它 Agent 连天气都查不了', () => {
    for (const manifest of [closedoff, blog]) {
      expect(allowedToolsFor(manifest, universal, []), `${manifest.id} 应能看到通用工具`).toContain('common_weather')
    }
  })

  it('不含其他 Agent 的专业工具 —— 这是限制的核心', () => {
    const closedoffAllowed = allowedToolsFor(closedoff, universal, closedoffTools)
    expect(closedoffAllowed.some(name => blogTools.some(t => t.name === name))).toBe(false)

    const blogAllowed = allowedToolsFor(blog, universal, blogTools)
    expect(blogAllowed.some(name => closedoffTools.some(t => t.name === name))).toBe(false)
  })

  it('未分类的工具不自动放行', () => {
    // 顺手放行会让限制形同虚设：任何老插件的工具都能被每个 Agent 调用。
    expect(allowedToolsFor(closedoff, universal, [...closedoffTools, ...legacy])).not.toContain('legacy_query')
  })

  it('Agent 不存在时给空清单', () => {
    // 空清单是安全的失败方向：拿不到工具总好过拿到不该有的。
    expect(allowedToolsFor(undefined, universal, closedoffTools)).toEqual([])
  })

  it('没有通用工具时只给自己的', () => {
    expect([...allowedToolsFor(closedoff, [], closedoffTools)].sort()).toEqual(['closedoff_vehicle_track', 'closedoff_warning_page'])
  })

  it('分类不同就互不可见，即使工具名相同', () => {
    // 同名不同分类不应互相放行；按名字猜归属是错的。
    const shared = [tool('shared_query', '博客工作台')]
    expect(allowedToolsFor(closedoff, [], shared)).toEqual([])
    expect(allowedToolsFor(blog, [], shared)).toEqual(['shared_query'])
  })
})

describe('按 id 惰性取值', () => {
  const manifests = [closedoff, blog]
  const descriptorsOf = (id: string) => id === 'closedoff' ? closedoffTools : id === 'blog' ? blogTools : []

  it('按 id 取到各自的清单', () => {
    const lookup = allowedToolsLookup(manifests, descriptorsOf, universal)
    expect(lookup('closedoff')).toContain('closedoff_vehicle_track')
    expect(lookup('blog')).toContain('blog_search_posts')
  })

  it('每次调用重新求值，不缓存装载期的结果', () => {
    // 子包在 dispatch 时才创建 Agent，那时通用工具才注册完毕；缓存会让通用工具漏掉。
    let extra: ToolDescriptor[] = []
    const lookup = allowedToolsLookup(manifests, id => id === 'closedoff' ? [...closedoffTools, ...extra] : [], [])
    expect(lookup('closedoff')).not.toContain('late_tool')
    extra = [tool('late_tool', '封闭化园区')]
    expect(lookup('closedoff')).toContain('late_tool')
  })

  it('未知 id 给空清单', () => {
    const lookup = allowedToolsLookup(manifests, descriptorsOf, universal)
    expect(lookup('未知')).toEqual([])
  })
})
