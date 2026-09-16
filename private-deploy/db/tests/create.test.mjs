/**
 * 建库脚本（M1）的自动校验：跑 `0001_init.sql` 真建一次库，再核对形状与三条关键行为。
 *
 * 运行方式：
 *   设 `BUTLER_TEST_PG_DSN`（沿用本仓 PG 契约套件的门控变量）后
 *   `node --test private-deploy/db/tests/create.test.mjs`。
 *   也接受 `DSH_PG_DSN`（建库脚本自己读的那个变量，便于"设一个变量就同时覆盖建库与校验"）
 *   与 `DSH_DB_TEST_DSN`（只跑建库校验、不动契约套件时用）。
 *
 * 两道安全闸（缺一不可，避免把生产库 DROP 掉）：
 *   1. DSN 的库名必须以 `_test` 结尾——与 `acceptance-pg-contract.test.ts:147` 同一条防呆；
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
    { dsn: 'postgresql://h/dsh_test', database: 'dsh_test', help: false });
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
  assert.equal((sql.match(/GENERATED ALWAYS AS \(payload/g) ?? []).length, 6);
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
});

// ---------------------------------------------------------------------------
// 真库校验：三条关键行为
// ---------------------------------------------------------------------------

test('真库行为 1：生成列不可写——INSERT 写 blog_drafts.title 报 428C9', { skip: SKIP }, async () => {
  const target = await connect();
  const insert = (columns, values) =>
    target.query(`INSERT INTO blog_drafts (${columns}) VALUES (${values})`);

  // 正例先立住：不写生成列、payload 带齐两个键就能插进去。
  await insert(
    'id, owner_namespace, owner_id, revision, payload',
    `'draft-ok', 'user', 'alice', 1, '{"title":"标题","updatedAt":1758000000000}'::jsonb`);
  const restored = await target.query(
    `SELECT title, updated_at FROM blog_drafts WHERE id='draft-ok'`);
  assert.equal(restored.rows[0].title, '标题');
  assert.equal(Number(restored.rows[0].updated_at), 1758000000000);

  // 反例：显式写生成列 → 428C9（cannot insert a non-DEFAULT value into column）。
  for (const [columns, values, column] of [
    ['id, owner_namespace, owner_id, revision, title, payload',
      `'draft-bad-title', 'user', 'alice', 1, '手写的标题', '{"title":"标题","updatedAt":1}'::jsonb`, 'title'],
    ['id, owner_namespace, owner_id, revision, updated_at, payload',
      `'draft-bad-updated', 'user', 'alice', 1, 1, '{"title":"标题","updatedAt":1}'::jsonb`, 'updated_at'],
  ]) {
    await assert.rejects(insert(columns, values), error => {
      assert.equal(error.code, '428C9', `写生成列应当报 428C9，实际 ${error.code}: ${error.message}`);
      assert.match(error.message, new RegExp(`"${column}"`));
      return true;
    });
  }

  // 形状守卫：payload 缺 title / updatedAt 时报 23514（CHECK），而不是静默写空。
  for (const [id, payload] of [['draft-no-title', '{"updatedAt":1}'], ['draft-no-updated', '{"title":"x"}']]) {
    await assert.rejects(
      insert('id, owner_namespace, owner_id, revision, payload', `'${id}', 'user', 'alice', 1, '${payload}'::jsonb`),
      error => error.code === '23514');
  }
});

test('真库行为 2：部分唯一索引——空 request_id 可共存，非空同值冲突', { skip: SKIP }, async () => {
  const target = await connect();
  const conversation = (id, requestId) => target.query(
    `INSERT INTO dsh_conversations
       (id, agent_id, owner_namespace, owner_id, request_id, ready, created_at, updated_at)
     VALUES ($1, 'butler', 'user', 'alice', $2, TRUE, 1758000000000, 1758000000000)`, [id, requestId]);

  // 管家式会话：没有 requestId 语义 → request_id = ''，多行必须能共存。
  await conversation('conv-empty-1', '');
  await conversation('conv-empty-2', '');
  const empty = await target.query(`SELECT count(*) AS total FROM dsh_conversations WHERE request_id = ''`);
  assert.equal(Number(empty.rows[0].total), 2, "两条 request_id='' 的会话必须能共存");

  // 幂等式会话：同一个 (agent_id, owner, request_id) 第二次必须冲突。
  await conversation('conv-mission-1', 'mission-42');
  await assert.rejects(conversation('conv-mission-2', 'mission-42'), error => {
    assert.equal(error.code, '23505', `同 request_id 应当报 23505，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /dsh_conversations_request/);
    return true;
  });

  // 幂等键跨 agent 隔离：别的 Agent 用同一个 request_id 不冲突。
  await target.query(
    `INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, request_id, ready, created_at, updated_at)
     VALUES ('conv-blog-1', 'blog', 'user', 'alice', 'mission-42', TRUE, 1758000000000, 1758000000000)`);
  const same = await target.query(`SELECT count(*) AS total FROM dsh_conversations WHERE request_id = 'mission-42'`);
  assert.equal(Number(same.rows[0].total), 2, 'request_id 的唯一性按 agent_id 隔离');

  // `ON CONFLICT` 必须重复部分索引谓词，否则 42P10（设计 §8.1 的语法陷阱）。
  await assert.rejects(
    target.query(`INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, request_id, created_at, updated_at)
                  VALUES ('conv-onconflict', 'blog', 'user', 'alice', 'mission-99', 1, 1)
                  ON CONFLICT (agent_id, owner_namespace, owner_id, request_id) DO NOTHING`),
    error => error.code === '42P10',
    '不带谓词的 ON CONFLICT 应当报 42P10');
  await target.query(
    `INSERT INTO dsh_conversations (id, agent_id, owner_namespace, owner_id, request_id, created_at, updated_at)
     VALUES ('conv-onconflict', 'blog', 'user', 'alice', 'mission-99', 1, 1)
     ON CONFLICT (agent_id, owner_namespace, owner_id, request_id) WHERE request_id <> '' DO NOTHING`);

  // `dsh_turn_results` 刻意没有 (turn, operation) 唯一约束：同一操作可以有多条结果。
  for (const id of ['result-1', 'result-2']) {
    await target.query(
      `INSERT INTO dsh_turn_results (id, agent_id, owner_namespace, owner_id, conversation_id, turn_id, operation_id, created_at)
       VALUES ($1, 'blog', 'user', 'alice', 'conv-blog-1', 'turn-1', 'op-1', 1758000000000)`, [id]);
  }
  const results = await target.query(`SELECT count(*) AS total FROM dsh_turn_results WHERE turn_id='turn-1' AND operation_id='op-1'`);
  assert.equal(Number(results.rows[0].total), 2, '同一 (turn, operation) 必须允许多条结果');
});

test('真库行为 3：blog_attachments 的 num_nonnulls 约束拒绝两个极端', { skip: SKIP }, async () => {
  const target = await connect();
  const attachment = (id, draftId, conversationId) => target.query(
    `INSERT INTO blog_attachments (id, owner_namespace, owner_id, draft_id, conversation_id, payload)
     VALUES ($1, 'user', 'alice', $2, $3, '{"status":"ready"}'::jsonb)`, [id, draftId, conversationId]);

  // 正例：恰好一个 scope 非空，两个方向都能落。
  await attachment('att-draft', 'draft-ok', null);
  await attachment('att-conversation', null, 'conv-blog-1');

  // 反例 1：两个都空 → 23514（blog_attachments_one_scope）。
  await assert.rejects(attachment('att-none', null, null), error => {
    assert.equal(error.code, '23514', `两个 scope 都空应当报 23514，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /blog_attachments_one_scope/);
    return true;
  });

  // 反例 2：两个都非空 → 同样 23514。
  await assert.rejects(attachment('att-both', 'draft-ok', 'conv-blog-1'), error => {
    assert.equal(error.code, '23514', `两个 scope 都非空应当报 23514，实际 ${error.code}: ${error.message}`);
    assert.match(error.message, /blog_attachments_one_scope/);
    return true;
  });

  // 外键方向也要真在库里：指向不存在的草稿 → 23503。
  await assert.rejects(attachment('att-ghost', 'draft-missing', null), error => error.code === '23503');

  // 生成列与镜像列的差异：blog_attachments.status 不可写，blog_translations.status 必须写。
  await assert.rejects(
    target.query(`INSERT INTO blog_attachments (id, owner_namespace, owner_id, draft_id, status, payload)
                  VALUES ('att-status', 'user', 'alice', 'draft-ok', 'ready', '{"status":"ready"}'::jsonb)`),
    error => error.code === '428C9');
  await target.query(
    `INSERT INTO blog_translations (id, cache_key, owner_namespace, owner_id, status, payload)
     VALUES ('tr-1', 'cache-1', 'user', 'alice', 'ready', '{"text":"译文"}'::jsonb)`);
  const translation = await target.query(`SELECT status FROM blog_translations WHERE id='tr-1'`);
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
