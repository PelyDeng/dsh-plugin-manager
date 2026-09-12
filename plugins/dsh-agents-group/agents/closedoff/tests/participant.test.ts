import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationManager } from '../src/agent.ts'
import { Config } from '../src/config.ts'
import { createClosedoffParticipant } from '../src/participant.ts'

const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const other: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }
const id = 'closedoff-web-01234567-89ab-4cde-8fab-0123456789ab'
afterEach(() => vi.useRealTimers())

function fixture(routePrefix = '/closedoff-qa') {
  const listeners = new Set<(session: { id: string }, event: SessionEvent) => void>()
  const disposers: (() => Promise<void>)[] = []
  let revoked = false
  const access: Access = {
    mode: 'authenticated', ready() {}, resolve: () => actor,
    assert(value) { if (revoked || value !== actor) throw new AccessError(403, '无权访问') },
  }
  const conversation = { id, active: false, handle: { agent: { whenIdle: vi.fn(async () => {}) } } }
  const assertConversation = vi.fn((value: string, valueActor: Actor) => {
    access.assert(valueActor)
    if (value !== id) throw new AccessError(404, '无权访问该会话')
  })
  const manager = {
    open: vi.fn(async (requested: string | undefined, _create: boolean, value: Actor) => {
      access.assert(value)
      if (requested) assertConversation(requested, value)
      return conversation
    }),
    assertConversation,
    retainTurn: vi.fn(() => () => { manager.finish() }),
    followup: vi.fn((_conversation: unknown, _message: string, value: Actor) => {
      access.assert(value)
      if (conversation.active) throw new AccessError(409, '上一条问题尚未完成')
      conversation.active = true
      emit('turn/start', { turn: 1 })
    }),
    abort: vi.fn(),
    finish: vi.fn(() => { conversation.active = false }),
  }
  const ctx = { effect: (effect: () => () => Promise<void>) => { disposers.push(effect()) }, on: (_name: string, listener: (session: { id: string }, event: SessionEvent) => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } } as unknown as Context
  const config = Config({ routePrefix, turnTimeoutMs: 10_000, authRecheckMs: 100 } as Config)
  const participant = createClosedoffParticipant(ctx, config, manager as unknown as ConversationManager, access)
  const controller = new AbortController()
  const onProgress = vi.fn()
  const request = { actor, missionId: 'mission-1', requestId: 'request-1', message: '查询通行记录', signal: controller.signal, onProgress }
  function emit(type: string, data: unknown, sessionId = id) {
    for (const listener of [...listeners]) listener({ id: sessionId }, { type, data, time: Date.now(), seq: 1 } as SessionEvent)
  }
  const end = (kind = 'completed') => emit('turn/end', { reason: { kind } })
  return { participant, request, manager, controller, onProgress, conversation, listeners, emit, end,
    revoke: () => { revoked = true }, dispose: async () => { listeners.clear(); for (const close of disposers) await close() } }
}

