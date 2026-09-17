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
import type { AgentDefinition, TurnHistory, TurnMessage } from './definition.ts'
import type { ConversationPageShape, ConversationPort, ConversationQueryShape, OwnerKey } from './storage/ports.ts'

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

interface PendingTurn { pending: boolean; dispatching: boolean; cancelled: boolean; finishRequested: boolean }

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
  private readonly forks = new Set<string>()
  private readonly heldTurns = new Map<string, { turn?: PendingTurn }>()
  private readonly turns = new WeakMap<Conversation, PendingTurn>()
  private readonly initialModels = new WeakMap<Conversation, ConversationModel>()
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
      if (this.turns.get(conversation) === held.turn || !this.turns.has(conversation)) this.finish(conversation.id)
    }
  }

  private setup(agentCtx: Context): void {
    agentCtx.systemPrompt.section({
      name: `${this.host.definition.id}:persona`,
      order: 600,
      text: this.host.definition.persona,
    })
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
        setup: agentCtx => this.setup(agentCtx),
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
        setup: agentCtx => this.setup(agentCtx),
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

  /** 打开一个活跃句柄：先尝试恢复持久化会话，必要时新建。 */
  async open(requestedId: string | undefined, createMissing: boolean, actor: Actor): Promise<Conversation | undefined> {
    if (this.disposed) throw new Error('conversation lifecycle is disposed')
    this.host.access.assert(actor)
    if (requestedId === undefined && !createMissing) return undefined
    const id = requestedId === undefined ? this.createId() : this.validateId(requestedId)
    if (requestedId !== undefined) this.assertConversation(id, actor)
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
    if (requestedId === undefined) {
      // 预留段：先把归属落库（`ready = false`）。中途失败留下的行不会被误用——
      // `assertConversation` 会把它挡在外面。
      await this.host.store.create(this.ownerOf(actor), id, '', { title: '' })
    }
    const created = (requestedId !== undefined
      ? this.resumeExisting(id, actor)
      : this.openReserved(id, this.reserveSlot(), actor))
      .finally(() => { this.openings.delete(id) })
    this.openings.set(id, created)
    return created
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
    const turn = { pending: true, dispatching: false, cancelled: false, finishRequested: false }
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
    const turn = { pending: true, dispatching: false, cancelled: false, finishRequested: false }
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
      turn.pending = false
      turn.dispatching = true
      try {
        conversation.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
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
      if (turn.finishRequested) this.finish(conversation.id)
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
        setup: agentCtx => this.setup(agentCtx),
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

  /** 把一个结束或断开的回合标成可被 LRU 驱逐。 */
  finish(id: string): void {
    if (this.heldTurns.has(id)) return
    const conversation = this.conversations.get(id)
    if (conversation === undefined) return
    const turn = this.turns.get(conversation)
    if (turn?.pending || turn?.dispatching) { turn.finishRequested = true; return }
    if (!turn) { conversation.active = false; return }
    // 同步 followup 可能发出 turn/end；必须等它返回后再取得当前 driver 的空闲承诺。
    void conversation.handle.agent.whenIdle().then(() => {
      if (this.conversations.get(id) !== conversation || this.turns.get(conversation) !== turn || this.heldTurns.has(id)) return
      this.turns.delete(conversation)
      conversation.active = false
      conversation.lastUsedAt = Date.now()
    }, () => { /* 宿主未确认空闲时保留占用。 */ })
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
    await Promise.allSettled([conversation.handle.dispose()])
  }

  /** 停止本实例持有的全部 Agent。它不关存储——存储由插件在更外层释放。 */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stopTitles()
    await Promise.allSettled([...this.openings.values()])
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
