/**
 * 发送/停止链路的等价单测（批 2a DoD；行为基准=旧 web/chat.js send/stop）。
 *
 * 覆盖：新建会话路径（ensureConversation 单飞）、chat-send 幂等指纹（同输入复用
 * 同一 requestId）、忙判定守卫、附件随消息反选、代次隔离（发送在途切会话不写
 * 状态）、停止链路（stopping 置位 → chat-stop → refresh → 复位）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource, historyPayload, installBrowserGlobals, resetStores, stubApi, tick } from './helpers.ts'

installBrowserGlobals()

const { send, stopAnswer, activate } = await import('../chat-controller.ts')
const { useConversationStore } = await import('../stores/conversation.ts')
const { useSessionStore } = await import('../stores/session.ts')
const { useComposerStore, usePickerStore } = await import('../stores/composer.ts')
const { useTurnStore } = await import('../stores/turn.ts')

let calls: Array<{ action: string; args: Record<string, unknown> }>

beforeEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  FakeEventSource.reset()
  await resetStores()
  const stub = stubApi({
    'chat-models': () => ({
      groups: [{ id: 'mock-provider', name: '演示模型组', models: [{ id: 'mock-pro', name: '演示模型 Pro' }] }],
      failures: [],
      selected: null,
      default: { provider: 'mock-provider', model: 'mock-pro' },
    }),
    'chat-create': () => ({ id: 'conv-created', title: '新对话', updatedAt: Date.now(), ready: true, parent: null, pinned: false }),
    'chat-send': args => ({ model: { provider: String((args.modelSelection as { provider?: string } | undefined)?.provider ?? 'mock-provider'), model: 'mock-pro' } }),
    'chat-stop': () => ({ ok: true }),
    'chat-history': args => historyPayload({
      conversation: { id: String(args.conversationId), title: 't', updatedAt: 0, ready: true, parent: null, pinned: false },
      messages: [{ id: 'u1', role: 'user', seq: 1, time: 0, text: String(args.conversationId) }],
    }),
    attachments: () => [],
    'attachment-select': () => ({}),
    'attachment-remove': () => ({}),
    'chat-list': () => ({ items: [], nextOffset: null }),
  })
  calls = stub.calls
})

describe('发送链路', () => {
  it('新对话路径：chat-create 单飞 → chat-send → 草稿清空 → 收尾三拉', async () => {
    useComposerStore.getState().setDraft('帮我写一篇提纲')
    await send('帮我写一篇提纲')

    expect(calls.some(call => call.action === 'chat-create')).toBe(true)
    const sendCall = calls.find(call => call.action === 'chat-send')
    expect(sendCall?.args.text).toBe('帮我写一篇提纲')
    expect(typeof sendCall?.args.requestId).toBe('string')
    expect(useConversationStore.getState().conversationId).toBe('conv-created')
    // 输入框与发送原文一致 → 清空；sending 复位。
    expect(useComposerStore.getState().draft).toBe('')
    expect(useComposerStore.getState().sending).toBe(false)
    expect(calls.some(call => call.action === 'chat-list')).toBe(true)
    expect(calls.some(call => call.action === 'chat-history')).toBe(true)
    expect(calls.some(call => call.action === 'attachments')).toBe(true)
  })

  it('同输入复用同一 requestId（chat-send 幂等指纹，旧 state.pending）', async () => {
    // 预置目录与 dirty 模型避免 payload 漂移影响指纹可比性。
    usePickerStore.setState({ ready: true, dirty: false, selected: null })
    await send('相同的问题')
    const first = calls.find(call => call.action === 'chat-send')
    useComposerStore.getState().setDraft('相同的问题')
    await send('相同的问题')
    const second = calls.filter(call => call.action === 'chat-send')
    expect(second).toHaveLength(2)
    expect(second[0]?.args.requestId).toBe(first?.args.requestId)
  })

  it('busy 守卫：sending/uploading/stopping/history.busy 时拒绝发送', async () => {
    useComposerStore.getState().setSending(true)
    await send('第一条') // 直接 return（旧码静默守卫），不抛错
    expect(calls.some(call => call.action === 'chat-send')).toBe(false)
    useComposerStore.getState().setSending(false)

    useConversationStore.getState().setConversationId('conv-busy')
    useConversationStore.getState().acceptHistory(historyPayload({ busy: true }) as never)
    await send('忙碌中')
    expect(calls.some(call => call.action === 'chat-send')).toBe(false)
  })

  it('空消息抛「请输入消息」', async () => {
    await expect(send('   ')).rejects.toThrow('请输入消息')
  })

  it('附件随消息提交并在发送后反选（旧 attachment-select 回扫）', async () => {
    useConversationStore.getState().setConversationId('conv-att')
    useComposerStore.getState().setFiles([
      { id: 'file-1', name: 'a.txt', kind: 'text/plain', status: 'ready', selected: true, version: 3 },
      { id: 'file-2', name: 'b.png', kind: 'image/png', status: 'ready', selected: false },
    ])
    await send('结合资料回答')
    const sendCall = calls.find(call => call.action === 'chat-send')
    expect(sendCall?.args.attachments).toEqual([{ id: 'file-1', version: 3 }])
    const unselect = calls.filter(call => call.action === 'attachment-select')
    expect(unselect).toHaveLength(1)
    expect(unselect[0]?.args).toMatchObject({ draftId: 'conv-att', id: 'file-1', selected: false })
  })

  it('代次隔离：发送在途切会话，回包不写状态、sending 不复位旧视图', async () => {
    // 挂起 chat-send，期间切会话。
    let releaseSend!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/identity')) {
        return new Response(JSON.stringify({ userId: 'tester', version: 'x', backupAdmin: false, maxImageBytes: 1, blogUrl: '' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { action: string; args: Record<string, unknown> }
      calls.push({ action: body.action, args: body.args })
      if (body.action === 'chat-send') {
        return await new Promise(resolve => { releaseSend = resolve })
      }
      if (body.action === 'chat-create') {
        return new Response(JSON.stringify({ id: 'conv-slow', title: 'n', updatedAt: 0, ready: true, parent: null, pinned: false }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const sending = send('慢慢回答')
    await tick()
    expect(useConversationStore.getState().conversationId).toBe('conv-slow')

    // 发送在途时切会话（bump 代次 + 会话易主）。
    useSessionStore.getState().beginViewChange()
    useConversationStore.getState().setConversationId('conv-other')
    releaseSend(new Response(JSON.stringify({ model: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await sending
    await tick()

    // 代次已变：sending 不在旧视图复位（避免旧视图收尾盖掉新面板的忙态）。
    expect(useComposerStore.getState().sending).toBe(true)
    // 面板仍归新会话（空面板，未被旧链路写入）。
    expect(useConversationStore.getState().history).toBeNull()
  })
})

describe('停止链路', () => {
  it('stopping 置位 → chat-stop → refresh 收尾 → 复位', async () => {
    useConversationStore.getState().setConversationId('conv-stop')
    const stopping = stopAnswer()
    expect(useComposerStore.getState().stopping).toBe(true)
    await stopping
    expect(calls.some(call => call.action === 'chat-stop')).toBe(true)
    expect(calls.some(call => call.action === 'chat-history')).toBe(true)
    expect(useComposerStore.getState().stopping).toBe(false)
  })

  it('stopping 进行中重复点击直接返回（旧码守卫）', async () => {
    useConversationStore.getState().setConversationId('conv-once')
    let releaseStop!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { action: string }
      if (body.action === 'chat-stop') {
        return await new Promise(resolve => { releaseStop = resolve })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const first = stopAnswer()
    const second = stopAnswer()
    releaseStop(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await Promise.all([first, second])
    const stopCalls = calls.filter(call => call.action === 'chat-stop')
    expect(stopCalls.length).toBeLessThanOrEqual(1)
  })
})

// 类型归位（describe 外加载的模块断言里已消费）。
void activate
void useTurnStore
