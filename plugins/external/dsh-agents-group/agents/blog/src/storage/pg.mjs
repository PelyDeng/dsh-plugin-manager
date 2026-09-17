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
 * - 记录列改 **`payload JSONB`**（见下），时间为毫秒 bigint，驱动侧回传字符串，读出按需 `Number()`。
 *
 * ## ⚠️ 库结构是**新形状**（`private-deploy/db/0001_init.sql` §5.4），不是 `data TEXT` 那一版
 *
 * 四处与前一代 DDL 不同，写 SQL 时每一条都得记住（漏一条就是运行期报错或静默错值）：
 *
 * 1. **归属是两列** `owner_namespace` + `owner_id`，不再是单个 `owner`。业务侧的 `owner` 字符串
 *    来自 `store.mjs:9` 的 `ownerKey`（`${namespace}:${userId}`），用 {@link ownerOf} 切**第一个**
 *    冒号。**不要**把它拼成一个合成串去比列。
 * 2. **载荷是 `payload JSONB`**（旧名 `data TEXT`）。写用 `$n::jsonb`；
 *    **读回来直接就是对象，不要再 `JSON.parse` 一次**（会抛 `Unexpected token o`）。
 * 3. **4 张表里有 6 个生成列**，`GENERATED ALWAYS … STORED`：`INSERT/UPDATE` 写它们报 **428C9**
 *    （不是被忽略）。它们由 `payload` 里的键派生，写路径只需保证载荷里有那个键；紧跟的
 *    `CHECK (payload ? 'x')` 会把"忘了写"变成一次**失败**而不是静默 NULL。
 *    逐列清单见 {@link DATABASE_GENERATED_COLUMNS}。**`blog_translations.status` 是唯一的例外：它是普通
 *    镜像列，必须写**（那一列不在清单里）。
 * 4. **版本行搬到了 `dsh_schema_versions`**（`plugin_id='blog'`）：`blog_schema_version` 这张表
 *    在新库里**不存在**。
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

/**
 * 每张表里**由库生成、写入即报 428C9** 的列。
 *
 * 两类都要列进来，`init()` 的形状核验与每一条 INSERT/UPDATE 的列清单都依赖它：
 * - **6 个计算生成列**（`GENERATED ALWAYS AS (payload->>…) STORED`）：`blog_drafts.title` /
 *   `updated_at`、`blog_jobs.draft_id` / `status`、`blog_operations.status`、`blog_attachments.status`；
 * - **4 个 IDENTITY 列**：`blog_jobs.seq` / `blog_operations.seq` / `blog_attachments.seq` /
 *   `blog_translations.seq`；另有 **`blog_audit.id`** 也是 IDENTITY（那张表的 INSERT 不写主键，
 *   由库铸），但它不属于"payload 派生"，所以只在这里点明、不进下面这张表。
 *
 * ⚠️ **`blog_translations.status` 是唯一的例外：它是普通镜像列，必须写**（DDL `:400-404` 写了理由：
 * 该表按 `(cache_key, status)` upsert，INSERT 时已知 status，无需从 payload 反推）。
 * DDL 原文明确"实施时**按本 DDL 为准，不要统一**"——六张表列名相同、可写性不同，统一成一套就错。
 *
 * 抄错一个字的后果是运行期 428C9，而那种报错只出现在**真正走到那条写路径**的时候。
 * 与 DDL 的对应：`0001_init.sql:273-407`。
 */
const DATABASE_GENERATED_COLUMNS = {
  blog_drafts: ['title', 'updated_at'],
  blog_jobs: ['draft_id', 'status', 'seq'],
  blog_operations: ['status', 'seq'],
  blog_audit: [],
  blog_attachments: ['status', 'seq'],
  blog_translations: ['seq'],
}

/** 多态 scope 的两支（`blog_attachments` / `blog_operations`）：**恰好一支非空**。
 *
 * `blog_attachments`：`draft_id` 指真实草稿，`conversation_id` 指会话（`blog-chat-*`，外键指向
 * `dsh_conversations`）。`blog_operations`：`draft_id` 指真实草稿，`scope_id` 指**合成 scope**
 * （`manage:<kind>:<id|new>` 来自 `application.mjs:203`、`remote:<rootCid>` 来自 `:239`）。
 * 两支各带一条 `CHECK (num_nonnulls(...) = 1)`，所以写错支不是"少一个字段"，是**整条 INSERT 失败**。
 */
