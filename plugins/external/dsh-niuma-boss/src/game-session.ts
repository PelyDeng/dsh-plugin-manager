/**
 * GameSession：浏览器运行时的核心深模块。对外只提供启动、处理用户意图和停止；
 * 内部把管家权威快照与事件流折叠成任务本投影，并驱动 Phaser 场景的表现边界。
 *
 * 任务终态只来自权威快照与 `summary` 事件；断线期间已有投影保持可浏览，
 * 恢复后重新读取快照与事件序号，不用本地表现推算任务状态。
 *
 * 写链路（本切片）同样只映射权威状态：`submitTask`（派活）、`replySubtask`（回复
 * 等待中的成员）、`stopRound`（停止当前轮）把用户意图按管家契约送进去，本会话
 * 不复制管家状态机、不在本地推算停止或完成。错误语义：403/409（含
 * version_conflict、run_result_unknown）只提示不重试；响应未知保留原任务 ID 与
 * 原正文，等用户用同一份 requestId 手动重试；stop 受理后以事件收敛为准。
 *
 * 身份边界：刷新全程持有统一代次，旧刷新的迟到响应不得写回；登录人变化、
 * 空会话列表、观察流或读取返回未登录/无权限时，先取消订阅、作废在途结果，
 * 再清空会话列表与任务投影——不保留可能属于其他用户的数据。
 */
import { ButlerClient, ButlerError, type ButlerStatus } from './butler-client.ts'
import { GameWorld } from './game-world.ts'
import { useTaskBookStore, type PendingSubmit } from './store.ts'
import { applyEvent, applySnapshot, emptyTaskView, type ButlerEvent, type ConversationSummary, type RecoveryContext, type RunInfo } from './task-projection.ts'

export interface GameSessionOptions {
  /** Phaser 挂载点。 */
  readonly parent: HTMLElement
  /** 编译后地图/图集资源的基路径（含部署前缀）。 */
  readonly assetsBase: string
  /** 管家入口发现起点等客户端参数；本地联调可覆盖。 */
  readonly butler?: { origin?: string; identityPath?: string; delays?: readonly number[]; writeAcceptTimeoutMs?: number }
}

export class GameSession {
  readonly client: ButlerClient
  private world: GameWorld
  private store = useTaskBookStore()
  /** 刷新与选择的统一代次：旧请求的迟到响应不得写回任何状态。 */
  private generation = 0
  private currentTaskId = ''
  /** 当前观察循环（只读订阅）的在途 Promise；新意图先等它退出再开自己的流。 */
  private observeTask: Promise<void> | null = null

  constructor(options: GameSessionOptions) {
    this.client = new ButlerClient({
      origin: options.butler?.origin,
      identityPath: options.butler?.identityPath,
      delays: options.butler?.delays,
      writeAcceptTimeoutMs: options.butler?.writeAcceptTimeoutMs,
      onStatus: (status, detail) => {
        this.store.status = status
        this.store.statusDetail = detail
        // 观察流的 401/403/404 只走状态回调、不抛错；身份不可信时立即清空旧用户数据。
        if (status === 'unauthorized' || status === 'forbidden') this.resetForIdentityChange()
      },
    })
    this.world = new GameWorld(options.parent, {
      assetsBase: options.assetsBase,
      inputLocked: () => this.store.bookOpen,
      onInteract: label => { this.store.notice = `${label}：正式对白将在后续版本接入` },
      onAssetsError: detail => { this.store.notice = detail },
      onReady: () => { this.store.worldReady = true },
    })
  }

  /** 启动：先让地图跑起来，再发现管家入口并装载任务本。游戏不因管家不可用而停摆。 */
  async start(): Promise<void> {
    this.world.start()
    await this.refresh()
  }

  /** 重新核验身份并重读会话列表（启动、回到前台、手动刷新时用）。 */
  async refresh(): Promise<void> {
    let token = ++this.generation
    try {
      // 登录人可能已经换了：每次刷新都重新发现身份，旧投影不能带进新身份。
      const previousKey = this.client.identity?.key ?? ''
      await this.client.discover()
      if (token !== this.generation) return
      if (previousKey !== '' && this.client.identity?.key !== previousKey) {
        this.resetForIdentityChange()
        token = this.generation
      }
      const conversations = await this.client.listConversations()
      // 旧刷新的列表响应迟到时直接丢弃，不得把前一用户的会话写回当前页面。
      if (token !== this.generation) return
      await this.reloadConversations(conversations, token)
    } catch (error) {
      // 旧刷新的失败同样不得覆盖新状态：B 已刷新成功后，A 的迟到 401 不能清空页面。
      if (token !== this.generation) return
      this.report(error)
    }
  }

