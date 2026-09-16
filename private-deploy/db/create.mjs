/** Create the single `dsh` database and apply the complete v1 DDL once; runtime never creates tables. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

/** 建库脚本不猜项目根：DDL 固定与本文件同目录，路径由显式 root 解析（AGENTS.md）。 */
export const SQL_FILE = fileURLToPath(new URL('0001_init.sql', import.meta.url));

/** 建库要写入版本表的四个归属；缺一项就说明 DDL 没跑完（设计 §3.1）。 */
export const EXPECTED_VERSIONS = ['butler', 'blog', 'closedoff', 'runtime'];

/** 建库后应当存在的 15 张表。多一张少一张都说明库不是本脚本建出的形状。 */
export const EXPECTED_TABLES = [
  'dsh_schema_versions',
  'butler_tasks', 'butler_subtasks', 'butler_task_inputs', 'butler_agent_aliases', 'butler_requests',
  'dsh_conversations', 'dsh_turns', 'dsh_turn_results',
  'blog_drafts', 'blog_jobs', 'blog_operations', 'blog_audit', 'blog_attachments', 'blog_translations',
];

const USAGE = `用法：node private-deploy/db/create.mjs [--dsn <DSN>] [--database <库名>] [--confirm <库名>] [--help]

环境变量（凭据一律不写进代码；--dsn 优先于环境变量）：
  DSH_PG_DSN      完整连接串，例如 postgresql://user:password@host:5432/dsh
  或分开给：DSH_PG_HOST / DSH_PG_PORT / DSH_PG_USER / DSH_PG_PASSWORD / DSH_PG_DATABASE
  DSH_DB_CONFIRM  目标库名；不是一次性测试库（*_test / *_mig / *_iso）时必须等于库名

行为：库不存在则 CREATE DATABASE，然后在一个事务里应用 0001_init.sql。
重复执行会被拒绝（42P07 关系已存在，整体回滚），不做幂等跳过。

⚠️ 建库不可逆，所以有两道闸：**正式库名（butler / agents_group）一律拒绝**；
**非测试库必须显式确认**（DSH_DB_CONFIRM 或 --confirm 等于目标库名）。`;

/** 从环境变量拼装 DSN；没有 host 也没有完整串时返回空串（调用方据此报错，不猜默认值）。 */
export function dsnFromEnv(env = process.env) {
  if (env.DSH_PG_DSN) return env.DSH_PG_DSN;
  if (!env.DSH_PG_HOST) return '';
  const url = new URL('postgresql://localhost');
  url.hostname = env.DSH_PG_HOST;
  if (env.DSH_PG_PORT) url.port = env.DSH_PG_PORT;
  if (env.DSH_PG_USER) url.username = env.DSH_PG_USER;
  if (env.DSH_PG_PASSWORD) url.password = env.DSH_PG_PASSWORD;
  url.pathname = `/${env.DSH_PG_DATABASE || 'dsh'}`;
  return url.toString();
}

/** 只改 DSN 里的库名，其余（host / 端口 / 账号 / 口令 / 参数）原样保留。 */
export function withDatabase(dsn, database) {
  const url = new URL(dsn);
  url.pathname = `/${database}`;
  return url.toString();
}

/** 把 DSN 拆成「目标库连接串」「管理连接串（连 maintenance 库）」「目标库名」；只改库名，不动凭据。 */
export function splitDsn(dsn, database, maintenance = 'postgres') {
  const target = database || decodeURIComponent(new URL(dsn).pathname.replace(/^\//, '')) || 'dsh';
  return { target, targetDsn: withDatabase(dsn, target), adminDsn: withDatabase(dsn, maintenance) };
}

/** 标识符要拼进 `CREATE DATABASE`（不能参数化），只放行保守的库名形状。 */
export function quoteDatabase(database) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(database)) {
    throw new Error(`库名「${database}」不合法：只接受字母 / 数字 / 下划线，且以字母或下划线开头。`);
  }
  return `"${database}"`;
}

/** 只替换版本行的毫秒占位符；换完仍是合法 SQL，所以这份文件也能原样交给 psql -v 执行。 */
export function sqlWithAppliedAt(sql, appliedAt = Date.now()) {
  if (!Number.isSafeInteger(appliedAt) || appliedAt <= 0) throw new Error('applied_at 必须是 Date.now() 量级的正整数毫秒值。');
  return sql.replaceAll(':applied_at', String(appliedAt));
}

/**
 * 把 SQL 文本切成语句。`--` 行注释按行剥掉（注释里可能出现分号），再按 `;` 切。
 * 本 DDL 是纯 DDL、无美元引用，这个切法够用；切成空白的片段直接丢弃。
 */
export function splitStatements(sql) {
  const withoutComments = sql.split('\n')
    .map(line => { const at = line.indexOf('--'); return at === -1 ? line : line.slice(0, at); })
    .join('\n');
  return withoutComments.split(';').map(part => part.trim()).filter(part => part !== '');
}

