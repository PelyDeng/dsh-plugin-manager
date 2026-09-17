/**
 * 内存版存储端口 —— 运行时的**非持久实现**（不是 P2 的权威实现）。
 *
 * 本文件两个类：{@link MemoryConversationPort}（会话索引）与 {@link MemoryTurnStore}（轮次与结果）。
 * 用途：给"还没有（或不该有）存储后端"的装配与测试一个可用的 `ConversationPort` / `TurnStorePort`。
 * 本轮把 `ConversationPort` 从 `tests/fixtures/` **提升进运行时**，理由是**跨包**：blog 的 24 个测试
 * 文件 / 192 条用例原本跑在 SQLite `:memory:` 上，索引库切到 PG 端口之后它们会**失去后端**，而
 * `storage/local.ts` 是"移除围栏的本地镜像 + outbox"、**不是**可用的内存端口实现；跨包 import 另一个
 * 包的测试夹具不可行。（`tests/fixtures/memory-conversation-port.ts` 现在只是转发到本文件，保住既有
 * import 路径。）
 *
 * ⚠️ 它**不是**"存储已经实现"的证据 —— 它连持久化都没有。**不要**拿它推断真实实现的时序或并发行为。
 *
 * ## 它**不具备**的语义（逐条都是真实实现有、本实现没有的）
 *
 * | 能力 | 真实实现 | 本实现 |
 * | --- | --- | --- |
 * | 持久 outbox | 标记与 `fence_outbox` / `title_outbox` 在同一个本地事务里落盘，后台按每会话 FIFO 补写 PG | **无**：`mark` 只改内存，进程结束即丢 |
 * | 崩溃窗口内的真值方向 | "pending 窗口内本地权威"：死在"写标记"与"补写 PG"之间时本地仍留 `pending`，启动时把它升格进 PG | **无**：没有崩溃窗口这回事，也谈不上哪一侧权威 |
 * | 跨进程 / 多实例 | PG 行 + 部分唯一索引，互斥与可见性由 PG 保证 | **无**：一个进程内的一张 `Map`，两个实例互不可见 |
 * | 启动收敛 | 先排空 outbox、再按 PG 收敛、镜像与 PG 对账 | **无** |
 * | 真正的异步往返 | `create` / `publish` / `list` / `syncTitle` 都是 PG 往返 | 方法签名是 `async`，内部**同步**完成：**不要据此推断真实实现的时序**（真实实现在 await 之间可能被并发插入） |
 * | `updated_at` 的来源 | 建会话、发布、受理一条用户消息（`touch`）、置顶分别维护 | 同样四个路径都推进；`touch` 的**单调不减**语义与真实实现的 `GREATEST` 等价（`Math.max`） |
 * | 宿主忙碌集合 | 调用方把 `hostBusyConversationIds(ctx)` 合进 `scope.busy` 后再传进来 | 完全依赖调用方传入的 `scope`；它自己看不到宿主 |
 * | 业务表 / 事务 / 健康探针 | `query()` / `transaction()` / outbox 积压深度 | **无** |
 *
 * 上表只列**真实差异**。P1 时期这里还记过两条"替身与现版实现故意不一致"的地方（`create` 收到
 * `{ title: '' }` 被记成 `manual`、`list` 不过滤 `ready = false`）——两处真实现都已修正
 * （D4 与 P2 的 `ready = TRUE`），差异消失，替身与真实现现在按同一口径工作。
 *
 * ## 与真实实现**逐条对齐**的部分（对齐是刻意的，不是巧合）
 *
 * - `create` 是**预留段**（插入 `ready = false`）；`requestId` 非空时按 `(agent, owner, requestId)`
 *   幂等，同一个 `requestId` 再来一次返回原来那一行，不新建（真实实现靠部分唯一索引）；
 * - `publish` 把 `ready` 翻真并推进 `updated_at`；
 * - `record` / `mark` 是**同步**的（kit 契约的硬要求，见 `ports.ts` 的说明），且只回答
 *   "存在 / 归属 / `ready` / 围栏状态"：未知、他人、别的 Agent 一律**同一个 404**，不泄露存在性
 *   （与 `closedoff/src/conversation-store.ts:63`、`storage/local.ts:142` 同一套判定）；
 *   `mark('removed')` 在 `deletedAt` 为空时才补（重复标记不刷新删除时刻）；
 * - `list` 的 5 态 state 机（`pending` / `failed` / `busy` / `legacy` / `ready`）、`busy` 与
 *   `archived` 两道过滤、`canRemove` 与 `blockedReason`；
 * - `syncTitle` 的"自动标题不覆盖手动标题"（`title_source = 'automatic'` 或本次来源是 `manual`
 *   才写，且要求已发布、未删除、无围栏标记）；
 * - `touch` 推进 `updated_at`（**单调不减**），**不**要求已发布、未删除、无围栏标记——真实实现
 *   那条 `UPDATE` 同样只有 owner 条件，且用 `GREATEST` 保证不倒退；
 * - `list` 的 `titleOnly`：为真时只匹配标题，否则"标题 OR id"（真实实现是 `strpos(lower(...))`）；
 * - `pin` 只改置顶标记并推进 `updated_at`（列表排序是 `pinned DESC, updated_at DESC, id`），
 *   **不**要求已发布、未删除、无围栏标记——真实实现那条 `UPDATE` 同样只有 owner 条件；
 * - `missionRequestId` 是 `(agentId, owner, missionId)` 的**纯函数**：含 `agentId`，避免跨 Agent
 *   撞键；同一输入恒等，且不读任何可变状态。
 */
