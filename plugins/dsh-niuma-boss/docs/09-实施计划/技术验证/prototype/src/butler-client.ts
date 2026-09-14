// 复用管家现有 SSE 解码器；这里只验证消费策略，不重验管家后端。
import { readEventStream } from '../../../../../../dsh-butler-console/web/stream.js'

export type ButlerState = {
  connection: string; sequence: number; reconnects: number[]; resets: number
  snapshotReads: number; idempotentExecutions: number; forbiddenRetries: number
}
export class ButlerClient {
  readonly state: ButlerState = { connection: '未连接', sequence: 0, reconnects: [], resets: 0, snapshotReads: 0, idempotentExecutions: 0, forbiddenRetries: 0 }
  private controller = new AbortController()
  private prefix: string
  private taskId = ''
  private runId = ''
  private observing = false

  constructor(private origin: string, identityPrefix: string, private changed: () => void = () => {}) {
    this.prefix = identityPrefix
  }
  async start(): Promise<void> {
    const identity = await this.read('/identity')
    if (identity.contractVersion !== 1 || !/^\/[a-z0-9][a-z0-9/-]*$/.test(identity.routePrefix)) throw new Error('unsupported_contract')
    this.prefix = identity.routePrefix
    await this.read('/conversations')
    await this.refresh()
  }
  stop(): void { this.controller.abort(); this.state.connection = '已停止'; this.changed() }

  async refresh(): Promise<void> {
    const { run } = await this.read('/events?conversationId=validation&probe=1')
    if (run?.taskId) this.taskId = run.taskId
    if (this.taskId) { await this.read('/task?id=' + encodeURIComponent(this.taskId)); this.state.snapshotReads++ }
    this.changed()
  }
  async write(path: '/chat' | '/reply' | '/supplement' | '/stop', payload: object): Promise<unknown> {
    const serialized = JSON.stringify(payload)
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response
      try {
        response = await fetch(this.origin + this.prefix + path, {
          method: 'POST', credentials: 'same-origin', signal: this.controller.signal,
          headers: { 'content-type': 'application/json' }, body: serialized,
        })
      } catch (error) {
        if (this.controller.signal.aborted) throw error
        if (path !== '/stop' && attempt === 0) continue
        await this.refresh()
        throw error
      }
      const result = await response.json().catch(() => ({ code: 'response_body_unknown' }))
      // 有确定 HTTP/业务错误就停止；仅响应未知可按原正文和原 requestId 重试一次。
      if (!response.ok || result.code === 'run_result_unknown' || result.code === 'response_body_unknown') {
        if (response.ok && result.code === 'response_body_unknown' && path !== '/stop' && attempt === 0) continue
        await this.refresh()
        throw new Error(result.code ?? ('http_' + response.status))
      }
      return result
    }
  }
  async observe(): Promise<void> {
    if (this.observing) return
    this.observing = true
    let attempt = 0
    try {
      while (!this.controller.signal.aborted) {
        try {
          const response = await fetch(this.origin + this.prefix + '/events?conversationId=validation&after=' + this.state.sequence, { credentials: 'same-origin', signal: this.controller.signal })
          if (!response.ok) {
            if ([401, 403, 409].includes(response.status)) { this.state.connection = '任务通道不可用'; this.changed(); return }
            throw new Error('stream_http_' + response.status)
          }
          this.state.connection = '已连接'
          this.changed()
          let reset = false
          for await (const raw of readEventStream(response, this.controller.signal)) {
            const event = raw as { type: string; seq?: number; runId?: string; taskId?: string; state?: string }
            if (event.runId && event.runId !== this.runId) { this.runId = event.runId; this.state.sequence = 0 }
            if (event.taskId) this.taskId = event.taskId
            if (event.type === 'reset') {
              await this.refresh()
              this.state.resets++
              this.state.sequence = event.seq ?? 0
              reset = true
            } else if (Number.isSafeInteger(event.seq)) this.state.sequence = Math.max(this.state.sequence, event.seq!)
            if (event.type === 'run' && event.state === 'idle') { this.state.connection = '空闲'; this.changed(); return }
            attempt = 0
            this.changed()
          }
          if (reset) continue
        } catch {
          if (this.controller.signal.aborted) return
          this.state.connection = '断线'
        }
        const delay = [1000, 2000, 5000, 10000][Math.min(attempt++, 3)]
        this.state.reconnects.push(delay)
        this.changed()
        await new Promise<void>(resolve => {
          const abort = () => { clearTimeout(timer); resolve() }
          const timer = setTimeout(() => { this.controller.signal.removeEventListener('abort', abort); resolve() }, delay)
          this.controller.signal.addEventListener('abort', abort, { once: true })
        })
      }
    } finally { this.observing = false }
  }
  private async read(path: string): Promise<any> {
    const response = await fetch(this.origin + this.prefix + path, { credentials: 'same-origin', signal: this.controller.signal })
    if (!response.ok) throw new Error('http_' + response.status)
    return response.json()
  }
}
