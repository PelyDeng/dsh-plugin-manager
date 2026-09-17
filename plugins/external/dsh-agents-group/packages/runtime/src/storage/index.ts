/**
 * 私有侧存储门面：把**本地同步围栏面**与 **PG 异步面**组合成一个完整的
 * {@link AgentDatabasePort}。
 *
 * ## 组合关系（为什么必须这样切）
 *
 * | 能力 | 落在哪 | 原因 |
 * | --- | --- | --- |
 * | `record` / `mark` | **本地 SQLite**（`local.ts`） | kit 契约要求**同步**，PG 做不到 |
 * | `conversationOf` / `create` / `publish` / `list` / `syncTitle` / `pin` | PG | 权威数据在 PG，多实例共享 |
 * | `managed` | adapter（`adapter.ts`） | 它要用 kit 的 `conversationRemover`，那是全仓唯一接触点 |
 * | `busy(id)` | 进程内镜像（注入） | **同步布尔**：做成 PG 查询会返回 `Promise`（恒真）⇒ 移除永远 409 |
 *
 * ## 启动顺序**不可交换**
 *
 * ```
 * ① 排空 outbox   —— 把本地未补写的围栏 / 标题变更按「每会话 FIFO」写进 PG
 * ② PG 侧清理     —— 本 Agent 遗留的 pending → failed
 * ③ 按 PG 收敛本地 —— 镜像与围栏状态跟着 PG 走（但**不抹掉**本地仍是 pending 的行）
 * ```
 *
 * 顺序反了会发生什么：先按 PG 收敛，本地那条"刚标记 pending、还没来得及补写"的行会被 PG 里
 * 的**空状态**覆盖 ⇒ 围栏失效（会话重新可见、可发消息），而宿主可能已经 `archiveSession`
 * ⇒ **幽灵会话**。所以①必须在③之前，且③遇到"本地 pending、PG 却不是 removed"时保留本地
 * 的 pending（见 `LocalFenceStore.mirrorUpsert` 的 `keepPending`）。
 *
 * ②在①之后：①刚把本地 pending 补成 PG pending，②正好把它们翻成 failed——这就是
 * "**本地遗留的 pending 升格为 PG pending**，再由 PG 的清理规则收尾"，而不是被抹掉。
 *
 * ## 排空有**两个**调用点，不是只有启动
 *
 * `mark` 与 `titleSink().submit` 都是**同步契约**（kit 的 `conversationRemover` 同步调它们），
 * 因此它们只能写本地 SQLite；而侧栏 `list` 读的是 PG。若"排空"只在 `open()` 里发生一次，
 * 这两个同步面在本进程内就**永远不会**到达 PG，表现是：移除接口返回 200 而那行还在侧栏
 * （点开 404）、官方标题一直不落库（页面标题刷新空转到超时）。所以同步写之后一律
 * {@link AgentDatabaseFacade.scheduleDrain} 一次，`close()` 之前再等待最后一次。
 */
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import type { TitleSink } from '../conversation.ts'
import { LocalFenceStore, type MirrorRow, type OutboxDepth } from './local.ts'
import { PostgresAgentDatabase, RUNTIME_SCHEMA_VERSION, toTitleSource } from './postgres.ts'
import type {
  AgentDatabasePort,
  ConversationPageShape,
  ConversationPayloadShape,
  ConversationPort,
  ConversationProviderShape,
  ConversationQueryShape,
  ConversationRecordShape,
  OwnerKey,
  TurnStorePort,
} from './ports.ts'

/** 侧栏入口的工厂；由 adapter 在插件挂载时装上（它需要 kit 的 `conversationRemover`）。 */
export type ManagedProviderFactory = (owner: OwnerKey) => ConversationProviderShape

/** 同步 `busy` 的判据：本实例正在跑的会话 + 宿主侧正在跑的会话。 */
export type BusyProbe = (conversationId: string) => boolean

