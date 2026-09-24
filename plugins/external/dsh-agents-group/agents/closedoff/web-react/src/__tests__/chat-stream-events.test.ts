/**
 * SSE 十类事件分发的等价单测（批 1 DoD：删码安全前提）。
 *
 * 行为基准=旧 web/app.js handleEvent（app.js:610-714）+ src/web.ts 的发送面。
 * 通过 sendMessage + stub fetch 驱动真实控制流，断言 turn/board store 的投影。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals, manualSseResponse, resetStores, sseResponse, stubFetch } from './helpers.ts'
import type { StoreModules } from './helpers.ts'

installBrowserGlobals()

const { sendMessage, openConversation } = await import('../chat-controller.ts')
const controller = await import('../chat-controller.ts')

let stores: StoreModules

const CARD_DATA = {
  tool: 'closedoff_warning_page',
  group: 'risk',
  variant: 'records',
  sourceLabel: '预警报警查询',
  state: 'data',
  count: 2,
  shown: 2,
  note: '',
  cards: [
    { title: '预警一号', fields: [{ k: '状态', v: '持续', tone: 'orange' }] },
    { title: '预警二号', fields: [{ k: '状态', v: '已解除', tone: 'green' }] },
  ],
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  stores = await resetStores()
})

describe('POST /chat 单向事件流的投影', () => {
  it('conversation 事件确立会话并锁定模型（不再提交 modelSelection）', async () => {
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-1', model: { provider: 'p1', model: 'm1' } },
      { type: 'done', reason: 'completed', meta: { messageId: 'msg-1', branchSeq: 3, completedAt: 100 } },
    ]))
    await sendMessage('你好')
    expect(stores.session.useSessionStore.getState().conversationId).toBe('closedoff-web-1')
    const picker = stores.picker.usePickerStore.getState()
    expect(picker.selected).toEqual({ provider: 'p1', model: 'm1' })
    expect(picker.dirty).toBe(false)
  })

  it('delta 累加正文；thinking_snapshot 进入思考域；done 落 meta 与终态', async () => {
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-2' },
      { type: 'thinking_snapshot', text: '正在梳理问题', done: false },
      { type: 'delta', text: '结论：' },
      { type: 'delta', text: '园区正常' },
      { type: 'thinking_snapshot', text: '整理完毕', done: true },
      {
        type: 'done', reason: 'completed',
        meta: { messageId: 'msg-2', branchSeq: 9, completedAt: 1234, runMs: 4200, ttftMs: 380, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      },
    ]))
    await sendMessage('园区状态')
    const turn = stores.turn.useTurnStore.getState()
    expect(turn.active).toBe(false)
    const board = stores.board.useBoardStore.getState()
    // 归档：用户消息 + 助手消息，正文累加、thinking 终态、meta 齐全。
    expect(board.messages).toHaveLength(2)
    const assistant = board.messages[1]
    expect(assistant?.kind).toBe('assistant')
    if (assistant?.kind !== 'assistant') return
    expect(assistant.text).toBe('结论：园区正常')
    expect(assistant.thinking).toBe('整理完毕')
    expect(assistant.thinkingDone).toBe(true)
    expect(assistant.meta?.messageId).toBe('msg-2')
    expect(assistant.meta?.branchSeq).toBe(9)
    expect(assistant.meta?.runMs).toBe(4200)
    expect(assistant.meta?.ttftMs).toBe(380)
    expect(assistant.meta?.usage?.totalTokens).toBe(15)
  })

  it('tool_start/tool_end 维护 chips 生命周期与 loading 卡占位', async () => {
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-3' },
      {
        type: 'tool_start', callId: 'call-1', name: 'closedoff_warning_page',
        presentation: { tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询' },
      },
      { type: 'cards', callId: 'call-1', payload: { ...CARD_DATA, state: 'loading', count: 0, shown: 0, cards: [] } },
      { type: 'tool_end', callId: 'call-1', status: 'done' },
      { type: 'cards', callId: 'call-1', payload: CARD_DATA },
      { type: 'done', reason: 'completed' },
    ]))
    await sendMessage('查预警')
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.tools).toHaveLength(1)
    expect(assistant.tools[0]?.phase).toBe('done')
    expect(assistant.cards['call-1']?.state).toBe('data')
    expect(assistant.cards['call-1']?.cards).toHaveLength(2)
  })

  it('tool_end error 将已有卡片置败', async () => {
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-4' },
      { type: 'tool_start', callId: 'call-9', name: 'closedoff_black_page', presentation: { tool: 'closedoff_black_page', group: 'authorization', variant: 'records', sourceLabel: '黑名单' } },
      { type: 'tool_end', callId: 'call-9', status: 'error' },
      { type: 'done', reason: 'completed' },
    ]))
    await sendMessage('查黑名单')
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.tools[0]?.phase).toBe('error')
    expect(assistant.cards['call-9']?.state).toBe('error')
    expect(assistant.hasStructured).toBe(false) // 错误卡不算结构化结果（旧码口径）
  })

  it('fences/track/cameras/media 入数据面；track/media 顶掉同 callId 卡片并置 hasStructured', async () => {
    const points = [{ lon: 102.7, lat: 25.0 }, { lon: 102.71, lat: 25.01 }]
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-5' },
      { type: 'tool_start', callId: 'call-t', name: 'closedoff_vehicle_track', presentation: { tool: 'closedoff_vehicle_track', group: 'track', variant: 'records', sourceLabel: '车辆轨迹' } },
      { type: 'tool_end', callId: 'call-t', status: 'done' },
      { type: 'cards', callId: 'call-t', payload: { ...CARD_DATA, tool: 'closedoff_vehicle_track', group: 'track', sourceLabel: '车辆轨迹' } },
      { type: 'track', callId: 'call-t', points, vehicleNo: '云A7D00M' },
      { type: 'cameras', callId: 'call-t', cameras: [{ name: '北门组', devices: [{ deviceId: 'd1' }] }] },
      { type: 'fences', callId: 'call-f', payload: { name: '核心围栏' } },
      { type: 'media', callId: 'call-m', items: [{ startTime: '2026-09-25 08:00:00', timeLength: '12s', deviceId: 'd1', mediaUrl: 'http://x' }] },
      { type: 'done', reason: 'completed' },
    ]))
    await sendMessage('查轨迹')
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.cards['call-t']).toBeUndefined() // track 顶掉卡片
    expect(assistant.tracks['call-t']?.points).toEqual(points)
    expect(assistant.tracks['call-t']?.vehicleNo).toBe('云A7D00M')
    expect(assistant.tracks['call-t']?.groups).toEqual([{ name: '北门组', devices: [{ deviceId: 'd1' }] }])
    expect(assistant.fences['call-f']).toEqual({ name: '核心围栏' })
    expect(assistant.media['call-m']).toHaveLength(1)
    expect(assistant.hasStructured).toBe(true)
  })

  it('流内 error 事件渲染为错误终态并归档', async () => {
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-6' },
      { type: 'error', message: '智能体回答失败: 上游超时' },
    ]))
    await sendMessage('再来一次')
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.terminalMessage).toBe('请求失败：智能体回答失败: 上游超时')
    expect(assistant.terminalTone).toBe('error')
    expect(stores.session.useSessionStore.getState().status.kind).toBe('ok')
  })

  it('非流式失败（HTTP 4xx/5xx JSON）回填输入框并给出错误终态', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: '智能体正在回答上一条问题' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    }))
    await sendMessage('被拒的问题')
    const board = stores.board.useBoardStore.getState()
    expect(board.messages).toHaveLength(2)
    const assistant = board.messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.terminalMessage).toContain('智能体正在回答上一条问题')
    expect(stores.composer.useComposerStore.getState().draft).toBe('被拒的问题')
  })

  it('停止：abort 后按 aborted 收尾（无续订语义，流即终态）', async () => {
    const manual = manualSseResponse()
    stubFetch(manual.response)
    const pending = sendMessage('慢慢回答')
    // 等到流建立并消费 conversation 事件。
    await vi.waitFor(() => expect(stores.turn.useTurnStore.getState().active).toBe(true))
    manual.push({ type: 'conversation', conversationId: 'closedoff-web-7' })
    await vi.waitFor(() => expect(stores.session.useSessionStore.getState().conversationId).toBe('closedoff-web-7'))
    controller.stopSend()
    manual.close()
    await pending
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.finishReason).toBeUndefined()
    expect(assistant.terminalMessage).toContain('已停止')
    expect(stores.turn.useTurnStore.getState().active).toBe(false)
  })

  it('打开历史会话走 restore（/history → board 五类投影）', async () => {
    const history = {
      history: [
        { role: 'user', text: '昨天的预约' },
        {
          role: 'assistant', text: '共 2 条预约', thinking: '查询预约表', thinkingDone: true,
          tools: [{ callId: 'c1', name: 'closedoff_reservation_approval_page', status: 'ok', time: 1000, durMs: 250 }],
          tracks: {}, fences: {}, media: {},
          cards: { c1: CARD_DATA },
          time: 2000, done: true, finishReason: 'completed', messageId: 'm-1', branchSeq: 5,
          completedAt: 2000, runMs: 1000, ttftMs: 100,
        },
      ],
      feedback: [{ messageId: 'm-1', rating: 'positive' }],
    }
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input))
      if (String(input).includes('/identity')) {
        return Promise.resolve(new Response(JSON.stringify({ mode: 'standalone', key: 'tester', label: 't' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (String(input).includes('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ groups: [], failures: [], selected: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (String(input).includes('/history')) {
        return Promise.resolve(new Response(JSON.stringify(history), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], nextOffset: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))
    const opened = await openConversation('closedoff-web-9')
    expect(opened).toBe(true)
    const board = stores.board.useBoardStore.getState()
    expect(board.messages).toHaveLength(2)
    const assistant = board.messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.tools[0]?.phase).toBe('done')
    expect(assistant.cards['c1']?.count).toBe(2)
    expect(assistant.rating).toBe('positive')
    expect(stores.session.useSessionStore.getState().conversationId).toBe('closedoff-web-9')
  })
})
