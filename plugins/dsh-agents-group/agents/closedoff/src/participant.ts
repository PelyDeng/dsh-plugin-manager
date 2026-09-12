/** 海盗指挥台只委派业务回合，不获取原始工具结果或内部推理。 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentParticipant, ParticipantResult } from 'dsh-pirate-command/protocol'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type { ConversationManager } from './agent.ts'
import type { Config } from './config.ts'
import { redactVisibleText } from './redaction.ts'
import { TOOL_BY_NAME } from './specs.ts'

export function createClosedoffParticipant(
  ctx: Context, config: Config, manager: ConversationManager, access: Access,
): AgentParticipant {
  let disposed = false
  const pending = new Set<() => Promise<void>>()
  ctx.effect(() => async () => {
    disposed = true
    await Promise.allSettled([...pending].map(close => close()))
  })
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
        let timeout: ReturnType<typeof setTimeout> | undefined
        let recheck: ReturnType<typeof setInterval> | undefined
        const cleanup = () => {
          finished = true
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
