/**
 * 会话生命周期：把 closedoff 与管家各写一套的机制收敛成一份实现。
 *
 * 逐条同构的机制（括号内是两个既有实现的位置）：
 *
 * - 活跃会话表（`closedoff/src/agent.ts:36` ↔ 管家的 `conversations` Map）
 * - 并发打开的合并（`agent.ts:255-267` ↔ 管家的 `openings`）
 * - 预留 + 发布两段握手（`agent.ts` 的 `store.reserve` → `agents.create` → `store.publish`）
 * - 同会话互斥（`agent.ts:111-124` 的 `retainTurn` ↔ 管家的 `claimNow`/`releaseClaim`）
 * - LRU 驱逐、中止、授权重核、分支
 *
 * ⚠️ 管家的"谁在跑"是**纯内存 Map + runId 释放凭据**（它自己的注释写着"执行已经不再挂在
 * 某条 HTTP 连接上，所以「谁在跑」必须自己记"）——那是一个**机制**，不是存储问题。早期方案
 * 把一个机制和一个存储捆在一起、用后者否掉前者，是错的。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import {
  AccessError,
  conversationModel,
  registerConversationTitles,
  type Access,
  type Actor,
  type ConversationModel,
} from '@dsh-plugin-manager/plugin-kit'
import { conversationModelCatalog, requestedConversationModel, selectConversationModel } from '@dsh-plugin-manager/plugin-kit/models'
import type { AgentDefinition, TurnHistory, TurnMessage, TurnOutcome } from './definition.ts'
import type { AgentStoragePort, ConversationPageShape, ConversationPort, ConversationQueryShape, OwnerKey } from './storage/ports.ts'

/**
 * 各 Agent 的会话前缀。**不可改。**
 *
 * `dsh_conversations.id` **就是宿主 session id**，而三个既有前缀被硬约束绑定：
 *
 * - `blog-chat-`：`backup/chat-state.mjs` 与 `backup/executor.py` 的正则
 *   `^blog-chat-[a-f0-9-]{36}$`——**备份与恢复会拒绝任何其他形状**；
 * - `closedoff-web-`：`closedoff/src/agent.ts:18` 的 `^closedoff-web-<v4 UUID>$`；
 * - `butler-web-`：管家页面的会话前缀。
 *
 * 新 Agent 用 `<agentId>-` 作为前缀，即"按 `agent_id` 参数化的前缀 + v4 UUID"。
 * 改既有前缀要等备份正则与页面入口一并升级——那是独立的一次动作，不在本次范围内。
 */
const CONVERSATION_PREFIX: Readonly<Record<string, string>> = {
  butler: 'butler-web-',
  blog: 'blog-chat-',
  closedoff: 'closedoff-web-',
}

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** 这个 Agent 的会话前缀。 */
export function conversationPrefix(agentId: string): string {
  return CONVERSATION_PREFIX[agentId] ?? `${agentId}-`
}

/** 按格式契约铸一个新的会话 id。 */
export function newConversationId(agentId: string): string {
  return `${conversationPrefix(agentId)}${randomUUID()}`
}

/** 校验一个外部传入的 id 是否属于这个 Agent（浏览器可以传 id，必须挡住别的会话）。 */
export function isConversationIdFor(agentId: string, value: string): boolean {
  const prefix = conversationPrefix(agentId)
  return value.startsWith(prefix) && V4.test(value.slice(prefix.length))
}

/** 一个由本插件持有句柄的活跃业务会话。 */
export interface Conversation {
  readonly id: string
  readonly handle: AgentHandle
  lastUsedAt: number
  active: boolean
}

interface PendingTurn {
  pending: boolean
  dispatching: boolean
  cancelled: boolean
  /**
   * 回合被要求结束时记下的**通知参数**——**不是布尔**。
   *
   * ⚠️ 存参数而不是 `true`：这条路径是"回合还没注入完就被要求结束"，`finish` 会**提前返回**，真正的
   * 通知发生在随后的 `followup` 收尾里（`if (turn.finishRequested) this.finish(...)`）。若那里用
   * 缺省值，调用方明确要求的 `notify: false`（"只是为注入下一轮释放占用"）就被丢掉，业务会收到一次
   * **假的**"回合结束"。实测抓到过：补交轮注入之后多出一条 `completed`。
   */
  finishRequested: false | { readonly outcome: TurnOutcome; readonly notify: boolean }
  /**
   * **已经在飞的收尾**（`whenIdle()` 回调已登记、还没跑）：记下这一次要用的通知参数。
   *
   * ⚠️ 为什么必须有它：同一个回合上 `finish` 会被调用**多次**（协作入口 `cleanup()` 里先
   * `releaseTurn()` 再 `lifecycle.finish(id, outcome)`；补交轮之间还有一次"释放占用"）。若每次都各
   * 登记一个 `whenIdle()` 回调，**谁先登记谁的回调先跑**，而它删掉回合之后，后面那些回调全被
   * `turns.get(conversation) !== turn` 守卫挡掉 ⇒ 通知的**次数与结论都由登记顺序决定**。
   * 而先登记的往往**不是**知道结论的那一个（释放凭据只知道"我放开了"，不知道这一轮成功还是失败）。
   * 实测抓到过两次：补交轮收到**两条** `completed`；失败回合收到 `completed`。
   *
   * 合并成一条在飞记录、**后到的调用更新它**（后到的信息更完整），通知就只发一次、且发的是最终结论。
   */
  finishInFlight?: { outcome: TurnOutcome; notify: boolean }
}

/** 运行时可注入的配置。 */
export interface RuntimeConfig {
  readonly routePrefix: string
  readonly turnTimeoutMs: number
  readonly authRecheckMs: number
  readonly maxActiveConversations: number
  /** 首选 reasoning effort；宿主不认这个值时回落到按会话选择的结果。 */
  readonly reasoningEffort: string
  /**
   * 进程内幂等缓存的上界（条），缺省 256。
   *
   * 它是内存优化，**不是**持久化保证 —— 重启后的幂等由 `dsh_turns` 承担（见 `TurnStorePort`）。
   * 做成可配是为了让"淘汰确实发生"能被测试直接验到，而不必跑几百轮。
   */
  readonly settledCacheMax?: number
}

/**
 * 标题写入的投递口。
 *
 * `registerConversationTitles` 的回调是**同步**的（`conversations.ts:36`），而标题最终要落 PG
 * （异步）。所以回调里只投递，后台按会话 FIFO 落库。
 *
 * ⚠️ **必须是持久队列**：内存队列会在崩溃或插件卸载时丢标题——丢的是一条"这个会话该叫什么"
 * 的指令，而它不可重建（宿主不会再发一次同一条事件）。
 *
 * **已经落地**：实现是 `storage/index.ts` 的 `AgentDatabaseFacade.titleSink()`，底层是
 * `storage/local.ts` 的 `title_outbox` 表（与删除围栏共用同一套"本地留下、后台补写"的机制，
 * 同一会话连续更新只留最后一条）。挂载时用 `installTitleSink(db.titleSink())` 接上。
 */
export interface TitleSink {
  /** 同步投递：把一次标题更新交出去，调用方不等待落库。 */
  submit(agentId: string, conversationId: string, title: string, source: 'automatic' | 'generated' | 'manual'): void
}

