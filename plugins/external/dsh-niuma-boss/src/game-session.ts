/**
 * GameSession：浏览器运行时的核心深模块。对外只提供启动、处理用户意图和停止；
 * 内部把管家权威快照与事件流折叠成任务本投影，并驱动 Phaser 场景的表现边界。
 *
 * 任务终态只来自权威快照与 `summary` 事件；断线期间已有投影保持可浏览，
 * 恢复后重新读取快照与事件序号，不用本地表现推算任务状态。
 *
 * 人物表现（本切片）：权威投影 → **表现命令**（src/performance.ts 的纯函数）→
 * GameWorld。命令只在权威状态变化时重算，表现层没有任何回写通路，因此演出缺失、
 * 重复或乱序都不会改变任务终态；整轮只收到终态时命令直接收敛到「交回并回工位」。
 * 就近交互（src/interaction.ts）只做两件事：按作者优先级选出唯一提示，并按作者数据
 * 打开普通 NPC 的预写对白或员工名牌——两个通路都不产生任务、不调用模型或业务工具。
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
 *
 * 故障恢复与竞争场景（本切片）：代次守卫覆盖读与写两条链路——旧会话/旧身份的
 * 迟到事件、迟到受理回调、迟到快照都不进新会话的状态；写尝试按序号归属，受理回调
 * 只清自己那一次的冻结提交（用户点过「重试提交」后，旧尝试的迟到受理不会把新尝试
 * 的冻结提交清掉，重试入口保持可用）；换会话时旧上下文的写状态与草稿一并收起
 * （待重试的冻结提交属于旧会话就作废，在途提交的界面锁解开），因此旧请求
 * 释放后不写回新会话，新会话的写入口也不会被旧请求锁死。页面隐藏只暂停渲染并落盘
 * 位置，订阅保持；回前台重读权威快照并按 probe 重新接上订阅。权限失效（无论来自
 * 读取、订阅流还是写链路）沿用同一条清空规则，界面按链路状态给出可见原因。
 */
import { ButlerClient, ButlerError, type ButlerStatus } from './butler-client.ts'
import { GameWorld } from './game-world.ts'
import { INTERACT_RADIUS_TILES, dialogueStillInReach, npcDialogue, resolvePrompt, staffNameplate, type NearTarget, type Prompt } from './interaction.ts'
import { deriveStaffCommands, staffDialogueViews } from './performance.ts'
import { browserStorage, RecoveryStore, scopeOf, type WorldSnapshot } from './recovery.ts'
import { applyStageVariables } from './stage.ts'
import { useTaskBookStore, type PendingSubmit } from './store.ts'
import { applyEvent, applySnapshot, emptyTaskView, taskStateLabel, type ButlerEvent, type ConversationSummary, type RecoveryContext, type RunInfo } from './task-projection.ts'
import type { Feet } from './world-runtime.ts'

export interface GameSessionOptions {
  /** Phaser 挂载点。 */
  readonly parent: HTMLElement
  /** 舞台变量宿主（.shell）：--stage-* 设在这里，提示/对白/toast 才能锚在游戏画面内。 */
  readonly stageHost?: HTMLElement
  /** 编译后地图/图集资源的基路径（含部署前缀）。 */
  readonly assetsBase: string
  /** 管家入口发现起点等客户端参数；本地联调可覆盖。 */
  readonly butler?: { origin?: string; identityPath?: string; delays?: readonly number[]; writeAcceptTimeoutMs?: number }
  /** 位置快照存储；缺省用浏览器 localStorage，测试可传替身。 */
  readonly recovery?: RecoveryStore
}

