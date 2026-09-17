/**
 * 建库脚本（M1）的自动校验：跑 `0001_init.sql` 真建一次库，再核对形状与七条关键行为。
 *
 * 运行方式：
 *   设 `BUTLER_TEST_PG_DSN`（沿用本仓 PG 契约套件的门控变量）后
 *   `node --test private-deploy/db/tests/create.test.mjs`。
 *   也接受 `DSH_PG_DSN`（建库脚本自己读的那个变量，便于"设一个变量就同时覆盖建库与校验"）
 *   与 `DSH_DB_TEST_DSN`（只跑建库校验、不动契约套件时用）。
 *   单跑某一条：`node --test --test-name-pattern="行为 5" private-deploy/db/tests/create.test.mjs`
 *   ——**七条真库用例各自独立**（每条自带前置行、id 带 b1- / b2- … 前缀），不靠"上一条先跑过"。
 *
 * 两道安全闸（缺一不可，避免把生产库 DROP 掉）：
 *   1. DSN 的库名必须以 `_test` 结尾——与 `acceptance-pg-contract.test.ts:147` 同一条防呆；
 *      （`create.mjs` 自己也有一道更宽的闸：正式库名 `butler` / `agents_group` 一律拒绝，
 *      非一次性测试库必须 `DSH_DB_CONFIRM=<库名>` 或 `--confirm <库名>`；本文件走 `*_test` 免确认）
 *   2. 本文件**只建、只读、只在 after 里 DROP 自己建的表**，不 DROP SCHEMA、不碰别的库。
 *
 * 无 DSN 时整文件跳过（沿用 `<file>.test.ts` 的 skipIf 门控风格）。**跳过不等于通过**：
 * 跳过时不打印任何"通过"结论，验收证据由 `.local/agent-console/docs/验收/` 记录。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  EXPECTED_TABLES, EXPECTED_VERSIONS, SQL_FILE,
  applySchema, assertDsn, createDatabase, parseArgs, splitDsn, splitStatements, sqlWithAppliedAt, summarize, validateTarget,
} from '../create.mjs';

const { Client } = pg;

/** 门控顺序与 `create.mjs` 的 `dsnFromEnv()` 对齐：`DSH_PG_DSN` 优先，其余两个是测试专用入口。 */
const DSN = process.env.DSH_PG_DSN || process.env.BUTLER_TEST_PG_DSN || process.env.DSH_DB_TEST_DSN || '';
const SKIP = DSN === ''
  ? '未设置 DSH_PG_DSN / BUTLER_TEST_PG_DSN / DSH_DB_TEST_DSN：跳过真库校验（跳过不等于通过）。'
  : false;

/** 库名后缀防呆：与 `acceptance-pg-contract.test.ts` 的 `*_test` 门同源。 */
function assertTestDatabase(dsn) {
  const name = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  assert.ok(name.endsWith('_test'), `DSN 指向的数据库「${name}」不是 *_test 测试库，拒绝建表与清理。`);
  return name;
}

/**
 * 15 张表上**应当存在的全部索引**，逐字来自 `0001_init.sql`：
 *   - 显式 `CREATE INDEX` / `CREATE UNIQUE INDEX`：20 个；
 *   - `PRIMARY KEY` 与 `UNIQUE` 约束的隐式索引：15 + 4 = 19 个；
 *   合计 39 个。索引名是 DDL 的一部分（显式索引名 + PG 的 `<表>_pkey` / `<表>_<列>_key` 约定），
 *   所以这里按**名字全清单**核对，而不是只数个数——数个数会漏掉"名字写错、另一个多出来"。
 */
const EXPECTED_INDEXES = [
  // 显式 CREATE INDEX / CREATE UNIQUE INDEX（20）
  'butler_tasks_owner', 'butler_tasks_conversation',
  'butler_subtasks_task', 'butler_subtasks_logical',
  'dsh_conversations_request', 'dsh_conversations_owner', 'dsh_conversations_parent',
  'dsh_turns_request', 'dsh_turns_conversation',
  'dsh_turn_results_conversation',
  'blog_drafts_owner',
  'blog_jobs_owner', 'blog_jobs_draft',
  'blog_operations_owner', 'blog_operations_draft', 'blog_operations_active',
  'blog_audit_owner',
  'blog_attachments_draft', 'blog_attachments_conversation',
  'blog_translation_cache',
  // PRIMARY KEY / UNIQUE 约束的隐式索引（4 + 15）
  'butler_tasks_id_owner_namespace_owner_id_key', 'butler_tasks_pkey',
  'butler_subtasks_pkey', 'butler_task_inputs_pkey', 'butler_agent_aliases_pkey', 'butler_requests_pkey',
  'dsh_conversations_id_owner_namespace_owner_id_key', 'dsh_conversations_pkey',
  'dsh_turns_pkey', 'dsh_turn_results_pkey',
  'blog_drafts_id_owner_namespace_owner_id_key', 'blog_drafts_pkey',
  'blog_jobs_owner_namespace_owner_id_caller_request_id_key', 'blog_jobs_pkey',
  'blog_operations_pkey', 'blog_audit_pkey', 'blog_attachments_pkey', 'blog_translations_pkey',
  'dsh_schema_versions_pkey',
];

/** 只放行本设计四种前缀的表名，清理时绝不误删同 schema 里的他表。 */
const PREFIXES = ['butler_', 'blog_', 'closedoff_', 'dsh_'];

/**
 * 剥掉 `--` 行注释。静态断言只应看**语句本体**：本 DDL 的注释里会正当地出现
 * `MATCH FULL` / `IF NOT EXISTS` 这类字样（"故意不写 X"），不剥注释会把说明当成代码。
 */
function stripComments(text) {
  return text.split('\n')
    .map(line => { const at = line.indexOf('--'); return at === -1 ? line : line.slice(0, at); })
    .join('\n');
}

let client;
let summary;
let connecting;

