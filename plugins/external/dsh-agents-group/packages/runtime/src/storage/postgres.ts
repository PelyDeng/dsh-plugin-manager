/**
 * PostgreSQL 侧：框架级会话索引（`dsh_conversations`）与轮次幂等（`dsh_turns`）。
 *
 * ## 这里的每一处都踩过坑，注释里写了原因
 *
 * - **`agent_id` 是必填且无默认值**：漏写直接 23502。更要紧的是**每一个查询都要带它**——
 *   三张 `dsh_*` 表是所有 Agent 共用的，而 `(owner_namespace, owner_id)` 只区分**人**、
 *   不区分 Agent；漏了就跨 Agent 串数据（实测：管家侧栏会列出别的 Agent 的会话）。
 * - **`ON CONFLICT` 必须重复部分唯一索引的谓词**：`WHERE request_id <> ''`，否则 PG 报
 *   **42P10**（"没有匹配 ON CONFLICT 规格的唯一约束"）。
 * - **`assertSchema` 只核验、不建表**：建表由建库脚本一次性完成（`private-deploy/db/0001_init.sql`）。
 *   缺表 → `storage_schema_missing`，版本不符 → `storage_schema_version`，两者都**拒绝服务**。
 * - **版本比较分两种**（设计 §3.1）：`runtime` 那一行用 **库版本 ≥ 插件内联版本**（用严格相等
 *   会让 rolling 升级期间"库已升、某个插件还没升"的**所有旧插件一起拒绝启动**）；
 *   本 Agent 自己的那一行用**严格相等**（同一插件的表只有它自己写，不存在异构共存）。
 *
 * ⚠️ 本文件**不实现 `record` / `mark`**：它们是同步契约，只能由本地围栏面（`local.ts`）提供，
 * 由门面（`index.ts`）组合。`managed` 也不在这里——它要用 kit 的 `conversationRemover`，
 * 属于 adapter 的职责。
 */
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import { StorageError, mapStorageError, uniqueViolation } from './errors.ts'
import type {
  AgentDatabasePort,
  ConversationPageShape,
  ConversationPort,
  ConversationQueryShape,
  ConversationRecordShape,
  ManagedConversationShape,
  OwnerKey,
} from './ports.ts'

/** 语句/锁上限（连接启动参数注入）。与 blog / 管家同一套取值。 */
const STATEMENT_TIMEOUT_MS = 5000
const LOCK_TIMEOUT_MS = 2000

/** 本运行时内联的结构版本；与 `dsh_schema_versions` 的 `runtime` 行比较时用 **≥**。 */
export const RUNTIME_SCHEMA_VERSION = 1

/** `dsh_*` 框架表；缺任何一张都拒绝服务。 */
const FRAMEWORK_TABLES = ['dsh_schema_versions', 'dsh_conversations', 'dsh_turns', 'dsh_turn_results'] as const

/** PG 侧能独立完成的那部分：`record` / `mark` 走本地同步面，`managed` 走 adapter。 */
export type PgConversationPart = Omit<ConversationPort, 'record' | 'mark' | 'managed'>

interface ConversationRow extends QueryResultRow {
  readonly id: string
  readonly title: string
  readonly titleSource: string
  readonly ready: boolean
  readonly pinned: boolean
  readonly removalState: string
  readonly deletedAt: string | number | null
  readonly updatedAt: string | number
  readonly state?: string
}

function toRecord(row: ConversationRow): ConversationRecordShape {
  return {
    id: row.id,
    title: row.title,
    updatedAt: Number(row.updatedAt),
    deletedAt: row.deletedAt === null ? null : Number(row.deletedAt),
    removalState: row.removalState,
    ready: row.ready === true,
  }
}