  /** 使旧会话的一切失效：取消订阅与在途请求，清空选择、任务与历史。 */
  private clearSelection(): void {
    this.generation++
    this.client.cancelObserve()
    this.store.selectedId = ''
    this.store.activeRun = null
    this.store.history = []
    this.store.task = emptyTaskView()
  }

  /** 身份变化或授权失效时连会话列表一并作废，不保留可能属于他人的数据。 */
  private resetForIdentityChange(): void {
    this.clearSelection()
    this.store.conversations = []
  }

  private async reloadConversations(conversations: ConversationSummary[], token: number): Promise<void> {
    if (conversations.length === 0) {
      // 空列表同样可能是换了没有管家会话的账号：旧任务与历史必须清空。
      this.resetForIdentityChange()
      this.store.status = 'ready'
      this.store.statusDetail = '还没有管家会话；去管家入口发起第一轮任务后，这里会同步显示'
      return
    }
    this.store.conversations = conversations
    const keep = conversations.find(c => c.id === this.store.selectedId)
    if (keep === undefined) this.clearSelection()
    await this.selectConversation((keep ?? conversations[0]).id)
  }

  /** 用户意图：选择一个会话；读取快照与历史，若有活跃轮则接上只读订阅。 */
  async selectConversation(id: string): Promise<void> {
    const token = ++this.generation
    this.client.cancelObserve()
    this.store.selectedId = id
    this.store.task = emptyTaskView(id)
    this.store.activeRun = null
    this.store.history = []
    this.currentTaskId = ''
    this.store.status = 'connecting'
    this.store.statusDetail = '正在读取任务'
    try {
      const run = await this.client.probe(id)
      if (token !== this.generation) return
      this.store.activeRun = run
      const history = await this.client.history({ conversationId: id, limit: 10 })
      if (token !== this.generation) return
      this.store.history = history.items
      // 任务详情优先活跃轮；没有活跃轮时展示该会话最近一次任务。
      const taskId = run?.taskId || history.items[0]?.id || ''
      if (taskId !== '') {
        const snapshot = await this.client.taskSnapshot(taskId)
        if (token !== this.generation) return
        this.currentTaskId = taskId
        // 恢复上下文带上 probe 的轮身份与头部序号：快照正文覆盖到哪条事件由此确定。
        this.store.task = applySnapshot(this.store.task, snapshot, Date.now(), recoveryOf(run))
      }
      if (run !== null && run.state === 'running') {
        // 事件日志每个会话只保留最近一轮：从 0 重放当前轮。快照先给出权威基准
        // （已落库的完成材料在投影中标记），运行中的增量只能来自重放，不会丢。
        this.observe(id, 0, token)
      } else {
        this.store.status = 'ready'
        this.store.statusDetail = run === null ? '当前没有进行中的一轮' : '本轮已结束'
      }
    } catch (error) {
      if (token !== this.generation) return
      this.report(error)
    }
  }