/**
 * 建库入口调一次（进程内只调一次，避免并发用例各自 CREATE DATABASE）。
 * 上一次跑到一半留下的同形状库可以复用：`0001_init.sql` 刻意不写 `IF NOT EXISTS`，
 * 重复执行必然 42P07——只有"表清单与本次期望一致"时才把这条错误当成"库已建好"。
 * 表清单不一致一律上抛，绝不 DROP 别人的库。
 */
async function connect() {
  if (client) return client;
  connecting ??= (async () => {
    assertTestDatabase(DSN);
    try {
      await createDatabase({ dsn: DSN, log: () => {} });
    } catch (error) {
      if (error.code !== '42P07') throw error;
      const probe = new Client({ connectionString: splitDsn(DSN).targetDsn });
      await probe.connect();
      try {
        const existing = await summarize(probe);
        assert.deepEqual([...existing.tables].sort(), [...EXPECTED_TABLES].sort(),
          `重复执行被拒绝（42P07），但库里的表清单与本设计不符，拒绝复用：${existing.tables.join(', ')}`);
      } finally {
        await probe.end();
      }
      console.log('库已存在且表清单一致：复用现有库。');
    }
    const target = new Client({ connectionString: splitDsn(DSN).targetDsn });
    await target.connect();
    summary = await summarize(target);
    client = target;
    return client;
  })();
  return connecting;
}

