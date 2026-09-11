import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../web/src/markdown.js';

test('模型正文可阅读表格和代码，但不执行HTML或自动加载外部图片', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![外部图片](https://example.invalid/track)\n\n| 项目 | 结果 |\n| --- | --- |\n| 查询 | 完成 |');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(/<script|<img|href="javascript:/i.test(html), false);
  assert.ok(html.includes('href="https://example.invalid/track"'));
  assert.ok(html.includes('<table>'));
});
