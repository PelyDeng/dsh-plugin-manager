import { describe, expect, it } from 'vitest'
// Browser-native module is intentionally plain JavaScript and is tested as shipped.
// @ts-expect-error The static browser module has no TypeScript declaration file.
import { filterTools, groupPluginsByCategory, groupToolsByCategory, pageTools, pageUsers, highlightParts, localEntry, toolCategory, toolDisplayName } from '../web/catalog-view.js'

const tools = Array.from({ length: 37 }, (_, index) => ({
  name: `demo_tool_${index}`, description: `中文工具说明 ${index}`,
  parameters: { type: 'object', properties: { [`field_${index}`]: { description: `参数描述 ${index}` } } },
}))

describe('tool catalog search and pagination', () => {
  it('displays localized titles while keeping codes searchable and old plugins compatible', () => {
    const named = { ...tools[0], displayName: ' 搜索文章 ' }
    expect(toolDisplayName(named)).toBe('搜索文章')
    expect(filterTools([named, tools[1]], '搜索文章')).toEqual([named])
    expect(filterTools([named, tools[1]], 'DEMO_TOOL_0')).toEqual([named])
    expect(toolDisplayName(tools[1])).toBe(tools[1]!.name)
    expect(toolDisplayName({ ...named, displayName: ' ' })).toBe(named.name)
  })

  it('splits real-sized catalogs into 15, 15, and 7 tools and clamps a changed search', () => {
    expect(pageTools(tools, '', 1).items).toHaveLength(15)
    expect(pageTools(tools, '', 2).items[0]).toBe(tools[15])
    expect(pageTools(tools, '', 3).items).toHaveLength(7)
    expect(pageTools(tools, '', 99).page).toBe(3)
    expect(pageTools(tools, 'field_36', 3)).toMatchObject({ items: [tools[36]], page: 1, pages: 1, total: 1 })
    expect(pageTools(tools, '不存在', 3)).toMatchObject({ items: [], page: 1, pages: 0, total: 0 })
  })

  it('finds case-insensitive names, Chinese descriptions, and nested parameter text', () => {
    expect(filterTools(tools, 'DEMO_TOOL_36')).toEqual([tools[36]])
    expect(filterTools(tools, '中文工具说明 36')).toEqual([tools[36]])
    expect(filterTools(tools, '参数描述 36')).toEqual([tools[36]])
    expect(filterTools([], '')).toEqual([])
  })

  it('highlights literal search terms without interpreting HTML or regular expressions', () => {
    expect(highlightParts('<img src=x> [x].* [X].*', '[x].*')).toEqual([
      { text: '<img src=x> ', match: false }, { text: '[x].*', match: true },
      { text: ' ', match: false }, { text: '[X].*', match: true },
    ])
    expect(highlightParts('中文参数中文', '中文')).toEqual([
      { text: '中文', match: true }, { text: '参数', match: false }, { text: '中文', match: true },
    ])
    expect(highlightParts('<script>alert(1)</script>', '')).toEqual([{ text: '<script>alert(1)</script>', match: false }])
  })

  it('keeps plugin and console entry links on the current origin', () => {
    expect(localEntry('/')).toBe('/')
    expect(localEntry('/demo')).toBe('/demo')
    for (const value of ['https://other.test', '//other.test', '/\\other.test', '/\n/other.test', undefined]) expect(localEntry(value)).toBeUndefined()
  })
})


it('paginates user cards and searches identities or localized roles', () => {
  const users = Array.from({ length: 14 }, (_, index) => ({ id: `id-${index}`, username: `person-${index}`, role: index === 0 ? 'admin' : 'user' }))
  expect(pageUsers(users, '', 1).items).toHaveLength(6)
  expect(pageUsers(users, '', 99)).toMatchObject({ page: 3, pages: 3, total: 14 })
  expect(pageUsers(users, '', 3).items).toHaveLength(2)
  expect(pageUsers(users, '管理员').items.map((user: { id: string }) => user.id)).toEqual(['id-0'])
  expect(pageUsers(users, 'PERSON-13').items.map((user: { id: string }) => user.id)).toEqual(['id-13'])
  expect(pageUsers(users, 'missing', 3)).toMatchObject({ page: 1, pages: 0, total: 0, items: [] })
})

