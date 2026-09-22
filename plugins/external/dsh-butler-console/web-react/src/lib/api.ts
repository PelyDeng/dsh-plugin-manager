/**
 * 后端接口封装（自 web/api.js 保留主体迁移为 TS：fetch/SSE 是纯逻辑，方案 §2）。
 *
 * 页面只通过这里访问工作台接口；路由前缀由服务端注入，不在前端写死。
 * SSE 事件形状见 `TurnEvent`（stores/turn.ts）——此处不定义，保持传输层与语义层分离。
 */

import { readEventStream } from './sse.ts'
import { DEFAULT_AVATAR_FILES } from './config.ts'
import type { TurnEvent } from './turn-event.ts'

const config = (globalThis as { __BUTLER_CONFIG__?: Record<string, unknown> }).__BUTLER_CONFIG__ ?? {}
export const ROUTE_PREFIX: string = typeof config.routePrefix === 'string' ? config.routePrefix : '/butler'

/** 历史分页一次取多少条：上限是服务端配置，页面只跟着它走。 */
export const HISTORY_PAGE_SIZE: number = typeof config.historyPageSize === 'number' ? config.historyPageSize : 30

/** 对话正文一页取多少条（与服务端缺省一致，上限 200）。 */
export const TRANSCRIPT_PAGE_SIZE = 50

/** 单个附件的大小上限：服务端下发真实值，这里只是拿不到时的兜底。 */
export const MAX_ATTACHMENT_BYTES: number = typeof config.maxAttachmentBytes === 'number' ? config.maxAttachmentBytes : 16 * 1024 * 1024

/** 一条消息最多带几个附件。 */
export const MAX_ATTACHMENTS_PER_MESSAGE: number = typeof config.maxAttachmentsPerMessage === 'number' ? config.maxAttachmentsPerMessage : 5

/** 任务记录分页大小（0.12.4）：与后端 conversationsPageSize 同步，identity 未下发时的缺省。 */
export const CHAT_PAGE_SIZE: number = typeof config.chatPageSize === 'number' ? config.chatPageSize : 10

/** 一次接口调用失败。带上状态码与稳定错误码（评审 B3：服务端承诺「客户端一律按 code 分支」）。 */
export class ApiError extends Error {
  status: number
  /** 服务端稳定错误码（如 run_already_finished / run_result_unknown / missing_field），无则 undefined。 */
  code?: string | undefined
  /** 409 冲突体附带的凭据：这轮其实已受理/结果未知时，据此引导去读任务快照。 */
  runId?: string | undefined
  conversationId?: string | undefined
  constructor(status: number, message: string, extra: { code?: string | undefined; runId?: string | undefined; conversationId?: string | undefined } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = extra.code
    this.runId = extra.runId
    this.conversationId = extra.conversationId
  }
}

/** 从错误响应体里取出服务端约定字段（缺啥都容错）。 */
async function errorFields(response: Response): Promise<{ message: string; code?: string | undefined; runId?: string | undefined; conversationId?: string | undefined }> {
  let message = `请求失败（HTTP ${response.status}）`
  let code: string | undefined
  let runId: string | undefined
  let conversationId: string | undefined
  try {
    const payload = await response.json()
    if (typeof payload?.error === 'string' && payload.error !== '') message = payload.error
    if (typeof payload?.code === 'string' && payload.code !== '') code = payload.code
    if (typeof payload?.runId === 'string' && payload.runId !== '') runId = payload.runId
    if (typeof payload?.conversationId === 'string' && payload.conversationId !== '') conversationId = payload.conversationId
  } catch { /* 非 JSON 错误体时保留上面的通用提示。 */ }
  return { message, code, runId, conversationId }
}

async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(options.body != null ? { 'content-type': 'application/json' } : {}) },
    ...options,
  })
  if (!response.ok) {
    const fields = await errorFields(response)
    throw new ApiError(response.status, fields.message, fields)
  }
  if (response.status === 204) return null as T
  return await response.json() as T
}

export interface ConversationItem {
  id: string
  title: string
  updatedAt: number
}

/** /conversations 的分页信封（0.12.4：offset+total，identity 下发页大小）。 */
export interface ConversationPage {
  items: ConversationItem[]
  total?: number
}