let titleSink: TitleSink | undefined

/** 由插件在挂载时注入标题投递口；未注入时标题更新被丢弃（不影响主链路）。 */
export function installTitleSink(sink: TitleSink | undefined): void {
  titleSink = sink
}

/** 会话生命周期需要的那部分运行时。 */
export interface LifecycleHost {
  readonly ctx: Context
  readonly definition: AgentDefinition
  readonly access: Access
  readonly store: ConversationPort
  readonly config: RuntimeConfig
  /**
   * 业务自己的存储门面；只用于喂给回合钩子（`onTurnStart` / `onTurnFinish`）。
   *
   * 可选：不注入时钩子拿到 `undefined`（它们本来就要处理这种情形，见 `AgentToolContext.storage`
   * 的同一约定）。会话机制本身**不用**它——会话走 `store`。
   */
  readonly storage?: AgentStoragePort | undefined
  /** 这个 Agent 能用的工具名（本分类 + 通用集），在 agent 作用域内应用。 */
  readonly allowedTools: () => readonly string[]
}

/**
 * 协作入口与页面入口共用的那部分运行时能力。
 *
 * 它**不暴露存储的内部结构**：业务要么用 `definition` 的钩子，要么用 `storage` 端口。
 */
export interface AgentRuntime {
  readonly ctx: Context
  readonly definition: AgentDefinition
  readonly access: Access
  readonly store: ConversationPort
  readonly config: RuntimeConfig
  /** 会话生命周期；协作入口与页面入口共用同一份。 */
  readonly lifecycle: ConversationLifecycle
  /** 这个 Agent 能用的工具名（本分类 + 通用集），在 agent 作用域内应用。 */
  readonly allowedTools: () => readonly string[]
}

/**
 * 会话生命周期的唯一实现。
 *
 * 状态（谁在跑、谁打开了、谁在分支中）全在内存：DSH 的会话事件是持久真相，这里只记
 * **运行期占用**。`retainTurn` 返回释放凭据，调用方必须在结束时调用它。
 */
export class ConversationLifecycle {
  private readonly conversations = new Map<string, Conversation>()
  private readonly openings = new Map<string, Promise<Conversation | undefined>>()
  /**
   * 派生寻址的在飞打开（键 = `missionRequestId(owner, missionId)`，见 {@link openByMission}）。
   *
   * **不能复用 `openings`**：那张表按**会话 id** 分桶，而派生的两次调用各自铸一个 id ⇒ 两个键
   * 不同，合并不了。两张表的键不同源，所以是两个 Map，不是一张。
   */
  private readonly missionOpenings = new Map<string, Promise<Conversation | undefined>>()
  private readonly forks = new Set<string>()
  private readonly heldTurns = new Map<string, { turn?: PendingTurn }>()
  private readonly turns = new WeakMap<Conversation, PendingTurn>()
  private readonly initialModels = new WeakMap<Conversation, ConversationModel>()
  /**
   * 每个会话**这一轮**的动态上下文文本（`AgentDefinition.turnContext` 的返回值）。
   *
   * 宿主**每次装配**都来读它（注册进去的是一个 provider），所以它必须在**注入消息之前**更新到位：
   * 否则模型看到的是上一次那一份（"资料过期"这种失效在界面上完全看不出来）。键是会话 id；
   * 会话被 LRU 驱逐或释放时一并清掉，不留无主快照。
   */
  private readonly turnContexts = new Map<string, string>()
  private pendingOpens = 0
  private disposed = false
  private readonly identities = new WeakMap<object, Actor>()
  private readonly stopTitles: () => void

  constructor(private readonly host: LifecycleHost) {
    this.stopTitles = registerConversationTitles(host.ctx, (id, title, manual, complete) => {
      if (this.disposed) return
      // 同步回调不能 await：投递给持久队列，后台按会话 FIFO 落库（见 TitleSink）。
      titleSink?.submit(host.definition.id, id, title, manual ? 'manual' : complete ? 'generated' : 'automatic')
    })
  }

  /** 这个实例是否已停止。 */
  get stopped(): boolean { return this.disposed }

  private ownerOf(actor: Actor): OwnerKey {
    return { namespace: actor.namespace, userId: actor.userId }
  }

  /** 某个会话此刻是否被本实例占用（活跃、正在打开或正在分支）。 */
  isBusy(id: string): boolean {
    return this.conversations.get(id)?.active === true || this.openings.has(id) || this.forks.has(id)
  }

  /**
   * 本实例此刻占用的全部会话 id。
   *
   * 侧栏 `list` 的 `busy` 集合要带上它们（adapter 装配时用 `localBusyIds` 传进去），
   * 与 {@link isBusy} **同源**：活跃、正在打开、正在分支三者都算——两处各算一遍迟早会漂移。
   */
  busyIds(): readonly string[] {
    return [...new Set([...this.conversations.keys(), ...this.openings.keys(), ...this.forks])].filter(id => this.isBusy(id))
  }

  /**
   * 侧栏列表的**机制部分**：算本地占用集合，交给存储端口去查。
   *
   * 宿主侧的忙集合与归档清单由调用方传进来——那两个来自 kit
   * （`hostBusyConversationIds` / `conversationArchive`），而本文件不碰 kit 的会话契约
   * （唯一接触点是 `storage/adapter.ts`）。`busy` 必须**同步**可判：它是移除围栏的一部分
   * （`conversationRemover` 的 `busy(id)` 一旦返回 `Promise` 就恒真，移除会永远报 409）。
   *
   * 本地的忙集合走 {@link busyIds}，与 `isBusy` **同源**——两处各算一遍迟早会漂移。
   */
  async list(actor: Actor, query: ConversationQueryShape,
    scope: { readonly hostBusy: readonly string[]; readonly archived: readonly string[] }): Promise<ConversationPageShape> {
    this.host.access.assert(actor)
    return this.host.store.list(this.ownerOf(actor), query, {
      busy: [...new Set([...scope.hostBusy, ...this.busyIds()])],
      archived: scope.archived,
    })
  }

  /**
   * 把一段会话事件投影成预览消息（供 adapter 装配侧栏的 `preview` 用）。
   *
   * 缺省实现只取用户与助手的正文：**宁可少显示，也不替业务编一份它没要求的预览**；
   * 业务有自己的展示口径时用 `definition.projectHistory` 覆盖。
   *
   * ⚠️ **侧栏入口（kit 的 `ConversationProvider`）刻意不在这个类里。**
   * `conversationRemover` 内部持有一个 `removing: Set<string>`（`conversations.ts:120`），
   * 那是"移除时序"的**进程内互斥**。装配两处就有两个集合，同一会话经两条路径并发移除时
   * 两道闸互相看不见——直接违反「状态、锁和恢复规则只有一个实现」（根 `AGENTS.md`）。
   * 所以唯一装配点是 `storage/adapter.ts` 的 `createConversationProvider`，本类只提供
   * 它需要的**预览投影**。
   */
  previewOf(events: readonly SessionEvent[]): readonly { role: 'user' | 'assistant'; text: string; reasoning?: string; time: number }[] {
    const custom = this.host.definition.projectHistory
    if (custom) return custom(events)
    return previewMessages(events)
  }

