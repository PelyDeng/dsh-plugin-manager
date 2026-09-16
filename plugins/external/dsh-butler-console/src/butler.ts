/**
 * 牛马大总管 Agent：理解目标、生成任务计划、按计划调度子 Agent、汇总结果。
 *
 * 职责边界（与设计文档一致）：
 *
 * - 牛马大总管自己只带一个 `butler_plan` 工具，用来把计划交回宿主。它不决定子 Agent
 *   调用什么工具，也不创建子 Agent 的会话。
 * - 每个子任务交给对应插件登记的 executor；由那个插件创建和驱动自己的 Agent。
 * - 子任务状态只在真实事件上迁移：派发前是 `queued`，交给 executor 后是
 *   `dispatched`，收到第一条进度后是 `running`，settle 之后才是成功或失败。
 *
 * 一轮完整对话由三段组成，中间的状态都来自真实事件：
 *
 * 1. 理解与拆解：牛马大总管回答，需要调度时调用 `butler_plan` 交回计划。
 * 2. 调度：按计划顺序把子任务交给各插件登记的 executor。
 * 3. 汇总：把子任务结果交回给牛马大总管，由它输出最终回答。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AccessError, conversationModel, defaultConversationModel, listPlugins, UNIVERSAL_TOOL_CATEGORY, type Access, type Actor, type AgentArtifact } from '@dsh-plugin-manager/plugin-kit'
import { listAgentCards, resolveExecutor, type AgentCard } from './agents.ts'
import type { Config } from './config.ts'
import { ConversationLog, type LoggedEvent, type RunHead } from './event-log.ts'
import type { ButlerAgentExecutor, ButlerDispatchResult, ButlerMember, ButlerPhase, ButlerProgressUpdate, ButlerReplyRequest } from './protocol.ts'
import type {
  ButlerInputRef,
  ButlerInputRefsKind,
  ButlerMemberReturn,
  ButlerStorage,
  ConversationSummary,
  RequestRecord,
  SubtaskRecord,
  TaskCounts,
  TaskInput,
  TaskSummary,
} from './storage/types.ts'
import { isTerminal, dependencyVerdict, type SubtaskState, type TaskState } from './task-model.ts'

const CONVERSATION_ID = /^butler-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PLAN_TOOL = 'butler_plan'
/**
 * 思考快照的发布间隔。
 *
 * 推理增量比正文更碎（一次几百字很常见），逐字发只会让页面反复重绘；攒到这个间隔再发一次
 * 整段快照，既看得出「在思考」，也不会把页面刷爆。
 */
const THINKING_INTERVAL_MS = 250
/** 末行还在生成时的占位：页面据此知道这一段还没写完。 */
const THINKING_TAIL = '正在生成…'

/** 群聊里一位成员的完整展示信息，含插件声明的补充字段。 */
export interface ButlerMemberCard extends ButlerMember {
  readonly description: string
  readonly version: string
  readonly toolCount: number
}

/** 页面要渲染的一条事件。`web.ts` 只把它序列化成 SSE，不做业务判断。 */
export type ButlerEvent =
  | { readonly type: 'user'; readonly text: string; readonly time: number }
  | { readonly type: 'chat'; readonly role: 'butler'; readonly text: string; readonly time: number }
  /**
   * 牛马大总管自己发言的增量片段。
   *
   * 与 `chat` 配对：`chat_delta` 开一条气泡并逐段追加，回合结束时到达的 `chat` 用它落定后的
   * 正文**替换**预览（重试过的那一版就不会留在页面上）。
   */
  | { readonly type: 'chat_delta'; readonly role: 'butler'; readonly text: string; readonly time: number }
  /**
   * 牛马大总管这一轮的思考快照（覆盖语义）。
   *
   * 页面用整段快照替换思考区，而不是追加。只发布**稳定行**：末尾还在生成的那一行留着，
   * 用一个「正在生成…」占位，所以它不会像正文那样字字跳动。空快照不下发；回合结束会补发
   * 一次完整快照，页面据此把占位去掉、把思考折起来。
   */
  | { readonly type: 'chat_thinking'; readonly role: 'butler'; readonly thinking: string; readonly time: number }
  /**
   * 模型重试开始：当前预览作废，下一段增量从新气泡起头（方案 S08）。
   *
   * 旧尝试的迟到帧不再转发，预览也不再把两次尝试的正文拼在一起——重试掉的那一版
   * 不该留在页面上，更不该和新版混成一句。
   */
  | { readonly type: 'chat_reset'; readonly time: number }
  /**
   * 这一轮接受了一条新的需求或补充。
   *
   * 它先于任何处理发出：老板要能立刻看到「话收到了」，而后面的派活与汇总可能还要等一会儿。
   * `version` 是这一轮的输入版本，客户端拿它做并发依据。
   */
  | {
    readonly type: 'input'
    readonly taskId: string
    /** 本次接受的输入版本。 */
    readonly version: number
    readonly text: string
    /** `chat` 是开新的一轮，`supplement` 是给当前这一轮改目标。 */
    readonly source: 'chat' | 'supplement'
    readonly time: number
  }
  | {
    readonly type: 'plan'
    readonly taskId: string
    readonly goal: string
    readonly note: string
    readonly subtasks: readonly {
      readonly id: string
      readonly goal: string
      readonly agentId: string
      readonly reason: string
      /** 该成员当时的显示名，页面据此渲染昵称与 @ 句柄。 */
      readonly displayName: string
    }[]
    readonly time: number
  }
  | {
    readonly type: 'subtask'
    readonly taskId: string
    readonly id: string
    readonly state: SubtaskState
    readonly agentId: string
    /** 该成员当时的显示名。 */
    readonly displayName: string
    /** 状态说明或结果摘要，已裁剪为可展示文本。 */
    readonly detail: string
    /** 当前协作环节，页面据此点亮链路；为空时只更新文字。 */
    readonly phase?: ButlerPhase
    /** 正在调用的工具名，用于「正在翻阅资料：xxx」。 */
    readonly tool?: string
    /** 等待用户回答的问题；只在 `waiting_user` 时有值。 */
    readonly question?: string
    /** 成员交回的材料引用；没有可点开的位置时不带这个字段。 */
    readonly artifacts?: readonly AgentArtifact[]
    /**
     * 外部待办；只在 `external_pending` 时有值。
     *
     * 它是成员的结构化声明，不是从正文措辞里推断出来的 —— 客户端据此显示「待外部处理」，
     * 而**不是**「已完成」。
     */
    readonly pending?: { readonly reason: string; readonly next?: string }
    readonly time: number
  }
  /**
   * 成员流式发言的增量片段。
   *
   * 按到达顺序追加到该成员当前的气泡里；页面不重绘整条消息，所以长回答不会闪。
   */
  | {
    readonly type: 'subtask_delta'
    readonly taskId: string
    readonly id: string
    readonly agentId: string
    readonly delta: string
    readonly time: number
  }
  /**
   * 成员可展示的思考快照。
   *
   * 覆盖语义：页面用它替换该成员气泡里的思考行，而不是追加。空快照不下发，
   * 页面据最后一条是否还在更新判断思考是否结束。
   */
  | {
    readonly type: 'subtask_thinking'
    readonly taskId: string
    readonly id: string
    readonly agentId: string
    readonly thinking: string
    readonly time: number
  }
  | { readonly type: 'summary'; readonly taskId: string; readonly text: string; readonly state: TaskState; readonly error: string; readonly time: number }
  | {
    readonly type: 'error'
    readonly message: string
    /**
     * 稳定错误码，与 HTTP 响应体里的 `code` 同一套含义。
     *
     * 流已经开出去之后再出错只能用事件表达；带上码，客户端才不必去解析 `message`。
     */
    readonly code?: string
    readonly time: number
  }

/**
 * 只在编排内部传递、不直接发给页面的值。
 *
 * 汇总轮产出的正文既要变成一条给用户看的回复，又要写进任务记录。分成两个事件会
 * 让 `send()` 里出现“同一条内容判断两次”，所以这里用一个内部标记把正文带回去，
 * 由调用方决定怎么用。
 */
type ButlerInnerEvent = ButlerEvent | { readonly type: 'summary_text'; readonly text: string }

/** 取出内部事件的正文；不是内部事件时返回 null。 */
function summaryTextOf(event: ButlerInnerEvent): string | null {
  return event.type === 'summary_text' ? event.text : null
}

/**
 * 执行期间到达的进度事件。
 *
 * 执行方是在 `await dispatch/reply` 期间回调 `onProgress` 的，而生成器只能在自己体内
 * `yield`，所以用「队列 + 唤醒」把回调推入和生成器产出接起来：事件一到就产出，页面才
 * 看得见成员边说边出字；攒到子任务结束再一次性补发等于没有流式。
 */
function progressQueue() {
  const queued: ButlerEvent[] = []
  let wake: (() => void) | undefined
  let settled = false
  const notify = () => { const resume = wake; wake = undefined; resume?.() }
  return {
    push(event: ButlerEvent) { queued.push(event); notify() },
    /** 执行已经结束：队列排空后产出随之结束。 */
    settle() { settled = true; notify() },
    async *drain(): AsyncGenerator<ButlerEvent> {
      while (queued.length > 0 || !settled) {
        if (queued.length === 0) { await new Promise<void>(resolve => { wake = resolve }); continue }
        yield queued.shift()!
      }
    },
  }
}

/** 一次牛马大总管的已打开会话。 */
interface Conversation {
  readonly id: string
  readonly handle: AgentHandle
  active: boolean
  lastUsedAt: number
}

/** 模型通过 `butler_plan` 交回的计划。 */
interface PlannedSubtask {
  readonly goal: string
  readonly agentId: string
  readonly reason: string
  /** 目标标识；沿用旧目标时由模型给出，新目标留空由管家分配。 */
  readonly logicalId?: string
  /** 替代哪一条子任务；首次尝试不填。 */
  readonly supersedes?: string
  /** 前置目标标识；派这一步之前按就绪表逐个核验。 */
  readonly dependsOn?: readonly string[]
  /** 这一步是否真的需要外部动作已经办完；不填按「材料够用」算。 */
  readonly requiresExternalAction?: boolean
}

interface PlanSubmission {
  readonly reply: string
  readonly note: string
  readonly subtasks: readonly PlannedSubtask[]
}

/** 收尾原因：正常结束、出错或被取消。 */
type TurnOutcome = { readonly kind: 'completed' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'cancelled' }

/** 一轮的记录，事件到达时由 `observe()` 填充。 */
interface Turn {
  /** 这一轮开始时在场且可调度的成员，用于渲染动态名单。 */
  readonly members: readonly AgentCard[]
  /**
   * 这一轮改的是哪个任务、它已有哪些尝试。
   *
   * 只有补充轮才有：新的一轮还没有任务，也就谈不上「替代某一条旧尝试」。派活工具用它校验
   * `supersedes`，让模型当场拿到错误并改正，而不是等计划落库之后才发现指向了不存在的东西。
   */
  readonly context?: { readonly taskId: string; readonly subtasks: readonly SubtaskRecord[] }
  plans: PlanSubmission[]
  text: string
  done: boolean
  outcome: TurnOutcome
  resolve: (outcome: TurnOutcome) => void
}

/** 子任务执行结论，供汇总阶段使用。 */
interface SubtaskOutcome {
  readonly state: SubtaskState
  /** 交给牛马大总管汇总时使用的结果正文。 */
  readonly report: string
}

/** 一位正在等待用户回话的成员。 */
interface WaitingMember {
  readonly executor: ButlerAgentExecutor
  readonly agentId: string
  readonly displayName: string
  /** 该成员原业务会话：进度早期上报或结果落库的引用，续问时沿它续接（G01/G02）。 */
  readonly conversationId?: string
}

/**
 * 一次已经受理、准备执行的回合。
 *
 * 校验和执行分开写，是为了让「提交」这一步能同步拿到 `400`／`409` 这类可预期的失败。
 * 如果校验也挪进后台，页面与游戏侧只会看到一条 SSE 错误，分不清是自己参数写错了、
 * 还是前一轮还没跑完、还是服务本身坏了。
 */
interface PreparedTurn {
  readonly conversationId: string
  readonly conversation: Conversation
  readonly text: string
  readonly actor: Actor
  readonly runId: string
  readonly abort: AbortController
}

/** 一次已经受理的补话。 */
interface PreparedReply {
  readonly conversationId: string
  readonly taskId: string
  readonly subtaskId: string
  readonly text: string
  readonly decideByAgent: boolean
  readonly actor: Actor
  readonly executor: ButlerAgentExecutor
  readonly agentId: string
  readonly displayName: string
  /** 成员原业务会话引用：来自早期上报或结果落库，交给执行方续接（可为空）。 */
  readonly memberConversationId?: string
  readonly runId: string
  readonly abort: AbortController
}

/** 一次已经受理的补充：改的是当前这一轮的目标，不是另开一轮。 */
interface PreparedSupplement {
  readonly conversationId: string
  readonly conversation: Conversation
  readonly taskId: string
  readonly text: string
  /** 这次补充被接受之后，任务所处的输入版本。 */
  readonly version: number
  readonly actor: Actor
  readonly runId: string
  readonly abort: AbortController
}

/** 一次刚受理的回合，交给 HTTP 层去订阅。 */
export interface StartedRun {
  readonly runId: string
  /** 这一轮挂在哪个会话上；补话的会话要从任务记录里反查，调用方拿不到。 */
  readonly conversationId: string
  /**
   * 订阅起点。新的一轮从 seq 1 开始计数，所以用 0 就能拿到这一轮的全部事件，
   * 不必先读头部再猜位置。
   */
  readonly from: number
  /**
   * 这是一次重复提交，而且原来那一轮**没有可回放的记录**。
   *
   * 两种情况都会这样：那一轮早就结束了（事件日志被下一轮覆盖），或者受理之后进程就没了
   * （结果不明）。两种都**不会重新执行** —— 调用方应当拿 `runId`／`conversationId` 去读
   * 任务快照，而不是再跑一遍。
   */
  readonly unknown?: boolean
  /**
   * `unknown` 为 true 时的错误码。
   *
   * 两个码对客户端的含义不同：`run_already_finished` 是「那一轮跑完了，去读快照就有结果」；
   * `run_result_unknown` 是「受理过但结果不明，不会重跑，快照里可能什么都没有」。
   */
  readonly unknownCode?: 'run_already_finished' | 'run_result_unknown'
  /** `unknown` 为 true 时给用户看的说明。 */
  readonly message?: string
}

/** 一份可订阅的观察：这一轮的头部信息加上按游标读取的事件流。 */
export interface RunWatch {
  readonly head: RunHead
  readonly events: AsyncGenerator<LoggedEvent<ButlerEvent>>
}

/** 取消请求的处理结果。 */
export interface CancelOutcome {
  /** 是否真的中止了一轮。`false` 表示这次取消没有对象，不是错误。 */
  readonly accepted: boolean
  /** 给用户看的说明；`accepted` 为 true 时为空字符串。 */
  readonly reason: string
}

/**
 * 一次补充请求：修改或追加**当前**任务的目标。
 *
 * 与「开新的一轮」（`/chat`）和「回答某位成员」（`/reply`）是三件事，不能混用。
 */
export interface SupplementRequest {
  /** 要改的是哪一轮。必填：没有它就只能猜「最近一轮」，而猜错会改到别的任务上。 */
  readonly taskId: string
  readonly text: string
  readonly actor: Actor
  /** 幂等标识；规则与 `/chat`、`/reply` 相同。 */
  readonly requestId?: string
  /**
   * 客户端看到的输入版本。
   *
   * 给了就核对：对不上说明这一轮已经被别的入口改过，如实拒绝，而不是让两份补充互相覆盖。
   */
  readonly expectVersion?: number
}

/** 等待超时收尾时给用户看的说明。要让人知道材料还在、重说一遍就能继续。 */
const WAITING_EXPIRED = '等太久了，这次等待已经过期；材料都还在，重新描述你的目标就能接着办。'

/** 等待超时后任务级的失败说明，比子任务那句短。 */
const WAITING_EXPIRED_TASK = '等用户回话超时，材料保留'

/**
 * 读对话正文时往前多读多少个事件，用来重建「这条消息属于第几回合」。
 *
 * `assistant/message` 自带回合号，`user/message` 不带 —— 它的回合得从前面那条
 * `turn/start` 推出来。翻页从回合中间开始时，不往前看一段就认不出归属，而往前读的成本
 * 只是一个回合的事件量。
 */
const TRANSCRIPT_LEAD_EVENTS = 200

/** 一次最多返回多少条对话；也是 `/transcript` 的 `limit` 上限。 */
export const TRANSCRIPT_MAX_ITEMS = 200

/** 尾读模式的扫描块大小：会话日志只有正向读取原语，整段扫过去再取末尾。 */
const TRANSCRIPT_SCAN_CHUNK = 512

/** 对话里的一条用户可见消息。 */
export interface TranscriptItem {
  /** 事件序号：稳定标识，也是翻页游标。 */
  readonly seq: number
  /** DSH 的消息标识，跨表示形式稳定。 */
  readonly messageId: string
  /** `butler` 就是牛马大总管自己的答复。 */
  readonly role: 'user' | 'butler'
  readonly text: string
  readonly time: number
  /** 这条消息属于第几回合；认不出来时为 null（只在往前看不着的边界上出现）。 */
  readonly turn: number | null
  /** 这一轮被中途打断，正文是已经流出的那部分。 */
  readonly interrupted?: true
}

/** 一页对话正文。 */
export interface TranscriptPage {
  readonly conversationId: string
  readonly items: readonly TranscriptItem[]
  /** 正读下一页的游标；没有更多时为 null。 */
  readonly nextAfter: number | null
  /** 往更早翻页的游标（尾读模式）：本页最早一条之前还有内容时给出，否则为 null。 */
  readonly prevBefore: number | null
}

