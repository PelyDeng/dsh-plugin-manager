/**
 * 三守卫 + 防抖重拉的等价单测（批 2a DoD 硬门；行为基准=旧 web/chat.js）。
 *
 * - 代次切换丢在途（epoch → viewToken）：activate/beginViewChange 后，迟到的流
 *   事件与重拉回包不再写任何 store；
 * - 乱序快照丢弃（refreshVersion → refreshTicket）：并发重拉，先发后至者丢弃；
 * - live 段保护（liveClock → liveClock+liveAt 新鲜度）：busy 重拉期间有新帧时
 *   本地 live 覆盖回包；live 过期（超 LIVE_FRESH_MS 无新帧）时回包生效；
 * - 60ms 防抖全量重拉语义保留；activate 清除挂起的防抖（旧 clearTimeout）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource, historyPayload, installBrowserGlobals, resetStores, stubApi, tick } from './helpers.ts'

installBrowserGlobals()

const { connect, handleStreamMessage, activate, refresh, scheduleRefresh, REFRESH_DEBOUNCE_MS } = await import('../chat-controller.ts')
const { useConversationStore } = await import('../stores/conversation.ts')
const { useSessionStore } = await import('../stores/session.ts')
const { useTurnStore, LIVE_FRESH_MS } = await import('../stores/turn.ts')

/** chat-history 的挂起闸门：非空时下一个请求挂起，测试手动放行。 */
interface HistoryGate {
  promise: Promise<Record<string, unknown>>
  resolve: (payload: Record<string, unknown>) => void
}
let gates: HistoryGate[] = []
let historyResponses: Array<Record<string, unknown>>
let historyCalls = 0
let calls: Array<{ action: string; args: Record<string, unknown> }>

function makeGate(): HistoryGate {
  let resolve!: (payload: Record<string, unknown>) => void
  const promise = new Promise<Record<string, unknown>>(settler => { resolve = settler })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  FakeEventSource.reset()
  await resetStores()
  gates = []
  historyResponses = []
  historyCalls = 0
  const stub = stubApi({
    'chat-feedback': () => ({ ok: true, value: { items: [] } }),
    'chat-history': async args => {
      historyCalls += 1
      const gate = gates.shift()
      if (gate !== undefined) return await gate.promise
      const id = String(args.conversationId)
      return historyResponses.shift() ?? historyPayload({ conversation: { id, title: id, updatedAt: 0, ready: true, parent: null, pinned: false } })
    },
  })
  calls = stub.calls
})

/** 让 conversation store 直接处于某会话（activate 全流程之外的轻量落位）。 */
function seatConversation(id: string): void {
  useConversationStore.getState().setConversationId(id)
}

