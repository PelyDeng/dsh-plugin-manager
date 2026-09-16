/**
 * 管家任务的消费客户端。游戏里唯一了解管家 HTTP/SSE、入口发现、契约版本、
 * 事件序号与重连规则的模块。
 *
 * 读：identity 发现、会话列表、运行历史、任务快照与 `/events` 只读订阅。
 * 写（本切片）：`/chat` 开新任务轮、`/reply` 回复等待中的成员、`/stop` 停止当前轮。
 *
 * 写链路的错误语义（与管家契约 v1 逐条对应，写路径一律**不自动重试**）：
 * - 401/403/404 归入 unauthorized/forbidden，409 连同 `code`（`run_busy`、
 *   `version_conflict`、`run_result_unknown`、`idempotency_conflict`、`waiting_expired`、
 *   `not_waiting`、`task_already_finished`…）归入 `conflict`，都只把服务端的
 *   `{error, code}` 交给调用方提示；客户端不代为重发。
 * - **响应未知**（网络失败或受理超时，结果不明）抛 `unknown`：受理与否无从确认，
 *   不编造失败也不编造成功；调用方保留原任务 ID 与原正文，等用户用**同一份**
 *   `requestId` 与正文手动重试——管家幂等保证那是同一次提交。
 * - **stop 不重试**：`/stop` 是请求不是保证，网络失败后结果同样不明；重复停止
 *   幂等，但由用户决定要不要再按一次。
 * - 提交被受理后（收到 200 事件流）连接断掉**不算失败**：这一轮在服务端继续跑，
 *   这里转由只读订阅按最后序号有界重连接管，不重新提交。
 *
 * 入口发现从约定的默认 `/butler/identity` 起步：管家在 identity 里交出真实的
 * `routePrefix` 与 `contractVersion`，之后所有请求都改用返回的前缀，不写死部署配置。
 */
import { readEventStream, STREAM_DONE } from './stream.ts'
import { CONTRACT_VERSION, type ButlerEvent, type ConversationSummary, type IdentityInfo, type RunInfo, type TaskSnapshot } from './task-projection.ts'

/** 链路状态；任务本据此显示连接提示。 */
export type ButlerStatus =
  | 'idle'          // 尚未开始
  | 'connecting'    // 发现入口或读取数据中
  | 'ready'         // 链路可用（订阅流已接通或读取成功）
  | 'offline'       // 断线；已有状态仍可浏览，按有界间隔重连
  | 'unauthorized'  // 未登录
  | 'forbidden'     // 无权限，或会话不属于当前登录（服务端不区分存在性）
  | 'incompatible'  // 管家契约版本不是本客户端认得的版本
  | 'stopped'       // 已主动释放（页面隐藏或销毁）

export type ButlerErrorKind = ButlerStatus | 'http' | 'network' | 'conflict' | 'unknown'

export class ButlerError extends Error {
  /**
   * 管家返回的稳定错误码（`{error, code}` 里的 `code`）；客户端按码分支，
   * 不解析文案。写链路 409 的具体码（version_conflict、run_result_unknown…）在这里。
   */
  readonly code: string

  constructor(kind: ButlerErrorKind, message: string, status = 0, code = '') {
    super(message)
    this.name = 'ButlerError'
    this.kind = kind
    this.status = status
    this.code = code
  }

  readonly kind: ButlerErrorKind
  readonly status: number
}

const IDENTITY_PATH_DEFAULT = '/butler/identity'
const ROUTE_PREFIX_PATTERN = /^\/[a-z0-9][a-z0-9/-]*$/
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000]
/** 写请求「是否受理」的等待上限：只约束拿到响应头，不约束随后的事件流。 */
const WRITE_ACCEPT_TIMEOUT_MS = 15_000

export interface ObserveHandlers {
  /** 收到一条业务事件（run/plan/subtask/summary/…，不含 reset）。 */
  readonly onEvent: (event: ButlerEvent) => void
  /**
   * 需要重读权威快照。`reset` 是游标落在窗口外；`round` 是换了执行轮，info 带着新轮
   * 的 runId/taskId 作为恢复上下文（taskId 可能为空——新轮还在理解阶段）。
   * `seq` 是恢复边界：不大于它的轮内事件属于重放的历史区间，快照正文已经覆盖。
   * `windowStart` 是日志窗口左边缘（事件序号），大于 1 说明更早的事件已经滚出。
   * 两次都应先按当前任务身份重读 `/task` 再续订。
   */
  readonly onReset: (reason: 'reset' | 'round', info: { runId: string; taskId: string; seq: number; windowStart?: number }) => Promise<void>
  /** 观察流正常结束（本轮跑完或空闲），不会再自动重连；`lastSeq` 是已读到的最大序号。 */
  readonly onRoundEnd?: (state: string, lastSeq: number) => void
}

