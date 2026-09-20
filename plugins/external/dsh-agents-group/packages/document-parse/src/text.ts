/**
 * 纯文本解析工具。
 *
 * 覆盖一切"字节本身就是文字"的输入：txt、日志、代码、配置，以及 md / csv / json / yaml /
 * xml / html。它**不需要任何依赖**，也不做格式转换——不做 HTML 去标签、不把 CSV 拆成表格、
 * 不把 JSON 展平。理由：这些都是**有损**变换，而损失掉的信息调用方往往还要用；只做形态核验
 * （json 必须是合法 json、文本必须是 UTF-8）与按行切分，其余交给模型。
 *
 * 单独一个工具而不是合进别的解析器：纯文本是最常走的那条路，它不该为 PDF / DOCX 的依赖付代价。
 */

import { resolveLimits, type DocumentLimits } from './limits.ts'
import { createBudget, type Budget } from './budget.ts'
import { detectDocumentKind, isTextKind, type DocumentKind } from './kinds.ts'
import { assertHasText, collectUnits, decodeUtf8, type ParsedDocument } from './units.ts'
import { DocumentParseError } from './limits.ts'

/** 入参：文件名与完整字节。 */
export interface TextParseInput {
  readonly name: string
  readonly bytes: Uint8Array
}

/** 纯文本解析的可选项。 */
export interface TextParseOptions {
  readonly limits?: Partial<DocumentLimits> | undefined
  readonly signal?: AbortSignal | undefined
}

/** 纯文本解析的实现（`parseTextDocument` 的同步内核，便于单元测试直接驱动）。 */
export function parseTextBytes(
  kind: DocumentKind,
  bytes: Uint8Array,
  limits: DocumentLimits,
  budget: Budget,
): ParsedDocument {
  const text = decodeUtf8(bytes)
  // NUL 说明这是二进制被当成文本送进来了。UTF-8 解码不会拦它（0x00 是合法编码），
  // 但它一定不是"文字"，放过去只会在下游变成一堆空字符。
  if (text.includes('\0')) throw new DocumentParseError('corrupt', '文件里含二进制内容，不是文本')
  if (kind === 'json') {
    try {
      JSON.parse(text)
    } catch {
      throw new DocumentParseError('corrupt', 'JSON 格式无效')
    }
  }
  budget.checkpoint()
  const parts = text.split(/\r?\n/u)
  const collected = collectUnits(parts, limits, budget)
  assertHasText(collected.units)
  return {
    kind,
    unit: '行',
    units: collected.units,
    totalUnits: parts.length,
    characters: collected.characters,
    partial: collected.partial,
  }
}

/**
 * 解析一份纯文本类文件。
 *
 * @throws DocumentParseError `empty` / `too_large` / `corrupt`（编码或格式）/ `no_text` /
 *   `unsupported`（这份文件不是纯文本类，走错了工具）/ `timeout` / `aborted`。
 */
export async function parseTextDocument(
  input: TextParseInput,
  options: TextParseOptions = {},
): Promise<ParsedDocument> {
  const limits = resolveLimits(options.limits)
  const bytes = input.bytes
  if (bytes.length === 0) throw new DocumentParseError('empty', '文件是空的')
  if (bytes.length > limits.maxBytes) {
    throw new DocumentParseError('too_large', `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)} MiB`)
  }
  const kind = detectDocumentKind(input.name, bytes)
  // 字节特征优先：一个名字叫 .txt 的 PDF 会在这里被挡下来，而不是解出一堆乱码。
  if (!isTextKind(kind)) {
    throw new DocumentParseError('unsupported', `这份文件按字节判定是 ${kind}，不是纯文本，请用对应的解析工具`)
  }
  return parseTextBytes(kind, bytes, limits, createBudget(limits, options.signal))
}
