/**
 * blog 业务存量迁移工具（scripts/migrate-blog-storage.ts）的行为验收（批 2 B2-2c）。
 *
 * 绑定规格：批 2 群组业务迁 PG 实施方案 §4 B2-2c —— 源 `blog.sqlite` 业务 5 表
 * （drafts/jobs/operations/audit/attachments）+ 译文单表一次性导入 PG 的 `blog_` 前缀表，
 * 导入、校验与 **BIGSERIAL setval 复位** 同事务；停写点复核在 COMMIT 前，不一致整体回滚；
 * `--clear-source` 备份先行（VACUUM INTO）再就地 DROP 业务 5 表，索引 3 表与协作映射表
 * 留库当索引库。
 *
 * 夹具按现状真实形状构造（DDL 取自 store.ts / chat-store.ts / participant.ts 的建表语句），
 * 含跨 owner、jobs 的 queued/running、attachments 的 uploading、非 ASCII 与 SQL 特殊字符、
 * 译文三态（running/failed/translated）。setval 用例不用「导入值 + 1」推断，而是导入后直接
 * 经 PG 插一条不带 seq 的记录，验证不撞 UNIQUE。
 *
 * 无 `AGENTS_GROUP_MIGRATE_PG_DSN` 时整文件跳过（CI 无 PG 供给；验收证据需明示跳过）。
 * 目标库专用 agents_group_mig，测试内允许 DROP SCHEMA 重建（含库名防呆断言）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Pool } from 'pg'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BlogPgStorage } from '../agents/blog/src/storage/pg.ts'
import { main, runMigration } from '../scripts/migrate-blog-storage.ts'

const DSN = process.env.AGENTS_GROUP_MIGRATE_PG_DSN ?? ''
const silent = (): void => {}
/** 迁移要走真实网络与整库导入，放宽单用例时限。 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })

const ALICE = 'user:alice'
const BOB = 'user:bob'
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 业务 5 表：与 store.ts / attachments.ts 拆库前的建表语句逐字一致。 */
const BUSINESS_DDL = `CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, caller TEXT NOT NULL, requestId TEXT NOT NULL, inputHash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,caller,requestId));
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, draftId TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, owner TEXT NOT NULL, draftId TEXT NOT NULL, data TEXT NOT NULL);`

/** 索引 3 表 + 协作映射表：与 chat-store.ts / participant.ts 的建表语句逐字一致（迁后留库）。 */
const INDEX_DDL = `CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,requestId TEXT NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner,requestId));
  CREATE INDEX IF NOT EXISTS chat_owner ON conversations(owner,updated DESC);
  CREATE TABLE IF NOT EXISTS chat_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,inputHash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner,requestId));
  CREATE TABLE IF NOT EXISTS chat_results(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,operationId TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pirate_blog_conversations(owner TEXT NOT NULL, missionId TEXT NOT NULL, conversationId TEXT NOT NULL, PRIMARY KEY(owner,missionId), UNIQUE(owner,conversationId));`

const INDEX_TABLES: readonly string[] = ['conversations', 'chat_requests', 'chat_results', 'pirate_blog_conversations']
const BLOG_CHAT = 'blog-chat-6f1c2d4e-9a3b-4c5d-8e7f-000000000001'

// ---------- 夹具数据（断言的唯一来源；全部是生产里会出现的形状） ----------

const draftAlice = {
  id: 'draft-0001-alice', owner: ALICE, revision: 3, updated: 1_767_000_000_123,
  data: {
    id: 'draft-0001-alice', title: '北门灯 · 巡检报告', slug: 'beimen-deng', format: 'markdown',
    text: "北门：三盏灯不亮\n第二行含特殊字符 ' \" ; -- /* */ ${} 100%\n第四行 中文与 emoji 🚧🧰 结束",
    tags: ['巡检', '北门'], categories: [7], allowComment: false,
    remote: { published: { cid: 'cid-pub-1' }, savedDraft: { cid: 'cid-draft-1' }, deleted: false, deletedAt: null },
    blogNative: true, proposal: null, sources: [{ title: '巡检表', path: '/blog/draft/draft-0002-bob' }],
    revision: 3, createdAt: 1_766_000_000_000, updatedAt: 1_767_000_000_123,
    contentUpdatedAt: 1_767_000_000_123, contentTimeSource: 'content',
  },
}
const draftBob = {
  id: 'draft-0002-bob', owner: BOB, revision: 1, updated: 1_767_000_100_000,
  data: {
    id: 'draft-0002-bob', title: '', slug: '', format: 'html', text: '<p>空草稿</p>', tags: [], categories: [],
    allowComment: true, remote: null, blogNative: false, proposal: null, sources: [],
    revision: 1, createdAt: 1_767_000_100_000, updatedAt: 1_767_000_100_000,
    contentUpdatedAt: 1_767_000_100_000, contentTimeSource: 'content',
  },
}

