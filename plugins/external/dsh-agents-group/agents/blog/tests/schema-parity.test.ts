/**
 * **形状一致性判据**：SQLite 替身（`src/store.mjs`）的六张业务表，与**生产建库脚本**
 * `private-deploy/db/0001_init.sql` 的列名 / 生成列**逐表比对**。
 *
 * ## 为什么需要它（这条用例要防的是什么）
 * 替身此前**整整落后一代形状**（`owner TEXT` + `data TEXT`），而生产早已是
 * `owner_namespace` + `owner_id` + `payload` + 生成列。后果不是"覆盖率低"，而是
 * **证据面与生产事实面不一致**：跑在替身上的那批用例**碰不到**形状相关的代码路径，
 * 于是"两列归属 / 载荷缺键 / 生成了还去写 / 两处多态 scope 恰好一支"这些错法一条都抓不到。
 * 靠"下一个改 `store.mjs` 的人记得同步"是防不住的 —— 判据必须**从生产 DDL 反推**，
 * 而不是把期望值再手写一遍（手写的期望值会与实现一起漂移，那正是本仓反复踩的坑）。
 *
 * ## 判据的三层（逐层更强）
 * 1. **列名集合**逐表相等；
 * 2. **生成列集合**逐表相等（`GENERATED ALWAYS` vs SQLite 的 `hidden IN (2,3)`）——
 *    并顺带断言"6 个生成列分布在 4 张表"，与 DDL 自己的注释对齐；
 * 3. **行为**：写一个生成列必须**报错**（SQLite 与 PG 的 `428C9` 是同一条语义）。
 *    只比列名会漏掉"名字对但可写"，第 3 层把"不能写"这条**语义**钉住。
 *
 * ⚠️ 读不到 DDL 文件时**直接失败**（不跳过）：缺文件说明检出是坏的，不是"这条用例不适用"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BlogStore } from '../src/store.ts'

/** 与 `tests/pg-smoke.test.mjs` 同一个相对位置（那条路径已实测可用）。 */
const DDL_URL = new URL('../../../../../../private-deploy/db/0001_init.sql', import.meta.url)
const TABLES = ['blog_drafts', 'blog_jobs', 'blog_operations', 'blog_audit', 'blog_attachments', 'blog_translations']

/**
 * 从 `CREATE TABLE <表>(…)` 的括号体里抽出**列名**。
 *
 * 抗噪要点（DDL 里有大量注释、`CHECK`、`CONSTRAINT`、`FOREIGN KEY`、`UNIQUE`）：
 * - 只按**整行注释**（`^\s*--`）过滤，不动行内内容 —— 本 DDL 的注释都是整行的；
 * - 按**括号深度为 0** 的逗号切分：`CHECK (num_nonnulls(a, b) = 1)` 里的逗号在括号内，不能当分隔符；
 * - 以 `CONSTRAINT`/`CHECK`/`FOREIGN`/`UNIQUE`/`PRIMARY` 开头的片段**不是列**；
 * - 剩下的片段取**第一个标识符**为列名。
 */
export function columnNamesOf(sql: string, table: string): { columns: string[]; generated: string[]; identity: string[] } {
  const match = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)
  assert.ok(match, `DDL 里找不到表 ${table}（建库脚本改过？判据要跟着改，不能静默）`)
  const matched = match[1]
  // 上面那条 `assert.ok(match)` 已经保证有捕获组；这里再窄一次是为了 `noUncheckedIndexedAccess`
  // （不是新增判据：拿不到表体就等于解析器失效，必须响）。
  assert.ok(matched !== undefined, `DDL 里表 ${table} 的表体解析失败`)
  const body = matched
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .join('\n')
  const fragments: string[] = []
  let depth = 0, current = ''
  for (const char of body) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) { fragments.push(current); current = ''; continue }
    current += char
  }
  fragments.push(current)
  const columns: string[] = [], generated: string[] = [], identity: string[] = []
  for (const fragment of fragments) {
    const text = fragment.trim()
    if (text === '') continue
    if (/^(CONSTRAINT|CHECK|FOREIGN|UNIQUE|PRIMARY)\b/i.test(text)) continue
    const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text)?.[1]
    assert.ok(name, `表 ${table} 的片段解析不出列名（判据的解析器要修，不能放过）：${text.slice(0, 80)}`)
    columns.push(name)
    /**
     * 只把 **`GENERATED ALWAYS AS (…)`**（由表达式/载荷派生）算作"计算生成列"，
     * **不**把 `GENERATED ALWAYS AS IDENTITY` 算进去 —— 后者是**自增**列（`seq` / `blog_audit.id`），
     * 语义完全不同：它不是"由载荷派生所以不能写"，而是"由库铸号所以调用方不写"。
     * 混在一起会让判据误判（实测：`seq` 被算成生成列，而 SQLite 的 `hidden` 只标计算生成列）。
     */
    if (/GENERATED ALWAYS AS \(/i.test(text)) generated.push(name)
    if (/GENERATED ALWAYS AS IDENTITY/i.test(text)) identity.push(name)
  }
  return { columns, generated, identity }
}