const SYNTHETIC_SCOPE = /^(?:manage|remote):/
/** 会话 id 前缀（`conversation.ts` 的 `CONVERSATION_PREFIX` 里 blog 那一项）。 */
const CONVERSATION_PREFIX = 'blog-chat-'

/**
 * `owner` 字符串（`store.mjs:9` 的 `ownerKey`，形如 `user:alice`）→ 新形状的两个归属列。
 *
 * 切**第一个**冒号：与 `chat-store.ts` 的同名派生逐字一致。两个消费方各切各的、切法不同，
 * 会让"同一条会话/草稿在两处落到不同 owner 列上"，而那种漂移**在页面上完全看不出来**。
 */
function ownerOf(owner) {
  invariant(typeof owner === 'string', '归属标识无效')
  const at = owner.indexOf(':')
  // 没有冒号或冒号在开头 ⇒ 这不是 `ownerKey` 的产物。当场抛，而不是拆出一个空 namespace：
  // 空 namespace 会让归属退化成"只按 userId 比"，跨命名空间的同名用户于是共享数据。
  invariant(at > 0, `归属标识无效：${owner}`)
  return { namespace: owner.slice(0, at), id: owner.slice(at + 1) }
}

/** 有界关闭上限：超时后放弃等待并记录，池终结交给进程退出。 */
const CLOSE_TIMEOUT_MS = 5000
/** /ready 就绪探针的耗时上限：连接与查询各有界，超过即按探针失败回答。 */
const READY_PROBE_TIMEOUT_MS = 1500
/** 语句/锁上限（连接启动参数注入，见池构造）。 */
const STATEMENT_TIMEOUT_MS = 5000
const LOCK_TIMEOUT_MS = 2000

/**
 * blog 业务表的 PostgreSQL 存储。
 *
 * 用法：构造（建池）→ `init()`（版本校验 + jobs/attachments 中断翻转）→ 对外服务。
 * 校验失败或未通过校验时，其余读写一律以同一 `StorageError` 拒绝：未就绪即不服务。
 */
