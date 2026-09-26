import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { Context } from '@deepseek-ai/cordis'
import { agentResource } from '@dsh-agents-group/common'
import { onRevoked } from '@dsh-plugin-manager/plugin-kit'
import { invariant } from './settings.ts'
import { ownerKey,type OwnerActor } from './store.ts'

export const MAX_ATTACHMENT_BYTES=20*1024*1024
const types: Readonly<Record<string, string>>={txt:'text',md:'markdown',markdown:'markdown',csv:'csv',json:'json',pdf:'pdf',docx:'docx',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}

/** 已解析范围（页/段/行；1 起、闭区间）。 */
export interface AttachmentRange {
  readonly from: number
  readonly to: number
}

/** 一个可选择的解析单元。 */
export interface ParsedUnit {
  readonly number: number
  readonly text: string
}

/** 解析结果（`runtime/parse-document.mjs` 的产出，与 `freeze()`/`content()` 一并交给调用方）。 */
export interface ParsedDocument {
  readonly unit: string
  readonly totalUnits: number
  readonly units: readonly ParsedUnit[]
  readonly characters: number
  readonly partial: boolean
}

/** 宿主附件服务写回的原始文件引用（本文件只把它原样交回 `readFileStream`）。 */
export type StoredOriginal = Record<string, any>

/**
 * 附件记录（业务库 `blog_attachments.payload`）。
 *
 * 前十二个键与 `store.ts` 的 `BlogAttachment` 逐字一致；`original`/`image`/`parsed` 是**附件层**
 * 写进去的，`store.ts` 有意留给了开放索引（那里的类注释写了理由）——本文件要按字段读它们，
 * 所以在这一层补上声明（`BlogAttachment` 仍然满足本类型：可选键由索引签名兜住）。
 */
export interface AttachmentRecord {
  id: string
  owner: string
  draftId: string
  name: string
  kind: string
  version: number
  status: string
  selected: boolean
  range: unknown
  createdAt: number
  bytes?: number | undefined
  message?: string | undefined
  original?: StoredOriginal | undefined
  image?: unknown
  parsed?: ParsedDocument | undefined
}

/** `public()` 的产出：对外只给这些字段（`owner`/`original`/`image`/`parsed` 不外泄）。 */
export interface PublicAttachment {
  readonly id: string
  readonly draftId: string
  readonly name: string
  readonly kind: string
  readonly version: number
  readonly status: string
  readonly selected: boolean
  readonly range: unknown
  readonly createdAt: number
  readonly bytes?: number | undefined
  readonly message?: string | undefined
  readonly unit?: string | undefined
  readonly totalUnits?: number | undefined
  readonly parsedUnits?: number | undefined
  readonly characters?: number | undefined
  readonly partial?: boolean | undefined
  readonly preview?: string | undefined
}

/** 一次资料选择（`freeze()` 的输入）：资料 id + 版本 + 可选的已解析范围。 */
export interface AttachmentSelection {
  readonly id: string
  readonly version: number
  readonly range?: AttachmentRange | null | undefined
}

/**
 * 冻结后的附件。
 *
 * 字段按**构造顺序**声明；`version`/`units` 等按可选写，是为了让 `chat.ts:642` 那份同名的局部
 * `FrozenAttachment`（`units` 必填、无 `version`）能与本类型互相比较 —— 那里的 `as` 只做收窄。
 */
export interface FrozenAttachment {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly units?: readonly ParsedUnit[] | undefined
  readonly version?: number | undefined
  readonly range?: AttachmentRange | null | undefined
  readonly unit?: string | undefined
  readonly partial?: boolean | undefined
  readonly image?: unknown
  readonly original?: StoredOriginal | undefined
}

/** 宿主附件服务在本文件里用到的面（`@deepseek-ai/dsh-attachment` 的 `AttachmentStore` 满足）。 */
export interface AttachmentProvider {
  saveFileStream(input: { data: AsyncIterable<Uint8Array>; name: string; signal?: AbortSignal | undefined }): Promise<StoredOriginal>
  /** 只处理图片资料时才会用到；测试替身按需给（见 `attachments.test.ts` 的 `Partial<AttachmentProvider>`）。 */
  saveImage?(input: { data: Uint8Array; mediaType: string; name?: string | undefined }): Promise<unknown>
}

