import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { invariant } from './settings.mjs'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const ownerKey = actor => `${actor.namespace}:${actor.userId}`
// Legacy deleted copies no longer retain the content timestamp from before deletion.
export const draftContentUpdatedAt = d => d.contentUpdatedAt !== undefined ? d.contentUpdatedAt : d.remote?.deleted ? null : d.updatedAt
const draftContentTimeSource = d => Number.isFinite(draftContentUpdatedAt(d)) ? d.contentTimeSource??(d.contentUpdatedAt!==undefined?'content':'legacy-record') : 'unknown'
export { draftContentTimeSource }
export function draftSummary(d) {
  return {id:d.id,title:d.title,revision:d.revision,createdAt:d.createdAt??null,updatedAt:d.updatedAt,contentUpdatedAt:draftContentUpdatedAt(d),contentTimeSource:draftContentTimeSource(d),tags:d.tags,categories:d.categories,
    remote:d.remote?{publishedCid:d.remote.published?.cid??null,savedDraftCid:d.remote.savedDraft?.cid??null,deleted:d.remote.deleted===true,deletedAt:d.remote.deletedAt??null}:null}
}
export function article(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), '文章内容无效')
  const output = {}
  for (const [field, max] of [['title', 300], ['text', 500000], ['slug', 200]]) {
    invariant(typeof value[field] === 'string' && value[field].length <= max, `${field} 格式或长度无效`)
    output[field] = value[field]
  }
  invariant(['markdown', 'html'].includes(value.format), '正文格式无效'); output.format = value.format
  invariant(Array.isArray(value.tags) && value.tags.length <= 50 && value.tags.every(v => typeof v === 'string' && v.trim() && v.length <= 80), '标签无效')
  output.tags = [...new Set(value.tags.map(v => v.trim()))]
  invariant(Array.isArray(value.categories) && value.categories.length <= 50 && value.categories.every(v => Number.isSafeInteger(v) && v > 0), '分类无效')
  output.categories = [...new Set(value.categories)]
  if(value.allowComment!==undefined){invariant(typeof value.allowComment==='boolean','评论开关无效');output.allowComment=value.allowComment}
  return output
}

/**
 * `owner` 字符串（`ownerKey` 的产物，形如 `user:alice`）→ 新形状的**两个**归属列。
 *
 * 切**第一个**冒号：与 `storage/pg.mjs` 的 `ownerOf` 逐字一致。两处切法不同，会让"同一条记录
 * 在两处落到不同归属列上"，而那种漂移**在页面上完全看不出来**。
 * 没有冒号或冒号在开头 ⇒ **当场抛**：空 namespace 会让归属退化成"只按 userId 比"，
 * 跨命名空间的同名用户于是共享数据（`pg-smoke` 就是为此补了"同名不同域"那条用例）。
 */
