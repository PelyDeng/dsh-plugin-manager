/**
 * Ciyuan 渠道的图像生成适配器（异步任务制）。
 *
 * ## 与 OpenAI 那套的区别：这里是**任务**，不是一次响应
 *
 * | 步骤 | 请求 | 拿到什么 |
 * | --- | --- | --- |
 * | 1. 创建 | `POST /v1/images/generations` | `{ id: jobId, status: 'queued' }` |
 * | 2. 轮询 | `GET /v1/image-jobs/<id>` | `status: queued \| running \| succeeded \| failed` |
 * | 3. 取图 | `result.data[0].url` | 再下载一次才是字节 |
 *
 * 所以**不能**照 OpenAI 那样一次调用就返回图片。这条链路的每一步都有自己的失败方式，
 * 本文件把它们分开处理，也分开报告——"创建被拒"与"生成到一半失败"对用户是两件事。
 *
 * ## 协议来源
 *
 * 对齐仓库内已验证可用的 `ciyuan-image-smoke.mjs`（它真实请求过 `gpt-image-2` 并产出图片）。
 * 三处细节照它来，不要凭 OpenAI 的直觉改：
 *
 * - 创建响应的任务 id 在 **`id`** 字段（不要去轮询响应里反推）；
 * - 刚创建的任务**可能短暂返回 404**，15 秒宽限期内要重试而不是当失败；
 * - 图片要先拿到 `url` 再下载一次，字节不在轮询响应里。
 *
 * ## 图生图不在本适配器里
 *
 * Ciyuan 另有 `/v1/images/edits`（multipart）支持传入参考图。绘语当前的工具集不做图生图，
 * 所以没有实现它——**留着而不是顺手加上**：一条没被任何工具走过、也没有测试覆盖的路径，
 * 加进来只会让"它到底通不通"变成未知数。
 */

import type {
  GeneratedImage,
  ImageGenerationProvider,
  ImageGenerationResult,
  ImageGenerationSpec,
  ImageProviderDescriptor,
  ImageProviderInput,
} from './spec.ts'
import { ImageGenerationError } from './spec.ts'

/** 本适配器的固定标识，与配置里的 `HUIYU_IMAGE_PROVIDER` 对应。 */
export const CIYUAN_KIND = 'ciyuan-images'

/** Ciyuan 的默认端点。真实调用验证过这个域名。 */
export const CIYUAN_DEFAULT_BASE_URL = 'https://img.ciyuan.fast'

/** 轮询间隔与整体超时。生成一张高分辨率图通常十几秒到一分钟，排队高峰会到三分钟上下。 */
const POLL_INTERVAL_MS = 3000
/**
 * 内层预算（单个任务的创建+轮询+下载）。要和 participant 层的外层协作预算错开
 * （见 huiyu 的 `TURN_TIMEOUT_MS`）：外层从接单起算、先烧完，等长会让内层那个
 * 更精确的"生图超时"永远轮不到报——线上只能看到笼统的"协作超时"。
 */
const DEFAULT_TIMEOUT_MS = 300_000
/** 多张图并行的单批上限。4 路并行实测安全；再多分批排队，不一次性烧爆渠道配额。 */
const MAX_PARALLEL_JOBS = 4
/** 刚创建的任务可能短暂 404，这段宽限期内重试。 */
const NOT_FOUND_GRACE_MS = 15_000

