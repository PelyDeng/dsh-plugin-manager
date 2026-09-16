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
 * 业务存储的 SQLite 实现（批 2 拆库后仅供测试与开发使用；生产装配只接 BlogPgStorage，
 * Q4 口径禁止静默回退本实现）。
 *
 * 与 BlogPgStorage 保持同一异步方法面（草稿/任务/操作/附件/译文），`init()` 应用表结构并
 * 执行与 PG 启动序列一致的中断翻转，测试因此可以用同一种“构造 → init() → 读写”的姿势。
 * 构造器不再创建业务表、不再维护 user_version：生产 blog.sqlite 文件已与业务表无关。
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, caller TEXT NOT NULL, requestId TEXT NOT NULL, inputHash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,caller,requestId));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, draftId TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, owner TEXT NOT NULL, draftId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS translations(id TEXT PRIMARY KEY, cacheKey TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS translation_cache ON translations(cacheKey,status);`)
    for (const row of this.db.prepare('SELECT id,data FROM jobs').all()) {
      const job = JSON.parse(row.data)
      if (['queued', 'running'].includes(job.status)) await this.jobUpdate(row.id, { status: 'failed', error: { code: 'interrupted', message: '服务已重启；保留结果，可发起新的写作任务' } })
    }
    for (const row of this.db.prepare('SELECT data FROM attachments').all()) {
      const a = JSON.parse(row.data)
      if (['uploading', 'parsing'].includes(a.status)) await this.attachmentWrite({ ...a, status: 'failed', message: '服务重启，解析已中断，请移除后重新上传' })
    }
    return this
  }
  close() { this.db.close() }
  async record(owner, action, data) { this.db.prepare('INSERT INTO audit(at,owner,action,data) VALUES(?,?,?,?)').run(Date.now(), owner, action, JSON.stringify(data)) }
  async create(owner, initial = {}, remote = null, blogNative = false) {
    const content = article({ title: '', text: '', slug: '', tags: [], categories: [], format: 'markdown', ...initial })
    const now=Date.now()
    const value = { id: randomUUID(), ...content, remote, blogNative, proposal: null, sources: [], revision: 1, createdAt:now, updatedAt:now, contentUpdatedAt:now }
    this.db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?)').run(value.id, owner, 1, value.updatedAt, JSON.stringify(value)); return value
  }
  async list(owner, query='') { const search=String(query).trim().toLowerCase(); return this.db.prepare('SELECT data FROM drafts WHERE owner=? ORDER BY updated DESC').all(owner).map(row=>JSON.parse(row.data)).filter(d=>!search||d.title.toLowerCase().includes(search)||d.text.toLowerCase().includes(search)).map(draftSummary) }
  async draftRecords(owner) { return this.db.prepare('SELECT data FROM drafts WHERE owner=?').all(owner).map(r => JSON.parse(r.data)) }
  async findByRemoteCid(owner, cid) { return (await this.draftRecords(owner)).filter(d => d.blogNative && d.remote && d.remote.deleted !== true && [d.remote.published?.cid ?? null, d.remote.savedDraft?.cid ?? null].includes(cid)) }
  async get(owner, id) {
    const row = this.db.prepare('SELECT data FROM drafts WHERE owner=? AND id=?').get(owner, id)
    invariant(row, '草稿不存在或无权访问', 404); return JSON.parse(row.data)
  }
  async save(owner, id, revision, patch) {
    const old = await this.get(owner, id)
    invariant(old.revision === revision, '草稿已在其他窗口修改，请保留当前内容后重新加载', 409)
    const now=Date.now(),contentChanged=['title','text','slug','format','tags','categories','allowComment'].some(key=>Object.hasOwn(patch,key)&&!isDeepStrictEqual(old[key],patch[key]))
    const next = { ...old, ...patch, id, revision: revision + 1, updatedAt: now, contentUpdatedAt:contentChanged?now:draftContentUpdatedAt(old), contentTimeSource:contentChanged?'content':draftContentTimeSource(old) }
    const result = this.db.prepare('UPDATE drafts SET revision=?,updated=?,data=? WHERE id=? AND owner=? AND revision=?').run(next.revision, next.updatedAt, JSON.stringify(next), id, owner, revision)
    invariant(result.changes === 1, '草稿修订冲突', 409); return next
  }
  async edit(owner, id, revision, content) { return this.save(owner, id, revision, article(content)) }
  async propose(owner, id, baseRevision, fields, sources, expectedProposalId) {
    const draft = await this.get(owner, id)
    invariant(expectedProposalId===undefined||(draft.proposal?.id??null)===expectedProposalId,'候选稿已被其他任务更新，请重新读取并核对后再生成',409)
    const candidate = article({ ...draft, ...fields })
    const proposal = { id: randomUUID(), baseRevision, before:baseRevision===draft.revision?{title:draft.title,text:draft.text,tags:draft.tags,categories:draft.categories,allowComment:draft.allowComment,format:draft.format}:null, fields: { title: candidate.title, text: candidate.text, tags: candidate.tags, categories:candidate.categories,...(candidate.allowComment!==undefined?{allowComment:candidate.allowComment}:{}) }, sources, createdAt: Date.now() }
    // A proposal is a side record: do not increment the hand-written draft revision.
    draft.proposal = proposal
    this.db.prepare('UPDATE drafts SET data=? WHERE id=? AND owner=?').run(JSON.stringify(draft), id, owner)
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
    const old = this.db.prepare('SELECT data,inputHash FROM jobs WHERE owner=? AND caller=? AND requestId=?').get(owner, caller, requestId)
    if (old) { invariant(old.inputHash === digest(input), '同一请求标识不能用于不同输入', 409); return { job: JSON.parse(old.data), fresh: false } }
    const job = { id: randomUUID(), owner, caller, requestId, input, actor, status: 'queued', text: '', sources: [], createdAt: Date.now(), updatedAt: Date.now() }
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(job.id, owner, caller, requestId, digest(input), JSON.stringify(job)); return { job, fresh: true }
  }
  async jobLookup(owner, caller, requestId) {
    const row = this.db.prepare('SELECT data FROM jobs WHERE owner=? AND caller=? AND requestId=?').get(owner, caller, requestId)
    return row === undefined ? undefined : JSON.parse(row.data)
  }
  async jobGet(owner, id) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=? AND owner=?').get(id, owner); invariant(row, '任务不存在或无权访问', 404); return JSON.parse(row.data) }
  async jobUpdate(id, patch) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); invariant(row, '任务不存在', 404); const job = { ...JSON.parse(row.data), ...patch, updatedAt: Date.now() }; this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), id); return job }
  async jobList(owner, draftId) { return this.db.prepare('SELECT data FROM jobs WHERE owner=? ORDER BY rowid DESC LIMIT 100').all(owner).map(r => JSON.parse(r.data)).filter(j => j.input.draftId === draftId).map(({ actor, owner: _owner, ...j }) => j) }
  async attachmentInsert(a) { this.db.prepare('INSERT INTO attachments VALUES(?,?,?,?)').run(a.id, a.owner, a.draftId, JSON.stringify(a)); return a }
  async attachmentWrite(a) { this.db.prepare('UPDATE attachments SET data=? WHERE id=?').run(JSON.stringify(a), a.id); return a }
  async attachmentGet(owner, draftId, id) {
    const row = this.db.prepare('SELECT data FROM attachments WHERE owner=? AND draftId=? AND id=?').get(owner, draftId, id)
    invariant(row, '附件不存在或无权访问', 404); const a = JSON.parse(row.data)
    invariant(a.status !== 'removed', '附件已移除', 404); return a
  }
  async attachmentList(owner, draftId) { return this.db.prepare('SELECT data FROM attachments WHERE owner=? AND draftId=? ORDER BY rowid').all(owner, draftId).map(r => JSON.parse(r.data)).filter(a => a.status !== 'removed') }
  async attachmentRaw(id) { const row = this.db.prepare('SELECT data FROM attachments WHERE id=?').get(id); return row === undefined ? undefined : JSON.parse(row.data) }
  async translationLatest(cacheKey) { const row = this.db.prepare("SELECT data FROM translations WHERE cacheKey=? AND status='translated' ORDER BY rowid DESC LIMIT 1").get(cacheKey); return row === undefined ? undefined : JSON.parse(row.data) }
  async translationWrite(id, cacheKey, owner, status, data) { this.db.prepare('INSERT OR REPLACE INTO translations(id,cacheKey,owner,status,data) VALUES(?,?,?,?,?)').run(id, cacheKey, owner, status, JSON.stringify(data)) }
  async operationInsert(op) { this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(op.id, op.owner, op.draftId, op.revision, JSON.stringify(op)) }
  async operation(owner, id) { const row = this.db.prepare('SELECT data FROM operations WHERE id=? AND owner=?').get(id, owner); invariant(row, '操作记录不存在或无权访问', 404); return JSON.parse(row.data) }
  async operationSave(id, value) { this.db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(value), id) }
  /** 条件状态占位（CAS）：仅当 status 仍是 expected 时写入；与 PG 版同一互斥语义。 */
  async operationClaimStatus(id, expected, value) { return this.db.prepare("UPDATE operations SET data=? WHERE id=? AND json_extract(data,'$.status')=?").run(JSON.stringify(value), id, expected).changes === 1 }
  async operations(owner) { return this.db.prepare('SELECT data FROM operations WHERE owner=? ORDER BY rowid').all(owner).map(row => JSON.parse(row.data)) }
  async operationsForDraft(owner, draftId, limit = 20) { return this.db.prepare('SELECT id,data FROM operations WHERE owner=? AND draftId=? ORDER BY rowid DESC LIMIT ?').all(owner, draftId, limit).map(row => ({ id: row.id, record: JSON.parse(row.data) })) }
  async pendingOperations() { return (await this.pendingOperationRecords()).map(op => op.chat?.conversationId).filter(Boolean) }
  async pendingOperationRecords() {
    const now = Date.now()
    return this.db.prepare('SELECT data FROM operations').all().map(r => JSON.parse(r.data)).filter(op => ['running', 'uncertain'].includes(op.status) || (op.status === 'prepared' && op.expiresAt > now))
  }
}
