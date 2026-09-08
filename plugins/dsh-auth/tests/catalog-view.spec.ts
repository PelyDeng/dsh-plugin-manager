import { describe, expect, it } from 'vitest'
// Browser-native module is intentionally plain JavaScript and is tested as shipped.
// @ts-expect-error The static browser module has no TypeScript declaration file.
import { filterTools, pageTools, pageUsers, highlightParts, localEntry, toolDisplayName } from '../web/catalog-view.js'

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
