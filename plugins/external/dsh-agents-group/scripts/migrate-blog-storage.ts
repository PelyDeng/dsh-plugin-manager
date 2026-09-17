/**
 * blog 业务存量迁移工具：把旧 SQLite（博客业务 5 表 + 译文单表）一次性导入 PostgreSQL。
 *
 * 规格来源：批 2 群组业务迁 PG 实施方案 §4 B2-2c（蓝本为牛马大总管 scripts/migrate-storage.ts，
 * 结构逐段对照，差异全部来自博客现状语义）：
 *
 * - 源 `blog.sqlite` **只读**打开（node:sqlite readOnly）：业务 5 表 drafts/jobs/operations/
 *   audit/attachments。索引 3 表（conversations/chat_requests/chat_results）与协作映射表
 *   （pirate_blog_conversations）**迁后仍留在这个文件里当索引库**——导入不读它们，清源不动
 *   它们，只作为清源前后的行数核对对象。
 * - 业务 5 表全不存在 = 已迁移/无需迁移（退出码 0）；部分存在，或存在但列不齐 = 结构无法识别
 *   （退出码 2，不按“空表”静默导入）。源 `PRAGMA user_version` 期望 0/1，其他值如实记录后
 *   按表存在性继续——本工具一次建全目标形状，不走逐版迁移链。
 * - 译文源 `reasoning-translations.sqlite` 的单表 translations 可选导入（--translations）；
 *   没给参数时若同目录存在该文件只提示、不导入。
 * - SQLite 的隐式 rowid 序在目标里显式化为 `seq`（BIGSERIAL UNIQUE）：jobs/operations/
 *   attachments/translations 用源 rowid 为 seq，audit 用源 rowid（= 它的 `id INTEGER PRIMARY
 *   KEY` 别名）为 id。导入后必须 **setval 复位五个序列**，否则后续不带 seq 的 INSERT 会撞
 *   UNIQUE（B2-2a 评审备忘 #1）。
 * - 结构初始化（agents/blog/migrations/postgres/0001_init.sql）、分批导入、导入后校验（版本行、
 *   逐表行数、主键集合、逐列规范化校验和、记录身份 spot check）与序列复位都在**同一个 PG
 *   事务**内；停写点复核（源库指纹导入前后比对）在 COMMIT 之前，不一致则整体回滚（退出码 4），
 *   目标库保持空。
 * - `--clear-source`：导入 COMMIT 之后，先用 `VACUUM INTO` 把源库快照写到 `--backup` 路径
 *   （备份先行，禁止裸拷主文件与 WAL——T2-3 现场踩过 WAL 陷阱），再单事务 DROP 业务 5 表。
 *   清源前二次核对停写指纹与业务表清单，DROP 前后核对索引表行数不变。
 *
 * 用法：`node dist/migrate-blog-storage.mjs --blog <blog.sqlite 路径> [--translations <译文源>]
 * (--dsn <DSN> | 环境变量 AGENTS_GROUP_MIGRATE_PG_DSN) [--dry-run] [--clear-source --backup <快照>]`。
 * DSN 只经参数或环境变量传入——本工具不内置任何默认连接串，也不会打印或记录 DSN。
 *
 * 退出码：0 成功（含无需迁移与 --dry-run）；1 参数/连接/校验/备份失败；2 源库无法识别；
 * 3 目标库不是可导入状态；4 停写点复核失败（导入已整体回滚，或清源被拒绝）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'

/** 目标库结构版本。与 `agents/blog/migrations/postgres/0001_init.sql` 写入的版本行、`agents/blog/src/storage/pg.ts` 的 STORAGE_SCHEMA_VERSION 一致。 */
const TARGET_SCHEMA_VERSION = 1
/** 版本表名（库内表按插件前缀平铺，其他 Agent 迁入时各管各的版本行）。 */
const VERSION_TABLE = 'blog_schema_version'
/**
 * 索引库里的表：清源时**必须原样保留**（博客索引、对话请求与结果，以及协作任务到博客会话的
 * 映射）。清源前后逐表核对行数；本工具不读它们的内容，也不写它们。
 */
const INDEX_TABLES: readonly string[] = ['conversations', 'chat_requests', 'chat_results', 'pirate_blog_conversations']

const MIGRATION_SQL_URL = new URL('../agents/blog/migrations/postgres/0001_init.sql', import.meta.url)
/**
 * 分批 INSERT 只解决绑定参数上限；源表已整表物化在内存（博客体量 MB 级，可接受），
 * 原子性由外层单事务保证，任一批失败整体回滚。
 */
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

type ColKind = 'text' | 'int'

interface ColSpec {
  /** 源 SQLite 列名（现状写法：部分列是 camelCase）；`null` = 目标 serial 列，值取源 rowid。 */
  readonly source: string | null
  /** 目标 PG 列名（0001_init.sql 的 snake_case）。 */
  readonly target: string
  readonly kind: ColKind
}

interface TableSpec {
  /** 源 SQLite 表名。 */
  readonly source: string
  /** 目标 PG 表名（blog_ 前缀平铺在群组单库里）。 */
  readonly target: string
  /** 目标表主键列（校验时按规范化行集合整体比对，主键集合因此一并覆盖）。 */
  readonly pk: readonly string[]
  /**
   * BIGSERIAL 列（jobs/operations/attachments/translations 的 seq、audit 的 id）：值取源 rowid，
   * 导入后该列序列必须 setval 复位，否则后续不带该列的 INSERT 会撞 UNIQUE。
   */
  readonly serial?: { readonly column: string }
  /** 目标列顺序；`source: null` 的位置就是 serial 列。 */
  readonly columns: readonly ColSpec[]
  /**
   * 记录身份 spot check：`data` JSON 里必须与投影列一致的字段（目标列名 → JSON 字段名）。
   * 这些字段在现状所有写路径里都由同一次赋值同时落库与落 JSON，不一致只可能是列映射写错或
   * 记录被改过——行集合校验和发现不了列映射错误，只有这一步能发现。
   */
  readonly identity: readonly (readonly [column: string, key: string])[]
}

