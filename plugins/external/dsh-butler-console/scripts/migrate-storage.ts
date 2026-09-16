/**
 * 牛马大总管存量库迁移工具：把旧 SQLite 工作台库一次性导入 PostgreSQL。
 *
 * 行为规格：《存量迁移/回滚验证方案》与《非框架插件业务库 PostgreSQL 默认方案》§6：
 *
 * - 源库**只读**打开（node:sqlite readOnly），逐版本直导、不做就地升级；旧库保持只读封存，
 *   本工具对源库不做任何写入。
 * - 源版本 0..9：0 = 空库（只初始化目标结构）；1..9 = 按缺列投影直导；10+ 或结构无法识别
 *   = 拒绝（退出码 2，打印实际与所需版本）。上限 9 与 `TARGET_SCHEMA_VERSION` 同源——源库
 *   版本比目标还新时直导会把新列**静默丢掉**，所以宁可拒绝。
 * - 缺列投影与旧 migrate() 链等价：文本列 `''`（含 v9 的 `acceptance`）、
 *   `accepted_version`/`processed_version` 1、`requires_external_action` 0、可空列为 NULL；
 *   v1..v4 缺 `logical_id` 列按 `'g'||seq` 回填（每条子任务各自当一个目标），v5+ 已有值
 *   原样保留、空值不补造。
 * - 结构初始化（0001_init.sql）、导入与校验在**同一个 PG 事务**内；停写点复核（源库指纹
 *   导入前后比对）在 COMMIT 之前，不一致则整体回滚（退出码 4），目标库保持空。
 * - 损坏的 input_refs / depends_on / member_return 等 JSON 原样搬入，不修补、不拦截。
 * - `claimed` 幂等记录（结果不明请求）永不清理，导入后打印人工核对清单。
 *
 * 用法：`node dist/migrate-storage.mjs --source <sqlite 路径> (--dsn <DSSN> | 环境变量
 * BUTLER_MIGRATE_PG_DSN) [--dry-run]`。DSN 只经参数或环境变量传入——本工具不内置任何
 * 默认连接串，也不会打印或记录 DSN。
 *
 * 退出码：0 成功；1 参数/连接/校验失败；2 源库版本无法迁移；3 目标库不是可导入状态；
 * 4 停写点复核失败（导入期间源库有新写入，本次导入已整体回滚）。
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'

/** 目标库结构版本。与 `migrations/postgres/0001_init.sql` 写入的版本行、`src/storage/postgres.ts` 的 STORAGE_SCHEMA_VERSION 保持一致。 */
const TARGET_SCHEMA_VERSION = 9
/** 可迁移的源库 `PRAGMA user_version` 上限；0 表示空库。 */
const MAX_SOURCE_VERSION = 9
/** 这四张表自 v1 就存在；user_version ≥ 1 的源库缺任何一张即视为来历不明。 */
const BASE_TABLES: readonly string[] = ['conversations', 'tasks', 'subtasks', 'agent_aliases']

const MIGRATION_SQL_URL = new URL('../migrations/postgres/0001_init.sql', import.meta.url)
/** 分批仅为绑定参数上限与内存控制；原子性仍由外层单事务保证，任一批失败整体回滚。 */
const INSERT_CHUNK = 100

/** 迁移工具的失败：`exitCode` 对应 CLI 退出码，供 main() 转换、测试直接断言。 */
export class MigrationFailure extends Error {
  readonly exitCode: number

  constructor(exitCode: number, message: string) {
    super(message)
    this.name = 'MigrationFailure'
    this.exitCode = exitCode
  }
}

type ColKind = 'text' | 'int' | 'blob'

interface ColSpec {
  readonly name: string
  readonly kind: ColKind
  readonly nullable: boolean
}

interface TableSpec {
  readonly name: string
  readonly pk: readonly string[]
  readonly columns: readonly ColSpec[]
}

const text = (name: string): ColSpec => ({ name, kind: 'text', nullable: false })
const int = (name: string, nullable = false): ColSpec => ({ name, kind: 'int', nullable })
const blob = (name: string): ColSpec => ({ name, kind: 'blob', nullable: true })