describe('工具分类分组', () => {
  /** 浏览器模块是纯 JavaScript，测试夹具需要显式类型，否则回调参数会隐式 any。 */
  const categorized: { name: string; category?: string }[] = [
    { name: 'a', category: '封闭化园区' },
    { name: 'b', category: '博客工作台' },
    { name: 'c', category: '通用工具' },
    { name: 'd', category: '封闭化园区' },
  ]
  /** 该导入没有类型声明，函数返回值是 any；这里补上结构，供断言使用。 */
  const groups = (input: readonly { name: string; category?: string }[]): { label: string; tools: { name: string }[] }[] =>
    groupToolsByCategory(input) as { label: string; tools: { name: string }[] }[]

  it('按标签分组，组内保持原顺序', () => {
    const result = groups(categorized)
    expect(result.map(group => group.label)).toEqual(['封闭化园区', '博客工作台', '通用工具'])
    expect(result[0]!.tools.map(tool => tool.name)).toEqual(['a', 'd'])
  })

  it('未分类的工具归入「未分类」并排在最后', () => {
    const result = groups([{ name: 'x' }, { name: 'a', category: '甲' }, { name: 'y', category: '  ' }])
    expect(result.map(group => group.label)).toEqual(['甲', '未分类'])
    expect(result[1]!.tools.map(tool => tool.name)).toEqual(['x', 'y'])
  })

  it('全部未分类时只有一个分组，顺序不变', () => {
    // 老插件不填分类也要照常展示，不能因此打乱顺序或凭空多出分组。
    const result = groups(tools)
    expect(result).toHaveLength(1)
    expect(result[0]!.label).toBe('未分类')
    expect(result[0]!.tools).toEqual(tools)
  })

  it('空列表得到空分组', () => {
    expect(groups([])).toEqual([])
  })

  it('分类标签去除首尾空白，空白视为未分类', () => {
    expect(toolCategory({ category: '  甲  ' })).toBe('甲')
    expect(toolCategory({ category: '   ' })).toBeUndefined()
    expect(toolCategory({})).toBeUndefined()
    expect(toolCategory({ category: 42 })).toBeUndefined()
  })
})

describe('plugin catalog grouping', () => {
  const rows = (...items: readonly (readonly [string, string | undefined])[]) =>
    groupPluginsByCategory(items.map(([id, category]) => ({ id, category }))).map(group => ({ label: group.label, ids: group.plugins.map(plugin => plugin.id) }))

  it('按固定顺序展示四个分类：系统默认、通用/工具、智能体、网页服务', () => {
    // 输入顺序刻意打乱，输出顺序必须由分类决定，不随目录返回顺序变化。
    expect(rows(['butler', 'web-services'], ['example', 'agents'], ['tools', 'universal-tools'], ['auth', 'system-default'], ['blog', 'agents'])).toEqual([
      { label: '系统默认', ids: ['auth'] },
      { label: '通用/工具', ids: ['tools'] },
      { label: '智能体', ids: ['example', 'blog'] },
      { label: '网页服务', ids: ['butler'] },
    ])
  })

  it('未知分类排在已知分类之后，未声明分类排最后', () => {
    expect(rows(['x', 'unknown-thing'], ['auth', 'system-default'], ['legacy', undefined], ['y', 'another'])).toEqual([
      { label: '系统默认', ids: ['auth'] },
      { label: 'unknown-thing', ids: ['x'] },
      { label: 'another', ids: ['y'] },
      { label: '未分类', ids: ['legacy'] },
    ])
  })

  it('空白分类视为未分类；空分类不产生标题', () => {
    expect(rows(['a', '   '], ['b', ''])).toEqual([{ label: '未分类', ids: ['a', 'b'] }])
    expect(groupPluginsByCategory([])).toEqual([])
  })

  it('分组不改变组内原有顺序，搜索后仍保持稳定', () => {
    const plugins = [{ id: 'm1', category: 'agents' }, { id: 'm2', category: 'agents' }, { id: 'a1', category: 'system-default' }]
    expect(groupPluginsByCategory(plugins).map(group => group.plugins.map(plugin => plugin.id))).toEqual([['a1'], ['m1', 'm2']])
    // 搜索收窄后再分组，同组内相对顺序保持不变。
    expect(groupPluginsByCategory(plugins.filter(plugin => plugin.id !== 'm1')).map(group => group.plugins.map(plugin => plugin.id))).toEqual([['a1'], ['m2']])
  })
})
