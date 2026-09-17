// 本文件原本测 `src/assistant-stream.ts` 的 `onAssistantDelta`。P4 把那 39 行迁进运行时
// （`packages/runtime/src/projection.ts`）、closedoff 不再持有实时通道的实现，所以用例改为
// 直接钉运行时的那份实现——文件名随之改成 `runtime-projection`，避免指向已不存在的模块。
// 原文件第 35–56 行的 `it.each(['completed','aborted','error'])` 只调 `projectHistory`，
// 已按盘点文档迁入 `presentation.test.ts`。
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { onAssistantDelta } from '../../../packages/runtime/src/index.ts'

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

  it('ignores payloads without a frame instead of failing the whole turn', () => {
    const on = vi.fn()
    const receive = vi.fn()
    onAssistantDelta({ on } as unknown as Context, receive)
    const call = on.mock.calls[0]
    if (call === undefined) throw new Error('Live listener was not registered')
    const [, listener] = call
    const agent = { session: { id: 'first' } }
    expect(() => listener({ agent, frame: undefined })).not.toThrow()
    expect(receive).not.toHaveBeenCalled()
  })
})
