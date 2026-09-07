import { expect, test } from 'vitest'
import { renderMarkdown } from '../web/markdown.js'

test('renders structured answers including tables and copyable code', () => {
  const html = renderMarkdown('# 接入\n\n**身份**与`userId`\n\n- 安装\n  - 配置\n\n> 保留数据\n\n| 应用 | 权限 |\n| --- | --- |\n| example | access |\n\n```json\n{"enabled": true}\n```\n\n[帮助](https://example.com)\n\n---')
  for (const part of ['<h1>接入</h1>', '<strong>身份</strong>', '<code>userId</code>', '<ul>', '<blockquote>', '<table>', '<th>应用</th>', '复制代码', 'language-json', '{&quot;enabled&quot;: true}', 'href="https://example.com"', '<hr>']) expect(html).toContain(part)
})

test('escapes HTML, fenced code and language labels and rejects executable links', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n[x](jav&#x61;script:alert%281%29)\n\n[x](data:text/html,hello)\n\n```"><img/src=x/onerror=alert(1)>\n<script>alert(1)</script>\n```')
  expect(html).not.toMatch(/<script|<img|href="(?:javascript|data):/i)
  expect(html).toContain('&lt;script&gt;')
})

test('unfinished stream blocks remain safe and render correctly when completed', () => {
  const prefix = '## 命令\n\n```sh\npnpm exec dsh-plugin-manager '
  expect(renderMarkdown(prefix)).toContain('<h2>命令</h2>')
  expect(renderMarkdown(prefix)).toContain('language-sh')
  const complete = renderMarkdown(prefix + 'list\n```\n\n**完成**')
  expect(complete).toContain('pnpm exec dsh-plugin-manager list\n</code>')
  expect(complete).toContain('<strong>完成</strong>')
})
