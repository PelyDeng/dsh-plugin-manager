/** 海盗指挥台只委派业务回合，不获取原始工具结果或内部推理。 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentParticipant, ParticipantResult } from 'dsh-pirate-command/protocol'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type { ConversationManager } from './agent.ts'
import { onAssistantDelta, type AssistantDelta } from './assistant-stream.ts'
import type { Config } from './config.ts'
import { redactVisibleText } from './redaction.ts'
import { TOOL_BY_NAME } from './specs.ts'

/**
 * 发布边界：脱敏的各项匹配都不跨这些字符。
 *
 * 只列脱敏字符类真正排除的字符。`?`、`:`、`!` 看着像句子边界，但地址里就有它们，
 * 当成边界会把一段还没被脱敏识别的地址先发出去，之后再匹配上就只能停在半句话上。
 */
const STREAM_BOUNDARY = /[\s)\]}，。；、,;]/

/**
 * 可以发布的长度：停在最后一个边界字符之后。
 *
 * 边界前以数字、`X` 或连字符结尾的词也一起等：脱敏允许号码和证件号的各位之间夹一个
 * 空格或连字符，先把它发出去就等于绕过了脱敏。
 */
function publishedLength(text: string): number {
  let cut = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (STREAM_BOUNDARY.test(text[index]!)) { cut = index + 1; break }
  }
  for (let held = 0; held < 4 && cut > 1; held += 1) {
    let start = cut - 2
    while (start >= 0 && !STREAM_BOUNDARY.test(text[start]!)) start -= 1
    if (!/[0-9Xx-]$/.test(text.slice(start + 1, cut - 1))) break
    cut = start + 1
  }
  return cut
}

/**
 * 把一轮回答的正文增量交给协作入口。
 *
 * 发布的是与最终正文同一套脱敏结果，并且只发布不会再被后续增量改写的部分 —— 先发后改
 * 就得撤回，页面上的字会来回跳。回合结束补发剩余正文。
 */
function createVisibleStream(publish: (text: string) => void) {
  let raw = ''
  let sent = ''
  const flush = (all: boolean) => {
    const redacted = redactVisibleText(raw)
    // 已发布的正文被改写（例如号码补齐后才匹配上脱敏）：本轮不再补发，宁可不完整也不重复或外泄。
    if (!redacted.startsWith(sent)) return
    const length = all ? redacted.length : publishedLength(redacted)
    if (length <= sent.length) return
    const next = redacted.slice(sent.length, length)
    sent = redacted.slice(0, length)
    publish(next)
  }
  return {
    push(text: string) { raw += text; flush(false) },
    finish() { flush(true) },
  }
}

