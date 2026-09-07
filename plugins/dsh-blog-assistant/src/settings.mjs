import { readFileSync } from 'node:fs'

export class BlogError extends Error {
  constructor(status, message) { super(message); this.name = 'BlogError'; this.status = status; this.code = 'DSH_ACCESS_ERROR' }
}
export function invariant(test, message, status = 400) { if (!test) throw new BlogError(status, message) }
export function origin(value, field, local = false) {
  let url
  try { url = new URL(value) } catch { throw new BlogError(503, `配置 ${field} 无效`) }
  invariant(!url.username && !url.password && url.origin === value
    && (url.protocol === 'https:' || local && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)), `配置 ${field} 无效`, 503)
  return url.origin
}
export function loadSettings(path) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { throw new BlogError(503, '无法读取博客 config/config.json，请检查配置路径与 JSON 格式') }
  invariant(value?.schemaVersion === 1, '配置 schemaVersion 必须为 1', 503)
  for (const section of ['blog', 'image']) {
    const c = value[section]
    invariant(c && typeof c === 'object', `缺少配置 ${section}`, 503)
    c.url = origin(c.url, `${section}.url`)
    for (const field of ['username', 'password']) invariant(typeof c[field] === 'string' && c[field].length > 0, `缺少配置 ${section}.${field}`, 503)
  }
  invariant(Number.isSafeInteger(value.image.strategyId) && value.image.strategyId > 0, '配置 image.strategyId 无效', 503)
  value.image.maxBytes ??= 10 * 1024 * 1024
  invariant(Number.isSafeInteger(value.image.maxBytes) && value.image.maxBytes > 0 && value.image.maxBytes <= 30 * 1024 * 1024, '配置 image.maxBytes 无效', 503)
  invariant(Array.isArray(value.backup?.allowedUserIds) && value.backup.allowedUserIds.every(v => typeof v === 'string' && v), '配置 backup.allowedUserIds 无效', 503)
  if (value.backup.url) value.backup.url = origin(value.backup.url, 'backup.url', true)
  return value
}
export async function readJSON(response, maxBytes = 8 * 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of response.body ?? []) { size += chunk.length; invariant(size <= maxBytes, '远端响应超过限制', 502); chunks.push(chunk) }
  let data
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BlogError(502, '远端未返回有效 JSON') }
  return data
}