/**
 * 替身侧：列名 + 生成列。
 *
 * ⚠️ **必须用 `pragma_table_xinfo`，不能用 `pragma_table_info`**：后者**不返回生成列**
 * （实测：`blog_drafts` 只报出 `id/owner_id/owner_namespace/payload/revision`，把 `title`/`updated_at`
 * 两列**藏起来**）⇒ 拿它当判据会得到一条**假的"列名不一致"**，而更糟的是反向：若哪天替身少了一整个
 * 生成列，用 `table_info` 也看不出来。`xinfo` 的 `hidden`：`2` = VIRTUAL、`3` = STORED。
 */
/** `pragma_table_xinfo` 的行形状（`node:sqlite` 的 `.all()` 返回 `unknown[]`，这里在夹具边界收窄一次）。 */
interface XinfoRow { readonly name: string; readonly hidden: number }

function doubleShape(store: BlogStore, table: string): { columns: string[]; generated: string[] } {
  const xinfo = store.db.prepare('SELECT name, hidden FROM pragma_table_xinfo(?)').all(table) as unknown as readonly XinfoRow[]
  return {
    columns: xinfo.map(row => row.name),
    generated: xinfo.filter(row => row.hidden === 2 || row.hidden === 3).map(row => row.name),
  }
}

const sorted = (list: Iterable<string>): string[] => [...list].sort()

test('★ 替身与生产 DDL 的表形状逐表一致：列名集合 + 生成列集合（防再次漂移）', async t => {
  const sql = await readFile(DDL_URL, 'utf8')
  const store = new BlogStore(':memory:')
  await store.init()
  t.after(() => store.close())

  let generatedTotal = 0
  const generatedTables = new Set()
  for (const table of TABLES) {
    const expected = columnNamesOf(sql, table)
    const actual = doubleShape(store, table)
    assert.deepEqual(sorted(actual.columns), sorted(expected.columns),
      `表 ${table} 的列名与生产 DDL 不一致（替身漂移了）\n  DDL : ${sorted(expected.columns).join(', ')}\n  替身: ${sorted(actual.columns).join(', ')}`)
    assert.deepEqual(sorted(actual.generated), sorted(expected.generated),
      `表 ${table} 的**生成列**与生产 DDL 不一致（生成列是"由载荷派生、不能写"的载体）`)
    generatedTotal += expected.generated.length
    if (expected.generated.length > 0) generatedTables.add(table)
  }
  // DDL 自己的注释写着"6 个生成列分布在 4 张表"：这里是从 DDL **反推**出来的独立复核。
  assert.equal(generatedTotal, 6, '生成列总数应为 6（DDL 注释：6 个生成列分布在 4 张表）')
  assert.equal(generatedTables.size, 4, '生成列应分布在 4 张表')
  // `IDENTITY`（自增）另有 5 处，**不属于**上面那 6 个 —— 混算会让本条判据失真（实测过）。
  const identityColumns = TABLES.flatMap(table => columnNamesOf(sql, table).identity.map(name => `${table}.${name}`))
  assert.deepEqual(sorted(identityColumns), sorted([
    'blog_audit.id', 'blog_jobs.seq', 'blog_operations.seq', 'blog_attachments.seq', 'blog_translations.seq',
  ]), 'IDENTITY 列应该是这 5 个（"由库铸号"与"由载荷派生"不是一回事）')
  // 反例对照：`blog_translations.status` 是**镜像列**、`blog_audit` 两者皆无 —— DDL 明确写了"不要统一"。
  assert.ok(!columnNamesOf(sql, 'blog_translations').generated.includes('status'),
    'blog_translations.status 是镜像列（必须可写），把它当成生成列会撞 NOT NULL')
  assert.deepEqual(columnNamesOf(sql, 'blog_audit').generated, [], 'blog_audit 没有生成列，也不该有')
})

