/** Optional, owner-scoped conversation management over the host event bus. */
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { AccessError, isAccessError, type Actor } from './access.ts'

export interface ConversationQuery { offset: number; limit: number; q: string; from?: number | undefined; to?: number | undefined; state: string }
export interface ConversationRecord { id: string; title: string; updatedAt: number; deletedAt: number | null; removalState: string }
export interface ManagedConversation { id: string; title: string; updatedAt: number; state: string; canRemove: boolean; blockedReason?: string }
export interface ConversationPage { items: ManagedConversation[]; total: number; nextOffset: number | null }
export interface PreviewMessage { role: 'user' | 'assistant' | 'tool'; text: string; reasoning?: string; time?: number; truncated?: boolean }
export interface ConversationPreview { messages: PreviewMessage[]; previousBefore: number | null; total: number }
export interface RemovalResult { id: string; status: 'removed' | 'alreadyRemoved' | 'blocked' | 'failed'; message?: string }
export interface ConversationProvider {
  readonly protocol: 1
  readonly pluginId: string
  list(actor: Actor, query: ConversationQuery): Promise<ConversationPage>
  preview(actor: Actor, id: string, before?: number): Promise<ConversationPreview>
  remove(actor: Actor, ids: string[]): Promise<{ results: RemovalResult[] }>
}
declare module '@deepseek-ai/cordis' {
  interface Events { 'ecosystem/conversations': (accept: (provider: ConversationProvider) => void) => void }
}
export function conversationProviders(ctx: Context): Map<string, ConversationProvider> {
  const result = new Map<string, ConversationProvider>()
  ctx.root.emit('ecosystem/conversations', provider => {
    if (provider.protocol !== 1 || result.has(provider.pluginId)) throw new AccessError(503, '会话管理协议不兼容或插件重复登记')
    result.set(provider.pluginId, provider)
  })
  return result
}
export function registerConversations(ctx: Context, provider: ConversationProvider): () => void {
  if (conversationProviders(ctx).has(provider.pluginId)) throw new Error('会话管理插件重复登记')
  return ctx.on('ecosystem/conversations', accept => accept(provider), { global: true })
}
export function conversationQuery(params: URLSearchParams): ConversationQuery {
  const number = (key: string, fallback?: number) => {
    const raw = params.get(key)
    if (raw === null) return fallback
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AccessError(400, '会话查询参数无效')
    return Number(raw)
  }
  const query = { offset: number('offset', 0)!, limit: number('limit', 30)!, q: (params.get('q') ?? '').trim(), from: number('from'), to: number('to'), state: params.get('state') ?? '' }
  if (query.limit < 1 || query.limit > 100 || query.q.length > 120 || !['', 'ready', 'busy', 'legacy', 'pending', 'failed'].includes(query.state)
    || (query.from !== undefined && query.to !== undefined && query.from >= query.to)) throw new AccessError(400, '会话查询参数无效')
  return query
}
export function conversationIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id))) throw new AccessError(400, '请选择 1–100 条不同的有效会话')
  return value as string[]
}

/** The host stays external. Older hosts without the official registry cannot silently soft-delete. */
export function conversationArchive(ctx: Context): { readonly archivedSessionIds: readonly string[]; archiveSession(id: string): Promise<void> } {
  const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[]; archiveSession?: (id: string) => Promise<void> } | undefined
  if (!registry || !Array.isArray(registry.archivedSessionIds) || typeof registry.archiveSession !== 'function') throw new AccessError(503, '当前宿主未提供官方会话归档能力')
  return registry as ReturnType<typeof conversationArchive>
}