/** 目标全量列清单（顺序即校验和的规范化顺序），与 0001_init.sql 的表结构一一对应。 */
const TABLE_SPECS: readonly TableSpec[] = [
  {
    name: 'conversations', pk: ['id'],
    columns: [text('id'), text('owner_namespace'), text('owner_id'), text('title'), int('created_at'), int('updated_at')],
  },
  {
    name: 'tasks', pk: ['id'],
    columns: [
      text('id'), text('conversation_id'), text('owner_namespace'), text('owner_id'), text('goal'),
      // v9 的验收口径。**必须列在这里**：这张清单是"目标全量列"的唯一来源，缺一列的话
      // 源库（最高 v8、没有这一列）与新库（v9、有）之间会**静默丢字段**——导入时按清单
      // 生成 INSERT，漏掉的列拿不到值，而校验和只算清单里的列，谁也发现不了。
      text('acceptance'),
      text('state'),
      text('note'), text('summary'), text('error'), int('accepted_version'), int('processed_version'),
      int('created_at'), int('updated_at'), int('finished_at', true),
    ],
  },
  {
    name: 'subtasks', pk: ['task_id', 'id'],
    columns: [
      text('task_id'), text('id'), int('seq'), text('goal'), text('acceptance'), text('agent_id'),
      text('reason'), text('state'),
      text('result'), text('error'), text('artifacts'), text('conversation_id'), text('logical_id'),
      text('supersedes'), text('depends_on'), int('requires_external_action'), text('input_refs'),
      text('member_return'), int('started_at', true), int('finished_at', true),
    ],
  },
  {
    name: 'agent_aliases', pk: ['owner_namespace', 'owner_id', 'agent_id'],
    columns: [
      text('owner_namespace'), text('owner_id'), text('agent_id'), text('display_name'), text('accent'),
      blob('avatar'), text('avatar_type'), int('updated_at'),
    ],
  },
  {
    name: 'requests', pk: ['owner_namespace', 'owner_id', 'kind', 'request_id'],
    columns: [
      text('owner_namespace'), text('owner_id'), text('kind'), text('request_id'), text('digest'),
      text('state'), text('run_id'), text('conversation_id'), int('created_at'), int('updated_at'),
    ],
  },
  {
    name: 'task_inputs', pk: ['task_id', 'version'],
    columns: [text('task_id'), int('version'), text('text'), text('source'), int('created_at')],
  },
]

/** 从源库读出并投影到目标全列形状的一张表。 */
interface LoadedTable {
  readonly spec: TableSpec
  /** 源库里这张表是否存在（v1/v2 没有 requests、v1..v3 没有 task_inputs）。 */
  readonly exists: boolean
  /** 每行的列值与 `spec.columns` 同序；缺列已按投影规则补默认值。 */
  readonly rows: readonly (readonly unknown[])[]
}

export interface MigrationOptions {
  readonly sourcePath: string
  readonly dsn: string
  /** 只盘点与校验：不初始化结构、不导入，也不改写源库。 */
  readonly dryRun?: boolean | undefined
  readonly log?: ((line: string) => void) | undefined
  /**
   * 验收/测试注入点：导入事务写入完成、停写点复核之前触发，用于模拟「停写被破坏」
   * （源库在导入期间被并发写入）并验证退出码 4 与整体回滚路径。生产使用时不传。
   */
  readonly onBeforeStopWriteRecheck?: (() => void | Promise<void>) | undefined
}

interface ParsedArgs {
  source: string | undefined
  dsn: string | undefined
  dryRun: boolean
  help: boolean
}

const USAGE = `用法：node dist/migrate-storage.mjs --source <sqlite 路径> [--dsn <PostgreSQL DSN>] [--dry-run]

--source    旧工作台 SQLite 库（只读打开；典型位置 <DSH 主目录>/plugins/butler/butler.sqlite）
--dsn       目标 PostgreSQL DSN；省略时读环境变量 BUTLER_MIGRATE_PG_DSN。必须指向独立空库；
            DSN 不会被打印或记录
--dry-run   只做源库盘点与目标库状态校验，不写入任何数据

退出码：0 成功；1 参数/连接/校验失败；2 源库版本无法迁移（支持 0..${MAX_SOURCE_VERSION}）；
        3 目标库不是空库或已初始化的空结构；4 停写点复核失败（本次导入已整体回滚）`