export function createClosedoffParticipant(
  ctx: Context, config: Config, manager: ConversationManager, access: Access,
): AgentParticipant {
  let disposed = false
  const pending = new Set<() => Promise<void>>()
  /** 正在协作的业务会话 → 这一轮的增量出口。同一会话不会有两轮同时跑。 */
  const sinks = new Map<string, (delta: AssistantDelta) => void>()
  ctx.effect(() => async () => {
    disposed = true
    await Promise.allSettled([...pending].map(close => close()))
  })
  onAssistantDelta(ctx, (sessionId, delta) => { sinks.get(sessionId)?.(delta) })
  const assertAccess = (actor: Actor) => {
    if (disposed) throw new AccessError(503, '封闭化插件正在停止')
    access.assert(actor)
  }
  return {
    protocol: 1, id: 'closedoff', displayName: '封闭化管理智能助手',
    description: '通过原有只读业务工具查询园区、通行与车辆信息，返回脱敏分析和原生会话。',
    assertAccess,
    async run(request) {
      request.signal.throwIfAborted()
      assertAccess(request.actor)
      const message = request.message.trim()
      if (!message) throw new AccessError(400, '协作消息不能为空')
      const conversation = await manager.open(request.conversationId, true, request.actor)
      if (!conversation) throw new AccessError(404, '封闭化会话不存在')
      request.signal.throwIfAborted()
      assertAccess(request.actor)
      manager.assertConversation(conversation.id, request.actor)
      if (conversation.active) throw new AccessError(409, '封闭化智能体正在回答上一条问题')

      return new Promise<ParticipantResult>((resolve, reject) => {
        let admitted = false, started = false, finished = false, ending = false, cancelled = false, failed = false
        let finalText = '', failure: unknown
        let continuation: Promise<void> | undefined
        let unsubscribe = () => {}
        let releaseTurn = () => {}
        let sink: ((delta: AssistantDelta) => void) | undefined
        let timeout: ReturnType<typeof setTimeout> | undefined
        let recheck: ReturnType<typeof setInterval> | undefined
        const visible = createVisibleStream(text => {
          assert()
          // 增量只带正文：会话入口在接单时已经交回，每条增量再带一次会让协作入口反复登记同一个会话。
          request.onProgress({ kind: 'delta', delta: text })
        })
        const cleanup = () => {
          finished = true
          if (sink !== undefined && sinks.get(conversation.id) === sink) sinks.delete(conversation.id)
          unsubscribe()
          clearTimeout(timeout)
          clearInterval(recheck)
          request.signal.removeEventListener('abort', cancel)
          pending.delete(close)
          releaseTurn()
        }
        const fail = (error: unknown) => {
          if (finished || failed) return
          failed = true; failure = error
          if (admitted) manager.abort(conversation.id)
          if (!started) { cleanup(); reject(error) }
        }
        const cancel = () => {
          if (finished) return
          cancelled = true
          if (admitted) manager.abort(conversation.id)
          if (!started) { cleanup(); reject(request.signal.reason) }
        }
        const close = async () => {
          if (finished) return
          cancelled = true
          if (admitted) manager.abort(conversation.id)
          try { if (started) { await continuation; await conversation.handle.agent.whenIdle() } } catch { /* 关闭时统一报告插件已停止。 */ }
          if (!finished) { cleanup(); reject(new AccessError(503, '封闭化插件已停止')) }
        }
        pending.add(close)
        const assert = () => { assertAccess(request.actor); manager.assertConversation(conversation.id, request.actor) }
        const progress = (text: string) => {
          assert()
          request.onProgress({ kind: 'status', text, conversationId: conversation.id })
        }
        /**
         * 本轮的正文增量出口。
         *
         * 只转发面向用户的正文：推理与工具参数不进协作入口。上报失败按回合失败处理，
         * 不能让异常穿过宿主的事件分发。
         */
        sink = delta => {
          if (finished || ending || cancelled || failed || !admitted || !started) return
          const chunk = delta.chunk
          if (chunk.type !== 'text-delta') return
          try { visible.push(chunk.text) } catch (error) { fail(error) }
        }
        unsubscribe = ctx.on('session/event', (session, event) => {
          if (String(session.id) !== conversation.id || finished || ending || !admitted) return
          if (event.type === 'turn/start') started = true
          if (!started) return
          if (event.type === 'turn/end') {
            // turn/end 先于 driver 退出，等待真正空闲后才能续发、回收或移除。
            ending = true
            void Promise.resolve().then(() => continuation).then(() => conversation.handle.agent.whenIdle()).then(() => { try {
              if (finished) return
              assert()
              if (failed) throw failure
              const reason = event.data.reason.kind
              const status = cancelled || reason === 'aborted' ? 'cancelled'
                : reason === 'completed' && finalText.trim() ? 'completed' : 'failed'
              // 收尾前补发最后一段正文：否则页面上停在一个逗号之前。
              if (status === 'completed') visible.finish()
              const text = status === 'completed' ? redactVisibleText(finalText)
                : status === 'cancelled' ? '封闭化协作已取消。' : '封闭化智能体未能完成本回合，请查看原会话。'
              cleanup()
              resolve({ status, conversationId: conversation.id, text, artifacts: [{
                kind: 'conversation', title: '查看封闭化会话',
                path: `${config.routePrefix}?conversationId=${encodeURIComponent(conversation.id)}`,
              }] })
            } catch (error) { cleanup(); reject(error) }
            }, error => { if (!finished) { cleanup(); reject(error) } })
            return
          }
          if (failed || cancelled) return
          try {
            assert()
            if (event.type === 'assistant/message') {
              finalText = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
            } else if (event.type === 'tool/call') {
              const tool = TOOL_BY_NAME.get(event.data.name as `closedoff_${string}`)
              progress(tool ? `正在执行：${tool.displayName}` : '正在执行封闭化业务查询。')
            } else if (event.type === 'tool/result') progress('封闭化查询步骤已返回。')
          } catch (error) { fail(error) }
        }, { global: true })
        request.signal.addEventListener('abort', cancel, { once: true })
        recheck = setInterval(() => { try { assert() } catch (error) { fail(error) } }, config.authRecheckMs)
        recheck.unref()
        timeout = setTimeout(() => fail(new Error('封闭化协作超时')), config.turnTimeoutMs)
        timeout.unref()
        void (async () => { try {
          request.signal.throwIfAborted()
          assert()
          request.onProgress({ kind: 'status', text: '封闭化智能体已接单。', conversationId: conversation.id,
            conversationArtifact: { kind: 'conversation', title: '查看封闭化会话',
              path: `${config.routePrefix}?conversationId=${encodeURIComponent(conversation.id)}` } })
          request.signal.throwIfAborted()
          assert()
          if (conversation.active) throw new AccessError(409, '封闭化智能体正在回答上一条问题')
          releaseTurn = manager.retainTurn(conversation, request.actor)
          admitted = true
          sinks.set(conversation.id, sink)
          continuation = manager.followup(conversation, message, request.actor)
          await continuation
        } catch (error) {
          if (finished) return
          if (admitted) {
            manager.abort(conversation.id)
            try { if (started) await conversation.handle.agent.whenIdle() } catch { /* 保留原始接续错误。 */ }
          }
          if (!finished) { cleanup(); reject(error) }
        } })()
      })
    },
  }
}
