/**
 * 会话消息的分组投影（旧 web/chat-turns.js 的逐行为等价迁移，纯数据函数）。
 *
 * 语义（旧文件头注）：每条用户消息开启一个「回答回合」组；助手/工具/状态消息
 * 按回合归组，turn 号切换即开新组。管理操作卡按 requestId 插到对应用户消息之后；
 * 找不到归属请求的操作卡（旧历史）保持可见并标 unassociated。
 */
import type { AttachmentRef, ChatMessage, OperationRecord } from './types.ts'

/** chatTurns 产出的助手回合组（steps/statuses 是分组期聚合，tools 是工具行）。 */
export interface TurnGroup {
  id: string
  role: 'assistant'
  displayKey: string
  seq: number
  time: number
  turn?: unknown
  text: string
  reasoning: string
  reasoningSource: string | undefined
  tools: ChatMessage[]
  steps: ChatMessage[]
  statuses: string[]
  feedback: boolean
  forkCut?: number | null
  tail?: boolean
  interrupted?: boolean
  model?: string
  provider?: string
  attachments?: readonly AttachmentRef[]
}

/** 操作卡在时间线上的呈现单元。 */
export interface OperationCard {
  role: 'operation'
  id: string
  operation: OperationRecord
  /** 旧历史缺归属请求：保持可见，不并入新回合。 */
  unassociated?: boolean
}

/** 时间线上的一条：原始消息 / 回合组 / 操作卡。 */
export type DisplayMessage = ChatMessage | TurnGroup | OperationCard

export function isTurnGroup(message: DisplayMessage | undefined): message is TurnGroup {
  return message !== undefined && (message as TurnGroup).displayKey !== undefined && message.role === 'assistant'
}

export function isOperationCard(message: DisplayMessage | undefined): message is OperationCard {
  return message !== undefined && message.role === 'operation'
}

export function chatTurns(
  messages: readonly ChatMessage[],
  { busy = false, operations = [], requests = [] }: { busy?: boolean; operations?: readonly OperationRecord[]; requests?: readonly { id: string; userMessageId?: string | undefined }[] } = {},
): DisplayMessage[] {
  const result: Array<ChatMessage | TurnGroup> = []
  let group: TurnGroup | null = null
  let userId = 'legacy'
  let sequence = 0
  const start = (message: Partial<ChatMessage> & { turn?: unknown; time?: number }): TurnGroup => {
    const created = {
      ...message,
      id: message.id ?? `pending-${userId}`,
      role: 'assistant' as const,
      displayKey: `answer-${userId}-${sequence++}`,
      text: '',
      reasoning: '',
      reasoningSource: undefined,
      tools: [] as ChatMessage[],
      steps: [] as ChatMessage[],
      statuses: [] as string[],
      feedback: false,
    } as TurnGroup
    group = created
    result.push(created)
    return created
  }
  for (const message of messages) {
    if (message.role === 'user') {
      result.push(message)
      group = null
      userId = message.id
      continue
    }
    // TS 无法追踪 start() 闭包内的赋值：显式回写 group 再取局部引用。
    if (group === null || (message.turn !== undefined && group.turn !== undefined && message.turn !== group.turn)) group = start(message)
    const current: TurnGroup = group
    if (message.role === 'tool') {
      current.tools.push(message)
      continue
    }
    if (message.role === 'status') {
      current.statuses.push(message.text ?? '')
      continue
    }
    if (message.role !== 'assistant') continue
    current.steps.push(message)
    if (message.reasoning) {
      current.reasoning = message.reasoning
      current.reasoningSource = message.id
    }
    if (message.text || !current.text) {
      for (const key of ['id', 'text', 'time', 'seq', 'turn', 'feedback', 'forkCut', 'tail', 'model', 'provider', 'interrupted'] as const) {
        ;(current as unknown as Record<string, unknown>)[key] = (message as unknown as Record<string, unknown>)[key]
      }
    }
  }
  const last = messages.at(-1)
  // 回答进行中、最新消息是用户发言且分组投影还没给本轮开组：补一个 pending 组承接 live 段。
  if (busy && group === null && last?.role === 'user') start({ turn: last.turn, time: last.time })
  const requestByUser = new Map(requests.filter(request => request.userMessageId !== undefined).map(request => [request.userMessageId as string, request.id]))
  const pending = new Map<string, OperationCard[]>()
  const timeline: DisplayMessage[] = []
  for (const operation of operations) {
    const key = operation.requestId ?? ''
    const cards = pending.get(key) ?? []
    cards.push({ role: 'operation', id: operation.id, operation })
    pending.set(key, cards)
  }
  let requestId: string | undefined
  const flush = (): void => {
    if (requestId === undefined) return
    const cards = pending.get(requestId)
    if (cards !== undefined) timeline.push(...cards)
    pending.delete(requestId)
  }
  for (const message of result) {
    if (message.role === 'user') {
      flush()
      requestId = message.requestId ?? requestByUser.get(message.id)
    }
    timeline.push(message)
  }
  flush()
  return [...[...pending.values()].flat().map(card => ({ ...card, unassociated: true })), ...timeline]
}
