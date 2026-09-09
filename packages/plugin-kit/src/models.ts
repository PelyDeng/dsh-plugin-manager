/** Resolve conversation routes from the official default and durable model projection. */
import type { Context } from '@deepseek-ai/cordis'
import { AccessError } from './access.ts'
import { readConversationSnapshot } from './conversations.ts'

export interface ConversationModel { provider: string; model: string; reasoningEffort?: string }

export interface ConversationModelCatalog {
  groups: { id: string; name: string; models: { id: string; name: string }[] }[]
  failures: { id: string; name: string }[]
  selected: ConversationModel
}

/** Auth and business selectors read the same host-owned directory and default. */
export async function conversationModelCatalog(ctx: Context): Promise<ConversationModelCatalog> {
  const controller = ctx.get('sessionController') as { modelCatalog?: () => Promise<ConversationModelCatalog> } | undefined
  if (!controller?.modelCatalog) throw new AccessError(503, '宿主未提供官方模型目录')
  const catalog = await controller.modelCatalog()
  return {
    groups: catalog.groups.map(group => ({ id: group.id, name: group.name, models: group.models.map(model => ({ id: model.id, name: model.name })) })),
    failures: catalog.failures.map(group => ({ id: group.id, name: group.name })),
    selected: defaultConversationModel(ctx),
  }
}

/** undefined inherits the conversation; null explicitly picks the current Auth default. */
export async function requestedConversationModel(ctx: Context, input: unknown): Promise<ConversationModel | undefined> {
  if (input === undefined) return undefined
  if (input !== null && (typeof input !== 'object' || Array.isArray(input)
    || !('provider' in input) || typeof input.provider !== 'string' || !input.provider || input.provider.length > 200
    || !('model' in input) || typeof input.model !== 'string' || !input.model || input.model.length > 200)) throw new AccessError(400, '请选择有效模型')
  const catalog = await conversationModelCatalog(ctx)
  const selected = input === null ? catalog.selected : input as ConversationModel
  if (!catalog.groups.some(group => group.id === selected.provider && group.models.some(model => model.id === selected.model))) throw new AccessError(400, '该模型不在当前目录中，请刷新后重新选择')
  const llm = ctx.get('llm') as { resolveCallConfig?: (value: ConversationModel) => Promise<ConversationModel> } | undefined
  if (!llm?.resolveCallConfig) throw new AccessError(503, '宿主未提供模型路由校验')
  // A concrete switch clears effort inherited from the previous model.
  const selection = { provider: selected.provider, model: selected.model }
  try { await llm.resolveCallConfig(selection) } catch { throw new AccessError(400, '模型路由当前不可用，请重新选择') }
  return selection
}

/** Caller opens its own Agent and holds its busy guard before selecting. The host also attempts to save its default. */
export async function selectConversationModel(ctx: Context, sessionId: string, selected: ConversationModel, authorize: () => void): Promise<ConversationModel> {
  const controller = ctx.get('sessionController') as { selectModel?: (request: ConversationModel & { sessionId: string }) => Promise<{ selected: ConversationModel }> } | undefined
  if (!controller?.selectModel) throw new AccessError(503, '宿主未提供会话模型切换能力')
  authorize()
  const release = ctx.on('internal/dispatch', (mode, name, args) => {
    if (mode !== 'emit' || name !== 'session/event') return
    const [session, event] = args as [{ id: string }, { type: string }]
    // 支持的宿主先调度再提交选择，之后才保存默认模型；此处可在写入前否决。
    if (session.id === sessionId && event.type === 'model/selection') authorize()
  }, { global: true })
  let result
  try { result = await controller.selectModel({ sessionId, ...selected }) }
  catch { throw new AccessError(400, '模型切换失败，请刷新后重试') }
  finally { release() }
  authorize()
  return { ...result.selected }
}

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