export interface ButlerClientOptions {
  readonly origin?: string
  /** 入口发现的固定起点；本地联调可指向替身。 */
  readonly identityPath?: string
  readonly fetchImpl?: typeof fetch
  /** 重连间隔序列，末项为上限；测试可缩短。 */
  readonly delays?: readonly number[]
  /** 写请求等待「是否受理」的超时（毫秒）；超时按响应未知处理。测试可缩短。 */
  readonly writeAcceptTimeoutMs?: number
  readonly onStatus?: (status: ButlerStatus, detail: string) => void
}

/** `POST /stop` 的结果；`accepted: false` 是幂等空操作，不是错误。 */
export interface StopOutcome {
  readonly accepted: boolean
  readonly reason: string
}

/** 写提交的附加回调：拿到 200 事件流（受理成立）时先于任何事件触发一次。 */
export interface SubmitCallbacks {
  readonly onAccepted?: () => void
}

export class ButlerClient {
  private controller = new AbortController()
  private observeAbort: AbortController | null = null
  /** 写提交响应上那条观察流的中止器；cancelObserve 一并取消它。 */
  private writeAbort: AbortController | null = null
  private discoveryEpoch = 0
  private discovering: Promise<IdentityInfo> | null = null
  /** 当前只读观察循环的在途 Promise；新观察先等旧循环退出。 */
  private observeLoop: Promise<void> | null = null
  private fetchImpl: typeof fetch
  private origin: string
  private delays: readonly number[]
  private writeAcceptTimeoutMs: number
  private identityPrefix: string
  private prefix = ''
  private observing = false
  identity: IdentityInfo | null = null

  constructor(private options: ButlerClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
    this.origin = options.origin ?? globalThis.location?.origin ?? ''
    this.delays = options.delays ?? RECONNECT_DELAYS
    this.writeAcceptTimeoutMs = options.writeAcceptTimeoutMs ?? WRITE_ACCEPT_TIMEOUT_MS
    this.identityPrefix = options.identityPath ?? IDENTITY_PATH_DEFAULT
  }

  get routePrefix(): string {
    return this.prefix || this.identityPrefix.replace(/\/identity$/, '')
  }

  private status(status: ButlerStatus, detail = ''): void {
    this.options.onStatus?.(status, detail)
  }

  private url(path: string): string {
    return this.origin + this.routePrefix + path
  }

  private async read(path: string): Promise<unknown> {
    await this.ensureDiscovered()
    let response: Response
    try {
      response = await this.fetchImpl(this.url(path), { credentials: 'same-origin', signal: this.controller.signal })
    } catch (error) {
      if (this.controller.signal.aborted) throw error
      throw new ButlerError('network', '网络请求失败', 0)
    }
    if (response.status === 401) throw new ButlerError('unauthorized', '需要登录', 401)
    if (response.status === 403) throw new ButlerError('forbidden', '没有访问权限', 403)
    if (response.status === 404) throw new ButlerError('forbidden', '会话不存在或无权访问', 404)
    if (!response.ok) throw new ButlerError('http', '管家接口返回 ' + response.status, response.status)
    try {
      return await response.json()
    } catch {
      throw new ButlerError('http', '管家接口响应无法解析', response.status)
    }
  }

  /** 读操作之前确保入口已发现；并发读取共用同一次在途发现，避免自我淘汰。 */
  private async ensureDiscovered(): Promise<void> {
    if (this.prefix !== '') return
    if (this.discovering === null) {
      this.discovering = this.discover().finally(() => { this.discovering = null })
    }
    await this.discovering
  }

