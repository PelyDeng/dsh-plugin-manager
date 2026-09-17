import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { invariant } from './settings.ts'

/**
 * `ownerKey()` 需要的归属两件套。
 *
 * 开放索引是**必需的**：调用方传的是 kit 的 `Actor`（还有 `sessionId`）与测试夹具里带更多键的
 * 裸对象字面量，多出来的键原样忽略、不参与判定。
 */
export type OwnerActor = { readonly namespace: string; readonly userId: string; readonly [key: string]: any }

/** `article()` 认的两种正文格式。 */
export type ArticleFormat = 'markdown' | 'html'

/** 文章内容：`article()` 的产物（六个必有键 + 可选评论开关）。 */
export interface BlogArticle {
  title: string
  text: string
  slug: string
  format: ArticleFormat
  tags: string[]
  categories: number[]
  allowComment?: boolean
}

/**
 * 业务记录：`blog_drafts` / `blog_jobs` / `blog_operations` / `blog_attachments` / `blog_translations`
 * 的 `payload` 那一层 JSON。键由写入方（业务代码与博客桥接器）决定，存储层只整层存取 ⇒ 这里按
 * **开放字典**处理，与本包 `settings.ts` 的 `loadSettings()` / `readJSON()` 同一口径，而不是一份
 * 需要跟着业务改的 schema。SQLite 侧是 `TEXT`（读回来 `JSON.parse`），PG 侧是 `JSONB`（读回来直接是对象）。
 */
export type BlogRecord = Record<string, any>

/** `article()` 的输入：编辑器提交、桥接器快照、草稿记录整份传入（形状由方法里的不变量逐个把关）。 */
export type ArticleInput = BlogRecord

/** 远端快照（`draft.remote`）：博客桥接器原样返回的 JSON，键随桥接器版本演进。 */
export type BlogRemoteSnapshot = BlogRecord

/**
 * 草稿记录（`blog_drafts.payload`）：本存储**写进去并保证存在**的键逐一声明；其余键走开放索引。
 *
 * ⚠️ **`remote` / `legacyRemote` / `deleteOperationId` 刻意不在这里声明**：它们是业务与博客桥接器
 * 写进载荷的 JSON，**可空**，而现有调用方（`application.ts` 与若干用例）按非空读它们
 * （`d.remote.deleted`）。声明成 `| null` 会把那些读法变成类型错误，声明成非空又是一句假话
 * ⇒ 本轮留给下面的开放索引，**如实登记为类型豁口**（见交付说明）。
 *
 * `proposal` 是**唯一**例外地显式声明成 `any`：调用方（`index.ts:422` 的存储端口与三个用例夹具）
 * 把 `get()` 的结果标注成 `{ proposal?: { id; fields: { title; text } } }` 这类**全可选形状**，
 * 而 TS 的弱类型检查不认索引签名（"has no properties in common"）；声明这个键才能让那些
 * 端口形状收得下这份记录。值类型不收窄的理由与上面 `remote` 相同（现有读法按非空 `d.proposal.id`
 * 取值，精确形状见 {@link BlogProposal}）。
 *
 * 可选键写成 `?: T | undefined`（与 `packages/runtime/src/storage/errors.ts` 的
 * `StorageErrorOptions` 同一写法）：记录是 `{...old, ...patch}` 拼出来的，展开一个开放字典会让
 * 这些键真的带 `undefined`，而 `exactOptionalPropertyTypes` 下"可选"与"显式 undefined"是两回事。
 */
export type BlogDraft = {
  id: string
  title: string
  text: string
  slug: string
  format: ArticleFormat
  tags: string[]
  categories: number[]
  allowComment?: boolean | undefined
  revision: number
  /** 未记录时间的旧记录读回来是 `undefined`（`contentTimeSource` 就是为这种记录准备的）。 */
  createdAt?: number | undefined
  updatedAt: number
  /** `save()` 自己会写 `null`：远端副本已删除且旧记录没有内容时间时，"内容时间未知"就是 `null`。 */
  contentUpdatedAt?: number | null | undefined
  contentTimeSource?: string | undefined
  blogNative?: boolean | undefined
  sources?: readonly unknown[] | undefined
  /** 候选稿：可空 JSON（精确形状见 {@link BlogProposal}），声明它是为了让端口形状收得下本记录。 */
  proposal?: any
  /** `remote` / 其他业务与桥接器写入的键：可空 JSON，见上面的说明。 */
  [key: string]: any
}

/** 候选稿（`draft.proposal`）：基线、候选字段与来源。`before` 与余项同样留开放索引（同上）。 */
export type BlogProposal = {
  id: string
  baseRevision: number
  fields: BlogRecord
  sources: readonly unknown[]
  createdAt: number
  [key: string]: any
}

/** 写作任务记录（`blog_jobs.payload`）。 */
export type BlogJob = {
  id: string
  owner: string
  caller: string
  requestId: string
  /** 受理时的输入（`digest(input)` 是幂等判据，`input.draftId` 派生生成列 `draft_id`）。 */
  input: BlogRecord
  status: string
  text: string
  createdAt: number
  updatedAt: number
  [key: string]: any
}