import { randomUUID } from 'node:crypto'
import { AccessError, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type {
  AppendTurnResultInput,
  ConversationDetailShape,
  ConversationFenceShape,
  ConversationOwner,
  ConversationPageShape,
  ConversationPort,
  ConversationProviderShape,
  ConversationQueryShape,
  ConversationPreviewShape,
  ConversationRecordShape,
  ManagedConversationShape,
  OwnerKey,
  RemovalResultShape,
  ConversationPayloadShape,
  TurnRecord,
  TurnResultRecord,
  TurnStorePort,
} from './ports.ts'

/** 围栏状态。空串表示没有围栏（真实实现里是 `removal_state` 列）。 */
type RemovalState = '' | 'pending' | 'failed' | 'removed'

/** 标题来源；决定它能不能被后续标题覆盖。 */
type TitleSource = 'automatic' | 'generated' | 'manual'

/** 一行会话索引的内存形状（对应真实实现里的 `conversation_mirror` 行）。 */
interface MemoryRow {
  readonly id: string
  readonly owner: OwnerKey
  title: string
  titleSource: TitleSource
  readonly requestId: string
  readonly createdAt: number
  updatedAt: number
  ready: boolean
  pinned: boolean
  deletedAt: number | null
  removalState: RemovalState
  /** 业务载荷（真实实现里是 `dsh_conversations.payload`）。 */
  payload: ConversationPayloadShape
}

/** busy 项的阻止理由：与 kit（`conversations.ts:86`）和 P2 的 PG 实现逐字相同。 */
const BUSY_REASON = '会话正在运行或有未完成操作，请先处理或等待完成'

/** pending 项的阻止理由：与 P2 的 PG 实现逐字相同（kit 的 SQLite 版只给 busy 一条）。 */
const PENDING_REASON = '上一次移除还没完成，请稍后重试'

function ownerKey(owner: OwnerKey): string {
  return `${owner.namespace}\u0000${owner.userId}`
}

function sameOwner(left: OwnerKey, right: { namespace: string; userId: string }): boolean {
  return left.namespace === right.namespace && left.userId === right.userId
}

/**
 * 内存版会话端口。
 *
 * 一个实例代表**一个 Agent**（`agentId` 参与 `missionRequestId` 的派生，也参与归属判定：
 * 别的 Agent 的行在这个实例里根本不存在，所以读它就是 404）。
 */
export class MemoryConversationPort implements ConversationPort {
  readonly agentId: string
  /** 会话 id → 行。真实实现是 `dsh_conversations`。 */
  private readonly rows = new Map<string, MemoryRow>()
  /** `owner + requestId` → 会话 id：创建幂等（真实实现是部分唯一索引）。 */
  private readonly requestIds = new Map<string, string>()
  /** 宿主归档清单的替身：只有 `setArchived` 与 `seedLegacy` 会碰它。 */
  private readonly archived = new Set<string>()
  /** 每一次 `touch` 收到的时刻与落下的值（断言"`followup` 真的推进了 `updated_at`"用）。 */
  private readonly touchCalls: { readonly id: string; readonly at: number; readonly updatedAt: number }[] = []

  constructor(agentId: string) {
    this.agentId = agentId
  }

  // ---------------------------------------------------------------------
  // ConversationPort
  // ---------------------------------------------------------------------

  /** 会话归属——授权判据。不存在或不属于该 owner 时返回 `undefined`（**不抛错**）。 */
  async conversationOf(owner: OwnerKey, conversationId: string): Promise<ConversationOwner | undefined> {
    const row = this.rows.get(conversationId)
    if (row === undefined || !sameOwner(row.owner, owner)) return undefined
    return { conversationId: row.id, agentId: this.agentId, owner: { ...row.owner } }
  }

  /**
   * 按 id 读**一整行**（含 `titleSource` / `pinned` / `createdAt` / `requestId`）。
   *
   * 不存在或不属于该 owner ⇒ `undefined`（与真实实现的 owner 条件同一条口径：别人的行在这个
   * 实例里根本读不到）。
   */
  async detail(owner: OwnerKey, conversationId: string): Promise<ConversationDetailShape | undefined> {
    const row = this.rows.get(conversationId)
    if (row === undefined || !sameOwner(row.owner, owner)) return undefined
    return {
      ...this.shapeOf(row),
      titleSource: row.titleSource,
      pinned: row.pinned,
      createdAt: row.createdAt,
      requestId: row.requestId,
    }
  }

  /**
   * **预留段**：插入一行归属，`ready = false`——会话此时不可见、也不能发消息。
   *
   * `requestId` 非空时幂等：同一个 `(agent, owner, requestId)` 再来一次返回原来那一行
   * （真实实现靠部分唯一索引 + `SELECT` 回既有行，见 `postgres.ts:96-119`）。
   */
  async create(owner: OwnerKey, conversationId: string, requestId: string,
    initial?: {
      readonly title?: string
      readonly payload?: ConversationPayloadShape
      readonly titleSource?: TitleSource
    }): Promise<ConversationRecordShape> {
    if (requestId !== '') {
      const existingId = this.requestIds.get(`${ownerKey(owner)}\u0000${requestId}`)
      if (existingId !== undefined) return this.shapeOf(this.ownedRow(owner, existingId))
    }
    const existing = this.rows.get(conversationId)
    if (existing !== undefined) {
      // 同一个 owner 重复预留同一个 id：幂等返回；别人的 id 被再次预留是撞身份，直接拒绝。
      if (!sameOwner(existing.owner, owner)) throw new AccessError(409, '会话标识已被占用')
      return this.shapeOf(existing)
    }
    const now = Date.now()
    const title = initial?.title ?? ''
    const row: MemoryRow = {
      id: conversationId,
      owner: { ...owner },
      title,
      // 显式给的来源优先；否则沿用"空标题 = 还没有标题（可被首条用户消息覆盖）/ 有值 = 调用方直接
      // 给的标题，按手动对待"。⚠️ 那个既有口径让"默认标题 + 之后可被自动标题覆盖"无法表达 ——
      // 所以要显式传（见 `ConversationPort.create` 的说明）。
      titleSource: initial?.titleSource ?? (title === '' ? 'automatic' : 'manual'),
      requestId,
      createdAt: now,
      updatedAt: now,
      ready: false,
      pinned: false,
      deletedAt: null,
      removalState: '',
      payload: { ...(initial?.payload ?? {}) },
    }
    this.rows.set(conversationId, row)
    if (requestId !== '') this.requestIds.set(`${ownerKey(owner)}\u0000${requestId}`, conversationId)
    return this.shapeOf(row)
  }

  /**
   * 合并写业务载荷：**浅合并**（与真实实现的 `payload || $1::jsonb` 同义）。
   *
   * 归属判定走 `ownedRow`（不存在 / 他人 / 别的 Agent ⇒ 404），与 `syncTitle` / `pin` 同一套。
   */
  async patchPayload(owner: OwnerKey, conversationId: string,
    patch: ConversationPayloadShape): Promise<ConversationPayloadShape> {
    const row = this.ownedRow(owner, conversationId)
    row.payload = { ...row.payload, ...patch }
    return { ...row.payload }
  }

  /** **发布段**：`ready` 翻真，并推进 `updated_at`。 */
  async publish(owner: OwnerKey, conversationId: string): Promise<void> {
    const row = this.ownedRow(owner, conversationId)
    row.ready = true
    row.updatedAt = Date.now()
  }

  /**
   * 协作任务的会话寻址：**纯函数**，同一输入恒等。
   *
   * 含 `agentId`（跨 Agent 不撞键）与 owner（跨用户不撞键）——真实实现的派生式逐字相同。
   */
  missionRequestId(owner: OwnerKey, missionId: string): string {
    return `mission:${this.agentId}:${owner.namespace}:${owner.userId}:${missionId}`
  }

  /**
   * 侧栏列表。
   *
   * `scope.busy` 与 `scope.archived` **都真的参与判定**（不是摆设）：busy 决定 `state = 'busy'`
   * 与 `canRemove = false` + `blockedReason`，archived 决定"已删除但没标记移除"的行是否出现。
   */
  async list(owner: OwnerKey, query: ConversationQueryShape,
    scope: { readonly busy: readonly string[]; readonly archived: readonly string[] }): Promise<ConversationPageShape> {
    const busy = new Set(scope.busy)
    const archived = new Set(scope.archived)
    const stateOf = (row: MemoryRow): string => row.removalState === 'pending' ? 'pending'
      : row.removalState === 'failed' ? 'failed'
        : busy.has(row.id) ? 'busy'
          : row.deletedAt === null ? 'ready' : 'legacy'
    const needle = query.q.toLowerCase()
    const visible = [...this.rows.values()]
      .filter(row => sameOwner(row.owner, owner))
      // 未发布的预留行默认不可见（`conversation.ts:383`：发布前"不能发消息、也不可见"）。
      // ⚠️ `includeUnready` 是**页面口径**的开关：blog 的"新建对话"要经过"建会话 → 用户打完
      // 第一条消息才发布"两段，中间那段时间列表里必须看得见它（否则刷新一次对话就"消失"了）。
      .filter(row => query.includeUnready === true || row.ready)
      .filter(row => row.removalState !== 'removed')
      // 已删除且**未被归档**的行不出现在列表里（它们等着被清）；这是 `archived` 的唯一落点。
      .filter(row => !(row.deletedAt !== null && row.removalState === '' && archived.has(row.id)))
      .filter(row => needle === '' || row.title.toLowerCase().includes(needle)
        // `titleOnly` 为真时**只**看标题：会话 id 里那一段（`closedoff-web-`）会让短查询命中全部。
        || (query.titleOnly !== true && row.id.toLowerCase().includes(needle)))
      .filter(row => query.from === undefined || row.updatedAt >= query.from)
      .filter(row => query.to === undefined || row.updatedAt < query.to)
      .filter(row => query.state === '' || stateOf(row) === query.state)
      // 排序必须与真实实现同序（`ORDER BY pinned DESC, updated_at DESC, id`）：反了的话
      // 置顶在页面上的效果就差一半，而两个实现不会同时被测到。
      .sort((left, right) => (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0)
        || right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1))
    const page = visible.slice(query.offset, query.offset + query.limit)
    const items: ManagedConversationShape[] = page.map(row => {
      const state = stateOf(row)
      return {
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt,
        state,
        canRemove: state !== 'busy' && state !== 'pending',
        // 这两个字段只给业务页面用（kit 侧栏忽略），这里填上是为了与真实实现的 `list` 对等：
        // 替身少给字段会让"页面拿得到"这件事在单测里永远测不出来。
        pinned: row.pinned,
        titleSource: row.titleSource,
        // `state` 里分不出"真已发布"与"还在创建握手"（未发布的行也是 `'ready'`）⇒ 单独给一列。
        ready: row.ready,
        ...(state === 'busy' ? { blockedReason: BUSY_REASON }
          : state === 'pending' ? { blockedReason: PENDING_REASON } : {}),
      }
    })
    return {
      items,
      total: visible.length,
      nextOffset: query.offset + items.length < visible.length ? query.offset + items.length : null,
    }
  }

  /**
   * 侧栏操作入口。
   *
   * ⚠️ 它是**存储侧**的入口：看不见宿主的忙碌集合（真实实现同样由 adapter 把
   * `hostBusyConversationIds(ctx)` 合进 `scope.busy` 之后再调用）。所以这里的明细列表只带
   * 本替身自己知道的归档清单，`busy` 传空。
   */
  managed(owner: OwnerKey): ConversationProviderShape {
    return {
      protocol: 1,
      pluginId: this.agentId,
      list: async (actor, query) => {
        assertOwned(actor, owner)
        return this.list(owner, query, { busy: [], archived: [...this.archived] })
      },
      preview: async (actor, conversationId): Promise<ConversationPreviewShape> => {
        assertOwned(actor, owner)
        // 围栏与 `record` 同一套：未知 / 他人 / 别的 Agent 都是 404。
        this.ownedRow(owner, conversationId)
        // 事件日志不在端口里（真实实现从宿主持久化读），替身没有可投影的内容。
        return { messages: [], previousBefore: null, total: 0 }
      },
      remove: async (actor: Actor, ids: readonly string[]): Promise<{ readonly results: readonly RemovalResultShape[] }> => {
        assertOwned(actor, owner)
        if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length
          || ids.some(id => !/^[\w-]{1,160}$/.test(id))) {
          throw new AccessError(400, '请选择 1–100 条不同的有效会话')
        }
        const results: RemovalResultShape[] = []
        for (const id of ids) {
          try {
            const row = this.ownedRow(owner, id)
            if (row.removalState === 'removed') { results.push({ id, status: 'alreadyRemoved' }); continue }
            if (!row.ready) { results.push({ id, status: 'failed', message: '会话不存在或无权访问' }); continue }
            if (row.removalState !== '') { results.push({ id, status: 'blocked', message: PENDING_REASON }); continue }
            // 真实实现还有一步"宿主归档"（`archiveSession`）；替身没有宿主，直接走标记。
            this.setRemovalState(owner, id, 'pending')
            this.setRemovalState(owner, id, 'removed')
            results.push({ id, status: 'removed' })
          } catch (error) {
            results.push({ id, status: 'failed', message: error instanceof Error ? error.message : '移除未完成，请刷新后重试' })
          }
        }
        return { results }
      },
    }
  }

  /** 标题投影：**自动标题不覆盖手动标题**。要求已发布、未删除、无围栏标记（与真实实现一致）。 */
  async syncTitle(owner: OwnerKey, conversationId: string, title: string, source: TitleSource): Promise<void> {
    this.writeTitle(this.ownedRow(owner, conversationId), title, source)
  }

  /**
   * 本地 outbox 的**补写点**替身：按会话 id 写标题，**不需要 owner**。
   *
   * 真实实现是门面 `drainOutboxes()` 里那条裸 `UPDATE … WHERE id = $3 AND agent_id = $4`
   * （标题事件只带会话 id，补写点也就只能按 id 找）。缺了它，夹具里的 `titleSink` 无处落库：
   * `syncTitle` 只负责"投递 + 判定"，**落库是补写点的事**——少了这一环，测试里标题永远写不进去，
   * 而生产里那是"官方标题一直不落库"那个真实缺陷的形状。
   *
   * 守卫与前台同源（{@link writeTitle}），所以这里不会绕过"自动不覆盖手动"。
   */
  deliverTitle(conversationId: string, title: string, source: TitleSource): void {
    const row = this.rows.get(conversationId)
    if (row !== undefined) this.writeTitle(row, title, source)
  }

  /** 标题写入的**唯一**判定点（`syncTitle` 与 `deliverTitle` 共用，两处各写一份必然漂移）。 */
  private writeTitle(row: MemoryRow, title: string, source: TitleSource): void {
    if (!row.ready || row.deletedAt !== null || row.removalState !== '') return
    if (row.titleSource !== 'automatic' && source !== 'manual') return
    row.title = title
    row.titleSource = source
  }

  /**
   * 推进 `updated_at`：**"这个会话刚受理了一条用户消息"的时间戳**。
   *
   * 与真实实现（`postgres.ts` 的 `touch`）逐条对齐：只有 owner 条件（`ownedRow` 之外没有
   * `ready` / `deletedAt` / `removalState` 守卫）、显式时刻、以及**单调不减**（`Math.max`）。
   */
  async touch(owner: OwnerKey, conversationId: string, at?: number): Promise<void> {
    const row = this.ownedRow(owner, conversationId)
    const requested = at ?? Date.now()
    const value = Math.max(row.updatedAt, requested)
    row.updatedAt = value
    // 两个都记：`at` 是"调用方给了什么时刻"，`updatedAt` 是"这一列最后是什么值"。
    // 只记后者的话，"`touch` 收到了一个陈旧的时刻、被 `Math.max` 挡下"与"收到了正确的时刻"
    // 在断言里长得一模一样。
    this.touchCalls.push({ id: conversationId, at: requested, updatedAt: value })
  }

  /**
   * 置顶标记：只改排序用的标记，**不**改变内容与围栏状态。
   *
   * 守卫只有"存在 + 归属"（`ownedRow`），与真实实现那条只带 owner 条件的 `UPDATE` 一致：
   * 这里多加一道 `ready` 检查就会让"未发布也能置顶"在替身里静默失败，而真实现是能写进去的。
   */
  async pin(owner: OwnerKey, conversationId: string, pinned: boolean): Promise<void> {
    const row = this.ownedRow(owner, conversationId)
    row.pinned = pinned
    row.updatedAt = Date.now()
  }

  /**
   * 删除围栏读：**同步**。
   *
   * 未知、他人、别的 Agent 一律同一个 404（不泄露存在性）。`removed` 的行**照常返回**——
   * 否则 kit 的 `alreadyRemoved` 分支（`conversations.ts:131`）永远走不到。
   */
  record(actor: Actor, conversationId: string): ConversationRecordShape {
    const row = this.rows.get(conversationId)
    if (row === undefined || !sameOwner(row.owner, actor)) throw new AccessError(404, '会话不存在或无权访问')
    return this.shapeOf(row)
  }

  /** 删除围栏写：**同步**。`removed` 时补 `deletedAt`（只在为空时补）。 */
  mark(actor: Actor, conversationId: string, state: 'pending' | 'failed' | 'removed'): void {
    this.setRemovalState({ namespace: actor.namespace, userId: actor.userId }, conversationId, state)
  }

  /**
   * 按 id 读镜像的投影，**不判定归属**（`ConversationPort.fenceOf` 的说明写了为什么需要它：
   * 官方的标题事件是同步回调、只带会话 id，而"要不要广播 changed"必须同步判定）。
   *
   * 与真实实现（本地 `conversation_mirror`）同口径：未知的 id ⇒ `undefined`，**不抛 404**。
   */
  fenceOf(conversationId: string): ConversationFenceShape | undefined {
    const row = this.rows.get(conversationId)
    return row === undefined ? undefined : { ...this.shapeOf(row), titleSource: row.titleSource }
  }

  // ---------------------------------------------------------------------
  // 仅供测试的检视与布置（不属于 ConversationPort）
  // ---------------------------------------------------------------------

  /** 行数（断言"没有偷偷新建第二条会话"用）。 */
  get size(): number {
    return this.rows.size
  }

  /**
   * 把整份状态快照成一个不透明值（**仅供测试**的事务替身用，不属于端口面）。
   *
   * 用途：测试夹具要一个"能回滚的 `AgentDatabasePort`"来验证业务的原子性（旧 SQLite 实现靠
   * `BEGIN IMMEDIATE`）。内存实现没有事务，所以夹具在事务开始时 `snapshot()`、抛错时
   * `restore()` —— 语义与 PG 的 `ROLLBACK` 在**单线程**下等价（真实实现可能被并发插入，
   * 那是内存替身本来就不具备的能力，见文件头那张表）。
   *
   * 深一层就够：行与载荷都不与快照共享引用（`payload` 是扁平对象，业务不往里塞嵌套可变结构）。
   */
  snapshot(): unknown {
    return {
      rows: [...this.rows].map(([id, row]) => [id, { ...row, owner: { ...row.owner }, payload: { ...row.payload } }]),
      requestIds: [...this.requestIds],
      archived: [...this.archived],
      touchCalls: this.touchCalls.map(call => ({ ...call })),
    }
  }

  /** 恢复到 {@link snapshot} 的那一刻（仅供测试）。 */
  restore(snapshot: unknown): void {
    const value = snapshot as {
      readonly rows: readonly (readonly [string, MemoryRow])[]
      readonly requestIds: readonly (readonly [string, string])[]
      readonly archived: readonly string[]
      readonly touchCalls: readonly { readonly id: string; readonly at: number; readonly updatedAt: number }[]
    }
    this.rows.clear()
    for (const [id, row] of value.rows) this.rows.set(id, row)
    this.requestIds.clear()
    for (const [key, id] of value.requestIds) this.requestIds.set(key, id)
    this.archived.clear()
    for (const id of value.archived) this.archived.add(id)
    this.touchCalls.length = 0
    this.touchCalls.push(...value.touchCalls)
  }

  /** 全部会话 id，按插入顺序。 */
  ids(): readonly string[] {
    return [...this.rows.keys()]
  }

  /**
   * 每一次 `touch` 的痕迹（`id` + 调用方给的时刻 + 落下的值）。
   *
   * 用它而不是只读 `updatedAt`：`updatedAt` 是"结果"，而这里能区分"没推进"与"根本没调
   * `touch`"——两者在只读 `updatedAt` 的断言下是同一种红。
   */
  get touched(): readonly { readonly id: string; readonly at: number; readonly updatedAt: number }[] {
    return [...this.touchCalls]
  }

  /** 一行的原始快照（含 `titleSource` / `requestId` 这两个不在 `ConversationRecordShape` 里的字段）。 */
  rawOf(conversationId: string): (ConversationRecordShape & { readonly titleSource: TitleSource; readonly requestId: string }) | undefined {
    const row = this.rows.get(conversationId)
    if (row === undefined) return undefined
    return { ...this.shapeOf(row), titleSource: row.titleSource, requestId: row.requestId }
  }

  /**
   * 布置一条"宿主已归档、但围栏标记为空"的历史行。
   *
   * 正常端口路径**写不出**这个组合（`deletedAt` 只由 `mark('removed')` 补，那时
   * `removalState` 也是 `'removed'`，行早被过滤掉了）。它是 `scope.archived` 分支唯一的观测点，
   * 所以只能由测试显式布置。
   */
  seedLegacy(owner: OwnerKey, conversationId: string, updatedAt = Date.now()): void {
    const row: MemoryRow = {
      id: conversationId,
      owner: { ...owner },
      title: '宿主已归档的历史会话',
      titleSource: 'automatic',
      requestId: '',
      createdAt: updatedAt,
      updatedAt,
      ready: true,
      pinned: false,
      deletedAt: updatedAt,
      removalState: '',
      payload: {},
    }
    this.rows.set(conversationId, row)
  }

  /** 模拟宿主的归档清单发生变化。 */
  setArchived(conversationId: string, archived: boolean): void {
    if (archived) this.archived.add(conversationId)
    else this.archived.delete(conversationId)
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  private ownedRow(owner: OwnerKey, conversationId: string): MemoryRow {
    const row = this.rows.get(conversationId)
    if (row === undefined || !sameOwner(row.owner, owner)) throw new AccessError(404, '会话不存在或无权访问')
    return row
  }

  private setRemovalState(owner: OwnerKey, conversationId: string, state: 'pending' | 'failed' | 'removed'): void {
    const row = this.ownedRow(owner, conversationId)
    row.removalState = state
    if (state === 'removed' && row.deletedAt === null) row.deletedAt = Date.now()
  }

  private shapeOf(row: MemoryRow): ConversationRecordShape {
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      removalState: row.removalState,
      ready: row.ready,
      payload: { ...row.payload },
    }
  }
}

