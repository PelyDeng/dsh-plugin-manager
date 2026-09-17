/**
 * 绘语的业务存储：生成图片的记录表。
 *
 * ## 与库结构的关系（`private-deploy/db/0001_init.sql` 的 ⑤ 段）
 *
 * 表 `huiyu_images` 是**新形状**：归属是 `owner_namespace` + `owner_id` 两列，载荷是
 * `payload JSONB`。两处容易照旧习惯写错：
 *
 * 1. 归属不是单列 `owner`。业务侧的 owner 串来自 {@link ownerKey}，用 {@link ownerOf}
 *    切**第一个**冒号拆回两列——不要拼一个合成串去比列。
 * 2. `payload` 读回来**已经是对象**，不要再 `JSON.parse` 一次（会抛 `Unexpected token o`）。
 *
 * 本表**没有生成列与 CHECK 守卫**（提升列只有 IDENTITY 的 `seq`），所以 INSERT 只写
 * `id / owner_namespace / owner_id / created_at / payload` 五列，形状比 blog 那六张表简单。
 *
 * ## 只核验不建表
 *
 * 缺表报 `storage_schema_missing`、版本不符报 `storage_schema_version`，**都不自动建表**：
 * 表形状只由建库脚本（新库）与 `0002_huiyu.sql`（现有库）决定。让插件在启动时补表会把
 * "部署没做到位"变成"静默改动了生产库"。
 */

import { Pool } from 'pg'
import { HuiyuError } from './errors.ts'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'

/** 本实现对应的库结构版本（与建库脚本写入的 `huiyu` 版本行一致）。 */
export const STORAGE_SCHEMA_VERSION = 1

/** 本存储占用的表。启动序列逐一核验存在性。 */
const EXPECTED_TABLES: readonly string[] = ['huiyu_images']

/**
 * 建库脚本写进 `dsh_schema_versions` 的插件标识。
 *
 * 它是**版本行的归属名**，不是任何表前缀的比较对象——表前缀是 `huiyu_`，两者恰好同名但不是
 * 同一件事（`runtime` 那一行就管着三张 `dsh_*` 表）。
 */
const VERSION_PLUGIN_ID = 'huiyu'

/** 语句与锁超时（毫秒）。与 blog 同口径：一次工具调用不该被一条慢语句拖住整个回合。 */
const STATEMENT_TIMEOUT_MS = 5000
const LOCK_TIMEOUT_MS = 2000

/** 并发连接上限。与 blog 相同的 5：一个站点的群组里各 Agent 各持一个池，合计仍远低于 PG 默认上限。 */
const POOL_MAX = 5

/** 一条生成图片记录。 */
export interface ImageRecord {
  readonly id: string
  readonly ownerNamespace: string
  readonly ownerId: string
  readonly createdAt: number
  readonly payload: ImageRecordPayload
}

/**
 * 记录的业务内容。
 *
 * `url` 与 `bucket`/`objectKey` **都存**是有意的：`objectKey` 是权威定位信息，换域名后仍能重新
 * 拼出正确地址；`url` 是当时的实际访问地址，排查时不必心算拼接。多占一点空间，换来的是
 * 排查与迁移都不用做推理。
 *
 * `sessionId` / `messageId` 是"图片不进备份"这个选择成立的前提：图丢了是预期内的，但只要记录
 * 还在，就能定位到是哪个会话的哪一轮要的图，重新生成即可。
 */
export interface ImageRecordPayload {
  /** 完整访问地址。 */
  readonly url: string
  /** 产出它的会话与消息，用于回查与重新生成。 */
  readonly sessionId: string
  readonly messageId?: string
  readonly prompt: string
  readonly provider: string
  readonly model: string
  readonly size: string
  readonly mediaType: string
  readonly width?: number
  readonly height?: number
  readonly bucket: string
  readonly objectKey: string
  /** 由哪个工具产出。 */
  readonly tool: string
  /** 花费。计价口径待定（见设计文档 §13），未定前不写这一项。 */
  readonly cost?: number
}

/** 归属串：`<namespace>:<userId>`。与 blog 的 `ownerKey` 同一形状。 */
export function ownerKey(actor: Actor): string {
  return `${actor.namespace}:${actor.userId}`
}

/**
 * 把归属串拆回两列。
 *
 * 切**第一个**冒号：namespace 不含冒号，而 userId 可能含（例如带命名空间的登录名）。
 */
export function ownerOf(owner: string): { readonly namespace: string; readonly id: string } {
  const at = owner.indexOf(':')
  return at < 0
    ? { namespace: owner, id: '' }
    : { namespace: owner.slice(0, at), id: owner.slice(at + 1) }
}

/** 存储未就绪或读写失败。`code` 是稳定码，供 HTTP 层映射状态码。 */
export class StorageError extends Error {
  constructor(readonly code: 'storage_schema_missing' | 'storage_schema_version' | 'storage_unconfigured' | 'storage_failed', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageError'
  }
}

/** 业务存储门面。 */
export interface HuiyuStore {
  /**
   * 启动序列：核验版本行与表存在性。失败后其余读写一律以同一错误拒绝（未就绪即不服务）。
   */
  init(): Promise<void>
  /** 运行期就绪探针：能确认表可用即 ok。要自带有界超时。 */
  probe(): Promise<{ readonly ok: boolean; readonly error?: string }>
  /** 写一条记录。 */
  record(input: ImageRecord): Promise<void>
  /** 按归属列出最近的记录，倒序。 */
  list(owner: string, limit: number): Promise<readonly ImageRecord[]>
  /** 关闭连接池。 */
  close(): Promise<void>
}

