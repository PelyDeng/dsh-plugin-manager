import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { article, ownerKey, digest } from './store.ts'
import type { ArticleInput, BlogArticle, BlogDraft, BlogRecord, OwnerActor } from './store.ts'
import { invariant } from './settings.ts'

/** 授权校验面：本文件只用到 `Access` 的 `assert`，故按最小结构声明（测试注入 `{assert(){}}` 替身）。 */
interface AccessPort { assert(actor: OwnerActor): void }

/**
 * `Array.prototype.findLast` 在 Node 22 里有，但本包 `target: ES2022` 的 lib 里没有它的声明
 * （`tsconfig.json` 不在本次改动范围内）⇒ 在这一处按用到的签名收口一次，调用点不必逐个断言。
 */
const findLastOperation = (operations: readonly BlogOperationRecord[], predicate: (op: BlogOperationRecord) => unknown): BlogOperationRecord | undefined =>
  (operations as readonly BlogOperationRecord[] & { findLast(predicate: (op: BlogOperationRecord) => unknown): BlogOperationRecord | undefined }).findLast(predicate)

/**
 * 远端的一篇文章版本（桥接器返回、存进 `remote.published` / `remote.savedDraft`）。
 *
 * `tags` / `categories` 按**非可选**声明：`remoteArticle()` 直接 `.map()` 它们，而桥接器契约里
 * 这两个键恒在（`article()` 随后还会逐条校验）。其余键按桥接器原样透传。
 */
interface RemoteArticle {
  cid?: number
  title: string
  text: string
  slug?: string
  format?: string
  type?: string
  url?: string
  tags: readonly (string | { readonly name: string })[]
  categories: readonly (number | { readonly id: number })[]
  raw?: { views?: number; allowComment?: unknown } | null
  allowComment?: boolean
}

/**
 * 桥接器回执（`blog.call('save'|'delete'|'manage-write')` 的返回值）。
 *
 * `snapshot` 声明为非空、且 `savedDraft` 必有：唯一读它的地方是保存路径
 * （`applyResult()` 里 `op.nativeSave` 那一支），删除路径只读 `before`。
 */
interface OperationResult {
  cid?: number
  url?: string
  version?: number
  snapshot: BlogRecord & { savedDraft: RemoteArticle }
}

/** 操作载荷：`content` 是冻结的正文，`base` 是提交前的远端快照。 */
interface OperationPayload {
  content?: BlogArticle | null
  base?: BlogRecord | null
  cid?: number | undefined
  readonly [key: string]: unknown
}

/** 操作上的对话绑定（对话卡片按它归位）。 */
interface OperationChat {
  conversationId?: string
  requestId: string
  logicalId?: string
  inputHash?: string
}

/**
 * 「待确认操作」记录（`blog_operations` 的 JSON 载荷）——本文件**落库写入**用的形状。
 *
 * ⚠️ 与 `store.ts` 里同名的 `BlogOperation`（存储层的开放字典）不是一份东西：这一份是**生产方**
 * （本文件的三处 `prepare*` 与 `confirm`）写进去的形状，`title` / `mode` 在这里是必填。
 * 可空键写成 `?: T | undefined`（与 `store.ts` 的 `BlogDraft` 同一写法，理由也一样）：记录是
 * `{...old, ...patch}` 拼出来的，且字面量里就有 `sessionId: actor.sessionId` 这类表达式，
 * 而 `exactOptionalPropertyTypes` 下"可选"与"显式 undefined"是两回事。
 */
export interface BlogOperation {
  id: string
  owner: string
  draftId: string
  revision: number
  mode: string
  status: string
  title?: string | undefined
  nonce?: string | undefined
  sessionId?: string | undefined
  expiresAt: number
  createdAt: number
  payload: OperationPayload
  before?: BlogRecord | null | undefined
  proposal?: BlogRecord | null | undefined
  sources?: readonly unknown[] | undefined
  chat?: OperationChat | undefined
  result?: OperationResult | undefined
  creationKey?: string | undefined
  legacyRemote?: BlogRecord | null | undefined
  nativeSave?: boolean
  clearProposal?: boolean
  impact?: unknown
}

/**
 * **读路径**上的操作记录：核心键必填，其余键走开放索引。
 *
 * 两处对外契约（`chat.ts` 的 `OperationRecord`、`definition.ts` 的 `app.operations`）按**必填**
 * 读 `title` / `mode`，而存储类型（`store.ts` 的 `BlogOperation`）按可选声明这两者、其余业务键
 * 更是不在声明里 ⇒ 这里只固定本文件与两份契约都依赖的核心键，`payload` / `before` / `result` /
 * `chat` 等键由开放索引给出（写入方是本文件的三处 `prepare*` 与 `confirm`）。
 */
