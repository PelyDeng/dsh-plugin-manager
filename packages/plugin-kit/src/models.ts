/** Resolve conversation routes from the official default and durable model projection. */
import type { Context } from '@deepseek-ai/cordis'
import { AccessError } from './access.ts'
import { readConversationSnapshot } from './conversations.ts'

export interface ConversationModel { provider: string; model: string; reasoningEffort?: string }

export function defaultConversationModel(ctx: Context): ConversationModel {
  const defaults = ctx.get('agentDefaultModel') as { currentSelection?: () => ConversationModel } | undefined
  const selected = defaults?.currentSelection?.()
  if (!selected?.provider || !selected.model) throw new AccessError(503, '宿主未提供对话默认模型')
  return { ...selected }
}

/** Call only after checking conversation ownership; a failed read never switches an existing conversation. */
export async function conversationModel(ctx: Context, id?: string, eventCount?: number): Promise<ConversationModel> {
  if (!id) return defaultConversationModel(ctx)
  const snapshot = await readConversationSnapshot(ctx, id)
  if (eventCount !== undefined && (!Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > snapshot.events.length)) throw new AccessError(409, '会话分支边界已变化')
  const projections = ctx.get('sessionProjections') as {
    restore(checkpoint: object, events: readonly unknown[], baseSeq: number, header: unknown, inherited: number): {
      checkpoint: { modelSelection?: { val: { pending: ConversationModel | null; lastUsed: ConversationModel | null } } }
    }
  } | undefined
  if (!projections) throw new AccessError(503, '宿主未提供会话模型恢复能力')
  const events = eventCount === undefined ? snapshot.events : snapshot.events.slice(0, eventCount)
  const state = projections.restore({}, events, 0, snapshot.header, Math.min(snapshot.inheritedEventCount ?? 0, events.length)).checkpoint.modelSelection?.val
  if (!state) throw new AccessError(503, '宿主未注册会话模型记录')
  const selected = state.pending ?? state.lastUsed
  return selected ? { ...selected } : defaultConversationModel(ctx)
}
