/**
 * 图片尺寸的解析与换算。
 *
 * 工具接受**语义化尺寸**（`square` / `landscape` / `portrait` / `banner`）与实际尺寸
 * （`1024x1024`）两种写法。换算集中在这里，是为了让"横幅固定尺寸"这类业务口径只有一个
 * 出处——散在各工具里迟早会出现"封面 1536x864、配图 1792x1024"这种没人解释得清的差异。
 *
 * ⚠️ 具体像素值是**上游模型的约束**，不是审美选择：换模型时这里要跟着核对，因为不同模型
 * 支持的尺寸集合不同。取值不在模型支持列表里时，上游会拒绝，本模块不替它猜一个相近值。
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
 * 用于把尺寸写进业务记录。解析不出数值时返回空对象而不是报错：尺寸**已经**通过
 * {@link resolveSize} 校验过，这里只是顺手记一笔，不该因为记账失败而让整次生成失败。
 */
export function dimensionsOf(size: string): { readonly width?: number; readonly height?: number } {
  const match = SIZE_PATTERN.exec(size.trim())
  if (match === null) return {}
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** 已识别的尺寸语义名，供工具参数说明使用。 */
export function sizeNames(): readonly string[] {
  return Object.keys(SEMANTIC_SIZES)
}