/** 清理只按前缀枚举本库的表；不 DROP SCHEMA，也不动任何非本设计的表。 */
async function dropOwnTables(target) {
  const found = await target.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (${PREFIXES.map((_, index) => `c.relname LIKE $${index + 1}`).join(' OR ')})`,
    PREFIXES.map(prefix => `${prefix}%`));
  for (const { name } of found.rows) await target.query(`DROP TABLE IF EXISTS "${name}" CASCADE`);
  return found.rows.map(row => row.name);
}

after(async () => {
  if (!client) return;
  try {
    assertTestDatabase(DSN);
    const dropped = await dropOwnTables(client);
    console.log(`已清理测试表 ${dropped.length} 张：${dropped.join(', ')}`);
  } finally {
    await client.end();
  }
});

// ---------------------------------------------------------------------------
// 不需要数据库的纯逻辑校验：参数解析与 DSN 裁决（永远运行）
// ---------------------------------------------------------------------------

test('参数解析与 DSN 裁决：未知参数被拒、建库目标不落自带库', async () => {
  assert.throws(() => parseArgs(['--force']), /未知参数/);
  assert.throws(() => parseArgs(['--dsn']), /缺少取值/);
  assert.throws(() => parseArgs(['--dsn', '--database', 'x']), /缺少取值/);
  assert.deepEqual(parseArgs(['--dsn=postgresql://h/dsh_test', '--database', 'dsh_test']),
    { dsn: 'postgresql://h/dsh_test', database: 'dsh_test', confirm: undefined, help: false });
  assert.equal(parseArgs(['--confirm', 'dsh']).confirm, 'dsh');
  assert.equal(parseArgs(['--help']).help, true);

  const split = splitDsn('postgresql://u:p@h:5432/dsh_test');
  assert.equal(split.target, 'dsh_test');
  assert.equal(split.adminDsn, 'postgresql://u:p@h:5432/postgres');
  assert.equal(split.targetDsn, 'postgresql://u:p@h:5432/dsh_test');
  assert.throws(() => validateTarget({ dsn: '', database: undefined, target: 'dsh' }), /未提供 DSN/);
  // 缺 DSN 的报错必须是"未提供 DSN"，不能是 URL 解析失败（顺序错了用户看不出是忘设环境变量）。
  assert.throws(() => assertDsn(''), /未提供 DSN/);
  await assert.rejects(createDatabase({ dsn: '', log: () => {} }), /未提供 DSN/);
  assert.throws(() => validateTarget({ dsn: 'postgresql://h/dsh', database: 'other', target: 'other' }), /不一致/);
  assert.throws(() => validateTarget({ dsn: 'postgresql://h/postgres', target: 'postgres' }), /自带库/);
  assert.throws(() => validateTarget({ dsn: 'postgresql://h/dsh_test', target: 'dsh;DROP' }), /不合法/);

  // 建库脚本的双闸门（红队实测补上的：早先的版本对 host 与库名没有任何闸门，
  // 用生产库名 `dsh` 会直接把库和 15 张表建出来；而本项目测试与正式环境共用一个 PG 实例）。
  assert.doesNotThrow(() => validateTarget({ dsn: 'postgresql://h/dsh_x_test', target: 'dsh_x_test', confirm: '' }),
    '一次性测试库（*_test / *_mig / *_iso）免确认');
  assert.throws(() => validateTarget({ dsn: 'postgresql://h/dsh', target: 'dsh', confirm: '' }), /显式确认/,
    '非一次性测试库必须显式确认');
  assert.throws(() => validateTarget({ dsn: 'postgresql://h/dsh', target: 'dsh', confirm: 'other' }), /显式确认/,
    '确认值必须等于库名');
  assert.doesNotThrow(() => validateTarget({ dsn: 'postgresql://h/dsh', target: 'dsh', confirm: 'dsh' }),
    'DSH_DB_CONFIRM/--confirm 等于库名时放行（正式库名的黑名单另算）');
  for (const legacy of ['butler', 'agents_group']) {
    assert.throws(() => validateTarget({ dsn: `postgresql://h/${legacy}`, target: legacy, confirm: legacy }),
      /正式库/, `${legacy} 是重构前的正式库：即使带确认也必须拒绝`);
  }

  const sql = readFileSync(SQL_FILE, 'utf8');
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  // 建表/建索引语句刻意不写 IF NOT EXISTS：重复执行应当报 42P07 整体回滚，而不是静默跳过。
  assert.ok(!/CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS/i.test(sql),
    'DDL 刻意不写 IF NOT EXISTS：重复执行应当整体回滚');

  // 切语句：剥掉行注释后按分号切，15 建表 + 20 建索引 + 1 插入 + 文件自带的 BEGIN/COMMIT = 38 条。
  const statements = splitStatements(sql);
  assert.equal(statements.length, 38, `语句数应当是 38，实际 ${statements.length}`);
  assert.ok(statements.every(part => part.trim() !== ''), '切出的语句不得有空片段');
  assert.ok(statements.every(part => !/--/.test(part)), '行注释必须被剥掉（注释里的分号会切错）');
  assert.equal(statements.filter(part => /^CREATE TABLE/.test(part)).length, 15);
  assert.equal(statements.filter(part => /^CREATE (?:UNIQUE )?INDEX/.test(part)).length, 20);
  assert.equal(statements.filter(part => /^INSERT INTO dsh_schema_versions/.test(part)).length, 1);
  assert.deepEqual(statements.slice(0, 1), ['BEGIN']);
  assert.deepEqual(statements.slice(-1), ['COMMIT']);
  // 占位符必须被真实毫秒值替换，且替换后仍是合法 SQL（不带引号）。
  // 只在 INSERT 那一条语句里数：文件头注释里也有同一个数字的示例，全文件搜会多命中一次。
  const applied = sqlWithAppliedAt(sql, 1789000000000);
  assert.equal((sql.match(/:applied_at/g) ?? []).length, 5, '占位符应当是 4 个（INSERT）+ 1 个（文件头说明）');
  assert.ok(!applied.includes(':applied_at'), '占位符必须全部替换');
  const versionInsert = splitStatements(applied).find(part => part.startsWith('INSERT INTO dsh_schema_versions'));
  assert.equal((versionInsert.match(/1789000000000/g) ?? []).length, 4, '四行版本行共用同一个毫秒值');
  assert.throws(() => sqlWithAppliedAt(sql, 0), /毫秒/);

  // 业务表不给 payload 默认值，框架表给——按表逐行数，避免误判注释里的同名字样。
  const bodies = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)].map(([, name, body]) => [name, body]);
  assert.equal(bodies.length, 15, '0001_init.sql 应当只建 15 张表');
  for (const [name, body] of bodies) {
    const generated = /GENERATED ALWAYS AS \(/.test(body);
    const defaulted = /payload\s+JSONB\s+NOT NULL DEFAULT/.test(body);
    if (['dsh_conversations', 'dsh_turns', 'dsh_turn_results'].includes(name)) assert.ok(defaulted, `${name}.payload 应当有默认值`);
    else assert.ok(!defaulted, `${name}.payload 不应当有默认值`);
    if (generated) assert.match(body, /CHECK \(payload/, `${name} 的生成列缺少形状守卫`);
  }
  // 镜像列的例外只有一处：blog_translations.status 不带 GENERATED。
  assert.match(bodies.find(([name]) => name === 'blog_translations')[1], /status\s+TEXT\s+NOT NULL/);
  // 唯一例外之外，blog 六个提升列都必须是生成列（`GENERATED ALWAYS AS (` 不会误匹配 IDENTITY）。
  // ⚠️ 这个 6 是**列数**，不要读成表数：生成列分布在 **4 张表**——blog_drafts（title/updated_at）、
  // blog_jobs（draft_id/status）、blog_operations（status）、blog_attachments（status）；
  // blog_audit 既无生成列也无镜像列。红队实测纠正过"6 张业务表里 5 张用生成列"这个错说法，
  // 所以下面把「列数」与「表数」两条分开断言，避免再次混为一谈。
  assert.equal((sql.match(/GENERATED ALWAYS AS \(payload/g) ?? []).length, 6, '生成列应当是 6 个（列数）');
  assert.deepEqual(
    bodies.filter(([, body]) => /GENERATED ALWAYS AS \(/.test(body)).map(([name]) => name).sort(),
    ['blog_attachments', 'blog_drafts', 'blog_jobs', 'blog_operations'],
    '生成列应当分布在 4 张表');
  assert.ok(!/GENERATED ALWAYS AS \(/.test(bodies.find(([name]) => name === 'blog_audit')[1]),
    'blog_audit 没有提升列');
  // blog_jobs.draft_id 的租户隔离外键（红队实测的缺口：补之前跨 owner 能插进去）。
  // 三条语义逐条钉住：复合外键带 owner 列、MATCH SIMPLE（默认，不写 MATCH FULL）、删除级联。
  const jobs = stripComments(bodies.find(([name]) => name === 'blog_jobs')[1]);
  assert.match(jobs,
    /FOREIGN KEY \(draft_id, owner_namespace, owner_id\)\s+REFERENCES blog_drafts \(id, owner_namespace, owner_id\) ON DELETE CASCADE/,
    'blog_jobs.draft_id 必须有带 owner 列的复合外键 + ON DELETE CASCADE');
  assert.ok(!/MATCH FULL/.test(jobs),
    'draft_id 是生成列且可为 NULL，必须留 MATCH SIMPLE：MATCH FULL 会把「键在、值为 null」判成 23503');
  // blog_operations 的多态 scope（第五轮定案）：draft_id 只装真实草稿 id、可空；合成 scope 落 scope_id；
  // 恰好一支非空。理由：manage:/remote: 合成 scope 装进 draft_id 会被复合外键判成 23503（实测）。
  const operations = stripComments(bodies.find(([name]) => name === 'blog_operations')[1]);
  assert.match(operations, /draft_id\s+TEXT\s*,/, 'blog_operations.draft_id 必须可空（合成 scope 那一支留空）');
  assert.match(operations, /scope_id\s+TEXT\s+NOT NULL DEFAULT ''/);
  assert.match(operations, /CHECK \(num_nonnulls\(draft_id, NULLIF\(scope_id, ''\)\) = 1\)/,
    'blog_operations 必须恰好一支 scope 非空');
  assert.ok(!/draft_id\s+TEXT\s+NOT NULL/.test(operations), 'draft_id 不得仍是 NOT NULL');
  assert.match(operations,
    /FOREIGN KEY \(draft_id, owner_namespace, owner_id\)\s+REFERENCES blog_drafts \(id, owner_namespace, owner_id\) ON DELETE CASCADE/,
    'blog_operations 的复合外键只对真实草稿那一支生效');
});

// ---------------------------------------------------------------------------
// 真库校验：形状
// ---------------------------------------------------------------------------

test('真库：15 张表、39 个索引、四行版本齐全', { skip: SKIP }, async () => {
  const target = await connect();

  assert.deepEqual([...summary.tables].sort(), [...EXPECTED_TABLES].sort(), '表清单与设计 §5 不一致');
  assert.deepEqual([...summary.indexes].sort(), [...EXPECTED_INDEXES].sort(), '索引清单与设计 §5 不一致');
  assert.equal(summary.indexes.length, 39);
  assert.equal(summary.indexes.length - summary.constraintIndexes.length, 20, '显式 CREATE INDEX 应当是 20 个');

  assert.deepEqual(summary.versions, [
    { pluginId: 'blog', version: 1 }, { pluginId: 'butler', version: 1 },
    { pluginId: 'closedoff', version: 1 }, { pluginId: 'runtime', version: 1 },
  ]);
  assert.deepEqual([...EXPECTED_VERSIONS].sort(), summary.versions.map(row => row.pluginId));

  const stamped = await target.query('SELECT DISTINCT applied_at FROM dsh_schema_versions');
  assert.equal(stamped.rowCount, 1, '四行版本应当共用同一个 applied_at');
  assert.ok(Number(stamped.rows[0].applied_at) > 1_700_000_000_000, 'applied_at 应当是 Date.now() 量级的毫秒值');

  // 部分唯一索引的谓词必须真在库里（不是"建了个全量唯一索引"）。
  const predicates = await target.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('dsh_conversations_request','dsh_turns_request','dsh_conversations_parent')`);
  for (const row of predicates.rows) assert.match(row.indexdef, /WHERE /, `${row.indexname} 应当是部分索引`);
  assert.match(predicates.rows.find(row => row.indexname === 'dsh_conversations_request').indexdef, /request_id <> ''::text/);

  // 生成列必须真的是 STORED 生成列（不是普通列）。
  const generated = await target.query(
    `SELECT table_name, column_name, is_generated FROM information_schema.columns
      WHERE table_schema='public' AND is_generated <> 'NEVER' ORDER BY table_name, column_name`);
  assert.deepEqual(generated.rows.map(row => `${row.table_name}.${row.column_name}`), [
    'blog_attachments.status', 'blog_drafts.title', 'blog_drafts.updated_at',
    'blog_jobs.draft_id', 'blog_jobs.status', 'blog_operations.status',
  ]);
  for (const row of generated.rows) assert.equal(row.is_generated, 'ALWAYS');
  // 6 个生成列分布在 4 张表（上面那 6 条是**列**清单，这里钉住**表**数）。
  assert.equal(new Set(generated.rows.map(row => row.table_name)).size, 4);

  // 外键清单（含新补的 blog_jobs）：逐条核对删除动作与匹配类型，不只数个数。
  // confdeltype: c=CASCADE / r=RESTRICT；confmatchtype: s=MATCH SIMPLE。
  const foreignKeys = await target.query(
    `SELECT conrelid::regclass::text AS table_name, conname, confdeltype, confmatchtype
       FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
      ORDER BY 1, 2`);
  assert.deepEqual(foreignKeys.rows.map(row => `${row.table_name}:${row.confdeltype}`), [
    'blog_attachments:c', 'blog_attachments:c', 'blog_jobs:c', 'blog_operations:c',
    'butler_subtasks:c', 'butler_task_inputs:c', 'butler_tasks:r',
    'dsh_turn_results:c', 'dsh_turns:c',
  ]);
  assert.ok(foreignKeys.rows.every(row => row.confmatchtype === 's'),
    '全部外键都应当是 MATCH SIMPLE（默认）：draft_id 可为 NULL，MATCH FULL 会误拒空引用');
  assert.ok(foreignKeys.rows.some(row => row.conname === 'blog_jobs_draft_id_owner_namespace_owner_id_fkey'),
    'blog_jobs 的租户隔离外键必须真的在库里');
});

// ---------------------------------------------------------------------------
// 真库校验：三条关键行为
// ---------------------------------------------------------------------------

test('真库行为 1：生成列不可写——INSERT 写 blog_drafts.title 报 428C9', { skip: SKIP }, async () => {
  const target = await connect();
  // ⚠️ 本文件的四条真库行为用例**各自独立**：每条自己插入所需的前置行，且 id 带自己的前缀
  // （b1- / b2- / b3- / b5-）。此前它们靠"行为 1 先插入 draft-ok、行为 2 再插入 conv-blog-1"
  // 的隐式顺序传递依赖，用 `--test-name-pattern` 单跑某一条就会失败（红队实测）。
  const insert = (columns, values) =>
    target.query(`INSERT INTO blog_drafts (${columns}) VALUES (${values})`);

  // 正例先立住：不写生成列、payload 带齐两个键就能插进去。
  await insert(
    'id, owner_namespace, owner_id, revision, payload',
    `'b1-draft-ok', 'user', 'alice', 1, '{"title":"标题","updatedAt":1758000000000}'::jsonb`);
  const restored = await target.query(
    `SELECT title, updated_at FROM blog_drafts WHERE id='b1-draft-ok'`);
  assert.equal(restored.rows[0].title, '标题');
  assert.equal(Number(restored.rows[0].updated_at), 1758000000000);

  // 反例：显式写生成列 → 428C9（cannot insert a non-DEFAULT value into column）。
  for (const [columns, values, column] of [
    ['id, owner_namespace, owner_id, revision, title, payload',
      `'b1-draft-bad-title', 'user', 'alice', 1, '手写的标题', '{"title":"标题","updatedAt":1}'::jsonb`, 'title'],
    ['id, owner_namespace, owner_id, revision, updated_at, payload',
      `'b1-draft-bad-updated', 'user', 'alice', 1, 1, '{"title":"标题","updatedAt":1}'::jsonb`, 'updated_at'],
  ]) {
    await assert.rejects(insert(columns, values), error => {
      assert.equal(error.code, '428C9', `写生成列应当报 428C9，实际 ${error.code}: ${error.message}`);
      assert.match(error.message, new RegExp(`"${column}"`));
      return true;
    });
  }

  // 形状守卫：payload 缺 title / updatedAt 时报 23514（CHECK），而不是静默写空。
  for (const [id, payload] of [['b1-draft-no-title', '{"updatedAt":1}'], ['b1-draft-no-updated', '{"title":"x"}']]) {
    await assert.rejects(
      insert('id, owner_namespace, owner_id, revision, payload', `'${id}', 'user', 'alice', 1, '${payload}'::jsonb`),
      error => error.code === '23514');
  }

  // 生成列的 cast 失败路径（红队实测的 22P02）：`?` 形状守卫只管键存在，值不是合法 bigint 时
  // 在**生成列求值**阶段就炸，既不是 23514 也不是 428C9——写入侧必须自己保证类型（设计 §8.1）。
  for (const [id, payload] of [
    ['b1-draft-cast-text', '{"title":null,"updatedAt":"not-a-number"}'],
    ['b1-draft-cast-float', '{"title":"x","updatedAt":1.5}'],
  ]) {
    await assert.rejects(
      insert('id, owner_namespace, owner_id, revision, payload', `'${id}', 'user', 'alice', 1, '${payload}'::jsonb`),
      error => {
        assert.equal(error.code, '22P02', `cast 失败应当报 22P02，实际 ${error.code}: ${error.message}`);
        assert.match(error.message, /invalid input syntax for type bigint/);
        return true;
      });
  }
  // 宽进：字符串数字能过 cast（`->>` 给的是文本）——它**不是**正确写法，只是不会报错。
  await insert('id, owner_namespace, owner_id, revision, payload',
    `'b1-draft-cast-strnum', 'user', 'alice', 1, '{"title":"x","updatedAt":"1758000000000"}'::jsonb`);
  // NULL 值 + DESC 排序：`blog_drafts_owner` 是 (owner_namespace, owner_id, updated_at DESC)，
  // PG 在 DESC 下默认 NULLS FIRST，所以"没有 updatedAt 的草稿"会排在最前（设计已登记）。
  await insert('id, owner_namespace, owner_id, revision, payload',
    `'b1-draft-null-updated', 'user', 'alice', 1, '{"title":"x","updatedAt":null}'::jsonb`);
  const ordered = await target.query(
    `SELECT id FROM blog_drafts WHERE owner_namespace='user' AND owner_id='alice'
      ORDER BY updated_at DESC LIMIT 1`);
  assert.equal(ordered.rows[0].id, 'b1-draft-null-updated', 'updated_at 为 NULL 时 DESC 排最前（NULLS FIRST）');
});

test('真库行为 2：部分唯一索引——空 request_id 可共存，非空同值冲突', { skip: SKIP }, async () => {
  const target = await connect();
  // 独立用例：前置数据全部自带（b2- 前缀），不依赖别的用例先跑。
  const conversation = (id, requestId) => target.query(
    `INSERT INTO dsh_conversations
       (id, agent_id, owner_namespace, owner_id, request_id, ready, created_at, updated_at)
     VALUES ($1, 'butler', 'user', 'alice', $2, TRUE, 1758000000000, 1758000000000)`, [id, requestId]);

  // 管家式会话：没有 requestId 语义 → request_id = ''，多行必须能共存。
  await conversation('b2-conv-empty-1', '');
  await conversation('b2-conv-empty-2', '');
  const empty = await target.query(`SELECT count(*) AS total FROM dsh_conversations WHERE request_id = ''`);
  assert.equal(Number(empty.rows[0].total), 2, "两条 request_id='' 的会话必须能共存");

  // 幂等式会话：同一个 (agent_id, owner, request_id) 第二次必须冲突。
  await conversation('b2-conv-mission-1', 'mission-42');
  await assert.rejects(conversation('b2-conv-mission-2', 'mission-42'), error => {
    assert.equal(error.code, '23505', `同 request_id 应当报 23505，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /dsh_conversations_request/);
    return true;
  });

  // 幂等键跨 agent 隔离：别的 Agent 用同一个 request_id 不冲突。
  await target.query(
    `INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, request_id, ready, created_at, updated_at)
     VALUES ('b2-conv-blog-1', 'blog', 'user', 'alice', 'mission-42', TRUE, 1758000000000, 1758000000000)`);
  const same = await target.query(`SELECT count(*) AS total FROM dsh_conversations WHERE request_id = 'mission-42'`);
  assert.equal(Number(same.rows[0].total), 2, 'request_id 的唯一性按 agent_id 隔离');

  // `ON CONFLICT` 必须重复部分索引谓词，否则 42P10（设计 §8.1 的语法陷阱）。
  await assert.rejects(
    target.query(`INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, request_id, created_at, updated_at)
                  VALUES ('b2-conv-onconflict', 'blog', 'user', 'alice', 'mission-99', 1, 1)
                  ON CONFLICT (agent_id, owner_namespace, owner_id, request_id) DO NOTHING`),
    error => error.code === '42P10',
    '不带谓词的 ON CONFLICT 应当报 42P10');
  await target.query(
    `INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, request_id, created_at, updated_at)
     VALUES ('b2-conv-onconflict', 'blog', 'user', 'alice', 'mission-99', 1, 1)
     ON CONFLICT (agent_id, owner_namespace, owner_id, request_id) WHERE request_id <> '' DO NOTHING`);

  // `dsh_turn_results` 刻意没有 (turn, operation) 唯一约束：同一操作可以有多条结果。
  for (const id of ['b2-result-1', 'b2-result-2']) {
    await target.query(
      `INSERT INTO dsh_turn_results (id, agent_id, owner_namespace, owner_id, conversation_id, turn_id, operation_id, created_at)
       VALUES ($1, 'blog', 'user', 'alice', 'b2-conv-blog-1', 'turn-1', 'op-1', 1758000000000)`, [id]);
  }
  const results = await target.query(`SELECT count(*) AS total FROM dsh_turn_results WHERE turn_id='turn-1' AND operation_id='op-1'`);
  assert.equal(Number(results.rows[0].total), 2, '同一 (turn, operation) 必须允许多条结果');

  // 陷阱列（红队实测的设计承诺）：漏写 `agent_id` → 23502；不写 `ready` → 落库 false。
  await assert.rejects(
    target.query(`INSERT INTO dsh_conversations (id, owner_namespace, owner_id, created_at, updated_at)
                  VALUES ('b2-conv-no-agent', 'user', 'alice', 1, 1)`),
    error => error.code === '23502', '漏写 agent_id 应当报 23502（该列无默认值）');
  await target.query(`INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, created_at, updated_at)
                      VALUES ('b2-conv-no-ready', 'butler', 'user', 'alice', 1, 1)`);
  const ready = await target.query(`SELECT ready FROM dsh_conversations WHERE id='b2-conv-no-ready'`);
  assert.equal(ready.rows[0].ready, false, '不写 ready 会落成 false——管家必须显式写 TRUE');
});