/**
 * 回显前脱敏：`--key=value` 只显示键名，任何形如连接串的裸值整体打码——
 * 错误消息与 DSN 不得同框（DSN 含密码，绝不进日志）。
 */
function redactArg(arg: string): string {
  const eq = arg.indexOf('=')
  if (eq >= 0) return `${arg.slice(0, eq)}=<…>`
  return arg.includes('://') ? '<已脱敏：疑似连接串>' : arg
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { source: undefined, dsn: undefined, dryRun: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) break
    // 支持 GNU 习惯的 `--key=value` 写法：这类值可能带凭据，必须当作已知参数消化掉，
    // 否则会掉进未知参数分支被回显。
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
    if (name === '--source') parsed.source = inlineValue ?? argv[index += 1]
    else if (name === '--dsn') parsed.dsn = inlineValue ?? argv[index += 1]
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new MigrationFailure(1, `未知参数：${redactArg(arg)}\n\n${USAGE}`)
  }
  return parsed
}

/** 只读打开源库。文件不存在、打不开或库损坏时按普通失败（退出码 1）报错。 */
function openSource(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    throw new Error(`源库打开失败（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version?: unknown } | undefined
  return Number(row?.user_version ?? 0)
}

function existingTables(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as unknown as { name: unknown }[]
  return new Set(rows.map(row => String(row.name)))
}

/** 源库某张表实际存在的列（只保留目标形状里有的列，源库多出来的列不导入）。 */
function presentColumns(db: DatabaseSync, spec: TableSpec, exists: boolean): Set<string> {
  if (!exists) return new Set()
  const rows = db.prepare(`PRAGMA table_info(${spec.name})`).all() as unknown as { name: unknown }[]
  const names = new Set(rows.map(row => String(row.name)))
  return new Set(spec.columns.filter(col => names.has(col.name)).map(col => col.name))
}

/**
 * 缺列投影：与旧 migrate() 链的 ALTER 结果逐列等价。
 *
 * `logical_id` 是唯一非平凡变换：v1..v4 没有这一列，按 `'g'||seq` 回填；v5+ 库已有值
 * （含空值）一律原样保留——旧链从 v5 起也不会再补。`accepted_version`/`processed_version`
 * 在 v1..v3 缺列时按 1（只有最初那条需求），`requires_external_action` 按 0（与加列前
 * 行为一致），可空列补 NULL，其余文本列补 ''。
 */
function projectCell(row: Record<string, unknown>, col: ColSpec, present: ReadonlySet<string>): unknown {
  if (present.has(col.name)) return row[col.name] ?? null
  if (col.name === 'logical_id') return `g${Number(row['seq'] ?? 0)}`
  if (col.name === 'accepted_version' || col.name === 'processed_version') return 1
  if (col.nullable) return null
  return col.kind === 'int' ? 0 : ''
}

function loadSourceTable(db: DatabaseSync, spec: TableSpec, existing: ReadonlySet<string>): LoadedTable {
  const exists = existing.has(spec.name)
  const present = presentColumns(db, spec, exists)
  if (!exists) return { spec, exists, rows: [] }
  // 结构无法识别的表不能静默按空表导入——主键列都凑不齐，说明它不是我们认识的库，
  // 按源库版本无法迁移拒绝（退出码 2），而不是丢掉这批数据还自洽通过校验。
  if (present.size === 0 || !spec.pk.every(col => present.has(col))) {
    throw new MigrationFailure(2, `源库表 ${spec.name} 结构无法识别（存在但缺主键列 ${spec.pk.join(',')}），拒绝导入；支持 user_version 0..${MAX_SOURCE_VERSION}`)
  }
  const selectList = spec.columns.filter(col => present.has(col.name)).map(col => col.name).join(',')
  const rawRows = db.prepare(`SELECT ${selectList} FROM ${spec.name}`).all() as unknown as Record<string, unknown>[]
  return { spec, exists, rows: rawRows.map(row => spec.columns.map(col => projectCell(row, col, present))) }
}

/** 单元格规范化：让 SQLite 与 PG 两边不同 JS 类型（number vs bigint 字符串、BLOB vs bytea）算出同一摘要。 */
function canonicalCell(value: unknown, kind: ColKind): string {
  if (value === null || value === undefined) return 'NULL'
  if (kind === 'int') return `i${Number(value)}`
  if (kind === 'blob') return `b${Buffer.from(value as Uint8Array).toString('hex')}`
  return `t${JSON.stringify(String(value))}`
}

function canonicalRow(row: readonly unknown[], spec: TableSpec): string {
  return spec.columns.map((col, index) => canonicalCell(row[index], col.kind)).join('\u001F')
}

function tableDigest(table: LoadedTable): string {
  const lines = table.rows.map(row => canonicalRow(row, table.spec)).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 源库指纹：全部业务表的全部行内容摘要，用于停写点复核（计数与最大 updated_at 之外再兜一层）。 */
function fingerprintOf(tables: readonly LoadedTable[]): string {
  const hash = createHash('sha256')
  for (const table of tables) hash.update(`${table.spec.name}:${tableDigest(table)}\n`)
  return hash.digest('hex')
}

function toParam(value: unknown, kind: ColKind): unknown {
  if (value === null || value === undefined) return null
  if (kind === 'blob') return Buffer.from(value as Uint8Array)
  if (kind === 'int') return Number(value)
  return String(value)
}

async function insertTable(client: PoolClient, table: LoadedTable): Promise<void> {
  if (table.rows.length === 0) return
  const columns = table.spec.columns.map(col => col.name).join(',')
  for (let start = 0; start < table.rows.length; start += INSERT_CHUNK) {
    const slice = table.rows.slice(start, start + INSERT_CHUNK)
    const values: unknown[] = []
    const tuples = slice.map(row =>
      `(${row.map((value, index) => `$${values.push(toParam(value, table.spec.columns[index]!.kind))}`).join(',')})`)
    await client.query(`INSERT INTO ${table.spec.name}(${columns}) VALUES ${tuples.join(',')}`, values)
  }
}

/** 源盘点：各表行数、owner 分布、各表最新时间戳、claimed 请求数。 */
function summarize(tables: readonly LoadedTable[]): {
  counts: Map<string, number>
  owners: Map<string, number>
  claimed: { owner: string; kind: string; requestId: string; digest: string; updatedAt: number }[]
  latest: Map<string, number | null>
} {
  const counts = new Map<string, number>()
  const owners = new Map<string, number>()
  const claimed: { owner: string; kind: string; requestId: string; digest: string; updatedAt: number }[] = []
  const latest = new Map<string, number | null>()
  for (const table of tables) {
    counts.set(table.spec.name, table.rows.length)
    latest.set(table.spec.name, null)
  }
  const indexOf = (spec: TableSpec, name: string): number => spec.columns.findIndex(col => col.name === name)
  for (const table of tables) {
    const spec = table.spec
    const nsIndex = indexOf(spec, 'owner_namespace')
    const idIndex = indexOf(spec, 'owner_id')
    const timeIndex = indexOf(spec, spec.name === 'task_inputs' ? 'created_at' : spec.name === 'subtasks' ? 'finished_at' : 'updated_at')
    const stateIndex = indexOf(spec, 'state')
    const kindIndex = indexOf(spec, 'kind')
    const requestIndex = indexOf(spec, 'request_id')
    const digestIndex = indexOf(spec, 'digest')
    for (const row of table.rows) {
      if (nsIndex >= 0 && idIndex >= 0) {
        const key = `${String(row[nsIndex])}/${String(row[idIndex])}`
        owners.set(key, (owners.get(key) ?? 0) + 1)
      }
      if (timeIndex >= 0) {
        const stamp = row[timeIndex]
        if (typeof stamp === 'number' && stamp !== null) {
          const current = latest.get(spec.name)
          if (current === null || current === undefined || stamp > current) latest.set(spec.name, stamp)
        }
      }
      if (spec.name === 'requests' && stateIndex >= 0 && row[stateIndex] === 'claimed') {
        claimed.push({
          owner: `${String(row[nsIndex])}/${String(row[idIndex])}`,
          kind: String(row[kindIndex]),
          requestId: String(row[requestIndex]),
          digest: String(row[digestIndex]),
          updatedAt: Number(row[indexOf(spec, 'updated_at')]),
        })
      }
    }
  }
  return { counts, owners, claimed, latest }
}

interface TargetState {
  /** true = 空库，需要在导入事务里先应用 0001_init.sql。 */
  readonly needInit: boolean
  readonly database: string
}

/** 目标库状态核验：只接受空库，或已按 0001_init.sql 初始化且业务表全空的库；其余拒绝（退出码 3）。 */
async function inspectTarget(client: PoolClient): Promise<TargetState> {
  const current = await client.query<{ name: string }>('SELECT current_database() AS name')
  const database = current.rows[0]?.name ?? '(未知)'
  await client.query("SET search_path = 'public'")
  const found = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  )
  const names = new Set(found.rows.map(row => row.table_name))
  if (names.size === 0) return { needInit: true, database }
  if (!names.has('schema_version')) {
    throw new MigrationFailure(
      3,
      `目标库（${database}）的 public schema 已有 ${names.size} 张表但没有 schema_version 版本表，无法确认结构版本；只接受空库或已按 migrations/postgres/0001_init.sql 初始化的库`,
    )
  }
  const versionResult = await client.query<{ version: string | number }>('SELECT version FROM schema_version')
  const version = Number(versionResult.rows[0]?.version ?? Number.NaN)
  if (version !== TARGET_SCHEMA_VERSION) {
    throw new MigrationFailure(3, `目标库结构版本不符：实际 ${version}，期望 ${TARGET_SCHEMA_VERSION}；请改用独立空库，或把该库修回初始结构`)
  }
  const missing = TABLE_SPECS.map(spec => spec.name).filter(name => !names.has(name))
  if (missing.length > 0) {
    throw new MigrationFailure(3, `目标库结构不完整（版本 ${version}），缺表：${missing.join('、')}`)
  }
  for (const spec of TABLE_SPECS) {
    const count = await client.query<{ total: string | number }>(`SELECT count(*) AS total FROM ${spec.name}`)
    if (Number(count.rows[0]?.total ?? 0) > 0) {
      throw new MigrationFailure(3, `目标库业务表 ${spec.name} 非空；导入只接受空库（或已初始化且全空的库），不叠加、不合并`)
    }
  }
  return { needInit: false, database }
}

/** 导入后校验：版本行、逐表行数与规范化校验和（隐含主键集合与逐列比对）、关联完整性 spot check。 */
async function verifyImport(client: PoolClient, tables: readonly LoadedTable[]): Promise<string> {
  const versionResult = await client.query<{ version: string | number }>('SELECT version FROM schema_version')
  const version = Number(versionResult.rows[0]?.version ?? Number.NaN)
  if (version !== TARGET_SCHEMA_VERSION) throw new Error(`导入后版本行校验失败：实际 ${version}，期望 ${TARGET_SCHEMA_VERSION}`)
  for (const table of tables) {
    const columnList = table.spec.columns.map(col => col.name).join(',')
    const result = await client.query<Record<string, unknown>>(`SELECT ${columnList} FROM ${table.spec.name}`)
    const expected = table.rows.map(row => canonicalRow(row, table.spec)).sort()
    const actual = result.rows
      .map(row => canonicalRow(table.spec.columns.map(col => row[col.name]), table.spec))
      .sort()
    if (actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
      throw new Error(`表 ${table.spec.name} 导入后校验不一致：期望 ${expected.length} 行（含全部列值），实际 ${actual.length} 行`)
    }
  }
  const orphans = await client.query<{ subtasks: string | number; taskInputs: string | number; taskConversations: string | number }>(`
    SELECT (SELECT count(*) FROM subtasks s LEFT JOIN tasks t ON t.id = s.task_id WHERE t.id IS NULL) AS subtasks,
           (SELECT count(*) FROM task_inputs i LEFT JOIN tasks t ON t.id = i.task_id WHERE t.id IS NULL) AS "taskInputs",
           (SELECT count(*) FROM tasks t LEFT JOIN conversations c ON c.id = t.conversation_id WHERE c.id IS NULL) AS "taskConversations"`)
  const orphanRow = orphans.rows[0]
  const orphanSubtasks = Number(orphanRow?.subtasks ?? 0)
  const orphanInputs = Number(orphanRow?.taskInputs ?? 0)
  const orphanTaskConversations = Number(orphanRow?.taskConversations ?? 0)
  if (orphanSubtasks + orphanInputs + orphanTaskConversations > 0) {
    throw new Error(`关联完整性 spot check 失败：悬空子任务 ${orphanSubtasks}、悬空输入 ${orphanInputs}、任务指向不存在会话 ${orphanTaskConversations}`)
  }
  return `悬空子任务 ${orphanSubtasks}、悬空输入 ${orphanInputs}、悬空任务会话 ${orphanTaskConversations}`
}

function printClaimedList(claimed: { owner: string; kind: string; requestId: string; digest: string; updatedAt: number }[], log: (line: string) => void): void {
  if (claimed.length === 0) {
    log('claimed 结果不明请求：0 条')
    return
  }
  log(`claimed 结果不明请求：${claimed.length} 条（人工核对项：受理后没有终态证据，迁移后永不按时间清理）`)
  for (const item of claimed) {
    log(`  - ${item.owner} ${item.kind} ${item.requestId} digest=${item.digest} updated_at=${item.updatedAt}`)
  }
}

/**
 * 执行一次迁移。规格见文件头。失败以 {@link MigrationFailure}（带退出码）或普通 Error 抛出。
 */
export async function runMigration(options: MigrationOptions): Promise<void> {
  const log = options.log ?? ((line: string) => { console.log(line) })
  const db = openSource(options.sourcePath)
  try {
    const version = readUserVersion(db)
    const existing = existingTables(db)
    if (version < 0 || version > MAX_SOURCE_VERSION) {
      throw new MigrationFailure(2, `源库版本无法迁移：实际 ${version}，本工具支持 0..${MAX_SOURCE_VERSION}（0 = 空库直接初始化目标结构）`)
    }
    if (version >= 1) {
      const missingBases = BASE_TABLES.filter(name => !existing.has(name))
      if (missingBases.length > 0) {
        throw new MigrationFailure(2, `源库 user_version=${version} 但缺少基础表 ${missingBases.join('、')}，结构来历不明，拒绝迁移`)
      }
    } else if (existing.size > 0) {
      throw new MigrationFailure(2, `源库 user_version=0 但已有表（${[...existing].join('、')}），结构来历不明；0 只接受空库`)
    }
    const loaded = TABLE_SPECS.map(spec => loadSourceTable(db, spec, existing))
    const inventory = summarize(loaded)
    const fingerprint = fingerprintOf(loaded)
    log(`源库盘点（只读）：${options.sourcePath}`)
    log(`  user_version = ${version}${version === 0 ? '（空库，只初始化目标结构）' : ''}`)
    for (const [name, count] of inventory.counts) {
      const latestStamp = inventory.latest.get(name)
      log(`  ${name}: ${count} 行${latestStamp === null || latestStamp === undefined ? '' : `，最新时间戳 ${latestStamp}`}`)
    }
    log(`  owner 分布：${[...inventory.owners].map(([owner, count]) => `${owner}×${count}`).join('、') || '（无）'}`)
    log(`  claimed 请求数：${inventory.claimed.length}`)
    log(`  内容指纹：${fingerprint.slice(0, 16)}…`)

    const pool = new Pool({ connectionString: options.dsn, max: 1, connectionTimeoutMillis: 10000 })
    // 空闲连接的后台错误必须有人接住，否则会成为进程级未捕获异常。
    pool.on('error', error => { log(`目标库连接池错误：${error.message}`) })
    const client = await pool.connect()
    try {
      const state = await inspectTarget(client)
      log(`目标库：已连接（数据库 ${state.database}），${state.needInit ? '空库——将在同一事务内应用 migrations/postgres/0001_init.sql' : '结构已初始化且业务表为空'}`)
      if (options.dryRun === true) {
        log('dry-run 结束：未写入任何数据。')
        return
      }
      await client.query('BEGIN')
      try {
        if (state.needInit) await client.query(readFileSync(MIGRATION_SQL_URL, 'utf8'))
        for (const table of loaded) await insertTable(client, table)
        const referential = await verifyImport(client, loaded)
        const imported = summarize(loaded).counts
        log('导入后校验：版本行、逐表行数与规范化校验和一致；关联 spot check 通过（' + referential + '）')
        printClaimedList(inventory.claimed, log)
        // 停写点复核：COMMIT 前重新读取源库全量指纹。不一致说明导入期间源库有新写入，
        // 本次导入的完整性无法证明 —— 整体回滚，目标库保持空，由操作者确认停写后重来。
        // 注意残余窗口：复核读取之后、COMMIT 之前的写入检测不到——指纹是兜底不是锁，
        // 真正的停写保证来自运维流程（停插件写入口），不来自本工具。
        if (options.onBeforeStopWriteRecheck !== undefined) await options.onBeforeStopWriteRecheck()
        const fingerprintAfter = fingerprintOf(TABLE_SPECS.map(spec => loadSourceTable(db, spec, existingTables(db))))
        if (fingerprintAfter !== fingerprint) {
          throw new MigrationFailure(4, `停写点复核失败：源库指纹导入前后不一致（${fingerprint.slice(0, 16)}… → ${fingerprintAfter.slice(0, 16)}…），源库在导入期间有新写入。本次导入已整体回滚，目标库保持空；请先让旧库停写（只读封存）再重新执行`)
        }
        try {
          await client.query('COMMIT')
        } catch (error) {
          // COMMIT 阶段的失败是「结果不明」而不是「确定没提交」：事务可能已在服务端落盘。
          // 单独报出来，避免操作者按普通失败盲目重跑（重跑会因目标非空被退出码 3 拒绝，
          // 但消息应先说清该核查什么）。
          throw new MigrationFailure(1, `提交结果不明：COMMIT 发送时出错（${error instanceof Error ? error.message : String(error)}）。事务可能已在服务端提交——先连接目标库核查 schema_version 与各表行数，确认后再决定后续动作，不要盲目重跑`)
        }
        log('── 迁移报告 ──')
        log(`源库：${options.sourcePath}（user_version=${version}，只读，未做任何写入）`)
        log(`目标库：${state.database}（${state.needInit ? '本次初始化结构并导入' : '结构已就绪，直接导入'}）`)
        log(`导入行数：${[...imported].map(([name, count]) => `${name} ${count}`).join('、')}`)
        log('校验：表数量、逐表行数、主键集合（经规范化行集合）、逐列校验和一致；关联完整性通过')
        log(`停写点复核：源库指纹导入前后一致（${fingerprint.slice(0, 16)}…）`)
        log('回滚边界：旧 SQLite 库保持只读封存、未做任何写入，导入失败时目标库整体回滚；PostgreSQL 一旦开始接受新写入（切换配置、插件正常运行），即不支持无损快速切回 SQLite——只能修复 PG 或执行经验证的反向迁移。切换前请先用 VACUUM INTO 或 backup API 留下 SQLite 快照。')
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // 连接已坏或已不在事务内：回滚失败不影响结论，导入未提交即视为未发生。
        }
        throw error
      }
    } finally {
      client.release()
      await pool.end().catch(() => {})
    }
  } finally {
    db.close()
  }
}

/**
 * CLI 入口：解析参数并执行迁移，返回退出码（不直接 process.exit，便于测试与嵌入）。
 * DSN 解析顺序：`--dsn` 参数 > 环境变量 `BUTLER_MIGRATE_PG_DSN`；没有默认值，绝不内置凭据。
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = (line) => { console.log(line) },
): Promise<number> {
  try {
    const args = parseArgs(argv)
    if (args.help) {
      log(USAGE)
      return 0
    }
    if (args.source === undefined) {
      console.error('缺少 --source <sqlite 路径>。\n')
      console.error(USAGE)
      return 1
    }
    const dsn = args.dsn?.trim() || env.BUTLER_MIGRATE_PG_DSN?.trim()
    if (dsn === undefined || dsn === '') {
      console.error('缺少目标 DSN：用 --dsn <PostgreSQL DSN> 或环境变量 BUTLER_MIGRATE_PG_DSN 提供（本工具不内置任何默认连接串）。')
      return 1
    }
    await runMigration({ sourcePath: args.source, dsn, dryRun: args.dryRun, log })
    return 0
  } catch (error) {
    if (error instanceof MigrationFailure) {
      console.error(error.message)
      return error.exitCode
    }
    console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code })
}
