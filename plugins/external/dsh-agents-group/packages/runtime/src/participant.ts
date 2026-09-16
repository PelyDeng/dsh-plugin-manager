/**
 * 协作入口：一个 Agent 被协调方派活时走的唯一通道。
 *
 * 职责分三类：
 *
 * 1. **继承既有实现**（`closedoff/src/participant.ts` 逐条对应）：授权复核与定时重核 ·
 *    独占判定 · 超时 / 中止 / 释放 · 事件投影 · conversation artifact 上报 · 上报前重核验。
 * 2. **本期新增**：`reply` 续问（幂等身份是 `requestId`，与会话寻址分开）与
 *    `status: 'waiting'` + `question`——两个生产实现此前从未产生过等待。
 * 3. **不改契约**：`ConversationProvider`（侧栏）由 `conversation.ts` 承载实现，接口不动。
 *
 * 逃生通道：`mount()` 允许返回自定义的 `participant`。运行时是**默认路径**，不是唯一实现层。
 */
import type { Agent as DshAgent } from '@deepseek-ai/dsh-agent'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  PARTICIPANT_PROTOCOL,
  type AgentParticipant,
  type ParticipantProgress,
  type ParticipantRequest,
  type ParticipantResult,
} from './contract.ts'
import { historyOf, textOf, type AgentRuntime, type Conversation } from './conversation.ts'
import type { AgentDefinition, ProjectedResult, ResultContext } from './definition.ts'
import { createVisibleStream, createVisibleThinking, onAssistantDelta, type AssistantDelta } from './projection.ts'
import type { AgentStoragePort } from './storage/ports.ts'

export interface CreateParticipantInput {
  readonly definition: AgentDefinition
  readonly runtime: AgentRuntime
  /** 可注入的存储门面；不注入时业务钩子拿到 `undefined`，工具与投影要自己处理这种情况。 */
  readonly storage?: AgentStoragePort
  readonly access: Access
  readonly config: {
    readonly turnTimeoutMs: number
    readonly authRecheckMs: number
    readonly routePrefix: string
  }
}

/**
 * 造一个协作入口。
 *
 * `run` 与 `reply` 共用同一条状态机，差别只有两处：**续问必须带原会话引用**（沿它续接而不是
 * 新建），以及**续问的幂等身份是 `requestId`**（`AgentReplyRequest.requestId` 必填，缺失即
 * 拒绝——回落成子任务 id 会让同一子任务的多次回话撞同一个键）。
 */