/** `jobList()` 的产物：按现状**去掉** `actor` / `owner`（列表不回传这两个身份字段）。 */
export type BlogJobSummary = Omit<BlogJob, 'actor' | 'owner'>

/** 附件记录（`blog_attachments.payload`）：`parsed` / `original` / `image` 等由附件层写入，留开放索引。 */
export type BlogAttachment = {
  id: string
  owner: string
  /** 真实草稿 id 或会话 id（`blog-chat-*`）——写入时按前缀分流到 `draft_id` / `conversation_id`。 */
  draftId: string
  name: string
  kind: string
  version: number
  status: string
  selected: boolean
  range: unknown
  createdAt: number
  bytes?: number
  message?: string
  [key: string]: any
}

/**
 * **读出来的**操作记录（`blog_operations.payload`）：一次提交/移除的待核对操作。
 *
 * `mode` / `title` 按**必有**声明：库里的操作全部由业务写入方（`application.ts` 的三处 `prepare*`）
 * 产生，而消费方（`application.ts` 的 `BlogStoragePort` / `chat.ts` 的 `OperationRecord`）都按必有读它们。
 * ⚠️ 写入侧的入参刻意更宽（见 {@link BlogStore.operationInsert} 的 `BlogRecord`）：夹具只写
 * `id/owner/draftId/revision/status`，本存储不强制业务字段齐全。
 */
export type BlogOperation = {
  id: string
  owner: string
  /** 真实草稿 id 或合成 scope（`manage:…` / `remote:…`）——写入时按前缀分流到 `draft_id` / `scope_id`。 */
  draftId: string
  revision: number
  status: string
  mode: string
  title: string
  sessionId?: string
  nonce?: string
  expiresAt?: number
  createdAt?: number
  [key: string]: any
}

/** `draftSummary()` 的远端投影：列表与检索只需要关联 cid 与删除标记。 */
export interface BlogRemoteSummary {
  publishedCid: number | null
  savedDraftCid: number | null
  deleted: boolean
  deletedAt: number | null
}

/** `draftSummary()` 的产物：列表项与检索项的稳定字段。 */
export interface BlogDraftSummary {
  id: string
  title: string
  revision: number
  createdAt: number | null
  updatedAt: number
  contentUpdatedAt: number | null
  contentTimeSource: string
  tags: string[]
  categories: number[]
  remote: BlogRemoteSummary | null
}

/** `SELECT payload …` 的行：`payload` 列在 SQLite 里是 TEXT（JSON 文本）。 */
type PayloadRow = { payload: string }
/** `SELECT id,payload …` 的行（全表回读时带 id 定位）。 */
type IdPayloadRow = { id: string; payload: string }
/** `SELECT payload,input_hash AS inputHash …` 的行（`jobStart` 的幂等预读）。 */
type JobPriorRow = { payload: string; inputHash: string }

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const ownerKey = (actor: OwnerActor): string => `${actor.namespace}:${actor.userId}`
// Legacy deleted copies no longer retain the content timestamp from before deletion.
export const draftContentUpdatedAt = (d: BlogDraft): number | null => d.contentUpdatedAt !== undefined ? d.contentUpdatedAt : d.remote?.deleted ? null : d.updatedAt
const draftContentTimeSource = (d: BlogDraft): string => Number.isFinite(draftContentUpdatedAt(d)) ? d.contentTimeSource??(d.contentUpdatedAt!==undefined?'content':'legacy-record') : 'unknown'
export { draftContentTimeSource }
export function draftSummary(d: BlogDraft): BlogDraftSummary {
  return {id:d.id,title:d.title,revision:d.revision,createdAt:d.createdAt??null,updatedAt:d.updatedAt,contentUpdatedAt:draftContentUpdatedAt(d),contentTimeSource:draftContentTimeSource(d),tags:d.tags,categories:d.categories,
    remote:d.remote?{publishedCid:d.remote.published?.cid??null,savedDraftCid:d.remote.savedDraft?.cid??null,deleted:d.remote.deleted===true,deletedAt:d.remote.deletedAt??null}:null}
}
export function article(value: ArticleInput): BlogArticle {
  invariant(value && typeof value === 'object' && !Array.isArray(value), '文章内容无效')
  const output: Partial<BlogArticle> = {}
  for (const [field, max] of [['title', 300], ['text', 500000], ['slug', 200]] as const) {
    invariant(typeof value[field] === 'string' && value[field].length <= max, `${field} 格式或长度无效`)
    output[field] = value[field]
  }
  invariant(['markdown', 'html'].includes(value.format), '正文格式无效'); output.format = value.format
  invariant(Array.isArray(value.tags) && value.tags.length <= 50 && value.tags.every((v: unknown) => typeof v === 'string' && v.trim() && v.length <= 80), '标签无效')
  output.tags = [...new Set(value.tags.map((v: string) => v.trim()))]
  invariant(Array.isArray(value.categories) && value.categories.length <= 50 && value.categories.every((v: number) => Number.isSafeInteger(v) && v > 0), '分类无效')
  output.categories = [...new Set(value.categories)]
  if(value.allowComment!==undefined){invariant(typeof value.allowComment==='boolean','评论开关无效');output.allowComment=value.allowComment}
  // 六个必有键在上面每条路径上都已经写过（循环写 title/text/slug，之后写 format/tags/categories），
  // 所以这里断言只是把"逐步构建"的中间态收成 `article()` 的对外契约 —— 取值与写入顺序一个都没动。
  return output as BlogArticle
}