function ownerColumns(owner) {
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
const nextSeq = table => `(SELECT COALESCE(MAX(seq),0)+1 FROM ${table})`

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
 * 此前这里还是 `owner TEXT` + `data TEXT`，而生产 `storage/pg.mjs` 已是
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
 *    —— 与 `storage/pg.mjs` 的写读口径逐字一致。
 *
 * ## 三处**不能**对齐的，如实写在这里（不要以为"看起来一样"就是一样）
 * 1. **外键**：PG 有 `blog_jobs`/`blog_operations`/`blog_attachments` 的 `draft_id` →
 *    `blog_drafts` 与 `blog_attachments.conversation_id` → `dsh_conversations`（复合外键、MATCH SIMPLE、
 *    ON DELETE CASCADE）。本替身**一条都不建**：`dsh_conversations` 这张表在本库里根本不存在
 *    （会话索引在运行时门面那边），只建一半会给出"有引用完整性"的**假象**；
 *    而且 `node:sqlite` 的 `PRAGMA foreign_keys` **默认是开的**（实测 `=1`），
 *    真建了就会**真的**开始拒绝 —— 那不是"更严格"，是"用一半的约束改变行为"。
 *    ⚠️ **它掩盖了什么**：本替身因此**比生产宽松**。已实测到一处 ——
 *    `tests/storage-wiring.test.mjs` 的操作夹具用 `draftId:'draft-x'`（既不是真实草稿、
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
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  }
  /** 应用业务表结构并把中断中的任务/附件收成 failed（对齐 BlogPgStorage.init 的启动序列）。 */
  async init() {
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
    for (const row of this.db.prepare('SELECT id,payload FROM blog_jobs').all()) {
      const job = JSON.parse(row.payload)
      if (['queued', 'running'].includes(job.status)) await this.jobUpdate(row.id, { status: 'failed', error: { code: 'interrupted', message: '服务已重启；保留结果，可发起新的写作任务' } })
    }
    for (const row of this.db.prepare('SELECT payload FROM blog_attachments').all()) {
      const a = JSON.parse(row.payload)
      if (['uploading', 'parsing'].includes(a.status)) await this.attachmentWrite({ ...a, status: 'failed', message: '服务重启，解析已中断，请移除后重新上传' })
    }
    return this
  }
  close() { this.db.close() }
  async record(owner, action, data) {
    const { namespace, id } = ownerColumns(owner)
    this.db.prepare('INSERT INTO blog_audit(at,owner_namespace,owner_id,action,payload) VALUES(?,?,?,?,?)')
      .run(Date.now(), namespace, id, action, JSON.stringify(data))
  }
  async create(owner, initial = {}, remote = null, blogNative = false) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const content = article({ title: '', text: '', slug: '', tags: [], categories: [], format: 'markdown', ...initial })
    const now=Date.now()
    const value = { id: randomUUID(), ...content, remote, blogNative, proposal: null, sources: [], revision: 1, createdAt:now, updatedAt:now, contentUpdatedAt:now }
    // `title` / `updated_at` 是**生成列**：只写 `payload`（载荷里有 `title`/`updatedAt`，由 CHECK 保证）。
    this.db.prepare('INSERT INTO blog_drafts(id,owner_namespace,owner_id,revision,payload) VALUES(?,?,?,?,?)')
      .run(value.id, namespace, ownerId, 1, JSON.stringify(value)); return value
  }
  async list(owner, query='') {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const search=String(query).trim().toLowerCase()
    return this.db.prepare('SELECT payload FROM blog_drafts WHERE owner_namespace=? AND owner_id=? ORDER BY updated_at DESC').all(namespace, ownerId).map(row=>JSON.parse(row.payload)).filter(d=>!search||d.title.toLowerCase().includes(search)||d.text.toLowerCase().includes(search)).map(draftSummary)
  }
  async draftRecords(owner) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return this.db.prepare('SELECT payload FROM blog_drafts WHERE owner_namespace=? AND owner_id=?').all(namespace, ownerId).map(r => JSON.parse(r.payload))
  }
  async findByRemoteCid(owner, cid) { return (await this.draftRecords(owner)).filter(d => d.blogNative && d.remote && d.remote.deleted !== true && [d.remote.published?.cid ?? null, d.remote.savedDraft?.cid ?? null].includes(cid)) }
  async get(owner, id) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_drafts WHERE owner_namespace=? AND owner_id=? AND id=?').get(namespace, ownerId, id)
    invariant(row, '草稿不存在或无权访问', 404); return JSON.parse(row.payload)
  }
  async save(owner, id, revision, patch) {
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
  async edit(owner, id, revision, content) { return this.save(owner, id, revision, article(content)) }
  async propose(owner, id, baseRevision, fields, sources, expectedProposalId) {
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
  async applyProposal(owner, id, revision, proposalId, fields) {
    const d = await this.get(owner, id)
    invariant(d.proposal?.id === proposalId && d.proposal.baseRevision === revision, 'AI 候选基线已变化，请比较并手动合并', 409)
    invariant(Array.isArray(fields) && fields.length && fields.every(v => ['title','text','tags','categories','allowComment'].includes(v)), '请选择要应用的候选字段')
    const patch = Object.fromEntries(fields.map(key => [key, d.proposal.fields[key]]))
    return this.save(owner, id, revision, { ...patch, sources: d.proposal.sources, proposal: null })
  }
  async discardProposal(owner, id, revision, proposalId) {
    const d=await this.get(owner,id)
    invariant(d.proposal&&d.proposal.id===proposalId,'候选稿已变化，请刷新后再删除',409)
    const result=await this.save(owner,id,revision,{proposal:null})
    await this.record(owner,'discard-proposal',{draftId:id,proposalId});return result
  }
  async jobStart(owner, caller, requestId, input, actor) {
    invariant(/^[\w.-]{1,80}$/.test(caller) && /^[\w-]{8,100}$/.test(requestId), '调用标识无效')
    const { namespace, id: ownerId } = ownerColumns(owner)
    const old = this.db.prepare('SELECT payload,input_hash AS inputHash FROM blog_jobs WHERE owner_namespace=? AND owner_id=? AND caller=? AND request_id=?').get(namespace, ownerId, caller, requestId)
    if (old) { invariant(old.inputHash === digest(input), '同一请求标识不能用于不同输入', 409); return { job: JSON.parse(old.payload), fresh: false } }
    const job = { id: randomUUID(), owner, caller, requestId, input, actor, status: 'queued', text: '', sources: [], createdAt: Date.now(), updatedAt: Date.now() }
    // `draft_id` / `status` 是生成列（由载荷派生，CHECK 要求载荷里有 `status` 与 `input.draftId`）。
    this.db.prepare(`INSERT INTO blog_jobs(id,owner_namespace,owner_id,caller,request_id,input_hash,seq,payload) VALUES(?,?,?,?,?,?,${nextSeq('blog_jobs')},?)`)
      .run(job.id, namespace, ownerId, caller, requestId, digest(input), JSON.stringify(job)); return { job, fresh: true }
  }
  async jobLookup(owner, caller, requestId) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_jobs WHERE owner_namespace=? AND owner_id=? AND caller=? AND request_id=?').get(namespace, ownerId, caller, requestId)
    return row === undefined ? undefined : JSON.parse(row.payload)
  }
  async jobGet(owner, id) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_jobs WHERE id=? AND owner_namespace=? AND owner_id=?').get(id, namespace, ownerId)
    invariant(row, '任务不存在或无权访问', 404); return JSON.parse(row.payload)
  }
  async jobUpdate(id, patch) { const row = this.db.prepare('SELECT payload FROM blog_jobs WHERE id=?').get(id); invariant(row, '任务不存在', 404); const job = { ...JSON.parse(row.payload), ...patch, updatedAt: Date.now() }; this.db.prepare('UPDATE blog_jobs SET payload=? WHERE id=?').run(JSON.stringify(job), id); return job }
  async jobList(owner, draftId) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return this.db.prepare('SELECT payload FROM blog_jobs WHERE owner_namespace=? AND owner_id=? ORDER BY seq DESC LIMIT 100').all(namespace, ownerId).map(r => JSON.parse(r.payload)).filter(j => j.input.draftId === draftId).map(({ actor, owner: _owner, ...j }) => j)
  }
  async attachmentInsert(a) {
    const { namespace, id: ownerId } = ownerColumns(a.owner)
    // scope 分两支：会话附件（`blog-chat-*`）落 `conversation_id`，其余落 `draft_id`（恰一非空，CHECK 强制）。
    const conversation = String(a.draftId).startsWith(CONVERSATION_PREFIX)
    this.db.prepare(`INSERT INTO blog_attachments(id,owner_namespace,owner_id,draft_id,conversation_id,seq,payload) VALUES(?,?,?,?,?,${nextSeq('blog_attachments')},?)`)
      .run(a.id, namespace, ownerId, conversation ? null : a.draftId, conversation ? a.draftId : null, JSON.stringify(a))
    return a
  }
  /** scope 两列**不在这里写**：它们在插入那一刻定下，而写路径只改状态/选择/版本（`a.draftId` 不变）。与 PG 同。 */
  async attachmentWrite(a) { this.db.prepare('UPDATE blog_attachments SET payload=? WHERE id=?').run(JSON.stringify(a), a.id); return a }
  async attachmentGet(owner, draftId, id) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    // `draftId` 既可以是草稿 id 也可以是会话 id ⇒ **两列一起比**（恰有一支非空，按前缀挑一列会在传错前缀时静默空）。
    const row = this.db.prepare('SELECT payload FROM blog_attachments WHERE owner_namespace=? AND owner_id=? AND (draft_id=? OR conversation_id=?) AND id=?').get(namespace, ownerId, draftId, draftId, id)
    invariant(row, '附件不存在或无权访问', 404); const a = JSON.parse(row.payload)
    invariant(a.status !== 'removed', '附件已移除', 404); return a
  }
  async attachmentList(owner, draftId) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return this.db.prepare('SELECT payload FROM blog_attachments WHERE owner_namespace=? AND owner_id=? AND (draft_id=? OR conversation_id=?) ORDER BY seq').all(namespace, ownerId, draftId, draftId).map(r => JSON.parse(r.payload)).filter(a => a.status !== 'removed')
  }
  async attachmentRaw(id) { const row = this.db.prepare('SELECT payload FROM blog_attachments WHERE id=?').get(id); return row === undefined ? undefined : JSON.parse(row.payload) }
  async translationLatest(cacheKey) { const row = this.db.prepare("SELECT payload FROM blog_translations WHERE cache_key=? AND status='translated' ORDER BY seq DESC LIMIT 1").get(cacheKey); return row === undefined ? undefined : JSON.parse(row.payload) }
  /**
   * `status` 在本表是**镜像列不是生成列**（DDL 专门写了这条例外）⇒ **必须写**；`seq` 由本存储生成。
   * 用 UPSERT 而不是 `INSERT OR REPLACE`：后者是"先删后插"，`MAX(seq)+1` 可能在删掉旧行之后求值
   * ⇒ 拿到与旧行相同的 `seq`，同一 cacheKey 的两条记录顺序就不确定了。
   */
  async translationWrite(id, cacheKey, owner, status, data) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    this.db.prepare(`INSERT INTO blog_translations(id,cache_key,owner_namespace,owner_id,status,seq,payload) VALUES(?,?,?,?,?,${nextSeq('blog_translations')},?)
      ON CONFLICT(id) DO UPDATE SET cache_key=excluded.cache_key, owner_namespace=excluded.owner_namespace, owner_id=excluded.owner_id, status=excluded.status, seq=excluded.seq, payload=excluded.payload`)
      .run(id, cacheKey, namespace, ownerId, status, JSON.stringify(data))
  }
  async operationInsert(op) {
    const { namespace, id: ownerId } = ownerColumns(op.owner)
    // 合成 scope（`manage:` / `remote:`）落 `scope_id`，真实草稿落 `draft_id`（恰一非空，CHECK 强制）。
    const synthetic = SYNTHETIC_SCOPE.test(String(op.draftId))
    this.db.prepare(`INSERT INTO blog_operations(id,owner_namespace,owner_id,draft_id,scope_id,revision,seq,payload) VALUES(?,?,?,?,?,?,${nextSeq('blog_operations')},?)`)
      .run(op.id, namespace, ownerId, synthetic ? null : op.draftId, synthetic ? op.draftId : '', op.revision, JSON.stringify(op))
  }
  async operation(owner, id) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    const row = this.db.prepare('SELECT payload FROM blog_operations WHERE id=? AND owner_namespace=? AND owner_id=?').get(id, namespace, ownerId)
    invariant(row, '操作记录不存在或无权访问', 404); return JSON.parse(row.payload)
  }
  async operationSave(id, value) { this.db.prepare('UPDATE blog_operations SET payload=? WHERE id=?').run(JSON.stringify(value), id) }
  /** 条件状态占位（CAS）：仅当 status 仍是 expected 时写入；与 PG 版同一互斥语义。 */
  async operationClaimStatus(id, expected, value) {
    // 读 `status` 这一列：它是生成列（PG 侧写的是 `payload->>'status'`，两者等价），顺手把生成列真正用上。
    return this.db.prepare('UPDATE blog_operations SET payload=? WHERE id=? AND status=?').run(JSON.stringify(value), id, expected).changes === 1
  }
  async operations(owner) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    return this.db.prepare('SELECT payload FROM blog_operations WHERE owner_namespace=? AND owner_id=? ORDER BY seq').all(namespace, ownerId).map(row => JSON.parse(row.payload))
  }
  async operationsForDraft(owner, draftId, limit = 20) {
    const { namespace, id: ownerId } = ownerColumns(owner)
    // 两列 OR：只比 `draft_id` 会让管理 / 远端操作（`scope_id` 那一支）整批查不到。
    return this.db.prepare('SELECT id,payload FROM blog_operations WHERE owner_namespace=? AND owner_id=? AND (draft_id=? OR scope_id=?) ORDER BY seq DESC LIMIT ?').all(namespace, ownerId, draftId, draftId, limit).map(row => ({ id: row.id, record: JSON.parse(row.payload) }))
  }
  async pendingOperations() { return (await this.pendingOperationRecords()).map(op => op.chat?.conversationId).filter(Boolean) }
  async pendingOperationRecords() {
    const now = Date.now()
    return this.db.prepare('SELECT payload FROM blog_operations').all().map(r => JSON.parse(r.payload)).filter(op => ['running', 'uncertain'].includes(op.status) || (op.status === 'prepared' && op.expiresAt > now))
  }
}
