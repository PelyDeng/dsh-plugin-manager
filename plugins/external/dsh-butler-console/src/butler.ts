/**
 * 牛马大总管 Agent：理解目标、生成任务计划、按计划调度子 Agent、汇总结果。
 *
 * 职责边界（与设计文档一致）：
 *
 * - 牛马大总管自己只带两个工具：`butler_plan`（把计划交回宿主）与 `butler_verdict`（收尾裁决）。
 *   它不决定子 Agent 调用什么工具，也不创建子 Agent 的会话。
 * - 每个子任务交给对应插件登记的 executor；由那个插件创建和驱动自己的 Agent。
 * - 子任务状态只在真实事件上迁移：派发前是 `queued`，交给 executor 后是
 *   `dispatched`，收到第一条进度后是 `running`，settle 之后才是成功或失败。
 *
 * 一轮完整对话由三段组成，中间的状态都来自真实事件：
 *
 * 1. 理解与拆解：牛马大总管回答，需要调度时调用 `butler_plan` 交回计划。
 * 2. 调度：按依赖就绪情况分批派发（同批取互不依赖、不同成员的步骤并发），交给各插件登记的 executor。
 * 3. 汇总：把子任务结果交回给牛马大总管，由它输出最终回答。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AccessError, conversationModel, conversationRemover, defaultConversationModel, hostConversationBusy, listPlugins, UNIVERSAL_TOOL_CATEGORY, type Access, type Actor, type AgentAction, type AgentArtifact, type AgentSelfCheck, type ConversationRecord } from '@dsh-plugin-manager/plugin-kit'
import type { ConversationModel } from '@dsh-plugin-manager/plugin-kit/models'
import { listAgentCards, resolveExecutor, type AgentCard } from './agents.ts'
import { ButlerAttachments } from './attachments.ts'
import { modelTakesImages } from './vision.ts'
import type { Config } from './config.ts'
import { ConversationLog, type LoggedEvent, type RunHead } from './event-log.ts'
import { MergedEvents } from './merged-events.ts'
import type { ButlerAgentExecutor, ButlerDispatchResult, ButlerMember, ButlerPhase, ButlerProgressUpdate, ButlerReplyRequest } from './protocol.ts'
import type {
  ButlerAttachmentRecord,
  ButlerInputRef,
  ButlerInputRefsKind,
  ButlerMemberReturn,
  ButlerStorage,
  ConversationSummary,
  RequestRecord,
  SubtaskRecord,
  SubtaskVerdict,
  TaskCounts,
  TaskInput,
  TaskSummary,
} from './storage/types.ts'
import { isTerminal, dependencyVerdict, type SubtaskState, type TaskState } from './task-model.ts'
import { makePlanTool } from './butler/planning.ts'
import { makeVerdictTool, readVerdictDecision } from './butler/verdict.ts'
import { clip, digestOf, subtaskResultText, textOf } from './butler/text.ts'
import { stackOf, visibleError } from './butler/errors.ts'
import { requireAcceptance, taskAcceptanceFinding } from './butler/acceptance.ts'
import { ATTACHMENT_SECTION_TITLE, DISPATCH_MESSAGE_LIMIT, claimedByOthers, dispatchBrief, effectiveSubtasks, memberReturnOf, ownPendingActions, supplementPrompt } from './butler/dispatch-brief.ts'
import { REPLAY_REJECTED_PREFIX, dispatchFailureDetail, isReplayRejection, selfCheckLabel, verdictDecisionFor } from './butler/verdict.ts'
import type { SettleTaskInput, Settlement, VerdictContext, VerdictDecision } from './butler/verdict.ts'
import { MAX_ATTEMPTS_PER_LOGICAL, planReworkAttempts, reportOf } from './butler/planning.ts'
import { SUMMARY_PROMPT_GOAL, SUMMARY_PROMPT_RESULTS, TRANSCRIPT_LEAD_EVENTS, TRANSCRIPT_SCAN_CHUNK, WAITING_EXPIRED, WAITING_EXPIRED_TASK, WAITING_STOPPED, WAITING_STOPPED_TASK, progressQueue, summaryTextOf, thinkingSnapshot } from './butler/speech.ts'
import type { Conversation, PlanSubmission, PlannedSubtask, PreparedAction, PreparedReply, PreparedSupplement, PreparedTurn, RunHooks, SubtaskOutcome, Turn, TurnOutcome, WaitingMember } from './butler/domain.ts'

const CONVERSATION_ID = /^butler-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 移除围栏同步镜像的键：owner 双列 + 会话 id（围栏的 record/mark 都是同步查它）。 */
function removalKey(actor: Actor, conversationId: string): string {
  return `${actor.namespace}:${actor.userId}:${conversationId}`
}
const PLAN_TOOL = 'butler_plan'
/**
 * 裁决工具：**批量**裁决已经终结的子任务。
 *
 * 与 `butler_plan` 一样是"结构化交回"通道：模型要么给出结构化裁决，要么就是普通正文，
 * 不从自然语言里解析。它**并入汇总轮**（设计 §5.4）：同一轮里先裁决，全 `accept` 才继续
 * 写汇总正文；有 `rework`/`replace` 就不写汇总，交后端处置——不额外占一轮，用户不会为了
 * 一次裁决多等一整轮。
 */
const VERDICT_TOOL = 'butler_verdict'
/**
 * 思考快照的发布间隔。
 *
 * 推理增量比正文更碎（一次几百字很常见），逐字发只会让页面反复重绘；攒到这个间隔再发一次
 * 整段快照，既看得出「在思考」，也不会把页面刷爆。
 */
const THINKING_INTERVAL_MS = 250

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
    /**
     * 等用户确认的操作（可空）。
     *
     * 页面据此就地渲染确认卡——**不认 `kind` 也能画**（标题/摘要/详情/字段/按钮文案都是呈现数据）。
     * 确认凭据不在其中：它始终留在执行方自己的记录里，前端与模型都拿不到。
     */
    readonly actions?: readonly AgentAction[]
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
export type ButlerInnerEvent = ButlerEvent | { readonly type: 'summary_text'; readonly text: string }

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

