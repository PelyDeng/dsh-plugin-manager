/**
 * 解析上限与错误码。
 *
 * 上限全部有缺省值，但**每一个都可以被调用方收紧**：宿主不同、部署的机器不同，同一个数字
 * 不会到处都合适。调用方传进来的值只做覆盖，不做"更严格才生效"的猜测——它说多少就是多少。
 *
 * 错误码是给程序分支用的，`message` 是给人看的。调用方按 `code` 决定 HTTP 状态与页面文案，
 * 不要去解析 `message` 的措辞。
 */

/** 单文件字节上限缺省值（16 MiB）。 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

/**
 * 归档展开后的总量上限缺省值（64 MiB）。
 *
 * 与单文件上限不是一回事：一个几百 KB 的 DOCX 解开可以有几个 GB（zip 炸弹）。所以压缩包
 * 必须按**展开后**的字节数来卡，不能按上传的大小卡。
 */
export const DEFAULT_MAX_EXPANDED_BYTES = 64 * 1024 * 1024

/** 归档内条目数上限缺省值：正常 DOCX 几十个条目，两千个已经不正常了。 */
export const DEFAULT_MAX_ENTRIES = 2000

/** 解析单元数上限缺省值（页 / 段 / 行）。 */
export const DEFAULT_MAX_UNITS = 10000

/** 正文字符数上限缺省值。 */
export const DEFAULT_MAX_CHARACTERS = 240000

/** PDF 最多读多少页。 */
export const DEFAULT_MAX_PDF_PAGES = 200

/**
 * 解析的时间预算缺省值（30 秒）。
 *
 * 这是**协作式**的：在页与页、单元与单元之间检查，不会打断一次已经在跑的解析调用。
 * 进程内解析（见 README「为什么不起 worker」）本来就没法强杀，与其假装能超时中断，
 * 不如把预算用在"不要把剩下的页读完"这件事上。
 */
export const DEFAULT_TIMEOUT_MS = 30000

/** 一次解析的上限。 */
export interface DocumentLimits {
  readonly maxBytes: number
  readonly maxExpandedBytes: number
  readonly maxEntries: number
  readonly maxUnits: number
  readonly maxCharacters: number
  readonly maxPdfPages: number
  readonly timeoutMs: number
}

/** 缺省上限。 */
export const DEFAULT_LIMITS: DocumentLimits = {
  maxBytes: DEFAULT_MAX_BYTES,
  maxExpandedBytes: DEFAULT_MAX_EXPANDED_BYTES,
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxUnits: DEFAULT_MAX_UNITS,
  maxCharacters: DEFAULT_MAX_CHARACTERS,
  maxPdfPages: DEFAULT_MAX_PDF_PAGES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
}

/** 解析失败的原因分类。 */
export type DocumentParseCode =
  /** 一个字节都没有。 */
  | 'empty'
  /** 超过 `maxBytes`。在解析之前就判，不会读进内存再判。 */
  | 'too_large'
  /** 这种格式这个包不解析（例如 xlsx、zip）。原文件仍然可以保存与转交，只是读不出文字。 */
  | 'unsupported'
  /** 需要的外部依赖没装。**不是**调用方的错，也不是文件的错——如实说明，别报成"文件坏了"。 */
  | 'unavailable'
  /** 文件本身坏了：结构不符合它的格式。 */
  | 'corrupt'
  /** 加密或带宏：不解析（带宏的文档是主动拒绝，不是读不动）。 */
  | 'encrypted'
  /** 格式对、也读出来了，但里面没有文字（例如没有文本层的扫描件 PDF）。 */
  | 'no_text'
  /** 超过时间预算。 */
  | 'timeout'
  /** 调用方中止。 */
  | 'aborted'

/** 一次解析失败。 */
export class DocumentParseError extends Error {
  constructor(
    readonly code: DocumentParseCode,
    message: string,
  ) {
    super(message)
    this.name = 'DocumentParseError'
  }
}

/** 判定一个异常是不是本包抛的。跨打包副本时 `instanceof` 会失效，所以也认 `code` 字段。 */
export function isDocumentParseError(value: unknown): value is DocumentParseError {
  if (value instanceof DocumentParseError) return true
  const candidate = value as { readonly name?: unknown; readonly code?: unknown } | null
  return candidate !== null
    && typeof candidate === 'object'
    && candidate.name === 'DocumentParseError'
    && typeof candidate.code === 'string'
}

/** 把调用方给的部分上限补齐成完整上限。 */
export function resolveLimits(overrides: Partial<DocumentLimits> | undefined): DocumentLimits {
  if (overrides === undefined) return DEFAULT_LIMITS
  return {
    maxBytes: overrides.maxBytes ?? DEFAULT_LIMITS.maxBytes,
    maxExpandedBytes: overrides.maxExpandedBytes ?? DEFAULT_LIMITS.maxExpandedBytes,
    maxEntries: overrides.maxEntries ?? DEFAULT_LIMITS.maxEntries,
    maxUnits: overrides.maxUnits ?? DEFAULT_LIMITS.maxUnits,
    maxCharacters: overrides.maxCharacters ?? DEFAULT_LIMITS.maxCharacters,
    maxPdfPages: overrides.maxPdfPages ?? DEFAULT_LIMITS.maxPdfPages,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
  }
}
