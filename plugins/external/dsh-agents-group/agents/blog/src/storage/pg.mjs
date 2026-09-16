/**
 * blog 业务存储的 PostgreSQL 实现（`pg` Pool，批 2 B2-2a）。
 *
 * 复用管家 butler-console 的机制（连接参数起点、错误稳定码、版本表、有界关闭，
 * 不跨插件 import，模式复制为群组自己的 storage/{dsn,errors}.mjs）：
 *
 * - 连接参数起点：max=5、取连接 3s、空闲 30s；连接建立后 SET statement_timeout=5000、
 *   lock_timeout=2000。多步写单连接单事务（checkout/BEGIN/COMMIT/ROLLBACK），禁止
 *   pool.query 逐条拼业务序列。
 * - 启动序列 init()：版本校验（缺表 `storage_schema_missing` / 版本不符
 *   `storage_schema_version`，不自动建表、不自动改写版本）+ jobs 中断翻转
 *   （store.mjs:45-48）与 attachments 中断翻转（attachments.mjs:14-17）并入启动序列，
 *   单事务完成恢复写；未就绪即不服务。
 * - 业务语义与 SQLite 版 BlogStore 逐字对齐：save 的 revision 条件更新守卫、jobStart 的
 *   UNIQUE(owner,caller,request_id) 幂等（SELECT 先行 + INSERT 兜底）、audit append-only、
 *   损坏 JSON 不做分类（现状即直接 JSON.parse，如实抛出，沿用）。
 * - 记录列保持 TEXT 存储 + 读时 JSON.parse（不迁 JSONB）；时间为毫秒 bigint，驱动侧
 *   回传字符串，读出按需 Number()。
 *
 * 本文件只新增存储能力，不改 SQLite 运行路径；调用方接线在 B2-2b。
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Client, Pool } from 'pg'
import { invariant } from '../settings.mjs'
import { article, digest, draftContentTimeSource, draftContentUpdatedAt, draftSummary } from '../store.mjs'
import { mapStorageError, StorageError } from './errors.mjs'

/** 本实现对应的库结构版本（与 `migrations/postgres/0001_init.sql` 写入的版本行一致）。 */
export const STORAGE_SCHEMA_VERSION = 1
const EXPECTED_SCHEMA_VERSION = STORAGE_SCHEMA_VERSION

/** 业务表清单：init 时逐一核验存在性（schema 固定 public，缺表归类 `storage_schema_missing`）。 */
const EXPECTED_TABLES = ['blog_drafts', 'blog_jobs', 'blog_operations', 'blog_audit', 'blog_attachments', 'blog_translations']

/** 有界关闭上限：超时后放弃等待并记录，池终结交给进程退出。 */
const CLOSE_TIMEOUT_MS = 5000
/** /ready 就绪探针的耗时上限：连接与查询各有界，超过即按探针失败回答。 */
const READY_PROBE_TIMEOUT_MS = 1500

/**
 * blog 业务表的 PostgreSQL 存储。
 *
 * 用法：构造（建池）→ `init()`（版本校验 + jobs/attachments 中断翻转）→ 对外服务。
 * 校验失败或未通过校验时，其余读写一律以同一 `StorageError` 拒绝：未就绪即不服务。
 */
export class BlogPgStorage {
  constructor(dsn, onError) {
    this.dsn = dsn
    this.pool = new Pool({ connectionString: dsn, max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000 })
    this.reportError = onError ?? (error => console.error('agents-group/blog: PostgreSQL 连接池错误', error))
    // 空闲连接的后台错误若无人监听会成为宿主 uncaughtException。
    this.pool.on('error', error => this.reportError(error))
    // 连接建立后设置语句/锁超时；'connect' 在连接交付前同步触发，SET 排在业务语句之前。
    this.pool.on('connect', client => {
      void client.query('SET statement_timeout = 5000; SET lock_timeout = 2000')
        .catch(error => this.reportError(error))
    })
    this.readyError = undefined
    this.inited = false
    this.closed = false
  }

