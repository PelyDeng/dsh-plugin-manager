/**
 * 记忆存储（v2.6 设计 §4.3，P1 最小闭环）——`agent_memories` 三表的唯一读写入口。
 *
 * 纪律（违反任何一条都是评审红线）：
 * - **查询红线分层**：注入与工具查询 WHERE 强制三元组等值（agent_id + owner 双列）；
 *   治理查询（面板筛选/统计）owner 等值强制 + agent_id 作过滤维度，禁止跨 owner。
 *   漏 agent_id 的三个后果（串 Agent / 误改他行 / 误列清单）在 `postgres.ts` 对
 *   `dsh_conversations` 的注释里实测在案——本表与它同构（同人多 Agent 共表）。
 * - **原子性收敛在存储层**：唯一约束 + ON CONFLICT（只吞目标约束）、条件 UPDATE + RETURNING、
 *   计数器行锁自增，调用方不拼多步读写（与 `postgres.ts` 头注释同一套哲学）。
 * - **短 id 由计数器表原子分配、永不重置**：「已删编号不复用」由此保证；I/M 序号共用同一
 *   计数器（同列存 `I3` / `M7` 完整字符串，唯一性由 `agent_memories_short_id` 索引兜底）。
 * - **content_hash 规范化是持久化数据格式的一部分**：规则单处实现（本文件 `normalizeContent`），
 *   golden-vector 测试钉死；任何调整都属破坏性变更，需要配套数据迁移说明。
 * - **删除写审计**：forget / delete / purge / update 各插一行不含 content 的审计行
 *   （`agent_memories_audit`），给诱导删除留归因可能。
 * - 全库零触发器：updated_at / importance 联动由本层单入口维护。
 *
 * P1.5 上收 kit 时本文件整体迁出（工厂形态见设计 §6.3），语义逐条等价。
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import { mapStorageError, StorageError, uniqueViolation } from './storage/errors.ts'

/** 记忆归属的智能体：butler 先行（P1），P1.5 起成员经 kit 工厂接入。 */
export type MemoryAgentId = string

/** 记忆大类（v2.4 扩枚举；DB CHECK 同款三值）。 */
export type MemoryKind = 'semantic' | 'episodic' | 'instruction'

/** 来源甄别（v2.5）：老大原话 vs 转述资料——事实形污染的第一道可见性防线。 */
export type MemoryOrigin = 'user_statement' | 'reference'

/** 写入来源：模型显式写 | 用户面板手写。P3 蒸馏加 'distill' 时与迁移、版本升位一起改。 */
export type MemorySource = 'tool' | 'manual'

/** 审计动作：工具遗忘 | 面板删除 | 清空 | 面板编辑。 */
export type MemoryAuditAction = 'forget' | 'delete' | 'purge' | 'update'

export interface MemoryRecord {
  readonly id: string
  readonly agentId: MemoryAgentId
  readonly ownerNamespace: string
  readonly ownerId: string
  readonly shortId: string
  readonly kind: MemoryKind
  readonly content: string
  readonly origin: MemoryOrigin
  readonly importance: number
  readonly source: MemorySource
  readonly sourceRef: string
  readonly expiresAt: number | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

export interface MemoryWriteInput {
  readonly kind: MemoryKind
  readonly content: string
  readonly origin: MemoryOrigin
  /** 1-5；缺省 3。origin='reference' 传 >3 会被 DB CHECK 拒绝（记错代价高原则）。 */
  readonly importance?: number | undefined
  /** 来源会话/任务 id；origin='reference' 时必填（应用层强制，DB 该列可空）。 */
  readonly sourceRef?: string | undefined
  /** 可选过期（毫秒）。 */
  readonly expiresAt?: number | undefined
  /** 可选：被替换条目的短 id。事务内插新行+删旧行；撞防重索引时中止（旧行保留）。 */
  readonly supersedesShortId?: string | undefined
}

export interface MemoryUpdatePatch {
  readonly content?: string | undefined
  readonly importance?: number | undefined
  readonly expiresAt?: number | null | undefined
}

/** 归一化 + 哈希（单点实现；golden-vector 测试钉死，改动属破坏性变更）。 */
export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').normalize('NFC').toLowerCase()
}

