import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { conversationModel } from '../src/models.ts'

describe('conversation model routing', () => {
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
