/** Business Agent lifecycle and durable session identity. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent, type SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import { AccessError, conversationModel, conversationArchive, conversationRemover, readConversationEvents, previewPage, hostBusyConversationIds, registerConversationTitles, type ConversationProvider, type PreviewMessage, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { conversationModelCatalog, requestedConversationModel, selectConversationModel, type ConversationModel } from '@dsh-plugin-manager/plugin-kit/models'
import { projectHistory } from './presentation.ts'
import type { ConversationStore, ConversationSummary } from './conversation-store.ts'

const SESSION_ID = /^closedoff-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionPersistenceNotFoundError'
}

/** One active business session owned by this plugin instance. */
export interface Conversation {
  readonly id: string
  readonly handle: AgentHandle
  lastUsedAt: number
  active: boolean
}

interface PendingTurn { pending: boolean; dispatching: boolean; cancelled: boolean; finishRequested: boolean }

/** Creates or resumes namespaced business Agents and owns their handles. */
export class ConversationManager {
  private readonly conversations = new Map<string, Conversation>()
  private readonly openings = new Map<string, Promise<Conversation | undefined>>()
  private readonly forks = new Set<string>()
  private readonly heldTurns = new Map<string, { turn?: PendingTurn }>()
  private readonly turns = new WeakMap<Conversation, PendingTurn>()
  private readonly initialModels = new WeakMap<Conversation, ConversationModel>()
  private pendingOpens = 0
  private disposed = false
  private readonly identities = new WeakMap<object, Actor>()
  private provider?: ConversationProvider
  private readonly stopTitles: () => void

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly persona: string,
    private readonly toolNames: readonly string[],
    private readonly access: Access,
    private readonly store: ConversationStore,
    /**
     * 本 Agent 能用的工具名（本分类 + 通用集）。
     *
     * 由群组注入，在 agent 作用域内应用。宿主不允许在插件上下文里做工具限制，所以必须落到
     * 各 Agent 自己的 setup（见 `setup`）。默认回落到自己的工具名，保持既有行为。
     */
    private readonly allowedTools: () => readonly string[] = () => toolNames,
  ) {
    this.stopTitles = registerConversationTitles(ctx, (id, title, manual, complete) => {
      if (!this.disposed) this.store.syncTitle(id, title, manual, complete)
    })
  }

  /** Reuse the same ownership fence as send, resume and branch. */
  management(): ConversationProvider {
    if (this.provider) return this.provider
    const busy = (id: string) => !!this.conversations.get(id)?.active || this.openings.has(id) || this.forks.has(id)
    return this.provider = { protocol:1, pluginId:'closedoff', list:async(actor,query)=>{
      this.access.assert(actor)
      return this.store.managed(actor,query,conversationArchive(this.ctx).archivedSessionIds,[...hostBusyConversationIds(this.ctx),...[...new Set([...this.conversations.keys(),...this.openings.keys(),...this.forks])].filter(busy)])
    }, preview:async(actor,id,before)=>{
      this.access.assert(actor)
      if(this.store.record(actor,id).removalState==='removed')throw new AccessError(404,'会话已移除')
      const events=await readConversationEvents(this.ctx,id) as readonly SessionEvent[]
      this.access.assert(actor)
      if(this.store.record(actor,id).removalState==='removed')throw new AccessError(404,'会话已移除')
      const messages=projectHistory(events,this.config.trackDeviceRadiusMeters).flatMap<PreviewMessage>(message=>message.role==='user'?[message]:[
        {role:'assistant' as const,text:message.text,reasoning:message.thinking,time:message.time},
        ...message.tools.map(tool=>({role:'tool' as const,text:`${tool.presentation.sourceLabel || tool.name} · ${tool.status}`})),
      ])
      return previewPage(messages,before)
    }, remove:conversationRemover(this.ctx,{assert:actor=>{this.access.assert(actor);if(this.disposed)throw new AccessError(503,'插件正在停止')},store:this.store,busy,release:async id=>{
      const conversation=this.conversations.get(id)
      if(conversation){this.conversations.delete(id);await conversation.handle.dispose()}
    }}) }
  }

  /** Create a fresh namespaced conversation id. */
  createId(): string {
    return `closedoff-web-${randomUUID()}`
  }

  /** Validate that a browser-supplied id cannot address another DSH session. */
  validateId(value: string): string {
    if (!SESSION_ID.test(value)) throw new AccessError(400, 'conversationId is not a closed-off business session id')
    return value
  }

  /** 协作进度和成果仍按原会话主人及发起登录复核。 */
  assertConversation(id: string, actor: Actor): void {
    if (this.disposed) throw new AccessError(503, '插件正在停止')
    this.access.assert(actor)
    this.store.assertOwner(this.validateId(id), actor)
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
      name: 'closedoff-assistant:persona',
      order: 600,
      text: this.persona,
    })
    // 只允许调用属于本 Agent 标签的工具，外加约定好的通用集。在 agent 作用域里限制 ——
    // 插件级限制会波及所有 Agent，宿主会直接拒绝。
    agentCtx.tools.restrict({ allow: [...this.allowedTools()] })
  }

  private async options(id?: string, eventCount?: number) {
    const selection = await conversationModel(this.ctx, id, eventCount)
    await requestedConversationModel(this.ctx, selection)
    const info = id ? undefined : await this.ctx.llm.resolveModelInfo(selection.provider, selection.model)
    const effort = info?.reasoning?.efforts.some(effort => effort.id === this.config.reasoningEffort) ? this.config.reasoningEffort : selection.reasoningEffort
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
    const occupied = this.conversations.size + this.pendingOpens
    if (occupied < this.config.maxActiveConversations) {
      this.pendingOpens += 1
      return undefined
    }
    const idle = [...this.conversations.values()]
      .filter(conversation => !conversation.active)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
    if (idle === undefined || occupied - 1 >= this.config.maxActiveConversations) {
      throw new Error(`active conversation limit ${String(this.config.maxActiveConversations)} reached`)
    }
    this.conversations.delete(idle.id)
    this.pendingOpens += 1
    return idle.handle
  }

  private async openReserved(
    id: string,
    evicted: AgentHandle | undefined,
    actor: Actor,
  ): Promise<Conversation | undefined> {
    let reserved = true
    try {
      await evicted?.dispose()
      this.access.assert(actor)
      const options = await this.options()
      this.access.assert(actor)
      if (this.disposed) throw new Error('conversation manager is disposed')
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: process.cwd() },
        agentOptions: options,
        setup: agentCtx => this.setup(agentCtx),
      })
      if (this.disposed) {
        await handle.dispose()
        throw new Error('conversation manager is disposed')
      }
      try {
        this.access.assert(actor)
        this.store.publish(id)
      } catch (error) { await handle.dispose(); throw error }
      this.pendingOpens -= 1
      reserved = false
      return this.publish(id, handle, options)
    } finally {
      if (reserved) this.pendingOpens -= 1
    }
  }

  private async resumeExisting(id: string, actor: Actor): Promise<Conversation | undefined> {
    const evicted = this.reserveSlot()
    let handle: AgentHandle | undefined
    let reserved = true
    let published = false
    try {
      await evicted?.dispose()
      if (this.disposed) throw new Error('conversation manager is disposed')
      this.access.assert(actor)
      this.store.assertOwner(id,actor)
      const options = await this.options(id)
      this.access.assert(actor)
      this.store.assertOwner(id,actor)
      if (this.disposed) throw new Error('conversation manager is disposed')
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions: options,
        setup: agentCtx => this.setup(agentCtx),
      })
      if (this.disposed) throw new Error('conversation manager is disposed')
      this.access.assert(actor)
      this.store.assertOwner(id,actor)
      this.pendingOpens -= 1
      reserved = false
      const conversation = this.publish(id, handle, options)
      published = true
      return conversation
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw error
    } finally {
      if (reserved) this.pendingOpens -= 1
      if (!published && handle !== undefined) await Promise.allSettled([handle.dispose()])
    }
  }

  /** Open an active handle, resuming persistence before optionally creating a missing session. */
  async open(requestedId: string | undefined, createMissing: boolean, actor: Actor): Promise<Conversation | undefined> {
    if (this.disposed) throw new Error('conversation manager is disposed')
    this.access.assert(actor)
    if (requestedId === undefined && !createMissing) return undefined
    const id = requestedId === undefined ? this.createId() : this.validateId(requestedId)
    if (requestedId !== undefined) this.store.assertOwner(id, actor)
    const active = this.conversations.get(id)
    if (active !== undefined) {
      active.lastUsedAt = Date.now()
      return active
    }
    const opening = this.openings.get(id)
    if (opening !== undefined) {
      const conversation = await opening
      this.access.assert(actor)
      return conversation
    }
    if (requestedId === undefined) this.store.reserve(id, actor)
    const created = (requestedId !== undefined
      ? this.resumeExisting(id, actor)
      : this.openReserved(id, this.reserveSlot(), actor))
      .finally(() => { this.openings.delete(id) })
    this.openings.set(id, created)
    return created
  }

  async models(actor: Actor, id?: string) {
    this.access.assert(actor)
    if (id) this.store.assertOwner(this.validateId(id), actor)
    const catalog = await conversationModelCatalog(this.ctx)
    const cached = id ? this.conversations.get(id) : undefined
    const selected = cached ? await this.effectiveModel(cached) : id ? await conversationModel(this.ctx, id) : null
    this.access.assert(actor); if (id) this.store.assertOwner(id, actor)
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
      const selected = await requestedConversationModel(this.ctx, input)
      const result = await selectConversationModel(this.ctx, conversation.id, selected!, () => {
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
    return conversationModel(this.ctx, conversation.id)
  }

  /** Add one user message to an active business Agent. */
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
      await requestedConversationModel(this.ctx, await this.effectiveModel(conversation))
      this.assertCurrent(conversation, actor)
      if (turn.cancelled || this.turns.get(conversation) !== turn) throw new AccessError(409, '本轮操作已停止')
      turn.pending = false
      turn.dispatching = true
      try {
        conversation.handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      } finally { turn.dispatching = false }
      this.store.touch(conversation.id, text)
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

  /** Create a new namespaced conversation from one completed-turn prefix. */
  async fork(conversation: Conversation, boundary: SessionSeqType, actor: Actor): Promise<Conversation> {
    if (this.disposed) throw new Error('conversation manager is disposed')
    this.access.assert(actor)
    this.store.assertOwner(conversation.id, actor)
    if (conversation.active) throw new Error('cannot branch an active conversation')
    const events = this.events(conversation)
    const boundaryIndex = events.findIndex(event => event.seq === boundary
      && event.type === 'turn/end'
      && event.data.reason.kind === 'completed')
    if (boundaryIndex === -1) throw new Error('branch boundary must be a completed turn')
    const seed = events.slice(0, boundaryIndex + 1)
    const id = this.createId()
    this.store.reserve(id, actor)
    const evicted = this.reserveSlot()
    this.forks.add(conversation.id)
    let reserved = true
    try {
      await evicted?.dispose()
      this.access.assert(actor)
      const options = await this.options(conversation.id, seed.length)
      this.access.assert(actor)
      this.store.assertOwner(conversation.id, actor)
      if (this.disposed) throw new Error('conversation manager is disposed')
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(id),
        seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: { cwd: process.cwd(), parentSession: SessionId(conversation.id), isSeeded: true },
        agentOptions: options,
        setup: agentCtx => this.setup(agentCtx),
      })
      if (this.disposed) {
        await handle.dispose()
        throw new Error('conversation manager is disposed')
      }
      try {
        this.access.assert(actor)
        this.store.publish(id)
      } catch (error) { await handle.dispose(); throw error }
      this.pendingOpens -= 1
      reserved = false
      return this.publish(id, handle, options)
    } finally {
      this.forks.delete(conversation.id)
      if (reserved) this.pendingOpens -= 1
    }
  }

  /** Mark a finished or disconnected turn as eligible for LRU eviction. */
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

  /** Cancel only the active operation for one business Agent. */
  cancel(id: string, actor: Actor): void {
    this.access.assert(actor)
    this.store.assertOwner(this.validateId(id), actor)
    this.abort(id)
  }

  /** Cancel already-admitted work on timeout, disconnect or authorization revocation. */
  abort(id: string): void {
    const conversation = this.conversations.get(id)
    const turn = conversation && this.turns.get(conversation)
    if (turn) {
      turn.cancelled = true
      if (turn.pending) { this.turns.delete(conversation!); conversation!.active = this.heldTurns.has(id) }
    }
    conversation?.handle.agent.cancel({ kind: 'user' })
  }

  /** Recheck the exact login session that started this Agent's current turn. */
  authorizeAgent(agent: object | undefined): void {
    if (this.access.mode === 'standalone') return
    const actor = agent === undefined ? undefined : this.identities.get(agent)
    if (actor === undefined) throw new AccessError(403, '工具调用缺少可信用户身份')
    this.access.assert(actor)
  }

  /** Revoke ongoing work without deleting persistent sessions or rebinding another login. */
  revokeInvalid(): void {
    for (const conversation of this.conversations.values()) {
      const actor = this.identities.get(conversation.handle.agent)
      if (actor === undefined) continue
      try { this.access.assert(actor) } catch { this.abort(conversation.id) }
    }
  }

  /** Return a single owner's bounded history page. */
  list(actor: Actor, offset: number, limit: number, query = ''): ConversationSummary[] {
    this.access.assert(actor)
    return this.store.list(actor, offset, limit, query)
  }

  async update(actor: Actor, input: { operation: string; ids: string[]; title?: string; pinned?: boolean }): Promise<void> {
    this.access.assert(actor)
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || input.ids.some(id => typeof id !== 'string') || new Set(input.ids).size !== input.ids.length) throw new AccessError(400, '对话操作无效')
    for (const id of input.ids) this.validateId(id)
    if (input.operation === 'delete') {
      const result = await this.management().remove(actor, input.ids)
      if (result.results.some(item => item.status === 'failed' || item.status === 'blocked')) throw new AccessError(409, '部分会话未移除，请在会话管理中查看并重试')
      return
    }
    for (const id of input.ids) {
      this.store.assertOwner(id, actor)
      if (this.conversations.get(id)?.active || this.openings.has(id) || this.forks.has(id)) throw new AccessError(409, '请等待回答完成或先停止')
    }
    this.store.mutate(actor, input)
  }

  /** Read the durable in-memory log of an active or resumed conversation. */
  events(conversation: Conversation): readonly SessionEvent[] {
    return conversation.handle.agent.session.snapshotEvents()
  }

  /** Stop every owned Agent before this plugin unloads. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stopTitles()
    await Promise.allSettled([...this.openings.values()])
    const handles = [...this.conversations.values()].map(conversation => conversation.handle)
    this.conversations.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
    this.store.close()
  }
}