/**
 * `owner` 字符串（`ownerKey` 的产物，形如 `user:alice`）→ 新形状的**两个**归属列。
 *
 * 切**第一个**冒号：与 `storage/pg.ts` 的 `ownerOf` 逐字一致。两处切法不同，会让"同一条记录
 * 在两处落到不同归属列上"，而那种漂移**在页面上完全看不出来**。
 * 没有冒号或冒号在开头 ⇒ **当场抛**：空 namespace 会让归属退化成"只按 userId 比"，
 * 跨命名空间的同名用户于是共享数据（`pg-smoke` 就是为此补了"同名不同域"那条用例）。
 */
function ownerColumns(owner: string): { namespace: string; id: string } {
  invariant(typeof owner === 'string', '归属标识无效')
  const at = owner.indexOf(':')
  invariant(at > 0, `归属标识无效：${owner}`)
  return { namespace: owner.slice(0, at), id: owner.slice(at + 1) }
}

/** 合成 scope（`manage:<kind>:<id|new>` / `remote:<rootCid>`）：落 `scope_id`，**不是**真实草稿 id。 */
const SYNTHETIC_SCOPE = /^(?:manage|remote):/
/** 会话 id 前缀（`conversation.ts` 的 `CONVERSATION_PREFIX` 里 blog 那一项）：附件落 `conversation_id`。 */
const CONVERSATION_PREFIX = 'blog-chat-'

/**
 * 由库生成的 `seq`（PG 是 `GENERATED ALWAYS AS IDENTITY`）。
 *
 * SQLite 没有第二个自增列，所以**由本存储自己**在 INSERT 里算；**调用方永远不传它**（与 IDENTITY
 * 的可观察语义一致）。子查询在 INSERT 求值时执行，`MAX(seq)` 看得见本行之前的所有行 ⇒ 严格递增。
 */
const nextSeq = (table: string): string => `(SELECT COALESCE(MAX(seq),0)+1 FROM ${table})`