  /** 铸一个新的会话 id（带本 Agent 的前缀）。 */
  createId(): string {
    return newConversationId(this.host.definition.id)
  }

  /** 校验外部传入的 id 不能指向别的 DSH 会话。 */
  validateId(value: string): string {
    if (!isConversationIdFor(this.host.definition.id, value)) {
      throw new AccessError(400, `conversationId is not a ${this.host.definition.id} business session id`)
    }
    return value
  }

  /**
   * 把这次派活的 `missionId` 派生成**创建幂等键**；本 Agent 不走派生寻址时返回 `undefined`。
   *
   * 返回 `undefined` 的两条路都必须**如实退化**（不派生、也不核验），**不能编一个键**：编出来的键
   * 会建出一条谁也找不到的会话，而调用方手里那个 id 还是"对"的——那是最难查的一类漂移。
   * - `conversationAddressing !== 'derived'`：这条统一只对 blog 成立（见 `definition.ts` 字段注释）；
   * - `missionId` 为空 / 缺省：协调方没给任务身份，就没有可派生的东西。
   */
  private missionKeyOf(actor: Actor, missionId: string | undefined): string | undefined {
    if (this.host.definition.conversationAddressing !== 'derived') return undefined
    if (missionId === undefined || missionId === '') return undefined
    return this.host.store.missionRequestId(this.ownerOf(actor), missionId)
  }

  /**
   * 协作调用前的归属与可见性复核。
   *
   * 与 `closedoff/src/conversation-store.ts:63` 的 `assertOwner` 同一套判定：**不泄露存在性**
   * ——未知、他人、未发布（`ready = false`）、已删除、删除中，都返回同一个 404。
   */
  assertConversation(id: string, actor: Actor): void {
    if (this.disposed) throw new AccessError(503, '插件正在停止')
    this.host.access.assert(actor)
    const row = this.host.store.record(actor, this.validateId(id))
    if (row.ready !== true || row.deletedAt !== null || row.removalState !== '') {
      throw new AccessError(404, '会话不存在或无权访问')
    }
  }

  /**
   * 派生寻址的**交叉核验**：调用方给的会话必须真的就是这个 mission 的会话。
   *
   * 为什么需要它：派生寻址把"同一 mission 只有一条会话"的保证落在**创建**上，而续问（`reply`）带
   * 的是协调方自己存的 `conversationId`。两个 mission 的会话被张冠李戴时（协调方串了引用、或调用方
   * 自己记错），没有这道闸就会**静默**把 A 任务的会话当成 B 任务的继续问下去——用户看到的是另一个
   * 任务的上下文，两边却都不报错。
   *
   * ⚠️ **只在能证伪时拒绝**（`missionKey` 为空时整段不跑，见 `missionKeyOf`）；两种情形必须放过：
   * - 这一行**不是派生建的**（`requestId` 为空：页面侧开的会话，或派生寻址之前建的）——拿它跟派生
   *   键比一定不等，但那不是"串了"，只是"这条会话没有 mission 身份"；
   * - `detail` 查不到（`assertConversation` 刚放行，理论上不该发生）——**不在这里补一次 404/403**：
   *   存在性要不要摊开由 `assertConversation` **一处**权威决定，这里再抛一次就是多开一个泄露口。
   */
  private async assertMission(actor: Actor, id: string, missionKey: string | undefined): Promise<void> {
    if (missionKey === undefined) return
    const row = await this.host.store.detail(this.ownerOf(actor), id)
    if (row === undefined || row.requestId === '') return
    if (row.requestId !== missionKey) {
      // 归属与可见性都已通过（否则上面就 404 了）：这里给出的是"存在、是你的，但不是这个任务的"。
      throw new AccessError(403, '这条会话属于另一个协作任务')
    }
  }

