/**
 * 业务接口层（旧 app.js businessFetch/readJson/postJson 的 React 等价）。
 *
 * 身份守卫的单一实现在这里：每次业务请求前核验 /identity，响应回来核对发起时的
 * identityEpoch（session store），登录状态变化即在途回包作废。401 跳登录页、
 * 403/503 清空私有视图——与旧 rejectAccess 同口径。
 *
 * SSE 是 POST 单向事件流（无重订语义）：读流通路上每个事件由消费方（chat-controller）
 * 再核对一次代次与 abort 状态。
 */
import { routePath } from './config.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ConversationPage, HistoryResponse, ModelCatalog, ModelSelection } from './types.ts'

/** 一次接口调用失败（错误体里带服务端 message 时优先用）。 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function parseErrorBody(response: Response): Promise<string> {
  try {
    const payload = await response.clone().json() as { error?: unknown }
    if (typeof payload?.error === 'string' && payload.error !== '') return payload.error
  } catch { /* 非 JSON 错误体，走通用文案。 */ }
  return `请求失败 HTTP ${response.status}`
}

/**
 * 401/403/503 的统一处置：清空私有视图（代次 bump + 中断在途请求）；
 * 401 再跳统一登录页。返回 true 表示响应被拒绝，调用方直接收场。
 */
function rejectAccess(response: Response): Response {
  if (![401, 403, 503].includes(response.status)) return response
  const session = useSessionStore.getState()
  session.clearPrivateView()
  if (response.status === 401) window.location.replace(`/auth?returnTo=${encodeURIComponent(routePath(''))}`)
  session.setStatus('off', response.status === 503 ? '认证服务暂不可用' : '当前账号没有访问权限')
  return response
}

/** /identity 核验（旧 checkIdentity 等价：不经过 businessFetch，防递归）。 */
export async function checkIdentity(): Promise<{ mode: string; key: string; label: string }> {
  const session = useSessionStore.getState()
  const epoch = session.identityEpoch
  let response: Response
  try {
    response = await fetch(routePath('/identity'), { cache: 'no-store' })
  } catch (error) {
    throw error instanceof Error ? error : new Error('网络异常，请稍后重试')
  }
  rejectAccess(response)
  const data = await response.json().catch(() => ({})) as { key?: unknown; mode?: unknown; label?: unknown }
  if (epoch !== useSessionStore.getState().identityEpoch) throw new Error('登录状态已变化')
  if (!response.ok) throw new Error(await parseErrorBody(response))
  if (typeof data.key !== 'string' || data.key === '') throw new Error('身份信息无效')
  const sessionNow = useSessionStore.getState()
  if (sessionNow.identityKey !== '' && sessionNow.identityKey !== data.key) {
    sessionNow.clearPrivateView()
    window.location.replace(routePath(''))
    throw new Error('登录账号已变化')
  }
  return {
    mode: typeof data.mode === 'string' ? data.mode : '',
    key: data.key,
    label: typeof data.label === 'string' ? data.label : '',
  }
}

/**
 * 业务请求入口：先核验身份，再发请求；响应回来核对发起时的 identityEpoch，
 * 登录状态已变化即抛错（旧 businessFetch 口径）。
 */
export async function businessFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const epoch = useSessionStore.getState().identityEpoch
  await checkIdentity()
  const response = await fetch(path, options)
  if (epoch !== useSessionStore.getState().identityEpoch) throw new Error('登录状态已变化，请重新打开页面')
  return rejectAccess(response)
}

/** JSON 响应读取：错误体优先用服务端 message（旧 readJson 等价，去 WeakMap 化）。 */
export async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as unknown
  if (!response.ok) {
    const message = (data as { error?: unknown })?.error
    throw new ApiError(response.status, typeof message === 'string' && message !== '' ? message : `请求失败 HTTP ${response.status}`)
  }
  return data as T
}

async function get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const params = new URLSearchParams(query)
  const suffix = params.toString() === '' ? '' : `?${params.toString()}`
  const response = await businessFetch(routePath(path) + suffix)
  return readJson<T>(response)
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await businessFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readJson<T>(response)
}

export const api = {
  identity: () => get<{ mode: string; key: string; label: string; authPath?: string }>('/identity'),
  models: (conversationId: string) =>
    get<ModelCatalog>('/models', conversationId === '' ? {} : { conversationId }),
  conversations: (offset: number, query: string) =>
    get<ConversationPage>('/conversations', { offset: String(offset), q: query }),
  history: (conversationId: string, signal?: AbortSignal) =>
    getFetch<HistoryResponse>(routePath('/history'), { conversationId }, signal),
  stop: (conversationId: string) => postJson<{ ok: boolean }>(routePath('/stop'), { conversationId }),
  feedback: (conversationId: string, messageId: string, rating: 'positive' | 'negative') =>
    postJson<{ rating: 'positive' | 'negative' | null }>(routePath('/feedback'), { conversationId, messageId, rating }),
  branch: (conversationId: string, atSeq: number) =>
    postJson<{ conversationId: string }>(routePath('/branch'), { conversationId, atSeq }),
  conversationAction: (input: { operation: string; ids: string[]; title?: string; pinned?: boolean }) =>
    postJson<{ ok: boolean }>(routePath('/conversation-action'), input),
  /**
   * 发起一轮对话：POST /chat 返回 event-stream 响应体（不在这里读流，
   * 事件分发与守卫在 chat-controller）。
   */
  chat: (payload: { conversationId: string; message: string; modelSelection?: ModelSelection }, signal: AbortSignal): Promise<Response> =>
    businessFetch(routePath('/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    }),
}

/** GET + query 的变体：history 需要 AbortSignal（切会话时中断在途复原）。 */
async function getFetch<T>(basePath: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const params = new URLSearchParams(query)
  const response = await businessFetch(`${basePath}?${params.toString()}`, signal === undefined ? {} : { signal })
  return readJson<T>(response)
}
