/**
 * 大总管气泡的「流式预览 + 落定替换」。
 *
 * 页面上这是用户直接看到的行为：增量续写同一条气泡，回合结束时用落定的正文替换预览
 * （重试过的那一版不该留在页面上）。本插件没有浏览器工装，所以按仓库既有做法把三个函数
 * 取出来、用替身视图与替身 `butlerMessage` 跑一遍。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

function load() {
  const pick = (name: string) => {
    const body = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
    if (body === undefined) throw new Error(`${name} 源码未找到`)
    return body
  }
  const created: { body: { textContent: string }; caret: { hidden: boolean }; text: string }[] = []
  const state: { butlerSpeech: null | { body: { textContent: string }; caret: { hidden: boolean }; text: string } } = { butlerSpeech: null }
  const butlerMessage = (text: string) => {
    const view = { body: { textContent: text }, caret: { hidden: true }, text }
    created.push(view)
    return view
  }
  const api = Function('state', 'butlerMessage',
    `${pick('butlerSpeech')}\n${pick('butlerDelta')}\n${pick('butlerSettle')}\nreturn { butlerDelta, butlerSettle }`,
  )(state, butlerMessage) as { butlerDelta(text: string): void; butlerSettle(text: string, time?: number): void }
  return { ...api, state, created }
}

describe('大总管气泡的流式预览', () => {
  it('增量续写同一条气泡', () => {
    const f = load()
    f.butlerDelta('收到老板，')
    f.butlerDelta('我这就安排。')
    expect(f.created).toHaveLength(1)
    expect(f.created[0]!.body.textContent).toBe('收到老板，我这就安排。')
    expect(f.created[0]!.caret.hidden).toBe(false)
  })

  it('落定的发言替换预览，不新起一条', () => {
    const f = load()
    f.butlerDelta('这是一版被重试掉的预览，写得很长')
    f.butlerSettle('这是最终回答。', 123)
    expect(f.created).toHaveLength(1)
    expect(f.created[0]!.body.textContent).toBe('这是最终回答。')
    expect(f.created[0]!.caret.hidden).toBe(true)
    expect(f.state.butlerSpeech).toBe(null)
  })

  it('没有正在流的气泡时，落定的发言照旧新起一条', () => {
    const f = load()
    f.butlerSettle('直接回答，没有预览。', 456)
    expect(f.created).toHaveLength(1)
    expect(f.created[0]!.body.textContent).toBe('直接回答，没有预览。')
    expect(f.created[0]!.caret.hidden).toBe(true)
  })
})
