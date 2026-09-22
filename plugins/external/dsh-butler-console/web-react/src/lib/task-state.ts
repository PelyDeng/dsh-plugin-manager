/**
 * 任务/子任务状态的**单点真相**（评审 #12：此前三张表两套色——STATE_TEXT 长文案、
 * CARD_STATE_TEXT 短文案、statusColor 与 DISPATCH_TONE 语义互补不重合，「什么状态
 * 算什么色」没有单点答案）。
 *
 * 每个状态一条元数据：长文案（消息流/摘要卡）、短文案（调度卡紧凑格）、色调、是否有定论
 * （settled=秒数不再上涨、收尾判定都用它）。ActionCard 的 STATE_TEXT 是操作卡独立域，
 * 不并入本表（prepared/executing 是操作的生命周期，不是任务的状态）。
 */

export type StateTone = 'ok' | 'warn' | 'error' | 'idle'

export interface StateMeta {
  /** 长文案：消息流状态标签、摘要卡。 */
  text: string
  /** 短文案：调度卡紧凑格（与长文案不同才单列，例如 running=进行中/在干活）。 */
  short: string
  tone: StateTone
  /** 有定论：计时停止、收尾口径共用。 */
  settled: boolean
}

export const TASK_STATES: Readonly<Record<string, StateMeta>> = {
  queued: { text: '排队中', short: '排队', tone: 'idle', settled: false },
  dispatched: { text: '已收到', short: '已收到', tone: 'idle', settled: false },
  running: { text: '在干活', short: '进行中', tone: 'idle', settled: false },
  summarizing: { text: '在写总结', short: '在总结', tone: 'idle', settled: false },
  waiting_user: { text: '等你回话', short: '等你回话', tone: 'warn', settled: true },
  external_pending: { text: '待外部处理', short: '待外部处理', tone: 'warn', settled: true },
  succeeded: { text: '已完成', short: '已完成', tone: 'ok', settled: true },
  completed: { text: '已完成', short: '已完成', tone: 'ok', settled: true },
  partial: { text: '部分完成', short: '部分完成', tone: 'warn', settled: true },
  failed: { text: '失败', short: '失败', tone: 'error', settled: true },
  cancelled: { text: '已停止', short: '已停止', tone: 'error', settled: true },
}

const FALLBACK = (state: string): StateMeta => ({ text: state, short: state, tone: 'idle', settled: false })

function metaOf(state: string | undefined): StateMeta | undefined {
  if (state === undefined) return undefined
  return TASK_STATES[state]
}

/** 长文案（消息流/摘要卡/详情回放的兜底文案）。 */
export function stateText(state: string | undefined): string {
  return metaOf(state)?.text ?? String(state ?? '')
}

/** 短文案（调度卡紧凑格）。 */
export function cardStateText(state: string | undefined): string {
  return metaOf(state)?.short ?? String(state ?? '')
}

/** 有定论：到了这些状态计时不再上涨（waiting/external_pending 挂着也算）。 */
export function cardSettled(state: string | undefined): boolean {
  return metaOf(state)?.settled ?? false
}

/** 色调 → CSS 变量（消息流状态标签色与调度卡圆点同源）。 */
export function toneColor(tone: StateTone): string {
  if (tone === 'error') return 'var(--bt-error)'
  if (tone === 'warn') return 'var(--bt-warn)'
  if (tone === 'ok') return 'var(--bt-ok)'
  return 'var(--bt-ink-soft)'
}

/** 消息流状态标签色（原 entries.tsx 本地 statusColor 的语义）。 */
export function statusColor(state: string | undefined): string {
  return toneColor(metaOf(state)?.tone ?? 'idle')
}

/** 调度卡圆点色调（原 card-text.ts DISPATCH_TONE）。未登记状态回 'queued'——它同时是 CSS 类名（dot--queued）。 */
export function stateTone(state: string | undefined): 'ok' | 'warn' | 'error' | 'queued' {
  const tone = metaOf(state)?.tone ?? 'idle'
  return tone === 'idle' ? 'queued' : tone
}