/**
 * 业务存储的 SQLite 实现（批 2 拆库后仅供测试与开发使用；生产装配只接 BlogPgStorage，
 * Q4 口径禁止静默回退本实现）。
 *
 * 与 BlogPgStorage 保持同一异步方法面（草稿/任务/操作/附件/译文），`init()` 应用表结构并
 * 执行与 PG 启动序列一致的中断翻转，测试因此可以用同一种“构造 → init() → 读写”的姿势。
 * 构造器不再创建业务表、不再维护 user_version：生产 blog.sqlite 文件已与业务表无关。
 *
 * ## ⚠️ 表结构**跟到新形状**（本文件此前是上一代结构，与生产分叉）
 *
 * 设计《…运行时重构方案-最终版》`:868` 的要求是"**SQLite 类（替身，跟新形状）**"。
 * 此前这里还是 `owner TEXT` + `data TEXT`，而生产 `storage/pg.ts` 已是
 * `owner_namespace` + `owner_id` + `payload` + `dsh_schema_versions` —— 后果**不是"覆盖率低"，
 * 而是证据面与生产事实面不一致**：跑在本替身上的那批用例**碰不到**形状相关的代码路径，
 * 于是"两列归属 / 载荷缺键 / 生成了还去写 / 两处多态 scope 恰好一支"这些错法一条都抓不到。
 *
 * 对齐了三件事（**语义对齐，不是照抄方言**）：
 * 1. **表名与列名与 DDL 一致**（`private-deploy/db/0001_init.sql` 的六张 `blog_*` 表），
 *    所以"比列名"这件事可以直接比、不需要映射表；
 * 2. **6 个生成列**（`blog_drafts.title`/`updated_at`、`blog_jobs.draft_id`/`status`、
 *    `blog_operations.status`、`blog_attachments.status`）用 SQLite 的
 *    `GENERATED ALWAYS AS (…) STORED` 表达 ⇒ **写它同样报错**（SQLite 报
 *    `cannot INSERT into generated column`，与 PG 的 `428C9` 是同一条语义）；
 *    另加 `CHECK` 形状守卫（载荷缺键即拒），对齐 PG 那几条 `CHECK (payload ? 'x')`；
 * 3. **两处多态 scope**：`blog_operations` 的 `draft_id`(真实草稿) / `scope_id`(合成
 *    `manage:` / `remote:`) 与 `blog_attachments` 的 `draft_id` / `conversation_id`
 *    （`blog-chat-` 前缀），都是"**恰好一支非空**"的 CHECK；**写入按前缀分流、读取两列 OR**
 *    —— 与 `storage/pg.ts` 的写读口径逐字一致。
 *
 * ## 三处**不能**对齐的，如实写在这里（不要以为"看起来一样"就是一样）
 * 1. **外键**：PG 有 `blog_jobs`/`blog_operations`/`blog_attachments` 的 `draft_id` →
 *    `blog_drafts` 与 `blog_attachments.conversation_id` → `dsh_conversations`（复合外键、MATCH SIMPLE、
 *    ON DELETE CASCADE）。本替身**一条都不建**：`dsh_conversations` 这张表在本库里根本不存在
 *    （会话索引在运行时门面那边），只建一半会给出"有引用完整性"的**假象**；
 *    而且 `node:sqlite` 的 `PRAGMA foreign_keys` **默认是开的**（实测 `=1`），
 *    真建了就会**真的**开始拒绝 —— 那不是"更严格"，是"用一半的约束改变行为"。
 *    ⚠️ **它掩盖了什么**：本替身因此**比生产宽松**。已实测到一处 ——
 *    `tests/storage-wiring.test.ts` 的操作夹具用 `draftId:'draft-x'`（既不是真实草稿、
 *    也不是 `manage:`/`remote:` 合成 scope），**在 PG 上那是 23503**。该文件不在本次改动范围内，
 *    已回报主线。
 * 2. **`seq`**：PG 是 `GENERATED ALWAYS AS IDENTITY`（库生成、不写）。SQLite **没有第二个自增列**
 *    （`INTEGER PRIMARY KEY` 才是 rowid 别名，而主键已经是 `id TEXT`）⇒ 由**本存储自己**在 INSERT
 *    里用 `(SELECT COALESCE(MAX(seq),0)+1 FROM 本表)` 生成。**调用方永远不传 `seq`** ——
 *    这一点与 IDENTITY 的可观察语义一致；顺序语义也因此与 PG 相同（都按插入序）。
 * 3. **方言**：`payload` 在 SQLite 里是 `TEXT`（存 JSON 文本），PG 是 `JSONB`。**载荷是一个整体
 *    JSON** 这条语义一致；`json_extract(...)` / `->>` 是 SQLite 侧的等价写法。
 */
