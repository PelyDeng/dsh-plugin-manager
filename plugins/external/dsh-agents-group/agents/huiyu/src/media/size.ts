/**
 * 图片尺寸的解析与换算。
 *
 * 工具接受**语义化尺寸**（`square` / `landscape` / `portrait` / `banner`）与实际尺寸
 * （`1024x1024`）两种写法。换算集中在这里，是为了让"横幅固定尺寸"这类业务口径只有一个
 * 出处——散在各工具里迟早会出现"封面 1536x864、配图 1792x1024"这种没人解释得清的差异。
 *
 * ⚠️ **`size` 是"请求"，不是"结果"。** 2026-09-18 在正式渠道上量过：往中转站发
 * `1024x1024` / `1536x1024` / `1536x864`，回来的分别是 `1536x1024` / `1536x1024` / `1536x1024`，
 * 而线上第一张头图（请求 `1536x864`）落地的文件是 `2048x768` —— **渠道不按请求出图**。
 * 所以凡是要写进记录、要告诉用户或模型的尺寸，都必须用 {@link deliveredSize} 从**交付的字节**
 * 里读出来；请求值只作为"我请求了什么"留痕（`ImageRecordPayload.size`）。
 *
 * 具体像素值仍是上游模型的约束（换模型时要跟着核对），但既然上游可能不听，就不能把请求值
 * 当成结果来汇报——那会让人以为拿到的是一张 16:9 的头图，实际是 8:3。
 */

import { invalid } from '../errors.ts'

/** 尺寸语义名到具体像素的映射。 */
const SEMANTIC_SIZES: Readonly<Record<string, string>> = {
  /** 方图，适合头像与社交卡片。 */
  square: '1024x1024',
  /** 横图，适合正文配图。 */
  landscape: '1536x1024',
  /** 竖图，适合海报与手机壁纸。 */
  portrait: '1024x1536',
  /** 文章头图的固定横幅尺寸。 */
  banner: '1536x864',
}

/** 具体尺寸的形状：`<宽>x<高>`，两侧都是正整数。 */
const SIZE_PATTERN = /^(\d{2,5})x(\d{2,5})$/

/**
 * 把工具收到的尺寸参数解析成上游认识的 `宽x高`。
 *
 * @param value 语义名或具体尺寸；缺省用 `square`
 * @returns 形如 `1024x1024` 的尺寸串
 * @throws {HuiyuError} 取值既不是已知语义名，也不是合法尺寸串
 */
export function resolveSize(value: string | undefined): string {
  const raw = value?.trim()
  if (raw === undefined || raw === '') return SEMANTIC_SIZES.square as string
  const semantic = SEMANTIC_SIZES[raw.toLowerCase()]
  if (semantic !== undefined) return semantic
  const match = SIZE_PATTERN.exec(raw)
  if (match === null) {
    throw invalid(`尺寸无效：${raw}。用 ${Object.keys(SEMANTIC_SIZES).join(' / ')}，或写成 1024x1024 这样的具体像素`)
  }
  return raw
}

/** 头图/封面的固定尺寸。 */
export function bannerSize(): string {
  return SEMANTIC_SIZES.banner as string
}

/**
 * 拆出宽高。
 *
 * 用于解析**请求**尺寸（`ImageRecordPayload.size` 那一栏）。解析不出数值时返回空对象而不是
 * 报错：尺寸**已经**通过 {@link resolveSize} 校验过，这里只是顺手记一笔。
 *
 * ⚠️ 不要把它的结果当成"用户拿到的那张图多大"——渠道可能不按请求出图，见下面的
 * {@link deliveredSize}。
 */
export function dimensionsOf(size: string): { readonly width?: number; readonly height?: number } {
  const match = SIZE_PATTERN.exec(size.trim())
  if (match === null) return {}
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** 从交付的字节里读出来的真实尺寸。 */
export interface DeliveredSize {
  readonly width: number
  readonly height: number
  /** 识别出的容器格式，用于日志与记录（`png` / `jpeg` / `webp`）。 */
  readonly format: 'png' | 'jpeg' | 'webp'
}

/** 读 24 位小端整数（WebP 的 VP8X 用它存"宽-1 / 高-1"）。 */
function uint24le(view: DataView, offset: number): number {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
}

/** 读 ASCII 标记（`IHDR` / `RIFF` 这类）。 */
function ascii(view: DataView, offset: number, length: number): string {
  let text = ''
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(offset + index))
  return text
}

/**
 * 从图片字节里读出**真实**宽高。
 *
 * 只认头部，不解码像素：PNG 的 `IHDR`、JPEG 的 `SOFn`、WebP 的 `VP8X`。这三种覆盖了本渠道
 * 与 OpenAI 兼容渠道会返回的容器；认不出来的格式返回 `undefined`——**如实说"不知道"，
 * 不拿请求值顶上**，那正是这次要修掉的谎。
 *
 * @param data 图片字节
 * @returns 真实宽高与格式；无法识别时为 undefined
 */
export function deliveredSize(data: Uint8Array): DeliveredSize | undefined {
  if (data.byteLength < 16) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  // PNG：8 字节签名 + `IHDR` 块，宽高各 4 字节大端。
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && ascii(view, 12, 4) === 'IHDR') {
    return { width: view.getUint32(16), height: view.getUint32(20), format: 'png' }
  }
  // JPEG：逐段找 `SOFn`（0xC0–0xCF，其中 C4/C8/CC 是别的段）。SOFn 里高在前、宽在后。
  if (view.getUint16(0) === 0xffd8) {
    let offset = 2
    while (offset + 9 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) { offset += 1; continue }
      const marker = view.getUint8(offset + 1)
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue }
      const length = view.getUint16(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5), format: 'jpeg' }
      }
      if (length < 2) return undefined
      offset += 2 + length
    }
    return undefined
  }
  // WebP：`RIFF....WEBP` + `VP8X`（带 alpha/元数据的 WebP 才有这一块；简单有损 WebP 认不出）。
  if (view.byteLength >= 30 && ascii(view, 0, 4) === 'RIFF' && ascii(view, 8, 4) === 'WEBP' && ascii(view, 12, 4) === 'VP8X') {
    return { width: 1 + uint24le(view, 24), height: 1 + uint24le(view, 27), format: 'webp' }
  }
  return undefined
}

/** 已识别的尺寸语义名，供工具参数说明使用。 */
export function sizeNames(): readonly string[] {
  return Object.keys(SEMANTIC_SIZES)
}
