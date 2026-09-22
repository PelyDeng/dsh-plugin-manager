/**
 * 站点级记忆存储（P1.5 自 butler `src/memories.ts` 上收，v2.6 设计 §4.3/§6.3）。
 *
 * 纪律（改动前先读设计文档对应节）：
 * - **kit 零数据库依赖**：本模块不 import `pg`——执行器由调用方注入（`MemoryExecutor`），
 *   连接池/超时/'error' 监听全部留在插件侧复用各自既有实现；kit 只拥有 SQL 文本与
 *   规范化逻辑（设计 §6.3：宿主运行实现保持外部依赖）。
 * - **查询红线分层**：注入与工具查询 WHERE 强制三元组等值（agent_id + owner 双列）；
 *   治理查询 owner 等值强制 + agent_id 作过滤维度，禁止跨 owner。跨 agent 行写入是
 *   「用户终裁豁免」（治理面板以用户身份代管全 agent 行，显式传 byAgentId）。
 * - **原子性收敛在存储层**：唯一约束 + ON CONFLICT（只吞目标约束）、条件 UPDATE +
 *   RETURNING、计数器行锁自增，调用方不拼多步读写。
 * - **短 id 由计数表原子分配、永不重置**；I/M 序号共用计数器（同列存完整字符串）。
 * - **content_hash 规范化是持久化数据格式的一部分**：规则单点实现（normalizeContent），
 *   golden-vector 测试钉死；调整属破坏性变更，需配套数据迁移说明。
 * - **删除写审计**：forget/delete/purge/update 各插一行不含 content 的审计行。
 * - 全库零触发器：updated_at / importance 联动由本层单入口维护。
 *
 * 表（`private-deploy/db/0004_agent_memories.sql`，站点级跨插件共享，版本行
 * `('agent-memories', N)`——消费插件启动核验走 `verifyAgentMemoriesSchema`）。
 */

import { randomUUID, createHash } from 'node:crypto'
import { AccessError } from './access.ts'

/** 记忆大类（DB CHECK 同款三值）。 */
export type MemoryKind = 'semantic' | 'episodic' | 'instruction'
/** 来源甄别（v2.5）：老大原话 vs 转述资料。 */
export type MemoryOrigin = 'user_statement' | 'reference'
/** 写入来源：模型显式写 | 用户面板手写。P3 蒸馏加 'distill' 时与迁移、版本升位一起改。 */
export type MemorySource = 'tool' | 'manual' | 'distill'
/** 审计动作。 */
export type MemoryAuditAction = 'forget' | 'delete' | 'purge' | 'update'

export interface MemoryRecord {
  readonly id: string
  readonly agentId: string
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
  readonly importance?: number | undefined
  readonly sourceRef?: string | undefined
  readonly expiresAt?: number | undefined
  /** 被替换条目的短 id：事务内插新行+删旧行；撞防重索引中止（旧行保留）。 */
  readonly supersedesShortId?: string | undefined
}

export interface MemoryUpdatePatch {
  readonly content?: string | undefined
  readonly importance?: number | undefined
  readonly expiresAt?: number | null | undefined
}

/** 注入执行器：kit 不持有连接池——由插件把既有池适配成这两个方法。 */
export interface MemoryQueryResult {
  rows: Array<Record<string, unknown>>
  rowCount: number | null
}

/** 注入执行器：kit 不持有连接池——由调用方注入（插件侧适配既有池）。 */
export interface MemoryExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<MemoryQueryResult>
  withTransaction<T>(work: (tx: MemoryExecutor) => Promise<T>): Promise<T>
}

/** 共享表版本登记常量（核验口径见 verifyAgentMemoriesSchema）。 */
export const AGENT_MEMORIES_PLUGIN_ID = 'agent-memories'
export const AGENT_MEMORIES_SCHEMA_VERSION = 1
/** 防重与短 id 正确性依赖的两个唯一索引（核验面包含它们）。 */
export const AGENT_MEMORIES_INDEXES = ['agent_memories_dedup', 'agent_memories_short_id'] as const

/** 工具参数红线（§4.4）：模型可见 schema 不含 owner/agent_id/source——服务端推导。 */
export const MEMORY_TOOL_WRITABLE_KINDS = ['semantic', 'episodic'] as const
/** 面板/工具第一道长度防线（DB CHECK 200 字是最后防线）。 */
export const MEMORY_CONTENT_LIMIT = 60
/** 注入硬上界与 semantic 保底（§4.5 辖域定案：1500 字符是记忆清单子段预算）。 */
export const MEMORY_INJECT_HARD_LIMIT = 10
export const MEMORY_INJECT_OVERSAMPLE = 20
export const MEMORY_SEMANTIC_FLOOR = 4
export const MEMORY_SECTION_BUDGET = 1500
export const MEMORY_INSTRUCTION_LIMIT = 10

