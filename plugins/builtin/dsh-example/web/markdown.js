import MarkdownIt from 'markdown-it'

// Model output is untrusted: keep raw HTML disabled and the parser's URL validation.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const fence = markdown.renderer.rules.fence
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const language = tokens[index].info.trim().split(/\s+/)[0] || 'text'
  return `<div class="code-block"><div class="code-toolbar"><span>${markdown.utils.escapeHtml(language)}</span><button type="button" class="copy-code">复制代码</button></div>${fence(tokens, index, options, env, renderer)}</div>`
}
markdown.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" role="region" aria-label="表格"><table>\n'
markdown.renderer.rules.table_close = () => '</table></div>\n'

/** Render complete or partially streamed Markdown without enabling embedded HTML. */
export function renderMarkdown(text) {
  return markdown.render(text)
}