test('真库行为 3：blog_attachments 的 num_nonnulls 约束拒绝两个极端', { skip: SKIP }, async () => {
  const target = await connect();
  // 独立用例：自己插入草稿与**会话**（此前依赖行为 1 的 draft-ok 与行为 2 的 conv-blog-1）。
  // 会话的 request_id 用非空值，避免影响行为 2 里"空 request_id 两条"的计数。
  await target.query(`INSERT INTO blog_drafts (id, owner_namespace, owner_id, revision, payload)
                      VALUES ('b3-draft', 'user', 'alice', 1, '{"title":"标题","updatedAt":1758000000000}'::jsonb)`);
  await target.query(`INSERT INTO dsh_conversations
                        (id, agent_id, owner_namespace, owner_id, request_id, ready, created_at, updated_at)
                      VALUES ('b3-conv', 'blog', 'user', 'alice', 'b3-mission-42', TRUE, 1, 1)`);
  const attachment = (id, draftId, conversationId) => target.query(
    `INSERT INTO blog_attachments (id, owner_namespace, owner_id, draft_id, conversation_id, payload)
     VALUES ($1, 'user', 'alice', $2, $3, '{"status":"ready"}'::jsonb)`, [id, draftId, conversationId]);

  // 正例：恰好一个 scope 非空，两个方向都能落。
  await attachment('att-draft', 'b3-draft', null);
  await attachment('att-conversation', null, 'b3-conv');

  // 反例 1：两个都空 → 23514（blog_attachments_one_scope）。
  await assert.rejects(attachment('att-none', null, null), error => {
    assert.equal(error.code, '23514', `两个 scope 都空应当报 23514，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /blog_attachments_one_scope/);
    return true;
  });

  // 反例 2：两个都非空 → 同样 23514。
  await assert.rejects(attachment('att-both', 'b3-draft', 'b3-conv'), error => {
    assert.equal(error.code, '23514', `两个 scope 都非空应当报 23514，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /blog_attachments_one_scope/);
    return true;
  });

  // 外键方向也要真在库里：指向不存在的草稿 → 23503。
  await assert.rejects(attachment('att-ghost', 'draft-missing', null), error => error.code === '23503');

  // 跨 owner 的复合外键（红队实测成立的那条）：A 的草稿 id + B 的 owner → 23503。
  await assert.rejects(
    target.query(`INSERT INTO blog_attachments (id, owner_namespace, owner_id, draft_id, payload)
                  VALUES ('att-cross-owner', 'user', 'bob', 'b3-draft', '{"status":"ready"}'::jsonb)`),
    error => {
      assert.equal(error.code, '23503');
      assert.match(error.message, /blog_attachments_draft_id_owner_namespace_owner_id_fkey/);
      return true;
    });

  // 生成列与镜像列的差异：blog_attachments.status 不可写，blog_translations.status 必须写。
  await assert.rejects(
    target.query(`INSERT INTO blog_attachments (id, owner_namespace, owner_id, draft_id, status, payload)
                  VALUES ('att-status', 'user', 'alice', 'b3-draft', 'ready', '{"status":"ready"}'::jsonb)`),
    error => error.code === '428C9');
  await target.query(
    `INSERT INTO blog_translations (id, cache_key, owner_namespace, owner_id, status, payload)
     VALUES ('b3-tr-1', 'cache-1', 'user', 'alice', 'ready', '{"text":"译文"}'::jsonb)`);
  const translation = await target.query(`SELECT status FROM blog_translations WHERE id='b3-tr-1'`);
  assert.equal(translation.rows[0].status, 'ready', 'blog_translations.status 是镜像列，INSERT 必须写它');
});