/** 请求指纹：把参与判定的字段压成一个稳定的摘要。 */
function digestOf(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** 从助手消息里取可见文本。 */
function textOf(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

/** 压平空白并限制长度。 */
function clip(value: string, limit: number): string {
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  return trimmed.length > limit ? `${[...trimmed].slice(0, Math.max(1, limit - 1)).join('')}…` : trimmed
}

/**
 * 把本轮推理整理成可发布的快照。
 *
 * 只发布**完整行**：末尾那一行还在生成，先只留一个占位，页面上的字就不会来回跳；
 * 回合结束时（`done`）把全部内容发出去，包括最后一行。全空时返回空串，调用方据此跳过，
 * 不发空事件。
 */
function thinkingSnapshot(raw: string, done: boolean): string {
  const text = raw.replace(/\s+$/u, '')
  if (text === '') return ''
  if (done) return text
  const cut = text.lastIndexOf('\n')
  const head = cut < 0 ? '' : text.slice(0, cut)
  return head === '' ? THINKING_TAIL : `${head}\n${THINKING_TAIL}`
}

/**
 * 把失败原因裁剪成用户可读的一段话。
 *
 * 设计文档要求不展示内部路径、配置值和凭据，所以这里只保留错误消息本身，并抹掉
 * 可能出现的绝对路径和密钥形状的片段。
 *
 * 但「不泄露」不等于「什么都不说」：早先这里对任何非 Error 的抛出物一律返回
 * 「未知错误」，结果是模型调用失败时页面上只有这四个字，连失败来自哪一类都不知道，
 * 排查只能靠猜。宿主的事件里 `reason.error` 既可能是 Error，也可能是普通对象、
 * 字符串或别的抛出物，所以这里按几种常见形状尽力取出**有信息量的那一部分**，
 * 再统一做脱敏。脱敏规则只有这一份，所有出口都走它。
 */
function describeThrown(error: unknown): string {
  if (error === null || error === undefined) return ''
  if (error instanceof Error) {
    const name = typeof error.name === 'string' ? error.name.trim() : ''
    const message = typeof error.message === 'string' ? error.message.trim() : ''
    // name 是 'Error' 时没有信息量，只有别的名字（如 LlmError、TypeError）才值得带出来。
    return name !== '' && name !== 'Error' ? (message === '' ? name : `${name}: ${message}`) : message
  }
  if (typeof error === 'string') return error.trim()
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error)
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    // 常见形状：{ code, message } / { name, message } / 带 cause 的包装对象。
    const parts: string[] = []
    for (const key of ['code', 'name', 'message'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim())
    }
    if (parts.length > 0) return parts.join(': ')
    // 空对象与空数组同样没有信息量，如实退回「未知错误」而不是显示一个空壳。
    const keys = Object.keys(record)
    if (keys.length === 0) return ''
    // 认不出来时给出对象内容的简短摘要，比「未知错误」有用得多。
    try {
      const text = JSON.stringify(error)
      if (typeof text === 'string' && text !== '{}' && text !== 'null' && text !== '[]') return text
    } catch { /* 循环引用等无法序列化的情况退回字段摘要 */ }
    return `无法识别的错误对象（字段：${keys.slice(0, 6).join(', ')}）`
  }
  return ''
}

/**
 * 取出一段可写进日志的错误栈，并抹掉本机绝对路径。
 *
 * 只用于服务端日志：宿主与插件的部署路径、账号名等不该出现在日志里，但文件名与行号
 * 是定位问题的关键，所以保留相对形态。
 */
export function stackOf(error: unknown): string {
  if (error === null || error === undefined) return '（无抛出物）'
  const raw = error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : describeThrown(error)
  return (raw === '' ? '（无栈信息）' : raw)
    .replace(/[A-Za-z]:\\[^\s)]+/gu, '…')
    .replace(/\/(?:data|home|Users|opt|srv|var)\/[^\s):]+/gu, '…')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '（凭据）')
    .slice(0, 4000)
}

export function visibleError(error: unknown, limit: number): string {
  const cleaned = describeThrown(error)
    .replace(/[A-Za-z]:\\[^\s，。；]+/gu, '（本机路径）')
    .replace(/\/(?:home|Users|var|opt|srv)\/[^\s，。；]+/gu, '（本机路径）')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '（凭据）')
  return clip(cleaned === '' ? '未知错误' : cleaned, limit)
}

/** 子任务简报：把整体目标、这个子任务和产出要求一起交给子 Agent。 */
/**
 * 派单 message 的管家本地保守上限（字符）。
 *
 * 依据：参考博客成员入口的实际接收检查（`plugins/external/dsh-agents-group/agents/blog/src/participant.ts`：
 * `request.message.length <= 8000`）。**不是**成员能力协商机制，也不代表其它成员或模型的容量；
 * 其它成员若有更低限制，仍以其入口的实际检查为准。超限一律不派单，不截断后继续。
 */
const DISPATCH_MESSAGE_LIMIT = 8000

/**
 * 协作返回的内部留存：原文照录 + 结构化外部待办。
 *
 * 页面展示用的 `result` 仍按 `maxResultChars` 裁剪；这里保存的是**未裁剪**的协作返回原文，
 * 供下游构建材料快照。只复用权威声明，不推断"未采用/未发布"，也不从正文反解析。
 */
function memberReturnOf(result: ButlerDispatchResult): ButlerMemberReturn {
  const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
  const next = typeof result.externalPending?.next === 'string' ? result.externalPending.next.trim() : ''
  return {
    protocol: 1,
    text: result.summary ?? '',
    ...(reason === '' ? {} : { externalPending: { reason, ...(next === '' ? {} : { next }) } }),
  }
}

/**
 * 派单简报：在原有说明之后接上**可用材料**段。
 *
 * 正文照录上游协作返回原文；位置型材料只给出位置并注明需在执行方页面打开（不宣称员工已取得）；
 * 外部待办照录上游权威声明。内容全部来自派单时固定的快照，不重读可变上游。
 */
function dispatchBrief(taskGoal: string, subtaskGoal: string, refs: readonly ButlerInputRef[]): string {
  const lines = [briefFor(taskGoal, subtaskGoal)]
  if (refs.length > 0) {
    lines.push('', '可用材料（来自上游，原文照录）：')
    for (const ref of refs) {
      lines.push(`【${ref.logicalId}】${ref.text}`)
      for (const artifact of ref.artifacts) {
        lines.push(`（位置型材料：${artifact.title}（${artifact.kind}）${artifact.path}；需在执行方页面打开，归属由执行方核验）`)
      }
      if (ref.externalPending !== undefined) {
        const next = ref.externalPending.next === undefined ? '' : `；处理后可做：${ref.externalPending.next}`
        lines.push(`（上游外部待办：${ref.externalPending.reason}${next}）`)
      }
    }
  }
  return lines.join('\n')
}

function briefFor(taskGoal: string, subtaskGoal: string): string {
  return [
    `整体目标：${taskGoal}`,
    `你负责的部分：${subtaskGoal}`,
    '只完成你负责的这一部分，不要代替其他 Agent 回答。',
    '如果缺少必要信息，直接说明缺什么，不要编造。',
  ].join('\n')
}

/**
 * 补充处理轮交给牛马大总管的话。
 *
 * 把它写成一段「现状 + 新要求 + 怎么判断」，而不是只把补充原文扔过去：它要判断这条补充是
 * 换个说法还是改了范围，就得看见这一轮已经做到哪儿、拿到了什么。只给原文，它只能重头理解
 * 一遍目标，很容易把已经干完的活又派一次。
 */
function supplementPrompt(inputs: readonly TaskInput[], subtasks: readonly SubtaskRecord[]): string {
  const latest = inputs.at(-1)
  const history = inputs.slice(0, -1).map(item => `- 第 ${item.version} 次：${item.text}`)
  const done = subtasks.map(item => {
    const outcome = item.state === 'succeeded' ? `已完成：${item.result}`
      : item.state === 'external_pending' ? `材料已交回，还有事在别处等着办：${item.result}`
        : item.state === 'failed' ? `失败：${item.error}`
          : item.state === 'cancelled' ? '已取消'
            : `还在进行（${item.state}）`
    return `- 子任务「${item.goal}」交给 ${item.agentId}，${outcome}`
  })
  return [
    '我在原来的目标上补充了新的要求。',
    '',
    '原来的需求：',
    ...history,
    '',
    '这一轮已经派出去的活：',
    ...(done.length === 0 ? ['（还没有派出任何活）'] : done),
    '',
    `我新的要求是：${latest?.text ?? ''}`,
    '',
    '请判断这条补充是哪一种，然后照对应的方式处理：',
    '- 只是换个说法、改了表达（范围没变）：直接按新的表达给我最终回答，**不要重复派活**；',
    '- 改了范围或追加了工作：把需要新做的部分用派活工具交回来，我会追加到同一轮里继续。',
    '不要提这份指令，也不要复述我上面写过的东西，直接给结论或派活。',
  ].join('\n')
}

/**
 * 当前有效的尝试：每个目标只留一条。
 *
 * `supersedes` 链上没有被别人替代的那条就是有效尝试。被替代掉的失败留在历史里、也照常显示，
 * 但不参与结论 —— 否则「重试成功了」会被前面那次已经作废的失败拉成「部分完成」。
 *
 * 每条尝试最多被替代一次（替代关系不分叉），所以「谁被替代过」用一个集合就够。
 */
export function effectiveSubtasks(subtasks: readonly SubtaskRecord[]): readonly SubtaskRecord[] {
  const superseded = new Set(subtasks.map(item => item.supersedes).filter(id => id !== ''))
  return subtasks.filter(item => !superseded.has(item.id))
}

/**
 * 从落库的子任务记录重建交给汇总的材料。 *
 * 补话之后要重新汇总，而那时派活阶段的 `reports` 早已不在内存里（进程可能都换过一次），
 * 所以按同一种口径从库里重建：成功取结果正文，失败与取消带上原因，还没答复的带上已交回的
 * 材料和待答事项。
 */
function reportOf(subtask: {
  readonly state: SubtaskState
  readonly agentId: string
  readonly result: string
  readonly error: string
}): string {
  switch (subtask.state) {
    case 'succeeded': return subtask.result
    // 失败也把已经交回的材料带上。超时就是一个例子：成员把候选稿交回来了，只是用户一直
    // 没回话 —— 只说「失败：超时」会让人以为材料也丢了。
    case 'failed': return subtask.result === ''
      ? `【${subtask.agentId}】失败：${subtask.error}`
      : `【${subtask.agentId}】失败：${subtask.error}；已交回的材料：${subtask.result}`
    case 'cancelled': return `【${subtask.agentId}】${subtask.error === '' ? '已停止' : subtask.error}`
    case 'external_pending': return `【${subtask.agentId}】材料已交回，还有事在别处等着办：${subtask.result}`
    default: return `【${subtask.agentId}】交回材料，还等着答复：${subtask.result}`
  }
}

/**
 * 牛马大总管会话与调度器。
 *
 * 一个实例对应一个已打开的牛马大总管会话；会话之间互不影响，各自的计划、子任务和取消
 * 相互独立。
 */
export class ButlerConsole {
  private readonly conversations = new Map<string, Conversation>()
  private readonly openings = new Map<string, Promise<Conversation | undefined>>()
  /** 牛马大总管会话的当前轮次；事件到达时由 `observe()` 填充。 */
  private readonly turns = new Map<string, Turn>()
  /**
   * 每个会话当前正在执行的一轮：`conversationId` → 轮次。
   *
   * 执行已经不再挂在某条 HTTP 连接上，所以「谁在跑」必须自己记：用户按停止、
   * 登录被撤销、插件卸载都要靠这份记录找到该中止的那一轮。
   */
  private readonly runs = new Map<string, { readonly runId: string; readonly abort: AbortController }>()

  /**
   * 同会话执行互斥：每个会话同一时刻只有一个受理在执行（chat 的回合、对等待成员的回话、
   * 补充的处理）。`runId` 是释放凭据——收尾时核对它，旧执行清不掉新执行的占用。接管一律
   * 不允许：回合还活着时回话会换掉运行引用和事件日志，把在跑的活变成不可停止，所以回话
   * 要等回合收尾（或先停止）。页面各自持有的 streaming 标记只是反馈，不能当互斥依据。
   */
  private readonly claims = new Map<string, { readonly runId: string; readonly kind: 'turn' | 'reply' | 'supplement' }>()

  /** 受理时同步占住执行权；拿不到返回 false，由调用方按 409 拒绝。 */
  private claimNow(conversationId: string, runId: string, kind: 'reply' | 'supplement'): boolean {
    const holder = this.claims.get(conversationId)
    if (holder !== undefined && holder.runId !== runId) return false
    this.claims.set(conversationId, { runId, kind })
    return true
  }