describe('代次守卫（epoch → viewToken）：切会话丢在途', () => {
  it('流事件在会话切换后到达，不再写入新面板', () => {
    seatConversation('conv-a')
    connect('conv-a', useSessionStore.getState().viewToken)
    const streamA = FakeEventSource.instances.at(-1)
    expect(streamA?.url).toContain('/chat-events?conversationId=conv-a')

    // 正常路径：live 落地。
    streamA?.emit({ type: 'live', live: { text: 'A 的实时输出', reasoning: '' } })
    expect(useTurnStore.getState().live?.text).toBe('A 的实时输出')

    // 切会话（activate 原子动作段的同款状态推进）。
    useSessionStore.getState().beginViewChange()
    seatConversation('conv-b')
    const viewB = useSessionStore.getState().viewToken

    // 旧流的迟到消息：代次核对不满足，丢弃。
    expect(() => handleStreamMessage(JSON.stringify({ type: 'live', live: { text: '迟到内容', reasoning: '' } }), 'conv-a', viewB - 1)).not.toThrow()
    expect(useTurnStore.getState().live?.text).toBe('A 的实时输出')
    // 会话 id 核对：同代次但 id 已易主，同样丢弃。
    expect(() => handleStreamMessage(JSON.stringify({ type: 'changed' }), 'conv-a', viewB)).not.toThrow()
  })

  it('refresh 在途切会话，迟到回包不落地', async () => {
    seatConversation('conv-hang')
    const gate = makeGate()
    gates.push(gate)
    const refreshing = refresh()
    await tick()
    expect(historyCalls).toBe(1)

    useSessionStore.getState().beginViewChange()
    seatConversation('conv-next')
    gate.resolve(historyPayload({ busy: false, messages: [{ id: 'stale', role: 'user', seq: 1, time: 0, text: '旧会话内容' }] }))
    await refreshing
    await tick()

    // 旧会话的挂起回包被代次守卫丢弃：面板仍是空（新会话的 refresh 尚未发起）。
    expect(useConversationStore.getState().history).toBeNull()
  })

  it('activate 完整流程：切会话断开旧流并清面板', async () => {
    const stub = stubApi({
      'chat-models': () => ({ groups: [], failures: [], selected: null, default: null }),
      'chat-history': args => historyPayload({ conversation: { id: String(args.conversationId), title: 't', updatedAt: 0, ready: true, parent: null, pinned: false } }),
      'chat-feedback': () => ({ ok: true, value: { items: [] } }),
      attachments: () => [],
      'chat-list': () => ({ items: [], nextOffset: null }),
    })
    seatConversation('conv-old')
    connect('conv-old', useSessionStore.getState().viewToken)
    const oldStream = FakeEventSource.instances.at(-1)
    await activate('conv-new')
    expect(oldStream?.closed).toBe(true)
    expect(useConversationStore.getState().conversationId).toBe('conv-new')
    expect(useConversationStore.getState().history?.conversation.id).toBe('conv-new')
    expect(stub.calls.some(call => call.action === 'chat-models')).toBe(true)
  })
})

describe('乱序守卫（refreshVersion → refreshTicket）', () => {
  it('并发重拉：先发后至的旧回包丢弃，面板只认最新一票', async () => {
    seatConversation('conv-race')
    const gate = makeGate()
    gates.push(gate)
    const first = refresh()
    await tick()
    historyResponses.push(historyPayload({ busy: false, messages: [{ id: 'new', role: 'user', seq: 9, time: 0, text: '最新快照' }] }))
    const second = refresh()
    await second
    // 放行第一笔（更旧的快照）：ticket 已被第二笔顶掉，落地即丢。
    gate.resolve(historyPayload({ busy: false, messages: [{ id: 'old', role: 'user', seq: 1, time: 0, text: '过期快照' }] }))
    await first
    await tick()

    expect(historyCalls).toBe(2)
    const messages = useConversationStore.getState().history?.messages ?? []
    expect(messages.map(message => message.id)).toEqual(['new'])
  })
})

describe('live 段保护（liveClock → liveClock+liveAt）', () => {
  it('重拉期间收到新 live 帧：本地 live 覆盖 busy 回包', () => {
    seatConversation('conv-live')
    const clockAtStart = useTurnStore.getState().liveClock
    useTurnStore.getState().applyLive({ text: '更新的实时输出', reasoning: '思考中' })

    const data = historyPayload({ busy: true, live: { text: '回包里的旧 live', reasoning: '' } })
    const merged = useTurnStore.getState().mergeLive(data as never, clockAtStart)
    expect((merged as { live: { text: string } }).live.text).toBe('更新的实时输出')
  })

  it('live 过期（超时限无新帧）：不覆盖快照刷新的结果', () => {
    seatConversation('conv-stale')
    useTurnStore.getState().applyLive({ text: '很久以前的实时输出', reasoning: '' })
    const clockAtStart = useTurnStore.getState().liveClock
    // 时间前进超过 LIVE_FRESH_MS 且期间无新帧。
    const merged = useTurnStore.getState().mergeLive(
      historyPayload({ busy: true, live: { text: '回包 live', reasoning: '' } }) as never,
      clockAtStart,
      Date.now() + LIVE_FRESH_MS + 1,
    )
    expect((merged as { live: { text: string } }).live.text).toBe('回包 live')
  })

  it('非 busy 回包不保护（live 段随完成态让位给快照）', () => {
    seatConversation('conv-done')
    const clockAtStart = useTurnStore.getState().liveClock
    useTurnStore.getState().applyLive({ text: '尾帧', reasoning: '' })
    const merged = useTurnStore.getState().mergeLive(
      historyPayload({ busy: false, live: null }) as never,
      clockAtStart,
    )
    expect((merged as { live: unknown }).live).toBeNull()
  })
})

