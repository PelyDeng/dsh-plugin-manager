/**
 * 牛马大总管自己发言的流式转发。
 *
 * 大总管的话走 `chat` 事件整段下发，页面上就是「一句状态 → 长时间空白 → 整段蹦出」。
 * 这里锁住两条：它自己会话的正文增量会被转给当前回合；别人的会话、推理与工具参数不会。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerStorage } from '../src/storage/types.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'

/** 只实现本测试用到的两条通道：目录（`runTurn` 会读成员名单）与调度入口。 */
function context(): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: 'closedoff', packageName: 'dsh-closedoff', version: '1.0.0', displayName: '封闭化',
          description: '', entryPath: '/agents/closedoff', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

function fixture() {
  const store = { setSubtaskState: vi.fn() } as unknown as ButlerStorage
  const access = { mode: 'authenticated', ready() {}, resolve: () => undefined, assert() {} } as unknown as Access
  const config = { subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000 } as Config
  const console_ = new ButlerConsole(context(), config, access, store, '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), whenIdle: vi.fn(async () => {}) }
  const conversation = { id: conversationId, handle: { agent } }
  const runTurn = (console_ as unknown as {
    runTurn(value: unknown, text: string, signal: AbortSignal, onDelta?: (text: string) => void):
    Promise<{ outcome: { kind: string }; text: string }>
  }).runTurn.bind(console_)
  return { console_, conversation, agent, runTurn }
}

/** 一条宿主实时帧；只有 `agent/assistant-stream` 的那两种帧会走到这里。 */
const chunk = (text: string, type = 'text-delta') => ({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 1, chunk: { type, index: 0, text } })

describe('大总管自己的发言边收边上', () => {
  it('把本会话的正文增量转给当前回合，别的会话与推理帧不转', async () => {
    const f = fixture()
    const deltas: string[] = []
    const turn = f.runTurn(f.conversation, '看看今天园区的情况', new AbortController().signal, text => deltas.push(text))

    f.console_.observeStream(f.agent, chunk('今天共有 ') as never)
    f.console_.observeStream({ session: { id: 'closedoff-web-other' } }, chunk('别人的会话') as never)
    f.console_.observeStream(f.agent, chunk('内部推理', 'reasoning-delta') as never)
    f.console_.observeStream(f.agent, { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 } as never)
    f.console_.observeStream(f.agent, { type: 'chunk', attemptId: 'a', revision: 3, index: 1, time: 2, chunk: { type: 'tool-call-delta', index: 1, id: 'call', argumentsDelta: '{}' } } as never)
    f.console_.observeStream(f.agent, chunk('12 辆车入园。') as never)

    f.console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    const result = await turn
    expect(result.outcome).toEqual({ kind: 'completed' })
    expect(deltas).toEqual(['今天共有 ', '12 辆车入园。'])
  })

  it('回合结束后不再转发，避免把上一轮的增量续到下一轮上', async () => {
    const f = fixture()
    const deltas: string[] = []
    const turn = f.runTurn(f.conversation, '继续', new AbortController().signal, text => deltas.push(text))
    f.console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    await turn
    f.console_.observeStream(f.agent, chunk('迟到增量') as never)
    expect(deltas).toEqual([])
  })

  it('没有出口的回合（例如历史读取）不因为收到帧而报错', () => {
    const f = fixture()
    expect(() => f.console_.observeStream(f.agent, chunk('无人接收') as never)).not.toThrow()
  })
})