export class BlogStore {
  /** SQLite 句柄：`tests/schema-parity` 与几处用例直接读它核验表结构与被拒的写，所以是公开只读字段。 */
  readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  }
  /** 应用业务表结构并把中断中的任务/附件收成 failed（对齐 BlogPgStorage.init 的启动序列）。 */
  async init(): Promise<this> {
    /**
     * 六张表的**形状**与 `private-deploy/db/0001_init.sql` 逐列对齐（列名一致、生成的列不写、
     * 两处多态 scope 恰一非空）。细节与"哪三处不能对齐"见类注释。
     */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blog_drafts(
        id              TEXT    PRIMARY KEY,
        owner_namespace TEXT    NOT NULL,
        owner_id        TEXT    NOT NULL,
        revision        INTEGER NOT NULL,
        title           TEXT    GENERATED ALWAYS AS (json_extract(payload,'$.title')) STORED,
        updated_at      INTEGER GENERATED ALWAYS AS (json_extract(payload,'$.updatedAt')) STORED,
        payload         TEXT    NOT NULL,
        UNIQUE(id, owner_namespace, owner_id),
        CHECK (json_extract(payload,'$.title') IS NOT NULL AND json_extract(payload,'$.updatedAt') IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS blog_drafts_owner ON blog_drafts(owner_namespace, owner_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS blog_jobs(
        id              TEXT    PRIMARY KEY,
        owner_namespace TEXT    NOT NULL,
        owner_id        TEXT    NOT NULL,
        caller          TEXT    NOT NULL,
        request_id      TEXT    NOT NULL,
        input_hash      TEXT    NOT NULL,
        draft_id        TEXT    GENERATED ALWAYS AS (json_extract(payload,'$.input.draftId')) STORED,
        status          TEXT    GENERATED ALWAYS AS (json_extract(payload,'$.status')) STORED,
        seq             INTEGER,
        payload         TEXT    NOT NULL,
        UNIQUE(owner_namespace, owner_id, caller, request_id),
        CHECK (json_extract(payload,'$.status') IS NOT NULL AND json_extract(payload,'$.input.draftId') IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS blog_jobs_owner ON blog_jobs(owner_namespace, owner_id, seq DESC);

      CREATE TABLE IF NOT EXISTS blog_operations(
        id              TEXT    PRIMARY KEY,
        owner_namespace TEXT    NOT NULL,
        owner_id        TEXT    NOT NULL,
        draft_id        TEXT,
        scope_id        TEXT    NOT NULL DEFAULT '',
        revision        INTEGER NOT NULL,
        status          TEXT    GENERATED ALWAYS AS (json_extract(payload,'$.status')) STORED,
        seq             INTEGER,
        payload         TEXT    NOT NULL,
        CHECK (json_extract(payload,'$.status') IS NOT NULL),
        CONSTRAINT blog_operations_one_scope CHECK ((draft_id IS NULL) <> (scope_id = ''))
      );
      CREATE INDEX IF NOT EXISTS blog_operations_owner ON blog_operations(owner_namespace, owner_id, seq);

      CREATE TABLE IF NOT EXISTS blog_audit(
        id              INTEGER PRIMARY KEY,
        at              INTEGER NOT NULL,
        owner_namespace TEXT    NOT NULL,
        owner_id        TEXT    NOT NULL,
        action          TEXT    NOT NULL,
        payload         TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blog_audit_owner ON blog_audit(owner_namespace, owner_id, at DESC);

      CREATE TABLE IF NOT EXISTS blog_attachments(
        id              TEXT    PRIMARY KEY,
        owner_namespace TEXT    NOT NULL,
        owner_id        TEXT    NOT NULL,
        draft_id        TEXT,
        conversation_id TEXT,
        status          TEXT    GENERATED ALWAYS AS (json_extract(payload,'$.status')) STORED,
        seq             INTEGER,
        payload         TEXT    NOT NULL,
        CHECK (json_extract(payload,'$.status') IS NOT NULL),
        CONSTRAINT blog_attachments_one_scope CHECK ((draft_id IS NULL) <> (conversation_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS blog_attachments_draft ON blog_attachments(owner_namespace, owner_id, draft_id, seq) WHERE draft_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS blog_attachments_conversation ON blog_attachments(owner_namespace, owner_id, conversation_id, seq) WHERE conversation_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS blog_translations(
        id              TEXT    PRIMARY KEY,
        cache_key       TEXT    NOT NULL,
        owner_namespace TEXT    NOT NULL,
        owner_id        TEXT    NOT NULL,
        status          TEXT    NOT NULL,
        seq             INTEGER,
        payload         TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blog_translation_cache ON blog_translations(cache_key, status, seq DESC);`)
    for (const row of this.db.prepare('SELECT id,payload FROM blog_jobs').all() as IdPayloadRow[]) {
      const job = JSON.parse(row.payload)
      if (['queued', 'running'].includes(job.status)) await this.jobUpdate(row.id, { status: 'failed', error: { code: 'interrupted', message: '服务已重启；保留结果，可发起新的写作任务' } })
    }
    for (const row of this.db.prepare('SELECT payload FROM blog_attachments').all() as PayloadRow[]) {
      const a = JSON.parse(row.payload)
      if (['uploading', 'parsing'].includes(a.status)) await this.attachmentWrite({ ...a, status: 'failed', message: '服务重启，解析已中断，请移除后重新上传' })
    }
    return this
  }
  close(): void { this.db.close() }
  async record(owner: string, action: string, data: unknown): Promise<void> {
    const { namespace, id } = ownerColumns(owner)
    this.db.prepare('INSERT INTO blog_audit(at,owner_namespace,owner_id,action,payload) VALUES(?,?,?,?,?)')
      .run(Date.now(), namespace, id, action, JSON.stringify(data))
  }
  async create(owner: string, initial: ArticleInput = {}, remote: BlogRemoteSnapshot | null = null, blogNative = false): Promise<BlogDraft> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const content = article({ title: '', text: '', slug: '', tags: [], categories: [], format: 'markdown', ...initial })
    const now=Date.now()
    const value = { id: randomUUID(), ...content, remote, blogNative, proposal: null, sources: [], revision: 1, createdAt:now, updatedAt:now, contentUpdatedAt:now }
    // `title` / `updated_at` 是**生成列**：只写 `payload`（载荷里有 `title`/`updatedAt`，由 CHECK 保证）。
    this.db.prepare('INSERT INTO blog_drafts(id,owner_namespace,owner_id,revision,payload) VALUES(?,?,?,?,?)')
      .run(value.id, namespace, ownerId, 1, JSON.stringify(value)); return value
  }
  async list(owner: string, query = ''): Promise<BlogDraftSummary[]> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const search=String(query).trim().toLowerCase()
    return (this.db.prepare('SELECT payload FROM blog_drafts WHERE owner_namespace=? AND owner_id=? ORDER BY updated_at DESC').all(namespace, ownerId) as PayloadRow[]).map(row=>JSON.parse(row.payload)).filter(d=>!search||d.title.toLowerCase().includes(search)||d.text.toLowerCase().includes(search)).map(draftSummary)
  }
  async draftRecords(owner: string): Promise<BlogDraft[]> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return (this.db.prepare('SELECT payload FROM blog_drafts WHERE owner_namespace=? AND owner_id=?').all(namespace, ownerId) as PayloadRow[]).map(r => JSON.parse(r.payload))
  }
  async findByRemoteCid(owner: string, cid: number): Promise<BlogDraft[]> { return (await this.draftRecords(owner)).filter(d => d.blogNative && d.remote && d.remote.deleted !== true && [d.remote.published?.cid ?? null, d.remote.savedDraft?.cid ?? null].includes(cid)) }
  async get(owner: string, id: string): Promise<BlogDraft> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_drafts WHERE owner_namespace=? AND owner_id=? AND id=?').get(namespace, ownerId, id) as PayloadRow | undefined
    invariant(row, '草稿不存在或无权访问', 404); return JSON.parse(row.payload)
  }
  async save(owner: string, id: string, revision: number, patch: BlogRecord): Promise<BlogDraft> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const old = await this.get(owner, id)
    invariant(old.revision === revision, '草稿已在其他窗口修改，请保留当前内容后重新加载', 409)
    const now=Date.now(),contentChanged=['title','text','slug','format','tags','categories','allowComment'].some(key=>Object.hasOwn(patch,key)&&!isDeepStrictEqual(old[key],patch[key]))
    const next = { ...old, ...patch, id, revision: revision + 1, updatedAt: now, contentUpdatedAt:contentChanged?now:draftContentUpdatedAt(old), contentTimeSource:contentChanged?'content':draftContentTimeSource(old) }
    // `updated_at` 是生成列：**改时间 = 改载荷里的 `updatedAt`**（`next.updatedAt=now` 已在上一步）。
    const result = this.db.prepare('UPDATE blog_drafts SET revision=?,payload=? WHERE id=? AND owner_namespace=? AND owner_id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), id, namespace, ownerId, revision)
    invariant(result.changes === 1, '草稿修订冲突', 409); return next
  }
  async edit(owner: string, id: string, revision: number, content: ArticleInput): Promise<BlogDraft> { return this.save(owner, id, revision, article(content)) }
  async propose(owner: string, id: string, baseRevision: number, fields: ArticleInput, sources: readonly unknown[], expectedProposalId?: string | null): Promise<BlogProposal> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const draft = await this.get(owner, id)
    invariant(expectedProposalId===undefined||(draft.proposal?.id??null)===expectedProposalId,'候选稿已被其他任务更新，请重新读取并核对后再生成',409)
    const candidate = article({ ...draft, ...fields })
    const proposal = { id: randomUUID(), baseRevision, before:baseRevision===draft.revision?{title:draft.title,text:draft.text,tags:draft.tags,categories:draft.categories,allowComment:draft.allowComment,format:draft.format}:null, fields: { title: candidate.title, text: candidate.text, tags: candidate.tags, categories:candidate.categories,...(candidate.allowComment!==undefined?{allowComment:candidate.allowComment}:{}) }, sources, createdAt: Date.now() }
    // A proposal is a side record: do not increment the hand-written draft revision.
    draft.proposal = proposal
    this.db.prepare('UPDATE blog_drafts SET payload=? WHERE id=? AND owner_namespace=? AND owner_id=?').run(JSON.stringify(draft), id, namespace, ownerId)
    return proposal
  }
  async applyProposal(owner: string, id: string, revision: number, proposalId: string, fields: readonly string[]): Promise<BlogDraft> {
    const d = await this.get(owner, id)
    invariant(d.proposal?.id === proposalId && d.proposal.baseRevision === revision, 'AI 候选基线已变化，请比较并手动合并', 409)
    invariant(Array.isArray(fields) && fields.length && fields.every(v => ['title','text','tags','categories','allowComment'].includes(v)), '请选择要应用的候选字段')
    const patch = Object.fromEntries(fields.map(key => [key, d.proposal.fields[key]]))
    return this.save(owner, id, revision, { ...patch, sources: d.proposal.sources, proposal: null })
  }
  async discardProposal(owner: string, id: string, revision: number, proposalId: string): Promise<BlogDraft> {
    const d=await this.get(owner,id)
    invariant(d.proposal&&d.proposal.id===proposalId,'候选稿已变化，请刷新后再删除',409)
    const result=await this.save(owner,id,revision,{proposal:null})
    await this.record(owner,'discard-proposal',{draftId:id,proposalId});return result
  }
  async jobStart(owner: string, caller: string, requestId: string, input: BlogRecord, actor: BlogRecord): Promise<{ job: BlogJob; fresh: boolean }> {
    invariant(/^[\w.-]{1,80}$/.test(caller) && /^[\w-]{8,100}$/.test(requestId), '调用标识无效')
    const { namespace, id: ownerId } = ownerColumns(owner)
    const old = this.db.prepare('SELECT payload,input_hash AS inputHash FROM blog_jobs WHERE owner_namespace=? AND owner_id=? AND caller=? AND request_id=?').get(namespace, ownerId, caller, requestId) as JobPriorRow | undefined
    if (old) { invariant(old.inputHash === digest(input), '同一请求标识不能用于不同输入', 409); return { job: JSON.parse(old.payload), fresh: false } }
    const job = { id: randomUUID(), owner, caller, requestId, input, actor, status: 'queued', text: '', sources: [], createdAt: Date.now(), updatedAt: Date.now() }
    // `draft_id` / `status` 是生成列（由载荷派生，CHECK 要求载荷里有 `status` 与 `input.draftId`）。
    this.db.prepare(`INSERT INTO blog_jobs(id,owner_namespace,owner_id,caller,request_id,input_hash,seq,payload) VALUES(?,?,?,?,?,?,${nextSeq('blog_jobs')},?)`)
      .run(job.id, namespace, ownerId, caller, requestId, digest(input), JSON.stringify(job)); return { job, fresh: true }
  }
  async jobLookup(owner: string, caller: string, requestId: string): Promise<BlogJob | undefined> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_jobs WHERE owner_namespace=? AND owner_id=? AND caller=? AND request_id=?').get(namespace, ownerId, caller, requestId) as PayloadRow | undefined
    return row === undefined ? undefined : JSON.parse(row.payload)
  }
  async jobGet(owner: string, id: string): Promise<BlogJob> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_jobs WHERE id=? AND owner_namespace=? AND owner_id=?').get(id, namespace, ownerId) as PayloadRow | undefined
    invariant(row, '任务不存在或无权访问', 404); return JSON.parse(row.payload)
  }
  async jobUpdate(id: string, patch: BlogRecord): Promise<BlogJob> { const row = this.db.prepare('SELECT payload FROM blog_jobs WHERE id=?').get(id) as PayloadRow | undefined; invariant(row, '任务不存在', 404); const job = { ...JSON.parse(row.payload), ...patch, updatedAt: Date.now() }; this.db.prepare('UPDATE blog_jobs SET payload=? WHERE id=?').run(JSON.stringify(job), id); return job }
  async jobList(owner: string, draftId: string): Promise<BlogJobSummary[]> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return (this.db.prepare('SELECT payload FROM blog_jobs WHERE owner_namespace=? AND owner_id=? ORDER BY seq DESC LIMIT 100').all(namespace, ownerId) as PayloadRow[]).map(r => JSON.parse(r.payload)).filter(j => j.input.draftId === draftId).map(({ actor, owner: _owner, ...j }) => j)
  }
  async attachmentInsert(a: BlogAttachment): Promise<BlogAttachment> {
    const { namespace, id: ownerId } = ownerColumns(a.owner)
    // scope 分两支：会话附件（`blog-chat-*`）落 `conversation_id`，其余落 `draft_id`（恰一非空，CHECK 强制）。
    const conversation = String(a.draftId).startsWith(CONVERSATION_PREFIX)
    this.db.prepare(`INSERT INTO blog_attachments(id,owner_namespace,owner_id,draft_id,conversation_id,seq,payload) VALUES(?,?,?,?,?,${nextSeq('blog_attachments')},?)`)
      .run(a.id, namespace, ownerId, conversation ? null : a.draftId, conversation ? a.draftId : null, JSON.stringify(a))
    return a
  }
  /** scope 两列**不在这里写**：它们在插入那一刻定下，而写路径只改状态/选择/版本（`a.draftId` 不变）。与 PG 同。 */
  async attachmentWrite(a: BlogAttachment): Promise<BlogAttachment> { this.db.prepare('UPDATE blog_attachments SET payload=? WHERE id=?').run(JSON.stringify(a), a.id); return a }
  async attachmentGet(owner: string, draftId: string, id: string): Promise<BlogAttachment> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    // `draftId` 既可以是草稿 id 也可以是会话 id ⇒ **两列一起比**（恰有一支非空，按前缀挑一列会在传错前缀时静默空）。
    const row = this.db.prepare('SELECT payload FROM blog_attachments WHERE owner_namespace=? AND owner_id=? AND (draft_id=? OR conversation_id=?) AND id=?').get(namespace, ownerId, draftId, draftId, id) as PayloadRow | undefined
    invariant(row, '附件不存在或无权访问', 404); const a = JSON.parse(row.payload)
    invariant(a.status !== 'removed', '附件已移除', 404); return a
  }
  async attachmentList(owner: string, draftId: string): Promise<BlogAttachment[]> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return (this.db.prepare('SELECT payload FROM blog_attachments WHERE owner_namespace=? AND owner_id=? AND (draft_id=? OR conversation_id=?) ORDER BY seq').all(namespace, ownerId, draftId, draftId) as PayloadRow[]).map(r => JSON.parse(r.payload)).filter(a => a.status !== 'removed')
  }
  async attachmentRaw(id: string): Promise<BlogAttachment | undefined> { const row = this.db.prepare('SELECT payload FROM blog_attachments WHERE id=?').get(id) as PayloadRow | undefined; return row === undefined ? undefined : JSON.parse(row.payload) }
  async translationLatest(cacheKey: string): Promise<BlogRecord | undefined> { const row = this.db.prepare("SELECT payload FROM blog_translations WHERE cache_key=? AND status='translated' ORDER BY seq DESC LIMIT 1").get(cacheKey) as PayloadRow | undefined; return row === undefined ? undefined : JSON.parse(row.payload) }
  /**
   * `status` 在本表是**镜像列不是生成列**（DDL 专门写了这条例外）⇒ **必须写**；`seq` 由本存储生成。
   * 用 UPSERT 而不是 `INSERT OR REPLACE`：后者是"先删后插"，`MAX(seq)+1` 可能在删掉旧行之后求值
   * ⇒ 拿到与旧行相同的 `seq`，同一 cacheKey 的两条记录顺序就不确定了。
   */
  async translationWrite(id: string, cacheKey: string, owner: string, status: string, data: BlogRecord): Promise<void> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    this.db.prepare(`INSERT INTO blog_translations(id,cache_key,owner_namespace,owner_id,status,seq,payload) VALUES(?,?,?,?,?,${nextSeq('blog_translations')},?)
      ON CONFLICT(id) DO UPDATE SET cache_key=excluded.cache_key, owner_namespace=excluded.owner_namespace, owner_id=excluded.owner_id, status=excluded.status, seq=excluded.seq, payload=excluded.payload`)
      .run(id, cacheKey, namespace, ownerId, status, JSON.stringify(data))
  }
  /**
   * 写入侧入参是**开放记录**而不是 {@link BlogOperation}：本存储只把载荷整层存下，不强制业务字段
   * 齐全（夹具与若干净化路径只写 `id/owner/draftId/revision/status`）。读出来时的形状见
   * {@link BlogOperation}。
   */
  async operationInsert(op: BlogRecord): Promise<void> {
    const { namespace, id: ownerId } = ownerColumns(op.owner)
    // 合成 scope（`manage:` / `remote:`）落 `scope_id`，真实草稿落 `draft_id`（恰一非空，CHECK 强制）。
    const synthetic = SYNTHETIC_SCOPE.test(String(op.draftId))
    this.db.prepare(`INSERT INTO blog_operations(id,owner_namespace,owner_id,draft_id,scope_id,revision,seq,payload) VALUES(?,?,?,?,?,?,${nextSeq('blog_operations')},?)`)
      .run(op.id, namespace, ownerId, synthetic ? null : op.draftId, synthetic ? op.draftId : '', op.revision, JSON.stringify(op))
  }
  async operation(owner: string, id: string): Promise<BlogOperation> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_operations WHERE id=? AND owner_namespace=? AND owner_id=?').get(id, namespace, ownerId) as PayloadRow | undefined
    invariant(row, '操作记录不存在或无权访问', 404); return JSON.parse(row.payload)
  }
  async operationSave(id: string, value: BlogOperation): Promise<void> { this.db.prepare('UPDATE blog_operations SET payload=? WHERE id=?').run(JSON.stringify(value), id) }
  /** 条件状态占位（CAS）：仅当 status 仍是 expected 时写入；与 PG 版同一互斥语义。 */
  async operationClaimStatus(id: string, expected: string, value: BlogOperation): Promise<boolean> {
    // 读 `status` 这一列：它是生成列（PG 侧写的是 `payload->>'status'`，两者等价），顺手把生成列真正用上。
    return this.db.prepare('UPDATE blog_operations SET payload=? WHERE id=? AND status=?').run(JSON.stringify(value), id, expected).changes === 1
  }
  async operations(owner: string): Promise<BlogOperation[]> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return (this.db.prepare('SELECT payload FROM blog_operations WHERE owner_namespace=? AND owner_id=? ORDER BY seq').all(namespace, ownerId) as PayloadRow[]).map(row => JSON.parse(row.payload))
  }
  async operationsForDraft(owner: string, draftId: string, limit = 20): Promise<{ id: string; record: BlogOperation }[]> {
    const { namespace, id: ownerId } = ownerColumns(owner)
    // 两列 OR：只比 `draft_id` 会让管理 / 远端操作（`scope_id` 那一支）整批查不到。
    return (this.db.prepare('SELECT id,payload FROM blog_operations WHERE owner_namespace=? AND owner_id=? AND (draft_id=? OR scope_id=?) ORDER BY seq DESC LIMIT ?').all(namespace, ownerId, draftId, draftId, limit) as IdPayloadRow[]).map(row => ({ id: row.id, record: JSON.parse(row.payload) }))
  }
  async pendingOperations(): Promise<string[]> { return (await this.pendingOperationRecords()).map(op => op.chat?.conversationId).filter(Boolean) }
  async pendingOperationRecords(): Promise<BlogOperation[]> {
    const now = Date.now()
    return (this.db.prepare('SELECT payload FROM blog_operations').all() as PayloadRow[]).map(r => JSON.parse(r.payload)).filter(op => ['running', 'uncertain'].includes(op.status) || (op.status === 'prepared' && op.expiresAt > now))
  }
}
