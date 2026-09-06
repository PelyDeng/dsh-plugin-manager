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
import { AccessError, type Access, type Actor } from '@dsh-plugin/plugin-kit'
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

/** Creates or resumes namespaced business Agents and owns their handles. */
export class ConversationManager {
  private readonly conversations = new Map<string, Conversation>()
  private readonly openings = new Map<string, Promise<Conversation | undefined>>()
  private pendingOpens = 0
  private disposed = false
  private readonly identities = new WeakMap<object, Actor>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly persona: string,
    private readonly toolNames: readonly string[],
    private readonly access: Access,
    private readonly store: ConversationStore,
  ) {}

  /** Create a fresh namespaced conversation id. */
  createId(): string {
    return `closedoff-web-${randomUUID()}`
  }

  /** Validate that a browser-supplied id cannot address another DSH session. */
  validateId(value: string): string {
    if (!SESSION_ID.test(value)) throw new AccessError(400, 'conversationId is not a closed-off business session id')
    return value
  }

  private setup(agentCtx: Context): void {
    agentCtx.systemPrompt.section({
      name: 'closedoff-assistant:persona',
      order: 600,
      text: this.persona,
    })
    agentCtx.tools.restrict({ allow: [...this.toolNames] })
  }

  private options() {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: ReasoningEffortId(this.config.reasoningEffort),
    }
  }

  private publish(id: string, handle: AgentHandle): Conversation {
    const conversation = { id, handle, lastUsedAt: Date.now(), active: false }
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
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: process.cwd() },
        agentOptions: this.options(),
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
      return this.publish(id, handle)
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
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions: this.options(),
        setup: agentCtx => this.setup(agentCtx),
      })
      if (this.disposed) throw new Error('conversation manager is disposed')
      this.access.assert(actor)
      this.pendingOpens -= 1
      reserved = false
      const conversation = this.publish(id, handle)
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

  /** Add one user message to an active business Agent. */
  followup(conversation: Conversation, text: string, actor: Actor): void {
    this.access.assert(actor)
    this.store.assertOwner(conversation.id, actor)
    if (conversation.active) throw new AccessError(409, '智能体正在回答上一条问题')
    this.identities.set(conversation.handle.agent, actor)
    conversation.lastUsedAt = Date.now()
    conversation.active = true
    try {
      conversation.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      this.store.touch(conversation.id, text)
    } catch (error: unknown) {
      conversation.active = false
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
    let reserved = true
    try {
      await evicted?.dispose()
      this.access.assert(actor)
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(id),
        seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: { cwd: process.cwd(), parentSession: SessionId(conversation.id), isSeeded: true },
        agentOptions: this.options(),
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
      return this.publish(id, handle)
    } finally {
      if (reserved) this.pendingOpens -= 1
    }
  }

  /** Mark a finished or disconnected turn as eligible for LRU eviction. */
  finish(id: string): void {
    const conversation = this.conversations.get(id)
    if (conversation === undefined) return
    conversation.active = false
    conversation.lastUsedAt = Date.now()
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
  list(actor: Actor, offset: number, limit: number): ConversationSummary[] {
    this.access.assert(actor)
    return this.store.list(actor, offset, limit)
  }

  /** Read the durable in-memory log of an active or resumed conversation. */
  events(conversation: Conversation): readonly SessionEvent[] {
    return conversation.handle.agent.session.snapshotEvents()
  }

  /** Stop every owned Agent before this plugin unloads. */
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.openings.values()])
    const handles = [...this.conversations.values()].map(conversation => conversation.handle)
    this.conversations.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
    this.store.close()
  }
}
