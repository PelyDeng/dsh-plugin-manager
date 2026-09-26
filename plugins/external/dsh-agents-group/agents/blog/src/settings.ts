import { readFileSync } from 'node:fs'

/**
 * blog 业务错误：以**原状态码 + 原文案**穿过 HTTP 边界，不被包成 500。
 *
 * `code` 用 kit 业务错误通道的类别标识 `DSH_BUSINESS_ERROR`（`BusinessError` 同值，形状兼容
 * `isBusinessError`，kit 的 `createPluginHttp` 默认渲染对其透传）。**不要**改回
 * `DSH_ACCESS_ERROR`：那是 kit 访问协议（`AccessError`）的类别标识，借用它会让"访问错误"
 * 与"业务错误"在识别处无法区分——本类历史上曾借用该值（伪装成访问错误传递），已迁移到
 * 业务通道。群组的 `blogStorageErrorHandler` 与 chat/jobs/attachments 的识别点均按两个
 * code 值并列识别（旧归档的 `AccessError` 与本类的业务错误都要走到各自的文案/状态分支）。
 */
export class BlogError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, message: string) { super(message); this.name = 'BlogError'; this.status = status; this.code = 'DSH_BUSINESS_ERROR' }
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
 *
 * ⚠️ 类型层只有两步：`JSON.parse` 的结果先按 `unknown` 收（`any → unknown` 是放大），
 * 各小节的读取点再按它自己的形状断言一次（`as {...}`；`any` 本来也不做检查），
 * 取值、键名与校验顺序一字不变。
 */
export function loadSettings(path: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { throw new BlogError(503, '无法读取博客 config/config.json，请检查配置路径与 JSON 格式') }
  const settings = value as {schemaVersion?: unknown; models?: unknown; blog?: unknown; image?: unknown; backup?: unknown} & Record<string, unknown>
  invariant(settings?.schemaVersion === 1, '配置 schemaVersion 必须为 1', 503)
  if(settings.models!==undefined){
    // 逐字段校验全在下面这行里，类型只是让"按字符串键读一个 model 的 provider/model"这件事可表达
    // （不是把校验挪到编译期）。
    const models = settings.models as Record<string, unknown>
    invariant(models&&typeof models==='object'&&!Array.isArray(models),'配置 models 无效',503)
    for(const [kind,model] of Object.entries(models))invariant(['text','vision'].includes(kind)&&model&&['provider','model'].every(k=>typeof (model as Record<string, unknown>)[k]==='string'&&((model as Record<string, unknown>)[k] as string).length>0&&((model as Record<string, unknown>)[k] as string).length<=200),'配置 models 需要有效的 text/vision provider 和 model',503)
  }
  for (const section of ['blog', 'image']) {
    const c = settings[section] as Record<string, unknown>
    invariant(c && typeof c === 'object', `缺少配置 ${section}`, 503)
    c.url = origin(c.url as string, `${section}.url`)
    for (const field of ['username', 'password']) invariant(typeof c[field] === 'string' && c[field].length > 0, `缺少配置 ${section}.${field}`, 503)
  }
  const image = settings.image as {strategyId: number; maxBytes: number}
  invariant(Number.isSafeInteger(image.strategyId) && image.strategyId > 0, '配置 image.strategyId 无效', 503)
  image.maxBytes ??= 10 * 1024 * 1024
  invariant(Number.isSafeInteger(image.maxBytes) && image.maxBytes > 0 && image.maxBytes <= 30 * 1024 * 1024, '配置 image.maxBytes 无效', 503)
  const backup = settings.backup as {allowedUserIds?: unknown; url?: string; token?: string}
  invariant(Array.isArray(backup?.allowedUserIds) && backup.allowedUserIds.every((v: unknown) => typeof v === 'string' && v), '配置 backup.allowedUserIds 无效', 503)
  if (backup.url) backup.url = origin(backup.url, 'backup.url', true)
  return settings
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
