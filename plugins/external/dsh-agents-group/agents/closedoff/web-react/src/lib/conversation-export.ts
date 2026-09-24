/**
 * 对话分享导出的纯函数（旧 web/conversation-history.js conversationMarkdown 等价）。
 *
 * 只导出问答正文：不含思考原文、附件文件、工具记录；不生成公开链接。
 */

/** /history 的最小读取形状（导出只消费 role/text）。 */
export interface ExportableMessage {
  role: string
  text?: string
}

/** 一段对话 → Markdown 文档（旧 conversationMarkdown 口径：标题 + 问答分段）。 */
export function conversationMarkdown(title: string, messages: readonly ExportableMessage[]): string {
  const heading = `# ${String(title || '对话记录').replace(/[\r\n]/g, ' ')}\n\n`
  const body = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && (m.text ?? '').trim() !== '')
    .map(m => `## ${m.role === 'user' ? '我' : '助手'}\n\n${m.text}`)
    .join('\n\n---\n\n')
  return `${heading}${body}\n`
}

/** 导出文件名消毒（旧 download.onclick 口径：单会话用标题，多会话用「对话记录」）。 */
export function exportFileName(titles: readonly string[]): string {
  const name = titles.length === 1 ? titles[0] ?? '' : '对话记录'
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60)
  return `${safe === '' ? '对话记录' : safe}.md`
}
