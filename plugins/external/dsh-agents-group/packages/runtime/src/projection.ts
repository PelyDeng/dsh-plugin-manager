/**
 * 事件投影：把宿主事件与实时帧整理成面向用户的增量。
 *
 * 两个机制在这里实现一次，所有 Agent 共用：
 *
 * - **正文通道**（{@link createVisibleStream}）：前缀单调 + 发布边界 + 回合结束补发。
 * - **思考通道**（{@link createVisibleThinking}）：按 step 累积、覆盖语义、节流发布、
 *   废弃尝试丢弃、回合结束收尾。
 *
 * 业务只提供两个**纯文本变换**（{@link AgentDefinition.redact} /
 * {@link AgentDefinition.projectReasoning}），触发权与按步状态都由这里掌握——早期把
 * 它们合成一个有状态签名的设计**表达不了**这些时序（见 `definition.ts` 的说明）。
 *
 * 这里的两段实现逐字来自 closedoff 的 `live-output.ts` 与 `assistant-stream.ts`：那两个文件
 * 是"机制"的既有载体，P4 会把它们删除、改用本模块（判据是 `presentation.test.ts` 的
 * opaque 累积与 `releaseTail` **逐字等价**）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as llm from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReasoningProjectionContext } from './definition.ts'

/** 实时通道的语义：`delta` 是增量，`cumulative` 是累计值。 */
export type LiveMode = 'delta' | 'cumulative'

/** 一帧实时增量：属于哪个 step、是什么块。 */
export interface AssistantDelta {
  time: number
  step: number
  chunk: StreamChunk
}

/**
 * 订阅实时帧。
 *
 * 通过 Cordis 订阅，插件释放时监听一并移除。
 *
 * `attempt` / `revision` 去重是必需的：同一步可能因为失败而重试，重试会带新的 `attemptId`；
 * 旧 attempt 的帧必须丢弃，否则上一版失败的推理会混进快照。
 */
export function onAssistantDelta(ctx: Context, receive: (sessionId: string, delta: AssistantDelta) => void): void {
  const attempts = new WeakMap<Agent, { attemptId: string; revision: number; step: number }>()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    // `frame` 缺失时直接返回：不区分事件名的替身会把别的通道也送进来，那种载荷没有帧，
    // 读 `frame.type` 会抛错并让整条回合失败。
    if (frame === undefined) return
    if (frame.type === 'start') {
      attempts.set(agent, { attemptId: frame.attemptId, revision: frame.revision, step: frame.step })
      return
    }
    const attempt = attempts.get(agent)
    if (attempt?.attemptId !== frame.attemptId || attempt.revision >= frame.revision) return
    attempt.revision = frame.revision
    if (frame.type === 'end') attempts.delete(agent)
    else receive(String(agent.session.id), { time: frame.time, step: attempt.step, chunk: frame.chunk })
  })
}

/**
 * 从**落定的事件**里读定时增量。
 *
 * 用途是持久回放（例如侧栏预览）：它**不发明事件、也不改序号**，只把官方流展开成同样形状的
 * 增量。只有 `assistant/message` 与 `assistant/attempt` 带 `data.stream` 时才有增量可读。
 */
export function historyAssistantDeltas(event: SessionEvent): readonly AssistantDelta[] {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return []
  const data = event.data
  if (data.stream === undefined) return []
  return llm.expandAssistantStream(data.stream).map(value => ({ ...value, step: data.step }))
}

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
 * 发布的是与最终正文同一套**脱敏结果**，并且只发布不会再被后续增量改写的部分——先发后改
 * 就得撤回，页面上的字会来回跳。代价是整段没有边界字符的内容（例如一串 JSON）会等到
 * 下一个边界或回合结束才出现：宁可以整段出现，也不发布可能被改写的片段。
 *
 * @param publish 发布一段**新增**的正文
 * @param redact 业务的无状态脱敏；缺省不改写
 */
export function createVisibleStream(publish: (text: string) => void, redact: (text: string) => string = text => text) {
  let raw = ''
  let sent = ''
  const flush = (all: boolean) => {
    const redacted = redact(raw)
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
 * 显示而不是追加。未结束的尾巴（还没写到句末的那段）由业务的投影自行决定怎么处理——运行时
 * 只把 `releaseTail` 告诉它。
 *
 * 只发布实时流里看到的推理，不引入落定 message 里的推理记录：那份是插件的持久内容，
 * 协作入口不读它；废弃尝试的推理则连实时片段一起丢掉。
 *
 * @param publish 发布一份**完整快照**（覆盖语义）
 * @param project 业务的思考投影；缺省原样返回
 * @param mode `delta`（缺省）时按增量累加；`cumulative` 时执行方发的是累计值，直接替换该 step
 */
export function createVisibleThinking(
  publish: (text: string) => void,
  project: (raw: string, ctx: ReasoningProjectionContext) => string = raw => raw,
  mode: LiveMode = 'delta',
) {
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
    .map(([, raw]) => project(raw, { opaqueValues: [...opaque], releaseTail: done }))
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
      // 累计值直接替换该 step 的内容；增量则往后接。两种语义都在这里收敛成"该 step 的完整原文"。
      steps.set(step, mode === 'cumulative' ? text : (steps.get(step) ?? '') + text)
      schedule()
    },
    /** 这一步的尝试被废弃（失败、重试、取消）：它的推理不能留在快照里。 */
    discard(step: number) {
      if (!steps.delete(step)) return
      schedule(true)
    },
    /** 工具结果里的不可外传标识：并进 opaque 集合，后续快照都会替换它们。 */
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
