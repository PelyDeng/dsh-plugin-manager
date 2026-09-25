// @vitest-environment happy-dom
/**
 * richText：模型文本统一渲染入口的守卫（设计 v2 §6）。
 *
 * 与 markdown-image.test.ts 的分工：那边锁 markdownPlan 的纯数据输出（安全与识别边界），
 * 这边锁 richText 的 DOM 行为——变体能力收窄、流式每帧全量重渲与终态一致、图片池复用、
 * 选区冻结、span→div 升级、错误降级记忆。环境用文件级 happy-dom，不动全局 vitest 配置。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error 渲染器是 JS 模块（无声明文件），行为断言在 DOM 层宽松读取。
import { markdownPlan, renderMarkdownInto, richText } from '../src/lib/markdown.js'

const IMG = 'https://img.pelycloud.com/huiyu/2026/09/21/pool-reuse.png'

function mount() {
  const host = document.createElement('div')
  host.id = `rich-${Math.random().toString(36).slice(2)}`
  document.body.appendChild(host)
  return host
}

/** happy-dom 不真加载图片：把池判定需要的两个只读状态显式定义成“已加载”。 */
function markLoaded(img: HTMLImageElement) {
  Object.defineProperty(img, 'complete', { value: true })
  Object.defineProperty(img, 'naturalWidth', { value: 640 })
}

afterEach(() => {
  for (const node of Array.from(document.body.children)) node.remove()
  document.body.className = ''
})

describe('richText：变体能力矩阵', () => {
  it('message（缺省）：完整 Markdown + 图片卡', () => {
    const host = mount()
    const out = richText(host, `**结论**：\n\n- 要点一\n\n${IMG}`)
    expect(out).toBe(host)
    expect(out.classList.contains('md')).toBe(true)
    expect(out.querySelector('strong')?.textContent).toBe('结论')
    expect(out.querySelectorAll('li')).toHaveLength(1)
    expect(out.querySelector('a.md-pic img')?.getAttribute('src')).toBe(IMG)
  })

  it('thinking：窄解析（4 空格缩进不是代码块、fence 保留）+ 无图片卡', () => {
    const host = mount()
    const out = richText(host, `先想一下\n\n    缩进的伪结构保持文本\n\n\`\`\`js\nconst a = 1\n\`\`\`\n\n地址 ${IMG} 不出图卡`, { variant: 'thinking' })
    expect(out.classList.contains('md--think')).toBe(true)
    // 缩进段是段落文本而不是 <pre>；fence 围栏代码块照常。
    expect(out.querySelector('pre.md-code')).not.toBeNull()
    const code = out.querySelector('pre.md-code')!
    expect(code.querySelector('code')?.className).toBe('language-js')
    const texts = out.textContent ?? ''
    expect(texts).toContain('缩进的伪结构保持文本')
    expect(out.querySelector('a.md-pic')).toBeNull()
    expect(texts).toContain(IMG)
    // 对照：message 变体下同一段缩进文本会进 <pre>（markdown-it 默认规则）。
    const wide = richText(mount(), '    缩进的伪结构保持文本')
    expect(wide.querySelector('pre')).not.toBeNull()
  })

  it('ask：无图片卡，URL 与图片语法都保持文本', () => {
    const host = mount()
    const out = richText(host, `文档在哪？看看 ${IMG} 和 ![标注](${IMG})`, { variant: 'ask' })
    expect(out.classList.contains('md--ask')).toBe(true)
    expect(out.querySelector('a.md-pic')).toBeNull()
    expect(out.querySelectorAll('img')).toHaveLength(0)
    expect(out.textContent).toContain(IMG)
    expect(out.textContent).toContain('[图片：标注')
  })

  it('card：与 message 同规则（图卡开）', () => {
    const out = richText(mount(), IMG, { variant: 'card' })
    expect(out.querySelector('a.md-pic img')?.getAttribute('src')).toBe(IMG)
  })
})

describe('richText：流式与终态一致', () => {
  it('三段增量（含未闭合围栏）每帧都是受控 DOM，终态与一次性渲染一致', () => {
    const host = mount()
    const chunks = ['计划如下：\n\n1. 查资料\n\n```js\n', 'const a = 1\n', '```\n\n**完**']
    let acc = ''
    let view = host
    for (const chunk of chunks) {
      acc += chunk
      view = richText(view, acc, { streaming: true })
      // 每帧受控：容器里只有白名单标签 + 文本节点，没有 <script>。
      expect(view.querySelector('script')).toBeNull()
      expect(view.classList.contains('md')).toBe(true)
    }
    const terminal = richText(view, acc)
    const once = renderMarkdownInto(mount(), acc)
    expect(terminal.innerHTML).toBe(once.innerHTML)
    expect(terminal.querySelector('pre.md-code')).not.toBeNull()
    expect(terminal.querySelector('strong')?.textContent).toBe('完')
  })
})

