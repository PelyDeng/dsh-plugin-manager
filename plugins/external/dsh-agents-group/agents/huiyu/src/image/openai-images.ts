/**
 * OpenAI 兼容协议的图像生成适配器。
 *
 * 覆盖中转站（ChatGPT image 系）以及任何照 OpenAI `/v1/images/generations` 实现的服务：
 * 请求体带 `response_format: 'b64_json'`，直接从响应里拿 base64 解码，省掉一次下载往返。
 *
 * 上游协议细节集中在 `request.ts`，本文件只管"把配置与规格翻译成一次调用，再把响应翻译回
 * 本接缝的词汇"。
 */

import type {
  GeneratedImage,
  ImageGenerationProvider,
  ImageGenerationResult,
  ImageGenerationSpec,
  ImageProviderDescriptor,
} from './spec.ts'
import { ImageGenerationError } from './spec.ts'
import { postImageGeneration, type ImageRequestConfig } from './request.ts'

/** 本适配器的固定标识，与配置里的 `HUIYU_IMAGE_PROVIDER` 对应。 */
export const OPENAI_IMAGES_KIND = 'openai-images'

/**
 * 把归一化的质量档位翻译成 OpenAI 的取值。
 *
 * `gpt-image-1` 系接受 `low` / `medium` / `high` / `auto`。本站只暴露标准与高质量两档，
 * 映射关系写死在这里，不让调用侧感知上游词汇。
 */
function upstreamQuality(quality: ImageGenerationSpec['quality']): string {
  return quality === 'high' ? 'high' : 'medium'
}

/** 校验并收窄上游声明的媒体类型。 */
function mediaTypeOf(raw: unknown): GeneratedImage['mediaType'] {
  return raw === 'image/jpeg' || raw === 'image/webp' ? raw : 'image/png'
}

export interface OpenAiImagesOptions extends ImageRequestConfig {
  readonly model: string
  /**
   * 覆盖实例上报的 kind。
   *
   * 同族的其他渠道（如火山方舟）复用本构造函数，但它们在注册表里有**自己的** kind——实例
   * 上报成 `openai-images` 会让注册表里出现两个看起来一样的条目，配置界面与错误提示都会
   * 指向错的那一家。
   */
  readonly kind?: string
}

/**
 * 建一个 OpenAI 兼容的图像生成 provider。
 *
 * @param options 端点、凭据与模型；`apiKey` 为空表示未配置
 */
export function createOpenAiImagesProvider(options: OpenAiImagesOptions): ImageGenerationProvider {
  const kind = options.kind ?? OPENAI_IMAGES_KIND
  const available = (): { ok: boolean; error?: string } => {
    if (options.baseUrl.trim() === '') return { ok: false, error: 'HUIYU_IMAGE_BASE_URL 未配置' }
    if (options.model.trim() === '') return { ok: false, error: 'HUIYU_IMAGE_MODEL 未配置' }
    if (options.apiKey.trim() === '') return { ok: false, error: 'HUIYU_IMAGE_API_KEY 未配置' }
    return { ok: true }
  }

  return {
    kind,
    available,
    async generate(spec: ImageGenerationSpec): Promise<ImageGenerationResult> {
      const state = available()
      if (!state.ok) {
        throw new ImageGenerationError('unconfigured', `图片生成未配置：${state.error ?? '缺少必要参数'}`)
      }
      const images = await postImageGeneration(options, {
        prompt: spec.prompt,
        model: options.model,
        size: spec.size,
        quality: upstreamQuality(spec.quality),
        count: spec.count,
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      })
      return {
        model: options.model,
        images: images.map(image => ({ data: image.data, mediaType: mediaTypeOf(image.mediaType) })),
      }
    },
  }
}

/**
 * 本适配器的自述。
 *
 * 与 Ciyuan 的差别只在这里声明，选择逻辑不看 kind：本家**必须**给端点（它服务的是任意兼容
 * 实现，没有"默认域名"这回事），且要求密钥。
 */
export const OPENAI_IMAGES_DESCRIPTOR: ImageProviderDescriptor = {
  kind: OPENAI_IMAGES_KIND,
  displayName: 'OpenAI 兼容（/v1/images/generations）',
  unavailableReason: (input) => {
    if (input.baseUrl.trim() === '') return 'HUIYU_IMAGE_BASE_URL 未配置（本适配器没有默认端点）'
    if (input.model.trim() === '') return 'HUIYU_IMAGE_MODEL 未配置'
    if (input.apiKey.trim() === '') return '未取到 API 密钥'
    return undefined
  },
  create: input => createOpenAiImagesProvider({
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  }),
}
