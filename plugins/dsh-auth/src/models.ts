/** Administrator access to the host-owned catalog and default selection. */
import type { Context } from '@deepseek-ai/cordis'
import { AccessError } from '@dsh-plugin-manager/plugin-kit/access'
import { conversationModelCatalog, defaultConversationModel, type ConversationModel } from '@dsh-plugin-manager/plugin-kit/models'

export async function conversationModels(ctx: Context) {
  const catalog = await conversationModelCatalog(ctx)
  const defaults = ctx.get('agentDefaultModel') as { saveSelection?: unknown } | undefined
  const settings = ctx.get('settings') as { replace?: unknown } | undefined
  return { ...catalog, writable: typeof defaults?.saveSelection === 'function' && typeof settings?.replace === 'function' }
}

export async function saveConversationModel(ctx: Context, input: Record<string, unknown>, authorize: () => void) {
  if (typeof input.provider !== 'string' || typeof input.model !== 'string' || input.provider.length > 200 || input.model.length > 200) throw new AccessError(400, '请选择有效模型')
  const catalog = await conversationModels(ctx)
  authorize()
  if (!catalog.writable) throw new AccessError(503, '宿主未提供可保存的默认模型设置')
  if (!catalog.groups.some(group => group.id === input.provider && group.models.some(model => model.id === input.model))) throw new AccessError(400, '该模型不在当前宿主目录中，请刷新后重试')
  const llm = ctx.get('llm') as { resolveCallConfig?: (selection: ConversationModel) => Promise<ConversationModel> } | undefined
  if (!llm?.resolveCallConfig) throw new AccessError(503, '宿主未提供模型路由校验')
  try { await llm.resolveCallConfig({ provider: input.provider, model: input.model }) }
  catch { throw new AccessError(400, '模型路由当前不可用，请刷新后重试') }
  authorize()
  const defaults = ctx.get('agentDefaultModel') as { saveSelection(selection: ConversationModel): Promise<void> }
  // A complete selection clears an effort specific to the previous model.
  await defaults.saveSelection({ provider: input.provider, model: input.model })
  authorize()
  const selected = defaultConversationModel(ctx)
  if (selected.provider !== input.provider || selected.model !== input.model) throw new AccessError(409, '默认模型已变化或未保存，请刷新后重试')
  return { selected }
}
