import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { TaskSnapshot } from '../src/task-projection.ts'

/** 读一个写请求的 JSON 正文；解析失败按空对象处理。 */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 管家契约桩（测试共用）：按契约 v1 形状提供 identity、会话、历史、快照、probe
 * 与 SSE，全部状态可变，用于复现迟到响应、授权失效与换轮等时序场景。
 * 只服务回环地址，数据全部自造，不涉及任何真实用户数据。
 */

export const identity = { mode: 'authenticated', key: 'user:a', label: '已登录', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }

export const defaultSnapshot: TaskSnapshot = {
  id: 'task-1', conversationId: 'conv-1', goal: '写博客', state: 'running', summary: '', error: '', finishedAt: null,
  subtasks: [{ id: 's1', goal: '起草博客', state: 'running', agentId: 'blog', displayName: '博客', result: '草稿写到一半' }],
}

export interface StreamStep { status?: number; events?: object[]; done?: boolean; destroy?: boolean }

/** 写端点（/chat、/reply、/stop）的一段剧本：错误形态、断流形态或受理后的事件流。 */
export interface WritePlan {
  /** 非 0 时按该状态码回 JSON 响应（body 字段即响应体，含 error/code）。 */
  status?: number
  body?: object
  /** 收到请求后不回应直接断开连接：复现「响应未知」。 */
  destroy?: boolean
  /** 收到请求后永不回应：复现受理超时（配合客户端缩短的受理时限）。 */
  hang?: boolean
  /** 受理成立、事件发出后断开连接：复现「受理已知、事件流中断」。 */
  cut?: boolean
  /** 受理成立后写在响应事件流上的事件序列。 */
  events?: object[]
  /** 事件发完后是否以 [DONE] 结束；false 表示这一轮还在跑、连接保持打开。 */
  done?: boolean
}

/** `/chat` 的缺省剧本：一段受理后直奔完成的正常轮。 */
export const defaultChatPlan = (payload: Record<string, unknown>): WritePlan => ({
  events: [
    { type: 'conversation', conversationId: payload.conversationId ?? '' },
    { type: 'run', runId: 'run-chat', state: 'running', taskId: '', startedAt: 1, finishedAt: null },
    { type: 'user', text: payload.message ?? '', time: 1, seq: 1, runId: 'run-chat' },
    { type: 'chat', role: 'butler', text: '收到，安排执行。', time: 2, seq: 2, runId: 'run-chat' },
    { type: 'plan', taskId: 'task-new', goal: String(payload.message ?? ''), seq: 3, runId: 'run-chat', subtasks: [{ id: 's1', goal: '执行第一步', agentId: 'blog', displayName: '博客' }] },
    { type: 'subtask', taskId: 'task-new', id: 's1', state: 'running', agentId: 'blog', displayName: '博客', detail: '开始执行', seq: 4, runId: 'run-chat' },
    { type: 'subtask', taskId: 'task-new', id: 's1', state: 'succeeded', agentId: 'blog', displayName: '博客', detail: '完成', seq: 5, runId: 'run-chat' },
    { type: 'summary', taskId: 'task-new', text: '按目标完成。', state: 'completed', seq: 6, runId: 'run-chat' },
  ],
  done: true,
})

/** `/reply` 的缺省剧本：回复被受理，同任务换执行轮后完成。 */
export const defaultReplyPlan = (payload: Record<string, unknown>): WritePlan => ({
  events: [
    { type: 'run', runId: 'run-reply', state: 'running', taskId: payload.taskId ?? '', startedAt: 1, finishedAt: null },
    { type: 'subtask', taskId: payload.taskId ?? '', id: payload.subtaskId ?? '', state: 'running', agentId: 'blog', displayName: '博客', detail: '收到回复，继续执行', seq: 1, runId: 'run-reply' },
    { type: 'subtask_delta', taskId: payload.taskId ?? '', id: payload.subtaskId ?? '', agentId: 'blog', delta: '（按你的选择定稿）', seq: 2, runId: 'run-reply' },
    { type: 'subtask', taskId: payload.taskId ?? '', id: payload.subtaskId ?? '', state: 'succeeded', agentId: 'blog', displayName: '博客', detail: '完成', seq: 3, runId: 'run-reply' },
    { type: 'summary', taskId: payload.taskId ?? '', text: '按你的选择完成。', state: 'completed', seq: 4, runId: 'run-reply' },
  ],
  done: true,
})

