/**
 * 标题轮询节流的等价单测（删码评审 B F2：旧 tests/web-title.test.ts 随 vanilla
 * 前端删除，React 侧实现收敛进 stores/session.ts 后补回护栏）。
 *
 * 语义（旧 startTitleRefresh 口径）：首条消息后启动，2s 一拍、65s 窗口；列表里
 * 出现非自动标题（人工命名或宿主生成）即停；会话切换、身份代次变化、窗口到点
 * 也停。停轮询判断（shouldStopTitlePoll）由列表落地方调用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals, resetStores } from './helpers.ts'

installBrowserGlobals()

const session = await import('../stores/session.ts')

beforeEach(async () => {
  vi.useFakeTimers()
  await resetStores()
  session.useSessionStore.setState({ conversationId: 'conv-1' })
})

afterEach(() => {
  session.useSessionStore.getState().stopTitlePoll()
  vi.useRealTimers()
})

/** 每次用例注入独立的一拍动作替身（装配点是模块级单例）。 */
function installTick(): ReturnType<typeof vi.fn<() => Promise<void>>> {
  const tick = vi.fn(async () => {})
  session.setTitlePollTick(tick)
  return tick
}

describe('标题轮询的 2s 节拍与 65s 窗口', () => {
  it('按 2s 一拍刷新，节拍与窗口常量沿用旧口径', async () => {
    expect(session.TITLE_POLL_TICK_MS).toBe(2000)
    expect(session.TITLE_POLL_WINDOW_MS).toBe(65000)

    const tick = installTick()
    session.useSessionStore.getState().startTitlePoll('conv-1')
    expect(tick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(session.TITLE_POLL_TICK_MS)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('窗口内持续刷新，65s 到点后停（旧码 32 拍口径）', async () => {
    const tick = installTick()
    session.useSessionStore.getState().startTitlePoll('conv-1')
    await vi.advanceTimersByTimeAsync(66000)
    // t=2s..64s 共 32 拍；t=66s 的一拍已越过 65s 窗口，不再发起。
    expect(tick).toHaveBeenCalledTimes(32)
    await vi.advanceTimersByTimeAsync(10000)
    expect(tick).toHaveBeenCalledTimes(32)
  })

  it('再次启动时旧轮询作废，同一时刻至多一个在跑', async () => {
    const tick = installTick()
    session.useSessionStore.getState().startTitlePoll('conv-1')
    session.useSessionStore.getState().startTitlePoll('conv-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(tick).toHaveBeenCalledTimes(1)
  })
})

describe('停轮询条件（旧 stopTitleRefresh / acceptTitleList 口径）', () => {
  it('列表里出现非自动标题即停（手动改名或宿主生成）', async () => {
    const tick = installTick()
    const state = session.useSessionStore.getState()
    state.startTitlePoll('conv-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(tick).toHaveBeenCalledTimes(1)

    // 自动标题：继续轮询。
    expect(state.shouldStopTitlePoll([{ id: 'conv-1', title: '新对话', updatedAt: 0, titleSource: 'automatic' }])).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tick).toHaveBeenCalledTimes(2)

    // 非自动标题：落地方调用 stop 后不再刷新。
    expect(state.shouldStopTitlePoll([{ id: 'conv-1', title: '已命名', updatedAt: 0, titleSource: 'generated' }])).toBe(true)
    state.stopTitlePoll()
    await vi.advanceTimersByTimeAsync(10000)
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('shouldStopTitlePoll 的否定分支：无轮询、列表缺当前会话、自动标题都不停', () => {
    const state = session.useSessionStore.getState()
    expect(state.shouldStopTitlePoll([{ id: 'conv-1', title: 'x', updatedAt: 0, titleSource: 'manual' }])).toBe(false)
    state.startTitlePoll('conv-1')
    expect(state.shouldStopTitlePoll([])).toBe(false)
    expect(state.shouldStopTitlePoll([{ id: 'conv-1', title: 'x', updatedAt: 0, titleSource: 'automatic' }])).toBe(false)
    expect(state.shouldStopTitlePoll([{ id: 'conv-1', title: '手改', updatedAt: 0, titleSource: 'manual' }])).toBe(true)
  })

  it('会话切换或身份代次变化后，下一拍自停（tick 内核对）', async () => {
    const tick = installTick()
    const state = session.useSessionStore.getState()
    state.startTitlePoll('conv-1')
    session.useSessionStore.setState({ conversationId: 'other' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(tick).not.toHaveBeenCalled()

    session.useSessionStore.setState({ conversationId: 'conv-1' })
    state.startTitlePoll('conv-1')
    session.useSessionStore.setState(state => ({ identityEpoch: state.identityEpoch + 1 }))
    await vi.advanceTimersByTimeAsync(4000)
    expect(tick).not.toHaveBeenCalled()

    session.useSessionStore.setState({ identityEpoch: 0 })
    state.startTitlePoll('conv-1')
    session.useSessionStore.setState({ identityReady: false })
    await vi.advanceTimersByTimeAsync(4000)
    expect(tick).not.toHaveBeenCalled()
  })
})
