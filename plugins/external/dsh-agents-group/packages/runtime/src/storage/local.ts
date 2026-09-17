/**
 * 本地 SQLite：**三个同步面**的唯一依托。
 *
 * ## 为什么必须是本地、必须是同步
 *
 * kit 的 `ConversationRemovalStore` 是**同步契约**（`conversations.ts:90-93`），被
 * `conversationRemover` 在 `:130/:139/:141/:149` 同步调用；`conversationRemover` 的
 * `busy(id): boolean` 也是同步的（`:117`，调用点 `:134/:140`）。而 PG 访问必然异步，
 * 所以三个面各按各的方式满足：
 *
 * | 面 | 形态 | 实现 |
 * | --- | --- | --- |
 * | `record` | 同步**读** | 读本地**会话行镜像**（返回值参与 kit 的 `alreadyRemoved` 分支，还要回答存在性 / 归属 / `ready`） |
 * | `mark` | 同步**写** | 同一个本地事务里写 `removal_state` **并**插入 `fence_outbox` |
 * | `busy` | 同步布尔 | 进程内镜像（由门面维护，见 `index.ts`）——**绝不能**做成 PG 查询 |
 *
 * ## 围栏的真值方向：**pending 窗口内本地权威**
 *
 * 反向设计（"PG 权威 + 本地可从 PG 重建"）是错的：`conversationRemover` 在 `:141` 同步
 * `mark('pending')`、`:149` 同步 `mark('removed')`。若 `mark` 只落本地而 PG 靠异步补，则死在
 * `:141` 与补写之间时 **PG 里什么都没有**；此时按"启动从 PG 重建"就会把本地 pending
 * **抹成空**，围栏失效（会话重新可见、可发消息），而宿主可能已经 `archiveSession` —— 留下
 * 幽灵会话。
 *
 * 所以：本地写标记 + 写**持久 outbox**（原子），后台按**每会话 FIFO** 补写 PG；
 * 启动时**先排空 outbox、再**按 PG 收敛；本地遗留的 `pending` **升格**为 PG `pending`
 * （不是被 PG 抹掉）。
 *
 * ## outbox 为什么必须持久
 *
 * 内存队列会在崩溃或插件卸载时丢——丢的是一条"这个会话该被移除"的指令，而宿主那边可能
 * 已经归档了。那种丢失不可察觉，只会表现为"会话还列在侧栏，点进去打不开"。
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccessError, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type { ConversationPayloadShape, ConversationRecordShape } from './ports.ts'

/** 镜像行：本地对 PG 那一行的投影。 */
export interface MirrorRow {
  readonly id: string
  readonly agentId: string
  readonly ownerNamespace: string
  readonly ownerId: string
  readonly title: string
  readonly titleSource: 'automatic' | 'generated' | 'manual'
  readonly ready: boolean
  readonly pinned: boolean
  readonly removalState: string
  readonly deletedAt: number | null
  readonly updatedAt: number
  /**
   * 业务载荷的**本地副本**（PG 的 `dsh_conversations.payload`）。
   *
   * 为什么业务余项也要进镜像：`record` 是同步读，而业务侧有**同步**消费者
   * （blog 的 `chat.ts:284` 从 `index.record(...)` 取 `inheritedRequests`）。载荷留在 PG
   * 不进镜像，那个同步读就只能在"重启后、收敛完成前"读到空——与围栏字段缺镜像时是同一类
   * 静默漂移。
   */
  readonly payload: ConversationPayloadShape
}

/** 一条待补写的围栏变更。 */
export interface FenceEntry {
  readonly seq: number
  readonly conversationId: string
  readonly state: 'pending' | 'failed' | 'removed'
}

/** 一条待补写的标题更新。 */
export interface TitleEntry {
  readonly seq: number
  readonly conversationId: string
  readonly title: string
  readonly source: 'automatic' | 'generated' | 'manual'
}

/** outbox 的积压状况（供健康探针与告警）。 */
export interface OutboxDepth {
  readonly depth: number
  /** 最老一条的写入时刻（毫秒）；空队列时 `undefined`。 */
  readonly oldestAt: number | undefined
}

/**
 * 本地结构版本。
 *
 * 1：首版（`conversation_mirror` + `fence_outbox` + `title_outbox`）。
 *
 * 本地库**可以重建**（镜像与 outbox 都能从 PG + 未完成的指令重新收敛），所以这里的版本
 * 检查比 PG 侧宽松：认不出的版本直接拒绝启动，由运维删文件重建——不写迁移链。
 *
 * ⚠️ 但这个"可以重建"是**有代价**的：`fence_outbox` 里未补写的围栏指令只存在于本地
 * （那正是"pending 窗口内本地权威"的全部意义）。所以**纯增列不在这里升版**——升版会让
 * 运维删文件，而删掉的可能是"这个会话该被移除"这样一条宿主已经归档、PG 却毫不知情的指令。
 * 增列走下面的幂等 `ALTER`（`ensureMirrorPayloadColumn`），旧库原样继续用。
 */
