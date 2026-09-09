import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { conversationModel, conversationModelCatalog, requestedConversationModel, selectConversationModel, type ConversationModel } from '../src/models.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap { 'model/selection': ConversationModel }
}

describe('conversation model routing', () => {
  it('shares only public catalog fields and delegates a checked selection without client effort injection',async()=>{
    const ctx=new Context(), selected={provider:'p',model:'m'},call=vi.fn(async()=>({selected})),authorize=vi.fn()
    ctx.provide('agentDefaultModel',{currentSelection:()=>selected})
    ctx.provide('sessionController',{modelCatalog:async()=>({groups:[{id:'p',name:'P',secret:'hidden',models:[{id:'m',name:'M',secret:'hidden'}]}],failures:[]}),selectModel:call})
    ctx.provide('llm',{resolveCallConfig:async(v:unknown)=>v})
    expect(JSON.stringify(await conversationModelCatalog(ctx))).not.toContain('hidden')
    expect(await requestedConversationModel(ctx,{...selected,reasoningEffort:'untrusted'})).toEqual(selected)
    await expect(requestedConversationModel(ctx,[])).rejects.toThrow('有效模型')
    await expect(requestedConversationModel(ctx,{provider:'p',model:'absent'})).rejects.toThrow('目录')
    expect(await requestedConversationModel(ctx,undefined)).toBeUndefined()
    expect(await requestedConversationModel(ctx,null)).toEqual(selected)
    await selectConversationModel(ctx,'owned',selected,authorize)
    expect(call).toHaveBeenCalledWith({sessionId:'owned',...selected});expect(authorize).toHaveBeenCalledTimes(2)
    authorize.mockImplementation(()=>{throw Error('revoked')})
    await expect(selectConversationModel(ctx,'foreign',selected,authorize)).rejects.toThrow('revoked')
    expect(call).toHaveBeenCalledTimes(1)
  })
  const original = { provider: 'first', model: 'original', reasoningEffort: 'high' }
  const changed = { provider: 'second', model: 'new' }
  function fixture(state: unknown = { pending: null, lastUsed: original }) {
    const ctx = new Context(), close = vi.fn(), read = vi.fn(async () => ({ events: [], eventState: 'shared-frozen' }))
    const restore = vi.fn(() => ({ checkpoint: { modelSelection: { val: state } } }))
    ctx.provide('agentDefaultModel', { currentSelection: () => changed })
    ctx.provide('sessionPersistence', { open: vi.fn(async () => ({ header: { id: 'owned' }, read, close })) })
    ctx.provide('sessionProjections', { restore })
    return { ctx, close, read, restore }
  }
  it('new sessions follow the live default; cold resumes keep the persisted model and effort', async () => {
    const f = fixture()
    expect(await conversationModel(f.ctx)).toEqual(changed)
    expect(f.read).not.toHaveBeenCalled()
    expect(await conversationModel(f.ctx, 'owned')).toEqual(original)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.restore).toHaveBeenCalledWith({}, [], 0, { id: 'owned' }, 0)
  })
  it('honors explicit official session selection and defaults only for an unused session', async () => {
    expect(await conversationModel(fixture({ pending: original, lastUsed: changed }).ctx, 'owned')).toEqual(original)
    expect(await conversationModel(fixture({ pending: null, lastUsed: null }).ctx, 'owned')).toEqual(changed)
  })
  it('never replaces an unreadable or unregistered old route with the new default', async () => {
    const f = fixture()
    f.read.mockRejectedValueOnce(new Error('storage failure'))
    await expect(conversationModel(f.ctx, 'owned')).rejects.toThrow('storage failure')
    expect(f.close).toHaveBeenCalledOnce()
    await expect(conversationModel(fixture(undefined).ctx, 'foreign')).rejects.toThrow('标识不匹配')
    await expect(conversationModel(fixture(null).ctx, 'owned')).rejects.toThrow('未注册')
  })

  async function selectionFixture() {
    const ctx = new Context(), fiber = await ctx.plugin(SessionStore)
    const owned = ctx.sessions.create(SessionId('owned')), other = ctx.sessions.create(SessionId('other'))
    let selectedDefault: ConversationModel = original
    const resolveCallConfig = vi.fn(async (value: ConversationModel) => value)
    const saveSelection = vi.fn(async (value: ConversationModel) => { selectedDefault = { ...value } })
    ctx.provide('sessionController', { async selectModel({ sessionId, ...requested }: ConversationModel & { sessionId: string }) {
      const selected = await resolveCallConfig(requested)
      // Official commit order, with the installed SessionStore's real pre-commit dispatch.
      ctx.sessions.get(SessionId(sessionId))!.append('model/selection', selected)
      await saveSelection(selected)
      return { selected }
    } })
    return { ctx, fiber, owned, other, resolveCallConfig, saveSelection, defaultSelection: () => selectedDefault }
  }

  it('vetoes a revoked selection after async routing without touching another session or its newer default', async () => {
    const f = await selectionFixture()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    let revoked = false
    const authorize = vi.fn(() => { if (revoked) throw new Error('revoked') })
    f.resolveCallConfig.mockImplementationOnce(async value => { enter(); await released; return value })
    const pending = selectConversationModel(f.ctx, f.owned.id, changed, authorize)
    const rejected = expect(pending).rejects.toThrow()
    try {
      await entered
      revoked = true
      const otherSelection = { provider: 'other', model: 'unrelated' }
      await expect(selectConversationModel(f.ctx, f.other.id, otherSelection, () => {})).resolves.toEqual(otherSelection)
      f.owned.append('turn/start', { turn: 1 })
      const before = f.owned.snapshotEvents()
      release()
      await rejected
      expect(f.owned.snapshotEvents()).toEqual(before)
      expect(f.other.snapshotEvents().map(event => event.data)).toEqual([otherSelection])
      expect(f.saveSelection.mock.calls).toEqual([[otherSelection]])
      expect(f.defaultSelection()).toEqual(otherSelection)
      expect(authorize).toHaveBeenCalledTimes(2)
      expect(() => f.owned.append('model/selection', original)).not.toThrow()
      expect(authorize).toHaveBeenCalledTimes(2)
    } finally { release(); await pending.catch(() => {}); await f.fiber.dispose() }
  })

  it('rechecks at commit and after success, then releases the selection guard', async () => {
    const f = await selectionFixture(), authorize = vi.fn()
    try {
      await expect(selectConversationModel(f.ctx, f.owned.id, changed, authorize)).resolves.toEqual(changed)
      expect(authorize).toHaveBeenCalledTimes(3)
      expect(f.owned.snapshotEvents().map(event => event.data)).toEqual([changed])
      expect(f.saveSelection).toHaveBeenCalledExactlyOnceWith(changed)
      authorize.mockImplementation(() => { throw new Error('revoked later') })
      expect(() => f.owned.append('model/selection', original)).not.toThrow()
      expect(authorize).toHaveBeenCalledTimes(3)
    } finally { await f.fiber.dispose() }
  })

  it('releases the guard when the controller fails before commit', async () => {
    const f = await selectionFixture(), authorize = vi.fn()
    try {
      f.resolveCallConfig.mockRejectedValueOnce(new Error('private provider failure'))
      await expect(selectConversationModel(f.ctx, f.owned.id, changed, authorize)).rejects.toThrow('模型切换失败')
      expect(f.owned.snapshotEvents()).toEqual([])
      expect(f.saveSelection).not.toHaveBeenCalled()
      authorize.mockImplementation(() => { throw new Error('revoked later') })
      expect(() => f.owned.append('model/selection', original)).not.toThrow()
      expect(authorize).toHaveBeenCalledOnce()
    } finally { await f.fiber.dispose() }
  })
})
