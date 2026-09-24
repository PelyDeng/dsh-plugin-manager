/**
 * 正文文本预处理（旧 web/render-text.js 的等价迁移，纯函数）。
 *
 * 轻量 Markdown 的 HTML 渲染不在这里：批 1a 正文统一走 web-common 的 RichText
 * 受控渲染飞地（群组渲染统一口径）。这里保留 closedoff 页面特有的行为——
 * 存在结构化结果时剥离最终正文中的重复 Markdown 表格（业务口径：卡片展示事实，
 * 正文不重复表格）。
 */

/** 去掉成块（≥2 行且第二行是分隔行）的 Markdown 表格，代码块内不动。 */
export function stripMarkdownTables(text: string): string {
  const lines = String(text ?? '').split('\n')
  const kept: string[] = []
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^```/.test(line.trim())) {
      inCode = !inCode
      kept.push(line)
      continue
    }
    if (inCode) {
      kept.push(line)
      continue
    }
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      kept.push(line)
      continue
    }
    const start = i
    while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1] ?? '')) i++
    const block = lines.slice(start, i + 1)
    const separator = block[1] ?? ''
    if (block.length < 2 || !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(separator)) kept.push(...block)
  }
  return kept.join('\n')
}