test('真库行为 4：重复执行被拒绝、零改动，且失败后连接仍可用', { skip: SKIP }, async () => {
  const target = await connect();
  const before = await summarize(target);
  const sql = readFileSync(SQL_FILE, 'utf8');
  await assert.rejects(applySchema(target, sql, { log: () => {} }), error => {
    assert.equal(error.code, '42P07', `重复建库应当报 42P07，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /already exists/);
    return true;
  });
  // 失败后连接必须能继续用：`applySchema` 在 catch 里自己发 ROLLBACK 就是为这条断言存在的。
  // 反例（已实测）：把整份 DDL 作为一条多语句查询发出去时，失败语句之后的 ROLLBACK 根本执行不到，
  // 连接会永久停在 aborted 态，后续任何查询都报 25P02。
  const after_ = await summarize(target);
  assert.deepEqual(after_, before, '失败的重复执行不得留下任何改动');
  const versions = await target.query('SELECT count(*) AS total FROM dsh_schema_versions');
  assert.equal(Number(versions.rows[0].total), 4, '重复执行不得重复插入版本行');
});

test('真库行为 5：blog_jobs 的租户隔离外键——跨 owner 被拒、同 owner 通过、删草稿级联', { skip: SKIP }, async () => {
  const target = await connect();
  // 本用例复现红队实测的缺口：补外键之前，"B 的 owner 用 blog_jobs 指向 A 的草稿"能插入成功。
  // 前置自带（b5- 前缀），不依赖别的用例。
  const draft = (id, owner) => target.query(
    `INSERT INTO blog_drafts (id, owner_namespace, owner_id, revision, payload)
     VALUES ($1, 'user', $2, 1, '{"title":"标题","updatedAt":1758000000000}'::jsonb)`, [id, owner]);
  // draftId 传 null 时构造出 `{"input":{"draftId":null}}`——键在、值为 JSON null（形状守卫放行、生成列 NULL）。
  const job = (id, ns, owner, draftId) => target.query(
    `INSERT INTO blog_jobs (id, owner_namespace, owner_id, caller, request_id, input_hash, payload)
     VALUES ($1, $2, $3, 'web', $4, 'hash-' || $1,
             jsonb_build_object('status', 'queued', 'input', jsonb_build_object('draftId', $5::text)))`,
    [id, ns, owner, `req-${id}`, draftId]);

  await draft('b5-draft-a', 'alice');

  // ① 正例：同 owner 指向自己的草稿 → 成功，生成列落到 draft_id。
  await job('b5-job-ok', 'user', 'alice', 'b5-draft-a');
  const ok = await target.query(`SELECT draft_id FROM blog_jobs WHERE id='b5-job-ok'`);
  assert.equal(ok.rows[0].draft_id, 'b5-draft-a');

  // ② 反例（红队的那一条）：B 的 owner 指向 A 的草稿 → 23503。
  await assert.rejects(job('b5-job-cross', 'user', 'bob', 'b5-draft-a'), error => {
    assert.equal(error.code, '23503', `跨 owner 应当报 23503，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /blog_jobs_draft_id_owner_namespace_owner_id_fkey/);
    return true;
  });
  // ②b 换 namespace 同样被拒（隔离按 (namespace, owner) 两列一起判）。
  await assert.rejects(job('b5-job-cross-ns', 'org', 'alice', 'b5-draft-a'),
    error => error.code === '23503');
  // ②c 指向不存在的草稿同样被拒（插入期引用完整性）。
  await assert.rejects(job('b5-job-ghost', 'user', 'alice', 'b5-draft-missing'),
    error => error.code === '23503');

  // ③ 边界：`draftId` 键在、值为 JSON null → MATCH SIMPLE 不校验（没有引用对象），落库 draft_id 为 NULL。
  //    这是**故意**的语义：`MATCH FULL` 会因 owner 两列 NOT NULL 而拒绝它，把合法空引用判成 23503。
  await job('b5-job-null-draft', 'user', 'bob', null);
  const nullDraft = await target.query(`SELECT draft_id IS NULL AS is_null FROM blog_jobs WHERE id='b5-job-null-draft'`);
  assert.equal(nullDraft.rows[0].is_null, true, 'draftId 为 JSON null 时生成列为 NULL，且不触发外键');

  // ④ 形状守卫仍在：缺 `draftId` 键 → 23514（外键不替代 CHECK）。
  await assert.rejects(
    target.query(`INSERT INTO blog_jobs (id, owner_namespace, owner_id, caller, request_id, input_hash, payload)
                  VALUES ('b5-job-no-key', 'user', 'alice', 'web', 'req-b5-job-no-key', 'h', '{"status":"queued","input":{}}'::jsonb)`),
    error => error.code === '23514');

  // ⑤ 删除行为与 DDL 注释一致：`ON DELETE CASCADE`——删草稿**不被拒绝**，且三张从属表的行一起消失。
  await target.query(`INSERT INTO blog_operations (id, owner_namespace, owner_id, draft_id, revision, payload)
                      VALUES ('b5-op', 'user', 'alice', 'b5-draft-a', 1, '{"status":"prepared"}'::jsonb)`);
  await target.query(`INSERT INTO blog_attachments (id, owner_namespace, owner_id, draft_id, payload)
                      VALUES ('b5-att', 'user', 'alice', 'b5-draft-a', '{"status":"ready"}'::jsonb)`);
  const before = await target.query(
    `SELECT (SELECT count(*) FROM blog_jobs WHERE draft_id='b5-draft-a') AS jobs,
            (SELECT count(*) FROM blog_operations WHERE draft_id='b5-draft-a') AS ops,
            (SELECT count(*) FROM blog_attachments WHERE draft_id='b5-draft-a') AS atts`);
  assert.deepEqual(before.rows[0], { jobs: '1', ops: '1', atts: '1' });
  const removed = await target.query(
    `DELETE FROM blog_drafts WHERE id='b5-draft-a' AND owner_namespace='user' AND owner_id='alice'`);
  assert.equal(removed.rowCount, 1, '删草稿必须成功（RESTRICT 会让它报 23503，故选 CASCADE）');
  const afterDelete = await target.query(
    `SELECT (SELECT count(*) FROM blog_jobs WHERE draft_id='b5-draft-a') AS jobs,
            (SELECT count(*) FROM blog_operations WHERE draft_id='b5-draft-a') AS ops,
            (SELECT count(*) FROM blog_attachments WHERE draft_id='b5-draft-a') AS atts`);
  assert.deepEqual(afterDelete.rows[0], { jobs: '0', ops: '0', atts: '0' },
    '删草稿后 job / operation / attachment 三张表的行都应随草稿消失（CASCADE）');
});