/** 原文读取面（`readOriginal` 只用这一个方法）。 */
export interface OriginalReader {
  readFileStream(ref: StoredOriginal, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/** 本服务用到的宿主面：effect 注册、服务查询、原文读取（`Context` 与测试夹具的部分替身都满足）。 */
export interface AttachmentContext {
  /**
   * 注册一个随 fiber 释放的副作用。
   *
   * 回调的返回值按宿主口径是 `Disposable`（cordis 的 `SyncEffect`），本文件只关心"注册成功"这件事
   * ⇒ 收成 `unknown`：这样 `Context`（`() => SyncEffect`）与测试夹具（`() => unknown`）两边都成立。
   */
  effect(execute: () => unknown): unknown
  get(name: string): AttachmentProvider | undefined
  /** `readOriginal` 走属性访问（`index.ts` 与 `chat.ts` 传的就是 `ctx.attachments`）。 */
  readonly attachments: OriginalReader
}

/** 访问校验面（kit 的 `Access` 与测试夹具的 `{assert(){}}` 都满足；方法参数按双变检查）。 */
export interface AttachmentAccess {
  assert(actor: OwnerActor): void
}

/** 本文件用到的业务存储面（`BlogStore` 与 `BlogPgStorage` 都满足）。 */
export interface AttachmentStorage {
  get(owner: string, id: string): Promise<unknown>
  attachmentInsert(a: AttachmentRecord): Promise<AttachmentRecord>
  attachmentWrite(a: AttachmentRecord): Promise<AttachmentRecord>
  attachmentGet(owner: string, draftId: string, id: string): Promise<AttachmentRecord>
  attachmentList(owner: string, draftId: string): Promise<AttachmentRecord[]>
  attachmentRaw(id: string): Promise<AttachmentRecord | undefined>
  record(owner: string, action: string, data: unknown): Promise<void>
}

/** 一次上传/解析的在途作业（`guard()`/`close()`/`recheck()` 用它取消与等待）。 */
interface UploadJob {
  readonly actor: OwnerActor
  readonly a: AttachmentRecord
  readonly abort: AbortController
  worker: Worker | null
  done: Promise<void> | null
  parseError?: string | undefined
}

/** `readOriginal` 的第二个参数：`name` + 已保存的原文件引用。 */
interface OriginalReference {
  readonly name: string
  readonly original?: StoredOriginal | undefined
}

/**
 * 附件存业务库（PG；表结构与中断翻转由存储 init 序列负责）。
 *
 * 四耦合点之 4：`assertScope` 是异步谓词——会话路径（blog-chat-*）由索引侧同步核验，
 * 草稿路径由业务存储侧核验（storage.get 的 404 口径不变），get/list 因此异步化。
 */
export class BlogAttachments {
  // `declare` 只声明类型，**不产生任何运行时代码**：赋值仍由构造函数里那行 `Object.assign` 完成
  // （与 `application.ts` 的 `declare readonly …` 同一写法）。
  declare readonly ctx: AttachmentContext
  declare readonly access: AttachmentAccess
  declare readonly storage: AttachmentStorage
  /** 归属 + 可见性判定：草稿路径是业务存储的 `get`，会话路径是索引侧的 `assertScope`（缺省即前者）。 */
  declare readonly assertScope: (owner: string, id: string) => unknown
  declare readonly active: Map<string, UploadJob>
  declare closed: boolean
  constructor(ctx: AttachmentContext,access: AttachmentAccess,storage: AttachmentStorage,assertScope: (owner: string, id: string) => unknown = async(owner: string,id: string)=>storage.get(owner,id)) {
    Object.assign(this,{ctx,access,storage,assertScope});this.active=new Map();this.closed=false
    // `onRevoked` 的形参是完整 `Context`（kit 的签名），而测试夹具传的是只带 `on`/`effect` 的部分替身
    // ⇒ 按"运行期确实是 Context"收窄一次（取值与调用顺序不变）。
    ctx.effect(()=>onRevoked(ctx as Context,()=>this.recheck()))
    ctx.effect(()=>{const timer=setInterval(()=>this.recheck(),1000);timer.unref();return()=>clearInterval(timer)})
  }
  async write(a: AttachmentRecord): Promise<AttachmentRecord> {return this.storage.attachmentWrite(a)}
  async get(actor: OwnerActor,draftId: string,id: string): Promise<AttachmentRecord> {this.access.assert(actor);await this.assertScope(ownerKey(actor),draftId);return this.storage.attachmentGet(ownerKey(actor),draftId,id)}
  public(a: AttachmentRecord): PublicAttachment {const {owner,original,image,parsed,...safe}=a;return {...safe,unit:parsed?.unit,totalUnits:parsed?.totalUnits,parsedUnits:parsed?.units.length,characters:parsed?.characters,partial:parsed?.partial,preview:parsed?.units.slice(0,3).map((u: ParsedUnit)=>u.text).join('\n').slice(0,300)}}
  async list(actor: OwnerActor,draftId: string): Promise<PublicAttachment[]> {this.access.assert(actor);await this.assertScope(ownerKey(actor),draftId);return (await this.storage.attachmentList(ownerKey(actor),draftId)).map(a=>this.public(a))}
  recheck(): void {for(const job of this.active.values()){try{this.access.assert(job.actor)}catch{job.abort.abort()}}}
  async guard(job: UploadJob): Promise<AttachmentRecord> {job.abort.signal.throwIfAborted();this.access.assert(job.actor);invariant(!this.closed,'附件服务正在停止',503);const a=await this.get(job.actor,job.a.draftId,job.a.id);invariant(a.version===job.a.version,'附件解析版本已变化',409);return a}
  async upload(actor: OwnerActor,draftId: string,name: string,read: (signal: AbortSignal) => Promise<Uint8Array>): Promise<PublicAttachment> {
    this.access.assert(actor);await this.assertScope(ownerKey(actor),draftId)
    invariant(!this.closed && this.active.size<2,'同时最多处理两个资料文件，请稍后重试',429)
    invariant(typeof name==='string' && name.length>0 && name.length<=180 && !/[\\/\u0000-\u001f]/.test(name),'文件名无效')
    // 扩展名取最后一段：`String.prototype.split` 至少返回一个元素，`?? ''` 只是替 `at(-1)` 的类型收窄
    //（真取到空串时 `types['']` 同样是 `undefined`，下面那条 invariant 报同一个错）。
    const kind=types[(name.split('.').at(-1)??'').toLowerCase()];invariant(kind,'支持 TXT、Markdown、CSV、JSON、PDF、DOCX、PNG、JPEG、WebP、GIF')
    invariant((await this.list(actor,draftId)).length<10,'当前草稿或对话最多选择 10 个资料文件',413)
    const a: AttachmentRecord={id:randomUUID(),owner:ownerKey(actor),draftId,name,kind,version:1,status:'uploading',selected:true,range:null,createdAt:Date.now()}
    await this.storage.attachmentInsert(a)
    const job: UploadJob={actor,a,abort:new AbortController(),worker:null,done:null};this.active.set(a.id,job)
    let finished!: () => void
    job.done=new Promise<void>(resolve=>{finished=resolve})
    try {
      const bytes=await read(job.abort.signal);await this.guard(job)
      invariant(bytes.length>0 && bytes.length<=MAX_ATTACHMENT_BYTES,'单个资料文件必须为 1 字节至 20 MiB',413)
      a.bytes=bytes.length
      const provider=this.ctx.get('attachments');invariant(provider?.saveFileStream,'宿主尚未挂载支持原文件的附件服务',503)
      a.original=await provider.saveFileStream({data:(async function*(){yield bytes})(),name,signal:job.abort.signal});await this.guard(job)
      a.status='parsing';await this.write(a)
      if(kind.startsWith('image/')) {
        // 图片路径必须由宿主规范化：替身按需给 `saveImage`（`!` 只是"这里一定有"的类型断言，
        // 真缺了仍在同一处抛 `is not a function`，与改造前逐字一致）。
        a.image=await provider.saveImage!({data:bytes,mediaType:kind,name});await this.guard(job)
        a.message=kind==='image/gif'?'模型读取规范化单帧；原 GIF 完整保留':'图片资料将发送至支持图片的模型'
      } else a.parsed=await this.parse(job,bytes)
      await this.guard(job);a.status='ready'
      if(a.parsed?.partial){a.selected=false;a.message=`仅解析前 ${a.parsed.units.length} ${a.parsed.unit}，请明确选择已覆盖范围`}
      await this.write(a);await this.storage.record(a.owner,'attachment-upload',{id:a.id,draftId,name,bytes:a.bytes})
      return this.public(a)
    } catch(error) {
      // 捕获变量是 `unknown`（`useUnknownInCatchVariables`）：本项目的解析/宿主异常都带 `code`/`message`
      //（`BlogError`），按字段收窄一次（与 `chat.ts:835` 同一写法）。可展示错误按形状并列识别：
      // kit 访问协议（`DSH_ACCESS_ERROR`）与业务通道（`DSH_BUSINESS_ERROR`，`BlogError` 迁移后的值）。
      const failure=error as { readonly code?: string | undefined; readonly message?: string | undefined }
      const row=await this.storage.attachmentRaw(a.id)
      if(row && row.status!=='removed')await this.write({...a,status:'failed',selected:false,message:job.abort.signal.aborted?'解析已取消':failure.code==='DSH_ACCESS_ERROR'||failure.code==='DSH_BUSINESS_ERROR'?failure.message:job.parseError??'文件无法解析，请检查格式、大小或宿主附件服务'})
      throw failure.code==='DSH_ACCESS_ERROR'||failure.code==='DSH_BUSINESS_ERROR'?error:new Error('资料处理未完成；请查看附件状态')
    } finally {await job.worker?.terminate();this.active.delete(a.id);finished();this.access.assert(actor)}
  }
  async parse(job: UploadJob,bytes: Uint8Array): Promise<ParsedDocument|undefined> {
    return new Promise((resolve,reject)=>{
      const worker=new Worker(agentResource(import.meta.url,'blog','runtime/parse-document.mjs'),{workerData:{bytes,kind:job.a.kind},resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:32,stackSizeMb:4}});job.worker=worker
      let settled=false
      const finish=(error?: unknown,value?: ParsedDocument): void=>{if(settled)return;settled=true;clearTimeout(timer);job.abort.signal.removeEventListener('abort',cancel);error?reject(error):resolve(value)}
      const cancel=()=>{void worker.terminate();finish(new Error('cancelled'))}
      const timer=setTimeout(()=>{job.parseError='解析超过 30 秒，已停止';cancel()},30000)
      job.abort.signal.addEventListener('abort',cancel,{once:true})
      worker.on('message',m=>{if(m.ok)finish(null,m.result);else{job.parseError=String(m.message).slice(0,200);finish(new Error('parse'))}})
      worker.on('error',()=>finish(new Error('worker')));worker.on('exit',()=>{if(!settled)finish(new Error('worker exited'))})
      if(job.abort.signal.aborted)cancel()
    })
  }
  async select(actor: OwnerActor,draftId: string,id: string,selected: unknown,range?: AttachmentRange | null): Promise<PublicAttachment> {const a=await this.get(actor,draftId,id);invariant(typeof selected==='boolean','附件选择无效');if(range!==null&&range!==undefined)this.validateRange(a,range);a.selected=selected;a.range=range??null;return this.public(await this.write(a))}
  validateRange(a: AttachmentRecord,range: AttachmentRange): void {invariant(a.parsed && Number.isSafeInteger(range?.from) && Number.isSafeInteger(range?.to) && range.from>=1 && range.to>=range.from && range.to<=a.parsed.units.length,'所选页/段/行范围未被解析')}
  async remove(actor: OwnerActor,draftId: string,id: string): Promise<{removed: boolean}> {const a=await this.get(actor,draftId,id);this.active.get(id)?.abort.abort();await this.write({...a,status:'removed',selected:false,version:a.version+1});await this.storage.record(ownerKey(actor),'attachment-remove',{id,draftId});return {removed:true}}
  async content(actor: OwnerActor,draftId: string,id: string): Promise<PublicAttachment & { units: readonly ParsedUnit[] }> {const a=await this.get(actor,draftId,id);invariant(a.status==='ready','附件尚未就绪');return {...this.public(a),units:a.parsed?.units??[]}}
  async original(actor: OwnerActor,draftId: string,id: string) {return this.readOriginal(actor,await this.get(actor,draftId,id),async()=>this.get(actor,draftId,id))}
  async readOriginal(actor: OwnerActor,a: unknown,guard: () => unknown) {
    // `a` 收成 `unknown`：`chat.ts:1021` 传的是 `ChatStore.historyAttachment()` 的返回值，而那份声明是
    // `Promise<unknown>`（索引侧只声明到 `ChatAttachmentRef`，运行期却是冻结后的完整附件）。
    // 所以这里按结构收窄一次 —— 这就是"不得不写"的那一处，取值与改造前逐字一致。
    const record=a as OriginalReference
    await guard();invariant(record.original,'原文件尚未保存',409);const chunks: Buffer[]=[];let size=0;for await(const chunk of this.ctx.attachments.readFileStream(record.original)){this.access.assert(actor);size+=chunk.length;invariant(size<=MAX_ATTACHMENT_BYTES,'原文件超过限制',413);chunks.push(Buffer.from(chunk))}await guard();return {name:record.name,bytes:Buffer.concat(chunks)}
  }
  async freeze(actor: OwnerActor,draftId: string,selections: readonly AttachmentSelection[]=[]): Promise<FrozenAttachment[]> {
    invariant(Array.isArray(selections)&&selections.length<=10,'最多选择 10 个资料文件')
    const ids=new Set<string>();let bytes=0,chars=0
    const frozen: FrozenAttachment[]=[]
    for(const s of selections){
      invariant(s && typeof s.id==='string'&&!ids.has(s.id),'资料选择无效或重复');ids.add(s.id)
      const a=await this.get(actor,draftId,s.id);invariant(a.status==='ready','所选资料尚未完成解析',409)
      invariant(a.version===s.version,'资料版本已变化，请重新选择',409)
      /**
       * 与改造前的 `bytes += a.bytes` 在**所有**取值下逐字等价：
       * - `undefined` ⇒ `NaN`（JS 的 `number + undefined` 本来就是 `NaN`）；
       * - 其余取值（数字、**字符串**、`null`）保持 `+` 的原样规则（字符串是**拼接**、`null` 当 0）。
       * ⚠️ 两种"看起来更整齐"的写法都不等价：`Number(a.bytes)` 会把字符串从拼接改成数值相加；
       * `a.bytes ?? NaN` 会把 `null` 从"当 0"改成 `NaN`（`??` 同时顶替 `null`）。
       */
      bytes+=a.bytes===undefined?NaN:a.bytes
      if(a.parsed?.partial)invariant(s.range,'部分解析的资料必须明确选择已解析范围')
      if(s.range)this.validateRange(a,s.range)
      const units=a.parsed?.units.filter((u: ParsedUnit)=>!s.range||u.number>=s.range.from&&u.number<=s.range.to)
      chars+=units?.reduce((n: number,u: ParsedUnit)=>n+u.text.length,0)??0
      frozen.push({id:a.id,version:a.version,name:a.name,kind:a.kind,range:s.range??null,unit:a.parsed?.unit,partial:!!a.parsed?.partial,units,image:a.image,original:a.original})
    }
    invariant(bytes<=40*1024*1024,'本次资料总量超过 40 MiB，请减少选择',413)
    invariant(chars<=100000,'本次资料正文超过 100000 字符，请选择较小的页/段/行范围',413)
    return frozen
  }
  async close(): Promise<void> {this.closed=true;const jobs=[...this.active.values()];for(const j of jobs)j.abort.abort();await Promise.all(jobs.map(j=>j.done))}
}
