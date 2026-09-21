/**
 * 调度卡文案与状态映射（自 web/modules/dcard.js 逐条迁移）。
 */
import { STATE_TEXT } from '../../lib/config.ts'

export const CARD_STATE_TEXT: Record<string, string> = {
  queued: '排队',
  dispatched: '已收到',
  running: '进行中',
  waiting_user: '等你回话',
  external_pending: '待外部处理',
  partial: '部分完成',
  succeeded: '已完成',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  summarizing: '在总结',
}

export function cardStateText(value: string | undefined): string {
  return CARD_STATE_TEXT[value ?? ''] ?? STATE_TEXT[value ?? ''] ?? String(value ?? '')
}

/** 有定论的状态：到了这些状态秒数不再往上走（waiting_user 也算——挂几小时还在跳是骗人）。 */
export function cardSettled(value: string | undefined): boolean {
  return ['succeeded', 'completed', 'failed', 'cancelled', 'external_pending', 'waiting_user', 'partial'].includes(value ?? '')
}

/** 结果区里还没有内容时的说明（不留空白框）。 */
export function emptySlotHint(value: string | undefined): string {
  if (value === 'queued' || value === undefined) return '还没开始，等前一步交回材料。'
  if (value === 'waiting_user') return '在等你回话。'
  if (value === 'external_pending') return '材料交回来了，还有事在别处办。'
  return '正在做，还没有可看的内容。'
}

/** 结果区标题：跟着选中成员的状态变。 */
export const CARD_RESULT_TITLE: Record<string, string> = {
  queued: '还没开始',
  dispatched: '正在做的事',
  running: '正在做的事',
  summarizing: '正在总结',
  succeeded: '交回的内容',
  completed: '交回的内容',
  external_pending: '交回的内容（还有事在外面办）',
  waiting_user: '等你回话',
  partial: '交回的部分',
  failed: '失败原因',
  cancelled: '已经停下',
}

/** 成员状态 → 面板小圆点配色。 */
export const DISPATCH_TONE: Record<string, string> = {
  succeeded: 'ok',
  completed: 'ok',
  failed: 'error',
  cancelled: 'error',
  waiting_user: 'warn',
  external_pending: 'warn',
}

/** 已过时间：有结束时刻定格，否则按当前时间走（与 formatElapsed 同一口径）。 */
export function cardElapsedText(since: number | undefined, until: number | undefined, now: number): string {
  if (typeof since !== 'number' || !Number.isFinite(since)) return ''
  const end = typeof until === 'number' && Number.isFinite(until) ? until : now
  const seconds = Math.max(0, Math.round((end - since) / 1000))
  if (!Number.isFinite(seconds)) return ''
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