export interface CiyuanOptions extends ImageProviderInput {
  readonly timeoutMs?: number
  /** 便于测试注入；缺省用真实时钟。 */
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** 创建任务的响应。只声明用到的字段。 */
interface CreatePayload {
  readonly id?: unknown
  readonly status?: unknown
}

/** 轮询任务的响应。 */
interface JobPayload {
  readonly status?: unknown
  readonly result?: { readonly data?: readonly { readonly url?: unknown }[] }
}

/** 轮询过程中认识的状态。`succeeded` 与 `failed` 是终态，其余继续等。 */
const TERMINAL_FAILED = 'failed'

/** 截断响应体，供错误消息使用。不整段回显，避免把上游长正文带进日志。 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/**
 * 建一个 Ciyuan 图像生成 provider。
 *
 * @param options 端点、模型与密钥
 */
export function createCiyuanProvider(options: CiyuanOptions): ImageGenerationProvider {
  const base = options.baseUrl.trim().replace(/\/+$/, '')
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? (ms => new Promise<void>(done => { setTimeout(done, ms) }))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const available = (): { ok: boolean; error?: string } => {
    if (base === '') return { ok: false, error: 'HUIYU_IMAGE_BASE_URL 未配置' }
    if (options.model.trim() === '') return { ok: false, error: 'HUIYU_IMAGE_MODEL 未配置' }
    // 密钥的缺失由凭据系统那一侧报告，这里只说"没拿到密钥"——不猜它本该在哪配。
    if (options.apiKey.trim() === '') return { ok: false, error: '未取到 Ciyuan 的 API 密钥（DSH 凭据 CIYUAN_API_KEY 未配置）' }
    return { ok: true }
  }

  /** 发一次带鉴权的请求并解析 JSON。 */
  const call = async (path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> => {
    let response: Response
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        redirect: 'error',
        signal,
        headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json', ...(init.headers ?? {}) },
      })
    } catch (cause: unknown) {
      throw new ImageGenerationError('upstream', `Ciyuan 请求失败（${path}）`, { cause })
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      // 401/403 归到配置类：密钥错了与没配密钥对用户是同一件事——去改凭据。
      const failure = response.status === 401 || response.status === 403 ? 'unconfigured' : 'upstream'
      throw new ImageGenerationError(failure, `Ciyuan 返回 HTTP ${response.status}：${excerpt(text)}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch (cause: unknown) {
      throw new ImageGenerationError('upstream', `Ciyuan 返回的不是 JSON：${excerpt(text)}`, { cause })
    }
  }

  return {
    kind: CIYUAN_KIND,
    available,

    async generate(spec: ImageGenerationSpec): Promise<ImageGenerationResult> {
      const state = available()
      if (!state.ok) throw new ImageGenerationError('unconfigured', `图片生成未配置：${state.error ?? '缺少必要参数'}`)
      const signal = spec.signal ?? AbortSignal.timeout(timeoutMs)

      /**
       * 一个单图任务从创建到拿到图片地址。每个任务固定 `n: 1`——渠道的任务制一次 job
       * 只稳定产出一张图，多张靠多个任务并行（分批上限 {@link MAX_PARALLEL_JOBS}）。
       */
      const runOne = async (): Promise<readonly string[]> => {
        // ---- 第一步：创建任务 ----
        const created = await call('/v1/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: options.model, prompt: spec.prompt, size: spec.size, n: 1 }),
        }, signal) as CreatePayload
        const jobId = typeof created.id === 'string' ? created.id : ''
        if (jobId === '') {
          throw new ImageGenerationError('upstream', `Ciyuan 创建任务未返回 id：${excerpt(JSON.stringify(created))}`)
        }

        // ---- 第二步：轮询到终态 ----
        const deadline = now() + timeoutMs
        const graceUntil = now() + NOT_FOUND_GRACE_MS
        let job: JobPayload
        for (;;) {
          try {
            job = await call(`/v1/image-jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, signal) as JobPayload
          } catch (error: unknown) {
            // 刚创建的任务可能短暂 404：宽限期内继续等，超过后按原错误失败。
            if (now() < graceUntil && error instanceof ImageGenerationError && error.message.includes('HTTP 404')) {
              await sleep(POLL_INTERVAL_MS)
              continue
            }
            throw error
          }
          const status = typeof job.status === 'string' ? job.status : ''
          if (status === 'succeeded') break
          if (status === TERMINAL_FAILED) {
            throw new ImageGenerationError('upstream', `Ciyuan 生图任务失败：${excerpt(JSON.stringify(job))}`)
          }
          if (now() >= deadline) {
            throw new ImageGenerationError('upstream', `Ciyuan 生图超时（${Math.round(timeoutMs / 1000)} 秒，任务 ${jobId} 最后状态 ${status || '未知'}）`)
          }
          await sleep(POLL_INTERVAL_MS)
        }

        // ---- 拿到图片地址 ----
        const urls = (job.result?.data ?? [])
          .map(entry => (typeof entry.url === 'string' ? entry.url : ''))
          .filter(url => url !== '')
        if (urls.length === 0) {
          throw new ImageGenerationError('upstream', `Ciyuan 任务成功但没有返回图片地址：${excerpt(JSON.stringify(job))}`)
        }
        return urls
      }

      /**
       * 多张 = 多个单图任务并行（一批最多 {@link MAX_PARALLEL_JOBS} 路，再多分批排队——
       * 并行路数实测 4 路安全，也不一次性烧爆渠道配额）。批内任何一路失败整轮失败，
       * 与单张语义一致，不交付"缺几张"的结果。
       */
      const count = Math.max(1, Math.floor(spec.count))
      const urls: string[] = []
      for (let done = 0; done < count; done += MAX_PARALLEL_JOBS) {
        const size = Math.min(MAX_PARALLEL_JOBS, count - done)
        const batch = await Promise.all(Array.from({ length: size }, () => runOne()))
        for (const part of batch) urls.push(...part)
      }

      // ---- 第三步：并行下载图片 ----
      const images = await Promise.all(urls.map(async url => {
        let response: Response
        try {
          response = await doFetch(url, { redirect: 'error', signal })
        } catch (cause: unknown) {
          throw new ImageGenerationError('upstream', '下载 Ciyuan 生成的图片失败', { cause })
        }
        if (!response.ok) {
          throw new ImageGenerationError('upstream', `下载 Ciyuan 生成的图片失败：HTTP ${response.status}`)
        }
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (buffer.byteLength === 0) {
          throw new ImageGenerationError('upstream', 'Ciyuan 返回了空的图片数据')
        }
        return { data: buffer, mediaType: mediaTypeOf(response.headers.get('content-type')) } satisfies GeneratedImage
      }))
      return { model: options.model, images }
    },
  }
}

