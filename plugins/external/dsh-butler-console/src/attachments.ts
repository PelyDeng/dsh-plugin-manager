/**
 * 牛马大总管工作台的附件服务。
 *
 * ## 一次上传发生了什么
 *
 * ```
 * 字节（本地上传 / URL 抓取）
 *   → 判种类（字节优先，扩展名其次）
 *   → 存进宿主的附件服务（图片走 saveImage，其余走 saveFileStream）
 *   → 解析成文字（纯文本 / PDF / DOCX 各自一件工具；图片先不读）
 *   → 落一行索引（`butler_attachments`）
 *   → 交回一份可展示的记录
 * ```
 *
 * ## 三条设计口径
 *
 * 1. **字节不进程**：本体按内容寻址存在宿主的附件服务里，这里只留引用。自建 BLOB 列等于把
 *    官方能力再写一遍，还要多一次摘要校验的实现。
 * 2. **图片先不读**：当前对话模型支持图片时，图片直接进消息就行，读成文字是白花钱。所以上传
 *    只存图，等到"确实需要文字"那一刻（{@link ButlerAttachments.ensureImageText}）才读一次，
 *    读完落库复用。
 * 3. **失败留行**：解析失败不删行、也不让整个上传报错（一次选三个文件，坏一个不该全废）。
 *    记录带着 `failed` 与一句原因回到页面，用户看得见"这个文件没成、为什么"。
 *
 * ## 归属
 *
 * 每条记录都按 `(owner_namespace, owner_id)` 落库，读路径一律带 owner 条件：知道 id 也读不到
 * 别人的附件。下载路由同样按当前登录身份过滤，不靠猜测。
 */

import { randomUUID } from 'node:crypto'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import {
  detectDocumentKind,
  isDocumentParseError,
  parseDocument,
  readImageDocument,
  renderDocumentText,
  type DocumentKind,
  type ParsedDocument,
  type VisionCall,
} from '@dsh-agents-group/document-parse'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.ts'
import type { ButlerAttachmentParsed, ButlerAttachmentRecord, ButlerAttachmentStatus } from './storage/types.ts'
import { resolveVisionRoute, visionCallFor, type VisionContext } from './vision.ts'