describe('richText：图片池复用', () => {
  it('同 URL 两帧重渲后 <img> 节点引用相等（保留已解码位图，不闪）', () => {
    const host = mount()
    const first = richText(host, `第一段\n\n${IMG}`)
    const img = first.querySelector('img')!
    markLoaded(img)
    const second = richText(first, `第一段加长了\n\n${IMG}\n\n第二段`)
    const kept = second.querySelector('img')!
    expect(kept).toBe(img)
    // 同 URL 出现两次：第一个复用旧节点，第二个用新节点（DOM 节点只能挂一处）。
    markLoaded(kept)
    const twice = richText(second, `${IMG}\n\n${IMG}`)
    const imgs = Array.from(twice.querySelectorAll('img'))
    expect(imgs[0]).toBe(kept)
    expect(imgs[1]).not.toBe(kept)
  })

  it('未加载完成的图片不进池（complete=false 时重渲正常换新节点）', () => {
    const host = mount()
    const first = richText(host, IMG)
    const img = first.querySelector('img')!
    // happy-dom 默认未加载：complete 为 false，池不收。
    const second = richText(first, `加长\n\n${IMG}`)
    expect(second.querySelector('img')).not.toBe(img)
  })
})

describe('richText：流式保护', () => {
  it('选区冻结：容器内有非折叠选区时跳过渲染（DOM 不变），选区收起后补渲', () => {
    const host = mount()
    richText(host, '第一段文本足够长')
    const selection = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(host)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selection.isCollapsed).toBe(false)
    const out = richText(host, '第一段文本足够长，第二段来了', { streaming: true })
    expect(out).toBe(host)
    expect(out.textContent).toBe('第一段文本足够长')  // 当帧没渲
    selection.removeAllRanges()
    const after = richText(out, '第一段文本足够长，第二段来了', { streaming: true })
    expect(after.textContent).toContain('第二段来了')
  })

  it('后台降频：document.hidden 时流式帧跳过，回前台补渲', () => {
    const host = mount()
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    try {
      const out = richText(host, '后台到达的增量', { streaming: true })
      expect(out.textContent ?? '').toBe('')
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      const after = richText(out, '后台到达的增量', { streaming: true })
      expect(after.textContent).toContain('后台到达的增量')
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    }
  })
})

