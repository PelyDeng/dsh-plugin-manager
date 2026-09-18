/**
 * 成员卡片的**正文取值**：终态以服务端那一份为准。
 *
 * ## 这条判据是生产截图换来的
 *
 * 卡片正文在流式期间是客户端一段段攒的（`subtask_delta`），攒的是**模型在回合里说过的话**——
 * 包括中途的分析与自我怀疑。而权威结论是服务端在终态事件里给的 `detail`（落库那一份，也是
 * 刷新后重新读到的那一份）。
 *
 * 原来的取值顺序是反的（累积值优先，服务端正文只在"一个字都没攒到"时才用），于是同一张卡片
 * **刷新前显示模型的自言自语、刷新后显示真正的结论**。用户报了两次；第一次我只改了服务端
 * （让落库与推送同源），把客户端这第三条路漏了——所以现象没变。
 *
 * 本插件没有浏览器工装，按仓库既有做法（见 `page-speech.test.ts`）把函数抠出来、用替身视图跑。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const css = readFileSync(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

interface StubNode {
  className: string
  textContent: string
  replaceWith(replacement: StubNode): void
}

/** 抠出要测的几个函数，配一套最小替身视图跑。 */
function load() {
  const pick = (name: string) => {
    const body = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
    if (body === undefined) throw new Error(`${name} 源码未找到`)
    return body
  }
  const node = (className = ''): StubNode => ({
    className,
    textContent: '',
    replaceWith(replacement) { this.textContent = replacement.textContent },
  })
  const make = (_tag: string, className: string) => node(className)
  const renderMarkdownInto = (target: StubNode, text: string) => { target.textContent = text }
  const api = Function('make', 'renderMarkdownInto',
    `${pick('settleMarkdown')}\n${pick('renderMemberContent')}\n${pick('settleMemberBody')}\nreturn { settleMemberBody, renderMemberContent }`,
  )(make, renderMarkdownInto) as {
    settleMemberBody(view: { body: string; text: StubNode }, fallback?: unknown): string
    renderMemberContent(view: { body: string; text: StubNode }, text: unknown): unknown
  }
  /** 一张"模型中途说了一堆、服务端另有结论"的卡片。 */
  const view = (streamed: string) => {
    const card = { body: streamed, text: node('text') }
    api.renderMemberContent(card, streamed)
    return card
  }
  return { ...api, view }
}

describe('成员卡片落定时的正文取值', () => {
  it('服务端给了正文：用它，**不**留着模型中途说的话', () => {
    const f = load()
    // 流式期间攒下来的是模型的自我怀疑，服务端的结论是那份清单。
    const card = f.view('记录：cid 336 的 rootCid 是 268，属已发布文章的未发布修改稿……')
    const settled = f.settleMemberBody(card, '| cid | 标题 | 分类 |\n| 351 | AI Agent 开发 Vlog | 其他 |')

    expect(settled).toContain('| cid | 标题 | 分类 |')
    expect(card.text.textContent, '卡片上留着的还是模型中途那句话').not.toContain('rootCid')
    expect(card.body).toContain('| cid | 标题 | 分类 |')
  })

  it('服务端正文是空串时**回落到**攒下来的内容（不能让卡片空掉）', () => {
    const f = load()
    const card = f.view('模型说的话')
    // `''` 是合法值：用 `??` 判断的话这里不会回落，卡片会被清空。
    expect(f.settleMemberBody(card, '')).toBe('模型说的话')
    expect(card.text.textContent).toBe('模型说的话')
  })

  it('服务端什么都没给（取消/异常）时同样回落', () => {
    const f = load()
    const card = f.view('模型说的话')
    expect(f.settleMemberBody(card, undefined)).toBe('模型说的话')
    const blank = { body: '', text: { className: 'text', textContent: '', replaceWith() {} } }
    expect(f.settleMemberBody(blank, undefined)).toBe('')
  })
})

describe('接线：四个终态都走同一条取值规则', () => {
  /**
   * 判据落在源码形状上（本插件没有浏览器工装）：终态分支必须把**服务端正文**交给
   * `settleMemberBody`，而不是把攒下来的内容或 `question` 交出去。
   *
   * 它防的是"有人改回旧写法"——旧写法是 `settleMemberBody(view, event.question ?? event.detail)`
   * 与 `view.body === '' ? … : view.body`，两者都会让卡片显示模型中途的话。
   */
  it('waiting / external_pending / failed-cancelled 三处都传 event.detail', () => {
    const settleCalls = [...source.matchAll(/settleMemberBody\(view, ([^)]*)\)/g)].map(match => match[1]!.trim())
    expect(settleCalls.length, '终态调用点变少了，检查是不是有人绕过了这条规则').toBeGreaterThanOrEqual(3)
    expect(settleCalls).toContain('event.detail')
    expect(settleCalls.some(call => call.includes('event.question')), 'waiting 又用 question 当正文了').toBe(false)
    expect(settleCalls.some(call => call.includes('view.body')), '又有分支把攒下来的内容当权威正文了').toBe(false)

    // succeeded 那条不走 settleMemberBody，单独核一次它的取值顺序。
    expect(source).toMatch(/const authoritative = typeof event\.detail === 'string' \? event\.detail\.trim\(\) : ''/)
    expect(source).toContain("const finalText = authoritative !== '' ? event.detail : view.body")
  })
})

describe('结果区高度：跟着内容走，但有上限', () => {
  it('不再写死 172px；有 max-height 上限且超出可滚', () => {
    const block = css.match(/\.dcard__slots \{[^}]*\}/)?.[0]
    expect(block, '.dcard__slots 规则没找到').toBeDefined()
    // 写死高度正是"六张卡片挤在一起、确认按钮要滚动才看得到"的原因。
    expect(block, '结果区又写死高度了').not.toMatch(/(^|[^-])height:\s*\d+px/)
    expect(block).toMatch(/max-height:\s*min\(56vh, 560px\)/)
    expect(block).toMatch(/overflow-y:\s*auto/)
  })
})