/**
 * `title_source` 列的取值收敛成端口的三态。
 *
 * 列本身有 CHECK 约束（`0001_init.sql:98`），但**端口这一侧的承诺不能依赖"库里一定是对的"**：
 * 消费方只看 `!== 'automatic'`（`closedoff/web/app.js` 判要不要停止首句标题刷新），任何认不出的
 * 值都会被当成"人工标题"而**永久停掉刷新**。所以认不出的一律收敛成 `automatic`（= 允许被覆盖）。
 *
 * 镜像侧（`index.ts` 的 `reconcileMirror`）用的是同一个函数：两处若各写一份，迟早漂移成
 * "侧栏说 manual、镜像说 automatic"，而那种不一致只在重启后显现。
 */
export function toTitleSource(value: unknown): 'automatic' | 'generated' | 'manual' {
  return value === 'manual' || value === 'generated' ? value : 'automatic'
}

export class PgConversations implements PgConversationPart {
  constructor(
    private readonly scoped: ScopedDatabase,
    readonly agentId: string,
  ) {}

  /** 会话归属——授权判据。返回 `undefined` 表示不存在或不属于该 owner。 */
  async conversationOf(owner: OwnerKey, conversationId: string) {
    const rows = await this.scoped.query<{ id: string }>(
      `SELECT id FROM dsh_conversations
        WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3 AND owner_id = $4`,
      [conversationId, this.agentId, owner.namespace, owner.userId],
    )
    const row = rows[0]
    return row === undefined
      ? undefined
      : { conversationId: row.id, agentId: this.agentId, owner }
  }

  /**
   * **预留段**：插入一行归属（`ready = false`）。
   *
   * 幂等：`requestId` 非空时靠 `dsh_conversations_request` 这个**部分**唯一索引去重，
   * 冲突后 `SELECT` 回既有行——同一个 `requestId` 再来一次返回原来那条，不新建。
   */
  async create(owner: OwnerKey, conversationId: string, requestId: string,
    initial?: { readonly title?: string }): Promise<ConversationRecordShape> {
    const now = Date.now()
    const title = initial?.title ?? ''
    // ⚠️ `agent_id` 必须显式写（无默认值）；`ON CONFLICT` 的目标必须**重复谓词**否则 42P10。
    await this.scoped.query(
      `INSERT INTO dsh_conversations(id, agent_id, owner_namespace, owner_id, request_id, title, title_source, ready, pinned, removal_state, created_at, updated_at, payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,FALSE,FALSE,'',$8,$8,'{}'::jsonb)
       ON CONFLICT (agent_id, owner_namespace, owner_id, request_id) WHERE request_id <> '' DO NOTHING`,
      [conversationId, this.agentId, owner.namespace, owner.userId, requestId, title,
        // 判定复用上一行算好的 `title`（= `initial?.title ?? ''`），两者必须**同源**。
        // 只看 `undefined` 会把空串当成人工标题：生产路径传的正是 `{ title: '' }`
        // （`conversation.ts` 新建会话处），于是每次新建都落 `manual`，`syncTitle(..., 'automatic')`
        // 被 `title_source = 'automatic'` 守卫拒绝 ⇒ 侧栏标题永久为空。
        title === '' ? 'automatic' : 'manual', now],
    )
    const existing = await this.readByRequest(owner, requestId)
    if (existing !== undefined) return existing
    const rows = await this.scoped.query<ConversationRow>(
      `SELECT id, title, title_source AS "titleSource", ready, pinned, removal_state AS "removalState",
              deleted_at AS "deletedAt", updated_at AS "updatedAt"
         FROM dsh_conversations WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3 AND owner_id = $4`,
      [conversationId, this.agentId, owner.namespace, owner.userId],
    )
    const row = rows[0]
    if (row === undefined) throw new StorageError('storage_unknown', '创建会话后读不回该行')
    return toRecord(row)
  }

