/**
 * GameSession：浏览器运行时的核心深模块。对外只提供启动、处理用户意图和停止；
 * 内部把管家权威快照与事件流折叠成任务本投影，并驱动 Phaser 场景的表现边界。
 *
 * 任务终态只来自权威快照与 `summary` 事件；断线期间已有投影保持可浏览，
 * 恢复后重新读取快照与事件序号，不用本地表现推算任务状态。
 *
 * 身份边界：刷新全程持有统一代次，旧刷新的迟到响应不得写回；登录人变化、
 * 空会话列表、观察流或读取返回未登录/无权限时，先取消订阅、作废在途结果，
 * 再清空会话列表与任务投影——不保留可能属于其他用户的数据。
 */
import { ButlerClient, ButlerError } from './butler-client.ts'
import { GameWorld } from './game-world.ts'
import { useTaskBookStore } from './store.ts'
import { applyEvent, applySnapshot, emptyTaskView, type ConversationSummary, type RecoveryContext, type RunInfo } from './task-projection.ts'

export interface GameSessionOptions {
  /** Phaser 挂载点。 */
  readonly parent: HTMLElement
  /** 编译后地图/图集资源的基路径（含部署前缀）。 */
  readonly assetsBase: string
  /** 管家入口发现起点等客户端参数；本地联调可覆盖。 */
  readonly butler?: { origin?: string; identityPath?: string; delays?: readonly number[] }
}

export class GameSession {
  readonly client: ButlerClient
  private world: GameWorld
  private store = useTaskBookStore()
  /** 刷新与选择的统一代次：旧请求的迟到响应不得写回任何状态。 */
  private generation = 0
  private currentTaskId = ''

  constructor(options: GameSessionOptions) {
    this.client = new ButlerClient({
      origin: options.butler?.origin,
      identityPath: options.butler?.identityPath,
      delays: options.butler?.delays,
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
        void this.observe(id, 0, token)
      } else {
        this.store.status = 'ready'
        this.store.statusDetail = run === null ? '当前没有进行中的一轮' : '本轮已结束'
      }
    } catch (error) {
      if (token !== this.generation) return
      this.report(error)
    }
  }

  private async observe(conversationId: string, after: number, token: number): Promise<void> {
    try {
      await this.client.observe(conversationId, after, {
        onEvent: event => {
          if (token !== this.generation) return
          if (event.taskId) this.currentTaskId = event.taskId
          this.store.task = applyEvent(this.store.task, event)
        },
        onReset: async (reason, info) => {
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
        // 本轮结束后补取：执行结束时正文已经落库，快照是完整来源。
        onRoundEnd: (_state, lastSeq) => { void this.completeRound(lastSeq, token) },
      })
    } catch (error) {
      if (token === this.generation) this.report(error)
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

  /** 释放：断开链路并销毁场景。 */
  stop(): void {
    this.generation++
    this.client.stop()
    this.world.destroy()
  }

  private report(error: unknown): void {
    if (error instanceof ButlerError) {
      // http/network 归入断线：已有状态可浏览，界面给出有界重试。
      const status = error.kind === 'http' || error.kind === 'network' ? 'offline' : error.kind
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