export class ButlerStubServer {
  readonly state = {
    identityStatus: 200,
    identityBody: identity as unknown,
    /** 一次性：identity 响应前的延迟（毫秒），用于复现迟到的旧发现结果。 */
    identityDelayMs: 0,
    conversations: [{ id: 'conv-1', title: '博客任务', createdAt: 1, updatedAt: 2, taskCount: 1 }],
    /** 一次性：会话列表响应前的延迟（毫秒）。 */
    listDelayMs: 0,
    /** 一次性：非 0 时列表按该状态码响应（配合延迟复现迟到的失败）。 */
    listStatus: 0,
    history: [{ id: 'task-1', conversationId: 'conv-1', goal: '写博客', state: 'running', createdAt: 1, updatedAt: 2, subtaskTotal: 1, subtaskDone: 0 }],
    snapshot: defaultSnapshot as TaskSnapshot,
    snapshotReads: 0,
    /** 非 0 时任务快照按该状态码响应（用于复现补取失败等路径）。 */
    snapshotStatus: 0,
    /** 快照错误码从第几次读取开始生效（默认 1，即立刻生效）。 */
    snapshotStatusFromRead: 1,
    /** probe 返回的在跑一轮；null 表示没有。可按次给出（probeQueue 优先）。 */
    run: { runId: 'run-1', state: 'running', taskId: 'task-1', seq: 5, windowStart: 1 } as { runId: string; state: string; taskId: string; seq: number; windowStart: number } | null,
    /** 按次返回 probe 结果（先到先用），用于复现换轮前后的不同轮次。 */
    probeQueue: [] as ({ runId: string; state: string; taskId: string; seq: number; windowStart: number } | null)[],
    /** 非 0 时订阅流直接按该状态码响应（授权失效路径）。 */
    eventsStatus: 0,
    /** 订阅流的剧本；耗尽后按空闲轮结束。 */
    streamQueue: [] as StreamStep[],
    /** 每次订阅的 after。 */
    subscriptions: [] as number[],
    /** 可选：按读取次数返回任务快照，用于复现快照内容随时间变化。 */
    snapshotFor: null as null | ((reads: number) => TaskSnapshot),
    /** POST /chat 的剧本队列（先到先用）；耗尽后用缺省完成轮。 */
    chatQueue: [] as WritePlan[],
    /** POST /reply 的剧本队列；耗尽后用缺省完成轮。 */
    replyQueue: [] as WritePlan[],
    /** POST /stop 的剧本；null 用默认 {accepted:true}。 */
    stopPlan: null as WritePlan | null,
    /** 收到的写请求体（含 requestId 与正文，供幂等与「不重试」断言）。 */
    chatRequests: [] as Record<string, unknown>[],
    replyRequests: [] as Record<string, unknown>[],
    stopRequests: [] as Record<string, unknown>[],
  }

  private server: Server
  origin = ''