  private async readByRequest(owner: OwnerKey, requestId: string): Promise<ConversationRecordShape | undefined> {
    if (requestId === '') return undefined
    const rows = await this.scoped.query<ConversationRow>(
      `SELECT id, title, title_source AS "titleSource", ready, pinned, removal_state AS "removalState",
              deleted_at AS "deletedAt", updated_at AS "updatedAt"
         FROM dsh_conversations
        WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND request_id = $4`,
      [this.agentId, owner.namespace, owner.userId, requestId],
    )
    const row = rows[0]
    return row === undefined ? undefined : toRecord(row)
  }

  /** **发布段**：`ready` 翻真——会话从此在侧栏可见、可以发消息。 */
  async publish(owner: OwnerKey, conversationId: string): Promise<void> {
    await this.scoped.query(
      `UPDATE dsh_conversations SET ready = TRUE, updated_at = $1
        WHERE id = $2 AND agent_id = $3 AND owner_namespace = $4 AND owner_id = $5`,
      [Date.now(), conversationId, this.agentId, owner.namespace, owner.userId],
    )
  }

  /**
   * 协作任务的会话寻址：**派生的 requestId**（不是会话 id——会话 id 是 `randomUUID()`）。
   *
   * 含 `agentId`，避免跨 Agent 撞键：同一个 missionId 派给两个 Agent 是两张不同的会话。
   */
  missionRequestId(owner: OwnerKey, missionId: string): string {
    // 与 blog 既有实现同形（`'pirate-conversation-' + digest({missionId})` 的语义迁移），
    // 但**带上 agentId 与 owner**——原先那个只哈希 missionId，跨 Agent/跨用户会撞。
    return `mission:${this.agentId}:${owner.namespace}:${owner.userId}:${missionId}`
  }