  /**
   * 启动序列（方案 §4 B2-2a 三环）：schema 版本校验 + jobs 中断翻转 + attachments 中断翻转。
   * 版本号只核验、不自动改写：迁移由显式工具执行；缺表/版本不符分别归类，不自动建表。
   */
  async init() {
    this.assertOpen()
    let failure
    try {
      const versionResult = await this.pool.query('SELECT version FROM blog_schema_version')
      const versionRow = versionResult.rows[0]
      if (versionRow === undefined) throw new StorageError('storage_schema_version', 'blog_schema_version 表没有版本行，无法确认博客数据结构版本')
      const current = Number(versionRow.version)
      if (current !== EXPECTED_SCHEMA_VERSION) throw new StorageError('storage_schema_version', `不支持的博客数据结构版本：${current}（期望 ${EXPECTED_SCHEMA_VERSION}）`)
      // 表存在性检查显式化：schema 固定 public，to_regclass 带 `public.` 前缀，不受 search_path 影响。
      const found = await this.pool.query('SELECT t.tab FROM unnest($1::text[]) AS t(tab) WHERE to_regclass(\'public.\' || t.tab) IS NOT NULL', [[...EXPECTED_TABLES]])
      const present = new Set(found.rows.map(row => row.tab))
      const missing = EXPECTED_TABLES.filter(table => !present.has(table))
      if (missing.length > 0) throw new StorageError('storage_schema_missing', `存储结构缺失，缺少表：${missing.join('、')}`)
      // 校验通过后执行恢复写（单事务）；恢复失败同样置为未就绪。
      this.inited = true
      this.readyError = undefined
      await this.recoverInterrupted()
      return
    } catch (error) {
      const mapped = error instanceof StorageError ? error : mapStorageError(error)
      failure = mapped instanceof StorageError ? mapped : new StorageError('storage_unknown', '存储初始化失败', { cause: error })
      this.readyError = failure
      throw failure
    }
  }

  /**
   * 启动恢复写（原 SQLite 构造器行为迁 PG 后并入启动序列）：
   * jobs 里 queued/running 的任务收成 failed（store.mjs:45-48），attachments 里
   * uploading/parsing 的记录收成 failed（attachments.mjs:14-17），单事务完成。
   */
  async recoverInterrupted() {
    const now = Date.now()
    return this.withTransaction(async client => {
      const jobs = await client.query('SELECT id, data FROM blog_jobs')
      for (const row of jobs.rows) {
        const job = JSON.parse(row.data)
        if (!['queued', 'running'].includes(job.status)) continue
        const failed = { ...job, status: 'failed', error: { code: 'interrupted', message: '服务已重启；保留结果，可发起新的写作任务' }, updatedAt: now }
        await client.query('UPDATE blog_jobs SET data=$1 WHERE id=$2', [JSON.stringify(failed), row.id])
      }
      const attachments = await client.query('SELECT data FROM blog_attachments')
      for (const row of attachments.rows) {
        const a = JSON.parse(row.data)
        if (!['uploading', 'parsing'].includes(a.status)) continue
        const failed = { ...a, status: 'failed', message: '服务重启，解析已中断，请移除后重新上传' }
        await client.query('UPDATE blog_attachments SET data=$1 WHERE id=$2', [JSON.stringify(failed), a.id])
      }
    })
  }

