/**
 * 牛马大总管工作台的 PostgreSQL 存储实现（`pg` Pool）。
 *
 * 绑定规格：《非框架插件业务库 PostgreSQL 默认方案》§2（机制决策 1-8）与 §3（PG 行为映射）。
 * 实现要点：
 *
 * - 连接参数起点（§2.7）：max=5、取连接 3s、空闲 30s；连接建立后 SET statement_timeout=5000、
 *   lock_timeout=2000。语句超时=事务已中止可安全重试；COMMIT 阶段连接丢失=结果不明，
 *   由调用方按原 requestId 核验，这里不做盲目重放。
 * - 多行写入一律同一 client 单事务（checkout/BEGIN/COMMIT/ROLLBACK + try-finally），
 *   禁止 pool.query 逐条拼业务序列（§3 总则）。
 * - 原子性收敛在存储层：唯一约束 + ON CONFLICT（只吞目标约束）、条件 UPDATE + RETURNING、
 *   行内 SELECT … FOR UPDATE，调用方不拼多步读写。
 * - JSON 列保持 TEXT 存储 + 读时解析分类（§2.3）：input_refs/member_return/depends_on
 *   的 damaged/unknown 语义与原 SQLite 实现逐字一致，不迁 JSONB。
 * - 池的 `'error'` 事件必须监听（§2.6）：空闲连接错误默认会成为宿主 uncaughtException。
 * - 所有故障经 `mapStorageError` 归类为稳定码；业务拒绝（归属、版本冲突、终态）以
 *   kit 的 `AccessError` 原样抛出。
 */

