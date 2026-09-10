import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { registerConversationTitles } from '../src/conversations.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap { 'session/title': { title: unknown; source?: { kind: string }; messageSeqs?: unknown } }
}

it('只同步首句自动标题和用户标题，规范空白与字符长度，持续监听至插件释放', async () => {
  const ctx = new Context(), fiber = await ctx.plugin(SessionStore), session = ctx.sessions.create(SessionId('owned'))
  const received: unknown[][] = []
  const dispose = registerConversationTitles(ctx, (...args) => received.push(args))
  try {
    for (const data of [
      { title: 'ignored', source: { kind: 'other' }, messageSeqs: [1] },
      { title: 'ignored', source: { kind: 'provider' }, messageSeqs: [1, 3] },
      { title: 'ignored', source: { kind: 'fallback' }, messageSeqs: [] },
      { title: 'ignored', source: { kind: 'provider' }, messageSeqs: '1' },
      { title: '\n  ', source: { kind: 'provider' }, messageSeqs: [1] },
      { title: 10, source: { kind: 'provider' }, messageSeqs: [1] },
    ]) session.append('session/title', data)
    expect(received).toEqual([])
    session.append('session/title', { title: '  第一\n  句话 ', source: { kind: 'fallback' }, messageSeqs: [1] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('session/title', { title: '😀'.repeat(110), source: { kind: 'provider' }, messageSeqs: [1] })
    session.append('session/title', { title: 'a'.repeat(99) + ' b', source: { kind: 'provider' }, messageSeqs: [1] })
    session.append('session/title', { title: '用户标题', source: { kind: 'user' }, messageSeqs: [] })
    expect(received).toEqual([
      ['owned', '第一 句话', false, false], ['owned', '😀'.repeat(100), false, true], ['owned', 'a'.repeat(99), false, true], ['owned', '用户标题', true, true],
    ])
    dispose()
    session.append('session/title', { title: 'disposed', source: { kind: 'user' }, messageSeqs: [] })
    expect(received).toHaveLength(4)
  } finally { dispose(); await fiber.dispose() }
})
