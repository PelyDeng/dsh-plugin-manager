/**
 * thinking 250ms 节流投影的单测（批 1 DoD：thinking 节流）。
 *
 * 语义对齐服务端 scheduleThinking（src/web.ts）：窗口内快照合并、终态 done
 * 强制直投不吞尾帧。用 fake timers 驱动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals, resetStores } from './helpers.ts'

installBrowserGlobals()

const { useTurnStore, THINKING_INTERVAL_MS } = await import('../stores/turn.ts')

beforeEach(async () => {
  vi.useFakeTimers()
  await resetStores()
  useTurnStore.getState().begin()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('thinking_snapshot 的 250ms 节流投影', () => {
  it('间隔内的密集快照合并，只在窗口边界投影一次', () => {
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: '第一帧', done: false })
    expect(useTurnStore.getState().thinking).toBe('第一帧')

    // 窗口内的后续快照只保留最新。
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: '第二帧', done: false })
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: '第三帧', done: false })
    expect(useTurnStore.getState().thinking).toBe('第一帧') // 尚未到窗口边界

    vi.advanceTimersByTime(THINKING_INTERVAL_MS)
    expect(useTurnStore.getState().thinking).toBe('第三帧') // 合并投影最新帧
    expect(useTurnStore.getState().thinkingDone).toBe(false)
  })

  it('间隔超过窗口的快照立即投影', () => {
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: 'A', done: false })
    vi.advanceTimersByTime(THINKING_INTERVAL_MS + 1)
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: 'B', done: false })
    expect(useTurnStore.getState().thinking).toBe('B')
  })

  it('终态 done 强制直投，且取消未决的合并定时器', () => {
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: '进行中', done: false })
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: '进行中二', done: false })
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: '思考完成文本', done: true })
    expect(useTurnStore.getState().thinking).toBe('思考完成文本')
    expect(useTurnStore.getState().thinkingDone).toBe(true)

    // 定时器被取消：时间推进不再改变状态。
    vi.advanceTimersByTime(THINKING_INTERVAL_MS * 2)
    expect(useTurnStore.getState().thinking).toBe('思考完成文本')
  })

  it('reset 清理节流状态（新一轮不残留旧定时器）', () => {
    useTurnStore.getState().applyEvent({ type: 'thinking_snapshot', text: '旧回合', done: false })
    useTurnStore.getState().reset()
    useTurnStore.getState().begin()
    vi.advanceTimersByTime(THINKING_INTERVAL_MS * 3)
    expect(useTurnStore.getState().thinking).toBe('')
  })
})