  /** 协作调用在宿主 whenIdle 后释放，期间沿用 active 的并发及移除围栏。 */
  retainTurn(conversation: Conversation, actor: Actor): () => void {
    this.assertCurrent(conversation, actor)
    if (conversation.active || this.heldTurns.has(conversation.id)) throw new AccessError(409, '智能体正在回答上一条问题')
    const held: { turn?: PendingTurn } = {}
    this.heldTurns.set(conversation.id, held)
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.heldTurns.get(conversation.id) !== held) return
      this.heldTurns.delete(conversation.id)
      /**
       * ⚠️ `{ notify: false }` —— **"我放开了这一轮的回合凭据"不是"这一轮结束了"**。
       *
       * 这个闭包在两种时机被调用：真正收尾时（`cleanup()` 里紧跟着一句带正确 `outcome` 的
       * `lifecycle.finish(...)`）与**为注入补交轮/自修正轮而释放占用**时（那一轮还在继续）。
       * 它两个都不知道结论，所以**不声明任何结论**；通知交给知道结论的那一次显式调用
       * （`finish` 会把意图合并到同一条在飞记录上，见 `PendingTurn.finishInFlight`）。
       *
       * 早先这里用缺省参数（`notify` 缺省 true、`outcome` 缺省 `'completed'`），实测抓到两个后果：
       * 补交轮收到**两条** `completed`；失败回合收到 `completed`。
       *
       * ⚠️ **诚实标注**：这一句**单独**变异**不会**让用例变红——同批加的意图合并已经能挡住那两个后果
       * （释放的 `notify: true` 会被紧接着的显式调用覆盖掉）。所以它与意图合并是**两道互相兜底**
       * （与 P5 收尾屏障同一形态）。保留它的理由是**语义**：让"释放凭据"在语法上就不声明结论，
       * 将来若有人只释放、不再显式收尾，也不会冒出一条假通知。
       */
      if (this.turns.get(conversation) === held.turn || !this.turns.has(conversation)) {
        this.finish(conversation.id, 'completed', { notify: false })
      }
    }
  }

  private setup(agentCtx: Context, conversationId: string): void {
    agentCtx.systemPrompt.section({
      name: `${this.host.definition.id}:persona`,
      order: 600,
      text: this.host.definition.persona,
    })
    /**
     * 每轮的**动态上下文**（`AgentDefinition.turnContext`）。
     *
     * ⚠️ 注册进去的是**provider 函数**、不是当时的文本：DSH 的 `PromptContext.text` 支持
     * "evaluated for each assembly"，所以宿主**每次装配**都回来读 `turnContexts` ⇒ 模型看到的是
     * **这一轮**的快照。这正是"长驻句柄"能承载 blog 原来"一轮一命 + 每轮 setup 注入"那条路的原因
     * （`setup` 只在打开会话时跑一次）。
     *
     * 位置取 620：宿主的策略类上下文在 110–120，业务资料性上下文排在它们之后才不会被误读成策略
     * （blog 原来那份操作快照也在 620）。
     *
     * 只有声明了 `turnContext` 的 Agent 才注册 ⇒ 对 closedoff / butler **零影响**。
     */
    if (this.host.definition.turnContext !== undefined) {
      agentCtx.systemPrompt.context({
        name: `${this.host.definition.id}:turn-context`,
        order: 620,
        text: () => this.turnContexts.get(conversationId) ?? '',
      })
    }
    // 只允许调用属于本 Agent 标签的工具，外加约定好的通用集。在 agent 作用域里限制——
    // 插件级限制会波及所有 Agent，宿主会直接拒绝。
    agentCtx.tools.restrict({ allow: [...this.host.allowedTools()] })
  }

  private async options(id?: string, eventCount?: number) {
    const { ctx, config } = this.host
    const selection = await conversationModel(ctx, id, eventCount)
    await requestedConversationModel(ctx, selection)
    const info = id ? undefined : await ctx.llm.resolveModelInfo(selection.provider, selection.model)
    const wanted = config.reasoningEffort
    const effort = info?.reasoning?.efforts.some(effort => effort.id === wanted) ? wanted : selection.reasoningEffort
    return {
      provider: selection.provider,
      model: selection.model,
      ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
    }
  }

  private publish(id: string, handle: AgentHandle, options: ConversationModel): Conversation {
    const conversation = { id, handle, lastUsedAt: Date.now(), active: false }
    this.initialModels.set(conversation, { ...options })
    this.conversations.set(id, conversation)
    return conversation
  }

  private reserveSlot(): AgentHandle | undefined {
    const limit = this.host.config.maxActiveConversations
    const occupied = this.conversations.size + this.pendingOpens
    if (occupied < limit) {
      this.pendingOpens += 1
      return undefined
    }
    const idle = [...this.conversations.values()]
      .filter(conversation => !conversation.active)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
    if (idle === undefined || occupied - 1 >= limit) {
      throw new Error(`active conversation limit ${String(limit)} reached`)
    }
    this.conversations.delete(idle.id)
    this.turnContexts.delete(idle.id)
    this.pendingOpens += 1
    return idle.handle
  }

  /** 新建路径：预留段已经在 `open()` 里写过，这里创建 Agent 并**发布**它。 */
  private async openReserved(id: string, evicted: AgentHandle | undefined, actor: Actor): Promise<Conversation | undefined> {
    const { ctx, access, store } = this.host
    let reserved = true
    try {
      await evicted?.dispose()
      access.assert(actor)
      const options = await this.options()
      access.assert(actor)
      if (this.disposed) throw new Error('conversation lifecycle is disposed')
      const handle = await ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: process.cwd() },
        agentOptions: options,
        setup: agentCtx => this.setup(agentCtx, id),
      })
      if (this.disposed) {
        await handle.dispose()
        throw new Error('conversation lifecycle is disposed')
      }
      try {
        access.assert(actor)
        // 发布段：`ready` 翻真之前这个会话在侧栏不可见、也不能发消息（`chat.mjs` 的 409 围栏）。
        await store.publish(this.ownerOf(actor), id)
      } catch (error) { await handle.dispose(); throw error }
      this.pendingOpens -= 1
      reserved = false
      return this.publish(id, handle, options)
    } finally {
      if (reserved) this.pendingOpens -= 1
    }
  }

  /** 恢复路径：会话已经发布过，只需重新拿句柄。 */
  private async resumeExisting(id: string, actor: Actor): Promise<Conversation | undefined> {
    const { ctx, access } = this.host
    const evicted = this.reserveSlot()
    let handle: AgentHandle | undefined
    let reserved = true
    let published = false
    try {
      await evicted?.dispose()
      if (this.disposed) throw new Error('conversation lifecycle is disposed')
      access.assert(actor)
      this.assertConversation(id, actor)
      const options = await this.options(id)
      access.assert(actor)
      this.assertConversation(id, actor)
      if (this.disposed) throw new Error('conversation lifecycle is disposed')
      handle = await ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions: options,
        setup: agentCtx => this.setup(agentCtx, id),
      })
      if (this.disposed) throw new Error('conversation lifecycle is disposed')
      access.assert(actor)
      this.assertConversation(id, actor)
      this.pendingOpens -= 1
      reserved = false
      const conversation = this.publish(id, handle, options)
      published = true
      return conversation
    } catch (error: unknown) {
      if (isSessionNotFound(error)) return undefined
      throw error
    } finally {
      if (reserved) this.pendingOpens -= 1
      if (!published && handle !== undefined) await Promise.allSettled([handle.dispose()])
    }
  }

  /**
   * 打开一个活跃句柄：先尝试恢复持久化会话，必要时新建。
   *
   * `missionId`（可选）是协调方这一次派活的**任务身份**。只有声明了
   * `conversationAddressing: 'derived'` 的 Agent 才用得上它：那时它既决定新建哪条会话
   * （{@link openByMission}），也用来交叉核验调用方给的 `requestedId`（{@link assertMission}）。
   * 缺省（`undefined`）时本方法的**行为**与加入这个参数之前一致：不派生、不核验、不新增挂起点
   * （"既有会话"那条路的代码只是原样搬进了 {@link openExisting}，供派遣生那条路共用）。
   */
  async open(requestedId: string | undefined, createMissing: boolean, actor: Actor,
    missionId?: string): Promise<Conversation | undefined> {
    if (this.disposed) throw new Error('conversation lifecycle is disposed')
    this.host.access.assert(actor)
    if (requestedId === undefined && !createMissing) return undefined
    const missionKey = this.missionKeyOf(actor, missionId)
    // 派生寻址：没有调用方给的 id 时，会话由 mission 寻址（而不是每次铸一个新的）。
    if (requestedId === undefined && missionKey !== undefined) return this.openByMission(missionKey, actor)
    const id = requestedId === undefined ? this.createId() : this.validateId(requestedId)
    // 调用方给了 id：走"既有会话"那条路（含本实例已有句柄的直接复用与并发合并）。
    if (requestedId !== undefined) return this.openExisting(id, actor, missionKey)
    // 新建路径：`id` 是刚铸的，所以下面两次查表在**这条路上**不可能命中（两张表都按会话 id 分桶）——
    // 与改造前逐字一致地留着它们，是因为它们本来就是这条路与"既有会话"那条路共用的代码。
    const active = this.conversations.get(id)
    if (active !== undefined) {
      active.lastUsedAt = Date.now()
      return active
    }
    // 并发打开同一个会话合并成一个 promise：两次 create 会建两个 Agent，第二个必然撞身份。
    const opening = this.openings.get(id)
    if (opening !== undefined) {
      const conversation = await opening
      this.host.access.assert(actor)
      return conversation
    }
    // 预留段：先把归属落库（`ready = false`）。中途失败留下的行不会被误用——
    // `assertConversation` 会把它挡在外面。派生寻址不在这条路上（它走上面的 `openByMission`）。
    await this.host.store.create(this.ownerOf(actor), id, '', { title: '' })
    const created = this.openReserved(id, this.reserveSlot(), actor)
      .finally(() => { this.openings.delete(id) })
    this.openings.set(id, created)
    return created
  }

  /**
   * **既有会话**的打开路径：本实例已经有句柄就直接复用，正在打开就合并，否则 `resume`。
   *
   * 它是 `open` 与{@link openByMission}（幂等命中既有行时）**共用**的一条路，所以"句柄复用 + 并发
   * 合并"只有一份实现。少了这一步、让派生寻址直接去 `resumeExisting`，同一进程里第二次派同一个
   * mission 就会**再 resume 一个句柄**，而旧句柄还活着——同一个会话两个 Agent 实例，事件流分叉。
   *
   * ⚠️ `assertMission` 那个 `await` 必须跑在**下面整段同步逻辑之前**，不能插在中间。下面从读
   * `active` 到 `openings.set(id, created)` 之间**一个 await 都没有**，那正是"两次并发打开合并成
   * 一个"的前提：先到的那次在同一个同步块里把 promise 登记进 `openings`，后到的那次才看得见它。
   * 一旦有挂起点插在中间，两次调用都会各自 `resumeExisting` 一遍 ⇒ 第二个必然撞会话身份。
   * `missionKey` 为空时这里根本不 await（`assertMission` 立刻返回），老路径零变化。
   */
  private async openExisting(id: string, actor: Actor, missionKey: string | undefined): Promise<Conversation | undefined> {
    this.assertConversation(id, actor)
    await this.assertMission(actor, id, missionKey)
    const active = this.conversations.get(id)
    if (active !== undefined) {
      active.lastUsedAt = Date.now()
      return active
    }
    const opening = this.openings.get(id)
    if (opening !== undefined) {
      const conversation = await opening
      this.host.access.assert(actor)
      return conversation
    }
    const created = this.resumeExisting(id, actor).finally(() => { this.openings.delete(id) })
    this.openings.set(id, created)
    return created
  }

  /**
   * 派生寻址的打开路径：`requestId` 是 mission 的纯函数，靠**部分唯一索引**保证"同一 mission 只有
   * 一条会话"——不建映射表，调用方也不必记住 `conversationId`。
   *
   * 判据是 **`create` 返回行的 id**（幂等命中时它返回的是**已存在的那一行**，见 `ports.ts` 的 `create`）：
   * - 返回的就是刚铸的那个 id ⇒ 真的是新行 ⇒ 走常规的预留 + 发布两段握手；
   * - 返回别的 id ⇒ 这个 mission 已经有会话（上一次调用、或**另一个进程**建的）⇒ 恢复它，绝不建第二条。
   *
   * 同进程内的并发同一 mission 也要合并：两次调用各自铸一个 id，所以上面那张按会话 id 分桶的
   * `openings` **合并不了**它们（两个键不同）——这也是 {@link missionOpenings} 单独一张表的原因。
   */
  private async openByMission(missionKey: string, actor: Actor): Promise<Conversation | undefined> {
    const opening = this.missionOpenings.get(missionKey)
    if (opening !== undefined) {
      const conversation = await opening
      this.host.access.assert(actor)
      return conversation
    }
    const created = this.reserveMissionRow(missionKey, actor)
      .finally(() => { this.missionOpenings.delete(missionKey) })
    this.missionOpenings.set(missionKey, created)
    return created
  }

  /** 派生寻址的预留段（**单独一个方法**是为了让 `openByMission` 的合并段全程同步）。 */
  private async reserveMissionRow(missionKey: string, actor: Actor): Promise<Conversation | undefined> {
    const minted = this.createId()
    const row = await this.host.store.create(this.ownerOf(actor), minted, missionKey, { title: '' })
    if (row.id === minted) return this.openReserved(minted, this.reserveSlot(), actor)
    /**
     * 幂等命中：`ready = false` ⇒ 那次创建没走完两段握手（进程死在预留与发布之间）。
     * **409 而不是再建一条**：再建一条会同时破坏"同一 mission 一条会话"和"这个 mission 到底在
     * 哪条会话里"——而后者的错法是静默的（协调方拿着新 id，旧行永远停在未发布）。
     */
    if (row.ready !== true) throw new AccessError(409, '该协作任务的会话尚未完成创建，请稍后重试')
    // 命中既有行 ⇒ 走"既有会话"那条路（句柄复用 + 并发合并），**不要**直接 `resumeExisting`。
    return this.openExisting(row.id, actor, missionKey)
  }

  async models(actor: Actor, id?: string) {
    this.host.access.assert(actor)
    if (id) this.assertConversation(this.validateId(id), actor)
    const catalog = await conversationModelCatalog(this.host.ctx)
    const cached = id ? this.conversations.get(id) : undefined
    const selected = cached ? await this.effectiveModel(cached) : id ? await conversationModel(this.host.ctx, id) : null
    this.host.access.assert(actor)
    if (id) this.assertConversation(id, actor)
    return { ...catalog, default: catalog.selected, selected }
  }

  async selectModel(conversation: Conversation, input: unknown, actor: Actor) {
    if (input === undefined) return
    this.assertCurrent(conversation, actor)
    if (conversation.active) throw new AccessError(409, '智能体正在回答上一条问题')
    const turn: PendingTurn = { pending: true, dispatching: false, cancelled: false, finishRequested: false }
    this.turns.set(conversation, turn)
    conversation.active = true
    try {
      const selected = await requestedConversationModel(this.host.ctx, input)
      const result = await selectConversationModel(this.host.ctx, conversation.id, selected!, () => {
        this.assertCurrent(conversation, actor)
        if (turn.cancelled || this.turns.get(conversation) !== turn) throw new AccessError(409, '本轮操作已停止')
      })
      this.initialModels.set(conversation, { ...result })
      return result
    } finally {
      if (this.turns.get(conversation) === turn) { this.turns.delete(conversation); conversation.active = false }
    }
  }

  private assertCurrent(conversation: Conversation, actor: Actor): void {
    this.assertConversation(conversation.id, actor)
    if (this.conversations.get(conversation.id) !== conversation) throw new AccessError(409, '会话已关闭，请重新打开')
  }

  private effectiveModel(conversation: Conversation): Promise<ConversationModel> {
    // 首次模型日志写入前保留创建选项；已有记录交给宿主投影恢复。
    if (!this.events(conversation).some(event => String(event.type) === 'model/selection' || event.type === 'request/header')) {
      const initial = this.initialModels.get(conversation)
      if (initial) return Promise.resolve(initial)
    }
    return conversationModel(this.host.ctx, conversation.id)
  }

  /** 给一个活跃的业务 Agent 追加一条用户消息。 */
  async followup(conversation: Conversation, text: string, actor: Actor): Promise<void> {
    this.assertCurrent(conversation, actor)
    if (conversation.active) throw new AccessError(409, '智能体正在回答上一条问题')
    const turn: PendingTurn = { pending: true, dispatching: false, cancelled: false, finishRequested: false }
    this.turns.set(conversation, turn)
    const held = this.heldTurns.get(conversation.id)
    if (held) held.turn = turn
    this.identities.set(conversation.handle.agent, actor)
    conversation.lastUsedAt = Date.now()
    conversation.active = true
    try {
      await requestedConversationModel(this.host.ctx, await this.effectiveModel(conversation))
      this.assertCurrent(conversation, actor)
      if (turn.cancelled || this.turns.get(conversation) !== turn) throw new AccessError(409, '本轮操作已停止')
      /**
       * 回合开始时的业务钩子，**在消息注入之前**。
       *
       * 位置是刻意的：放这里失败还来得及（消息还没进去，本轮按失败收尾即可）；放到注入之后就只剩
       * "收拾残局"——业务会看到一条已经进了会话、却没能完成记账的消息。
       */
      /**
       * 回合开始时的业务钩子，**在消息注入之前**。
       *
       * 位置是刻意的：放这里失败还来得及（消息还没进去，本轮按失败收尾即可）；放到注入之后就只剩
       * "收拾残局"——业务会看到一条已经进了会话、却没能完成记账的消息。
       */
      const startHook = this.host.definition.onTurnStart
      if (startHook !== undefined) {
        await startHook({
          conversationId: conversation.id,
          actor,
          agent: conversation.handle.agent,
          storage: this.host.storage,
        })
        // 钩子是异步的：期间可能被取消/顶掉，注入前要再核一次（与上面 `requestedConversationModel`
        // 之后那次同一理由）。
        this.assertCurrent(conversation, actor)
        if (turn.cancelled || this.turns.get(conversation) !== turn) throw new AccessError(409, '本轮操作已停止')
      }
      /**
       * 每轮的**动态上下文**（`AgentDefinition.turnContext`）：在**注入之前**求值并落到槽位上，
       * 宿主随后的装配读到的就是这一份。
       *
       * 与 `onTurnStart` 同一位置理由：放这里失败还来得及（消息还没进去，本轮按失败收尾即可）；
       * 放到注入之后，模型可能已经带着**上一轮**的资料开跑了——而"资料过期"在界面上看不出来。
       */
      const turnContext = this.host.definition.turnContext
      if (turnContext !== undefined) {
        this.turnContexts.set(conversation.id, await turnContext({
          conversationId: conversation.id,
          actor,
          agent: conversation.handle.agent,
          storage: this.host.storage,
        }))
        // 钩子是异步的：期间可能被取消/顶掉，注入前要再核一次（与上面同一理由）。
        this.assertCurrent(conversation, actor)
        if (turn.cancelled || this.turns.get(conversation) !== turn) throw new AccessError(409, '本轮操作已停止')
      }
      /**
       * 本轮的内容块：业务可以组合多块（附件文本 / 图片），缺省**逐字**保持老口径的单块正文。
       */
      const compose = this.host.definition.composeTurnInput
      const content: readonly unknown[] = compose === undefined
        ? [{ type: 'text', text }]
        : await compose({ text, conversationId: conversation.id, actor })
      turn.pending = false
      turn.dispatching = true
      try {
        conversation.handle.agent.followup(createUserMessage({ content: content as never, source: { kind: 'user' } }))
      } finally { turn.dispatching = false }
      // 首条用户消息决定标题（官方标题随后经 TitleSink 覆盖；自动标题不覆盖手动标题）。
      await this.host.store.syncTitle(this.ownerOf(actor), conversation.id, firstLine(text), 'automatic')
      /**
       * ⚠️ `syncTitle` 的 `UPDATE` **不碰 `updated_at`**（守卫只认 `title` / `title_source`），
       * 而侧栏排序是 `pinned DESC, updated_at DESC, id`、`from` / `to` 过滤也按这一列。少了这
       * 一次 `touch`，"刚说过话的会话"在列表里按**创建时间**排：新会话永远压在旧会话下面，
       * 时间范围过滤同样算错。
       *
       * 时刻用 `followup` 开头记下的 `lastUsedAt`（本轮的受理时刻），不用 `Date.now()`：
       * 中间隔了模型目录解析与发布检查两次 await，取当下会让时间戳晚于真实受理点。
       */
      await this.host.store.touch(this.ownerOf(actor), conversation.id, conversation.lastUsedAt)
      // 延后收尾：把要求结束时记下的**通知参数**原样带上（`notify` 丢成缺省会给业务一次假通知）。
      if (turn.finishRequested) {
        this.finish(conversation.id, turn.finishRequested.outcome, { notify: turn.finishRequested.notify })
      }
    } catch (error: unknown) {
      if (this.turns.get(conversation) === turn) {
        if (turn.pending) {
          this.turns.delete(conversation)
          conversation.active = this.heldTurns.has(conversation.id)
        } else { this.abort(conversation.id); this.finish(conversation.id) }
      }
      throw error
    }
  }

  /** 从一个已完成的回合前缀分支出新会话。 */
  async fork(conversation: Conversation, boundary: SessionSeq, actor: Actor): Promise<Conversation> {
    if (this.disposed) throw new Error('conversation lifecycle is disposed')
    this.host.access.assert(actor)
    this.assertConversation(conversation.id, actor)
    if (conversation.active) throw new Error('cannot branch an active conversation')
    const events = this.events(conversation)
    const boundaryIndex = events.findIndex(event => event.seq === boundary
      && event.type === 'turn/end'
      && event.data.reason.kind === 'completed')
    if (boundaryIndex === -1) throw new Error('branch boundary must be a completed turn')
    const seed = events.slice(0, boundaryIndex + 1)
    const id = this.createId()
    await this.host.store.create(this.ownerOf(actor), id, '', { title: '' })
    const evicted = this.reserveSlot()
    this.forks.add(conversation.id)
    let reserved = true
    try {
      await evicted?.dispose()
      this.host.access.assert(actor)
      const options = await this.options(conversation.id, seed.length)
      this.host.access.assert(actor)
      this.assertConversation(conversation.id, actor)
      if (this.disposed) throw new Error('conversation lifecycle is disposed')
      const handle = await this.host.ctx.agents.create({
        sessionId: SessionId(id),
        seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: { cwd: process.cwd(), parentSession: SessionId(conversation.id), isSeeded: true },
        agentOptions: options,
        setup: agentCtx => this.setup(agentCtx, id),
      })
      if (this.disposed) {
        await handle.dispose()
        throw new Error('conversation lifecycle is disposed')
      }
      try {
        // 发布段：照 `openReserved` 的形状——发布失败时句柄**必须**在这里销毁。少了这一步，
        // 分支的发布一失败，那个 Agent 就既不进活跃表（`publish()` 没被调用）也没人回收
        // ⇒ 进程里留下一个永不释放的 driver（`finally` 只管 `pendingOpens` 与 `forks` 两个计数）。
        await this.host.store.publish(this.ownerOf(actor), id)
      } catch (error) { await handle.dispose(); throw error }
      this.pendingOpens -= 1
      reserved = false
      return this.publish(id, handle, options)
    } finally {
      this.forks.delete(conversation.id)
      if (reserved) this.pendingOpens -= 1
    }
  }

  /**
   * 把一个结束或断开的回合标成可被 LRU 驱逐。
   *
   * `outcome` 只喂给 {@link AgentDefinition.onTurnFinish}：**协作入口知道**这一轮是正常结束、被取消
   * 还是失败，所以由它传；页面入口与其它调用方只做"放掉占用"，不传时按 `'completed'` 处理。
   *
   * ⚠️ 若这一轮还在 `pending`/`dispatching`（回合已被要求结束、但消息还没注入完），这里只能把
   * **`outcome` 与 `notify` 一起记进 `turn.finishRequested`**，由随后的 `followup` 收尾原样带上。
   * 早先这里只记一个布尔，`notify: false`（"只是为注入下一轮释放占用"）会在那条路径上被丢成缺省值
   * ⇒ 业务收到一次**假的**"回合结束"（实测抓到过，见 `PendingTurn.finishRequested` 的注释）。
   */
  finish(id: string, outcome: TurnOutcome = 'completed', options: { readonly notify?: boolean } = {}): void {
    if (this.heldTurns.has(id)) return
    const conversation = this.conversations.get(id)
    if (conversation === undefined) return
    /**
     * ⚠️ `notify: false` 的用处：这个方法在协作入口里被**两种语义**共用——①「这一轮结束了」；
     * ②「为注入下一轮而释放占用」（补交轮 / 自修正轮之间）。只有 ① 该触发 `onTurnFinish`；
     * ② 若也触发，业务每注入一轮就会收到一次假的"回合结束"（而这一轮其实还在继续），
     * 它按那个信号去解除绑定、写终态，就会把还在跑的回合记成已结束。
     */
    const notify = options.notify ?? true
    const turn = this.turns.get(conversation)
    if (turn?.pending || turn?.dispatching) { turn.finishRequested = { outcome, notify }; return }
    /**
     * `!turn` ⇒ **这个会话上没有登记中的回合** ⇒ 没有"结束"可通知。
     *
     * 这一格是两个来源共用的：① 从没 `followup` 过的会话；② **重复的 `finish` 调用**（最典型的是
     * `turn/end` 的监听器在协作入口已经收尾之后再调一次）。若在这里也通知，业务会收到一次**假的**
     * "回合结束"——它据此解除绑定、写终态，而那一轮其实早就结束了（或压根没开始）。实测抓到过：
     * 补交轮注入之后多出一条 `completed`。
     */
    if (!turn) { conversation.active = false; return }
    /**
     * ⚠️ **已经在飞就只更新意图**，不再登记第二个回调。
     *
     * 同一回合上 `finish` 会被调用多次（`cleanup()` 里先释放凭据、再带结论收尾；补交轮之间还有一次
     * "释放占用"）。各登记一个回调的话，**先跑的那个赢**——它删掉回合，后面的全被下面的守卫挡掉。
     * 而先登记的往往不是知道结论的那一个 ⇒ 通知的次数与结论都由登记顺序决定。
     *
     * 判据是「**后到的信息更完整**」：释放凭据只知道"我放开了"，不知道这一轮成功还是失败；带
     * `outcome` 的那次收尾才知道。所以合并的规则只能是"更新"，不能是"先到先得"。
     * ⚠️ 这条也意味着**不要在收尾回调里放业务副作用**——它可能被后到的调用改写意图后只跑一次，
     * 也可能因为守卫提前返回而根本不跑；副作用属于业务钩子（`onTurnFinish`），不属于这里。
     *
     * 这两个后果（补交轮收到**两条** `completed`；失败回合收到 `completed`）实测都抓到过。
     * ⚠️ **诚实归类**：它们不是运行时的老问题，而是**本轮新加的回合缝引入的**——`onTurnFinish`
     * 这条缝上线时，通知的发出者与顺序还没有收敛到"唯一在飞记录"上。修复即本节，回归见
     * `tests/runtime-closure.test.ts` 的「回合钩子的通知：发出者与次数」。
     */
    if (turn.finishInFlight !== undefined) {
      turn.finishInFlight.outcome = outcome
      turn.finishInFlight.notify = notify
      return
    }
    const inFlight = { outcome, notify }
    turn.finishInFlight = inFlight
    // 同步 followup 可能发出 turn/end；必须等它返回后再取得当前 driver 的空闲承诺。
    void conversation.handle.agent.whenIdle().then(() => {
      if (this.conversations.get(id) !== conversation || this.turns.get(conversation) !== turn || this.heldTurns.has(id)) return
      this.turns.delete(conversation)
      conversation.active = false
      conversation.lastUsedAt = Date.now()
      if (inFlight.notify) this.notifyTurnFinish(conversation, inFlight.outcome)
    }, () => { /* 宿主未确认空闲时保留占用。 */ })
  }

  /**
   * 通知业务"这一轮结束了"。
   *
   * ⚠️ **不等待、也不让业务的失败改变结论**：收到终态之后翻案，会让协调方按前一个结论记过的账
   * 对不上（协调方可能已经据此派了下一步）。所以这里只记日志。
   */
  private notifyTurnFinish(conversation: Conversation, outcome: TurnOutcome): void {
    const hook = this.host.definition.onTurnFinish
    if (hook === undefined) return
    // ⚠️ 拿不到 actor 就**不调**：`identities` 只在 `followup` 里写入，所以"没有 actor"恰好等价于
    // "这一轮**从来没注入过消息**"——那不是一次真正的回合，没有"结束"可通知。造一个假 actor 去调，
    // 会让业务按一个不存在的身份记账。
    const actor = this.identities.get(conversation.handle.agent)
    if (actor === undefined) return
    const notify = async (): Promise<void> => {
      await hook({
        conversationId: conversation.id,
        actor,
        agent: conversation.handle.agent,
        storage: this.host.storage,
        outcome,
      })
    }
    void notify().catch((error: unknown) => {
      console.warn(`[agents-group/runtime] ${this.host.definition.id} 的 onTurnFinish 抛错（不改变已定结论）：`, error)
    })
  }

  /** 取消某个业务会话上正在进行的操作。 */
  cancel(id: string, actor: Actor): void {
    this.host.access.assert(actor)
    this.assertConversation(this.validateId(id), actor)
    this.abort(id)
  }

  /** 超时、断开或授权撤销时中止已经受理的工作。 */
  abort(id: string): void {
    const conversation = this.conversations.get(id)
    const turn = conversation && this.turns.get(conversation)
    if (turn) {
      turn.cancelled = true
      if (turn.pending) { this.turns.delete(conversation!); conversation!.active = this.heldTurns.has(id) }
    }
    conversation?.handle.agent.cancel({ kind: 'user' })
  }

  /**
   * 中止**这一轮自己持有的那个回合**：只有"这个句柄仍是这个 id 的当前句柄、且它上面的当前回合
   * 就是这一轮 `retainTurn` 之后派发出去的那一个"时才取消，否则**什么都不做**。
   *
   * 与 {@link abort} 的差别只有守卫这一个，而它是必要的：`abort(id)` 取消的是"这个 id **此刻**的
   * 当前回合"。协作入口的接续失败分支（旧目录 / 旧接续的**迟到**失败）在失败到达时，这一轮自己的
   * 回合可能已经不在了（被页面入口的 `cancel` 摘掉、或被 `finish` 收掉），那一下就会取消到
   * **别人**的回合上，或者对同一个 driver 补一次无人需要的取消。
   *
   * 判据用的是这一轮的**回合凭据**（`retainTurn` 的 `held` 记录），不是标志位或时间窗：
   *
   * - `conversations.get(id) !== conversation` ⇒ 这个句柄已被 LRU 驱逐 / 侧栏移除，id 上此刻的
   *   句柄是**另一个对象**（`turns` 是 `WeakMap<Conversation, …>`，按对象算，不对上就一定是别人的）；
   * - `held.turn === undefined` ⇒ 这一轮还没派发过任何回合（`followup` 在第一个 await 之前就登记，
   *   没登记说明它当时就抛了），这一轮没有任何东西可取消；
   * - `turns.get(conversation) !== held.turn` ⇒ 当前回合不是这一轮派发的那一个（已被摘掉，或已被
   *   后续轮次取代）。
   *
   * 三条都不成立时才走 {@link abort}：那时当前回合**就是**这一轮的回合，取消它是这一轮的本分。
   */
  abortHeldTurn(conversation: Conversation): void {
    if (this.conversations.get(conversation.id) !== conversation) return
    const held = this.heldTurns.get(conversation.id)
    if (held?.turn === undefined || this.turns.get(conversation) !== held.turn) return
    this.abort(conversation.id)
  }

  /** 复核启动当前回合的那个登录会话。 */
  authorizeAgent(agent: object | undefined): void {
    if (this.host.access.mode === 'standalone') return
    const actor = agent === undefined ? undefined : this.identities.get(agent)
    if (actor === undefined) throw new AccessError(403, '工具调用缺少可信用户身份')
    this.host.access.assert(actor)
  }

  /** 撤销正在进行的工作，不删除持久会话、也不改绑到另一个登录。 */
  revokeInvalid(): void {
    for (const conversation of this.conversations.values()) {
      const actor = this.identities.get(conversation.handle.agent)
      if (actor === undefined) continue
      try { this.host.access.assert(actor) } catch { this.abort(conversation.id) }
    }
  }

  /** 读取活跃会话的持久内存日志。 */
  events(conversation: Conversation): readonly SessionEvent[] {
    return conversation.handle.agent.session.snapshotEvents()
  }

  /**
   * 释放**一个**会话的句柄（侧栏移除会话时由装配侧调用）。
   *
   * 与 {@link dispose} 的差别只有一个：只动这一个会话，不停本实例、也不碰其他会话。
   *
   * **必须真的把句柄销毁**，不能只让围栏标记落库：句柄还活着的话这条会话仍然占着活跃表、
   * 也可能还在跑，而围栏已经宣称它被移除了——那是"删了却还在"的幽灵会话。
   *
   * 已知会话不存在时**静默返回**：移除路径可能对同一个 id 重试，第二次没有句柄可释放不是错误。
   */
  async release(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId)
    if (conversation === undefined) return
    this.conversations.delete(conversationId)
    this.turnContexts.delete(conversationId)
    await Promise.allSettled([conversation.handle.dispose()])
  }

  /** 停止本实例持有的全部 Agent。它不关存储——存储由插件在更外层释放。 */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stopTitles()
    await Promise.allSettled([...this.openings.values()])
    // 派生寻址在飞的那几次也必须等：它们的 promise **不在** `openings` 里（那张表按会话 id 分桶，
    // 而派生路径要等 `create` 回来才知道最终 id），漏掉就等于"停止时还有一次 create 在飞"。
    await Promise.allSettled([...this.missionOpenings.values()])
    const handles = [...this.conversations.values()].map(conversation => conversation.handle)
    this.conversations.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}