  /**
   * 运行时就绪探针（Q4 口径：已配置但运行中 PG 不可达 = blog 已装载未就绪，端点 503）。
   * 用一条独立的短连接查同源 schema 版本，不占业务池、总耗时以 1.5s 为上界、不做结果缓存。
   */
  async readyProbe() {
    this.assertOpen()
    const client = new Client({ connectionString: this.dsn, connectionTimeoutMillis: READY_PROBE_TIMEOUT_MS })
    client.on('error', error => this.reportError(error))
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StorageError('storage_timeout', '就绪探针超时', { retryable: true })), READY_PROBE_TIMEOUT_MS)
    })
    try {
      await Promise.race([
        (async () => {
          await client.connect()
          await client.query(`SET statement_timeout = ${READY_PROBE_TIMEOUT_MS}`)
          const one = await client.query('SELECT 1 AS one')
          if (one.rows[0]?.one !== 1) throw new StorageError('storage_unknown', '就绪探针收到异常应答')
          const versionResult = await client.query('SELECT version FROM blog_schema_version')
          const versionRow = versionResult.rows[0]
          if (versionRow === undefined) throw new StorageError('storage_schema_version', 'blog_schema_version 表没有版本行，无法确认博客数据结构版本')
          const current = Number(versionRow.version)
          if (current !== EXPECTED_SCHEMA_VERSION) throw new StorageError('storage_schema_version', `不支持的博客数据结构版本：${current}（期望 ${EXPECTED_SCHEMA_VERSION}）`)
        })(),
        deadline,
      ])
    } catch (error) {
      throw error instanceof StorageError ? error : mapStorageError(error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      client.end().catch(() => {})
    }
  }

  // ---------- 草稿（对应 BlogStore：record/create/list/get/save/edit/propose/applyProposal/discardProposal） ----------

  async record(owner, action, data) {
    await this.run('INSERT INTO blog_audit(at, owner, action, data) VALUES($1,$2,$3,$4)', [Date.now(), owner, action, JSON.stringify(data)])
  }

  async create(owner, initial = {}, remote = null, blogNative = false) {
    const content = article({ title: '', text: '', slug: '', tags: [], categories: [], format: 'markdown', ...initial })
    const now = Date.now()
    const value = { id: randomUUID(), ...content, remote, blogNative, proposal: null, sources: [], revision: 1, createdAt: now, updatedAt: now, contentUpdatedAt: now }
    await this.run('INSERT INTO blog_drafts(id, owner, revision, updated, data) VALUES($1,$2,$3,$4,$5)', [value.id, owner, 1, value.updatedAt, JSON.stringify(value)])
    return value
  }

  async list(owner, query = '') {
    const search = String(query).trim().toLowerCase()
    const result = await this.run('SELECT data FROM blog_drafts WHERE owner=$1 ORDER BY updated DESC', [owner])
    return result.rows.map(row => JSON.parse(row.data)).filter(d => !search || d.title.toLowerCase().includes(search) || d.text.toLowerCase().includes(search)).map(draftSummary)
  }

  /** owner 名下全部草稿的完整记录（search.mjs:41 的检索入口，检索与排序在调用方）。 */
  async draftRecords(owner) {
    const result = await this.run('SELECT data FROM blog_drafts WHERE owner=$1', [owner])
    return result.rows.map(row => JSON.parse(row.data))
  }

  /**
   * 按 cid 找已导入的博客原生草稿（application.mjs:139-145 importSnapshot 的 cid 幂等去重
   * 存储侧支撑，四耦合点之 1）：过滤条件与现状逐字对齐——非原生、已删除、无该关联 cid 的跳过。
   * 返回完整记录，variant 与内容比对（sameBlogContent）仍由调用方完成。
   */
  async findByRemoteCid(owner, cid) {
    return (await this.draftRecords(owner)).filter(d => d.blogNative && d.remote && d.remote.deleted !== true
      && [d.remote.published?.cid ?? null, d.remote.savedDraft?.cid ?? null].includes(cid))
  }

  async get(owner, id) {
    const result = await this.run('SELECT data FROM blog_drafts WHERE owner=$1 AND id=$2', [owner, id])
    invariant(result.rows[0], '草稿不存在或无权访问', 404)
    return JSON.parse(result.rows[0].data)
  }

  async save(owner, id, revision, patch) {
    const old = await this.get(owner, id)
    invariant(old.revision === revision, '草稿已在其他窗口修改，请保留当前内容后重新加载', 409)
    const now = Date.now(), contentChanged = ['title', 'text', 'slug', 'format', 'tags', 'categories', 'allowComment'].some(key => Object.hasOwn(patch, key) && !isDeepStrictEqual(old[key], patch[key]))
    const next = { ...old, ...patch, id, revision: revision + 1, updatedAt: now, contentUpdatedAt: contentChanged ? now : draftContentUpdatedAt(old), contentTimeSource: contentChanged ? 'content' : draftContentTimeSource(old) }
    // revision 条件更新守卫：并发下恰有一路 UPDATE 命中，另一路 0 行按 409 拒绝（store.mjs:68 语义）。
    const result = await this.run('UPDATE blog_drafts SET revision=$1, updated=$2, data=$3 WHERE id=$4 AND owner=$5 AND revision=$6', [next.revision, next.updatedAt, JSON.stringify(next), id, owner, revision])
    invariant(result.rowCount === 1, '草稿修订冲突', 409)
    return next
  }

  async edit(owner, id, revision, content) { return this.save(owner, id, revision, article(content)) }

  async propose(owner, id, baseRevision, fields, sources, expectedProposalId) {
    const draft = await this.get(owner, id)
    invariant(expectedProposalId === undefined || (draft.proposal?.id ?? null) === expectedProposalId, '候选稿已被其他任务更新，请重新读取并核对后再生成', 409)
    const candidate = article({ ...draft, ...fields })
    const proposal = { id: randomUUID(), baseRevision, before: baseRevision === draft.revision ? { title: draft.title, text: draft.text, tags: draft.tags, categories: draft.categories, allowComment: draft.allowComment, format: draft.format } : null, fields: { title: candidate.title, text: candidate.text, tags: candidate.tags, categories: candidate.categories, ...(candidate.allowComment !== undefined ? { allowComment: candidate.allowComment } : {}) }, sources, createdAt: Date.now() }
    // A proposal is a side record: do not increment the hand-written draft revision.
    draft.proposal = proposal
    await this.run('UPDATE blog_drafts SET data=$1 WHERE id=$2 AND owner=$3', [JSON.stringify(draft), id, owner])
    return proposal
  }

  async applyProposal(owner, id, revision, proposalId, fields) {
    const d = await this.get(owner, id)
    invariant(d.proposal?.id === proposalId && d.proposal.baseRevision === revision, 'AI 候选基线已变化，请比较并手动合并', 409)
    invariant(Array.isArray(fields) && fields.length && fields.every(v => ['title', 'text', 'tags', 'categories', 'allowComment'].includes(v)), '请选择要应用的候选字段')
    const patch = Object.fromEntries(fields.map(key => [key, d.proposal.fields[key]]))
    return this.save(owner, id, revision, { ...patch, sources: d.proposal.sources, proposal: null })
  }

  async discardProposal(owner, id, revision, proposalId) {
    const d = await this.get(owner, id)
    invariant(d.proposal && d.proposal.id === proposalId, '候选稿已变化，请刷新后再删除', 409)
    const result = await this.save(owner, id, revision, { proposal: null })
    await this.record(owner, 'discard-proposal', { draftId: id, proposalId })
    return result
  }

  // ---------- 写作任务（对应 BlogStore：jobStart/jobGet/jobUpdate/jobList） ----------

  async jobStart(owner, caller, requestId, input, actor) {
    invariant(/^[\w.-]{1,80}$/.test(caller) && /^[\w-]{8,100}$/.test(requestId), '调用标识无效')
    // SELECT 先行：已受理的请求直接回既有任务（store.mjs:97-98）。
    const prior = await this.run('SELECT data, input_hash AS "inputHash" FROM blog_jobs WHERE owner=$1 AND caller=$2 AND request_id=$3', [owner, caller, requestId])
    if (prior.rows[0]) {
      invariant(prior.rows[0].inputHash === digest(input), '同一请求标识不能用于不同输入', 409)
      return { job: JSON.parse(prior.rows[0].data), fresh: false }
    }
    const job = { id: randomUUID(), owner, caller, requestId, input, actor, status: 'queued', text: '', sources: [], createdAt: Date.now(), updatedAt: Date.now() }
    // INSERT 兜底：UNIQUE(owner,caller,request_id) + ON CONFLICT DO NOTHING，并发下恰一插入；
    // 败者回读胜者记录，同一 requestId 换输入仍按 409 拒绝（对齐现状唯一约束语义）。
    const inserted = await this.run('INSERT INTO blog_jobs(id, owner, caller, request_id, input_hash, data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (owner, caller, request_id) DO NOTHING', [job.id, owner, caller, requestId, digest(input), JSON.stringify(job)])
    if ((inserted.rowCount ?? 0) === 1) return { job, fresh: true }
    const winner = await this.run('SELECT data, input_hash AS "inputHash" FROM blog_jobs WHERE owner=$1 AND caller=$2 AND request_id=$3', [owner, caller, requestId])
    const row = winner.rows[0]
    if (row === undefined) throw new StorageError('storage_unknown', '写作任务占位冲突后未能读到既有记录（不应发生）')
    invariant(row.inputHash === digest(input), '同一请求标识不能用于不同输入', 409)
    return { job: JSON.parse(row.data), fresh: false }
  }

  async jobGet(owner, id) {
    const result = await this.run('SELECT data FROM blog_jobs WHERE id=$1 AND owner=$2', [id, owner])
    invariant(result.rows[0], '任务不存在或无权访问', 404)
    return JSON.parse(result.rows[0].data)
  }

  async jobUpdate(id, patch) {
    const result = await this.run('SELECT data FROM blog_jobs WHERE id=$1', [id])
    invariant(result.rows[0], '任务不存在', 404)
    const job = { ...JSON.parse(result.rows[0].data), ...patch, updatedAt: Date.now() }
    await this.run('UPDATE blog_jobs SET data=$1 WHERE id=$2', [JSON.stringify(job), id])
    return job
  }

  async jobList(owner, draftId) {
    // 原 ORDER BY rowid DESC = 最近插入在前，seq 显式化保持同序。
    const result = await this.run('SELECT data FROM blog_jobs WHERE owner=$1 ORDER BY seq DESC LIMIT 100', [owner])
    return result.rows.map(r => JSON.parse(r.data)).filter(j => j.input.draftId === draftId).map(({ actor, owner: _owner, ...j }) => j)
  }

  // ---------- 附件（attachments.mjs 的表读写；get/list 按 owner+draftId 双路径 scope，四耦合点之 4） ----------

  async attachmentInsert(a) {
    await this.run('INSERT INTO blog_attachments(id, owner, draft_id, data) VALUES($1,$2,$3,$4)', [a.id, a.owner, a.draftId, JSON.stringify(a)])
    return a
  }

  async attachmentWrite(a) {
    await this.run('UPDATE blog_attachments SET data=$1 WHERE id=$2', [JSON.stringify(a), a.id])
    return a
  }

  /** draftId 既可以是草稿 id 也可以是会话 id（blog-chat-*）：表按原样存 scope 标识，两路同一条查询。 */
  async attachmentGet(owner, draftId, id) {
    const result = await this.run('SELECT data FROM blog_attachments WHERE owner=$1 AND draft_id=$2 AND id=$3', [owner, draftId, id])
    invariant(result.rows[0], '附件不存在或无权访问', 404)
    const a = JSON.parse(result.rows[0].data)
    invariant(a.status !== 'removed', '附件已移除', 404)
    return a
  }

  /** 返回原始记录（已滤 removed）；public() 投影留在调用方。 */
  async attachmentList(owner, draftId) {
    const result = await this.run('SELECT data FROM blog_attachments WHERE owner=$1 AND draft_id=$2 ORDER BY seq', [owner, draftId])
    return result.rows.map(r => JSON.parse(r.data)).filter(a => a.status !== 'removed')
  }

  // ---------- 译文（reasoning-translation.ts 的 translations 表读写） ----------

  /** 最近一条已完成的译文留档（cacheKey+status 索引，rowid 序取最新 → seq DESC）。 */
  async translationLatest(cacheKey) {
    const result = await this.run("SELECT data FROM blog_translations WHERE cache_key=$1 AND status='translated' ORDER BY seq DESC LIMIT 1", [cacheKey])
    return result.rows[0] ? JSON.parse(result.rows[0].data) : undefined
  }

  /**
   * 留档一次译文请求状态（原 INSERT OR REPLACE → ON CONFLICT (id) DO UPDATE）。
   * REPLACE 的行序副作用（重写行移到末尾）在单实例单飞约束下不可观测：DO UPDATE 保持
   * 插入序，「取最新 translated」的读取语义一致。
   */
  async translationWrite(id, cacheKey, owner, status, data) {
    await this.run(`INSERT INTO blog_translations(id, cache_key, owner, status, data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET cache_key=excluded.cache_key, owner=excluded.owner, status=excluded.status, data=excluded.data`,
      [id, cacheKey, owner, status, JSON.stringify(data)])
  }

  // ---------- 操作记录（application.mjs 的 operations 读写 + pendingOperations，四耦合点之 2） ----------

  async operationInsert(op) {
    await this.run('INSERT INTO blog_operations(id, owner, draft_id, revision, data) VALUES($1,$2,$3,$4,$5)', [op.id, op.owner, op.draftId, op.revision, JSON.stringify(op)])
  }

  async operation(owner, id) {
    const result = await this.run('SELECT data FROM blog_operations WHERE id=$1 AND owner=$2', [id, owner])
    invariant(result.rows[0], '操作记录不存在或无权访问', 404)
    return JSON.parse(result.rows[0].data)
  }

  async operationSave(id, value) {
    await this.run('UPDATE blog_operations SET data=$1 WHERE id=$2', [JSON.stringify(value), id])
  }

  async operations(owner) {
    const result = await this.run('SELECT data FROM blog_operations WHERE owner=$1 ORDER BY seq', [owner])
    return result.rows.map(row => JSON.parse(row.data))
  }

  /** 某草稿最近的操作（原 ORDER BY rowid DESC LIMIT 20）；返回 {id, record}，投影由调用方完成。 */
  async operationsForDraft(owner, draftId, limit = 20) {
    const result = await this.run('SELECT id, data FROM blog_operations WHERE owner=$1 AND draft_id=$2 ORDER BY seq DESC LIMIT $3', [owner, draftId, limit])
    return result.rows.map(row => ({ id: row.id, record: JSON.parse(row.data) }))
  }

  /**
   * 有待核对操作的会话 id 集合（chat-store.mjs:32 pendingOperations 的存储侧支撑，
   * 四耦合点之 2 的启动/查询镜像源）。过滤条件与原 json_extract 语义一致：
   * running/uncertain，或 expiresAt 未过的 prepared；chat.conversationId 为空的丢弃。
   */
  async pendingOperations() {
    const now = Date.now()
    const result = await this.run('SELECT data FROM blog_operations')
    const ids = new Set()
    for (const row of result.rows) {
      const op = JSON.parse(row.data)
      if (['running', 'uncertain'].includes(op.status) || (op.status === 'prepared' && op.expiresAt > now)) {
        const id = op.chat?.conversationId
        if (id) ids.add(id)
      }
    }
    return [...ids]
  }

  // ---------- 生命周期 ----------

  /** 有界关闭：等待池归位，超过 5 秒放弃等待并记录；关闭后其余操作一律拒绝。 */
  async close() {
    if (this.closed) return
    this.closed = true
    let timer
    try {
      const outcome = await Promise.race([
        this.pool.end().then(
          () => 'closed',
          error => { this.reportError(error); return 'closed' },
        ),
        new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS) }),
      ])
      if (outcome === 'timeout') this.reportError(new Error(`PostgreSQL 连接池关闭超过 ${Math.round(CLOSE_TIMEOUT_MS / 1000)} 秒，放弃等待；池终结交给进程退出`))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  assertOpen() {
    if (this.closed) throw new StorageError('storage_closed', '存储已关闭，不能继续读写')
  }

  /** 未就绪即不服务：init 失败或未先通过校验时，所有业务读写以稳定错误拒绝。 */
  assertReady() {
    this.assertOpen()
    if (this.readyError !== undefined) throw this.readyError
    if (!this.inited) throw new StorageError('storage_unknown', '存储尚未通过结构校验（init），拒绝读写')
  }

  /** 单语句执行（读或单条写）：出口统一归类稳定码。 */
  async run(text, values) {
    this.assertReady()
    try {
      return await this.pool.query(text, values)
    } catch (error) {
      throw mapStorageError(error)
    }
  }

  /** 取连接（归类取连接超时等连接故障）。 */
  async connectClient() {
    try {
      return await this.pool.connect()
    } catch (error) {
      throw mapStorageError(error)
    }
  }

  /** 单连接单事务：checkout → BEGIN → work → COMMIT，异常路径 ROLLBACK；client 在 finally 归还。 */
  async withTransaction(work) {
    this.assertReady()
    const client = await this.connectClient()
    try {
      await client.query('BEGIN')
      let result
      try {
        result = await work(client)
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // 连接已坏：ROLLBACK 失败不必处理，连接随 release 终结。
        }
        throw error
      }
      await client.query('COMMIT')
      return result
    } catch (error) {
      throw mapStorageError(error)
    } finally {
      client.release()
    }
  }
}
