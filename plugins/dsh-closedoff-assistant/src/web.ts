/** Dedicated HTTP and SSE surface for business users. */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConversationManager } from './agent.ts'
import { onAssistantDelta, type AssistantDelta } from './assistant-stream.ts'
import type { Config } from './config.ts'
import { fencesFromResult, isFenceTool } from './fences.ts'
import {
  collectOpaqueResultValues,
  extractCards,
  extractDeviceGroups,
  emptyCardsPayload,
  extractTrackDeviceGroupsFromResult,
  extractTrackPointsFromResult,
  extractTrackVehicleNoFromResult,
  extractVehicleMediaFromResult,
  filterDeviceGroupsNearTrack,
  gatewayResultFailed,
  projectHistory,
  turnUsageSummary,
  presentationDescriptor,
  projectReasoning,
  type TrackDeviceGroup,
  type TrackPoint,
} from './presentation.ts'
import { redactVisibleText } from './redaction.ts'
import { TOOL_BY_NAME } from './specs.ts'
import { isAccessError, createPluginHttp, actorKey, onRevoked, type Access, type Actor } from '@dsh-plugin/plugin-kit'

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function method(req: IncomingMessage, expected: string): void {
  if (req.method !== expected) throw new HttpError(405, `只支持 ${expected}`)
}