/** 会话持久化里"这条会话不存在"的判定：只认官方那一个错误名。 */
function isSessionNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionPersistenceNotFoundError'
}

/** 首条用户消息压成的标题。 */
function firstLine(text: string): string {
  return Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 80).join('')
}

/** 取一段内容块里的文本。 */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

/**
 * 缺省的预览投影：只取用户与助手的正文。
 *
 * `user/message` 的载荷**就是**消息本身，`assistant/message` 的载荷是 `{ message, … }` 的包装
 * ——两者的形状不同，必须分开取。时间统一用事件自己的 `time`（`AssistantMessage` 上没有）。
 */
export function previewMessages(events: readonly SessionEvent[]): readonly { role: 'user' | 'assistant'; text: string; time: number }[] {
  const messages: { role: 'user' | 'assistant'; text: string; time: number }[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = textOf(event.data.content)
      if (text !== '') messages.push({ role: 'user', text, time: event.time })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content)
      if (text !== '') messages.push({ role: 'assistant', text, time: event.time })
    }
  }
  return messages
}

/**
 * 从会话事件里读一轮历史（供结果投影与自检使用）。
 *
 * ## 为什么必须带**回合归属**与 `tail`
 *
 * 一轮里每一步的正文后面都跟着一次工具调用（「让我先看看…」「找到了！」），只有**最后一条**
 * 才是答案。业务原来的做法是靠"本轮起点"切片（它自己有一张请求表、用 `requestId` 对消息 id），
 * 而运行时看不见那张表——但运行时**看得见 `turn/start`**，所以"哪几条属于本轮"由 `turn` 直接
 * 回答，比让每个业务各切一次更可靠。
 *
 * `tail` 是"这一轮**算数的正文**"：本回合内最后一条**未被中断**、且有正文的 assistant 消息。
 * 它与 {@link TurnHistory.finalText} **不同**（后者取最后一条 `assistant/message` 的正文，
 * 被中断的也算）——把这个区别抹平会**静默改变答案提取语义**。
 *
 * ## `assistant/attempt` 为什么**不**进历史（刻意的，别顺手加）
 *
 * 1. 它按定义就是 `interrupted`（失败、重试或取消的尝试），**永远不可能**是 `tail`；
 * 2. 它的正文要从 `data.stream` 展开（`llm.expandAssistantStream` + 块装配），那是**另一套
 *    机制**；运行时对它现在的处置是"丢弃该步的思考累积"（`thinking.discard(step)`）；
 * 3. 真要把失败尝试的过程叙述也交回，那是业务口径问题，应当由业务在自己的钩子里声明——
 *    不要由运行时替所有 Agent 决定。
 */
