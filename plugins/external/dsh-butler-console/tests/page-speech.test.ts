/**
 * 大总管气泡的「流式预览 + 落定替换」（C 批后含按帧合并与受控 Markdown 落定）。
 *
 * 页面上这是用户直接看到的行为：增量续写同一条气泡（一帧只写一次 DOM），回合结束时
 * 用落定的正文替换预览并走受控 Markdown 排版（重试过的那一版不该留在页面上）。本插件
 * 没有浏览器工装，所以按仓库既有做法把函数取出来、用替身视图与替身渲染跑一遍；
 * 浏览器侧的观感验证见验收记录。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

interface StubNode {
  className: string
  textContent: string
  replaced: StubNode | null
  replaceWith(replacement: StubNode): void
}

function load() {
  const pick = (name: string) => {
    const body = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
    if (body === undefined) throw new Error(`${name} 源码未找到`)
    return body
  }
  const node = (className = ''): StubNode => ({
    className,
    textContent: '',
    replaced: null,
    replaceWith(replacement) { this.replaced = replacement },
  })
  const created: { body: StubNode; caret: { hidden: boolean }; msg: StubNode; text: string }[] = []
  const state: { butlerSpeech: null | { body: StubNode; caret: { hidden: boolean }; msg: StubNode; text: string } } = { butlerSpeech: null }
  const butlerMessage = (text: string) => {
    const view = { body: node(), caret: { hidden: true }, msg: node(), text }
    created.push(view)
    return view
  }
  // 帧队列由测试手动冲洗：证明增量按帧合并，而不是每条 delta 立刻写 DOM。
  const jobs: (() => void)[] = []
  const scheduleFrame = (job: () => void) => { jobs.push(job) }
  const stabilizeViewport = (mutate: () => void) => { mutate() }
  const make = (_tag: string, className: string) => node(className)
  const rendered: string[] = []
  const renderMarkdownInto = (target: StubNode, text: string) => { target.textContent = text; rendered.push(text) }
  // 追加写替身：语义与真实实现一致（写入由帧回调驱动），节点细节由浏览器验证覆盖。
  const appendPreviewText = (target: StubNode, book: { rendered?: string }, text: string) => { target.textContent = text; book.rendered = text }
  /**
   * 思考挂载替身：真实实现把 `state.butlerThinking` 挂到这条气泡上（思考行本身见
   * `page-thinking.test.ts`）。这里只锁住「气泡一出现就挂思考」这条接线确实被走到。
   */
  const attached: unknown[] = []
  const attachButlerThinking = (view: unknown) => { attached.push(view) }
  const api = Function('state', 'butlerMessage', 'scheduleFrame', 'stabilizeViewport', 'make', 'renderMarkdownInto', 'appendPreviewText', 'attachButlerThinking',
    `${pick('butlerSpeech')}\n${pick('butlerDelta')}\n${pick('settleMarkdown')}\n${pick('butlerSettle')}\nreturn { butlerDelta, butlerSettle }`,
  )(state, butlerMessage, scheduleFrame, stabilizeViewport, make, renderMarkdownInto, appendPreviewText, attachButlerThinking) as
    { butlerDelta(text: string): void; butlerSettle(text: string, time?: number): void }
  return {
    ...api,
    state,
    created,
    rendered,
    attached,
    pending: () => jobs.length,
    flush: () => { for (const run of jobs.splice(0, jobs.length)) run() },
  }
}

describe('大总管气泡的流式预览', () => {
  it('增量按帧合并续写同一条气泡：写 DOM 只发生在帧冲洗时', () => {
    const f = load()
    f.butlerDelta('收到老板，')
    f.butlerDelta('我这就安排。')
    expect(f.created).toHaveLength(1)
    // 气泡一出现就把这一轮的思考挂上去（思考通常先于正文到达，挂载点在这里）。
    expect(f.attached.length).toBeGreaterThan(0)
    expect(f.attached.every(view => view === f.state.butlerSpeech)).toBe(true)
    // 帧没冲之前不写 DOM（I12：不逐 token 全量重建）。
    expect(f.created[0]!.body.textContent).toBe('')
    expect(f.pending()).toBe(1)
    f.flush()
    expect(f.created[0]!.body.textContent).toBe('收到老板，我这就安排。')
    expect(f.created[0]!.caret.hidden).toBe(false)
  })

  it('落定的发言替换预览并走受控 Markdown，不新起一条', () => {
    const f = load()
    f.butlerDelta('这是一版被重试掉的预览，写得很长')
    f.butlerSettle('这是**最终**回答。', 123)
    expect(f.created).toHaveLength(1)
    // 预览 span 被受控 Markdown 容器替换，正文来自渲染器。
    expect(f.created[0]!.body.replaced?.className).toBe('md')
    expect(f.created[0]!.body.replaced?.textContent).toBe('这是**最终**回答。')
    expect(f.rendered).toEqual(['这是**最终**回答。'])
    expect(f.created[0]!.caret.hidden).toBe(true)
    expect(f.state.butlerSpeech).toBe(null)
    // 落定后迟到的帧冲洗不再写旧预览（S08：迟写不覆盖已校准的结论）。
    f.flush()
    expect(f.created[0]!.body.textContent).toBe('')
  })

  it('没有正在流的气泡时，落定的发言照旧新起一条', () => {
    const f = load()
    f.butlerSettle('直接回答，没有预览。', 456)
    expect(f.created).toHaveLength(1)
    expect(f.created[0]!.body.replaced?.className).toBe('md')
    expect(f.created[0]!.body.replaced?.textContent).toBe('直接回答，没有预览。')
    expect(f.created[0]!.caret.hidden).toBe(true)
  })
})
