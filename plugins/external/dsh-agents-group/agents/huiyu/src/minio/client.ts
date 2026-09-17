/**
 * 极简 S3 客户端：只做绘语需要的两件事——探测可用性、上传一个对象。
 *
 * 与 `sigv4.ts` 分开：那个文件是**纯算法**（输入相同则输出相同，可单独验证），本文件管
 * 网络与错误分类。
 *
 * ## 两个地址，不要混
 *
 * | 用途 | 取值 | 出处 |
 * | --- | --- | --- |
 * | 上传（写） | `endpoint`，内网地址，如 `http://127.0.0.1:3101` | `HUIYU_MINIO_ENDPOINT` |
 * | 访问（读） | `publicBaseUrl`，外网地址，如 `https://img.pelycloud.com` | `HUIYU_PUBLIC_BASE_URL` |
 *
 * **不能从 endpoint 推导对外地址**：内网地址拼出来的链接用户打不开，而那个错误会以"图片
 * 生成成功但看不到"的形式出现，很难反推到配置上。所以两个地址各自独立配置。
 */

import { HuiyuError } from '../errors.ts'
import { encodePath, signS3Request, signedRequestHeaders } from './sigv4.ts'

/** MinIO 连接配置。 */
export interface MinioConfig {
  /** 内网 S3 端点，不带尾斜杠。 */
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly accessKey: string
  readonly secretKey: string
  /** 外网访问前缀，不带尾斜杠。 */
  readonly publicBaseUrl: string
}

/** 客户端。 */
export interface MinioClient {
  /**
   * 探测端点与桶是否可用。
   *
   * **不抛出**：不可用是一种正常状态。用有界超时，避免一个不通的地址拖住就绪探针。
   */
  available(signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly error?: string }>
  /**
   * 上传一个对象。
   *
   * @param input 对象键、字节与媒体类型
   * @param signal 取消信号
   * @returns 对象键与**完整可访问地址**
   */
  put(input: { readonly key: string; readonly data: Uint8Array; readonly contentType: string }, signal?: AbortSignal): Promise<{ readonly key: string; readonly url: string }>
}

/** 探测与上传的超时。上传给足时间：一张高分辨率图可能几 MB。 */
const PROBE_TIMEOUT_MS = 5000
const PUT_TIMEOUT_MS = 60_000

/** 去掉首尾斜杠，避免拼出 `//`。 */
function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

/** 响应体截断成可放进错误消息的片段。 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/**
 * 建一个客户端。
 *
 * @param config 连接配置
 * @param fetchImpl 便于测试注入；缺省用全局 `fetch`
 * @param now 便于测试注入时间；缺省取当前时刻
 */
export function createMinioClient(
  config: MinioConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): MinioClient {
  const endpoint = config.endpoint.replace(/\/+$/, '')
  const bucket = stripSlashes(config.bucket)
  const publicBase = config.publicBaseUrl.replace(/\/+$/, '')

  /** 把对象键与桶拼成请求路径（键可以是多级）。 */
  const pathOf = (key: string): string => `/${bucket}/${stripSlashes(key)}`

  return {
    async available(signal) {
      // 用 HEAD 桶做探测：它不需要列出权限，也不产生计费读数。
      // 403 也算"端点与桶都在"——那说明请求打到了 S3 且它认得这个桶，只是这份凭据没权限，
      // 而权限问题会在 put 时以更明确的形式报出来。
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
      const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      try {
        const signed = signS3Request({
          method: 'HEAD',
          path: `/${bucket}`,
          query: '',
          headers: {},
          payload: new Uint8Array(0),
          accessKey: config.accessKey,
          secretKey: config.secretKey,
          region: config.region,
          service: 's3',
          now: now(),
          endpoint,
        })
        const response = await fetchImpl(`${endpoint}/${bucket}`, {
          method: 'HEAD',
          signal: merged,
          // 只发签过的头：`signS3Request` 补的 `x-amz-*` 必须与 `SignedHeaders` 一致。
          headers: signedRequestHeaders(signed),
        })
        if (response.ok || response.status === 403) return { ok: true }
        if (response.status === 404) return { ok: false, error: `MinIO 上不存在桶 ${bucket}（请先建桶并设为匿名只读）` }
        return { ok: false, error: `MinIO 探测失败：HTTP ${response.status}` }
      } catch (error: unknown) {
        if (merged.aborted) return { ok: false, error: `MinIO 探测超时（${PROBE_TIMEOUT_MS} 毫秒）：${endpoint} 不可达` }
        return { ok: false, error: `MinIO 不可达（${endpoint}）：${error instanceof Error ? error.message : String(error)}` }
      }
    },

    async put(input, signal) {
      const timeout = AbortSignal.timeout(PUT_TIMEOUT_MS)
      const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const path = pathOf(input.key)
      const signed = signS3Request({
        method: 'PUT',
        path,
        query: '',
        headers: { 'content-type': input.contentType },
        payload: input.data,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        region: config.region,
        service: 's3',
        now: now(),
        endpoint,
      })
      let response: Response
      try {
        response = await fetchImpl(`${endpoint}${encodePath(path)}`, {
          method: 'PUT',
          signal: merged,
          // 只发签过的头。把签名结果整个展开会把没进 `SignedHeaders` 的 `x-amz-*` 也发出去，
          // 那在规范上是另一种请求——服务端可以据此拒绝。
          headers: signedRequestHeaders(signed, { 'content-type': input.contentType }),
          body: input.data as unknown as BodyInit,
        })
      } catch (cause: unknown) {
        if (merged.aborted) {
          throw new HuiyuError('upstream', signal?.aborted === true ? '图片上传已取消' : `图片上传超时（${PUT_TIMEOUT_MS} 毫秒）`, { cause })
        }
        throw new HuiyuError('upstream', `图片上传失败：无法连接 ${endpoint}`, { cause })
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new HuiyuError('upstream', `图片上传失败（HTTP ${response.status}）：${excerpt(text)}`)
      }
      return { key: input.key, url: `${publicBase}/${bucket}/${stripSlashes(input.key)}` }
    },
  }
}