/** 一行的内存形状（对应真实实现里的 `dsh_turns` 行）。 */
interface MemoryTurnRow {
  readonly id: string
  readonly owner: OwnerKey
  readonly conversationId: string
  readonly requestId: string
  readonly inputHash: string
  status: string
  /** 插入序（真实实现是 `BIGINT GENERATED ALWAYS AS IDENTITY`）。 */
  readonly seq: number
  readonly createdAt: number
  payload: ConversationPayloadShape
}

/**
 * 内存版 `TurnStorePort` —— `dsh_turns` + `dsh_turn_results` 的**非持久实现**。
 *
 * 与 {@link MemoryConversationPort} 同一处境、同一用途：给"还没有（或不该有）存储后端"的装配与
 * 测试一个可用的轮次端口。**它存在的理由是跨包**——blog 的 24 个测试文件原本跑在 SQLite
 * `:memory:` 上，索引库切到 PG 端口之后它们会失去后端，而 `storage/local.ts` 是"围栏镜像 + outbox"、
 * **不实现轮次**；跨包 import 另一个包的测试夹具不可行。
 *
 * ⚠️ 它**不是**"轮次已经落库"的证据：没有持久化、没有并发、没有跨进程。**不要**拿它推断真实实现
 * 的时序（真实实现在两次 `await` 之间可能被并发插入）。
 *
 * ## 与真实实现**逐条对齐**的部分（对齐是刻意的）
 *
 * - `claim`：空 `requestId` ⇒ 400（不伪造幂等身份）；同 `(owner, requestId)` 幂等，命中既有行时
 *   比对 `inputHash`——相同答 `'duplicate'`，不同抛 409（同一次受理换正文必须报冲突，否则带副作用
 *   的活会干两遍）；`payload` **只在首次建行时**生效（真实实现靠 `ON CONFLICT DO NOTHING`）；
 * - `finish` / `turnId` / `turnStatus` / `turnById` / `turnResults` 的**空 `requestId` / 空行 id**
 *   一律静默返回（`undefined` / `[]`），与真实实现的前置早退一致；
 * - `turnStatus` 只认 `'claimed'` / `'finished'`，别的值（例如等待行的 `'waiting'`）答 `undefined`；
 * - `turnById` 与 `turnsOf` 都按 **owner** 过滤：别人的行在这个实例里根本读不到（真实实现是 SQL 条件）；
 * - `turnsOf` 按 **`seq`** 升序、**含 `request_id = ''` 的等待行**——`seq` 是插入序（真实实现是库
 *   生成的 IDENTITY），所以**同一毫秒内的顺序也是确定的**（这一点与真实实现一致）；
 * - `patchTurnPayload`：**浅合并**，返回**合并后那一层**（不是补丁），行不存在或不属于该 owner ⇒ 404；
 * - `appendTurnResult` / `turnResults`：`seq` 是每个实例内单调的插入序（真实实现是
 *   `GENERATED ALWAYS AS IDENTITY`，跨实例共享），按 `seq` 升序读；`createdAt` 缺省取当前时间；
 * - `pendingQuestion`：取该会话**最新**一条带非空 `question` 的行；`setPendingQuestion` 写入前先清掉
 *   该会话原有的 `question` 键（真实实现是同一句 `payload - 'question'`），所以正常情况下只有一行带着它
 *   ——"此刻在等什么"由这个不变量定，不靠时间戳运气（毫秒级同刻是常见情形）。
 */