const jobInputs = {
  queued: { draftId: draftAlice.id, text: '把北门的巡检记录整理成一篇文章' },
  running: { draftId: draftBob.id, text: '继续上一轮未说完的部分' },
  done: { draftId: draftAlice.id, text: '写一条发布说明' },
}
const jobRecords = {
  queued: {
    id: 'job-0001-queued', owner: ALICE, caller: 'butler', requestId: 'req-00000001',
    input: jobInputs.queued, actor: { namespace: 'user', userId: 'alice', sessionId: 'sess-alice' },
    status: 'queued', text: '', sources: [], createdAt: 1_767_000_200_000, updatedAt: 1_767_000_200_000,
  },
  running: {
    id: 'job-0002-running', owner: ALICE, caller: 'butler', requestId: 'req-00000002',
    input: jobInputs.running, actor: { namespace: 'user', userId: 'alice', sessionId: 'sess-alice' },
    status: 'running', text: '已写出开头', sources: [], createdAt: 1_767_000_210_000, updatedAt: 1_767_000_220_000,
  },
  done: {
    id: 'job-0003-succeeded', owner: BOB, caller: 'blog-ui', requestId: 'req-00000003',
    input: jobInputs.done, actor: { namespace: 'user', userId: 'bob', sessionId: 'sess-bob' },
    status: 'succeeded', text: '发布说明如下…', sources: [], createdAt: 1_767_000_230_000, updatedAt: 1_767_000_240_000,
  },
}

const operationRecords = {
  live: {
    id: 'op-0001', owner: ALICE, draftId: draftAlice.id, revision: 3,
    data: { id: 'op-0001', owner: ALICE, draftId: draftAlice.id, revision: 3, mode: 'publish', status: 'uncertain', nonce: 'n-1', createdAt: 1_767_000_300_000 },
  },
  manage: {
    id: 'op-0002', owner: BOB, draftId: 'manage:article:new', revision: 0,
    data: { id: 'op-0002', owner: BOB, draftId: 'manage:article:new', revision: 0, mode: 'manage', status: 'prepared', expiresAt: 1_767_000_900_000, createdAt: 1_767_000_310_000 },
  },
}

/** audit 按插入序写 id=5、再 id=2：rowid 序与 id 升序不同，能钉住「audit 用源 rowid 为 id」。 */
const auditRows = [
  { id: 5, at: 1_767_000_400_000, owner: ALICE, action: 'attachment-upload', data: { draftId: draftAlice.id, name: '巡检表.csv', bytes: 42 } },
  { id: 2, at: 1_767_000_400_100, owner: BOB, action: 'import', data: { draftId: draftBob.id, cid: 'cid-draft-1', variant: 'native' } },
]

const attachmentRecords = {
  uploading: {
    id: 'att-0001-uploading', owner: ALICE, draftId: draftAlice.id,
    data: { id: 'att-0001-uploading', owner: ALICE, draftId: draftAlice.id, name: '巡检表.csv', kind: 'csv', version: 1, status: 'uploading', selected: true, range: null, createdAt: 1_767_000_500_000 },
  },
  attached: {
    id: 'att-0002-ready', owner: ALICE, draftId: BLOG_CHAT,
    data: { id: 'att-0002-ready', owner: ALICE, draftId: BLOG_CHAT, name: '口述记录.txt', kind: 'text', version: 2, status: 'ready', selected: false, bytes: 128, createdAt: 1_767_000_510_000 },
  },
}

const translationRecords = {
  running: {
    id: 'req-trans-0001', cacheKey: 'a'.repeat(64), owner: ALICE, status: 'running',
    data: { requestId: 'req-trans-0001', conversationId: BLOG_CHAT, sourceId: 'msg-1', sourceHash: 'b'.repeat(64), targetLanguage: 'zh-CN', version: 'zh-v1', startedAt: 1_767_000_600_000, usage: null },
  },
  failed: {
    id: 'req-trans-0002', cacheKey: 'c'.repeat(64), owner: ALICE, status: 'failed',
    data: { requestId: 'req-trans-0002', conversationId: BLOG_CHAT, sourceId: 'msg-2', sourceHash: 'd'.repeat(64), targetLanguage: 'zh-CN', version: 'zh-v1', startedAt: 1_767_000_610_000, endedAt: 1_767_000_620_000, error: '译文请求失败' },
  },
  translated: {
    id: 'req-trans-0003', cacheKey: 'e'.repeat(64), owner: BOB, status: 'translated',
    data: {
      requestId: 'req-trans-0003', conversationId: BLOG_CHAT, sourceId: 'msg-1', sourceHash: 'b'.repeat(64),
      targetLanguage: 'zh-CN', version: 'zh-v1', startedAt: 1_767_000_630_000, endedAt: 1_767_000_640_000,
      textNormalized: true, result: { status: 'translated', text: '这是译文正文，含中文标点。', partial: false, sourceHash: 'b'.repeat(64), provider: 'zhipu', model: 'glm-5.3' },
    },
  },
}

// ---------- 夹具与工具 ----------

