/**
 * 图像生成的 provider 接缝。
 *
 * ## 为什么必须自建
 *
 * 宿主的 `llm` 服务是**对话模型**的适配器注册表：它的模态枚举只有 `'text' | 'image'`，
 * 且都是**输入**模态。宿主没有任何图像生成接口，也没有可以挂载图像生成适配器的位置。
 * 所以照本项目已有的口径（`dsh-shell` 的 request/spec 分离）自建一个，三个角色齐全：
 * Definition（本文件）、Provider（各厂商适配器）、Consumer（绘语的生图工具）。
 *
 * ## 契约要点
 *
 * - **请求规格的默认值在调用侧解析**，provider 不猜、不补默认值；
 * - `generate` **一律返回已解码的字节**，不把上游的临时 URL 往外抛——临时 URL 的有效期、
 *   鉴权头、重定向行为都是厂商特有的实现细节，往外抛会让消费侧被迫了解这些差异，接缝就漏了；
 * - **不支持的能力显式报错，不静默降级**。质量档位做不到就说做不到，不能悄悄按别的档位生成
 *   然后让用户以为拿到的是他要的东西。
 */

/** 一次图像生成的请求规格。字段全部必填：默认值由调用侧解析好。 */
export interface ImageGenerationSpec {
  readonly prompt: string
  /** 具体尺寸，形如 `1024x1024`。调用侧负责把「横幅」这类语义翻译成具体尺寸。 */
  readonly size: string
  /**
   * 质量档位。
   *
   * 这是**本接口的归一化词汇**，不是任何厂商的枚举值：provider 负责翻译成自家取值，
   * 翻译不了就抛 {@link ImageGenerationError}，不要挑一个相近的档位代替。
   */
  readonly quality: 'standard' | 'high'
  readonly count: number
  readonly signal?: AbortSignal
}

/** 一张生成出来的图片。 */
export interface GeneratedImage {
  readonly data: Uint8Array
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
}

/** 一次生成的结果。 */
export interface ImageGenerationResult {
  readonly images: readonly GeneratedImage[]
  /** 实际使用的模型标识；落库存档、便于算账与排查。 */
  readonly model: string
}

/**
 * 生成失败的分类。
 *
 * 分成三类而不是一个笼统的错误：HTTP 层要按它给不同的状态码，而"缺配置"（503）与
 * "上游挂了"（502）在运维上是完全不同的两件事。
 */
export type ImageGenerationFailure =
  /** provider 未配置或凭据不可用。 */
  | 'unconfigured'
  /** 上游拒绝或返回了无法理解的内容。 */
  | 'upstream'
  /** 上游不支持本次请求的某个参数。 */
  | 'unsupported'

/** 生图失败。`message` 直接面向用户，不要放内部堆栈。 */
export class ImageGenerationError extends Error {
  constructor(readonly failure: ImageGenerationFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageGenerationError'
  }
}

/** 一个图像生成 provider。 */
export interface ImageGenerationProvider {
  /** 适配器标识，与配置里的 `HUIYU_IMAGE_PROVIDER` 对应。 */
  readonly kind: string
  /**
   * 该 provider 当前是否可用（地址、模型、密钥是否齐备）。
   *
   * 就绪探针读它。**不得抛出**：不可用是一种正常状态，不是异常。
   */
  available(): { readonly ok: boolean; readonly error?: string }
  /**
   * 生成图片。
   *
   * @param spec 已解析好默认值的请求规格
   * @returns 解码后的图片字节与实际使用的模型
   * @throws {ImageGenerationError} 配置缺失、上游失败或能力不支持
   */
  generate(spec: ImageGenerationSpec): Promise<ImageGenerationResult>
}
