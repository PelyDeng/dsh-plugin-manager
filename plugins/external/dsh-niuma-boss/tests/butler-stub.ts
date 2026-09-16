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
 *
 * 能力边界：幂等记录只在进程内存里，受理后「事件日志是否还能回放」用剧本字段
 * `lostLog` 显式表达（真实管家按事件日志头是不是那一轮判断），保留期与跨重启
 * 持久化都不模拟；`lostLog` 命中时按契约回 409——那一轮已有终态证据
 * （`run_already_finished`）或只有受理、结果不明（`run_result_unknown`），两种都不重新执行。
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
  /** 收到请求后不回应直接断开连接：复现「响应未知」，且这次**没有**受理。 */
  destroy?: boolean
  /** 收到请求后永不回应：复现受理超时（配合客户端缩短的受理时限）。 */
  hang?: boolean
  /** 受理成立、事件发出后断开连接：复现「受理已知、事件流中断」。 */
  cut?: boolean
  /**
   * 受理成立（这一轮真的在服务端跑起来、幂等占位落下）但响应没有送到：
   * 复现「提交可能已被受理、结果不明」——客户端只能保留原正文手动重试，重试按
   * requestId 拿回**同一轮**，不重复执行。
   */
  acceptThenDestroy?: boolean
  /** 受理成立后写在响应事件流上的事件序列。 */
  events?: object[]
  /** 事件发完后是否以 [DONE] 结束；false 表示这一轮还在跑、连接保持打开。 */
  done?: boolean
  /** `/stop` 响应前的延迟（毫秒）：复现停止请求迟到（等它到达时本轮已被别的入口结束）。 */
  delayMs?: number
  /**
   * 首次那一轮的事件日志已经不可回放（契约里的两种情形：被下一轮覆盖，或受理后
   * 进程重启、只在内存里的日志丢掉）。同一个 `requestId` 的同一份正文再次到达时
   * 没有过程可回放，按契约回 `409`：那一轮已有终态证据（有 `summary` 事件）回
   * `run_already_finished`，否则（受理过、没有终态证据）回 `run_result_unknown`；
   * 两种都**不重新执行**，也不计入幂等重放。
   */
  lostLog?: boolean
}

