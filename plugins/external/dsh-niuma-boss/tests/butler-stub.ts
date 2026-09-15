import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { TaskSnapshot } from '../src/task-projection.ts'

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
    return json(404, { error: 'not found', code: 'not_found' })
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