interface BlogOperationRecord {
  id: string
  owner: string
  draftId: string
  revision: number
  status: string
  /**
   * ⚠️ `title` / `mode` 按 `any` 收（三处约束卡在一起，只有它能同时成立）：
   * 存储类型按**可选**声明（`store.ts` 的 `BlogOperation`：夹具与用例只写 id/owner/draftId/…），
   * 而两份对外契约按**必填 string** 读（`chat.ts` 的 `OperationRecord` 会 `.filter((op: OperationRecord))`，
   * `definition.ts` 的 `app.operations` 也声明必填）——写成 `string` 就从存储那边不可赋值，
   * 写成 `string | undefined` 就从契约这边不可赋值。
   */
  title: any
  mode: any
  [key: string]: any
}

/** `operationsForDraft()` 的一行：操作 id + 记录（记录按存储的开放字典，`call()` 只投影几个字段）。 */
interface OperationRow { id: string; record: BlogRecord }

/** 待核对操作的进程内镜像条目。 */
interface PendingOperationEntry { readonly conversationId: string; readonly status: string; readonly expiresAt: number }

/**
 * `record()` 接受的最小形状：完整操作记录、落库前的 `{...value,id}`，或存储读回来的记录。
 *
 * 按 `BlogRecord`（开放字典）收：三处调用方分别交来字面量、`BlogOperation` 与读路径记录，
 * 它们共同的部分只有"按 id 记 status/expiresAt"，而 `chat` 的形状也不在存储类型里。
 */
type PendingOperationInput = BlogRecord

/** 待核对镜像的启动恢复来源（`restore()` 只用到这一个方法）。 */
interface PendingOperationSource { pendingOperationRecords(): Promise<readonly BlogRecord[]> }

/** `saveBlogDraft()` 的参数：正文 + 乐观并发基线（`revision`）。 */
interface SaveArgs { id: string; revision: number; content: BlogArticle }

/** `prepare()` 的参数：目标状态、基线与（可选）冻结正文 / 候选选择。 */
interface PrepareArgs {
  id: string
  revision: number
  mode: string
  /** 可空键都写成 `?: T | undefined`：`chat.ts` 的调用点就是把 `string | undefined` 直接传进来的。 */
  proposalId?: string | undefined
  nativeSave?: boolean | undefined
  detached?: boolean | undefined
  content?: BlogArticle | undefined
  clearProposal?: boolean | undefined
  creationKey?: string | undefined
}

/**
 * 业务存储：按本文件实际调用的方法面声明（`store.ts` 的 `BlogStore` 与 `storage/pg.ts` 的
 * `BlogPgStorage` 都满足）。写入类方法的载荷按 `BlogRecord` 收，因为调用方交的是字面量。
 */
interface BlogStoragePort {
  get(owner: string, id: string): Promise<BlogDraft>
  create(owner: string, initial?: ArticleInput, remote?: BlogRecord | null, blogNative?: boolean): Promise<BlogDraft>
  save(owner: string, id: string, revision: number, patch: BlogRecord): Promise<BlogDraft>
  discardProposal(owner: string, id: string, revision: number, proposalId: string): Promise<BlogDraft>
  draftRecords(owner: string): Promise<readonly BlogDraft[]>
  findByRemoteCid(owner: string, cid: number): Promise<readonly BlogDraft[]>
  record(owner: string, action: string, data: unknown): Promise<void>
  jobList(owner: string, draftId: string): Promise<readonly unknown[]>
  operationsForDraft(owner: string, draftId: string, limit?: number): Promise<readonly OperationRow[]>
  /**
   * ⚠️ 读回来的操作记录在**端口这一层**只按 `any` 收：实现侧（`store.ts` 的 `BlogOperation`）把
   * `title` / `mode` 声明成**可选**，而"可选属性赋给必填属性"TS 一律拒绝（连目标写成 `any` 也拒绝，
   * 实测），所以端口不能声明成对外的 `BlogOperationRecord`。形状由本类的 `operations()` /
   * `operation()` 收口，取值点的 invariant 兜底。
   */
  operation(owner: string, id: string): Promise<any>
  operationSave(id: string, value: BlogRecord): Promise<void>
  operationInsert(op: BlogRecord): Promise<void>
  operationClaimStatus(id: string, expected: string, value: BlogRecord): Promise<boolean>
  operations(owner: string): Promise<any[]>
}

/** 博客桥接器（`connectors.ts` 的 `BlogClient`）里本文件用到的那几个面。 */
interface BlogClientPort {
  call(action: string, args?: unknown, signal?: AbortSignal): Promise<any>
  get(cid: number | undefined, signal?: AbortSignal): Promise<BlogRecord>
  list(query?: string, page?: number, signal?: AbortSignal, status?: string): Promise<any>
  search(input?: unknown, signal?: AbortSignal): Promise<any>
}

