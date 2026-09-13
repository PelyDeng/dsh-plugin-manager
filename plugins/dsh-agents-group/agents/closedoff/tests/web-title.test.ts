import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { webApp } from './web-source.ts'

afterEach(() => vi.useRealTimers())

it('refreshes only the first pending title and stops after generation, manual naming, navigation or timeout', async () => {
  vi.useFakeTimers()
  const refresh = vi.fn(async () => undefined)
  const state = { identityEpoch: 1, identityReady: true, conversationId: 'current', sidebar: { refresh }, setTimeout, clearTimeout, Date, Promise }
  // 按函数名逐个取出来跑：标题刷新块夹在别的接线中间，按位置切片会连别人的代码一起带进 vm。
  const block = ['stopTitleRefresh', 'syncConversationUrl', 'startTitleRefresh', 'acceptTitleList'].map(name => {
    const start = webApp.indexOf(`  function ${name}(`)
    const end = start < 0 ? -1 : webApp.indexOf('\n  }\n', start)
    if (start < 0 || end < 0) throw new Error(`没有找到 ${name} 的实现`)
    return webApp.slice(start, end + 4)
  }).join('\n')
  const watcher = runInNewContext(`var titleRefresh; ${block}; ({ start: startTitleRefresh, accept: acceptTitleList })`, state)

  watcher.start('current')
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(1)
  watcher.accept({ items: [{ id: 'current', titleSource: 'automatic' }] })
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(2)
  watcher.accept({ items: [{ id: 'current', titleSource: 'generated' }] })
  await vi.advanceTimersByTimeAsync(10000)
  expect(refresh).toHaveBeenCalledTimes(2)

  watcher.start('current')
  watcher.accept({ items: [{ id: 'current', titleSource: 'manual' }] })
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(2)
  watcher.start('current'); state.conversationId = 'other'
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(2)

  state.conversationId = 'current'; refresh.mockClear(); watcher.start('current')
  await vi.advanceTimersByTimeAsync(66000)
  expect(refresh).toHaveBeenCalledTimes(32)
  await vi.advanceTimersByTimeAsync(10000)
  expect(refresh).toHaveBeenCalledTimes(32)
})
