/**
 * OpenAI 兼容图像生成端点的一次调用。
 *
 * 单独成文件而不是塞进适配器：这里处理的是**协议层**的事（URL 拼接、超时、响应解析、
 * base64 解码），与"本接缝怎么表达一次生成"无关。上游如果哪天给了兼容但细节不同的端点，
 * 改的是这里，适配器不动。
 */

import { ImageGenerationError } from './spec.ts'

/** 调用上游所需的连接信息。 */
export interface ImageRequestConfig {
  /** 端点根，例如 `https://relay.example.com`；允许以 `/v1` 结尾。 */
  readonly baseUrl: string
  readonly apiKey: string
  /** 便于测试注入；缺省用全局 `fetch`。 */
  readonly fetchImpl?: typeof fetch
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number
}

/** 一次上游调用的请求体。 */
export interface UpstreamImageRequest {
  readonly prompt: string
  readonly model: string
  readonly size: string
  readonly quality: string
  readonly count: number
  readonly signal?: AbortSignal
}

/** 上游返回的一张图片（尚未落盘）。 */
export interface UpstreamImage {
  readonly data: Uint8Array
  readonly mediaType: string
}

const DEFAULT_TIMEOUT_MS = 180_000

/**
 * 拼出图像生成端点的完整 URL。
 *
 * 兼容两种写法：`https://host` 与 `https://host/v1`。中转站的地址通常已经带 `/v1`，
 * 再拼一次会得到 `/v1/v1/images/generations`——那是最常见的配置事故。
 */
function endpointOf(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1')
    ? `${trimmed}/images/generations`
    : `${trimmed}/v1/images/generations`
}

/** 把响应体截断成可放进错误消息的片段；不整段回显，避免把上游的长正文带进日志。 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/** 从上游错误响应里尽量取出一句可读原因。 */
function reasonOf(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message === 'string' && message.trim() !== '') return message.trim()
  } catch {
    // 不是 JSON：按纯文本处理，下面的 excerpt 会给出片段。
  }
  return excerpt(body) === '' ? `HTTP ${status}` : excerpt(body)
}

/**
 * 调一次图像生成端点。
 *
 * @param config 端点与凭据
 * @param request 已翻译成上游词汇的请求体
 * @returns 解码后的图片字节；`data` 里既没有 base64 也没有可下载地址时按上游失败处理
 * @throws {ImageGenerationError} `unconfigured` 表示没配端点；`upstream` 表示调用或响应有问题
 */
export async function postImageGeneration(
  config: ImageRequestConfig,
  request: UpstreamImageRequest,
): Promise<readonly UpstreamImage[]> {
  if (config.baseUrl.trim() === '') {
    throw new ImageGenerationError('unconfigured', '图片生成未配置：HUIYU_IMAGE_BASE_URL 为空')
  }
  const doFetch = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 超时与调用方取消合并：任一触发都要中断请求，否则一个卡住的上游会占满整个回合预算。
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])

  let response: Response
  try {
    response = await doFetch(endpointOf(config.baseUrl), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        n: request.count,
        // 直接要 base64：省掉一次下载往返，也避免临时 URL 过期导致偶发失败。
        response_format: 'b64_json',
      }),
    })
  } catch (cause: unknown) {
    if (signal.aborted) {
      throw new ImageGenerationError('upstream', request.signal?.aborted === true ? '图片生成已取消' : `图片生成超时（${timeoutMs} 毫秒）`, { cause })
    }
    throw new ImageGenerationError('upstream', '图片生成请求失败，请检查网络与 HUIYU_IMAGE_BASE_URL', { cause })
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    // 401/403 归到配置类：密钥错了与"没配密钥"对用户是同一件事——去改配置。
    const failure = response.status === 401 || response.status === 403 ? 'unconfigured' : 'upstream'
    throw new ImageGenerationError(failure, `图片生成失败（HTTP ${response.status}）：${reasonOf(response.status, text)}`)
  }

  return decodeResponse(text)
}

/** 上游响应体的形状（只声明用到的字段）。 */
interface UpstreamPayload {
  readonly data?: readonly {
    readonly b64_json?: unknown
    readonly url?: unknown
  }[]
}

/**
 * 解析上游响应。
 *
 * 只接受 `b64_json`：本站配置的就是这个协议，出现 URL 说明上游没按请求的 `response_format` 办，
 * 静默改成下载会让"为什么慢了一倍"无从解释。要支持 URL 形态的厂商（如火山方舟的某些型号）
 * 应当在它自己的适配器里下载，而不是放宽这里。
 */
function decodeResponse(text: string): readonly UpstreamImage[] {
  let payload: UpstreamPayload
  try {
    payload = JSON.parse(text) as UpstreamPayload
  } catch (cause: unknown) {
    throw new ImageGenerationError('upstream', `图片生成返回了无法解析的内容：${excerpt(text)}`, { cause })
  }
  const entries = payload.data
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ImageGenerationError('upstream', `图片生成没有返回图片：${excerpt(text)}`)
  }
  const images: UpstreamImage[] = []
  for (const entry of entries) {
    if (typeof entry.b64_json !== 'string' || entry.b64_json === '') {
      if (typeof entry.url === 'string' && entry.url !== '') {
        throw new ImageGenerationError('unsupported', '图片生成返回了下载地址而非图片数据，当前适配器只接受 base64（response_format: b64_json）')
      }
      throw new ImageGenerationError('upstream', '图片生成返回的条目里没有图片数据')
    }
    images.push({ data: decodeBase64(entry.b64_json), mediaType: 'image/png' })
  }
  return images
}

/**
 * 解码 base64。
 *
 * `Buffer.from(..., 'base64')` 对非法字符是**静默忽略**的，所以先做一次形状校验：
 * 否则一个被截断的响应会解出一张损坏的图片，错误推迟到用户打开时才暴露。
 */
function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new ImageGenerationError('upstream', '图片生成返回的数据不是合法的 base64')
  }
  const data = Buffer.from(normalized, 'base64')
  if (data.byteLength === 0) {
    throw new ImageGenerationError('upstream', '图片生成返回了空的图片数据')
  }
  return new Uint8Array(data)
}