export class MemoryTurnStore implements TurnStorePort {
  readonly agentId: string
  /** 行 id → 行。真实实现是 `dsh_turns`。 */
  private readonly rows = new Map<string, MemoryTurnRow>()
  /** `owner + requestId` → 行 id：幂等身份（真实实现是部分唯一索引 `WHERE request_id <> ''`）。 */
  private readonly requestIds = new Map<string, string>()
  /**
   * 结果记录（`dsh_turn_results`）。
   *
   * 连 `conversationId` 一起存：真实实现里 `dsh_turn_results.conversation_id` 是**自己的列**
   * （不是从 turn 上取的），`turnResultsOf` 就按它过滤。少了它，那个方法只能靠 `turnId` 反查，
   * 而"靠反查"在真实实现里是不需要的一次 join。
   */
  private readonly results: (TurnResultRecord & { readonly owner: OwnerKey; readonly conversationId: string })[] = []
  /** 结果 `seq` 的替身（真实实现是库生成的 IDENTITY）。 */
  private resultSeq = 0
  /** 轮次 `seq` 的替身（真实实现是 `dsh_turns.seq` 的 IDENTITY；`claim` 与等待行各占一个）。 */
  private turnSeq = 0

  constructor(agentId: string) {
    this.agentId = agentId
  }