test('真库行为 6：RESTRICT 的错误码是 23001（不是 23503）', { skip: SKIP }, async () => {
  const target = await connect();
  // 设计 §6 决策 4：`butler_tasks.conversation_id` 用 ON DELETE RESTRICT。实施者容易按 23503 写断言，
  // 而 PG 对 RESTRICT 报的是 **23001**（violates RESTRICT setting of foreign key constraint，红队实测）。
  await target.query(`INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, ready, created_at, updated_at)
                      VALUES ('b6-conv', 'butler', 'user', 'alice', TRUE, 1, 1)`);
  await target.query(`INSERT INTO butler_tasks (id, conversation_id, owner_namespace, owner_id, goal, state, created_at, updated_at)
                      VALUES ('b6-task', 'b6-conv', 'user', 'alice', '目标', 'running', 1, 1)`);
  await assert.rejects(
    target.query(`DELETE FROM dsh_conversations WHERE id='b6-conv'`),
    error => {
      assert.equal(error.code, '23001', `RESTRICT 应当报 23001，实际 ${error.code}: ${error.message}`);
      assert.match(error.message, /RESTRICT setting of foreign key constraint/);
      assert.match(error.message, /butler_tasks_conversation_id_owner_namespace_owner_id_fkey/);
      return true;
    });
});

