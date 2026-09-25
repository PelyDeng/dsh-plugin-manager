/**
 * 业务接口层（旧 web/app.js request/api 的 React 等价）。
 *
 * 形态照旧：全部业务动作走 POST /api 的 {action,args} 信封；错误体优先用服务端
 * error/message 文案。blog 旧页面没有请求前的身份复检（与 closedoff 的
 * businessFetch 不同构），401 由错误体文案透出——保持等价，不新增机制。
 */
import { basePath } from './config.ts'
import type {
  ArticleListItem,
  AttachmentContent,
  AttachmentItem,
  BlogCategory,
  BlogDraft,
  ChatHistoryResult,
  ConversationInfo,
  ConversationPage,
  FeedbackEntry,
  FeedbackResult,
  Identity,
  ManagePrepareResult,
  ModelCatalog,
  ModelSelection,
  OperationLogRow,
  SendResult,
  WritingJob,
} from './types.ts'

/** 一次接口调用失败（错误体里带服务端 error/message 时优先用）。 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(basePath(path), { credentials: 'same-origin', ...options })
  } catch (error) {
    throw error instanceof Error ? error : new Error('网络异常，请稍后重试')
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error('服务返回异常，请检查登录状态')
  }
  if (!response.ok) {
    const payload = data as { error?: unknown; message?: unknown }
    const message = typeof payload?.error === 'string' && payload.error !== ''
      ? payload.error
      : typeof payload?.message === 'string' && payload.message !== ''
        ? payload.message
        : `请求失败（${response.status}）`
    throw new ApiError(response.status, message)
  }
  return data as T
}

/** POST /api 的 action 信封（旧 api() 等价）。 */
export function callAction<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  return request<T>('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }),
  })
}