/** 归一化（trim + 连续空白折叠 + NFC + lower）——单点实现，golden-vector 钉死。 */
export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').normalize('NFC').toLowerCase()
}

/** 规范化文本的 sha256 hex（防重硬键）。 */
export function contentHash(content: string): string {
  return createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex')
}

export interface MemoryActor {
  readonly namespace: string
  readonly userId: string
}

interface MemoryRow extends Record<string, unknown> {
  id: unknown
  agent_id: unknown
  owner_namespace: unknown
  owner_id: unknown
  short_id: unknown
  kind: unknown
  content: unknown
  origin: unknown
  importance: unknown
  source: unknown
  source_ref: unknown
  expires_at: unknown
  created_at: unknown
  updated_at: unknown
}

function rowToMemory(row: MemoryRow): MemoryRecord {
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

const COLUMNS = `id, agent_id, owner_namespace, owner_id, short_id, kind, content,
  origin, importance, source, source_ref, expires_at, created_at, updated_at`

/**
 * 站点级共享表的结构核验（消费插件 init 时调用）：版本行严格相等 + 表存在 +
 * 两个唯一索引存在。「迁移先行、任一侧版本落后即拒服」是预期停机语义。
 */
export async function verifyAgentMemoriesSchema(
  executor: MemoryExecutor,
  options: { readonly expectedVersion?: number | undefined } = {},
): Promise<void> {
  const expected = options.expectedVersion ?? AGENT_MEMORIES_SCHEMA_VERSION
  const version = await executor.query(
    'SELECT version FROM dsh_schema_versions WHERE plugin_id = $1',
    [AGENT_MEMORIES_PLUGIN_ID],
  )
  const current = version.rows[0]?.version
  if (current === undefined) {
    throw new AccessError(503, `站点级记忆表未登记（dsh_schema_versions 缺 '${AGENT_MEMORIES_PLUGIN_ID}' 行），请执行 private-deploy/db/0004_agent_memories.sql`, 'storage_schema_missing')
  }
  if (Number(current) !== expected) {
    throw new AccessError(503, `不支持的记忆表结构版本：${current}（期望 ${expected}）；请先执行对应版本的迁移再升级插件`, 'storage_schema_version')
  }
  const found = await executor.query(
    'SELECT t.tab FROM unnest($1::text[]) AS t(tab) WHERE to_regclass(\'public.\' || t.tab) IS NOT NULL',
    [[...AGENT_MEMORIES_INDEXES]],
  )
  const present = new Set(found.rows.map(row => String(row.tab)))
  const missing = AGENT_MEMORIES_INDEXES.filter(index => !present.has(index))
  if (missing.length > 0) {
    throw new AccessError(503, `存储结构缺失，缺少索引：${missing.join('、')}（防重与短 id 正确性依赖它们，请重跑 0004_agent_memories.sql）`, 'storage_schema_missing')
  }
}

export interface CreateMemoryStoreOptions {
  readonly executor: MemoryExecutor
  /** 本插件在记忆表里的命名空间（agent_id 列）。 */
  readonly agentId: string
}

export class MemoryStore {
  constructor(private readonly executor: MemoryExecutor, private readonly agentId: string) {}

  // ── 写入 ──────────────────────────────────────────────────────────

  /**
   * 写入一条记忆；同 kind 同内容已存在时返回 undefined（NOOP，防重）。
   * supersedesShortId：事务内插新+删旧；新内容撞防重索引时**中止整个事务、旧行保留**，
   * 抛「与现存记忆重复」——不静默丢数据。
   */
  async write(
    actor: MemoryActor,
    input: MemoryWriteInput & { readonly source: MemorySource },
    byAgentId?: string | undefined,
  ): Promise<MemoryRecord | undefined> {
    const agentId = byAgentId ?? this.agentId
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
    const ownerNamespace = actor.namespace
    const ownerId = actor.userId
    return this.executor.withTransaction(async tx => {
      const counter = await tx.query(
        `INSERT INTO agent_memory_counters (agent_id, owner_namespace, owner_id, last_n)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (agent_id, owner_namespace, owner_id)
         DO UPDATE SET last_n = agent_memory_counters.last_n + 1
         RETURNING last_n`,
        [agentId, ownerNamespace, ownerId],
      )
      const serial = Number(counter.rows[0]?.last_n ?? 0)
      if (serial <= 0) throw new Error('agent_memory_counters 自增失败')
      const shortId = `${input.kind === 'instruction' ? 'I' : 'M'}${serial}`
      const now = Date.now()
      const hash = contentHash(content)

      if (input.supersedesShortId !== undefined) {
        const existing = await tx.query(
          `SELECT ${COLUMNS} FROM agent_memories
           WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND kind = $4 AND content_hash = $5`,
          [agentId, ownerNamespace, ownerId, input.kind, hash],
        )
        if (existing.rows.length > 0) {
          throw new AccessError(409, `与现存记忆重复（${String(existing.rows[0]?.short_id)}），如要替换请改用更新`)
        }
        const superseded = await tx.query(
          `DELETE FROM agent_memories
           WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND short_id = $4
           RETURNING id`,
          [agentId, ownerNamespace, ownerId, input.supersedesShortId],
        )
        if (superseded.rows.length === 0) {
          throw new AccessError(404, `要替换的记忆 ${input.supersedesShortId} 不存在`)
        }
        await this.insertAudit(tx, actor, agentId, 'update', String(superseded.rows[0]?.id), input.supersedesShortId)
      }

      const inserted = await tx.query(
        `INSERT INTO agent_memories
           (id, agent_id, owner_namespace, owner_id, short_id, kind, content, content_hash,
            origin, importance, source, source_ref, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (agent_id, owner_namespace, owner_id, kind, content_hash) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          randomUUID(), agentId, ownerNamespace, ownerId, shortId, input.kind, content, hash,
          input.origin, input.importance ?? 3, input.source, input.sourceRef ?? '',
          input.expiresAt ?? null, now, now,
        ],
      )
      if (inserted.rows.length === 0) return undefined
      return rowToMemory(inserted.rows[0] as unknown as MemoryRow)
    })
  }

  /** 面板编辑：条件 UPDATE + RETURNING；content 变更同语句重算 hash 与 updated_at。 */
  async update(
    actor: MemoryActor,
    memoryId: string,
    patch: MemoryUpdatePatch,
    byAgentId?: string | undefined,
  ): Promise<MemoryRecord | undefined> {
    const agentId = byAgentId ?? this.agentId
    const content = patch.content?.trim()
    if (content !== undefined && (content.length < 4 || content.length > 200)) {
      throw new AccessError(400, `记忆内容须在 4-200 字之间（当前 ${content.length} 字）`)
    }
    const now = Date.now()
    const result = await this.executor.query(
      `UPDATE agent_memories SET
         content = COALESCE($4, content),
         content_hash = COALESCE($5, content_hash),
         importance = COALESCE($6, importance),
         expires_at = CASE WHEN $7 THEN $8 ELSE expires_at END,
         updated_at = $9
       WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3
       RETURNING ${COLUMNS}`,
      [
        memoryId, agentId, actor.namespace,
        content ?? null, content !== undefined ? contentHash(content) : null,
        patch.importance ?? null,
        patch.expiresAt !== undefined, patch.expiresAt ?? null,
        now,
      ],
    )
    if (result.rows.length === 0) return undefined
    // owner 等值由 WHERE 承担；这里补 owner_id 校验（更新成功但属他人 = 不可能，防御性断言）。
    const record = rowToMemory(result.rows[0] as MemoryRow)
    if (record.ownerId !== actor.userId) return undefined
    await this.insertAudit(this.executor, actor, agentId, 'update', memoryId, record.shortId)
    return record
  }

  /** 面板删除（单条与批量，批量逐行审计）。跨 agent 行=用户终裁豁免。 */
  async delete(
    actor: MemoryActor,
    memoryIds: readonly string[],
    byAgentId?: string | undefined,
  ): Promise<number> {
    const agentId = byAgentId ?? this.agentId
    if (memoryIds.length === 0) return 0
    return this.executor.withTransaction(async tx => {
      let deleted = 0
      for (const memoryId of memoryIds) {
        const result = await tx.query(
          `DELETE FROM agent_memories
           WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3 AND owner_id = $4
           RETURNING short_id`,
          [memoryId, agentId, actor.namespace, actor.userId],
        )
        if (result.rows.length > 0) {
          deleted += 1
          await this.insertAudit(tx, actor, agentId, 'delete', memoryId, String(result.rows[0]?.short_id))
        }
      }
      return deleted
    })
  }

  /** 工具遗忘路径：按短 id 删 + 审计。instruction 的拒绝校验在工具层。 */
  async forgetByShortId(actor: MemoryActor, shortId: string): Promise<MemoryRecord | undefined> {
    return this.executor.withTransaction(async tx => {
      const found = await tx.query(
        `SELECT ${COLUMNS} FROM agent_memories
         WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND short_id = $4`,
        [this.agentId, actor.namespace, actor.userId, shortId],
      )
      if (found.rows.length === 0) return undefined
      await tx.query(
        `DELETE FROM agent_memories
         WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3 AND short_id = $4`,
        [this.agentId, actor.namespace, actor.userId, shortId],
      )
      await this.insertAudit(tx, actor, this.agentId, 'forget', String(found.rows[0]?.id), shortId)
      return rowToMemory(found.rows[0] as unknown as MemoryRow)
    })
  }

  /** 一键清空本 agent 记忆库 + 审计一行。 */
  async purge(actor: MemoryActor): Promise<number> {
    return this.executor.withTransaction(async tx => {
      const result = await tx.query(
        'DELETE FROM agent_memories WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3',
        [this.agentId, actor.namespace, actor.userId],
      )
      await this.insertAudit(tx, actor, this.agentId, 'purge', '', '')
      return result.rowCount ?? 0
    })
  }

  // ── 读取 ──────────────────────────────────────────────────────────

  async byId(actor: MemoryActor, memoryId: string, byAgentId?: string | undefined): Promise<MemoryRecord | undefined> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM agent_memories
       WHERE id = $1 AND agent_id = $2 AND owner_namespace = $3 AND owner_id = $4`,
      [memoryId, byAgentId ?? this.agentId, actor.namespace, actor.userId],
    )
    return result.rows.length > 0 ? rowToMemory(result.rows[0] as MemoryRow) : undefined
  }

  /** 治理查询：owner 等值强制，agentId/kind 过滤维度可选。 */
  async list(
    actor: MemoryActor,
    filter: { readonly agentId?: string | undefined; readonly kind?: MemoryKind | undefined } = {},
  ): Promise<readonly MemoryRecord[]> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM agent_memories
       WHERE owner_namespace = $1 AND owner_id = $2
         AND ($3::text IS NULL OR agent_id = $3)
         AND ($4::text IS NULL OR kind = $4)
       ORDER BY updated_at DESC, id`,
      [actor.namespace, actor.userId, filter.agentId ?? null, filter.kind ?? null],
    )
    return result.rows.map(row => rowToMemory(row as unknown as MemoryRow))
  }

  /** 注入查询：三元组等值 + 未过期 + 排除 instruction + semantic 保底 + 超采样。 */
  async injectQuery(actor: MemoryActor, now: number): Promise<readonly MemoryRecord[]> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM agent_memories
       WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3
         AND kind IN ('semantic','episodic')
         AND (expires_at IS NULL OR expires_at > $4)
       ORDER BY importance DESC, updated_at DESC, id
       LIMIT $5`,
      [this.agentId, actor.namespace, actor.userId, now, MEMORY_INJECT_OVERSAMPLE],
    )
    const rows = result.rows.map(row => rowToMemory(row as MemoryRow))
    const semantic = rows.filter(row => row.kind === 'semantic')
    const episodic = rows.filter(row => row.kind === 'episodic')
    const picked = semantic.slice(0, MEMORY_SEMANTIC_FLOOR)
    const rest = [...semantic.slice(MEMORY_SEMANTIC_FLOOR), ...episodic].filter(row => !picked.includes(row))
    return [...picked, ...rest].slice(0, MEMORY_INJECT_HARD_LIMIT)
  }

  /** 指令子段：全部 instruction（≤10 条由写入端上限约束）。 */
  async instructions(actor: MemoryActor, now: number): Promise<readonly MemoryRecord[]> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM agent_memories
       WHERE agent_id = $1 AND owner_namespace = $2 AND owner_id = $3
         AND kind = 'instruction'
         AND (expires_at IS NULL OR expires_at > $4)
       ORDER BY updated_at DESC, id
       LIMIT ${MEMORY_INSTRUCTION_LIMIT}`,
      [this.agentId, actor.namespace, actor.userId, now],
    )
    return result.rows.map(row => rowToMemory(row as MemoryRow))
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private async insertAudit(
    executor: MemoryExecutor,
    actor: MemoryActor,
    agentId: string,
    action: MemoryAuditAction,
    memoryId: string,
    shortId: string,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO agent_memories_audit (id, owner_namespace, owner_id, agent_id, action, memory_id, short_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), actor.namespace, actor.userId, agentId, action, memoryId, shortId, Date.now()],
    )
  }
}

/** 工厂（设计 §6.3）：注入执行器 + 构造期 agentId；owner 随方法级 actor 传入。 */
export function createMemoryStore(options: CreateMemoryStoreOptions): MemoryStore {
  return new MemoryStore(options.executor, options.agentId)
}
