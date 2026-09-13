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

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AccessError, conversationModel, defaultConversationModel, listPlugins, UNIVERSAL_TOOL_CATEGORY, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { listAgentCards, resolveExecutor, type AgentCard } from './agents.ts'
import type { Config } from './config.ts'
import type { ButlerAgentExecutor, ButlerMember, ButlerPhase, ButlerProgressUpdate, ButlerReplyRequest } from './protocol.ts'
import type { TaskStore } from './store.ts'
import type { SubtaskState, TaskState } from './task-model.ts'

const CONVERSATION_ID = /^butler-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PLAN_TOOL = 'butler_plan'

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
  | { readonly type: 'error'; readonly message: string; readonly time: number }

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
function briefFor(taskGoal: string, subtaskGoal: string): string {
  return [
    `整体目标：${taskGoal}`,
    `你负责的部分：${subtaskGoal}`,
    '只完成你负责的这一部分，不要代替其他 Agent 回答。',
    '如果缺少必要信息，直接说明缺什么，不要编造。',
  ].join('\n')
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
  /** 每个会话的中止控制器，用户按停止时触发。 */
  private readonly aborts = new Map<string, AbortController>()
  /** 每个正在进行的大总管回合的正文增量出口：`sessionId` → 写进当前事件流。 */
  private readonly deltas = new Map<string, (text: string) => void>()
  /**
   * 正在等待用户回话的子任务：`taskId:subtaskId` → 该子任务的执行方。
   *
   * 进程重启后这里会空，但子任务状态仍在库里；`submitReply` 会如实告知等待已失效，
   * 而不是假装还能回复。
   */
  private readonly waiting = new Map<string, WaitingMember>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly access: Access,
    private readonly store: TaskStore,
    private readonly persona: string,
  ) {}

  /** 校验浏览器传来的会话 id，避免用它去寻址别的 DSH 会话。 */
  validateId(value: string): string {
    if (!CONVERSATION_ID.test(value)) throw new AccessError(400, '不是牛马大总管的会话标识')
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
    if (this.disposed) throw new AccessError(503, '插件正在停止')
    this.access.assert(actor)
    if (requestedId === undefined && !createMissing) return undefined
    const id = requestedId === undefined ? this.createId() : this.validateId(requestedId)
    // 新会话要就地创建：会话 id 由页面在客户端生成，首次发消息时库里还没有这条记录。
    // 若这里先 assertOwner，新会话会被判成「不存在」而拒绝，页面就开不出会话。
    // 已属于他人时 openOrReserveConversation 以同样的 404 拒绝，不泄露存在性。
    if (requestedId !== undefined) this.store.openOrReserveConversation(id, actor)
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
    if (requestedId === undefined) this.store.reserveConversation(id, actor)
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
    if (this.disposed) throw new AccessError(503, '插件正在停止')
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
      throw new AccessError(503, '插件正在停止')
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
        for (const item of args.subtasks as readonly { goal?: unknown; agentId?: unknown; reason?: unknown }[]) {
          const goal = typeof item.goal === 'string' ? clip(item.goal, 2000) : ''
          const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : ''
          if (goal === '') throw new Error('子任务缺少目标')
          if (!available.has(agentId)) {
            throw new Error(`Agent ${agentId === '' ? '（空）' : agentId} 不能接收子任务。本轮可调度的是：${[...available].join('、') || '（没有）'}`)
          }
          subtasks.push({ goal, agentId, reason: clip(typeof item.reason === 'string' ? item.reason : '', 300) })
        }
        if (subtasks.length === 0) throw new Error('计划里至少要有一个子任务')
        if (subtasks.length > this.config.maxSubtasks) throw new Error(`一次最多派发 ${this.config.maxSubtasks} 个子任务`)
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
  members(actor: Actor): ButlerMemberCard[] {
    this.access.assert(actor)
    const aliases = this.store.aliases(actor)
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
      }
    })
  }

  /** 按 id 取一位成员的显示名；找不到时回落到 id 本身。 */
  private displayNameOf(actor: Actor, agentId: string): string {
    const alias = this.store.aliases(actor).get(agentId)
    if (alias !== undefined && alias.displayName !== '') return alias.displayName
    return listAgentCards(this.ctx).find(card => card.id === agentId)?.displayName ?? agentId
  }

  /** 保存一位成员的显示别名。空值表示恢复默认。 */
  setAlias(actor: Actor, agentId: string, displayName: string, accent: string): void {
    this.access.assert(actor)
    this.store.setAlias(actor, agentId, displayName, accent)
  }

  /** 保存一位成员的头像。字节已在 HTTP 层核验过类型与大小。 */
  setAvatar(actor: Actor, agentId: string, bytes: Uint8Array, contentType: string): void {
    this.access.assert(actor)
    this.store.setAvatar(actor, agentId, bytes, contentType)
  }

  /** 读取一位成员的头像。 */
  avatar(actor: Actor, agentId: string): { bytes: Uint8Array; contentType: string } | undefined {
    this.access.assert(actor)
    return this.store.avatar(actor, agentId)
  }

  /** 删除一位成员的头像，别名保留。 */
  clearAvatar(actor: Actor, agentId: string): void {
    this.access.assert(actor)
    this.store.clearAvatar(actor, agentId)
  }

  /** 侧栏列表。 */
  listConversations(actor: Actor) {
    this.access.assert(actor)
    return this.store.listConversations(actor, 50)
  }

  /** 运行历史分页。 */
  history(actor: Actor, query: { offset: number; limit: number; keyword: string; state: string }) {
    this.access.assert(actor)
    if (!Number.isSafeInteger(query.offset) || query.offset < 0
      || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.config.maxHistoryPageSize
      || query.keyword.length > 120) throw new AccessError(400, '历史查询参数无效')
    return this.store.history(actor, query)
  }

  /** 一条任务的完整记录。 */
  task(actor: Actor, id: string) {
    this.access.assert(actor)
    const record = this.store.task(actor, id)
    if (record === undefined) throw new AccessError(404, '任务不存在或无权访问')
    return record
  }

  /** 右栏状态摘要。 */
  overview(actor: Actor) {
    this.access.assert(actor)
    return { counts: this.store.counts(actor), failures: this.store.recentFailures(actor, 5) }
  }

  /** 用户按下停止。 */
  cancel(conversationId: string, actor: Actor): void {
    this.access.assert(actor)
    this.store.assertOwner(this.validateId(conversationId), actor)
    this.abort(conversationId)
  }

  /** 中止所有正在跑的会话；登录被撤销和插件卸载时使用。 */
  cancelAll(): void {
    for (const conversationId of [...this.aborts.keys()]) this.abort(conversationId)
  }

  /** 中止一轮：先中止子任务，再取消牛马大总管自己这一轮。 */
  private abort(conversationId: string): void {
    this.aborts.get(conversationId)?.abort()
    this.conversations.get(conversationId)?.handle.agent.cancel({ kind: 'user' })
  }

  /**
   * 处理一条用户消息，按发生顺序产出页面事件。
   *
   * 串行调度：计划本身表达的是先后关系，而且并行会让右栏状态难以解释。需要并行
   * 时再作为独立改动引入。
   */
  async *send(conversationId: string, message: string, actor: Actor): AsyncGenerator<ButlerEvent> {
    this.access.assert(actor)
    const text = message.trim()
    if (text === '') throw new AccessError(400, '消息不能为空')
    if ([...text].length > this.config.maxMessageChars) throw new AccessError(400, `消息过长，最多 ${this.config.maxMessageChars} 个字符`)
    this.validateId(conversationId)
    const conversation = await this.open(conversationId, true, actor)
    if (conversation === undefined) throw new AccessError(500, '无法打开牛马大总管会话')
    this.access.assert(actor)
    if (conversation.active) throw new AccessError(409, '牛马大总管正在处理上一条消息，请先停止或等待完成')

    conversation.active = true
    conversation.lastUsedAt = Date.now()
    this.store.touchConversation(conversationId, actor, text)
    const abort = new AbortController()
    this.aborts.set(conversationId, abort)
    yield { type: 'user', text, time: Date.now() }

    try {
      // 第一段：理解与拆解。它自己的话边收边上：回合还没结束就把增量发给页面。
      const speech = progressQueue()
      const planningTurn = this.runTurn(conversation, text, abort.signal,
        delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }))
      void planningTurn.then(() => speech.settle(), () => speech.settle())
      for await (const event of speech.drain()) yield event
      const planning = await planningTurn
      if (planning.outcome.kind === 'cancelled') {
        yield { type: 'summary', taskId: '', text: '', state: 'cancelled', error: '已停止', time: Date.now() }
        return
      }
      if (planning.outcome.kind === 'failed') {
        if (planning.text !== '') yield { type: 'chat', role: 'butler', text: planning.text, time: Date.now() }
        yield { type: 'error', message: `牛马大总管回答失败：${planning.outcome.message}`, time: Date.now() }
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
      const subtasks = plan.subtasks.map((subtask, index) => ({
        id: `s${index + 1}`,
        goal: subtask.goal,
        agentId: subtask.agentId,
        reason: subtask.reason,
        displayName: this.displayNameOf(actor, subtask.agentId),
      }))
      this.store.createTask({ id: taskId, conversationId, actor, goal: text, note: plan.note, subtasks })
      yield { type: 'plan', taskId, goal: text, note: plan.note, subtasks, time: Date.now() }

      // 第二段：按顺序调度。
      const reports: string[] = []
      let failed = 0
      let cancelled = 0
      let waitingForUser = 0
      for (const subtask of subtasks) {
        if (abort.signal.aborted) {
          this.store.setSubtaskState(taskId, subtask.id, 'cancelled', { error: '已停止' })
          yield {
            type: 'subtask', taskId, id: subtask.id, state: 'cancelled',
            agentId: subtask.agentId, displayName: subtask.displayName, detail: '已停止', time: Date.now(),
          }
          cancelled += 1
          continue
        }
        for await (const event of this.dispatchSubtask({
          taskId, subtaskId: subtask.id, goal: subtask.goal, agentId: subtask.agentId,
          displayName: subtask.displayName, taskGoal: text, actor, signal: abort.signal,
        })) {
          yield event
          if (event.type !== 'subtask' || event.id !== subtask.id) continue
          if (event.state === 'succeeded') reports.push(event.detail)
          if (event.state === 'failed') failed += 1
          if (event.state === 'cancelled') cancelled += 1
          if (event.state === 'waiting_user') waitingForUser += 1
        }
      }

      // 第三段：汇总。
      const stopped = abort.signal.aborted || cancelled > 0
      let taskState: TaskState
      if (stopped) taskState = 'cancelled'
      else if (failed === 0) taskState = 'completed'
      else if (failed === subtasks.length) taskState = 'failed'
      else taskState = 'completed'
      // 有人还在等用户回话时任务不算收尾：不跑汇总轮，状态停在「等人回话」。
      if (waitingForUser > 0 && !stopped) {
        const message = `有 ${waitingForUser} 位成员在等你回话，回完再给你汇总。`
        this.store.setTaskState(taskId, 'waiting_user', { summary: reports.join('\n\n') })
        if (reports.length > 0) yield { type: 'chat', role: 'butler', text: message, time: Date.now() }
        yield { type: 'summary', taskId, text: message, state: 'waiting_user', error: '', time: Date.now() }
        return
      }
      let summaryText = ''
      if (!stopped) {
        this.store.setTaskState(taskId, 'summarizing')
        for await (const event of this.summarize(conversation, text, subtasks, reports, abort.signal)) {
          const inner = summaryTextOf(event)
          if (inner !== null) summaryText = inner
          else yield event as ButlerEvent
        }
      }
      if (summaryText === '') {
        summaryText = reports.length === 0
          ? '这次没有拿到可用的子任务结果。'
          : reports.join('\n\n')
      }
      const error = failed === 0 ? '' : `${failed} 个子任务失败`
      this.store.setTaskState(taskId, taskState, { summary: summaryText, error })
      yield { type: 'summary', taskId, text: summaryText, state: taskState, error, time: Date.now() }
    } finally {
      conversation.active = false
      conversation.lastUsedAt = Date.now()
      this.aborts.delete(conversationId)
    }
  }

  /**
   * 跑牛马大总管的一轮并收集结果。
   *
   * 先注册记录再投递消息，避免第一轮的事件早于监听建立；`abort` 触发时按取消
   * 收尾，不让调用方无限等待。
   */
  private async runTurn(
    conversation: Conversation,
    text: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
  ): Promise<{ outcome: TurnOutcome; text: string; plans: readonly PlanSubmission[] }> {
    const sessionId = String(conversation.handle.agent.session.id)
    const turn: Turn = {
      // 名单在组装提示词时读取，所以这里取的是「这一轮开始时」的在场情况。
      members: listAgentCards(this.ctx),
      plans: [], text: '', done: false, outcome: { kind: 'cancelled' }, resolve: () => {},
    }
    this.turns.set(sessionId, turn)
    if (onDelta !== undefined) this.deltas.set(sessionId, onDelta)
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
      this.turns.delete(sessionId)
      this.deltas.delete(sessionId)
    }
  }

  /**
   * 宿主实时帧入口，由 `index.ts` 注册到 `ctx.on('agent/assistant-stream')`。
   *
   * 只转发牛马大总管当前回合的正文增量：其他插件 Agent 的帧、推理与工具参数都不进页面。
   * 一次回合里可能有多次尝试（重试会换 attemptId），这里不做尝试级区分 —— 落定的 `chat`
   * 会用最终正文替换整条预览，被重试掉的那一版不会留在页面上。
   */
  observeStream(agent: { session?: { id?: unknown } } | undefined, frame: AssistantStreamFrame): void {
    if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return
    const text = frame.chunk.text
    if (text === '') return
    this.deltas.get(String(agent?.session?.id ?? ''))?.(text)
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
   * 调度一个子任务，实时产出状态事件。
   *
   * 状态先写库再上报：页面上的每个状态都对应一次已持久化的迁移，刷新后仍然一致。
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
  }): AsyncGenerator<ButlerEvent, SubtaskOutcome> {
    const { taskId, subtaskId, agentId, displayName, signal } = input
    const emit = (
      state: SubtaskState,
      detail: string,
      extra: { phase?: ButlerPhase; tool?: string; question?: string } = {},
    ): ButlerEvent => ({
      type: 'subtask', taskId, id: subtaskId, state, agentId, displayName, detail,
      ...(extra.phase === undefined ? {} : { phase: extra.phase }),
      ...(extra.tool === undefined ? {} : { tool: extra.tool }),
      ...(extra.question === undefined ? {} : { question: extra.question }),
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

    const executor: ButlerAgentExecutor | undefined = resolveExecutor(this.ctx, agentId)
    if (executor === undefined) {
      const detail = `${displayName} 现在不在场，接不了这活`
      this.store.setSubtaskState(taskId, subtaskId, 'failed', { error: detail })
      yield emit('failed', detail)
      return { state: 'failed', report: `【${displayName}】${detail}` }
    }

    this.store.setSubtaskState(taskId, subtaskId, 'dispatched')
    yield emit('dispatched', `已把活交给 ${displayName}`, { phase: 'analyzing' })

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.config.subtaskTimeoutMs)
    let running = false
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
      if (update.needsReply === true) {
        this.store.setSubtaskState(taskId, subtaskId, 'waiting_user')
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
        this.store.setSubtaskState(taskId, subtaskId, 'running')
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
        brief: briefFor(input.taskGoal, input.goal),
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
      if (result.status === 'cancelled' || signal.aborted || timedOut) {
        const detail = timedOut ? `超过 ${Math.round(this.config.subtaskTimeoutMs / 1000)} 秒没干完，已叫停` : '已停止'
        this.store.setSubtaskState(taskId, subtaskId, 'cancelled', { error: detail })
        yield emit('cancelled', detail)
        return { state: 'cancelled', report: `【${displayName}】${detail}` }
      }
      if (result.status === 'failed') {
        const detail = clip(result.summary === '' ? `${displayName} 没干成这活` : result.summary, this.config.maxResultChars)
        this.store.setSubtaskState(taskId, subtaskId, 'failed', { error: detail })
        yield emit('failed', detail)
        return { state: 'failed', report: `【${displayName}】失败：${detail}` }
      }
      if (result.status === 'waiting_user') {
        const question = clip(result.question ?? result.summary, 500)
        this.store.setSubtaskState(taskId, subtaskId, 'waiting_user')
        // 记下等待上下文，用户回复时据此把话交回同一位成员。
        this.waiting.set(`${taskId}:${subtaskId}`, { executor, agentId, displayName })
        yield emit('waiting_user', question, { phase: 'waiting_user', question })
        return { state: 'waiting_user', report: `【${displayName}】等着你回话：${question}` }
      }
      const summary = clip(result.summary, this.config.maxResultChars)
      this.store.setSubtaskState(taskId, subtaskId, 'succeeded', { result: summary })
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
      this.store.setSubtaskState(taskId, subtaskId, state, { error: detail })
      yield emit(state, detail)
      return { state, report: `【${displayName}】${stopped ? detail : `失败：${detail}`}` }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 把用户对一次 `waiting_user` 子任务的回复交回原执行方。
   *
   * 与 `dispatch` 分开：`dispatch` 是派活，这里是补话。牛马大总管不参与执行方的内部处理，
   * 只负责把话转过去、把结果和状态带回来。
   */
  async *submitReply(input: {
    taskId: string
    subtaskId: string
    text: string
    decideByAgent: boolean
    actor: Actor
  }): AsyncGenerator<ButlerEvent, void> {
    this.access.assert(input.actor)
    const key = `${input.taskId}:${input.subtaskId}`
    const waiting = this.waiting.get(key)
    const record = this.store.task(input.actor, input.taskId)
    if (record === undefined) throw new AccessError(404, '任务不存在或无权访问')
    const subtask = record.subtasks.find(item => item.id === input.subtaskId)
    if (subtask === undefined) throw new AccessError(404, '这个子任务不存在')
    if (waiting === undefined) {
      // 服务重启后等待上下文会丢，但状态还在；这时如实说明而不是假装能回复。
      throw new AccessError(409, `${subtask.agentId} 的这次等待已经失效，请重新描述你的目标`)
    }
    if (subtask.state !== 'waiting_user') throw new AccessError(409, '这位成员当前没有在等你回话')

    const { executor, agentId, displayName } = waiting
    this.store.setSubtaskState(input.taskId, input.subtaskId, 'running')
    yield {
      type: 'subtask', taskId: input.taskId, id: input.subtaskId, state: 'running',
      agentId, displayName, detail: input.decideByAgent ? '你让它自己拿主意' : `你说：${clip(input.text, 200)}`,
      phase: 'analyzing', time: Date.now(),
    }

    const controller = new AbortController()
    const progress = progressQueue()
    const onProgress = (update: ButlerProgressUpdate) => {
      // 理由同 `dispatchSubtask`：`stage` 来自另一个插件，缺值按空状态行处理。
      const stage = update.stage ?? ''
      if (update.delta !== undefined && update.delta !== '') {
        progress.push({ type: 'subtask_delta', taskId: input.taskId, id: input.subtaskId, agentId, delta: update.delta, time: Date.now() })
        return
      }
      if (update.thinking !== undefined && update.thinking !== '') {
        progress.push({ type: 'subtask_thinking', taskId: input.taskId, id: input.subtaskId, agentId, thinking: update.thinking, time: Date.now() })
        return
      }
      if (update.detail === undefined && update.tool === undefined) return
      progress.push({
        type: 'subtask', taskId: input.taskId, id: input.subtaskId, state: 'running', agentId, displayName,
        detail: clip(update.detail ? (stage === '' ? update.detail : `${stage} · ${update.detail}`) : stage, 300),
        ...(update.phase === undefined ? {} : { phase: update.phase }),
        ...(update.tool === undefined ? {} : { tool: update.tool }),
        time: Date.now(),
      })
    }
    const request: ButlerReplyRequest = {
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      text: clip(input.text, this.config.maxMessageChars),
      decideByAgent: input.decideByAgent,
      owner: `${input.actor.namespace}:${input.actor.userId}`,
      // 完整身份交给执行方鉴权：owner 丢掉了 sessionId，无法反推回 Actor。
      actor: input.actor,
      signal: controller.signal,
      onProgress,
    }
    try {
      if (executor.reply === undefined) {
        const detail = `${displayName} 不接受中途回话，等它跑完或者重新描述你的目标`
        this.store.setSubtaskState(input.taskId, input.subtaskId, 'failed', { error: detail })
        yield {
          type: 'subtask', taskId: input.taskId, id: input.subtaskId, state: 'failed',
          agentId, displayName, detail, time: Date.now(),
        }
        return
      }
      const execution = executor.reply(request)
      void execution.then(() => progress.settle(), () => progress.settle())
      for await (const event of progress.drain()) yield event
      const result = await execution
      if (result.status === 'waiting_user') {
        const question = clip(result.question ?? result.summary, 500)
        this.store.setSubtaskState(input.taskId, input.subtaskId, 'waiting_user')
        yield {
          type: 'subtask', taskId: input.taskId, id: input.subtaskId, state: 'waiting_user',
          agentId, displayName, detail: question, phase: 'waiting_user', question, time: Date.now(),
        }
        return
      }
      if (result.status === 'succeeded') {
        const summary = clip(result.summary, this.config.maxResultChars)
        this.store.setSubtaskState(input.taskId, input.subtaskId, 'succeeded', { result: summary })
        this.waiting.delete(key)
        yield { type: 'subtask', taskId: input.taskId, id: input.subtaskId, state: 'succeeded', agentId, displayName, detail: summary, time: Date.now() }
        return
      }
      const detail = clip(result.summary === '' ? `${displayName} 没接上这活` : result.summary, this.config.maxResultChars)
      const state: SubtaskState = result.status === 'cancelled' ? 'cancelled' : 'failed'
      this.store.setSubtaskState(input.taskId, input.subtaskId, state, { error: detail })
      this.waiting.delete(key)
      yield { type: 'subtask', taskId: input.taskId, id: input.subtaskId, state, agentId, displayName, detail, time: Date.now() }
    } catch (error) {
      const detail = visibleError(error, this.config.maxResultChars)
      this.store.setSubtaskState(input.taskId, input.subtaskId, 'failed', { error: detail })
      this.waiting.delete(key)
      yield { type: 'subtask', taskId: input.taskId, id: input.subtaskId, state: 'failed', agentId, displayName, detail, time: Date.now() }
    }
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
      delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }))
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
    for (const abort of this.aborts.values()) abort.abort()
    this.aborts.clear()
    await Promise.allSettled([...this.openings.values()])
    const handles = [...this.conversations.values()].map(conversation => conversation.handle)
    this.conversations.clear()
    this.turns.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionPersistenceNotFoundError'
}