export interface CreateAgentDatabaseInput {
  /** PG 连接串；凭据不写进代码。 */
  readonly dsn: string
  /** 本 Agent 的 id（`dsh_conversations.agent_id` 的取值，也是会话前缀的来源）。 */
  readonly agentId: string
  /** 本地围栏库路径（`:memory:` 用于测试）。 */
  readonly localPath: string
  /** 业务表结构版本；与自己那一行版本**严格相等**。 */
  readonly agentVersion?: number
  /** 插件内联的运行时版本；与 `runtime` 那一行做 **≥** 比较。 */
  readonly runtimeVersion?: number
  readonly onError?: (error: Error) => void
}

/** outbox 的积压状况；健康探针据此把本 Agent 标为 degraded。 */
export interface StorageHealth {
  readonly fence: OutboxDepth
  readonly title: OutboxDepth
  readonly mirrorSize: number
}

/**
 * 后台排空的延迟。**不能为 0**（`setTimeout(…, 0)` 会在当前宏任务之后立刻跑，等于把一次 PG
 * 往返塞回请求路径上）；也不能太大，否则"删了但侧栏还在"会持续到用户第二次操作才消失。
 */
const DRAIN_DELAY_MS = 25

export class AgentDatabaseFacade implements AgentDatabasePort {
  private readonly pg: PostgresAgentDatabase
  private readonly conversationsPort: ConversationPort
  private managedFactory: ManagedProviderFactory | undefined
  private busyProbe: BusyProbe = () => false
  private opened = false
  /** 正在跑的那一次排空（**单飞**：并发的触发只置 `drainAgain`，不再开第二条）。 */
  private draining: Promise<void> | undefined
  /** 排空途中又来了新条目（或 `close()` 要求最后一次），跑完当前轮再跑一轮。 */
  private drainAgain = false
  private drainTimer: ReturnType<typeof setTimeout> | undefined
  /** 关停中：不再接受新的排空触发（`close()` 自己会在最后 await 一次）。 */
  private closing = false
  /** 已 `close()`；后台排空据此收尾（它可能在 close 的 await 之间被唤醒）。 */
  private closed = false
  /**
   * ⚠️ 这两个字段**不能**写成构造函数的参数属性（`constructor(private readonly input: …)`）：
   * 参数属性是 TS 的代码生成语法，`node --test` 的 strip-only 类型剥离会以
   * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 拒绝整个模块——而本文件在
   * `packages/runtime/src/index.ts` 的导出链上，blog 的整套 `.mjs` 用例都从那里 import
   * ⇒ 一处参数属性让它们**整个文件加载失败**（表现为"套件变小"，不是某条红）。
   */
  private readonly input: CreateAgentDatabaseInput
  private readonly local: LocalFenceStore

  constructor(
    input: CreateAgentDatabaseInput,
    local: LocalFenceStore,
  ) {
    this.input = input
    this.local = local
    this.pg = new PostgresAgentDatabase(
      input.dsn,
      input.agentId,
      input.agentVersion ?? 1,
      input.runtimeVersion ?? RUNTIME_SCHEMA_VERSION,
      input.onError,
    )
    this.conversationsPort = this.composeConversations()
  }

  get conversations(): ConversationPort { return this.conversationsPort }
  get turns(): TurnStorePort { return this.pg.turns }

  /** 装上侧栏入口的实现（adapter 调用）。 */
  installManagedProvider(factory: ManagedProviderFactory, busy: BusyProbe): void {
    this.managedFactory = factory
    this.busyProbe = busy
  }

  /**
   * 启动序列：**顺序不可交换**（见文件头）。
   *
   * 三步都在 `assertSchema()` 之后——结构没核验过就写数据，等于在不确定的表上做不可逆的事。
   */
  async open(): Promise<void> {
    if (this.opened) return
    await this.pg.assertSchema()
    const drained = await this.drainOutboxes()
    const failed = await this.pg.turns.failStalePending()
    await this.reconcileMirror()
    this.opened = true
    if (drained.fence > 0 || drained.title > 0 || failed > 0) {
      console.log(`agents-group/runtime(${this.input.agentId}): 启动收敛——补写围栏 ${drained.fence} 条、标题 ${drained.title} 条，PG 侧翻转 pending→failed ${failed} 条`)
    }
  }