/** 用完就删的临时目录（含两个 sqlite 库与快照）。 */
const created: string[] = []
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agents-group-migrate-${label}-`))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) {
    // Windows 上文件可能仍被占着；临时目录会自己清，不必因此失败。
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 留给系统清理 */ }
  }
})

function insert(db: DatabaseSync, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row)
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => (row[column] ?? null) as SQLInputValue))
}

function businessRowCount(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as unknown as { total?: number }
    return Number(row?.total ?? -1)
  } finally { db.close() }
}

/** 源库业务表的 rowid 序（seq 的唯一来源），返回 [id, rowid] 对。 */
function rowidOrder(path: string, table: string): [string, number][] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare(`SELECT rowid AS rowid, id AS id FROM ${table} ORDER BY rowid`).all() as unknown as { rowid: number | bigint; id: unknown }[]
    return rows.map(row => [String(row.id), Number(row.rowid)])
  } finally { db.close() }
}

/** 索引库全量内容的规范化快照：清源前后必须逐字节一致。 */
function indexSnapshot(path: string): Record<string, string[]> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const dump: Record<string, string[]> = {}
    for (const table of INDEX_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[]
      dump[table] = rows.map(row => JSON.stringify(row)).sort()
    }
    return dump
  } finally { db.close() }
}

function tableNames(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as unknown as { name: unknown }[]
    return rows.map(row => String(row.name)).sort()
  } finally { db.close() }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

interface Fixture {
  readonly dir: string
  readonly blogPath: string
  readonly translationsPath: string
}

/**
 * 建出与生产同形的源库：业务 5 表 + 索引 3 表 + 协作映射表（WAL，与现状一致），
 * 另建译文库（translations 单表，三态齐全）。
 * `business: 'empty'` 只建业务表结构不写行；`'partial'` 只建 drafts/audit。
 */
function fixture(label: string, business: 'full' | 'empty' | 'partial' = 'full', userVersion = 1): Fixture {
  const dir = tempDir(label)
  const blogPath = join(dir, 'blog.sqlite')
  const translationsPath = join(dir, 'reasoning-translations.sqlite')

  const blog = new DatabaseSync(blogPath)
  blog.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  if (business === 'partial') {
    blog.exec(`CREATE TABLE drafts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);`)
  } else {
    blog.exec(BUSINESS_DDL)
  }
  blog.exec(INDEX_DDL)
  blog.exec(`PRAGMA user_version=${userVersion}`)
  if (business === 'full') {
    for (const draft of [draftAlice, draftBob]) insert(blog, 'drafts', { ...draft, data: JSON.stringify(draft.data) })
    insert(blog, 'jobs', { id: jobRecords.queued.id, owner: jobRecords.queued.owner, caller: jobRecords.queued.caller, requestId: jobRecords.queued.requestId, inputHash: digest(jobInputs.queued), data: JSON.stringify(jobRecords.queued) })
    insert(blog, 'jobs', { id: jobRecords.done.id, owner: jobRecords.done.owner, caller: jobRecords.done.caller, requestId: jobRecords.done.requestId, inputHash: digest(jobInputs.done), data: JSON.stringify(jobRecords.done) })
    insert(blog, 'jobs', { id: jobRecords.running.id, owner: jobRecords.running.owner, caller: jobRecords.running.caller, requestId: jobRecords.running.requestId, inputHash: digest(jobInputs.running), data: JSON.stringify(jobRecords.running) })
    for (const operation of [operationRecords.live, operationRecords.manage]) {
      insert(blog, 'operations', { id: operation.id, owner: operation.owner, draftId: operation.draftId, revision: operation.revision, data: JSON.stringify(operation.data) })
    }
    for (const audit of auditRows) insert(blog, 'audit', { ...audit, data: JSON.stringify(audit.data) })
    insert(blog, 'attachments', { id: attachmentRecords.attached.id, owner: attachmentRecords.attached.owner, draftId: attachmentRecords.attached.draftId, data: JSON.stringify(attachmentRecords.attached.data) })
    insert(blog, 'attachments', { id: attachmentRecords.uploading.id, owner: attachmentRecords.uploading.owner, draftId: attachmentRecords.uploading.draftId, data: JSON.stringify(attachmentRecords.uploading.data) })
  }
  // 索引库内容：清源不许碰。
  insert(blog, 'conversations', { id: BLOG_CHAT, owner: ALICE, requestId: 'pirate-conversation-1', updated: 1_767_000_700_000, data: JSON.stringify({ id: BLOG_CHAT, owner: ALICE, title: '北门巡检对话', ready: true, pinned: false, attachments: [] }) })
  insert(blog, 'conversations', { id: 'blog-chat-6f1c2d4e-9a3b-4c5d-8e7f-000000000002', owner: BOB, requestId: 'conv-req-2', updated: 1_767_000_710_000, data: JSON.stringify({ id: 'blog-chat-6f1c2d4e-9a3b-4c5d-8e7f-000000000002', owner: BOB, title: '别的对话', ready: false, pinned: true, attachments: [] }) })
  insert(blog, 'chat_requests', { id: randomUUID(), owner: ALICE, conversationId: BLOG_CHAT, requestId: 'req-chat-1', inputHash: 'f'.repeat(64), data: JSON.stringify({ id: 'chat-req-1', owner: ALICE, conversationId: BLOG_CHAT, status: 'done', input: { text: '这条对话只活在索引库' } }) })
  insert(blog, 'chat_results', { id: randomUUID(), owner: ALICE, conversationId: BLOG_CHAT, requestId: 'chat-req-1', operationId: 'op-0001', data: JSON.stringify({ id: 'res-1', kind: 'draft', draftId: draftAlice.id, revision: 3 }) })
  insert(blog, 'pirate_blog_conversations', { owner: ALICE, missionId: 'mission-1', conversationId: BLOG_CHAT })
  blog.close()

  const translations = new DatabaseSync(translationsPath)
  translations.exec(`CREATE TABLE IF NOT EXISTS translations(id TEXT PRIMARY KEY, cacheKey TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS translation_cache ON translations(cacheKey,status);`)
  for (const record of [translationRecords.failed, translationRecords.translated, translationRecords.running]) {
    insert(translations, 'translations', { id: record.id, cacheKey: record.cacheKey, owner: record.owner, status: record.status, data: JSON.stringify(record.data) })
  }
  translations.close()
  return { dir, blogPath, translationsPath }
}

describe.skipIf(DSN === '')('blog 存量迁移工具（agents_group_mig）', () => {
  let admin: Pool

  beforeAll(() => {
    admin = new Pool({ connectionString: DSN, max: 2 })
  })

  /** 重建目标 schema。清库前核对 DSN 确实指向 *_mig 专用库，配错时立即失败，绝不 DROP 别的库。 */
  async function resetTarget(): Promise<void> {
    const client = await admin.connect()
    try {
      const current = await client.query<{ name: string }>('SELECT current_database() AS name')
      const databaseName = current.rows[0]?.name ?? ''
      expect(databaseName.endsWith('_mig'), `DSN 指向的数据库「${databaseName}」不是 *_mig 迁移测试库，拒绝 DROP SCHEMA public CASCADE`).toBe(true)
      await client.query('DROP SCHEMA public CASCADE')
      await client.query('CREATE SCHEMA public')
    } finally {
      client.release()
    }
  }

  async function businessTableCount(): Promise<number> {
    const result = await admin.query<{ total: string }>(
      "SELECT count(*) AS total FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    )
    return Number(result.rows[0]?.total ?? 0)
  }

  async function countOf(table: string): Promise<number> {
    const result = await admin.query<{ total: string }>(`SELECT count(*) AS total FROM ${table}`)
    return Number(result.rows[0]?.total ?? -1)
  }

  const BLOG_TABLES = ['blog_drafts', 'blog_jobs', 'blog_operations', 'blog_audit', 'blog_attachments', 'blog_translations']

  it('dry-run：只盘点与校验，目标库不落任何表且源库字节不变', async () => {
    const fx = fixture('dry-run')
    const beforeBlog = sha256File(fx.blogPath)
    const beforeTranslations = sha256File(fx.translationsPath)
    await resetTarget()
    const logs: string[] = []
    const code = await main(['--blog', fx.blogPath, '--translations', fx.translationsPath, '--dsn', DSN, '--dry-run'], {}, line => logs.push(line))
    expect(code).toBe(0)
    expect(await businessTableCount()).toBe(0)
    expect(sha256File(fx.blogPath)).toBe(beforeBlog)
    expect(sha256File(fx.translationsPath)).toBe(beforeTranslations)
    expect(logs.some(line => line.includes('dry-run 结束：未写入任何数据。'))).toBe(true)
    expect(logs.some(line => line.includes('drafts: 2 行'))).toBe(true)
    expect(logs.some(line => line.includes('translations: 3 行'))).toBe(true)
  })

  it('导入：6 张表行数、seq 等于源 rowid 序、逐列值保真，且源库索引表完好', async () => {
    const fx = fixture('import')
    const indexBefore = indexSnapshot(fx.blogPath)
    const sourceRowids = {
      jobs: rowidOrder(fx.blogPath, 'jobs'),
      operations: rowidOrder(fx.blogPath, 'operations'),
      attachments: rowidOrder(fx.blogPath, 'attachments'),
      audit: rowidOrder(fx.blogPath, 'audit'),
      translations: rowidOrder(fx.translationsPath, 'translations'),
    }
    await resetTarget()
    const logs: string[] = []
    await runMigration({ blogPath: fx.blogPath, translationsPath: fx.translationsPath, dsn: DSN, log: line => logs.push(line) })

    expect(await countOf('blog_drafts')).toBe(2)
    expect(await countOf('blog_jobs')).toBe(3)
    expect(await countOf('blog_operations')).toBe(2)
    expect(await countOf('blog_audit')).toBe(2)
    expect(await countOf('blog_attachments')).toBe(2)
    expect(await countOf('blog_translations')).toBe(3)
    const version = await admin.query<{ version: number }>('SELECT version FROM blog_schema_version')
    expect(Number(version.rows[0]?.version)).toBe(1)

    // seq/id 必须逐行等于源 rowid（含 audit 的 id，插入序 5 → 2 与 id 升序不同）。
    const pairs = async (table: string, key: string): Promise<[string, number][]> => {
      const result = await admin.query<Record<string, unknown>>(`SELECT id, ${key} FROM ${table} ORDER BY ${key}`)
      return result.rows.map(row => [String(row.id), Number(row[key])])
    }
    expect(await pairs('blog_jobs', 'seq')).toEqual(sourceRowids.jobs)
    expect(await pairs('blog_operations', 'seq')).toEqual(sourceRowids.operations)
    expect(await pairs('blog_attachments', 'seq')).toEqual(sourceRowids.attachments)
    expect(await pairs('blog_audit', 'id')).toEqual(sourceRowids.audit)
    expect(await pairs('blog_translations', 'seq')).toEqual(sourceRowids.translations)

    // 逐列值保真：非 ASCII、SQL 特殊字符、嵌套 JSON 原样搬入（未重新序列化）。
    const drafts = await admin.query<{ id: string; owner: string; revision: number; updated: string; data: string }>('SELECT id, owner, revision, updated, data FROM blog_drafts ORDER BY updated')
    expect(drafts.rows[0]).toMatchObject({ id: draftAlice.id, owner: ALICE, revision: 3 })
    expect(Number(drafts.rows[0]?.updated)).toBe(draftAlice.updated)
    expect(drafts.rows[0]?.data).toBe(JSON.stringify(draftAlice.data))
    expect(JSON.parse(String(drafts.rows[0]?.data)).text).toContain("' \" ; -- /* */")
    expect(drafts.rows[1]).toMatchObject({ id: draftBob.id, owner: BOB, revision: 1 })
    expect(drafts.rows[1]?.data).toBe(JSON.stringify(draftBob.data))

    const jobs = await admin.query<{ id: string; caller: string; request_id: string; input_hash: string; data: string }>('SELECT id, caller, request_id, input_hash, data FROM blog_jobs ORDER BY seq')
    expect(jobs.rows.map(row => row.id)).toEqual([jobRecords.queued.id, jobRecords.done.id, jobRecords.running.id])
    expect(jobs.rows[0]?.input_hash).toBe(digest(jobInputs.queued))
    expect(jobs.rows[0]?.data).toBe(JSON.stringify(jobRecords.queued))
    expect(JSON.parse(String(jobs.rows[0]?.data)).input.text).toContain('巡检')

    const operations = await admin.query<{ id: string; draft_id: string; revision: number }>('SELECT id, draft_id, revision FROM blog_operations ORDER BY seq')
    expect(operations.rows.map(row => [row.id, row.draft_id, row.revision])).toEqual([
      [operationRecords.live.id, draftAlice.id, 3],
      [operationRecords.manage.id, 'manage:article:new', 0],
    ])

    const audit = await admin.query<{ id: string; at: string; owner: string; action: string }>('SELECT id, at, owner, action FROM blog_audit ORDER BY id')
    expect(audit.rows.map(row => [Number(row.id), row.owner, row.action])).toEqual([[2, BOB, 'import'], [5, ALICE, 'attachment-upload']])
    expect(Number(audit.rows[1]?.at)).toBe(auditRows[0]?.at)

    const attachments = await admin.query<{ id: string; draft_id: string }>('SELECT id, draft_id FROM blog_attachments ORDER BY seq')
    expect(attachments.rows.map(row => [row.id, row.draft_id])).toEqual([
      [attachmentRecords.attached.id, BLOG_CHAT],
      [attachmentRecords.uploading.id, draftAlice.id],
    ])

    const translations = await admin.query<{ id: string; cache_key: string; owner: string; status: string }>('SELECT id, cache_key, owner, status FROM blog_translations ORDER BY seq')
    expect(translations.rows.map(row => [row.id, row.owner, row.status])).toEqual([
      [translationRecords.failed.id, ALICE, 'failed'],
      [translationRecords.translated.id, BOB, 'translated'],
      [translationRecords.running.id, ALICE, 'running'],
    ])

    // 人工核对清单如实报数（jobs queued/running、attachments uploading）。
    expect(logs.some(line => line.includes('jobs 中 queued/running：2 条'))).toBe(true)
    expect(logs.some(line => line.includes(`job id=${jobRecords.queued.id} owner=${ALICE} status=queued`))).toBe(true)
    expect(logs.some(line => line.includes('attachments 中 uploading/parsing：1 条'))).toBe(true)
    expect(logs.some(line => line.includes('BIGSERIAL 序列复位'))).toBe(true)

    // 源库只读：业务 5 表与索引表都在，内容一字未动。
    expect(tableNames(fx.blogPath)).toEqual([...INDEX_TABLES, 'audit', 'attachments', 'drafts', 'jobs', 'operations'].sort())
    expect(businessRowCount(fx.blogPath, 'drafts')).toBe(2)
    expect(indexSnapshot(fx.blogPath)).toEqual(indexBefore)
  })

  it('setval 复位：导入后不带 seq 直接 INSERT 不撞 UNIQUE，且各序列从导入最大值续号', async () => {
    const fx = fixture('setval')
    await resetTarget()
    await runMigration({ blogPath: fx.blogPath, translationsPath: fx.translationsPath, dsn: DSN, log: silent })

    const maxOf = async (table: string, column: string): Promise<number> => {
      const result = await admin.query<{ max: string | null }>(`SELECT max(${column})::text AS max FROM ${table}`)
      return Number(result.rows[0]?.max ?? -1)
    }
    // 五张带序列的表都插一条不带序列列的记录：值必须是「导入最大值 + 1」。
    const inserts: readonly (readonly [string, string])[] = [
      ['blog_jobs', "INSERT INTO blog_jobs(id, owner, caller, request_id, input_hash, data) VALUES('job-post-migrate','user:alice','butler','req-00000009','h','{}')"],
      ['blog_operations', "INSERT INTO blog_operations(id, owner, draft_id, revision, data) VALUES('op-post-migrate','user:alice','draft-0001-alice',4,'{}')"],
      ['blog_attachments', "INSERT INTO blog_attachments(id, owner, draft_id, data) VALUES('att-post-migrate','user:alice','draft-0001-alice','{}')"],
      ['blog_translations', "INSERT INTO blog_translations(id, cache_key, owner, status, data) VALUES('trans-post-migrate','k','user:alice','running','{}')"],
      ['blog_audit', "INSERT INTO blog_audit(at, owner, action, data) VALUES(1,'user:alice','post-migrate','{}')"],
    ]
    for (const [table, sql] of inserts) {
      const column = table === 'blog_audit' ? 'id' : 'seq'
      const before = await maxOf(table, column)
      await admin.query(sql)
      const inserted = await maxOf(table, column)
      expect(inserted, `${table}.${column} 序列未复位：导入最大值 ${before}，直插后 ${inserted}`).toBe(before + 1)
    }

    // 复位后既有读取序不受影响：新记录排最后（seq DESC/ASC 的现状语义）。
    const jobs = await admin.query<{ id: string }>('SELECT id FROM blog_jobs ORDER BY seq DESC LIMIT 1')
    expect(jobs.rows[0]?.id).toBe('job-post-migrate')
  })

  it('setval 复位：空业务表的库导入后首次直插得到 1', async () => {
    const fx = fixture('setval-empty', 'empty')
    await resetTarget()
    await runMigration({ blogPath: fx.blogPath, dsn: DSN, log: silent })
    expect(await countOf('blog_jobs')).toBe(0)

    const job = await admin.query<{ seq: string }>("INSERT INTO blog_jobs(id, owner, caller, request_id, input_hash, data) VALUES('job-first','user:alice','butler','req-00000001','h','{}') RETURNING seq")
    const attachment = await admin.query<{ seq: string }>("INSERT INTO blog_attachments(id, owner, draft_id, data) VALUES('att-first','user:alice','d','{}') RETURNING seq")
    const audit = await admin.query<{ id: string }>("INSERT INTO blog_audit(at, owner, action, data) VALUES(1,'user:alice','first','{}') RETURNING id")
    expect(Number(job.rows[0]?.seq)).toBe(1)
    expect(Number(attachment.rows[0]?.seq)).toBe(1)
    expect(Number(audit.rows[0]?.id)).toBe(1)
  })

  it('--clear-source + --backup：快照先行可用，业务 5 表就地清除，索引表与映射表一字未动', async () => {
    const fx = fixture('clear')
    const indexBefore = indexSnapshot(fx.blogPath)
    const backup = join(fx.dir, 'blog-before-cutover.sqlite')
    await resetTarget()
    const logs: string[] = []
    await runMigration({ blogPath: fx.blogPath, translationsPath: fx.translationsPath, dsn: DSN, clearSource: true, backupPath: backup, log: line => logs.push(line) })

    // 快照先行：文件存在、可只读打开、业务表齐全且行数与清源前一致（回退位的直接证据）。
    expect(existsSync(backup)).toBe(true)
    expect(tableNames(backup)).toEqual([...INDEX_TABLES, 'audit', 'attachments', 'drafts', 'jobs', 'operations'].sort())
    expect(businessRowCount(backup, 'drafts')).toBe(2)
    expect(businessRowCount(backup, 'jobs')).toBe(3)
    expect(businessRowCount(backup, 'audit')).toBe(2)
    expect(businessRowCount(backup, 'attachments')).toBe(2)
    expect(businessRowCount(backup, 'operations')).toBe(2)
    expect(indexSnapshot(backup)).toEqual(indexBefore)

    // 源库业务表消失，索引 3 表与协作映射表原样保留。
    const remaining = tableNames(fx.blogPath)
    for (const table of ['drafts', 'jobs', 'operations', 'audit', 'attachments']) expect(remaining).not.toContain(table)
    expect(remaining.sort()).toEqual([...INDEX_TABLES].sort())
    expect(indexSnapshot(fx.blogPath)).toEqual(indexBefore)

    expect(logs.some(line => line.includes('清源前核对：业务表清单与停写指纹一致'))).toBe(true)
    expect(logs.some(line => line.includes('清源完成：已删除 drafts、jobs、operations、audit、attachments'))).toBe(true)
    expect(logs.some(line => line.includes('索引表行数未变'))).toBe(true)
    expect(logs.some(line => line.includes('不支持只回业务表'))).toBe(true)
    // 目标库内容不受清源影响。
    expect(await countOf('blog_jobs')).toBe(3)
  })

  it('--clear-source 缺少 --backup：拒绝且源库一个字节都没动（退出码 1）', async () => {
    const fx = fixture('clear-no-backup')
    const before = sha256File(fx.blogPath)
    await resetTarget()
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    let code: number
    try {
      code = await main(['--blog', fx.blogPath, '--translations', fx.translationsPath, '--dsn', DSN, '--clear-source'], {}, silent)
    } finally {
      spy.mockRestore()
    }
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('--backup')
    // 源库未动：字节一致、业务表都在；目标库也没落表。
    expect(sha256File(fx.blogPath)).toBe(before)
    expect(businessRowCount(fx.blogPath, 'jobs')).toBe(3)
    expect(await businessTableCount()).toBe(0)
    // runMigration 直调同一拒绝（测试与嵌入路径一致）。
    await expect(runMigration({ blogPath: fx.blogPath, dsn: DSN, clearSource: true, log: silent }))
      .rejects.toMatchObject({ exitCode: 1 })
    expect(sha256File(fx.blogPath)).toBe(before)
  })

  it('目标库状态：业务表非空拒绝（3）；版本不符或有表无版本行同样拒绝（3）', async () => {
    const fx = fixture('target-nonempty')
    await resetTarget()
    await runMigration({ blogPath: fx.blogPath, dsn: DSN, log: silent })
    await expect(runMigration({ blogPath: fx.blogPath, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 3 })
    // 已导入的数据不被第二次尝试破坏。
    expect(await countOf('blog_jobs')).toBe(3)

    // 版本不符：结构在但版本行被改成 2。
    await admin.query('UPDATE blog_schema_version SET version = 2')
    await expect(runMigration({ blogPath: fx.blogPath, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 3 })

    // 有表但没有版本行：来历不明，拒绝。
    await resetTarget()
    await admin.query('CREATE TABLE some_other_agent(id int)')
    await expect(runMigration({ blogPath: fx.blogPath, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 3 })
    expect(await countOf('some_other_agent')).toBe(0)
  })

  it('源库结构不可识别：只有部分业务表或缺列都拒绝（退出码 2），目标库不落表', async () => {
    const partial = fixture('source-partial', 'partial')
    await resetTarget()
    await expect(runMigration({ blogPath: partial.blogPath, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 2 })
    expect(await businessTableCount()).toBe(0)

    // 五张表都在，但 attachments 缺 draftId 列：同样按结构无法识别拒绝，不静默按空表导入。
    const broken = fixture('source-broken', 'full')
    const db = new DatabaseSync(broken.blogPath)
    db.exec('ALTER TABLE attachments RENAME TO attachments_old; CREATE TABLE attachments(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL)')
    db.close()
    await resetTarget()
    await expect(runMigration({ blogPath: broken.blogPath, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 2 })
    expect(await businessTableCount()).toBe(0)
  })

  it('停写点复核失败：导入期间源库被并发写入，整体回滚且退出码 4', async () => {
    const fx = fixture('stopwrite')
    await resetTarget()
    await expect(runMigration({
      blogPath: fx.blogPath,
      translationsPath: fx.translationsPath,
      dsn: DSN,
      log: silent,
      // 双连接模拟「停写被破坏」：导入写入完成、复核之前，第二个读写连接插进一条新草稿。
      onBeforeStopWriteRecheck: () => {
        const writer = new DatabaseSync(fx.blogPath)
        insert(writer, 'drafts', {
          id: 'draft-late', owner: BOB, revision: 1, updated: 1_767_000_800_000,
          data: JSON.stringify({ id: 'draft-late', owner: BOB, revision: 1, updatedAt: 1_767_000_800_000, title: '迟到的草稿' }),
        })
        writer.close()
      },
    })).rejects.toMatchObject({ exitCode: 4 })
    // 整体回滚：结构初始化与数据都不留痕。
    expect(await businessTableCount()).toBe(0)
    // 源库未被工具改动：原有行数不变，只多出注入点写的那一条（回滚不顺手改源）。
    expect(businessRowCount(fx.blogPath, 'drafts')).toBe(3)
    expect(businessRowCount(fx.blogPath, 'jobs')).toBe(3)
    expect(businessRowCount(fx.blogPath, 'audit')).toBe(2)
  })

  it('清源前复核：导入提交后源库又被写入，拒绝清源并保留源库（退出码 4）', async () => {
    const fx = fixture('clear-stopwrite')
    const backup = join(fx.dir, 'snapshot.sqlite')
    await resetTarget()
    // 注入点位置：日志回调在「迁移报告 / 停写点复核」之后、清源之前被调用，此时在源库里改一行，
    // 模拟「导入事务提交之后、清源之前」的并发写入（正是清源前二次复核要拦住的那段窗口）。
    const tamper = (line: string): void => {
      if (!line.includes('停写点复核：源库指纹导入前后一致')) return
      const writer = new DatabaseSync(fx.blogPath)
      writer.prepare("UPDATE audit SET action='tampered' WHERE id=5").run()
      writer.close()
    }
    await expect(runMigration({
      blogPath: fx.blogPath,
      dsn: DSN,
      clearSource: true,
      backupPath: backup,
      log: tamper,
    })).rejects.toMatchObject({ exitCode: 4 })
    // 拒绝清源：源库业务表原样保留（含被改的那一行）、不留快照；目标库已提交的导入不受影响。
    expect(tableNames(fx.blogPath)).toContain('drafts')
    expect(businessRowCount(fx.blogPath, 'jobs')).toBe(3)
    expect(existsSync(backup)).toBe(false)
    expect(await countOf('blog_jobs')).toBe(3)
  })

  it('--clear-source 的快照路径已存在：导入之前就拒绝（退出码 1），目标库不落表、源库字节不变', async () => {
    const fx = fixture('clear-snapshot-exists')
    const before = sha256File(fx.blogPath)
    const backup = join(fx.dir, 'occupied.sqlite')
    writeFileSync(backup, 'occupied')
    await resetTarget()
    await expect(runMigration({
      blogPath: fx.blogPath, translationsPath: fx.translationsPath, dsn: DSN,
      clearSource: true, backupPath: backup, log: silent,
    })).rejects.toMatchObject({ exitCode: 1 })
    // fail fast：导入根本没发生（目标库 0 表），源库一个字节没动，占用文件未被覆盖。
    expect(await businessTableCount()).toBe(0)
    expect(sha256File(fx.blogPath)).toBe(before)
    expect(readFileSync(backup, 'utf8')).toBe('occupied')
  })

  it('--clear-source 的快照父目录不存在：导入之前就拒绝（退出码 1），目标库不落表', async () => {
    const fx = fixture('clear-snapshot-parent')
    await resetTarget()
    await expect(runMigration({
      blogPath: fx.blogPath, translationsPath: fx.translationsPath, dsn: DSN,
      clearSource: true, backupPath: join(fx.dir, 'missing-dir', 'snap.sqlite'), log: silent,
    })).rejects.toMatchObject({ exitCode: 1 })
    expect(await businessTableCount()).toBe(0)
  })

  it('清源前复核发现业务表被删：拒绝清源（退出码 4），其余业务表与目标库不受影响、不留快照', async () => {
    const fx = fixture('clear-missing-table')
    const backup = join(fx.dir, 'snapshot.sqlite')
    await resetTarget()
    // 注入点位置同「源库又被写入」用例：迁移报告日志之后、清源复核之前把 audit 删掉。
    const tamper = (line: string): void => {
      if (!line.includes('停写点复核：源库指纹导入前后一致')) return
      const writer = new DatabaseSync(fx.blogPath)
      writer.exec('DROP TABLE audit')
      writer.close()
    }
    const failure = await runMigration({
      blogPath: fx.blogPath, translationsPath: fx.translationsPath, dsn: DSN,
      clearSource: true, backupPath: backup, log: tamper,
    }).then(() => undefined, (error: unknown) => error as { exitCode?: number; message?: string })
    expect(failure?.exitCode).toBe(4)
    expect(failure?.message).toContain('业务表少了')
    expect(failure?.message).toContain('audit')
    // 其余业务表原样、没生成快照；目标库已提交的导入不受影响。
    expect(businessRowCount(fx.blogPath, 'drafts')).toBe(2)
    expect(businessRowCount(fx.blogPath, 'jobs')).toBe(3)
    expect(existsSync(backup)).toBe(false)
    expect(await countOf('blog_jobs')).toBe(3)
  })

  it('已迁移的源库（业务表已清）：退出码 0 并说明无需迁移，连 DSN 都不需要', async () => {    const fx = fixture('already-migrated')
    await resetTarget()
    await runMigration({ blogPath: fx.blogPath, translationsPath: fx.translationsPath, dsn: DSN, clearSource: true, backupPath: join(fx.dir, 'snap.sqlite'), log: silent })
    expect(tableNames(fx.blogPath).sort()).toEqual([...INDEX_TABLES].sort())

    const logs: string[] = []
    const code = await main(['--blog', fx.blogPath], {}, line => logs.push(line))
    expect(code).toBe(0)
    expect(logs.some(line => line.includes('已迁移或无需迁移'))).toBe(true)
    // 没给 DSN 也能判定「无需迁移」——已清源的库不该再要求连接目标。
    expect(logs.some(line => line.includes('无需迁移（退出码 0）'))).toBe(true)
  })

  it('译文源缺失或没有 translations 表：跳过并记录，业务 5 表照常迁移', async () => {
    const missing = fixture('translations-missing')
    await resetTarget()
    const logs: string[] = []
    const code = await main(['--blog', missing.blogPath, '--translations', join(missing.dir, 'nope.sqlite'), '--dsn', DSN], {}, line => logs.push(line))
    expect(code).toBe(0)
    expect(logs.some(line => line.includes('译文源不存在'))).toBe(true)
    expect(await countOf('blog_drafts')).toBe(2)
    expect(await countOf('blog_translations')).toBe(0)

    // 没传 --translations 但同目录存在：只提示不导入。
    const sibling = fixture('translations-sibling')
    await resetTarget()
    const siblingLogs: string[] = []
    expect(await main(['--blog', sibling.blogPath, '--dsn', DSN], {}, line => siblingLogs.push(line))).toBe(0)
    expect(siblingLogs.some(line => line.includes('存在但未传 --translations'))).toBe(true)
    expect(await countOf('blog_translations')).toBe(0)
    expect(await countOf('blog_jobs')).toBe(3)
  })

  it('非 0/1 的 user_version：如实记录后按业务表存在性继续导入', async () => {
    const fx = fixture('user-version-2', 'full', 2)
    await resetTarget()
    const logs: string[] = []
    await runMigration({ blogPath: fx.blogPath, dsn: DSN, log: line => logs.push(line) })
    expect(logs.some(line => line.includes('user_version = 2') && line.includes('按业务表存在性继续'))).toBe(true)
    expect(await countOf('blog_drafts')).toBe(2)
  })

  it('CLI 参数契约：--help 为 0；缺 --blog 为 1；未知参数回显脱敏；--dry-run 与 --clear-source 互斥', async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    try {
      const logs: string[] = []
      expect(await main(['--help'], {}, line => logs.push(line))).toBe(0)
      expect(logs.join('\n')).toContain('用法：node dist/migrate-blog-storage.mjs')
      expect(await main([], {}, silent)).toBe(1)
      errors.length = 0
      expect(await main(['--bogus=postgresql://user:secret@host:5432/db'], {}, silent)).toBe(1)
      const joined = errors.join('\n')
      expect(joined).not.toContain('secret')
      expect(joined).not.toContain('postgresql://')
      expect(joined).toContain('--bogus=<…>')
      errors.length = 0
      expect(await main(['--blog', 'whatever.sqlite', '--dry-run', '--clear-source', '--backup', 'snap.sqlite', '--dsn', DSN], {}, silent)).toBe(1)
      expect(errors.join('\n')).toContain('不能同时使用')
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * ⚠️ **这里曾有一条「迁移后首次启动」用例，已随 P7 ⑤ 删除。**
   *
   * 它先迁入**旧形状**（`data TEXT` / `owner`）再用 `BlogPgStorage` 启动，而 ⑤ 把实现切到**新形状**
   * （`payload JSONB` + `dsh_schema_versions`）⇒ **「旧形状的目标库 + 新实现」这个组合不再被支持**，
   * 用例的前提消失（实测：`relation "dsh_schema_versions" does not exist` ⇒ `storage_schema_missing`）。
   *
   * **覆盖面没有丢**，两半各有归宿：
   * - 「在途 jobs / attachments 被启动序列收成 failed」⇒ 已在**新形状**上覆盖，见
   *   `agents/blog/tests/pg-smoke.test.ts` 的「启动翻转：jobs 置 running、attachments 置 uploading 后，
   *   init 收成 failed」；
   * - 「迁移不替业务做状态翻转」⇒ 由本文件的导入类用例覆盖。
   *
   * ⚠️ 顺带登记：本文件、被它测试的 `scripts/migrate-blog-storage.ts`、以及
   * `agents/blog/migrations/postgres/0001_init.sql`（旧形状 DDL）**已被新库 DDL 取代**，
   * 现在**零生产消费者**。按设计 §6.3 的过渡说明，管家切完新库之后它们就该一起退役 ——
   * 那是一次独立的清理动作（含发布清单 `verifyFiles` 与包内 `files`），**不在本次范围内**。
   */
})
