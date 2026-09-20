/**
 * 后端接口封装。
 *
 * 页面只通过这里访问工作台接口；路由前缀由服务端注入，不在前端写死。
 */

import { readEventStream } from './stream.js'

const config = globalThis.__BUTLER_CONFIG__ ?? {}
export const ROUTE_PREFIX = config.routePrefix ?? '/butler'

/**
 * 历史分页一次取多少条。
 *
 * 上限是服务端配置，页面只跟着它走：写死一个比上限大的数会直接被服务端按参数无效拒掉，
 * 而页面上只会显示一句「读取记录失败」——错误离原因太远。
 */
export const HISTORY_PAGE_SIZE = config.historyPageSize ?? 30

/**
 * 对话正文一页取多少条。
 *
 * 与服务端缺省一致（上限 200）：历史阅读先取最新一页，再按 `before` 游标往更早翻。
 */
export const TRANSCRIPT_PAGE_SIZE = 50

/**
 * 单个附件的大小上限。
 *
 * 服务端会在 `/identity` 与页面配置里下发真实值，这里只作为**拿不到时的兜底**。写死一个比
 * 服务端大的数会白跑一次上传、再被 413 拒掉；写小了会让本来能传的文件传不上去。
 * （头像那条路把 262144 写死在 `uploadAvatar` 里，是同一类问题的既有例子，这里不重犯。）
 */
export const MAX_ATTACHMENT_BYTES = config.maxAttachmentBytes ?? 16 * 1024 * 1024