  /** 入口发现：确认可信身份、安全前缀与契约版本；失败按类别抛出。 */
  async discover(): Promise<IdentityInfo> {
    // 迟到的旧发现结果不得落地：否则换登录人后，旧响应会把客户端身份改回去。
    const epoch = ++this.discoveryEpoch
    this.status('connecting', '正在发现管家入口')
    const raw = await this.readFrom(this.origin + this.identityPrefix)
    // 过期检查放在一切会产生状态副作用的校验之前：过期响应无论成败都不影响当前状态。
    if (epoch !== this.discoveryEpoch) throw new ButlerError('stopped', '身份发现结果已过期', 0)
    const identity = raw as IdentityInfo
    if (identity.contractVersion !== CONTRACT_VERSION) {
      this.status('incompatible', '管家契约版本 ' + String(identity.contractVersion) + '，本游戏认得版本 ' + CONTRACT_VERSION)
      throw new ButlerError('incompatible', '管家契约版本不兼容', 0)
    }
    if (typeof identity.routePrefix !== 'string' || !ROUTE_PREFIX_PATTERN.test(identity.routePrefix)) {
      this.status('incompatible', '管家返回的路由前缀不安全')
      throw new ButlerError('incompatible', '管家返回的路由前缀不安全', 0)
    }
    this.prefix = identity.routePrefix
    this.identity = identity
    return identity
  }