/**
 * 把 DDL 落成一个事务：只把**语句体**（不含文件自带的 `BEGIN`/`COMMIT`）逐条发出，
 * 外面套一对 `BEGIN`/`COMMIT`。这样做有三个必要理由，逐条都有实测依据：
 *   1. **原子性**：任何一条失败 → 整批 `ROLLBACK`，库里空空的，重跑一次就是干净建库；
 *      整体回滚也意味着"重复建库被拒绝且零改动"，不会留下半建的现场。
 *   2. **不污染连接**：把整份 DDL 作为**一条**多语句查询发出去时，PostgreSQL 在第一条失败后
 *      后续语句全部报 25P02，且显式 `ROLLBACK` 已排在失败语句之后、**根本没有机会执行**
 *      （本机实测：失败后连接再查什么都报 `current transaction is aborted`）。
 *      逐条发送后失败点确定，`ROLLBACK` 由脚本自己发，连接回到可用状态。
 *   3. **可诊断**：报错就是**那条**语句的错（例如重复建库的首条 `CREATE TABLE` 报 42P07），
 *      而不是一串 25P02 噪声。
 */
export async function applySchema(client, sql, { log = console.log } = {}) {
  const statements = splitStatements(sqlWithAppliedAt(sql));
  await client.query('BEGIN');
  try {
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT');
    log(`DDL 已提交：${statements.length} 条语句在一个事务内全部成功。`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * 表数 / 索引数 / 版本行。
 * 索引必须按「一个索引一行」数：`pg_constraint.conindid` 在**外键**约束上也指向**被引用表**的
 * 那个唯一索引，直接 JOIN 会让同一索引重复出现（本机实测 39 个索引被数成 47 行）。
 * 所以这里用 LATERAL 每个索引只取一个"拥有它的"约束（p/u/x 三类才真正新建索引），
 * 并额外报出索引**名**清单——调用方据此核对名字，而不是只数个数。
 */
export async function summarize(client) {
  const tables = await client.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`);
  const indexes = await client.query(
    `SELECT c.relname AS name, i.indisprimary AS primary, o.contype AS constraint_type
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN LATERAL (
         SELECT x.contype FROM pg_constraint x
          WHERE x.conindid = i.indexrelid AND x.contype IN ('p','u','x')
          LIMIT 1) o ON TRUE
      WHERE n.nspname = 'public' AND t.relkind = 'r'
      ORDER BY c.relname`);
  const versions = await client.query('SELECT plugin_id, version FROM dsh_schema_versions ORDER BY plugin_id');
  const names = indexes.rows.map(row => row.name);
  if (new Set(names).size !== names.length) throw new Error('索引统计出现重复行：请检查 pg_constraint 的关联方式。');
  return {
    tables: tables.rows.map(row => row.name),
    indexes: names,
    constraintIndexes: indexes.rows.filter(row => row.primary || row.constraint_type !== null).map(row => row.name),
    versions: versions.rows.map(row => ({ pluginId: row.plugin_id, version: Number(row.version) })),
  };
}

/**
 * 先拦"没有 DSN"这一种情况：它必须在任何 `new URL(dsn)` 之前判掉，否则用户看到的是
 * `Invalid URL` 这种与"忘设环境变量"毫无关系的报错（实测踩过）。
 */
export function assertDsn(dsn) {
  if (!dsn) throw new Error('未提供 DSN：请设置 DSH_PG_DSN（或 DSH_PG_HOST 等分项），或在命令行给 --dsn。凭据不写进代码。');
  return dsn;
}

/**
 * 一次性测试库：沿用本仓既有命名（`*_test` / `*_mig` / `*_iso`），它们免确认。
 *
 * 这几个后缀来自既有的环境库（`agents_group_iso` / `_mig` / `_test`、`butler_*` 同款），
 * 本来就是建了就用、用完就丢的库。
 */
function isDisposableDatabase(target) {
  return /_(?:test|mig|iso)$/.test(target);
}

/**
 * 对**不可逆**的建库动作做前置校验。
 *
 * 三道闸，按"先拦最危险的"排序：
 *
 * 1. **自带库与重构前的正式库一律拒绝**。`butler` 与 `agents_group` 是本次重构之前的正式库，
 *    新库建好之前它们**全程只读**——这个脚本不该有机会碰到它们。
 * 2. **不是一次性测试库就必须显式确认**：`DSH_DB_CONFIRM`（或 `--confirm`）要等于目标库名。
 *    它挡的是"手滑跑错环境"——本地 shell 里还留着生产 DSN、或者 CI 变量没清，
 *    都会在这一步被拦下。**这一条是实测补上的**：早先的版本对 host 与库名没有任何闸门，
 *    用生产库名 `dsh` 会直接把库和 15 张表建出来；而本项目"测试与正式环境共用一个 PG 实例"，
 *    一次误建就会污染正式环境。
 * 3. 库名要合法、两个来源不能打架。
 */
export function validateTarget({ dsn, database, target, confirm = process.env.DSH_DB_CONFIRM }) {
  assertDsn(dsn);
  const declared = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  if (database && declared && declared !== database) {
    throw new Error(`--database(${database}) 与 DSN 里的库名(${declared}) 不一致；只保留一个来源，避免建错库。`);
  }
  quoteDatabase(target);
  if (['postgres', 'template0', 'template1', 'butler', 'agents_group'].includes(target)) {
    throw new Error(`目标库名 ${target} 是 PostgreSQL 自带库或本次重构前的正式库，拒绝在这个名字上建库。正式库全程只读，请给新库另取名字。`);
  }
  if (!isDisposableDatabase(target) && confirm !== target) {
    throw new Error(
      `拒绝在 ${target} 上建库：它不是一次性测试库（\`*_test\` / \`*_mig\` / \`*_iso\`），需要显式确认。`
      + `\n确认方式：设 DSH_DB_CONFIRM=${target}，或加 --confirm ${target}。`
      + '\n这一步挡的是"手滑跑错环境"——建库不可逆，而本项目测试与正式环境共用一个 PG 实例。',
    );
  }
  return { target };
}

async function exists(client, target) {
  const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
  return found.rowCount > 0;
}

/** 建库入口：库不存在则创建，再在**单事务**里应用完整 DDL，最后返回可核验摘要。 */
export async function createDatabase({ dsn = dsnFromEnv(), database, confirm, maintenance = 'postgres', log = console.log } = {}) {
  assertDsn(dsn);
  const { target, targetDsn, adminDsn } = splitDsn(dsn, database, maintenance);
  validateTarget({ dsn, database, target, confirm });
  const sql = readFileSync(SQL_FILE, 'utf8');
  const appliedAt = Date.now();
  const admin = new Client({ connectionString: adminDsn });
  await admin.connect();
  let created = false;
  try {
    if (await exists(admin, target)) {
      log(`数据库 ${target} 已存在，跳过创建（只应用 DDL）。`);
    } else {
      await admin.query(`CREATE DATABASE ${quoteDatabase(target)}`);
      created = true;
      log(`已创建数据库 ${target}。`);
    }
  } finally {
    await admin.end();
  }
  const client = new Client({ connectionString: targetDsn });
  await client.connect();
  try {
    log(`应用 ${SQL_FILE}（单事务；重复执行整体回滚，不做幂等跳过）…`);
    await applySchema(client, sql, { log });
    return { target, created, appliedAt, sqlFile: SQL_FILE, ...(await summarize(client)) };
  } finally {
    await client.end();
  }
}

/** 摘要必须能一眼核验：表名清单、索引数（含来源拆分）、四行版本。 */
function report(summary) {
  const explicit = summary.indexes.length - summary.constraintIndexes.length;
  console.log(`建库完成：${summary.target}${summary.created ? '（本次创建）' : '（已存在）'}`);
  console.log(`表 ${summary.tables.length} 张：${summary.tables.join(', ')}`);
  console.log(`索引 ${summary.indexes.length} 个 = 约束隐式 ${summary.constraintIndexes.length}（PK/UNIQUE）+ CREATE INDEX 显式 ${explicit}`);
  console.log(`版本行 ${summary.versions.length} 行：${summary.versions.map(row => `${row.pluginId}=${row.version}`).join(', ')}`);
  const missingVersions = EXPECTED_VERSIONS.filter(id => !summary.versions.some(row => row.pluginId === id));
  const missingTables = EXPECTED_TABLES.filter(name => !summary.tables.includes(name));
  if (missingVersions.length || missingTables.length) {
    throw new Error(`建库结果不完整：缺表 ${missingTables.join(', ') || '无'}；缺版本行 ${missingVersions.join(', ') || '无'}。`);
  }
  return summary;
}

/** 只识别 `--flag value` / `--flag=value`；未知 flag 与多余位置参数一律拒绝，不静默忽略。 */
export function parseArgs(args) {
  const options = { dsn: undefined, database: undefined, confirm: undefined, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].startsWith('--') && args[index].includes('=')
      ? [args[index].slice(0, args[index].indexOf('=')), args[index].slice(args[index].indexOf('=') + 1)]
      : [args[index], undefined];
    if (flag === '--help') { options.help = true; continue; }
    if (flag !== '--dsn' && flag !== '--database' && flag !== '--confirm') throw new Error(`未知参数：${args[index]}\n\n${USAGE}`);
    const value = inline ?? args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值。\n\n${USAGE}`);
    options[flag === '--dsn' ? 'dsn' : flag === '--database' ? 'database' : 'confirm'] = value;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
    } else {
      const dsn = options.dsn || dsnFromEnv();
      // `DSH_PG_DATABASE` 只在"分项环境变量拼 DSN"这条路上才是库名来源；完整 DSN（--dsn 或
      // DSH_PG_DSN）自己已经带库名了，再拿它去覆盖只会变成"两个来源打架"的假报错（实测踩过）。
      const split = options.dsn === undefined && !process.env.DSH_PG_DSN;
      report(await createDatabase({
        dsn,
        database: options.database ?? (split ? process.env.DSH_PG_DATABASE : undefined),
        confirm: options.confirm,
      }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}