/** 一次最多返回多少条对话；也是 `/transcript` 的 `limit` 上限。 */
export const TRANSCRIPT_MAX_ITEMS = 200

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
  private readonly claims = new Map<string, { readonly runId: string; readonly kind: 'turn' | 'reply' | 'supplement' | 'action' }>()

  /**
   * 正在裁决的会话 → 这一次汇总轮的裁决上下文。
   *
   * 键是**牛马大总管自己的会话 id**（裁决工具就是注册在那个 agent 上的）。一代收尾开始前设置、
   * 结束（含异常）时清除 —— 工具注册是每会话一次、对所有轮次生效的，靠这份上下文才分得清
   * "现在这一轮该不该裁决"。
   */
  private readonly verdictContexts = new Map<string, VerdictContext>()

  /** 受理时同步占住执行权；拿不到返回 false，由调用方按 409 拒绝。 */
  private claimNow(conversationId: string, runId: string, kind: 'reply' | 'supplement' | 'action'): boolean {
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

  /**
   * 附件服务：老板丢进输入框的文件与图片，进这一轮的理解与派单。
   *
   * **公开**（不是 private）：页面那条 HTTP 面（`web.ts`）要的就是同一个实例——附件是这份
   * 应用的对象，路由只是它的一个入口，另造一个实例等于让两处各持一份状态。
   */
  readonly attachments: ButlerAttachments

  /**
   * 移除围栏的同步镜像：`${namespace}:${userId}:${conversationId}` → `removal_state`。
   *
   * kit 的 `conversationRemover` 在**同步上下文**里调 `record` / `mark`，而管家存储是异步
   * PG——镜像先拦住运行期路径（send/resume/fork 前的 record 判定、mark 即刻生效），落库走
   * write-behind。启动时全量加载（单用户百级会话，内存可行），新会话登记时同步补登。
   */
  private readonly conversationIndex = new Map<string, string>()

  /** kit 移除围栏产物：会话删除的宿主归档、围栏状态与忙检查都由它承担（不自造）。 */
  readonly removeViaFence: ReturnType<typeof conversationRemover>

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly access: Access,
    /** 异步业务存储（生产为 PostgresTaskStorage；测试注入过渡适配器或替身）。 */
    private readonly storage: ButlerStorage,
    private readonly persona: string,
  ) {
    // 附件服务按**每一次调用**去问"此刻的存储"，而不是把 `storage` 抓在手里：这个字段是可变的
    // （测试在重开库之后会整只换掉它），抓住旧的那一个，换库之后读到的就是一张已经关掉的库
    // ——报出来的是 `database is not open`，离真正的原因很远。
    this.attachments = new ButlerAttachments(ctx, config, access, {
      attachmentInsert: (actor, record) => this.storage.attachmentInsert(actor, record),
      attachmentWrite: (actor, record) => this.storage.attachmentWrite(actor, record),
      attachment: (actor, id) => this.storage.attachment(actor, id),
      attachments: (actor, conversationId) => this.storage.attachments(actor, conversationId),
      attachmentBind: (actor, ids, taskId, conversationId) => this.storage.attachmentBind(actor, ids, taskId, conversationId),
      taskAttachments: taskId => this.storage.taskAttachments(taskId),
    })
    this.removeViaFence = conversationRemover(ctx, {
      assert: actor => {
        this.access.assert(actor)
        if (this.disposed) throw new AccessError(503, '牛马大总管正在停止', 'butler_stopping')
      },
      store: {
        record: (actor, id) => {
          const state = this.conversationIndex.get(removalKey(actor, id))
          // 未知、他人或已删除的会话同一个错，不泄露存在性（与 assertOwner 同一口径）。
          if (state === undefined) throw new AccessError(404, '会话不存在或无权访问', 'conversation_not_found')
          // 围栏只消费 removalState / deletedAt；title / updatedAt 不参与判定。
          return { id, title: '', updatedAt: 0, deletedAt: null, removalState: state } satisfies ConversationRecord
        },
        mark: (actor, id, state) => {
          const key = removalKey(actor, id)
          this.conversationIndex.set(key, state)
          // write-behind：镜像先行保证运行期拦截不落空；落库失败只记录——重启后状态回空
          // 意味着该会话重新可见，但宿主会话已归档、业务表已清，用户看到的是空会话（可接受的降级）。
          void this.storage.markConversationRemoved(actor, id, state).catch(error => {
            console.error(`butler-console: 围栏状态（${id} → ${state}）落库失败：${visibleError(error, 200)}`)
          })
        },
      },
      busy: id => this.runs.has(id) || this.claims.has(id) || hostConversationBusy(ctx, id),
      release: async id => {
        // 围栏放行删除前 busy 已挡掉活跃轮；这里是兜底中止（abort 内部自含收尾）。
        // 等待中的子任务无需处理：waiting_user 状态下执行方已返回，不存在悬空回调；
        // 迟到的超时定时器只会写已删除的行（StorageError 日志），不会写脏数据。
        this.abort(id)
      },
    })
  }

  /** 启动时把全部管家会话与围栏状态加载进同步镜像（index.ts 在就绪前调用）。 */
  async loadConversationIndex(): Promise<void> {
    for (const { key, state } of await this.storage.conversationRemovals()) this.conversationIndex.set(key, state)
  }

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
    // 同步补登移除镜像：围栏的 record 是同步查表，新登记的会话必须立刻可见，否则
    // 「刚建好就想删」会在围栏里被当成不存在。
    if (!this.conversationIndex.has(removalKey(actor, id))) this.conversationIndex.set(removalKey(actor, id), '')
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
    const conversation: Conversation = { id, handle, selection, active: false, lastUsedAt: Date.now() }
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
    // 裁决工具：同一个会话上再注册一个。它只在收尾的汇总轮里有上下文（见 `verdictContexts`），
    // 其余轮次调用它会拿到一句明确的拒绝，而不是静默什么都不做。
    agentCtx.tools.register(this.verdictTool(sessionId))
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
      // 简介是插件自述、无长度约束；成员一多，全文拼接会静默吃掉每轮的系统提示词预算。
      // 与 capabilities 同等待遇截断（能力 12 条×60 字），成员自己想写长介绍就写进自己的页面。
      const brief = clip(member.description.trim(), 120)
      const summary = brief === '' ? '' : `；简介：${brief}`
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
   * `butler_plan` 工具（工厂实现见 butler/planning.ts 的 makePlanTool）。
   */
  private planTool(sessionId: string) {
    return makePlanTool({
      name: PLAN_TOOL,
      sessionId,
      turns: this.turns,
      dispatchableAgents: () => this.dispatchableAgents(),
      maxSubtasks: this.config.maxSubtasks,
    })
  }

  /**
   * `butler_verdict` 工具（工厂实现见 butler/verdict.ts 的 makeVerdictTool）。
   */
  private verdictTool(sessionId: string) {
    return makeVerdictTool({
      name: VERDICT_TOOL,
      sessionId,
      verdictContexts: this.verdictContexts,
      dispatchableAgents: () => this.dispatchableAgents(),
      readVerdictDecision: (raw, context, dispatchableAgents) => readVerdictDecision(raw, context, dispatchableAgents ?? (() => this.dispatchableAgents())),
      applyVerdictDecision: (context, decision) => this.applyVerdictDecision(context, decision),
    })
  }

  /** 落**一条**裁决：D-2 与证据核验 → 写库 → **写后核验** → 记账。 */
  private async applyVerdictDecision(context: VerdictContext, decision: VerdictDecision): Promise<void> {
    const target = context.open.find(entry => entry.id === decision.subtaskId)
    if (target === undefined) throw new Error(`子任务 ${decision.subtaskId} 不在这一次的待裁决清单里`)
    const mapped = verdictDecisionFor({
      requested: decision.verdict,
      evidence: decision.evidence ?? '',
      selfCheck: target.selfCheck,
      result: target.result,
      memberReturnText: target.memberReturnText,
      artifacts: target.artifacts,
    })
    if (mapped.downgraded) {
      // 降级**如实记下来**：否则页面上只看到"没裁决"，看不出是"模型想采纳但证据核验不过"。
      context.problems.push(`子任务 ${decision.subtaskId}：${decision.verdict} → ${mapped.verdict}（${mapped.why}）`)
    }
    const rows = await this.storage.setSubtaskVerdict(context.actor, context.taskId, decision.subtaskId, {
      verdict: mapped.verdict,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.evidence === undefined ? {} : { evidence: decision.evidence }),
      ...(mapped.why === '' ? {} : { observation: mapped.why }),
    })
    // **写后核验**：受影响行数为 0 说明这条子任务根本不在库里（或不属于这个 owner）——
    // 那是编程错误，不能静默吞掉，否则"裁决过了"只活在内存里（设计 §5.4）。
    if (rows === 0) throw new Error(`裁决没有落到库里（受影响 0 行）：${decision.subtaskId}`)
    context.decided.add(decision.subtaskId)
    context.decisions.push({
      subtaskId: decision.subtaskId,
      verdict: mapped.verdict,
      requested: decision.verdict,
      ...(decision.newAgentId === undefined ? {} : { newAgentId: decision.newAgentId }),
    })
  }

  /** 当前可调度（登记了执行入口且仍在目录中）的 Agent。 */
  private dispatchableAgents(): AgentCard[] {
    return listAgentCards(this.ctx).filter(card => card.dispatchable)
  }

  /**
   * 群成员列表：登记了调度执行入口、且仍在插件目录里的 Agent，叠加该用户的本地别名。
   *
   * 只收能接活的人。声明为「智能体」但没有执行入口的应用不是群成员：列进名单只会让人
   * 以为可以派活，大总管的提示词里也从来没有它们。
   *
   * 显示名取本地别名优先，插件声明的名称始终保留在 `declaredName` 里，页面上以次要
   * 文字显示，保证「谁是谁」永远可追溯。
   */
  async members(actor: Actor): Promise<ButlerMemberCard[]> {
    this.access.assert(actor)
    const aliases = await this.storage.aliases(actor)
    const busy = await this.storage.busy(actor)
    return this.dispatchableAgents().map(card => {
      const alias = aliases.get(card.id)
      return {
        agentId: card.id,
        displayName: alias?.displayName !== undefined && alias.displayName !== '' ? alias.displayName : card.displayName,
        declaredName: card.displayName,
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

  /** 侧栏列表（分页，0.12.4 管理分页）。 */
  async listConversations(actor: Actor, offset = 0): Promise<{ items: ConversationSummary[]; total: number }> {
    this.access.assert(actor)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new AccessError(400, '分页参数无效', 'list_offset_invalid')
    return await this.storage.listConversations(actor, this.config.conversationsPageSize ?? 10, offset)
  }

  /** 改会话标题（管理操作）。空标题被拒——「改成无名」没有合理场景，防误触把标题清空。 */
  async renameConversation(actor: Actor, conversationId: string, title: string): Promise<void> {
    this.access.assert(actor)
    const id = this.validateId(conversationId)
    const trimmed = title.replace(/\s+/gu, ' ').trim()
    if (trimmed === '') throw new AccessError(400, '标题不能为空', 'rename_empty')
    await this.storage.renameConversation(actor, id, trimmed)
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
      }) => ({
        ...rest,
        // 待确认的操作是**呈现数据**，与内部材料（派单原文、协作返回原文）分开处理：
        // 它必须能到页面（刷新后还要重画确认卡），所以在这里从留存里投影出来，而不是把
        // 整份 `memberReturn` 原样外传。
        actions: (_memberReturn as { readonly actions?: readonly AgentAction[] } | undefined)?.actions ?? [],
      })),
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
    if (active === undefined) {
      // 没有正在跑的一轮，但会话里可能还挂着「等你回话」的步骤——等待没有活跃 run，
      // 只看 runs 就永远喊不停它（#14）。等待作废（材料保留），这才是喊停的完整语义。
      // 带了 taskId 就只收那个任务（与下方活跃分支同一副防误伤：旧任务迟到的停止
      // 请求不该碰到该会话随后开的新任务）。
      const stopped = await this.stopWaitingSubtasks(id, actor, taskId)
      if (stopped > 0) return { accepted: true, reason: '已把等待中的任务喊停，材料保留' }
      return { accepted: false, reason: '现在没有正在执行的一轮' }
    }
    if (taskId !== '') {
      // 必须严格对上。当前这一轮还在理解阶段（日志里还没有 taskId）时也算对不上：
      // 那多半是另一个新任务刚起步，拿旧任务的取消去掐它才是真的误伤。
      const current = this.logs.get(id)?.head()?.taskId ?? ''
      if (current !== taskId) return { accepted: false, reason: '这个任务已经不在执行了' }
    }
    this.abort(id)
    // 正在跑的一轮停了；同会话挂着的等待也一并收掉——它们占着成员与计数，
    // 喊停的语义是"这个会话现在别忙"，不该留下喊不动的等待。带了 taskId 时同样只动那个任务。
    const stopped = await this.stopWaitingSubtasks(id, actor, taskId)
    return { accepted: true, reason: stopped > 0 ? '已停止，等待中的任务一并喊停（材料保留）' : '' }
  }

  /** 中止所有正在跑的会话；登录被撤销和插件卸载时使用。 */
  cancelAll(): void {
    for (const conversationId of [...this.runs.keys()]) this.abort(conversationId)
  }

  /**
   * 删除会话（页面「任务记录」的删除/批量删除）。
   *
   * 复用 kit 的移除围栏（`conversationRemover`）：忙检查（管家轮次 + 宿主侧占用）、围栏状态
   * 标记、宿主会话归档都由它承担；管家自己的业务数据（任务/子任务/输入/幂等/附件索引）在
   * 围栏确认 `removed` 之后清理。逐会话返回结果，页面按结果提示。
   */
  async deleteConversations(actor: Actor, ids: readonly string[]): Promise<{ id: string; status: string; message?: string }[]> {
    this.access.assert(actor)
    const { results } = await this.removeViaFence(actor, [...ids])
    const removed: string[] = []
    for (const result of results) if (result.status === 'removed') removed.push(result.id)
    if (removed.length > 0) {
      // 宿主已归档、围栏已标 removed，业务表清理失败只影响「数据残留」不影响一致性
      //（侧栏按围栏状态过滤，不会再显示）；失败记日志，下次删除同会话会走 alreadyRemoved，
      // 业务表清理由那时补做——所以这里失败也要再试一次清表。
      try {
        await this.storage.deleteConversationRows(actor, removed)
      } catch (error) {
        console.error(`butler-console: 已移除会话的业务数据清理失败（${removed.join(',')}）：${visibleError(error, 200)}`)
      }
    }
    return results
  }

  /**
   * 删除一条任务（失败记录清理）。只允许删**终态**任务：活跃任务由存储层条件 DELETE 拒绝，
   * 这里如实转成 409，页面提示先停止或等待完成。
   */
  async deleteTask(actor: Actor, taskId: string): Promise<void> {
    this.access.assert(actor)
    // 任务 id 不走会话正则（形状是 butler-task-<uuid>）；归属由存储层条件 DELETE 的
    // owner 三列守住，形状不匹配即 0 行 → 下面的 404 分支。
    const deleted = await this.storage.deleteTask(actor, taskId)
    if (!deleted) {
      const record = await this.storage.task(actor, taskId)
      if (record === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
      throw new AccessError(409, '任务还没结束，先停止或等它完成', 'task_not_removable')
    }
    // 撤掉这条任务上可能还挂着的等待闹钟：行已删，迟到的超时只会写已删除的行。
    for (const key of [...this.waitingTimers.keys()]) {
      if (key.startsWith(`${taskId}:`)) {
        clearTimeout(this.waitingTimers.get(key))
        this.waitingTimers.delete(key)
        this.waiting.delete(key)
      }
    }
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
  private async prepareTurn(
    conversationId: string,
    message: string,
    actor: Actor,
    runId: string,
    attachmentIds: readonly string[] = [],
  ): Promise<PreparedTurn> {
    this.access.assert(actor)
    const text = message.trim()
    if (text === '') throw new AccessError(400, '消息不能为空', 'message_empty')
    if ([...text].length > this.config.maxMessageChars) throw new AccessError(400, `消息过长，最多 ${this.config.maxMessageChars} 个字符`, 'message_too_long')
    this.validateId(conversationId)
    const conversation = await this.open(conversationId, true, actor)
    if (conversation === undefined) throw new AccessError(500, '无法打开牛马大总管会话', 'conversation_open_failed')
    this.access.assert(actor)

    // 附件在互斥标志**之前**处理完：这一段里有 await（读库，模型收不了图片时还有一次读图
    // 调用），插在「检查 active」与「置位 active」之间会让同一会话的两个回合同时进来。
    const attachments = await this.attachments.select(actor, attachmentIds)
    const images = await this.attachImages(conversation, actor, attachments)
    const prompt = await this.promptFor(text, attachments)

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
    return { conversationId, conversation, text, prompt, attachments, images, actor, runId, abort }
  }

  /**
   * 这一轮的图片要不要直接交给模型。
   *
   * 两条路**必须二选一**，不能都走：
   *
   * - **模型收图片** → 直接把图片引用交出去，**不做读图**。读一遍等于让模型看二手转述，
   *   还白花一次调用。
   * - **模型不收图片** → 先把图片读成文字（读一次落库，下一轮复用），图片引用不再交出去。
   *   宿主在发请求前会拒掉"模型不支持却带图片"的消息（`llm/src/index.ts:1052`），硬塞会让
   *   整轮对话当场失败，而失败原因离用户很远。
   */
  private async attachImages(
    conversation: Conversation,
    actor: Actor,
    records: readonly ButlerAttachmentRecord[],
  ): Promise<readonly ImageAttachmentRef[]> {
    const refs = this.attachments.imageRefs(records)
    if (refs.length === 0) return []
    if (await modelTakesImages(this.ctx, conversation.selection.provider, conversation.selection.model)) return refs
    await this.attachments.ensureImageText(actor, records)
    return []
  }

  /** 发给模型的正文：原话之后接一段附件说明，没有附件就原样返回。 */
  private async promptFor(text: string, records: readonly ButlerAttachmentRecord[]): Promise<string> {
    if (records.length === 0) return text
    const block = await this.attachments.promptBlock(records, this.config.attachmentBriefChars)
    if (block === '') return text
    return [text, '', ATTACHMENT_SECTION_TITLE, block].join('\n')
  }

  /**
   * 派单简报里的附件段：这一轮老板带的文件，按任务取。
   *
   * 派单前先补一次读图（`ensureImageText`）：成员拿到的是**文字**，看不见图片，一张没有文字的
   * 图片对它等于没有。读一次落库，同一张图不会读第二次。当前对话模型是多模态时，图片已经直接
   * 交给过协调方，但成员这条路仍然需要文字，所以这里照样读。
   */
  private async attachmentSection(actor: Actor, taskId: string): Promise<string> {
    const records = await this.attachments.forTask(taskId)
    if (records.length === 0) return ''
    try {
      await this.attachments.ensureImageText(actor, records)
    } catch (error) {
      // 读图失败不阻断派单：附件正文照给，缺的部分由 `promptBlock` 如实标出来。
      console.error(`butler-console: 派单前读图失败：${visibleError(error, 300)}`)
    }
    const block = await this.attachments.promptBlock(records, this.config.attachmentBriefChars)
    return block === '' ? '' : `${ATTACHMENT_SECTION_TITLE}\n${block}`
  }

  /**
   * 跑完一轮，按发生顺序产出事件。
   *
   * 调度交给 {@link drainQueue}：互不依赖、成员不同的步骤**批内并发**，同一成员每批只取一个
   * （执行方有自己的会话互斥）。第一版曾经是严格串行，改成并发的理由写在第二段那段注释里。
   */
  private async *turnBody(turn: PreparedTurn): AsyncGenerator<ButlerEvent> {
    const { conversation, conversationId, text, prompt, attachments, images, actor, abort } = turn
    yield { type: 'user', text, time: Date.now() }

    try {
      // 第一段：理解与拆解。它自己的话边收边上：回合还没结束就把增量发给页面。
      const speech = progressQueue()
      const planningTurn = this.runTurn(conversation, prompt, abort.signal, {
        onDelta: delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }),
        onReset: () => speech.push({ type: 'chat_reset', time: Date.now() }),
        onThinking: thinking => speech.push({ type: 'chat_thinking', role: 'butler', thinking, time: Date.now() }),
        ...(images.length === 0 ? {} : { images }),
      })
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
        acceptance?: string
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
          // 验收口径要落库：派单时从这里读出来交给执行方，重启后仍要能拿到。
          ...(subtask.acceptance === undefined ? {} : { acceptance: subtask.acceptance }),
          // 目标标识与依赖要落库：前者决定聚合按谁算，后者决定这一步该不该派。
          ...(subtask.logicalId === undefined ? {} : { logicalId: subtask.logicalId }),
          ...(subtask.supersedes === undefined ? {} : { supersedes: subtask.supersedes }),
          ...(subtask.dependsOn === undefined ? {} : { dependsOn: subtask.dependsOn }),
          ...(subtask.requiresExternalAction === true ? { requiresExternalAction: true } : {}),
        })
      }
      await this.storage.createTask({
        id: taskId, conversationId, actor, goal: text, acceptance: plan.acceptance, note: plan.note, subtasks,
      })
      // 附件绑到任务上：派单时要靠这个绑定把文件正文放进成员的简报里。绑定失败**不阻断**
      // 这一轮——活该派还是要派，只是成员看不到附件内容；这里如实记一行日志。
      if (attachments.length > 0) {
        try {
          const bound = await this.attachments.bindToTask(actor, attachments.map(item => item.id), taskId, conversationId)
          if (bound !== attachments.length) {
            console.warn(`butler-console: 附件绑定数量不符（${bound}/${attachments.length}），${taskId}`)
          }
        } catch (error) {
          console.error(`butler-console: 附件绑定失败：${visibleError(error, 300)}`)
        }
      }
      yield { type: 'plan', taskId, goal: text, note: plan.note, subtasks, time: Date.now() }

      // 第二段：调度。走与后续派发（回话/点卡后的下游、补充追加）**同一条** drainQueue：
      // 一批互不依赖、不同成员的步骤并发派出（串行会让独立步骤排队，每步最坏一个执行超时）。
      // 依赖核验、依赖拒派与排队语义都在 drainQueue 里，这里不再另写一份循环。
      yield* this.drainQueue({ taskId, actor, goal: text, signal: abort.signal })
      // 中途喊停：还没派出去的排队步骤如实标「已停止」（drainQueue 让位时不会动它们，
      // 原来的逐个循环是在派发前逐条标记的，这里补齐同一语义）。
      if (abort.signal.aborted) {
        const remaining = (await this.storage.task(actor, taskId))?.subtasks ?? []
        for (const subtask of remaining) {
          if (subtask.state !== 'queued') continue
          const displayName = await this.displayNameOf(actor, subtask.agentId)
          await this.queueSubtaskWrite(taskId, subtask.id, () => this.storage.setSubtaskState(taskId, subtask.id, 'cancelled', { error: '已停止' }))
          yield {
            type: 'subtask', taskId, id: subtask.id, state: 'cancelled',
            agentId: subtask.agentId, displayName, detail: '已停止', time: Date.now(),
          }
        }
      }

      // 第三段：汇总与收尾。
      //
      // 子任务结局与汇总材料都**从库里重建**，而不是在循环里边跑边攒：补话那条路径上
      // 内存里早已没有这一轮的累积值（进程可能都换过一次），两条路径用同一个口径才不会
      // 出现「派活时汇总内容对、补话后汇总内容少一半」这种只在某条路径上复现的偏差。
      const acceptance = await this.storedAcceptance(actor, taskId)
      yield* this.closeTask({
        taskId,
        actor,
        conversation,
        goal: text,
        subtasks: await this.storedSubtasks(actor, taskId, subtasks),
        // 任务级口径与每步口径/材料一并交给收尾（消费点排在下一批，这里先把数据取到）。
        ...(acceptance === '' ? {} : { acceptance }),
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
  async start(
    conversationId: string,
    message: string,
    actor: Actor,
    requestId = '',
    attachmentIds: readonly string[] = [],
  ): Promise<StartedRun> {
    // 顺手兜一遍过期等待（#6）：内存闹钟丢了也不会再挂到重启，正常时晚 60 秒、轮不到它。
    void this.sweepStaleWaitings(actor).catch(() => {})
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
      turn = await this.prepareTurn(conversationId, message, actor, runId, attachmentIds)
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

  /**
   * 用户对一条待确认操作的决策（就地确认 / 取消）。
   *
   * **与 `startReply` 同一套语义**（幂等受理 + 后台执行 + 事件流），差别只在把"用户说的话"
   * 换成"一个结构化决策"。它会：
   *
   * 1. 核验任务与子任务归属（Actor 口径与读记录一致，不泄露存在性）；
   * 2. 找**执行方自己的**执行入口（`resolveExecutor`），把决策交给它——**协调方不替它执行**，
   *    凭据也从不经过这里（`AgentAction` 只有呈现数据）；
   * 3. 把返回的新状态与新的待办按同一条 `subtask` 事件通道下发，顺带更新留存（刷新后仍画得出）。
   */
  async startAction(input: {
    taskId: string
    subtaskId: string
    actionId: string
    decision: 'confirm' | 'cancel'
    note?: string
    actor: Actor
    requestId?: string
  }): Promise<StartedRun> {
    const requestId = input.requestId ?? ''
    const digest = digestOf([input.taskId, input.subtaskId, input.actionId, input.decision, input.note ?? ''])
    if (requestId !== '') {
      const existing = await this.storage.request(input.actor, 'action', requestId)
      if (existing !== undefined) return this.replayRequest(existing, digest, requestId)
    }
    const runId = `butler-run-${randomUUID()}`
    if (requestId !== '') {
      const winner = await this.storage.claimRequest(input.actor, 'action', requestId, digest, runId, '', this.config.idempotencyTtlMs)
      if (winner !== undefined) return this.replayRequest(winner, digest, requestId)
    }
    let prepared: PreparedAction
    try {
      prepared = await this.prepareAction(input, runId)
    } catch (error) {
      if (requestId !== '') this.releaseRequestQuietly(input.actor, 'action', requestId)
      throw error
    }
    if (requestId !== '') await this.storage.bindRequest(input.actor, 'action', requestId, prepared.runId, prepared.conversationId)
    const log = this.beginLog(prepared.conversationId, prepared.runId)
    void this.pump(prepared.abort.signal, log, this.actionBody(prepared))
      .then(() => { if (requestId !== '') void this.finishRequestWithRetry(input.actor, 'action', requestId) })
      .catch(error => { console.error(`butler-console: 确认收尾链失败（${prepared.conversationId}/${prepared.runId}）：${visibleError(error, 300)}\n${stackOf(error)}`) })
    return { runId: prepared.runId, conversationId: prepared.conversationId, from: 0 }
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
    void this.sweepStaleWaitings(input.actor).catch(() => {})
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
    void this.sweepStaleWaitings(input.actor).catch(() => {})
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
      const turn = this.runTurn(conversation, prompt, prepared.abort.signal, {
        onDelta: delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }),
        onReset: () => speech.push({ type: 'chat_reset', time: Date.now() }),
        context: { taskId, subtasks: record.subtasks },
        onThinking: thinking => speech.push({ type: 'chat_thinking', role: 'butler', thinking, time: Date.now() }),
      })
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
          acceptance?: string
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
            // 新追加的每一步可以有自己的口径。**任务级口径不在这里改写**：补充轮追加的是同一个
            // 任务里的新活，用后来的补充悄悄改掉整条任务的口径，会让已经派出去的那些步失去依据。
            ...(subtask.acceptance === undefined ? {} : { acceptance: subtask.acceptance }),
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
            ...(subtask.acceptance === undefined ? {} : { acceptance: subtask.acceptance }),
            ...(subtask.supersedes === undefined ? {} : { reworkOf: subtask.supersedes }),
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
      // 与 settleAfterTurn 复用同一 drainQueue，传导给排队下游之后才谈收尾。
      yield* this.drainQueue({
        taskId,
        actor,
        goal: (await this.storage.task(actor, taskId))?.goal ?? '',
        signal: prepared.abort.signal,
      })

      // 收尾走同一条路径：它按库里的子任务结局决定终态，也负责把材料与外部待办留住。
      const acceptance = await this.storedAcceptance(actor, taskId)
      yield* this.closeTask({
        taskId,
        actor,
        conversation,
        goal: (await this.storage.task(actor, taskId))?.goal ?? '',
        subtasks: await this.storedSubtasks(actor, taskId, []),
        ...(acceptance === '' ? {} : { acceptance }),
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
      // 汇总轮的内部提示词同样被宿主记成 source=user：它带着裁决指令与验收口径，出现在
      // 正文里等于把给模型的指令念给老板听（生产 #1）。标志串与 {@link summarize} 的拼装
      // 共用同一组常量——改提示词必须连同这里一起改。两个标志同时命中才判内件，真人恰好
      // 打出这两句的概率可以忽略。
      if (text.includes(SUMMARY_PROMPT_GOAL) && text.includes(SUMMARY_PROMPT_RESULTS)) return null
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
    // （与 settleAfterTurn 同一实现，不另造一套）。会话上正有回话或补充在执行时让位：那一轮
    // 自己的收尾会排空队列，两条路径同时派同一步会把它派两遍。
    // 会话上正有回话或补充在执行时让位（判断在 finishTaskAfterBackgroundWrite 内）：
    // 那一轮自己的收尾会排空队列，两条路径同时派同一步会把它派两遍。
    await this.finishTaskAfterBackgroundWrite(taskId, actor, WAITING_EXPIRED_TASK)
  }

  /**
   * 后台写完一条子任务终态之后的收尾：依赖重判（排队的下游结账）+ 全终结时的任务结账。
   *
   * 从 {@link expireWaiting} 抽出：等待超时、喊停收等待、兜底扫描三条后台路径共用同一副
   * 骨架——三处各抄一份的后果就是其中一处忘了核验依赖（排队的下游悬空到老板下次过问）。
   *
   * 事件全部丢弃：后台路径没有 SSE 观众，状态与原因都以先写库的记录为准。
   */
  private async finishTaskAfterBackgroundWrite(taskId: string, actor: Actor, settleErrorOverride: string): Promise<void> {
    const record = await this.storage.task(actor, taskId)
    if (record === undefined) return
    const holder = this.claims.get(record.conversationId)
    // 会话上有**任何**占用（回话/补充/一轮/另一次点卡）都先不派发排队步骤：两条路径同时
    // 派同一步会把它派两遍（dispatched→dispatched 幂等合法，挡不住第二个写者）。占用方自己
    // 的收尾会排空队列。任务级结账照走——它有版本与终态守卫，覆盖不了才留给下一轮兜底。
    if (holder === undefined) {
      // 这是无人观看的后台收尾：没有对应的 SSE 轮次，事件如实产出后不外推。
      for await (const _event of this.drainQueue({
        taskId, actor, goal: record.goal, signal: new AbortController().signal,
      })) { /* 后台收尾没有 SSE 观众 */ }
    }
    const after = await this.storage.task(actor, taskId)
    if (after === undefined || after.subtasks.some(item => !isTerminal(item.state))) return
    for await (const _event of this.settleTask({
      taskId,
      actor,
      conversation: undefined,
      goal: after.goal,
      subtasks: effectiveSubtasks(after.subtasks),
      ...(after.acceptance === '' ? {} : { acceptance: after.acceptance }),
      reports: await this.storedReports(actor, taskId),
      signal: new AbortController().signal,
      stopped: false,
      summarize: false,
      settleErrorOverride,
    })) { /* 后台收尾没有 SSE 观众 */ }
  }

  /**
   * 喊停时把这个会话里挂着「等你回话」的步骤一并收掉（收成 `cancelled`，材料保留）。
   *
   * 等待中的步骤没有活跃 run，`cancel` 只看 `this.runs` 时它们喊不停（#14）——等待又
   * 不设执行定时器，用户面对一条永远挂着且无处回话的任务没有任何收尾手段。喊停是老板
   * 的明确意志，等待作废（材料保留）是它最贴近的语义。
   *
   * 返回收掉的条数；0 表示这个会话本来就没有等待中的步骤。
   */
  private async stopWaitingSubtasks(conversationId: string, actor: Actor, taskId = ''): Promise<number> {
    const stopped = await this.storage.cancelWaitingSubtasks(actor, conversationId, WAITING_STOPPED, taskId)
    if (stopped.length === 0) return 0
    for (const item of stopped) {
      this.clearWaitingTimeout(`${item.taskId}:${item.subtaskId}`)
      this.waiting.delete(`${item.taskId}:${item.subtaskId}`)
    }
    for (const taskId of new Set(stopped.map(item => item.taskId))) {
      await this.finishTaskAfterBackgroundWrite(taskId, actor, WAITING_STOPPED_TASK)
    }
    return stopped.length
  }

  /**
   * 兜底：收掉明显超过 `waitingTimeoutMs` 仍挂在等待里的步骤。
   *
   * 等待超时靠内存 `setTimeout`（{@link scheduleWaitingTimeout}），闹钟挂不上或进程内
   * 丢失时，等待会挂到下一次服务重启才被 `failInterrupted` 收敛——生产实测挂过 50+ 分钟
   * （#6）。这里在用户动作的入口上再扫一遍：晚于闹钟 60 秒才动手（正常情况轮不到它），
   * 只收"闹钟明显不在了"的。`started_at` 是首次进入执行的时间，等待必然发生在它之后，
   * 拿它当兜底口径只会提前收、不会漏收。
   */
  private async sweepStaleWaitings(actor: Actor): Promise<void> {
    if (this.disposed) return
    // 阈值取两倍时限：闹钟活着的话，等待最多存活一个时限就被它收掉；超过两倍还挂着，
    // 只可能是闹钟真丢了。用时限本身会把「执行很久后才提问」「回话后的第二次等待」误收
    // （它们的 started_at 是首次派发时间，比等待本身早得多）。
    const stale = await this.storage.staleWaitingSubtasks(actor, this.config.waitingTimeoutMs * 2 + 60_000)
    for (const item of stale) {
      const key = `${item.taskId}:${item.subtaskId}`
      // 闹钟还在内存里就轮不到兜底：二次等待刚挂上时 started_at 早已很老，时间条件分不出
      // 「新等待」和「死闹钟」，内存表分得出（#6）。
      if (this.waitingTimers.has(key)) continue
      const displayName = await this.displayNameOf(actor, item.agentId)
      await this.expireWaiting(key, item.taskId, item.subtaskId, displayName, actor).catch(error => {
        console.error(`butler-console: 兜底超时收尾失败（${key}）：${visibleError(error, 300)}`)
      })
    }
  }

  /** 在会话上开一份新的事件日志，覆盖它的上一轮。 */
  private beginLog(conversationId: string, runId: string): ConversationLog<ButlerEvent> {
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
    hooks: RunHooks = {},
  ): Promise<{ outcome: TurnOutcome; text: string; plans: readonly PlanSubmission[] }> {
    const { onDelta, onReset, context, onThinking, images } = hooks
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
      // 图片随消息一起发出去（只有当前模型收图片时才有内容）。**顺序是"文字在前、图片在后"**：
      // 先给模型看要它干什么，再看图，比反过来少一次"这些图是干嘛的"的猜测。
      conversation.handle.agent.followup(createUserMessage({
        content: [
          { type: 'text', text },
          ...(images ?? []).map(attachment => ({ type: 'image' as const, attachment })),
        ],
        source: { kind: 'user' },
      }))
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
   * goal 充实（中继轮）：派下一棒之前，让大总管读着上游交回的原文，把这一步在拆解时
   * 预写的目标织具体——「用 A 查来的数据配图」变成「用 A 交回的那三个数字配图」。
   *
   * 在**临时会话**里跑：不经 butler 的会话表（不进用户的对话列表），也不占用户会话——
   * 并行派发时多个中继轮互不相撞，内部指令也绝不落进用户看得到的对话流。留痕是两份：
   * 原目标在计划快照里（`butler_plan` 落库的原文），充实版随 `dispatched` 写进子任务行。
   *
   * 中继只是增益：开不出会话、超时、被打断、空文或超长，一律回落原目标，不阻塞派单。
   */
  private async relayGoalEnrich(
    taskGoal: string,
    goal: string,
    refs: readonly ButlerInputRef[],
    signal: AbortSignal,
  ): Promise<string | null> {
    let handle: AgentHandle | undefined
    try {
      // `?? 45000`：旧配置对象（如测试手写的 config）没有这个新字段——中继预算兜个默认，别让增益功能变成派单门槛。
      const budget = AbortSignal.any([signal, AbortSignal.timeout(this.config.goalRelayTimeoutMs ?? 45_000)])
      const selection = await defaultConversationModel(this.ctx)
      const effort = selection.reasoningEffort ?? this.config.reasoningEffort
      const id = this.createId()
      handle = await this.ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: process.cwd() },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
        },
        setup: agentCtx => this.setup(agentCtx, id),
      })
      const conversation: Conversation = { id, handle, selection, active: false, lastUsedAt: Date.now() }
      const prompt = [
        '【内部中继指令·目标充实】一个多步骤任务里的一步即将派给执行方。上游步骤已经交回结果，请把这一步的目标结合上游产出改写得更具体。',
        '只输出改写后的目标正文本身：不要解释、不要前后缀、不要引号、不要调任何工具。',
        `整体目标：${clip(taskGoal, 1000)}`,
        `这一步在拆解时预写的目标：${goal}`,
        '上游交回的材料（原文照录）：',
        ...refs.map(ref => `【${ref.logicalId}】${clip(ref.text, 2000)}`),
        '改写规则：',
        '- 把上游交回里对这一步有用的具体信息（数字、结论、文件名、地址、口径、已确认的决定）织进目标正文；',
        '- 删掉与这一步无关的上游内容；',
        '- 上游材料里没有可用信息、或原目标已经足够具体时，原样重抄原目标；',
        '- 目标只转述要做的产出本身，老板没说的要求不要添加。',
      ].join('\n')
      const turn = await this.runTurn(conversation, prompt, budget)
      if (turn.outcome.kind !== 'completed') return null
      const text = turn.text.trim()
      // 上限收紧到 1200：充实目标是"要点织入"不是"材料搬运"，留太多反而把派单顶破成员上限。
      if (text === '' || text.length > 1200) return null
      return text
    } catch {
      return null
    } finally {
      void handle?.dispose().catch(() => { /* 中继会话用完即弃，释放失败不影响派单。 */ })
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
  /**
   * 把成员的结论落到子任务记录上。
   *
   * @returns **写进库里的那份正文**。调用方必须用它做事件里的 `detail`——实时与回看同源，
   *   靠的就是"返回同一个值"，而不是两处各拼一次（那份不一致用户已经看见过了）。
   */
  private async applyMemberResult(input: {
    actor: Actor
    taskId: string
    subtaskId: string
    result: ButlerDispatchResult
    emptyText?: string
  }): Promise<string> {
    const { actor, taskId, subtaskId, result } = input
    const emptyText = input.emptyText ?? ''
    const max = this.config.maxResultChars
    const artifacts = result.artifacts === undefined ? {} : { artifacts: result.artifacts }
    const conversation = result.conversationId === undefined || result.conversationId === ''
      ? {}
      : { conversationId: result.conversationId }
    /**
     * ⚠️ 正文**只在这里拼一次**（{@link subtaskResultText}），事件里的 `detail` 用它的返回值。
     *
     * 这条注释是花钱买来的：曾经落库拼的是 `正文 + "\n\n外部待办：…"`，而实时事件发的是
     * 那句 `reason`——于是**同一条子任务，刷新前和刷新后看到的正文不一样**（用户在生产上直接
     * 看到：刷新前卡片里没有"外部待办"那一段，刷新后有了）。两份拼法必然漂移，所以合成一份。
     */
    const text = subtaskResultText(result, max, emptyText)
    /**
     * 成员交回的待办清单是**会话级**的：另一个步骤刚做出来的卡也会出现在这一步的清单里。
     * 整份收下就会让同一张卡在两个步骤下面各画一遍（用户生产上看到的就是两张一样的卡），
     * 而画在错步骤下面的那张，点了结算的是错的那一步。归属规则见 {@link ownPendingActions}。
     */
    const record = await this.storage.task(actor, taskId)
    const declared = (record?.subtasks.find(item => item.id === subtaskId)?.memberReturn as
      { readonly actions?: readonly AgentAction[] } | undefined)?.actions ?? []
    // 归属判定还要跨**任务**看一圈：待办清单按成员会话共享，同会话先开的任务已经声明过的卡，
    // 后开任务的步骤不能再整份收进名下——收了就是同一张卡挂两处，点挂在后出任务下的那张，
    // 结算的是错的任务（生产 #13）。
    //
    // ⚠️ 但排除表**不能把"成员本轮真的新做出来的卡"也排掉**：同一成员会话先后跑两个任务时，
    // 成员为新任务做的卡 id 是新的，不在任何旧声明里，正常进入本步名下；真正要防的只有
    // "别的任务**声明过**的卡"被重复挂载。此前这里的排除表按"同会话所有任务的声明"取全集，
    // 会把**成员刚做出来、但恰好与旧任务同会话**的新卡一并排掉——卡片在界面上无处安放，
    // op 却活着，用户点确认得 404「这条待办不存在」（生产 2026-09-19 清理任务，365/369 三连）。
    // 修正：跨任务排除只取"旧任务里**当前仍是 prepared 且还没被本会话之外消费**"太复杂，
    // 且归属的真正判据是 op 的 logicalId 指向哪一步。改为：排除表中只保留
    // "memberReturn 明文声明过"的那些 id（siblingClaimedActionIds 已按此实现），
    // 同时把"本轮 result.actions 里 id 是新的、不等于任何旧声明"的卡**强制归属本步**
    // ——声明权按"谁先把它画给用户"算。
    const claimed = new Set(claimedByOthers(record, subtaskId))
    const memberConversationId = result.conversationId ?? record?.subtasks.find(item => item.id === subtaskId)?.conversationId ?? ''
    const siblingClaims = memberConversationId === ''
      ? new Map<string, string>()
      : await this.storage.siblingClaimedActionIds(actor, memberConversationId, taskId)
    // 归属唯一判据是 op 的 logicalId（成员声明这张卡时写下的 "run:<taskId>:<subtaskId>"）：
    // - 指向**别的任务/别的步骤** → 进排除表（重复挂载面，#13）；
    // - 指向**本步** → 从排除表放行（本步快照即便被清过，成员交回时也要归位）。
    // 没有 logicalId 的老数据按排除表处理。豁免语义由此精确，不再按"新卡"猜。
    for (const [id, logical] of siblingClaims) {
      if (logical === `run:${taskId}:${subtaskId}`) claimed.delete(id)
      else if (logical !== '') claimed.add(id)
    }
    const actions = ownPendingActions(declared, result.actions ?? [], claimed)
    const memberReturn: ButlerMemberReturn = {
      ...memberReturnOf(result),
      ...(actions.length === 0 ? { actions: [] } : { actions }),
    }
    if (result.status === 'succeeded') {
      await this.settleSubtaskState(taskId, subtaskId, 'succeeded', { result: text, memberReturn, ...artifacts, ...conversation })
      return text
    }
    if (result.status === 'waiting_user') {
      await this.settleSubtaskState(taskId, subtaskId, 'waiting_user', { result: text, memberReturn, ...artifacts, ...conversation })
      return text
    }
    if (result.status === 'external_pending') {
      const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
      if (reason === '') {
        // 声明了外部待办却没说明在等什么，按「返回不满足协作契约」收：猜一个理由等于
        // 给用户显示一件没发生过的外部事项。材料仍然保留。
        const error = '说还有外部待办，但没说明在等什么'
        await this.settleSubtaskState(taskId, subtaskId, 'failed', {
          error, result: text, memberReturn, ...artifacts, ...conversation,
        })
        return error
      }
      await this.settleSubtaskState(taskId, subtaskId, 'external_pending', {
        result: text, memberReturn, ...artifacts, ...conversation,
      })
      return text
    }
    const cancelled = result.status === 'cancelled'
    // 失败/取消只写 error，result 由 COALESCE 保留先前交回的阶段性成果。
    const written = cancelled && text === '' ? '已停止' : text
    await this.settleSubtaskState(taskId, subtaskId, cancelled ? 'cancelled' : 'failed', {
      error: written,
      memberReturn,
    })
    return written
  }

  /**
   * 结账写入：这一步的状态变化**必须真的落到库里**。
   *
   * 条件 UPDATE 在迁移不合法时**影响 0 行、而且不报错**。2026-09-18 的生产现场就是这一条：
   * `external_pending → succeeded` 漏在存储层的写入白名单里，老板点掉确认卡之后库里那一步
   * 还是 `external_pending` —— 表面上"点了没反应"，实际是"办完了"这件事被静默丢掉，等它的
   * 下游永远留在队列里。
   *
   * 白名单现在由迁移表生成（{@link import('./task-model.ts').subtaskTransitionSources}，
   * 只有一份实现），能挡掉的只剩"并发抢先改写"；那一种也必须有声音，不能继续无声无息。
   */
  private async settleSubtaskState(
    taskId: string,
    subtaskId: string,
    state: SubtaskState,
    patch?: Parameters<ButlerStorage['setSubtaskState']>[3],
  ): Promise<void> {
    const written = await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, state, patch))
    if (written === 0) {
      console.warn(`butler-console: 子任务 ${subtaskId} 的结论没写进库里（目标状态 ${state}）—— 迁移不合法，或已被并发改写；接下来的依赖核验会读到旧状态`)
    }
  }

  /**
   * 用成员刚交回的清单，刷新**同一个成员会话里其他步骤**的待办快照。
   *
   * 待办是**会话级**的：一次「删 342、343」分成两步、共用同一个成员会话时，342 的卡办掉之后，
   * 第二步手上那张 342 的卡就是死卡了。不清掉它，界面上会一直留着一张点了只回
   * "这条操作已经办完了"的卡，用户还以为事情没办完。
   *
   * 两条边界：
   * - 只清"已经不在成员清单里"的，**不把清单里那些这一步没声明过的搬过来**（见
   *   {@link ownPendingActions}：搬过来就会在错步骤下面多画一张卡）；
   * - 只刷新**同一个成员会话**里的步骤 —— 待办按会话归属，别的会话的清单套不上来。
   */
  private async refreshSiblingPendingActions(input: {
    taskId: string
    actor: Actor
    conversationId: string
    fresh: readonly AgentAction[]
    /** 刚刚办完的那一步：它自己那份由调用方连同结果一起写入，这里跳过。 */
    skipSubtaskId: string
  }): Promise<readonly { subtaskId: string; state: SubtaskState; actions: readonly AgentAction[]; agentId: string; displayName: string }[]> {
    const record = await this.storage.task(input.actor, input.taskId)
    if (record === undefined) return []
    const refreshed: { subtaskId: string; state: SubtaskState; actions: readonly AgentAction[]; agentId: string; displayName: string }[] = []
    for (const step of record.subtasks) {
      if (step.id === input.skipSubtaskId) continue
      if (step.conversationId !== input.conversationId) continue
      const declared = step.memberReturn?.actions ?? []
      if (declared.length === 0 || step.memberReturn === undefined) continue
      const own = ownPendingActions(declared, input.fresh, claimedByOthers(record, step.id))
      const unchanged = own.length === declared.length
        && own.every((action, index) => action.id === declared[index]?.id && action.state === declared[index]?.state)
      if (unchanged) continue
      // 状态不动（相同状态是合法迁移），只把待办快照换成成员此刻的真实清单。
      await this.settleSubtaskState(input.taskId, step.id, step.state, {
        memberReturn: { ...step.memberReturn, actions: own },
      })
      // 快照变了必须**发事件**：实时视图里这张卡还画在兄弟步骤名下（随会话级清单进的），
      // 不发事件它就残留在界面上可点，点了提交的是错步骤 → 404「这条待办不存在」
      // （生产 2026-09-19，同一会话两张删除卡第二张必挂；刷新后一切正常，正是缺这条事件）。
      refreshed.push({
        subtaskId: step.id, state: step.state, actions: own, agentId: step.agentId,
        displayName: await this.displayNameOf(input.actor, step.agentId),
      })
    }
    return refreshed
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
    /**
     * 这一步自己的验收口径；空/缺省表示这一步没有可核验的口径。
     *
     * **不回落到任务级口径**：任务级描述的是整件事要交回什么（往往是最终产物），套到
     * 「先查个资料」这类中间步骤上，会让「口径提到的产出物必须交回」那条校验把它们系统性
     * 判成不达标。任务级口径留给汇总与裁决阶段用。
     */
    acceptance?: string
    /**
     * 这一次派活是对哪一条尝试的重做：填被重做的子任务 id，取值来自库里的 `supersedes`。
     *
     * 它与 `supersedes` 是**同一条关系的两个投影**：`supersedes` 是管家自己的私有列（模型填、
     * 有强校验、被 `effectiveSubtasks()` 消费），`reworkOf` 是跨插件契约里的那一个（执行方看）。
     * 两者**必须同源**——由这里从同一条记录同时取出，不允许各写一份（否则会出现
     * `supersedes=s3` 而 `reworkOf=s5` 的自相矛盾，且没有任何断言能发现）。
     */
    reworkOf?: string
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
        /**
         * 成员交回的**待确认操作**。
         *
         * ⚠️ 这个字段曾经**漏在 emit 里**：落库那条路有（`memberReturnOf` 存了，回看时从
         * `memberReturn.actions` 取回来），实时这条路没有 —— 于是用户在生产上看到的是
         * "卡片上写着要确认，但一个按钮都没有"，刷新之后按钮才出现（回看路把它补上了）。
         * 结构化的东西**两条路都要带**，缺哪条都会表现成"有时有、有时没有"。
         */
        actions?: readonly AgentAction[]
      } = {},
    ): ButlerEvent => ({
      type: 'subtask', taskId, id: subtaskId, state, agentId, displayName, detail,
      ...(extra.phase === undefined ? {} : { phase: extra.phase }),
      ...(extra.tool === undefined ? {} : { tool: extra.tool }),
      ...(extra.question === undefined ? {} : { question: extra.question }),
      ...(extra.artifacts === undefined ? {} : { artifacts: extra.artifacts }),
      ...(extra.pending === undefined ? {} : { pending: extra.pending }),
      ...(extra.actions === undefined || extra.actions.length === 0 ? {} : { actions: extra.actions }),
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

    // 容量：按**完整派单 message** 计（整体目标、本步、老板带的附件、材料原文、位置来源、
    // 外部待办全部计入）。超限一律不派单，也不静默或显式截断后继续；由老板缩小范围后走既有
    // 「新尝试」规则。
    const attachmentSection = await this.attachmentSection(input.actor, taskId)
    // goal 充实（方案 B）：带上游材料的派单先过一次中继轮，把拆解时预写的目标织具体。
    // 充实版落进子任务行（原目标留痕在计划快照），派单简报与页面显示都用充实版。
    let dispatchGoal = input.goal
    let goalRefined = false
    if (inputRefs.length > 0) {
      const refined = await this.relayGoalEnrich(input.taskGoal, input.goal, inputRefs, signal)
      if (refined !== null && refined !== input.goal) {
        dispatchGoal = refined
        goalRefined = true
      }
    }
    const brief = dispatchBrief(input.taskGoal, dispatchGoal, inputRefs, attachmentSection, goalRefined)
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
    // 队列，天然晚于本条。goal 只在中继充实过时才覆盖（v1 在计划快照里，v2 是派出去的这份）。
    await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'dispatched', {
      inputRefs,
      ...(goalRefined ? { goal: dispatchGoal } : {}),
    }))
    yield emit('dispatched', `已把活交给 ${displayName}${goalRefined ? '（目标已结合上游产出充实）' : ''}`, { phase: 'analyzing' })

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    // addEventListener 对"已经 aborted"的 signal 不会回调：并行派发后，喊停可能落在这条
    // 流被选出与注册监听之间（批前检查之后的窗口）——不补这一句，它会白跑一整轮模型
    // 调用直到执行超时，与喊停语义相悖。
    if (signal.aborted) controller.abort()
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
        // 验收口径按步传：执行方拿它做本轮自检，协调方也用它核验「口径提到的产出物是否真的
        // 交回」。空串不传 —— 契约里的缺省语义就是「没有声明口径」，传空串会让执行方以为有口径。
        ...(input.acceptance === undefined || input.acceptance === '' ? {} : { acceptance: input.acceptance }),
        // 重做溯源：与库里的 `supersedes` 同源，由调用方从同一条记录取出。
        ...(input.reworkOf === undefined || input.reworkOf === '' ? {} : { reworkOf: input.reworkOf }),
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
        // `detail` 用落库返回的**同一个值**：实时与刷新后看到的是同一段正文。
        const detail = await this.applyMemberResult({ actor: input.actor, taskId, subtaskId, result, emptyText: `${displayName} 没干成这活` })
        // 事件里的待办只发**落库归这一步**的那份（见 persistedActionsForEmit）：原始 result.actions
        // 是会话级清单，原样发出去会把别的步骤的卡画到这一步名下，点了结算错步骤（生产 2026-09-19）。
        const actions = await this.persistedActionsForEmit(input.actor, taskId, subtaskId)
        yield emit('failed', detail, {
          ...(actions.length > 0 ? { actions } : {}),
        })
        return { state: 'failed', report: `【${displayName}】失败：${detail}` }
      }
      if (result.status === 'waiting_user') {
        const question = clip(result.question ?? result.summary, 500)
        // 落库走统一矩阵（G04）：正文、原会话与材料一次写全，刷新和重启都找得回。
        // ⚠️ 事件里的 `detail` 用它的返回值（正文），问题走 `question` 字段——前端请示卡优先
        // 显示 `question`（`askCard`），所以这里改成正文不会影响等待态的界面。
        const detail = await this.applyMemberResult({ actor: input.actor, taskId, subtaskId, result })
        // 记下等待上下文，用户回复时据此把话交回同一位成员；带上原会话引用供续问（G01）。
        this.waiting.set(`${taskId}:${subtaskId}`, {
          executor, agentId, displayName,
          ...(memberConversationId === undefined ? {} : { conversationId: memberConversationId }),
        })
        // 等待不是终态，执行的定时器已经撤了，这里另起一个等回话的。
        await this.scheduleWaitingTimeout(taskId, subtaskId, displayName, input.actor)
        const actions = await this.persistedActionsForEmit(input.actor, taskId, subtaskId)
        yield emit('waiting_user', detail, {
          phase: 'waiting_user',
          question,
          ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
          ...(actions.length > 0 ? { actions } : {}),
        })
        return { state: 'waiting_user', report: `【${displayName}】等着你回话：${question}` }
      }
      if (result.status === 'external_pending') {
        // 判定来源只有一个：员工给出的结构化声明。**不从正文措辞里猜**，也不因为
        // 「结果里带着材料」就自行把这一轮当成可以在外部收尾 —— 那正是要避免的混用。
        const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
        const detail = await this.applyMemberResult({ actor: input.actor, taskId, subtaskId, result })
        if (reason === '') {
          if (!signal.aborted) console.warn(`butler-console: 子任务 ${taskId}:${subtaskId}（${agentId}）声明 external_pending 但没有给出理由`)
          yield emit('failed', detail, { ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }) })
          return { state: 'failed', report: `【${displayName}】失败：${detail}` }
        }
        // 待办理由随结果落库（applyMemberResult）：只留在事件里的话，刷新之后任务详情
        // 就只剩一段正文，看不出还等着谁做什么。
        const actions = await this.persistedActionsForEmit(input.actor, taskId, subtaskId)
        yield emit('external_pending', detail, {
          ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
          ...(actions.length > 0 ? { actions } : {}),
          pending: {
            reason,
            ...(result.externalPending?.next === undefined ? {} : { next: result.externalPending.next }),
          },
        })
        return { state: 'external_pending', report: `【${displayName}】${detail}` }
      }
      const summary = await this.applyMemberResult({ actor: input.actor, taskId, subtaskId, result })
      const actions = await this.persistedActionsForEmit(input.actor, taskId, subtaskId)
      yield emit('succeeded', summary, {
        ...(actions.length > 0 ? { actions } : {}),
      })
      return { state: 'succeeded', report: summary }
    } catch (error) {
      const stopped = signal.aborted || timedOut
      /**
       * **重启重放被拒**（运行时抛的 409）与"成员业务失败"必须分得开：前者不是活没干好，
       * 是这一轮请求本来就不该重跑（外部副作用已经发生过一次）。判据是落库的 `error` 以
       * {@link REPLAY_REJECTED_PREFIX} 开头，{@link reportOf} 据此换一句渲染。
       */
      const replayed = !stopped && isReplayRejection(error)
      const raw = stopped ? '' : visibleError(error, this.config.maxResultChars)
      const detail = stopped
        ? (timedOut ? `超过 ${Math.round(this.config.subtaskTimeoutMs / 1000)} 秒没干完，已叫停` : '已停止')
        // 归类交给纯函数（`dispatchFailureDetail`）：判定可被直接测到。
        : dispatchFailureDetail(error, raw)
      const state: SubtaskState = stopped ? 'cancelled' : 'failed'
      // 失败只留下「给用户看的一句话」时，服务端也就没有别的东西可查：页面上只有一句
      // TypeError，日志里什么都没有，定位只能靠猜。这里把栈单独写进日志（脱敏后），
      // 用户看到的文案不变。
      //
      // 重放被拒**不打 error 级日志**：它不是故障，是一次正常的拒绝；打成错误会让运维去追
      // 一个不存在的成员故障。用 warn 并写清"不是失败"。
      if (replayed) {
        console.warn(`butler-console: 子任务 ${taskId}:${subtaskId}（${agentId}）被运行时拒绝重跑（不是失败）：${raw}`)
      } else if (!stopped) {
        console.error(`butler-console: 子任务执行失败（${agentId}）：${detail}\n${stackOf(error)}`)
      }
      await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, state, { error: detail }))
      yield emit(state, detail)
      return {
        state,
        // 取消与"重放被拒"都不加「失败：」前缀：前者是喊停，后者是这一轮本来就不该跑。
        report: stopped || replayed ? `【${displayName}】${detail}` : `【${displayName}】失败：${detail}`,
      }
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
    // 转移核验：准备期间等待可能已被喊停/兜底收掉（它们不占会话 claim，claimNow 挡不住
    // 这个窗口）。写不进 running（0 行）就如实拒绝，不再驱动成员白跑一轮。
    const moved = await this.queueSubtaskWrite(input.taskId, input.subtaskId, () => this.storage.setSubtaskState(input.taskId, input.subtaskId, 'running'))
    if (moved === 0) throw new AccessError(409, '这次等待刚刚被喊停或收掉了，重新描述你的目标就能接着办', 'waiting_gone')
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
      // 口径从库里读回来：续问发生在可能重启过的进程里，不能指望派的单还留在内存。
      ...(subtask.acceptance === '' ? {} : { acceptance: subtask.acceptance }),
      runId,
      abort,
    }
  }

  /**
   * 受理一次操作决策（就地确认 / 取消）。
   *
   * 与 `prepareReply` 的三点不同，都是有意的：
   *
   * 1. **不要求"正在等待"**：这类操作的典型形态是 `external_pending`（材料已交回、事情在别处
   *    等着办）——那一轮**已经收尾**了，等待登记也早就清了。所以执行方按**注册表**找
   *    （`resolveExecutor`），不依赖内存里的等待上下文；服务重启后依然能确认。
   * 2. **不写 `running` 抢占这一轮**：确认不是"再跑一轮"，它只把一条决策交给执行方；
   *    子任务状态由返回的结果决定（可能仍然是 `external_pending`——还有别的待办）。
   * 3. **凭据不经过这里**：`AgentAction` 只有呈现数据，执行方从自己的记录里取确认凭据。
   */
  private async prepareAction(input: {
    taskId: string
    subtaskId: string
    actionId: string
    decision: 'confirm' | 'cancel'
    note?: string
    actor: Actor
  }, runId: string): Promise<PreparedAction> {
    this.access.assert(input.actor)
    const record = await this.storage.task(input.actor, input.taskId)
    if (record === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
    const subtask = record.subtasks.find(item => item.id === input.subtaskId)
    if (subtask === undefined) throw new AccessError(404, '这个子任务不存在', 'subtask_not_found')
    // 归属之外再核一次"这条操作确实属于这一步"：客户端传来的 actionId 不能越权去动别人的待办。
    // ⚠️ **归属以 actionId 在全任务内的真实宿主为准，而不是客户端传来的 subtaskId**：
    // 同一会话的待办清单按成员会话共享，前端可能把同一张卡画到多个步骤名下（实时视图与
    // 刷新重建各一份）；用户点的永远是"他看到的那张卡"——卡只有一个，结算就该落在它的
    // 真实宿主上（生产 2026-09-19：第二张卡被画进第一步的格子，按提交的 s1 找不到 → 404，
    // 卡永远办不掉）。actionId 在多步同时出现（理论上不该有）时按最早声明的那步算。
    const owner = record.subtasks.find(item =>
      ((item.memberReturn as { readonly actions?: readonly AgentAction[] } | undefined)?.actions ?? [])
        .some(action => action.id === input.actionId))
    if (owner === undefined) {
      throw new AccessError(404, '这条待办不存在或已经办完了', 'action_not_found')
    }
    const subtaskId = owner.id
    const subtaskForAction = owner
    void subtask
    const actions = (subtaskForAction.memberReturn as { readonly actions?: readonly AgentAction[] } | undefined)?.actions ?? []
    const executor = resolveExecutor(this.ctx, subtaskForAction.agentId)
    if (executor?.applyAction === undefined) {
      throw new AccessError(409, `${subtaskForAction.agentId} 没有实现就地确认，请到它的页面里办理`, 'action_unsupported')
    }
    // 同会话执行互斥：一次只允许一个决策/回话/补充在跑（防止同一个确认被并发执行两次）。
    if (!this.claimNow(record.conversationId, runId, 'action')) {
      const holder = this.claims.get(record.conversationId)
      throw new AccessError(409, holder?.kind === 'turn'
        ? '这一轮还在执行，等它收尾或先停止再确认'
        : '这个会话已有一次操作在执行，等它完成或先停止', 'conversation_busy')
    }
    const abort = new AbortController()
    this.runs.set(record.conversationId, { runId, abort })
    const memberConversationId = subtask.conversationId === '' ? undefined : subtask.conversationId
    return {
      conversationId: record.conversationId,
      taskId: input.taskId,
      subtaskId: input.subtaskId,
      actionId: input.actionId,
      decision: input.decision,
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
      actor: input.actor,
      executor,
      agentId: subtask.agentId,
      displayName: await this.displayNameOf(input.actor, subtask.agentId),
      ...(memberConversationId === undefined ? {} : { memberConversationId }),
      runId,
      abort,
    }
  }

  /**
   * 把决策交给执行方，按发生顺序产出事件。
   *
   * 结果按与派活/回话**同一套**分支处理：这样"确认之后还剩别的待办""确认之后这一轮才算成"
   * 这些情形都不需要另写一套状态机。
   */
  private async *actionBody(prepared: PreparedAction): AsyncGenerator<ButlerEvent> {
    const { taskId, subtaskId, agentId, displayName } = prepared
    try {
      yield {
        type: 'subtask', taskId, id: subtaskId, state: 'running',
        agentId, displayName,
        detail: prepared.decision === 'confirm' ? '你点了确认' : '你选择先不办',
        phase: 'analyzing', time: Date.now(),
      }
      const result = await prepared.executor.applyAction!({
        taskId,
        subtaskId,
        actionId: prepared.actionId,
        decision: prepared.decision,
        ...(prepared.note === undefined ? {} : { note: prepared.note }),
        ...(prepared.memberConversationId === undefined ? {} : { conversationId: prepared.memberConversationId }),
        actor: prepared.actor,
        signal: prepared.abort.signal,
      })
      /**
       * 办完一张卡之后，待办快照按成员交回的清单刷新，而且**只留在声明过它的步骤名下**。
       *
       * 2026-09-18 生产现场：一次「删 342、343」分成两步。点掉 342 的卡，成员交回的
       * "这个会话里还剩 343"被整份挂到**第一步**名下；界面于是在第一步下面又画了一张 343 的卡，
       * 用户点的是它 —— 结算的成了第一步，真正等 343 的第二步永远停在"待外部处理"，界面上的
       * 卡点了也只回一句"已经按你确认的办了"。
       *
       * 规则两句话：
       * - 这一步自己那份 = `它声明过的 ∩ 成员刚交回的`（见 {@link ownPendingActions}）；
       * - 这一步**自己还有没办完的待办**才停在"待外部处理"，别的步骤的待办由它们自己交回。
       */
      const record = await this.storage.task(prepared.actor, taskId)
      const acting = record?.subtasks.find(item => item.id === subtaskId)
      const declared = (acting?.memberReturn as { readonly actions?: readonly AgentAction[] } | undefined)?.actions ?? []
      const fresh = result.status === 'external_pending'
        // 成员说"还有别的待办"却没交回清单：不知道还剩什么，原样留着，不凭空清空。
        ? (result.actions === undefined || result.actions.length === 0 ? declared : result.actions)
        // 撤回：成员没交清单就等于没有剩余（成功同款）——留着 declared 会留一张
        // 点了只回"已经办完了"的死卡；交了清单就清到只剩清单里的。
        : result.status === 'cancelled'
          ? (result.actions ?? [])
          // 失败：操作没办成，卡还在原地。
          : result.status === 'failed' ? declared : []
      // 点卡结算与派发落库同一张归属排除表：本任务其他步骤 + **同成员会话其他任务**声明过的
      // 卡都要排除（跨任务不排除的话，成员交回的会话级清单会把别的任务已声明的卡又挂到
      // 这一步名下——同一张卡两处，点错的结算错任务，#13 在点卡路径的复发面）。
      const actionClaimed = new Set(claimedByOthers(record, subtaskId))
      const actionMemberConversation = result.conversationId ?? acting?.conversationId ?? ''
      if (actionMemberConversation !== '') {
        const siblingClaims = await this.storage.siblingClaimedActionIds(prepared.actor, actionMemberConversation, taskId)
        for (const [id, logical] of siblingClaims) {
          if (logical === `run:${taskId}:${subtaskId}`) actionClaimed.delete(id)
          else if (logical !== '') actionClaimed.add(id)
        }
      }
      const own = ownPendingActions(declared, fresh, actionClaimed)
      // 撤回与办成同款：这一步自己还有别的卡在等就停在"待外部处理"等下一张；
      // 一张都不剩时，确认 → succeeded，撤回 → cancelled（老板的"不要"是终态结论）。
      const state: SubtaskState = result.status === 'failed'
        ? 'failed'
        : result.status === 'waiting_user'
          ? 'waiting_user'
          : own.length > 0
            ? 'external_pending'
            : result.status === 'cancelled' ? 'cancelled' : 'succeeded'
      // 用户在确认卡上的决策是这一步的亲历事实：成员只转述结果，裁决与汇总只认材料。
      // 写进 result 一处，裁决清单、任务快照与刷新后的页面读到同一句话（单一来源，
      // 不在提示词里另行拼装）——没有它，裁决会把"点了确认"读成"没经过确认"（#12）。
      const decisionFact = prepared.decision === 'confirm'
        ? `用户已在确认卡上点了「确认」（操作 ${prepared.actionId.slice(0, 8)}）。`
        : `用户已在确认卡上点了「先不办」，这一步按撤回收尾（操作 ${prepared.actionId.slice(0, 8)}）。`
      // 结果落库：待办的最新状态要能在刷新后重画（与派活那条路径同一个写法）。
      // 材料同样要落库（批 2）：成员办结时交回的 `{ url, state, fields }` 写进步骤记录，
      // 刷新后产出区才有得画、裁决才有 url/state 可比——只进事件不进库，重启就全丢。
      await this.settleSubtaskState(taskId, subtaskId, state, {
        result: clip(`${decisionFact}${result.summary ?? ''}`, this.config.maxResultChars),
        memberReturn: { ...memberReturnOf(result), actions: own },
        ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
        ...(result.conversationId === undefined ? {} : { conversationId: result.conversationId }),
      })
      /**
       * 同一个成员会话里的**其他步骤**也要跟着刷新：342 的卡办掉之后，第二步手上那张 342 的卡
       * 已经成了死卡，不清掉的话界面留着它，用户点它只会得到"这条操作已经办完了"，
       * 还会以为事情没办完。
       */
      if (result.conversationId !== undefined && result.conversationId !== '') {
        const refreshed = await this.refreshSiblingPendingActions({
          taskId, actor: prepared.actor, conversationId: result.conversationId, fresh, skipSubtaskId: subtaskId,
        })
        // 兄弟步骤的待办快照变了就要**发事件**：实时视图里那张卡还画在兄弟名下（随会话级
        // 清单进来的），不发事件它就残留在界面上可点，点了提交错步骤 → 404（生产 2026-09-19）。
        // 状态不动、只换待办快照（同状态幂等迁移），事件让前端把兄弟名下的卡整块重画。
        for (const item of refreshed) {
          yield {
            type: 'subtask', taskId, id: item.subtaskId, state: item.state,
            agentId: item.agentId, displayName: item.displayName,
            detail: item.state === 'external_pending' ? '会话里还有别的待确认操作，已按刚才的确认更新' : `待办已更新`,
            time: Date.now(),
            ...(item.actions.length > 0 ? { actions: item.actions } : {}),
          }
        }
      }
      yield* this.emitResultEvents(prepared, result)
      /**
       * 办完这一条之后**把依赖传导下去**：正等这条前置的步骤可能就绪了。
       *
       * 少了这一步，用户点掉第一张卡、上游变成"已办完"，而后面排队的步骤没有人回头看它们
       * ——2026-09-18 的现场就是这样：一次「删六篇草稿」点了第一张，其余五张永远停在失败。
       */
      yield* this.settleAfterTurn(prepared, { deferToBusyTurn: true })
    } catch (error) {
      const detail = visibleError(error, this.config.maxResultChars)
      await this.settleSubtaskState(taskId, subtaskId, 'failed', { error: detail })
      yield { type: 'subtask', taskId, id: subtaskId, state: 'failed', agentId, displayName, detail, time: Date.now() }
      // 失败同样是一次结账：等它的下游该按真实状态重判（该派的派、该收的收）。
      yield* this.settleAfterTurn(prepared, { deferToBusyTurn: true })
    } finally {
      if (this.runs.get(prepared.conversationId)?.runId === prepared.runId) this.runs.delete(prepared.conversationId)
      this.releaseClaim(prepared.conversationId, prepared.runId)
    }
  }

  /**
   * 事件里的待办清单**只发落库后归这一步的那份**。
   *
   * `result.actions` 是成员交回的**会话级**清单（可能含别的步骤/别的卡的待办），事件里原样
   * 发出去，前端就会把别人的卡画到这一步名下；用户点这张错位的卡，提交的是（这一步，这张卡），
   * 而这一步的留存里没有它 → 404「这条待办不存在」（生产 2026-09-19，同一会话两张删除卡
   * 第二张必挂）。落库路径（applyMemberResult）已经做过 own 归属过滤，这里直接**读回落库
   * 的那份**——页面拿到的一定是库里那份。
   */
  private async persistedActionsForEmit(actor: Actor, taskId: string, subtaskId: string): Promise<readonly AgentAction[]> {
    const record = await this.storage.task(actor, taskId)
    return (record?.subtasks.find(item => item.id === subtaskId)?.memberReturn as
      { readonly actions?: readonly AgentAction[] } | undefined)?.actions ?? []
  }

  /**
   * 把一次执行的结论变成事件（派活 / 回话 / 确认三条路径共用）。
   *
   * 抽出来的理由：三条路径的**事件形状必须一致**（页面用的是同一个渲染器），而"外部待办"
   * 与"等你回话"两种暂停语义、以及待确认操作的下发，都在这里收口一次。
   */
  private async *emitResultEvents(
    prepared: { readonly taskId: string; readonly subtaskId: string; readonly agentId: string; readonly displayName: string },
    result: ButlerDispatchResult,
  ): AsyncGenerator<ButlerEvent> {
    const { taskId, subtaskId, agentId, displayName } = prepared
    const actionsOf = result.actions === undefined || result.actions.length === 0 ? {} : { actions: result.actions }
    if (result.status === 'waiting_user') {
      const question = clip(result.question ?? result.summary, 500)
      yield {
        type: 'subtask', taskId, id: subtaskId, state: 'waiting_user',
        agentId, displayName, detail: question, phase: 'waiting_user', question, time: Date.now(), ...actionsOf,
      }
      return
    }
    if (result.status === 'succeeded') {
      yield { type: 'subtask', taskId, id: subtaskId, state: 'succeeded', agentId, displayName, detail: clip(result.summary, this.config.maxResultChars), time: Date.now(), ...actionsOf }
      return
    }
    if (result.status === 'external_pending') {
      const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
      const failed = reason === ''
      yield {
        type: 'subtask', taskId, id: subtaskId, state: failed ? 'failed' : 'external_pending',
        agentId, displayName,
        detail: failed ? clip(`${displayName} 说还有外部待办，但没说明在等什么`, this.config.maxResultChars) : reason,
        time: Date.now(),
        ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
        ...actionsOf,
        ...(!failed && result.externalPending?.next !== undefined ? { pending: { reason, next: result.externalPending.next } } : {}),
      }
      return
    }
    yield {
      type: 'subtask', taskId, id: subtaskId,
      state: result.status === 'cancelled' ? 'cancelled' : 'failed',
      agentId, displayName,
      detail: clip(result.summary === '' ? `${displayName} 没接上这活` : result.summary, this.config.maxResultChars),
      time: Date.now(),
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
        // 续问沿用同一份口径：口径不变，变的是用户又补了一句话。
        ...(prepared.acceptance === undefined ? {} : { acceptance: prepared.acceptance }),
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
        await this.applyMemberResult({ actor: prepared.actor, taskId, subtaskId, result })
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
          yield {
            type: 'subtask', taskId, id: subtaskId, state: 'succeeded', agentId, displayName, detail: summary, time: Date.now(),
            // 有的操作确认完就整轮成功了（例如"交给它去发布"），那一步也可能带新的待办。
            ...(await this.persistedActionsForEmit(prepared.actor, prepared.taskId, prepared.subtaskId)),
          }
          yield* this.settleAfterTurn(prepared)
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
            // 待确认的操作跟着结果一起下发：页面**当场**就能画出确认卡（不必等刷新）。
            ...(await this.persistedActionsForEmit(prepared.actor, prepared.taskId, prepared.subtaskId)),
            ...(!failed && result.externalPending?.next !== undefined ? { pending: { reason, next: result.externalPending.next } } : {}),
          }
          yield* this.settleAfterTurn(prepared)
          return
        }
        const detail = clip(result.summary === '' ? `${displayName} 没接上这活` : result.summary, this.config.maxResultChars)
        const state: SubtaskState = result.status === 'cancelled' ? 'cancelled' : 'failed'
        yield { type: 'subtask', taskId, id: subtaskId, state, agentId, displayName, detail, time: Date.now() }
        yield* this.settleAfterTurn(prepared)
      } catch (error) {
        const detail = visibleError(error, this.config.maxResultChars)
        await this.queueSubtaskWrite(taskId, subtaskId, () => this.storage.setSubtaskState(taskId, subtaskId, 'failed', { error: detail }))
        this.waiting.delete(key)
        yield { type: 'subtask', taskId, id: subtaskId, state: 'failed', agentId, displayName, detail, time: Date.now() }
        yield* this.settleAfterTurn(prepared)
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
  ): Promise<{
    id: string
    logicalId: string
    goal: string
    agentId: string
    state: SubtaskState
    acceptance: string
    artifacts: readonly AgentArtifact[]
    result: string
    memberReturnText: string
    selfCheck: AgentSelfCheck | undefined
    verdict: SubtaskVerdict
  }[]> {
    const record = await this.storage.task(actor, taskId)
    if (record === undefined) {
      // 库里查不到：按「未跑完」回落。没有口径、也没有材料可谈 —— 空串与空数组就是"没有"。
      return planned.map(item => ({
        ...item, logicalId: item.id, state: 'cancelled' as SubtaskState, acceptance: '', artifacts: [],
        result: '', memberReturnText: '', selfCheck: undefined, verdict: '' as SubtaskVerdict,
      }))
    }
    return effectiveSubtasks(record.subtasks).map(item => ({
      id: item.id, logicalId: item.logicalId, goal: item.goal, agentId: item.agentId, state: item.state,
      // 每步的口径、材料、结果正文、协作返回原文、自检结论与已有裁决一并带上：裁决要靠它们做
      // **证据核验**与 **D-2 映射** —— 少一个，"核验"就退化成"看模型给的理由像不像真的"。
      acceptance: item.acceptance,
      artifacts: item.artifacts,
      result: item.result,
      memberReturnText: item.memberReturn?.text ?? '',
      selfCheck: item.memberReturn?.selfCheck,
      verdict: item.verdict,
    }))
  }

  /** 任务级验收口径的**唯一**读法；库里的空串就是"没有声明"。 */
  private async storedAcceptance(actor: Actor, taskId: string): Promise<string> {
    return (await this.storage.task(actor, taskId))?.acceptance ?? ''
  }

  /** 收尾时要交给汇总的材料，同样从库里重建、同样只看有效尝试。 */
  private async storedReports(actor: Actor, taskId: string): Promise<string[]> {
    const record = await this.storage.task(actor, taskId)
    return record === undefined ? [] : effectiveSubtasks(record.subtasks).map(reportOf)
  }

  /**
   * 收尾判定的**唯一实现**（判据 R9）：从「有效子任务的结局 + 是不是被喊停」算出这一轮该
   * 落什么结论。
   *
   * 收尾有四条路径（派活轮、补充轮、补话之后、等待超时），它们的差异只在「拿到结论之后做
   * 什么」：`closeTask` 拿它决定要不要跑汇总轮，{@link expireWaiting} 拿同一个结论决定要不
   * 要写终态。判定本身不再各写一份 —— 之前 `expireWaiting` 里内联的那份缺了「有取消的按
   * 停止处理」与「还有未处理输入先不结账」两条，于是同一份输入在两条路径上会得到不同答案，
   * 而且超时那条路径会把已经写好的 `cancelled` 改写成 `partial`。
   *
   * 顺序就是优先级（设计 §5.4 / §5.10 的早退表）：
   *
   * - 0 被喊停，或子任务里有取消的 ⇒ `cancelled`；
   * - 1 还有已接受未处理的输入 ⇒ `defer`：这一轮先不给结论，交给那条输入自己的回合。
   *     取消与故障**不受**这道屏障约束 —— 它们没有宣称成功，可以带着未处理的输入结束；
   * - 2 还有人在等用户回话 ⇒ `waiting_user`；
   * - 3 还有材料交回、剩下的事在别处办 ⇒ `external_pending`（等用户回话优先于外部待办：
   *     有人等着补一句话时，用户还没法把这一轮放下去开新活）；
   * - 4 其余落终态：全失败 ⇒ `failed`；有失败 ⇒ `partial`；队列里还有没跑过的步骤同样降级
   *     `partial`；否则 ⇒ `completed`。
   *
   * 调用方负责传**有效尝试**（`effectiveSubtasks()` 之后的那些）：被替代掉的旧尝试不参与
   * 这一轮的结论。
   */
  private async decideSettlement(input: {
    readonly taskId: string
    readonly subtasks: readonly { readonly state: SubtaskState }[]
    /** 这一轮是否已经被喊停。子任务里有取消的同样按停止处理。 */
    readonly stopped: boolean
  }): Promise<Settlement> {
    const { taskId, subtasks } = input
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
      return { kind: 'defer' }
    }
    // 还留在队列里的步骤（前置没就绪）同样不能算完成：它们根本没跑过。
    if (!stopped && undispatched > 0 && taskState === 'completed') taskState = 'partial'

    if (waiting > 0 && !stopped) return { kind: 'waiting_user', waiting }
    if (external > 0 && !stopped) return { kind: 'external_pending', external, failed }
    return { kind: 'settle', state: taskState, failed, stopped }
  }

  /**
   * 汇总并给这一轮写下终态。
   *
   * 派活那一轮和补话之后都会走到这里，所以它只认「子任务各自到了什么状态」和「已经拿到
   * 哪些结果」，不关心结果是怎么来的 —— 补话路径上的材料是从库里重建的，不是内存里那份。
   *
   * 只要还有子任务在等用户回话，任务就不算收尾：不跑汇总轮，状态停在 `waiting_user`，
   * 等补话那条路径把最后一位成员送走之后再回来调一次。
   *
   * 结论一律来自 {@link decideSettlement}：这里不再自己数一遍子任务。
   */
  /**
   * 打开这一次收尾的裁决上下文。
   *
   * 只收**已终结、且还没裁决过**的步骤：没结束的步骤没有结论可裁；已经裁过的（补话之后
   * 汇总轮会重跑）不该被再裁一次——同一子任务重复裁决会让结论互相覆盖，而下一次裁决的依据
   * 已经和上一次不同了。
   */
  private openVerdictContext(sessionId: string, input: SettleTaskInput): void {
    const open = input.subtasks
      .filter(item => isTerminal(item.state) && (item.verdict ?? '') === '')
      .map(item => ({
        id: item.id,
        goal: item.goal,
        agentId: item.agentId,
        result: item.result ?? '',
        artifacts: item.artifacts ?? [],
        memberReturnText: item.memberReturnText ?? '',
        selfCheck: item.selfCheck,
      }))
    this.verdictContexts.set(sessionId, {
      actor: input.actor, taskId: input.taskId, open,
      decided: new Set(), decisions: [], problems: [],
    })
  }

  /** 关掉上下文并取回结论。**一定要关**：留在 Map 里，下一轮的模型会以为还能接着裁。 */
  private closeVerdictContext(sessionId: string): VerdictContext | undefined {
    const context = this.verdictContexts.get(sessionId)
    this.verdictContexts.delete(sessionId)
    return context
  }

  private async *settleTask(input: SettleTaskInput): AsyncGenerator<ButlerEvent> {
    const { taskId, conversation, goal, subtasks, reports, signal } = input
    const settlement = await this.decideSettlement({ taskId, subtasks, stopped: input.stopped })

    if (settlement.kind === 'defer') {
      yield {
        type: 'chat', role: 'butler',
        text: '老大又补了一句，这一轮先不结账 —— 等新的说法处理完再给你结论。',
        time: Date.now(),
      }
      return
    }

    if (settlement.kind === 'waiting_user') {
      const message = `有 ${settlement.waiting} 位成员在等你回话，回完再给你汇总。`
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
     */
    if (settlement.kind === 'external_pending') {
      const message = `材料已经交回，还有 ${settlement.external} 件事要在外面办完。这一轮到此为止，想继续可以新开一轮。`
      const error = settlement.failed === 0 ? '' : `${settlement.failed} 个子任务失败`
      await this.storage.setTaskState(taskId, 'external_pending', { summary: reports.join('\n\n'), error })
      yield { type: 'summary', taskId, text: message, state: 'external_pending', error, time: Date.now() }
      return
    }

    const { state: taskState, failed, stopped } = settlement
    let summaryText = ''
    /**
     * 裁决上下文（设计 §5.4）：**并入汇总轮** —— 同一轮里先裁决、再写汇总正文，不额外占一轮。
     *
     * 只在真的有观众、有会话句柄的路径上开（后台等待超时那条没有汇总轮，也就没有裁决）。
     * `finally` 里一定关掉：留在 Map 里，下一轮的模型会以为还能接着裁。
     */
    let verdict: VerdictContext | undefined
    // 汇总只在**有观众**的路径上跑：后台等待超时（路径 4）传 `summarize: false`。
    if (input.summarize && !stopped && conversation !== undefined) {
      this.openVerdictContext(conversation.id, input)
      try {
        await this.storage.setTaskState(taskId, 'summarizing')
        for await (const event of this.summarize(conversation, goal, subtasks, reports, signal, input.acceptance ?? '')) {
          const inner = summaryTextOf(event)
          if (inner !== null) summaryText = inner
          else yield event as ButlerEvent
        }
      } finally {
        verdict = this.closeVerdictContext(conversation.id)
      }
    }
    /**
     * 有 `rework` / `replace` ⇒ **不写汇总正文**，先按设计 §5.4 第 2 步**追加尝试、回调度**。
     *
     * 那一轮正文是按"都成了"写出来的，写下去会把"还要重做"盖掉。追加成功时这一轮**不落终态**
     * （任务回到调度中，新尝试跑完会再收尾一次）；预算用尽或没有可追加的，才按 `partial` 如实
     * 收尾 —— 那两种情况都说明"要重做但做不了"，而不是"已经重做了"。
     */
    /**
     * ⚠️ **模型完全不调 `butler_verdict` 时的守卫。**
     *
     * 工具内部那道"漏裁拒绝整批"只在**模型调了工具**时生效；一条都不裁时 `decisions` 为空、
     * 下面的 `rework` 也就是空 ⇒ 会像"全部通过"一样照写汇总正文、落 `completed`，而库里四列
     * 全空、页面不显示、汇总材料也不提——**没有任何"这一轮没裁决过"的痕迹**（静默）。而设计
     * §5.4 的流程约定是"同一轮里先调 `butler_verdict` 再写汇总"，代码里没有对应守卫。
     *
     * 所以这里显式判：**清单非空**（确实有待裁决的步骤）**却一条都没裁** ⇒ 不冒充"全通过"。
     */
    const undecided = verdict !== undefined && verdict.open.length > 0 && verdict.decisions.length === 0
    const rework = (verdict?.decisions ?? []).filter(item => item.verdict === 'rework' || item.verdict === 'replace')
    if (rework.length > 0) {
      const retried = yield* this.applyReworkAttempts({
        input, decisions: rework, problems: verdict?.problems ?? [],
      })
      if (retried) return
      const problems = verdict?.problems ?? []
      const detail = problems.length === 0 ? '' : `（${problems.join('；')}）`
      const message = `有 ${rework.length} 个步骤被裁决为要重做，但重做预算已经用尽，这一轮先不出汇总。${detail}`
      // 与汇总路径同一道版本屏障：这中间进来的补充会让这份结论作废。
      if (!(await this.storage.commitTaskState(taskId, 'partial', { summary: message, error: '' }))) {
        await this.storage.setTaskState(taskId, 'running')
        yield {
          type: 'chat', role: 'butler',
          text: '老大又补了一句，刚那份结论先当草稿 —— 等新的说法处理完再给你结论。',
          time: Date.now(),
        }
        return
      }
      yield { type: 'summary', taskId, text: message, state: 'partial', error: '', time: Date.now() }
      return
    }
    if (summaryText === '') {
      summaryText = reports.length === 0 ? '这次没有拿到可用的子任务结果。' : reports.join('\n\n')
    }
    // 后台等待超时那条路径用固定的超时说明（`settleErrorOverride`）：它的结论对用户来说是
    // "没人回话所以停了"，而不是"N 个子任务失败"。其余路径照旧按失败数拼。
    //
    // §5.2 第二条消费点：口径非空但整条任务一份材料都没有 ⇒ **如实写进这一轮的说明**。
    // 它是"没交回口径要的东西"，与"N 个子任务失败"是两件事，所以两句并列而不是互相覆盖。
    const acceptanceFinding = taskAcceptanceFinding({
      acceptance: input.acceptance,
      artifacts: subtasks.flatMap(item => item.artifacts ?? []),
    })
    const error = input.settleErrorOverride
      ?? [
        failed === 0 ? '' : `${failed} 个子任务失败`,
        acceptanceFinding.detail,
      ].filter(text => text !== '').join('；')
    /**
     * "这一轮没有裁决"如实落进说明（见上面 `undecided` 的定义）。
     *
     * **只在说明里写，不改终态** —— 评审给了两个选项（"不落 `completed`"或"至少记进说明"），
     * 主线选后者，理由有两条：
     *
     * 1. `completed` / `failed` / `cancelled` / `partial` 描述的是**子任务的结果**
     *    （`decideSettlement` 的四条规则），而"这一轮没有裁决"是**流程缺失**、不是任务质量
     *    问题 —— 拿 `partial` 去盖会把两类不同的事混为一谈（§5.4 对 `unverified` 也正是同一
     *    口径："不进终态"）。
     * 2. 它写进 `error` 之后**任务详情与汇总材料都看得到**，而升成 `partial` 会让 9 条与本主题
     *    无关的既有用例（走汇总轮但不调裁决工具）一起变红 —— 那不是修复，那是把流程缺失的代价
     *    转嫁给所有旧路径。
     *
     * 若将来要让"没裁决"真的影响终态，应当先定义它在 §5.4 里的位置（它今天没有位置）。
     */
    const undecidedNote = `这一轮没有裁决：有 ${verdict?.open.length ?? 0} 个步骤等待裁决，但一条结论都没有拿到`
    const finalError = undecided ? [error, undecidedNote].filter(text => text !== '').join('；') : error
    /**
     * 汇总跑完再核一次输入版本，而且**核对与写入在同一个事务里**。
     *
     * 开头那道屏障只挡得住「开始汇总时就已经有未处理输入」的情况。汇总这一轮本身是异步的，
     * 正好在它跑的这段时间里进来的补充，只能在这里拦下来 —— 那份结论是按**旧范围**总结的，
     * 写下去就等于用旧结论盖住新目标，还把任务报成完成。
     */
    if (!(await this.storage.commitTaskState(taskId, taskState, { summary: summaryText, error: finalError }))) {
      // 结论作废，但它已经边流边出现在页面上了：如实说明它只是草稿，不冒充最终答复。
      await this.storage.setTaskState(taskId, 'running')
      yield {
        type: 'chat', role: 'butler',
        text: '老大又补了一句，刚那份结论先当草稿 —— 等新的说法处理完再给你结论。',
        time: Date.now(),
      }
      return
    }
    yield { type: 'summary', taskId, text: summaryText, state: taskState, error: finalError, time: Date.now() }
  }

  /**
   * 按裁决**追加尝试并回调度**（设计 §5.4 第 2 步）。
   *
   * 返回 `true` 表示"已经重新派出去了、这一轮不该再落终态"（新尝试跑完之后会**再收尾一次**）；
   * 返回 `false` 表示没有可追加的（预算用尽 / 没有匹配的步骤）—— 调用方按 `partial` 如实收尾。
   *
   * 三件事的顺序不能换：**先写库、再派单、最后排空队列**。写库在派单之前，是因为派单会
   * 立刻驱动成员干活，而"这一步存在"必须以库里的记录为准（`drainQueue` 内部保持同一顺序）。
   * 排空队列在最后，是因为新尝试可能让排队的下游重新就绪（依赖重判方案 §3.2）。
   */
  private async *applyReworkAttempts(input: {
    readonly input: SettleTaskInput
    readonly decisions: VerdictContext['decisions']
    readonly problems: readonly string[]
  }): AsyncGenerator<ButlerEvent, boolean> {
    const { taskId, actor, goal, signal } = input.input
    // ⚠️ 预算与 id 编号都取**全部历史尝试**（未去重）：`input.input.subtasks` 是
    // `effectiveSubtasks()` 之后的集合，被替代的旧尝试不在里面 ⇒ 用它统计会让"同一目标已有
    // 2 条尝试"缩成 1 条 ⇒ 预算永不耗尽、id 与历史撞车（实测：UNIQUE 约束失败、整轮中断）。
    const raw = await this.storage.task(actor, taskId)
    const allAttempts = raw?.subtasks ?? []
    const plan = planReworkAttempts({
      decided: input.decisions,
      subtasks: input.input.subtasks,
      allSubtasks: allAttempts,
      baseCount: allAttempts.length,
    })
    if (plan.appended.length === 0) return false
    const appended: {
      id: string
      goal: string
      agentId: string
      reason: string
      displayName: string
      acceptance?: string
      logicalId: string
      supersedes: string
    }[] = []
    for (const item of plan.appended) {
      appended.push({
        id: item.id,
        goal: item.goal,
        agentId: item.agentId,
        logicalId: item.logicalId,
        supersedes: item.supersedes,
        // ⚠️ 条件展开而不是 `acceptance: item.acceptance`：本仓开着
        // `exactOptionalPropertyTypes`，显式 `undefined` 与"没有这个字段"是两回事。
        ...(item.acceptance === undefined ? {} : { acceptance: item.acceptance }),
        reason: '裁决要求重做',
        displayName: await this.displayNameOf(actor, item.agentId),
      })
    }
    await this.storage.appendSubtasks(actor, taskId, appended)
    yield { type: 'plan', taskId, goal, note: '裁决要求重做：已经追加新的尝试并重新派出。', subtasks: appended, time: Date.now() }
    for (const item of appended) {
      if (signal.aborted) break
      yield* this.dispatchSubtask({
        taskId, subtaskId: item.id, goal: item.goal, agentId: item.agentId,
        displayName: item.displayName, taskGoal: goal, actor, signal,
        ...(item.acceptance === undefined ? {} : { acceptance: item.acceptance }),
        // `supersedes` 与 `reworkOf` 同源：都取被替代的那条尝试（见 `dispatchSubtask` 的说明）。
        reworkOf: item.supersedes,
      })
    }
    yield* this.drainQueue({ taskId, actor, goal, signal })
    if (signal.aborted) return true
    const after = await this.storage.task(actor, taskId)
    if (after === undefined) return true
    // 新尝试已经跑完（`dispatchSubtask` 会等到成员交回结论）⇒ 按同一张表**再收尾一次**。
    // 递归有界：每次追加都让该 `logicalId` 的尝试数 +1，`MAX_ATTEMPTS_PER_LOGICAL` 是硬上限；
    // 再被裁 `rework` 时 `planReworkAttempts` 会说"预算用尽"，这一轮就按 `partial` 收尾。
    yield* this.settleTask({
      ...input.input,
      subtasks: await this.storedSubtasks(actor, taskId, []),
      reports: await this.storedReports(actor, taskId),
    })
    return true
  }

  /**
   * 有观众的收尾：派活轮、补充轮、补话之后三条路径共用（判据 R8 的"正常路径"走的就是这里）。
   *
   * 它只是 {@link settleTask} 的一层薄包装 —— `summarize: true` 是这三条路径唯一的共同点，
   * 其余差异（会话句柄拿不到、被喊停）由 `settleTask` 按参数处理。
   *
   * ⚠️ **不要再往这个包装里加逻辑**：收尾只有一处实现，包装里多一行就等于多一条"只在部分
   * 路径上生效"的分支 —— 那正是合并要消掉的东西。后台路径（等待超时）直接调 `settleTask`。
   */
  private async *closeTask(input: Omit<SettleTaskInput, 'summarize'>): AsyncGenerator<ButlerEvent> {
    yield* this.settleTask({ ...input, summarize: true })
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
      // 取一批互不依赖候选里的**不同成员**步骤并发派出：计划工具鼓励把独立的事拆成并列
      // 步骤，串行派发会让它们排队（每步最坏一个执行超时），成员一多吞吐先崩在这里。
      // 同一成员每批只取一个（保守：执行方有自己的会话互斥，没必要让同成员多轮并发）。
      const batch: SubtaskRecord[] = []
      const seenAgents = new Set<string>()
      for (const item of record.subtasks) {
        if (item.state !== 'queued' || suspended.has(item.id)) continue
        if (seenAgents.has(item.agentId)) continue
        batch.push(item)
        seenAgents.add(item.agentId)
      }
      if (batch.length === 0) return
      if (input.signal.aborted) return
      const merged = new MergedEvents<ButlerEvent>()
      for (const item of batch) {
        merged.open()
        void (async () => {
          try {
            for await (const event of this.dispatchSubtask({
              taskId: input.taskId, subtaskId: item.id, goal: item.goal, agentId: item.agentId,
              displayName: await this.displayNameOf(input.actor, item.agentId), taskGoal: input.goal,
              actor: input.actor, signal: input.signal,
              // 从库里读回来的口径：进程重启后补派这一步时仍要带上（空串 = 这一步没有口径）。
              ...(item.acceptance === '' ? {} : { acceptance: item.acceptance }),
              // 重做溯源同样从库里读回（重启后补派这一步时也要带）。
              ...(item.supersedes === '' ? {} : { reworkOf: item.supersedes }),
              ...(item.dependsOn.length === 0 ? {} : { dependsOn: item.dependsOn }),
              ...(item.requiresExternalAction ? { requiresExternalAction: true } : {}),
            })) {
              merged.push(event)
            }
          } catch (error) {
            merged.fail(error)
          } finally {
            merged.close()
          }
        })()
      }
      yield* merged.drain()
      const after = (await this.storage.task(input.actor, input.taskId))?.subtasks ?? []
      let settledAny = false
      for (const item of batch) {
        const state = after.find(entry => entry.id === item.id)?.state
        // 派完仍排队中：前置仍未就绪，如实挂起，继续核验排在后面的。
        if (state === 'queued') suspended.add(item.id)
        else if (state !== undefined) settledAny = true
      }
      // 有步骤真的结账（派出或判失败）：挂起中的那些前置可能因此就绪，全部重新核验一轮。
      // 结账最多发生排队项数那么多次，循环必然收敛。
      if (settledAny) suspended.clear()
    }
  }

  /**
   * 一位成员的那一轮**了结之后**：先重判依赖，再按需收尾。
   *
   * 三条路径共用：用户补了话、用户在卡片上办了确认/撤回、以及等待超时后的后台收尾（那条走
   * `settleTask`，不经过这里）。
   *
   * ## 为什么"用户办了确认"也要走这里（2026-09-18 生产事故）
   *
   * 之前只有"补话"和"上游失败"两条路会重判依赖。于是"上游还在等你确认"时排队/被判死的下游，
   * 在你**点掉那张卡之后**没有人回头看它们 —— 一次「删六篇草稿」的活，点掉第一张，剩下五张永远
   * 停在失败。确认办理同样会让上游结账，那就同样得把依赖传导下去。
   *
   * 让位规则只对**确认办理**这一条路径生效（`deferToBusyTurn`）：它会话上可能正有回话或补充在
   * 执行，那种情况让那一轮自己的收尾去排空队列 —— 两条路径同时派同一步会把它派两遍。
   * 回话/补充这两条路径本身就是"说完话之后排空队列"的那一环，**不判断让位**：它们此刻的占用者
   * 就是自己，把自己当成"别人在跑"会让队列永远不动（写这条时踩过一次，队列卡住的用例当场变红）。
   */
  private async *settleAfterTurn(prepared: {
    readonly taskId: string
    readonly actor: Actor
    readonly conversationId: string
    readonly abort: AbortController
  }, options: { readonly deferToBusyTurn?: boolean } = {}): AsyncGenerator<ButlerEvent> {
    const before = await this.storage.task(prepared.actor, prepared.taskId)
    if (before === undefined) return
    const holder = this.claims.get(prepared.conversationId)
    const defer = options.deferToBusyTurn === true && (holder?.kind === 'reply' || holder?.kind === 'supplement')
    if (!defer) {
      // 有人回完话、或者刚办完一条确认之后，之前「前置还没终结」而留在队列里的步骤可能就绪了。
      yield* this.drainQueue({
        taskId: before.id, actor: prepared.actor, goal: before.goal, signal: prepared.abort.signal,
      })
    }
    const record = await this.storage.task(prepared.actor, prepared.taskId)
    if (record === undefined) return
    if (record.subtasks.some(item => !isTerminal(item.state))) return
    // 只看有效尝试：被替代掉的旧尝试不该参与这一轮的结论。
    const effective = effectiveSubtasks(record.subtasks)
    yield* this.closeTask({
      taskId: record.id,
      actor: prepared.actor,
      conversation: this.conversations.get(prepared.conversationId),
      goal: record.goal,
      subtasks: effective.map(item => ({
        id: item.id, goal: item.goal, agentId: item.agentId, state: item.state,
        // 与派活路径同一个口径：裁决要用的结果正文、协作原文、自检结论与已有裁决都带上。
        acceptance: item.acceptance,
        artifacts: item.artifacts,
        result: item.result,
        memberReturnText: item.memberReturn?.text ?? '',
        selfCheck: item.memberReturn?.selfCheck,
        verdict: item.verdict,
      })),
      ...(record.acceptance === '' ? {} : { acceptance: record.acceptance }),
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
    /** 任务级验收口径；没有声明时传空串（§5.2 第一条消费点）。 */
    acceptance: string,
  ): AsyncGenerator<ButlerInnerEvent, void> {
    const lines = subtasks.map((subtask, index) => `- 子任务「${subtask.goal}」由 ${subtask.agentId} 完成，结果：\n${reports[index] ?? '（没有结果）'}`)
    /**
     * §5.2 第一条消费点：**任务级验收口径要进汇总提示词**。
     *
     * 在这之前它是"只写不读"的字段（盘点 §5.3 实测编排层零消费）：模型拿不到老板当初写下的
     * 口径，只能凭"这几个成员都返回了"自己猜算不算完成。带上它之后，汇总正文是对着口径写的，
     * 而不是对着"都返回了"写的 —— 口径要的东西没交回来时，这一轮才可能自己说出来。
     */
    const acceptanceLines = acceptance.trim() === '' ? [] : [
      '',
      '# 这次任务的验收口径（老板写下的「交回什么才算完成」）',
      '',
      acceptance.trim(),
      '',
      '写汇总时对着它回答：口径要的东西有没有交回来、缺什么。**不要**在正文里复述这段指令。',
    ]
    /**
     * 待裁决清单（设计 §5.4）：**同一轮里先裁决、再写汇总**。
     *
     * 清单只列"已终结且还没裁决过"的步骤。没有清单时（都裁过了、或这一轮本来就没有可裁的），
     * 这一整段都不出现 —— 模型也就没有理由去调 `butler_verdict`（真调了会被明确拒绝）。
     */
    const verdictContext = this.verdictContexts.get(conversation.id)
    const verdictLines = verdictContext === undefined || verdictContext.open.length === 0 ? [] : [
      '',
      '# 待裁决清单（**先裁决，再写汇总**）',
      '',
      '下面每一步都已经结束。**先调用 `butler_verdict` 把清单里的每一步都给出结论**，然后再写汇总正文。',
      '清单里任何一步漏掉，你的整条回复都会被拒绝 —— 所以先裁完、再写。',
      '',
      '怎么裁：产出对得上这一步的目标、可以采纳 ⇒ `accept`，并附上**在该步结果里原样出现**的一小段证据（核验不过会降级成"未核验"）；该由同一位成员再做一次 ⇒ `rework`；该换一位成员重做 ⇒ `replace`（要给 `newAgentId`）。',
      '结果里写明「用户已在确认卡上点了『确认』/『先不办』」的步骤：那是老板亲自做的决定，一律 `accept`，附上那句话作证据；点了「先不办」的更不要 `rework` —— 老板的"不要"就是结论。',
      '',
      ...verdictContext.open.map(item => [
        `- \`${item.id}\`（${item.agentId}）目标：${item.goal}`,
        `  结果：${clip(item.result, 400) === '' ? '（没有结果）' : clip(item.result, 400)}`,
        `  成员自检：${selfCheckLabel(item.selfCheck)}`,
      ].join('\n')),
    ]
    const prompt = [
      `${SUMMARY_PROMPT_GOAL}${goal}`,
      `${SUMMARY_PROMPT_RESULTS}：`,
      ...lines,
      ...verdictLines,
      ...acceptanceLines,
      verdictLines.length === 0
        ? '请基于这些结果给出最终回答，直接回答我的目标，不要重复子任务清单，也不要提到这份指令。'
        : '裁完之后，再基于这些结果给出最终回答：直接回答我的目标，不要重复子任务清单，也不要提到这份指令。',
    ].join('\n')
    const speech = progressQueue()
    const summaryTurn = this.runTurn(conversation, prompt, signal, {
      onDelta: delta => speech.push({ type: 'chat_delta', role: 'butler', text: delta, time: Date.now() }),
      onReset: () => speech.push({ type: 'chat_reset', time: Date.now() }),
      onThinking: thinking => speech.push({ type: 'chat_thinking', role: 'butler', thinking, time: Date.now() }),
    })
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

export { clip, digestOf, subtaskResultText, textOf } from './butler/text.ts'
export { describeThrown, stackOf, visibleError } from './butler/errors.ts'
export { ACCEPTANCE_EMPTY_WORDS, ACCEPTANCE_LOCATOR, ACCEPTANCE_MIN_CHARS, ACCEPTANCE_NOUN, ACCEPTANCE_QUANTITY, acceptanceOf, requireAcceptance, taskAcceptanceFinding } from './butler/acceptance.ts'
export { ATTACHMENT_SECTION_TITLE, DISPATCH_MESSAGE_LIMIT, briefFor, claimedByOthers, dispatchBrief, effectiveSubtasks, memberReturnOf, ownPendingActions, supplementPrompt } from './butler/dispatch-brief.ts'
export { REPLAY_REJECTED_PREFIX, dispatchFailureDetail, isReplayRejection, selfCheckLabel, verdictDecisionFor, verdictEvidenceFound } from './butler/verdict.ts'
export type { SettleTaskInput, Settlement, VerdictContext, VerdictDecision } from './butler/verdict.ts'
export { MAX_ATTEMPTS_PER_LOGICAL, planReworkAttempts, reportOf } from './butler/planning.ts'
export type { ReworkAttemptPlan } from './butler/planning.ts'
export { SUMMARY_PROMPT_GOAL, SUMMARY_PROMPT_RESULTS, THINKING_TAIL, TRANSCRIPT_LEAD_EVENTS, TRANSCRIPT_SCAN_CHUNK, WAITING_EXPIRED, WAITING_EXPIRED_TASK, WAITING_STOPPED, WAITING_STOPPED_TASK, progressQueue, summaryTextOf, thinkingSnapshot } from './butler/speech.ts'
export type { Conversation, PlanSubmission, PlannedSubtask, PreparedAction, PreparedReply, PreparedSupplement, PreparedTurn, RunHooks, SubtaskOutcome, Turn, TurnOutcome, WaitingMember } from './butler/domain.ts'
