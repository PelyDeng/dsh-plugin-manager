/**
 * 服务端 SSE 事件的类型与回合游标口径（方案 §3.3 turn/stream store 的事件面）。
 *
 * 服务端事件是宽松 JSON：这里只给「实际会发的形状」一个类型名，字段全部可选放宽
 * （运行中的字段增补不破坏前端）。游标组（lastSeq/lastRunId/lastRunTaskId）、streaming/abort
 * 与 viewToken 是同一条 SSE 生命周期的三个面，状态放在 stores/turn.ts。
 */

export interface TurnEvent {
  type: string
  seq?: number
  runId?: string
  taskId?: string
  conversationId?: string
  /** user/chat/chat_delta 的正文。 */
  text?: string
  delta?: string
  thinking?: string
  time?: number
  /** subtask 事件。 */
  id?: string
  agentId?: string
  state?: string
  detail?: string | null
  result?: string | null
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
  phase?: string
  tool?: string
  /** waiting_user 的卡面问题。 */
  question?: string
  artifacts?: unknown[]
  actions?: unknown[]
  /** input 事件。 */
  source?: string
  version?: number
  /** error 事件的文案。 */
  message?: string
  [key: string]: unknown
}

/** 提交幂等身份：与旧前端同一格式（state.js newConversationId）。 */
export function newConversationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80
  const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('')
  return `butler-web-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function rememberConversation(id: string): void {
  try { localStorage.setItem('butler.conversationId', id) } catch { /* 隐私模式下忽略。 */ }
}

export function recallConversation(): string | null {
  try { return localStorage.getItem('butler.conversationId') } catch { return null /* 隐私模式下当作没有。 */ }
}
