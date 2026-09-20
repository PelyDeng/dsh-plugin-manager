/**
 * 文件解析工具集。
 *
 * ## 四件工具，各管一类
 *
 * | 工具 | 入口 | 依赖 |
 * | --- | --- | --- |
 * | 纯文本 | `parseTextDocument`（`./text`） | 无 |
 * | PDF | `parsePdfDocument`（`./pdf`） | `pdfjs-dist` |
 * | DOCX | `parseDocxDocument`（`./docx`） | `yauzl` + `mammoth` |
 * | 图片 | `readImageDocument`（`./image`） | 一个支持图片的模型（调用方注入） |
 *
 * 四者互相独立、可以单独导入，产出同一种形状（`ParsedDocument`）。分成四个而不是一个
 * "万能解析器"，是因为它们的代价与失败方式完全不同：纯文本零依赖、PDF/DOCX 要装库、
 * 图片要调模型花钱。混在一起，只想读 txt 的调用方也得为另外三条路买单。
 *
 * 本文件另外提供 `parseDocument`：按字节判定种类后转给对应工具，给"用户随手丢了个文件进来"
 * 这种不知道是什么的场合用。它不做任何解析本身。
 *
 * ## 它解决什么
 *
 * "用户往聊天框里丢了一个文件"这件事，每个带输入框的 Agent 都会遇到，而**能读到内容**是后面
 * 一切的前提：读不到内容的附件只能原样转交，协调方拆不了任务，成员也干不了活。
 *
 * ## 谁在用
 *
 * 牛马聊天群（`dsh-butler-console`）与大总管派单的成员；智能体群组各子 Agent 的聊天页面将来
 * 直接复用。包名里的 `@dsh-agents-group/` 是**物理寄放位置**（私有共享包只能落在
 * `plugins/external/<项目>/packages/<包>` 这一层），不代表管家依赖了群组业务。
 *
 * ## 用之前要知道的四件事
 *
 * 1. **依赖动态加载**：PDF / DOCX 的第三方库用变量说明符 `import()`，消费方要自己把它们放进
 *    `dependencies`。缺依赖时报 `unavailable`——明确区分"部署没装"与"文件坏了"。
 * 2. **进程内解析**：不起 worker（原因见 README）。上限是唯一的保护，调用方应把 `maxBytes`
 *    按自己的容忍度调小。
 * 3. **不做 OCR**：图片走视觉模型（`readImageDocument`），扫描件 PDF 给 `no_text`。
 * 4. **单元是 1 起的**：`units[i].number` 就是"第几页/段/行/图"，`partial` 说明是否只解析了一部分。
 *
 * 用法：
 *
 * ```ts
 * // 知道是什么类型：直接用对应工具
 * const pdf = await parsePdfDocument({ name, bytes })
 *
 * // 不知道：交给分派器（图片需要一个读图调用）
 * const parsed = await parseDocument({ name, bytes }, { vision })
 * const { text, truncated } = renderDocumentText(parsed, 20000)
 * ```
 */

export * from './kinds.ts'
export * from './limits.ts'
export * from './budget.ts'
export * from './units.ts'
export * from './render.ts'
export * from './text.ts'
export * from './pdf.ts'
export * from './docx.ts'
export * from './image.ts'

import { DocumentParseError, resolveLimits, type DocumentLimits } from './limits.ts'
import { defaultLoader, type DocumentLoader } from './budget.ts'
import { detectDocumentKind, isTextKind } from './kinds.ts'
import { parseTextDocument } from './text.ts'
import { parsePdfDocument } from './pdf.ts'
import { parseDocxDocument } from './docx.ts'
import { readImageDocument, type VisionCall } from './image.ts'
import type { ParsedDocument } from './units.ts'

/** `parseDocument` 的入参。 */
export interface AnyParseInput {
  readonly name: string
  readonly bytes: Uint8Array
  /** 由调用方按字节核验过的媒体类型（图片会用）。 */
  readonly mediaType?: string | undefined
}

/** `parseDocument` 的可选项：四个工具的可选项合起来，用不到的那些会被忽略。 */
export interface AnyParseOptions {
  readonly limits?: Partial<DocumentLimits> | undefined
  readonly signal?: AbortSignal | undefined
  readonly load?: DocumentLoader | undefined
  /**
   * 读图调用。**不传时遇到图片直接报 `unsupported`**——这是有意的：调用方必须显式说明
   * "我愿意为读图花一次模型调用"，而不是让它悄悄发生。
   */
  readonly vision?: VisionCall | undefined
  readonly prompt?: string | undefined
  readonly allowedMediaTypes?: readonly string[] | undefined
}

/**
 * 按内容转给对应的解析工具。
 *
 * @throws DocumentParseError 各个工具的错误码，外加 `unsupported`（图片但没给读图调用、
 *   或这类文件读不出文字）。
 */
export async function parseDocument(
  input: AnyParseInput,
  options: AnyParseOptions = {},
): Promise<ParsedDocument> {
  const limits = resolveLimits(options.limits)
  const bytes = input.bytes
  if (bytes.length === 0) throw new DocumentParseError('empty', '文件是空的')
  if (bytes.length > limits.maxBytes) {
    throw new DocumentParseError('too_large', `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)} MiB`)
  }
  const kind = detectDocumentKind(input.name, bytes)
  const shared = {
    limits: options.limits,
    signal: options.signal,
    load: options.load ?? defaultLoader,
  }
  if (isTextKind(kind)) return parseTextDocument({ name: input.name, bytes }, shared)
  if (kind === 'pdf') return parsePdfDocument({ name: input.name, bytes }, shared)
  if (kind === 'docx') return parseDocxDocument({ name: input.name, bytes }, shared)
  if (kind === 'image') {
    if (options.vision === undefined) {
      throw new DocumentParseError('unsupported', '这是图片；要么把它直接交给支持图片的模型，要么提供读图调用')
    }
    return readImageDocument(
      { name: input.name, bytes, mediaType: input.mediaType },
      options.vision,
      {
        limits: options.limits,
        signal: options.signal,
        prompt: options.prompt,
        allowedMediaTypes: options.allowedMediaTypes,
      },
    )
  }
  throw new DocumentParseError('unsupported', '这类文件读不出文字，只能原样转交')
}

/** 包版本，用于确认内联生效（构建后不应依赖外部解析）。 */
export const DOCUMENT_PARSE_VERSION = '0.2.0'