/** `payload` 的读取形状（PG 的 JSONB 回传已经是对象）。 */
type ImageRow = { id: string; owner_namespace: string; owner_id: string; created_at: string | number; payload: ImageRecordPayload }

/** 把一行转成记录。 */
function toRecord(row: ImageRow): ImageRecord {
  return {
    id: row.id,
    ownerNamespace: row.owner_namespace,
    ownerId: row.owner_id,
    // bigint 列由驱动回传字符串，读出按需转数字（与 blog 同一口径）。
    createdAt: Number(row.created_at),
    payload: row.payload,
  }
}

/**
 * 建一个 PostgreSQL 存储。
 *
 * @param dsn 连接串
 * @param onError 连接池错误上报口；缺省写 stderr
 */
export function createHuiyuStore(dsn: string, onError?: (error: unknown) => void): HuiyuStore {
  const pool = new Pool({
    connectionString: dsn,
    max: POOL_MAX,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    // 超时走连接启动参数（服务端 -c），不额外发 SET：'connect' 钩子里 fire-and-forget 的 SET
    // 会与该连接上的首个业务语句并发（pg 已弃用该用法）。
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${LOCK_TIMEOUT_MS}`,
  })
  // 空闲连接的后台错误若无人监听会成为宿主 uncaughtException。
  pool.on('error', error => (onError ?? (e => console.error('agents-group/huiyu: PostgreSQL 连接池错误', e)))(error))

  let ready: StorageError | undefined
  let closed = false

  const assertReady = (): void => {
    if (closed) throw new StorageError('storage_failed', '绘语存储正在停止')
    if (ready !== undefined) throw ready
  }

  const init = async (): Promise<void> => {
    try {
      const version = await pool.query<{ version: string | number }>(
        'SELECT version FROM dsh_schema_versions WHERE plugin_id = $1', [VERSION_PLUGIN_ID])
      const row = version.rows[0]
      if (row === undefined) {
        throw new StorageError('storage_schema_version',
          `dsh_schema_versions 里没有 plugin_id='${VERSION_PLUGIN_ID}' 的版本行，无法确认绘语数据结构版本；请执行 private-deploy/db/0002_huiyu.sql`)
      }
      const current = Number(row.version)
      if (current !== STORAGE_SCHEMA_VERSION) {
        throw new StorageError('storage_schema_version',
          `不支持的绘语数据结构版本：${current}（期望 ${STORAGE_SCHEMA_VERSION}）`)
      }
      // 表存在性：`to_regclass` 带 `public.` 前缀，schema 固定 public，不受 search_path 影响。
      const found = await pool.query<{ tab: string }>(
        "SELECT t.tab FROM unnest($1::text[]) AS t(tab) WHERE to_regclass('public.' || t.tab) IS NOT NULL",
        [[...EXPECTED_TABLES]])
      const present = new Set(found.rows.map(r => r.tab))
      const missing = EXPECTED_TABLES.filter(table => !present.has(table))
      if (missing.length > 0) {
        throw new StorageError('storage_schema_missing',
          `绘语存储结构缺失，缺少表：${missing.join('、')}；请在数据库上执行 private-deploy/db/0002_huiyu.sql`)
      }
      ready = undefined
    } catch (error: unknown) {
      ready = error instanceof StorageError
        ? error
        : new StorageError('storage_failed', '绘语存储初始化失败', { cause: error })
      throw ready
    }
  }

  return {
    init,
    async probe() {
      if (closed) return { ok: false, error: '绘语存储正在停止' }
      if (ready !== undefined) return { ok: false, error: ready.message }
      try {
        // 有界探针：一条最便宜的查询确认连接与表都还在。
        await pool.query('SELECT 1 FROM huiyu_images LIMIT 1')
        return { ok: true }
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async record(input: ImageRecord) {
      assertReady()
      try {
        await pool.query(
          'INSERT INTO huiyu_images (id, owner_namespace, owner_id, created_at, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
          [input.id, input.ownerNamespace, input.ownerId, input.createdAt, JSON.stringify(input.payload)])
      } catch (error: unknown) {
        throw new StorageError('storage_failed', '写入图片记录失败', { cause: error })
      }
    },
    async list(owner: string, limit: number) {
      assertReady()
      const { namespace, id } = ownerOf(owner)
      try {
        const result = await pool.query<ImageRow>(
          'SELECT id, owner_namespace, owner_id, created_at, payload FROM huiyu_images WHERE owner_namespace = $1 AND owner_id = $2 ORDER BY seq DESC LIMIT $3',
          [namespace, id, limit])
        return result.rows.map(toRecord)
      } catch (error: unknown) {
        throw new StorageError('storage_failed', '读取图片记录失败', { cause: error })
      }
    },
    async close() {
      closed = true
      await pool.end().catch(() => {})
    },
  }
}

/** 把存储错误转成面向用户的 {@link HuiyuError}；非存储错误原样返回。 */
export function mapStorageError(error: unknown): unknown {
  if (!(error instanceof StorageError)) return error
  switch (error.code) {
    case 'storage_unconfigured':
    case 'storage_schema_missing':
    case 'storage_schema_version':
      return new HuiyuError('unconfigured', error.message, { cause: error })
    default:
      return new HuiyuError('upstream', error.message, { cause: error })
  }
}