  /** 只核验不建表；由 `open()` 调用，也可单独用于探针。 */
  async assertSchema(): Promise<void> {
    await this.pg.assertSchema()
  }

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    return this.pg.query<T>(sql, values)
  }

  async transaction<T>(fn: (tx: AgentDatabasePort) => Promise<T>): Promise<T> {
    return this.pg.transaction(fn)
  }

  /** 本地围栏库的积压与规模（健康探针用）。 */
  health(): StorageHealth {
    const depth = this.local.depth()
    return { fence: depth.fence, title: depth.title, mirrorSize: this.local.mirrorAll().length }
  }

  /**
   * 标题投递口：`registerConversationTitles` 的**同步回调**只能走到这里。
   *
   * 它只写本地 outbox（同步、原子），后台再补写 PG。内存队列会在崩溃或插件卸载时丢标题，
   * 所以必须是持久的。
   *
   * ⚠️ 写完**必须**触发一次后台排空（{@link scheduleDrain}）：只写本地队列而不排空，
   * 官方标题在本次进程内永远进不了 PG——而 `list` 读的是 PG，于是页面标题刷新一直空转到超时。
   */
  titleSink(): TitleSink {
    return {
      submit: (agentId, conversationId, title, source) => {
        if (agentId !== this.input.agentId) return
        try {
          this.local.titleSubmit(conversationId, title, source)
        } catch (error) {
          // 同步回调里不能抛给宿主的事件分发：投递失败记一条日志，主链路继续。
          console.error(`agents-group/runtime(${this.input.agentId}): 标题投递失败`, error)
          return
        }
        this.scheduleDrain()
      },
    }
  }

  /**
   * 关闭：**先把 outbox 排空再关连接**。
   *
   * 反过来的话，`mark` / `titleSink` 刚写进本地队列的条目会随着池关闭而永远补不上——
   * 本地队列是持久的，下一次 `open()` 还能补，但那要等到下一次进程启动，而这一次进程里
   * 用户看到的仍是"删了还在、标题没变"。
   *
   * 排空失败**不抛**：关停期间抛错会让调用方的释放链断在半路（PG 池与本地句柄都不关）。
   * 失败的那一刻队列里还留着条目，下次 `open()` 会重试。
   */
  async close(): Promise<void> {
    this.closing = true
    if (this.drainTimer !== undefined) { clearTimeout(this.drainTimer); this.drainTimer = undefined }
    try {
      await this.drainOutboxes()
    } catch (error) {
      this.reportDrainFailure(error)
    }
    await this.draining?.catch(() => { /* 失败已在 drainOnce 里报过 */ })
    await this.pg.close()
    this.local.close()
    this.closed = true
  }

  // ---------------------------------------------------------------------
  // 组合
  // ---------------------------------------------------------------------

  private composeConversations(): ConversationPort {
    const { pg, local, input } = this
    const agentId = input.agentId

    /** 把 PG 的一行投影成本地镜像行。 */
    const mirrorOf = (record: ConversationRecordShape, owner: OwnerKey): MirrorRow => ({
      id: record.id,
      agentId,
      ownerNamespace: owner.namespace,
      ownerId: owner.userId,
      title: record.title,
      titleSource: 'automatic',
      ready: record.ready,
      pinned: false,
      removalState: record.removalState,
      deletedAt: record.deletedAt,
      updatedAt: record.updatedAt,
      // 载荷也要进镜像：`record` 是同步读，业务侧有同步消费者靠它（blog 的
      // `inheritedRequests`）。漏了这一项，重启后收敛完成之前那个同步读会拿到空对象。
      payload: record.payload ?? {},
    })

    return {
      agentId,

      conversationOf: (owner, conversationId) => pg.conversations.conversationOf(owner, conversationId),

      /**
       * 单条业务读：走 PG，**不碰本地镜像**。
       *
       * 刻意不写镜像：这是**读**路径，而 `mirrorUpsert` 会覆盖围栏状态（它只在启动收敛时带
       * `keepPending`）。让一次"读会话详情"有机会把本地仍是 `pending` 的围栏抹成 PG 里的空串，
       * 就是"围栏失效而宿主可能已经归档"那个幽灵会话缺陷——读路径不该有这种副作用。
       * 镜像的更新点保持为：`create` / `publish` / `patchPayload` / `syncTitle` / `touch` / `pin`
       * / `mark` 与启动收敛。
       */
      detail: (owner, conversationId) => pg.conversations.detail(owner, conversationId),

      create: async (owner, conversationId, requestId, initial) => {
        const record = await pg.conversations.create(owner, conversationId, requestId, initial)
        // 预留段也要进镜像：`record` 是同步读，它得能回答"这个会话存在"。
        local.mirrorUpsert(mirrorOf(record, owner))
        return record
      },

      /**
       * 合并写业务载荷：与 `syncTitle` / `touch` / `pin` 同一条路子——**先写 PG，PG 成功后再
       * 更新本地镜像**。
       *
       * ⚠️ 进镜像的必须是 **PG 返回的合并结果**，不是这里的 `patch`：`payload || $1` 是浅合并，
       * 只拿 `patch` 覆盖镜像会把没提到的键**抹掉**（镜像里的载荷是整层，不是一个补丁），
       * 于是同步 `record` 会在"这次只改了一个字段"之后丢掉其余字段。
       *
       * 这一行不存在或不属于本 owner 时**由 PG 抛 404**，镜像不动：镜像只装"本实例见过的行"，
       * 凭空改一行等于伪造一次归属。
       */
      patchPayload: async (owner, conversationId, patch) => {
        const merged = await pg.conversations.patchPayload(owner, conversationId, patch)
        const row = local.mirrorGet(conversationId)
        if (row !== undefined) {
          local.mirrorUpsert({ ...row, payload: merged, updatedAt: Date.now() })
        }
        return merged
      },

      publish: async (owner, conversationId) => {
        await pg.conversations.publish(owner, conversationId)
        const row = local.mirrorGet(conversationId)
        // 发布之后这个会话才在侧栏可见、才能被发送：本地镜像要立刻跟上，否则 `record` 还会
        // 说它 `ready = false`，而 kit 的移除围栏会因此拒绝一次本该成功的移除。
        if (row !== undefined) {
          local.mirrorUpsert({ ...row, ready: true, updatedAt: Date.now() })
        }
      },

      missionRequestId: (owner, missionId) => pg.conversations.missionRequestId(owner, missionId),

      list: (owner, query, scope) => pg.conversations.list(owner, query, scope),

      managed: (owner) => {
        const factory = this.managedFactory
        if (factory === undefined) {
          // 装配错误要在调用时立刻暴露，而不是给一个静默返回空列表的实现。
          throw new AccessError(503, '会话管理入口尚未装配（adapter 未安装）')
        }
        return factory(owner)
      },

      syncTitle: async (owner, conversationId, title, source) => {
        await pg.conversations.syncTitle(owner, conversationId, title, source)
        const row = local.mirrorGet(conversationId)
        if (row !== undefined) {
          // 只有真的写进去了才更新镜像：PG 那条 UPDATE 自带"自动标题不覆盖手动标题"的守卫，
          // 无条件改本地会让镜像显示一个 PG 里并不存在的标题。
          const canWrite = source === 'manual' || row.titleSource === 'automatic'
          if (canWrite) local.mirrorUpsert({ ...row, title, titleSource: source, updatedAt: Date.now() })
        }
      },

      /**
       * 推进 `updated_at`：与 `syncTitle` / `pin` 同一条路子——**先写 PG，PG 成功后再更新本地
       * 镜像**。镜像那一列是 `record`（同步读）的回答来源之一，不一致只在"重启后镜像收敛"之前
       * 可见，但那段时间里侧栏与围栏读的就是它。
       *
       * ⚠️ 写进镜像的时刻必须是**PG 实际落下的那个值**（`GREATEST(updated_at, at)` 的结果），
       * 不是这里的 `at`：`at` 更早时 PG 会保留原来的值，而按 `at` 改镜像等于显示一个 PG 里
       * 并不存在的时刻。差一个最大值，就是"本地比 PG 新"这类只在同一实例里显现的漂移。
       */
      touch: async (owner, conversationId, at) => {
        const value = at ?? Date.now()
        await pg.conversations.touch(owner, conversationId, value)
        const row = local.mirrorGet(conversationId)
        if (row !== undefined && value > row.updatedAt) {
          local.mirrorUpsert({ ...row, updatedAt: value })
        }
      },

      /**
       * 置顶：与 `syncTitle` 同一条路子——**先写 PG，PG 成功后再更新本地镜像**。
       *
       * 镜像里只有"本实例见过的行"（`create` / `publish` / 启动收敛写进去的），所以先问
       * `mirrorGet`；没有这一行就不必凭空造一行——`record` 的回答靠镜像，而造一行等于伪造
       * 一次"我见过这个会话"。归属与存在性由 PG 那条 `UPDATE` 的 owner 条件保证。
       */
      pin: async (owner, conversationId, pinned) => {
        await pg.conversations.pin(owner, conversationId, pinned)
        const row = local.mirrorGet(conversationId)
        if (row !== undefined) local.mirrorUpsert({ ...row, pinned, updatedAt: Date.now() })
      },

      // —— 三个同步面（kit 契约的硬要求）——
      record: (actor, conversationId) => local.record(actor, conversationId),
      // 无归属判定的镜像读：官方标题事件是同步回调、只带会话 id，而"要不要广播 changed"必须
      // 同步判定（详见 `ConversationPort.fenceOf` 的说明）。
      fenceOf: conversationId => local.fenceOf(conversationId),
      /**
       * ⚠️ `mark` 的**同步契约**必须保持：kit 的 `conversationRemover` 在 `:141/:149` 同步调用它，
       * 返回 `Promise` 会让那边的分支判定失效（`ports.ts` 顶上写了这条）。
       *
       * 但"同步写本地"只解决了围栏的**当前进程内**有效性：PG 那一侧（侧栏 `list` 读的正是它）
       * 要有人补写。补写就是后面这一次**后台排空**——不触发的话，移除接口返回 200 而
       * `dsh_conversations` 里那行还在，侧栏照样列出它、点进去 404。
       */
      mark: (actor, conversationId, state) => {
        local.mark(actor, conversationId, state)
        this.scheduleDrain()
      },
    }
  }

  // ---------------------------------------------------------------------
  // 后台排空（单飞 + 合并触发）
  // ---------------------------------------------------------------------

  /**
   * 安排一次后台排空。
   *
   * 三条约束，都是"运行期没有任何排空点"这个缺陷的直接后果：
   *
   * - **触发点只有 `mark` / `titleSink().submit` 这两处**（它们都是同步回调，改不成 async）；
   * - **合并多次触发**：一次移除会连续 `mark('pending')`、`mark('removed')`，标题也可能连发几条
   *   ——每条各开一次排空等于把两次 PG 往返变成四次的排队；
   * - **单飞**：同一时刻只允许一条排空链，否则两次并发排空会各自读到同一批待补写条目、
   *   各自补写一遍（幂等 UPDATE 无害，但每条会多做一次往返）。
   *
   * 失败**只告警**：它跑在后台，没有人 await 它，抛出去就是 unhandledRejection（宿主级错误）。
   * 队列里的条目失败时不会被 ack，所以下次触发或下次启动还会重试。
   */
  private scheduleDrain(): void {
    if (this.closing) return
    this.drainAgain = true
    if (this.draining !== undefined || this.drainTimer !== undefined) return
    const timer = setTimeout(() => {
      this.drainTimer = undefined
      void this.drainOnce()
    }, DRAIN_DELAY_MS)
    // 定时器不能拖住进程退出：它只是一个"稍后补写"的调度，进程退出时队列是持久的。
    timer.unref?.()
    this.drainTimer = timer
  }

  /** 跑排空链，直到没有新的触发；单飞，重复触发合并进当前这一条。 */
  private drainOnce(): Promise<void> {
    this.draining ??= (async () => {
      try {
        while (this.drainAgain && !this.closed) {
          this.drainAgain = false
          try {
            await this.drainOutboxes()
          } catch (error) {
            // 一条条目失败 ⇒ 整批停在这里（顺序不能跳过，见 `drainOutboxes` 的说明），
            // 记一条告警后结束本轮，等下一次触发或下次启动重试。
            this.reportDrainFailure(error)
            return
          }
        }
      } finally {
        this.draining = undefined
      }
    })()
    return this.draining
  }

  private reportDrainFailure(error: unknown): void {
    console.error(`agents-group/runtime(${this.input.agentId}): 后台补写 outbox 失败（条目保留，稍后重试）`, error)
  }

  // ---------------------------------------------------------------------
  // 启动收敛
  // ---------------------------------------------------------------------

  /**
   * ① 排空 outbox：按**每会话 FIFO** 补写。
   *
   * 两个调用点，缺任何一个都会静默失效：
   *
   * - **启动时一次**（`open()` 的第一件事）——补上一次进程留下的残留；
   * - **运行期后台**（{@link scheduleDrain} → {@link drainOnce}）——`mark` 与 `titleSink().submit`
   *   是同步回调，只能写本地队列，PG 那一侧全靠这里补。此前唯一调用点是 `open()`，于是
   *   "移除返回 200 但侧栏那行还在"、"官方标题在本次进程内永不落 PG"两件事都真实发生过。
   *
   * 每会话 FIFO 而不是全局：同一会话上 `pending → removed` 必须按序（反了会让会话永久删不掉
   * 也打不开）；跨会话之间没有顺序要求，按全局顺序取反而会被一个卡住的会话拖住全部。
   */
  private async drainOutboxes(): Promise<{ fence: number; title: number }> {
    let fence = 0
    let title = 0
    // ⚠️ 循环的终止条件只能是"批次为空"。`fencePending` 按**每会话只取最老一条**，所以非空
    // 批次的长度**天然可能小于 limit**（一个会话排队两条时，第一批就只有一条）。用
    // `batch.length < limit` 当完成判据会**提前退出**，把同一会话后面的条目留在队列里——
    // 实测后果：`pending → removed` 只补了 pending，紧接着的 PG 清理把刚落下的 pending 翻成
    // `failed`，最终状态与"按序补完"完全不同（本该是 `removed`）。
    for (;;) {
      const batch = this.local.fencePending(100)
      if (batch.length === 0) break
      for (const entry of batch) {
        await this.pg.query(
          `UPDATE dsh_conversations
              SET removal_state = $1,
                  deleted_at = CASE WHEN $1 = 'removed' THEN COALESCE(deleted_at, $2) ELSE deleted_at END,
                  updated_at = $2
            WHERE id = $3 AND agent_id = $4`,
          [entry.state, Date.now(), entry.conversationId, this.input.agentId],
        )
        this.local.fenceAck(entry.seq)
        fence += 1
      }
    }
    for (;;) {
      const batch = this.local.titlePending(100)
      if (batch.length === 0) break
      for (const entry of batch) {
        /**
         * 补写走与前台同一条路径（它自带"自动标题不覆盖手动标题"的守卫）。
         *
         * ⚠️ **这份守卫是前台那条 SQL 的拷贝，两处必须逐字同形**——判据也一样：
         * `ready` 只约束自动 / 生成标题，**人工改名在未发布会话上也要写得进去**（blog 的改名走
         * `ChatStore.syncTitle → titleSink → 本队列`，而页面自 `e78e285` 起看得见未发布会话）。
         * 围栏两道（`deleted_at` / `removal_state`）不放宽。
         * 详见 `postgres.ts` 的 `syncTitle` 注释。
         */
        await this.pg.query(
          `UPDATE dsh_conversations SET title = $1, title_source = $2
            WHERE id = $3 AND agent_id = $4 AND deleted_at IS NULL AND removal_state = ''
              AND (ready = TRUE OR $2 = 'manual')
              AND (title_source = 'automatic' OR $2 = 'manual')`,
          [entry.title, entry.source, entry.conversationId, this.input.agentId],
        )
        this.local.titleAck(entry.seq)
        title += 1
      }
    }
    return { fence, title }
  }

  /**
   * ③ 按 PG 收敛本地镜像。
   *
   * 两个方向都要做：
   * - PG 有的行 → 写进本地（`keepPending = true`：**不抹掉**本地仍是 pending 的围栏）；
   * - 本地有、PG 没有的行 → 从本地删掉（PG 已经不认它了）。
   *
   * 为什么是**全量**而不是只收敛"本地已有的"：PG 里可能出现本地从来没有过的行（别的实例建的，
   * 或多实例部署下另一台写的），而 `record` 必须能同步回答它们——否则那些会话在侧栏点不动。
   * 单 Agent 的会话规模是几百到几千条，全量读一次的成本可接受。
   */
  private async reconcileMirror(): Promise<void> {
    const rows = await this.pg.query<{
      id: string; ownerNamespace: string; ownerId: string; title: string; titleSource: string
      ready: boolean; pinned: boolean; removalState: string; deletedAt: string | number | null
      updatedAt: string | number; payload: ConversationPayloadShape
    }>(
      `SELECT id, owner_namespace AS "ownerNamespace", owner_id AS "ownerId", title,
              title_source AS "titleSource", ready, pinned, removal_state AS "removalState",
              deleted_at AS "deletedAt", updated_at AS "updatedAt", payload
         FROM dsh_conversations WHERE agent_id = $1`,
      [this.input.agentId],
    )
    const keep = new Set<string>()
    // ⚠️ `keepPending` **只在"这个会话在 outbox 里还有未补写的条目"时为真**：
    //
    // - outbox 已排空（① 成功）⇒ 本地那个 pending 早就进了 PG，本地就该**无条件跟 PG 走**
    //   （常见结果是 PG 的清理已把它翻成 `failed`）；
    // - outbox 还有条目（① 没跑完，例如 PG 不可达）⇒ 本地那份比 PG 新，**不能抹掉**。
    //
    // 两个极端都错过一遍：无条件保留会让本地永远停在 `pending`（重启也修不回来）；
    // 无条件覆盖会在崩溃窗口里把围栏抹成空，而宿主可能已经归档 ⇒ 幽灵会话。
    const stillQueued = this.local.fencePendingConversations()
    for (const row of rows) {
      keep.add(row.id)
      this.local.mirrorUpsert({
        id: row.id,
        agentId: this.input.agentId,
        ownerNamespace: row.ownerNamespace,
        ownerId: row.ownerId,
        title: row.title,
        titleSource: toTitleSource(row.titleSource),
        ready: row.ready === true,
        pinned: row.pinned === true,
        removalState: row.removalState,
        deletedAt: row.deletedAt === null ? null : Number(row.deletedAt),
        updatedAt: Number(row.updatedAt),
        // 收敛是**全量**的：本地从来没有过的行也要连载荷一起装进来，否则 `record` 会为它
        // 回答一个空载荷（业务字段丢失，而围栏字段却是对的——最难查的那种半对）。
        payload: row.payload ?? {},
      }, stillQueued.has(row.id))
    }
    for (const stale of this.local.mirrorStale(keep)) this.local.mirrorRemove(stale)
  }
}

/**
 * 造一个私有侧存储门面。
 *
 * ⚠️ 它**只建连接与本地库，不做结构核验**——要显式调 `open()`（或 `assertSchema()`）。
 * 这样调用方可以先决定"核验失败时是否还要起服务"（本项目一贯是"未就绪即不服务"）。
 */
export function createAgentDatabase(input: CreateAgentDatabaseInput): AgentDatabaseFacade {
  const local = new LocalFenceStore(input.agentId, input.localPath)
  return new AgentDatabaseFacade(input, local)
}

export { LocalFenceStore } from './local.ts'
export { RUNTIME_SCHEMA_VERSION, PostgresAgentDatabase, uniqueViolation } from './postgres.ts'
export { StorageError, mapStorageError, storageCodeOf } from './errors.ts'
export type { StorageErrorCode } from './errors.ts'
