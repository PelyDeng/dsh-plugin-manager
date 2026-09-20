/**
 * 把解析结果拼成给模型看的一段文字。
 *
 * 有意做得极简：只做"按顺序拼接 + 到上限就停"。不加单元编号、不加小标题、不做缩进——
 * 那些都要占字符预算，而预算的用途是让模型看到**内容**。需要按页/段引用时，调用方拿
 * `ParsedDocument.units` 自己拼（它有编号）。
 */

import type { ParsedDocument } from './units.ts'

/** {@link renderDocumentText} 的结果。 */
export interface RenderedDocumentText {
  readonly text: string
  /** 是否因为 `limit` 而没把解析出的单元全放进去。 */
  readonly truncated: boolean
}

/**
 * 拼接解析结果。
 *
 * @param parsed 任一解析工具的产出。
 * @param limit 字符上限。计数含自己插入的换行，所以结果长度一定不超过它。
 */
export function renderDocumentText(parsed: ParsedDocument, limit: number): RenderedDocumentText {
  const parts: string[] = []
  // `used` 记的是**拼接后**的长度，包含自己加的那个换行：只算正文长度会让结果比 `limit`
  // 长出"单元数 - 1"个字符，而调用方是按 `limit` 分配预算的。
  let used = 0
  let truncated = false
  for (const unit of parsed.units) {
    const text = unit.text.trim()
    if (text === '') continue
    const separator = parts.length === 0 ? 0 : 1
    if (used + separator + text.length > limit) {
      truncated = true
      // 还剩一点空间时给它一个开头，比整段丢掉有用；一点都不剩就直接停。
      const room = limit - used - separator
      if (room > 0) parts.push(text.slice(0, room))
      break
    }
    parts.push(text)
    used += separator + text.length
  }
  if (parsed.partial) truncated = true
  return { text: parts.join('\n'), truncated }
}

/**
 * 一句话说明这份解析的规模，例如「12 段，4821 字」或「前 30 页，共 240 页，12480 字」。
 *
 * 给用户和模型看的同一句话：用户据此判断"是不是全给了"，模型据此知道自己看到的是不是全部。
 */
export function describeDocument(parsed: ParsedDocument): string {
  const scope = parsed.partial
    ? `前 ${parsed.units.length} ${parsed.unit}，共 ${parsed.totalUnits} ${parsed.unit}`
    : `共 ${parsed.totalUnits} ${parsed.unit}`
  return `${scope}，${parsed.characters} 字`
}
