/**
 * 待发附件条的**页面侧**行为。
 *
 * 本插件没有浏览器工装，按仓库既有做法（见 `page-speech.test.ts`）把函数抠出来、用替身节点跑。
 * 这里要守的是三件容易写错的事：
 *
 * 1. 状态文字如实反映服务端回来的那条记录（"读不出来"必须能被看见，否则用户以为文件内容已经给到了）；
 * 2. 只把**就绪**的附件随消息发出去（上传中/失败的 id 送出去只会换来一个 404 或一份空内容）；
 * 3. 发出去的那几条从输入框上摘掉——留着的话用户会以为没发出去，再发一遍。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')

interface StubNode {
  tag: string
  className: string
  textContent: string
  /** `hidden` 是 `syncAttachStrip` 唯一用到的属性，替身照样得有。 */
  hidden: boolean
  dataset: Record<string, string>
  children: StubNode[]
  attrs: Record<string, string>
  listeners: Record<string, (() => void)[]>
  appendChild(child: StubNode): StubNode
  setAttribute(name: string, value: string): void
  addEventListener(type: string, fn: () => void): void
}

function stubNode(tag = '', className = '', text = ''): StubNode {
  return {
    tag,
    className,
    textContent: text,
    hidden: false,
    dataset: {},
    children: [],
    attrs: {},
    listeners: {},
    appendChild(child) { this.children.push(child); return child },
    setAttribute(name, value) { this.attrs[name] = value },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
  }
}

function load() {
  const pick = (name: string) => {
    const body = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
    if (body === undefined) throw new Error(`${name} 源码未找到`)
    return body
  }
  const state: { attachments: Record<string, unknown>[] } = { attachments: [] }
  const el = { attachItems: stubNode('div'), attachStrip: stubNode('div'), attachUrl: stubNode('div') }
  el.attachStrip.hidden = true
  el.attachUrl.hidden = true
  const make = (tag: string, className?: string, text?: string) => stubNode(tag, className ?? '', text === undefined ? '' : String(text))
  const clear = (node: StubNode) => { node.children = [] }

  const api = Function(
    'state', 'el', 'make', 'clear',
    `${pick('fileSizeText')}\n${pick('attachmentNote')}\n${pick('attachmentChip')}\n`
    + `${pick('syncAttachStrip')}\n${pick('renderAttachments')}\n${pick('attachmentsForSend')}\n`
    + `${pick('takeSentAttachments')}\n${pick('clearAttachments')}\n`
    + 'return { fileSizeText, attachmentNote, attachmentChip, renderAttachments, attachmentsForSend, takeSentAttachments, clearAttachments }',
  )(state, el, make, clear) as {
    fileSizeText(bytes: number): string
    attachmentNote(entry: Record<string, unknown>): string
    attachmentChip(entry: Record<string, unknown>): StubNode
    renderAttachments(): void
    attachmentsForSend(): string[]
    takeSentAttachments(ids: string[]): Record<string, unknown>[]
    clearAttachments(): void
  }
  return { ...api, state, el }
}

/** 一条待发附件（页面的那份形状）。 */
const entry = (patch: Record<string, unknown> = {}) => ({
  key: 'k1', name: '需求.txt', size: 2048, phase: 'ready', message: '', item: { id: 'att-1', status: 'ready' }, ...patch,
})