export const api = {
  identity: (): Promise<Identity> => request<Identity>('/identity'),
  /** 全量历史重拉（订阅-快照模型的 snapshot/changed 统一走这里）。 */
  history: (conversationId: string): Promise<ChatHistoryResult> =>
    callAction<ChatHistoryResult>('chat-history', { conversationId }),
  list: (offset: number, query: string): Promise<ConversationPage> =>
    callAction<ConversationPage>('chat-list', { offset, query }),
  /** 模型目录：无会话上下文时 conversationId=null（旧码把 null 原样传给服务端）。 */
  models: (conversationId: string | null): Promise<ModelCatalog> =>
    callAction<ModelCatalog>('chat-models', { conversationId }),
  /** 会话操作（重命名/置顶/删除；历史抽屉消费）。 */
  update: (args: { operation: string; ids: string[]; title?: string; pinned?: boolean }): Promise<unknown> =>
    callAction('chat-update', args),
  create: (requestId: string): Promise<ConversationInfo> => callAction<ConversationInfo>('chat-create', { requestId }),
  send: (input: {
    conversationId: string
    text: string
    research: boolean
    attachments: Array<{ id: string; version?: number; range?: { from: number; to: number } | null }>
    modelSelection?: ModelSelection
    retryFrom?: string
    /** 幂等键（同输入复用同一 id；chat-controller 的 pending 指纹机制产出）。 */
    requestId?: string
  }): Promise<SendResult> => callAction<SendResult>('chat-send', input),
  stop: (conversationId: string): Promise<unknown> => callAction('chat-stop', { conversationId }),
  imageCapability: (conversationId: string, modelSelection?: ModelSelection): Promise<{ message: string; available: boolean; currentSupportsImages: boolean }> =>
    callAction('chat-image-capability', { conversationId, ...(modelSelection === undefined ? {} : { modelSelection }) }),
  attachments: (draftId: string): Promise<AttachmentItem[]> => callAction<AttachmentItem[]>('attachments', { draftId }),
  attachmentSelect: (args: { draftId: string; id: string; selected: boolean; range?: { from: number; to: number } | null }): Promise<unknown> =>
    callAction('attachment-select', args),
  attachmentRemove: (draftId: string, id: string): Promise<unknown> => callAction('attachment-remove', { draftId, id }),
  /** 附件解析内容（旧 previewFile/viewAttachment 的 attachment-content）。 */
  attachmentContent: (draftId: string, id: string): Promise<AttachmentContent> => callAction<AttachmentContent>('attachment-content', { draftId, id }),

  // ── 批 2b：评价、分支与操作卡 ──────────────────────────────────────────
  /** 评价查询/写入（operation=list|put|delete；version-conflict 由调用方分流）。 */
  feedback: (args: {
    conversationId: string
    operation: 'list' | 'put' | 'delete'
    messageId?: string
    rating?: 'positive' | 'negative'
    note?: string
    ifVersion?: number | null
  }): Promise<FeedbackResult> => callAction<FeedbackResult>('chat-feedback', args),
  /** 从某条回答分支新会话（旧 chat-fork：{conversationId,messageId,requestId}）。 */
  fork: (args: { conversationId: string; messageId: string; requestId: string }): Promise<ConversationInfo> =>
    callAction<ConversationInfo>('chat-fork', args),
  /** 操作卡确认/取消/核对（旧 chat-operation：confirm|cancel|reconcile）。 */
  operationAction: (args: { conversationId: string; id: string; nonce?: string | null; operation: 'confirm' | 'cancel' | 'reconcile'; consumeSavedDraft?: boolean }): Promise<unknown> =>
    callAction('chat-operation', args),

  // ── 批 2b：文章工作台 ──────────────────────────────────────────────────
  /** 文章/草稿列表（args.status: published|draft|all）。 */
  articles: (args: { query?: string; page?: number; status?: string }): Promise<{ items: ArticleListItem[]; hasMore: boolean }> =>
    callAction('articles', args),
  /** 打开博客文章/保存稿（import：cid+variant）。 */
  importArticle: (cid: number, variant: string): Promise<BlogDraft> => callAction<BlogDraft>('import', { cid, variant }),
  draft: (id: string): Promise<BlogDraft> => callAction<BlogDraft>('draft', { id }),
  /** 新建工作台草稿（create action；与 chat-create 的 create 撞名故另起）。 */
  createDraftAction: (requestId: string): Promise<BlogDraft> => callAction<BlogDraft>('create', { requestId }),
  save: (args: { id: string; revision: number; content: Record<string, unknown> }): Promise<BlogDraft> => callAction<BlogDraft>('save', args),
  apply: (args: { id: string; revision: number; proposalId: string; fields: string[] }): Promise<BlogDraft> => callAction<BlogDraft>('apply', args),
  discardProposal: (args: { id: string; revision: number; proposalId: string }): Promise<BlogDraft> => callAction<BlogDraft>('discard-proposal', args),
  migrationStatus: (): Promise<{ remaining: number }> => callAction('migration-status'),
  migrateDrafts: (): Promise<unknown> => callAction('migrate-drafts'),
  metadata: (): Promise<{ categories: BlogCategory[] }> => callAction('metadata'),
  tasks: (draftId: string): Promise<WritingJob[]> => callAction('tasks', { draftId }),
  task: (id: string): Promise<WritingJob> => callAction<WritingJob>('task', { id }),
  taskStart: (args: { requestId: string; draftId: string; expectedRevision: number; instruction: string; research: boolean; attachments: Array<{ id: string; version?: number; range?: { from: number; to: number } | null }> }): Promise<WritingJob> =>
    callAction<WritingJob>('task-start', args),
  taskCancel: (id: string): Promise<WritingJob> => callAction<WritingJob>('task-cancel', { id }),
  operations: (draftId: string): Promise<OperationLogRow[]> => callAction('operations', { draftId }),
  prepare: (args: { id: string; revision: number; mode: 'publish'; proposalId?: string }): Promise<Record<string, unknown>> => callAction('prepare', args),
  prepareDelete: (cid: number): Promise<Record<string, unknown>> => callAction('prepare-delete', { cid }),
  confirm: (args: { id: string; nonce: string; consumeSavedDraft: boolean }): Promise<{ status: string; message?: string; result?: { url?: string | null } }> => callAction('confirm', args),
  reconcile: (id: string): Promise<{ status: string; message?: string; result?: { url?: string | null } }> => callAction('reconcile', { id }),
  /** 图片上传（POST /upload，octet-stream；返回图床地址）。 */
  uploadImage: (body: Blob | ArrayBuffer): Promise<{ url: string }> =>
    request<{ url: string }>('/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }),

  // ── 批 2b：管理域 ──────────────────────────────────────────────────────
  /** 分类/标签/评论的列表查询（kind 分流；评论带 page/status/cid）。 */
  manageList: (args: Record<string, unknown>): Promise<{ items: Array<Record<string, unknown>>; hasMore?: boolean }> => callAction('manage-list', args),
  manageGet: (args: { kind: string; id: number }): Promise<{ item?: Record<string, unknown>; version?: number; impact?: { defaultCategory?: boolean } }> => callAction('manage-get', args),
  managePrepare: (args: Record<string, unknown>): Promise<ManagePrepareResult> => callAction<ManagePrepareResult>('manage-prepare', args),
}

/** 附件上传（POST /attachment，octet-stream；旧 request('/attachment?...') 等价）。 */
export function uploadAttachment(draftId: string, name: string, body: Blob | ArrayBuffer): Promise<unknown> {
  const query = new URLSearchParams({ draftId, name })
  return request(`/attachment?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  })
}

/** 消息附件下载链接（旧 chat-file-link 的 href 拼法）。 */
export function chatAttachmentUrl(conversationId: string, requestId: string, id: string): string {
  const query = new URLSearchParams({ conversationId, requestId, id })
  return basePath(`/chat-attachment?${query.toString()}`)
}

/** 附件缩略图/下载链接（attachment-download；inline=1 走浏览器内联预览）。 */
export function attachmentDownloadUrl(draftId: string, id: string, inline = false): string {
  const query = new URLSearchParams(inline ? { draftId, id, inline: '1' } : { draftId, id })
  return basePath(`/attachment-download?${query.toString()}`)
}
