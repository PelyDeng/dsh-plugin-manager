/**
 * blog 页面契约类型（形状对齐 src/index.ts 的 /api 各 action 与 /chat-events 的
 * 服务端产出；投影层字段语义见 src/chat-history.ts）。
 *
 * 刻意保持「开放形状」口径：服务端投影是异构联合（chat-history.ts 的
 * ProjectedMessage 系），页面只读自己消费的字段，多余字段原样透传——升级不
 * 同步时少一个字段不该清空整个面板（旧页面 conversationRowVisible 的同款宽容）。
 */

/** 本轮实时输出（src/chat.ts 的 LiveOutput：正文与思考各一条通道）。 */
export interface LiveOutput {
  text: string
  reasoning: string
}

/** 会话元信息（chat.ts publicConversation 的返回形状）。 */
export interface ConversationInfo {
  id: string
  title: string
  updatedAt: number
  ready: boolean
  parent: string | null
  pinned: boolean
}

/** 附件在消息/资料行上的引用形状。 */
export interface AttachmentRef {
  id: string
  name?: string | undefined
  kind?: string | undefined
  range?: { from: number; to: number } | null | undefined
  partial?: boolean | undefined
}

/**
 * 会话投影里的一条消息。role 判别：user / assistant / tool / status；assistant
 * 的完整字段见 chat-history.ts ProjectedMessage（开放读取，不逐字段收窄）。
 */
export interface ChatMessage {
  id: string
  role: string
  seq: number
  time: number
  turn?: unknown
  text?: string | undefined
  reasoning?: string | undefined
  name?: string | undefined
  status?: string | undefined
  interrupted?: boolean | undefined
  feedback?: boolean | undefined
  tail?: boolean | undefined
  forkCut?: number | null | undefined
  requestId?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  attachments?: readonly AttachmentRef[] | undefined
  /** chatTurns 分组投影的派生字段（运行时步骤与状态行）。 */
  steps?: readonly ChatMessage[] | undefined
  statuses?: readonly string[] | undefined
}

/** 一轮对话的回合摘要（chat-history.ts ProjectedTurnSummary）。 */
export interface TurnSummary {
  turn: unknown
  startSeq: number
  startedAt: number
  status?: string | undefined
  usage: unknown
  runMs: number | null
  ttftMs: number | null
  tokensPerSecond: number | null
  attempts: number
  cut: number | null
  endedAt?: number | undefined
}

/** 一轮对话请求的记录（chat.ts history 的 requests 投影）。 */
export interface HistoryRequest {
  id: string
  conversationId: string
  status: string
  message?: string | undefined
  createdAt: number
  userMessageId?: string | undefined
  sources?: readonly SourceRef[] | undefined
}

/** 联网查证的一条来源。 */
export interface SourceRef {
  url: string
  title?: string | undefined
  fetched?: boolean | undefined
}

/** 文章候选卡（dsh_turn_results 投影；点击进入文章视图——批 2b 消费）。 */
export interface ChatResult {
  id: string
  draftId: string
  title?: string | undefined
  revision: number
  proposal?: { fields: { title: string; text: string } } | undefined
}

/**
 * 管理操作卡（chat.ts operationCards 投影）。
 * 批 2a 只登记形状（消息流里以占位行呈现确认面，批 2b 接管交互）。
 */
export interface OperationRecord {
  id: string
  mode: string
  title: string
  status: string
  requestId?: string | undefined
  canConfirm?: boolean | undefined
  nonce?: string | null | undefined
  result?: { cid: number | null; url: string | null } | undefined
}

/** chat-history 的完整产出（GET /api action=chat-history 与 snapshot.value 同形）。 */
export interface ChatHistoryResult {
  conversation: ConversationInfo
  messages: readonly ChatMessage[]
  turns: readonly TurnSummary[]
  busy: boolean
  live: LiveOutput | null
  requests: readonly HistoryRequest[]
  results: readonly ChatResult[]
  operations: readonly OperationRecord[]
}

/** 会话列表行（chat-store.ts ChatListItem）。 */
export interface ChatListItem {
  id: string
  title: string
  updatedAt: number
  /** ready/busy 可打开；pending/failed/legacy 是死行（旧页面同口径过滤）。 */
  state?: string | undefined
  pinned?: boolean | undefined
}

/** chat-list 的分页响应。 */
export interface ConversationPage {
  items: readonly ChatListItem[]
  nextOffset: number | null
}

/** 模型选择（provider + model）。 */
export interface ModelSelection {
  provider: string
  model: string
}

/** chat-models 的目录响应（chat.ts models 的返回形状）。 */
export interface ModelCatalog {
  groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]
  failures: readonly unknown[]
  selected: ModelSelection | null
  default: ModelSelection | null
}

/** attachments 的资料行（attachments.ts 投影；页面只读这些字段）。 */
export interface AttachmentItem {
  id: string
  name: string
  kind: string
  status: string
  selected: boolean
  version?: number | undefined
  range?: { from: number; to: number } | null | undefined
  unit?: string | undefined
  message?: string | undefined
}

/** /identity 的响应（src/index.ts identity 端点）。 */
export interface Identity {
  userId: string
  version: string
  backupAdmin: boolean
  maxImageBytes: number
  blogUrl: string
}

/** chat-send 的响应（chat.ts send 返回 { model: ... }；页面只消费 model）。 */
export interface SendResult {
  model?: ModelSelection | null | undefined
}

/** chat-events 的一条消息（服务端广播；ping 是 1s 心跳）。 */
export type StreamMessage =
  | { type: 'live'; live: LiveOutput }
  | { type: 'snapshot'; value: ChatHistoryResult }
  | { type: 'changed' }
  | { type: 'ping' }