/** 宿主附件服务在本文件里用到的面。`@deepseek-ai/dsh-attachment` 的 `AttachmentStore` 满足它。 */
export interface AttachmentProvider {
  saveFileStream(input: {
    data: AsyncIterable<Uint8Array>
    name: string
    signal?: AbortSignal | undefined
  }): Promise<unknown>
  readFileStream(ref: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>
  /** 图片必须走这一个：模型层要的是带宽高的规范化引用，`saveFileStream` 给的那个用不了。 */
  saveImage?(input: { data: Uint8Array, mediaType: string, name?: string }): Promise<ImageAttachmentRef>
  readImage?(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>
  /** 部署解析出来的图片策略；缺省表示不额外限制。 */
  readonly imageLimits?: { readonly mediaTypes: readonly string[], readonly maxImageBytes: number } | undefined
}

/** 本文件用到的存储面（`ButlerStorage` 与测试双实现都满足）。 */
export interface AttachmentStorage {
  attachmentInsert(actor: Actor, record: ButlerAttachmentRecord): Promise<void>
  attachmentWrite(actor: Actor, record: ButlerAttachmentRecord): Promise<number>
  attachment(actor: Actor, id: string): Promise<ButlerAttachmentRecord | undefined>
  attachments(actor: Actor, conversationId: string): Promise<ButlerAttachmentRecord[]>
  attachmentBind(actor: Actor, ids: readonly string[], taskId: string, conversationId: string): Promise<number>
  taskAttachments(taskId: string): Promise<ButlerAttachmentRecord[]>
}

/** 对外（页面）可见的附件字段。`original` 这类内部引用一概不给。 */
export interface PublicAttachment {
  readonly id: string
  readonly conversationId: string
  readonly name: string
  readonly kind: string
  readonly mediaType: string
  readonly bytes: number
  readonly status: ButlerAttachmentStatus
  readonly message: string
  readonly sourceUrl: string
  readonly createdAt: number
  readonly unit?: string | undefined
  readonly totalUnits?: number | undefined
  readonly characters?: number | undefined
  readonly partial?: boolean | undefined
  /** 前几段正文，供页面直接显示"它大概是什么"。 */
  readonly preview?: string | undefined
}

/** 一次上传的入参。 */
export interface UploadInput {
  readonly name: string
  readonly bytes: Uint8Array
  /** 由调用方按字节核验过的媒体类型；本地上传时是客户端声明，URL 抓取时是响应头。 */
  readonly mediaType?: string | undefined
  /** 上传时所在的会话；还没开新会话时给空串。 */
  readonly conversationId?: string | undefined
  /** 由 URL 抓取而来时的原地址。 */
  readonly sourceUrl?: string | undefined
}

/** 读图时用的解码上限：与上传上限同一口径，读回来的字节不该比存进去的还大。 */
const DOWNLOAD_CHUNK_LIMIT = 4096

export class ButlerAttachments {
  constructor(
    private readonly ctx: VisionContext,
    private readonly config: Config,
    private readonly access: Access,
    private readonly storage: AttachmentStorage,
  ) {}

  /**
   * 存一份附件并解析。
   *
   * @throws AccessError `attachment_empty`(400) / `attachment_too_large`(413) /
   *   `attachment_limit`(413，这个会话的附件数已满) / `attachment_unsupported`(415) /
   *   `attachment_store_unavailable`(503，宿主没挂附件服务)。
   */
  async upload(actor: Actor, input: UploadInput): Promise<PublicAttachment> {
    this.access.assert(actor)
    const name = normalizedName(input.name)
    const bytes = input.bytes
    if (bytes.length === 0) throw new AccessError(400, '文件是空的', 'attachment_empty')
    if (bytes.length > this.config.maxAttachmentBytes) {
      throw new AccessError(413, `单个附件不能超过 ${mib(this.config.maxAttachmentBytes)}`, 'attachment_too_large')
    }
    const conversationId = (input.conversationId ?? '').trim()
    // 会话归属**不在这里核验**：上传常常发生在会话还不存在的时候（先拖文件、再写需求），
    // 这里去建会话会让侧栏多出一堆空记录。读路径一律带 owner 条件，所以一个陌生 id 只是
    // 一个读不到的桶，不构成泄露。真正的绑定发生在受理那一轮（bindToTask）。
    //
    // 计数按**还没绑到任务**的那些算（`attachments` 的口径）：绑上去的已经发出去了，不占
    // 待发的位置。上限用"一条消息能带几个"——攒了发不出去没有意义。
    const staged = await this.storage.attachments(actor, conversationId)
    if (staged.length >= this.config.maxAttachmentsPerMessage) {
      throw new AccessError(413, `一次最多带 ${this.config.maxAttachmentsPerMessage} 个附件`, 'attachment_limit')
    }

    const kind = detectDocumentKind(name, bytes)
    const now = Date.now()
    const record: MutableAttachment = {
      id: `butler-att-${randomUUID()}`,
      conversationId,
      taskId: '',
      name,
      kind,
      mediaType: input.mediaType ?? '',
      bytes: bytes.length,
      status: 'uploading',
      message: '',
      sourceUrl: input.sourceUrl ?? '',
      original: undefined,
      parsed: undefined,
      createdAt: now,
      updatedAt: now,
    }
    // 先落行再存字节：中途崩了留下一条 `uploading` 的痕迹，比什么都没有好查。
    await this.storage.attachmentInsert(actor, record)
    const provider = this.provider()
    try {
      if (kind === 'image') {
        Object.assign(record, await this.storeImage(provider, record, bytes))
      } else {
        record.original = await provider.saveFileStream({
          data: (async function* () { yield bytes })(),
          name,
        })
        Object.assign(record, await this.parseInto(record, bytes))
      }
    } catch (error) {
      // 存字节失败（宿主服务坏了 / 图片被部署策略拒了）：这条记录留着并标失败，页面能说清原因。
      record.status = 'failed'
      record.message = messageOf(error)
      await this.storage.attachmentWrite(actor, record)
      throw error
    }
    record.updatedAt = Date.now()
    await this.storage.attachmentWrite(actor, record)
    return this.public(record)
  }

  /** 从 URL 抓取后走同一条存储与解析路径。抓取本身在 `fetch-url.ts`（有界 + 地址校验）。 */
  async uploadFromUrl(actor: Actor, input: {
    readonly url: string
    readonly name?: string | undefined
    readonly mediaType?: string | undefined
    readonly bytes: Uint8Array
    readonly conversationId?: string | undefined
  }): Promise<PublicAttachment> {
    return await this.upload(actor, {
      name: input.name === undefined || input.name === '' ? '下载的内容' : input.name,
      bytes: input.bytes,
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      sourceUrl: input.url,
    })
  }

  /** 这个会话下还没删除的附件，按创建时间倒序。 */
  async list(actor: Actor, conversationId: string): Promise<PublicAttachment[]> {
    this.access.assert(actor)
    const records = await this.storage.attachments(actor, (conversationId ?? '').trim())
    return records.map(record => this.public(record))
  }

  /** 标记删除。字节本体不删（宿主附件服务没有删除接口），留下的是引用与一行记录。 */
  async remove(actor: Actor, id: string): Promise<void> {
    this.access.assert(actor)
    const record = await this.require(actor, id)
    await this.storage.attachmentWrite(actor, { ...record, status: 'removed', updatedAt: Date.now() })
  }

  /** 读回原文件字节，供下载路由用。 */
  async download(actor: Actor, id: string): Promise<{ name: string, mediaType: string, bytes: Uint8Array }> {
    this.access.assert(actor)
    const record = await this.require(actor, id)
    return { name: record.name, mediaType: record.mediaType, bytes: await this.readOriginal(record) }
  }

  /**
   * 把一批附件绑到刚落库的任务上。
   *
   * @returns 真正被改写的行数；调用方据此核对"是不是都绑上了"——少绑一条意味着那一步的派单
   *   简报里看不到这份材料，而用户以为它已经交出去了。
   */
  async bindToTask(actor: Actor, ids: readonly string[], taskId: string, conversationId: string): Promise<number> {
    if (ids.length === 0) return 0
    return await this.storage.attachmentBind(actor, ids, taskId, conversationId)
  }

  /**
   * 校验一批附件 id 并取回记录（顺序与传入一致）。
   *
   * @throws AccessError `attachment_not_found`(404)：有一个 id 不存在、不属于这个人、或已被删除。
   *   整批拒绝而不是悄悄跳过——跳过一个附件会让用户以为文件交出去了。
   */
  async select(actor: Actor, ids: readonly string[]): Promise<ButlerAttachmentRecord[]> {
    this.access.assert(actor)
    if (ids.length === 0) return []
    if (ids.length > this.config.maxAttachmentsPerMessage) {
      throw new AccessError(413, `一次最多带 ${this.config.maxAttachmentsPerMessage} 个附件`, 'attachment_limit')
    }
    const unique = [...new Set(ids)]
    if (unique.length !== ids.length) throw new AccessError(400, '附件重复', 'attachment_duplicate')
    const records: ButlerAttachmentRecord[] = []
    for (const id of unique) records.push(await this.require(actor, id))
    return records
  }

  /**
   * 把附件整理成提示词与派单简报里的一段文字。
   *
   * 图片**不在这里读**：调用方先判断当前模型能不能收图片，不能收才调
   * {@link ButlerAttachments.ensureImageText}。这样多模态的那条路上一次模型调用都不多花。
   */
  async promptBlock(records: readonly ButlerAttachmentRecord[], limit: number): Promise<string> {
    if (records.length === 0) return ''
    // 预算是**硬**的：它对应的是提示词与派单简报那头的长度上限，按文件数平分。
    // 不设"至少给多少字"的下限——那会让实际长度超出调用方声明的预算。
    const perFile = Math.max(1, Math.floor(limit / records.length))
    const lines: string[] = []
    for (const [index, record] of records.entries()) {
      lines.push(`【${index + 1}】${record.name}（${kindText(record)}）`)
      if (record.status === 'failed') {
        lines.push(`（这个文件没有读出来${record.message === '' ? '' : `：${record.message}`}，只能原样转交）`)
        continue
      }
      if (record.parsed !== undefined) {
        const rendered = renderDocumentText(asParsed(record.parsed), perFile)
        if (rendered.text !== '') lines.push(rendered.text)
        if (rendered.truncated) lines.push(`（上面只是这份文件的一部分，共 ${record.parsed.totalUnits} ${record.parsed.unit}）`)
        continue
      }
      if (record.kind === 'image') {
        lines.push('（这是一张图片，文字内容还没有读出来）')
        continue
      }
      lines.push(`（这个文件读不出文字，只能原样转交${record.message === '' ? '' : `：${record.message}`}）`)
    }
    return lines.join('\n')
  }

  /** 这批附件里可以当图片内容块发给模型的那些（只有已经存成图片引用的才算）。 */
  imageRefs(records: readonly ButlerAttachmentRecord[]): ImageAttachmentRef[] {
    const refs: ImageAttachmentRef[] = []
    for (const record of records) {
      if (record.kind !== 'image' || record.status !== 'ready' || record.original === undefined) continue
      refs.push(record.original as ImageAttachmentRef)
    }
    return refs
  }

  /**
   * 把还没有文字的图片读成文字并落库。
   *
   * **只在当前对话模型收不了图片时调用**。读完落库、下一轮直接复用，同一张图不会读第二次。
   * 读不出来不把附件判失败（文件本身没坏），只写一句说明。
   */
  async ensureImageText(actor: Actor, records: readonly ButlerAttachmentRecord[], signal?: AbortSignal): Promise<void> {
    const pending = records.filter(record => record.kind === 'image' && record.status === 'ready' && record.parsed === undefined)
    if (pending.length === 0) return
    const route = await resolveVisionRoute(this.ctx, this.config.visionModel)
    for (const record of pending) {
      if (route === undefined) {
        await this.write(actor, { ...record, message: '这个部署没有能读图的模型，管家看不到图里的内容' })
        continue
      }
      try {
        const bytes = await this.readOriginal(record)
        const parsed = await readImageDocument(
          { name: record.name, bytes, mediaType: record.mediaType },
          visionCallFor(this.ctx, route, record.original as ImageAttachmentRef),
          { limits: { maxBytes: this.config.maxAttachmentBytes, maxCharacters: this.config.attachmentParseChars }, signal },
        )
        await this.write(actor, { ...record, parsed: storedParsed(parsed), message: '' })
      } catch (error) {
        await this.write(actor, { ...record, message: `读图失败：${messageOf(error)}` })
      }
    }
  }

  /** 一条任务下的附件（派单时读）。 */
  async forTask(taskId: string): Promise<ButlerAttachmentRecord[]> {
    return await this.storage.taskAttachments(taskId)
  }

  /** 记录 → 可展示字段。`original` 这类内部引用一概不外泄。 */
  public(record: ButlerAttachmentRecord): PublicAttachment {
    const parsed = record.parsed
    return {
      id: record.id,
      conversationId: record.conversationId,
      name: record.name,
      kind: record.kind,
      mediaType: record.mediaType,
      bytes: record.bytes,
      status: record.status,
      message: record.message,
      sourceUrl: record.sourceUrl,
      createdAt: record.createdAt,
      ...(parsed === undefined ? {} : {
        unit: parsed.unit,
        totalUnits: parsed.totalUnits,
        characters: parsed.characters,
        partial: parsed.partial,
        preview: parsed.units.slice(0, 3).map(unit => unit.text).join('\n').slice(0, 300),
      }),
    }
  }

  /** 宿主附件服务；没挂就 503（插件仍然装载，只是上传这条路不可用）。 */
  private provider(): AttachmentProvider {
    const provider = this.ctx.get('attachments') as AttachmentProvider | undefined
    if (provider === undefined || typeof provider.saveFileStream !== 'function') {
      throw new AccessError(503, '宿主尚未挂载附件服务，暂时不能上传文件', 'attachment_store_unavailable')
    }
    return provider
  }

  private async require(actor: Actor, id: string): Promise<ButlerAttachmentRecord> {
    const record = await this.storage.attachment(actor, id)
    if (record === undefined || record.status === 'removed') {
      // 不存在、属于别人、已删除三种情况给同一个答案：不泄露存在性。
      throw new AccessError(404, '没有这个附件', 'attachment_not_found')
    }
    return record
  }

  private async write(actor: Actor, record: ButlerAttachmentRecord): Promise<void> {
    await this.storage.attachmentWrite(actor, { ...record, updatedAt: Date.now() })
  }

  /** 图片：走 `saveImage` 拿到规范化引用（模型层只认它），并在这里核验部署策略。 */
  private async storeImage(
    provider: AttachmentProvider,
    record: MutableAttachment,
    bytes: Uint8Array,
  ): Promise<Partial<MutableAttachment>> {
    if (typeof provider.saveImage !== 'function') {
      throw new AccessError(503, '宿主的附件服务不支持图片，暂时不能上传图片', 'attachment_store_unavailable')
    }
    // 类型按**字节**核验过的那个来：客户端声明的 content-type 不可信，改个扩展名是最省事的绕过。
    const mediaType = imageMediaType(bytes, record.mediaType)
    if (mediaType === undefined) {
      throw new AccessError(415, '只支持 PNG / JPEG / WebP / GIF 图片', 'attachment_unsupported')
    }
    const limits = provider.imageLimits
    if (limits !== undefined && !limits.mediaTypes.includes(mediaType)) {
      throw new AccessError(415, `这个部署不接受 ${mediaType} 格式的图片`, 'attachment_unsupported')
    }
    if (limits !== undefined && bytes.length > limits.maxImageBytes) {
      throw new AccessError(413, `图片不能超过 ${mib(limits.maxImageBytes)}`, 'attachment_too_large')
    }
    const ref = await provider.saveImage({ data: bytes, mediaType, name: record.name })
    // 媒体类型取**引用里的**那个：宿主按存下来的字节核验过，比我们判的更权威。
    return { original: ref, mediaType: ref.mediaType, status: 'ready' }
  }

  /** 文本 / PDF / DOCX：交给对应解析工具；`binary` 直接标"读不出文字"。 */
  private async parseInto(
    record: MutableAttachment,
    bytes: Uint8Array,
  ): Promise<Partial<MutableAttachment>> {
    if (record.kind === 'binary') {
      return { status: 'ready', message: '这类文件读不出文字，只能原样转交' }
    }
    try {
      const parsed = await parseDocument({ name: record.name, bytes }, {
        limits: {
          maxBytes: this.config.maxAttachmentBytes,
          maxCharacters: this.config.attachmentParseChars,
        },
      })
      return {
        parsed: storedParsed(parsed),
        status: 'ready',
        message: parsed.partial
          ? `只读了前 ${parsed.units.length} ${parsed.unit}，共 ${parsed.totalUnits} ${parsed.unit}`
          : '',
      }
    } catch (error) {
      // 解析失败**不抛**：一次选三个文件，坏一个不该让另外两个也传不上去。记录带着原因回到页面，
      // 由用户决定是删掉它还是照样交出去（原文件仍然存着、能下载）。
      if (!isDocumentParseError(error)) throw error
      return { status: 'failed', message: error.message }
    }
  }

  /** 读回原文件字节。上限按上传上限再加一点余量，防止一个被换过的对象把内存吃光。 */
  private async readOriginal(record: ButlerAttachmentRecord): Promise<Uint8Array> {
    const provider = this.provider()
    if (record.original === undefined) throw new AccessError(409, '这个附件的原文件没有存下来', 'attachment_no_original')
    const limit = Math.max(record.bytes, this.config.maxAttachmentBytes)
    const chunks: Buffer[] = []
    let size = 0
    if (record.kind === 'image' && typeof provider.readImage === 'function') {
      const stored = await provider.readImage(record.original as ImageAttachmentRef)
      return new Uint8Array(stored.data)
    }
    for await (const chunk of provider.readFileStream(record.original)) {
      size += chunk.length
      if (size > limit) throw new AccessError(413, '附件超过大小上限', 'attachment_too_large')
      chunks.push(Buffer.from(chunk))
      // 分块读：宿主可能给出很小的块，这里不按块数做事，只用 `DOWNLOAD_CHUNK_LIMIT` 提醒读实现
      // 有界（真实的界是上面那个 size 检查）。
      void DOWNLOAD_CHUNK_LIMIT
    }
    return new Uint8Array(Buffer.concat(chunks))
  }
}

/**
 * 可变的附件记录。
 *
 * 存储接口把字段声明成 `readonly`（读完就不该被改），而这里要一条一条往里填，所以本地放开
 * 一次；写库前一律整条交给存储层，不存在"改了一半"的中间态外泄。
 */
type MutableAttachment = {
  -readonly [K in keyof ButlerAttachmentRecord]: ButlerAttachmentRecord[K]
}

/** 文件名清洗：去掉路径分隔与控制字符，长度封顶。名字只用于展示，**从不**当路径用。 */
export function normalizedName(raw: string): string {
  const cleaned = raw.replace(/[\\/\u0000-\u001f]/gu, '').replace(/\s+/gu, ' ').trim()
  const name = cleaned === '' ? '未命名文件' : cleaned
  return [...name].slice(0, 180).join('')
}

/** 按字节判图片类型；判不出来返回 undefined。 */
function imageMediaType(bytes: Uint8Array, declared: string): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  // 字节判不出来时**不回落**到声明值：那正是"改个扩展名"要利用的那条缝。
  void declared
  return undefined
}

/** 解析结果 → 落库形状（与解析包的 `ParsedDocument` 一一对应）。 */
function storedParsed(parsed: ParsedDocument): ButlerAttachmentParsed {
  return {
    kind: parsed.kind,
    unit: parsed.unit,
    totalUnits: parsed.totalUnits,
    characters: parsed.characters,
    partial: parsed.partial,
    units: parsed.units.map(unit => ({ number: unit.number, text: unit.text })),
  }
}

/** 落库形状 → 解析结果，供渲染复用同一份 `renderDocumentText`。 */
function asParsed(parsed: ButlerAttachmentParsed): ParsedDocument {
  return {
    kind: parsed.kind as DocumentKind,
    unit: parsed.unit,
    units: parsed.units,
    totalUnits: parsed.totalUnits,
    characters: parsed.characters,
    partial: parsed.partial,
  }
}

/** 给用户看的种类说明。 */
function kindText(record: ButlerAttachmentRecord): string {
  const labels: Readonly<Record<string, string>> = {
    text: '文本', markdown: 'Markdown', csv: 'CSV', json: 'JSON', yaml: 'YAML', xml: 'XML',
    html: '网页', pdf: 'PDF', docx: 'Word 文档', image: '图片', binary: '文件',
  }
  const label = labels[record.kind] ?? record.kind
  if (record.parsed === undefined) return `${label}，${sizeText(record.bytes)}`
  const scope = record.parsed.partial
    ? `前 ${record.parsed.units.length} ${record.parsed.unit}，共 ${record.parsed.totalUnits} ${record.parsed.unit}`
    : `共 ${record.parsed.totalUnits} ${record.parsed.unit}`
  return `${label}，${sizeText(record.bytes)}，${scope}`
}

/** 字节数的人话说法。 */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`
}

/** 错误整理成一句话；不把内部结构或本机路径带出去。 */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.replace(/[A-Za-z]:\\[^\s，。；]+/gu, '（本机路径）').replace(/\s+/gu, ' ').trim()
  return text === '' ? '处理失败' : [...text].slice(0, 200).join('')
}
