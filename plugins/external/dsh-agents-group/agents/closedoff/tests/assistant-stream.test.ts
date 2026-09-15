import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { onAssistantDelta } from '../src/assistant-stream.ts'
import { projectHistory } from '../src/presentation.ts'

describe('DSH assistant stream presentation', () => {
  it('routes live attempts by Agent and rejects late frames after replacement or end', () => {
    const on = vi.fn()
    const receive = vi.fn()
    onAssistantDelta({ on } as unknown as Context, receive)
    const call = on.mock.calls[0]
    if (call === undefined) throw new Error('Live listener was not registered')
    const [name, listener] = call
    expect(name).toBe('agent/assistant-stream')
    const first = { session: { id: 'first' } }
    const second = { session: { id: 'second' } }
    const start = { type: 'start', attemptId: 'a', revision: 1, step: 2 }
    const delta = { type: 'chunk', attemptId: 'a', revision: 2, time: 120, chunk: { type: 'reasoning-delta', index: 0, text: '正在查询。' } }
    listener({ agent: first, frame: start })
    listener({ agent: second, frame: { ...start, step: 4 } })
    listener({ agent: first, frame: delta })
    listener({ agent: second, frame: delta })
    listener({ agent: first, frame: delta })
    listener({ agent: first, frame: { ...start, attemptId: 'b', revision: 3 } })
    listener({ agent: first, frame: delta })
    listener({ agent: second, frame: { type: 'end', attemptId: 'a', revision: 3 } })
    listener({ agent: second, frame: delta })
    expect(receive.mock.calls).toEqual([
      ['first', { time: 120, step: 2, chunk: delta.chunk }],
      ['second', { time: 120, step: 4, chunk: delta.chunk }],
    ])
  })

  it.each(['completed', 'aborted', 'error'])('restores %s embedded streams without changing durable branch offsets', reason => {
    const events = [
      { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 110, data: { step: 1, turn: 1 } },
      { type: reason === 'completed' ? 'assistant/message' : 'assistant/attempt', seq: 2, time: 180, data: {
        turn: 1, step: 1,
        stream: [
          { type: 'chunk', time: 120, chunk: { type: 'reasoning-delta', index: 0, text: '查询完成。' } },
          { type: 'chunk', time: 130, chunk: { type: 'tool-call-delta', index: 1, id: 'call', name: 'closedoff_vehicle_track', argumentsDelta: '{}' } },
          { type: 'chunk', time: 150, chunk: { type: 'text-delta', index: 2, text: '已返回' } },
        ],
        ...(reason === 'completed' ? { message: { id: 'answer', source: { provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text: '已返回完整结果' }, { type: 'reasoning', text: '查询完成。' }] } } : {}),
      } },
      { type: 'turn/end', seq: 3, time: 200, data: { reason: { kind: reason } } },
    ] as unknown as SessionEvent[]
    expect(projectHistory(events)[0]).toMatchObject({
      text: reason === 'completed' ? '已返回完整结果' : '已返回',
      thinking: '查询完成。', thinkingDone: true, done: true,
      finishReason: reason, ttftMs: 10, runMs: 100, branchSeq: 3,
      tools: [{ callId: 'call', name: 'closedoff_vehicle_track' }],
    })
  })
})
