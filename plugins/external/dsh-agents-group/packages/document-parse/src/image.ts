/**
 * 图片解析工具。
 *
 * ## 它做什么
 *
 * 把一张图变成一段文字：图里的文字逐字抄下来，再加上"这张图是什么"的说明。走**视觉模型**，
 * 不做本地 OCR——理由见 README「为什么用视觉模型而不是 OCR」。
 *
 * ## 什么时候会用到它
 *
 * **当前对话模型本身支持图片时，这个工具根本不该被调用**：图片作为消息的一部分直接发给模型
 * 就行，又快又不丢信息。它服务的是另一种情况——对话模型读不了图，但用户还是把图发过来了，
 * 而协调方、下游成员都需要"图里写了什么"这段文字。
 *
 * ## 为什么模型调用要由调用方注入
 *
 * 这个包不持有任何模型连接（也不该持有）。它把"提示词 + 结果处理"这两件真正通用的事留在
 * 这里，把"谁来调模型"交给调用方——一行 `VisionCall` 就够，不是一层可替换后端。
 *
 * 调用方拿到的结果与另外三个解析工具的形状一致（`ParsedDocument`），所以下游不必分类型处理。
 */

import { DocumentParseError, resolveLimits, type DocumentLimits } from './limits.ts'
import { detectDocumentKind } from './kinds.ts'
import type { ParsedDocument } from './units.ts'

/**
 * 一次"读图"调用。
 *
 * @param input 图片字节、媒体类型与提示词。
 * @returns 模型给出的文字；空串由本工具按失败处理。
 */
export type VisionCall = (input: {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly prompt: string
  readonly signal?: AbortSignal | undefined
}) => Promise<string>

/**
 * 缺省提示词。
 *
 * 写成两段是**故意的**：传统 OCR 只能给第一段，而很多图片（截图、流程图、产品照片）的价值
 * 全在第二段。让模型一次把两件事都办了，比调两次便宜也更快。
 *
 * 不写"你是一个专业的图像分析助手"这类开场：它不产生信息，只占 token。
 */
export const IMAGE_READ_PROMPT = [
  '读这张图，用中文回答，按下面两段输出：',
  '一、图里的文字：逐字抄下来，保留原有的顺序与换行；确实没有文字就写"没有文字"。',
  '二、图里的内容：这是什么（截图 / 照片 / 图表 / 表格 / 手写 / 界面等），关键信息有哪些；是表格就按行列说清楚，是图表就说清它表达的关系。',
  '不要评价图片质量，不要复述这段要求。',
].join('\n')

/** 入参：文件名、字节与（可选的）媒体类型。 */
export interface ImageReadInput {
  readonly name: string
  readonly bytes: Uint8Array
  /**
   * 媒体类型。**由调用方按字节核验后给出**，不取客户端声明；不给时只做"必须是图片"的形态检查。
   */
  readonly mediaType?: string | undefined
}

/** 读图的可选项。 */
export interface ImageReadOptions {
  readonly limits?: Partial<DocumentLimits> | undefined
  readonly signal?: AbortSignal | undefined
  /** 覆盖缺省提示词。调用方有更具体的问题时（"这张报表的合计是多少"）用自己的。 */
  readonly prompt?: string | undefined
  /** 允许的媒体类型白名单；给了就必须在里面。 */
  readonly allowedMediaTypes?: readonly string[] | undefined
}

/**
 * 读一张图。
 *
 * @throws DocumentParseError `empty` / `too_large` / `unsupported`（不是图片 / 媒体类型不在
 *   白名单）/ `no_text`（模型没给出可用内容）/ `unavailable`（模型调用失败）。
 */
export async function readImageDocument(
  input: ImageReadInput,
  vision: VisionCall,
  options: ImageReadOptions = {},
): Promise<ParsedDocument> {
  const limits = resolveLimits(options.limits)
  const bytes = input.bytes
  if (bytes.length === 0) throw new DocumentParseError('empty', '文件是空的')
  if (bytes.length > limits.maxBytes) {
    throw new DocumentParseError('too_large', `图片超过 ${Math.round(limits.maxBytes / 1024 / 1024)} MiB`)
  }
  if (detectDocumentKind(input.name, bytes) !== 'image') {
    throw new DocumentParseError('unsupported', '这份文件不是图片，读图工具处理不了')
  }
  const mediaType = input.mediaType ?? 'image/png'
  if (options.allowedMediaTypes !== undefined && !options.allowedMediaTypes.includes(mediaType)) {
    throw new DocumentParseError('unsupported', `这个部署不接受 ${mediaType} 格式的图片`)
  }
  const prompt = options.prompt ?? IMAGE_READ_PROMPT
  let answer: string
  try {
    answer = await vision({ bytes, mediaType, prompt, ...(options.signal === undefined ? {} : { signal: options.signal }) })
  } catch (error) {
    // 模型调用失败与"图里没内容"是两件事。前者可能是没配模型、没额度、连不上，
    // 报成 no_text 会让用户以为是自己的图有问题。
    throw new DocumentParseError('unavailable', `读图失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = answer.trim()
  if (text === '') {
    throw new DocumentParseError('no_text', '模型没有从这张图里读出内容')
  }
  return {
    kind: 'image',
    // 单元名与另外三个工具对齐（行/段/页/图），调用方拼"共 N 图"也说得通。
    unit: '图',
    units: [{ number: 1, text }],
    totalUnits: 1,
    characters: text.length,
    partial: false,
  }
}
