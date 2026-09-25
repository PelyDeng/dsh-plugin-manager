/**
 * 历史对话侧栏的纯函数面（旧 web/conversation-history.js 的 React 等价，
 * closedoff 批 1b conversation-export.ts 同口径）。
 *
 * 只含数据变换与常量：分组、行可见性、导出 Markdown、文件名消毒、收起状态键。
 * 组件与接口层不在这里。
 */
import type { ChatListItem } from './types.ts'

/** 历史对话列表里只显示打得开的会话行（旧 conversationRowVisible 同口径）。
 *
 * `pending`/`failed`/`legacy` 是死行（点开 404、再删也 404）；`busy` 是运行时
 * 现算状态必须留下；`state` 缺失按可显示处理（升级不同步时不清空整个列表）。
 */
export function conversationRowVisible(item: ChatListItem): boolean {
  return item.state === undefined || item.state === 'ready' || item.state === 'busy'
}

/** 时间分组标题（旧 historyGroup：置顶/今天/昨天/7 天内/30 天内/更早）。 */
export function historyGroup(item: ChatListItem, now = Date.now()): string {
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

/** /chat-history 的最小读取形状（导出只消费 role/text；text 显式含 undefined，
 * 与 ChatMessage 在 exactOptionalPropertyTypes 下兼容）。 */
export interface ExportableMessage {
  role: string
  text?: string | undefined
}

/** 一段对话 → Markdown 文档（旧 conversationMarkdown 口径：标题 + 问答分段）。 */
export function conversationMarkdown(title: string, messages: readonly ExportableMessage[]): string {
  const heading = `# ${String(title || '对话记录').replace(/[\r\n]/g, ' ')}\n\n`
  const body = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && (m.text ?? '').trim() !== '')
    .map(m => `## ${m.role === 'user' ? '我' : '助手'}\n\n${m.text}`)
    .join('\n\n---\n\n')
  return `${heading}${body}\n`
}

/** 导出文件名消毒（旧 download.onclick 口径：单会话用标题，多会话用「对话记录」）。 */
export function exportFileName(titles: readonly string[]): string {
  const name = titles.length === 1 ? titles[0] ?? '' : '对话记录'
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60)
  return `${safe === '' ? '对话记录' : safe}.md`
}

/**
 * 收起状态的 localStorage 键（键沿用纪律：旧 web/chat.js 实际传入
 * `storageKey:'blog-history:'+identity.userId`——conversation-history.js 里的
 * `'chat-history'` 只是未采用的默认参数，生产键一直带用户域，这里保持一致）。
 */
export function historyStorageKey(userId: string): string {
  return `blog-history:${userId}`
}

/** 收起状态值（旧 remember 口径：'collapsed'/'expanded'，格式不变）。 */
export type HistoryExpandedValue = 'collapsed' | 'expanded'

/** 读收起状态（存储不可用/无记录时返回 null，由调用方按默认展开处理）。 */
export function readHistoryExpanded(userId: string): HistoryExpandedValue | null {
  try {
    const raw = window.localStorage.getItem(historyStorageKey(userId))
    return raw === 'collapsed' || raw === 'expanded' ? raw : null
  } catch {
    return null
  }
}

/** 写收起状态（旧 remember：只在桌面端写，存储异常静默——侧栏开合不受影响）。 */
export function writeHistoryExpanded(userId: string, value: HistoryExpandedValue): void {
  try {
    window.localStorage.setItem(historyStorageKey(userId), value)
  } catch {
    // 隐私模式等存储不可用场景：状态只在本次会话内生效（旧码 try/catch 同口径）。
  }
}

/** 移动端判定（旧 matchMedia('(max-width: 960px)') 同一断点）。 */
export const MOBILE_QUERY = '(max-width: 960px)'

export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
}
