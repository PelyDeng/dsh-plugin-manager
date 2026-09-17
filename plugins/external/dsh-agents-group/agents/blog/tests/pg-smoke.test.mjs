/**
 * blog 业务存储 PostgreSQL 冒烟契约测试（批 2 B2-2a，真实 PG 契约）。
 *
 * 无 `AGENTS_GROUP_TEST_PG_DSN` 时整文件跳过（CI 无 PG 供给；验收证据需明示跳过）。
 * 测试库专用 agents_group_test，允许在测试内重建 schema（DROP SCHEMA public CASCADE）；
 * 清库前核对 DSN 确实指向 *_test 库，配错立即失败，绝不 DROP 别的库。
 * 覆盖：init 版本校验（99 拒绝/缺表/未就绪即不服务/readyProbe）、drafts save revision
 * 守卫（旧版本与并发恰一）、jobStart 幂等（并发同 requestId 恰一 + 换输入 409）、
 * importSnapshot cid 去重、translations 读写与 running/failed 留档、attachments 读写与
 * 草稿 id/会话 id 双路径 scope、pendingOperations 过滤、启动翻转（jobs/attachments 收
 * failed）、close 后拒绝。
 *
 * ## ⚠️ 建 schema 用的是**新库 DDL**（`private-deploy/db/0001_init.sql`）
 *
 * 这里原来读的是本包内的 `../migrations/postgres/0001_init.sql`（**上一代** DDL：`owner` +
 * `data TEXT` + `blog_schema_version`）。生产库现在由 `private-deploy/db/create.mjs` 按新版
 * 一次建出，业务存储的 SQL 也切到了新形状 ⇒ 测试必须跟着换，否则"测试全绿"证明的是**上一代结构**。
 *
 * ⚠️ 代价如实写在这里：本文件因此**依赖仓库布局**（DDL 在 `private-deploy/` 下，不在本包内），
 * 所以它只在源码检出里可跑，不能作为发布产物的自检。发布链路的契约由 `create.mjs` 自己的验收覆盖。
 * 包内那份旧 DDL **保留但不再被本文件使用**（决策 D-6：旧 DDL 与迁移工具保留一期）。
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, before, after, it } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { BlogError } from '../src/settings.mjs'
import { StorageError } from '../src/storage/errors.mjs'
import { BlogPgStorage, STORAGE_SCHEMA_VERSION } from '../src/storage/pg.mjs'

const DSN = process.env.AGENTS_GROUP_TEST_PG_DSN ?? ''

/** 稳定码断言：错误必须是 StorageError 且携带指定 code。 */
const hasStorageCode = (error, code) => error instanceof StorageError && error.code === code
/** 业务拒绝断言：BlogError（DSH_ACCESS_ERROR）且携带指定 HTTP 状态。 */
const isBlogStatus = (error, status) => error instanceof BlogError && error.status === status

/**
 * 建库 DDL（新形状）的正文。
 *
 * `:applied_at` 是**唯一**占位符，必须替换成毫秒字面量再执行（`create.mjs:71-74` 的
 * `sqlWithAppliedAt` 同款；psql 那条路用 `-v applied_at=…`）。不替换就是语法错误 —— 这一条
 * 是实测出来的，不是从注释里读的。
 */
async function initSql() {
  const url = new URL('../../../../../../private-deploy/db/0001_init.sql', import.meta.url)
  return (await readFile(url, 'utf8')).replaceAll(':applied_at', String(Date.now()))
}

/**
 * 重建 schema：`DROP SCHEMA public CASCADE` → `CREATE SCHEMA public` → 整份 DDL。
 *
 * 整份重放而不是"手抄一张表"：新形状的 blog 表带生成列与 CHECK，手抄一份必然与 DDL 漂移，
 * 而漂移的方向恰好是"测试里的表比生产宽松"——那种绿是最贵的。
 */
async function resetSchema(pool) {
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.query(await initSql())
}

