import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { conversationModel, conversationModelCatalog, requestedConversationModel, selectConversationModel } from '../src/models.ts'

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
    const ctx = new Context(), close = vi.fn(), read = vi.fn(async () => [])
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
})
