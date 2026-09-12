/**
 * 后端接口封装。
 *
 * 页面只通过这里访问工作台接口；路由前缀由服务端注入，不在前端写死。
 */

import { readEventStream } from './stream.js'

const config = globalThis.__BUTLER_CONFIG__ ?? {}
export const ROUTE_PREFIX = config.routePrefix ?? '/butler'

/** 一次接口调用失败。带上状态码，页面据此区分未登录和真正的服务错误。 */
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
    ...options,
  })
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const payload = await response.json()
      if (typeof payload?.error === 'string' && payload.error !== '') message = payload.error
    } catch { /* 非 JSON 错误体时保留上面的通用提示。 */ }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return null
  return await response.json()
}

export const api = {
  identity: () => request('/identity'),
  members: () => request('/members'),
  overview: () => request('/overview'),
  conversations: () => request('/conversations'),
  history: ({ offset = 0, limit = 40, keyword = '', state = '' } = {}) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (keyword !== '') params.set('q', keyword)
    if (state !== '') params.set('state', state)
    return request(`/history?${params.toString()}`)
  },
  task: id => request(`/task?id=${encodeURIComponent(id)}`),
  stop: conversationId => request('/stop', { method: 'POST', body: JSON.stringify({ conversationId }) }),
  setAlias: (agentId, displayName, accent) =>
    request('/members/alias', { method: 'POST', body: JSON.stringify({ agentId, displayName, accent }) }),
  clearAvatar: agentId =>
    request(`/members/avatar?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
}

/** 头像地址；带上更新时间戳避免换图后浏览器继续用旧缓存。 */
export function avatarUrl(agentId, stamp) {
  return `${ROUTE_PREFIX}/members/avatar?agentId=${encodeURIComponent(agentId)}&v=${stamp ?? 0}`
}

/**
 * 上传成员头像。
 *
 * 直接把图片字节发过去，服务端按魔数核验类型，不信这里的 content-type。
 */
export async function uploadAvatar(agentId, file) {
  if (file.size > 262144) throw new ApiError(413, '图片太大了，换张小于 256KB 的')
  const response = await fetch(`${ROUTE_PREFIX}/members/avatar?agentId=${encodeURIComponent(agentId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type, accept: 'application/json' },
    body: file,
  })
  if (!response.ok) {
    let message = `上传失败（HTTP ${response.status}）`
    try {
      const payload = await response.json()
      if (typeof payload?.error === 'string' && payload.error !== '') message = payload.error
    } catch { /* 保留通用提示。 */ }
    throw new ApiError(response.status, message)
  }
  return await response.json()
}

/**
 * 发起一轮对话并逐条产出事件。
 *
 * 用 POST + SSE 而不是 EventSource：请求要带 JSON 正文。中断时由调用方 abort，
 * 服务端会在连接断开时中止这一轮。
 */
export async function* chat({ conversationId, message, signal }) {
  yield* postStream('/chat', { conversationId, message }, signal)
}

/** 回应一位正在等你的成员。 */
export async function* reply({ taskId, subtaskId, text, decideByAgent, signal }) {
  yield* postStream('/reply', { taskId, subtaskId, text, decideByAgent }, signal)
}

async function* postStream(path, payload, signal) {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) {
    let text = `请求失败（HTTP ${response.status}）`
    try {
      const parsed = await response.json()
      if (typeof parsed?.error === 'string' && parsed.error !== '') text = parsed.error
    } catch { /* 保留通用提示。 */ }
    throw new ApiError(response.status, text)
  }
  yield* readEventStream(response, signal)
}