/** 图床（`connectors.ts` 的 `ImageClient`）。 */
interface ImageClientPort { upload(bytes: Buffer): Promise<unknown> }

/** 备份执行器（`connectors.ts` 的 `BackupClient`）。 */
interface BackupClientPort { call(actor: OwnerActor, action: string, input?: unknown): Promise<unknown> }

/** 附件服务（`attachments.ts` 的 `BlogAttachments`）里本文件用到的面。 */
interface AttachmentsPort {
  list(actor: OwnerActor, draftId: string): Promise<unknown>
  remove(actor: OwnerActor, draftId: string, id: string): Promise<unknown>
  select(actor: OwnerActor, draftId: string, id: string, selected: unknown, range: unknown): Promise<unknown>
  content(actor: OwnerActor, draftId: string, id: string): Promise<unknown>
}

/** 写作任务服务（`jobs.ts` 的 `BlogJobs`）里本文件用到的面。 */
interface JobsPort {
  searchDrafts(owner: string, args: unknown, signal?: AbortSignal): Promise<unknown>
  start(actor: OwnerActor, request: unknown): Promise<unknown>
  get(actor: OwnerActor, id: string): Promise<unknown>
  cancel(actor: OwnerActor, id: string): Promise<unknown>
  /** 只把远端快照投影成模型可读的文章（`jobs.ts` 的 `modelArticle`）。 */
  modelArticle(article: RemoteArticle | null | undefined): unknown
}

/** 对话绑定（页面路径的 `BlogChat` 或对话卡片用的小对象）；`prepare*` 的 `chat` 参数缺省为空。 */
interface ChatBindingPort {
  conversationId?: string
  requestId: string
  logicalId?: string
  inputHash?: string
}

/**
 * 操作卡片的投影输入：本文件的完整记录，或 `chat.ts` 的只读投影。
 *
 * 除 `id` / `mode` 外都走开放索引：`chat.ts` 的 `OperationRecord` 与业务记录在这里都只是
 * "有这几个键就算数"，`preview()` 也不改写它们。
 */
interface OperationView {
  id: string
  mode: string
  readonly [key: string]: any
}

/**
 * 待核对操作的进程内镜像（四耦合点之 2）。
 *
 * `busy()` 与 provider.list 是 kit 的同步契约，不能读业务库；镜像由**写路径**维护
 * （operationInsert/operationSave 后调用 record），启动时从业务存储恢复一次
 * （restore）。条目按操作 id 记 status/expiresAt，查询时重算会话集合——prepared 过期
 * 与状态翻转都能如实反映，与原 SQLite 直查的过滤口径一致。
 */
export class PendingOperationsMirror {
  private readonly entries: Map<string, PendingOperationEntry>
  constructor() { this.entries = new Map() }
  record(op: PendingOperationInput | null | undefined): void {
    if (op?.chat?.conversationId === undefined) return
    this.entries.set(op.id, { conversationId: op.chat.conversationId, status: op.status, expiresAt: op.expiresAt })
  }
  ids(now = Date.now()): readonly string[] {
    const ids = new Set<string>()
    for (const entry of this.entries.values())
      if (['running', 'uncertain'].includes(entry.status) || (entry.status === 'prepared' && entry.expiresAt > now)) ids.add(entry.conversationId)
    return [...ids]
  }
  async restore(storage: PendingOperationSource): Promise<this> {
    for (const op of await storage.pendingOperationRecords()) this.record(op)
    return this
  }
}

// Older bridge hashes included theme view counters. Compare full variants to retain
// existing workbench drafts across the hash upgrade without hiding actual edits.
function sameBlogContent(a: BlogRecord, b: BlogRecord) {
  const variants=(snapshot: BlogRecord)=>{
    const value=structuredClone({published:snapshot.published??null,savedDraft:snapshot.savedDraft??null})
    for(const variant of Object.values(value))if(variant?.raw)delete variant.raw.views
    return value
  }
  return isDeepStrictEqual(variants(a),variants(b))
}
function remoteArticle(source: RemoteArticle): BlogArticle {
  return article({title:source.title,text:source.text,slug:source.slug,format:source.format,tags:source.tags.map(t=>typeof t==='string'?t:t.name),categories:source.categories.map(c=>typeof c==='number'?c:c.id),...(source.raw?.allowComment!==undefined?{allowComment:!!Number(source.raw.allowComment)}:source.allowComment!==undefined?{allowComment:source.allowComment}:{})})
}