/** 一次受理的幂等记录：同 requestId 同正文再提交时回放**首次那一轮**（不重复执行）。 */
interface IdempotencyRecord {
  readonly fingerprint: string
  /** 回放形态：首次那一轮的凭据（run 头）与事件流，从第一条事件重新发一遍。 */
  readonly replay: WritePlan
  /** 首次那一轮的凭据：日志不可回放时回在 409 里，供客户端去读任务快照。 */
  readonly runId: string
  readonly conversationId: string
  /** 首次那一轮是否已有终态证据（`summary`）：决定不可回放时的错误码。 */
  readonly finished: boolean
  /** 首次那一轮的日志是否已不可回放（剧本字段 `lostLog`）。 */
  readonly lostLog: boolean
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
    /** POST /stop 的剧本队列（先到先用）；用尽后落到 stopPlan。 */
    stopQueue: [] as WritePlan[],
    /** 收到的写请求体（含 requestId 与正文，供幂等与「不重试」断言）。 */
    chatRequests: [] as Record<string, unknown>[],
    replyRequests: [] as Record<string, unknown>[],
    stopRequests: [] as Record<string, unknown>[],
    /** 真正**执行**的轮次数（受理成立才 +1）：幂等重试不回放执行，只回放首次那一轮的凭据。 */
    chatExecutions: 0,
    replyExecutions: 0,
    /** 按 requestId 命中的幂等重放次数（同一份提交再次到达）。 */
    duplicateSubmits: [] as string[],
    /** requestId → 首次受理的幂等记录。 */
    idempotency: new Map<string, IdempotencyRecord>(),
    /** 每一个到达桩的请求路径：用于断言某条通路「一次调用都没有」（例如普通 NPC 对白）。 */
    requests: [] as string[],
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
    state.requests.push((request.method ?? 'GET') + ' ' + url.pathname)
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
      if (step.destroy) {
        // 先把已经写的事件真正发出去，再断开：复现「读到了几条事件之后连接中断」。
        response.flushHeaders()
        setTimeout(() => response.destroy(), 20)
        return
      }
      if (step.done !== false) response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    if (url.pathname === '/fixture-butler/chat' && request.method === 'POST') {
      const payload = await readBody(request)
      state.chatRequests.push(payload)
      return this.serveWrite(this.planned('chat', payload, state.chatQueue), response)
    }
    if (url.pathname === '/fixture-butler/reply' && request.method === 'POST') {
      const payload = await readBody(request)
      state.replyRequests.push(payload)
      return this.serveWrite(this.planned('reply', payload, state.replyQueue), response)
    }
    if (url.pathname === '/fixture-butler/stop' && request.method === 'POST') {
      const payload = await readBody(request)
      state.stopRequests.push(payload)
      const plan = state.stopQueue.shift() ?? state.stopPlan ?? this.defaultStopPlan(payload)
      const respond = () => {
        if (plan.destroy) { response.destroy(); return }
        if (plan.hang) return
        if (plan.status !== undefined) return json(plan.status, plan.body ?? { error: '停止失败', code: 'http_error' })
        // /stop 的成功响应是 JSON（accepted:false 是幂等空操作，不是错误）。
        return json(200, plan.body ?? { ok: true, accepted: true })
      }
      if (plan.delayMs !== undefined) { setTimeout(respond, plan.delayMs); return }
      respond()
      return
    }
    return json(404, { error: 'not found', code: 'not_found' })
  }

  /**
   * 没有显式剧本时的 `/stop` 契约行为：带 `taskId` 时只中止「当前这一轮确实在跑那个
   * 任务」的情况——旧任务迟到的取消请求不会碰到该会话随后开的新任务，按幂等空操作回
   * `accepted:false`（不是错误）。
   */
  private defaultStopPlan(payload: Record<string, unknown>): WritePlan {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
    const current = this.state.run?.taskId ?? ''
    if (taskId !== '' && taskId !== current) {
      return { body: { ok: true, accepted: false, reason: '这个任务已经不在执行了' } }
    }
    return { body: { ok: true, accepted: true } }
  }

  /**
   * 按 requestId 决定这次写请求的剧本。契约里「同 owner + 同类型 + 同 requestId」是同一次
   * 提交：首次到达按剧本队列受理；再次到达且正文相同时——首次那一轮的日志还能回放就
   * **回放首次那一轮**（同一个 runId，不重新执行），日志已经不可回放（`lostLog`）则按契约
   * 回 409（终态已落库 `run_already_finished`／只有受理 `run_result_unknown`）；正文不同则
   * 回 409 idempotency_conflict。不带 requestId 时每次都是新一轮。
   */
  private planned(kind: 'chat' | 'reply', payload: Record<string, unknown>, queue: WritePlan[]): WritePlan {
    const state = this.state
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
    const plan = queue.shift() ?? (kind === 'chat' ? defaultChatPlan(payload) : defaultReplyPlan(payload))
    // 受理成立 = 走了事件流（400/409/断开/悬挂都没有受理）。
    const accepted = plan.status === undefined && plan.destroy !== true && plan.hang !== true
    if (requestId === '' || !accepted) return plan
    const fingerprint = kind + '|' + JSON.stringify(payload)
    const events = plan.events ?? []
    const runHead = events.find(event => (event as { type?: string }).type === 'run') as { runId?: string } | undefined
    const seen = state.idempotency.get(requestId)
    if (seen !== undefined) {
      if (seen.fingerprint !== fingerprint) {
        return { status: 409, body: { error: '这次提交的 requestId 已经用在另一份内容上', code: 'idempotency_conflict' } }
      }
      if (seen.lostLog) {
        // 没有可回放的记录：不重新执行，也不计入幂等重放；按那一轮有没有终态证据给码。
        return { status: 409, body: {
          error: seen.finished
            ? '这次提交已经处理过，那一轮也已经结束，无法再回放它的过程'
            : '这次提交已经受理过，但结果不明（服务在这里重启过）；不会重新执行',
          code: seen.finished ? 'run_already_finished' : 'run_result_unknown',
          runId: seen.runId,
          conversationId: seen.conversationId,
        } }
      }
      // 同一次提交：回放首次那一轮的凭据与事件流，执行次数不再增加。
      state.duplicateSubmits.push(requestId)
      return seen.replay
    }
    state.idempotency.set(requestId, {
      fingerprint,
      replay: { events, done: plan.done },
      runId: runHead?.runId ?? '',
      conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : '',
      // 终态证据 = 这一轮的剧本里有 summary（契约里 finished 与 claimed 的分界）。
      finished: events.some(event => (event as { type?: string }).type === 'summary'),
      lostLog: plan.lostLog === true,
    })
    if (kind === 'chat') state.chatExecutions++
    else state.replyExecutions++
    return plan
  }

  /** 按剧本回应一个写请求：错误 JSON、断开、悬挂或受理后的事件流。 */
  private serveWrite(plan: WritePlan, response: ServerResponse): void {
    if (plan.delayMs !== undefined && plan.delayMs > 0 && !response.writableEnded) {
      // 迟到的受理与事件：响应到达时界面可能已经换了会话或轮次（代次守卫要拦住它）。
      setTimeout(() => { if (!response.writableEnded) this.serveWrite({ ...plan, delayMs: 0 }, response) }, plan.delayMs)
      return
    }
    if (plan.hang) return
    if (plan.status !== undefined) {
      response.writeHead(plan.status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(plan.body ?? { error: '写请求失败', code: 'http_error' }))
      return
    }
    if (plan.destroy) { response.destroy(); return }
    if (plan.acceptThenDestroy) {
      // 受理成立（这一轮在服务端跑），但响应没有送到客户端：响应未知，重试按 requestId 回放同一轮。
      response.destroy()
      return
    }
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
