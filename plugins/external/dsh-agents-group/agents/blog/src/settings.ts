import { readFileSync } from 'node:fs'

export class BlogError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, message: string) { super(message); this.name = 'BlogError'; this.status = status; this.code = 'DSH_ACCESS_ERROR' }
}
/** 断言式不变量：`asserts test` 让调用点后面的 `definition.parameters` 之类**真的收窄**（不只是修辞）。 */
export function invariant(test: unknown, message: string, status = 400): asserts test { if (!test) throw new BlogError(status, message) }
export function origin(value: string, field: string, local = false): string {
  let url: URL
  try { url = new URL(value) } catch { throw new BlogError(503, `配置 ${field} 无效`) }
  invariant(!url.username && !url.password && url.origin === value
    && (url.protocol === 'https:' || local && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)), `配置 ${field} 无效`, 503)
  return url.origin
}
/**
 * 读博客配置。返回**解析后的 JSON 对象**（结构由运行期不变量逐个把关，见下），
 * 所以类型是"任意键的对象"而不是一个逐字段接口——这里的检查就是它的形状契约。
 */
export function loadSettings(path: string): Record<string, any> {
  let value: any
  try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { throw new BlogError(503, '无法读取博客 config/config.json，请检查配置路径与 JSON 格式') }
  invariant(value?.schemaVersion === 1, '配置 schemaVersion 必须为 1', 503)
  if(value.models!==undefined){
    // 显式收成 `Record<string, any>`：`value` 是 JSON.parse 的结果，逐字段校验全在下面这行里，
    // 类型只是让"按字符串键读一个 model 的 provider/model"这件事可表达（不是把校验挪到编译期）。
    const models: Record<string, any> = value.models
    invariant(models&&typeof models==='object'&&!Array.isArray(models),'配置 models 无效',503)
    for(const [kind,model] of Object.entries(models))invariant(['text','vision'].includes(kind)&&model&&['provider','model'].every(k=>typeof model[k]==='string'&&model[k].length>0&&model[k].length<=200),'配置 models 需要有效的 text/vision provider 和 model',503)
  }
  for (const section of ['blog', 'image']) {
    const c = value[section]
    invariant(c && typeof c === 'object', `缺少配置 ${section}`, 503)
    c.url = origin(c.url, `${section}.url`)
    for (const field of ['username', 'password']) invariant(typeof c[field] === 'string' && c[field].length > 0, `缺少配置 ${section}.${field}`, 503)
  }
  invariant(Number.isSafeInteger(value.image.strategyId) && value.image.strategyId > 0, '配置 image.strategyId 无效', 503)
  value.image.maxBytes ??= 10 * 1024 * 1024
  invariant(Number.isSafeInteger(value.image.maxBytes) && value.image.maxBytes > 0 && value.image.maxBytes <= 30 * 1024 * 1024, '配置 image.maxBytes 无效', 503)
  invariant(Array.isArray(value.backup?.allowedUserIds) && value.backup.allowedUserIds.every((v: unknown) => typeof v === 'string' && v), '配置 backup.allowedUserIds 无效', 503)
  if (value.backup.url) value.backup.url = origin(value.backup.url, 'backup.url', true)
  return value
}
/** 远端响应体：只要求"能异步迭代出字节块 + 可选 body"（`fetch` 的 `Response` 与宿主给出的流都满足）。 */
export interface ByteStream {
  readonly body?: AsyncIterable<Uint8Array> | null
}
export async function readJSON(response: ByteStream, maxBytes = 8 * 1024 * 1024): Promise<any> {
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of response.body ?? []) { size += chunk.length; invariant(size <= maxBytes, '远端响应超过限制', 502); chunks.push(chunk) }
  let data: any
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BlogError(502, '远端未返回有效 JSON') }
  return data
}
