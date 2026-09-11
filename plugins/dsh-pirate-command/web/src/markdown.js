import MarkdownIt from 'markdown-it';

// 与现有对话页使用相同解析器；关闭原始HTML，图片改为点击后查看的链接。
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const label = markdown.utils.escapeHtml(token.content || '查看图片');
  const source = token.attrGet('src') || '';
  return markdown.validateLink(source) ? `<a href="${markdown.utils.escapeHtml(source)}">${label}</a>` : label;
};
markdown.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" role="region" aria-label="表格"><table>';
markdown.renderer.rules.table_close = () => '</table></div>';

export function renderMarkdown(text) { return markdown.render(String(text)); }
