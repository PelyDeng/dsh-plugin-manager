/**
 * 解析的产出形状与共用的切分逻辑。
 *
 * ## 为什么是"单元"而不是一整段字符串
 *
 * 调用方几乎从不需要整份文件：给模型的上下文有上限，给用户的预览只显示前几段，有的业务还让
 * 用户挑"只发第 3 到第 5 页"。所以解析的产出是**带编号的单元序列**加一个 `totalUnits`——
 * 有编号才能说清"给你的是哪一部分"，有总数才能说清"还有多少没给"。
 *
 * ## `partial` 是如实标注，不是错误
 *
 * 超过上限时**不抛错**，返回已经解析出来的部分并把 `partial` 置为 true。理由：用户上传一份
 * 300 页的 PDF，想做的事通常是"让管家看看前面这部分"，为此把整个上传判失败是帮倒忙。
 * 但也不能假装解析完了——`partial` 让调用方能如实告诉用户"只读了前 200 页"。
 */

import { DocumentParseError, type DocumentLimits } from './limits.ts'
import type { DocumentKind } from './kinds.ts'
import type { Budget } from './budget.ts'

/** 一个可选择的解析单元。`number` 从 1 开始，是"第几页/第几段/第几行"。 */
export interface ParsedUnit {
  readonly number: number
  readonly text: string
}

/** 一份文件的解析结果。三个解析工具产出同一种形状，调用方不必分类型处理。 */
export interface ParsedDocument {
  readonly kind: DocumentKind
  /** 单元的名字，用于拼"共 N 页"这类文案。 */
  readonly unit: string
  readonly units: readonly ParsedUnit[]
  /** 文件里一共有多少个单元（**不是**返回了多少个）。 */
  readonly totalUnits: number
  /** 返回的正文总字符数。 */
  readonly characters: number
  /** 是否只解析了一部分。 */
  readonly partial: boolean
}

/**
 * 把若干段文字按上限收成单元序列。
 *
 * @param parts 已经切好的段落（文本按行、DOCX 按段、PDF 按页）。
 * @returns `total` 是**切分后的总数**，不是收下的数量。
 */
export function collectUnits(
  parts: readonly string[],
  limits: DocumentLimits,
  budget: Budget,
): { units: ParsedUnit[]; characters: number; partial: boolean } {
  const units: ParsedUnit[] = []
  let characters = 0
  let partial = false
  for (const [index, part] of parts.entries()) {
    budget.checkpoint()
    if (characters + part.length > limits.maxCharacters || units.length >= limits.maxUnits) {
      partial = true
      break
    }
    units.push({ number: index + 1, text: part })
    characters += part.length
  }
  if (!partial && units.length < parts.length) partial = true
  return { units, characters, partial }
}

/** 严格解码 UTF-8；解不开就是编码不对，明说，别拿乱码糊过去。 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DocumentParseError('corrupt', '仅支持 UTF-8 编码的文本，请转换编码后重试')
  }
}

/** 整份文件里一段文字都没有时的统一拒绝。 */
export function assertHasText(units: readonly ParsedUnit[], message = '文件里没有可读取的文字'): void {
  if (!units.some(unit => unit.text.trim() !== '')) throw new DocumentParseError('no_text', message)
}

/**
 * 把第三方解析库自己抛的异常归到 `corrupt`。
 *
 * 对用户来说"这个文件读不出来"就是一句话，PDF 库内部那句 `Invalid PDF structure` 只会让人以为
 * 是自己操作错了。已经带错误码的（超时、中止、缺依赖）原样放过——那些不是文件的问题。
 */
export async function asCorrupt<T>(run: () => Promise<T>, message: string): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof DocumentParseError) throw error
    throw new DocumentParseError('corrupt', message)
  }
}