export function historyOf(events: readonly SessionEvent[], conversationId: string): TurnHistory {
  const messages: TurnMessage[] = []
  let finalText = ''
  /** 最后一次 `turn/start` 的回合号；`undefined` = 历史里没有回合边界（隐式单回合）。 */
  let turn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      const value = (event.data as { turn?: unknown }).turn
      if (typeof value === 'number') turn = value
    } else if (event.type === 'user/message') {
      const text = textOf(event.data.content)
      if (text !== '') {
        messages.push({
          role: 'user', text, time: event.time,
          ...identify((event.data as { id?: unknown }).id),
          ...attribute(turn),
        })
      }
    } else if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: unknown; id?: unknown }; interrupted?: unknown }
      finalText = textOf(data.message?.content)
      if (finalText !== '') {
        messages.push({
          role: 'assistant', text: finalText, time: event.time,
          ...identify(data.message?.id),
          ...attribute(turn),
          ...(data.interrupted === true ? { interrupted: true } : {}),
        })
      }
    }
  }
  // `tail` 只在**本回合**里找：跨回合回退会把上一轮的答案当成这一轮的（业务原实现的
  // `findLast(m => m.turn === turn.turn)` 就是这个口径）。
  let tail: TurnMessage | undefined
  for (const message of messages) {
    if (message.role !== 'assistant' || message.interrupted === true) continue
    if (message.turn !== turn) continue
    tail = message
  }
  return { messages, conversationId, finalText, ...(turn === undefined ? {} : { turn }), ...(tail === undefined ? {} : { tail }) }
}

/** 官方消息 id 是字符串时带上它；形状不对就不带（业务侧按"没有 id"处理）。 */
function identify(value: unknown): { id?: string } {
  return typeof value === 'string' && value !== '' ? { id: value } : {}
}

/** 回合归属：`undefined` 时不带这个字段（与"隐式单回合"同义）。 */
function attribute(turn: number | undefined): { turn?: number } {
  return turn === undefined ? {} : { turn }
}