const LOCAL_SCHEMA_VERSION = 1

/** 增列前先看列在不在：`ALTER TABLE ... ADD COLUMN` 没有 `IF NOT EXISTS`。 */
const MIRROR_PAYLOAD_COLUMN = 'payload'

export class LocalFenceStore {
  private readonly db: DatabaseSync
  private closed = false

  constructor(private readonly agentId: string, path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version !== 0 && version !== LOCAL_SCHEMA_VERSION) {
      this.db.close()
      throw new Error(`不支持的本地围栏结构版本：${version}（期望 ${LOCAL_SCHEMA_VERSION}）；本地库可以删除重建`)
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversation_mirror (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        owner_namespace TEXT NOT NULL, owner_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', title_source TEXT NOT NULL DEFAULT 'automatic',
        ready INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
        removal_state TEXT NOT NULL DEFAULT '', deleted_at INTEGER, updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS conversation_mirror_owner
        ON conversation_mirror(agent_id, owner_namespace, owner_id, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS fence_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS title_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${LOCAL_SCHEMA_VERSION};
    `)
    this.ensureMirrorPayloadColumn()
  }

  /**
   * 给**已存在**的 `conversation_mirror`（首版建的表）补上 `payload` 列。
   *
   * 为什么不升 `LOCAL_SCHEMA_VERSION`：那个版本号是**拒绝启动**的开关，升一版就意味着
   * 运维必须删掉 `mirror.sqlite` 才能起来——而那个文件里有 `fence_outbox`（未补写的删除
   * 指令，PG 那边什么都没有）。为了一列纯增字段付这个代价是错的，所以这里用幂等 `ALTER`
   * 就地补上：老库一行不动地继续用，新库由上面的 `CREATE TABLE` 直接带出这一列。
   *
   * 列默认 `'{}'`（不是 NULL）：老库里那些行本来就没有业务载荷，"空对象"正是它们的真值，
   * 而 `NOT NULL` 让读侧的 `decodeMirrorPayload` 只需要处理"形状漂移"一种异常。
   */
  private ensureMirrorPayloadColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(conversation_mirror)').all() as unknown as { name?: unknown }[]
    if (columns.some(column => column.name === MIRROR_PAYLOAD_COLUMN)) return
    this.db.exec(`ALTER TABLE conversation_mirror ADD COLUMN payload TEXT NOT NULL DEFAULT '{}'`)
  }

  private assertOpen(): void {
    if (this.closed) throw new AccessError(503, '本地围栏已关闭')
  }

  // ---------------------------------------------------------------------
  // 同步面之一：record（同步读）
  // ---------------------------------------------------------------------

  /**
   * 删除围栏读：**同步**。
   *
   * 只回答"存在 / 归属 / `ready` / 围栏状态"，**不按 `removal_state` 过滤**——`removed` 的行
   * 也必须返回，否则 kit 的 `alreadyRemoved` 分支（`conversations.ts:131`）永远走不到，
   * 重复移除会被当成失败。
   *
   * 未知、他人、`agent_id` 不匹配一律返回**同一个** 404：不泄露存在性（与
   * `closedoff/src/conversation-store.ts:63` 同一套判定）。
   */
  record(actor: Actor, conversationId: string): ConversationRecordShape {
    this.assertOpen()
    const row = this.mirrorGet(conversationId)
    if (row === undefined || row.agentId !== this.agentId
      || row.ownerNamespace !== actor.namespace || row.ownerId !== actor.userId) {
      throw new AccessError(404, '会话不存在或无权访问')
    }
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      removalState: row.removalState,
      ready: row.ready,
      // 同步读也要给出业务载荷：`payload` 是"业务余项"那一层的唯一来源，缺了它，
      // 依赖它的同步消费者（blog 的 `inheritedRequests`）在重启后会读到空。
      payload: row.payload,
    }
  }

  // ---------------------------------------------------------------------
  // 同步面之二：mark（同步写，标记 + outbox 同一本地事务）
  // ---------------------------------------------------------------------

  /**
   * 删除围栏写：**同步**。
   *
   * 标记与 outbox 必须在**同一个本地事务**里落：否则崩溃可能留下"标记写了、指令没留"
   * （围栏在本地有效但 PG 永远不知道）或反过来（PG 会收到一条来源不明的指令）。
   *
   * `removed` 时补 `deleted_at`（只在为空时补：重复标记不该刷新删除时刻）。
   */
  mark(actor: Actor, conversationId: string, state: 'pending' | 'failed' | 'removed'): void {
    this.assertOpen()
    // 先按同一套判定核验归属（不存在/他人/别的 Agent 都抛 404）。
    this.record(actor, conversationId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `UPDATE conversation_mirror
           SET removal_state = ?, deleted_at = CASE WHEN ? = 'removed' THEN COALESCE(deleted_at, ?) ELSE deleted_at END
         WHERE id = ? AND agent_id = ?`,
      ).run(state, state, Date.now(), conversationId, this.agentId)
      this.db.prepare(
        'INSERT INTO fence_outbox(agent_id, conversation_id, state, created_at) VALUES(?,?,?,?)',
      ).run(this.agentId, conversationId, state, Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---------------------------------------------------------------------
  // 镜像维护（由门面在收敛与写入路径上调用）
  // ---------------------------------------------------------------------

  mirrorGet(id: string): MirrorRow | undefined {
    const row = this.db.prepare(
      `SELECT id, agent_id, owner_namespace, owner_id, title, title_source, ready, pinned, removal_state, deleted_at, updated_at, payload
         FROM conversation_mirror WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toMirrorRow(row)
  }

  /** 该 Agent 的全部镜像行（启动时与 PG 对账用）。 */
  mirrorAll(): readonly MirrorRow[] {
    const rows = this.db.prepare(
      `SELECT id, agent_id, owner_namespace, owner_id, title, title_source, ready, pinned, removal_state, deleted_at, updated_at, payload
         FROM conversation_mirror WHERE agent_id = ?`,
    ).all(this.agentId) as unknown as Record<string, unknown>[]
    return rows.map(toMirrorRow)
  }

  /**
   * 写入或更新镜像。
   *
   * ⚠️ **本地遗留的 `pending` 要升格、不能被抹掉**：这一条由调用方（启动收敛）保证，
   * 这里只提供 `keepPending` 开关把决定显式化——传 `true` 时，本地是 `pending` 而传入的不是
   * `removed`，就保留本地的 `pending`。
   */
  mirrorUpsert(row: MirrorRow, keepPending = false): void {
    this.assertOpen()
    const existing = keepPending ? this.mirrorGet(row.id) : undefined
    const removalState = existing?.removalState === 'pending' && row.removalState !== 'removed'
      ? 'pending'
      : row.removalState
    this.db.prepare(
      `INSERT INTO conversation_mirror(id, agent_id, owner_namespace, owner_id, title, title_source, ready, pinned, removal_state, deleted_at, updated_at, payload)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         agent_id = excluded.agent_id, owner_namespace = excluded.owner_namespace, owner_id = excluded.owner_id,
         title = excluded.title, title_source = excluded.title_source, ready = excluded.ready,
         pinned = excluded.pinned, removal_state = excluded.removal_state,
         deleted_at = excluded.deleted_at, updated_at = excluded.updated_at,
         payload = excluded.payload`,
    ).run(
      row.id, row.agentId, row.ownerNamespace, row.ownerId, row.title, row.titleSource,
      row.ready ? 1 : 0, row.pinned ? 1 : 0, removalState, row.deletedAt, row.updatedAt,
      JSON.stringify(row.payload ?? {}),
    )
  }

  /** 该 Agent 的镜像里不在给定 id 集合中的行（PG 已经不认它们了，本地要跟着删）。 */
  mirrorStale(keepIds: ReadonlySet<string>): readonly string[] {
    return this.mirrorAll().filter(row => !keepIds.has(row.id)).map(row => row.id)
  }

  mirrorRemove(id: string): void {
    this.assertOpen()
    this.db.prepare('DELETE FROM conversation_mirror WHERE id = ? AND agent_id = ?').run(id, this.agentId)
  }

  // ---------------------------------------------------------------------
  // outbox（围栏 / 标题）
  // ---------------------------------------------------------------------

  /**
   * 取待补写的围栏变更，**按每会话 FIFO**。
   *
   * 为什么是每会话而不是全局：同一个会话上的 `pending → removed` 必须按序补写；跨会话之间
   * 没有顺序要求，按全局 `seq` 取反而会被一个卡住的会话拖住全部。
   * 实现上按 `conversation_id` 分组各取最老的一条——同一会话的后续条目等这条确认后再取。
   */
  fencePending(limit = 100): readonly FenceEntry[] {
    const rows = this.db.prepare(
      `SELECT o.seq, o.conversation_id, o.state FROM fence_outbox o
        WHERE o.agent_id = ?
          AND o.seq = (SELECT min(i.seq) FROM fence_outbox i WHERE i.agent_id = o.agent_id AND i.conversation_id = o.conversation_id)
        ORDER BY o.seq LIMIT ?`,
    ).all(this.agentId, limit) as unknown as Record<string, unknown>[]
    return rows.map(row => ({
      seq: Number(row.seq),
      conversationId: String(row.conversation_id),
      state: String(row.state) as FenceEntry['state'],
    }))
  }

  fenceAck(seq: number): void {
    this.assertOpen()
    this.db.prepare('DELETE FROM fence_outbox WHERE seq = ? AND agent_id = ?').run(seq, this.agentId)
  }

  /**
   * 还有未补写围栏条目的会话集合。
   *
   * 启动收敛用它决定"要不要保留本地的围栏状态"：**outbox 里还有这个会话的条目**，说明
   * 本地那份比 PG 新（PG 那边什么都没有或者还是旧的），不能按 PG 覆盖；条目已经排空，
   * 说明本地状态早就进了 PG，本地就该无条件跟 PG 走。
   */
  fencePendingConversations(): ReadonlySet<string> {
    const rows = this.db.prepare(
      'SELECT DISTINCT conversation_id FROM fence_outbox WHERE agent_id = ?',
    ).all(this.agentId) as unknown as { conversation_id: unknown }[]
    return new Set(rows.map(row => String(row.conversation_id)))
  }

  titlePending(limit = 100): readonly TitleEntry[] {
    const rows = this.db.prepare(
      `SELECT o.seq, o.conversation_id, o.title, o.source FROM title_outbox o
        WHERE o.agent_id = ?
          AND o.seq = (SELECT min(i.seq) FROM title_outbox i WHERE i.agent_id = o.agent_id AND i.conversation_id = o.conversation_id)
        ORDER BY o.seq LIMIT ?`,
    ).all(this.agentId, limit) as unknown as Record<string, unknown>[]
    return rows.map(row => ({
      seq: Number(row.seq),
      conversationId: String(row.conversation_id),
      title: String(row.title),
      source: String(row.source) as TitleEntry['source'],
    }))
  }

  titleAck(seq: number): void {
    this.assertOpen()
    this.db.prepare('DELETE FROM title_outbox WHERE seq = ? AND agent_id = ?').run(seq, this.agentId)
  }

  /** 同一个会话上还没补写的标题条数（用于合并：同一会话只需补最后一条）。 */
  titleDepth(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT count(*) AS total FROM title_outbox WHERE agent_id = ? AND conversation_id = ?',
    ).get(this.agentId, conversationId) as { total?: number | bigint } | undefined
    return Number(row?.total ?? 0)
  }

  /**
   * 投递一次标题更新（`registerConversationTitles` 的同步回调只能走到这里）。
   *
   * 同一会话连续多次更新时**只保留最后一条**：标题是覆盖语义，补写中间态没有意义，
   * 而积压时逐条补写只会拖长收敛时间。
   */
  titleSubmit(conversationId: string, title: string, source: TitleEntry['source']): void {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM title_outbox WHERE agent_id = ? AND conversation_id = ?').run(this.agentId, conversationId)
      this.db.prepare(
        'INSERT INTO title_outbox(agent_id, conversation_id, title, source, created_at) VALUES(?,?,?,?,?)',
      ).run(this.agentId, conversationId, title, source, Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 两个 outbox 的积压状况（健康探针用；超过阈值要记结构化告警并把本 Agent 标为 degraded）。 */
  depth(): { readonly fence: OutboxDepth; readonly title: OutboxDepth } {
    const read = (table: 'fence_outbox' | 'title_outbox'): OutboxDepth => {
      const row = this.db.prepare(
        `SELECT count(*) AS total, min(created_at) AS oldest FROM ${table} WHERE agent_id = ?`,
      ).get(this.agentId) as { total?: number | bigint; oldest?: number | bigint | null } | undefined
      const total = Number(row?.total ?? 0)
      return { depth: total, oldestAt: total === 0 || row?.oldest == null ? undefined : Number(row.oldest) }
    }
    return { fence: read('fence_outbox'), title: read('title_outbox') }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

function toMirrorRow(row: Record<string, unknown>): MirrorRow {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    ownerNamespace: String(row.owner_namespace),
    ownerId: String(row.owner_id),
    title: String(row.title ?? ''),
    titleSource: String(row.title_source ?? 'automatic') as MirrorRow['titleSource'],
    ready: Number(row.ready ?? 0) === 1,
    pinned: Number(row.pinned ?? 0) === 1,
    removalState: String(row.removal_state ?? ''),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    updatedAt: Number(row.updated_at ?? 0),
    // `payload` 是本地列里的 JSON 文本；形状漂移（非对象 / 坏 JSON）一律退化成 `{}`——
    // 载荷损坏不该让这个会话读不出来（读不出来等于整行从侧栏消失）。
    payload: decodeMirrorPayload(row.payload),
  }
}

function decodeMirrorPayload(value: unknown): ConversationPayloadShape {
  if (typeof value !== 'string' || value === '') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as ConversationPayloadShape
      : {}
  } catch {
    return {}
  }
}
