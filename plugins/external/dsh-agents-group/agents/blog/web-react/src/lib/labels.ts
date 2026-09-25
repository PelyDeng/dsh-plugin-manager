/**
 * 展示文案映射（旧 web/chat.js 内联字典的收拢；键=服务端工具名/状态值）。
 */
import type { TurnSummary } from './types.ts'

/** 博客工具名 → 中文标签（旧 chat.js toolLabel 字典）。 */
export const TOOL_LABELS: Record<string, string> = {
  blog_search_posts: '查询博客文章',
  blog_read_post: '读取文章',
  blog_list_drafts: '查询博客草稿',
  blog_select_draft: '选择写作文章',
  blog_propose: '保存候选稿',
  blog_web_search: '搜索资料',
  blog_web_fetch: '阅读网页',
  blog_publish_draft: '准备发布',
  blog_delete_post: '准备删除',
  blog_manage_list: '查询分类标签评论',
  blog_manage_get: '读取管理条目',
  blog_manage_change: '准备管理修改',
}

export function toolLabel(name: string | undefined): string {
  return TOOL_LABELS[name ?? ''] ?? '执行博客工具'
}

/** 工具/回合状态 → 中文（旧 chat.js statusLabel 字典）。 */
export const STATUS_LABELS: Record<string, string> = {
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  interrupted: '已中断',
}

export function statusLabel(status: string | undefined): string {
  return STATUS_LABELS[status ?? ''] ?? status ?? ''
}

/** Token 用量行（旧 usage() 的 rows 口径：恒显两项，其余有值才显示）。 */
export function usageRows(turn: TurnSummary): Array<[string, string]> {
  const u = (turn.usage ?? null) as Record<string, unknown> | null
  const rows: Array<[string, string]> = []
  const pick = (key: string): string | null =>
    u !== null && typeof u === 'object' && u[key] !== undefined ? Number(u[key]).toLocaleString() : null
  const uncached = pick('uncachedInputTokens')
  const output = pick('outputTokens')
  if (uncached !== null) rows.push(['未缓存输入', uncached])
  if (output !== null) rows.push(['输出', output])
  for (const [key, label] of [['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['reasoningTokens', '其中推理']] as const) {
    const value = pick(key)
    if (value !== null) rows.push([label, value])
  }
  return rows
}

/** Token 总量紧凑显示（旧 compactTokens：1.2K 形态）。 */
export function compactTokens(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

/** 毫秒 → 秒文案（旧 formatTime）。 */
export function formatMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} 秒` : '未提供'
}

/** http(s) 外链白名单（旧 url()：其它协议一律不给 a）。 */
export function safeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}
