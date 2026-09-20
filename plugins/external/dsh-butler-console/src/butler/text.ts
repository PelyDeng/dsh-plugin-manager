/**
 * 文本工具（拆分 v2 批 2）：摘要指纹、内容文本化、截断与结果摘要。纯函数，零状态。
 */

import { createHash } from 'node:crypto'
import type { ButlerDispatchResult } from '../protocol.ts'

/** 请求指纹：把参与判定的字段压成一个稳定的摘要。 */
export function digestOf(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** 从助手消息里取可见文本。 */
export function textOf(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

/** 压平空白并限制长度。 */
export function clip(value: string, limit: number): string {
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  return trimmed.length > limit ? `${[...trimmed].slice(0, Math.max(1, limit - 1)).join('')}…` : trimmed
}

/**
 * 一条子任务**对用户展示的结论正文**——落库与实时事件共用这一份拼法。
 *
 * ## 为什么必须只有一份
 *
 * 这个位置原本是两份：`applyMemberResult` 落库时写 `正文 + 外部待办：理由`，而
 * `dispatchSubtask` 发事件时 `detail` 只发那句理由。用户在生产上直接看到了后果——
 * **同一条子任务，刷新前卡片里没有"外部待办"那一段，刷新后有了**。两份拼法必然漂移，
 * 所以合成一份，并由 `applyMemberResult` 把它**返回**给事件（调用方拿到的就是写进库的那个值，
 * 结构上不可能不一致）。
 *
 * @param result 成员交回的结论
 * @param limit 正文长度上限（`maxResultChars`）
 * @param emptyText 正文为空时的兜底话术（失败分支用；缺省给空串，由调用方决定要不要兜）
 */
export function subtaskResultText(result: ButlerDispatchResult, limit: number, emptyText = ''): string {
  const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
  if (result.status === 'external_pending' && reason !== '') {
    // 拼法与历史记录一致（`\n\n` 会被 `clip` 压成空格）：老记录读起来也是这个形状。
    return clip(`${result.summary}\n\n外部待办：${reason}`, limit)
  }
  const text = clip(result.summary, limit)
  return text === '' ? emptyText : text
}