  /** 只读订阅与写响应事件流共用的投影处理：一切事件先过代次，再进权威投影。 */
  private handlersFor(token: number) {
    return {
      onEvent: (event: ButlerEvent) => {
        if (token !== this.generation) return
        // `/chat` 响应开头的会话声明：游戏新建的会话先记下归属，
        // 本轮结束后的列表补读会把它并进导航。
        if (event.type === 'conversation' && event.conversationId && this.store.selectedId === '') {
          this.store.selectedId = event.conversationId
        }
        if (event.taskId) this.currentTaskId = event.taskId
        this.store.task = applyEvent(this.store.task, event)
      },
      onReset: async (reason: 'reset' | 'round', info: { runId: string; taskId: string; seq: number; windowStart?: number }) => {
        // 换轮时以 probe 给出的新轮任务身份为准——新轮可能已经换了任务，
        // 不能拿旧 currentTaskId 读快照。
        if (reason === 'round' && info.taskId !== '') this.currentTaskId = info.taskId
        if (this.currentTaskId === '') return
        const snapshot = await this.client.taskSnapshot(this.currentTaskId)
        if (token !== this.generation) return
        // 快照重建正文基准；边界取 probe 序号，重放里已经落库的正文按边界排除，
        // 恢复之后的新增量照常累积。窗口左边缘大于 1 说明更早的事件已滚出，
        // 未落库的片段补不回来，如实标记正文可能不完整。
        this.store.task = applySnapshot(this.store.task, snapshot, Date.now(), {
          runId: info.runId,
          seq: info.seq,
          truncated: info.windowStart === undefined || info.windowStart > 1,
        })
      },
      // 本轮结束后补取：执行结束时正文已经落库，快照是完整来源；随后补读会话
      // 与历史列表，任一入口看到的都是同一份权威记录。
      onRoundEnd: (_state: string, lastSeq: number) => {
        // onRoundEnd 在观察循环退出前触发：等它彻底退出再做收尾，避免交叉。
        void (this.observeTask ?? Promise.resolve()).finally(() => { void this.afterRoundEnd(lastSeq, token) })
      },
    }
  }

  private observe(conversationId: string, after: number, token: number): Promise<void> {
    const task = this.client.observe(conversationId, after, this.handlersFor(token))
      .catch(error => { if (token === this.generation) this.report(error) })
    this.observeTask = task
    return task
  }

  /** 本轮结束：按需补取完整正文（只读 GET），再补读会话与运行历史。 */
  private async afterRoundEnd(lastSeq: number, token: number): Promise<void> {
    await this.completeRound(lastSeq, token)
    try {
      const conversations = await this.client.listConversations()
      if (token !== this.generation) return
      this.store.conversations = conversations
      if (this.store.selectedId === '') return
      const history = await this.client.history({ conversationId: this.store.selectedId, limit: 10 })
      if (token !== this.generation) return
      this.store.history = history.items
    } catch {
      // 列表补读失败不打断已完成的本轮展示，下次刷新再取。
    }
  }

  /**
   * 补取权威快照：只在标记「可能不完整」时读一次（只读 GET，不写任何东西）。
   * 投影只对**能证明属于本轮**的结果（succeeded/external_pending）替换正文并清除提示；
   * 普通失败/取消留下的旧 result 既不当成本轮正文，也不清除提示——GET 成功不等于正文完整。
   */
  private async completeRound(lastSeq: number, token: number): Promise<void> {
    if (!this.store.task.incomplete || this.currentTaskId === '') return
    try {
      const snapshot = await this.client.taskSnapshot(this.currentTaskId)
      if (token !== this.generation) return
      this.store.task = applySnapshot(this.store.task, snapshot, Date.now(), {
        runId: this.store.task.lastRunId,
        seq: lastSeq,
        final: true,
      })
    } catch {
      this.store.statusDetail = '本轮已结束，但补取完整正文失败；可手动刷新再取'
    }
  }

  /** 页面隐藏：暂停渲染；订阅保持，回前台再按权威快照核对。 */
  onHidden(): void {
    this.world.pause()
  }

  /** 页面回前台：恢复渲染，重读任务快照并恢复订阅。 */
  onVisible(): void {
    this.world.resume()
    void this.refresh()
  }

  /** 用户意图：任务本开合。 */
  openBook(): void { this.store.bookOpen = true }

  closeBook(): void { this.store.bookOpen = false }

  /** 用户意图：断线/过期后的手动重试。 */
  retry(): void {
    void this.refresh()
  }

  /**
   * 用户意图：派活（`/chat` 开一轮新任务）。在当前会话上提交，与管家入口共享
   * 同一份任务流；还没有任何会话时按管家约定新建一个会话标识。
   */
  async submitTask(message: string): Promise<void> {
    const text = message.trim()
    if (text === '' || this.store.submitting) return
    const conversationId = this.store.selectedId !== '' ? this.store.selectedId : newConversationId()
    this.store.pendingSubmit = {
      kind: 'chat', conversationId, requestId: newRequestId(), message: text,
      taskId: '', subtaskId: '', replyText: '', decideByAgent: false,
    }
    await this.dispatchSubmit()
  }