export class GameSession {
  readonly client: ButlerClient
  private world: GameWorld
  private store = useTaskBookStore()
  /** 位置恢复：按登录用户分开存，只存地图/格子/朝向/偏好四项。 */
  private readonly recovery: RecoveryStore
  private scope = ''
  /** 刷新与选择的统一代次：旧请求的迟到响应不得写回任何状态。 */
  private generation = 0
  /** 写尝试序号：受理回调只认自己那一次尝试（用户可能已经用同一份提交点了重试）。 */
  private submitAttempt = 0
  private currentTaskId = ''
  /** 当前观察循环（只读订阅）的在途 Promise；新意图先等它退出再开自己的流。 */
  private observeTask: Promise<void> | null = null
  /** 业务员工 id（作者数据 role=staff）：切图后仍保留，命令不会因为前台地图变了而丢。 */
  private staffIds: string[] = []
  /** 员工显示名（作者角色名册），只用于界面文案。 */
  private readonly staffLabels = new Map<string, string>()
  /** 就近范围内的可交互对象（表现事实），提示由它和权威任务事实一起解析。 */
  private near: NearTarget[] = []

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
    this.recovery = options.recovery ?? new RecoveryStore(browserStorage())
    this.world = new GameWorld(options.parent, {
      assetsBase: options.assetsBase,
      // 舞台矩形变化（建场景/resize/换 zoom）写进 .shell 的 CSS 变量，DOM 提示跟着锚定游戏画面。
      onStage: stage => applyStageVariables(options.stageHost, stage),
      inputLocked: () => this.store.bookOpen || this.store.dialogue !== null,
      onInteract: target => { this.interact(target) },
      onNearTargets: targets => {
        this.near = targets
        // 走远/离场的角色自动结束就近会话，再按作者优先级解析唯一提示。
        this.closeDialogueIfOutOfReach()
        this.syncPrompt()
      },
      onInteractKey: () => { this.interactKey() },
      onAssetsError: detail => { this.store.notice = detail },
      onPortalHeld: hint => { this.envNotice(hint) },
      onReady: () => {
        this.store.worldReady = true
        this.syncRoster()
        // 场景重建后表现层会自己复位；这里只同步界面用的名册与气泡。
        this.refreshPerformance()
        this.syncPrompt()
      },
      onLoading: () => { this.store.worldReady = false },
      // 位置事实按格变化回调一次；只写四项快照，不带任何任务内容。
      onFeet: feet => {
        // 换图后旧图的角色已经不在近邻事实里：就近会话随之关闭（先判再落盘新地图）。
        if (feet.map !== this.store.worldMap) this.closeDialogueIfOutOfReach(true)
        this.saveFeet(feet)
      },
      restore: () => this.recovery.load(this.scope),
    })
  }

  /**
   * 启动：先让地图跑起来，再发现管家入口并装载任务本。游戏不因管家不可用而停摆，
   * 地图启动失败也不连带丢掉任务本：两条链路各自成败，任务本入口始终走到底。
   */
  async start(): Promise<void> {
    // 身份确认前先按上次活跃用户恢复位置与界面偏好；确认后立刻校正（换用户就换位置）。
    this.scope = this.recovery.lastScope()
    this.store.bookOpen = this.recovery.load(this.scope)?.preferences.taskBookOpen === true
    try {
      await this.world.start()
    } catch (error) {
      // 出生地图资产缺失/过期时如实记录，不吞错也不静默；任务本照常刷新。
      console.error('牛马-老板：地图启动失败', error)
    }
    this.store.worldMap = this.world.mapId
    this.syncRoster()
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
      this.applyUserScope()
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

  /**
   * 按登录身份切换位置作用域：换用户时把人物换到那位用户自己的落点，界面偏好
   * 也换成他自己的，没有快照就回安全出生点。身份未知（未登录）时不动已恢复的位置。
   */
  private applyUserScope(): void {
    const identityKey = this.client.identity?.key ?? ''
    if (identityKey === '') return
    const scope = scopeOf(identityKey)
    if (scope === this.scope) return
    this.scope = scope
    this.recovery.remember(scope)
    const snapshot = this.recovery.load(scope)
    this.store.bookOpen = snapshot?.preferences.taskBookOpen === true
    this.world.applyRestore(snapshot)
  }

  /** 位置事实按用户写回：只有地图、格子、朝向与界面偏好四项。 */
  private saveFeet(feet: Feet): void {
    this.store.worldMap = feet.map
    this.recovery.save(this.scope, feet, { taskBookOpen: this.store.bookOpen })
  }

  /** 名册：当前地图的作者角色（名字、职责、对白通道）。界面只读展示，不改任何业务。 */
  private syncRoster(): void {
    const staff = this.world.characters.filter(c => c.role === 'staff')
    // 员工名单按作者数据累积：走到外图时仍按权威状态更新员工表现（不因为看不见就不算）。
    if (staff.length > 0) {
      this.staffIds = staff.map(c => c.id)
      for (const character of staff) this.staffLabels.set(character.id, character.label)
    }
  }

  /**
   * 权威投影 → 表现命令：全项目唯一的映射点。命令是投影的纯函数，不产生也不修改
   * 业务状态；演出缺失、重复或乱序都不会改变任务终态，只影响画面。
   */
  private refreshPerformance(): void {
    // 名册跟着前台地图走：切图后仍按同一份权威状态更新员工表现。
    this.syncRoster()
    const commands = deriveStaffCommands(this.store.task, this.staffIds)
    // 命令只下发给表现层：会话不保存第二份副本，避免出现「哪个进度为准」的歧义。
    this.world.applyPerformance(commands)
    this.store.staff = staffDialogueViews(
      this.store.task, commands,
      this.staffIds.map(id => ({ id, label: this.staffLabels.get(id) ?? id })),
    )
    // 打开着的员工名牌跟着权威状态刷新：状态文案不能停在旧的一轮上。
    const open = this.store.dialogue
    if (open !== null && open.kind === 'staff' && open.mode === 'staff') {
      const view = this.store.staff.find(entry => entry.id === open.id)
      const character = this.world.character(open.id)
      if (view !== undefined && character !== undefined) {
        this.store.dialogue = staffNameplate(character, view.stateLabel + ' · ' + view.actionLabel)
      }
    }
    this.syncPrompt()
  }

  /** 就近提示：表现层给对象与距离，权威投影给任务事实，按作者优先级只留一个。 */
  private syncPrompt(): void {
    const active = this.store.task.runState === 'running' || this.store.activeRun?.state === 'running'
      || ['queued', 'running', 'summarizing', 'waiting_user'].includes(this.store.task.state)
    this.store.prompt = resolvePrompt(this.near, {
      staffReplyPending: this.store.task.subtasks.some(subtask => subtask.state === 'waiting_user'),
      taskActive: active,
      stopping: this.store.stopRequested,
      // 每个就近触发器都写着 requires.input_open: false：任务本或对白开着时不出现提示。
      inputOpen: this.store.bookOpen || this.store.dialogue !== null,
    })
  }

  /**
   * 已经打开的对白/名牌随**表现事实**收尾（interaction_rules.yaml#selection.walk_away、
   * npc_rules.yaml#dialogue.interruption）：老板走远超过 walk_away_tiles、切到别的图、
   * 或者被搭话的角色已经离场时自动关闭。只关面板，不碰任何任务状态，也没有草稿要留。
   */
  private closeDialogueIfOutOfReach(mapChanged = false): void {
    const open = this.store.dialogue
    if (open === null) return
    if (dialogueStillInReach(this.near, open.id, mapChanged)) return
    this.store.dialogue = null
    this.flushEnvNotice()
  }

  /**
   * 用户意图：点击地图上的角色。超出就近范围只给一次轻微反馈，不打开任何输入
   * （interaction_rules.yaml#hotkey.out_of_range 的同一条规则）。
   */
  private interact(target: NearTarget): void {
    if (target.distanceTiles > INTERACT_RADIUS_TILES) {
      this.envNotice('走近一点再和' + target.label + '说话')
      this.syncPrompt()
      return
    }
    this.openTarget(target)
  }

  /**
   * 环境提示（走近一点/无可互动对象等）：任务本或对白打开时不打扰，挂起到关闭后补显；
   * 写链路错误与状态类提示不受此限（它们必须即时可见）。
   */
  private envNotice(text: string): void {
    if (this.store.bookOpen || this.store.dialogue !== null) {
      this.store.pendingNotice = text
      return
    }
    this.store.notice = text
  }

  /** 面板关闭时补显挂起的环境提示（closeBook/closeDialogue 尾部调用）。 */
  private flushEnvNotice(): void {
    if (!this.store.pendingNotice) return
    this.store.notice = this.store.pendingNotice
    this.store.pendingNotice = ''
  }

  /** 用户意图：交互键（E）或点击就近提示。有提示就执行提示动作，没有就只给一次轻微反馈。 */
  interactKey(): void {
    const prompt: Prompt | null = this.store.prompt
    if (prompt === null) {
      this.envNotice('这里没有可以互动的对象')
      return
    }
    if (prompt.action === 'hint_only') {
      // 「正在收尾」这类提示只说明状态，不提供入口（interaction_rules.yaml 的 butler_busy_hint）。
      this.envNotice(prompt.label + '：本轮正在收尾，以管家事件为准')
      return
    }
    const target = this.near.find(entry => entry.id === prompt.target)
    if (target !== undefined) this.openTarget(target)
  }

  /**
   * 按对象类型分派，职责隔离就在这一个分叉上：
   * 牛马大总管走任务本（常驻入口），业务员工只给名牌与权威状态（本切片没有独立搭话通道），
   * 普通 NPC 打开作者预写对白。三条通路都不产生任务、不调用模型或业务工具。
   */
  private openTarget(target: NearTarget): void {
    if (target.kind === 'butler') { this.openBook(); return }
    const character = this.world.character(target.id)
    if (character === undefined) return
    if (target.kind === 'staff') {
      const view = this.store.staff.find(entry => entry.id === target.id)
      this.store.dialogue = staffNameplate(character, view === undefined ? '状态未知' : view.stateLabel + ' · ' + view.actionLabel)
    } else {
      this.store.dialogue = npcDialogue(character)
    }
    // 会话视图开着的期间不再渲染就近提示（requires.input_open: false）。
    this.syncPrompt()
  }

  /** 用户意图：关闭对白面板或名牌。 */
  closeDialogue(): void {
    this.store.dialogue = null
    this.syncPrompt()
    this.flushEnvNotice()
  }

  /** 使旧会话的一切失效：取消订阅与在途请求，清空选择、任务与历史。 */
  private clearSelection(): void {
    this.generation++
    this.client.cancelObserve()
    this.store.selectedId = ''
    this.store.activeRun = null
    this.store.history = []
    this.store.task = emptyTaskView()
    this.store.stopRequested = false
    // 展示类状态一起清：对白面板/名牌属于被作废的那份任务与身份。
    this.near = []
    this.store.prompt = null
    this.store.dialogue = null
    this.refreshPerformance()
  }

  /** 身份变化或授权失效时连会话列表一并作废，不保留可能属于他人的数据。 */
  private resetForIdentityChange(): void {
    this.clearSelection()
    this.store.conversations = []
    // 旧身份的写状态与草稿一起作废：待重试的冻结提交属于上一位登录人，重试会把旧正文
    // 发到新身份下；在途提交的锁也不能留给下一位（写入口会一直禁用）；派活与回复草稿
    // 同样是上一位登录人在输入框里写的东西，同样不留给下一位。
    this.store.pendingSubmit = null
    this.store.submitting = false
    this.store.assignDraft = ''
    this.store.replyDrafts = {}
  }

  /**
   * 换会话时收干净旧上下文的写状态（旧请求释放后不写回新会话）：
   * - 待重试的冻结提交指向**别的会话**时随选择作废——它的 requestId 与正文属于那次
   *   提交的会话，留着会让「重试提交」把旧请求发进新会话的界面语境里。冻结正文仍在
   *   草稿里，用户可在新会话重新提交（那是一次新的提交，新 requestId）。
   * - 在途提交的写锁（submitting）一并解开：旧请求已经不再拥有新会话的界面状态，
   *   留着它只会让新会话的写入口一直禁用（旧请求的迟到回调按代次守卫不会碰新状态）。
   */
  private releaseWriteState(conversationId: string): void {
    this.store.submitting = false
    const pending = this.store.pendingSubmit
    if (pending !== null && pending.conversationId !== conversationId) this.store.pendingSubmit = null
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
    this.releaseWriteState(id)
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
      // 权威状态说本轮已经不在跑，界面里「正在收尾」的请求状态随之作废。
      if (run === null || run.state !== 'running') this.store.stopRequested = false
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
      // 快照落地后重算表现命令：整轮只有终态快照时，员工直接收敛到交回并回工位。
      this.refreshPerformance()
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
        // 权威投影变了就重算一次表现命令；表现层不回写，终态只由上面的投影决定。
        this.refreshPerformance()
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
        this.refreshPerformance()
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
    // 本轮已收敛：停止请求的界面状态随之作废（是否真停下由权威终态说了算）。
    if (token === this.generation) this.store.stopRequested = false
    this.refreshPerformance()
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

  /** 页面隐藏：暂停渲染并立刻落盘位置；订阅保持，回前台再按权威快照核对。 */
  onHidden(): void {
    this.world.pause()
    this.saveFeet(this.world.state)
  }

  /** 页面回前台：恢复渲染，重读任务快照并恢复订阅。 */
  onVisible(): void {
    this.world.resume()
    void this.refresh()
  }

  /** 用户意图：任务本开合。界面偏好随位置一起按用户保存；开着的时候不渲染就近提示。 */
  openBook(): void {
    this.store.bookOpen = true
    this.saveFeet(this.world.state)
    this.syncPrompt()
  }

  closeBook(): void {
    this.store.bookOpen = false
    this.saveFeet(this.world.state)
    this.syncPrompt()
    this.flushEnvNotice()
  }

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
      if (outcome.accepted && token === this.generation) {
        // 受理只是请求：界面按「正在收尾」提示，是否真停下以管家事件为准（不改任何状态）。
        this.store.stopRequested = true
        this.syncPrompt()
      }
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
    const attempt = ++this.submitAttempt
    this.store.submitting = true
    this.store.notice = ''
    // 新意图作废旧观察（只读订阅或上一次写响应的流）：先取消再等它退出，
    // 事件投影只属于这一次提交。
    this.client.cancelObserve()
    await (this.observeTask ?? Promise.resolve()).catch(() => {})
    const accepted = () => {
      // 只清自己这一次尝试的冻结提交。用户可能在这次尝试后点过「重试提交」——那是同一个
      // pending 对象的新一次尝试（同 requestId），旧的受理回调迟到时若按对象身份清掉它，
      // 重试入口会消失；用户重打正文会用新的 requestId，可能重复执行。
      // 用尝试序号而不是「现在没有在途提交」判断：更新的那次尝试也可能已经以「结果不明」
      // 收尾（那时 submitting 已是 false），冻结提交同样必须留着。
      if (attempt === this.submitAttempt && this.store.pendingSubmit === pending) this.store.pendingSubmit = null
      if (token !== this.generation) {
        // 代次已经在提交期间前进（回前台刷新、切换会话）：事件流不再属于当前投影，
        // 但这一次提交确实受理了——如果界面还停在这个会话上，只读重读一次把这一轮接回来。
        // 还有写请求在途（更新的提交尝试或停止请求）时不再重读：它的写响应流正接管同一份
        // 投影，这里再开一条只读订阅会让同一批事件进两次投影。
        if (!this.store.submitting && this.store.selectedId === pending.conversationId) void this.resyncCurrent()
        return
      }
      // 受理即解锁写入口：这一轮可以继续观察，用户也能进行下一个意图（如回复）。
      this.store.submitting = false
      // 草稿按会话归属清：提交的会话已经不是当前选择时不动草稿（那可能是新会话在写）。
      if (this.store.selectedId !== pending.conversationId) return
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
        // 管家的拒绝说明服务端状态与我们看到的不一样（换轮、已被别的入口结束、版本更新…）：
        // 只读重读一次当前任务，不用本地推测补齐，也不重发任何写请求。
        void this.resyncCurrent()
        return
      default:
        this.store.pendingSubmit = null
        this.store.notice = '提交失败：' + error.message
    }
  }

  /**
   * 只读重读当前会话的权威状态（probe/快照/历史，不重发任何写请求）：用于写请求被
   * 明确拒绝之后，以及受理回调迟到（代次已前进）而界面还停在这个会话上时——两种情形
   * 都说明本地投影可能已经和管家不一致，提示文案里说的「刷新」得有东西可读。
   * 语义与选择会话时同一套：任务身份优先用 probe 给的当前轮，退回正在展示的任务；
   * 读取全部回来即证明链路可用，收尾同样按选择会话那一套回写链路状态。
   */
  private async resyncCurrent(): Promise<void> {
    const conversationId = this.store.selectedId
    if (conversationId === '') return
    const token = this.generation
    const stale = () => token !== this.generation || this.store.selectedId !== conversationId
    try {
      const run = await this.client.probe(conversationId)
      if (stale()) return
      this.store.activeRun = run
      const taskId = run?.taskId || this.currentTaskId
      if (taskId !== '') {
        const snapshot = await this.client.taskSnapshot(taskId)
        if (stale()) return
        this.currentTaskId = taskId
        this.store.task = applySnapshot(this.store.task, snapshot, Date.now(), recoveryOf(run))
      }
      const history = await this.client.history({ conversationId, limit: 10 })
      if (stale()) return
      this.store.history = history.items
      // 这一跳的读取（probe／快照／历史）全部回来了：链路刚刚被证明可用，状态回写为
      // 可用，否则断线之后重读成功，离线徽标与「重试」入口还挂在界面上不消失。
      // 文案与选择会话同一套口径：在跑的一轮交给订阅接通时的「已连接」。
      this.store.status = 'ready'
      if (run === null || run.state !== 'running') {
        // 权威状态说这一轮已经不在跑：界面里「正在收尾」的请求状态随之作废。
        this.store.stopRequested = false
        this.store.statusDetail = run === null ? '当前没有进行中的一轮' : '本轮已结束'
      } else {
        // 这一轮在跑：链路可用的文案交给订阅接通时的「已连接」，这里不保留旧的断线提示。
        this.store.statusDetail = ''
        if (!this.client.isObserving) {
          // 提交前的订阅已经被取消、谁也没接回来：只读订阅从 0 重放当前轮。
          this.observe(conversationId, 0, token)
        }
      }
      this.refreshPerformance()
    } catch (error) {
      if (!stale()) this.report(error)
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