  private async readFrom(url: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(url, { credentials: 'same-origin', signal: this.controller.signal })
    } catch (error) {
      if (this.controller.signal.aborted) throw error
      throw new ButlerError('network', '网络请求失败', 0)
    }
    if (response.status === 401) throw new ButlerError('unauthorized', '需要登录', 401)
    if (response.status === 403) throw new ButlerError('forbidden', '没有访问权限', 403)
    if (!response.ok) throw new ButlerError('http', '管家接口返回 ' + response.status, response.status)
    try {
      return await response.json()
    } catch {
      throw new ButlerError('http', '管家接口响应无法解析', response.status)
    }
  }

  /** 当前登录用户的会话列表（服务端按登录身份过滤归属）。 */
  async listConversations(): Promise<ConversationSummary[]> {
    const raw = await this.read('/conversations') as { items?: ConversationSummary[] }
    return Array.isArray(raw.items) ? raw.items : []
  }

  /** 运行历史；按会话或状态筛选由管家完成。 */
  async history(query: { conversationId?: string; state?: string; offset?: number; limit?: number } = {}): Promise<{ items: HistoryItem[]; total: number; nextOffset: number | null }> {
    const params = new URLSearchParams()
    if (query.conversationId) params.set('conversationId', query.conversationId)
    if (query.state) params.set('state', query.state)
    if (query.offset !== undefined) params.set('offset', String(query.offset))
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const raw = await this.read('/history?' + params.toString()) as { items?: HistoryItem[]; total?: number; nextOffset?: number | null }
    return { items: Array.isArray(raw.items) ? raw.items : [], total: raw.total ?? 0, nextOffset: raw.nextOffset ?? null }
  }

  /** 任务的权威快照。 */
  async taskSnapshot(taskId: string): Promise<TaskSnapshot> {
    return await this.read('/task?id=' + encodeURIComponent(taskId)) as TaskSnapshot
  }

  /** 探问某个会话此刻有没有在跑的一轮；`null` 表示没有。 */
  async probe(conversationId: string): Promise<RunInfo | null> {
    const raw = await this.read('/events?conversationId=' + encodeURIComponent(conversationId) + '&probe=1') as { run?: RunInfo | null }
    return raw.run ?? null
  }

  /**
   * 提交一轮新任务（`/chat`）：受理与执行分离，本客户端同时消费这条响应上的
   * 事件流。`requestId` 由调用方按「一次逻辑提交」生成并冻结；响应未知后的手动
   * 重试必须原样复用它，管家幂等保证不会执行两次。
   * 受理成立后连接断掉不算失败：转由 `observe` 的有界重连接管，不重新提交。
   */
  async submitChat(conversationId: string, message: string, requestId: string, handlers: ObserveHandlers, callbacks: SubmitCallbacks = {}): Promise<void> {
    await this.writeAndObserve('/chat', { conversationId, message, requestId }, conversationId, handlers, callbacks)
  }

  /**
   * 回复一位正在等回话的成员（`/reply`）。`conversationId` 用于受理后断流时
   * 重接只读订阅（会话归属由服务端从任务反查，请求体不带它）。
   */
  async submitReply(input: {
    readonly conversationId: string
    readonly taskId: string
    readonly subtaskId: string
    readonly text: string
    readonly decideByAgent: boolean
    readonly requestId: string
  }, handlers: ObserveHandlers, callbacks: SubmitCallbacks = {}): Promise<void> {
    await this.writeAndObserve('/reply', {
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      ...(input.decideByAgent ? { decideByAgent: true } : { text: input.text }),
      requestId: input.requestId,
    }, input.conversationId, handlers, callbacks)
  }

  /** 停止当前这一轮（`/stop`）；`accepted: false` 是幂等空操作，不是错误。不重试。 */
  async requestStop(conversationId: string, taskId = ''): Promise<StopOutcome> {
    const { response, detach } = await this.postFor('/stop', { conversationId, ...(taskId === '' ? {} : { taskId }) })
    try {
      this.assertNotOk(response)
      const body = await response.json().catch(() => null) as { accepted?: boolean; reason?: string } | null
      return { accepted: body?.accepted === true, reason: body?.reason ?? '' }
    } finally {
      detach()
    }
  }

  /**
   * 写请求的公共外壳：POST + 按错误语义归类；受理成立后把响应上的事件流
   * 作为本轮的观察来源消费掉。
   */
  private async writeAndObserve(path: string, body: Record<string, unknown>, conversationId: string, handlers: ObserveHandlers, callbacks: SubmitCallbacks): Promise<void> {
    const { response, writer, detach } = await this.postFor(path, body)
    try {
      this.assertNotOk(response)
      if (response.status === 409) {
        const payload = await readJson(response)
        throw new ButlerError('conflict', payload.error ?? '管家拒绝了这次提交', 409, payload.code ?? 'conflict')
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const payload = await readJson(response)
        throw new ButlerError('http', payload.error ?? '管家返回了意外的响应', response.status, payload.code ?? '')
      }
    } catch (error) {
      detach()
      throw error
    }
    callbacks.onAccepted?.()
    this.status('ready', '已受理，正在观察这一轮')
    await this.consumeWriteStream(response, writer, detach, conversationId, handlers)
  }

  /** 写响应的非 2xx 状态归类：401/403/404 与其余错误码统一映射，JSON 体留给调用方按需读。 */
  private assertNotOk(response: Response): void {
    if (response.ok) return
    if (response.status === 401) throw new ButlerError('unauthorized', '需要登录', 401)
    if (response.status === 403) throw new ButlerError('forbidden', '没有访问权限或请求来源不受信任', 403)
    if (response.status === 404) throw new ButlerError('forbidden', '任务或会话不存在或无权访问', 404)
  }

  /**
   * 发出写请求并等待「是否受理」（响应头）。受理等待有界：超时或网络失败都意味着
   * 结果不明，按 `unknown` 抛出并中断在途连接——不自动重试。返回的 `writer` 管理
   * 这条响应流的后续生命周期（`cancelObserve` 可中止），`detach` 解绑客户端级停止监听。
   */
  private async postFor(path: string, body: Record<string, unknown>): Promise<{ response: Response; writer: AbortController; detach: () => void }> {
    await this.ensureDiscovered()
    const writer = new AbortController()
    const clientStop = () => writer.abort()
    this.controller.signal.addEventListener('abort', clientStop, { once: true })
    const detach = () => this.controller.signal.removeEventListener('abort', clientStop)
    let timer: ReturnType<typeof setTimeout> | undefined
    const overdue = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ButlerError('unknown', '提交后没有在受理时限内收到管家的回应，这一轮是否已受理无法确认', 0)), this.writeAcceptTimeoutMs)
    })
    try {
      const response = await Promise.race([
        this.fetchImpl(this.url(path), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: writer.signal,
        }),
        overdue,
      ])
      return { response, writer, detach }
    } catch (error) {
      detach()
      writer.abort()
      if (this.controller.signal.aborted) throw error
      if (error instanceof ButlerError) throw error
      throw new ButlerError('unknown', '提交后没有收到管家的回应，这一轮是否已受理无法确认', 0)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 消费写响应上的事件流（与 `/events` 同形，`/chat` 开头多一条 `conversation`）。
   * 正常结束回调 `onRoundEnd`；`reset` 先重读快照再转只读订阅；连接断掉时
   * 受理已经成立，转 `observe` 从最后序号有界重连——不重新提交。
   */
  private async consumeWriteStream(response: Response, writer: AbortController, detach: () => void, conversationId: string, handlers: ObserveHandlers): Promise<void> {
    this.writeAbort = writer
    let seq = 0
    let runId = ''
    let lastRunState = ''
    let resetSeq: number | undefined
    let resetWindowStart: number | undefined
    try {
      for await (const raw of readEventStream(response, writer.signal)) {
        if (raw === STREAM_DONE) {
          this.status('ready', '本轮已结束')
          handlers.onRoundEnd?.(lastRunState, seq)
          return
        }
        const event = raw as ButlerEvent
        if (event.type === 'reset') {
          resetSeq = event.seq ?? 0
          resetWindowStart = event.windowStart
          break
        }
        if (event.runId && runId === '') runId = event.runId
        if (event.type === 'run' && typeof event.state === 'string') lastRunState = event.state
        if (Number.isSafeInteger(event.seq)) seq = Math.max(seq, event.seq as number)
        handlers.onEvent(event)
      }
    } catch {
      if (writer.signal.aborted || this.controller.signal.aborted) return
      // 受理已知、流断了：转只读订阅有界重连（不重新提交）。
      await this.observe(conversationId, seq, handlers)
      return
    } finally {
      detach()
      if (this.writeAbort === writer) this.writeAbort = null
    }
    if (resetSeq !== undefined) {
      await handlers.onReset('reset', {
        runId,
        taskId: '',
        seq: resetSeq,
        ...(resetWindowStart === undefined ? {} : { windowStart: resetWindowStart }),
      })
      if (writer.signal.aborted || this.controller.signal.aborted) return
      // 与 observe 的 reset 分支同一条规则：从窗口内还剩的最早一条之前续订。
      await this.observe(conversationId, resetWindowStart === undefined || resetWindowStart <= 1 ? 0 : resetWindowStart - 1, handlers)
      return
    }
    // 没有 [DONE] 的自然断开：同样是转只读订阅续上。
    await this.observe(conversationId, seq, handlers)
  }

  /**
   * 只读订阅某个会话的事件流，直到本轮正常结束、`stop()` 或 `cancelObserve()`。
   * 断线按 1/2/5/10 秒有界重连（上限 10 秒）；收到 `reset` 先回调重读快照，
   * 再从服务端给出的当前序号续订。
   */
  async observe(conversationId: string, after: number, handlers: ObserveHandlers): Promise<void> {
    // 同一个客户端同时只保留一条只读观察：新观察（含写流断开后的接管）先取消
    // 旧的并等它退出，再接自己的流——两条观察写同一个投影才是要避免的事。
    if (this.observing) {
      this.observeAbort?.abort()
      await (this.observeLoop ?? Promise.resolve()).catch(() => {})
      if (this.observing) throw new Error('已有观察流在运行')
    }
    // 守卫通过后同步占位再进入任何 await：并发 observe 不能都穿过发现间隙
    // 各自开循环，那会让先启动的循环成为孤儿（observeAbort 只指向后者）。
    this.observing = true
    try {
      await this.ensureDiscovered()
    } catch (error) {
      this.observing = false
      throw error
    }
    const loop = this.observeLoop = this.observeOnce(conversationId, after, handlers)
    try {
      await loop
    } finally {
      if (this.observeLoop === loop) this.observeLoop = null
    }
  }

  private async observeOnce(conversationId: string, after: number, handlers: ObserveHandlers): Promise<void> {
    const obs = new AbortController()
    this.observeAbort = obs
    const clientStop = () => obs.abort()
    this.controller.signal.addEventListener('abort', clientStop, { once: true })
    let seq = after
    let attempt = 0
    let runId = ''
    let lastRunState = ''
    try {
      while (!obs.signal.aborted) {
        let done = false
        let resetSeq: number | undefined
        let resetRunId = ''
        let resetWindowStart: number | undefined
        let newRound = false
        try {
          const response = await this.fetchImpl(
            this.url('/events?conversationId=' + encodeURIComponent(conversationId) + '&after=' + seq),
            { credentials: 'same-origin', signal: obs.signal },
          )
          if (response.status === 401) { this.status('unauthorized', '需要登录'); return }
          if (response.status === 403 || response.status === 404) { this.status('forbidden', '会话不存在或无权访问'); return }
          if (!response.ok) throw new ButlerError('http', '事件流返回 ' + response.status, response.status)
          this.status('ready', '已连接')
          attempt = 0
          for await (const raw of readEventStream(response, obs.signal)) {
            if (raw === STREAM_DONE) { done = true; break }
            const event = raw as ButlerEvent
            if (event.type === 'reset') {
              resetSeq = event.seq ?? 0
              resetRunId = event.runId ?? runId
              resetWindowStart = event.windowStart
              break
            }
            if (event.runId && runId !== '' && event.runId !== runId) {
              // 换轮：生产端事件序号每轮从 1 重新计数（契约文档的「会话内单调递增」
              // 按轮理解），旧游标会让服务端把新轮早期事件整段跳过——必须从 0 重放。
              newRound = true
              runId = event.runId
              break
            }
            if (event.runId && runId === '') runId = event.runId
            if (event.type === 'run' && typeof event.state === 'string') lastRunState = event.state
            if (Number.isSafeInteger(event.seq)) seq = Math.max(seq, event.seq as number)
            handlers.onEvent(event)
          }
          if (obs.signal.aborted) return
        } catch {
          if (obs.signal.aborted) return
          this.status('offline', '事件流中断，正在重连')
        }
        if (resetSeq !== undefined) {
          // reset 是正常恢复信号：先重读权威快照，再从**窗口内还剩的最早一条**续订——
          // 直接跳到日志头会连窗口里还留着的运行中增量一起略过（那些正文还没落库）。
          // 窗口左边缘之前的增量已经不在日志里，恢复不了，交给会话如实标记不完整。
          await handlers.onReset('reset', {
            runId: resetRunId,
            taskId: '',
            seq: resetSeq,
            ...(resetWindowStart === undefined ? {} : { windowStart: resetWindowStart }),
          })
          if (obs.signal.aborted) return
          seq = resetWindowStart === undefined || resetWindowStart <= 1 ? 0 : resetWindowStart - 1
          attempt = 0
          continue
        }
        if (newRound) {
          // 换执行轮：probe 取新轮身份、状态与头部序号交给会话重读正确任务的快照；
          // 事件日志每个会话只保留最近一轮，随后从 0 重放当前轮——快照不覆盖的
          // 运行中增量由此恢复，已落库的权威结果按恢复边界在投影中排除、不重复计入。
          const run = await this.probe(conversationId)
          if (obs.signal.aborted) return
          await handlers.onReset('round', {
            runId: run?.runId ?? '',
            taskId: run?.taskId ?? '',
            seq: typeof run?.seq === 'number' ? run.seq : -1,
            ...(typeof run?.windowStart === 'number' ? { windowStart: run.windowStart } : {}),
          })
          if (obs.signal.aborted) return
          if (run === null || run.state !== 'running') {
            this.status('ready', '本轮已结束')
            handlers.onRoundEnd?.(run?.state ?? lastRunState, typeof run?.seq === 'number' ? run.seq : seq)
            return
          }
          seq = 0
          attempt = 0
          continue
        }
        if (done) {
          this.status('ready', '本轮已结束')
          handlers.onRoundEnd?.(lastRunState, seq)
          return
        }
        const delay = this.delays[Math.min(attempt++, this.delays.length - 1)]
        this.status('offline', '连接异常，' + Math.round(delay / 1000) + ' 秒后重试')
        await sleepAbortable(delay, obs.signal)
      }
    } finally {
      this.controller.signal.removeEventListener('abort', clientStop)
      if (this.observeAbort === obs) this.observeAbort = null
      this.observing = false
    }
  }

  /** 是否有观察流在跑（页面隐藏时用于判断要不要重新接上）。 */
  get isObserving(): boolean {
    return this.observing
  }

  /** 只取消当前观察流（只读订阅或写响应上的事件流）；客户端本身可继续读取。切换会话或再次提交时用。 */
  cancelObserve(): void {
    this.observeAbort?.abort()
    this.writeAbort?.abort()
  }

  /** 释放：中断在途请求与观察流；已读到的状态留在调用方。 */
  stop(): void {
    this.controller.abort()
    this.status('stopped', '已断开')
  }
}

function sleepAbortable(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
    const abort = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 读一个写响应上的 JSON 错误体；解析失败只说明服务端没给正文，不掩盖原始状态。 */
async function readJson(response: Response): Promise<{ error?: string; code?: string }> {
  try {
    return await response.json() as { error?: string; code?: string }
  } catch {
    return {}
  }
}

/** 运行历史条目；由管家按登录身份过滤。 */
export interface HistoryItem {
  readonly id: string
  readonly conversationId: string
  readonly goal: string
  readonly state: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly subtaskTotal: number
  readonly subtaskDone: number
}