test('真库行为 7：blog_operations 的多态 scope——两支各自成立、恰好一支非空、级联只清真实草稿那支', { skip: SKIP }, async () => {
  const target = await connect();
  // 第五轮定案（本轮新发现的 23503 的修复）：`draft_id` 只装真实草稿 id、合成 scope 落 `scope_id`。
  // 用例按四条钉住：① 真实草稿操作成功 + 跨 owner 被拒；② manage:/remote: 合成 scope 成功；
  // ③ 两支都空 / 都非空被 23514 挡；④ 删草稿只级联真实草稿操作，合成 scope 的记录留下。
  await target.query(`INSERT INTO blog_drafts (id, owner_namespace, owner_id, revision, payload)
                      VALUES ('b7-draft', 'user', 'alice', 1, '{"title":"标题","updatedAt":1758000000000}'::jsonb)`);
  const operation = (id, ns, owner, draftId, scopeId) => target.query(
    `INSERT INTO blog_operations (id, owner_namespace, owner_id, draft_id, scope_id, revision, payload)
     VALUES ($1, $2, $3, $4, $5, 1, '{"status":"prepared"}'::jsonb)`, [id, ns, owner, draftId, scopeId]);

  // ① 真实草稿操作：draft_id 非空、scope_id 空串 → 成功；跨 owner 指向 A 的草稿 → 23503。
  await operation('b7-op-draft', 'user', 'alice', 'b7-draft', '');
  const draftOp = await target.query(`SELECT draft_id, scope_id FROM blog_operations WHERE id='b7-op-draft'`);
  assert.deepEqual(draftOp.rows[0], { draft_id: 'b7-draft', scope_id: '' });
  await assert.rejects(operation('b7-op-cross', 'user', 'bob', 'b7-draft', ''), error => {
    assert.equal(error.code, '23503', `跨 owner 应当报 23503，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /blog_operations_draft_id_owner_namespace_owner_id_fkey/);
    return true;
  });

  // ② 合成 scope（管理 / 远端）：draft_id 留空 → MATCH SIMPLE 下外键不检查，插入**成功**。
  //    这两条正是修复前会报 23503 的形状（application.ts:203 / :239）。
  for (const [id, scope] of [['b7-op-manage', 'manage:blog:new'], ['b7-op-remote', 'remote:12345']]) {
    await operation(id, 'user', 'alice', null, scope);
  }
  const synthetic = await target.query(
    `SELECT id, draft_id, scope_id FROM blog_operations
      WHERE id IN ('b7-op-manage','b7-op-remote') ORDER BY id`);
  assert.deepEqual(synthetic.rows.map(row => [row.id, row.draft_id, row.scope_id]), [
    ['b7-op-manage', null, 'manage:blog:new'],
    ['b7-op-remote', null, 'remote:12345'],
  ]);

  // ③ 恰好一支非空：两支都空 / 都非空 → 23514（blog_operations_one_scope）。
  for (const [id, draftId, scopeId] of [['b7-op-none', null, ''], ['b7-op-both', 'b7-draft', 'remote:1']]) {
    await assert.rejects(operation(id, 'user', 'alice', draftId, scopeId), error => {
      assert.equal(error.code, '23514', `scope 数量不对应当报 23514，实际 ${error.code}: ${error.message}`);
      assert.match(error.message, /blog_operations_one_scope/);
      return true;
    });
  }

  // ④ 删草稿：真实草稿操作级联消失；合成 scope 的记录**留下**（它们的 scope 指向远端对象，
  //    不是本地草稿——级联掉等于静默丢弃一条"提交待核对"记录）。
  const before = await target.query(
    `SELECT (SELECT count(*) FROM blog_operations WHERE id='b7-op-draft') AS draft_ops,
            (SELECT count(*) FROM blog_operations WHERE id IN ('b7-op-manage','b7-op-remote')) AS synthetic_ops`);
  assert.deepEqual(before.rows[0], { draft_ops: '1', synthetic_ops: '2' });
  const removed = await target.query(
    `DELETE FROM blog_drafts WHERE id='b7-draft' AND owner_namespace='user' AND owner_id='alice'`);
  assert.equal(removed.rowCount, 1, '删草稿必须成功（这一支是 CASCADE，不是 RESTRICT）');
  const after = await target.query(
    `SELECT (SELECT count(*) FROM blog_operations WHERE id='b7-op-draft') AS draft_ops,
            (SELECT count(*) FROM blog_operations WHERE id IN ('b7-op-manage','b7-op-remote')) AS synthetic_ops`);
  assert.deepEqual(after.rows[0], { draft_ops: '0', synthetic_ops: '2' },
    '删草稿只级联真实草稿操作；合成 scope 的记录留下');
});