/** 一条消息最多带几个附件。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = config.maxAttachmentsPerMessage ?? 5

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
  history: ({ offset = 0, limit = HISTORY_PAGE_SIZE, keyword = '', state = '', conversationId = '' } = {}) => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (keyword !== '') params.set('q', keyword)
    if (state !== '') params.set('state', state)
    if (conversationId !== '') params.set('conversationId', conversationId)
    return request(`/history?${params.toString()}`)
  },
  /**
   * 对话正文（C 批历史阅读）：官方会话日志里的真人输入与已提交答复，不另存副本。
   * `tail: true` 取最新一页；`before` 取该序号之前更早的一页；两者互斥。响应里的
   * `prevBefore` 为 null 表示没有更早的了。
   */
  transcript: ({ conversationId, after, before, tail = false, limit = TRANSCRIPT_PAGE_SIZE, signal } = {}) => {
    const params = new URLSearchParams({ conversationId, limit: String(limit) })
    if (after !== undefined) params.set('after', String(after))
    if (before !== undefined) params.set('before', String(before))
    if (tail) params.set('tail', '1')
    return request(`/transcript?${params.toString()}`, signal === undefined ? {} : { signal })
  },
  task: (id, signal) => request(`/task?id=${encodeURIComponent(id)}`, signal === undefined ? {} : { signal }),
  stop: (conversationId, signal) => request('/stop', { method: 'POST', body: JSON.stringify({ conversationId }), signal }),
  setAlias: (agentId, displayName, accent) =>
    request('/members/alias', { method: 'POST', body: JSON.stringify({ agentId, displayName, accent }) }),
  clearAvatar: agentId =>
    request(`/members/avatar?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
  /** 待发附件（还没绑到任务的那些）。刷新页面后靠它把附件条重建出来。 */
  attachments: (conversationId = '') =>
    request(`/attachments/list?conversationId=${encodeURIComponent(conversationId)}`),
  removeAttachment: id =>
    request(`/attachments?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** 头像地址；带上更新时间戳避免换图后浏览器继续用旧缓存。 */
export function avatarUrl(agentId, stamp) {
  return `${ROUTE_PREFIX}/members/avatar?agentId=${encodeURIComponent(agentId)}&v=${stamp ?? 0}`
}

/**
 * 上传一个附件。
 *
 * 与头像同一条路子：直接把文件字节发过去，**不是 multipart、不 base64**，类型由服务端按字节
 * 判定（不信这里的 content-type）。文件名走 query——正文只能有一个，而名字是元信息。
 *
 * 返回服务端的附件记录：`status` 是 `ready` 或 `failed`。**解析失败也返回 200**：一次选三个
 * 文件，坏一个不该让另外两个也传不上去，所以每个文件自己带状态回来，页面按状态画。
 */
export async function uploadAttachment(file, conversationId = '') {
  const params = new URLSearchParams({ name: file.name })
  if (conversationId !== '') params.set('conversationId', conversationId)
  const response = await fetch(`${ROUTE_PREFIX}/attachments?${params.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream', accept: 'application/json' },
    body: file,
  })
  if (!response.ok) throw await apiFailure(response, '上传失败')
  const payload = await response.json()
  return payload.item
}

/**
 * 从一个链接取回附件（服务端抓取）。
 *
 * 与上传的区别只在"字节从哪来"：地址的合法性、能不能跟跳转、多大、多长都由服务端把关，
 * 页面不做判断——那些规则只有一处实现才不会两边不一致。
 */
export async function attachFromUrl(url, conversationId = '') {
  const response = await fetch(`${ROUTE_PREFIX}/attachments/url`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url, ...(conversationId === '' ? {} : { conversationId }) }),
  })
  if (!response.ok) throw await apiFailure(response, '取回失败')
  const payload = await response.json()
  return payload.item
}

/** 非 2xx 响应 → `ApiError`：优先用服务端那句给人看的话。 */
async function apiFailure(response, fallback) {
  let message = `${fallback}（HTTP ${response.status}）`
  try {
    const payload = await response.json()
    if (typeof payload?.error === 'string' && payload.error !== '') message = payload.error
  } catch { /* 非 JSON 错误体时保留上面的通用提示。 */ }
  return new ApiError(response.status, message)
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
 * `requestId` 是提交幂等身份（S07）：同一次提交的每次重试复用同一个 ID，
 * 服务端据此认出「同一句话」而不是再派一遍活。
 * `attachmentIds` 是这一轮带的附件（按上传时拿到的 id）；不带就是没有附件。
 */
export async function* chat({ conversationId, message, requestId, attachmentIds, signal }) {
  yield* postStream('/chat', {
    conversationId,
    message,
    ...(requestId === undefined ? {} : { requestId }),
    ...(attachmentIds === undefined || attachmentIds.length === 0 ? {} : { attachmentIds }),
  }, signal)
}

/**
 * 回应一位正在等待的成员。
 *
 * 与 `/chat` 一样：受理之后执行在后台跑，这条连接只是「我在这里看着」。
 * `requestId` 幂等语义同 {@link chat}；改了措辞就是新的一次回话，要换新 ID。
 */
export async function* reply({ taskId, subtaskId, text, decideByAgent, requestId, signal }) {
  yield* postStream('/reply', { taskId, subtaskId, text, decideByAgent, ...(requestId === undefined ? {} : { requestId }) }, signal)
}

/**
 * 对一条待确认操作做决策（就地确认 / 取消）。
 *
 * 与 {@link reply} 同一套：受理之后执行在后台跑，这条连接只负责把事件推回来。
 * `requestId` 是受理幂等身份（同一次点击的重试复用同一个 ID，换一条操作换新 ID）——
 * 用户在卡片上双击时，服务端按它去重，不会把同一件事办两遍。
 */
export async function* act({ taskId, subtaskId, actionId, decision, note, requestId, signal }) {
  yield* postStream('/action', {
    taskId,
    subtaskId,
    actionId,
    decision,
    ...(note === undefined || note === '' ? {} : { note }),
    ...(requestId === undefined ? {} : { requestId }),
  }, signal)
}

/**
 * 只读订阅一个会话最近一轮的事件。
 *
 * 它不启动任何执行，所以刷新页面、或者第二个入口想看同一轮，用它接上即可，
 * 不会把任务重跑一遍。不传 `after` 表示只看从现在开始的新事件；传了就以它为游标续传。
 */
export async function* events({ conversationId, after, signal }) {
  const params = new URLSearchParams({ conversationId })
  if (after !== undefined) params.set('after', String(after))
  yield* eventStream(`/events?${params.toString()}`, signal)
}

/**
 * 只问「这个会话现在有没有在跑的一轮」。
 *
 * 接上一轮之前先问一句，可以避免为一个根本没在跑的任务把整轮事件重新拉一遍。
 * 返回 `null` 表示没有可观察的一轮。
 */
export async function eventsHead(conversationId, signal) {
  const { run } = await request(`/events?conversationId=${encodeURIComponent(conversationId)}&probe=1`, signal === undefined ? {} : { signal })
  return run ?? null
}

async function* eventStream(path, signal) {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    credentials: 'same-origin',
    headers: { accept: 'text/event-stream' },
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