  constructor() {
    this.server = createServer((request: IncomingMessage, response: ServerResponse) => { void this.handle(request, response) })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(body))
    }
    const state = this.state
    if (url.pathname === '/butler/identity') {
      const delay = state.identityDelayMs
      state.identityDelayMs = 0
      if (delay > 0) { setTimeout(() => json(state.identityStatus, state.identityBody), delay); return }
      return json(state.identityStatus, state.identityBody)
    }
    if (url.pathname === '/fixture-butler/conversations') {
      const delay = state.listDelayMs
      const status = state.listStatus
      state.listDelayMs = 0
      state.listStatus = 0
      const respond = () => json(status !== 0 ? status : 200, status !== 0 ? { error: '请先登录', code: 'unauthorized' } : { items: state.conversations })
      if (delay > 0) { setTimeout(respond, delay); return }
      return respond()
    }
    if (url.pathname === '/fixture-butler/history') {
      return json(200, { items: state.history, total: state.history.length, nextOffset: null })
    }
    if (url.pathname === '/fixture-butler/task') {
      const id = url.searchParams.get('id') ?? ''
      if (state.snapshotStatus !== 0 && state.snapshotReads + 1 >= state.snapshotStatusFromRead) {
        return json(state.snapshotStatus, { error: '任务读取失败', code: 'http_error' })
      }
      const snap = state.snapshotFor ? state.snapshotFor(state.snapshotReads + 1) : state.snapshot
      if (id !== snap.id) return json(404, { error: '任务不存在或无权访问', code: 'not_found' })
      state.snapshotReads++
      return json(200, snap)
    }
    if (url.pathname === '/fixture-butler/events') {
      if (url.searchParams.get('probe') === '1') {
        const queued = state.probeQueue.length > 0 ? state.probeQueue.shift() ?? null : state.run
        return json(200, { run: queued })
      }
      if (url.searchParams.get('conversationId') !== 'conv-1') return json(404, { error: '会话不存在或无权访问', code: 'not_found' })
      if (state.eventsStatus !== 0) return json(state.eventsStatus, { error: '会话不存在或无权访问', code: 'forbidden' })
      const step = state.streamQueue.shift() ?? { events: [{ type: 'run', runId: '', state: 'idle', taskId: '' }], done: true }
      state.subscriptions.push(Number(url.searchParams.get('after') ?? 0))
      if (step.status !== undefined) return json(step.status, { error: 'x', code: 'http_error' })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const event of step.events ?? []) response.write('data: ' + JSON.stringify(event) + '\n\n')
      if (step.destroy) { response.destroy(); return }
      if (step.done !== false) response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    if (url.pathname === '/fixture-butler/chat' && request.method === 'POST') {
      const payload = await readBody(request)
      state.chatRequests.push(payload)
      return this.serveWrite(state.chatQueue.shift() ?? defaultChatPlan(payload), response)
    }
    if (url.pathname === '/fixture-butler/reply' && request.method === 'POST') {
      const payload = await readBody(request)
      state.replyRequests.push(payload)
      return this.serveWrite(state.replyQueue.shift() ?? defaultReplyPlan(payload), response)
    }
    if (url.pathname === '/fixture-butler/stop' && request.method === 'POST') {
      const payload = await readBody(request)
      state.stopRequests.push(payload)
      const plan = state.stopPlan
      if (plan?.destroy) { response.destroy(); return }
      if (plan?.hang) return
      if (plan?.status !== undefined) return json(plan.status, plan.body ?? { error: '停止失败', code: 'http_error' })
      // /stop 的成功响应是 JSON（accepted:false 是幂等空操作，不是错误）。
      return json(200, plan?.body ?? { ok: true, accepted: true })
    }
    return json(404, { error: 'not found', code: 'not_found' })
  }

  /** 按剧本回应一个写请求：错误 JSON、断开、悬挂或受理后的事件流。 */
  private serveWrite(plan: WritePlan, response: ServerResponse): void {
    if (plan.hang) return
    if (plan.status !== undefined) {
      response.writeHead(plan.status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(plan.body ?? { error: '写请求失败', code: 'http_error' }))
      return
    }
    if (plan.destroy) { response.destroy(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of plan.events ?? []) response.write('data: ' + JSON.stringify(event) + '\n\n')
    if (plan.cut) {
      // 先把响应头与事件真正发出去，再断开连接：复现「受理已知、事件流中断」。
      response.flushHeaders()
      setTimeout(() => response.destroy(), 20)
      return
    }
    if (plan.done !== false) {
      response.write('data: [DONE]\n\n')
      response.end()
    }
    // done === false：这一轮还在服务端执行，连接保持打开直到客户端断开。
  }

  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', () => resolve()))
    this.origin = 'http://127.0.0.1:' + (this.server.address() as { port: number }).port
    return this.origin
  }

  close(): Promise<void> {
    return new Promise<void>(resolve => { this.server.closeAllConnections(); this.server.close(() => resolve()) })
  }
}