const text = (source: string | null, target: string): ColSpec => ({ source, target, kind: 'text' })
const int = (source: string | null, target: string): ColSpec => ({ source, target, kind: 'int' })

/** 目标全量列清单（顺序即校验和的规范化顺序），与 0001_init.sql 逐列一一对应。 */
const TABLE_SPECS: readonly TableSpec[] = [
  {
    source: 'drafts', target: 'blog_drafts', pk: ['id'],
    columns: [text('id', 'id'), text('owner', 'owner'), int('revision', 'revision'), int('updated', 'updated'), text('data', 'data')],
    identity: [['id', 'id'], ['revision', 'revision'], ['updated', 'updatedAt']],
  },
  {
    source: 'jobs', target: 'blog_jobs', pk: ['id'], serial: { column: 'seq' },
    columns: [
      text('id', 'id'), text('owner', 'owner'), text('caller', 'caller'), text('requestId', 'request_id'),
      text('inputHash', 'input_hash'), int(null, 'seq'), text('data', 'data'),
    ],
    identity: [['id', 'id'], ['owner', 'owner'], ['caller', 'caller'], ['request_id', 'requestId']],
  },
  {
    source: 'operations', target: 'blog_operations', pk: ['id'], serial: { column: 'seq' },
    columns: [
      text('id', 'id'), text('owner', 'owner'), text('draftId', 'draft_id'), int('revision', 'revision'),
      int(null, 'seq'), text('data', 'data'),
    ],
    identity: [['id', 'id'], ['owner', 'owner'], ['draft_id', 'draftId']],
  },
  {
    // audit 的 id 是 rowid 别名：导入时显式写源 rowid，不重排审计序。
    source: 'audit', target: 'blog_audit', pk: ['id'], serial: { column: 'id' },
    columns: [int(null, 'id'), int('at', 'at'), text('owner', 'owner'), text('action', 'action'), text('data', 'data')],
    // audit 的 data 是任意审计载荷，没有身份字段可核。
    identity: [],
  },
  {
    source: 'attachments', target: 'blog_attachments', pk: ['id'], serial: { column: 'seq' },
    columns: [
      text('id', 'id'), text('owner', 'owner'), text('draftId', 'draft_id'), int(null, 'seq'), text('data', 'data'),
    ],
    identity: [['id', 'id'], ['owner', 'owner'], ['draft_id', 'draftId']],
  },
]

/** 译文单表（reasoning-translations.sqlite 的 translations，源自 reasoning-translation.ts）。 */
const TRANSLATION_SPEC: TableSpec = {
  source: 'translations', target: 'blog_translations', pk: ['id'], serial: { column: 'seq' },
  columns: [
    text('id', 'id'), text('cacheKey', 'cache_key'), text('owner', 'owner'), text('status', 'status'),
    int(null, 'seq'), text('data', 'data'),
  ],
  // 留档 JSON 是 audit 对象：id 列写的是 requestId，JSON 里也有 requestId。
  identity: [['id', 'requestId']],
}

/** 从源库读出并投影到目标全列形状的一张表。 */
interface LoadedTable {
  readonly spec: TableSpec
  /** 每行的目标列值（与 `spec.columns` 同序；serial 列已用源 rowid 填好）。 */
  readonly rows: readonly (readonly unknown[])[]
  /** 每行的源 rowid（与 rows 同序）：只参与停写指纹，不导入。 */
  readonly rowids: readonly number[]
}

export interface MigrationOptions {
  /** 旧业务库：`<DSH 主目录>/plugins/blog/blog.sqlite`（拆库后它只剩索引表）。 */
  readonly blogPath: string
  /** 译文源 `reasoning-translations.sqlite`；省略时若有同目录同名文件只提示、不导入。 */
  readonly translationsPath?: string | undefined
  /** 目标 PostgreSQL DSN；省略时由 main() 读环境变量。DSN 不打印、不落日志。 */
  readonly dsn?: string | undefined
  /** 只盘点与校验：不初始化结构、不导入、不清源，也不改写源库。 */
  readonly dryRun?: boolean | undefined
  /** 快照路径；`--clear-source` 必填（备份先行）。 */
  readonly backupPath?: string | undefined
  /** 导入提交成功后，备份先行再就地 DROP 源库业务 5 表（索引 3 表与协作映射表保留）。 */
  readonly clearSource?: boolean | undefined
  readonly log?: ((line: string) => void) | undefined
  /**
   * 验收/测试注入点：导入事务写入完成、停写点复核之前触发，用于模拟「停写被破坏」
   * （源库在导入期间被并发写入）并验证退出码 4 与整体回滚路径。生产使用时不传。
   */
  readonly onBeforeStopWriteRecheck?: (() => void | Promise<void>) | undefined
  /**
   * 验收/测试注入点：导入已提交、清源复核开始之前触发，用于模拟「清源前源库被改动」
   * （业务表缺失/指纹变化）并验证清源拒绝路径。生产使用时不传。
   */
  readonly onBeforeClearSource?: (() => void) | undefined
}

interface ParsedArgs {
  blog: string | undefined
  translations: string | undefined
  dsn: string | undefined
  dryRun: boolean
  backup: string | undefined
  clearSource: boolean
  help: boolean
}