  /** 用户意图：回复一位等待中的成员（`/reply`）；`decideByAgent` 表示「让它自己拿主意」。 */
  async replySubtask(subtaskId: string, text: string, decideByAgent = false): Promise<void> {
    if (this.store.submitting || this.currentTaskId === '' || this.store.selectedId === '') return
    if (!decideByAgent && text.trim() === '') return
    this.store.pendingSubmit = {
      kind: 'reply', conversationId: this.store.selectedId, requestId: newRequestId(), message: '',
      taskId: this.currentTaskId, subtaskId, replyText: text.trim(), decideByAgent,
    }
    await this.dispatchSubmit()
  }

  /** 用户意图：响应未知后原样重试同一份提交（同一 requestId 与正文，管家幂等不重复执行）。 */
  retrySubmit(): void {
    if (this.store.pendingSubmit !== null && !this.store.submitting) void this.dispatchSubmit()
  }

  /** 用户意图：停止当前这一轮（`/stop`）。受理即反馈；是否真停下以管家事件为准，本地不推算、不重试。 */
  async stopRound(): Promise<void> {
    if (this.store.selectedId === '' || this.store.submitting) return
    const token = this.generation
    this.store.submitting = true
    try {
      // 带 taskId 精确到这一轮：旧任务迟到的取消不会碰到该会话随后开的新任务。
      const outcome = await this.client.requestStop(this.store.selectedId, this.currentTaskId)
      this.store.notice = outcome.accepted
        ? '已请求停止本轮；停止进度以管家的任务事件为准。'
        : '本轮无需停止：' + (outcome.reason || '当前没有正在执行的一轮')
    } catch (error) {
      // stop 的失败不构成「待重试的提交已失效」的证据：404/500 只说明这次停止没
      // 成功，错误提示走 stop 自己的路径，不触碰 pendingSubmit。只有 401/403 连
      // 身份一起不可信，沿用提交链路的清空规则。
      if (error instanceof ButlerError && (error.kind === 'unauthorized' || (error.kind === 'forbidden' && error.status === 403))) {
        this.store.pendingSubmit = null
        this.report(error)
        this.store.notice = '停止请求被拒绝：' + error.message
      } else if (error instanceof ButlerError && error.kind === 'unknown') {
        this.store.notice = '停止请求后没有收到管家的回应，本轮是否已停止无法确认。不会自动重试；可刷新查看最新状态，需要时再停一次（重复停止是幂等的）。'
      } else {
        this.store.notice = '停止请求失败：' + (error instanceof Error ? error.message : String(error))
          + '。不会自动重试，可再停一次或刷新查看最新状态；待重试的提交不受影响。'
      }
    } finally {
      // 期间有新意图接管了代次时不抢着解锁它的提交锁。
      if (token === this.generation) this.store.submitting = false
    }
  }

  /** 把待重试的提交送进管家：作废旧观察、串行写入口、按错误语义提示。 */
  private async dispatchSubmit(): Promise<void> {
    const pending = this.store.pendingSubmit
    if (pending === null) return
    const token = ++this.generation
    this.store.submitting = true
    this.store.notice = ''
    // 新意图作废旧观察（只读订阅或上一次写响应的流）：先取消再等它退出，
    // 事件投影只属于这一次提交。
    this.client.cancelObserve()
    await (this.observeTask ?? Promise.resolve()).catch(() => {})
    const accepted = () => {
      if (token !== this.generation) return
      this.store.pendingSubmit = null
      // 受理即解锁写入口：这一轮可以继续观察，用户也能进行下一个意图（如回复）。
      this.store.submitting = false
      if (pending.kind === 'chat') this.store.assignDraft = ''
      else this.store.replyDrafts = { ...this.store.replyDrafts, [pending.subtaskId]: '' }
    }
    try {
      const handlers = this.handlersFor(token)
      if (pending.kind === 'chat') {
        await this.client.submitChat(pending.conversationId, pending.message, pending.requestId, handlers, { onAccepted: accepted })
      } else {
        await this.client.submitReply({
          conversationId: pending.conversationId,
          taskId: pending.taskId,
          subtaskId: pending.subtaskId,
          text: pending.replyText,
          decideByAgent: pending.decideByAgent,
          requestId: pending.requestId,
        }, handlers, { onAccepted: accepted })
      }
    } catch (error) {
      if (token === this.generation) this.reportSubmitError(error)
    } finally {
      if (token === this.generation) this.store.submitting = false
    }
  }

