/**
 * 宿主附件服务的桥接。
 *
 * ## 两类图片走两条路
 *
 * | 场景 | 存放 | 访问方式 | 鉴权 |
 * | --- | --- | --- | --- |
 * | 生成图 | MinIO 桶 | `<publicBaseUrl>/<bucket>/<key>` 直链 | 无（公开） |
 * | 用户上传图 | 宿主附件存储 | `/agents/huiyu/images/<attachmentId>` | `huiyu:access` |
 *
 * 于是本模块只服务第二条路：把上传图读成字节交给模型，以及把生成图存进附件存储好让模型
 * 能直接看到它。**不要把用户上传的私有图倒进公开的 MinIO 桶**——那会造成数据泄露。
 *
 * ## 为什么用结构化类型而不是导入宿主包
 *
 * 群组只在运行时注入 `ctx.attachments`，本子包与宿主之间是靠**运行时形状**而不是编译期依赖
 * 连接的（与 blog 的 `AttachmentProvider` 同一取向）。写成结构化类型让测试替身不必实现整份
 * `AttachmentStore`。
 */

import { HuiyuError } from '../errors.ts'

/** 宿主图片引用的最小形状。 */
export interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/**
 * 宿主图片读取的结果。
 *
 * 字段名对齐宿主 0.1.7 的 `StoredImageAttachment { ref, data }`
 * （deepseek-harness `packages/attachment/attachment/src/types.ts:130-133`）——旧代码读
 * `attachment` 字段恒取不到，读图路由的 Content-Type 与识图元信息都退回了最小引用。
 */
export interface StoredImage {
  readonly data: Uint8Array | Buffer
  readonly ref?: ImageRef
}

/** 本模块用到的宿主附件服务面。 */
export interface AttachmentService {
  /** 写一张规范化图片，返回持久引用。 */
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string | undefined }): Promise<ImageRef>
  /** 按持久引用读回图片字节，并核验与记录一致。 */
  readImage(ref: ImageRef, signal?: AbortSignal): Promise<StoredImage>
}

/**
 * 从上下文取附件服务。
 *
 * @param ctx 宿主上下文（只要求 `get`）
 * @returns 附件服务
 * @throws {HuiyuError} 宿主未挂载附件服务——这是 503，因为缺的是运行环境而不是调用方参数
 */
export function attachmentsOf(ctx: { get(name: string): unknown }): AttachmentService {
  const service = ctx.get('attachments') as Partial<AttachmentService> | undefined
  if (typeof service?.saveImage !== 'function' || typeof service.readImage !== 'function') {
    throw new HuiyuError('unconfigured', '宿主未挂载附件服务，图片无法读写')
  }
  return service as AttachmentService
}

/**
 * 按引用读一张图片的字节。
 *
 * @param service 附件服务
 * @param attachmentId 持久引用的摘要标识
 * @param signal 取消信号
 * @returns 图片字节
 * @throws {HuiyuError} 引用不存在或不可读时按 `not_found`——**不区分"不存在"与"无权访问"**，
 *   区分它们等于给调用方一个探测他人附件的接口
 */
export async function readImageBytes(
  service: AttachmentService,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<{ readonly data: Uint8Array; readonly ref: ImageRef }> {
  // 引用在会话日志里以完整对象存在，但工具只拿得到 id。宿主的 `readImage` 要整份引用，
  // 所以这里用最小引用尝试：宿主按 `attachmentId` 定位对象并核验字节，其余字段它自己补。
  const ref = { attachmentId, mediaType: 'image/png', bytes: 0, width: 0, height: 0 } satisfies ImageRef
  let stored: StoredImage
  try {
    stored = await service.readImage(ref, signal)
  } catch (cause: unknown) {
    throw new HuiyuError('not_found', `读不到这张图片（${attachmentId}）：它可能已被清理，或不属于当前会话`, { cause })
  }
  // 宿主核验字节后回传完整引用（`StoredImageAttachment.ref`）：用它，媒体类型与尺寸才是
  // 真实值；缺失时才退回上面的最小引用（宿主类型保证有 ref，这只兜测试替身的形状）。
  return { data: toBytes(stored.data), ref: stored.ref ?? ref }
}

/** 把宿主回传的数据收成 `Uint8Array`（兼容 `Buffer` 与只读视图）。 */
function toBytes(data: Uint8Array | Buffer): Uint8Array {
  return data instanceof Uint8Array ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
}

/**
 * 把生成出来的图片写进宿主附件存储。
 *
 * 这一步的目的是**让模型能直接看到刚生成的图**：工具结果里带上图片内容块，模型下一轮就看得见，
 * 不必靠读 URL。MinIO 那份是给用户和页面用的外链，两者用途不同，所以图片存两份是刻意的。
 *
 * @param service 附件服务
 * @param data 图片字节
 * @param mediaType 媒体类型
 * @param name 展示用文件名
 * @returns 持久引用，可直接放进工具结果的内容块
 */
export async function saveGeneratedImage(
  service: AttachmentService,
  data: Uint8Array,
  mediaType: string,
  name: string,
): Promise<ImageRef> {
  try {
    return await service.saveImage({ data, mediaType, name })
  } catch (cause: unknown) {
    // 存不进附件存储不该让整次生成失败：外链已经拿到了，用户还能用地址打开。
    // 所以这里抛出可识别的错误，由调用方决定降级成"只给地址"。
    throw new HuiyuError('upstream', '生成的图片无法写入宿主附件存储，模型这一轮看不到它', { cause })
  }
}
