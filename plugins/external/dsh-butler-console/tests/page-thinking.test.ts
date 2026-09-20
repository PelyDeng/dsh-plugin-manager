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
import { webSource } from './helpers/web-source.ts'
import { describe, expect, it } from 'vitest'

// 工作副本在 Windows 上是 CRLF：先统一换行，按行匹配的片段才取得到（同 closedoff 的做法）。
const source = webSource()

/** 取出 `setThinking` 的实现：页面是浏览器模块，测试只拿这一个函数的行为。
 *
 * 思考渲染并入帧合并（设计 v2：快照高频到达，richText 全量重渲每帧最多一次）：
 * 沙盒注入 scheduleFrame（手动冲洗）与 richText 替身（把快照写进 body.textContent）。
 */
function loadSetThinking(): { setThinking(view: unknown, thinking: string): void; flush(): void; pending(): number } {
  const body = source.match(/function setThinking\(view, thinking\) \{[\s\S]*?\n\}\n/)?.[0]
  if (body === undefined) throw new Error('setThinking 源码未找到')
  const jobs: (() => void)[] = []
  const scheduleFrame = (job: () => void) => { jobs.push(job) }
  const richText = (target: { textContent: string }, text: string) => { target.textContent = text; return target }
  const setThinking = Function('scheduleFrame', 'richText', `${body}; return setThinking`)(scheduleFrame, richText) as
    (view: unknown, thinking: string) => void
  return {
    setThinking,
    pending: () => jobs.length,
    flush: () => { for (const run of jobs.splice(0, jobs.length)) run() },
  }
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
  it('快照替换整行，不追加；渲染按帧合并（一帧最多渲一次）', () => {
    const f = loadSetThinking()
    const view = bubble()
    f.setThinking(view, '先看今天的通行记录。')
    f.setThinking(view, '先看今天的通行记录。再核对危化车。')
    // 两次快照只排了一帧；帧没冲之前 body 还是旧的。
    expect(f.pending()).toBe(1)
    f.flush()
    expect(view.think.body.textContent).toBe('先看今天的通行记录。再核对危化车。')
    expect(view.think.node.hidden).toBe(false)
  })

  it('摘要行只留最后一行非空内容', () => {
    const f = loadSetThinking()
    const streaming = bubble()
    f.setThinking(streaming, '先看今天的通行记录。\n正在生成…')
    f.flush()
    expect(streaming.think.preview.textContent).toBe('正在生成…')
    const trailing = bubble()
    f.setThinking(trailing, '先看今天的通行记录。\n\n   ')
    f.flush()
    expect(trailing.think.preview.textContent).toBe('先看今天的通行记录。')
  })

  it('汇总后清空气泡时，迟到的快照不抛错', () => {
    const f = loadSetThinking()
    expect(() => f.setThinking(undefined, '迟到的思考')).not.toThrow()
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
   * 取出 `butlerThinking` / `attachButlerThinking` / `dropThinkingOnlySpeech`：三者依赖页面状态、
   * 气泡与思考行，用替身注入后单独跑。
   */
  function loadButlerThinking() {
    const pick = (name: string) => {
      const body = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
      if (body === undefined) throw new Error(`${name} 源码未找到`)
      return body
    }
    const thinkingBody = pick('butlerThinking')
    const attachBody = pick('attachButlerThinking')
    const dropBody = pick('dropThinkingOnlySpeech')
    const calls: { inserted: string[]; thinking: string[]; areaMade: number; removed: number; speechMade: number } =
      { inserted: [], thinking: [], areaMade: 0, removed: 0, speechMade: 0 }
    const caret = { hidden: true }
    const speech: {
      think?: unknown
      text: string
      thinkingOnly?: boolean
      caret: { hidden: boolean }
      bubble: { insertBefore(node: unknown, before: unknown): void }
      body: object
      msg: { remove(): void }
    } = {
      text: '',
      caret,
      bubble: { insertBefore: (node: unknown, before: unknown) => { calls.inserted.push(String(before === speech.body ? 'before-body' : 'elsewhere')); void node } },
      body: {},
      msg: { remove: () => { calls.removed += 1 } },
    }
    const state = { butlerSpeech: null as unknown, butlerThinking: '' }
    const thinkingArea = () => { calls.areaMade += 1; return { node: { name: 'think' }, preview: {}, body: {} } }
    const setThinking = (_view: unknown, thinking: string) => { calls.thinking.push(thinking) }
    // 页面里的 `butlerSpeech()` 会先建一条大总管气泡再返回它；替身只记"开了一条"。
    const butlerSpeech = () => { calls.speechMade += 1; state.butlerSpeech = speech; return speech }
    const loaded = Function('state', 'thinkingArea', 'setThinking', 'butlerSpeech',
      `${attachBody}\n${dropBody}\n${thinkingBody}\nreturn { butlerThinking, attachButlerThinking, dropThinkingOnlySpeech }`)(
      state, thinkingArea, setThinking, butlerSpeech,
    ) as {
      butlerThinking(thinking: string): void
      attachButlerThinking(view: unknown): void
      dropThinkingOnlySpeech(): void
    }
    return { ...loaded, state, speech, calls }
  }

  it('第一条思考就开气泡并把思考行挂上：用户看得到"在想"（改造前是卡着不动、结果突然出现）', () => {
    const f = loadButlerThinking()
    f.butlerThinking('先看通行记录。')
    expect(f.calls.speechMade).toBe(1)
    expect(f.state.butlerSpeech).toBe(f.speech)
    expect(f.calls.areaMade).toBe(1)
    expect(f.calls.inserted).toEqual(['before-body'])
    expect(f.calls.thinking).toEqual(['先看通行记录。'])
    // 还没吐字 ⇒ 这条气泡算"只有思考"，换尝试时要能撤掉。
    expect(f.speech.thinkingOnly).toBe(true)
    expect(f.speech.caret.hidden).toBe(false)
  })

  it('气泡里已经有正文之后，思考行照旧挂（覆盖语义）', () => {
    const f = loadButlerThinking()
    f.speech.text = '我按下面的方式拆了任务。'
    f.butlerThinking('第一段。')
    f.butlerThinking('第一段。\n第二段。')
    expect(f.calls.speechMade).toBe(1)
    expect(f.calls.areaMade).toBe(1)
    expect(f.calls.inserted).toEqual(['before-body'])
    expect(f.calls.thinking).toEqual(['第一段。', '第一段。\n第二段。'])
    expect(f.speech.thinkingOnly).toBe(false)
  })

  it('撤掉"只有思考、还没有正文"的气泡；有正文的不撤', () => {
    const f = loadButlerThinking()
    f.butlerThinking('只推理、还没吐字。')
    f.dropThinkingOnlySpeech()
    expect(f.calls.removed).toBe(1)
    expect(f.state.butlerSpeech).toBeNull()
    // 有正文的那条：换尝试时留给落定替换，不在这里删（删了正文就没了）。
    const g = loadButlerThinking()
    g.butlerThinking('第一段。')
    g.speech.text = '正文已经出来了。'
    g.dropThinkingOnlySpeech()
    expect(g.calls.removed).toBe(0)
  })

  it('思考行只创建一次：重复挂同一份快照不会插入第二行', () => {
    const f = loadButlerThinking()
    // 直接调 attach（落定正文那条路径就是这么挂的）：思考行按需创建，第二次只是重写内容。
    f.state.butlerThinking = '第一段。'
    f.attachButlerThinking(f.speech)
    f.attachButlerThinking(f.speech)
    expect(f.calls.areaMade).toBe(1)
    expect(f.calls.inserted).toEqual(['before-body'])
    expect(f.calls.thinking).toEqual(['第一段。', '第一段。'])
  })

  it('换尝试、开新一轮、派出任务时都撤掉只有思考的那条气泡，缓冲一并清空', () => {
    // 源码级锁住接线：三条清场路径都走同一个函数（不能只清缓冲、把空气泡留在页面上）。
    expect(source).toMatch(/case 'chat_reset':[\s\S]{0,400}dropThinkingOnlySpeech\(\)/)
    expect(source).toMatch(/case 'user':[\s\S]{0,600}dropThinkingOnlySpeech\(\)/)
    expect(source).toMatch(/case 'plan':[\s\S]{0,900}dropThinkingOnlySpeech\(\)/)
    expect(source).toMatch(/function butlerDelta\(text\) \{[\s\S]{0,200}attachButlerThinking\(speech\)/)
    expect(source).toMatch(/function butlerSettle\(text, time\) \{[\s\S]{0,400}attachButlerThinking\(view\)/)
  })

  it('页面把 chat_thinking 接到大总管自己的气泡上', () => {
    expect(source).toContain("case 'chat_thinking':")
    expect(source).toContain('butlerThinking(event.thinking)')
  })
})