import { Buffer } from 'node:buffer'
import { Client, Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { AccessError, type Actor, type AgentArtifact } from '@dsh-plugin-manager/plugin-kit'
import { isTerminal, subtaskTransitionSources, type SubtaskState, type TaskState } from '../task-model.ts'
import { mapStorageError, StorageError, uniqueViolation } from './errors.ts'
import { parseArtifacts, parseDependsOn, parseDependsOnStrict, parseInputRefs, parseMemberReturn } from './parse.ts'
import type {
  ButlerInputRef,
  ButlerMemberReturn,
  ButlerStorage,
  ConversationSummary,
  HistoryQuery,
  NewSubtask,
  RequestRecord,
  SubtaskRecord,
  SubtaskVerdict,
  TaskCounts,
  TaskInput,
  TaskRecord,
  TaskSummary,
} from './types.ts'

/** 本实现对应的库结构版本（与 `migrations/postgres/0001_init.sql` 写入的版本行一致）。 */
/**
 * 目标库的数据结构版本。
 *
 * ⚠️ **切库后这里读的是新库**（`private-deploy/db/0001_init.sql` 的 `dsh_schema_versions`，
 * 管家的行是 `('butler', 1)`）——所以它是 **1**，不是旧形状表的 10。
 *
 * 旧形状的 `schema_version`（单行 `id = 0`、版本 10）与插件自带的 `migrations/postgres/0001_init.sql`
 * 按 D-6 **保留一期**（部署回退路径"指回旧 DSN"时还需要它们），但**运行时代码不再读那张表**：
 * 指到旧形状库会得到"版本不符"的**响亮失败**，而不是静默降级。
 */
export const STORAGE_SCHEMA_VERSION = 1
/** init 版本校验使用的期望版本（与 {@link STORAGE_SCHEMA_VERSION} 同源，/ready 汇报同一数值）。 */
const EXPECTED_SCHEMA_VERSION = STORAGE_SCHEMA_VERSION

/** 业务表清单：init 时逐一核验存在性（插件 schema 固定 public），缺表归类 `storage_schema_missing`。 */
const EXPECTED_TABLES = [
  'dsh_schema_versions',
  // 会话并入框架级表（设计 §5.3：管家同样是"一个 Agent"，没有理由单独一张会话表）。
  'dsh_conversations',
  'butler_tasks',
  'butler_subtasks',
  'butler_agent_aliases',
  'butler_requests',
  'butler_task_inputs',
] as const

/**
 * 管家在 `dsh_conversations` 里的 `agent_id`。
 *
 * ⚠️ `dsh_conversations` 是**所有 Agent 共用**的一张表，而 `(owner_namespace, owner_id)` 只区分
 * **人**、不区分 Agent ⇒ **每一个**面向会话的查询都必须带 `agent_id`（设计 §3.2 登记的第 1 条约束）。
 * 漏了它的三个后果都是实测记录在案的：`assertOwner` 会把别的 Agent 的会话判成管家自己的（**串 Agent**）、
 * `touchConversation` 会去改别的 Agent 的会话行（`title` / `updated_at`，而后者是 blog 侧栏的排序键）、
 * `listConversations` 会把 blog / closedoff 的会话**列进管家侧栏**。
 */
const BUTLER_AGENT_ID = 'butler'

/** 有界关闭上限（§2.6）：超时后放弃等待并记录，池终结交给进程退出。 */
const CLOSE_TIMEOUT_MS = 5000

/**
 * /ready 就绪探针的耗时上限（§2.5 运行期翻转）：连接与查询各有界，超过即按探针失败
 * 回答，不让 /ready 挂住调用方，也不在业务池里积压等待者。
 */
const READY_PROBE_TIMEOUT_MS = 1500
/** §2.7 的语句/锁上限（连接启动参数注入，见池构造）。 */
const STATEMENT_TIMEOUT_MS = 5000
const LOCK_TIMEOUT_MS = 2000

interface TaskRow extends QueryResultRow {
  readonly id: string
  readonly conversationId: string
  readonly goal: string
  readonly acceptance: string
  readonly state: string
  readonly note: string
  readonly summary: string
  readonly error: string
  readonly acceptedVersion: string | number
  readonly processedVersion: string | number
  readonly createdAt: string | number
  readonly updatedAt: string | number
  readonly finishedAt: string | number | null
}

/** 子任务原始行：JSON 列仍是 TEXT，毫秒时间戳（int8）驱动侧回传字符串。 */
interface SubtaskRow extends QueryResultRow {
  readonly id: string
  readonly seq: string | number
  readonly goal: string
  readonly acceptance: string
  readonly logicalId: string
  readonly supersedes: string
  readonly dependsOnRaw: string
  readonly agentId: string
  readonly reason: string
  readonly state: string
  readonly result: string
  readonly error: string
  readonly artifacts: string
  readonly subtaskConversationId: string
  readonly startedAt: string | number | null
  readonly finishedAt: string | number | null
  readonly requiresExternalActionRaw: string | number
  readonly inputRefsRaw: string
  readonly memberReturnRaw: string
  /** 裁决四列（`subtasks` 表，v10 起）。空串表示**还没裁决过**。 */
  readonly verdict: string
  readonly verdictReason: string
  /**
   * ⚠️ `unknown` 而不是 `string`：**新库这两列是 JSONB**（`private-deploy/db/0001_init.sql`），
   * pg 驱动读回的是对象/数组；插件自带的旧表本次仍是 TEXT（读回是字符串）。标注成 `string`
   * 等于对切库后的读侧撒谎。消费方不要当字符串用——要么走 `parse…`，要么自己判类型。
   */
  readonly verdictEvidence: unknown
  readonly observation: unknown
}

function toTimestamp(value: string | number | null): number | null {
  return value === null ? null : Number(value)
}

/** 把子任务原始行解析成记录：JSON 列按分类解析，损坏与未知如实呈现，不修补。 */
function mapSubtaskRow(row: SubtaskRow): SubtaskRecord {
  // 「确实还没派出去过」= 从未开始过（started_at 为空）且状态还是排队中。别的状态都说明
  // 已经派出去过：那时列还是空串只能表示旧记录没留材料，是未知，不是「等着首次固定」。
  const snapshot = parseInputRefs(row.inputRefsRaw, row.startedAt === null && row.state === 'queued')
  const depends = parseDependsOnStrict(row.dependsOnRaw)
  return {
    id: row.id,
    seq: Number(row.seq),
    logicalId: row.logicalId,
    supersedes: row.supersedes,
    // depends_on 分类严格化，但取值与 SQLite 测试双实现（tests/helpers/sqlite-test-store.ts）
    // 对齐：合法列表照旧，损坏时保留宽松过滤结果（能读出的字符串项照常给出）；编排层只看
    // dependsOnState='damaged' 拒派，存储层不静默改写原值、也不把损坏伪装成「没有前置」。
    dependsOn: depends.kind === 'valid' ? depends.items : parseDependsOn(row.dependsOnRaw),
    dependsOnState: depends.kind,
    goal: row.goal,
    acceptance: row.acceptance,
    agentId: row.agentId,
    reason: row.reason,
    state: row.state as SubtaskState,
    result: row.result,
    error: row.error,
    artifacts: parseArtifacts(row.artifacts),
    conversationId: row.subtaskConversationId,
    inputRefs: snapshot.kind === 'fixed' ? snapshot.inputRefs : undefined,
    inputRefsState: snapshot.kind,
    memberReturn: parseMemberReturn(row.memberReturnRaw),
    // 裁决四列原样读回：**空串就是"还没裁决过"**，不做任何"默认通过"的修补——把空串读成
    // `accept` 会让所有历史行凭空获得一次没人做过的裁决。
    verdict: row.verdict as SubtaskVerdict,
    verdictReason: row.verdictReason,
    verdictEvidence: row.verdictEvidence,
    observation: row.observation,
    startedAt: toTimestamp(row.startedAt),
    finishedAt: toTimestamp(row.finishedAt),
    requiresExternalAction: Number(row.requiresExternalActionRaw) === 1,
  }
}

/**
 * 一条子任务的 SQL 写入参数（createTask 与 appendSubtasks 共用同一形状与顺序）。
 *
 * ⚠️ **末尾那两列（`owner_namespace` / `owner_id`）不是可选的**：本表有
 * `FOREIGN KEY (task_id, owner_namespace, owner_id)`，漏写就是 **23502**（NOT NULL），
 * 写错 owner 就是 **23503**。取值一律来自**发起这次写的 actor** —— 让数据库来判"这个 task 是不是你的"，
 * 而不是靠调用方记得先查一次父任务（补这两列之前正是那样，DB 层拦不住跨 owner 写入）。
 */
function subtaskInsertValues(owner: Actor, taskId: string, subtask: NewSubtask, seq: number, logicalId: string): unknown[] {
  return [
    taskId, subtask.id, seq, subtask.goal, subtask.agentId, subtask.reason, 'queued',
    logicalId, subtask.supersedes ?? '', JSON.stringify(subtask.dependsOn ?? []),
    // ⚠️ 直接传**布尔**：新库这一列是 `BOOLEAN`（旧库是 `SMALLINT`）。写 `1`/`0` 数字会得到
    // `column "requires_external_action" is of type boolean but expression is of type integer`
    // （42804）——**响亮失败**，不是静默错。读侧 `Number(raw) === 1` 对 `true`/`false` 同样成立。
    subtask.requiresExternalAction === true,
    // 验收口径：没声明就写空串（列是 NOT NULL DEFAULT ''，普通 TEXT 列，不是 JSONB）。
    subtask.acceptance ?? '',
    // 归属两列**追加在末尾**（而不是插到 `task_id` 之后）：INSERT 带显式列清单，列序自由；
    // 追加就不必给前面 12 个占位符重新编号 —— 那正是最容易写错一位的地方。
    owner.namespace, owner.userId,
  ]
}

/**
 * `verdict_evidence` 是 **JSONB**（新库 DDL 默认 `'[]'::jsonb`，语义是"证据片段列表"）。
 *
 * ⚠️ 不能直接写文本：**空串不是合法 JSON**，写进去得到 22P02；而调用方（裁决链路）传的是模型给的
 * **一段原样文字**。这里把它包成数组——与列默认值同形，读侧不必猜是"字符串还是数组"。
 * 旧库那一列是 TEXT（存裸文本），但**全新库不迁移旧数据**，两种形态不会混在同一张表里。
 */
function verdictEvidenceJson(evidence: string | undefined): string {
  const text = evidence ?? ''
  return text === '' ? '[]' : JSON.stringify([text])
}

/**
 * `observation` 同样是 **JSONB**（默认 `'{}'::jsonb`）。调用方传的是"为什么这么裁"的**一句话**，
 * 这里包成 `{ why }`：保持对象形状（与列默认值一致），将来要加别的观察字段不必改列。
 */
function observationJson(observation: string | undefined): string {
  const text = observation ?? ''
  return text === '' ? '{}' : JSON.stringify({ why: text })
}

const SUBTASK_INSERT_COLUMNS = 'task_id,id,seq,goal,agent_id,reason,state,logical_id,supersedes,depends_on,requires_external_action,acceptance,owner_namespace,owner_id'

/**
 * 牛马大总管工作台的 PostgreSQL 存储。
 *
 * 用法：构造（建池）→ `init()`（schema 版本校验）→ `failInterrupted()`（恢复写）→ 对外服务。
 * 校验失败或未通过校验时，其余读写一律以同一 `StorageError` 拒绝：未就绪即不服务（§2.5）。
 */
export class PostgresTaskStorage implements ButlerStorage {
  private readonly pool: Pool
  private readonly reportError: (error: Error) => void
  private readyError: StorageError | undefined
  private inited = false
  private closed = false

  constructor(private readonly dsn: string, onError?: (error: Error) => void) {
    this.pool = new Pool({
      connectionString: dsn,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      // §2.7：语句/锁超时走连接启动参数（服务端 -c），不额外发 SET——'connect' 钩子里
      // fire-and-forget 的 SET 会与该连接上的首个业务语句并发（pg 警告 "client.query()
      // when the client is already executing a query"，pg@9 起不再允许）。
      options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${LOCK_TIMEOUT_MS}`,
    })
    this.reportError = onError ?? ((error) => { console.error('butler-console: PostgreSQL 连接池错误', error) })
    // §2.6：空闲连接的后台错误若无人监听会成为宿主 uncaughtException。
    this.pool.on('error', (error) => { this.reportError(error) })
  }

  /** §2.5 启动序列：schema 版本校验。缺表/版本不符分别归类，不自动改写版本、不自动建表。 */
  async init(): Promise<void> {
    this.assertOpen()
    let failure: StorageError
    try {
      const versionResult = await this.pool.query<{ version: string | number }>('SELECT version FROM dsh_schema_versions WHERE plugin_id = \'butler\'')
      const versionRow = versionResult.rows[0]
      if (versionRow === undefined) {
        throw new StorageError('storage_schema_version', 'schema_version 表没有版本行，无法确认工作台数据结构版本')
      }
      const current = Number(versionRow.version)
      if (current !== EXPECTED_SCHEMA_VERSION) {
        throw new StorageError(
          'storage_schema_version',
          `不支持的工作台数据结构版本：${current}（期望 ${EXPECTED_SCHEMA_VERSION}）`,
        )
      }
      // 表存在性检查显式化：插件 schema 固定 public，to_regclass 一律带 `public.` 前缀，
      // 不受连接 search_path 影响（迁移执行保持现状，不在此建表）。
      const found = await this.pool.query<{ tab: string }>(
        'SELECT t.tab FROM unnest($1::text[]) AS t(tab) WHERE to_regclass(\'public.\' || t.tab) IS NOT NULL',
        [[...EXPECTED_TABLES]],
      )
      const present = new Set(found.rows.map(row => row.tab))
      const missing = EXPECTED_TABLES.filter(table => !present.has(table))
      if (missing.length > 0) {
        throw new StorageError('storage_schema_missing', `存储结构缺失，缺少表：${missing.join('、')}`)
      }
      this.inited = true
      this.readyError = undefined
      return
    } catch (error) {
      failure = mapStorageError(error) instanceof StorageError
        ? mapStorageError(error) as StorageError
        : new StorageError('storage_unknown', '存储初始化失败', { cause: error })
      this.readyError = failure
      throw failure
    }
  }

  /**
   * 运行时就绪探针（§2.5 口径：已配置但运行中 PG 不可达 = 已装载未就绪，业务与 /ready 503）。
   *
   * 启动序列的缓存只证明「装载时校验通过」；PG 是否**此刻**可达由本探针回答：用一条
   * 独立的短连接查 `SELECT 1` 同源的 schema 版本（版本校验逻辑与 {@link init} 一致），
   * 失败按稳定码抛 StorageError（unreachable / auth / schema_version / timeout / closed）。
   *
   * 实现约束：不占业务池（探针慢或挂住不影响在途事务，也不产生池内等待者积压）；连接与
   * 查询总耗时以 {@link READY_PROBE_TIMEOUT_MS} 为上界——超时即销毁连接终止挂起的查询；
   * 不做结果缓存，/ready 调用频率低，每次如实探测。
   */
  async readyProbe(): Promise<void> {
    this.assertOpen()
    const client = new Client({ connectionString: this.dsn, connectionTimeoutMillis: READY_PROBE_TIMEOUT_MS })
    // §2.6：探针连接同样必须监听 'error'，空闲期故障不得成为宿主 uncaughtException。
    client.on('error', (error) => { this.reportError(error) })
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StorageError('storage_timeout', '就绪探针超时', { retryable: true })),
        READY_PROBE_TIMEOUT_MS,
      )
    })
    try {
      // Promise.race 已给两侧挂上处理函数：deadline 先落定后，work 的迟到失败不会成为
      // unhandledRejection；反向同理。
      await Promise.race([
        (async () => {
          await client.connect()
          await client.query(`SET statement_timeout = ${READY_PROBE_TIMEOUT_MS}`)
          const one = await client.query<{ one: number }>('SELECT 1 AS one')
          if (one.rows[0]?.one !== 1) {
            throw new StorageError('storage_unknown', '就绪探针收到异常应答')
          }
          const versionResult = await client.query<{ version: string | number }>('SELECT version FROM dsh_schema_versions WHERE plugin_id = \'butler\'')
          const versionRow = versionResult.rows[0]
          if (versionRow === undefined) {
            throw new StorageError('storage_schema_version', 'schema_version 表没有版本行，无法确认工作台数据结构版本')
          }
          const current = Number(versionRow.version)
          if (current !== EXPECTED_SCHEMA_VERSION) {
            throw new StorageError(
              'storage_schema_version',
              `不支持的工作台数据结构版本：${current}（期望 ${EXPECTED_SCHEMA_VERSION}）`,
            )
          }
        })(),
        deadline,
      ])
    } catch (error) {
      throw error instanceof StorageError ? error : mapStorageError(error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // 探针连接用完即弃：end() 销毁套接字，竞速超时时挂着的 connect/query 也一并终止，
      // 不留无限积压。注意：对挂起查询的强制终止依赖 pg 8.x 的 Client.end() 行为
      // （内部 stream.destroy()）；升级驱动时复核此性质，connect 未完成路径另由同值
      // connectionTimeoutMillis 兜底。
      client.end().catch(() => {})
    }
  }

  async aliases(actor: Actor): Promise<Map<string, { displayName: string; accent: string }>> {
    const result = await this.run<{ agentId: string; displayName: string; accent: string }>(
      `SELECT agent_id AS "agentId", display_name AS "displayName", accent
       FROM butler_agent_aliases WHERE owner_namespace=$1 AND owner_id=$2`,
      [actor.namespace, actor.userId],
    )
    return new Map(result.rows.map(row => [row.agentId, { displayName: row.displayName, accent: row.accent }]))
  }

  async setAlias(actor: Actor, agentId: string, displayName: string, accent: string): Promise<void> {
    const name = Array.from(displayName.replace(/\s+/gu, ' ').trim()).slice(0, 24).join('')
    const color = /^#[0-9a-f]{6}$/iu.test(accent) ? accent.toLowerCase() : ''
    if (name === '' && color === '') {
      await this.run('DELETE FROM butler_agent_aliases WHERE owner_namespace=$1 AND owner_id=$2 AND agent_id=$3',
        [actor.namespace, actor.userId, agentId])
      return
    }
    await this.run(
      `INSERT INTO butler_agent_aliases(owner_namespace,owner_id,agent_id,display_name,accent,updated_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_namespace,owner_id,agent_id)
       DO UPDATE SET display_name=excluded.display_name, accent=excluded.accent, updated_at=excluded.updated_at`,
      [actor.namespace, actor.userId, agentId, name, color, Date.now()],
    )
  }

  async setAvatar(actor: Actor, agentId: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.run(
      `INSERT INTO butler_agent_aliases(owner_namespace,owner_id,agent_id,avatar,avatar_type,updated_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_namespace,owner_id,agent_id)
       DO UPDATE SET avatar=excluded.avatar, avatar_type=excluded.avatar_type, updated_at=excluded.updated_at`,
      [actor.namespace, actor.userId, agentId, Buffer.from(bytes), contentType, Date.now()],
    )
  }

  async avatar(actor: Actor, agentId: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    const result = await this.run<{ bytes: Buffer; contentType: string }>(
      `SELECT avatar AS bytes, avatar_type AS "contentType" FROM butler_agent_aliases
       WHERE owner_namespace=$1 AND owner_id=$2 AND agent_id=$3 AND avatar IS NOT NULL`,
      [actor.namespace, actor.userId, agentId],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return { bytes: new Uint8Array(row.bytes), contentType: row.contentType }
  }

  async clearAvatar(actor: Actor, agentId: string): Promise<void> {
    await this.run(
      'UPDATE butler_agent_aliases SET avatar=NULL, avatar_type=\'\', updated_at=$1 WHERE owner_namespace=$2 AND owner_id=$3 AND agent_id=$4',
      [Date.now(), actor.namespace, actor.userId, agentId],
    )
  }

  async reserveConversation(id: string, actor: Actor): Promise<void> {
    // §3：INSERT OR IGNORE → ON CONFLICT (id) DO NOTHING，只吞目标约束冲突。
    //
    // ⚠️ 两列**必须显式写**（设计 §8.1 的管家侧清单，都是"漏了会静默出事"的那一类）：
    //  · `agent_id = 'butler'`——该列 `NOT NULL` **且无默认值**，漏写报 **23502**；
    //  · `ready = TRUE`——`dsh_conversations` 把它建成默认 FALSE 的"陷阱列"（新库 DDL 的原话），
    //    而管家**没有"预留—发布"两段握手**（closedoff/blog 才有）：不一步到位，它的会话会永久
    //    停在"创建未完成"——**侧栏看不到、也删不掉**。
    // `title_source` 不写，用 DDL 默认的 `'automatic'`（管家建的会话标题本来就是自动来源）。
    await this.run(
      `INSERT INTO dsh_conversations(id, agent_id, owner_namespace, owner_id, ready, created_at, updated_at)
       VALUES($1,$2,$3,$4,TRUE,$5,$5) ON CONFLICT (id) DO NOTHING`,
      [id, BUTLER_AGENT_ID, actor.namespace, actor.userId, Date.now()],
    )
  }

  async openOrReserveConversation(id: string, actor: Actor): Promise<void> {
    await this.reserveConversation(id, actor)
    await this.assertOwner(id, actor)
  }

  /**
   * 校验会话归属。未知、他人或已删除的会话返回同一个结果，不泄露存在性。
   *
   * ⚠️ `agent_id` 这一列不能省：`dsh_conversations` 是所有 Agent 共用的，`(owner, id)` 只区分人
   * ——**只写双列会把别的 Agent 的会话判成管家自己的**（设计 §8.1 的实测结论）。
   * 这里**不**按 `removal_state` / `deleted_at` 过滤：管家的旧表根本没有这两列，加进来会改变行为
   * （属于"切库顺带改语义"，不是本期目标）；跨 Agent 那部分已经由 `agent_id` 挡住。
   */
  async assertOwner(conversationId: string, actor: Actor): Promise<void> {
    const result = await this.run<{ one: number }>(
      'SELECT 1 AS one FROM dsh_conversations WHERE id=$1 AND owner_namespace=$2 AND owner_id=$3 AND agent_id=$4',
      [conversationId, actor.namespace, actor.userId, BUTLER_AGENT_ID],
    )
    if (result.rows[0] === undefined) throw new AccessError(404, '会话不存在或无权访问', 'conversation_not_found')
  }

  async touchConversation(conversationId: string, actor: Actor, title?: string): Promise<void> {
    await this.assertOwner(conversationId, actor)
    const trimmed = Array.from((title ?? '').replace(/\s+/gu, ' ').trim()).slice(0, 80).join('')
    // 归属与 `agent_id` 在 UPDATE 里再写一次：`assertOwner` 与本语句之间是有窗口的，
    // 而漏 `agent_id` 的后果是**去改别的 Agent 的会话行**（`updated_at` 还是 blog 侧栏的排序键）。
    await this.run(
      `UPDATE dsh_conversations SET updated_at=$1, title=CASE WHEN title='' THEN $2 ELSE title END
        WHERE id=$3 AND owner_namespace=$4 AND owner_id=$5 AND agent_id=$6`,
      [Date.now(), trimmed, conversationId, actor.namespace, actor.userId, BUTLER_AGENT_ID],
    )
  }

  async listConversations(actor: Actor, limit: number): Promise<ConversationSummary[]> {
    const result = await this.run<{ id: string; title: string; createdAt: string | number; updatedAt: string | number; taskCount: string | number }>(
      `SELECT c.id AS "id", c.title AS "title", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
         (SELECT count(*) FROM butler_tasks t WHERE t.conversation_id = c.id) AS "taskCount"
       FROM dsh_conversations c
       WHERE c.owner_namespace=$1 AND c.owner_id=$2 AND c.agent_id=$4
       ORDER BY c.updated_at DESC, c.id LIMIT $3`,
      [actor.namespace, actor.userId, limit, BUTLER_AGENT_ID],
    )
    return result.rows.map(row => ({
      id: row.id,
      title: row.title,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      taskCount: Number(row.taskCount),
    }))
  }

  async createTask(input: {
    id: string
    conversationId: string
    actor: Actor
    goal: string
    acceptance?: string
    note: string
    subtasks: readonly NewSubtask[]
  }): Promise<void> {
    await this.assertOwner(input.conversationId, input.actor)
    const now = Date.now()
    await this.withTransaction(async (client) => {
      // 任务行的锁由本次 INSERT 取得：并发的追加编号（appendSubtasks 的 FOR UPDATE）会
      // 排队到本事务提交之后，seq/logicalId 不会撞号（§3 createTask 规格）。
      await client.query(
        `INSERT INTO butler_tasks(id,conversation_id,owner_namespace,owner_id,goal,acceptance,state,note,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8,$8)`,
        [input.id, input.conversationId, input.actor.namespace, input.actor.userId, input.goal, input.acceptance ?? '', input.note, now],
      )
      // 开头那条需求就是版本 1，与任务一起落库：输入历史要完整。
      // ⚠️ 归属两列必须写：本表有 `(task_id, owner_namespace, owner_id)` 复合外键，
      // 漏了就 23502、写错 owner 就 23503（见 `subtaskInsertValues` 的注释）。
      await client.query(
        'INSERT INTO butler_task_inputs(task_id,owner_namespace,owner_id,version,text,source,created_at) VALUES($1,$2,$3,1,$4,$5,$6)',
        [input.id, input.actor.namespace, input.actor.userId, input.goal, 'chat', now],
      )
      for (const [index, subtask] of input.subtasks.entries()) {
        // 没给目标标识就按顺序分配：首次计划里一条子任务就是一个目标。
        await client.query(
          `INSERT INTO butler_subtasks(${SUBTASK_INSERT_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          subtaskInsertValues(input.actor, input.id, subtask, index + 1, subtask.logicalId ?? `g${index + 1}`),
        )
      }
    })
  }

  async setTaskState(id: string, state: TaskState, patch: { note?: string; summary?: string; error?: string } = {}): Promise<void> {
    const terminal = isTerminal(state)
    const now = Date.now()
    await this.run(
      `UPDATE butler_tasks SET state=$1, updated_at=$2,
         note=COALESCE($3,note), summary=COALESCE($4,summary), error=COALESCE($5,error),
         finished_at=CASE WHEN $6::boolean THEN COALESCE(finished_at,$2::bigint) ELSE finished_at END
       WHERE id=$7`,
      [state, now, patch.note ?? null, patch.summary ?? null, patch.error ?? null, terminal, id],
    )
  }

  async commitTaskState(id: string, state: TaskState, patch: { note?: string; summary?: string; error?: string } = {}): Promise<boolean> {
    if (state !== 'completed' && state !== 'partial') {
      // 取消与失败没有宣称成功，可以带着未处理的输入结束：直接写终态。
      await this.setTaskState(id, state, patch)
      return true
    }
    // §3：版本守卫与终态写入合并为单条条件 UPDATE + RETURNING，消灭 check-then-write 竞态。
    // 只对宣称成功的终态设关卡：accepted <= processed 才允许落「这一轮干完了」。
    const result = await this.run<{ id: string }>(
      `UPDATE butler_tasks SET state=$1, updated_at=$2,
         note=COALESCE($3,note), summary=COALESCE($4,summary), error=COALESCE($5,error),
         finished_at=COALESCE(finished_at,$2::bigint)
       WHERE id=$6 AND accepted_version<=processed_version
       RETURNING id`,
      [state, Date.now(), patch.note ?? null, patch.summary ?? null, patch.error ?? null, id],
    )
    return result.rows.length > 0
  }

  async setSubtaskState(
    taskId: string,
    subtaskId: string,
    state: SubtaskState,
    patch: {
      result?: string
      error?: string
      artifacts?: readonly AgentArtifact[]
      inputRefs?: readonly ButlerInputRef[]
      memberReturn?: ButlerMemberReturn
      conversationId?: string
    } = {},
  ): Promise<number> {
    const now = Date.now()
    const started = state === 'dispatched' || state === 'running'
    const terminal = isTerminal(state)
    // 快照只在「可证明还没派出去过」时才落库：列还是空串，而且这条记录真的没开始过
    // （started_at 为空、状态还是排队中）。已固定的、旧已派出却留空的、以及损坏的值一律
    // 原样保留。state、started_at 在这个 CASE 里都是**更新前**的旧值 —— 与 SQLite 测试
    // 双实现的 SET 表达式逐字等价。
    const inputRefs = patch.inputRefs === undefined ? null : JSON.stringify(patch.inputRefs)
    /**
     * 写入白名单**由迁移表生成**（{@link subtaskTransitionSources}），这里不再手抄一份。
     *
     * 手抄的那一份漏了 `external_pending` 的出边：老板点了确认之后
     * `setSubtaskState(s1, 'succeeded')` 条件不成立、影响 0 行、**不报错**，于是"办结了"在库里
     * 从没发生过，等 s1 的下游永远停在队列里。查这段历史花了整整一轮生产验证。
     */
    const sources = subtaskTransitionSources(state)
    const result = await this.run(
      `UPDATE butler_subtasks SET state=$1,
         result=COALESCE($2,result), error=COALESCE($3,error),
         artifacts=COALESCE($4,artifacts), conversation_id=COALESCE($5,conversation_id),
         input_refs=CASE WHEN $6::jsonb IS NULL THEN input_refs
           WHEN input_refs <> '[]'::jsonb THEN input_refs
           WHEN started_at IS NOT NULL OR state<>'queued' THEN input_refs
           ELSE $6::jsonb END,
         member_return=COALESCE($7,member_return),
         started_at=CASE WHEN $8::boolean THEN COALESCE(started_at,$9::bigint) ELSE started_at END,
         finished_at=CASE WHEN $10::boolean THEN COALESCE(finished_at,$9::bigint) ELSE finished_at END
       WHERE task_id=$11 AND id=$12 AND state = ANY($13::text[])`,
      [
        state,
        patch.result ?? null,
        patch.error ?? null,
        patch.artifacts === undefined ? null : JSON.stringify(patch.artifacts),
        patch.conversationId === undefined || patch.conversationId === '' ? null : patch.conversationId,
        inputRefs,
        patch.memberReturn === undefined ? null : JSON.stringify(patch.memberReturn),
        started, now, terminal,
        taskId, subtaskId, [...sources],
      ],
    )
    // 影响 0 行 = 迁移不合法（或这条子任务不存在）。返回行数是为了让**结账写入**能核验：
    // 静默丢弃过一次，代价是整条链永远等一个已经办结的上游。
    return result.rowCount ?? 0
  }

  /**
   * 落一条裁决结论（`butler_verdict` 的写入面）。
   *
   * 一条 scoped UPDATE：`task_id` 与 `id` 一起进 WHERE，**不另做一次预查询**（两套判定必然漂移）。
   *
   * ⚠️ **归属条件从"子查询"改成了本表的列**（R4 两表例外补上 owner 两列 + 复合外键之后）：
   * 原先本表没有 owner 列，只能写 `EXISTS (SELECT 1 FROM butler_tasks t WHERE t.id=$5 AND …)`；
   * 现在 `(task_id, owner_namespace, owner_id)` 是复合外键 ⇒ **子行的 owner 恒等于父行的 owner**，
   * 于是 `owner_namespace=$7 AND owner_id=$8` 与那条子查询**等价**，而少一次子查询。
   * （等价性不是推断出来的：外键让"两者不同"这件事在数据库里不可能存在。）
   *
   * **返回受影响行数** ⇒ 调用方做写后核验（0 = 这条子任务不存在或不属于该任务，是编程错误）。
   */
  async setSubtaskVerdict(
    actor: Actor,
    taskId: string,
    subtaskId: string,
    patch: { verdict: SubtaskVerdict; reason?: string; evidence?: string; observation?: string },
  ): Promise<number> {
    const result = await this.run(
      `UPDATE butler_subtasks SET verdict=$1, verdict_reason=$2, verdict_evidence=$3, observation=$4
        WHERE task_id=$5 AND id=$6 AND owner_namespace=$7 AND owner_id=$8`,
      [patch.verdict, patch.reason ?? '', verdictEvidenceJson(patch.evidence), observationJson(patch.observation),
        taskId, subtaskId, actor.namespace, actor.userId],
    )
    return result.rowCount ?? 0
  }

  async task(actor: Actor, id: string): Promise<TaskRecord | undefined> {
    const taskResult = await this.run<TaskRow>(
      `SELECT id,conversation_id AS "conversationId",goal,acceptance,state,note,summary,error,
         accepted_version AS "acceptedVersion",processed_version AS "processedVersion",
         created_at AS "createdAt",updated_at AS "updatedAt",finished_at AS "finishedAt"
       FROM butler_tasks WHERE id=$1 AND owner_namespace=$2 AND owner_id=$3`,
      [id, actor.namespace, actor.userId],
    )
    const row = taskResult.rows[0]
    if (row === undefined) return undefined
    const subResult = await this.run<SubtaskRow>(
      `SELECT id,seq,goal,acceptance,logical_id AS "logicalId",supersedes,depends_on AS "dependsOnRaw",
         agent_id AS "agentId",reason,state,result,error,
         artifacts,conversation_id AS "subtaskConversationId",started_at AS "startedAt",finished_at AS "finishedAt",
         requires_external_action AS "requiresExternalActionRaw",
         input_refs AS "inputRefsRaw",member_return AS "memberReturnRaw",
         verdict,verdict_reason AS "verdictReason",verdict_evidence AS "verdictEvidence",observation
       FROM butler_subtasks WHERE task_id=$1 ORDER BY seq`,
      [id],
    )
    const subtasks = subResult.rows.map(mapSubtaskRow)
    return {
      id: row.id,
      conversationId: row.conversationId,
      goal: row.goal,
      acceptance: row.acceptance,
      state: row.state as TaskState,
      note: row.note,
      summary: row.summary,
      error: row.error,
      acceptedVersion: Number(row.acceptedVersion),
      processedVersion: Number(row.processedVersion),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      finishedAt: toTimestamp(row.finishedAt),
      subtasks,
    }
  }

  async history(actor: Actor, query: HistoryQuery): Promise<{ items: TaskSummary[]; total: number; nextOffset: number | null }> {
    const filters = ['t.owner_namespace=$1', 't.owner_id=$2']
    const values: unknown[] = [actor.namespace, actor.userId]
    if (query.keyword !== '') {
      values.push(query.keyword)
      // instr(lower(...)) → strpos（§3 方言差异）。大小写折叠走 PG lower()，受 collation 影响，
      // 非 ASCII 关键字的大小写行为与 SQLite 的 ASCII-only 折叠略有差异，属既定接受项。
      filters.push(`strpos(lower(t.goal), lower($${values.length}))>0`)
    }
    if (query.state !== '') {
      values.push(query.state)
      filters.push(`t.state=$${values.length}`)
    }
    if (query.conversationId !== undefined && query.conversationId !== '') {
      values.push(query.conversationId)
      filters.push(`t.conversation_id=$${values.length}`)
    }
    const where = filters.join(' AND ')
    const totalResult = await this.run<{ total: string | number }>(`SELECT count(*) AS total FROM butler_tasks t WHERE ${where}`, values)
    const total = Number(totalResult.rows[0]?.total ?? 0)
    const itemsResult = await this.run<{
      id: string; conversationId: string; goal: string; state: string
      createdAt: string | number; updatedAt: string | number; subtaskTotal: string | number; subtaskDone: string | number
    }>(
      `SELECT t.id AS "id", t.conversation_id AS "conversationId", t.goal AS "goal", t.state AS "state",
         t.created_at AS "createdAt", t.updated_at AS "updatedAt",
         (SELECT count(*) FROM butler_subtasks s WHERE s.task_id=t.id) AS "subtaskTotal",
         (SELECT count(*) FROM butler_subtasks s WHERE s.task_id=t.id AND s.state IN ('succeeded','failed','cancelled','external_pending')) AS "subtaskDone"
       FROM butler_tasks t WHERE ${where} ORDER BY t.created_at DESC, t.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit, query.offset],
    )
    const items = itemsResult.rows.map(row => ({
      id: row.id,
      conversationId: row.conversationId,
      goal: row.goal,
      state: row.state as TaskState,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      subtaskTotal: Number(row.subtaskTotal),
      subtaskDone: Number(row.subtaskDone),
    }))
    const next = query.offset + items.length
    return { items, total, nextOffset: next < total ? next : null }
  }

  async busy(actor: Actor): Promise<Map<string, { taskId: string; subtaskId: string; state: SubtaskState }>> {
    const result = await this.run<{ agentId: string; taskId: string; subtaskId: string; state: string }>(
      `SELECT s.agent_id AS "agentId", s.task_id AS "taskId", s.id AS "subtaskId", s.state AS "state"
       FROM butler_subtasks s JOIN butler_tasks t ON t.id = s.task_id
       WHERE t.owner_namespace=$1 AND t.owner_id=$2
         AND s.state IN ('dispatched','running','waiting_user')
       ORDER BY s.started_at NULLS FIRST, s.task_id, s.id`,
      [actor.namespace, actor.userId],
    )
    const busy = new Map<string, { taskId: string; subtaskId: string; state: SubtaskState }>()
    for (const row of result.rows) {
      // 同一位成员出现多条时留**最早派出去**的那条：占用从派发那一刻起算，后来的顶不掉它。
      // SQLite 升序排序里 NULL 排在最前，PG 相反 —— 显式 NULLS FIRST 保持原语义（§3 方言差异）。
      if (!busy.has(row.agentId)) {
        busy.set(row.agentId, { taskId: row.taskId, subtaskId: row.subtaskId, state: row.state as SubtaskState })
      }
    }
    return busy
  }

  async addInput(actor: Actor, taskId: string, text: string, source: 'chat' | 'supplement', expectedVersion?: number): Promise<number> {
    const now = Date.now()
    return this.withTransaction(async (client) => {
      // 行锁内复核终态与期望版本（§3）：受理前打开会话是异步窗口，事务外的旧结论不可信。
      const locked = await client.query<{ acceptedVersion: string | number; state: string }>(
        `SELECT accepted_version AS "acceptedVersion", state FROM butler_tasks
         WHERE id=$1 AND owner_namespace=$2 AND owner_id=$3 FOR UPDATE`,
        [taskId, actor.namespace, actor.userId],
      )
      const row = locked.rows[0]
      if (row === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
      if (isTerminal(row.state as TaskState)) {
        throw new AccessError(409, '这一轮已经结束，改目标请用 /chat 开新的一轮', 'task_already_finished')
      }
      const accepted = Number(row.acceptedVersion)
      if (expectedVersion !== undefined && expectedVersion !== accepted) {
        throw new AccessError(409, `这一轮已经更新到第 ${accepted} 版，请按最新内容重新提交`, 'version_conflict')
      }
      const next = accepted + 1
      try {
        await client.query('UPDATE butler_tasks SET accepted_version=$1, updated_at=$2 WHERE id=$3', [next, now, taskId])
        await client.query(
          'INSERT INTO butler_task_inputs(task_id,owner_namespace,owner_id,version,text,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [taskId, actor.namespace, actor.userId, next, text, source, now],
        )
      } catch (error) {
        // (task_id,version) 主键兜底（§3）：正常并发已被任务行锁串行化，真撞上说明
        // accepted_version 与输入表已不一致。按版本冲突映射 409 语义，不是 500。
        if (uniqueViolation(error, 'butler_task_inputs') !== undefined) {
          throw new AccessError(409, `这一轮已经接受过第 ${next} 版输入，请按最新内容重新提交`, 'version_conflict')
        }
        throw error
      }
      return next
    })
  }

  async inputVersions(taskId: string): Promise<{ accepted: number; processed: number } | undefined> {
    const result = await this.run<{ accepted: string | number; processed: string | number }>(
      'SELECT accepted_version AS accepted, processed_version AS processed FROM butler_tasks WHERE id=$1',
      [taskId],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return { accepted: Number(row.accepted), processed: Number(row.processed) }
  }

  async inputs(taskId: string): Promise<TaskInput[]> {
    const result = await this.run<{ version: string | number; text: string; source: string; createdAt: string | number }>(
      'SELECT version,text,source,created_at AS "createdAt" FROM butler_task_inputs WHERE task_id=$1 ORDER BY version',
      [taskId],
    )
    return result.rows.map(row => ({
      version: Number(row.version),
      text: row.text,
      source: row.source as TaskInput['source'],
      createdAt: Number(row.createdAt),
    }))
  }

  async setProcessedVersion(taskId: string, version: number): Promise<void> {
    // 只往前追：回调乱序或者重放时不可能把已经处理过的输入退回未处理。
    await this.run(
      'UPDATE butler_tasks SET processed_version=$1, updated_at=$2 WHERE id=$3 AND processed_version < $1',
      [version, Date.now(), taskId],
    )
  }

  async appendSubtasks(actor: Actor, taskId: string, subtasks: readonly NewSubtask[]): Promise<string[]> {
    return this.withTransaction(async (client) => {
      // §3：编号（seq/logicalId）分配入事务并对任务行 SELECT FOR UPDATE —— 并发追加在行锁上
      // 串行化，编号接着现有的往下排，不复用也不跳号。owner 过滤同一把锁完成：任务不存在
      // 或不属于该用户都是同一个结果，不泄露存在性。
      const locked = await client.query<{ id: string }>(
        'SELECT id FROM butler_tasks WHERE id=$1 AND owner_namespace=$2 AND owner_id=$3 FOR UPDATE',
        [taskId, actor.namespace, actor.userId],
      )
      if (locked.rows[0] === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
      const seqResult = await client.query<{ maxSeq: string | number | null }>(
        'SELECT max(seq) AS "maxSeq" FROM butler_subtasks WHERE task_id=$1', [taskId],
      )
      const start = Number(seqResult.rows[0]?.maxSeq ?? 0)
      const logicalResult = await client.query<{ logicalId: string }>(
        // SQL 空串字面量：JS 侧两个 \' 转义出 <>''（曾误写成一个引号导致整条语句 42601）；
        // 列别名为驼峰（曾漏写别名，读 row.logicalId 拿到 undefined）。
        'SELECT DISTINCT logical_id AS "logicalId" FROM butler_subtasks WHERE task_id=$1 AND logical_id<>\'\'', [taskId],
      )
      // 新目标的标识从现有最大值往下排，不与已有的撞号。
      const nextLogical = logicalResult.rows.reduce((max, row) => {
        const value = Number.parseInt(row.logicalId.replace(/^g/u, ''), 10)
        return Number.isSafeInteger(value) ? Math.max(max, value) : max
      }, 0)
      const ids: string[] = []
      for (const [index, subtask] of subtasks.entries()) {
        await client.query(
          `INSERT INTO butler_subtasks(${SUBTASK_INSERT_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          subtaskInsertValues(actor, taskId, subtask, start + index + 1, subtask.logicalId ?? `g${nextLogical + index + 1}`),
        )
        ids.push(subtask.id)
      }
      await client.query('UPDATE butler_tasks SET updated_at=$1 WHERE id=$2', [Date.now(), taskId])
      return ids
    })
  }

  async counts(actor: Actor): Promise<TaskCounts> {
    const result = await this.run<{ state: string; total: string | number }>(
      'SELECT state, count(*) AS total FROM butler_tasks WHERE owner_namespace=$1 AND owner_id=$2 GROUP BY state',
      [actor.namespace, actor.userId],
    )
    const rows = result.rows.map(row => ({ state: row.state as TaskState, total: Number(row.total) }))
    const pick = (...states: TaskState[]) => rows.filter(row => states.includes(row.state)).reduce((sum, row) => sum + row.total, 0)
    return {
      running: pick('running', 'summarizing'),
      waitingUser: pick('waiting_user'),
      externalPending: pick('external_pending'),
      partial: pick('partial'),
      failed: pick('failed'),
      completed: pick('completed'),
      queued: pick('queued'),
    }
  }

  async recentFailures(actor: Actor, limit: number): Promise<{ id: string; goal: string; error: string; updatedAt: number }[]> {
    const result = await this.run<{ id: string; goal: string; error: string; updatedAt: string | number }>(
      `SELECT t.id AS "id", t.goal AS "goal",
         COALESCE(NULLIF(t.error,''), (SELECT s.error FROM butler_subtasks s WHERE s.task_id=t.id AND s.error!='' ORDER BY s.seq LIMIT 1), '') AS error,
         t.updated_at AS "updatedAt"
       FROM butler_tasks t WHERE t.owner_namespace=$1 AND t.owner_id=$2 AND t.state='failed'
       ORDER BY t.updated_at DESC LIMIT $3`,
      [actor.namespace, actor.userId, limit],
    )
    return result.rows.map(row => ({ id: row.id, goal: row.goal, error: row.error, updatedAt: Number(row.updatedAt) }))
  }

  async failInterrupted(): Promise<number> {
    const now = Date.now()
    return this.withTransaction(async (client) => {
      // §3 重启恢复规格：任务与子任务两条 UPDATE 并为一个事务，避免「任务收了、子任务还转圈」。
      const tasks = await client.query(
        `UPDATE butler_tasks SET state='failed', error=$1, updated_at=$2, finished_at=COALESCE(finished_at,$2)
         WHERE state IN ('queued','running','waiting_user','summarizing')`,
        ['服务已重启，这次任务没有跑完', now],
      )
      if ((tasks.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE butler_subtasks SET state='failed', error=$1, finished_at=COALESCE(finished_at,$2)
           WHERE state IN ('queued','dispatched','running','waiting_user')`,
          ['服务已重启，这个子任务没有跑完', now],
        )
      }
      return tasks.rowCount ?? 0
    })
  }

  async request(actor: Actor, kind: string, requestId: string): Promise<RequestRecord | undefined> {
    const result = await this.run<RequestRow>(
      `SELECT kind,digest,state,run_id AS "runId",conversation_id AS "conversationId",updated_at AS "updatedAt"
       FROM butler_requests WHERE owner_namespace=$1 AND owner_id=$2 AND kind=$3 AND request_id=$4`,
      [actor.namespace, actor.userId, kind, requestId],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return { kind: row.kind, digest: row.digest, state: row.state as RequestRecord['state'], runId: row.runId, conversationId: row.conversationId, updatedAt: Number(row.updatedAt) }
  }

  async claimRequest(actor: Actor, kind: string, requestId: string, digest: string, runId: string, conversationId: string, ttlMs: number): Promise<RequestRecord | undefined> {
    const now = Date.now()
    return this.withTransaction(async (client) => {
      // 顺带清掉过期记录，**只清已完成的**：claimed 意味着「可能已经执行过、结果不明」，
      // 它是防重的唯一依据，永不按时间清除（§3）。
      await client.query(
        `DELETE FROM butler_requests WHERE owner_namespace=$1 AND owner_id=$2 AND state='finished' AND updated_at < $3`,
        [actor.namespace, actor.userId, now - ttlMs],
      )
      // §3：库级唯一约束 (owner_namespace,owner_id,kind,request_id) + ON CONFLICT DO NOTHING，
      // 同事务回读决出胜者；两个并发请求不再可能双双通过「先查有没有」。
      const inserted = await client.query(
        `INSERT INTO butler_requests(owner_namespace,owner_id,kind,request_id,digest,state,run_id,conversation_id,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,'claimed',$6,$7,$8,$8)
         ON CONFLICT (owner_namespace,owner_id,kind,request_id) DO NOTHING`,
        [actor.namespace, actor.userId, kind, requestId, digest, runId, conversationId, now],
      )
      if ((inserted.rowCount ?? 0) > 0) return undefined // 本调用是胜者。
      // 败者同事务回读胜者记录：调用方据它做 digest 冲突与结果不明判定。
      const existing = await client.query<RequestRow>(
        `SELECT kind,digest,state,run_id AS "runId",conversation_id AS "conversationId",updated_at AS "updatedAt"
         FROM butler_requests WHERE owner_namespace=$1 AND owner_id=$2 AND kind=$3 AND request_id=$4`,
        [actor.namespace, actor.userId, kind, requestId],
      )
      const row = existing.rows[0]
      if (row === undefined) {
        throw new StorageError('storage_unknown', '幂等占位冲突后未能读到既有记录（不应发生）')
      }
      return { kind: row.kind, digest: row.digest, state: row.state as RequestRecord['state'], runId: row.runId, conversationId: row.conversationId, updatedAt: Number(row.updatedAt) }
    })
  }

  async bindRequest(actor: Actor, kind: string, requestId: string, runId: string, conversationId: string): Promise<void> {
    // 条件更新语义保持：只补空标识，不覆盖已绑定的（§3）。
    await this.run(
      `UPDATE butler_requests SET run_id=$1, conversation_id=$2, updated_at=$3
       WHERE owner_namespace=$4 AND owner_id=$5 AND kind=$6 AND request_id=$7 AND conversation_id=''`,
      [runId, conversationId, Date.now(), actor.namespace, actor.userId, kind, requestId],
    )
  }

  async finishRequest(actor: Actor, kind: string, requestId: string): Promise<void> {
    await this.run(
      `UPDATE butler_requests SET state='finished', updated_at=$1
       WHERE owner_namespace=$2 AND owner_id=$3 AND kind=$4 AND request_id=$5`,
      [Date.now(), actor.namespace, actor.userId, kind, requestId],
    )
  }

  async releaseRequest(actor: Actor, kind: string, requestId: string): Promise<void> {
    await this.run(
      'DELETE FROM butler_requests WHERE owner_namespace=$1 AND owner_id=$2 AND kind=$3 AND request_id=$4',
      [actor.namespace, actor.userId, kind, requestId],
    )
  }

  /** 【§3 新增专用原子操作】等待超时原子结账：单条条件 UPDATE，只写 error 不碰 result。 */
  async expireWaitingSubtask(taskId: string, subtaskId: string, error: string): Promise<boolean> {
    const result = await this.run(
      `UPDATE butler_subtasks SET state='failed', error=$1, finished_at=COALESCE(finished_at,$2)
       WHERE task_id=$3 AND id=$4 AND state='waiting_user'`,
      [error, Date.now(), taskId, subtaskId],
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * 有界关闭（§2.6）：等待池归位，超过 5 秒放弃等待并记录，池终结交给进程退出。
   * 关闭后其余操作一律拒绝。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    let timer: NodeJS.Timeout | undefined
    try {
      const outcome = await Promise.race([
        this.pool.end().then(
          () => 'closed' as const,
          (error: unknown) => {
            this.reportError(error as Error)
            return 'closed' as const
          },
        ),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS)
        }),
      ])
      if (outcome === 'timeout') {
        this.reportError(new Error(`PostgreSQL 连接池关闭超过 ${Math.round(CLOSE_TIMEOUT_MS / 1000)} 秒，放弃等待；池终结交给进程退出`))
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageError('storage_closed', '存储已关闭，不能继续读写')
  }

  /** 未就绪即不服务（§2.5）：init 失败或未先通过校验时，所有业务读写以稳定错误拒绝。 */
  private assertReady(): void {
    this.assertOpen()
    if (this.readyError !== undefined) throw this.readyError
    if (!this.inited) throw new StorageError('storage_unknown', '存储尚未通过结构校验（init），拒绝读写')
  }

  /** 单语句执行（读或单条写）：出口统一归类稳定码。 */
  private async run<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    this.assertReady()
    try {
      return await this.pool.query<R>(text, values)
    } catch (error) {
      throw mapStorageError(error)
    }
  }

  /** 取连接（归类取连接超时等连接故障）。 */
  private async connectClient(): Promise<PoolClient> {
    try {
      return await this.pool.connect()
    } catch (error) {
      throw mapStorageError(error)
    }
  }

  /**
   * 单连接单事务：checkout → BEGIN → work → COMMIT，异常路径 ROLLBACK；client 在
   * finally 里归还。AccessError 等业务错误原样穿透，其余出口统一归类稳定码。
   */
  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertReady()
    const client = await this.connectClient()
    try {
      await client.query('BEGIN')
      let result: T
      try {
        result = await work(client)
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // 连接已坏：ROLLBACK 失败不必处理，连接随 release 终结。
        }
        throw error
      }
      await client.query('COMMIT')
      return result
    } catch (error) {
      throw mapStorageError(error)
    } finally {
      client.release()
    }
  }
}

interface RequestRow extends QueryResultRow {
  readonly kind: string
  readonly digest: string
  readonly state: string
  readonly runId: string
  readonly conversationId: string
  readonly updatedAt: string | number
}