export class BlogApplication {
  // —— 装配期注入的协作者（原来是 `Object.assign(this,{...})` 动态挂的）——
  // ⚠️ `declare` 只声明类型，**不产生任何运行时代码**（赋值仍由下面那行 `Object.assign` 完成）。
  // 四个可缺省的协作者（图床 / 备份 / 写作任务 / 附件）在测试里按 null 或省略注入，用到它们的方法
  // 只在生产装配（`index.ts`）那条路上被调用；字段在这里按"用到即存在"声明。
  declare readonly storage: BlogStoragePort
  declare readonly access: AccessPort
  declare readonly blog: BlogClientPort
  declare readonly images: ImageClientPort
  declare readonly backups: BackupClientPort
  declare readonly jobs: JobsPort
  declare readonly attachments: AttachmentsPort
  declare readonly pending: PendingOperationsMirror | null
  declare mutex: Promise<unknown>
  constructor(storage: BlogStoragePort, access: AccessPort, blog: BlogClientPort | null = null, images: ImageClientPort | null = null, backups: BackupClientPort | null = null, jobs: JobsPort | null = null, attachments: AttachmentsPort | null = null, pending: PendingOperationsMirror | null = null) {
    Object.assign(this,{storage,access,blog,images,backups,jobs,attachments,pending})
    /** confirm / prepare 的「读-核-占」互斥段串行链（原 SQLite 同步段的原子性，异步化后显式化）。 */
    this.mutex = Promise.resolve()
  }
  /** 串行执行一段互斥逻辑：同实例内按到达顺序排队，失败不断链。 */
  critical<T>(section: () => T | Promise<T>): Promise<T> {
    const run = this.mutex.then(section, section)
    this.mutex = run.then(() => {}, () => {})
    return run
  }
  /**
   * 按 action 分派的 HTTP 入口。
   *
   * ⚠️ `args` 显式写成 `any`：它是 `JSON.parse` 出来的请求袋，同一参数对每个 action 要的形状都不同
   * （`{query}` / `{id,revision,content}` / `{proposalId,fields}` …），而 dispatcher 无法为同一个
   * 参数按分支收窄。写成 `BlogRecord` 也不行——索引签名类型**缺必填属性**，传给 `saveBlogDraft()`
   * 这类方法时 TS 会报 "missing the following properties"（实测），于是每个调用点都要断言一次。
   * 各分支的形状仍由各自的 `invariant` 兜住（与转 TS 之前一致）。
   */
  async call(actor: OwnerActor, action: string, args: any = {}): Promise<unknown> {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    let result: unknown
    switch(action) {
      case 'drafts': result=(await this.blog.list(args.query??'',args.page??1,undefined,'draft')).items;break
      case 'search-drafts': result=await this.jobs.searchDrafts(owner,args);break
      case 'search-articles': result=await this.blog.search(args);break
      case 'create': result=await this.createBlogDraft(actor,args.requestId);break
      case 'draft': result=await this.storage.get(owner,args.id);break
      case 'save': result=await this.saveBlogDraft(actor,args);break
      case 'apply': result=await this.applyBlogProposal(actor,args);break
      case 'migration-status': result={remaining:(await this.legacyDrafts(owner)).length};break
      case 'migrate-drafts': result=await this.migrateDrafts(actor);break
      case 'discard-proposal': result=await this.storage.discardProposal(owner,args.id,args.revision,args.proposalId);break
      case 'articles': result=await this.blog.list(args.query??'',args.page??1,undefined,args.status??'published');break
      case 'metadata': result=await this.blog.call('status');break
      case 'manage-list': result=await this.blog.call('manage-list',args);break
      case 'manage-get': result=await this.blog.call('manage-get',args);break
      case 'manage-prepare': result=await this.prepareManagement(actor,args);break
      case 'import': {
        result=await this.importDraft(actor,args.cid,args.variant);break
      }
      case 'tasks': result=await this.storage.jobList(owner,args.draftId);break
      case 'attachments': result=await this.attachments.list(actor,args.draftId);break
      case 'attachment-remove': result=await this.attachments.remove(actor,args.draftId,args.id);break
      case 'attachment-select': result=await this.attachments.select(actor,args.draftId,args.id,args.selected,args.range);break
      case 'attachment-content': result=await this.attachments.content(actor,args.draftId,args.id);break
      case 'task-start': result=await this.jobs.start(actor,{...args,callerId:'web'});break
      case 'task': result=await this.jobs.get(actor,args.id);break
      case 'task-cancel': result=await this.jobs.cancel(actor,args.id);break
      case 'prepare-delete': result=await this.prepareDelete(actor,args.cid);break
      case 'prepare': result=await this.prepare(actor,{id:args.id,revision:args.revision,mode:args.mode,proposalId:args.proposalId});break
      case 'confirm': result=await this.confirm(actor,args);break
      case 'reconcile': result=await this.reconcile(actor,args.id);break
      case 'operations': result=(await this.storage.operationsForDraft(owner,args.draftId)).map(({id,record})=>({id,status:record.status,mode:record.mode,url:record.result?.url,createdAt:record.createdAt}));break
      case 'backup-status': result=await this.backups.call(actor,'status');break
      case 'backup-run': result=await this.backups.call(actor,'run');break
      case 'backup-schedule': result=await this.backups.call(actor,'schedule',args);break
      case 'backup-verify': result=await this.backups.call(actor,'verify',args);break
      case 'backup-restore-prepare': result=await this.backups.call(actor,'restore-prepare',args);break
      case 'backup-restore-confirm': result=await this.backups.call(actor,'restore-confirm',args);break
      default: invariant(false,'不支持的博客操作',404)
    }
    this.access.assert(actor);return result
  }
  async legacyDrafts(owner: string): Promise<readonly BlogDraft[]> { return (await this.storage.draftRecords(owner)).filter(d=>!d.blogNative) }
  async commitBlogDraft(actor: OwnerActor, op: BlogOperationRecord): Promise<BlogDraft> {
    this.access.assert(actor)
    invariant(op.mode==='draft'&&op.nativeSave,'不是博客草稿保存操作',409)
    if(op.status==='succeeded')return this.storage.get(op.owner,op.draftId)
    invariant(op.status!=='running','这篇文章正在保存，请稍后重试',409)
    invariant(op.status!=='conflict','博客草稿已在其他位置修改，请重新打开并比较',409)
    // Retry the same frozen request id; the bridge receipt prevents duplicate drafts.
    op.status='prepared';op.sessionId=actor.sessionId;op.nonce=randomUUID();op.expiresAt=Date.now()+10*60*1000
    await this.operationSave(op.id,op)
    await this.confirm(actor,{id:op.id,nonce:op.nonce})
    return this.storage.get(op.owner,op.draftId)
  }
  async createBlogDraft(actor: OwnerActor, requestId: string, existing?: BlogDraft, content?: BlogArticle): Promise<BlogDraft> {
    this.access.assert(actor)
    invariant(typeof requestId==='string'&&/^[\w:-]{8,160}$/.test(requestId),'新建草稿需要有效请求标识')
    const owner=ownerKey(actor),prior=(await this.operations(owner)).find(op=>op.creationKey===requestId)
    if(prior)return this.commitBlogDraft(actor,prior)
    const status=await this.blog.call('status');this.access.assert(actor)
    invariant(status.nativeDrafts===true,'统一草稿需要更新博客桥接扩展后再使用',503)
    const concurrent=(await this.operations(owner)).find(op=>op.creationKey===requestId)
    if(concurrent)return this.commitBlogDraft(actor,concurrent)
    const d=existing??await this.storage.create(owner)
    const preview=await this.prepare(actor,{id:d.id,revision:d.revision,mode:'draft',content:content??article(d),nativeSave:true,detached:true,creationKey:requestId})
    const op=await this.operation(owner,preview.id);op.creationKey=requestId;op.legacyRemote=d.remote;await this.operationSave(op.id,op)
    return this.commitBlogDraft(actor,op)
  }
  async saveBlogDraft(actor: OwnerActor, args: SaveArgs, clearProposal = false): Promise<BlogDraft> {
    this.access.assert(actor)
    const owner=ownerKey(actor),d=await this.storage.get(owner,args.id),content=article(args.content)
    if(!d.blogNative) {
      // First save on a pre-upgrade draft migrates it in place: the frozen migration receipt
      // creates the blog draft with the editor content, and a stale receipt replay is topped
      // up by a normal save so newer edits are never lost.
      const saved=await this.createBlogDraft(actor,'migration:'+d.id,d,content)
      if(digest(article(saved))===digest(content))return saved
      return this.saveBlogDraft(actor,{...args,id:saved.id,revision:saved.revision,content},clearProposal)
    }
    const prior=findLastOperation(await this.operations(owner),op=>op.nativeSave&&op.draftId===d.id&&op.revision===args.revision&&digest(op.payload.content)===digest(content)&&!!op.clearProposal===clearProposal)
    if(prior)return this.commitBlogDraft(actor,prior)
    invariant(d.revision===args.revision,'文章已在其他窗口修改，请保留输入后重新打开',409)
    if(!clearProposal&&isDeepStrictEqual(article(d),content))return d
    const preview=await this.prepare(actor,{id:d.id,revision:d.revision,mode:'draft',content,nativeSave:true,clearProposal})
    return this.commitBlogDraft(actor,await this.operation(owner,preview.id))
  }
  async applyBlogProposal(actor: OwnerActor, args: { id: string; revision: number; proposalId: string; fields: readonly string[] }): Promise<BlogDraft> {
    const d=await this.storage.get(ownerKey(actor),args.id)
    invariant(d.proposal?.id===args.proposalId&&d.proposal.baseRevision===args.revision&&d.revision===args.revision,'AI 修改建议已变化，请重新比较',409)
    invariant(Array.isArray(args.fields)&&args.fields.length&&args.fields.every(key=>['title','text','tags','categories','allowComment'].includes(key)&&Object.hasOwn(d.proposal.fields,key)),'请选择要采用的修改字段')
    const content=article({...d,...Object.fromEntries(args.fields.map(key=>[key,d.proposal.fields[key]]))})
    return this.saveBlogDraft(actor,{...args,content},true)
  }
  async migrateDrafts(actor: OwnerActor): Promise<{ items: { id: string; cid: number | undefined }[]; remaining: number }> {
    const owner=ownerKey(actor),items=[]
    for(const d of await this.legacyDrafts(owner)) {
      this.access.assert(actor)
      const saved=await this.createBlogDraft(actor,'migration:'+d.id,d)
      items.push({id:d.id,cid:saved.remote.savedDraft.cid})
    }
    return {items,remaining:(await this.legacyDrafts(owner)).length}
  }
  /**
   * 读取一个待导入的远端版本。
   *
   * `variant` 声明为 `string | undefined`：`chat.ts` 的交由它在调用点已用 `includes(...)` 核过
   * （`args.variant ?? ''`），但那个判断没有收窄类型；本方法第一句 `invariant` 把它收成两种取值，
   * 所以下面按版本名取值时补 `?? ''`（取不到就是 `undefined`，与原先的判断结论逐字一致）。
   */
  async readImport(actor: OwnerActor, cid: number, variant: string | undefined, signal?: AbortSignal): Promise<{ source: RemoteArticle; remote: BlogRecord; variant: string | undefined }> {
    this.access.assert(actor);signal?.throwIfAborted()
    invariant(['published','savedDraft'].includes(variant??''),'请选择导入公开版或保存稿')
    const remote=await this.blog.get(cid,signal);this.access.assert(actor);signal?.throwIfAborted()
    const source=remote[variant??''];invariant(source,'所选版本不存在',404)
    return{source,remote,variant}
  }
  /**
   * 导入按 cid 幂等去重（四耦合点之 1 的 PG 侧半步）：命中已导入的原生稿直接复用，
   * 不创建第二份。绑定两步化后，“PG 建稿成功、索引 updateRequest 失败”的重试靠这里收敛；
   * 远端内容漂移（sameBlogContent 不匹配）时会按现状生成新副本——残余窗口已在方案 §2.1
   * 声明，由绑定并发重试用例按现行语义断言，不加守卫。
   */
  async importSnapshot(actor: OwnerActor, {source,remote,variant}: { source: RemoteArticle; remote: BlogRecord; variant: string | undefined }, cid: number): Promise<BlogDraft> {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    for(const existing of await this.storage.findByRemoteCid(owner,cid)){
      if(existing.remote.selectedVariant===variant&&sameBlogContent(existing.remote,remote))return existing
    }
    const result=await this.storage.create(owner,remoteArticle(source),{...remote,selectedVariant:variant},true)
    await this.storage.record(owner,'import',{draftId:result.id,cid,variant});return result
  }
  async importDraft(actor: OwnerActor, cid: number, variant: string | undefined): Promise<BlogDraft> {return this.importSnapshot(actor,await this.readImport(actor,cid,variant),cid)}
  async operation(owner: string, id: string): Promise<BlogOperationRecord> { return this.storage.operation(owner,id) }
  async operationSave(id: string, value: BlogOperationRecord): Promise<BlogOperationRecord> { await this.storage.operationSave(id,value);this.pending?.record({...value,id});return value }
  async operationInsert(op: BlogOperation): Promise<BlogOperation> { await this.storage.operationInsert(op);this.pending?.record(op);return op }
  async operations(owner: string): Promise<BlogOperationRecord[]> { return this.storage.operations(owner) }
  async assertPending(owner: string, draftId: string, remoteCid?: number | null, except?: string): Promise<void> {
    invariant(!(await this.operations(owner)).some(op=>op.id!==except&&['running','uncertain'].includes(op.status)&&(op.draftId===draftId||remoteCid&&(op.before?.published?.cid??op.before?.savedDraft?.cid)===remoteCid)), '同一文章已有提交待核对，不能重复操作',409)
  }
  preview(op: OperationView) {
    if(op.mode==='manage')return {id:op.id,nonce:op.nonce,expiresAt:op.expiresAt,mode:op.mode,title:op.title,management:op.payload,impact:op.impact}
    return {id:op.id,nonce:op.nonce,expiresAt:op.expiresAt,mode:op.mode,title:op.title??op.payload.content?.title??'',before:op.before?.published?this.jobs.modelArticle(op.before.published):null,after:op.payload.content??null,hasSavedDraft:!!op.before?.savedDraft,sources:op.sources??[],source:op.proposal?'proposal':'draft',deletedArticles:op.mode==='delete'?[op.before.published,op.before.savedDraft].filter(Boolean).map(p=>({cid:p.cid,title:p.title,type:p.type})):[]}
  }
  async prepareManagement(actor: OwnerActor, args: BlogRecord, signal?: AbortSignal, chat?: ChatBindingPort) {
    this.access.assert(actor);signal?.throwIfAborted()
    const data=await this.blog.call('manage-preview',args,signal)
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor),draftId=`manage:${data.input.kind}:${data.input.id??'new'}`
    const op={id:randomUUID(),owner,draftId,revision:0,mode:'manage',title:data.title,payload:data.input,impact:data.impact,chat,status:'prepared',nonce:randomUUID(),sessionId:actor.sessionId,expiresAt:Date.now()+600000,createdAt:Date.now()}
    await this.critical(async()=>{await this.assertPending(owner,draftId);await this.operationInsert(op)})
    return this.preview(op)
  }
  async prepare(actor: OwnerActor, args: PrepareArgs, signal?: AbortSignal, chat?: ChatBindingPort) {
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor), d=await this.storage.get(owner,args.id)
    invariant(d.revision===args.revision,'草稿已变化，请重新预览',409)
    invariant(['draft','publish'].includes(args.mode),'目标状态无效')
    invariant(!args.nativeSave||args.mode==='draft','自动保存仅适用于博客草稿')
    invariant(args.nativeSave&&args.detached||!d.remote?.deleted,'博客原文已删除；如需重新发布，请明确创建新文章',409)
    const proposal=args.proposalId?d.proposal:null
    if(args.proposalId)invariant(proposal?.id===args.proposalId&&proposal.baseRevision===d.revision,'候选稿已变化，请重新选择并预览',409)
    const content=article(args.nativeSave?args.content:proposal?{...d,...proposal.fields}:d)
    if(args.mode==='publish')invariant(content.title.trim() && content.text.trim(),'标题和正文不能为空')
    await this.assertPending(owner,d.id,d.remote?.published?.cid??d.remote?.savedDraft?.cid)
    let remote=null
    if(d.remote&&!args.detached) {
      remote=await this.blog.get(d.remote.published?.cid??d.remote.savedDraft?.cid,signal)
      invariant(remote.version===d.remote.version||sameBlogContent(remote,d.remote),'博客内容或设置已有变化，当前改稿已保留，请重新导入比较',409)
      remote.selectedVariant=d.remote.selectedVariant??(remote.savedDraft?'savedDraft':'published')
    }
    this.access.assert(actor);signal?.throwIfAborted()
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId:d.id,revision:d.revision,mode:args.mode,status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),title:content.title,payload:{content,base:remote},before:remote,proposal,sources:proposal?.sources??d.sources,...(chat?{chat}:{}),...(args.nativeSave?{nativeSave:true,clearProposal:args.clearProposal===true,...(args.creationKey?{creationKey:args.creationKey}:{})}:{})}
    await this.critical(async()=>{await this.assertPending(owner,d.id,d.remote?.published?.cid??d.remote?.savedDraft?.cid);await this.operationInsert(op)})
    return this.preview(op)
  }
  async prepareDelete(actor: OwnerActor, cid: number | undefined, signal?: AbortSignal, chat?: ChatBindingPort) {
    this.access.assert(actor);signal?.throwIfAborted()
    const status=await this.blog.call('status',{},signal)
    invariant(status.deleteArticle===true,'博客桥接扩展尚未支持删除，请先更新 DshBlogBridge',503)
    const remote=await this.blog.get(cid,signal),rootCid=remote.published?.cid??remote.savedDraft?.cid
    // Deleting a child draft must never silently delete its published parent.
    invariant(cid===rootCid,'该 ID 是文章的保存稿；删除整篇文章请核对主文章 ID',409)
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor),draftId=`remote:${rootCid}`
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId,revision:0,mode:'delete',status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),title:(remote.published??remote.savedDraft).title,payload:{cid:rootCid,base:remote},before:remote,chat}
    await this.critical(async()=>{await this.assertPending(owner,draftId,rootCid);await this.operationInsert(op)})
    return this.preview(op)
  }
  async applyResult(op: BlogOperationRecord, result: OperationResult): Promise<void> {
    if(op.mode==='manage')return
    if(op.mode==='delete') {
      const ids=new Set([op.before.published?.cid,op.before.savedDraft?.cid].filter(Boolean))
      for(const d of await this.storage.draftRecords(op.owner))if(ids.has(d.remote?.published?.cid)||ids.has(d.remote?.savedDraft?.cid)){
        if(d.remote?.deleteOperationId!==op.id)await this.storage.save(op.owner,d.id,d.revision,{remote:{...d.remote,deleted:true,deletedAt:Date.now(),deleteOperationId:op.id}})
      }
      return
    }
    const d=await this.storage.get(op.owner,op.draftId)
    const nativeContent=op.nativeSave?remoteArticle(result.snapshot.savedDraft):null
    // Keep edits made while the remote request was in flight. The receipt still records success.
    if(d.revision===op.revision&&(!op.proposal||digest(d.proposal)===digest(op.proposal)))await this.storage.save(op.owner,d.id,d.revision,{remote:result.snapshot,blogNative:true,...(op.nativeSave?{...nativeContent,...(Object.hasOwn(op,'legacyRemote')?{legacyRemote:op.legacyRemote}:{})}:{}),...(op.proposal||op.clearProposal?{...(nativeContent??op.payload.content),proposal:null,sources:op.sources}: {})})
  }
  async confirm(actor: OwnerActor, args: { id: string; nonce?: string; consumeSavedDraft?: boolean }, conversationId?: string) {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    // 互斥段：读-核-占整体串行（重读权威记录），并发确认恰有一路翻成 running。
    const op=await this.critical(async()=>{
      const op=await this.storage.operation(owner,args.id)
      if(op.chat)invariant(conversationId===op.chat.conversationId,'请在原对话卡片确认该操作',403)
      if(op.status==='succeeded')return {replay:op}
      invariant(op.status==='prepared','提交已开始，请查询回执核对结果',409)
      invariant(op.nonce===args.nonce && op.sessionId===actor.sessionId && op.expiresAt>Date.now(),'确认已失效，请重新预览',409)
      if(!['delete','manage'].includes(op.mode)) {
        const d=await this.storage.get(owner,op.draftId);invariant(d.revision===op.revision,'草稿已变化，请重新预览',409)
        if(op.proposal)invariant(digest(d.proposal)===digest(op.proposal),'候选稿已变化，请重新预览',409)
      }
      if(op.before?.savedDraft && op.mode==='publish')invariant(args.consumeSavedDraft===true,'请明确确认发布会消费现有博客保存稿')
      this.access.assert(actor)
      await this.assertPending(owner,op.draftId,op.before?.published?.cid??op.before?.savedDraft?.cid,op.id)
      op.status='running';delete op.nonce
      invariant(await this.storage.operationClaimStatus(op.id,'prepared',op),'提交已开始，请查询回执核对结果',409)
      this.pending?.record(op)
      return {claimed:op}
    })
    if(op.replay!==undefined)return {status:op.replay.status,result:op.replay.result}
    const claimed=op.claimed
    await this.storage.record(owner,'submit-before',{operationId:claimed.id,draftId:claimed.draftId,mode:claimed.mode,snapshot:claimed.before,content:claimed.payload.content})
    try {
      const result=await this.blog.call(claimed.mode==='manage'?'manage-write':claimed.mode==='delete'?'delete':'save',{requestId:claimed.id,mode:claimed.mode,...claimed.payload})
      claimed.status='succeeded';claimed.result=result;await this.operationSave(claimed.id,claimed)
      await this.storage.record(owner,'submit-success',{operationId:claimed.id,version:result.version})
      await this.applyResult(claimed,result)
      this.access.assert(actor);return {status:claimed.status,result}
    } catch(error: any) {
      if(claimed.status==='succeeded')throw error
      claimed.status=error?.status===409?'conflict':'uncertain';await this.operationSave(claimed.id,claimed)
      throw error
    }
  }
  async reconcile(actor: OwnerActor, id: string) {
    this.access.assert(actor)
    const owner=ownerKey(actor),op=await this.operation(owner,id)
    if(op.status==='succeeded'){await this.applyResult(op,op.result);return {status:op.status,result:op.result}}
    invariant(['running','uncertain'].includes(op.status),'该操作不需要核对回执',409)
    const result=await this.blog.call('receipt',{requestId:op.id});this.access.assert(actor)
    if(result.status==='succeeded') {
      op.status='succeeded';op.result=result.result;await this.operationSave(id,op)
      await this.applyResult(op,result.result)
      await this.storage.record(owner,'reconciled',{operationId:id});return {status:op.status,result:op.result}
    }
    return {status:'uncertain',message:'未取得成功回执；本地稿与提交记录已保留，请核对博客后再处理'}
  }
  async upload(actor: OwnerActor, bytes: Buffer) {this.access.assert(actor);const result=await this.images.upload(bytes);this.access.assert(actor);await this.storage.record(ownerKey(actor),'upload',result);return result}
}