describe('blog PostgreSQL 存储冒烟（agents_group_test）', DSN === '' ? { skip: '未设置 AGENTS_GROUP_TEST_PG_DSN，跳过真实 PG 契约测试' } : {}, () => {
  let admin
  let storage

  before(async () => {
    admin = new Pool({ connectionString: DSN, max: 2 })
    const client = await admin.connect()
    try {
      // 防呆：清库前核对 DSN 确实指向 *_test 专用库。
      const current = await client.query('SELECT current_database() AS name')
      const databaseName = current.rows[0]?.name ?? ''
      assert.ok(databaseName.endsWith('_test'), `DSN 指向的数据库「${databaseName}」不是 *_test 测试库，拒绝 DROP SCHEMA public CASCADE`)
      await resetSchema(admin)
    } finally {
      client.release()
    }
    storage = new BlogPgStorage(DSN)
    await storage.init()
  })

  after(async () => {
    await storage?.close()
    await admin?.end()
  })

  it('init：迁移后版本校验通过、幂等，readyProbe 正常', async () => {
    await storage.init()
    const version = await admin.query("SELECT version FROM dsh_schema_versions WHERE plugin_id = 'blog'")
    assert.equal(Number(version.rows[0]?.version), STORAGE_SCHEMA_VERSION)
    await storage.readyProbe()
  })

  it('版本不符（99）时 init 与读写都以 storage_schema_version 拒绝（未就绪即不服务）', async () => {
    await admin.query("UPDATE dsh_schema_versions SET version = 99 WHERE plugin_id = 'blog'")
    const rejected = new BlogPgStorage(DSN)
    try {
      await assert.rejects(rejected.init(), error => hasStorageCode(error, 'storage_schema_version'))
      await assert.rejects(rejected.get('user:x', 'missing'), error => hasStorageCode(error, 'storage_schema_version'))
      await assert.rejects(rejected.record('user:x', 'import', {}), error => hasStorageCode(error, 'storage_schema_version'))
    } finally {
      await rejected.close()
      await admin.query(`UPDATE dsh_schema_versions SET version = ${STORAGE_SCHEMA_VERSION} WHERE plugin_id = 'blog'`)
    }
  })

  it('缺表时 init 以 storage_schema_missing 拒绝，不自动建表', async () => {
    // CASCADE 是必需的：新形状里 blog_jobs / blog_operations / blog_attachments 的复合外键
    // 指向 blog_drafts，不带 CASCADE 连删都删不掉（旧形状没有外键，所以旧版本这里不需要它）。
    await admin.query('DROP TABLE blog_drafts CASCADE')
    const missing = new BlogPgStorage(DSN)
    try {
      await assert.rejects(missing.init(), error => hasStorageCode(error, 'storage_schema_missing'))
      await assert.rejects(missing.get('user:x', 'missing'), error => hasStorageCode(error, 'storage_schema_missing'))
    } finally {
      await missing.close()
      // 恢复：整份 DDL 重放。`DROP TABLE ... CASCADE` 已经把别的表上那两条外键一起带走了，
      // 所以不能只把 blog_drafts 建回来 —— 那样剩下的表会缺外键，而缺外键是**静默**的。
      await resetSchema(admin)
    }
  })

  it('形状核验：表在但列是上一代的（owner + data）时，init 以 storage_schema_missing 拒绝而不是让每个请求 500', async () => {
    // 这是本批新增的一步。旧形状在"表名齐全"这条判据下完全合格 ⇒ 没有它就会 init 成功、
    // 服务开始接请求，然后每条 SQL 撞 42703 → mapStorageError 归到 storage_unknown → **每个请求 500**。
    await admin.query('ALTER TABLE blog_drafts RENAME COLUMN payload TO data')
    const shaped = new BlogPgStorage(DSN)
    try {
      await assert.rejects(shaped.init(), error => hasStorageCode(error, 'storage_schema_missing'))
      // 未就绪即不服务：拒绝的是同一个稳定码，不是 500。
      await assert.rejects(shaped.get('user:x', 'missing'), error => hasStorageCode(error, 'storage_schema_missing'))
    } finally {
      await shaped.close()
      await admin.query('ALTER TABLE blog_drafts RENAME COLUMN data TO payload')
    }
  })

  it('新形状契约：建草稿 → 读回 → 改 → 读回，且派生列与载荷同步、版本行真的被读到', async () => {
    // 版本行来自 `dsh_schema_versions`：把 `pg.mjs` 的查询改回 `blog_schema_version`（那张表在新库
    // 里不存在）⇒ `before()` 里的 `storage.init()` 直接抛，**整个文件**变红。这就是这一条的变异探针。
    const version = await admin.query("SELECT plugin_id, version FROM dsh_schema_versions WHERE plugin_id = 'blog'")
    assert.equal(version.rows.length, 1)
    assert.equal(Number(version.rows[0].version), STORAGE_SCHEMA_VERSION)

    const owner = 'user:shape'
    const created = await storage.create(owner, { title: '形状', text: '正文', slug: '', tags: [], categories: [] })
    const back = await storage.get(owner, created.id)
    assert.equal(back.title, '形状')
    assert.equal(back.revision, 1)
    /**
     * **派生列真的由载荷派生**（直接读库，不看代码怎么想）：
     * `title` 与 `updated_at` 是 `GENERATED ALWAYS AS (payload->>…) STORED`，列值必须与载荷键一致。
     * 列不存在（上一代 `data` 结构）或载荷缺键（CHECK 会先拦）时这一条都红。
     */
    const row = await admin.query('SELECT title, updated_at, payload FROM blog_drafts WHERE id=$1', [created.id])
    assert.equal(row.rows[0].title, row.rows[0].payload.title)
    assert.equal(Number(row.rows[0].updated_at), Number(row.rows[0].payload.updatedAt))
    /**
     * **"改时间"在新形状里等于改载荷那一个键**：`save` 推进 `payload.updatedAt`，
     * 派生列 `updated_at` 跟着走 —— 而那条 UPDATE **不能**自己写 `updated_at`（生成列，428C9）。
     * 断言比到 `saved.updatedAt` 上，等于同时钉住"载荷里的时刻"与"库里的派生列"是同一个值。
     */
    const saved = await storage.save(owner, created.id, 1, { title: '形状二' })
    assert.equal(saved.revision, 2)
    const after = await admin.query('SELECT title, updated_at, payload FROM blog_drafts WHERE id=$1', [created.id])
    assert.equal(after.rows[0].title, '形状二')
    assert.equal(Number(after.rows[0].updated_at), saved.updatedAt)
    assert.equal((await storage.get(owner, created.id)).title, '形状二')
    // 归属两列真的被写进去（不是靠合成串比出来的）：同一 id 换个 owner 读不到。
    await assert.rejects(storage.get('user:shape2', created.id), error => isBlogStatus(error, 404))
    /**
     * ⚠️ **同名不同域**：同一个 `userId`、两个 `namespace` ⇒ 必须是两条互不可见的数据。
     *
     * 这一条是"归属是**两列**、不是拼出来的一个串"的**唯一**判据：只比 `owner_id`（或把两列拼成
     * 一个字符串再比）在"两个 owner 连 userId 都不同"的用例下**照样全绿** —— 上面那些
     * `user:other` 就是这种用例，它们区分不出"比较了两列"和"只比了 userId"。
     * 真出错的后果是把两个命名空间的同名用户当成同一个人：跨域读到别人的草稿。
     */
    const twin = await storage.create('admin:shape', { title: '同名不同域', text: '', slug: '', tags: [], categories: [] })
    assert.equal(twin.id === created.id, false)
    assert.equal((await storage.list('user:shape')).some(draft => draft.id === twin.id), false, 'user 域不该看到 admin 域的同名稿')
    assert.equal((await storage.list('admin:shape')).some(draft => draft.id === created.id), false, 'admin 域不该看到 user 域的同名稿')
    await assert.rejects(storage.get('user:shape', twin.id), error => isBlogStatus(error, 404))
    await assert.rejects(storage.get('admin:shape', created.id), error => isBlogStatus(error, 404))
  })

  it('drafts save 的 revision 守卫：旧版本拒改，并发恰有一路成功', async () => {
    const owner = 'user:rev'
    const created = await storage.create(owner, { title: '初稿', text: '正文', slug: '', tags: [], categories: [] })
    assert.equal(created.revision, 1)
    const saved = await storage.save(owner, created.id, 1, { title: '第一版' })
    assert.equal(saved.revision, 2)
    assert.equal(saved.title, '第一版')
    // 旧版本顺序拒改：读到的新修订与提交的 revision 不一致 → 409。
    await assert.rejects(storage.save(owner, created.id, 1, { title: '过期修改' }), error => isBlogStatus(error, 409))
    // 并发：两路同时以 revision 2 保存，恰有一路命中条件 UPDATE，另一路 0 行按 409 拒绝。
    const settled = await Promise.allSettled([
      storage.save(owner, created.id, 2, { title: '并发甲' }),
      storage.save(owner, created.id, 2, { title: '并发乙' }),
    ])
    const fulfilled = settled.filter(outcome => outcome.status === 'fulfilled')
    const rejected = settled.filter(outcome => outcome.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(fulfilled[0].value.revision, 3)
    assert.ok(isBlogStatus(rejected[0].reason, 409))
    // 他人/不存在：同一 404 口径，不泄露存在性。
    await assert.rejects(storage.get('user:other', created.id), error => isBlogStatus(error, 404))
    await assert.rejects(storage.get(owner, 'missing'), error => isBlogStatus(error, 404))
  })

  it('jobStart 幂等：并发同 requestId 恰一 fresh，换输入 409；jobGet/jobList 去掉 actor/owner', async () => {
    const owner = 'user:job'
    /**
     * ⚠️ `draftId` 必须是**真实存在的草稿**（夹具更新，不是放宽断言）。
     *
     * 新形状里 `blog_jobs.draft_id` 是**生成列**（`payload->'input'->>'draftId'`）且带复合外键
     * 指向 `blog_drafts`；载荷里那个 `input.draftId` 指向不存在的草稿会直接 **23503**。
     * 旧夹具顺手写的 `'draft-for-job-tests'` 在上一代 DDL 上没有外键所以能过 —— 而 DDL 的注释
     * 明确写了"没有'无草稿的 job'这条路径"（`jobs.mjs` 先 `storage.get` 草稿、取不到就 404）。
     * 本用例断的幂等 / fresh / 409 / 404 一条没变，变的只是"这条 job 指向哪个草稿"。
     */
    const draft = await storage.create(owner, { title: '任务用稿', text: '', slug: '', tags: [], categories: [] })
    const draftId = draft.id
    const actor = { namespace: 'user', userId: 'job' }
    const input = { draftId, expectedRevision: 1, instruction: '写一篇短文', research: false, attachments: [] }
    const [a, b] = await Promise.all([
      storage.jobStart(owner, 'web', 'jobconcurrent0001', input, actor),
      storage.jobStart(owner, 'web', 'jobconcurrent0001', input, actor),
    ])
    assert.equal([a, b].filter(result => result.fresh).length, 1)
    assert.equal([a, b].filter(result => !result.fresh).length, 1)
    assert.equal(a.job.id, b.job.id)
    assert.equal(a.job.status, 'queued')
    const updated = await storage.jobUpdate(a.job.id, { status: 'running' })
    assert.equal(updated.status, 'running')
    assert.equal((await storage.jobGet(owner, a.job.id)).status, 'running')
    const listed = await storage.jobList(owner, draftId)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, a.job.id)
    assert.ok(!('actor' in listed[0]) && !('owner' in listed[0]))
    // 同一 requestId 换输入：409 拒绝（inputHash 守卫）。
    await assert.rejects(storage.jobStart(owner, 'web', 'jobconcurrent0001', { ...input, instruction: '换一个问题' }, actor), error => isBlogStatus(error, 409))
    // 归属过滤：他人读不到。
    await assert.rejects(storage.jobGet('user:other', a.job.id), error => isBlogStatus(error, 404))
  })

  it('importSnapshot cid 去重：findByRemoteCid 命中已导入原生稿，删除/非原生不算；audit 留痕', async () => {
    const owner = 'user:imp'
    const existing = await storage.create(owner, { title: '导入稿', text: '正文', slug: '', tags: [], categories: [] },
      { version: 3, published: { cid: 4242 }, savedDraft: null, selectedVariant: 'published' }, true)
    const found = await storage.findByRemoteCid(owner, 4242)
    assert.equal(found.length, 1)
    assert.equal(found[0].id, existing.id)
    // 应用层语义（application.mjs:139-145）：命中即返回既有稿，不再创建第二份。
    // 未关联的 cid 找不到 → 走新建分支。
    assert.equal((await storage.findByRemoteCid(owner, 9999)).length, 0)
    // 已删除的副本不算可去重目标。
    await storage.create(owner, { title: '已删除副本', text: '', slug: '', tags: [], categories: [] },
      { version: 1, published: { cid: 4243 }, savedDraft: null, deleted: true }, true)
    assert.equal((await storage.findByRemoteCid(owner, 4243)).length, 0)
    // 非原生（本地）草稿不算。
    await storage.create(owner, { title: '本地稿', text: '', slug: '', tags: [], categories: [] },
      { version: 1, published: { cid: 4244 }, savedDraft: null }, false)
    assert.equal((await storage.findByRemoteCid(owner, 4244)).length, 0)
    // 审计 append-only：导入动作留痕，只增不改。
    await storage.record(owner, 'import', { draftId: existing.id, cid: 4242, variant: 'published' })
    const auditRows = await admin.query('SELECT count(*)::int AS n FROM blog_audit WHERE owner_namespace=$1 AND owner_id=$2 AND action=$3', ['user', 'imp', 'import'])
    assert.equal(auditRows.rows[0].n, 1)
  })

  it('translations：translated 命中且取最新，running/failed 留档不命中；同 id 重写生效', async () => {
    const key = randomUUID()
    const owner = 'user:trans'
    await storage.translationWrite(randomUUID(), key, owner, 'running', { requestId: 'r1' })
    assert.equal(await storage.translationLatest(key), undefined)
    await storage.translationWrite(randomUUID(), key, owner, 'failed', { requestId: 'r2', error: '译文请求失败' })
    assert.equal(await storage.translationLatest(key), undefined)
    const first = randomUUID()
    await storage.translationWrite(first, key, owner, 'translated', { requestId: 'r3', result: { text: '第一份译文' } })
    assert.equal((await storage.translationLatest(key)).result.text, '第一份译文')
    // 同 id 重写（原 INSERT OR REPLACE 语义 → ON CONFLICT (id) DO UPDATE）。
    await storage.translationWrite(first, key, owner, 'translated', { requestId: 'r3', result: { text: '重写后的第一份' } })
    assert.equal((await storage.translationLatest(key)).result.text, '重写后的第一份')
    // 更晚插入的 translated 优先。
    await storage.translationWrite(randomUUID(), key, owner, 'translated', { requestId: 'r4', result: { text: '第二份译文' } })
    assert.equal((await storage.translationLatest(key)).result.text, '第二份译文')
    // running/failed 留档仍在（缓存+审计双重身份，无 TTL 清除）。
    const kept = await admin.query('SELECT status, count(*)::int AS n FROM blog_translations WHERE cache_key=$1 GROUP BY status', [key])
    const byStatus = Object.fromEntries(kept.rows.map(row => [row.status, row.n]))
    assert.equal(byStatus.running, 1)
    assert.equal(byStatus.failed, 1)
    assert.equal(byStatus.translated, 2)
    // 其他 key 互不干扰。
    assert.equal(await storage.translationLatest(randomUUID()), undefined)
  })

  it('attachments：读写与 removed 过滤；draftId 支持草稿 id 与会话 id 双路径 scope', async () => {
    const owner = 'user:att'
    const draft = await storage.create(owner)
    const a1 = { id: randomUUID(), owner, draftId: draft.id, name: '资料.txt', kind: 'text', version: 1, status: 'uploading', selected: true, range: null, createdAt: Date.now() }
    await storage.attachmentInsert(a1)
    a1.status = 'ready'; a1.bytes = 12
    await storage.attachmentWrite(a1)
    const got = await storage.attachmentGet(owner, draft.id, a1.id)
    assert.equal(got.status, 'ready')
    assert.equal(got.bytes, 12)
    // removed：get 按已移除 404，list 过滤掉。
    const a2 = { ...a1, id: randomUUID(), status: 'removed', selected: false }
    await storage.attachmentInsert(a2)
    await assert.rejects(storage.attachmentGet(owner, draft.id, a2.id), error => isBlogStatus(error, 404))
    const listed = await storage.attachmentList(owner, draft.id)
    assert.deepEqual(listed.map(item => item.id), [a1.id])
    // 会话 id 路径（blog-chat-*）：同一查询面，按 owner+draftId 隔离。
    const conversationId = `blog-chat-${randomUUID()}`
    /**
     * ⚠️ **新形状的前置条件**：会话附件落 `conversation_id`，而那一列带复合外键指向
     * `dsh_conversations(id, owner_namespace, owner_id)` ⇒ **会话行必须先在同一个库里**。
     * 上一代 DDL 没有这条外键，所以旧用例可以直接插一条指向不存在会话的附件。
     * 生产路径不受影响：`attachments.upload` 先走 `assertScope`，会话路径由
     * `ChatStore.assertScope` 核验归属（查不到就 404），根本走不到这条 INSERT。
     */
    await admin.query(
      `INSERT INTO dsh_conversations(id, agent_id, owner_namespace, owner_id, ready, created_at, updated_at)
       VALUES($1,'blog','user','att',TRUE,$2,$2)`,
      [conversationId, Date.now()],
    )
    const a3 = { id: randomUUID(), owner, draftId: conversationId, name: '笔记.md', kind: 'markdown', version: 1, status: 'ready', selected: false, range: null, createdAt: Date.now() }
    await storage.attachmentInsert(a3)
    assert.equal((await storage.attachmentGet(owner, conversationId, a3.id)).id, a3.id)
    assert.deepEqual((await storage.attachmentList(owner, conversationId)).map(item => item.id), [a3.id])
    assert.equal((await storage.attachmentList(owner, draft.id)).length, 1)
    /**
     * 直接核**两列各装了什么**（不是只断言"能读回来"）：谓词写对了但两支都塞进 `draft_id`
     * 这种错法，在"能读回来"这条断言下是**看不出来**的 —— 会话附件那一支会被复合外键拦成
     * 23503（响的），但草稿附件误塞 `conversation_id` 就完全静默了。这里把两支的落点钉死。
     */
    const scopes = await admin.query('SELECT id, draft_id, conversation_id FROM blog_attachments WHERE id = ANY($1::text[])', [[a1.id, a3.id]])
    const byId = Object.fromEntries(scopes.rows.map(row => [row.id, row]))
    assert.equal(byId[a1.id].draft_id, draft.id)
    assert.equal(byId[a1.id].conversation_id, null)
    assert.equal(byId[a3.id].draft_id, null)
    assert.equal(byId[a3.id].conversation_id, conversationId)
    // 归属过滤：他人查不到。
    await assert.rejects(storage.attachmentGet('user:other', draft.id, a1.id), error => isBlogStatus(error, 404))
  })

  it('pendingOperations：running/uncertain/未过期 prepared 计入，过期或已完成不计入', async () => {
    const owner = 'user:pend'
    const draft = await storage.create(owner)
    const op = (status, conversationId, expiresAt) => ({ id: randomUUID(), owner, draftId: draft.id, revision: draft.revision, mode: 'draft', status, ...(conversationId ? { chat: { conversationId } } : {}), ...(expiresAt === undefined ? {} : { expiresAt }) })
    await storage.operationInsert(op('running', 'blog-chat-p1'))
    await storage.operationInsert(op('uncertain', 'blog-chat-p2'))
    await storage.operationInsert(op('prepared', 'blog-chat-p3', Date.now() + 60000))
    await storage.operationInsert(op('prepared', 'blog-chat-p4', Date.now() - 1000))
    await storage.operationInsert(op('succeeded', 'blog-chat-p5'))
    await storage.operationInsert(op('prepared', null, Date.now() + 60000))
    const pending = await storage.pendingOperations()
    for (const id of ['blog-chat-p1', 'blog-chat-p2', 'blog-chat-p3']) assert.ok(pending.includes(id), `${id} 应在待核对集合`)
    for (const id of ['blog-chat-p4', 'blog-chat-p5']) assert.ok(!pending.includes(id), `${id} 不应在待核对集合`)
    // 同一会话多条只计一次。
    await storage.operationInsert(op('running', 'blog-chat-p1'))
    const recomputed = await storage.pendingOperations()
    assert.equal(recomputed.filter(id => id === 'blog-chat-p1').length, 1)
    // operations 全量与按草稿查询：最新在前（seq DESC）。
    const all = await storage.operations(owner)
    assert.equal(all.length, 7)
    const recent = await storage.operationsForDraft(owner, draft.id, 20)
    assert.equal(recent.length, 7)
    assert.equal(recent[0].record.chat.conversationId, 'blog-chat-p1') // 最后插入的重复 p1 在最前
    /**
     * ⚠️ **合成 scope**（`manage:<kind>:<id|new>` / `remote:<rootCid>`）落 `scope_id`，不落 `draft_id`。
     *
     * 这一条是"读取侧两列 OR"的**唯一**判据：只比 `draft_id` 时，管理 / 远端那批操作会
     * **静默查不出来** —— 页面显示"没有待核对的操作"、没有任何报错，而那条记录还在库里。
     * 所以这里两头都钉：写入落到哪一列（直接查库）、读能不能找回来。
     */
    const syntheticScope = 'manage:blog:new'
    await storage.operationInsert({ id: randomUUID(), owner, draftId: syntheticScope, revision: 1, mode: 'manage', status: 'prepared', nonce: randomUUID(), expiresAt: Date.now() + 60000 })
    const syntheticRow = await admin.query('SELECT draft_id, scope_id FROM blog_operations WHERE owner_namespace=$1 AND owner_id=$2 AND scope_id=$3', ['user', 'pend', syntheticScope])
    assert.equal(syntheticRow.rows.length, 1, '合成 scope 必须落在 scope_id 这一列')
    assert.equal(syntheticRow.rows[0].draft_id, null)
    assert.equal(syntheticRow.rows[0].scope_id, syntheticScope)
    assert.equal((await storage.operationsForDraft(owner, syntheticScope, 20)).length, 1, '按合成 scope 查必须查得到')
    // 真实草稿那一支不受影响：上面 7 条仍全部按 draft_id 查得到。
    assert.equal((await storage.operationsForDraft(owner, draft.id, 20)).length, 7)
    // operationSave 覆盖写。
    const readBack = await storage.operation(owner, recent[6].id)
    readBack.status = 'succeeded'
    await storage.operationSave(recent[6].id, readBack)
    assert.equal((await storage.operation(owner, recent[6].id)).status, 'succeeded')
    await assert.rejects(storage.operation('user:other', recent[6].id), error => isBlogStatus(error, 404))
  })

  it('启动翻转：jobs 置 running、attachments 置 uploading 后，init 收成 failed', async () => {
    const owner = 'user:flip'
    const draft = await storage.create(owner)
    const actor = { namespace: 'user', userId: 'flip' }
    const { job } = await storage.jobStart(owner, 'flipcaller', 'fliprequest0001', { draftId: draft.id, expectedRevision: 1, instruction: '写', research: false, attachments: [] }, actor)
    await storage.jobUpdate(job.id, { status: 'running' })
    const attachment = { id: randomUUID(), owner, draftId: draft.id, name: '解析中.txt', kind: 'text', version: 1, status: 'parsing', selected: true, range: null, createdAt: Date.now() }
    await storage.attachmentInsert(attachment)
    const reborn = new BlogPgStorage(DSN)
    try {
      await reborn.init()
      const failedJob = await reborn.jobGet(owner, job.id)
      assert.equal(failedJob.status, 'failed')
      assert.deepEqual(failedJob.error, { code: 'interrupted', message: '服务已重启；保留结果，可发起新的写作任务' })
      const failedAttachment = await reborn.attachmentGet(owner, draft.id, attachment.id)
      assert.equal(failedAttachment.status, 'failed')
      assert.equal(failedAttachment.message, '服务重启，解析已中断，请移除后重新上传')
    } finally {
      await reborn.close()
    }
  })

  it('close 之后拒绝继续读写（稳定码 storage_closed），重复 close 安全', async () => {
    const disposable = new BlogPgStorage(DSN)
    await disposable.init()
    await disposable.close()
    await assert.rejects(disposable.get('user:x', 'missing'), error => hasStorageCode(error, 'storage_closed'))
    await assert.rejects(disposable.jobStart('user:x', 'web', 'closedrequest01', { draftId: 'd', expectedRevision: 1, instruction: 'x', research: false, attachments: [] }, {}), error => hasStorageCode(error, 'storage_closed'))
    await disposable.close()
  })

  /**
   * **两处多态 scope 的"恰一非空"在真 PG 上是硬的**（S1 登记的那条"零覆盖"）。
   *
   * 为什么必须有这条：`blog_operations.draft_id` 带**指向 `blog_drafts` 的复合外键**，而合成 scope
   * （`manage:<kind>:<id|new>` / `remote:<rootCid>`，来自 `application.mjs`）**不是真实草稿 id**
   * ⇒ 它们只能落 `scope_id`。把两义值装进一列时，复合外键会把"合法地指向远端文章"的操作判成
   * **23503**（DDL 注释写明本机 PG18 实测过：`draft_id='manage:blog:new'` → 23503、
   * `draft_id='remote:12345'` → 23503）。
   * ⚠️ 而"**合法的那一支能插进去**"从来没被断言过 —— 只断"非法被拒"的话，一个**永远抛错**的实现
   * 也照样绿 ⇒ 本条**成对断言**（同一条链上既要有成功的、也要有被拒的）。
   */
  it('多态 scope：合成 scope 必须落 scope_id（落 draft_id 则 23503），"恰一非空"两个方向都拦', async () => {
    const owner = 'user:scope'
    const draft = await storage.create(owner, { title: '有主草稿', text: '', slug: '', tags: [], categories: [] })
    const [namespace, id] = owner.split(':')
    const insert = (rowId, draftId, scopeId) => admin.query(
      `INSERT INTO blog_operations(id, owner_namespace, owner_id, draft_id, scope_id, revision, payload)
       VALUES($1,$2,$3,$4,$5,1,'{"status":"prepared"}'::jsonb)`,
      [rowId, namespace, id, draftId, scopeId ?? ''])
    // ① 合成 scope 落 `scope_id` ⇒ 合法（`manage:` / `remote:` 那一支的归宿）。
    await insert(randomUUID(), null, 'manage:blog:new')
    await insert(randomUUID(), null, 'remote:12345')
    // ② 同一个合成值落 `draft_id` ⇒ 复合外键拒绝（23503）—— "两义值装不进一列"的实证。
    await assert.rejects(insert(randomUUID(), 'manage:blog:new', null),
      error => error.code === '23503', '合成 scope 落 draft_id 必须被复合外键拒')
    // ③ 真实草稿那一支 ⇒ 合法。
    await insert(randomUUID(), draft.id, null)
    // ④ "恰一非空"两个方向由 **CHECK** 拦（23514）—— 与 ② 的 23503 是**两个不同的约束**，分开断言。
    await assert.rejects(insert(randomUUID(), draft.id, 'manage:blog:new'),
      error => error.code === '23514', '两支都非空必须被 CHECK 拒')
    await assert.rejects(insert(randomUUID(), null, null),
      error => error.code === '23514', '两支都为空必须被 CHECK 拒')
  })
})