/** Source SQL is a plugin-owned constant projecting the normalized columns, already scoped by owner. */
export function queryConversationIndex(db: DatabaseSync, source: string, values: SQLInputValue[], query: ConversationQuery,
  archived: readonly string[], busy: readonly string[]): ConversationPage {
  const sql = `WITH owned AS (${source}), visible AS (
    SELECT *, CASE WHEN removalState='pending' THEN 'pending' WHEN removalState='failed' THEN 'failed'
      WHEN id IN (SELECT value FROM json_each(?)) THEN 'busy' WHEN deletedAt IS NOT NULL THEN 'legacy' ELSE 'ready' END AS state
    FROM owned WHERE removalState!='removed' AND NOT (deletedAt IS NOT NULL AND removalState='' AND id IN (SELECT value FROM json_each(?)))
  ), filtered AS (SELECT * FROM visible WHERE (instr(lower(title),lower(?))>0 OR instr(lower(id),lower(?))>0)
    AND (? IS NULL OR updatedAt>=?) AND (? IS NULL OR updatedAt<?) AND (?='' OR state=?))`
  const args: SQLInputValue[] = [...values, JSON.stringify(busy), JSON.stringify(archived), query.q, query.q,
    query.from ?? null, query.from ?? null, query.to ?? null, query.to ?? null, query.state, query.state]
  const total = Number(db.prepare(sql + ' SELECT count(*) AS total FROM filtered').get(...args)!.total)
  const rows = db.prepare(sql + ' SELECT id,title,updatedAt,state FROM filtered ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?').all(...args, query.limit, query.offset)
  const items = rows.map(row => ({ ...row, canRemove: row.state !== 'busy' && row.state !== 'pending',
    ...(row.state === 'busy' ? { blockedReason: '会话正在运行或有未完成操作，请先处理或等待完成' } : {}) })) as unknown as ManagedConversation[]
  return { items, total, nextOffset: query.offset + items.length < total ? query.offset + items.length : null }
}

export interface ConversationRemovalStore {
  record(actor: Actor, id: string): ConversationRecord
  mark(actor: Actor, id: string, state: 'pending' | 'failed' | 'removed'): void
}
/** Includes host-driven work, which can outlive a plugin HTTP stream. */
export function hostConversationBusy(ctx: Context, id: string): boolean {
  type LiveAgent = { id: string; status?: string; session?: unknown }
  const agents = ctx.get('agents') as { get?: (id: string) => LiveAgent | undefined; list?: () => LiveAgent[]; isOwnedBy?: (id: string, owner: LiveAgent) => boolean } | undefined
  const agent = agents?.get?.(id)
  const projections = ctx.get('sessionProjections') as { stateOf(session: unknown, key: string): { active?: unknown[] } | undefined } | undefined
  return agent !== undefined && (agent.status !== 'idle' || !!agents?.list?.().some(child => agents.isOwnedBy?.(child.id, agent))
    || !!(agent.session && projections?.stateOf(agent.session, 'schedule')?.active?.length))
}
export function hostBusyConversationIds(ctx: Context): string[] {
  const agents = ctx.get('agents') as { list?: () => { id: string }[] } | undefined
  return (agents?.list?.() ?? []).filter(agent => hostConversationBusy(ctx, agent.id)).map(agent => agent.id)
}
/** Read the official registered projection; never maintain a second schedule parser. */
function assertNoSchedules(ctx: Context, { events, header, inheritedEventCount = 0 }: ConversationSnapshot): void {
  if (!events.some(event => (event as { type?: string }).type === 'schedule/change')) return
  const projections = ctx.get('sessionProjections') as { restore(checkpoint: object, events: readonly unknown[], baseSeq: number, header: unknown, inherited: number): { checkpoint: { schedule?: { val: { active: unknown[] } } } } } | undefined
  const state = header && projections?.restore({}, events, 0, header, inheritedEventCount).checkpoint.schedule?.val
  if (!state || !Array.isArray(state.active)) throw new AccessError(503, '无法核验定时任务，请在官方控制台处理后重试')
  if (state.active.length) throw new AccessError(409, '会话仍有定时任务，请先在官方控制台处理')
}
/** One removal implementation; its durable pending marker fences every plugin's send/resume/fork paths. */
export function conversationRemover(ctx: Context, options: {
  assert(actor: Actor): void; store: ConversationRemovalStore; busy(id: string): boolean; release(id: string): Promise<void>
  inspect?(actor: Actor, id: string): Promise<void>
}) {
  const removing = new Set<string>()
  return async (actor: Actor, input: string[]): Promise<{ results: RemovalResult[] }> => {
    const ids = conversationIds(input)
    options.assert(actor)
    const archive = conversationArchive(ctx)
    const results: RemovalResult[] = []
    for (const id of ids) {
      let accepted = false
      try {
        options.assert(actor)
        const record = options.store.record(actor, id)
        if (record.removalState === 'removed' || (record.deletedAt !== null && !record.removalState && archive.archivedSessionIds.includes(id))) {
          results.push({ id, status: 'alreadyRemoved' }); continue
        }
        if (removing.has(id) || options.busy(id) || hostConversationBusy(ctx, id)) throw new AccessError(409, '会话正在运行或有未完成操作，请先处理或等待完成')
        const snapshot = await readConversationSnapshot(ctx, id)
        assertNoSchedules(ctx, snapshot)
        await options.inspect?.(actor, id)
        options.assert(actor)
        options.store.record(actor, id)
        if (removing.has(id) || options.busy(id) || hostConversationBusy(ctx, id)) throw new AccessError(409, '会话状态已变化，请刷新后重试')
        options.store.mark(actor, id, 'pending')
        removing.add(id)
        accepted = true
        await options.release(id)
        options.assert(actor)
        // The host checks identity and persistence; a storage error is never treated as a missing log.
        await archive.archiveSession(id)
        options.assert(actor)
        options.store.mark(actor, id, 'removed')
        results.push({ id, status: 'removed' })
      } catch (error) {
        if (accepted) { try { options.store.mark(actor, id, 'failed') } catch { /* The persisted pending marker remains recoverable. */ } }
        results.push({ id, status: isAccessError(error) && error.status === 409 ? 'blocked' : 'failed',
          message: isAccessError(error) ? error.message : '移除未完成，请刷新后重试' })
      } finally { if (accepted) removing.delete(id) }
    }
    return { results }
  }
}

