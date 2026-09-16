/**
 * 思考行。
 *
 * 这一段没有浏览器验收（本插件没有浏览器工装），但它是用户直接看到的东西，两条性质错了
 * 就会当场看得出来：快照必须**替换**而不是追加（追加会把每次更新拼成一长串重复文字），
 * 视图已经不在时（汇总后清空气泡，迟到的快照仍会到达）不能抛错。所以按仓库既有做法
 * （见 closedoff 的 `web-analysis.test.ts`）把函数取出来、用替身视图跑一遍。
 *
 * 成员与大总管共用 `.think` 这一套结构：成员的是执行方上报的脱敏投影，大总管的是它自己
 * 这一轮的推理；大总管那条挂在它自己的气泡上，且位于正文之前。
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

describe('大总管气泡里的思考行', () => {
  /**
   * 取出 `butlerThinking` 与 `attachButlerThinking`：两者依赖页面状态、气泡与思考行，
   * 用替身注入后单独跑。
   */
  function loadButlerThinking() {
    const thinkingBody = source.match(/function butlerThinking\(thinking\) \{[\s\S]*?\n\}\n/)?.[0]
    const attachBody = source.match(/function attachButlerThinking\(speech\) \{[\s\S]*?\n\}\n/)?.[0]
    if (thinkingBody === undefined || attachBody === undefined) throw new Error('大总管思考行源码未找到')
    const calls: { inserted: string[]; thinking: string[]; areaMade: number } = { inserted: [], thinking: [], areaMade: 0 }
    const speech: { think?: unknown; bubble: { insertBefore(node: unknown, before: unknown): void }; body: object } = {
      bubble: { insertBefore: (node: unknown, before: unknown) => { calls.inserted.push(String(before === speech.body ? 'before-body' : 'elsewhere')); void node } },
      body: {},
    }
    const state = { butlerSpeech: null as unknown, butlerThinking: '' }
    const thinkingArea = () => { calls.areaMade += 1; return { node: { name: 'think' }, preview: {}, body: {} } }
    const setThinking = (_view: unknown, thinking: string) => { calls.thinking.push(thinking) }
    const loaded = Function('state', 'thinkingArea', 'setThinking',
      `${attachBody}\n${thinkingBody}\nreturn { butlerThinking, attachButlerThinking }`)(state, thinkingArea, setThinking) as {
        butlerThinking(thinking: string): void
        attachButlerThinking(view: unknown): void
      }
    return { ...loaded, state, speech, calls }
  }

  it('只有思考、还没有正文时不新开气泡（重试掉的那版不留空消息）', () => {
    const f = loadButlerThinking()
    // 状态里没有当前气泡：思考只入缓冲，不建行、不插 DOM。
    f.butlerThinking('先看通行记录。')
    expect(f.state.butlerThinking).toBe('先看通行记录。')
    expect(f.calls.areaMade).toBe(0)
    expect(f.calls.inserted).toEqual([])
    expect(f.calls.thinking).toEqual([])
    expect(f.state.butlerSpeech).toBeNull()
  })

  it('气泡出现后才挂思考行：按需创建一次，位置在正文之前', () => {
    const f = loadButlerThinking()
    f.butlerThinking('先看通行记录。')
    f.state.butlerSpeech = f.speech
    f.attachButlerThinking(f.speech)
    expect(f.calls.areaMade).toBe(1)
    expect(f.calls.inserted).toEqual(['before-body'])
    expect(f.calls.thinking).toEqual(['先看通行记录。'])
  })

  it('已存在的思考行不再重复插入，快照仍按覆盖语义交给 setThinking', () => {
    const f = loadButlerThinking()
    f.butlerThinking('第一段。')
    f.state.butlerSpeech = f.speech
    f.attachButlerThinking(f.speech)
    f.butlerThinking('第一段。\n第二段。')
    expect(f.calls.areaMade).toBe(1)
    expect(f.calls.inserted).toEqual(['before-body'])
    expect(f.calls.thinking).toEqual(['第一段。', '第一段。\n第二段。'])
  })

  it('换尝试或开新一轮时清空缓冲，旧思考不挂到新气泡上', () => {
    // 源码级锁住接线：reset/user 清缓冲，增量与落定各自把缓冲挂上去。
    expect(source).toContain("case 'chat_reset':")
    expect(source).toMatch(/case 'chat_reset':[\s\S]{0,260}state\.butlerThinking = ''/)
    expect(source).toMatch(/case 'user':[\s\S]{0,600}state\.butlerThinking = ''/)
    expect(source).toMatch(/function butlerDelta\(text\) \{[\s\S]{0,200}attachButlerThinking\(speech\)/)
    expect(source).toMatch(/function butlerSettle\(text, time\) \{[\s\S]{0,400}attachButlerThinking\(view\)/)
  })

  it('页面把 chat_thinking 接到大总管自己的气泡上', () => {
    expect(source).toContain("case 'chat_thinking':")
    expect(source).toContain('butlerThinking(event.thinking)')
  })
})