  /**
   * 侧栏列表。
   *
   * 逐条复刻 kit 的 `queryConversationIndex` 语义（那是 SQLite 版，两边必须给出同一套
   * 5 态 state 机与同一套 busy/archived 过滤，否则侧栏的状态标签会错位）：
   *
   * - `state`：`pending` / `failed`（围栏态优先）→ `busy`（在传进来的集合里）→ `legacy`
   *   （已删除但没标记移除）→ `ready`；
   * - 过滤掉 `removal_state = 'removed'`；
   * - 已删除且**未被归档**的行也不出现（它们等着被清）；
   * - 搜索是 `strpos(lower(...), lower($q))`（与 SQLite 的 `instr(lower(),lower())` 对应）。
   */
  async list(owner: OwnerKey, query: ConversationQueryShape,
    scope: { readonly busy: readonly string[]; readonly archived: readonly string[] }): Promise<ConversationPageShape> {
    const values: unknown[] = [this.agentId, owner.namespace, owner.userId, scope.busy, scope.archived]
    const filters = [
      'agent_id = $1', 'owner_namespace = $2', 'owner_id = $3',
      // ⚠️ `ready` 是**陷阱列**：它是"可见 / 可删"的门，三个消费方都靠它（列表过滤、移除围栏
      // 的 409、`conversation-store.ts:63/99`）。kit 那套是把 `ready = 1` 放在**调用方提供的
      // source SQL** 里的，所以这里必须自己写——漏了它，预留段（`ready = false`）的会话会
      // 出现在侧栏里，点进去既不能发消息也不能删。
      'ready = TRUE',
      `removal_state <> 'removed'`,
      // 已删除且未被归档：不出现（与 kit 的实现一致）。
      `NOT (deleted_at IS NOT NULL AND removal_state = '' AND id = ANY($5::text[]))`,
    ]
    if (query.q !== '') {
      values.push(query.q)
      filters.push(`(strpos(lower(title), lower($${values.length})) > 0 OR strpos(lower(id), lower($${values.length})) > 0)`)
    }
    if (query.from !== undefined) {
      values.push(query.from)
      filters.push(`updated_at >= $${values.length}`)
    }
    if (query.to !== undefined) {
      values.push(query.to)
      filters.push(`updated_at < $${values.length}`)
    }
    // 状态过滤必须**下推到 SQL**：在 JS 里过滤会让每页条数少于 limit，`nextOffset` 跟着算错。
    values.push(query.state)
    const stateIndex = values.length
    const visible = `SELECT id, title, pinned, title_source AS "titleSource", updated_at,
        CASE
          WHEN removal_state = 'pending' THEN 'pending'
          WHEN removal_state = 'failed' THEN 'failed'
          WHEN id = ANY($4::text[]) THEN 'busy'
          WHEN deleted_at IS NOT NULL THEN 'legacy'
          ELSE 'ready' END AS state
      FROM dsh_conversations WHERE ${filters.join(' AND ')}`
    const stateFilter = `($${stateIndex}::text = '' OR state = $${stateIndex}::text)`
    const counted = await this.scoped.query<{ total: string | number }>(
      `SELECT count(*) AS total FROM (${visible}) AS v WHERE ${stateFilter}`,
      values,
    )
    const total = Number(counted[0]?.total ?? 0)
    const rows = await this.scoped.query<ConversationRow>(
      // `pinned` / `"titleSource"` 是**给业务页面看的**（kit 侧栏忽略，见 `ports.ts` 的
      // `ManagedConversationShape`）：`pinned` 同时还是排序键，`title_source` 则决定业务页面
      // 要不要停止首句标题刷新。两列本来就在 `visible` 里，这里只是把它们带出到投影上。
      `SELECT id, title, pinned, "titleSource", updated_at AS "updatedAt", state FROM (${visible}) AS v
        WHERE ${stateFilter}
        ORDER BY pinned DESC, updated_at DESC, id
        LIMIT $${stateIndex + 1} OFFSET $${stateIndex + 2}`,
      [...values, query.limit, query.offset],
    )
    const items: ManagedConversationShape[] = rows.map(row => ({
      id: row.id,
      title: row.title,
      updatedAt: Number(row.updatedAt),
      state: String(row.state),
      canRemove: row.state !== 'busy' && row.state !== 'pending',
      pinned: row.pinned === true,
      titleSource: toTitleSource(row.titleSource),
      ...(row.state === 'busy'
        ? { blockedReason: '会话正在运行或有未完成操作，请先处理或等待完成' }
        : row.state === 'pending'
          ? { blockedReason: '上一次移除还没完成，请稍后重试' }
          : {}),
    }))
    return {
      items,
      total,
      nextOffset: query.offset + items.length < total ? query.offset + items.length : null,
    }
  }

  /**
   * 标题投影。
   *
   * **自动标题不覆盖手动标题**：只有当前 `title_source = 'automatic'`（或本次来源是 `manual`）
   * 才写。这是"自动结果不覆盖手动、分支和既有标题"那条约定的落点，与 kit 的
   * `registerConversationTitles` 语义配套。
   */
  async syncTitle(owner: OwnerKey, conversationId: string, title: string,
    source: 'automatic' | 'generated' | 'manual'): Promise<void> {
    await this.scoped.query(
      `UPDATE dsh_conversations SET title = $1, title_source = $2
        WHERE id = $3 AND agent_id = $4 AND owner_namespace = $5 AND owner_id = $6
          AND ready = TRUE AND deleted_at IS NULL AND removal_state = ''
          AND (title_source = 'automatic' OR $2 = 'manual')`,
      [title, source, conversationId, this.agentId, owner.namespace, owner.userId],
    )
  }

