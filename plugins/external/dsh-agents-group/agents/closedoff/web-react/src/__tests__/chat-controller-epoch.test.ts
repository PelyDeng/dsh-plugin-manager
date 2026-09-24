/**
 * 代次隔离的等价单测（批 1 DoD：身份守卫）。
 *
 * 守卫语义：流事件/复原响应在上屏前核对 identityEpoch（登录态变化）、viewToken
 * （会话切换）与 abort 状态——三者任一变化即在途数据作废（旧 app.js 的
 * identityEpoch + responseEpochs + restore abort 的合并重写）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals, manualSseResponse, resetStores, stubFetch } from './helpers.ts'
import type { StoreModules } from './helpers.ts'

installBrowserGlobals()

const { sendMessage, stopSend, openConversation } = await import('../chat-controller.ts')
const { startFreshConversation } = await import('../chat-controller.ts')

let stores: StoreModules

beforeEach(async () => {
  vi.unstubAllGlobals()
  stores = await resetStores()
})

/** 推进微任务队列（让 reader.read() 的循环跑起来）。 */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('视图代次（viewToken）：切会话丢弃在途流', () => {
  it('流式中途切换会话，迟到事件不再写入新面板且旧流不归档', async () => {
    const manual = manualSseResponse()
    stubFetch(manual.response)
    const pending = sendMessage('长问题')
    await vi.waitFor(() => expect(stores.turn.useTurnStore.getState().active).toBe(true))
    manual.push(
      { type: 'conversation', conversationId: 'closedoff-web-a' },
      { type: 'delta', text: '前半' },
    )
    await vi.waitFor(() => expect(stores.turn.useTurnStore.getState().text).toBe('前半'))

    // 模拟切会话：beginViewChange（bump 代次）+ 清面板（openConversation 的
    // switchConversation 原子动作链；closedoff 在回答进行中禁止切换，此路径
    // 是放开该限制前的防御面）。
    stores.session.useSessionStore.getState().beginViewChange()
    stores.turn.useTurnStore.getState().reset()
    await tick()

    // 旧流的迟到事件：必须全部被丢弃。
    expect(() => manual.push({ type: 'delta', text: '后半' })).not.toThrow()
    await tick()
    expect(stores.turn.useTurnStore.getState().text).toBe('')

    await pending
    // 旧流不向新面板归档（收尾判定：视图已易主）。
    const texts = stores.board.useBoardStore.getState().messages.map(message => message.kind === 'assistant' ? message.text : '')
    expect(texts).not.toContain('前半')
    expect(texts).not.toContain('前半后半')
  })

  it('restore 在途时切换会话，迟到的复原结果不上屏', async () => {
    let releaseHistory: ((value: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/identity')) {
        return Promise.resolve(new Response(JSON.stringify({ mode: 'standalone', key: 'tester', label: 't' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (url.includes('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ groups: [], failures: [], selected: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (url.includes('/history')) {
        return new Promise<Response>(resolve => { releaseHistory = resolve })
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], nextOffset: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))

    const opening = openConversation('closedoff-web-slow')
    await vi.waitFor(() => expect(releaseHistory).not.toBeNull())
    // 复原还在路上时切走（闭包赋值不参与 TS 收窄，这里显式断言非空）。
    const release = releaseHistory as unknown as (value: Response) => void
    await startFreshConversation()
    release(new Response(JSON.stringify({
      history: [{ role: 'user', text: '迟到内容' }],
      feedback: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await opening
    expect(stores.board.useBoardStore.getState().messages).toHaveLength(0)
    expect(stores.board.useBoardStore.getState().restorePhase).toBe('idle')
  })
})

describe('身份代次（identityEpoch）：登录状态变化丢弃在途回包', () => {
  it('流式中途 bump identityEpoch，后续事件全部丢弃且不归档', async () => {
    const manual = manualSseResponse()
    stubFetch(manual.response)
    const pending = sendMessage('长问题二')
    await vi.waitFor(() => expect(stores.turn.useTurnStore.getState().active).toBe(true))
    manual.push({ type: 'conversation', conversationId: 'closedoff-web-b' })
    await vi.waitFor(() => expect(stores.session.useSessionStore.getState().conversationId).toBe('closedoff-web-b'))

    // 模拟身份失效（clearPrivateView 与旧码一致：bump epoch + abort 在途）。
    stores.session.useSessionStore.getState().clearPrivateView()
    await tick()

    expect(() => manual.push({ type: 'delta', text: '不该出现' })).not.toThrow()
    await tick()
    expect(stores.turn.useTurnStore.getState().text).toBe('')
    await pending
    // 身份已失效：不做归档收尾（界面由 clearPrivateView 接管）。
    expect(stores.board.useBoardStore.getState().messages).toHaveLength(0)
    expect(stores.session.useSessionStore.getState().identityReady).toBe(false)
  })

  it('stopSend 中断读取并通知服务端（/stop 只在有会话时调用）', async () => {
    const manual = manualSseResponse()
    const { calls } = stubFetch(manual.response)
    const pending = sendMessage('要停止的问题')
    await vi.waitFor(() => expect(stores.turn.useTurnStore.getState().active).toBe(true))
    manual.push({ type: 'conversation', conversationId: 'closedoff-web-c' })
    await vi.waitFor(() => expect(stores.session.useSessionStore.getState().conversationId).toBe('closedoff-web-c'))
    stopSend()
    manual.close()
    await pending
    await vi.waitFor(() => expect(calls.some(url => url.includes('/stop'))).toBe(true))
    const assistant = stores.board.useBoardStore.getState().messages[1]
    expect(assistant?.kind).toBe('assistant')
    if (assistant?.kind === 'assistant') {
      expect(assistant.terminalMessage).toContain('已停止')
    }
  })
})