  /** 收尾释放自己的占用；不是自己的 runId 就不动。 */
  private releaseClaim(conversationId: string, runId: string): void {
    if (this.claims.get(conversationId)?.runId === runId) this.claims.delete(conversationId)
  }
  /**
   * 每个会话最近一轮的事件日志，供 `/events` 回放与跟随。
   *
   * 新的一轮开始时覆盖旧的。关掉页面再打开、或者第二个入口要观察同一轮，都从这里读，
   * 而不是各自重跑一遍任务。
   */
  private readonly logs = new Map<string, ConversationLog<ButlerEvent>>()
  /** 每个正在进行的大总管回合的正文增量出口：`sessionId` → 写进当前事件流。 */
  private readonly deltas = new Map<string, (text: string) => void>()
  /** 同一个回合的思考快照出口：与 `deltas` 并行，覆盖语义而不是追加。 */
  private readonly thinkings = new Map<string, (thinking: string) => void>()
  /** 思考累积状态：按会话记原始推理、已发布的快照与节流计时器。 */
  private readonly thinkingState = new Map<string, { raw: string; published: string; timer?: NodeJS.Timeout }>()
  /** 每个会话当前采用的流式尝试（宿主帧的 attemptId）：旧尝试的迟到帧按它丢弃（S08）。 */
  private readonly streamAttempts = new Map<string, unknown>()
  /** 尝试切换时通知回合回调重置预览（发出 chat_reset）。 */
  private readonly deltaResets = new Map<string, () => void>()
  /**
   * 正在等待用户回话的子任务：`taskId:subtaskId` → 该子任务的执行方。
   *
   * 进程重启后这里会空，但子任务状态仍在库里；`submitReply` 会如实告知等待已失效，
   * 而不是假装还能回复。
   */
  private readonly waiting = new Map<string, WaitingMember>()
  /**
   * 正在等待用户回话的子任务上的闹钟：`taskId:subtaskId` → 定时器。
   *
   * 用户回话、任务被取消、插件卸载时都要撤掉：留在那里会让一次早就结束的等待在很久
   * 以后把状态改成超时失败。
   */
  private readonly waitingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 同子任务存储写入的串行化队列（§3「同子任务写入顺序」）：`taskId:subtaskId` → 链尾。
   *
   * 执行器的 `onProgress` 是 fire-and-forget 回调，异步化后两次写库可能乱序落地：`dispatched`
   * （含 inputRefs 首次固定）必须先于 `running`，乱序会让 inputRefsState 永久 unknown、重派被拒。
   * 派单、进度回调与结果落库全部经由 {@link queueSubtaskWrite} 入队，保证每个子任务内严格 FIFO。
   */
  private readonly subtaskWrites = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly access: Access,
    /** 异步业务存储（生产为 PostgresTaskStorage；测试注入过渡适配器或替身）。 */
    private readonly storage: ButlerStorage,
    private readonly persona: string,
  ) {}

  /**
   * 把一次子任务存储写排进该子任务的串行队列（§3 同子任务写入顺序不变量）。
   *
   * 队列链尾只承载「完成」状态：前一次失败不阻塞后续写入（每次写都有状态守卫兜底），
   * 链上也不会出现 unhandledRejection；返回给调用方的 promise 仍如实反映本次写入的结果，
   * fire-and-forget 调用方（onProgress）忽略它也安全——失败已由链尾记录成服务端日志。
   */
  private queueSubtaskWrite<T>(taskId: string, subtaskId: string, write: () => Promise<T>): Promise<T> {
    const key = `${taskId}:${subtaskId}`
    const previous = this.subtaskWrites.get(key) ?? Promise.resolve()
    const running = previous.then(write, write)
    const tail = running.then(() => undefined, error => {
      console.error(`butler-console: 子任务 ${key} 的存储写入失败：${visibleError(error, 300)}\n${stackOf(error)}`)
    })
    this.subtaskWrites.set(key, tail)
    // 链尾落定且没有新写入接上来时清掉表项，队列表不随历史子任务无限增长。
    void tail.then(() => { if (this.subtaskWrites.get(key) === tail) this.subtaskWrites.delete(key) })
    return running
  }

  /**
   * 幂等收尾的有限重试（§3 finishRequest 失败路径）：指数退避重试至多 3 次，仍失败则落
   * console.error 并放弃——记录留在 `claimed`，重启后按「结果不明」人工核对，绝不重跑。
   * 全程消化异常，不会成为宿主的 unhandledRejection。
   */
  private async finishRequestWithRetry(actor: Actor, kind: string, requestId: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.storage.finishRequest(actor, kind, requestId)
        return
      } catch (error) {
        if (attempt >= 3 || this.disposed) {
          console.error(`butler-console: 幂等记录（${kind}/${requestId}）标记完成失败，已放弃；该请求重启后按「结果不明」人工核对：${visibleError(error, 300)}\n${stackOf(error)}`)
          return
        }
        const backoff = 1000 * 2 ** attempt
        console.warn(`butler-console: 幂等记录（${kind}/${requestId}）标记完成失败，${backoff}ms 后重试（第 ${attempt + 1}/3 次）：${visibleError(error, 300)}`)
        await new Promise(resolve => { setTimeout(resolve, backoff).unref?.() })
      }
    }
  }

  /**
   * 撤销幂等占位，失败只记录、不重试（§3 releaseRequest 失败路径）：占位撤不掉意味着同一个
   * `requestId` 再提交会被当成「结果不明」，保留人工核对口径即可；绝不让它打断已经抛出的
   * 受理错误，也不成为 unhandledRejection。
   */
  private releaseRequestQuietly(actor: Actor, kind: string, requestId: string): void {
    void this.storage.releaseRequest(actor, kind, requestId).catch(error => {
      console.error(`butler-console: 撤销幂等占位（${kind}/${requestId}）失败，保留人工核对口径：${visibleError(error, 300)}\n${stackOf(error)}`)
    })
  }

  /** 校验浏览器传来的会话 id，避免用它去寻址别的 DSH 会话。 */
  validateId(value: string): string {
    if (!CONVERSATION_ID.test(value)) throw new AccessError(400, '不是牛马大总管的会话标识', 'conversation_invalid')
    return value
  }

  private createId(): string {
    return `butler-web-${randomUUID()}`
  }

  /**
   * 打开或创建牛马大总管会话。
   *
   * 对话正文由 DSH 官方会话日志承载；本插件只在工作台索引里登记归属和标题，不
   * 复制一份对话内容。
   */
  async open(requestedId: string | undefined, createMissing: boolean, actor: Actor): Promise<Conversation | undefined> {
    if (this.disposed) throw new AccessError(503, '插件正在停止', 'plugin_stopping')
    this.access.assert(actor)
    if (requestedId === undefined && !createMissing) return undefined
    const id = requestedId === undefined ? this.createId() : this.validateId(requestedId)
    // 新会话要就地创建：会话 id 由页面在客户端生成，首次发消息时库里还没有这条记录。
    // 若这里先 assertOwner，新会话会被判成「不存在」而拒绝，页面就开不出会话。
    // 已属于他人时 openOrReserveConversation 以同样的 404 拒绝，不泄露存在性。
    //
    // 归属登记先于去重块完成：登记的 await 之后，conversations 命中、openings 并发合并与
    // openAgent 登记必须留在同一个同步块里，否则并发 open 会绕过 openings 各建一份会话句柄。
    if (requestedId !== undefined) await this.storage.openOrReserveConversation(id, actor)
    else await this.storage.reserveConversation(id, actor)
    const existing = this.conversations.get(id)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      return existing
    }
    const opening = this.openings.get(id)
    if (opening !== undefined) {
      const conversation = await opening
      this.access.assert(actor)
      return conversation
    }
    const created = this.openAgent(id, actor).finally(() => { this.openings.delete(id) })
    this.openings.set(id, created)
    return created
  }

  private async openAgent(id: string, actor: Actor): Promise<Conversation | undefined> {
    /**
     * 新会话还没有持久化记录，读会话模型会以「找不到会话」失败。
     *
     * 那不是异常，而是「这是新会话」—— 新会话就该用宿主默认模型，这也正是
     * `conversationModel` 在没有模型记录时的返回值。若不在这里兜住，页面第一次发消息永远
     * 开不出会话，表现为 SSE 里一条笼统的「服务处理请求失败」，很难看出原因。
     */
    let selection: Awaited<ReturnType<typeof conversationModel>>
    try {
      selection = await conversationModel(this.ctx, id)
    } catch (error) {
      if (!isNotFound(error)) throw error
      selection = await defaultConversationModel(this.ctx)
    }
    this.access.assert(actor)
    if (this.disposed) throw new AccessError(503, '插件正在停止', 'plugin_stopping')
    const effort = selection.reasoningEffort ?? this.config.reasoningEffort
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
    }
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions,
        setup: agentCtx => this.setup(agentCtx, id),
      })
    } catch (error) {
      if (!isNotFound(error)) throw error
      handle = await this.ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup: agentCtx => this.setup(agentCtx, id),
      })
    }
    this.access.assert(actor)
    if (this.disposed) {
      await handle.dispose()
      throw new AccessError(503, '插件正在停止', 'plugin_stopping')
    }
    const conversation: Conversation = { id, handle, active: false, lastUsedAt: Date.now() }
    this.conversations.set(id, conversation)
    return conversation
  }

  /**
   * 牛马大总管自己的提示词与工具。
   *
   * 子 Agent 的提示词和工具不在这里配置：那是各自插件的事。这里只限制牛马大总管自己
   * 能看到什么，避免牛马大总管绕过计划直接执行业务操作。
   *
   * `sessionId` 由创建处闭包传入，而不是从 agentCtx 上读 `agent.id`：这样不依赖
   * 宿主对 Context 的类型扩展，行为也更明确。
   */
  private setup(agentCtx: Context, sessionId: string): void {
    agentCtx.systemPrompt.section({ name: 'butler:persona', order: 600, text: this.persona })
    // 在场名单每次组装时重新求值：新插件装上来、旧插件卸下去，牛马大总管下一轮就知道，
    // 不需要重启也不需要改代码。
    agentCtx.systemPrompt.section({
      name: 'butler:roster',
      order: 610,
      text: () => this.rosterText(sessionId),
    })
    agentCtx.tools.register(this.planTool(sessionId))
    // 牛马大总管能直接调用的工具：派活工具 + 目录里的通用工具。
    //
    // 通用工具是约定好的公共集（分类标签 `通用工具`），任何智能体都能调。牛马大总管需要它们
    // 才能直接处理那些「不需要专业智能体」的问题（例如查天气），而不是为了不必要的小事
    // 去派活。
    //
    // 从目录实时读而不是写死名单：新增通用工具时牛马大总管自动就能用，不需要改这里。
    //
    // 只列**全局**工具名，并且**读不到目录时干脆不施加限制**。
    //
    // 两个失败方向都不对称，必须选对：`restrict({ allow: [] })` 会遮蔽**所有**工具（包括
    // 刚注册的 `butler_plan`），牛马大总管于是连派活工具都没有、整轮只能干瞪眼；而「不限制」的最坏
    // 结果是牛马大总管多看到几个工具，它仍受自己的提示词与鉴权约束。所以空清单绝不能拿去 restrict。
    const universal = this.universalToolNames(agentCtx)
    if (universal.length > 0) agentCtx.tools.restrict({ allow: universal })
  }

  /**
   * 当前目录里标记为「通用工具」的工具名。
   *
   * 读不到目录时返回空数组，**由调用方理解为「本次不施加限制」**——理由见调用处：
   * 空 allow 会遮蔽全部工具，那比不限制糟得多。
   */
  private universalToolNames(ctx: Context): string[] {
    try {
      return listPlugins(ctx)
        .flatMap(plugin => plugin.tools)
        .filter(tool => tool.category === UNIVERSAL_TOOL_CATEGORY)
        .map(tool => tool.name)
    } catch {
      return []
    }
  }

  /**
   * 渲染「当前可调度成员」名单。
   *
   * 名单来自插件目录，能力来自各执行入口自己的声明。没有可调度成员时明确写出来，
   * 让牛马大总管知道这次只能自己回答，而不是硬凑一个不存在的成员。
   */
  private rosterText(sessionId: string): string {
    const turn = this.turns.get(sessionId)
    const members = (turn?.members ?? []).filter(member => member.dispatchable)
    if (members.length === 0) {
      return '# 当前可调度的成员\n\n（现在没有能接活的成员，这一轮只能你自己回答，不要调用 butler_plan。）'
    }
    const lines = members.map(member => {
      const caps = member.capabilities.length > 0 ? member.capabilities.join('、') : '未声明，按子任务语义自行判断'
      const summary = member.description.trim() === '' ? '' : `；简介：${member.description.trim()}`
      return `- id \`${member.id}\`（${member.displayName}）：能接 ${caps}${summary}`
    })
    return [
      '# 当前可调度的成员',
      '',
      '只能把子任务派给下面列出的成员，`agentId` 必须原样使用反引号里的 id：',
      '',
      ...lines,
    ].join('\n')
  }

  /**
   * `butler_plan` 工具。
   *
   * 用工具交回计划，而不是从自然语言里解析 JSON：模型要么给出结构化计划，要么就
   * 只是普通回答，宿主不会把一段看起来像 JSON 的正文误当成计划。
   */
  private planTool(sessionId: string) {
    return defineTool({
      name: PLAN_TOOL,
      description: '把这一次的任务拆解交回宿主。只在确实需要把任务派给子 Agent 时调用；不需要调度的普通问答不要调用。',
      parameters: {
        reply: { type: 'string', required: true, description: '给用户看的说明：你如何理解目标，以及打算怎么做。' },
        note: { type: 'string', description: '拆解依据的补充说明，可以留空。' },
        subtasks: {
          type: 'array',
          required: true,
          description: '按执行先后排列的子任务。每个子任务都是可以被独立交给一个子 Agent 完成的一句话目标。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string', required: true, description: '交给子 Agent 的完整目标，要自带必要上下文，不要用“同上”“继续”这类指代。' },
              agentId: { type: 'string', required: true, description: '目标 Agent 的 id，只能从本轮可调度的 Agent 列表中选择。' },
              reason: { type: 'string', description: '为什么把这个子任务派给这个 Agent。' },
              logicalId: { type: 'string', description: '同一个目标重做时沿用原来的目标标识（例如 g1）。新目标不要填，管家会分配。' },
              supersedes: { type: 'string', description: '替代哪一条尝试：填它原来的子任务 id（s1、s2…）。只在这个新尝试取代同一个目标的旧尝试时才填；旧尝试必须已经结束。' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: '前置的目标标识（例如 g1）。派这一步之前逐个核验：前置还没结束（含等人回话）就留在队列里等，不判失败；前置失败、取消或被替代才不派，并如实记下缺失的前提。不填表示没有前置。只能引用这一轮里已经存在的目标，或者本次计划中排在它前面的目标。',
              },
              requiresExternalAction: {
                type: 'boolean',
                description: '这一步是否真的需要外部动作（在原页面采用、确认、发布）已经办完。默认 false：前置交了材料就可以拿材料继续干。当前置带着「外部待办」时这条才起作用 —— 填 true 表示这一步要的是已经办完的结果（例如「报道一下已经发布的版本」），材料本身不够用；不填表示材料够用（例如「拿候选稿写个摘要」）。',
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { accepted: { type: 'boolean', required: true }, subtasks: { type: 'integer', required: true } },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.accepted ? `已接受 ${value.subtasks} 个子任务，开始调度。` : '计划未被接受。',
        }],
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const turn = this.turns.get(sessionId)
        if (turn === undefined || turn.done) throw new Error('这一轮已经结束，计划未被接受')
        const available = new Set(this.dispatchableAgents().map(card => card.id))
        const subtasks: PlannedSubtask[] = []
        // 前置只能指向这一轮里已有的目标，或者本次计划中排在它前面的目标 —— 这样依赖天然
        // 无环，也天然有序，不必再跑一遍环检测。
        const known = new Set<string>((turn.context?.subtasks ?? []).map(item => item.logicalId))
        /**
         * 新目标的标识**在这里就分配**，不留给存储层。
         *
         * 因为同一个计划里后面的项要能依赖前面的项：如果标识要等落库时才知道，校验这一步
         * 就看不见它，`dependsOn` 里的 `g1` 会被当成「不存在」。分配规则与存储层一致 ——
         * 从现有最大值往后排。
         */
        let nextLogical = (turn.context?.subtasks ?? [])
          .map(item => Number.parseInt(item.logicalId.replace(/^g/u, ''), 10))
          .filter(value => Number.isSafeInteger(value))
          .reduce((max, value) => Math.max(max, value), 0)
        for (const item of args.subtasks as readonly {
          goal?: unknown
          agentId?: unknown
          reason?: unknown
          logicalId?: unknown
          supersedes?: unknown
          dependsOn?: unknown
          requiresExternalAction?: unknown
        }[]) {
          const goal = typeof item.goal === 'string' ? clip(item.goal, 2000) : ''
          const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : ''
          if (goal === '') throw new Error('子任务缺少目标')
          if (!available.has(agentId)) {
            throw new Error(`Agent ${agentId === '' ? '（空）' : agentId} 不能接收子任务。本轮可调度的是：${[...available].join('、') || '（没有）'}`)
          }
          let logicalId = typeof item.logicalId === 'string' ? item.logicalId.trim() : ''
          const supersedes = typeof item.supersedes === 'string' ? item.supersedes.trim() : ''
          if (supersedes !== '') {
            const attempts = turn.context?.subtasks
            if (attempts === undefined) throw new Error('这一轮还没有可以替代的旧尝试，不要填 supersedes')
            const target = attempts.find(candidate => candidate.id === supersedes)
            if (target === undefined) throw new Error(`要替代的子任务 ${supersedes} 不在这一轮里`)
            if (!isTerminal(target.state)) {
              throw new Error(`子任务 ${supersedes} 还没有结束（${target.state}），不能替代它`)
            }
            // 替代必须是同一个目标的新尝试：换个目标就该用新的标识，否则两条不相干的活会
            // 被算成一条，聚合时互相顶掉。
            if (logicalId !== '' && logicalId !== target.logicalId) {
              throw new Error(`子任务 ${supersedes} 属于目标 ${target.logicalId}，不能改成 ${logicalId}；要换目标请用新的标识并去掉 supersedes`)
            }
            logicalId = target.logicalId
          } else if (logicalId === '') {
            // 新目标：**在这里就分配标识**，不留给存储层。同一个计划里后面的项要能依赖前面的项，
            // 而依赖校验就发生在下面几行 —— 标识要等落库时才知道的话，`dependsOn` 里的 `g1`
            // 会被当成「不存在」。分配规则与存储层一致：从现有最大值往后排。
            do { nextLogical += 1 } while (known.has(`g${nextLogical}`))
            logicalId = `g${nextLogical}`
          }
          const dependsOn = Array.isArray(item.dependsOn)
            ? [...new Set(item.dependsOn
              .filter((value): value is string => typeof value === 'string')
              .map(value => value.trim())
              .filter(value => value !== ''))]
            : []
          // 先查自依赖：它看起来像「引用了一个还不存在的目标」，报错会指向错误的方向。
          if (logicalId !== '' && dependsOn.includes(logicalId)) throw new Error('不能把自己当作前置')
          for (const dependency of dependsOn) {
            if (!known.has(dependency)) {
              throw new Error(`前置目标 ${dependency} 不在这一轮里；只能引用已有的目标，或本次计划中排在它前面的目标`)
            }
          }
          subtasks.push({
            goal, agentId, reason: clip(typeof item.reason === 'string' ? item.reason : '', 300),
            ...(logicalId === '' ? {} : { logicalId }),
            ...(supersedes === '' ? {} : { supersedes }),
            ...(dependsOn.length === 0 ? {} : { dependsOn }),
            // 只在真的声明了 true 时才带上：没声明按「材料够用」算，与加这个字段之前一致。
            ...(item.requiresExternalAction === true ? { requiresExternalAction: true } : {}),
          })
          if (logicalId !== '') known.add(logicalId)
        }
        if (subtasks.length === 0) throw new Error('计划里至少要有一个子任务')
        if (subtasks.length > this.config.maxSubtasks) throw new Error(`一次最多派发 ${this.config.maxSubtasks} 个子任务`)
        // 同一次计划里同一个目标只能有一条有效尝试：两条会互相替代，聚合时谁也不算数。
        const claimed = new Set<string>()
        for (const subtask of subtasks) {
          if (subtask.logicalId === undefined) continue
          if (claimed.has(subtask.logicalId)) throw new Error(`计划里目标 ${subtask.logicalId} 出现了不止一次，请合成一条`)
          claimed.add(subtask.logicalId)
        }
        turn.plans.push({ reply: clip(args.reply, 4000), note: clip(args.note ?? '', 1000), subtasks })
        return { accepted: true, subtasks: subtasks.length }
      },
    })
  }

  /** 当前可调度（登记了执行入口且仍在目录中）的 Agent。 */
  private dispatchableAgents(): AgentCard[] {
    return listAgentCards(this.ctx).filter(card => card.dispatchable)
  }

  /**
   * 群成员列表：目录里的全部 Agent，叠加该用户的本地别名。
   *
   * 显示名取本地别名优先，插件声明的名称始终保留在 `declaredName` 里，页面上以次要
   * 文字显示，保证「谁是谁」永远可追溯。
   */
  async members(actor: Actor): Promise<ButlerMemberCard[]> {
    this.access.assert(actor)
    const aliases = await this.storage.aliases(actor)
    const busy = await this.storage.busy(actor)
    return listAgentCards(this.ctx).map(card => {
      const alias = aliases.get(card.id)
      return {
        agentId: card.id,
        displayName: alias?.displayName !== undefined && alias.displayName !== '' ? alias.displayName : card.displayName,
        declaredName: card.displayName,
        online: card.dispatchable,
        accent: alias?.accent ?? '',
        capabilities: card.capabilities,
        description: card.description,
        version: card.version,
        toolCount: card.toolCount,
        busy: busy.get(card.id) ?? null,
      }
    })
  }

  /** 按 id 取一位成员的显示名；找不到时回落到 id 本身。 */
  private async displayNameOf(actor: Actor, agentId: string): Promise<string> {
    const alias = (await this.storage.aliases(actor)).get(agentId)
    if (alias !== undefined && alias.displayName !== '') return alias.displayName
    return listAgentCards(this.ctx).find(card => card.id === agentId)?.displayName ?? agentId
  }

  /** 保存一位成员的显示别名。空值表示恢复默认。 */
  async setAlias(actor: Actor, agentId: string, displayName: string, accent: string): Promise<void> {
    this.access.assert(actor)
    await this.storage.setAlias(actor, agentId, displayName, accent)
  }

  /** 保存一位成员的头像。字节已在 HTTP 层核验过类型与大小。 */
  async setAvatar(actor: Actor, agentId: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.access.assert(actor)
    await this.storage.setAvatar(actor, agentId, bytes, contentType)
  }

  /** 读取一位成员的头像。 */
  async avatar(actor: Actor, agentId: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    this.access.assert(actor)
    return await this.storage.avatar(actor, agentId)
  }

  /** 删除一位成员的头像，别名保留。 */
  async clearAvatar(actor: Actor, agentId: string): Promise<void> {
    this.access.assert(actor)
    await this.storage.clearAvatar(actor, agentId)
  }

  /** 侧栏列表。 */
  async listConversations(actor: Actor): Promise<ConversationSummary[]> {
    this.access.assert(actor)
    return await this.storage.listConversations(actor, 50)
  }

  /** 运行历史分页。 */
  async history(actor: Actor, query: {
    offset: number
    limit: number
    keyword: string
    state: string
    /** 只取某个会话的活；省略表示全部会话。 */
    conversationId?: string
  }): Promise<{ items: TaskSummary[]; total: number; nextOffset: number | null }> {
    this.access.assert(actor)
    if (!Number.isSafeInteger(query.offset) || query.offset < 0
      || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.config.maxHistoryPageSize
      || query.keyword.length > 120) throw new AccessError(400, '历史查询参数无效', 'history_query_invalid')
    const conversationId = query.conversationId ?? ''
    if (conversationId === '') return await this.storage.history(actor, query)
    // 会话 id 形状不对就当场拒掉；归属也一起核，别人拿不到存在性，也不会拿它去寻址别的会话。
    this.validateId(conversationId)
    await this.storage.assertOwner(conversationId, actor)
    return await this.storage.history(actor, { ...query, conversationId })
  }

  /** 一条任务的完整记录。对外只给既有公开字段，管家内部的派单材料不进任何响应。 */
  async task(actor: Actor, id: string) {
    this.access.assert(actor)
    const record = await this.storage.task(actor, id)
    if (record === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
    // `inputRefs`/`inputRefsState`（派单材料原文、来源快照与「为什么是这个值」）和
    // `memberReturn`（协作返回原文）是管家内部数据：原文长度不受页面展示摘要边界约束，
    // 序列化进 HTTP/SSE 就等于把内部材料漏到对外响应里。
    // 内部派单、依赖判定与恢复照旧读 `storage.task` 的完整记录，不受这里裁剪影响。
    return {
      ...record,
      subtasks: record.subtasks.map(({
        inputRefs: _inputRefs, inputRefsState: _inputRefsState, memberReturn: _memberReturn, ...rest
      }) => rest),
    }
  }

  /** 右栏状态摘要。 */
  async overview(actor: Actor): Promise<{ counts: TaskCounts; failures: { id: string; goal: string; error: string; updatedAt: number }[] }> {
    this.access.assert(actor)
    return { counts: await this.storage.counts(actor), failures: await this.storage.recentFailures(actor, 5) }
  }

  /**
   * 用户按下停止。
   *
   * `taskId` 可选。给了就只中止「这一轮确实在跑那个任务」的情况：旧任务迟到的取消
   * 请求不该碰到该会话随后开的新任务，所以对不上时如实返回「已经不在执行」，
   * 而不是顺手把当前这一轮也掐掉。
   *
   * `accepted` 只表示中止请求已经发出去。执行方是不是真的停下，要等它自己以
   * `cancelled` 收尾或超时兜底，页面状态也到那一步才改。
   */
  async cancel(conversationId: string, actor: Actor, taskId = ''): Promise<CancelOutcome> {
    this.access.assert(actor)
    const id = this.validateId(conversationId)
    await this.storage.assertOwner(id, actor)
    if (taskId !== '') {
      const record = await this.storage.task(actor, taskId)
      if (record === undefined || record.conversationId !== id) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
    }
    const active = this.runs.get(id)
    if (active === undefined) return { accepted: false, reason: '现在没有正在执行的一轮' }
    if (taskId !== '') {
      // 必须严格对上。当前这一轮还在理解阶段（日志里还没有 taskId）时也算对不上：
      // 那多半是另一个新任务刚起步，拿旧任务的取消去掐它才是真的误伤。
      const current = this.logs.get(id)?.head()?.taskId ?? ''
      if (current !== taskId) return { accepted: false, reason: '这个任务已经不在执行了' }
    }
    this.abort(id)
    return { accepted: true, reason: '' }
  }

  /** 中止所有正在跑的会话；登录被撤销和插件卸载时使用。 */
  cancelAll(): void {
    for (const conversationId of [...this.runs.keys()]) this.abort(conversationId)
  }

  /** 中止一轮：先中止执行方，再取消牛马大总管自己这一轮。 */
  private abort(conversationId: string): void {
    this.runs.get(conversationId)?.abort.abort()
    this.conversations.get(conversationId)?.handle.agent.cancel({ kind: 'user' })
  }

  /**
   * 观察一个会话最近一轮的事件流。
   *
   * 只读：不启动任何执行，也不会让正在跑的任务重跑一遍。新增观察者只影响它自己
   * 那一条流，断线也只是它不再读。
   *
   * `signal` 只用来结束**这次观察**（客户端断开时立刻收摊，不必等下一个事件），
   * 与任务本身是否继续无关。
   *
   * 返回 `undefined` 表示这个会话还没有可以观察的一轮，由调用方决定是提示
   * 「现在没有任务」还是等下一轮。
   */
  async watch(conversationId: string, actor: Actor, after: number, signal?: AbortSignal): Promise<RunWatch | undefined> {
    this.access.assert(actor)
    const id = this.validateId(conversationId)
    await this.storage.assertOwner(id, actor)
    const log = this.logs.get(id)
    if (log === undefined) return undefined
    const head = log.head()
    if (head === null) return undefined
    // 头部与事件流在同一个同步块里取：分成两次调用时若换了轮次，订阅会跟到别的任务上。
    // 归属校验的 await 不会破坏这个配对——它在这两步之前完成。
    return { head, events: log.follow(head.runId, after, signal) }
  }

  /**
   * 受理一条用户消息：做完所有可预期的校验，把这一轮登记为「正在执行」。
   *
   * 到这一步为止的失败都是同步可见的（参数不对、上一轮还没完、会话不属于这个登录），
   * 调用方能直接给出 `400`／`409`，不必让用户去一条 SSE 流里找原因。
   */
  private async prepareTurn(conversationId: string, message: string, actor: Actor, runId: string): Promise<PreparedTurn> {
    this.access.assert(actor)
    const text = message.trim()
    if (text === '') throw new AccessError(400, '消息不能为空', 'message_empty')
    if ([...text].length > this.config.maxMessageChars) throw new AccessError(400, `消息过长，最多 ${this.config.maxMessageChars} 个字符`, 'message_too_long')
    this.validateId(conversationId)
    const conversation = await this.open(conversationId, true, actor)
    if (conversation === undefined) throw new AccessError(500, '无法打开牛马大总管会话', 'conversation_open_failed')
    this.access.assert(actor)
    // 同会话执行互斥（T1-2 不变量 a）：`conversation.active` 检查到置位、`claims` 检查到
    // 占用之间不得插入任何 await——中间让出执行权，一次回话或补充会挤进来换掉运行引用和
    // 事件日志，把在跑的回合变成不可停止。会话标题的写入因此挪到全部互斥标志立好之后。
    if (conversation.active) throw new AccessError(409, '牛马大总管正在处理上一条消息，请先停止或等待完成', 'run_busy')
    if (this.claims.has(conversationId)) throw new AccessError(409, '这个会话还有一次执行没有结束，请等它完成或先停止', 'run_busy')

    conversation.active = true
    conversation.lastUsedAt = Date.now()
    const abort = new AbortController()
    this.runs.set(conversationId, { runId, abort })
    this.claims.set(conversationId, { runId, kind: 'turn' })
    await this.storage.touchConversation(conversationId, actor, text)
    return { conversationId, conversation, text, actor, runId, abort }
  }

  /**
   * 跑完一轮，按发生顺序产出事件。
   *
   * 串行调度：计划本身表达的是先后关系，而且并行会让右栏状态难以解释。需要并行
   * 时再作为独立改动引入。
   */
  private async *turnBody(turn: PreparedTurn): AsyncGenerator<ButlerEvent> {
    const { conversation, conversationId, text, actor, abort } = turn
    yield { type: 'user', text, time: Date.now() }

    try {
      // 第一段：理解与拆解。它自己的话边收边上：回合还没结束就把增量发给页面。
      const speech = progressQueue()
      const planningTurn = this.runTurn(conversation, text, abort.signal,
        delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }),
        () => speech.push({ type: 'chat_reset', time: Date.now() }),
        undefined,
        thinking => speech.push({ type: 'chat_thinking', role: 'butler', thinking, time: Date.now() }))
      void planningTurn.then(() => speech.settle(), () => speech.settle())
      for await (const event of speech.drain()) yield event
      const planning = await planningTurn
      if (planning.outcome.kind === 'cancelled') {
        yield { type: 'summary', taskId: '', text: '', state: 'cancelled', error: '已停止', time: Date.now() }
        return
      }
      if (planning.outcome.kind === 'failed') {
        if (planning.text !== '') yield { type: 'chat', role: 'butler', text: planning.text, time: Date.now() }
        yield { type: 'error', message: `牛马大总管回答失败：${planning.outcome.message}`, code: 'turn_failed', time: Date.now() }
        return
      }
      const plan = planning.plans.at(-1)
      if (plan === undefined) {
        // 不需要调度：牛马大总管已经直接回答了。
        yield { type: 'chat', role: 'butler', text: planning.text, time: Date.now() }
        return
      }
      if (plan.reply !== '') yield { type: 'chat', role: 'butler', text: plan.reply, time: Date.now() }

      // 计划立刻落盘，刷新页面也能找回这次任务。
      const taskId = `butler-task-${randomUUID()}`
      const subtasks: {
        id: string
        goal: string
        agentId: string
        reason: string
        displayName: string
        logicalId?: string
        supersedes?: string
        dependsOn?: readonly string[]
        requiresExternalAction?: boolean
      }[] = []
      for (const subtask of plan.subtasks) {
        subtasks.push({
          id: `s${subtasks.length + 1}`,
          goal: subtask.goal,
          agentId: subtask.agentId,
          reason: subtask.reason,
          displayName: await this.displayNameOf(actor, subtask.agentId),
          // 目标标识与依赖要落库：前者决定聚合按谁算，后者决定这一步该不该派。
          ...(subtask.logicalId === undefined ? {} : { logicalId: subtask.logicalId }),
          ...(subtask.supersedes === undefined ? {} : { supersedes: subtask.supersedes }),
          ...(subtask.dependsOn === undefined ? {} : { dependsOn: subtask.dependsOn }),
          ...(subtask.requiresExternalAction === true ? { requiresExternalAction: true } : {}),
        })
      }
      await this.storage.createTask({ id: taskId, conversationId, actor, goal: text, note: plan.note, subtasks })
      yield { type: 'plan', taskId, goal: text, note: plan.note, subtasks, time: Date.now() }

      // 第二段：按顺序调度。
      for (const subtask of subtasks) {
        if (abort.signal.aborted) {
          await this.queueSubtaskWrite(taskId, subtask.id, () => this.storage.setSubtaskState(taskId, subtask.id, 'cancelled', { error: '已停止' }))
          yield {
            type: 'subtask', taskId, id: subtask.id, state: 'cancelled',
            agentId: subtask.agentId, displayName: subtask.displayName, detail: '已停止', time: Date.now(),
          }
          continue
        }
        for await (const event of this.dispatchSubtask({
          taskId, subtaskId: subtask.id, goal: subtask.goal, agentId: subtask.agentId,
          displayName: subtask.displayName, taskGoal: text, actor, signal: abort.signal,
          ...(subtask.dependsOn === undefined ? {} : { dependsOn: subtask.dependsOn }),
          ...(subtask.requiresExternalAction === true ? { requiresExternalAction: true } : {}),
        })) {
          yield event
        }
      }

      // 第三段：汇总与收尾。
      //
      // 子任务结局与汇总材料都**从库里重建**，而不是在循环里边跑边攒：补话那条路径上
      // 内存里早已没有这一轮的累积值（进程可能都换过一次），两条路径用同一个口径才不会
      // 出现「派活时汇总内容对、补话后汇总内容少一半」这种只在某条路径上复现的偏差。
      yield* this.closeTask({
        taskId,
        conversation,
        goal: text,
        subtasks: await this.storedSubtasks(actor, taskId, subtasks),
        reports: await this.storedReports(actor, taskId),
        signal: abort.signal,
        stopped: abort.signal.aborted,
      })
    } finally {
      conversation.active = false
      conversation.lastUsedAt = Date.now()
      // 只在自己还是当前那一轮时才清：同一会话上的补话会换一轮，别把新记录删掉。
      if (this.runs.get(conversationId)?.runId === turn.runId) this.runs.delete(conversationId)
      this.releaseClaim(conversationId, turn.runId)
    }
  }

  /** 直接跑一轮，把事件产出给调用方。不经过事件日志，供内部编排与测试使用。 */
  async *send(conversationId: string, message: string, actor: Actor): AsyncGenerator<ButlerEvent> {
    yield* this.turnBody(await this.prepareTurn(conversationId, message, actor, `butler-run-${randomUUID()}`))
  }

  /**
   * 受理一轮并在后台执行，事件写进会话日志。
   *
   * 返回的是受理凭据而不是结果。提交方随后用 `watch()` 订阅；订阅断了只表示不再读，
   * 与这一轮是否继续执行无关 —— 关掉页面不再等于取消。
   *
   * 带了 `requestId` 时：受理之后、执行之前先把这个占用**落库**，所以进程哪怕在下一毫秒
   * 就没了，重启后同一个请求也会被认出「受理过」，而不是再跑一遍。同一身份、同一类型下的
   * `requestId` 一旦用在别的请求上就直接拒绝：那多半是客户端把 id 生成错了，静默当成同一次
   * 会让两条不同的需求合成一条。
   */
  async start(conversationId: string, message: string, actor: Actor, requestId = ''): Promise<StartedRun> {
    const digest = digestOf([conversationId, message])
    if (requestId !== '') {
      const existing = await this.storage.request(actor, 'chat', requestId)
      if (existing !== undefined) return this.replayRequest(existing, digest, requestId)
    }

    const runId = `butler-run-${randomUUID()}`
    if (requestId !== '') {
      // 占位早于受理：受理本身就会开任务、开会话，两个并发提交各开一份就不是「同一次请求」了。
      const winner = await this.storage.claimRequest(actor, 'chat', requestId, digest, runId, '', this.config.idempotencyTtlMs)
      if (winner !== undefined) return this.replayRequest(winner, digest, requestId)
    }
    let turn: PreparedTurn
    try {
      turn = await this.prepareTurn(conversationId, message, actor, runId)
    } catch (error) {
      // 受理没成功（会话打不开、参数不合法）：撤掉占位，同一个 requestId 还能再提交。
      if (requestId !== '') this.releaseRequestQuietly(actor, 'chat', requestId)
      throw error
    }
    if (requestId !== '') await this.storage.bindRequest(actor, 'chat', requestId, turn.runId, turn.conversationId)
    // 不变量（T1-2 c）：beginLog 是 SSE 的起点，必须等全部存储 await（占位/受理/绑定）完成
    // 之后再开——日志一起点，早到的事件就会写进一份可能作废的受理里。
    const log = this.beginLog(turn.conversationId, turn.runId)
    void this.pump(turn.abort.signal, log, this.turnBody(turn))
      .then(() => { if (requestId !== '') void this.finishRequestWithRetry(actor, 'chat', requestId) })
      .catch(error => { console.error(`butler-console: 回合收尾链失败（${turn.conversationId}/${turn.runId}）：${visibleError(error, 300)}\n${stackOf(error)}`) })
    return { runId: turn.runId, conversationId: turn.conversationId, from: 0 }
  }

  /** 受理一次补话并在后台执行。幂等规则同 {@link start}。 */
  async startReply(input: {
    taskId: string
    subtaskId: string
    text: string
    decideByAgent: boolean
    actor: Actor
    requestId?: string
  }): Promise<StartedRun> {
    const requestId = input.requestId ?? ''
    const digest = digestOf([input.taskId, input.subtaskId, input.text, String(input.decideByAgent)])
    if (requestId !== '') {
      const existing = await this.storage.request(input.actor, 'reply', requestId)
      if (existing !== undefined) return this.replayRequest(existing, digest, requestId)
    }

    const runId = `butler-run-${randomUUID()}`
    if (requestId !== '') {
      const winner = await this.storage.claimRequest(input.actor, 'reply', requestId, digest, runId, '', this.config.idempotencyTtlMs)
      if (winner !== undefined) return this.replayRequest(winner, digest, requestId)
    }
    let prepared: PreparedReply
    try {
      prepared = await this.prepareReply(input, runId)
    } catch (error) {
      if (requestId !== '') this.releaseRequestQuietly(input.actor, 'reply', requestId)
      throw error
    }
    if (requestId !== '') await this.storage.bindRequest(input.actor, 'reply', requestId, prepared.runId, prepared.conversationId)
    // 不变量（T1-2 c）：SSE 日志起点在全部存储 await 完成之后，理由同 {@link start}。
    const log = this.beginLog(prepared.conversationId, prepared.runId)
    void this.pump(prepared.abort.signal, log, this.replyBody(prepared))
      .then(() => { if (requestId !== '') void this.finishRequestWithRetry(input.actor, 'reply', requestId) })
      .catch(error => { console.error(`butler-console: 回话收尾链失败（${prepared.conversationId}/${prepared.runId}）：${visibleError(error, 300)}\n${stackOf(error)}`) })
    return { runId: prepared.runId, conversationId: prepared.conversationId, from: 0 }
  }

  /**
   * 受理一条补充：修改或追加**当前**任务的目标。
   *
   * 三个入口各管一件事，不能混用：`/chat` 开新回合、`/reply` 回答成员的问题、
   * 这里改当前目标。把补充塞进 `/chat` 会另开一轮，任务记录就此分家；塞进 `/reply`
   * 则会被当成对某位成员的回答。
   *
   * 受理与处理是分开的：这里返回的是「已经收下」，随后的事件流才说明处理到哪一步。
   */
  async submitSupplement(input: SupplementRequest): Promise<StartedRun> {
    const requestId = input.requestId ?? ''
    const digest = digestOf([input.taskId, input.text])
    if (requestId !== '') {
      const existing = await this.storage.request(input.actor, 'supplement', requestId)
      if (existing !== undefined) return this.replayRequest(existing, digest, requestId)
    }

    const runId = `butler-run-${randomUUID()}`
    if (requestId !== '') {
      // 占位排在**一切副作用之前**：受理会写输入、开一轮，两个并发提交各写一条就没有
      // 「同一次提交」可言了。判定与写入在存储层是同一个事务，所以并发时只有一个能赢，
      // 输的那个连输入都不会写。
      const winner = await this.storage.claimRequest(input.actor, 'supplement', requestId, digest, runId, '', this.config.idempotencyTtlMs)
      if (winner !== undefined) return this.replayRequest(winner, digest, requestId)
    }
    let prepared: PreparedSupplement
    try {
      prepared = await this.prepareSupplement(input, runId)
    } catch (error) {
      // 受理本身没成功（版本对不上、任务已结束、会话打不开）：撤掉占位。留着它会让同一个
      // requestId 再提交时被当成「结果不明」，把一个根本没开始的执行报成待恢复的状态。
      if (requestId !== '') this.releaseRequestQuietly(input.actor, 'supplement', requestId)
      throw error
    }
    if (requestId !== '') await this.storage.bindRequest(input.actor, 'supplement', requestId, prepared.runId, prepared.conversationId)
    // 不变量（T1-2 c）：SSE 日志起点在全部存储 await 完成之后，理由同 {@link start}。
    const log = this.beginLog(prepared.conversationId, prepared.runId)
    void this.pump(prepared.abort.signal, log, this.supplementBody(prepared))
      .then(() => { if (requestId !== '') void this.finishRequestWithRetry(input.actor, 'supplement', requestId) })
      .catch(error => { console.error(`butler-console: 补充收尾链失败（${prepared.conversationId}/${prepared.runId}）：${visibleError(error, 300)}\n${stackOf(error)}`) })
    return { runId: prepared.runId, conversationId: prepared.conversationId, from: 0 }
  }

  /**
   * 受理一条补充。
   *
   * 三件可预期的失败都当场给出：任务不存在、任务已经结束、以及版本对不上。最后那条是并发
   * 依据 —— 两个入口同时改同一个任务时，后提交的那个会被拒，而不是让两份补充互相覆盖。
   *
   * 这里的检查只是**快速失败**（省掉一次打开会话）。真正算数的是 `addInput` 事务里的那次
   * 复核：受理要打开会话，那是一段异步窗口，任务可能就在这期间被别人收尾，或者另一个入口
   * 已经改到了下一版。事务外查过的结论不能拿来写数据。
   */
  private async prepareSupplement(input: SupplementRequest, runId: string): Promise<PreparedSupplement> {
    this.access.assert(input.actor)
    const record = await this.storage.task(input.actor, input.taskId)
    if (record === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
    if (isTerminal(record.state)) {
      // 终态任务不接受补充：改写旧结论会让「历史里的这一轮」变来变去，后续跟进是新的一轮。
      throw new AccessError(409, '这一轮已经结束，改目标请用 /chat 开新的一轮', 'task_already_finished')
    }
    if (input.expectVersion !== undefined && input.expectVersion !== record.acceptedVersion) {
      throw new AccessError(409, `这一轮已经更新到第 ${record.acceptedVersion} 版，请按最新内容重新提交`, 'version_conflict')
    }
    const conversation = await this.open(record.conversationId, false, input.actor)
    if (conversation === undefined) throw new AccessError(500, '无法打开牛马大总管会话', 'conversation_open_failed')
    this.access.assert(input.actor)
    // 版本与原文一起落库，之后才谈处理。核验也在同一个事务里再走一遍。
    const version = await this.storage.addInput(input.actor, input.taskId, input.text, 'supplement', input.expectVersion)
    return {
      conversationId: record.conversationId,
      conversation,
      taskId: input.taskId,
      text: input.text,
      version,
      actor: input.actor,
      runId,
      abort: new AbortController(),
    }
  }

  /**
   * 处理一条补充。
   *
   * 先等当前这一轮跑到安全点：补充本来就是运行中提出来的，不能因此把正在跑的活打断。
   * 等到了之后再交给大总管判断它是「换个说法」还是「改了范围」。
   */
  private async *supplementBody(prepared: PreparedSupplement): AsyncGenerator<ButlerEvent> {
    const { taskId, version, actor, conversation, conversationId } = prepared
    yield { type: 'input', taskId, version, text: prepared.text, source: 'supplement', time: Date.now() }
    if (!(await this.awaitExecution(conversation, conversationId, prepared.runId, prepared.abort.signal))) return

    this.runs.set(conversationId, { runId: prepared.runId, abort: prepared.abort })
    try {
      const record = await this.storage.task(actor, taskId)
      if (record === undefined) return
      /**
       * 等空闲的这段时间里，这条补充可能已经被处理掉了。
       *
       * 补单一进来就会起一个回合，它要等当前这一轮跑到安全点；等的过程中老板可能又改了一次
       * （那一轮会把这条一起处理），或者这一轮已经收尾。这时再处理一遍等于把同一句话喂两遍
       * 模型，还会把已经写好的终态再写一次。
       */
      const handled = await this.storage.inputVersions(taskId)
      if (isTerminal(record.state) || (handled !== undefined && handled.processed >= version)) return
      const prompt = supplementPrompt(await this.storage.inputs(taskId), record.subtasks)

      const speech = progressQueue()
      const turn = this.runTurn(conversation, prompt, prepared.abort.signal,
        delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }),
        () => speech.push({ type: 'chat_reset', time: Date.now() }),
        { taskId, subtasks: record.subtasks },
        thinking => speech.push({ type: 'chat_thinking', role: 'butler', thinking, time: Date.now() }))
      void turn.then(() => speech.settle(), () => speech.settle())
      for await (const event of speech.drain()) yield event
      const outcome = await turn

      if (outcome.outcome.kind === 'cancelled') {
        yield { type: 'summary', taskId, text: '', state: 'cancelled', error: '已停止', time: Date.now() }
        return
      }
      if (outcome.outcome.kind === 'failed') {
        if (outcome.text !== '') yield { type: 'chat', role: 'butler', text: outcome.text, time: Date.now() }
        yield { type: 'error', message: `处理补充失败：${outcome.outcome.message}`, code: 'turn_failed', time: Date.now() }
        return
      }
      // 到这里这条补充才算**处理过**：理解完成，版本跟着追平。
      //
      // 追平到「读取输入时已包含的版本」，而不是受理时那个版本号：受理之后、读取之前进来的
      // 补充也在这份 prompt 里，只记自己那一版会把它留成「已接受未处理」，让它再被处理一遍。
      await this.storage.setProcessedVersion(taskId, (await this.storage.inputVersions(taskId))?.accepted ?? version)

      const plan = outcome.plans.at(-1)
      if (plan !== undefined) {
        // 改了范围或追加了工作：新活追加到**同一个任务**里，编号接着往下排。
        const existing = await this.storage.task(actor, taskId)
        if (existing === undefined) return
        const base = existing.subtasks.length
        const appended: {
          id: string
          goal: string
          agentId: string
          reason: string
          displayName: string
          logicalId?: string
          supersedes?: string
          dependsOn?: readonly string[]
          requiresExternalAction?: boolean
        }[] = []
        for (const subtask of plan.subtasks) {
          appended.push({
            id: `s${base + appended.length + 1}`,
            goal: subtask.goal,
            agentId: subtask.agentId,
            reason: subtask.reason,
            displayName: await this.displayNameOf(actor, subtask.agentId),
            // 目标标识与替代关系要原样带进库：聚合按它们判断「哪条尝试算数」，
            // 漏掉的话重做的活会被当成一个新目标，旧的失败继续拉低结论。
            ...(subtask.logicalId === undefined ? {} : { logicalId: subtask.logicalId }),
            ...(subtask.supersedes === undefined ? {} : { supersedes: subtask.supersedes }),
            ...(subtask.dependsOn === undefined ? {} : { dependsOn: subtask.dependsOn }),
            ...(subtask.requiresExternalAction === true ? { requiresExternalAction: true } : {}),
          })
        }
        await this.storage.appendSubtasks(actor, taskId, appended)
        if (plan.reply !== '') yield { type: 'chat', role: 'butler', text: plan.reply, time: Date.now() }
        yield { type: 'plan', taskId, goal: existing.goal, note: plan.note, subtasks: appended, time: Date.now() }

        for (const subtask of appended) {
          if (prepared.abort.signal.aborted) break
          yield* this.dispatchSubtask({
            taskId, subtaskId: subtask.id, goal: subtask.goal, agentId: subtask.agentId,
            displayName: subtask.displayName, taskGoal: existing.goal, actor, signal: prepared.abort.signal,
            ...(subtask.dependsOn === undefined ? {} : { dependsOn: subtask.dependsOn }),
            ...(subtask.requiresExternalAction === true ? { requiresExternalAction: true } : {}),
          })
        }
      } else if (outcome.text !== '') {
        // 只是换个说法：大总管已经按新表达给出了结论，没有再派活。
        yield { type: 'chat', role: 'butler', text: outcome.text, time: Date.now() }
      }

      // 收尾前先排空队列（依赖重判方案 §3.2，Q3 已批准）：补充追加的新行（含 supersedes
      // 新尝试）派完之后，既有排队下游的依赖状态可能已经变化 —— 新尝试成功、旧失败不再算数。
      // 与 closeAfterReply 复用同一 drainQueue，传导给排队下游之后才谈收尾。
      yield* this.drainQueue({
        taskId,
        actor,
        goal: (await this.storage.task(actor, taskId))?.goal ?? '',
        signal: prepared.abort.signal,
      })

      // 收尾走同一条路径：它按库里的子任务结局决定终态，也负责把材料与外部待办留住。
      yield* this.closeTask({
        taskId,
        conversation,
        goal: (await this.storage.task(actor, taskId))?.goal ?? '',
        subtasks: await this.storedSubtasks(actor, taskId, []),
        reports: await this.storedReports(actor, taskId),
        signal: prepared.abort.signal,
        stopped: prepared.abort.signal.aborted,
      })
    } finally {
      if (this.runs.get(conversationId)?.runId === prepared.runId) this.runs.delete(conversationId)
      this.releaseClaim(conversationId, prepared.runId)
    }
  }

  /**
   * 等安全点并取得同会话执行权。
   *
   * 补充要等当前这一轮跑到安全点，不能把正在跑的活打断；执行权还可能被一次回话或另一条
   * 补充占着——回话不会处理输入表里的补充，跳过会让这条补充永远留在「已接受未处理」，
   * 所以等到为止而不是放弃。等待期间可以被取消，插件卸下时也直接放弃。
   */
  private async awaitExecution(conversation: Conversation, conversationId: string, runId: string, signal: AbortSignal): Promise<boolean> {
    while (conversation.active || !this.claimNow(conversationId, runId, 'supplement')) {
      if (signal.aborted || this.disposed) return false
      // 轮询而不是另做一套唤醒：这一批只要求「不打断」，等到就跑，等不到就随取消结束。
      await new Promise(resolve => { setTimeout(resolve, 200).unref?.() })
    }
    return true
  }

  /**
   * 同一个 `requestId` 又来了：给原凭据，**绝不重跑**。
   *
   * 三种情形，调用方能分清：
   *
   * - 同进程内还记得这一轮 → 正常重放事件，客户端能看到完整过程；
   * - 那一轮已经结束（事件日志被下一轮覆盖）→ 标 `unknown`，说明结果去读快照；
   * - 受理过但没有任何终态证据（进程在这里断过）→ 同样标 `unknown`，并说明**不会重跑**。
   *
   * 后两种都不会重新执行：那些可能带外部副作用的活正是最不该重跑的，宁可让用户去看一眼
   * 快照，也不能悄悄再派一次。
   */
  private replayRequest(existing: RequestRecord, digest: string, requestId: string): StartedRun {
    if (existing.digest !== digest) {
      throw new AccessError(409, `requestId ${requestId} 已经用在另一次请求上，换一个再提交`, 'idempotency_conflict')
    }
    const started: StartedRun = { runId: existing.runId, conversationId: existing.conversationId, from: 0 }
    if (this.logs.get(existing.conversationId)?.head()?.runId === existing.runId) return started
    const finished = existing.state === 'finished'
    return {
      ...started,
      unknown: true,
      unknownCode: finished ? 'run_already_finished' : 'run_result_unknown',
      message: finished
        ? '这次提交已经处理过，那一轮也已经结束；结果请读任务快照。'
        : '这次提交已经受理过，但执行结果不明（服务在这里重启过）；不会重新执行，请读任务快照确认，或另起一轮。',
    }
  }

  /**
   * 给一次「等用户回话」上闹钟。
   *
   * 等待不是终态，所以 `subtaskTimeoutMs` 那个只管执行的定时器已经撤了；不另起一个的话，
   * 没人回话的等待会永远挂在那里 —— 计数只增不减，用户下次进来看到一条不知道自己还要
   * 不要回的任务。
   */
  private async scheduleWaitingTimeout(taskId: string, subtaskId: string, displayName: string, actor: Actor): Promise<void> {
    const key = `${taskId}:${subtaskId}`
    this.clearWaitingTimeout(key)
    const conversationId = (await this.storage.task(actor, taskId))?.conversationId ?? ''
    // 查不到会话就不上闹钟：超时收尾要按会话归属写回去，无从下手时宁可不动。
    if (conversationId === '') return
    const timer = setTimeout(
      () => {
        // 后台收尾的失败只落服务端日志：它是无人等待的 Promise，绝不成为宿主的
        // unhandledRejection（§3 后台错误不外溢）。
        void this.expireWaiting(key, taskId, subtaskId, displayName, actor).catch(error => {
          console.error(`butler-console: 等待超时收尾失败（${key}）：${visibleError(error, 300)}\n${stackOf(error)}`)
        })
      },
      this.config.waitingTimeoutMs,
    )
    // 别让一个等待中的闹钟把进程钉住不退出。
    timer.unref?.()
    this.waitingTimers.set(key, timer)
  }

  /** 撤掉一次等待的闹钟；没有时什么都不做。 */
  private clearWaitingTimeout(key: string): void {
    const timer = this.waitingTimers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.waitingTimers.delete(key)
  }

  /**
   * 读一段对话正文。
   *
   * 正文**不在这里另存一份**：它一直是 DSH 官方会话日志的内容，这里只是按当前登录身份
   * 鉴权之后读出来。第二入口需要老板的原话和管家的答复才能真的接着处理，光有任务级摘要
   * 不够 —— 那也是这个接口存在的理由。
   *
   * 只返回用户可见的东西：真人输入的用户消息与已提交的助手答复。注入的上下文、系统提示词、
   * 工具调用与未提交的尝试都不出声，推理内容同样不出。
   *
   * 日志不存在或读不到时**如实报错**，不拿任务摘要冒充一段完整对话：那会让客户端以为
   * 自己看到的是全部。
   */
  async transcript(
    conversationId: string,
    actor: Actor,
    after: number,
    limit: number,
    options: { before?: number; tail?: boolean } = {},
  ): Promise<TranscriptPage> {
    this.access.assert(actor)
    const id = this.validateId(conversationId)
    await this.storage.assertOwner(id, actor)

    let handle: SessionHandle
    try {
      // 只读打开：不取写所有权，因此跟正在跑的那一轮并存，也不会影响它。
      handle = await this.ctx.sessionPersistence.open(SessionId(id), 'read')
    } catch (error) {
      if (isNotFound(error)) {
        throw new AccessError(404, '这次会话还没有可读的对话正文', 'transcript_not_found')
      }
      console.error(`butler-console: 读取对话正文失败：${visibleError(error, 300)}\n${stackOf(error)}`)
      throw new AccessError(503, '对话正文暂时读不到', 'transcript_unavailable')
    }

    try {
      // 尾读模式（C 批历史阅读）：先取最新一页，再按 before 往更早翻。
      if (options.tail === true || options.before !== undefined) {
        return await this.readTranscriptTail(handle, id, options.before, limit)
      }
      // 往前多读一段只为重建回合号；真正返回的仍是 seq >= after 的那些。
      const lead = Math.max(0, after - TRANSCRIPT_LEAD_EVENTS)
      const want = (after - lead) + limit * 8
      const { events } = await handle.read(lead, want)
      const { items, cursor, full } = this.readTranscript(events, after, limit)
      // 「还有没有下一页」要看两件事：这一页是不是被 limit 截断的，以及事件本身读完了没有。
      // 只看事件数会误判 —— 日志很短但 limit 更小时，明明还有可见消息却报到底了。
      const exhausted = events.length < want && !full
      return { conversationId: id, items, nextAfter: exhausted ? null : cursor, prevBefore: null }
    } finally {
      await handle.close()
    }
  }

  /**
   * 从日志尾部读一页（C 批历史阅读）：`before` 给出时只收该序号之前的内容。
   *
   * 会话日志只有正向读取原语，「先看最新、往更早翻」只能分块扫过去再取末尾——成本随
   * 日志长度线性，换来的是不动宿主接口。回合号在扫描中跨块累积维护，翻页从回合中间
   * 开始也认得出归属。`prevBefore` 是本页最早一条的 seq：还有更早内容时给客户端续翻。
   */
  private async readTranscriptTail(
    handle: SessionHandle,
    id: string,
    before: number | undefined,
    limit: number,
  ): Promise<TranscriptPage> {
    const collected: TranscriptItem[] = []
    let offset = 0
    let turn: number | null = null
    for (;;) {
      const { events } = await handle.read(offset, TRANSCRIPT_SCAN_CHUNK)
      let reached = false
      for (const event of events) {
        if (event.type === 'turn/start') turn = event.data.turn
        if (before !== undefined && event.seq >= before) { reached = true; break }
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          const item = this.transcriptItem(event, turn)
          if (item !== null) collected.push(item)
        }
      }
      if (reached || events.length < TRANSCRIPT_SCAN_CHUNK) break
      offset += events.length
    }
    const items = collected.slice(-limit)
    const hasOlder = collected.length > items.length
    const earliest = items[0]
    return {
      conversationId: id,
      items,
      nextAfter: null,
      prevBefore: hasOlder && earliest !== undefined ? earliest.seq : null,
    }
  }

  /**
   * 从一段事件里挑出用户可见的消息。
   *
   * `after` 之前的只用来认回合号，不进结果 —— 翻页从回合中间开始时，没有那一段就认不出
   * 这条消息属于哪一轮。游标始终往前走，即使这一段里一条可见消息都没有，客户端也不会
   * 卡在同一个位置反复读。
   *
   * `full` 表示这一页是被 `limit` 截断的：后面还有可见消息，调用方不能当成读完了。
   */
  private readTranscript(
    events: readonly SessionEvent[],
    after: number,
    limit: number,
  ): { items: TranscriptItem[]; cursor: number; full: boolean } {
    const items: TranscriptItem[] = []
    let turn: number | null = null
    let cursor = after
    let full = false

    for (const event of events) {
      if (event.type === 'turn/start') {
        turn = event.data.turn
        continue
      }
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      // 认回合号用的那一段不进结果，但它已经把 turn 记下来了。
      if (event.seq < after) continue
      if (items.length >= limit) { full = true; break }

      const item = this.transcriptItem(event, turn)
      if (item !== null) items.push(item)
      cursor = event.seq + 1
    }

    return { items, cursor, full }
  }

  /** 把一条会话事件翻译成对话正文里的条目；不是用户可见内容时返回 null。 */
  private transcriptItem(
    event: SessionEvent<'user/message'> | SessionEvent<'assistant/message'>,
    turn: number | null,
  ): TranscriptItem | null {
    if (event.type === 'user/message') {
      // 只认真人输入。注入的上下文、文件变更通知、目标续跑也都是 user 角色，但它们是
      // 宿主塞给模型的背景，出现在对话正文里会让人以为老板说过这些话。
      if (event.data.source.kind !== 'user') return null
      const text = textOf(event.data.content)
      if (text.trim() === '') return null
      return { seq: event.seq, messageId: String(event.data.id), role: 'user', text, time: event.time, turn }
    }
    // 只取已提交的助手答复；`assistant/attempt` 是没进过历史面的尝试，不该出现在对话里。
    const text = textOf(event.data.message.content)
    if (text.trim() === '') return null
    return {
      seq: event.seq, messageId: String(event.data.message.id), role: 'butler',
      text, time: event.time, turn: event.data.turn,
      ...(event.data.interrupted === true ? { interrupted: true as const } : {}),
    }
  }

  /**
   * 一次等待到点了：如实收成超时失败，材料全部保留。
   *
   * 结账用存储层的原子操作（§3 expireWaiting）：只有此刻仍处于 `waiting_user` 的那一条才会
   * 被置为 `failed`——上闹钟之后用户可能已经回过话、成员也已经接着干完，那时这次等待早就
   * 不是「等着」，什么都不该做。守卫在单条条件 UPDATE 里闭合，不再有读-写窗口。
   *
   * 全终结时把这一轮也收掉，但**不跑汇总轮** —— 没有人在看，而且用户随时可能开始新一轮，
   * 跟它抢同一个会话句柄只会让两边都出错。逐项结局与材料都在库里，下次进来读得到。
   *
   * 上游判 failed 之后、任务结账之前，同任务里仍排队的下游先经 {@link drainQueue} 走一次
   * 依赖判定（§3.2）：该失败的写明原因，还该等的保持排队，不再悬空。
   */
  private async expireWaiting(key: string, taskId: string, subtaskId: string, displayName: string, actor: Actor): Promise<void> {
    this.waitingTimers.delete(key)
    // `dispose()` 会撤掉所有闹钟，这里是竞态下的第二道：插件已经卸下之后不该再往库里写。
    if (this.disposed) return
    const expired = await this.storage.expireWaitingSubtask(taskId, subtaskId, WAITING_EXPIRED)
    if (!expired) return

    this.waiting.delete(key)
    console.warn(`butler-console: ${displayName} 的等待超过 ${Math.round(this.config.waitingTimeoutMs / 1000)} 秒没有回音，已按超时收尾（任务 ${taskId}）`)

    // 上游判 failed 之后，同任务的非终态下游先走一次依赖判定结账（依赖重判方案 §3.2，
    // Q3 已批准）：fail 的下游写明原因收成 failed，wait 的保持 queued 如实挂起，放行的
    // 照常派出去 —— 之前这里直接返回，排队下游会悬空到老板下一次人工过问。复用 drainQueue
    // （与 closeAfterReply 同一实现，不另造一套）。会话上正有回话或补充在执行时让位：那一轮
    // 自己的收尾会排空队列，两条路径同时派同一步会把它派两遍。
    const settled = await this.storage.task(actor, taskId)
    if (settled !== undefined) {
      const holder = this.claims.get(settled.conversationId)
      if (holder?.kind !== 'reply' && holder?.kind !== 'supplement') {
        // 这是无人观看的后台收尾：没有对应的 SSE 轮次，事件如实产出后不外推，状态与原因
        // 都以先写库的记录为准（先写库后上报的顺序在 drainQueue 内部保持）。
        for await (const _event of this.drainQueue({
          taskId, actor, goal: settled.goal, signal: new AbortController().signal,
        })) { /* 后台收尾没有 SSE 观众 */ }
      }
    }

    const after = await this.storage.task(actor, taskId)
    if (after === undefined || after.subtasks.some(item => !isTerminal(item.state))) return
    const active = effectiveSubtasks(after.subtasks)
    const failed = active.filter(item => item.state === 'failed').length
    await this.storage.setTaskState(taskId, failed === 0 ? 'completed' : failed === active.length ? 'failed' : 'partial', {
      summary: (await this.storedReports(actor, taskId)).join('\n\n'),
      error: WAITING_EXPIRED_TASK,
    })
  }

  /** 在会话上开一份新的事件日志，覆盖它的上一轮。 */  private beginLog(conversationId: string, runId: string): ConversationLog<ButlerEvent> {
    const log = new ConversationLog<ButlerEvent>(this.config.maxConversationEvents)
    log.begin(runId)
    this.logs.set(conversationId, log)
    return log
  }

  /**
   * 把一轮的事件搬进日志。
   *
   * 订阅者断线走不到这里，所以后台执行自己得保证两件事：事件一条不漏地进日志，
   * 以及无论成功、失败还是抛出，这一轮都必须落到一个终态。少了后者，`/events` 的
   * 读者会永远等在一个不会再产出事件的流上。
   */
  private async pump(
    signal: AbortSignal,
    log: ConversationLog<ButlerEvent>,
    events: AsyncGenerator<ButlerEvent>,
  ): Promise<void> {
    let state: 'finished' | 'cancelled' | 'failed' = 'finished'
    try {
      for await (const event of events) {
        if (event.type === 'plan') log.setTaskId(event.taskId)
        log.push(event)
        // 流式诊断（方案 S01）：应用事件**入队**点，入队后记录才能拿到本条的 runId 与 seq。
        // 与宿主帧、HTTP 写出（web.ts）、客户端接收/绘制对同一轮 runId。时间为服务端墙钟，
        // 与客户端 performance.now 不可直接相减。
        if (process.env.BUTLER_STREAM_DEBUG === '1') {
          const head = log.head()
          console.debug('butler-stream server-enqueue', {
            type: event.type, runId: head?.runId ?? '', seq: head?.seq ?? null, t: Date.now(),
          })
        }
      }
      if (signal.aborted) state = 'cancelled'
    } catch (error) {
      // 编排本身已经把大多数失败转成了事件；走到这里说明是编排之外的问题（例如写库失败）。
      console.error(`butler-console: 一轮执行中断：${visibleError(error, 500)}\n${stackOf(error)}`)
      log.push({ type: 'error', message: visibleError(error, 500), code: 'internal_error', time: Date.now() })
      state = 'failed'
    } finally {
      log.finish(state)
    }
  }

  /**
   * 跑牛马大总管的一轮并收集结果。
   *
   * 先注册记录再投递消息，避免第一轮的事件早于监听建立；`abort` 触发时按取消
   * 收尾，不让调用方无限等待。
   *
   * `context` 只在补充轮传：那一轮改的是某个已存在的任务，派活工具要靠它核对「替代的是哪一条
   * 旧尝试」。新的一轮还没有任务，传不了也不该传。
   */
  private async runTurn(
    conversation: Conversation,
    text: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onReset?: () => void,
    context?: { readonly taskId: string; readonly subtasks: readonly SubtaskRecord[] },
    onThinking?: (thinking: string) => void,
  ): Promise<{ outcome: TurnOutcome; text: string; plans: readonly PlanSubmission[] }> {
    const sessionId = String(conversation.handle.agent.session.id)
    const turn: Turn = {
      // 名单在组装提示词时读取，所以这里取的是「这一轮开始时」的在场情况。
      members: listAgentCards(this.ctx),
      ...(context === undefined ? {} : { context }),
      plans: [], text: '', done: false, outcome: { kind: 'cancelled' }, resolve: () => {},
    }
    this.turns.set(sessionId, turn)
    if (onDelta !== undefined) this.deltas.set(sessionId, onDelta)
    if (onReset !== undefined) this.deltaResets.set(sessionId, onReset)
    // 思考是覆盖语义：这一轮从空快照起头，上一轮的残留不会混进来。
    if (onThinking !== undefined) {
      this.thinkings.set(sessionId, onThinking)
      this.thinkingState.set(sessionId, { raw: '', published: '' })
    }
    const finished = new Promise<TurnOutcome>(resolve => {
      turn.resolve = outcome => {
        if (turn.done) return
        turn.done = true
        turn.outcome = outcome
        resolve(outcome)
      }
      signal.addEventListener('abort', () => { turn.resolve({ kind: 'cancelled' }) }, { once: true })
    })
    try {
      if (signal.aborted) return { outcome: { kind: 'cancelled' }, text: '', plans: [] }
      conversation.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      const outcome = await finished
      return { outcome, text: turn.text, plans: turn.plans }
    } catch (error) {
      // 同子任务失败：给用户的是裁剪过的一句话，栈单独进日志，否则线上只有一句话可查。
      console.error(`butler-console: 一轮失败：${visibleError(error, 500)}\n${stackOf(error)}`)
      return { outcome: { kind: 'failed', message: visibleError(error, 500) }, text: turn.text, plans: turn.plans }
    } finally {
      // 收尾补发一次完整思考快照：末行还在生成时页面用的是「正在生成…」占位，
      // 这里把最后一节补齐，页面才知道这轮的思考已经结束。
      this.flushThinking(sessionId, true)
      this.turns.delete(sessionId)
      this.deltas.delete(sessionId)
      this.deltaResets.delete(sessionId)
      this.streamAttempts.delete(sessionId)
      this.thinkings.delete(sessionId)
      this.thinkingState.delete(sessionId)
    }
  }

  /**
   * 宿主实时帧入口，由 `index.ts` 注册到 `ctx.on('agent/assistant-stream')`。
   *
   * 只处理牛马大总管当前回合的帧：其他插件 Agent 的帧与工具参数都不进页面。
   * - 正文增量走 `deltas`（页面追加）；
   * - 推理增量走 `thinkings`（页面覆盖，节流后只发稳定行）；
   * 一次回合里可能有多次尝试（重试会换 attemptId），这里不做尝试级区分 —— 落定的 `chat`
   * 会用最终正文替换整条预览，被重试掉的那一版不会留在页面上，思考也随新尝试重新起头。
   */
  observeStream(agent: { session?: { id?: unknown } } | undefined, frame: AssistantStreamFrame): void {
    // 流式诊断（方案 S01）：BUTLER_STREAM_DEBUG=1 时记录宿主帧的类型与长度——正文、推理与
    // 工具参数在这里区分开。不记录内容本身，跨机器时间不可直接相减。
    if (process.env.BUTLER_STREAM_DEBUG === '1' && frame.type === 'chunk') {
      const chunk = frame.chunk as { type?: unknown; text?: unknown }
      console.debug('butler-stream host-frame', { kind: String(chunk.type), len: typeof chunk.text === 'string' ? chunk.text.length : 0 })
    }
    const sessionKey = String(agent?.session?.id ?? '')
    if (sessionKey === '') return
    // 尝试隔离（S08）：`start` 宣告新尝试；旧尝试的迟到帧按当前尝试丢弃，预览重置。
    if (frame.type === 'start') {
      if (this.streamAttempts.get(sessionKey) !== frame.attemptId) {
        this.streamAttempts.set(sessionKey, frame.attemptId)
        this.deltaResets.get(sessionKey)?.()
        // 重试换的是另一次尝试：上一版的推理不能续到这一版上，思考快照重新起头。
        const state = this.thinkingState.get(sessionKey)
        if (state !== undefined) { state.raw = ''; state.published = '' }
      }
      return
    }
    if (frame.type !== 'chunk') return
    const kind = frame.chunk.type
    if (kind !== 'text-delta' && kind !== 'reasoning-delta') return
    const current = this.streamAttempts.get(sessionKey)
    if (current !== undefined && current !== frame.attemptId) return
    if (current === undefined) this.streamAttempts.set(sessionKey, frame.attemptId)
    const text = frame.chunk.text
    if (text === '') return
    if (kind === 'reasoning-delta') { this.collectThinking(sessionKey, text); return }
    this.deltas.get(sessionKey)?.(text)
  }

  /**
   * 收下一条推理增量，按节流发布思考快照。
   *
   * 逐字发会让页面反复重绘，所以攒够一个间隔再发；发的是**覆盖语义的整段快照**，
   * 页面直接替换思考区，不需要自己维护拼接状态。
   */
  private collectThinking(sessionKey: string, delta: string): void {
    const state = this.thinkingState.get(sessionKey)
    if (state === undefined || !this.thinkings.has(sessionKey)) return
    state.raw += delta
    if (state.timer !== undefined) return
    // 计时器用完就删掉键：`exactOptionalPropertyTypes` 下不能给可选属性赋 undefined，
    // 语义上也是「这个间隔已经结清」，不是「有一个值为 undefined 的计时器」。
    state.timer = setTimeout(() => { delete state.timer; this.flushThinking(sessionKey, false) }, THINKING_INTERVAL_MS)
  }

  /** 发布一次思考快照；与上次相同就跳过，避免无意义的重复事件。 */
  private flushThinking(sessionKey: string, done: boolean): void {
    const publish = this.thinkings.get(sessionKey)
    const state = this.thinkingState.get(sessionKey)
    if (publish === undefined || state === undefined) return
    if (state.timer !== undefined) { clearTimeout(state.timer); delete state.timer }
    const snapshot = thinkingSnapshot(state.raw, done)
    if (snapshot === '' || snapshot === state.published) return
    state.published = snapshot
    publish(snapshot)
  }

  /**
   * 会话事件入口，由 `index.ts` 注册到 `ctx.on('session/event')`。
   *
   * 只处理属于牛马大总管自己的会话；其他插件的会话事件一律忽略。
   */
  observe(session: { id?: unknown }, event: SessionEvent): void {
    const turn = this.turns.get(String(session?.id ?? ''))
    if (turn === undefined) return
    if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content)
      if (text !== '') turn.text = text
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      turn.resolve(reason.kind === 'completed'
        ? { kind: 'completed' }
        : reason.kind === 'error'
          ? { kind: 'failed', message: visibleError(reason.error, 500) }
          : { kind: 'cancelled' })
    }
  }

  /**
   * 成员结果的统一落库（G04）：派发与续问共用同一套状态矩阵，每种合法状态都把正文、
   * 原会话、材料与待办声明写全。
   *
   * 之前两条路径各写一份且都有缺：reply 的 `external_pending` 落成 `failed`，成功分支
   * 只写 summary 丢掉材料与会话；dispatch 的成功分支同样丢引用。事件上报由调用方按
   * 各自的展示差异发出，落库口径只有这一份。
   *
   * 写入经 {@link queueSubtaskWrite} 入队（§3 同子任务写入顺序）：结果必须排在 fire-and-forget
   * 的进度写入之后落地，否则一次迟到的 running 上报会盖掉终态。
   */
  private async applyMemberResult(taskId: string, subtaskId: string, result: ButlerDispatchResult): Promise<void> {
    const max = this.config.maxResultChars
    const artifacts = result.artifacts === undefined ? {} : { artifacts: result.artifacts }
    const conversation = result.conversationId === undefined || result.conversationId === ''
      ? {}
      : { conversationId: result.conversationId }
    if (result.status === 'succeeded') {
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'succeeded', { result: clip(result.summary, max), memberReturn: memberReturnOf(result), ...artifacts, ...conversation }))
      return
    }
    if (result.status === 'waiting_user') {
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'waiting_user', { result: clip(result.summary, max), memberReturn: memberReturnOf(result), ...artifacts, ...conversation }))
      return
    }
    if (result.status === 'external_pending') {
      const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
      if (reason === '') {
        // 声明了外部待办却没说明在等什么，按「返回不满足协作契约」收：猜一个理由等于
        // 给用户显示一件没发生过的外部事项。材料仍然保留。
        await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', {
          error: '说还有外部待办，但没说明在等什么',
          result: clip(result.summary, max), memberReturn: memberReturnOf(result), ...artifacts, ...conversation,
        }))
        return
      }
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'external_pending', {
        result: clip(`${result.summary}\n\n外部待办：${reason}`, max), memberReturn: memberReturnOf(result), ...artifacts, ...conversation,
      }))
      return
    }
    const cancelled = result.status === 'cancelled'
    // 失败/取消只写 error，result 由 COALESCE 保留先前交回的阶段性成果。
    await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, cancelled ? 'cancelled' : 'failed', {
      error: cancelled && clip(result.summary, max) === '' ? '已停止' : clip(result.summary, max),
      memberReturn: memberReturnOf(result),
    }))
  }

  /**
   * 调度一个子任务，实时产出状态事件。
   *
   * 状态先写库再上报：页面上的每个状态都对应一次已持久化的迁移，刷新后仍然一致。
   * 例外是执行器 onProgress 回调里的 running/waiting_user：事件先行推送、写库入队
   * fire-and-forget —— 崩溃窗口内页面可能短暂领先于库，但写库仍严格按发生顺序串行落盘。
   */
  private async *dispatchSubtask(input: {
    taskId: string
    subtaskId: string
    goal: string
    agentId: string
    displayName: string
    taskGoal: string
    actor: Actor
    signal: AbortSignal
    /** 前置目标标识；按就绪表逐个核验后才派这一步。 */
    dependsOn?: readonly string[]
    /** 这一步是否真的需要外部动作（采用、确认、发布）已经办完；不传按不需要算。 */
    requiresExternalAction?: boolean
  }): AsyncGenerator<ButlerEvent, SubtaskOutcome> {
    const { taskId, subtaskId, agentId, displayName, signal } = input
    const emit = (
      state: SubtaskState,
      detail: string,
      extra: {
        phase?: ButlerPhase
        tool?: string
        question?: string
        artifacts?: readonly AgentArtifact[]
        pending?: { readonly reason: string; readonly next?: string }
      } = {},
    ): ButlerEvent => ({
      type: 'subtask', taskId, id: subtaskId, state, agentId, displayName, detail,
      ...(extra.phase === undefined ? {} : { phase: extra.phase }),
      ...(extra.tool === undefined ? {} : { tool: extra.tool }),
      ...(extra.question === undefined ? {} : { question: extra.question }),
      ...(extra.artifacts === undefined ? {} : { artifacts: extra.artifacts }),
      ...(extra.pending === undefined ? {} : { pending: extra.pending }),
      time: Date.now(),
    })
    /**
     * 执行期间到达的进度事件。
     *
     * 执行方是在 `dispatch` 的 await 期间回调 `onProgress` 的，而生成器只能在自己体内
     * `yield`，所以用队列加唤醒把两者接起来：事件一到就产出，页面才看得见成员边说边出字；
     * 攒到子任务结束再一次性补发等于没有流式。
     */
    const progress = progressQueue()

    /**
     * 前置没就绪就不派 —— 按就绪表逐条核验，结论只有「派」「等」「判失败」三种。
     *
     * 之前这里只认「前置成功」，其余一律判失败：前置还在等人回话、或者交了材料只是外部还没
     * 办完时，这一步会被判成「干不成」，而员工其实连机会都没有 —— 那是在替员工报告一次
     * 并不存在的失败。现在按既定机制分三种处理，判定本身是纯函数（`dependencyVerdict`），
     * 与游戏侧的就绪表同一张。
     */
    // 派单材料快照：首次派单固定下来，之后不再改写（无依赖时为 `[]`）。
    //
    // **只有「确实还没派出去过」才允许首次固定**。另外两种一律拒绝派单：
    // - `unknown`：这一步派出过，但库里没留下材料（旧版本记录）—— 拿此刻的上游结果补一份
    //   来源等于伪造历史，材料到底是不是当时发出去的那份无从证明；
    // - `damaged`：已固定的快照读不出来（数据损坏）—— 损坏值写不回库，员工收到的材料会和
    //   库里记的对不上，宁可停下来说清楚。
    // 已固定的合法快照则沿用库里的那一份：材料已经随派单 message 发出去过，此刻再按上游当前
    // 状态重算，会让库里的来源与员工实际收到的东西对不上。
    const record = await this.storage.task(input.actor, taskId)
    const current = effectiveSubtasks(record?.subtasks ?? [])
    const self = current.find(candidate => candidate.id === subtaskId)
    // 前置声明读不出来（损坏即拒，依赖重判方案 §3 条目 4）：不知道这一步依赖谁就不能派，
    // 也不把损坏值修补成「没有前置」。原值原样保留在库里，与 inputRefs/memberReturn 同原则。
    if (self?.dependsOnState === 'damaged') {
      const detail = '这一步的前置声明读不出来（数据损坏）：不派单，原记录保持不动'
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
      yield emit('failed', detail)
      return { state: 'failed', report: `【${displayName}】失败：${detail}` }
    }
    // 读不到这条记录就无从证明「还没派过」：按未知拒绝，不猜。
    const snapshotState: ButlerInputRefsKind = self?.inputRefsState ?? 'unknown'
    if (snapshotState === 'unknown' || snapshotState === 'damaged') {
      const detail = snapshotState === 'unknown'
        ? '这一步之前派出过，但没有留下材料快照（旧记录未留存）：来源未知，不重新派单，也不补造历史'
        : '这一步已固定的材料快照读不出来（数据损坏）：不重新派单，原记录保持不动'
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
      yield emit('failed', detail)
      return { state: 'failed', report: `【${displayName}】失败：${detail}` }
    }
    const fixed = self?.inputRefs
    const inputRefs: ButlerInputRef[] = fixed === undefined ? [] : [...fixed]
    if (fixed === undefined && input.dependsOn !== undefined && input.dependsOn.length > 0) {
      const waiting: string[] = []
      const blocked: string[] = []
      for (const logicalId of input.dependsOn) {
        const attempt = current.find(candidate => candidate.logicalId === logicalId)
        if (attempt === undefined) {
          blocked.push(`${logicalId}（找不到这条前置）`)
          continue
        }
        // 材料真值统一到协作返回原文（依赖重判方案 §3.1）：上游该次有效尝试留下协作返回
        // 正文才算「可消费」，判定与交付用同一真值。result（可裁剪的展示摘要）与 artifacts
        // （位置型材料）退为展示信息，不再参与判定；旧记录没有留存（memberReturn 为
        // undefined）即「协作返回未知」，按现状拒派，也绝不拿裁剪过的展示摘要顶替。
        const source = attempt.memberReturn
        const materialsReady = source !== undefined && source.text.trim() !== ''
        const verdict = dependencyVerdict({
          upstream: attempt.state,
          materialsReady,
          requiresExternalAction: input.requiresExternalAction === true,
        })
        if (verdict === 'wait') waiting.push(`${logicalId}（${attempt.state}）`)
        else if (verdict !== 'dispatch' || source === undefined) {
          // 拒派原因如实分类写明缺什么：上游已判失败/取消的只写状态；材料不满足的区分
          // 未知（旧记录）、只有页面位置、正文为空；确需外部办完的写明是这一步自己的声明
          // 没被满足。判定放行却没有留存属于逻辑上不可达的防御分支，按未知拒派。
          const why = attempt.state === 'failed' || attempt.state === 'cancelled'
            ? attempt.state
            : materialsReady
              ? '这一步需要外部动作办完，上游还在等外部处理'
              : source === undefined
                ? '上游协作返回未知（旧记录未留存材料）'
                : attempt.artifacts.length > 0 ? '上游只提供页面位置，下游无法消费' : '上游协作返回为空'
          blocked.push(why === attempt.state
            ? `${logicalId}（${why}）`
            : `${logicalId}（${attempt.state}，${why}）`)
        }
        else {
          inputRefs.push({
            subtaskId: attempt.id,
            logicalId: attempt.logicalId,
            state: attempt.state,
            text: source.text,
            artifacts: [...attempt.artifacts],
            ...(source.externalPending === undefined ? {} : { externalPending: { ...source.externalPending } }),
          })
        }
      }
      if (waiting.length > 0 && blocked.length === 0) {
        // 前置还没终结：这一步留在队列里，不占员工，也不判失败。等前置有结果之后由收尾
        // （或补话后的重新核验）再走一遍；这一轮会按上游的真实状态结账。
        const detail = `等前置有结果：${waiting.join('、')}`
        await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'queued'))
        yield emit('queued', detail)
        return { state: 'queued', report: `【${displayName}】还没派：${detail}` }
      }
      if (blocked.length > 0) {
        const detail = `前置没有完成，这一步不派了：${blocked.join('、')}`
        await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
        yield emit('failed', detail)
        return { state: 'failed', report: `【${displayName}】失败：${detail}` }
      }
    }

    // 容量：按**完整派单 message** 计（整体目标、本步、材料原文、位置来源、外部待办全部计入）。
    // 超限一律不派单，也不静默或显式截断后继续；由老板缩小范围后走既有「新尝试」规则。
    const brief = dispatchBrief(input.taskGoal, input.goal, inputRefs)
    if (brief.length > DISPATCH_MESSAGE_LIMIT) {
      const detail = `派单材料超过成员接收上限（${brief.length} > ${DISPATCH_MESSAGE_LIMIT} 字符），已停止派单，请缩小范围后重试`
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
      yield emit('failed', detail)
      return { state: 'failed', report: `【${displayName}】失败：${detail}` }
    }
    const executor: ButlerAgentExecutor | undefined = resolveExecutor(this.ctx, agentId)
    if (executor === undefined) {
      const detail = `${displayName} 现在不在场，接不了这活`
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
      yield emit('failed', detail)
      return { state: 'failed', report: `【${displayName}】${detail}` }
    }

    // 同子任务写入顺序（§3 / T1-2 不变量 b）：dispatched（含 inputRefs 首次固定）必须先于
    // onProgress 触发的任何 running 写入落地。这里入队并 await；后续进度写入排进同一条
    // 队列，天然晚于本条。
    await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'dispatched', { inputRefs }))
    yield emit('dispatched', `已把活交给 ${displayName}`, { phase: 'analyzing' })

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.config.subtaskTimeoutMs)
    let running = false
    // 迄今见过的原业务会话引用（G01/G02）：进度早期上报优先，结果兜底；等待登记与续问都沿它。
    let memberConversationId: string | undefined
    /**
     * 把执行方的一次进度上报翻译成页面事件。
     *
     * - `delta` 走独立的 `subtask_delta` 事件：页面按增量追加，不重绘整条气泡。
     * - `thinking` 走 `subtask_thinking`，是覆盖语义的完整快照，页面替换思考行。
     * - `phase` 只改链路，不改状态文字。
     * - `needsReply` 让子任务进入 `waiting_user`，页面据此给出回复入口。
     */
    const onProgress = (update: ButlerProgressUpdate) => {
      // `stage` 是另一个插件的事件载荷：这里按跨插件边界处理，缺了按空状态行显示，不拿它
      // 直接去压平空白 —— 一个展示字段缺值不该把整轮子任务打成 TypeError 失败。
      const stage = update.stage ?? ''
      // 早期引用（G02）：拿到业务会话就落库，不等 final——final 前失败或进程重启，任务
      // 记录里仍找得回原会话，不需要重新派活去补。引用只表示可找到，不表示业务完成。
      //
      // 写入是 fire-and-forget 的（回调不能 await），经 queueSubtaskWrite 排进该子任务的
      // 串行队列（§3）：乱序落地会让首次固定的 inputRefs 被跳过、终态被迟到的 running 盖掉。
      if (update.conversationId !== undefined && update.conversationId !== '') {
        memberConversationId ??= update.conversationId
        // 局部固化引用：闭包里 TS 不会保持属性收窄，队列回调又可能晚于本轮事件执行。
        const earlyRef = update.conversationId
        const earlyArtifact = update.conversationArtifact
        void this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'running', {
          conversationId: earlyRef,
          ...(earlyArtifact === undefined ? {} : { artifacts: [earlyArtifact] }),
        }))
      }
      if (update.needsReply === true) {
        void this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'waiting_user', {
          ...(update.conversationId === undefined || update.conversationId === '' ? {} : { conversationId: update.conversationId }),
        }))
        progress.push(emit('waiting_user', clip(update.detail ?? stage, 300), {
          phase: 'waiting_user',
          question: clip(update.detail ?? stage, 500),
        }))
        return
      }
      if (update.delta !== undefined && update.delta !== '') {
        progress.push({ type: 'subtask_delta', taskId, id: subtaskId, agentId, delta: update.delta, time: Date.now() })
      }
      if (update.thinking !== undefined && update.thinking !== '') {
        progress.push({ type: 'subtask_thinking', taskId, id: subtaskId, agentId, thinking: update.thinking, time: Date.now() })
      }
      const streamed = update.delta !== undefined || update.thinking !== undefined
      if (streamed && update.detail === undefined && update.tool === undefined) return
      const detail = clip(update.detail ? (stage === '' ? update.detail : `${stage} · ${update.detail}`) : stage, 300)
      if (!running) {
        running = true
        void this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'running'))
      }
      progress.push(emit('running', detail === '' ? '干活中' : detail, {
        ...(update.phase === undefined ? {} : { phase: update.phase }),
        ...(update.tool === undefined ? {} : { tool: update.tool }),
      }))
    }
    try {
      const execution = executor.dispatch({
        taskId,
        subtaskId,
        goal: input.goal,
        brief,
        taskGoal: input.taskGoal,
        owner: `${input.actor.namespace}:${input.actor.userId}`,
        // 完整身份交给执行方鉴权：owner 丢掉了 sessionId，无法反推回 Actor。
        actor: input.actor,
        signal: controller.signal,
        onProgress,
      })
      // 结束通知只负责让产出停下来；执行本身的结果与失败仍由下面的 await 决定。
      void execution.then(() => progress.settle(), () => progress.settle())
      for await (const event of progress.drain()) yield event
      const result = await execution
      if (result.conversationId !== undefined && result.conversationId !== '') memberConversationId = result.conversationId
      if (result.status === 'cancelled' || signal.aborted || timedOut) {
        const detail = timedOut ? `超过 ${Math.round(this.config.subtaskTimeoutMs / 1000)} 秒没干完，已叫停` : '已停止'
        await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'cancelled', { error: detail }))
        yield emit('cancelled', detail)
        return { state: 'cancelled', report: `【${displayName}】${detail}` }
      }
      if (result.status === 'failed') {
        const detail = clip(result.summary === '' ? `${displayName} 没干成这活` : result.summary, this.config.maxResultChars)
        await this.applyMemberResult(taskId, subtaskId, result)
        yield emit('failed', detail)
        return { state: 'failed', report: `【${displayName}】失败：${detail}` }
      }
      if (result.status === 'waiting_user') {
        const question = clip(result.question ?? result.summary, 500)
        // 落库走统一矩阵（G04）：正文、原会话与材料一次写全，刷新和重启都找得回。
        await this.applyMemberResult(taskId, subtaskId, result)
        // 记下等待上下文，用户回复时据此把话交回同一位成员；带上原会话引用供续问（G01）。
        this.waiting.set(`${taskId}:${subtaskId}`, {
          executor, agentId, displayName,
          ...(memberConversationId === undefined ? {} : { conversationId: memberConversationId }),
        })
        // 等待不是终态，执行的定时器已经撤了，这里另起一个等回话的。
        await this.scheduleWaitingTimeout(taskId, subtaskId, displayName, input.actor)
        yield emit('waiting_user', question, {
          phase: 'waiting_user',
          question,
          ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
        })
        return { state: 'waiting_user', report: `【${displayName}】等着你回话：${question}` }
      }
      if (result.status === 'external_pending') {
        // 判定来源只有一个：员工给出的结构化声明。**不从正文措辞里猜**，也不因为
        // 「结果里带着材料」就自行把这一轮当成可以在外部收尾 —— 那正是要避免的混用。
        const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
        await this.applyMemberResult(taskId, subtaskId, result)
        if (reason === '') {
          if (!signal.aborted) console.warn(`butler-console: 子任务 ${taskId}:${subtaskId}（${agentId}）声明 external_pending 但没有给出理由`)
          const detail = clip(`${displayName} 说还有外部待办，但没说明在等什么`, this.config.maxResultChars)
          yield emit('failed', detail, { ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }) })
          return { state: 'failed', report: `【${displayName}】失败：${detail}` }
        }
        // 待办理由随结果落库（applyMemberResult）：只留在事件里的话，刷新之后任务详情
        // 就只剩一段正文，看不出还等着谁做什么。
        yield emit('external_pending', reason, {
          ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
          pending: {
            reason,
            ...(result.externalPending?.next === undefined ? {} : { next: result.externalPending.next }),
          },
        })
        return { state: 'external_pending', report: `【${displayName}】${clip(result.summary, this.config.maxResultChars)}\n外部待办：${reason}` }
      }
      const summary = clip(result.summary, this.config.maxResultChars)
      await this.applyMemberResult(taskId, subtaskId, result)
      yield emit('succeeded', summary)
      return { state: 'succeeded', report: summary }
    } catch (error) {
      const stopped = signal.aborted || timedOut
      const detail = stopped
        ? (timedOut ? `超过 ${Math.round(this.config.subtaskTimeoutMs / 1000)} 秒没干完，已叫停` : '已停止')
        : visibleError(error, this.config.maxResultChars)
      const state: SubtaskState = stopped ? 'cancelled' : 'failed'
      // 失败只留下「给用户看的一句话」时，服务端也就没有别的东西可查：页面上只有一句
      // TypeError，日志里什么都没有，定位只能靠猜。这里把栈单独写进日志（脱敏后），
      // 用户看到的文案不变。
      if (!stopped) console.error(`butler-console: 子任务执行失败（${agentId}）：${detail}\n${stackOf(error)}`)
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, state, { error: detail }))
      yield emit(state, detail)
      return { state, report: `【${displayName}】${stopped ? detail : `失败：${detail}`}` }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 受理一次对 `waiting_user` 子任务的补话。
   *
   * 校验、状态迁移与登记都在这里完成，理由同 `prepareTurn`：`404`／`409` 要能在
   * 提交那一刻就返回。补话同样登记到会话上，因此 `/stop` 也能中止它 —— 之前它用的是
   * 一个没人拿得到的局部控制器，喊停对补话是没有效果的。
   */
  private async prepareReply(input: {
    taskId: string
    subtaskId: string
    text: string
    decideByAgent: boolean
    actor: Actor
  }, runId: string): Promise<PreparedReply> {
    this.access.assert(input.actor)
    const waiting = this.waiting.get(`${input.taskId}:${input.subtaskId}`)
    const record = await this.storage.task(input.actor, input.taskId)
    if (record === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
    const subtask = record.subtasks.find(item => item.id === input.subtaskId)
    if (subtask === undefined) throw new AccessError(404, '这个子任务不存在', 'subtask_not_found')
    if (waiting === undefined) {
      // 服务重启后等待上下文会丢，但状态还在；这时如实说明而不是假装能回复。
      throw new AccessError(409, `${subtask.agentId} 的这次等待已经失效，请重新描述你的目标`, 'waiting_expired')
    }
    if (subtask.state !== 'waiting_user') throw new AccessError(409, '这位成员当前没有在等你回话', 'not_waiting')
    // 同会话执行互斥（T1-2 不变量 a）：检查与置位都在 claimNow 这一个同步调用里完成，
    // 之间不允许出现 await；执行权拿到之后，下面的状态写入才可以让出执行权。
    // 回合还活着同样拒绝：接管会覆盖运行引用与日志，把在跑的活变成不可停止；等它收尾
    // 或先停止再回复。
    if (!this.claimNow(record.conversationId, runId, 'reply')) {
      const holder = this.claims.get(record.conversationId)
      throw new AccessError(409, holder?.kind === 'turn'
        ? '这一轮还在执行，等它收尾或先停止再回复'
        : '这个会话已有一次回话或补充在执行，等它完成或先停止', 'conversation_busy')
    }

    // 用户回话了，这次等待的闹钟就该撤掉 —— 留着它到点会把一个正在跑的活的结局改成超时。
    // 必须在写 running 让出执行权**之前**撤：写库的 await 窗口里闹钟一旦触发，超时的条件
    // 更新先落地，running 会被转移守卫挡成 no-op，这一步就被钉死在超时结局上。
    this.clearWaitingTimeout(`${input.taskId}:${input.subtaskId}`)
    await this.queueSubtaskWrite(input.taskId, input.subtaskId, () => this.storage.setSubtaskState(input.taskId, input.subtaskId, 'running'))
    const abort = new AbortController()
    this.runs.set(record.conversationId, { runId, abort })
    // 原成员会话引用（G01）：等待登记里的早期上报优先，库里落的结果引用兜底。
    // 交给执行方沿它续接；没有引用时不编造，由执行方按自己的规则处理。
    const memberConversationId = waiting.conversationId
      ?? (subtask.conversationId === '' ? undefined : subtask.conversationId)
    return {
      conversationId: record.conversationId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      text: input.text,
      decideByAgent: input.decideByAgent,
      actor: input.actor,
      executor: waiting.executor,
      agentId: waiting.agentId,
      displayName: waiting.displayName,
      ...(memberConversationId === undefined ? {} : { memberConversationId }),
      runId,
      abort,
    }
  }

  /**
   * 把用户的回复交回原执行方，按发生顺序产出事件。
   *
   * 与 `dispatch` 分开：`dispatch` 是派活，这里是补话。牛马大总管不参与执行方的内部处理，
   * 只负责把话转过去、把结果和状态带回来。
   */
  private async *replyBody(prepared: PreparedReply): AsyncGenerator<ButlerEvent> {
    const { taskId, subtaskId, agentId, displayName } = prepared
    const key = `${taskId}:${subtaskId}`
    try {
      yield {
        type: 'subtask', taskId, id: subtaskId, state: 'running',
        agentId, displayName,
        detail: prepared.decideByAgent ? '你让它自己拿主意' : `你说：${clip(prepared.text, 200)}`,
        phase: 'analyzing', time: Date.now(),
      }

      const progress = progressQueue()
      let latestConversationId = prepared.memberConversationId
      const onProgress = (update: ButlerProgressUpdate) => {
        // 理由同 `dispatchSubtask`：`stage` 来自另一个插件，缺值按空状态行处理。
        const stage = update.stage ?? ''
        // 早期引用同派发路径（G02）：续问期间拿到会话也尽早落库。写入经该子任务的串行
        // 队列（§3 同子任务写入顺序），fire-and-forget 不 await，也不会乱序。
        if (update.conversationId !== undefined && update.conversationId !== '') {
          latestConversationId ??= update.conversationId
          // 局部固化引用：闭包里 TS 不会保持属性收窄（理由同派发路径）。
          const earlyRef = update.conversationId
          const earlyArtifact = update.conversationArtifact
          void this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'running', {
            conversationId: earlyRef,
            ...(earlyArtifact === undefined ? {} : { artifacts: [earlyArtifact] }),
          }))
        }
        if (update.delta !== undefined && update.delta !== '') {
          progress.push({ type: 'subtask_delta', taskId, id: subtaskId, agentId, delta: update.delta, time: Date.now() })
          return
        }
        if (update.thinking !== undefined && update.thinking !== '') {
          progress.push({ type: 'subtask_thinking', taskId, id: subtaskId, agentId, thinking: update.thinking, time: Date.now() })
          return
        }
        if (update.detail === undefined && update.tool === undefined) return
        progress.push({
          type: 'subtask', taskId, id: subtaskId, state: 'running', agentId, displayName,
          detail: clip(update.detail ? (stage === '' ? update.detail : `${stage} · ${update.detail}`) : stage, 300),
          ...(update.phase === undefined ? {} : { phase: update.phase }),
          ...(update.tool === undefined ? {} : { tool: update.tool }),
          time: Date.now(),
        })
      }
      const request: ButlerReplyRequest = {
        taskId,
        subtaskId,
        // 续问的幂等身份（G01）：runId 在同一次受理（含重试）内稳定，新的回话自然换新 ID。
        requestId: prepared.runId,
        text: clip(prepared.text, this.config.maxMessageChars),
        decideByAgent: prepared.decideByAgent,
        ...(prepared.memberConversationId === undefined ? {} : { conversationId: prepared.memberConversationId }),
        owner: `${prepared.actor.namespace}:${prepared.actor.userId}`,
        // 完整身份交给执行方鉴权：owner 丢掉了 sessionId，无法反推回 Actor。
        actor: prepared.actor,
        signal: prepared.abort.signal,
        onProgress,
      }
      try {
        if (prepared.executor.reply === undefined) {
          const detail = `${displayName} 不接受中途回话，等它跑完或者重新描述你的目标`
          await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
          yield {
            type: 'subtask', taskId, id: subtaskId, state: 'failed',
            agentId, displayName, detail, time: Date.now(),
          }
          return
        }
        const execution = prepared.executor.reply(request)
        void execution.then(() => progress.settle(), () => progress.settle())
        for await (const event of progress.drain()) yield event
        const result = await execution
        if (result.conversationId !== undefined && result.conversationId !== '') latestConversationId = result.conversationId
        // 落库走与派发同一份结果矩阵（G04）：每种合法状态都写全正文、原会话与材料。
        await this.applyMemberResult(taskId, subtaskId, result)
        if (result.status === 'waiting_user') {
          const question = clip(result.question ?? result.summary, 500)
          // 回话又引出新的等待：重新登记等待上下文与闹钟，用户可以继续回话。
          this.waiting.set(key, {
            executor: prepared.executor, agentId, displayName,
            ...(latestConversationId === undefined ? {} : { conversationId: latestConversationId }),
          })
          await this.scheduleWaitingTimeout(taskId, subtaskId, displayName, prepared.actor)
          yield {
            type: 'subtask', taskId, id: subtaskId, state: 'waiting_user',
            agentId, displayName, detail: question, phase: 'waiting_user', question, time: Date.now(),
          }
          return
        }
        this.waiting.delete(key)
        if (result.status === 'succeeded') {
          const summary = clip(result.summary, this.config.maxResultChars)
          yield { type: 'subtask', taskId, id: subtaskId, state: 'succeeded', agentId, displayName, detail: summary, time: Date.now() }
          yield* this.closeAfterReply(prepared)
          return
        }
        if (result.status === 'external_pending') {
          const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
          const detail = reason === ''
            ? clip(`${displayName} 说还有外部待办，但没说明在等什么`, this.config.maxResultChars)
            : reason
          const failed = reason === ''
          yield {
            type: 'subtask', taskId, id: subtaskId, state: failed ? 'failed' : 'external_pending',
            agentId, displayName, detail, time: Date.now(),
            ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
            ...(!failed && result.externalPending?.next !== undefined ? { pending: { reason, next: result.externalPending.next } } : {}),
          }
          yield* this.closeAfterReply(prepared)
          return
        }
        const detail = clip(result.summary === '' ? `${displayName} 没接上这活` : result.summary, this.config.maxResultChars)
        const state: SubtaskState = result.status === 'cancelled' ? 'cancelled' : 'failed'
        yield { type: 'subtask', taskId, id: subtaskId, state, agentId, displayName, detail, time: Date.now() }
        yield* this.closeAfterReply(prepared)
      } catch (error) {
        const detail = visibleError(error, this.config.maxResultChars)
        await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
        this.waiting.delete(key)
        yield { type: 'subtask', taskId, id: subtaskId, state: 'failed', agentId, displayName, detail, time: Date.now() }
        yield* this.closeAfterReply(prepared)
      }
    } finally {
      // 释放自己的占用：核对 runId，不清理别的执行在这份会话上留下的引用。
      if (this.runs.get(prepared.conversationId)?.runId === prepared.runId) this.runs.delete(prepared.conversationId)
      this.releaseClaim(prepared.conversationId, prepared.runId)
    }
  }

  /** 直接跑一次补话，把事件产出给调用方。不经过事件日志，供内部与测试使用。 */
  async *submitReply(input: {
    taskId: string
    subtaskId: string
    text: string
    decideByAgent: boolean
    actor: Actor
  }): AsyncGenerator<ButlerEvent, void> {
    yield* this.replyBody(await this.prepareReply(input, `butler-run-${randomUUID()}`))
  }

  /**
   * 收尾时要用的子任务结局，以库里的记录为准，**只取当前有效的尝试**。
   *
   * 库里的记录也照样留在历史与详情里；这里少的是那些已经被替代掉的尝试 —— 它们的失败不该
   * 再参与这一轮的结论。库里查不到时回落到计划里的那几项、并按「未跑完」处理：宁可把一轮
   * 当成没跑成，也不要凭内存里的旧状态给它写一个偏乐观的终态。
   */
  private async storedSubtasks(
    actor: Actor,
    taskId: string,
    planned: readonly { readonly id: string; readonly goal: string; readonly agentId: string }[],
  ): Promise<{ id: string; goal: string; agentId: string; state: SubtaskState }[]> {
    const record = await this.storage.task(actor, taskId)
    if (record === undefined) {
      return planned.map(item => ({ ...item, state: 'cancelled' as SubtaskState }))
    }
    return effectiveSubtasks(record.subtasks).map(item => ({
      id: item.id, goal: item.goal, agentId: item.agentId, state: item.state,
    }))
  }

  /** 收尾时要交给汇总的材料，同样从库里重建、同样只看有效尝试。 */
  private async storedReports(actor: Actor, taskId: string): Promise<string[]> {
    const record = await this.storage.task(actor, taskId)
    return record === undefined ? [] : effectiveSubtasks(record.subtasks).map(reportOf)
  }

  /**
   * 汇总并给这一轮写下终态。
   *
   * 派活那一轮和补话之后都会走到这里，所以它只认「子任务各自到了什么状态」和「已经拿到
   * 哪些结果」，不关心结果是怎么来的 —— 补话路径上的材料是从库里重建的，不是内存里那份。
   *
   * 只要还有子任务在等用户回话，任务就不算收尾：不跑汇总轮，状态停在 `waiting_user`，
   * 等补话那条路径把最后一位成员送走之后再回来调一次。
   */
  private async *closeTask(input: {
    readonly taskId: string
    /** 汇总要用的牛马大总管会话；拿不到时跳过汇总，仍然把终态落下。 */
    readonly conversation: Conversation | undefined
    readonly goal: string
    readonly subtasks: readonly {
      readonly id: string
      readonly goal: string
      readonly agentId: string
      readonly state: SubtaskState
    }[]
    readonly reports: readonly string[]
    readonly signal: AbortSignal
    /** 这一轮是否已经被喊停。子任务里有取消的同样按停止处理。 */
    readonly stopped: boolean
  }): AsyncGenerator<ButlerEvent> {
    const { taskId, conversation, goal, subtasks, reports, signal } = input
    const failed = subtasks.filter(item => item.state === 'failed').length
    const waiting = subtasks.filter(item => item.state === 'waiting_user').length
    const external = subtasks.filter(item => item.state === 'external_pending').length
    const stopped = input.stopped || subtasks.some(item => item.state === 'cancelled')
    let taskState: TaskState
    if (stopped) taskState = 'cancelled'
    else if (failed === 0) taskState = 'completed'
    else if (failed === subtasks.length) taskState = 'failed'
    // 一部分成、一部分败：有可用成果，但这一轮并没有全部完成。
    //
    // 这个结论**由后端统一给出**，不让两个界面各自去数子任务 —— 那样迟早会不一致，而且
    // 谁也没法改对方的判断。之前这种情况落在 `completed`，用户看到的是「活干完了」。
    else taskState = 'partial'

    /**
     * 还有已接受但没处理的输入时，这一轮**不算完**。
     *
     * 老板刚改的目标不能因为「旧范围跑完了」就被丢掉：这一轮先不说结论，交给那条输入自己的
     * 回合收尾。取消和故障可以带着未处理的输入结束（它们没有宣称成功），但「完成」和
     * 「部分完成」不行 —— 那等于告诉他活干完了。
     *
     * 这个屏障是必需的而不是保险：受理补充与收尾是两条异步路径，受理会在打开会话那里让出
     * 执行权，旧范围正好在这段时间跑完的情况是能构造出来的。
     */
    const versions = await this.storage.inputVersions(taskId)
    const pendingInput = versions !== undefined && versions.accepted > versions.processed
    const undispatched = subtasks.filter(item => item.state === 'queued').length
    if (!stopped && pendingInput && (taskState === 'completed' || taskState === 'partial')) {
      yield {
        type: 'chat', role: 'butler',
        text: '老大又补了一句，这一轮先不结账 —— 等新的说法处理完再给你结论。',
        time: Date.now(),
      }
      return
    }
    // 还留在队列里的步骤（前置没就绪）同样不能算完成：它们根本没跑过。
    if (!stopped && undispatched > 0 && taskState === 'completed') taskState = 'partial'

    if (waiting > 0 && !stopped) {
      const message = `有 ${waiting} 位成员在等你回话，回完再给你汇总。`
      await this.storage.setTaskState(taskId, 'waiting_user', { summary: reports.join('\n\n') })
      if (reports.length > 0) yield { type: 'chat', role: 'butler', text: message, time: Date.now() }
      yield { type: 'summary', taskId, text: message, state: 'waiting_user', error: '', time: Date.now() }
      return
    }

    /**
     * 材料已交回、剩下的事在别处办。
     *
     * 这里**不跑汇总轮**：这一轮的目标并没有达成，让大总管「总结一下完成情况」很容易说出
     * 「已交付」这类结论，而实际上那件事还在外面等着。所以只如实留下材料与外部待办，
     * 状态写 `external_pending`，本轮到此结束、随后就能开新活。后续跟进是新任务。
     *
     * 等用户回话优先于外部待办：有人等着补一句话时，用户还没法把这一轮放下去开新活。
     */
    if (external > 0 && !stopped) {
      const message = `材料已经交回，还有 ${external} 件事要在外面办完。这一轮到此为止，想继续可以新开一轮。`
      const error = failed === 0 ? '' : `${failed} 个子任务失败`
      await this.storage.setTaskState(taskId, 'external_pending', { summary: reports.join('\n\n'), error })
      yield { type: 'summary', taskId, text: message, state: 'external_pending', error, time: Date.now() }
      return
    }

    let summaryText = ''
    if (!stopped && conversation !== undefined) {
      await this.storage.setTaskState(taskId, 'summarizing')
      for await (const event of this.summarize(conversation, goal, subtasks, reports, signal)) {
        const inner = summaryTextOf(event)
        if (inner !== null) summaryText = inner
        else yield event as ButlerEvent
      }
    }
    if (summaryText === '') {
      summaryText = reports.length === 0 ? '这次没有拿到可用的子任务结果。' : reports.join('\n\n')
    }
    const error = failed === 0 ? '' : `${failed} 个子任务失败`
    /**
     * 汇总跑完再核一次输入版本，而且**核对与写入在同一个事务里**。
     *
     * 开头那道屏障只挡得住「开始汇总时就已经有未处理输入」的情况。汇总这一轮本身是异步的，
     * 正好在它跑的这段时间里进来的补充，只能在这里拦下来 —— 那份结论是按**旧范围**总结的，
     * 写下去就等于用旧结论盖住新目标，还把任务报成完成。
     */
    if (!(await this.storage.commitTaskState(taskId, taskState, { summary: summaryText, error }))) {
      // 结论作废，但它已经边流边出现在页面上了：如实说明它只是草稿，不冒充最终答复。
      await this.storage.setTaskState(taskId, 'running')
      yield {
        type: 'chat', role: 'butler',
        text: '老大又补了一句，刚那份结论先当草稿 —— 等新的说法处理完再给你结论。',
        time: Date.now(),
      }
      return
    }
    yield { type: 'summary', taskId, text: summaryText, state: taskState, error, time: Date.now() }
  }

  /**
   * 补话之后看看这一轮能不能收尾了。
   *
   * 全部子任务都终结时才汇总：之前这里什么都不做，于是老板答复完最后一位成员、那位成员也
   * 干完了，任务却永远停在「等人回话」，拿不到应有的结论。还有人在等、或者还有活没派完时
   * 保持原样，任务继续停在 `waiting_user`，等下一次补话。
   *
   * 会话句柄找不到时把 `conversation` 留空交给 `closeTask`：它照常写下终态与材料，
   * 只是不跑汇总那一轮。宁可这一次没有结论，也不能把任务永远留在「等人回话」。
   */
  /**
   * 把队列里已经就绪的步骤派出去。
   *
   * 依赖在**派单前**核验，而不是计划生成时定死：前置可能还在跑、还在等人回话、或者交了
   * 材料而外面还没办完。之前因为「前置还没终结」留在队列里的步骤，等前置有结果之后要接得
   * 上 —— 补话收尾（closeAfterReply）、补充收尾与等待超时收尾前都走一遍这里，就是机制里
   * 说的「派单前重新核验条件」。
   *
   * 还在等前置的保持队列状态如实挂起：不空转，也不占用员工；但核验按条独立结账，队头在等
   * 不挡住队尾已经就绪的步骤。
   */
  private async *drainQueue(input: {
    taskId: string
    actor: Actor
    goal: string
    signal: AbortSignal
  }): AsyncGenerator<ButlerEvent> {
    // 本轮核验过、结论是「继续等」的步骤：如实挂起、不再反复核验（否则会在它身上空转），
    // 但也不让它挡住排在后面、已经就绪的步骤 —— 依赖核验按条独立结账，队头在等不该让
    // 队尾跟着悬空。
    const suspended = new Set<string>()
    for (;;) {
      const record = await this.storage.task(input.actor, input.taskId)
      if (record === undefined) return
      const next = record.subtasks.find(item => item.state === 'queued' && !suspended.has(item.id))
      if (next === undefined) return
      if (input.signal.aborted) return
      yield* this.dispatchSubtask({
        taskId: input.taskId, subtaskId: next.id, goal: next.goal, agentId: next.agentId,
        displayName: await this.displayNameOf(input.actor, next.agentId), taskGoal: input.goal,
        actor: input.actor, signal: input.signal,
        ...(next.dependsOn.length === 0 ? {} : { dependsOn: next.dependsOn }),
        ...(next.requiresExternalAction ? { requiresExternalAction: true } : {}),
      })
      const after = (await this.storage.task(input.actor, input.taskId))?.subtasks.find(item => item.id === next.id)
      if (after === undefined) return
      // 派完仍排队中：前置仍未就绪，如实挂起，继续核验排在后面的。
      if (after.state === 'queued') suspended.add(next.id)
      // 有步骤真的结账（派出或判失败）：挂起中的那些前置可能因此就绪，全部重新核验一轮。
      // 结账最多发生排队项数那么多次，循环必然收敛。
      else suspended.clear()
    }
  }

  private async *closeAfterReply(prepared: PreparedReply): AsyncGenerator<ButlerEvent> {
    const before = await this.storage.task(prepared.actor, prepared.taskId)
    if (before === undefined) return
    // 有人回完话之后，之前「前置还没终结」而留在队列里的步骤可能就绪了：先核验再派。
    yield* this.drainQueue({
      taskId: before.id, actor: prepared.actor, goal: before.goal, signal: prepared.abort.signal,
    })
    const record = await this.storage.task(prepared.actor, prepared.taskId)
    if (record === undefined) return
    if (record.subtasks.some(item => !isTerminal(item.state))) return
    // 只看有效尝试：被替代掉的旧尝试不该参与这一轮的结论。
    const effective = effectiveSubtasks(record.subtasks)
    yield* this.closeTask({
      taskId: record.id,
      conversation: this.conversations.get(prepared.conversationId),
      goal: record.goal,
      subtasks: effective.map(item => ({
        id: item.id, goal: item.goal, agentId: item.agentId, state: item.state,
      })),
      reports: effective.map(reportOf),
      signal: prepared.abort.signal,
      stopped: prepared.abort.signal.aborted,
    })
  }
  /**
   * 汇总：把子任务结果交回给牛马大总管，由它输出最终回答。
   *
   * 汇总轮也是真实的一轮：它有自己的 `turn/end`，失败或取消时如实上报，而不是用
   * 一段模板文本冒充汇总结果。
   */
  private async *summarize(
    conversation: Conversation,
    goal: string,
    subtasks: readonly { readonly id: string; readonly goal: string; readonly agentId: string }[],
    reports: readonly string[],
    signal: AbortSignal,
  ): AsyncGenerator<ButlerInnerEvent, void> {
    const lines = subtasks.map((subtask, index) => `- 子任务「${subtask.goal}」由 ${subtask.agentId} 完成，结果：\n${reports[index] ?? '（没有结果）'}`)
    const prompt = [
      `我的原始目标是：${goal}`,
      '各子 Agent 已经返回结果：',
      ...lines,
      '请基于这些结果给出最终回答，直接回答我的目标，不要重复子任务清单，也不要提到这份指令。',
    ].join('\n')
    const speech = progressQueue()
    const summaryTurn = this.runTurn(conversation, prompt, signal,
      delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }),
      () => speech.push({ type: 'chat_reset', time: Date.now() }),
      undefined,
      thinking => speech.push({ type: 'chat_thinking', role: 'butler', thinking, time: Date.now() }))
    void summaryTurn.then(() => speech.settle(), () => speech.settle())
    for await (const event of speech.drain()) yield event
    const outcome = await summaryTurn
    if (outcome.outcome.kind === 'cancelled') {
      yield { type: 'summary_text', text: '' }
      return
    }
    if (outcome.outcome.kind === 'failed') {
      yield { type: 'chat', role: 'butler', text: `汇总失败：${outcome.outcome.message}`, time: Date.now() }
      yield { type: 'summary_text', text: '' }
      return
    }
    const text = outcome.text.trim() === '' ? reports.join('\n\n') : outcome.text.trim()
    if (text !== '') yield { type: 'chat', role: 'butler', text, time: Date.now() }
    yield { type: 'summary_text', text }
  }

  /** 停止时释放全部 Agent；不删除任何用户数据。 */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const run of this.runs.values()) run.abort.abort()
    this.runs.clear()
    this.claims.clear()
    // 等待中的闹钟也要撤：留在那里会在插件已经卸下之后去写库。
    for (const timer of this.waitingTimers.values()) clearTimeout(timer)
    this.waitingTimers.clear()
    await Promise.allSettled([...this.openings.values()])
    const handles = [...this.conversations.values()].map(conversation => conversation.handle)
    this.conversations.clear()
    this.turns.clear()
    // 事件日志只活在内存里，停止后没有读者：清掉比留一堆不会再被读的缓冲干净。
    this.logs.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionPersistenceNotFoundError'
}