  /**
   * 置顶标记。
   *
   * 一条 `UPDATE` 完成，条件与参数顺序照抄 `publish` / `syncTitle`：`id` + `agent_id` +
   * `owner_namespace` + `owner_id` 四列 AND。**归属与存在性全靠它**——不加预查询，也不在
   * 调用方另判一次：两套判定必然漂移，而漂移表现为"点了没反应"。
   *
   * 与 `syncTitle` 不同，这里**没有** `ready` / `deleted_at` / `removal_state` 守卫：置顶是纯
   * 展示状态（未发布的会话本来就不在侧栏里），拦一道只会多一个调用方要处理的失败分支。
   *
   * `updated_at` 一起推进是刻意的：列表排序是 `pinned DESC, updated_at DESC, id`，置顶要立刻
   * 生效就得让这一行"变新"。
   */
  async pin(owner: OwnerKey, conversationId: string, pinned: boolean): Promise<void> {
    await this.scoped.query(
      `UPDATE dsh_conversations SET pinned = $1, updated_at = $2
        WHERE id = $3 AND agent_id = $4 AND owner_namespace = $5 AND owner_id = $6`,
      [pinned, Date.now(), conversationId, this.agentId, owner.namespace, owner.userId],
    )
  }
}

/** 轮次幂等与待答问题（`dsh_turns`）。 */
export class PgTurns {
  constructor(
    private readonly scoped: ScopedDatabase,
    readonly agentId: string,
  ) {}

  /**
   * 认领一轮。
   *
   * - 插入成功 → `'claimed'`；
   * - 已有同 `requestId` 的行 → 比对 `inputHash`：相同 → `'duplicate'`；不同 → 409
   *   （同一次受理换了正文，必须报冲突而不是重跑——那会让带副作用的活干两遍）。
   */
  async claim(owner: OwnerKey, conversationId: string, requestId: string, inputHash: string)
    : Promise<'claimed' | 'duplicate'> {
    if (requestId === '') throw new AccessError(400, '轮次缺少幂等身份（requestId）')
    const now = Date.now()
    const inserted = await this.scoped.query<{ id: string }>(
      `INSERT INTO dsh_turns(id, agent_id, owner_namespace, owner_id, conversation_id, request_id, input_hash, status, created_at, payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,'claimed',$8,'{}'::jsonb)
       ON CONFLICT (agent_id, owner_namespace, owner_id, request_id) WHERE request_id <> '' DO NOTHING
       RETURNING id`,
      [randomUUID(), this.agentId, owner.namespace, owner.userId, conversationId, requestId, inputHash, now],
    )
    if (inserted.length > 0) return 'claimed'
    const existing = await this.scoped.query<{ inputHash: string }>(
      `SELECT input_hash AS "inputHash" FROM dsh_turns
        WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND request_id = $4`,
      [this.agentId, owner.namespace, owner.userId, requestId],
    )
    const row = existing[0]
    if (row === undefined) return 'claimed'
    if (row.inputHash !== inputHash) {
      throw new AccessError(409, '同一个请求标识不能换正文')
    }
    return 'duplicate'
  }

  /** 这一轮跑完了。 */
  async finish(owner: OwnerKey, requestId: string): Promise<void> {
    if (requestId === '') return
    await this.scoped.query(
      `UPDATE dsh_turns SET status = 'finished'
        WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND request_id = $4`,
      [this.agentId, owner.namespace, owner.userId, requestId],
    )
  }

  /**
   * 这一轮的状态；没有行时 `undefined`。
   *
   * `claim` 的 `'duplicate'` 分不清"已交付"与"崩溃中断"，接线时必须配合本方法才有正确语义：
   * `finished` ⇒ 不重跑；`claimed` ⇒ 上一轮中断，允许重跑。
   */
  async turnStatus(owner: OwnerKey, requestId: string): Promise<'claimed' | 'finished' | undefined> {
    if (requestId === '') return undefined
    const rows = await this.scoped.query<{ status: string }>(
      `SELECT status FROM dsh_turns
        WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND request_id = $4`,
      [this.agentId, owner.namespace, owner.userId, requestId],
    )
    const status = rows[0]?.status
    return status === 'claimed' || status === 'finished' ? status : undefined
  }