export function createParticipant(input: CreateParticipantInput): AgentParticipant {
  const { definition, runtime, access, config } = input
  const { ctx, lifecycle } = runtime
  const storage = input.storage
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
    if (disposed) throw new AccessError(503, `${definition.displayName}正在停止`)
    access.assert(actor)
  }

  /** 结果投影：业务钩子优先，缺省用兜底投影（**"没调交活工具"不等于失败**）。 */
  const project = async (requestContext: ResultContext): Promise<ProjectedResult> => {
    if (definition.projectResult === undefined) return fallbackProjection(requestContext)
    const projected = await definition.projectResult(requestContext)
    // 等待的唯一来源是 needsReply：业务给了问题但没声明要等时，不能自行把状态改成等待。
    if (projected.status === 'completed' && definition.needsReply?.(requestContext) === true) {
      return { ...projected, status: 'waiting', question: projected.question ?? fallbackQuestion(projected) }
    }
    return projected
  }

  function runTurn(request: ParticipantRequest, mode: 'run' | 'reply'): Promise<ParticipantResult> {
    request.signal.throwIfAborted()
    assertAccess(request.actor)
    const message = request.message.trim()
    if (!message) throw new AccessError(400, '协作消息不能为空')
    if (mode === 'reply' && (request.conversationId === undefined || request.conversationId === '')) {
      // 没有原会话引用就无法"续接"：新建一个会话会让用户的话落进一条他不认识的对话里。
      throw new AccessError(400, '续问缺少原会话引用（conversationId）')
    }
    return new Promise<ParticipantResult>((resolve, reject) => {
      void (async () => {
        let conversation: Conversation | undefined
        try {
          conversation = await lifecycle.open(
            request.conversationId === undefined || request.conversationId === '' ? undefined : request.conversationId,
            mode === 'run',
            request.actor,
          )
        } catch (error) { reject(error); return }
        if (conversation === undefined) { reject(new AccessError(404, '会话不存在或无权访问')); return }
        const opened = conversation
        try {
          request.signal.throwIfAborted()
          assertAccess(request.actor)
          lifecycle.assertConversation(opened.id, request.actor)
          if (opened.active) throw new AccessError(409, '智能体正在回答上一条问题')
        } catch (error) { reject(error); return }

        let admitted = false
        let started = false
        let finished = false
        let ending = false
        let cancelled = false
        let failed = false
        let finalText = ''
        let failure: unknown
        let continuation: Promise<void> | undefined
        let unsubscribe = () => {}
        let releaseTurn = () => {}
        let sink: ((delta: AssistantDelta) => void) | undefined
        let timeout: ReturnType<typeof setTimeout> | undefined
        let recheck: ReturnType<typeof setInterval> | undefined

        // 正文与思考各走一条通道：正文是面向用户的回答，思考是业务那套脱敏投影。
        // 两条通道的变换都由业务提供（纯函数），时序与节流在这里。
        const visible = createVisibleStream(text => { report({ kind: 'delta', delta: text }) }, definition.redact)
        const thinking = createVisibleThinking(
          text => { report({ kind: 'thinking', thinking: text }) },
          definition.projectReasoning,
          definition.liveMode ?? 'delta',
        )

        const cleanup = () => {
          finished = true
          thinking.clear()
          if (sink !== undefined && sinks.get(opened.id) === sink) sinks.delete(opened.id)
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
          if (admitted) lifecycle.abort(opened.id)
          if (!started) { cleanup(); reject(error) }
        }
        const cancel = () => {
          if (finished) return
          cancelled = true
          if (admitted) lifecycle.abort(opened.id)
          if (!started) { cleanup(); reject(request.signal.reason) }
        }
        const close = async () => {
          if (finished) return
          cancelled = true
          if (admitted) lifecycle.abort(opened.id)
          try { if (started) { await continuation; await opened.handle.agent.whenIdle() } } catch { /* 关闭时统一报告插件已停止。 */ }
          if (!finished) { cleanup(); reject(new AccessError(503, '插件已停止')) }
        }
        pending.add(close)
        const assert = () => { assertAccess(request.actor); lifecycle.assertConversation(opened.id, request.actor) }
        /** 实时上报：每条都在当前授权与归属下重新核验，失败按回合失败处理。 */
        const report = (value: ParticipantProgress) => {
          assert()
          request.onProgress(value)
        }
        const progress = (text: string) => {
          report({ kind: 'status', text, conversationId: opened.id })
        }
        sink = delta => {
          if (finished || ending || cancelled || failed || !admitted || !started) return
          const chunk = delta.chunk
          try {
            if (chunk.type === 'text-delta') visible.push(chunk.text)
            else if (chunk.type === 'reasoning-delta') thinking.push(delta.step, chunk.text)
          } catch (error) { fail(error) }
        }
        // 不加显式注解：`session/event` 的载荷类型由官方包的事件增强提供，覆盖注解会把
        // `session` 变成隐式 any，也让 `event.type` 的收窄失效。
        unsubscribe = ctx.on('session/event', (session, event) => {
          if (String(session.id) !== opened.id || finished || ending || !admitted) return
          if (event.type === 'turn/start') started = true
          if (!started) return
          if (event.type === 'turn/end') {
            // turn/end 先于 driver 退出，等待真正空闲后才能续发、回收或移除。
            ending = true
            void Promise.resolve().then(() => continuation).then(() => opened.handle.agent.whenIdle()).then(() => { void (async () => {
              if (finished) return
              assert()
              if (failed) throw failure
              const reason = event.data.reason.kind
              const aborted = cancelled || reason === 'aborted'
              const status = aborted ? 'cancelled' : reason === 'completed' && finalText.trim() ? 'completed' : 'failed'
              const history = historyOf(lifecycle.events(opened), opened.id)
              // 收尾前补发最后一段正文与思考快照：否则页面上停在一个逗号之前、思考也缺最后一节。
              if (status === 'completed') { thinking.finish(); visible.finish() }
              const text = status === 'completed' ? (definition.redact?.(finalText) ?? finalText)
                : status === 'cancelled' ? '协作已取消。' : `${definition.displayName}未能完成本回合，请查看原会话。`
              const projected = status === 'completed'
                ? await project({
                  history,
                  request: {
                    message,
                    ...(request.acceptance === undefined ? {} : { acceptance: request.acceptance }),
                    ...(request.reworkOf === undefined ? {} : { reworkOf: request.reworkOf }),
                  },
                  storage,
                })
                : { status: status as ProjectedResult['status'], text }
              cleanup()
              resolve({
                status: projected.status,
                conversationId: opened.id,
                text: projected.text === '' ? text : projected.text,
                ...(projected.question === undefined ? {} : { question: projected.question }),
                ...(projected.artifacts === undefined ? { artifacts: [conversationArtifact(opened.id)] } : { artifacts: projected.artifacts }),
                ...(projected.externalPending === undefined ? {} : { externalPending: projected.externalPending }),
              })
            })().catch(error => { cleanup(); reject(error) }) }, error => { if (!finished) { cleanup(); reject(error) } })
            return
          }
          if (failed || cancelled) return
          try {
            assert()
            if (event.type === 'assistant/message') {
              finalText = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
            } else if (event.type === 'assistant/attempt') {
              // 失败、重试或取消的尝试：它的推理不能留在思考快照里。
              thinking.discard(event.data.step)
            } else if (event.type === 'tool/result') {
              // 工具结果里的业务主键不能出现在思考正文里——**这是安全钩子，不是展示细节**。
              const opaque = definition.opaqueFromToolResult
              if (opaque !== undefined) {
                const block = event.data.message.content[0]
                if (block !== undefined) thinking.hide(opaque(textOf(block.content), event.data.meta))
              }
              progress('查询步骤已返回。')
            } else if (event.type === 'tool/call') {
              progress(definition.stageText?.(event) ?? '正在执行。')
            }
          } catch (error) { fail(error) }
        }, { global: true })
        request.signal.addEventListener('abort', cancel, { once: true })
        recheck = setInterval(() => { try { assert() } catch (error) { fail(error) } }, config.authRecheckMs)
        recheck.unref()
        timeout = setTimeout(() => fail(new Error('协作超时')), config.turnTimeoutMs)
        timeout.unref()
        void (async () => { try {
          request.signal.throwIfAborted()
          assert()
          request.onProgress({
            kind: 'status', text: '已接单。', conversationId: opened.id,
            conversationArtifact: conversationArtifact(opened.id),
          })
          request.signal.throwIfAborted()
          assert()
          if (opened.active) throw new AccessError(409, '智能体正在回答上一条问题')
          releaseTurn = lifecycle.retainTurn(opened, request.actor)
          admitted = true
          sinks.set(opened.id, sink!)
          continuation = lifecycle.followup(opened, message, request.actor)
          await continuation
        } catch (error) {
          if (finished) return
          if (admitted) {
            lifecycle.abort(opened.id)
            try { if (started) await opened.handle.agent.whenIdle() } catch { /* 保留原始接续错误。 */ }
          }
          if (!finished) { cleanup(); reject(error) }
        } })()
      })()
    })
  }

  /** 会话材料定位：告诉用户在哪能看到这场对话。 */
  const conversationArtifact = (conversationId: string) => ({
    kind: 'conversation' as const,
    title: '查看会话',
    path: `${config.routePrefix}?conversationId=${encodeURIComponent(conversationId)}`,
  })

  return {
    protocol: PARTICIPANT_PROTOCOL,
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    assertAccess,
    run: request => runTurn(request, 'run'),
    reply: request => runTurn(request, 'reply'),
  }
}

/** 缺省的结果投影：按回合结局判定，正文取最终消息。 */
function fallbackProjection(context: ResultContext): ProjectedResult {
  const text = context.history.finalText.trim()
  return { status: text === '' ? 'failed' : 'completed', text: text === '' ? '没有拿到可交付的结果。' : text }
}

/** `needsReply` 声明要等、但投影没给问题时，用一句兜底问题，避免用户面对一个没有问题的"等待"。 */
function fallbackQuestion(projected: ProjectedResult): string {
  return projected.text.trim() === '' ? '需要你补充一句话才能继续。' : projected.text.slice(0, 200)
}