export interface MemberItem {
  agentId: string
  displayName: string
  declaredName: string
  accent?: string
  /** 成员简介（评审 中9）：档案卡次要行展示。 */
  description?: string
  /** 插件版本与工具数（悬浮可见）。 */
  version?: string
  toolCount?: number
  capabilities?: ReadonlyArray<{ name?: string; description?: string }> | ReadonlyArray<string>
  /** 正在忙的任务（真实形状是对象，此前误声明为 string）。 */
  busy?: { taskId: string; subtaskId: string; state: string } | null
}

export interface TaskRecord {
  /** 验收口径（评审 中19）：「交回什么才算完成」的对照物。 */
  acceptance?: string
  id: string
  conversationId: string
  goal: string
  note: string | null
  state: string
  createdAt: number | string
  updatedAt: number | string
  summary: string | null
  error: string | null
  subtasks: TaskSubtask[]
}

/**
 * 任务列表投影（/history 返回，方案护栏「不导入业务源码」的存储投影形状）：
 * **没有 subtasks**——逐条子任务只在 /task 详情里有。
 */
export interface TaskSummary {
  id: string
  conversationId: string
  goal: string
  state: string
  createdAt: number | string
  updatedAt: number | string
  subtaskTotal: number
  subtaskDone: number
}

export interface TaskSubtask {
  id: string
  agentId: string
  goal: string
  /** 本步的验收口径。 */
  acceptance?: string
  state: string
  startedAt: number | string | null
  finishedAt: number | string | null
  result: string | null
  error: string | null
  artifacts?: unknown[]
  /** external_pending 的结构化说明（在等谁做什么/办完能做什么）。 */
  pending?: { reason: string; next?: string }
  /** 协调方质检裁决（accept/rework/replace/unverified）。 */
  verdict?: string
  verdictReason?: string
  actions?: ReadonlyArray<{
    id: string
    kind?: string
    title?: string
    summary?: string
    detail?: string
    fields?: ReadonlyArray<{ label?: string; value?: string }>
    state?: string
    expiresAt?: number
    confirmLabel?: string
    cancelLabel?: string
  }>
}

export interface TranscriptItem {
  /** 事件序号（数值，不是字符串——历史合并按数值排序）。 */
  seq: number
  role: string
  text: string
  time: number
  interrupted: boolean
}

export interface RunHead {
  runId: string
  state: string
  taskId?: string
  startedAt?: number
  finishedAt?: number | null
  /** 探测头部的窗口位置（reset 重建后续订对齐的基准）。 */
  seq?: number
}

