/**
 * 历史会话面板的纯函数面（旧 web/conversation-history.js 的
 * conversationRowVisible + historyGroup；blog 侧 lib/history.ts 同口径）。
 *
 * 只含数据变换：行可见性与时间分组。组件（ConversationPanel）与接口层不在这里。
 */
import type { ConversationItem } from './types.ts'

/** 列表里只显示打得开的会话行（旧 conversationRowVisible：busy 必须保留）。
 *
 * `pending`/`failed`/`legacy` 是死行（点开 404、再删也 404）；`busy` 是运行时
 * 现算状态必须留下；`state` 缺失按可显示处理（服务端比页面旧时不清空整个列表）。
 */
export function conversationRowVisible(item: ConversationItem): boolean {
  return item.state === undefined || item.state === 'ready' || item.state === 'busy'
}

/** 按最近活动时间分组（旧 historyGroup 口径：置顶优先，其余按自然日差）。 */
export function historyGroup(item: ConversationItem, now: number): string {
  if (item.pinned === true) return '置顶'
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const updated = new Date(item.updatedAt)
  updated.setHours(0, 0, 0, 0)
  const age = Math.floor((day.getTime() - updated.getTime()) / 86400000)
  if (age <= 0) return '今天'
  if (age === 1) return '昨天'
  if (age < 7) return '7 天内'
  if (age < 30) return '30 天内'
  return '更早'
}
