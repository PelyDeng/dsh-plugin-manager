/**
 * 生图 provider 的装配与选择。
 *
 * 目前只有一个已实现的协议族：**OpenAI 兼容的 `/v1/images/generations`**。中转站与火山方舟
 * 都属于这个族（方舟的图片生成 API 是 OpenAI 兼容风格），差别只在端点与模型名——那两项是配置，
 * 不是代码分支。
 *
 * ⚠️ **`ark-images` 尚未用真实密钥验证**：它的端点路径与响应字段未经真机联调确认，所以
 * 只注册适配器、不宣称可用。在拿到密钥前它不出现在验收依据里（见设计文档 §6.3）。
 */

import type { HuiyuEnvironment } from '../env.ts'
import { createOpenAiImagesProvider, OPENAI_IMAGES_KIND } from './openai-images.ts'
import type { ImageGenerationProvider } from './spec.ts'

/**
 * 转出接缝类型。
 *
 * 消费侧（工具装配）只需要"有个 provider 能用"，不该被迫 import 到 `spec.ts`——那是接缝的
 * 内部结构。转出一次，依赖面就收敛在本文件。
 */
export type { ImageGenerationProvider } from './spec.ts'
export type { ImageGenerationSpec, ImageGenerationResult, GeneratedImage } from './spec.ts'

/** 火山方舟的适配器标识。与 `openai-images` 同族协议，但端点为方舟域名。 */
export const ARK_IMAGES_KIND = 'ark-images'

/** 已实现的 provider 标识。 */
export const KNOWN_IMAGE_PROVIDERS: readonly string[] = [OPENAI_IMAGES_KIND, ARK_IMAGES_KIND]

/**
 * 按配置建一个生图 provider。
 *
 * @param environment 绘语的私有配置（`HUIYU_IMAGE_*` 那一组）
 * @returns 与 `HUIYU_IMAGE_PROVIDER` 对应的 provider；未识别的取值按未配置处理
 */
export function createImageProvider(environment: HuiyuEnvironment): ImageGenerationProvider {
  const configured = environment.image.provider.trim()
  if (!KNOWN_IMAGE_PROVIDERS.includes(configured)) {
    // 不认识的取值**不回落**到默认适配器：配置写错时静默用另一个协议，错误会以"上游拒绝"
    // 的形式出现在很远的地方。这里当场说清合法取值。
    return {
      kind: configured === '' ? 'unconfigured' : configured,
      available: () => ({ ok: false, error: `HUIYU_IMAGE_PROVIDER 取值不被识别：${configured || '(空)'}；可用取值：${KNOWN_IMAGE_PROVIDERS.join(' / ')}` }),
      generate: () => Promise.reject(new Error(`HUIYU_IMAGE_PROVIDER 取值不被识别：${configured || '(空)'}`)),
    }
  }
  return createOpenAiImagesProvider({
    baseUrl: environment.image.baseUrl,
    apiKey: environment.image.apiKey,
    model: environment.image.model,
  })
}
