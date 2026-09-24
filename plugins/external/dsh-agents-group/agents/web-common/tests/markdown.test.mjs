/**
 * 受控 Markdown 的安全与结构映射（方案 5.4 / C 批）。
 *
 * 断言对象是「节点计划」（纯数据），不依赖浏览器：标签只能来自渲染器白名单，文本只能
 * 是文本节点内容，链接/图片降级为可复制文本。浏览器侧的排版观感见验收记录。
 */
import { expect, test } from 'vitest'
import { markdownPlan } from '../src/lib/markdown.js'

/** 计划里出现过的所有标签；纯文本节点（只有 text 没有 tag）记为 '#text'。 */
function tags(plan) {
  const out = []
  const walk = node => {
    out.push(node.tag === undefined ? '#text' : node.tag)
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of plan) walk(node)
  return out
}

/** 拼出纯文本渲染结果（相当于把整棵计划树读成字符串）。 */
function plain(plan) {
  const out = []
  const walk = node => {
    if (node.text !== undefined) out.push(node.text)
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of plan) walk(node)
  return out.join('')
}

/** 深度摊平节点计划。 */
function flatten(nodes, out = []) {
  for (const node of nodes ?? []) {
    out.push(node)
    flatten(node.children, out)
  }
  return out
}

test('结构化内容映射为白名单标签：标题、强调、行内代码、列表、引用、表格、代码块、分隔线', () => {
  const plan = markdownPlan('# 接入\n\n**加粗**与*斜体*、`userId`、~~旧~~\n\n- 安装\n  - 配置\n\n> 保留数据\n\n| 应用 | 权限 |\n| :--- | ---: |\n| example | access |\n\n```json\n{"enabled": true}\n```\n\n---')
  const all = tags(plan)
  expect(all).toContain('h1')
  expect(all).toContain('strong')
  expect(all).toContain('em')
  expect(all).toContain('code')
  // 删除线：markdown-it 产出的是 s 标签。
  expect(all).toContain('s')
  expect(all).toContain('ul')
  expect(all).toContain('li')
  expect(all).toContain('blockquote')
  expect(all).toContain('table')
  expect(all).toContain('th')
  expect(all).toContain('td')
  // 表格进可聚焦的横向滚动区域（固定属性，不来自模型）。
  const tableWrap = plan.find(node => node.className === 'table-scroll')
  expect(tableWrap?.attrs).toEqual({ tabindex: '0', role: 'region', 'aria-label': '表格' })
  // 对齐只接受 markdown-it 的三种 text-align。
  const headCell = tableWrap?.children[0]?.children[0]?.children[0]?.children[0]
  expect(headCell?.align).toBe('left')
  // 代码块语言来自白名单字符；围栏内容整体进 code 文本。
  const codeNode = plan.flatMap(node => node.children ?? []).find(node => node.className === 'language-json')
  expect(codeNode?.text).toContain('{"enabled": true}')
  expect(JSON.stringify(plan)).toContain('language-json')
  expect(all).toContain('hr')
})

test('危险输入：HTML 全部变成待显示文本，零脚本标签、零锚点、零图片元素', () => {
  const plan = markdownPlan('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n<iframe src="https://evil"></iframe>\n\n[x](javascript:alert%281%29)\n\n[x](data:text/html,hello)\n\n[点这里](https://evil.example/next)')
  const all = tags(plan)
  expect(all).not.toContain('img')
  expect(all).not.toContain('script')
  expect(all).not.toContain('iframe')
  expect(all).not.toContain('a')
  expect(all).not.toContain('svg')
  const text = plain(plan)
  expect(text).toContain('<img src=x onerror=alert(1)>')
  expect(text).toContain('<script>alert(1)</script>')
  // 危险协议的链接 markdown-it 直接拒绝解析：整段按原文显示，同样没有锚点。
  expect(text).toContain('[x](javascript:alert%281%29)')
  expect(text).toContain('[x](data:text/html,hello)')
  // 普通外链不生成可点击元素：标题与完整地址都是纯文本。
  expect(text).toContain('点这里（https://evil.example/next）')
})

test('图片出受控缩略图（kkFileView 预览）；非图片裸地址保持纯文本；地址即正文时不重复', () => {
  // 2026-09-19 行为变更（有意）：http(s) 图片地址从「占位文本」改为受控缩略图，点击新窗口
  // 进 kkFileView 在线预览；安全边界（不执行 HTML、协议白名单、非图片不自动化）见 markdown-image.test.ts。
  const plan = markdownPlan('![示意图](https://cdn.example.com/a.png)\n\n看这个 https://example.com/info\n\n<https://example.com/docs>')
  const all = tags(plan)
  expect(all).toContain('img')
  expect(all).toContain('a')
  const pics = flatten(plan).filter(node => node.tag === 'a' && node.className === 'md-pic')
  expect(pics).toHaveLength(1)
  expect(pics[0].children[0].attrs).toMatchObject({ src: 'https://cdn.example.com/a.png', alt: '示意图' })
  expect(pics[0].attrs.href).toContain('/onlinePreview?url=')
  const text = plain(plan)
  // linkify 关闭：裸 URL 保持普通文本，没有被包成链接再补地址（非图片后缀不自动图片化）。
  expect(text).toContain('看这个 https://example.com/info')
  expect(text).not.toContain('https://example.com/info（')
  // 自动链接 <url>：正文已是地址，不再追加（url）。
  expect(text).toContain('https://example.com/docs')
  expect(text).not.toContain('https://example.com/docs（')
})

test('未闭合围栏与半张表格按不完整输入处理：不抛错、不吞后续文本', () => {
  const prefix = markdownPlan('## 命令\n\n```sh\npnpm exec dsh-plugin-manager ')
  expect(tags(prefix)).toContain('h2')
  expect(tags(prefix)).toContain('pre')
  expect(plain(prefix)).toContain('pnpm exec dsh-plugin-manager ')
  // 半张表格（缺分隔行）不成为表格，内容以段落文本保留。
  const half = markdownPlan('| 应用 | 权限\n| example | access')
  expect(tags(half)).not.toContain('table')
  expect(plain(half)).toContain('| example | access')
  // 补全后正常成表。
  const full = markdownPlan('| 应用 | 权限 |\n| --- | --- |\n| example | access |')
  expect(tags(full)).toContain('table')
})

test('有序列表保留起始编号；从 1 开始不加多余属性', () => {
  // 「3. 第三步 / 4. 第四步」必须从 3 开始，不能回退成 1、2。
  const plan = markdownPlan('3. 第三步\n4. 第四步\n')
  const ol = plan.find(node => node.tag === 'ol')
  expect(ol?.attrs).toEqual({ start: '3' })
  expect(ol?.children.length).toBe(2)
  // 从 0 开始同样合法：保留 0，不省略成默认 1。
  const fromZero = markdownPlan('0. 零\n1. 壹\n')
  const olZero = fromZero.find(node => node.tag === 'ol')
  expect(olZero?.attrs).toEqual({ start: '0' })
  expect(olZero?.children.length).toBe(2)
  // 从 1 开始时不写 start；属性值只接受受控整数。
  const fromOne = markdownPlan('1. 第一步\n2. 第二步\n')
  expect(fromOne.find(node => node.tag === 'ol')?.attrs).toBeUndefined()
})

test('空文本与纯文本：空计划不建节点，普通文字进段落文本节点', () => {
  expect(markdownPlan('')).toEqual([])
  expect(markdownPlan(null ?? '')).toEqual([])
  const plan = markdownPlan('就是一句普通的话')
  expect(tags(plan)).toEqual(['p', '#text'])
})
