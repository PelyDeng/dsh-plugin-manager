import { expect, test, vi } from 'vitest'
import { projectHistory } from '../src/history.ts'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  expandAssistantStream: stream => stream.frames,
}))

test('durable attempts restore interrupted reasoning and final messages replace answer deltas', () => {
  const events = [
    { type: 'assistant/attempt', data: { stream: { frames: [
      { chunk: { type: 'reasoning-delta', text: '先看' } },
      { chunk: { type: 'reasoning-delta', text: '条件' } },
    ] } } },
  ]
  expect(projectHistory(events)).toEqual([{ role: 'assistant', text: '', reasoning: '先看条件' }])
  events.push({ type: 'assistant/message', data: { message: { content: [
    { type: 'reasoning', text: '先看条件，再计算' }, { type: 'text', text: '结果为 2' },
  ] } } })
  expect(projectHistory(events)).toEqual([{ role: 'assistant', text: '结果为 2', reasoning: '先看条件，再计算' }])
})
