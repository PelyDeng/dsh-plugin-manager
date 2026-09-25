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
  proposal?: Proposal | undefined
}

/**
 * 管理操作卡（chat.ts operationCards 投影；批 2b 接管确认/取消交互）。
 * 字段来自 app.preview(op) 的展开：mode/status 之外，publish 带 after/before 与
 * source、delete 带 deletedArticles、manage 带 management/impact（managementSummary
 * 消费）；hasSavedDraft 只在 publish+prepared 场景出现。
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
  source?: string | undefined
  hasSavedDraft?: boolean | undefined
  after?: { title?: string; text?: string; tags?: string[]; categories?: number[]; allowComment?: boolean } | undefined
  before?: { title?: string; text?: string } | undefined
  deletedArticles?: readonly { title: string; type: string; cid: number }[] | undefined
  management?: { operation?: string; kind?: string; id?: number; fields?: Record<string, unknown> } | undefined
  impact?: { relatedCount?: number; childCategories?: number; note?: string; defaultCategory?: boolean } | undefined
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
  partial?: boolean | undefined
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

// ── 批 2b：评价、文章工作台与管理域 ────────────────────────────────────────

/** 一条回答的评价（chat-feedback list 投影行；version 是乐观并发版本）。 */
export interface FeedbackEntry {
  messageId: string
  rating: 'positive' | 'negative'
  note?: string | undefined
  version: number
}

/**
 * chat-feedback 的响应信封：list 时 value.items 是全部评价行；put/delete 时
 * value 是单条评价（absent=已撤销）。ok=false 时 error.code 分流（旧 checkFeedback）。
 */
export type FeedbackResult =
  | { ok: true; value: FeedbackEntry & { absent?: boolean; items?: readonly FeedbackEntry[] } }
  | { ok: false; error: { code: string; current?: FeedbackEntry | null; message?: string } }

/** 文章/草稿（src/storage 投影；页面读写这些字段）。 */
export interface BlogDraft {
  id: string
  title: string
  text: string
  slug: string
  format: string
  tags: string[]
  categories: number[]
  allowComment?: boolean | undefined
  revision: number
  blogNative?: boolean | undefined
  proposal?: Proposal | null | undefined
  remote?: {
    deleted?: boolean | undefined
    published?: { cid: number } | null | undefined
    savedDraft?: { cid: number } | null | undefined
  } | undefined
}

/** 候选稿（AI 提出的修改建议；apply/discard/prepare 按 id+revision 消费）。 */
export interface Proposal {
  id: string
  createdAt: number
  baseRevision: number
  fields: {
    title: string
    text: string
    tags: string[]
    categories: number[]
    allowComment?: boolean | undefined
  }
  before?: { format?: string | undefined } | undefined
  sources?: readonly SourceRef[] | undefined
}

/** 文章列表行（blog.list 投影）。 */
export interface ArticleListItem {
  cid: number
  title: string
  hasPublished?: boolean | undefined
  hasSavedDraft?: boolean | undefined
}

/** 写作任务（jobs 投影；queued/running 期间轮询）。 */
export interface WritingJob {
  id: string
  status: string
  text: string
  thinking?: string | undefined
  error?: { message: string } | undefined
  input: { instruction: string; research: boolean }
  sources?: readonly SourceRef[] | undefined
  proposalId?: string | undefined
}

/** 发布/同步记录行（operations 投影）。 */
export interface OperationLogRow {
  id: string
  status: string
  mode: string
  url?: string | null | undefined
  createdAt: number
}

/** 附件解析内容（attachment-content 投影；units 是提取出的可读单元）。 */
export interface AttachmentContent {
  name: string
  kind: string
  unit: string
  totalUnits: number
  parsedUnits: number
  characters: number
  partial: boolean
  message?: string | undefined
  units?: readonly { number: number; text: string }[] | undefined
  range?: { from: number; to: number } | null | undefined
}

/** /metadata（博客 status）的分类段（文章设置与管理弹窗共用）。 */
export interface BlogCategory {
  id: number
  name: string
}

/** manage-list 的评论行。 */
export interface CommentItem {
  id: number
  cid: number
  author: string
  text: string
  status?: string | undefined
  parent?: number | undefined
}

/** 管理确认弹窗的 preview（manage-prepare 产出）。 */
export interface ManagePrepareResult {
  id: string
  title: string
  nonce?: string | undefined
  status?: string | undefined
  management?: { operation?: string; kind?: string; id?: number; fields?: Record<string, unknown> }
  impact?: { relatedCount?: number; childCategories?: number; note?: string; defaultCategory?: boolean }
}
