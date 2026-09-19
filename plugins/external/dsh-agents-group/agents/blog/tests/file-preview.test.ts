/**
 * kkFileView 预览共享模块（file-preview.js）的纯函数边界。
 *
 * DOM 部分（enhancePreviews / 弹窗）属浏览器行为，L3 真实页面验收；这里锁三件
 * 接入新成员时最容易踩的事：
 * 1. kkFileViewUrl 的实测约定（直接 Base64，编码版 403）；
 * 2. 扩展名判定（版本号 `.2` 不算、无扩展名不算、`7z` 特例算）；
 * 3. 中文文件名的百分号解码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// 渲染层是无类型 JS；这里只 import 纯函数。
const { kkFileViewUrl, fileExtensionOf } = await import('../web/file-preview.js')

test('kkFileViewUrl：https 基址 + encodeURIComponent(Base64(明文))——官方可行形态', () => {
  const href = kkFileViewUrl('https://img.pelycloud.com/huiyu/report.pdf')
  assert.match(href, /^https:\/\/preview\.pelycloud\.com\/onlinePreview\?url=/)
  // Base64 里必须是**明文**地址（内层 encode 的编码态地址被 KK 拒成 403/UNKNOWN）；
  // 外层 encodeURIComponent 防止 Base64 的 "+" 被 query 解析成空格。
  const b64 = decodeURIComponent(href.split('url=')[1] ?? '')
  assert.equal(Buffer.from(b64, 'base64').toString(), 'https://img.pelycloud.com/huiyu/report.pdf')
})

test('kkFileViewUrl：地址含非 ASCII 时先 encodeURI 再 Base64（btoa 不吃非 ASCII）', () => {
  const href = kkFileViewUrl('https://example.com/files/季报.pdf')
  const decoded = Buffer.from(href.split('url=')[1] ?? '', 'base64').toString()
  assert.equal(decoded, encodeURI('https://example.com/files/季报.pdf'))
})

test('fileExtensionOf：常见文件都识别，版本号与无扩展名不误伤', () => {
  assert.equal(fileExtensionOf('https://example.com/a/report.pdf'), 'pdf')
  assert.equal(fileExtensionOf('https://example.com/a/报表.xlsx?token=1'), 'xlsx')
  assert.equal(fileExtensionOf('https://example.com/demo.mp4'), 'mp4')
  assert.equal(fileExtensionOf('https://example.com/archive.7z'), '7z')
  assert.equal(fileExtensionOf('https://example.com/page'), undefined, '无扩展名：不是文件')
  assert.equal(fileExtensionOf('https://example.com/v1.2'), undefined, '版本号 .2：首位数字不算')
  assert.equal(fileExtensionOf('https://example.com/a.b/c'), undefined, '扩展名只看末段')
})