  // ---------------------------------------------------------------------
  // TurnStorePort
  // ---------------------------------------------------------------------

  /**
   * 认领一轮：空 `requestId` 拒绝；同 `(owner, requestId)` 幂等；换正文报 409。
   *
   * `payload` 只在**首次建行**时落，命中既有行时原样保留（与 `ConversationPort.create` 的
   * `initial` 同一条口径）。
   */
  async claim(owner: OwnerKey, conversationId: string, requestId: string, inputHash: string,
    payload?: ConversationPayloadShape)
    : Promise<'claimed' | 'duplicate'> {
    if (requestId === '') throw new AccessError(400, '轮次缺少幂等身份（requestId）')
    const key = `${ownerKey(owner)}\u0000${requestId}`
    const existingId = this.requestIds.get(key)
    if (existingId !== undefined) {
      const row = this.rows.get(existingId)!
      // 同一次受理换了正文：必须报冲突而不是重跑（重跑会让带副作用的活干两遍）。
      if (row.inputHash !== inputHash) throw new AccessError(409, '同一个请求标识不能换正文')
      return 'duplicate'
    }
    const id = randomUUID()
    this.rows.set(id, {
      id,
      owner: { ...owner },
      conversationId,
      requestId,
      inputHash,
      status: 'claimed',
      seq: (this.turnSeq += 1),
      createdAt: Date.now(),
      payload: { ...payload },
    })
    this.requestIds.set(key, id)
    return 'claimed'
  }