describe('richText：容器升级与降级', () => {
  it('span→div 首帧升级：返回新 div（引用更新纪律），原 span 脱离文档', () => {
    const span = document.createElement('span')
    const parent = mount()
    parent.appendChild(span)
    const out = richText(span, '**加粗**')
    expect(out.tagName).toBe('DIV')
    expect(out.classList.contains('md')).toBe(true)
    expect(span.isConnected).toBe(false)
    expect(out.querySelector('strong')?.textContent).toBe('加粗')
    // 已是 div 的容器不再换节点（引用稳定）。
    expect(richText(out, '**加粗**再改')).toBe(out)
  })

  it('错误回落带记忆：渲染抛错降级纯文本；连降级写入也失败时组件不抛错（流式永不断流）', () => {
    const host = mount()
    const good = richText(host, '正常渲染')
    expect(good.querySelector('p')).not.toBeNull()
    // 制造渲染路径抛错：把 appendChild 打烂（happy-dom 的 textContent 内部也走它，
    // 所以同时覆盖「降级写入也失败」的更深边界）。
    host.appendChild = () => { throw new Error('boom') }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => richText(host, '这一帧会炸')).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
      // 降级名单生效：后续帧不再尝试渲染，也就不再抛错/刷 console。
      expect(() => richText(host, '这一帧会炸且变长了')).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('markdownPlan 可选参数向后兼容', () => {
  it('不传 opts 与 v1 行为一致（默认解析器 + 图卡开）', () => {
    const plan = markdownPlan(`![图](${IMG})`)
    expect(JSON.stringify(plan)).toContain('md-pic')
    const noImages = markdownPlan(`![图](${IMG})`, { images: false })
    expect(JSON.stringify(noImages)).not.toContain('md-pic')
    expect(JSON.stringify(noImages)).toContain('[图片：图')
  })
})

/** 深度摊平节点计划（本段自带的纯数据 helper，与 markdown.test.mjs 同款）。 */
function flattenPlan(nodes, out = []) {
  for (const node of nodes ?? []) {
    out.push(node)
    flattenPlan(node.children, out)
  }
  return out
}

/** 拼出纯文本渲染结果。 */
function plainOf(plan) {
  const out = []
  const walk = node => {
    if (node.text !== undefined) out.push(node.text)
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of plan) walk(node)
  return out.join('')
}

describe('渲染器能力开关（批 2b 增量，blog 消费；缺省关闭=butler 基线不变）', () => {
  it('links：markdown 链接出受控 <a>（target/rel 白名单），不再追加地址括号', () => {
    const plan = markdownPlan('[点这里](https://good.example/page)')
    expect(plan[0]).not.toHaveProperty('tag', 'a') // 缺省：降级纯文本（基线不变）
    const linked = markdownPlan('[点这里](https://good.example/page)', { links: true })
    const a = flattenPlan(linked).find(node => node.tag === 'a' && node.className === 'md-link')
    expect(a?.attrs).toEqual({ href: 'https://good.example/page', target: '_blank', rel: 'noopener noreferrer' })
    expect(plainOf(linked)).toBe('点这里')
  })

  it('links：链接目标是图片/文件地址时优先升级预览卡（upgradeLink 同语义，链接文字丢弃）', () => {
    const linked = markdownPlan('[看图](https://cdn.example.com/a.png) 和 [报表](https://cdn.example.com/b.xlsx)', { links: true })
    const pics = flattenPlan(linked).filter(node => node.className === 'md-pic')
    const files = flattenPlan(linked).filter(node => node.className === 'md-file')
    expect(pics).toHaveLength(1)
    expect(files).toHaveLength(1)
    expect(plainOf(linked)).not.toContain('看图')
  })

  it('links：非 http(s) 协议与 images=false 变体不受开关影响，恒为纯文本', () => {
    const evil = markdownPlan('[点这里](ftp://evil.example/file)', { links: true })
    expect(flattenPlan(evil).filter(node => node.tag === 'a')).toHaveLength(0)
    const thinking = markdownPlan('[点这里](https://good.example/page)', { links: true, images: false })
    expect(flattenPlan(thinking).filter(node => node.tag === 'a')).toHaveLength(0)
    expect(plainOf(thinking)).toContain('点这里')
    // 裸地址：links 开启时出受控外链（对齐旧 blog linkify 观感）。
    const bare = markdownPlan('文档在 https://good.example/docs', { links: true })
    const a = flattenPlan(bare).find(node => node.className === 'md-link')
    expect(a?.attrs?.href).toBe('https://good.example/docs')
  })

  it('codeCopy：fence 包 code-block/code-toolbar（语言标签+复制按钮），缺省结构不变', () => {
    const plainPlan = markdownPlan('```js\nconst a = 1\n```')
    expect(flattenPlan(plainPlan).filter(node => node.className === 'code-block')).toHaveLength(0)
    const copied = markdownPlan('```js\nconst a = 1\n```', { codeCopy: true })
    const block = copied.find(node => node.className === 'code-block')
    expect(block).toBeDefined()
    const toolbar = flattenPlan([block!]).find(node => node.className === 'code-toolbar')
    expect(plainOf([toolbar!])).toContain('js')
    expect(flattenPlan([toolbar!]).some(node => node.className === 'copy-code' && node.text === '复制代码')).toBe(true)
    expect(flattenPlan([block!]).some(node => node.className === 'md-code' && node.children?.[0]?.text === 'const a = 1\n')).toBe(true)
  })

  it('DOM：复制按钮点击写剪贴板并置「已复制」；外链 a 带 target/rel', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const host = richText(mount(), '看 [文档](https://good.example/docs)\n\n```sh\npnpm build\n```', { links: true, codeCopy: true })
    const link = host.querySelector('a.md-link')!
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.querySelector('strong') ?? link.textContent).toBeDefined()
    const button = host.querySelector('button.copy-code') as HTMLButtonElement
    expect(button.textContent).toBe('复制代码')
    button.click()
    expect(writeText).toHaveBeenCalledWith('pnpm build\n')
    expect(button.textContent).toBe('已复制')
    expect(host.querySelector('.table-scroll')).toBeNull()
  })

  it('DOM：表格仍进可聚焦横滚区（批 2b 三能力裁决的「已有项」核对）', () => {
    const host = richText(mount(), '| 应用 | 权限 |\n| --- | --- |\n| example | access |', { links: true, codeCopy: true })
    const wrap = host.querySelector('.table-scroll')!
    expect(wrap.getAttribute('role')).toBe('region')
    expect(wrap.getAttribute('aria-label')).toBe('表格')
    expect(wrap.getAttribute('tabindex')).toBe('0')
  })
})
