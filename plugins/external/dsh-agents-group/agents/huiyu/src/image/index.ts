/**
 * 生图 provider 的注册表与选取。
 *
 * ## 新增一家生图 API 时要改哪里
 *
 * **只改这个文件的一行**：写一个实现文件（自述 + 构造函数），在 {@link REGISTRY} 里加一条。
 * 选取逻辑、可用性判断、错误分类都不动。
 *
 * 所以这里**不许出现 `if (kind === '某家')`**：一旦有了第一家特判，第二家就会跟着抄一条，
 * 注册表也就退化成一串分支了。凡是要区分"这家怎么建、缺什么算不可用"的，都放进描述符，
 * 由适配器自己回答。
 *
 * ## 各家协议的差异由谁吸收
 *
 * 由适配器自己。已实现的两族差别很大——Ciyuan 是**异步任务制**（创建→轮询→下载），
 * OpenAI 兼容族是**同步响应**（一次调用拿 base64）。这个差异不该让上层看见：消费方只认
 * `ImageGenerationProvider.generate(spec) → 字节`。
 *
 * ## 密钥从哪来
 *
 * 由装配侧（`src/index.ts`）从 DSH 凭据系统取出，作为 {@link ImageProviderInput.apiKey}
 * 传进来。本模块不认识凭据服务，也不认识 `env.conf`——它只要一个字符串。
 */

import type { HuiyuEnvironment } from '../env.ts'
import { CIYUAN_DESCRIPTOR, CIYUAN_DEFAULT_BASE_URL, CIYUAN_KIND } from './ciyuan.ts'
import { createOpenAiImagesProvider, OPENAI_IMAGES_DESCRIPTOR, OPENAI_IMAGES_KIND } from './openai-images.ts'
import { ImageGenerationError, type ImageGenerationProvider, type ImageProviderDescriptor, type ImageProviderInput } from './spec.ts'

/** 火山方舟的适配器标识：与 OpenAI 兼容族同协议，但端点为方舟域名。**尚未真机验证**。 */
export const ARK_IMAGES_KIND = 'ark-images'

/**
 * 全部已注册的适配器。
 *
 * 顺序即配置界面与错误提示里的展示顺序。**加一家就在这里加一条**——这是新增 provider
 * 唯一需要改的地方（外加它自己的实现文件）。
 *
 * `ark-images` 与 OpenAI 兼容族同协议，差别只在端点，所以复用一个构造函数；但它的
 * `kind` 与展示名必须**各自声明**，不能靠展开另一个描述符来"继承"——那样建出来的实例
 * 会带着被展开那一家的 kind，注册表里就会出现两个看起来一样的条目。
 */
const REGISTRY: readonly ImageProviderDescriptor[] = [
  CIYUAN_DESCRIPTOR,
  OPENAI_IMAGES_DESCRIPTOR,
  {
    kind: ARK_IMAGES_KIND,
    displayName: '火山方舟（OpenAI 兼容风格，未验证）',
    unavailableReason: input => input.baseUrl.trim() === ''
      ? 'HUIYU_IMAGE_BASE_URL 未配置（方舟端点形如 https://ark.cn-beijing.volces.com）'
      : (input.model.trim() === '' ? 'HUIYU_IMAGE_MODEL 未配置' : (input.apiKey.trim() === '' ? '未取到方舟的 API 密钥' : undefined)),
    create: input => createOpenAiImagesProvider({
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      kind: ARK_IMAGES_KIND,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    }),
  },
]

/** 按 kind 索引，避免每处各写一次查表。 */
const BY_KIND: ReadonlyMap<string, ImageProviderDescriptor> = new Map(REGISTRY.map(entry => [entry.kind, entry]))

/** 已注册的 provider 标识，供错误提示与文档引用。 */
export const KNOWN_IMAGE_PROVIDERS: readonly string[] = REGISTRY.map(entry => entry.kind)

/** 未知取值时的占位 provider：可用性检查与生成都明确拒绝。 */
function unknownProvider(configured: string): ImageGenerationProvider {
  const message = `HUIYU_IMAGE_PROVIDER 取值不被识别：${configured === '' ? '(空)' : configured}；可用取值：${KNOWN_IMAGE_PROVIDERS.join(' / ')}`
  return {
    kind: configured === '' ? 'unconfigured' : configured,
    available: () => ({ ok: false, error: message }),
    generate: () => Promise.reject(new ImageGenerationError('unconfigured', message)),
  }
}

/**
 * 按配置建一个生图 provider。
 *
 * @param environment 绘语的私有配置（`HUIYU_IMAGE_*` 那一组）
 * @param apiKey 生图密钥，由装配侧从 DSH 凭据系统取出；`env.conf` 里显式给了值时以它为准
 * @param fetchImpl 便于测试注入网络实现
 * @returns 与 `HUIYU_IMAGE_PROVIDER` 对应的 provider；未知取值返回一律拒绝的占位
 */
export function createImageProvider(
  environment: HuiyuEnvironment,
  apiKey: string,
  fetchImpl?: typeof fetch,
): ImageGenerationProvider {
  const configured = environment.image.provider.trim()
  const descriptor = BY_KIND.get(configured)
  if (descriptor === undefined) return unknownProvider(configured)

  const input: ImageProviderInput = {
    baseUrl: environment.image.baseUrl,
    model: environment.image.model,
    // `env.conf` 里显式给了密钥就用它（独立开发环境），否则用凭据系统取来的。
    apiKey: environment.image.apiKey.trim() === '' ? apiKey : environment.image.apiKey,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }
  // 缺配置时**不建** provider：把"缺什么"留在描述符里回答，构造出来的实例只负责可用时的行为。
  // 仍然返回一个拒绝一切的对象，好让工具拿到稳定的错误而不是 `undefined` 崩溃。
  const reason = descriptor.unavailableReason(input)
  if (reason !== undefined) {
    return {
      kind: descriptor.kind,
      available: () => ({ ok: false, error: reason }),
      generate: () => Promise.reject(new ImageGenerationError('unconfigured', `图片生成未配置：${reason}`)),
    }
  }
  return descriptor.create(input)
}

/** 已实现适配器的展示名，供页面与诊断使用。 */
export function describeImageProviders(): readonly { readonly kind: string; readonly displayName: string }[] {
  return REGISTRY.map(entry => ({ kind: entry.kind, displayName: entry.displayName }))
}

export { CIYUAN_DEFAULT_BASE_URL, CIYUAN_KIND }
export type { ImageGenerationProvider, ImageProviderDescriptor }