const USAGE = `用法：node dist/migrate-blog-storage.mjs --blog <blog.sqlite 路径> [--translations <译文源路径>]
       [--dsn <PostgreSQL DSN>] [--dry-run] [--clear-source --backup <快照路径>]

--blog          旧业务库（只读打开；典型位置 <DSH 主目录>/plugins/blog/blog.sqlite）。
                只导入业务 5 表 drafts/jobs/operations/audit/attachments；索引 3 表与
                协作映射表留在原文件里不动。
--translations  译文源（<DSH 主目录>/plugins/blog/reasoning-translations.sqlite 的
                translations 单表）；省略时若有同目录同名文件只提示、不导入。
--dsn           目标 PostgreSQL DSN；省略时读环境变量 AGENTS_GROUP_MIGRATE_PG_DSN。
                必须是空库，或已按 0001_init.sql 初始化且业务表全空的库；DSN 不会被打印或记录。
--dry-run       只做源库盘点与目标库状态校验，不写入任何数据。
--clear-source  导入并校验成功后，备份先行再就地清除源库业务 5 表（索引表保留）。
--backup        源库快照路径（--clear-source 必填）；用 VACUUM INTO 出一致快照，不裸拷主文件与 WAL。

退出码：0 成功（含无需迁移与 --dry-run）；1 参数/连接/校验/备份失败；2 源库无法识别；
        3 目标库不是空库或已按 0001_init.sql 初始化且业务表全空的结构；4 停写点复核失败`

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
  const parsed: ParsedArgs = { blog: undefined, translations: undefined, dsn: undefined, dryRun: false, backup: undefined, clearSource: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) break
    // 支持 GNU 习惯的 `--key=value` 写法：这类值可能带凭据，必须当作已知参数消化掉，
    // 否则会掉进未知参数分支被回显。
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
    if (name === '--blog') parsed.blog = inlineValue ?? argv[index += 1]
    else if (name === '--translations') parsed.translations = inlineValue ?? argv[index += 1]
    else if (name === '--dsn') parsed.dsn = inlineValue ?? argv[index += 1]
    else if (name === '--backup') parsed.backup = inlineValue ?? argv[index += 1]
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--clear-source') parsed.clearSource = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new MigrationFailure(1, `未知参数：${redactArg(arg)}\n\n${USAGE}`)
  }
  return parsed
}