export function contentHash(content: string): string {
  return createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex')
}

function ownerOf(actor: { readonly namespace: string; readonly userId: string }): { ownerNamespace: string; ownerId: string } {
  return { ownerNamespace: actor.namespace, ownerId: actor.userId }
}

/** 行 → 记录（与 postgres.ts 的行解析同风格：毫秒 BIGINT 读回 number）。 */
function rowToMemory(row: QueryResultRow): MemoryRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    ownerNamespace: String(row.owner_namespace),
    ownerId: String(row.owner_id),
    shortId: String(row.short_id),
    kind: row.kind as MemoryKind,
    content: String(row.content),
    origin: row.origin as MemoryOrigin,
    importance: Number(row.importance),
    source: row.source as MemorySource,
    sourceRef: String(row.source_ref),
    expiresAt: row.expires_at === null ? undefined : Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

const MEMORY_COLUMNS = `id, agent_id, owner_namespace, owner_id, short_id, kind, content,
  origin, importance, source, source_ref, expires_at, created_at, updated_at`

/** 工具参数红线（设计 §4.4）：模型可见的参数 schema 不含 owner/agent_id/source——它们由服务端推导。 */
export const MEMORY_TOOL_WRITABLE_KINDS = ['semantic', 'episodic'] as const

/** instruction 单条长度上限（面板侧与工具侧同一道第一道防线；DB CHECK 200 字是最后防线）。 */
export const MEMORY_CONTENT_LIMIT = 60

/** 注入查询的物理上界（应用层逐条累加字符数到预算即停，见 `injectQuery`）。 */
const INJECT_HARD_LIMIT = 10
/** 超采样上限：一次取这么多条，内存里先保 semantic 配额再按序填充。 */
const INJECT_OVERSAMPLE = 20
/** semantic 保底配额：偏好被挤掉的代价是行为回退，旧事件被挤掉只是少个上下文。 */
const SEMANTIC_FLOOR = 4

