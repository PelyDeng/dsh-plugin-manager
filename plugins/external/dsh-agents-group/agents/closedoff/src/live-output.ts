/**
 * 协作入口的实时输出：正文增量与可展示的思考快照。
 *
 * 两条通道都只发布协作入口该看到的东西：
 *
 * - 正文只发面向用户的回答，推理与工具参数不发。
 * - 思考走业务页面同一套投影（[`projectReasoning`]）：脱敏、只含稳定语句、隐藏工具结果里的
 *   内部标识，不是原始推理增量。
 * - 先发后改就得撤回，页面上的字会来回跳，所以正文按边界发布、思考按完整快照覆盖发布。
 */
import { projectReasoning } from './presentation.ts'
import { redactVisibleText } from './redaction.ts'

/** 思考快照的发布间隔：业务页面用同样的节奏，太快只会让消费方反复重绘。 */
const THINKING_INTERVAL_MS = 250

/**
 * 正文发布边界：脱敏的各项匹配都不跨这些字符。
 *
 * 只列脱敏字符类真正排除的字符。`?`、`:`、`!` 看着像句子边界，但地址里就有它们，
 * 当成边界会把一段还没被脱敏识别的地址先发出去，之后再匹配上就只能停在半句话上。
 */
const STREAM_BOUNDARY = /[\s)\]}，。；、,;]/

/**
 * 可以发布的长度：停在最后一个边界字符之后。
 *
 * 边界前以数字、`X` 或连字符结尾的词也一起等：脱敏允许号码和证件号的各位之间夹一个
 * 空格或连字符，先把它发出去就等于绕过了脱敏。
 */
function publishedLength(text: string): number {
  let cut = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (STREAM_BOUNDARY.test(text[index]!)) { cut = index + 1; break }
  }
  for (let held = 0; held < 4 && cut > 1; held += 1) {
    let start = cut - 2
    while (start >= 0 && !STREAM_BOUNDARY.test(text[start]!)) start -= 1
    if (!/[0-9Xx-]$/.test(text.slice(start + 1, cut - 1))) break
    cut = start + 1
  }
  return cut
}

/**
 * 把一轮回答的正文增量交给协作入口。
 *
 * 发布的是与最终正文同一套脱敏结果，并且只发布不会再被后续增量改写的部分 —— 先发后改
 * 就得撤回，页面上的字会来回跳。代价是整段没有边界字符的内容（例如一串 JSON）会等到
 * 下一个边界或回合结束才出现：宁可以整段出现，也不发布可能被改写的片段。回合结束补发剩余正文。
 */
export function createVisibleStream(publish: (text: string) => void) {
  let raw = ''
  let sent = ''
  const flush = (all: boolean) => {
    const redacted = redactVisibleText(raw)
    // 已发布的正文被改写（例如号码补齐后才匹配上脱敏）：本轮不再补发，宁可不完整也不重复或外泄。
    if (!redacted.startsWith(sent)) return
    const length = all ? redacted.length : publishedLength(redacted)
    if (length <= sent.length) return
    const next = redacted.slice(sent.length, length)
    sent = redacted.slice(0, length)
    publish(next)
  }
  return {
    push(text: string) { raw += text; flush(false) },
    finish() { flush(true) },
  }
}

/**
 * 把一轮的思考整理成可展示快照。
 *
 * 与正文通道的区别是**覆盖**语义：每个步骤累积推理，投影后拼成一份最新快照，消费方替换
 * 显示而不是追加。未结束的尾巴（还没写到句末的那段）不发布，只留「正在生成…」。
 *
 * 只发布实时流里看到的推理，不引入落定 message 里的推理记录：那份是插件的持久内容，
 * 协作入口不读它，废弃尝试的推理则连实时片段一起丢掉。
 */
export function createVisibleThinking(publish: (text: string) => void) {
  /** 按步骤累积：一问一答里每一步的推理是独立的一段。 */
  const steps = new Map<number, string>()
  /** 工具结果里的业务主键：思考正文提到它们等于把内部标识发出去。 */
  const opaque = new Set<string>()
  let done = false
  let lastAt = 0
  let lastPayload = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const snapshot = () => [...steps.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, raw]) => projectReasoning(raw, done, [...opaque]))
    .filter(Boolean)
    .join('\n')
  const publishNow = () => {
    timer = undefined
    const text = snapshot()
    const payloadKey = `${done ? '1' : '0'}:${text}`
    if (text === '' || payloadKey === lastPayload) return
    lastPayload = payloadKey
    lastAt = Date.now()
    publish(text)
  }
  const schedule = (force = false) => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const wait = Math.max(0, THINKING_INTERVAL_MS - (Date.now() - lastAt))
    if (force || wait === 0) {
      publishNow()
      return
    }
    timer = setTimeout(publishNow, wait)
    timer.unref()
  }
  return {
    push(step: number, text: string) {
      steps.set(step, (steps.get(step) ?? '') + text)
      schedule()
    },
    /** 这一步的尝试被废弃（失败、重试、取消）：它的推理不能留在快照里。 */
    discard(step: number) {
      if (!steps.delete(step)) return
      schedule(true)
    },
    hide(values: readonly string[]) { for (const value of values) opaque.add(value) },
    /** 本轮结束：补发最后一份完整快照。 */
    finish() { done = true; schedule(true) },
    /** 协作结束时停掉挂起的发布。 */
    clear() {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}