describe('字节数的人话说法', () => {
  it('按量级换单位，与服务端口径一致', () => {
    const { fileSizeText } = load()
    expect(fileSizeText(512)).toBe('512 字节')
    expect(fileSizeText(2048)).toBe('2 KB')
    expect(fileSizeText(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(fileSizeText(0)).toBe('')
  })
})

describe('状态文字', () => {
  it('上传中、失败、就绪各有说法', () => {
    const { attachmentNote } = load()
    expect(attachmentNote(entry({ phase: 'uploading' }))).toBe('上传中…')
    expect(attachmentNote(entry({ phase: 'uploading', message: '取回中…' }))).toBe('取回中…')
    expect(attachmentNote(entry({ phase: 'failed' }))).toBe('没成')
    expect(attachmentNote(entry({ phase: 'failed', message: 'JSON 格式无效' }))).toBe('JSON 格式无效')
    // 就绪的那条通常没什么要说的；服务端给了提示（例如"只读了前 3 行"）就照原样显示。
    expect(attachmentNote(entry())).toBe('')
    expect(attachmentNote(entry({ message: '只读了前 3 行，共 40 行' }))).toBe('只读了前 3 行，共 40 行')
  })
})

describe('附件条目', () => {
  it('带上名字、大小、状态与移除按钮，并把阶段写在 dataset 上供样式用', () => {
    const { attachmentChip } = load()
    const chip = attachmentChip(entry({ phase: 'failed', message: '文件损坏' }))
    expect(chip.className).toBe('attach__item')
    expect(chip.dataset.phase).toBe('failed')
    expect(chip.children.map(child => child.className)).toEqual(['attach__name', 'attach__size', 'attach__note', 'attach__remove'])
    expect(chip.children[0]?.textContent).toBe('需求.txt')
    expect(chip.children[1]?.textContent).toBe('2 KB')
    expect(chip.children[2]?.textContent).toBe('文件损坏')
    expect(chip.children[3]?.attrs['aria-label']).toBe('移除 需求.txt')
  })
})

describe('附件条', () => {
  it('一条一个条目；空的时候整块收起来', () => {
    const page = load()
    page.state.attachments = [entry(), entry({ key: 'k2', name: '图.png', phase: 'uploading' })]
    page.renderAttachments()
    expect(page.el.attachItems.children).toHaveLength(2)
    expect(page.el.attachStrip.hidden).toBe(false)

    page.clearAttachments()
    expect(page.el.attachItems.children).toHaveLength(0)
    expect(page.el.attachStrip.hidden).toBe(true)
  })

  it('粘链接那一行开着时，附件条不能收起来', () => {
    const page = load()
    page.clearAttachments()
    page.el.attachUrl.hidden = false
    page.renderAttachments()
    expect(page.el.attachStrip.hidden).toBe(false)
  })
})

describe('发出去的是哪些', () => {
  it('只带服务端已收下且就绪的；上传中与上传失败的都不带', () => {
    const page = load()
    page.state.attachments = [
      entry({ key: 'k1', item: { id: 'att-1', status: 'ready' } }),
      entry({ key: 'k2', phase: 'uploading', item: null }),
      entry({ key: 'k3', phase: 'failed', message: '网络断了', item: null }),
      // 服务端收下了但内容读不出来：照样能交出去，所以带上。
      entry({ key: 'k4', phase: 'failed', message: '文件损坏', item: { id: 'att-4', status: 'failed' } }),
    ]
    expect(page.attachmentsForSend()).toEqual(['att-1'])
  })

  it('发出去的那几条从输入框摘掉，剩下的留着', () => {
    const page = load()
    page.state.attachments = [
      entry({ key: 'k1', item: { id: 'att-1', status: 'ready' } }),
      entry({ key: 'k2', item: { id: 'att-2', status: 'ready' } }),
      entry({ key: 'k3', phase: 'uploading', item: null }),
    ]
    const taken = page.takeSentAttachments(['att-1'])
    expect(taken.map(value => value.key)).toEqual(['k1'])
    expect(page.state.attachments.map(value => value.key)).toEqual(['k2', 'k3'])
  })
})

describe('页面骨架', () => {
  it('三个入口与附件条都在，且回形针不再是装饰', () => {
    expect(html).toContain('id="attach-button"')
    expect(html).toContain('id="attach-link-button"')
    expect(html).toContain('id="attach-input"')
    expect(html).toContain('id="attach-strip"')
    expect(html).toContain('id="attach-url-input"')
    // 装饰用的那个 span 已经换成真按钮：留着它会出现"看着能点、点了没反应"的图标。
    expect(html).not.toContain('composer__clip')
    // 附件条在输入框**外面**（上面）：那一块是 flex 行布局，塞进去会跟输入框并排。
    expect(html.indexOf('id="attach-strip"')).toBeLessThan(html.indexOf('class="composer__box"'))
  })

  it('app.js 不再引用那个装饰类', () => {
    expect(source).not.toContain('composer__clip')
  })
})
