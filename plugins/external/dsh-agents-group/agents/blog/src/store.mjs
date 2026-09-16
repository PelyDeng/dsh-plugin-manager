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
export class BlogStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    invariant(version === 0 || version === 1, '不支持的博客数据版本', 503)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, caller TEXT NOT NULL, requestId TEXT NOT NULL, inputHash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,caller,requestId));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, draftId TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1;`)
    for (const row of this.db.prepare('SELECT id,data FROM jobs').all()) {
      const job = JSON.parse(row.data)
      if (['queued', 'running'].includes(job.status)) this.jobUpdate(row.id, { status: 'failed', error: { code: 'interrupted', message: '服务已重启；保留结果，可发起新的写作任务' } })
    }
  }
  close() { this.db.close() }
  record(owner, action, data) { this.db.prepare('INSERT INTO audit(at,owner,action,data) VALUES(?,?,?,?)').run(Date.now(), owner, action, JSON.stringify(data)) }
  create(owner, initial = {}, remote = null, blogNative = false) {
    const content = article({ title: '', text: '', slug: '', tags: [], categories: [], format: 'markdown', ...initial })
    const now=Date.now()
    const value = { id: randomUUID(), ...content, remote, blogNative, proposal: null, sources: [], revision: 1, createdAt:now, updatedAt:now, contentUpdatedAt:now }
    this.db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?)').run(value.id, owner, 1, value.updatedAt, JSON.stringify(value)); return value
  }
  list(owner, query='') { const search=String(query).trim().toLowerCase(); return this.db.prepare('SELECT data FROM drafts WHERE owner=? ORDER BY updated DESC').all(owner).map(row=>JSON.parse(row.data)).filter(d=>!search||d.title.toLowerCase().includes(search)||d.text.toLowerCase().includes(search)).map(draftSummary) }
  get(owner, id) {
    const row = this.db.prepare('SELECT data FROM drafts WHERE owner=? AND id=?').get(owner, id)
    invariant(row, '草稿不存在或无权访问', 404); return JSON.parse(row.data)
  }
  save(owner, id, revision, patch) {
    const old = this.get(owner, id)
    invariant(old.revision === revision, '草稿已在其他窗口修改，请保留当前内容后重新加载', 409)
    const now=Date.now(),contentChanged=['title','text','slug','format','tags','categories','allowComment'].some(key=>Object.hasOwn(patch,key)&&!isDeepStrictEqual(old[key],patch[key]))
    const next = { ...old, ...patch, id, revision: revision + 1, updatedAt: now, contentUpdatedAt:contentChanged?now:draftContentUpdatedAt(old), contentTimeSource:contentChanged?'content':draftContentTimeSource(old) }
    const result = this.db.prepare('UPDATE drafts SET revision=?,updated=?,data=? WHERE id=? AND owner=? AND revision=?').run(next.revision, next.updatedAt, JSON.stringify(next), id, owner, revision)
    invariant(result.changes === 1, '草稿修订冲突', 409); return next
  }
  edit(owner, id, revision, content) { return this.save(owner, id, revision, article(content)) }
  propose(owner, id, baseRevision, fields, sources, expectedProposalId) {
    const draft = this.get(owner, id)
    invariant(expectedProposalId===undefined||(draft.proposal?.id??null)===expectedProposalId,'候选稿已被其他任务更新，请重新读取并核对后再生成',409)
    const candidate = article({ ...draft, ...fields })
    const proposal = { id: randomUUID(), baseRevision, before:baseRevision===draft.revision?{title:draft.title,text:draft.text,tags:draft.tags,categories:draft.categories,allowComment:draft.allowComment,format:draft.format}:null, fields: { title: candidate.title, text: candidate.text, tags: candidate.tags, categories:candidate.categories,...(candidate.allowComment!==undefined?{allowComment:candidate.allowComment}:{}) }, sources, createdAt: Date.now() }
    // A proposal is a side record: do not increment the hand-written draft revision.
    draft.proposal = proposal
    this.db.prepare('UPDATE drafts SET data=? WHERE id=? AND owner=?').run(JSON.stringify(draft), id, owner)
    return proposal
  }
  applyProposal(owner, id, revision, proposalId, fields) {
    const d = this.get(owner, id)
    invariant(d.proposal?.id === proposalId && d.proposal.baseRevision === revision, 'AI 候选基线已变化，请比较并手动合并', 409)
    invariant(Array.isArray(fields) && fields.length && fields.every(v => ['title','text','tags','categories','allowComment'].includes(v)), '请选择要应用的候选字段')
    const patch = Object.fromEntries(fields.map(key => [key, d.proposal.fields[key]]))
    return this.save(owner, id, revision, { ...patch, sources: d.proposal.sources, proposal: null })
  }
  discardProposal(owner, id, revision, proposalId) {
    const d=this.get(owner,id)
    invariant(d.proposal&&d.proposal.id===proposalId,'候选稿已变化，请刷新后再删除',409)
    const result=this.save(owner,id,revision,{proposal:null})
    this.record(owner,'discard-proposal',{draftId:id,proposalId});return result
  }
  jobStart(owner, caller, requestId, input, actor) {
    invariant(/^[\w.-]{1,80}$/.test(caller) && /^[\w-]{8,100}$/.test(requestId), '调用标识无效')
    const old = this.db.prepare('SELECT data,inputHash FROM jobs WHERE owner=? AND caller=? AND requestId=?').get(owner, caller, requestId)
    if (old) { invariant(old.inputHash === digest(input), '同一请求标识不能用于不同输入', 409); return { job: JSON.parse(old.data), fresh: false } }
    const job = { id: randomUUID(), owner, caller, requestId, input, actor, status: 'queued', text: '', sources: [], createdAt: Date.now(), updatedAt: Date.now() }
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(job.id, owner, caller, requestId, digest(input), JSON.stringify(job)); return { job, fresh: true }
  }
  jobGet(owner, id) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=? AND owner=?').get(id, owner); invariant(row, '任务不存在或无权访问', 404); return JSON.parse(row.data) }
  jobUpdate(id, patch) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); invariant(row, '任务不存在', 404); const job = { ...JSON.parse(row.data), ...patch, updatedAt: Date.now() }; this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), id); return job }
  jobList(owner, draftId) { return this.db.prepare('SELECT data FROM jobs WHERE owner=? ORDER BY rowid DESC LIMIT 100').all(owner).map(r => JSON.parse(r.data)).filter(j => j.input.draftId === draftId).map(({ actor, owner: _owner, ...j }) => j) }
}
