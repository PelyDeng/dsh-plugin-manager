import { expect, test, vi } from 'vitest'
import { projectHistory } from '../src/history.ts'

vi.mock('@deepseek-ai/dsh-llm', async importOriginal => ({
  ...await importOriginal(),
  expandAssistantStream: stream => stream.frames,
}))

test('runtime language snapshots do not become user bubbles or rewrite prior reasoning', () => {
  const old = { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'Earlier English reasoning.' }, { type: 'text', text: '旧回答' }] } } }
  const events = [old, { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }, content: [{ type: 'text', text: '当前语言：简体中文' }] } }]
  expect(projectHistory(events)).toEqual(projectHistory([old]))
})

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
