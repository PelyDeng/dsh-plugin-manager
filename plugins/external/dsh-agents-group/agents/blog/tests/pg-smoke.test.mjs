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
      await client.query('DROP SCHEMA public CASCADE')
      await client.query('CREATE SCHEMA public')
      const sql = await readFile(new URL('../migrations/postgres/0001_init.sql', import.meta.url), 'utf8')
      await client.query(sql)
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
    const version = await admin.query('SELECT version FROM blog_schema_version')
    assert.equal(Number(version.rows[0]?.version), STORAGE_SCHEMA_VERSION)
    await storage.readyProbe()
  })

  it('版本不符（99）时 init 与读写都以 storage_schema_version 拒绝（未就绪即不服务）', async () => {
    await admin.query('UPDATE blog_schema_version SET version = 99')
    const rejected = new BlogPgStorage(DSN)
    try {
      await assert.rejects(rejected.init(), error => hasStorageCode(error, 'storage_schema_version'))
      await assert.rejects(rejected.get('user:x', 'missing'), error => hasStorageCode(error, 'storage_schema_version'))
      await assert.rejects(rejected.record('user:x', 'import', {}), error => hasStorageCode(error, 'storage_schema_version'))
    } finally {
      await rejected.close()
      await admin.query(`UPDATE blog_schema_version SET version = ${STORAGE_SCHEMA_VERSION}`)
    }
  })

  it('缺表时 init 以 storage_schema_missing 拒绝，不自动建表', async () => {
    await admin.query('DROP TABLE blog_drafts')
    const missing = new BlogPgStorage(DSN)
    try {
      await assert.rejects(missing.init(), error => hasStorageCode(error, 'storage_schema_missing'))
      await assert.rejects(missing.get('user:x', 'missing'), error => hasStorageCode(error, 'storage_schema_missing'))
    } finally {
      await missing.close()
      await admin.query(`CREATE TABLE blog_drafts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, updated BIGINT NOT NULL, data TEXT NOT NULL)`)
    }
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
    const draftId = 'draft-for-job-tests'
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
    const auditRows = await admin.query('SELECT count(*)::int AS n FROM blog_audit WHERE owner=$1 AND action=$2', [owner, 'import'])
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
    const a3 = { id: randomUUID(), owner, draftId: conversationId, name: '笔记.md', kind: 'markdown', version: 1, status: 'ready', selected: false, range: null, createdAt: Date.now() }
    await storage.attachmentInsert(a3)
    assert.equal((await storage.attachmentGet(owner, conversationId, a3.id)).id, a3.id)
    assert.deepEqual((await storage.attachmentList(owner, conversationId)).map(item => item.id), [a3.id])
    assert.equal((await storage.attachmentList(owner, draft.id)).length, 1)
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
})