export const api = {
  identity: () => request<{ label: string; chatPageSize?: number }>('/identity'),
  members: () => request<{ items: MemberItem[] }>('/members'),
  overview: () => request<{ counts: Record<string, number>; failures: Array<{ id: string; goal: string; updatedAt: number; error: string | null }> }>('/overview'),
  conversations: (offset = 0, limit?: number) => {
    const query = `?offset=${String(offset)}${limit === undefined ? '' : `&limit=${String(limit)}`}`
    return request<ConversationPage>(`/conversations${query}`)
  },
  /** 会话重命名（0.12.4）：仅服务端持有标题写权。 */
  renameConversation: (id: string, title: string) =>
    request<{ items: ConversationItem[] }>('/conversations/rename', { method: 'POST', body: JSON.stringify({ id, title }) }),
  history: ({ offset = 0, limit = HISTORY_PAGE_SIZE, keyword = '', state = '', conversationId = '' } = {}) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (keyword !== '') params.set('q', keyword)
    if (state !== '') params.set('state', state)
    if (conversationId !== '') params.set('conversationId', conversationId)
    return request<{ items: TaskSummary[]; nextOffset: number | null }>(`/history?${params.toString()}`)
  },
  /**
   * 对话正文（历史阅读）：官方会话日志里的真人输入与已提交答复，不另存副本。
   * `tail: true` 取最新一页；`before` 取该序号之前更早的一页；两者互斥。响应里的
   * `prevBefore` 为 null 表示没有更早的了。
   */
  transcript: ({ conversationId, after, before, tail = false, limit = TRANSCRIPT_PAGE_SIZE, signal }: {
    conversationId: string
    after?: number
    before?: string
    tail?: boolean
    limit?: number
    signal?: AbortSignal
  }) => {
    const params = new URLSearchParams({ conversationId, limit: String(limit) })
    if (after !== undefined) params.set('after', String(after))
    if (before !== undefined) params.set('before', String(before))
    if (tail) params.set('tail', '1')
    return request<{ items: TranscriptItem[]; prevBefore: string | null }>(`/transcript?${params.toString()}`, signal === undefined ? {} : { signal })
  },
  task: <T = TaskRecord>(id: string, signal?: AbortSignal) => request<T>(`/task?id=${encodeURIComponent(id)}`, signal === undefined ? {} : { signal }),
  stop: (conversationId: string, options: { taskId?: string | undefined; signal?: AbortSignal | undefined } = {}) => {
    const body: Record<string, unknown> = { conversationId }
    if (options.taskId !== undefined && options.taskId !== '') body.taskId = options.taskId
    const init: RequestInit = { method: 'POST', body: JSON.stringify(body) }
    return request<{ accepted: boolean; reason?: string }>('/stop', options.signal === undefined ? init : { ...init, signal: options.signal })
  },
  removeConversations: (ids: string[]) =>
    request<{ results: Array<{ id: string; status: string; message?: string }> }>('/conversations/remove', { method: 'POST', body: JSON.stringify({ ids }) }),
  removeTask: (id: string) =>
    request<{ ok: boolean }>('/tasks/remove', { method: 'POST', body: JSON.stringify({ id }) }),
  setAlias: (agentId: string, displayName: string, accent?: string) =>
    request('/members/alias', { method: 'POST', body: JSON.stringify({ agentId, displayName, accent }) }),
  clearAvatar: (agentId: string) =>
    request(`/members/avatar?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
  attachments: (conversationId = '') =>
    request<{ items: AttachmentRecord[] }>(`/attachments/list?conversationId=${encodeURIComponent(conversationId)}`),
  removeAttachment: (id: string) =>
    request(`/attachments?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/**
 * 上传一个附件：直接把文件字节发过去（不是 multipart、不 base64），类型由服务端按字节
 * 判定。文件名走 query——正文只能有一个，而名字是元信息。**解析失败也返回 200**：
 * 一次选三个文件，坏一个不该让另外两个也传不上去。
 */
export async function uploadAttachment(file: File, conversationId = ''): Promise<AttachmentRecord> {
  const params = new URLSearchParams({ name: file.name })
  if (conversationId !== '') params.set('conversationId', conversationId)
  const response = await fetch(`${ROUTE_PREFIX}/attachments?${params.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream', accept: 'application/json' },
    body: file,
  })
  if (!response.ok) throw await streamFailure(response)
  return (await response.json()).item as AttachmentRecord
}

/** 服务端附件记录（评审 中11：preview/kind 等元数据供页面直接说明它是什么）。 */
export interface AttachmentRecord {
  id: string
  name: string
  bytes: number
  status: string
  message?: string
  kind?: string
  preview?: string
  totalUnits?: number
  characters?: number
  sourceUrl?: string
}

/** 从一个链接取回附件（服务端抓取）：地址合法性、跳转、大小、时长都由服务端把关。 */
export async function attachFromUrl(url: string, conversationId = ''): Promise<AttachmentRecord> {
  const response = await fetch(`${ROUTE_PREFIX}/attachments/url`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url, ...(conversationId === '' ? {} : { conversationId }) }),
  })
  if (!response.ok) throw await streamFailure(response)
  return (await response.json()).item as AttachmentRecord
}

/**
 * 上传成员头像：直接把图片字节发过去，服务端按魔数核验类型，不信 content-type。
 * 上限写死 256KB 是既有口径（服务端同样核验）。
 */
export async function uploadAvatar(agentId: string, file: File): Promise<unknown> {
  if (file.size > 262144) throw new ApiError(413, '图片太大了，换张小于 256KB 的')
  const response = await fetch(`${ROUTE_PREFIX}/members/avatar?agentId=${encodeURIComponent(agentId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type, accept: 'application/json' },
    body: file,
  })
  if (!response.ok) throw await streamFailure(response)
  return await response.json()
}

/** 头像地址；带上更新时间戳避免换图后浏览器继续用旧缓存。 */
export function avatarUrl(agentId: string, stamp?: number): string {
  return `${ROUTE_PREFIX}/members/avatar?agentId=${encodeURIComponent(agentId)}&v=${stamp ?? 0}`
}

export function defaultAvatarUrl(agentId: string): string | null {
  const file = DEFAULT_AVATAR_FILES.get(String(agentId))
  return file === undefined ? null : `${ROUTE_PREFIX}/assets/media/avatars/${file}`
}

/** 发起一轮对话并逐条产出事件（POST + SSE：请求要带 JSON 正文）。 */
export function chat({ conversationId, message, requestId, attachmentIds, signal }: {
  conversationId: string
  message: string
  requestId?: string
  attachmentIds?: string[]
  signal?: AbortSignal | undefined
}): AsyncGenerator<TurnEvent> {
  return postStream<TurnEvent>('/chat', {
    conversationId,
    message,
    ...(requestId === undefined ? {} : { requestId }),
    ...(attachmentIds === undefined || attachmentIds.length === 0 ? {} : { attachmentIds }),
  }, signal)
}

/** 回应一位正在等待的成员。requestId 幂等语义同 chat。 */
export function reply({ taskId, subtaskId, text, decideByAgent, requestId, signal }: {
  taskId: string
  subtaskId: string
  text: string
  decideByAgent?: boolean
  requestId?: string
  signal?: AbortSignal | undefined
}): AsyncGenerator<TurnEvent> {
  return postStream<TurnEvent>('/reply', { taskId, subtaskId, text, decideByAgent, ...(requestId === undefined ? {} : { requestId }) }, signal)
}

/**
 * 给进行中的一轮补充目标/材料（后端 /supplement：幂等 + expectVersion 并发防护）。
 * 消费返回的事件流与 chat 同构（run 头 + 事件 + summary）。
 */
export function supplement({ taskId, text, expectVersion, requestId, signal }: {
  taskId: string
  text: string
  expectVersion?: number | undefined
  requestId?: string | undefined
  signal?: AbortSignal | undefined
}): AsyncGenerator<TurnEvent> {
  return postStream<TurnEvent>('/supplement', {
    taskId,
    text,
    ...(expectVersion === undefined ? {} : { expectVersion }),
    ...(requestId === undefined ? {} : { requestId }),
  }, signal)
}

/** 对一条待确认操作做决策。requestId 是受理幂等身份。 */
export function act({ taskId, subtaskId, actionId, decision, note, requestId, signal }: {
  taskId: string
  subtaskId: string
  actionId: string
  decision: string
  note?: string | undefined
  requestId?: string | undefined
  signal?: AbortSignal | undefined
}): AsyncGenerator<TurnEvent> {
  return postStream<TurnEvent>('/action', {
    taskId,
    subtaskId,
    actionId,
    decision,
    ...(note === undefined || note === '' ? {} : { note }),
    ...(requestId === undefined ? {} : { requestId }),
  }, signal)
}

/** 只读订阅一个会话最近一轮的事件（不启动任何执行）。 */
export function events({ conversationId, after, signal }: {
  conversationId: string
  after?: number
  signal?: AbortSignal
}): AsyncGenerator<unknown> {
  const params = new URLSearchParams({ conversationId })
  if (after !== undefined) params.set('after', String(after))
  return eventStream<TurnEvent>(`/events?${params.toString()}`, signal)
}

/** 只问「这个会话现在有没有在跑的一轮」。null 表示没有可观察的一轮。 */
export async function eventsHead(conversationId: string, signal?: AbortSignal): Promise<RunHead | null> {
  const { run } = await request<{ run: RunHead | null }>(`/events?conversationId=${encodeURIComponent(conversationId)}&probe=1`, signal === undefined ? {} : { signal })
  return run ?? null
}

async function* eventStream<T = TurnEvent>(path: string, signal?: AbortSignal | undefined): AsyncGenerator<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    credentials: 'same-origin',
    headers: { accept: 'text/event-stream' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw await streamFailure(response)
  yield* readEventStream<T>(response, signal)
}

async function* postStream<T = TurnEvent>(path: string, payload: unknown, signal?: AbortSignal | undefined): AsyncGenerator<T> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw await streamFailure(response)
  yield* readEventStream(response, signal)
}

async function streamFailure(response: Response): Promise<ApiError> {
  const { message, code, runId, conversationId } = await errorFields(response)
  return new ApiError(response.status, message, { code, runId, conversationId })
}
