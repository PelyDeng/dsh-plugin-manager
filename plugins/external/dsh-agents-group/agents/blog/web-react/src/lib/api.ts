/**
 * 业务接口层（旧 web/app.js request/api 的 React 等价）。
 *
 * 形态照旧：全部业务动作走 POST /api 的 {action,args} 信封；错误体优先用服务端
 * error/message 文案。blog 旧页面没有请求前的身份复检（与 closedoff 的
 * businessFetch 不同构），401 由错误体文案透出——保持等价，不新增机制。
 */
import { basePath } from './config.ts'
import type {
  AttachmentItem,
  ChatHistoryResult,
  ConversationInfo,
  ConversationPage,
  Identity,
  ModelCatalog,
  ModelSelection,
  SendResult,
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
