/**
 * 文本渲染：转义、去掉 Markdown 表格、轻量 Markdown 转 HTML。纯函数，页面壳与卡片都靠它渲染正文。
 */

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function stripMarkdownTables(text) {
  var lines = String(text || '').split('\n');
  var kept = [], inCode = false;
  for (var i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i].trim())) { inCode = !inCode; kept.push(lines[i]); continue; }
    if (inCode) { kept.push(lines[i]); continue; }
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) { kept.push(lines[i]); continue; }
    var start = i;
    while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) i++;
    var block = lines.slice(start, i + 1);
    if (block.length < 2 || !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(block[1])) kept.push.apply(kept, block);
  }
  return kept.join('\n');
}

// 轻量 Markdown 渲染（转义后渲染）
export function mdToHtml(text) {
  var lines = String(text || '').split('\n');
  var html = [], i = 0, inCode = false, codeBuf = [];
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return s;
  }
  while (i < lines.length) {
    var line = lines[i];
    if (/^```/.test(line.trim())) {
      if (inCode) { html.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; inCode = false; }
      else inCode = true;
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }
    var t = line.trim();
    if (t === '') { i++; continue; }
    var h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) { html.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (t.startsWith('|') && t.endsWith('|')) {
      var rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      if (rows.length >= 2) {
        var cells = rows.map(function (r) { return r.slice(1, -1).split('|').map(function (c) { return c.trim(); }); });
        var out = '<table><thead><tr>' + cells[0].map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        for (var r = 2; r < cells.length; r++) {
          out += '<tr>' + cells[r].map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
        }
        html.push(out + '</tbody></table>'); continue;
      }
    }
    if (/^[-*•]\s+/.test(t)) {
      html.push('<ul>');
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) { html.push('<li>' + inline(lines[i].trim().replace(/^[-*•]\s+/, '')) + '</li>'); i++; }
      html.push('</ul>'); continue;
    }
    if (/^\d+[.、]\s+/.test(t)) {
      html.push('<ol>');
      while (i < lines.length && /^\d+[.、]\s+/.test(lines[i].trim())) { html.push('<li>' + inline(lines[i].trim().replace(/^\d+[.、]\s+/, '')) + '</li>'); i++; }
      html.push('</ol>'); continue;
    }
    html.push('<p>' + inline(line) + '</p>'); i++;
  }
  if (inCode) html.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
  return html.join('');
}