/** A read handle never creates, resumes, follows up, touches titles, or updates plugin history. */
export async function readConversationEvents(ctx: Context, id: string): Promise<readonly unknown[]> {
  return (await readConversationSnapshot(ctx, id)).events
}
interface ConversationSnapshot { events: readonly unknown[]; header?: { id?: string }; inheritedEventCount?: number }
export async function readConversationSnapshot(ctx: Context, id: string): Promise<ConversationSnapshot> {
  const persistence = ctx.get('sessionPersistence') as {
    inspect?: (id: string) => Promise<ConversationSnapshot>
    open?: (id: string, access: 'read') => Promise<{ header?: { id?: string }; inheritedEventCount?: number; read(): Promise<{ events: readonly unknown[] }>; close(): Promise<void> }>
  } | undefined
  if (persistence?.inspect) return await persistence.inspect(id)
  if (!persistence?.open) throw new AccessError(503, '当前宿主不支持只读会话预览')
  const handle = await persistence.open(id, 'read')
  try {
    if (handle.header?.id !== undefined && String(handle.header.id) !== id) throw new AccessError(409, '会话持久化标识不匹配')
    const { events } = await handle.read()
    if (!Array.isArray(events)) throw new AccessError(503, '宿主返回了不兼容的会话读取结果')
    return { events, ...(handle.header ? { header: handle.header } : {}), inheritedEventCount: handle.inheritedEventCount ?? 0 }
  } finally { await handle.close() }
}

export function previewPage(messages: PreviewMessage[], before?: number): ConversationPreview {
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0 || before > messages.length)) throw new AccessError(400, '预览分页已变化，请重新打开')
  const end = before ?? messages.length, start = Math.max(0, end - 30)
  return { messages: messages.slice(start, end).map(message => ({ ...message, text: message.text.slice(0, 64000),
    ...(message.reasoning ? { reasoning: message.reasoning.slice(0, 64000) } : {}),
    ...(message.text.length > 64000 || (message.reasoning?.length ?? 0) > 64000 ? { truncated: true } : {}) })), previousBefore: start || null, total: messages.length }
}