describe('防抖全量重拉（60ms 语义保留）', () => {
  it('snapshot/changed 密集到达只触发一次重拉', async () => {
    vi.useFakeTimers()
    seatConversation('conv-debounce')
    scheduleRefresh()
    scheduleRefresh()
    scheduleRefresh()
    expect(historyCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS)
    expect(historyCalls).toBe(1)
    vi.useRealTimers()
  })

  it('activate 清除挂起的防抖重拉（旧 clearTimeout）', async () => {
    vi.useFakeTimers()
    seatConversation('conv-pending')
    scheduleRefresh()
    stubApi({
      'chat-models': () => ({ groups: [], failures: [], selected: null, default: null }),
      attachments: () => [],
      'chat-list': () => ({ items: [], nextOffset: null }),
    })
    await activate(null)
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS * 4)
    // 挂起重拉已被清掉：chat-history 一次都不发。
    expect(calls.filter(call => call.action === 'chat-history')).toHaveLength(0)
    vi.useRealTimers()
  })

  it('snapshot 的 value 不直接渲染：统一走重拉管线（契约事实）', async () => {
    vi.useFakeTimers()
    seatConversation('conv-snapshot')
    const cleanup = connect('conv-snapshot', useSessionStore.getState().viewToken)
    const source = FakeEventSource.instances.at(-1)
    source?.emit({ type: 'snapshot', value: historyPayload({ messages: [{ id: 'direct', role: 'user', seq: 1, time: 0, text: '直写内容' }] }) })
    // 防抖窗口内：快照 value 没有直写面板。
    expect(useConversationStore.getState().history).toBeNull()
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS)
    // 重拉结果落地（stub 给空历史），value 里的「直写内容」从未出现。
    expect((useConversationStore.getState().history?.messages ?? []).some(message => message.id === 'direct')).toBe(false)
    vi.useRealTimers()
    cleanup()
  })
})

describe('订阅连接（connect 幂等）', () => {
  it('重复 connect 同一会话：旧流关闭，仅一条活动订阅（StrictMode 双订阅安全）', () => {
    seatConversation('conv-connect')
    const cleanupA = connect('conv-connect', useSessionStore.getState().viewToken)
    const first = FakeEventSource.instances.at(-1)
    const cleanupB = connect('conv-connect', useSessionStore.getState().viewToken)
    const second = FakeEventSource.instances.at(-1)
    expect(first).not.toBe(second)
    expect(first?.closed).toBe(true)
    expect(second?.closed).toBe(false)
    cleanupA()
    expect(second?.closed).toBe(false) // cleanup 只关自己那条流
    cleanupB()
    expect(second?.closed).toBe(true)
  })

  it('代次已推进时 connect 拒绝建立（在途 activate 的迟到段）', () => {
    const view = useSessionStore.getState().viewToken
    useSessionStore.getState().beginViewChange()
    const cleanup = connect('conv-late', view)
    expect(FakeEventSource.instances).toHaveLength(0)
    cleanup()
  })

  it('ping 心跳忽略；坏消息置顶层提示且不中断后续消息', () => {
    seatConversation('conv-bad')
    connect('conv-bad', useSessionStore.getState().viewToken)
    const source = FakeEventSource.instances.at(-1)
    source?.emit({ type: 'ping' })
    expect(useSessionStore.getState().notice).toBeNull()
    source?.emitRaw('{not-json')
    expect(useSessionStore.getState().notice?.text).toContain('对话流返回异常')
    source?.emit({ type: 'changed' })
    expect(useTurnStore.getState().live).toBeNull()
  })
})