  /** 写链路失败只提示，不改链路状态、不清投影；身份类错误沿用读链路的清空规则。 */
  private reportSubmitError(error: unknown): void {
    if (!(error instanceof ButlerError)) {
      this.store.notice = (error instanceof Error ? error.message : String(error)) || '提交失败'
      return
    }
    switch (error.kind) {
      case 'unknown':
        // 响应未知：保留待重试的提交（同一 requestId 与正文），不编造失败也不编造成功。
        this.store.notice = error.message + '。不会自动重试；可点「重试提交」用同一份内容再试一次（管家按 requestId 幂等），或刷新查看是否已受理。'
        return
      case 'unauthorized':
      case 'forbidden':
        this.store.pendingSubmit = null
        // 身份不可信：按读链路同一条规则清空可能属于其他用户的数据。
        this.report(error)
        this.store.notice = '提交被拒绝：' + error.message
        return
      case 'conflict':
        this.store.pendingSubmit = null
        this.store.notice = conflictNotice(error.code, error.message)
        return
      default:
        this.store.pendingSubmit = null
        this.store.notice = '提交失败：' + error.message
    }
  }

  /** 释放：断开链路并销毁场景。 */
  stop(): void {
    this.generation++
    this.client.stop()
    this.world.destroy()
  }

  private report(error: unknown): void {
    if (error instanceof ButlerError) {
      // http/network 归入断线：已有状态可浏览，界面给出有界重试。
      // conflict/unknown 是写链路语义，由 reportSubmitError 以轻提示处理，不改链路状态；
      // 防御性地归入 offline，保证状态字段永远是合法的链路状态。
      const kind = error.kind
      const status: ButlerStatus = kind === 'http' || kind === 'network' || kind === 'conflict' || kind === 'unknown' ? 'offline' : kind
      this.store.status = status
      this.store.statusDetail = error.message
      // 未登录/无权限时身份已不可信，清空可能属于其他用户的数据。
      if (status === 'unauthorized' || status === 'forbidden') this.resetForIdentityChange()
    } else {
      this.store.status = 'offline'
      this.store.statusDetail = (error instanceof Error ? error.message : String(error)) || '连接管家失败'
    }
  }
}

/** 恢复上下文：probe 给出的当前轮身份、头部序号与日志窗口左边缘。 */
function recoveryOf(run: RunInfo | null): RecoveryContext {
  return {
    runId: run?.runId ?? '',
    seq: typeof run?.seq === 'number' ? run.seq : -1,
    // 窗口左边缘大于 1（或窗口信息缺失）时不假定完整：宁可提示可能不完整，也不静默展示残缺正文。
    truncated: run !== null && (typeof run.windowStart !== 'number' || run.windowStart > 1),
  }
}

/** 新的管家会话标识：客户端生成，须匹配管家的 UUID v4 约定。 */
function newConversationId(): string {
  return 'butler-web-' + crypto.randomUUID()
}

/** 一次逻辑提交的幂等标识：同 owner、同类型、同 requestId 视为同一次提交。 */
function newRequestId(): string {
  return 'niuma-' + crypto.randomUUID()
}

/** 409 家族按稳定码给出可操作的提示；未认得的码沿用服务端文案，不解析语义。 */
function conflictNotice(code: string, message: string): string {
  const notices: Record<string, string> = {
    run_busy: '管家正在处理上一条消息；请等它完成或先停止本轮。',
    run_result_unknown: '这次提交此前已受理但结果不明，管家不会重新执行；请刷新读取任务快照确认结果。',
    run_already_finished: '这次提交已经处理完成；请刷新读取任务快照查看结果。',
    version_conflict: '这一轮已被另一入口更新到新版本；请刷新后按最新内容重新提交。',
    idempotency_conflict: '这次提交的 requestId 已用在另一份内容上；请修改内容后重新提交。',
    waiting_expired: '这次等待已经过期；请重新描述你的目标开新的一轮。',
    not_waiting: '这位成员当前没有在等你回话；请刷新查看最新状态。',
    task_already_finished: '这一轮已经结束；如需继续请开新的一轮。',
  }
  return notices[code] ?? message
}
