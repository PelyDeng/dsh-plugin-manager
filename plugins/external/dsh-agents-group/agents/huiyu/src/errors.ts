/**
 * 绘语的业务错误。
 *
 * HTTP 层按 {@link HuiyuError.status} 映射状态码。分成稳定的几类而不是让各种 Error 直接冒到
 * HTTP 层：只有本子包知道哪些错误是**可预期**的（参数不对是 400、上游挂了是 502、没配置是 503），
 * 用通用 500 兜底会让前端无法区分"我传错了"和"服务坏了"。
 */

/** 错误分类，与设计文档 §9 的错误口径一一对应。 */
export type HuiyuErrorKind =
  /** 参数校验失败。 */
  | 'invalid'
  /** 找不到目标，或调用方无权访问它。 */
  | 'not_found'
  /** 能力未配置（缺 env.conf 里的键、缺存储）。 */
  | 'unconfigured'
  /** 上游服务失败（生图、对象存储）。 */
  | 'upstream'
  /** 上游不支持本次请求。 */
  | 'unsupported'
  /** 服务正在停止或并发超限。 */
  | 'unavailable'

const STATUS: Readonly<Record<HuiyuErrorKind, number>> = {
  invalid: 400,
  not_found: 404,
  unconfigured: 503,
  upstream: 502,
  unsupported: 422,
  unavailable: 503,
}

/** 绘语的业务错误。`message` 直接面向用户，不放内部堆栈。 */
export class HuiyuError extends Error {
  readonly status: number

  constructor(readonly kind: HuiyuErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HuiyuError'
    this.status = STATUS[kind]
  }
}

/** 参数校验失败的快捷构造。 */
export function invalid(message: string, options?: ErrorOptions): HuiyuError {
  return new HuiyuError('invalid', message, options)
}

/** 判断一个值是不是本子包的错误（供 HTTP 错误渲染使用）。 */
export function isHuiyuError(value: unknown): value is HuiyuError {
  return value instanceof HuiyuError
}