export class BlogPgStorage {
  constructor(dsn, onError) {
    this.dsn = dsn
    this.pool = new Pool({
      connectionString: dsn, max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000,
      // 语句/锁超时走连接启动参数（服务端 -c），不额外发 SET：'connect' 钩子里 fire-and-forget
      // 的 SET 会与该连接上的首个业务语句并发（pg 弃用警告，pg@9 起不再允许）。
      options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${LOCK_TIMEOUT_MS}`,
    })
    this.reportError = onError ?? (error => console.error('agents-group/blog: PostgreSQL 连接池错误', error))
    // 空闲连接的后台错误若无人监听会成为宿主 uncaughtException。
    this.pool.on('error', error => this.reportError(error))
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
      const versionResult = await this.pool.query('SELECT version FROM dsh_schema_versions WHERE plugin_id = $1', ['blog'])
      const versionRow = versionResult.rows[0]
      if (versionRow === undefined) throw new StorageError('storage_schema_version', "dsh_schema_versions 里没有 plugin_id='blog' 的版本行，无法确认博客数据结构版本")
      const current = Number(versionRow.version)
      if (current !== EXPECTED_SCHEMA_VERSION) throw new StorageError('storage_schema_version', `不支持的博客数据结构版本：${current}（期望 ${EXPECTED_SCHEMA_VERSION}）`)
      // 表存在性检查显式化：schema 固定 public，to_regclass 带 `public.` 前缀，不受 search_path 影响。
      const found = await this.pool.query('SELECT t.tab FROM unnest($1::text[]) AS t(tab) WHERE to_regclass(\'public.\' || t.tab) IS NOT NULL', [[...EXPECTED_TABLES]])
      const present = new Set(found.rows.map(row => row.tab))
      const missing = EXPECTED_TABLES.filter(table => !present.has(table))
      if (missing.length > 0) throw new StorageError('storage_schema_missing', `存储结构缺失，缺少表：${missing.join('、')}`)
      await this.assertShape()
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
   * **形状核验**：不等价于"表在不在"——它挡住的是"表在、但是**上一代的列**"。
   *
   * 为什么必须单独一步：旧形状（`owner` + `data TEXT`）在"表名齐全"这条判据下**完全合格**，
   * 于是 check 全过、`init()` 成功、服务开始接请求，然后每一条 SQL 都撞 `42703`
   * （column does not exist）—— 而 `mapStorageError` 把 42703 归到 `storage_unknown`，
   * 于是**每个业务请求 500**，而不是一句"结构不对、未就绪"。缺表是 503、缺列是 500，
   * 两者对运维是完全不同的动作，所以这里把后者也归到 `storage_schema_missing`。
   *
   * 核验两件事，都是"新形状必需、旧形状必无"：
   * 1. 六张表都有 `payload` 与 `owner_namespace`（旧形状分别是 `data` 与 `owner`）；
   * 2. {@link DATABASE_GENERATED_COLUMNS} 里列的每个生成列**都真的存在**（清单与 DDL 漂移时，本文件会去
   *    写一个生成列并报 428C9 —— 在启动期挡住比在上线后挡住便宜得多）。
   *
   * ⚠️ 它**不**核验列的类型与约束细节：那是 DDL 的职责，这里只回答"本文件的 SQL 能不能在这套表上跑"。
   */
  async assertShape() {
    const rows = await this.pool.query(
      `SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...EXPECTED_TABLES]],
    )
    const have = new Set(rows.rows.map(row => `${row.table}.${row.column}`))
    const absent = []
    for (const table of EXPECTED_TABLES) {
      for (const column of ['payload', 'owner_namespace', ...DATABASE_GENERATED_COLUMNS[table]]) {
        if (!have.has(`${table}.${column}`)) absent.push(`${table}.${column}`)
      }
    }
    if (absent.length > 0) {
      throw new StorageError('storage_schema_missing', `存储结构不是新形状，缺少列：${absent.join('、')}（缺 payload/owner_namespace = 这张表还是上一版的 owner + data 结构；缺生成列 = 本文件的清单与 DDL 漂移了）`)
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
      const jobs = await client.query('SELECT id, payload FROM blog_jobs')
      for (const row of jobs.rows) {
        const job = row.payload
        if (!['queued', 'running'].includes(job.status)) continue
        const failed = { ...job, status: 'failed', error: { code: 'interrupted', message: '服务已重启；保留结果，可发起新的写作任务' }, updatedAt: now }
        await client.query('UPDATE blog_jobs SET payload=$1::jsonb WHERE id=$2', [JSON.stringify(failed), row.id])
      }
      const attachments = await client.query('SELECT id, payload FROM blog_attachments')
      for (const row of attachments.rows) {
        const a = row.payload
        if (!['uploading', 'parsing'].includes(a.status)) continue
        const failed = { ...a, status: 'failed', message: '服务重启，解析已中断，请移除后重新上传' }
        await client.query('UPDATE blog_attachments SET payload=$1::jsonb WHERE id=$2', [JSON.stringify(failed), row.id])
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
          const versionResult = await client.query('SELECT version FROM dsh_schema_versions WHERE plugin_id = $1', ['blog'])
          const versionRow = versionResult.rows[0]
          if (versionRow === undefined) throw new StorageError('storage_schema_version', "dsh_schema_versions 里没有 plugin_id='blog' 的版本行，无法确认博客数据结构版本")
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
    // `blog_audit.id` 是 IDENTITY（库生成），写它报 428C9 ⇒ INSERT 列清单里没有它。
    const { namespace, id } = ownerOf(owner)
    await this.run('INSERT INTO blog_audit(at, owner_namespace, owner_id, action, payload) VALUES($1,$2,$3,$4,$5::jsonb)', [Date.now(), namespace, id, action, JSON.stringify(data)])
  }

  async create(owner, initial = {}, remote = null, blogNative = false) {
    const content = article({ title: '', text: '', slug: '', tags: [], categories: [], format: 'markdown', ...initial })
    const now = Date.now()
    const value = { id: randomUUID(), ...content, remote, blogNative, proposal: null, sources: [], revision: 1, createdAt: now, updatedAt: now, contentUpdatedAt: now }
    // ⚠️ `title` / `updated_at` 是**生成列**（`GENERATED ALWAYS … STORED`），写它们报 428C9：
    // 它们由 `payload` 里的 `title` / `updatedAt` 派生，而 `CHECK (payload ? 'title' AND
    // payload ? 'updatedAt')` 保证这两个键一定在 —— `value` 里两者都有（`article()` 兜底了 title）。
    const { namespace, id: ownerId } = ownerOf(owner)
    await this.run('INSERT INTO blog_drafts(id, owner_namespace, owner_id, revision, payload) VALUES($1,$2,$3,$4,$5::jsonb)', [value.id, namespace, ownerId, 1, JSON.stringify(value)])
    return value
  }

  async list(owner, query = '') {
    const search = String(query).trim().toLowerCase()
    const { namespace, id: ownerId } = ownerOf(owner)
    // 排序键从 `updated` 换成派生列 `updated_at`：同一个值（都来自 `payload->>'updatedAt'`）。
    const result = await this.run('SELECT payload FROM blog_drafts WHERE owner_namespace=$1 AND owner_id=$2 ORDER BY updated_at DESC', [namespace, ownerId])
    return result.rows.map(row => row.payload).filter(d => !search || d.title.toLowerCase().includes(search) || d.text.toLowerCase().includes(search)).map(draftSummary)
  }

  /** owner 名下全部草稿的完整记录（search.mjs:41 的检索入口，检索与排序在调用方）。 */
  async draftRecords(owner) {
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_drafts WHERE owner_namespace=$1 AND owner_id=$2', [namespace, ownerId])
    return result.rows.map(row => row.payload)
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
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_drafts WHERE owner_namespace=$1 AND owner_id=$2 AND id=$3', [namespace, ownerId, id])
    invariant(result.rows[0], '草稿不存在或无权访问', 404)
    return result.rows[0].payload
  }

  async save(owner, id, revision, patch) {
    const old = await this.get(owner, id)
    invariant(old.revision === revision, '草稿已在其他窗口修改，请保留当前内容后重新加载', 409)
    const now = Date.now(), contentChanged = ['title', 'text', 'slug', 'format', 'tags', 'categories', 'allowComment'].some(key => Object.hasOwn(patch, key) && !isDeepStrictEqual(old[key], patch[key]))
    const next = { ...old, ...patch, id, revision: revision + 1, updatedAt: now, contentUpdatedAt: contentChanged ? now : draftContentUpdatedAt(old), contentTimeSource: contentChanged ? 'content' : draftContentTimeSource(old) }
    // revision 条件更新守卫：并发下恰有一路 UPDATE 命中，另一路 0 行按 409 拒绝（store.mjs:68 语义）。
    // ⚠️ 旧的 `updated=$2` 没有了：新形状里 `updated_at` 是**生成列**，"更新时间"就是
    // `payload.updatedAt` 本身 —— 上面 `next.updatedAt = now` 已经写进载荷，派生列随之推进。
    // 换句话说：**改时间 = 改载荷那一个键**，单独再写一列既写不进去（428C9）也会与派生值打架。
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('UPDATE blog_drafts SET revision=$1, payload=$2::jsonb WHERE id=$3 AND owner_namespace=$4 AND owner_id=$5 AND revision=$6', [next.revision, JSON.stringify(next), id, namespace, ownerId, revision])
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
    // 这一条**不动** `revision`，也不动 `updatedAt` ⇒ 生成列 `updated_at` 保持原值，与旧实现
    // （只写 `data`、不写 `updated`）逐字同义。
    const { namespace, id: ownerId } = ownerOf(owner)
    await this.run('UPDATE blog_drafts SET payload=$1::jsonb WHERE id=$2 AND owner_namespace=$3 AND owner_id=$4', [JSON.stringify(draft), id, namespace, ownerId])
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
    const { namespace, id: ownerId } = ownerOf(owner)
    // SELECT 先行：已受理的请求直接回既有任务（store.mjs:97-98）。
    const prior = await this.run('SELECT payload, input_hash AS "inputHash" FROM blog_jobs WHERE owner_namespace=$1 AND owner_id=$2 AND caller=$3 AND request_id=$4', [namespace, ownerId, caller, requestId])
    if (prior.rows[0]) {
      invariant(prior.rows[0].inputHash === digest(input), '同一请求标识不能用于不同输入', 409)
      return { job: prior.rows[0].payload, fresh: false }
    }
    // ⚠️ 载荷里**保留** `owner` 这个业务字段：它现在与归属两列重复，但 `application.mjs` / `jobs.mjs`
    // 读的是记录里的 `job.owner`（`ownerKey(actor)` 那个串），删掉会静默改变它们的输入。
    const job = { id: randomUUID(), owner, caller, requestId, input, actor, status: 'queued', text: '', sources: [], createdAt: Date.now(), updatedAt: Date.now() }
    // INSERT 兜底：UNIQUE(owner_namespace,owner_id,caller,request_id) + ON CONFLICT DO NOTHING，
    // 并发下恰一插入；败者回读胜者记录，同一 requestId 换输入仍按 409 拒绝（对齐现状唯一约束语义）。
    // ⚠️ `draft_id` / `status` / `seq` 三列都不能写（前两个是生成列、`seq` 是 IDENTITY）：
    // `draft_id` 由 `payload->'input'->>'draftId'` 派生、`status` 由 `payload->>'status'` 派生，
    // 而 `CHECK (payload ? 'status' AND payload->'input' ? 'draftId')` 会把"载荷里没这两个键"
    // 变成**整条 INSERT 失败**，而不是让生成列静默变 NULL。
    const inserted = await this.run('INSERT INTO blog_jobs(id, owner_namespace, owner_id, caller, request_id, input_hash, payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (owner_namespace, owner_id, caller, request_id) DO NOTHING', [job.id, namespace, ownerId, caller, requestId, digest(input), JSON.stringify(job)])
    if ((inserted.rowCount ?? 0) === 1) return { job, fresh: true }
    const winner = await this.run('SELECT payload, input_hash AS "inputHash" FROM blog_jobs WHERE owner_namespace=$1 AND owner_id=$2 AND caller=$3 AND request_id=$4', [namespace, ownerId, caller, requestId])
    const row = winner.rows[0]
    if (row === undefined) throw new StorageError('storage_unknown', '写作任务占位冲突后未能读到既有记录（不应发生）')
    invariant(row.inputHash === digest(input), '同一请求标识不能用于不同输入', 409)
    return { job: row.payload, fresh: false }
  }

  async jobGet(owner, id) {
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_jobs WHERE id=$1 AND owner_namespace=$2 AND owner_id=$3', [id, namespace, ownerId])
    invariant(result.rows[0], '任务不存在或无权访问', 404)
    return result.rows[0].payload
  }

  /** 只读探测：同 (owner,caller,requestId) 的既有任务（jobs.mjs 的 429 门在 jobStart 前先看它）。 */
  async jobLookup(owner, caller, requestId) {
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_jobs WHERE owner_namespace=$1 AND owner_id=$2 AND caller=$3 AND request_id=$4', [namespace, ownerId, caller, requestId])
    return result.rows[0] === undefined ? undefined : result.rows[0].payload
  }

  async jobUpdate(id, patch) {
    const result = await this.run('SELECT payload FROM blog_jobs WHERE id=$1', [id])
    invariant(result.rows[0], '任务不存在', 404)
    const job = { ...result.rows[0].payload, ...patch, updatedAt: Date.now() }
    // 只写载荷：`status` / `draft_id` 是生成列，`patch` 改了载荷里的 `status` 就够派生列跟上。
    await this.run('UPDATE blog_jobs SET payload=$1::jsonb WHERE id=$2', [JSON.stringify(job), id])
    return job
  }

  async jobList(owner, draftId) {
    const { namespace, id: ownerId } = ownerOf(owner)
    // 原 ORDER BY rowid DESC = 最近插入在前，seq 显式化保持同序。
    const result = await this.run('SELECT payload FROM blog_jobs WHERE owner_namespace=$1 AND owner_id=$2 ORDER BY seq DESC LIMIT 100', [namespace, ownerId])
    return result.rows.map(r => r.payload).filter(j => j.input.draftId === draftId).map(({ actor, owner: _owner, ...j }) => j)
  }

  // ---------- 附件（attachments.mjs 的表读写；get/list 按 owner+draftId 双路径 scope，四耦合点之 4） ----------

  async attachmentInsert(a) {
    const { namespace, id: ownerId } = ownerOf(a.owner)
    /**
     * ⚠️ scope 是**多态**的，而且"恰好一支非空"由 `CHECK (num_nonnulls(draft_id, conversation_id) = 1)`
     * 强制：会话附件（`blog-chat-*`）落 `conversation_id`（复合外键指向 `dsh_conversations`），
     * 草稿附件落 `draft_id`（指向 `blog_drafts`）。**写错支不是"少一个字段"，是整条 INSERT 失败**。
     *
     * 判据用前缀、不去查"草稿到底在不在"：`ChatStore.assertScope` 与 `index.ts` 的双路径分流
     * 用的就是同一个前缀（`attachments.mjs:13` 的注释也是这一条），三处必须同一口径 ——
     * 两处各判一套，会让"同一个 scope 在两处落到不同列上"，而那种错法是静默的。
     */
    const conversation = typeof a.draftId === 'string' && a.draftId.startsWith(CONVERSATION_PREFIX)
    // `status` 是生成列（由 `payload->>'status'` 派生），不写；`payload ? 'status'` 由 CHECK 保证。
    await this.run(
      'INSERT INTO blog_attachments(id, owner_namespace, owner_id, draft_id, conversation_id, payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [a.id, namespace, ownerId, conversation ? null : a.draftId, conversation ? a.draftId : null, JSON.stringify(a)])
    return a
  }

  async attachmentWrite(a) {
    // scope 两列**不在这里写**：它们在插入那一刻定下，而写路径只改状态/选择/版本（`a.draftId` 不变）。
    await this.run('UPDATE blog_attachments SET payload=$1::jsonb WHERE id=$2', [JSON.stringify(a), a.id])
    return a
  }

  /**
   * draftId 既可以是草稿 id 也可以是会话 id（`blog-chat-*`）：**两列一起比**。
   *
   * 读取侧刻意用 `(draft_id = $x OR conversation_id = $x)` 而不是按前缀挑一列：恰有一支非空，
   * 所以这个 OR 与旧实现的"单列相等"**语义完全等价**，却不会因为将来多出一种 scope 形式而漏行。
   * 代价是可能走不上那两条部分索引（`…_draft` / `…_conversation`）——本表规模小、查询都带
   * owner 与 id 的等值条件，先要正确性。
   */
  async attachmentGet(owner, draftId, id) {
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_attachments WHERE owner_namespace=$1 AND owner_id=$2 AND (draft_id=$3 OR conversation_id=$3) AND id=$4', [namespace, ownerId, draftId, id])
    invariant(result.rows[0], '附件不存在或无权访问', 404)
    const a = result.rows[0].payload
    invariant(a.status !== 'removed', '附件已移除', 404)
    return a
  }

  /** 返回原始记录（已滤 removed）；public() 投影留在调用方。 */
  async attachmentList(owner, draftId) {
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_attachments WHERE owner_namespace=$1 AND owner_id=$2 AND (draft_id=$3 OR conversation_id=$3) ORDER BY seq', [namespace, ownerId, draftId])
    return result.rows.map(r => r.payload).filter(a => a.status !== 'removed')
  }

  /** 按 id 读原始记录（含 removed；attachments.mjs 上传失败路径要复核当前状态）。 */
  async attachmentRaw(id) {
    const result = await this.run('SELECT payload FROM blog_attachments WHERE id=$1', [id])
    return result.rows[0] === undefined ? undefined : result.rows[0].payload
  }

  // ---------- 译文（reasoning-translation.ts 的 translations 表读写） ----------

  /** 最近一条已完成的译文留档（cacheKey+status 索引，rowid 序取最新 → seq DESC）。 */
  async translationLatest(cacheKey) {
    const result = await this.run("SELECT payload FROM blog_translations WHERE cache_key=$1 AND status='translated' ORDER BY seq DESC LIMIT 1", [cacheKey])
    return result.rows[0] ? result.rows[0].payload : undefined
  }

  /**
   * 留档一次译文请求状态（原 INSERT OR REPLACE → ON CONFLICT (id) DO UPDATE）。
   * REPLACE 的行序副作用（重写行移到末尾）在单实例单飞约束下不可观测：DO UPDATE 保持
   * 插入序，「取最新 translated」的读取语义一致。
   *
   * ⚠️ 本表的 `status` 是**镜像列不是生成列**（DDL `:400-404` 专门写了这条例外：它按
   * `(cache_key, status)` upsert，INSERT 时已知 status，无需从 payload 反推）⇒ **必须写**。
   * 照 `blog_drafts` 那几张表的做法把它从列清单里去掉，会撞 NOT NULL。
   * `seq` 是 IDENTITY，不写。
   */
  async translationWrite(id, cacheKey, owner, status, data) {
    const { namespace, id: ownerId } = ownerOf(owner)
    await this.run(`INSERT INTO blog_translations(id, cache_key, owner_namespace, owner_id, status, payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (id) DO UPDATE SET cache_key=excluded.cache_key, owner_namespace=excluded.owner_namespace, owner_id=excluded.owner_id, status=excluded.status, payload=excluded.payload`,
      [id, cacheKey, namespace, ownerId, status, JSON.stringify(data)])
  }

  // ---------- 操作记录（application.mjs 的 operations 读写 + pendingOperations，四耦合点之 2） ----------

  async operationInsert(op) {
    const { namespace, id: ownerId } = ownerOf(op.owner)
    /**
     * ⚠️ scope 分两支（`CHECK (num_nonnulls(draft_id, NULLIF(scope_id,'')) = 1)`）：
     * **真实草稿 id** 落 `draft_id`（复合外键指向 `blog_drafts`，删草稿时级联），
     * **合成 scope**（`manage:<kind>:<id|new>` / `remote:<rootCid>`）落 `scope_id`。
     *
     * 为什么必须分开：合成 scope 指向的是**远端文章或管理对象**，不是本地草稿。塞进 `draft_id`
     * 会被复合外键判成 23503（DDL 注释里记着实测：`draft_id='manage:blog:new'` → 23503）。
     * 反过来把真实草稿放进 `scope_id` 也不是"能跑就行"：那条外键就不再生效，删草稿会留下悬垂操作，
     * 而悬垂读不出来 —— 静默。
     */
    const synthetic = typeof op.draftId === 'string' && SYNTHETIC_SCOPE.test(op.draftId)
    // `status` / `seq` 是生成列（DDL `:341-342`），不写；`payload ? 'status'` 由 CHECK 保证。
    await this.run(
      'INSERT INTO blog_operations(id, owner_namespace, owner_id, draft_id, scope_id, revision, payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [op.id, namespace, ownerId, synthetic ? null : op.draftId, synthetic ? op.draftId : '', op.revision, JSON.stringify(op)])
  }

  async operation(owner, id) {
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_operations WHERE id=$1 AND owner_namespace=$2 AND owner_id=$3', [id, namespace, ownerId])
    invariant(result.rows[0], '操作记录不存在或无权访问', 404)
    return result.rows[0].payload
  }

  async operationSave(id, value) {
    // 只写载荷：scope 两列在插入时定下，状态翻转不改 scope。
    await this.run('UPDATE blog_operations SET payload=$1::jsonb WHERE id=$2', [JSON.stringify(value), id])
  }

  /**
   * 条件状态占位（CAS）：仅当记录当前 status 仍是 `expected` 时写入 `value`。
   * 异步化后 confirm 的互斥前奏会交错（原 SQLite 同步段的原子性消失），靠这一条
   * 条件 UPDATE 保证并发下恰有一路把 prepared 翻成 running；败者按 0 行拒绝。
   *
   * 判据从 `data::jsonb->>'status'` 改为 `payload->>'status'`（载荷本来就是 jsonb）——**不读生成列**：
   * 读生成列也行，但让这条 CAS 只依赖载荷，语义就与"写入的是载荷"完全同源。
   */
  async operationClaimStatus(id, expected, value) {
    const result = await this.run("UPDATE blog_operations SET payload=$1::jsonb WHERE id=$2 AND payload->>'status'=$3", [JSON.stringify(value), id, expected])
    return (result.rowCount ?? 0) === 1
  }

  async operations(owner) {
    const { namespace, id: ownerId } = ownerOf(owner)
    const result = await this.run('SELECT payload FROM blog_operations WHERE owner_namespace=$1 AND owner_id=$2 ORDER BY seq', [namespace, ownerId])
    return result.rows.map(row => row.payload)
  }

  /** 某草稿最近的操作（原 ORDER BY rowid DESC LIMIT 20）；返回 {id, record}，投影由调用方完成。 */
  async operationsForDraft(owner, draftId, limit = 20) {
    const { namespace, id: ownerId } = ownerOf(owner)
    /**
     * ⚠️ **两列一起比**。调用方（`application.mjs:93` 的 `operations` 动作）拿到的是同一个
     * scope 字符串，它可能是真实草稿 id（插入时落 `draft_id`）也可能是合成 scope
     * （`manage:…` / `remote:…`，落 `scope_id`）。只比 `draft_id` 会让管理 / 远端操作
     * **静默查不出来**：页面显示"没有操作"，没有任何报错，而那条待核对的操作还在库里。
     * 恰有一支非空，所以这个 OR 与旧实现的"单列相等"语义完全等价。
     */
    const result = await this.run('SELECT id, payload FROM blog_operations WHERE owner_namespace=$1 AND owner_id=$2 AND (draft_id=$3 OR scope_id=$3) ORDER BY seq DESC LIMIT $4', [namespace, ownerId, draftId, limit])
    return result.rows.map(row => ({ id: row.id, record: row.payload }))
  }

  /**
   * 有待核对操作的会话 id 集合（chat-store.mjs:32 pendingOperations 的存储侧支撑，
   * 四耦合点之 2 的启动/查询镜像源）。过滤条件与原 json_extract 语义一致：
   * running/uncertain，或 expiresAt 未过的 prepared；chat.conversationId 为空的丢弃。
   *
   * ⚠️ 这里仍是**全表读 + JS 过滤**（DDL 的 `blog_operations_active` 部分索引本是为此建的）。
   * 本批只做形状切换、不做查询下推：下推要把 `expiresAt` 带进类型转换，一旦载荷里那个键
   * 形状不对就会从"这行被过滤掉"变成"整条查询报错"，那是另一个决定。**如实登记为未做的优化。**
   */
  async pendingOperations() {
    const now = Date.now()
    const result = await this.run('SELECT payload FROM blog_operations')
    const ids = new Set()
    for (const row of result.rows) {
      const op = row.payload
      if (['running', 'uncertain'].includes(op.status) || (op.status === 'prepared' && op.expiresAt > now)) {
        const id = op.chat?.conversationId
        if (id) ids.add(id)
      }
    }
    return [...ids]
  }

  /**
   * 有待核对的操作记录全量（B2-2b 接线新增）：进程内 pending 镜像启动恢复用。
   * 与 pendingOperations() 同一过滤口径，但带完整记录，镜像才能在状态翻转时自行重算。
   */
  async pendingOperationRecords() {
    const now = Date.now()
    const result = await this.run('SELECT payload FROM blog_operations')
    const records = []
    for (const row of result.rows) {
      const op = row.payload
      if (['running', 'uncertain'].includes(op.status) || (op.status === 'prepared' && op.expiresAt > now)) records.push(op)
    }
    return records
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
