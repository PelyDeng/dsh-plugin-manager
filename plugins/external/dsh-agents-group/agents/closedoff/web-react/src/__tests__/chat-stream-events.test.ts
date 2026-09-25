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

  it('失败 attempt：服务端在 done 前补发 tool_end(error)，查询行不悬挂在「查询中」', async () => {
    // 复审 N1：finish error/aborted 的 attempt 里 tool_start 之后 tool/result 不会再来，
    // 服务端 turn/end 收尾先补 tool_end(error) 再发 done——这里按修复后的真实序列断言
    // chip 落到 error、loading 卡置败，归档消息不再停在「正在查询…」。
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-13' },
      { type: 'tool_start', callId: 'call-h', name: 'closedoff_warning_page', presentation: { tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询' } },
      { type: 'tool_end', callId: 'call-h', status: 'error' },
      { type: 'error', message: '智能体回答失败: 上游超时' },
      { type: 'done', reason: 'error' },
    ]))
    await sendMessage('失败的问题')
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.tools[0]?.phase).toBe('error')
    expect(assistant.tools[0]?.resultState).toBe('error')
    expect(assistant.cards['call-h']?.state).toBe('error')
    expect(assistant.terminalTone).toBe('error')
  })

  it('兜底：tool_start 后直接 done（无 tool_end）时 chip 不停在 calling（store 收尾保持）', async () => {
    // done case 的 calling→done 收尾是前端最后一道防线；卡片的 loading 推进依赖服务端
    // 补发 tool_end（本用例只锁定 chip 相位，不放宽对卡片的口径）。
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-14' },
      { type: 'tool_start', callId: 'call-b', name: 'closedoff_warning_page', presentation: { tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询' } },
      { type: 'done', reason: 'aborted' },
    ]))
    await sendMessage('中断的问题')
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.tools[0]?.phase).toBe('done')
    expect(assistant.finishReason).toBe('aborted')
  })

  it('纯卡片查询：cards data 即置位 hasStructured/hasResult（流式期与归档一致）', async () => {
    // 旧 renderCards：查询卡落定（data/empty）即置位——正文业务表格据此剥离，
    // archive 固化后 restore 前后同形。无 track/fences/media 也必须置位。
    const manual = manualSseResponse()
    stubFetch(manual.response)
    const pending = sendMessage('查预警')
    await vi.waitFor(() => expect(stores.turn.useTurnStore.getState().active).toBe(true))
    manual.push(
      { type: 'conversation', conversationId: 'closedoff-web-10' },
      {
        type: 'tool_start', callId: 'call-c', name: 'closedoff_warning_page',
        presentation: { tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询' },
      },
      { type: 'cards', callId: 'call-c', payload: CARD_DATA },
    )
    // 流式期即置位（表格剥离不等 done）。
    await vi.waitFor(() => expect(stores.turn.useTurnStore.getState().hasStructured).toBe(true))
    expect(stores.turn.useTurnStore.getState().hasResult).toBe(true)
    manual.push({ type: 'delta', text: '结论如下。' }, { type: 'done', reason: 'completed' })
    manual.close()
    await pending
    const assistant = stores.board.useBoardStore.getState().messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    // 归档保持 hasStructured（restore 投影同口径，双路径显示一致）。
    expect(assistant.hasStructured).toBe(true)
  })

  it('cards empty 同置位（旧 renderCards：empty 也算结果落地）', async () => {
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-11' },
      { type: 'tool_start', callId: 'call-e', name: 'closedoff_black_page', presentation: { tool: 'closedoff_black_page', group: 'authorization', variant: 'records', sourceLabel: '黑名单' } },
      { type: 'cards', callId: 'call-e', payload: { ...CARD_DATA, tool: 'closedoff_black_page', group: 'authorization', sourceLabel: '黑名单', state: 'empty', count: 0, shown: 0, cards: [] } },
      { type: 'done', reason: 'completed' },
    ]))
    await sendMessage('查黑名单')
    const empty = stores.board.useBoardStore.getState().messages[1]
    if (empty?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(empty.cards['call-e']?.state).toBe('empty')
    expect(empty.hasStructured).toBe(true)
  })

  it('cards error 不置位（旧 renderCards 口径：仅 data/empty 算结果）', async () => {
    stubFetch(sseResponse([
      { type: 'conversation', conversationId: 'closedoff-web-12' },
      { type: 'tool_start', callId: 'call-x', name: 'closedoff_black_page', presentation: { tool: 'closedoff_black_page', group: 'authorization', variant: 'records', sourceLabel: '黑名单' } },
      { type: 'cards', callId: 'call-x', payload: { ...CARD_DATA, tool: 'closedoff_black_page', group: 'authorization', sourceLabel: '黑名单', state: 'error', count: 0, shown: 0, cards: [] } },
      { type: 'done', reason: 'completed' },
    ]))
    await sendMessage('查黑名单')
    const failed = stores.board.useBoardStore.getState().messages[1]
    if (failed?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(failed.cards['call-x']?.state).toBe('error')
    expect(failed.hasStructured).toBe(false)
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

  it('authenticated 模式顶栏显示名被 Auth 会话 username 覆盖（旧码 /auth/api/session 段）', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/identity')) {
        return Promise.resolve(new Response(JSON.stringify({ mode: 'authenticated', key: 'tester', label: '身份标签' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (url.includes('/auth/api/session')) {
        return Promise.resolve(new Response(JSON.stringify({ user: { username: 'zhangsan' }, csrf: 'c' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (url.includes('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ groups: [], failures: [], selected: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], nextOffset: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))
    stores.session.useSessionStore.setState({ identityReady: false, identityKey: '', identityLabel: '', identityMode: '' })
    await controller.bootstrap()
    // 先落 /identity 的 label，再被 session username 覆盖。
    await vi.waitFor(() => expect(stores.session.useSessionStore.getState().identityLabel).toBe('zhangsan'))
    expect(stores.session.useSessionStore.getState().identityMode).toBe('authenticated')
  })

  it('standalone 模式不请求 Auth 会话，显示名保持 /identity 的 label', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/identity')) {
        return Promise.resolve(new Response(JSON.stringify({ mode: 'standalone', key: 'tester', label: '测试用户' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      if (url.includes('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ groups: [], failures: [], selected: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], nextOffset: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))
    stores.session.useSessionStore.setState({ identityReady: false, identityKey: '', identityLabel: '', identityMode: '' })
    await controller.bootstrap()
    await vi.waitFor(() => expect(stores.session.useSessionStore.getState().identityReady).toBe(true))
    expect(stores.session.useSessionStore.getState().identityLabel).toBe('测试用户')
    expect(calls.some(url => url.includes('/auth/api/session'))).toBe(false)
  })
})