/** 只读打开一个 SQLite 库。文件不存在、打不开或库损坏时按普通失败（退出码 1）报错。 */
function openSource(path: string, label = '源库'): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    throw new Error(`${label}打开失败（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version?: unknown } | undefined
  return Number(row?.user_version ?? 0)
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as unknown as { name: unknown }[]
  return new Set(rows.map(row => String(row.name)))
}

function rowCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as unknown as { total?: unknown } | undefined
  return Number(row?.total ?? 0)
}

function indexTableCounts(db: DatabaseSync): Map<string, number> {
  const existing = tableNames(db)
  const counts = new Map<string, number>()
  for (const table of INDEX_TABLES) if (existing.has(table)) counts.set(table, rowCount(db, table))
  return counts
}

/**
 * 读一张源表并投影到目标全列形状：serial 列（源库没有这一列）用源 rowid 填，
 * 行序即 rowid 序——也就是目标侧各读取路径（ORDER BY seq / seq DESC）的现状语义。
 *
 * 与管家蓝本不同，本工具不做缺列投影：博客没有逐版迁移链，业务表列不齐只可能是来历不明，
 * 按结构无法识别拒绝（退出码 2），而不是补默认值把一批数据静默降级。源库多出来的列不导入。
 */
function loadSourceTable(db: DatabaseSync, spec: TableSpec, existing: ReadonlySet<string>): LoadedTable {
  if (!existing.has(spec.source)) return { spec, rows: [], rowids: [] }
  const info = db.prepare(`PRAGMA table_info(${spec.source})`).all() as unknown as { name: unknown }[]
  const present = new Set(info.map(row => String(row.name)))
  const sourced = spec.columns.filter(col => col.source !== null)
  const missing = sourced.filter(col => !present.has(col.source as string)).map(col => col.source as string)
  if (missing.length > 0) {
    throw new MigrationFailure(2, `源库表 ${spec.source} 结构无法识别（缺列 ${missing.join('、')}），拒绝导入；请确认它就是博客业务库的现状形状`)
  }
  const selectList = sourced.map(col => col.source as string).join(',')
  let rawRows: Record<string, unknown>[]
  try {
    // ORDER BY rowid：插入序即 seq 序；rowid 同时是停写指纹的一部分。
    rawRows = db.prepare(`SELECT rowid AS __rowid, ${selectList} FROM ${spec.source} ORDER BY rowid`).all() as unknown as Record<string, unknown>[]
  } catch (error) {
    throw new MigrationFailure(2, `源库表 ${spec.source} 无法按 rowid 读取（${error instanceof Error ? error.message : String(error)}）：结构无法识别，拒绝导入`)
  }
  const rowids = rawRows.map(row => Number(row.__rowid ?? 0))
  const rows = rawRows.map((row, index) => spec.columns.map(col => col.source === null ? rowids[index] : (row[col.source] ?? null)))
  return { spec, rows, rowids }
}

/** 译文源（若给了路径且文件存在）：文件不存在或没有 translations 表都返回 undefined，由调用方记录。 */
function loadTranslations(path: string): LoadedTable | undefined {
  if (!existsSync(path)) return undefined
  const db = openSource(path, '译文源')
  try {
    const existing = tableNames(db)
    if (!existing.has(TRANSLATION_SPEC.source)) return undefined
    return loadSourceTable(db, TRANSLATION_SPEC, existing)
  } finally {
    db.close()
  }
}

/** 单元格规范化：让 SQLite 与 PG 两边不同 JS 类型（number vs bigint 字符串）算出同一摘要。 */
function canonicalCell(value: unknown, kind: ColKind): string {
  if (value === null || value === undefined) return 'NULL'
  return kind === 'int' ? `i${Number(value)}` : `t${JSON.stringify(String(value))}`
}

function canonicalRow(row: readonly unknown[], spec: TableSpec): string {
  return spec.columns.map((col, index) => canonicalCell(row[index], col.kind)).join('\u001F')
}

function tableDigest(table: LoadedTable): string {
  const lines = table.rows.map((row, index) => `#${table.rowids[index] ?? 0}\u001F${canonicalRow(row, table.spec)}`)
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 源库指纹：业务各表（含译文表）全行内容与 rowid 序的摘要，用于停写点复核。 */
function fingerprintOf(tables: readonly LoadedTable[]): string {
  const hash = createHash('sha256')
  for (const table of tables) hash.update(`${table.spec.source}:${table.rows.length}:${tableDigest(table)}\n`)
  return hash.digest('hex')
}

function toParam(value: unknown, kind: ColKind): unknown {
  if (value === null || value === undefined) return null
  return kind === 'int' ? Number(value) : String(value)
}

async function insertTable(client: PoolClient, table: LoadedTable): Promise<void> {
  if (table.rows.length === 0) return
  const columns = table.spec.columns.map(col => col.target).join(',')
  for (let start = 0; start < table.rows.length; start += INSERT_CHUNK) {
    const slice = table.rows.slice(start, start + INSERT_CHUNK)
    const values: unknown[] = []
    const tuples = slice.map(row =>
      `(${row.map((value, index) => `$${values.push(toParam(value, table.spec.columns[index]!.kind))}`).join(',')})`)
    await client.query(`INSERT INTO ${table.spec.target}(${columns}) VALUES ${tuples.join(',')}`, values)
  }
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
  if (!names.has(VERSION_TABLE)) {
    const blogLike = [...names].filter(name => name.startsWith('blog_'))
    const hint = blogLike.length > 0
      ? `存在 blog_ 前缀表（${blogLike.join('、')}）但没有版本表：结构不完整或版本表被删，请改用空库`
      : '该库没有 blog_ 前缀表（可能是其他 Agent 先迁入的群组库）：先按 agents/blog/migrations/postgres/0001_init.sql 用 psql 初始化本插件的表，再重跑本工具（群组单库、各插件各管各的表与版本行）'
    throw new MigrationFailure(
      3,
      `目标库（${database}）的 public schema 已有 ${names.size} 张表但没有 ${VERSION_TABLE} 版本表，无法确认结构版本；${hint}`,
    )
  }
  const versionResult = await client.query<{ version: string | number }>(`SELECT version FROM ${VERSION_TABLE}`)
  const version = Number(versionResult.rows[0]?.version ?? Number.NaN)
  if (version !== TARGET_SCHEMA_VERSION) {
    throw new MigrationFailure(3, `目标库结构版本不符：实际 ${version}，期望 ${TARGET_SCHEMA_VERSION}；请改用空库（群组单库、库内表按插件前缀平铺），或把该库修回初始结构`)
  }
  const missing = [...TABLE_SPECS, TRANSLATION_SPEC].map(spec => spec.target).filter(name => !names.has(name))
  if (missing.length > 0) {
    throw new MigrationFailure(3, `目标库结构不完整（版本 ${version}），缺表：${missing.join('、')}`)
  }
  for (const spec of [...TABLE_SPECS, TRANSLATION_SPEC]) {
    const count = await client.query<{ total: string | number }>(`SELECT count(*) AS total FROM ${spec.target}`)
    if (Number(count.rows[0]?.total ?? 0) > 0) {
      throw new MigrationFailure(3, `目标库业务表 ${spec.target} 非空；导入只接受空库（或已初始化且全空的库），不叠加、不合并`)
    }
  }
  return { needInit: false, database }
}

/**
 * 导入后校验：版本行、逐表行数、逐列规范化校验和（经规范化行集合整体比对，serial 列也按
 * 「等于源 rowid」核对，因此主键集合与 seq 取值同时被钉住）、记录身份 spot check
 * （`data` JSON 里的身份字段与投影列一致——列映射写错只有这一步能发现）。
 *
 * 返回一行校验结论；关联情况作为信息项一并报出（不拦截）。
 */
async function verifyImport(client: PoolClient, tables: readonly LoadedTable[]): Promise<string> {
  const versionResult = await client.query<{ version: string | number }>(`SELECT version FROM ${VERSION_TABLE}`)
  const version = Number(versionResult.rows[0]?.version ?? Number.NaN)
  if (version !== TARGET_SCHEMA_VERSION) throw new Error(`导入后版本行校验失败：实际 ${version}，期望 ${TARGET_SCHEMA_VERSION}`)
  let unparsable = 0
  for (const table of tables) {
    const spec = table.spec
    const columnList = spec.columns.map(col => `"${col.target}"`).join(',')
    const result = await client.query<Record<string, unknown>>(`SELECT ${columnList} FROM ${spec.target}`)
    const expected = table.rows.map(row => canonicalRow(row, spec)).sort()
    const actual = result.rows.map(row => canonicalRow(spec.columns.map(col => row[col.target]), spec)).sort()
    if (actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
      throw new Error(`表 ${spec.target} 导入后校验不一致：期望 ${expected.length} 行（含全部列值与 seq），实际 ${actual.length} 行`)
    }
    const pkList = spec.pk.map(name => `"${name}"`).join(',')
    const keyOf = (row: readonly unknown[]): string => spec.pk.map(name => {
      const index = spec.columns.findIndex(col => col.target === name)
      return canonicalCell(row[index], spec.columns[index]?.kind ?? 'text')
    }).join('\u001F')
    const expectedKeys = table.rows.map(row => keyOf(row)).sort()
    const actualKeys = result.rows.map(row => keyOf(spec.columns.map(col => row[col.target]))).sort()
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error(`表 ${spec.target}（主键 ${pkList}）主键集合校验不一致：期望 ${expectedKeys.length} 个，实际 ${actualKeys.length} 个`)
    }
    for (const row of result.rows) {
      if (spec.identity.length === 0) break
      let record: unknown
      try {
        record = JSON.parse(String(row['data']))
      } catch {
        // 损坏的 JSON 原样搬入、不修补也不拦截（现状读路径就是直接 JSON.parse），只记录条数。
        unparsable += 1
        continue
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
      for (const [column, key] of spec.identity) {
        const fromJson = (record as Record<string, unknown>)[key]
        const fromColumn = row[column]
        if (fromJson === null || fromJson === undefined || String(fromJson) !== String(fromColumn)) {
          throw new Error(`表 ${spec.target} 记录身份 spot check 失败：${column}=${String(fromColumn)} 与 data.${key}=${String(fromJson)} 不一致（列映射或记录来源有误）`)
        }
      }
    }
  }
  // 关联 spot check（信息项，只报数不拦截）：operations.draft_id 允许是 `manage:*`/`remote:*`
  // 这类非草稿标识，attachments.draft_id 允许是 `blog-chat-*` 会话标识——都不是外键，数据本身
  // 合法，因此不做致命判断，如实打印供人工核对。
  const relations = await client.query<{ operations: string | number; attachments: string | number }>(`
    SELECT (SELECT count(*) FROM blog_operations o WHERE o.draft_id IN (SELECT id FROM blog_drafts) AND o.owner <> (SELECT d.owner FROM blog_drafts d WHERE d.id = o.draft_id)) AS operations,
           (SELECT count(*) FROM blog_attachments a WHERE a.draft_id NOT IN (SELECT id FROM blog_drafts) AND a.draft_id NOT LIKE 'blog-chat-%') AS attachments`)
  const crossOwnerOperations = Number(relations.rows[0]?.operations ?? 0)
  const unknownAttachmentScopes = Number(relations.rows[0]?.attachments ?? 0)
  const note = unparsable > 0 ? `；data 无法解析的记录 ${unparsable} 条（原样搬入，未参与身份核对）` : ''
  return `版本行 ${version}、逐表行数、主键集合与逐列校验和一致；关联 spot check（信息项）：跨 owner 操作 ${crossOwnerOperations} 条、非草稿非会话附件 scope ${unknownAttachmentScopes} 条${note}`
}

/**
 * BIGSERIAL 序列复位（B2-2a 评审备忘 #1）：显式写 seq/id 不会推进序列，不复位的话后续
 * 不带该列的 INSERT（现状 PG 实现就是不带）会从 1 开始撞 UNIQUE。
 * 空表复位到 1,false，保证首次 nextval 得到 1。
 */
async function resetSequences(client: PoolClient, tables: readonly LoadedTable[], log: (line: string) => void): Promise<void> {
  for (const table of tables) {
    const serial = table.spec.serial
    if (serial === undefined) continue
    const found = await client.query<{ seq: string | null }>('SELECT pg_get_serial_sequence($1,$2) AS seq', [table.spec.target, serial.column])
    const sequence = found.rows[0]?.seq ?? null
    if (sequence === null) {
      throw new Error(`目标表 ${table.spec.target}.${serial.column} 没有关联序列（BIGSERIAL 期望 ${table.spec.target}_${serial.column}_seq），无法复位`)
    }
    const maxResult = await client.query<{ max: string | null }>(`SELECT max(${serial.column})::text AS max FROM ${table.spec.target}`)
    const max = maxResult.rows[0]?.max ?? null
    if (max === null) {
      await client.query('SELECT setval($1::regclass, 1, false)', [sequence])
      log(`  ${sequence} → 1（表空，未调用；首次插入得到 1）`)
    } else {
      await client.query('SELECT setval($1::regclass, $2::bigint, true)', [sequence, max])
      log(`  ${sequence} → ${max}`)
    }
  }
}

interface Checklist {
  readonly jobs: { id: string; owner: string; status: string }[]
  readonly attachments: { id: string; owner: string; status: string }[]
  /** data 无法解析、状态因此未知的在途表行数（如实报数，不猜测状态）。 */
  readonly unparsable: number
}

/** 人工核对清单：迁移后启动序列会翻转的在途记录（jobs queued/running、attachments uploading/parsing）。 */
function collectChecklist(tables: readonly LoadedTable[]): Checklist {
  const jobs: Checklist['jobs'] = []
  const attachments: Checklist['attachments'] = []
  let unparsable = 0
  for (const table of tables) {
    const watch = table.spec.source === 'jobs' ? ['queued', 'running'] : table.spec.source === 'attachments' ? ['uploading', 'parsing'] : []
    if (watch.length === 0) continue
    const idIndex = table.spec.columns.findIndex(col => col.source === 'id')
    const ownerIndex = table.spec.columns.findIndex(col => col.source === 'owner')
    const dataIndex = table.spec.columns.findIndex(col => col.source === 'data')
    for (const row of table.rows) {
      let status: string
      try {
        const record = JSON.parse(String(row[dataIndex])) as { status?: unknown }
        status = typeof record?.status === 'string' ? record.status : '(无 status 字段)'
      } catch {
        unparsable += 1
        continue
      }
      if (!watch.includes(status)) continue
      const item = { id: String(row[idIndex]), owner: String(row[ownerIndex]), status }
      if (table.spec.source === 'jobs') jobs.push(item)
      else attachments.push(item)
    }
  }
  return { jobs, attachments, unparsable }
}

function printChecklist(checklist: Checklist, log: (line: string) => void): void {
  log('人工核对清单（启动序列会把下列在途记录收成 failed，切换前请确认是否要等它们跑完）：')
  log(`  jobs 中 queued/running：${checklist.jobs.length} 条`)
  for (const job of checklist.jobs) log(`    - job id=${job.id} owner=${job.owner} status=${job.status}`)
  log(`  attachments 中 uploading/parsing：${checklist.attachments.length} 条`)
  for (const item of checklist.attachments) log(`    - attachment id=${item.id} owner=${item.owner} status=${item.status}`)
  if (checklist.unparsable > 0) log(`  （另有 ${checklist.unparsable} 条在途表的 data 无法解析，状态未知；原样导入，未列入清单）`)
}

/**
 * 清源：备份先行（`VACUUM INTO` 一致快照）→ 单事务 DROP 业务 5 表（索引 3 表与协作映射表
 * 原样保留）。
 *
 * 清源前二次核对：业务表清单与停写指纹都必须与导入前一致——导入 COMMIT 之后到清源之间仍有
 * 写入窗口（指纹是兜底不是锁），不一致就拒绝清源，源库原样不动（退出码 4）。
 */
function clearSource(options: {
  readonly blogPath: string
  /** 只读连接（runMigration 的源库句柄）：复核阶段专用——拒绝分支不开写连接、不碰源库字节。 */
  readonly reader: DatabaseSync
  readonly backupPath: string
  /** 导入前的**业务表**停写指纹（译文源是另一个文件，不参与清源核对）。 */
  readonly businessFingerprint: string
  readonly log: (line: string) => void
  readonly onBeforeClearSource?: (() => void) | undefined
}): void {
  const { log } = options
  // 复核阶段全部走只读连接：下面每个拒绝分支都不得在源库上产生 WAL checkpoint 之类的写。
  const existing = tableNames(options.reader)
  const toDrop = TABLE_SPECS.map(spec => spec.source)
  const missing = toDrop.filter(name => !existing.has(name))
  if (missing.length > 0) {
    throw new MigrationFailure(4, `清源前核对失败：源库业务表少了 ${missing.join('、')}（导入之后源库被改动过）；本次不清源，其余部分原样保留`)
  }
  const current = fingerprintOf(TABLE_SPECS.map(spec => loadSourceTable(options.reader, spec, existing)))
  if (current !== options.businessFingerprint) {
    throw new MigrationFailure(4, `清源前复核失败：源库业务表指纹与导入前不一致（${options.businessFingerprint.slice(0, 16)}… → ${current.slice(0, 16)}…），导入之后源库又有写入。本次不清源，源库原样保留；请先确认那批写入怎么处理（重导到新库或人工合并），再决定下一步`)
  }
  const kept = INDEX_TABLES.filter(name => existing.has(name))
  log(`清源前核对：业务表清单与停写指纹一致（${options.businessFingerprint.slice(0, 16)}…）；将清除 ${toDrop.join('、')}，保留 ${kept.join('、') || '（索引表均不存在）'}`)
  if (existsSync(options.backupPath)) {
    throw new MigrationFailure(1, `快照路径已存在（${options.backupPath}），拒绝覆盖；请换一个不存在的路径再执行 --clear-source`)
  }
  const beforeCounts = indexTableCounts(options.reader)
  if (options.onBeforeClearSource !== undefined) options.onBeforeClearSource()
  // 到这一步才开写连接（VACUUM INTO 与 DROP 都需要可写）：此前的拒绝分支不在源库上开写。
  const writer = new DatabaseSync(options.blogPath)
  try {
    // 备份先行：VACUUM INTO 出一致快照（自行处理 WAL），禁止裸拷主文件与 -wal。
    try {
      writer.exec(`VACUUM INTO '${options.backupPath.replaceAll("'", "''")}'`)
    } catch (error) {
      throw new MigrationFailure(1, `源库快照失败（${options.backupPath}）：${error instanceof Error ? error.message : String(error)}。本次不清源，源库原样保留`)
    }
    // 快照可用性当场核验：能只读打开、业务表齐全、逐表行数与源库（只读视图）一致。
    // 快照完成后、DROP 之前再取一次业务指纹并比对——把「复核→清了」的窗口从两次读取之间
    // 缩到含快照在内的一次比对；此写入只存在于快照里，拒绝零代价。
    try {
      const snapshot = openSource(options.backupPath, '快照')
      try {
        const snapshotTables = tableNames(snapshot)
        for (const name of toDrop) {
          if (!snapshotTables.has(name)) throw new Error(`快照缺表 ${name}`)
          if (rowCount(snapshot, name) !== rowCount(options.reader, name)) {
            throw new Error(`快照表 ${name} 行数 ${rowCount(snapshot, name)} 与源库 ${rowCount(options.reader, name)} 不一致`)
          }
        }
      } finally {
        snapshot.close()
      }
      const afterSnapshot = fingerprintOf(TABLE_SPECS.map(spec => loadSourceTable(options.reader, spec, tableNames(options.reader))))
      if (afterSnapshot !== options.businessFingerprint) {
        throw new Error(`快照期间源库又有写入（指纹 ${options.businessFingerprint.slice(0, 16)}… → ${afterSnapshot.slice(0, 16)}…）`)
      }
    } catch (error) {
      if (error instanceof MigrationFailure) throw error
      throw new MigrationFailure(1, `源库快照校验失败（${options.backupPath}）：${error instanceof Error ? error.message : String(error)}。本次不清源，源库原样保留`)
    }
    writer.exec('BEGIN IMMEDIATE')
    try {
      for (const name of toDrop) writer.exec(`DROP TABLE ${name}`)
      const afterCounts = indexTableCounts(writer)
      if (INDEX_TABLES.some(name => beforeCounts.get(name) !== afterCounts.get(name))) {
        throw new MigrationFailure(4, `索引表行数在清源事务内发生变化（${[...beforeCounts].map(([name, count]) => `${name}=${count}`).join('、')} → ${[...afterCounts].map(([name, count]) => `${name}=${count}`).join('、')}）；本次清源已回滚，源库原样保留`)
      }
      if (toDrop.some(name => tableNames(writer).has(name))) throw new MigrationFailure(4, '清源事务内业务表仍存在（不应发生）；本次清源已回滚')
      writer.exec('COMMIT')
    } catch (error) {
      try {
        writer.exec('ROLLBACK')
      } catch {
        // 回滚失败不影响结论：未提交即视为未清源。
      }
      throw error
    }
    log(`清源完成：已删除 ${toDrop.join('、')}；索引表行数未变（${[...beforeCounts].map(([name, count]) => `${name}=${count}`).join('、') || '无索引表'}）；快照：${options.backupPath}`)
  } finally {
    writer.close()
  }
}

/**
 * 执行一次迁移。规格见文件头。失败以 {@link MigrationFailure}（带退出码）或普通 Error 抛出。
 */
export async function runMigration(options: MigrationOptions): Promise<void> {
  const log = options.log ?? ((line: string) => { console.log(line) })
  // 参数交叉校验放在打开源库之前：错的组合不碰任何文件。
  if (options.clearSource === true && options.dryRun === true) {
    throw new MigrationFailure(1, '--clear-source 与 --dry-run 不能同时使用：dry-run 不写目标库，也就没有可清源的导入结果')
  }
  if (options.clearSource === true && options.backupPath === undefined) {
    throw new MigrationFailure(1, '--clear-source 必须配合 --backup <快照路径>：备份先行，源库快照是这次切换唯一的回退位')
  }
  if (options.clearSource === true) {
    // 快照落点前置校验（不碰任何文件、更在导入之前）：清源失败后目标库已非空、不能再跑一遍
    // 同一命令，所以路径错误必须在导入落库之前就挡下，不能留「已导入但没清源」的僵局。
    if (existsSync(options.backupPath ?? '')) {
      throw new MigrationFailure(1, `快照路径已存在（${options.backupPath}），拒绝覆盖；请换一个不存在的路径再执行 --clear-source`)
    }
    const parent = dirname(options.backupPath ?? '')
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new MigrationFailure(1, `快照路径的父目录不存在（${parent}）；请先建好目录再执行（工具不代建目录，避免路径笔误被掩盖）`)
    }
  }
  // 译文源默认取业务库同目录（拆库前两者同目录：<DSH 主目录>/plugins/blog/）。
  // 只有显式给了 --translations 才导入译文；缺省时同目录的同名文件只提示、不读不导。
  const translationsPath = options.translationsPath ?? join(dirname(options.blogPath), 'reasoning-translations.sqlite')
  const wantTranslations = options.translationsPath !== undefined
  const readTranslations = (): LoadedTable | undefined => wantTranslations ? loadTranslations(translationsPath) : undefined
  const db = openSource(options.blogPath)
  try {
    const version = readUserVersion(db)
    const existing = tableNames(db)
    const present = TABLE_SPECS.filter(spec => existing.has(spec.source))
    log(`源库盘点（只读）：${options.blogPath}`)
    log(`  user_version = ${version}${version === 0 || version === 1 ? '' : '（与现状的 0/1 不符；按业务表存在性继续，如实记录）'}`)
    if (present.length === 0) {
      log(`  业务 5 表（${TABLE_SPECS.map(spec => spec.source).join('、')}）均不存在：已迁移或无需迁移，本次不做任何改动。`)
      log(`  仍在库里的表：${[...existing].join('、') || '（无）'}（索引 3 表与协作映射表是迁后索引库的正式内容）`)
      log('结束：无需迁移（退出码 0）。')
      return
    }
    if (present.length !== TABLE_SPECS.length) {
      const missing = TABLE_SPECS.filter(spec => !existing.has(spec.source)).map(spec => spec.source)
      throw new MigrationFailure(2, `源库业务表不完整（存在 ${present.length}/5，缺 ${missing.join('、')}）：结构无法识别，拒绝迁移——部分存在说明它不是本工具认识的博客业务库，或上一次清源没有完成；请先确认源库来历，不要按“已迁移”处理`)
    }
    const loaded = TABLE_SPECS.map(spec => loadSourceTable(db, spec, existing))
    const known = new Set<string>([...TABLE_SPECS.map(spec => spec.source), ...INDEX_TABLES])
    const unknown = [...existing].filter(name => !known.has(name))
    if (unknown.length > 0) log(`  提示：未识别表 ${unknown.join('、')} 将原样留在源库（不导入、不清除；如需处理请人工确认来历）`)
    if (options.translationsPath !== undefined && !existsSync(options.translationsPath)) {
      log(`  译文源不存在（${options.translationsPath}）：跳过译文导入，业务 5 表照常迁移。`)
    } else if (options.translationsPath === undefined && existsSync(translationsPath)) {
      log(`  提示：${translationsPath} 存在但未传 --translations，本次不导入译文（业务 5 表照常迁移）。`)
    }
    const translations = readTranslations()
    if (translations === undefined && options.translationsPath !== undefined && existsSync(options.translationsPath)) {
      log('  译文源里没有 translations 表：跳过译文导入（译文是派生缓存，重问即可再生成）。')
    }
    for (const table of loaded) log(`  ${table.spec.source}: ${table.rows.length} 行`)
    if (translations !== undefined) log(`  translations: ${translations.rows.length} 行（译文源 ${translationsPath}）`)
    const importTables = translations === undefined ? loaded : [...loaded, translations]
    // 两个源是两个文件：业务库与译文源分别算指纹，停写复核与清源复核都按同一口径比对。
    const businessFingerprint = fingerprintOf(loaded)
    const translationsFingerprint = translations === undefined ? undefined : fingerprintOf([translations])
    const checklist = collectChecklist(loaded)
    log(`  内容指纹：业务表 ${businessFingerprint.slice(0, 16)}…${translationsFingerprint === undefined ? '' : `、译文 ${translationsFingerprint.slice(0, 16)}…`}`)
    printChecklist(checklist, log)

    const dsn = options.dsn?.trim()
    if (dsn === undefined || dsn === '') {
      throw new MigrationFailure(1, '缺少目标 DSN：用 --dsn <PostgreSQL DSN> 或环境变量 AGENTS_GROUP_MIGRATE_PG_DSN 提供（本工具不内置任何默认连接串，也不回退 SQLite）。')
    }
    const pool = new Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 10000 })
    // 空闲连接的后台错误必须有人接住，否则会成为进程级未捕获异常。
    pool.on('error', error => { log(`目标库连接池错误：${error.message}`) })
    const client = await pool.connect()
    try {
      const state = await inspectTarget(client)
      log(`目标库：已连接（数据库 ${state.database}），${state.needInit ? '空库——将在同一事务内应用 agents/blog/migrations/postgres/0001_init.sql' : '结构已初始化且业务表为空'}`)
      if (options.dryRun === true) {
        log('dry-run 结束：未写入任何数据。')
        return
      }
      await client.query('BEGIN')
      try {
        if (state.needInit) await client.query(readFileSync(MIGRATION_SQL_URL, 'utf8'))
        for (const table of importTables) await insertTable(client, table)
        const verified = await verifyImport(client, importTables)
        log(`导入后校验：${verified}`)
        log('BIGSERIAL 序列复位：')
        await resetSequences(client, importTables, log)
        // 停写点复核：COMMIT 前重新读取源库全量指纹。不一致说明导入期间源库有新写入，
        // 本次导入的完整性无法证明 —— 整体回滚，目标库保持空，由操作者确认停写后重来。
        // 注意残余窗口：复核读取之后、COMMIT 之前的写入检测不到——指纹是兜底不是锁，
        // 真正的停写保证来自运维流程（停插件写入口），不来自本工具。
        if (options.onBeforeStopWriteRecheck !== undefined) await options.onBeforeStopWriteRecheck()
        const afterBusiness = fingerprintOf(TABLE_SPECS.map(spec => loadSourceTable(db, spec, tableNames(db))))
        const afterTranslationsTable = readTranslations()
        const afterTranslations = afterTranslationsTable === undefined ? undefined : fingerprintOf([afterTranslationsTable])
        if (afterBusiness !== businessFingerprint || afterTranslations !== translationsFingerprint) {
          const which = afterBusiness !== businessFingerprint ? '业务库 blog.sqlite' : '译文源 reasoning-translations.sqlite'
          const detail = `业务表 ${businessFingerprint.slice(0, 16)}… → ${afterBusiness.slice(0, 16)}…${translationsFingerprint === undefined ? '' : `；译文 ${translationsFingerprint.slice(0, 16)}… → ${afterTranslations?.slice(0, 16) ?? '（读不到）'}…`}`
          throw new MigrationFailure(4, `停写点复核失败：${which} 的指纹导入前后不一致（${detail}），源库在导入期间有新写入。本次导入已整体回滚，目标库保持空；请先让旧库停写（停业务写入口）再重新执行`)
        }
        try {
          await client.query('COMMIT')
        } catch (error) {
          // COMMIT 阶段的失败是「结果不明」而不是「确定没提交」：事务可能已在服务端落盘。
          // 单独报出来，避免操作者按普通失败盲目重跑（重跑会因目标非空被退出码 3 拒绝，
          // 但消息应先说清该核查什么）。
          throw new MigrationFailure(1, `提交结果不明：COMMIT 发送时出错（${error instanceof Error ? error.message : String(error)}）。事务可能已在服务端提交——先连接目标库核查 ${VERSION_TABLE} 与各表行数，确认后再决定后续动作，不要盲目重跑`)
        }
        log('── 迁移报告 ──')
        log(`源库：${options.blogPath}（user_version=${version}，只读，未做任何写入）`)
        log(`目标库：${state.database}（${state.needInit ? '本次初始化结构并导入' : '结构已就绪，直接导入'}）`)
        log(`导入行数：${importTables.map(table => `${table.spec.target} ${table.rows.length}`).join('、')}`)
        log('校验：版本行、逐表行数、主键集合、逐列校验和一致；' + verified.slice(verified.indexOf('；') + 1))
        log(`停写点复核：源库指纹导入前后一致（业务表 ${businessFingerprint.slice(0, 16)}…${translationsFingerprint === undefined ? '' : `、译文 ${translationsFingerprint.slice(0, 16)}…`}）`)
        log(`人工核对清单：jobs queued/running ${checklist.jobs.length} 条、attachments uploading/parsing ${checklist.attachments.length} 条（迁移不改状态；切换后启动序列会收成 failed，逐条清单见盘点上文）`)
        if (options.clearSource === true) {
          clearSource({
            blogPath: options.blogPath,
            reader: db,
            backupPath: options.backupPath ?? '',
            businessFingerprint,
            log,
            ...(options.onBeforeClearSource === undefined ? {} : { onBeforeClearSource: options.onBeforeClearSource }),
          })
        } else {
          log('源库未清源：业务 5 表仍在原文件里。清源**不可事后补做**——已导入的目标库会被退出码 3 拒绝，所以需要清源时请在导入前就带好 --clear-source --backup <快照路径>；若本次已放过，可按 README「清源失败后的人工收尾」一节处理。')
        }
        log('回滚边界：清源前源库业务表原样未动，导入失败时目标库整体回滚。清源后 blog.sqlite 只剩索引 3 表与协作映射表，回退到 SQLite = 从停写快照**整库恢复**（索引一并回退）或保持新版修复 PG——**不支持只回业务表**（业务表已不在源库，只在快照里）。')
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
 * DSN 解析顺序：`--dsn` 参数 > 环境变量 `AGENTS_GROUP_MIGRATE_PG_DSN`；没有默认值，绝不内置凭据。
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
    if (args.blog === undefined) {
      console.error('缺少 --blog <blog.sqlite 路径>。\n')
      console.error(USAGE)
      return 1
    }
    if (args.clearSource && args.backup === undefined) {
      console.error('缺少 --backup <快照路径>：--clear-source 必须先出源库快照（VACUUM INTO），快照是这次切换唯一的回退位。\n')
      console.error(USAGE)
      return 1
    }
    const dsn = args.dsn?.trim() || env.AGENTS_GROUP_MIGRATE_PG_DSN?.trim()
    await runMigration({
      blogPath: args.blog,
      translationsPath: args.translations,
      dsn,
      dryRun: args.dryRun,
      backupPath: args.backup,
      clearSource: args.clearSource,
      log,
    })
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