  /** 这一轮跑完了。空 `requestId` 与不存在的轮次都是**静默无操作**（与真实实现一致）。 */
  async finish(owner: OwnerKey, requestId: string): Promise<void> {
    const row = this.rowByRequest(owner, requestId)
    if (row === undefined) return
    row.status = 'finished'
  }

  /** 这一轮的状态；没有行、空 `requestId`、或状态不是 `claimed`/`finished` 时 `undefined`。 */
  async turnStatus(owner: OwnerKey, requestId: string): Promise<'claimed' | 'finished' | undefined> {
    const status = this.rowByRequest(owner, requestId)?.status
    return status === 'claimed' || status === 'finished' ? status : undefined
  }

  /** 这一轮的**行 id**；没有这一轮（或 `requestId` 为空）时 `undefined`。 */
  async turnId(owner: OwnerKey, requestId: string): Promise<string | undefined> {
    return this.rowByRequest(owner, requestId)?.id
  }

  /** 按**行 id** 读一轮；没有这一行（或不属于本 owner）时 `undefined`。 */
  async turnById(owner: OwnerKey, turnId: string): Promise<TurnRecord | undefined> {
    const row = this.ownedRow(owner, turnId)
    return row === undefined ? undefined : this.shapeOf(row)
  }

  /**
   * 读一个会话下的全部轮次（**含 `request_id = ''` 的等待行**），按 **`seq`** 升序。
   *
   * ⚠️ **按 `seq` 而不是 `createdAt`**：后者只到毫秒，同一毫秒内的两条会退化成按 `id`（随机
   * UUID）排 ⇒ **列表顺序不确定**。真实实现里 `seq` 是库生成的 IDENTITY，这里由本实例递增。
   */
  async turnsOf(owner: OwnerKey, conversationId: string): Promise<readonly TurnRecord[]> {
    return [...this.rows.values()]
      .filter(row => sameOwner(row.owner, owner) && row.conversationId === conversationId)
      .sort((left, right) => left.seq - right.seq)
      .map(row => this.shapeOf(row))
  }

