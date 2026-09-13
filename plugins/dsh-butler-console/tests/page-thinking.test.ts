/**
 * 成员气泡里的思考行。
 *
 * 这一段没有浏览器验收（本插件没有浏览器工装），但它是用户直接看到的东西，两条性质错了
 * 就会当场看得出来：快照必须**替换**而不是追加（追加会把每次更新拼成一长串重复文字），
 * 视图已经不在时（汇总后清空气泡，迟到的快照仍会到达）不能抛错。所以按仓库既有做法
 * （见 closedoff 的 `web-analysis.test.ts`）把函数取出来、用替身视图跑一遍。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 工作副本在 Windows 上是 CRLF：先统一换行，按行匹配的片段才取得到（同 closedoff 的做法）。
const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

/** 取出 `setThinking` 的实现：页面是浏览器模块，测试只拿这一个函数的行为。 */
function loadSetThinking(): (view: unknown, thinking: string) => void {
  const body = source.match(/function setThinking\(view, thinking\) \{[\s\S]*?\n\}\n/)?.[0]
  if (body === undefined) throw new Error('setThinking 源码未找到')
  return Function(`${body}; return setThinking`)() as (view: unknown, thinking: string) => void
}

/** 一个成员气泡的思考行替身。 */
function bubble() {
  return {
    think: {
      node: { hidden: true },
      preview: { textContent: '', hidden: false },
      body: { textContent: '' },
    },
  }
}

describe('成员气泡里的思考行', () => {
  it('快照替换整行，不追加', () => {
    const setThinking = loadSetThinking()
    const view = bubble()
    setThinking(view, '先看今天的通行记录。')
    setThinking(view, '先看今天的通行记录。再核对危化车。')
    expect(view.think.body.textContent).toBe('先看今天的通行记录。再核对危化车。')
    expect(view.think.node.hidden).toBe(false)
  })

  it('摘要行只留最后一行非空内容', () => {
    const setThinking = loadSetThinking()
    const streaming = bubble()
    setThinking(streaming, '先看今天的通行记录。\n正在生成…')
    expect(streaming.think.preview.textContent).toBe('正在生成…')
    const trailing = bubble()
    setThinking(trailing, '先看今天的通行记录。\n\n   ')
    expect(trailing.think.preview.textContent).toBe('先看今天的通行记录。')
  })

  it('汇总后清空气泡时，迟到的快照不抛错', () => {
    const setThinking = loadSetThinking()
    expect(() => setThinking(undefined, '迟到的思考')).not.toThrow()
  })

  it('正文仍然是追加，思考行不改写正文', () => {
    // 正文与思考两条通道各管各的：思考行覆盖，正文追加。
    expect(source).toContain('view.body += event.delta')
    expect(source).toContain("case 'subtask_thinking':")
    expect(source).toContain('setThinking(state.bubbles.get(event.id), event.thinking)')
  })
})