export class MemoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly agentId: MemoryAgentId,
  ) {}

  // ------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------

  /**
   * 写入一条记忆。返回插入的记录；同 kind 同内容已存在时返回 undefined（NOOP，防重）。
   *
   * `supersedesShortId`：锚定被替换条目（「说破更新」的机制载体）。事务内插新行+删旧行；
   * 新内容撞防重索引时**中止整个事务、旧行保留**，抛「与现存记忆重复」——不删旧行
   * （删了=旧记忆没了新记忆没写入，静默丢数据）。
   */
  async write(
    actor: { readonly namespace: string; readonly userId: string },
    input: MemoryWriteInput & { readonly source: MemorySource },
  ): Promise<MemoryRecord | undefined> {
    if (input.kind === 'instruction' && input.source !== 'manual') {
      throw new AccessError(403, 'instruction 只能由用户在设置页手写（模型不能给自己下指令）')
    }
    if (input.origin === 'reference' && (input.sourceRef ?? '') === '') {
      throw new AccessError(400, '转述资料来源的记忆必须带 sourceRef（可溯源），否则不要记')
    }
    const content = input.content.trim()
    if (content.length < 4 || content.length > 200) {
      throw new AccessError(400, `记忆内容须在 4-200 字之间（当前 ${content.length} 字）`)
    }
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // 计数器原子自增（行锁下无并发缝隙；首写用 INSERT … ON CONFLICT 初始化）。
      const counter = await client.query<{ last_n: number }>(
        `INSERT INTO agent_memory_counters (agent_id, owner_namespace, owner_id, last_n)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (agent_id, owner_namespace, owner_id)
         DO UPDATE SET last_n = agent_memory_counters.last_n + 1
         RETURNING last_n`,
        [this.agentId, ownerNamespace, ownerId],
      )
      const serial = Number(counter.rows[0]?.last_n ?? 0)
      if (serial <= 0) throw new Error('agent_memory_counters 自增失败')
      const prefix = input.kind === 'instruction' ? 'I' : 'M'
      const shortId = `${prefix}${serial}`
      const now = Date.now()
      const hash = contentHash(content)

      if (input.supersedesShortId !== undefined) {
        // 替换语义：先看新内容是否撞防重索引（撞则中止，旧行保留），再插新删旧。
        const existing = await client.query(
          `SELECT ${MEMORY_COLUMNS} FROM agent_memories
           WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3
             AND kind = $4 AND content_hash = $5`,
          [this.agentId, ownerNamespace, ownerId, input.kind, hash],
        )
        if (existing.rows.length > 0) {
          await client.query('ROLLBACK')
          throw new AccessError(409, `与现存记忆重复（${String(existing.rows[0].short_id)}），如要替换请改用更新`)
        }
        const superseded = await client.query(
          `DELETE FROM agent_memories
           WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND short_id = $4
           RETURNING id`,
          [this.agentId, ownerNamespace, ownerId, input.supersedesShortId],
        )
        if (superseded.rows.length === 0) {
          await client.query('ROLLBACK')
          throw new AccessError(404, `要替换的记忆 ${input.supersedesShortId} 不存在`)
        }
        await this.insertAudit(client, actor, this.agentId, 'update', String(superseded.rows[0].id), input.supersedesShortId)
      }

      const inserted = await client.query(
        `INSERT INTO agent_memories
           (id, agent_id, owner_namespace, owner_id, short_id, kind, content, content_hash,
            origin, importance, source, source_ref, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (agent_id, owner_namespace, owner_id, kind, content_hash) DO NOTHING
         RETURNING ${MEMORY_COLUMNS}`,
        [
          randomUUID(), this.agentId, ownerNamespace, ownerId, shortId, input.kind, content, hash,
          input.origin, input.importance ?? 3, input.source, input.sourceRef ?? '',
          input.expiresAt ?? null, now, now,
        ],
      )
      if (inserted.rows.length === 0) {
        await client.query('COMMIT')
        return undefined // 同 kind 同内容已存在（防重命中；计数器已自增但编号不复用，无害）
      }
      await client.query('COMMIT')
      return rowToMemory(inserted.rows[0])
    } catch (error) {
      await this.safeRollback(client)
      throw this.rethrow(error)
    } finally {
      client.release()
    }
  }

  /**
   * 面板编辑：条件 UPDATE + RETURNING；content 变更时同语句重算 hash 与 updated_at
   * （否则唯一索引对着假键工作）。跨 agent 行是用户终裁豁免（byAgentId 显式传目标 agent）。
   */
  async update(
    actor: { readonly namespace: string; readonly userId: string },
    memoryId: string,
    patch: MemoryUpdatePatch,
    byAgentId?: MemoryAgentId | undefined,
  ): Promise<MemoryRecord | undefined> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const agentId = byAgentId ?? this.agentId
    const content = patch.content?.trim()
    if (content !== undefined && (content.length < 4 || content.length > 200)) {
      throw new AccessError(400, `记忆内容须在 4-200 字之间（当前 ${content.length} 字）`)
    }
    const now = Date.now()
    const result = await this.pool.query(
      `UPDATE agent_memories SET
         content = COALESCE($4, content),
         content_hash = COALESCE($5, content_hash),
         importance = COALESCE($6, importance),
         expires_at = CASE WHEN $7 THEN $8 ELSE expires_at END,
         updated_at = $9
       WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3
       RETURNING ${MEMORY_COLUMNS}`,
      [
        memoryId, agentId, ownerNamespace,
        content ?? null, content !== undefined ? contentHash(content) : null,
        patch.importance ?? null,
        patch.expiresAt !== undefined, patch.expiresAt ?? null,
        now,
      ],
    )
    if (result.rows.length === 0) return undefined
    await this.insertAudit(this.pool, actor, agentId, 'update', memoryId, String(result.rows[0].short_id))
    return rowToMemory(result.rows[0])
  }

  /**
   * 面板删除（单条与批量；批量逐行插审计）。跨 agent 行是用户终裁豁免。
   * 返回实际删除的条数。
   */
  async delete(
    actor: { readonly namespace: string; readonly userId: string },
    memoryIds: readonly string[],
    byAgentId?: MemoryAgentId | undefined,
  ): Promise<number> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const agentId = byAgentId ?? this.agentId
    if (memoryIds.length === 0) return 0
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      let deleted = 0
      for (const memoryId of memoryIds) {
        const result = await client.query(
          `DELETE FROM agent_memories
           WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3 AND owner_id = $4
           RETURNING short_id`,
          [memoryId, agentId, ownerNamespace, ownerId],
        )
        if (result.rows.length > 0) {
          deleted += 1
          await this.insertAudit(client, actor, agentId, 'delete', memoryId, String(result.rows[0].short_id))
        }
      }
      await client.query('COMMIT')
      return deleted
    } catch (error) {
      await this.safeRollback(client)
      throw this.rethrow(error)
    } finally {
      client.release()
    }
  }

  /**
   * 工具遗忘路径：按短 id 删（先查存在，命中后删+审计）。返回被删记录；不存在返回 undefined。
   * instruction 由调用方（工具层）拒绝——本层不重复校验（单一职责在工具参数校验）。
   */
  async forgetByShortId(
    actor: { readonly namespace: string; readonly userId: string },
    shortId: string,
  ): Promise<MemoryRecord | undefined> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query(
        `SELECT ${MEMORY_COLUMNS} FROM agent_memories
         WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND short_id = $4`,
        [this.agentId, ownerNamespace, ownerId, shortId],
      )
      if (found.rows.length === 0) {
        await client.query('ROLLBACK')
        return undefined
      }
      await client.query(
        `DELETE FROM agent_memories
         WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND short_id = $4`,
        [this.agentId, ownerNamespace, ownerId, shortId],
      )
      await this.insertAudit(client, actor, this.agentId, 'forget', String(found.rows[0].id), shortId)
      await client.query('COMMIT')
      return rowToMemory(found.rows[0])
    } catch (error) {
      await this.safeRollback(client)
      throw this.rethrow(error)
    } finally {
      client.release()
    }
  }

  /** 一键清空（面板，两步确认后调用）：按 owner 清本 agent 的全部记忆 + 计数器保留 + 审计一行。 */
  async purge(actor: { readonly namespace: string; readonly userId: string }): Promise<number> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `DELETE FROM agent_memories WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3`,
        [this.agentId, ownerNamespace, ownerId],
      )
      await this.insertAudit(client, actor, this.agentId, 'purge', '', '')
      await client.query('COMMIT')
      return result.rowCount ?? 0
    } catch (error) {
      await this.safeRollback(client)
      throw this.rethrow(error)
    } finally {
      client.release()
    }
  }

  // ------------------------------------------------------------------
  // 读取
  // ------------------------------------------------------------------

  /** 按 id 精确取（面板编辑回显）。 */
  async byId(
    actor: { readonly namespace: string; readonly userId: string },
    memoryId: string,
    byAgentId?: MemoryAgentId | undefined,
  ): Promise<MemoryRecord | undefined> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const result = await this.pool.query(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories
       WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3 AND owner_id = $4`,
      [memoryId, byAgentId ?? this.agentId, ownerNamespace, ownerId],
    )
    return result.rows.length > 0 ? rowToMemory(result.rows[0]) : undefined
  }

  /** 治理查询（面板列表）：owner 等值强制，agentId 过滤维度可选，kind 过滤可选。 */
  async list(
    actor: { readonly namespace: string; readonly userId: string },
    filter: {
      readonly agentId?: MemoryAgentId | undefined
      readonly kind?: MemoryKind | undefined
    } = {},
  ): Promise<readonly MemoryRecord[]> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const result = await this.pool.query(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories
       WHERE owner_namespace = $1 AND owner_id = $2
         AND ($3::text IS NULL OR agent_id = $3)
         AND ($4::text IS NULL OR kind = $4)
       ORDER BY updated_at DESC, id`,
      [ownerNamespace, ownerId, filter.agentId ?? null, filter.kind ?? null],
    )
    return result.rows.map(rowToMemory)
  }

  /** 全库时点（当前毫秒）之后未过期的条数——过期物理清理前的读侧统计。 */
  async stats(
    actor: { readonly namespace: string; readonly userId: string },
  ): Promise<readonly { agentId: MemoryAgentId; kind: MemoryKind; count: number }[]> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const result = await this.pool.query(
      `SELECT agent_id, kind, count(*)::int AS count FROM agent_memories
       WHERE owner_namespace = $1 AND owner_id = $2
       GROUP BY agent_id, kind ORDER BY agent_id, kind`,
      [ownerNamespace, ownerId],
    )
    return result.rows.map(row => ({ agentId: String(row.agent_id), kind: row.kind as MemoryKind, count: Number(row.count) }))
  }

  /**
   * 注入查询：三元组等值 + 未过期 + **kind 排除 instruction**（指令走独立子段，否则同条
   * 双份注入），top-20 超采样，内存先保 semantic ≥4 再按序填充。
   * 预算（≤1500 渲染整行字符）由注入段组装方逐条累加，本层只负责排序与配额。
   */
  async injectQuery(
    actor: { readonly namespace: string; readonly userId: string },
    now: number,
  ): Promise<readonly MemoryRecord[]> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const result = await this.pool.query(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories
       WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3
         AND kind IN ('semantic','episodic')
         AND (expires_at IS NULL OR expires_at > $4)
       ORDER BY importance DESC, updated_at DESC, id
       LIMIT $5`,
      [this.agentId, ownerNamespace, ownerId, now, INJECT_OVERSAMPLE],
    )
    const rows = result.rows.map(rowToMemory)
    const semantic = rows.filter(row => row.kind === 'semantic')
    const episodic = rows.filter(row => row.kind === 'episodic')
    const picked = semantic.slice(0, SEMANTIC_FLOOR)
    const rest = [
      ...semantic.slice(SEMANTIC_FLOOR),
      ...episodic,
    ].filter(row => !picked.includes(row))
    return [...picked, ...rest].slice(0, INJECT_HARD_LIMIT)
  }

  /** 指令子段查询：全部 instruction（写入端上限 10 条；注入端不参与 top-N 竞争）。 */
  async instructions(
    actor: { readonly namespace: string; readonly userId: string },
    now: number,
  ): Promise<readonly MemoryRecord[]> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    const result = await this.pool.query(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories
       WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3
         AND kind = 'instruction'
         AND (expires_at IS NULL OR expires_at > $4)
       ORDER BY updated_at DESC, id
       LIMIT 10`,
      [this.agentId, ownerNamespace, ownerId, now],
    )
    return result.rows.map(rowToMemory)
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private async insertAudit(
    executor: { query: PoolClient['query'] } | Pool,
    actor: { readonly namespace: string; readonly userId: string },
    agentId: MemoryAgentId,
    action: MemoryAuditAction,
    memoryId: string,
    shortId: string,
  ): Promise<void> {
    const { ownerNamespace, ownerId } = ownerOf(actor)
    await executor.query(
      `INSERT INTO agent_memories_audit (id, owner_namespace, owner_id, agent_id, action, memory_id, short_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), ownerNamespace, ownerId, agentId, action, memoryId, shortId, Date.now()],
    )
  }

  private async safeRollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK')
    } catch {
      // ROLLBACK 失败（连接已断）时无需处理：连接归还池后由池的错误监听兜底。
    }
  }

  private rethrow(error: unknown): unknown {
    const constraint = uniqueViolation(error)
    if (constraint !== undefined && constraint.includes('short_id')) {
      // 理论上不可达（计数器行锁下无并发缝隙）；真发生说明有人绕过本层手插短 id——响亮失败。
      return new StorageConstraintError('短 id 撞号：agent_memory_counters 与写入路径被绕过', { cause: error })
    }
    if (error instanceof AccessError || error instanceof StorageConstraintError) return error
    return mapStorageError(error)
  }
}

/** 短 id 撞号等「不该发生的约束冲突」：不归入可重试，直接暴露。 */
export class StorageConstraintError extends StorageError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('storage_constraint', message, options)
  }
}