test('★ 生成列"由载荷派生、所以不能写"这条语义在替身上同样是硬的（写就报错）', async t => {
  const store = new BlogStore(':memory:')
  await store.init()
  t.after(() => store.close())
  const owner = { namespace: 'user', id: 'shape' }
  const draft = { id: 'd1', title: 'T', text: 'x', revision: 1, createdAt: 1, updatedAt: 2, contentUpdatedAt: 2 }
  store.db.prepare('INSERT INTO blog_drafts(id,owner_namespace,owner_id,revision,payload) VALUES(?,?,?,?,?)')
    .run('d1', owner.namespace, owner.id, 1, JSON.stringify(draft))
  // 生成列由载荷派生 ⇒ 值确实是载荷里那个（不是另一份副本）。
  // ⚠️ `node:sqlite` 的行是 **null 原型**对象，`deepEqual` 会因原型不同而假红 ⇒ 显式展开。
  const derived = store.db.prepare('SELECT title, updated_at FROM blog_drafts WHERE id=?').get('d1')
  assert.deepEqual({ ...derived }, { title: 'T', updated_at: 2 })
  // ① 写生成列 = 报错（PG 是 428C9，这里是 SQLite 的同类拒绝）。
  assert.throws(() => store.db.prepare('INSERT INTO blog_drafts(id,owner_namespace,owner_id,revision,title,payload) VALUES(?,?,?,?,?,?)')
    .run('d2', owner.namespace, owner.id, 1, 'X', JSON.stringify(draft)), /generated column/i)
  assert.throws(() => store.db.prepare('UPDATE blog_drafts SET updated_at=? WHERE id=?').run(9, 'd1'), /generated column/i)
  // ② 载荷缺键 = 报错（对齐 PG 的 `CHECK (payload ? 'title' AND payload ? 'updatedAt')`）。
  assert.throws(() => store.db.prepare('INSERT INTO blog_drafts(id,owner_namespace,owner_id,revision,payload) VALUES(?,?,?,?,?)')
    .run('d3', owner.namespace, owner.id, 1, JSON.stringify({ title: '只有标题' })), /CHECK constraint/i)
  // ③ 改载荷里那个键 ⇒ 生成列跟着变（"改时间 = 改载荷那个键"，与 PG 同）。
  store.db.prepare('UPDATE blog_drafts SET payload=? WHERE id=?')
    .run(JSON.stringify({ ...draft, updatedAt: 7 }), 'd1')
  const updated = store.db.prepare('SELECT updated_at FROM blog_drafts WHERE id=?').get('d1') as unknown as { updated_at: number }
  assert.equal(updated.updated_at, 7)
})

test('★ `seq` 由存储自己生成、调用方不传（IDENTITY 的可观察语义）', async t => {
  const store = new BlogStore(':memory:')
  await store.init()
  t.after(() => store.close())
  // SQLite 没有第二个自增列（主键已是 `id TEXT`），所以 `seq` 由存储用 MAX+1 生成。
  // 判据是"**不传它**也严格递增" —— 这正是 PG 的 IDENTITY 对调用方的可观察语义。
  await store.jobStart('user:seq', 'router', 'request-0001', { draftId: 'd1' }, {})
  await store.jobStart('user:seq', 'router', 'request-0002', { draftId: 'd1' }, {})
  await store.jobStart('user:seq', 'router', 'request-0003', { draftId: 'd2' }, {})
  const seqs = (store.db.prepare('SELECT seq FROM blog_jobs ORDER BY seq').all() as unknown as readonly { seq: number }[]).map(row => row.seq)
  assert.deepEqual(seqs, [1, 2, 3], 'seq 必须由存储生成且严格递增')
  // 顺序语义因此与 PG 相同：`jobList` 按 `seq DESC`，最新在前。
  assert.deepEqual((await store.jobList('user:seq', 'd1')).map(job => job.requestId),
    ['request-0002', 'request-0001'])
})

test('★ 两处多态 scope 的"恰好一支非空"在替身上同样是硬的（operations / attachments）', async t => {
  const store = new BlogStore(':memory:')
  await store.init()
  t.after(() => store.close())
  const base = { owner_namespace: 'user', owner_id: 'shape', revision: 1, payload: JSON.stringify({ status: 'prepared' }) }
  const insertOperation = (id: string, draftId: string | null, scopeId: string | null) => store.db.prepare(
    'INSERT INTO blog_operations(id,owner_namespace,owner_id,draft_id,scope_id,revision,payload) VALUES(?,?,?,?,?,?,?)')
    .run(id, base.owner_namespace, base.owner_id, draftId, scopeId, base.revision, base.payload)
  insertOperation('op-real', 'd1', '')          // 真实草稿那一支
  insertOperation('op-synth', null, 'manage:x') // 合成 scope 那一支
  assert.throws(() => insertOperation('op-both', 'd1', 'manage:x'), /one_scope/, '两支都非空必须被拒')
  assert.throws(() => insertOperation('op-none', null, ''), /one_scope/, '两支都为空必须被拒')

  const attachment = { status: 'ready' }
  const insertAttachment = (id: string, draftId: string | null, conversationId: string | null) => store.db.prepare(
    'INSERT INTO blog_attachments(id,owner_namespace,owner_id,draft_id,conversation_id,payload) VALUES(?,?,?,?,?,?)')
    .run(id, base.owner_namespace, base.owner_id, draftId, conversationId, JSON.stringify(attachment))
  insertAttachment('at-draft', 'd1', null)
  insertAttachment('at-conversation', null, 'blog-chat-x')
  assert.throws(() => insertAttachment('at-both', 'd1', 'blog-chat-x'), /one_scope/, '两支都非空必须被拒')
  assert.throws(() => insertAttachment('at-none', null, null), /one_scope/, '两支都为空必须被拒')
})