  /**
   * 这个会话在等用户回什么。
   *
   * 取该会话**最新**一条带 `question` 的行：等待可能发生多次（回一句、又等一句），
   * 只有最后那次是"此刻在等的"。
   */
  async pendingQuestion(owner: OwnerKey, conversationId: string): Promise<string | undefined> {
    const rows = await this.scoped.query<{ question: string | null }>(
      `SELECT payload->>'question' AS question FROM dsh_turns
        WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND conversation_id = $4
          AND payload ? 'question'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [this.agentId, owner.namespace, owner.userId, conversationId],
    )
    const question = rows[0]?.question
    return question === null || question === undefined || question === '' ? undefined : question
  }

  /**
   * 记下"在等什么"；传 `undefined` 表示不再等待。
   *
   * 落一行 `request_id = ''` 的 turn：它没有幂等语义（部分唯一索引排除空串，所以可以有多条），
   * 只承载"这一轮在等什么"。**不能只留在内存**——协调侧要求重启后仍能恢复等待上下文，
   * 否则 `prepareReply` 会直接报 `waiting_expired`，子任务永远停在 `waiting_user`。
   */
  async setPendingQuestion(owner: OwnerKey, conversationId: string, question: string | undefined): Promise<void> {
    if (question === undefined || question === '') {
      await this.scoped.query(
        `UPDATE dsh_turns SET payload = payload - 'question'
          WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND conversation_id = $4
            AND payload ? 'question'`,
        [this.agentId, owner.namespace, owner.userId, conversationId],
      )
      return
    }
    await this.scoped.query(
      `INSERT INTO dsh_turns(id, agent_id, owner_namespace, owner_id, conversation_id, request_id, input_hash, status, created_at, payload)
       VALUES($1,$2,$3,$4,$5,'','','waiting',$6,jsonb_build_object('question', $7::text))`,
      [randomUUID(), this.agentId, owner.namespace, owner.userId, conversationId, Date.now(), question],
    )
  }

  // —— 供门面的启动收敛使用（不属于 TurnStorePort 的公开面）——

  /** 把本 Agent 遗留的 `pending` 围栏翻成 `failed`（"请求过移除但没跑完"）。 */
  async failStalePending(): Promise<number> {
    const rows = await this.scoped.query<{ id: string }>(
      `UPDATE dsh_conversations SET removal_state = 'failed'
        WHERE agent_id = $1 AND removal_state = 'pending' RETURNING id`,
      [this.agentId],
    )
    return rows.length
  }

  /** 按 id 读回一行（门面做本地镜像收敛时用；**含未发布的与已移除的**）。 */
  async readForMirror(ids: readonly string[]): Promise<readonly ConversationRecordShape[]> {
    if (ids.length === 0) return []
    const rows = await this.scoped.query<ConversationRow>(
      `SELECT id, title, title_source AS "titleSource", ready, pinned, removal_state AS "removalState",
              deleted_at AS "deletedAt", updated_at AS "updatedAt"
         FROM dsh_conversations WHERE agent_id = $1 AND id = ANY($2::text[])`,
      [this.agentId, [...ids]],
    )
    return rows.map(toRecord)
  }
}

/**
 * 数据访问的作用域：要么是池（自动取连接），要么是某个事务里的连接。
 *
 * 事务内的 `ScopedDatabase` 复用同一个 client，所以嵌套 `transaction()` 会**加入外层事务**
 * 而不是开新事务（PG 不支持真正的嵌套事务；用 SAVEPOINT 的收益在这里不值那份复杂度）。
 */
export class ScopedDatabase {
  constructor(private readonly source: Pool | PoolClient, private readonly transactional: boolean) {}

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    try {
      const result = await this.source.query(sql, values as unknown[])
      return result.rows as T[]
    } catch (error) {
      throw mapStorageError(error)
    }
  }

  /** 当前作用域是否已在事务里。 */
  get inTransaction(): boolean { return this.transactional }

  /** 在同一个作用域上执行事务；已在事务里时直接跑（加入外层）。 */
  async transaction<T>(fn: (tx: ScopedDatabase) => Promise<T>): Promise<T> {
    if (this.transactional) return fn(this)
    const client = await (this.source as Pool).connect()
    try {
      await client.query('BEGIN')
      const result = await fn(new ScopedDatabase(client, true))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { /* 回滚失败不掩盖原始错误 */ })
      throw mapStorageError(error)
    } finally {
      client.release()
    }
  }
}

/**
 * PG 门面：实现 `AgentDatabasePort` 里**可以纯异步完成**的那部分。
 *
 * `record` / `mark`（同步契约）由本地围栏面提供，`managed`（要用 kit 的 `conversationRemover`）
 * 由 adapter 提供——三者由 `index.ts` 组合成一个完整的 `AgentDatabasePort`。
 */
export class PostgresAgentDatabase implements Omit<AgentDatabasePort, 'conversations'> {
  private readonly pool: Pool
  private readonly scoped: ScopedDatabase
  private readyError: StorageError | undefined
  private closed = false
  private inited = false
  readonly conversations: PgConversations
  readonly turns: PgTurns

  constructor(
    dsn: string,
    readonly agentId: string,
    /** 本 Agent 业务表的结构版本；与它自己的版本行做**严格相等**比较。 */
    readonly agentVersion: number = 1,
    /** 插件内联的运行时版本；与 `runtime` 版本行做 **≥** 比较。 */
    readonly runtimeVersion: number = RUNTIME_SCHEMA_VERSION,
    onError?: (error: Error) => void,
  ) {
    this.pool = new Pool({
      connectionString: dsn,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      // 语句/锁超时走连接启动参数（服务端 -c），不额外发 SET：'connect' 钩子里 fire-and-forget
      // 的 SET 会与该连接上的首个业务语句并发（pg 弃用警告，pg@9 起不再允许）。
      options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${LOCK_TIMEOUT_MS}`,
    })
    // 空闲连接的后台错误若无人监听会成为宿主 uncaughtException。
    this.pool.on('error', onError ?? ((error: Error) => { console.error('agents-group/runtime: PostgreSQL 连接池错误', error) }))
    this.scoped = new ScopedDatabase(this.pool, false)
    this.conversations = new PgConversations(this.scoped, agentId)
    this.turns = new PgTurns(this.scoped, agentId)
  }

  /**
   * 只核验、不建表。
   *
   * 三件事：框架表存在 → `runtime` 版本 **≥** 内联版本 → 本 Agent 版本**严格相等**。
   * 失败时记下同一个错误，之后所有读写都以它拒绝（未就绪即不服务）。
   */
  async assertSchema(): Promise<void> {
    this.assertOpen()
    try {
      const found = await this.scoped.query<{ tab: string }>(
        `SELECT t.tab FROM unnest($1::text[]) AS t(tab) WHERE to_regclass('public.' || t.tab) IS NOT NULL`,
        [[...FRAMEWORK_TABLES]],
      )
      const present = new Set(found.map(row => row.tab))
      const missing = FRAMEWORK_TABLES.filter(table => !present.has(table))
      if (missing.length > 0) {
        throw new StorageError('storage_schema_missing', `存储结构缺失，缺少表：${missing.join('、')}；请先执行建库脚本`)
      }
      const versions = await this.scoped.query<{ pluginId: string; version: number | string }>(
        'SELECT plugin_id AS "pluginId", version FROM dsh_schema_versions WHERE plugin_id = ANY($1::text[])',
        [[this.agentId, 'runtime']],
      )
      const byId = new Map(versions.map(row => [row.pluginId, Number(row.version)]))
      if (!byId.has('runtime')) {
        throw new StorageError('storage_schema_version', 'dsh_schema_versions 缺少 runtime 那一行，无法确认框架表版本')
      }
      const runtimeVersion = byId.get('runtime')!
      if (runtimeVersion < this.runtimeVersion) {
        throw new StorageError('storage_schema_version',
          `框架表版本过低：库 ${runtimeVersion} < 插件内联 ${this.runtimeVersion}；请先跑建库/升级入口`)
      }
      if (!byId.has(this.agentId)) {
        throw new StorageError('storage_schema_version', `dsh_schema_versions 缺少 ${this.agentId} 的版本行`)
      }
      const agentVersion = byId.get(this.agentId)!
      if (agentVersion !== this.agentVersion) {
        throw new StorageError('storage_schema_version',
          `不支持的数据结构版本：${agentVersion}（期望 ${this.agentVersion}）`)
      }
      this.inited = true
      this.readyError = undefined
    } catch (error) {
      const mapped = error instanceof StorageError ? error : mapStorageError(error)
      const failure = mapped instanceof StorageError ? mapped : new StorageError('storage_unknown', '存储初始化失败', { cause: error })
      this.readyError = failure
      throw failure
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageError('storage_closed', '存储已关闭')
    if (this.readyError !== undefined && this.inited) throw this.readyError
  }

  /** 未就绪即不服务：所有读写先过这一关。 */
  private assertReady(): void {
    this.assertOpen()
    if (this.readyError !== undefined) throw this.readyError
    if (!this.inited) throw new StorageError('storage_unknown', '存储尚未完成结构核验')
  }

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.assertReady()
    return this.scoped.query<T>(sql, values)
  }

  async transaction<T>(fn: (tx: AgentDatabasePort) => Promise<T>): Promise<T> {
    this.assertReady()
    return this.scoped.transaction(async tx => fn(this.scopedFacade(tx)))
  }

  /**
   * 事务内的门面：`query` 与异步会话/轮次方法都走**同一条事务连接**。
   *
   * `record` / `mark` / `managed` 在事务里没有对应物（前两个是同步契约、由本地围栏面提供，
   * 第三个属于 adapter），所以给一个**会抛错**的实现而不是静默返回空值——静默会让"在事务里
   * 误用同步围栏"变成难以察觉的数据问题。
   */
  private scopedFacade(tx: ScopedDatabase): AgentDatabasePort {
    const scoped = new PgConversations(tx, this.agentId)
    const outOfScope = (what: string): never => {
      throw new AccessError(503,
        `事务内不支持 ${what}：它要么是同步契约（record / mark，由本地围栏面提供），要么属于 adapter（managed）`)
    }
    const conversations: ConversationPort = {
      agentId: this.agentId,
      conversationOf: (owner, id) => scoped.conversationOf(owner, id),
      create: (owner, id, requestId, initial) => scoped.create(owner, id, requestId, initial),
      publish: (owner, id) => scoped.publish(owner, id),
      missionRequestId: (owner, missionId) => scoped.missionRequestId(owner, missionId),
      list: (owner, query, scope) => scoped.list(owner, query, scope),
      syncTitle: (owner, id, title, source) => scoped.syncTitle(owner, id, title, source),
      // 置顶是一条普通 `UPDATE`，事务内可以直接跑（不像 record / mark 是同步契约、managed 属于 adapter）。
      pin: (owner, id, pinned) => scoped.pin(owner, id, pinned),
      managed: () => outOfScope('managed'),
      record: () => outOfScope('record'),
      mark: () => outOfScope('mark'),
    }
    return {
      assertSchema: () => Promise.resolve(),
      conversations,
      turns: new PgTurns(tx, this.agentId),
      query: <T>(sql: string, values: readonly unknown[] = []) => tx.query<T>(sql, values),
      transaction: <T>(fn: (inner: AgentDatabasePort) => Promise<T>) => tx.transaction(inner => fn(this.scopedFacade(inner))),
      close: () => Promise.resolve(),
    }
  }

  /** 供门面直接拿作用域（启动收敛要在一个事务里做多步）。 */
  scope(): ScopedDatabase {
    this.assertReady()
    return this.scoped
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }
}

/** 供测试与调用方判断唯一约束冲突。 */
export { uniqueViolation }
