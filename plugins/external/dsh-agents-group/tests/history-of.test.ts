/**
 * `historyOf` 的**回合归属**与 `tail` 语义 —— 运行时侧的"哪一条算答案"。
 *
 * ## 为什么值得一组用例
 *
 * 业务原来各自算一次答案（blog 靠自己的请求表 + `findLast(m => m.turn === turn.turn && !m.interrupted)`），
 * 而运行时只给一个 `finalText`。把 `tail` 落进运行时之后，**"算数的正文"与"最后一条正文"的
 * 区别就成了共享口径** —— 而这个区别一旦被抹平，是**静默**的：交回的会是一次被中断的半句，
 * 而且不报错。
 *
 * 所以下面每一条都对着一个具体后果，尤其是"最后一条 `assistant/message` 被中断"那一条：
 * 它是 `tail` 与 `finalText` **分道扬镳**的唯一情形，也就是"拿 `finalText` 当答案"这个近似
 * 唯一会出错的地方。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { historyOf } from '../packages/runtime/src/conversation.ts'

const event = (type: string, seq: number, time: number, data: unknown): SessionEvent =>
  ({ type, seq, time, data } as unknown as SessionEvent)

const user = (seq: number, time: number, text: string, id = `u${seq}`): SessionEvent =>
  event('user/message', seq, time, { id, content: [{ type: 'text', text }] })

const assistant = (seq: number, time: number, text: string,
  options: { id?: string; interrupted?: boolean } = {}): SessionEvent =>
  event('assistant/message', seq, time, {
    message: { id: options.id ?? `a${seq}`, content: text === '' ? [] : [{ type: 'text', text }] },
    ...(options.interrupted === undefined ? {} : { interrupted: options.interrupted }),
  })

const turnStart = (seq: number, time: number, turn: number): SessionEvent =>
  event('turn/start', seq, time, { turn })

const turnEnd = (seq: number, time: number): SessionEvent =>
  event('turn/end', seq, time, { reason: { kind: 'completed' } })

describe('historyOf：回合归属', () => {
  it('每条消息带上它那一回合的回合号，`history.turn` 是最后一轮', () => {
    const history = historyOf([
      turnStart(0, 100, 1), user(1, 110, '第一问'), assistant(2, 120, '第一答'), turnEnd(3, 130),
      turnStart(4, 140, 2), user(5, 150, '第二问'), assistant(6, 160, '第二答'), turnEnd(7, 170),
    ], 'c1')
    expect(history.messages.map(message => [message.role, message.text, message.turn])).toEqual([
      ['user', '第一问', 1], ['assistant', '第一答', 1],
      ['user', '第二问', 2], ['assistant', '第二答', 2],
    ])
    expect(history.turn).toBe(2)
  })

  it('历史里没有 `turn/start` 时按**隐式单回合**处理（`tail` 仍算得出来）', () => {
    // 有些替身只发消息与 `turn/end`（不发 `turn/start`），这条钉住那种情形不会让 `tail` 失效。
    const history = historyOf([user(0, 100, '问'), assistant(1, 110, '答')], 'c1')
    expect(history.turn).toBeUndefined()
    expect(history.messages.map(message => message.turn)).toEqual([undefined, undefined])
    expect(history.tail?.text).toBe('答')
  })

  it('带出官方消息 id（业务用它把自己的记录对上；官方事件里**没有**业务的 requestId）', () => {
    const history = historyOf([
      user(0, 100, '问', 'msg-u'), assistant(1, 110, '答', { id: 'msg-a' }),
    ], 'c1')
    expect(history.messages.map(message => message.id)).toEqual(['msg-u', 'msg-a'])
  })

  it('空正文的消息不进历史，且 `finalText` 为空（既有行为，本次未改）', () => {
    const history = historyOf([user(0, 100, '问'), assistant(1, 110, ''), turnEnd(2, 120)], 'c1')
    expect(history.messages.map(message => message.text)).toEqual(['问'])
    expect(history.finalText).toBe('')
    expect(history.tail).toBeUndefined()
  })
})

describe('historyOf：tail 是"算数的正文"，不是"最后一条正文"', () => {
  it('⚠️ 最后一条 `assistant/message` 被中断时：`tail` 不是它，而 `finalText` 是它', () => {
    // **这是本组最重要的一条**：一轮里每步的正文后面都跟着工具调用，只有最后那条是答案；
    // 而"最后一条"若被中断（用户停止、模型被取消），它就不是答案。
    // 把两者抹平 —— 例如用 `finalText` 当答案 —— 会**静默**交出一次被中断的半句。
    const history = historyOf([
      turnStart(0, 100, 1), user(1, 110, '问'),
      assistant(2, 120, '算数的答案'),
      assistant(3, 130, '被打断的半句', { interrupted: true }),
      turnEnd(4, 140),
    ], 'c1')
    expect(history.finalText).toBe('被打断的半句')
    expect(history.tail?.text).toBe('算数的答案')
    // 判据的核心：两者**必须不同**。若哪天有人把 `tail` 实现成 `finalText` 的别名，这里会红。
    expect(history.tail?.text).not.toBe(history.finalText)
  })

  it('本回合没有可算数的正文时 `tail` 为 `undefined`，**不回退到上一轮**', () => {
    // 跨回合回退会把上一轮的答案当成本轮的交回物 —— 那比"没有答案"更糟（交错了东西）。
    const history = historyOf([
      turnStart(0, 100, 1), user(1, 110, '第一问'), assistant(2, 120, '第一答'), turnEnd(3, 130),
      turnStart(4, 140, 2), user(5, 150, '第二问'),
      assistant(6, 160, '第二轮的半句', { interrupted: true }), turnEnd(7, 170),
    ], 'c1')
    expect(history.turn).toBe(2)
    expect(history.tail).toBeUndefined()
    // `finalText` 仍有值（它取的是"最后一条 message"）——这正是两者分工不同的证据。
    expect(history.finalText).toBe('第二轮的半句')
  })

  it('一轮里多条未中断的 assistant 消息时，`tail` 取**最后**一条', () => {
    // 过程叙述（「让我先看看…」）都在前面，答案在最后。
    const history = historyOf([
      turnStart(0, 100, 1), user(1, 110, '问'),
      assistant(2, 120, '让我先看看…'),
      assistant(3, 130, '找到了相关文章！'),
      assistant(4, 140, '这是最终答案（3890 字）'),
      turnEnd(5, 150),
    ], 'c1')
    expect(history.tail?.text).toBe('这是最终答案（3890 字）')
    expect(history.tail?.time).toBe(140)
  })

  it('全被中断 ⇒ `tail` 为 `undefined`（调用方按自己的口径兜底）', () => {
    const history = historyOf([
      turnStart(0, 100, 1), user(1, 110, '问'),
      assistant(2, 120, '半句甲', { interrupted: true }),
      assistant(3, 130, '半句乙', { interrupted: true }),
    ], 'c1')
    expect(history.tail).toBeUndefined()
    expect(history.finalText).toBe('半句乙')
  })
})

describe('historyOf：`assistant/attempt` 刻意不进历史', () => {
  it('失败/重试的尝试不出现（它按定义就是 interrupted，永远不可能是 tail）', () => {
    // 它**不**进历史是刻意的，理由见 `historyOf` 的注释：① 恒为 interrupted，不可能算数；
    // ② 它的正文要从 `data.stream` 展开（另一套机制）；③ 要不要把失败尝试的过程叙述交回，
    // 是业务口径，应当由业务自己声明，而不是运行时替所有 Agent 决定。
    const history = historyOf([
      turnStart(0, 100, 1), user(1, 110, '问'),
      event('assistant/attempt', 2, 120, { step: 1, stream: [] }),
      assistant(3, 130, '真正的答复'),
      turnEnd(4, 140),
    ], 'c1')
    expect(history.messages.map(message => message.text)).toEqual(['问', '真正的答复'])
    expect(history.tail?.text).toBe('真正的答复')
  })
})
