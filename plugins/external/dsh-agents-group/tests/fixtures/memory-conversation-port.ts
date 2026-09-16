/**
 * 内存版 `ConversationPort` —— **测试替身，不是 P2 的真实实现**。
 *
 * 用途只有一个：让 P1（运行时骨架）的验收测试在没有 PG、没有本地 SQLite 文件、没有网络的环境里
 * 跑一轮最小会话。P2 的真实实现（PG 权威 + 本地同步镜像 + 持久 outbox）不在这里，本文件也
 * **不能**当作"存储已经实现"的证据 —— 它连持久化都没有。
 *
 * ## 它**不具备**的语义（逐条都是真实实现有、替身没有的）
 *
 * | 能力 | 真实实现 | 本替身 |
 * | --- | --- | --- |
 * | 持久 outbox | 标记与 `fence_outbox` / `title_outbox` 在同一个本地事务里落盘，后台按每会话 FIFO 补写 PG | **无**：`mark` 只改内存，进程结束即丢 |
 * | 崩溃窗口内的真值方向 | "pending 窗口内本地权威"：死在"写标记"与"补写 PG"之间时本地仍留 `pending`，启动时把它升格进 PG | **无**：没有崩溃窗口这回事，也谈不上哪一侧权威 |
 * | 跨进程 / 多实例 | PG 行 + 部分唯一索引，互斥与可见性由 PG 保证 | **无**：一个进程内的一张 `Map`，两个实例互不可见 |
 * | 启动收敛 | 先排空 outbox、再按 PG 收敛、镜像与 PG 对账 | **无** |
 * | 真正的异步往返 | `create` / `publish` / `list` / `syncTitle` 都是 PG 往返 | 方法签名是 `async`，内部**同步**完成：**不要据此推断真实实现的时序**（真实实现在 await 之间可能被并发插入） |
 * | `updated_at` 的来源 | 建会话、发布、以及"受理一条用户消息"等路径分别维护（`touch` 语义） | 只在 `create` / `publish` 时推进；**没有** `touch` 这一步 |
 * | 宿主忙碌集合 | 调用方把 `hostBusyConversationIds(ctx)` 合进 `scope.busy` 后再传进来 | 完全依赖调用方传入的 `scope`；它自己看不到宿主 |
 * | 业务表 / 事务 / 健康探针 | `query()` / `transaction()` / outbox 积压深度 | **无** |
 * | 标题来源映射 | `create` 收到 `{ title: '' }` 时被记成 `manual`（`postgres.ts:106`：`initial?.title === undefined ? 'automatic' : 'manual'`），于是首条用户消息的自动标题再也写不进去 | 按**空标题 = `automatic`** 实现（见下面的差异说明） |
 * | 列表过滤 | 现版 `postgres.ts` 的 `list` **没有**过滤 `ready = false` | 过滤掉未发布的预留行（`conversation.ts:383` 的"发布段"注释要求"`ready` 翻真之前这个会话在侧栏不可见"） |
 *
 * 最后两条是**替身与 P2 现版实现故意不一致**的地方，因为那两处现版实现与本仓自己的约定相矛盾
 * （差异与复现方式已随 P1 验收报告一起上报，不要在没核对的情况下把替身改成"跟现版一样"）。
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
 * - `missionRequestId` 是 `(agentId, owner, missionId)` 的**纯函数**：含 `agentId`，避免跨 Agent
 *   撞键；同一输入恒等，且不读任何可变状态。
 */
import { AccessError, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type {
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
} from '../../packages/runtime/src/storage/ports.ts'

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
  deletedAt: number | null
  removalState: RemovalState
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
   * **预留段**：插入一行归属，`ready = false`——会话此时不可见、也不能发消息。
   *
   * `requestId` 非空时幂等：同一个 `(agent, owner, requestId)` 再来一次返回原来那一行
   * （真实实现靠部分唯一索引 + `SELECT` 回既有行，见 `postgres.ts:96-119`）。
   */
  async create(owner: OwnerKey, conversationId: string, requestId: string,
    initial?: { readonly title?: string }): Promise<ConversationRecordShape> {
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
      // 空标题 = 还没有标题（可被首条用户消息覆盖）；有值 = 调用方直接给的标题，按手动对待。
      titleSource: title === '' ? 'automatic' : 'manual',
      requestId,
      createdAt: now,
      updatedAt: now,
      ready: false,
      deletedAt: null,
      removalState: '',
    }
    this.rows.set(conversationId, row)
    if (requestId !== '') this.requestIds.set(`${ownerKey(owner)}\u0000${requestId}`, conversationId)
    return this.shapeOf(row)
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
      // 未发布的预留行在侧栏不可见（`conversation.ts:383`：发布前"不能发消息、也不可见"）。
      .filter(row => row.ready)
      .filter(row => row.removalState !== 'removed')
      // 已删除且**未被归档**的行不出现在列表里（它们等着被清）；这是 `archived` 的唯一落点。
      .filter(row => !(row.deletedAt !== null && row.removalState === '' && archived.has(row.id)))
      .filter(row => needle === '' || row.title.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
      .filter(row => query.from === undefined || row.updatedAt >= query.from)
      .filter(row => query.to === undefined || row.updatedAt < query.to)
      .filter(row => query.state === '' || stateOf(row) === query.state)
      .sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1))
    const page = visible.slice(query.offset, query.offset + query.limit)
    const items: ManagedConversationShape[] = page.map(row => {
      const state = stateOf(row)
      return {
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt,
        state,
        canRemove: state !== 'busy' && state !== 'pending',
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
      remove: async (actor, ids): Promise<{ readonly results: readonly RemovalResultShape[] }> => {
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
    const row = this.ownedRow(owner, conversationId)
    if (!row.ready || row.deletedAt !== null || row.removalState !== '') return
    if (row.titleSource !== 'automatic' && source !== 'manual') return
    row.title = title
    row.titleSource = source
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

  // ---------------------------------------------------------------------
  // 仅供测试的检视与布置（不属于 ConversationPort）
  // ---------------------------------------------------------------------

  /** 行数（断言"没有偷偷新建第二条会话"用）。 */
  get size(): number {
    return this.rows.size
  }

  /** 全部会话 id，按插入顺序。 */
  ids(): readonly string[] {
    return [...this.rows.keys()]
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
      deletedAt: updatedAt,
      removalState: '',
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
    }
  }
}

/** `owner` 与 `Actor` 在归属上是同一对键（namespace + userId）。 */
function assertOwned(actor: Actor, owner: OwnerKey): void {
  if (!sameOwner(owner, actor)) throw new AccessError(404, '会话不存在或无权访问')
}