async function body(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type 必须是 application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error: unknown) {
    throw new HttpError(400, `请求体不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function error(res: ServerResponse, caught: unknown): void {
  const expected = caught instanceof HttpError || isAccessError(caught)
  const status = expected ? caught.status : 500
  if (!expected) console.error('closedoff-assistant web request failed', caught)
  const message = expected ? caught.message : '服务处理请求失败'
  json(res, status, { error: message })
}

function textBlocks(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

function reasoningBlocks(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'reasoning'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

function presentationValue(meta: unknown): unknown {
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'value' in meta
    ? (meta as Record<string, unknown>).value
    : undefined
}

const ASSET_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.cjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

type EventSink = (event: SessionEvent | { type: 'assistant/live-chunk'; time: number; data: AssistantDelta }) => void

/** Register the page, asset, chat, history, and cancellation routes. */
export async function installWeb(ctx: Context, config: Config, manager: ConversationManager, access: Access): Promise<void> {
  const sourceHtml = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  const webConfig = JSON.stringify({
    routePrefix: config.routePrefix,
    map: {
      terrainUrl: config.terrainUrl,
      tilesetUrl: config.tilesetUrl,
      tilesetHeight: config.tilesetHeight,
      trackDeviceRadiusMeters: config.trackDeviceRadiusMeters,
    },
  }).replaceAll('<', '\\u003c')
  const html = sourceHtml.replaceAll('/closedoff-qa', config.routePrefix).replace('__WEB_CONFIG__', webConfig)
  const webAssetRoot = fileURLToPath(new URL('../web/assets/', import.meta.url))
  const webAssetPath = `${config.routePrefix}/assets`
  const waiters = new Map<string, Set<EventSink>>()
  const active = new Set<string>()
  const closeStreams = new Set<() => void>()
  const recheckStreams = new Set<() => void>()
  const recheck = () => { for (const check of [...recheckStreams]) check() }
  ctx.effect(() => onRevoked(ctx, recheck))
  ctx.effect(() => {
    const interval = setInterval(recheck, config.authRecheckMs)
    interval.unref()
    return () => clearInterval(interval)
  })
  const respond = (actor: Actor, res: ServerResponse, status: number, value: unknown) => {
    access.assert(actor)
    json(res, status, value)
  }
  const { register, registerPublic } = createPluginHttp(ctx, { access, routePrefix: config.routePrefix, onError: error })
  ctx.effect(() => registerPublic({
    kind: 'exact', path: `${config.routePrefix}/health`, handler: (_req, res) => json(res, 200, { ok: true }),
  }))
  ctx.effect(() => registerPublic({
    kind: 'exact', path: `${config.routePrefix}/ready`, handler: (req, res) => {
      try { method(req, 'GET'); access.ready(); json(res, 200, { ok: true }) } catch (caught: unknown) { error(res, caught) }
    },
  }))
  ctx.effect(() => register({
    kind: 'exact', path: `${config.routePrefix}/identity`, handler: (_req, res, actor) => {
      respond(actor, res, 200, { mode: access.mode, key: actorKey(actor), label: actor.namespace === 'standalone' ? '独立模式' : '已登录', authPath: '/auth' })
    },
  }))
  ctx.effect(() => register({
    kind: 'exact', path: `${config.routePrefix}/conversations`, handler: (req, res, actor) => {
      method(req, 'GET')
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const offset = Number(params.get('offset') ?? '0')
      const limit = Number(params.get('limit') ?? '30')
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '历史分页参数无效')
      const items = manager.list(actor, offset, limit + 1)
      respond(actor, res, 200, { items: items.slice(0, limit), nextOffset: items.length > limit ? offset + limit : null })
    },
  }))

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') manager.finish(String(session.id))
    for (const sink of waiters.get(String(session.id)) ?? []) sink(event)
  })
  onAssistantDelta(ctx, (sessionId, delta) => {
    for (const sink of waiters.get(sessionId) ?? []) sink({ type: 'assistant/live-chunk', time: delta.time, data: delta })
  })

  ctx.effect(() => register({
    kind: 'exact',
    path: config.routePrefix,
    surface: 'page',
    handler: (req, res, actor) => {
      try {
        method(req, 'GET')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(html)
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'prefix',
    path: webAssetPath,
    handler: async (req, res, actor) => {
      try {
        method(req, 'GET')
        const requestUrl = new URL(req.url ?? webAssetPath, 'http://localhost')
        const suffix = decodeURIComponent(requestUrl.pathname.slice(webAssetPath.length)).replace(/^\/+/, '')
        if (suffix === '') throw new HttpError(404, '资源不存在')
        const file = resolve(webAssetRoot, suffix)
        const local = relative(webAssetRoot, file)
        if (local.startsWith('..') || isAbsolute(local)) throw new HttpError(404, '资源不存在')
        const content = await readFile(file)
        access.assert(actor)
        res.writeHead(200, {
          'content-type': ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': suffix === 'app.css' || suffix === 'trajectory.js' || suffix === 'app.js'
            ? 'no-cache'
            : 'public, max-age=31536000, immutable',
        })
        res.end(content)
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/history`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'GET')
        const requestUrl = new URL(req.url ?? config.routePrefix, 'http://localhost')
        const rawId = requestUrl.searchParams.get('conversationId')
        if (rawId === null || rawId === '') return respond(actor, res, 200, { history: [] })
        const conversation = await manager.open(rawId, false, actor)
        let feedback: Array<{ messageId: MessageId; rating: 'positive' | 'negative' }> = []
        let feedbackUnavailable = false
        if (conversation !== undefined) {
          try {
            const listed = await ctx.messageFeedback.list({ sessionId: SessionId(conversation.id) })
            if (listed.ok) feedback = listed.value.items.map(item => ({ messageId: item.messageId, rating: item.rating }))
            else feedbackUnavailable = true
          } catch {
            feedbackUnavailable = true
          }
        }
        respond(actor, res, 200, {
          history: conversation === undefined
            ? []
            : projectHistory(manager.events(conversation), config.trackDeviceRadiusMeters),
          feedback,
          feedbackUnavailable,
        })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/feedback`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const rawId = payload.conversationId
        const rawMessageId = payload.messageId
        const rating = payload.rating
        if (typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        if (typeof rawMessageId !== 'string' || rawMessageId === '') throw new HttpError(400, 'messageId 必须是非空字符串')
        if (rating !== 'positive' && rating !== 'negative') throw new HttpError(400, 'rating 必须是 positive 或 negative')
        const conversation = await manager.open(rawId, false, actor)
        if (conversation === undefined) throw new HttpError(404, '会话不存在')
        const sessionId = SessionId(conversation.id)
        const messageId = MessageId(rawMessageId)
        const listed = await ctx.messageFeedback.list({ sessionId })
        access.assert(actor)
        if (!listed.ok) throw new HttpError(404, '会话反馈不可用')
        const current = listed.value.items.find(item => item.messageId === messageId)
        const changed = current?.rating === rating
          ? await ctx.messageFeedback.delete({ sessionId, messageId, ifVersion: current.version })
          : await ctx.messageFeedback.put({
            sessionId,
            messageId,
            rating,
            ifVersion: current?.version ?? null,
          })
        if (!changed.ok) throw new HttpError(changed.error.code === 'version-conflict' ? 409 : 400, '反馈状态已变化，请重试')
        respond(actor, res, 200, { rating: current?.rating === rating ? null : rating })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/branch`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const rawId = payload.conversationId
        const atSeq = payload.atSeq
        if (typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        if (typeof atSeq !== 'number' || !Number.isSafeInteger(atSeq) || atSeq < 0) throw new HttpError(400, 'atSeq 必须是非负安全整数')
        const source = await manager.open(rawId, false, actor)
        if (source === undefined) throw new HttpError(404, '会话不存在')
        if (active.has(rawId)) throw new HttpError(409, '智能体仍在回答，暂时不能创建分支')
        const child = await manager.fork(source, SessionSeq(atSeq), actor)
        respond(actor, res, 200, { conversationId: child.id })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/stop`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const rawId = payload.conversationId
        if (typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        manager.cancel(rawId, actor)
        respond(actor, res, 200, { ok: true })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/chat`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const message = typeof payload.message === 'string' ? payload.message.trim() : ''
        if (message === '') throw new HttpError(400, '消息不能为空')
        const rawId = payload.conversationId
        if (rawId !== undefined && typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        const conversation = await manager.open(rawId === '' ? undefined : rawId, true, actor)
        if (conversation === undefined) throw new Error('failed to create business conversation')
        access.assert(actor)
        if (active.has(conversation.id) || conversation.active) throw new HttpError(409, '智能体正在回答上一条问题，请稍候或点击停止')
        active.add(conversation.id)

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (value: unknown) => {
          if (finished) return
          try { access.assert(actor) } catch {
            finish()
            manager.abort(conversation.id)
            return
          }
          if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`)
        }

        const tools = new Map<string, { name: string; api: string }>()
        const tracks = new Map<string, TrackPoint[]>()
        const reasoningSteps = new Map<number, { raw: string; released: boolean }>()
        const opaqueValues = new Set<string>()
        let deviceGroups: TrackDeviceGroup[] = []
        let finalText = ''
        let finished = false
        let thinkingDone = false
        let thinkingTimer: NodeJS.Timeout | undefined
        let lastThinkingAt = 0
        let lastThinkingPayload = ''
        let turnStartAt: number | undefined
        let firstStep: number | undefined
        let firstStepStartAt: number | undefined
        let firstTokenAt: number | undefined
        let finalMessageId: string | undefined
        let turnEvents: SessionEvent[] = []
        let sink: EventSink
        const listeners = waiters.get(conversation.id) ?? new Set<EventSink>()
        waiters.set(conversation.id, listeners)

        const thinkingText = () => [...reasoningSteps.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => projectReasoning(value.raw, thinkingDone || value.released, [...opaqueValues]))
          .filter(Boolean)
          .join('\n')
        const emitThinking = () => {
          const text = thinkingText()
          const payloadKey = `${thinkingDone ? '1' : '0'}:${text}`
          if (text === '' || payloadKey === lastThinkingPayload) return
          lastThinkingPayload = payloadKey
          lastThinkingAt = Date.now()
          send({ type: 'thinking_snapshot', text, done: thinkingDone })
        }
        const scheduleThinking = (force = false, done = false) => {
          if (done) thinkingDone = true
          if (thinkingTimer !== undefined) {
            clearTimeout(thinkingTimer)
            thinkingTimer = undefined
          }
          const wait = Math.max(0, 250 - (Date.now() - lastThinkingAt))
          if (force || wait === 0) {
            emitThinking()
            return
          }
          thinkingTimer = setTimeout(() => {
            thinkingTimer = undefined
            emitThinking()
          }, wait)
        }

        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(timeout)
          if (thinkingTimer !== undefined) clearTimeout(thinkingTimer)
          listeners.delete(sink)
          if (listeners.size === 0) waiters.delete(conversation.id)
          active.delete(conversation.id)
          closeStreams.delete(finish)
          recheckStreams.delete(checkAccess)
          if (!res.writableEnded) res.end()
        }
        const timeout = setTimeout(() => manager.abort(conversation.id), config.turnTimeoutMs)
        const checkAccess = () => {
          try { access.assert(actor) } catch {
            finish()
            manager.abort(conversation.id)
          }
        }

        sink = (event) => {
          checkAccess()
          if (finished) return
          if (event.type === 'turn/start') turnEvents = [event]
          else if (event.type !== 'assistant/live-chunk' && turnEvents.length > 0) turnEvents.push(event)
          switch (event.type) {
            case 'turn/start': {
              turnStartAt = event.time
              firstStep = undefined
              firstStepStartAt = undefined
              firstTokenAt = undefined
              finalMessageId = undefined
              break
            }
            case 'step/start': {
              if (firstStep === undefined) {
                firstStep = event.data.step
                firstStepStartAt = event.time
              }
              break
            }
            case 'assistant/chunk':
            case 'assistant/live-chunk': {
              const chunk = event.data.chunk
              if (event.data.step === firstStep && firstTokenAt === undefined) {
                const carriesToken = (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
                  ? chunk.text !== ''
                  : chunk.type === 'tool-call-delta' && (chunk.argumentsDelta !== '' || chunk.name !== undefined)
                if (carriesToken) firstTokenAt = event.time
              }
              if (chunk.type === 'text-delta') finalText += chunk.text
              else if (chunk.type === 'reasoning-delta') {
                const state = reasoningSteps.get(event.data.step) ?? { raw: '', released: false }
                state.raw += chunk.text
                reasoningSteps.set(event.data.step, state)
                scheduleThinking()
              }
              else if (chunk.type === 'tool-call-delta' && !tools.has(String(chunk.id))) {
                tools.set(String(chunk.id), { name: chunk.name ?? '', api: '' })
                send({
                  type: 'tool_start', callId: String(chunk.id), name: chunk.name ?? '',
                  presentation: presentationDescriptor(chunk.name ?? ''),
                })
              }
              break
            }
            case 'tool/call': {
              const callId = String(event.data.callId)
              const known = tools.get(callId)
              const api = TOOL_BY_NAME.get(event.data.name as `closedoff_${string}`)?.path ?? ''
              tools.set(callId, { name: event.data.name, api })
              if (known === undefined) send({
                type: 'tool_start', callId, name: event.data.name,
                presentation: presentationDescriptor(event.data.name),
              })
              break
            }
            case 'tool/result': {
              const block = event.data.message.content[0]
              const callId = String(block.toolCallId)
              const fullResultText = textBlocks(block.content)
              for (const value of collectOpaqueResultValues(fullResultText, event.data.meta)) opaqueValues.add(value)
              const failed = event.data.error !== undefined || block.isError || gatewayResultFailed(fullResultText)
              send({ type: 'tool_end', callId, status: failed ? 'error' : 'done' })
              const tool = tools.get(callId)?.name ?? ''
              if (!failed && isFenceTool(tool)) send({ type: 'fences', callId, payload: fencesFromResult(fullResultText, event.data.meta) })
              if (!failed && tool === 'closedoff_vehicle_track') {
                const points = extractTrackPointsFromResult(fullResultText, event.data.meta)
                const bundledGroups = extractTrackDeviceGroupsFromResult(event.data.meta)
                if (bundledGroups.length > 0) deviceGroups = bundledGroups
                if (points.length > 0) {
                  tracks.set(callId, points)
                  send({ type: 'track', callId, points, vehicleNo: extractTrackVehicleNoFromResult(fullResultText, event.data.meta) })
                  if (deviceGroups.length > 0) {
                    send({
                      type: 'cameras',
                      callId,
                      cameras: filterDeviceGroupsNearTrack(deviceGroups, points, config.trackDeviceRadiusMeters),
                    })
                  }
                }
                else {
                  const cards = extractCards(tool, fullResultText)
                  send({ type: 'cards', callId, payload: cards ?? emptyCardsPayload(tool, '未返回可展示的轨迹点') })
                }
              } else if (!failed && tool === 'closedoff_vehicle_stream') {
                const media = extractVehicleMediaFromResult(event.data.meta)
                if (media.length > 0) send({ type: 'media', callId, items: media })
                else {
                  const cards = extractCards(tool, fullResultText)
                  if (cards !== undefined) send({ type: 'cards', callId, payload: cards })
                }
              } else if (!failed && tool === 'closedoff_device_page') {
                deviceGroups = extractDeviceGroups(presentationValue(event.data.meta))
                for (const [trackCallId, points] of tracks) {
                  send({
                    type: 'cameras',
                    callId: trackCallId,
                    cameras: filterDeviceGroupsNearTrack(deviceGroups, points, config.trackDeviceRadiusMeters),
                  })
                }
              } else if (!failed && tool !== '') {
                const cards = extractCards(tool, fullResultText)
                if (cards !== undefined) send({ type: 'cards', callId, payload: cards })
              }
              break
            }
            case 'assistant/message': {
              const completeText = textBlocks(event.data.message.content)
              if (completeText !== '') {
                finalText = completeText
                finalMessageId = String(event.data.message.id)
              }
              const reasoning = reasoningBlocks(event.data.message.content)
              if (reasoning !== '') reasoningSteps.set(event.data.step, { raw: reasoning, released: true })
              scheduleThinking(true)
              break
            }
            case 'turn/end': {
              const reason = event.data.reason
              scheduleThinking(true, true)
              if (finalText !== '') send({ type: 'delta', text: redactVisibleText(finalText) })
              if (reason.kind === 'error') send({ type: 'error', message: redactVisibleText(`智能体回答失败: ${reason.error.message}`) })
              const turnUsage = turnUsageSummary(turnEvents)
              const completed = reason.kind === 'completed'
              send({
                type: 'done',
                reason: reason.kind,
                ...(completed ? {
                  meta: {
                    ...(finalMessageId === undefined ? {} : { messageId: finalMessageId }),
                    branchSeq: event.seq,
                    completedAt: event.time,
                    ...(turnStartAt === undefined ? {} : { runMs: Math.max(0, event.time - turnStartAt) }),
                    ...(firstStepStartAt === undefined || firstTokenAt === undefined
                      ? {}
                      : { ttftMs: Math.max(0, firstTokenAt - firstStepStartAt) }),
                    ...(turnUsage === undefined ? {} : { usage: turnUsage }),
                  },
                } : {}),
              })
              finish()
              break
            }
          }
        }
        listeners.add(sink)
        closeStreams.add(finish)
        recheckStreams.add(checkAccess)
        send({ type: 'conversation', conversationId: conversation.id })
        res.once('close', () => {
          if (!finished) manager.abort(conversation.id)
          finish()
        })
        try {
          manager.followup(conversation, message, actor)
        } catch (caught: unknown) {
          finish()
          throw caught
        }
      } catch (caught: unknown) {
        if (!res.headersSent) error(res, caught)
        else if (!res.writableEnded) res.end()
      }
    },
  }))

  ctx.effect(() => () => {
    for (const close of [...closeStreams]) close()
    waiters.clear()
    active.clear()
  })
}