describe('封闭化协作适配', () => {
  it('目录等待中的拒绝、取消、撤权和卸载不会留下未启动的协作', async () => {
    for (const action of ['reject', 'cancel', 'revoke', 'close']) {
      const f = fixture()
      let rejectDirectory!: (error: unknown) => void
      f.manager.followup.mockImplementationOnce(() => {
        f.conversation.active = true
        return new Promise<void>((_resolve, reject) => { rejectDirectory = reject })
      })
      const pending = f.participant.run(f.request)
      const rejected = expect(pending).rejects.toBeDefined()
      await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
      if (action === 'cancel') f.controller.abort()
      else if (action === 'close') await f.dispose()
      else if (action === 'revoke') { f.revoke(); await new Promise(resolve => setTimeout(resolve, 150)) }
      else rejectDirectory(new AccessError(400, '模型已从目录移除'))
      await rejected
      expect(f.listeners.size).toBe(0)
      expect(f.conversation.active).toBe(false)
      expect(f.conversation.handle.agent.whenIdle).not.toHaveBeenCalled()
      rejectDirectory(new AccessError(409, '旧目录操作已停止'))
      await Promise.resolve()
      expect(f.manager.finish).toHaveBeenCalledOnce()
    }
  })
  it('取消尚未启动的回合后，旧目录失败不能取消或释放下一轮', async () => {
    const f = fixture()
    let rejectDirectory!: (error: unknown) => void
    f.manager.followup.mockImplementationOnce(() => {
      f.conversation.active = true
      return new Promise<void>((_resolve, reject) => { rejectDirectory = reject })
    })
    const old = f.participant.run(f.request)
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.controller.abort()
    await rejected
    const next = f.participant.run({ ...f.request, signal: new AbortController().signal })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledTimes(2))
    rejectDirectory(new Error('迟到目录失败'))
    await new Promise(resolve => setImmediate(resolve))
    expect(f.manager.abort).toHaveBeenCalledOnce()
    expect(f.manager.finish).toHaveBeenCalledOnce()
    expect(f.conversation.active).toBe(true)
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '新回合正常完成' }] } })
    f.end()
    expect(await next).toMatchObject({ status: 'completed', text: '新回合正常完成' })
  })
  it('启动前取消不创建业务会话', async () => {
    const f = fixture()
    f.controller.abort()
    await expect(f.participant.run(f.request)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.manager.open).not.toHaveBeenCalled()
    expect(f.onProgress).not.toHaveBeenCalled()
  })

  it('归属核验后、接续前只提供一次自身会话链接，最终入口保持兼容', async () => {
    const f = fixture('/native-closedoff')
    const beforeFollowup: number[] = []
    const pending = f.participant.run({ ...f.request, onProgress(value) {
      f.onProgress(value)
      beforeFollowup.push(f.manager.followup.mock.calls.length)
    } })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.emit('tool/call', { name: 'closedoff_query' })
    f.emit('tool/result', {})
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '查询结果' }] } })
    f.end()
    const result = await pending
    const artifact = { kind: 'conversation', title: '查看封闭化会话', path: '/native-closedoff?conversationId=' + id }
    expect(f.onProgress).toHaveBeenCalledWith({ kind: 'status', text: '封闭化智能体已接单。', conversationId: id, conversationArtifact: artifact })
    expect(beforeFollowup[0]).toBe(0)
    expect(f.manager.assertConversation).toHaveBeenCalledWith(id, actor)
    expect(f.onProgress.mock.calls.filter(([value]) => value.conversationArtifact)).toHaveLength(1)
    expect(f.onProgress.mock.calls).toHaveLength(3)
    expect(result).toMatchObject({ status: 'completed', artifacts: [artifact] })
  })

  it('会话打开期间取消、撤权或卸载后，迟到会话不发链接或接续', async () => {
    for (const action of ['cancel', 'revoke', 'close']) {
      const f = fixture()
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      f.manager.open.mockImplementationOnce(async () => { await gate; return f.conversation })
      const pending = f.participant.run(f.request)
      const rejected = expect(pending).rejects.toBeDefined()
      if (action === 'cancel') f.controller.abort()
      else if (action === 'revoke') f.revoke()
      else await f.dispose()
      release()
      await rejected
      expect(f.onProgress).not.toHaveBeenCalled()
      expect(f.manager.followup).not.toHaveBeenCalled()
      expect(f.listeners.size).toBe(0)
    }
  })

  it('复用指定会话与原 Actor，仅返回完整脱敏正文和原生入口', async () => {
    const f = fixture()
    const pending = f.participant.run({ ...f.request, conversationId: id })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    expect(f.manager.open).toHaveBeenCalledWith(id, true, actor)
    expect(f.manager.followup).toHaveBeenCalledWith(f.conversation, '查询通行记录', actor)
    expect(f.onProgress).toHaveBeenCalledWith({ kind: 'status', text: '封闭化智能体已接单。', conversationId: id,
      conversationArtifact: { kind: 'conversation', title: '查看封闭化会话', path: '/closedoff-qa?conversationId=' + id } })
    f.emit('assistant/chunk', { chunk: { type: 'reasoning-delta', text: '不得对外返回的内部推理' } })
    f.emit('tool/result', { meta: { token: '不应外传的原始字段' } })
    f.emit('assistant/message', { message: { content: [
      { type: 'reasoning', text: '不得对外返回的内部推理' },
      { type: 'text', text: '查询完成，联系 13800138000，查看 https://private.invalid/stream' },
      { type: 'tool-call', name: 'internal_tool', arguments: { token: '不应外传' } },
    ] } })
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '另一个会话的秘密' }] } }, 'another-session')
    f.end()
    const result = await pending
    expect(result).toEqual({
      status: 'completed', conversationId: id,
      text: '查询完成，联系 138****8000，查看 [地址已隐藏]',
      artifacts: [{ kind: 'conversation', title: '查看封闭化会话', path: '/closedoff-qa?conversationId=' + id }],
    })
    expect(JSON.stringify(f.onProgress.mock.calls)).not.toMatch(/内部推理|原始字段|private\.invalid/)
    expect(f.listeners.size).toBe(0)
    expect(f.conversation.active).toBe(false)
  })

  it('外部用户和不属于当前主人的会话在派单前被拒绝', async () => {
    const f = fixture()
    await expect(f.participant.run({ ...f.request, actor: other })).rejects.toMatchObject({ status: 403 })
    await expect(f.participant.run({ ...f.request, conversationId: 'foreign' })).rejects.toMatchObject({ status: 404 })
    expect(f.manager.followup).not.toHaveBeenCalled()
    expect(f.onProgress).not.toHaveBeenCalled()
  })

  it.each(['error', 'aborted'])('V3 的废弃 attempt 正文在 %s 结束时不作为成果返回', async reason => {
    const f = fixture()
    const pending = f.participant.run(f.request)
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    // Session V3 持久化失败尝试的 stream，但它不是 assistant/message。
    f.emit('assistant/attempt', { turn: 1, step: 1, stream: [
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['废弃尝试中的业务明细'] },
    ] })
    f.end(reason)
    const result = await pending
    expect(result.status).toBe(reason === 'aborted' ? 'cancelled' : 'failed')
    expect(JSON.stringify([result, f.onProgress.mock.calls])).not.toContain('废弃尝试中的业务明细')
  })

  it('V3 重试只返回最终提交的 message，不拼接废弃 attempt 或嵌入式 stream', async () => {
    const f = fixture()
    const pending = f.participant.run(f.request)
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.emit('assistant/attempt', { turn: 1, step: 1, stream: [
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['废弃尝试'] },
    ] })
    f.emit('assistant/message', { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: '内部推理' }, { type: 'text', text: '最终公开分析' },
    ] }, stream: [
      { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['最终公开分析'] },
    ] })
    f.end()
    expect(await pending).toMatchObject({ status: 'completed', text: '最终公开分析' })
    expect(JSON.stringify(f.onProgress.mock.calls)).not.toMatch(/废弃尝试|内部推理/)
  })

  it('宿主取消产生 interrupted message 时，即使请求 signal 未取消也不返回部分成果', async () => {
    const f = fixture()
    const pending = f.participant.run(f.request)
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.emit('assistant/message', { turn: 1, step: 1, interrupted: true, stream: [],
      message: { content: [{ type: 'text', text: '尚未完成的部分分析' }] },
    })
    f.end('aborted')
    expect(f.request.signal.aborted).toBe(false)
    expect(await pending).toMatchObject({ status: 'cancelled', text: '封闭化协作已取消。' })
  })

  it('已完成请求的迟到 abort 不会取消或释放正在运行的下一轮', async () => {
    const f = fixture()
    const first = f.participant.run(f.request)
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '第一轮完成' }] } })
    f.end()
    expect(await first).toMatchObject({ status: 'completed' })
    const next = f.participant.run({ ...f.request, requestId: 'request-2', signal: new AbortController().signal })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledTimes(2))
    f.controller.abort()
    expect(f.manager.abort).not.toHaveBeenCalled()
    expect(f.manager.finish).toHaveBeenCalledOnce()
    expect(f.conversation.active).toBe(true)
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '第二轮继续完成' }] } })
    f.end()
    expect(await next).toMatchObject({ status: 'completed', text: '第二轮继续完成' })
  })

  it('停止后阻止输出，收到 turn/end 前仍拒绝新回合', async () => {
    const f = fixture()
    const pending = f.participant.run(f.request)
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.controller.abort()
    expect(f.manager.abort).toHaveBeenCalledWith(id)
    expect(f.conversation.active).toBe(true)
    const count = f.onProgress.mock.calls.length
    f.emit('tool/result', {})
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '迟到成果' }] } })
    expect(f.onProgress).toHaveBeenCalledTimes(count)
    await expect(f.participant.run({ ...f.request, signal: new AbortController().signal, conversationId: id })).rejects.toMatchObject({ status: 409 })
    f.end('aborted')
    expect(await pending).toMatchObject({ status: 'cancelled', conversationId: id, text: '封闭化协作已取消。' })
    expect(f.conversation.active).toBe(false)
  })

  it('接单回调中取消，不向 Agent 添加问题', async () => {
    const f = fixture()
    await expect(f.participant.run({ ...f.request, onProgress: () => f.controller.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.manager.followup).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  })

  it('运行中撤销授权会取消 Agent，并拒绝最终成果', async () => {
    const f = fixture()
    const pending = f.participant.run(f.request)
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.revoke()
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '撤销授权后的资料' }] } })
    expect(f.manager.abort).toHaveBeenCalledWith(id)
    f.end()
    await rejected
    expect(f.onProgress).toHaveBeenCalledTimes(1)
    expect(f.listeners.size).toBe(0)
  })

  it('超时发出取消请求，但不提前释放运行身份', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const pending = f.participant.run(f.request)
    const rejected = expect(pending).rejects.toThrow('封闭化协作超时')
    await Promise.resolve()
    expect(f.manager.followup).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.manager.abort).toHaveBeenCalledWith(id)
    expect(f.conversation.active).toBe(true)
    f.end('aborted')
    await rejected
    expect(f.conversation.active).toBe(false)
  })

  it('turn/end 后继续持有回合，直到宿主 driver 空闲才允许立即续发', async () => {
    const f = fixture()
    let retire!: () => void
    f.conversation.handle.agent.whenIdle.mockImplementationOnce(() => new Promise<void>(resolve => { retire = resolve }))
    const pending = f.participant.run(f.request)
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '第一轮完成' }] } })
    f.end()
    expect(f.conversation.active).toBe(true)
    await expect(f.participant.run({ ...f.request, conversationId: id })).rejects.toMatchObject({ status: 409 })
    retire()
    expect(await pending).toMatchObject({ status: 'completed', text: '第一轮完成' })
    const second = f.participant.run({ ...f.request, conversationId: id })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledTimes(2))
    f.emit('assistant/message', { message: { content: [{ type: 'text', text: '第二轮完成' }] } })
    f.end()
    expect(await second).toMatchObject({ status: 'completed', text: '第二轮完成' })
    expect(f.listeners.size).toBe(0)
  })

  it('卸载导致事件监听被移除时，仍取消并等待宿主退出后结束协作', async () => {
    const f = fixture()
    let retire!: () => void
    f.conversation.handle.agent.whenIdle.mockImplementationOnce(() => new Promise<void>(resolve => { retire = resolve }))
    const pending = f.participant.run(f.request)
    const rejected = expect(pending).rejects.toMatchObject({ status: 503 })
    await vi.waitFor(() => expect(f.manager.followup).toHaveBeenCalledOnce())
    const closing = f.dispose()
    expect(f.manager.abort).toHaveBeenCalledWith(id)
    expect(f.conversation.active).toBe(true)
    await vi.waitFor(() => expect(f.conversation.handle.agent.whenIdle).toHaveBeenCalledOnce())
    retire()
    await closing
    await rejected
    expect(f.conversation.active).toBe(false)
    await expect(f.participant.run(f.request)).rejects.toMatchObject({ status: 503 })
  })
})