/** 收窄下载响应的媒体类型。上游一般给 image/png，缺声明时按 PNG 处理。 */
function mediaTypeOf(raw: string | null): GeneratedImage['mediaType'] {
  const value = (raw ?? '').split(';')[0]?.trim().toLowerCase()
  return value === 'image/jpeg' ? 'image/jpeg' : value === 'image/webp' ? 'image/webp' : 'image/png'
}

/**
 * 本适配器的自述。注册表按 `kind` 查它，**不做任何 `if (kind === ...)` 判断**。
 */
export const CIYUAN_DESCRIPTOR: ImageProviderDescriptor = {
  kind: CIYUAN_KIND,
  displayName: 'Ciyuan 渠道（gpt-image 系）',
  unavailableReason: (input) => {
    // 端点空时用默认值，所以只要求模型与密钥。密钥的缺失说清"去哪配"，不说"没配置"就完事。
    if (input.model.trim() === '') return 'HUIYU_IMAGE_MODEL 未配置'
    if (input.apiKey.trim() === '') return '未取到 Ciyuan 的 API 密钥（DSH 凭据 CIYUAN_API_KEY 未配置）'
    return undefined
  },
  create: input => createCiyuanProvider({
    ...input,
    // 端点留空时用默认域名：它是这一家的固定入口，不值得要求每份配置都抄一遍。
    baseUrl: input.baseUrl.trim() === '' ? CIYUAN_DEFAULT_BASE_URL : input.baseUrl,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  }),
}
