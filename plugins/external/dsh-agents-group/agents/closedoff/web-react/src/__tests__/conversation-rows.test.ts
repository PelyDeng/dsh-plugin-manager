/**
 * 历史会话面板行过滤与分组的等价单测（删码评审 B F2：旧
 * tests/conversation-history.test.mjs 的判据用例随 vanilla 前端删除，React 侧
 * 的实现在 lib/conversation-rows.ts，这里补回护栏）。
 *
 * 为什么值得单独测：`/conversations` 回来的行里有 `pending`/`failed`/`legacy`
 * 三种点开会 404、在本页再删也 404 的死行；而 `busy`（正在回答）必须留下——
 * 用 `state === 'ready'` 一刀切会让正在回答的那条会话从列表里凭空消失。
 */
import { describe, expect, it } from 'vitest'

const { conversationRowVisible, historyGroup } = await import('../lib/conversation-rows.ts')

describe('死行过滤（conversationRowVisible）', () => {
  it('只有 ready / busy / 未提供 state 算可显示（旧码判据用例同口径）', () => {
    for (const state of ['ready', 'busy']) expect(conversationRowVisible({ id: 'a', title: 'x', updatedAt: 0, state }), state).toBe(true)
    for (const state of ['pending', 'failed', 'legacy']) expect(conversationRowVisible({ id: 'a', title: 'x', updatedAt: 0, state }), state).toBe(false)
    // 服务端比页面旧（没有 state 字段）时不能把整份列表清空。
    expect(conversationRowVisible({ id: 'a', title: 'x', updatedAt: 0 })).toBe(true)
  })
})

describe('按最近活动时间分组（historyGroup）', () => {
  // 固定「今天」：2026-09-26 12:00（本地时区）。
  const NOW = new Date(2026, 8, 26, 12, 0, 0).getTime()
  const item = (updatedAt: number, pinned?: boolean): { id: string; title: string; updatedAt: number; pinned?: boolean } =>
    ({ id: 'a', title: 'x', updatedAt, ...(pinned === undefined ? {} : { pinned }) })

  it('置顶行优先于自然日差', () => {
    expect(historyGroup(item(new Date(2020, 0, 1).getTime(), true), NOW)).toBe('置顶')
  })

  it('自然日差映射今天/昨天/7 天内/30 天内/更早', () => {
    expect(historyGroup(item(new Date(2026, 8, 26, 0, 0, 1).getTime()), NOW)).toBe('今天')
    expect(historyGroup(item(new Date(2026, 8, 25, 23, 59).getTime()), NOW)).toBe('昨天')
    expect(historyGroup(item(new Date(2026, 8, 20).getTime()), NOW)).toBe('7 天内')
    expect(historyGroup(item(new Date(2026, 8, 19).getTime()), NOW)).toBe('30 天内')
    // 距今 29 天仍在 30 天内；恰好 30 天起归「更早」。
    expect(historyGroup(item(new Date(2026, 7, 28).getTime()), NOW)).toBe('30 天内')
    expect(historyGroup(item(new Date(2026, 7, 27).getTime()), NOW)).toBe('更早')
    expect(historyGroup(item(new Date(2020, 0, 1).getTime()), NOW)).toBe('更早')
  })
})