  /**
   * 合并写一轮的业务载荷（**浅合并**）；返回合并后落下的那一层。
   *
   * 行不存在或不属于本 owner ⇒ **404**（静默成功会让调用方以为写进去了）。
   */
  async patchTurnPayload(owner: OwnerKey, turnId: string, patch: ConversationPayloadShape)
    : Promise<ConversationPayloadShape> {
    const row = this.ownedRow(owner, turnId)
    if (row === undefined) throw new AccessError(404, '轮次不存在或无权访问')
    row.payload = { ...row.payload, ...patch }
    return { ...row.payload }
  }

  /** 落一条结果记录；返回它的 id。`seq` 由本实例生成（真实实现是库生成的 IDENTITY）。 */
  async appendTurnResult(owner: OwnerKey, input: AppendTurnResultInput): Promise<string> {
    this.resultSeq += 1
    const id = randomUUID()
    this.results.push({
      id,
      turnId: input.turnId,
      operationId: input.operationId,
      seq: this.resultSeq,
      createdAt: input.createdAt ?? Date.now(),
      payload: { ...input.payload },
      owner: { ...owner },
      conversationId: input.conversationId,
    })
    return id
  }

  /** 读某一轮的全部结果记录，按 `seq`（插入序）升序。 */
  async turnResults(owner: OwnerKey, turnId: string): Promise<readonly TurnResultRecord[]> {
    if (turnId === '') return []
    return this.results
      .filter(row => sameOwner(row.owner, owner) && row.turnId === turnId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ owner: _owner, conversationId: _conversationId, ...row }) => ({ ...row, payload: { ...row.payload } }))
  }

  /**
   * 读**一个会话下所有轮次**的结果记录，按 `seq`（插入序）升序。
   *
   * 与真实实现同一条口径：按 `conversation_id` 过滤（它自己的列），**不**先查轮次再逐轮查。
   * 别人的会话读不到——这里按 owner 过滤（真实实现是 SQL 条件）。
   */
  async turnResultsOf(owner: OwnerKey, conversationId: string): Promise<readonly TurnResultRecord[]> {
    return this.results
      .filter(row => sameOwner(row.owner, owner) && row.conversationId === conversationId)
      .sort((left, right) => left.seq - right.seq)
      .map(({ owner: _owner, conversationId: _conversationId, ...row }) => ({ ...row, payload: { ...row.payload } }))
  }

  /**
   * 按**业务操作标识**读轮次（跨会话），最新的在前。
   *
   * 与真实实现同一条口径：查的是载荷里的业务键（列上没有它）、按 `seq` 降序、空串直接返回空数组。
   */
  async turnsByOperationId(owner: OwnerKey, operationId: string): Promise<readonly TurnRecord[]> {
    if (operationId === '') return []
    return [...this.rows.values()]
      .filter(row => sameOwner(row.owner, owner) && row.payload.operationId === operationId)
      .sort((left, right) => right.seq - left.seq)
      .map(row => this.shapeOf(row))
  }

  /**
   * 这个会话在等用户回什么；没有等待行时 `undefined`（取**最新**一条带问题的行）。
   *
   * "最新"按 **`seq`** 定义（同真实实现）：`createdAt` 只到毫秒，内存实现里两次等待**必然同毫秒**，
   * 按它排就退化成按随机 UUID 排。正常情况下这里最多命中一行（`setPendingQuestion` 先清键），
   * 排序只是兜底。
   */
  async pendingQuestion(owner: OwnerKey, conversationId: string): Promise<string | undefined> {
    const waiting = [...this.rows.values()]
      .filter(row => sameOwner(row.owner, owner) && row.conversationId === conversationId)
      .sort((left, right) => right.seq - left.seq)
    const question = waiting.find(row => typeof row.payload.question === 'string' && row.payload.question !== '')?.payload.question
    return typeof question === 'string' ? question : undefined
  }

  /**
   * 记下"在等什么"；`undefined` / 空串表示不再等待。
   *
   * 落一行 `request_id = ''` 的等待行（没有幂等语义，可以有多条），`status = 'waiting'`。
   *
   * ⚠️ 写入前**先清掉该会话上原有的 `question` 键**（与真实实现同一句 SQL 的等价物）。不清的话
   * "此刻在等什么"就会命中多条，只能靠时间戳挑"最新"，而内存实现里两次等待**必然同毫秒**。
   */
  async setPendingQuestion(owner: OwnerKey, conversationId: string, question: string | undefined): Promise<void> {
    const rows = [...this.rows.values()]
      .filter(row => sameOwner(row.owner, owner) && row.conversationId === conversationId)
    for (const row of rows) delete row.payload.question
    if (question === undefined || question === '') return
    const id = randomUUID()
    this.rows.set(id, {
      id,
      owner: { ...owner },
      conversationId,
      requestId: '',
      inputHash: '',
      status: 'waiting',
      seq: (this.turnSeq += 1),
      createdAt: Date.now(),
      payload: { question },
    })
  }

  // ---------------------------------------------------------------------
  // 观测（测试用；不属于端口面）
  // ---------------------------------------------------------------------

  /** 全部行的原始快照（含端口读不到的 `inputHash`），按插入序。 */
  get rawTurns(): readonly MemoryTurnRow[] {
    return [...this.rows.values()].map(row => ({ ...row, payload: { ...row.payload } }))
  }

  /** 整份状态快照（仅供测试的事务替身；语义见 `MemoryConversationPort.snapshot`）。 */
  snapshot(): unknown {
    return {
      rows: [...this.rows].map(([id, row]) => [id, { ...row, owner: { ...row.owner }, payload: { ...row.payload } }]),
      requestIds: [...this.requestIds],
      results: this.results.map(row => ({ ...row, owner: { ...row.owner }, payload: { ...row.payload } })),
      resultSeq: this.resultSeq,
      turnSeq: this.turnSeq,
    }
  }

  /** 恢复到 {@link snapshot} 的那一刻（仅供测试）。 */
  restore(snapshot: unknown): void {
    const value = snapshot as {
      readonly rows: readonly (readonly [string, MemoryTurnRow])[]
      readonly requestIds: readonly (readonly [string, string])[]
      readonly results: readonly (TurnResultRecord & { readonly owner: OwnerKey; readonly conversationId: string })[]
      readonly resultSeq: number
      readonly turnSeq: number
    }
    this.rows.clear()
    for (const [id, row] of value.rows) this.rows.set(id, row)
    this.requestIds.clear()
    for (const [key, id] of value.requestIds) this.requestIds.set(key, id)
    this.results.length = 0
    this.results.push(...value.results)
    this.resultSeq = value.resultSeq
    this.turnSeq = value.turnSeq
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  private rowByRequest(owner: OwnerKey, requestId: string): MemoryTurnRow | undefined {
    if (requestId === '') return undefined
    const id = this.requestIds.get(`${ownerKey(owner)}\u0000${requestId}`)
    return id === undefined ? undefined : this.rows.get(id)
  }

  private ownedRow(owner: OwnerKey, turnId: string): MemoryTurnRow | undefined {
    if (turnId === '') return undefined
    const row = this.rows.get(turnId)
    return row === undefined || !sameOwner(row.owner, owner) ? undefined : row
  }

  private shapeOf(row: MemoryTurnRow): TurnRecord {
    return {
      id: row.id,
      conversationId: row.conversationId,
      requestId: row.requestId,
      inputHash: row.inputHash,
      status: row.status,
      seq: row.seq,
      createdAt: row.createdAt,
      payload: { ...row.payload },
    }
  }
}

/** `owner` 与 `Actor` 在归属上是同一对键（namespace + userId）。 */
function assertOwned(actor: Actor, owner: OwnerKey): void {
  if (!sameOwner(owner, actor)) throw new AccessError(404, '会话不存在或无权访问')
}
