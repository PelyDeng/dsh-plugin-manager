/**
 * 交回验收（拆分 v2 批 2）：交回正文里「可交付物」的识别与验收结论提取。
 */

import type { AgentArtifact } from '@dsh-plugin-manager/plugin-kit'
import { clip } from './text.ts'

/**
 * 去掉标点与空白后的最少字数：只挡住「好」「行」这类连表态都算不上的输入。
 *
 * ⚠️ 它**不是**主要判据。早先的版本只数长度 + 比一张无信息词表，独立评审逐字重放实测
 * 两端全漏：误杀「一份表格」「一条链接」「3 个文件」这类完全可核验的短口径 13/13，
 * 同时放过「认真完成不要敷衍」「全部完成没有任何问题」这类够长却零信息的表态 12/12。
 * 降阈值也救不了——**信息量不是长度的函数**（中文 4 字既可能是「一份表格」也可能是
 * 「全部完成」）。
 */
export const ACCEPTANCE_MIN_CHARS = 4

/** 整句就是一个无信息词的情形。比较前统一小写，中英文都列上。 */
export const ACCEPTANCE_EMPTY_WORDS: readonly string[] = [
  '完成', '已完成', '做完', '做完了', '干完', '干完了', '搞定', '好了', '好的',
  '可以', '行', '没问题', '正常', '成功', '无', '没有', '随便', '你看着办',
  'ok', 'done', 'yes', 'fine',
]

/** 明确的位置：URL，或常见产物的文件名后缀。 */
export const ACCEPTANCE_LOCATOR = /https?:\/\/|[\w-]+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|tar|gz|png|jpe?g|gif|svg|md|txt|csv|json|html?)\b/iu

/**
 * 产出物名词：说明"要交什么"。
 *
 * 刻意列得宽（含"数据""记录""截图""回执"这类中间产物）：**宁可多放行一个模糊口径，
 * 也不要误杀一个明确的口径**——误杀的代价是模型被迫放弃一个本来正确的口径，
 * 而它无从知道为什么被拒。
 */
export const ACCEPTANCE_NOUN = /(稿|文章|文案|链接|地址|表格|报表|报告|清单|列表|文档|文件|附件|截图|图片|照片|图|视频|音频|数据|记录|日志|回执|凭证|签章|签名|版本|页面|接口|字段|条目|结论|方案|计划|说明书|手册|PDF|Excel|Word|URL|CSV|JSON)/iu

/** 数量：说明"交多少"。含数字（"HTTP 200""3 个文件"都在这一档）。 */
export const ACCEPTANCE_QUANTITY = /\d|[一二两三四五六七八九十百千]+(?=[个份张条篇页行字次版])/u

/**
 * 验收口径的判据：**可对照性**，不是长度（§5.2 的防套话）。
 *
 * 口径的价值在于「说得比目标更具体」，而模型很容易用一句「完成即可」敷衍过去——那种口径
 * 在核验阶段没有任何可对照的东西，**比没有口径更危险**：它会让「口径提到的产出物必须交回」
 * 那条校验假装有依据。
 *
 * 判据是：口径里必须出现一个**可对照的东西**——一个明确的位置（URL / 文件名）、一个产出物
 * 名词（"稿""链接""表格"…），或一个数量。三者都没有的就是表态，多长都拒。
 *
 * ⚠️ 它仍然只是**形态**校验：词表可绕，真正能保证交付完整的是 acceptance 结构化（后续期）。
 * 这里的目标是把零成本的敷衍挡在门外，不是判定口径写得好不好。返回空串表示「没有声明口径」；
 * 给了却不合格由 {@link requireAcceptance} 报错，不静默丢弃。
 */
export function acceptanceOf(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = clip(value, 500)
  if (text === '') return ''
  const bare = text.replace(/[\s，。；、,.!！?？:：~～\-—_/]/gu, '')
  if ([...bare].length < ACCEPTANCE_MIN_CHARS) return ''
  if (ACCEPTANCE_EMPTY_WORDS.includes(text.toLowerCase())) return ''
  // 三者都没有 = 纯表态（「认真完成不要敷衍」这类够长的也算）。
  if (!ACCEPTANCE_LOCATOR.test(text) && !ACCEPTANCE_NOUN.test(text) && !ACCEPTANCE_QUANTITY.test(text)) return ''
  return text
}

/**
 * 校验模型给出的口径；不合格就当场抛错，让它在同一轮里改正。
 *
 * 与「没给」区分开：`undefined` / 空串是合法的「不声明口径」，形态不合格则是错误。
 * 静默降级成空串会让模型以为自己声明成功了，而核验阶段什么都拿不到 —— 那正是要防的情形。
 */
export function requireAcceptance(value: unknown, where: string): string {
  const normalized = acceptanceOf(value)
  if (normalized !== '') return normalized
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return ''
  throw new Error(`${where}的验收口径太笼统，等于没有。请写清「交回什么才算完成」（产出物的种类、数量，或必须包含的要点）；确实不需要口径就不要传这个参数。`)
}

/**
 * §5.2 第二条消费点：汇总前**程序化核验**"任务级口径提到的产出物是否交回了"。
 *
 * ⚠️ **强度必须如实说明**（不许在注释或报告里夸大）：`acceptance` 是**自由文本**（模型写中文，
 * 如"一篇已发布的博客文章链接"），而 `AgentArtifact.kind` 是**执行方自定义的开放字符串**
 * （2026-09-19 起不再是固定枚举），契约里**没有 "文本 → kind" 的映射** ⇒ 这一版只能证明
 * "**有材料交回**"，**不**证明"交回的正是口径点名的那一种"。要做到逐 `kind` 对照，得先把
 * `acceptance` 结构化（后续期）。
 *
 * 这与运行时 ⑦ 第 3 条是**同一条强度**（交接文档 §10 的 D2 决策）——两边口径必须一致，否则
 * 同一件事在协调侧与执行侧会得到不同结论。
 *
 * 纯函数：不读时钟、不碰存储、不调模型。
 */
export function taskAcceptanceFinding(input: {
  readonly acceptance: string | undefined
  readonly artifacts: readonly AgentArtifact[]
}): { readonly applied: boolean; readonly ok: boolean; readonly detail: string } {
  const acceptance = (input.acceptance ?? '').trim()
  // 没有声明口径 ⇒ **不施加**这条（老协调方、或这件事本来就没有可核验的产出），也不记问题。
  if (acceptance === '') return { applied: false, ok: true, detail: '' }
  if (input.artifacts.length > 0) return { applied: true, ok: true, detail: '' }
  return {
    applied: true,
    ok: false,
    detail: `任务级口径要求交回产出物，但整条任务没有任何材料交回（口径：${clip(acceptance, 60)}）`,
  }
}
