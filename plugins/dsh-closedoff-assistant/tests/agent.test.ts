import { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { ConversationManager } from '../src/agent.ts'
import { ConversationStore } from '../src/conversation-store.ts'
import { Config } from '../src/config.ts'
import { inject } from '../src/index.ts'

const alice: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-1' }
const otherLogin: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-2' }
const bob: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-1' }
const local: Actor = { namespace: 'standalone', userId: 'local' }
const unknownId = 'closedoff-web-01234567-89ab-4cde-8fab-0123456789ab'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

function handle(events: unknown[] = []) {
  return { agent: { followup: vi.fn(), cancel: vi.fn(), session: { snapshotEvents: () => events } }, dispose: vi.fn(async () => undefined) }
}
function fixture(max = 2, store = new ConversationStore(':memory:')) {
  const revoked = new Set<string>()
  const access: Access = { mode: 'authenticated', ready: () => {}, resolve: () => alice, assert: actor => {
    if (actor.namespace === 'user' && revoked.has(actor.sessionId)) throw new AccessError(401, '已退出登录')
  } }
  const create = vi.fn(async (_options: unknown) => handle())
  const resume = vi.fn(async (_options: unknown): Promise<ReturnType<typeof handle>> => {
    throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' })
  })
  const defaults = { currentSelection: () => ({ provider: 'deepseek', model: 'test' }) }
  const services: Record<string, unknown> = {
    agentDefaultModel: defaults,
    sessionPersistence: { async open(id: string) { const result = create.mock.calls.findIndex(([options]) => (options as {sessionId:string}).sessionId === id); const current=result < 0 ? undefined : await create.mock.results[result]!.value; return {header:{id},read:async()=>({events:current?.agent.session.snapshotEvents()??[],eventState:"detached"}),close:async()=>{}} } },
    sessionProjections: { restore(_checkpoint:unknown,events:{type:string;data:any}[]) { return {checkpoint:{modelSelection:{val:{pending:null,lastUsed:[...events].reverse().find(event=>event.type==='request/header')?.data.header.config??null}}}} } },
  }
  const ctx = { on: () => () => {}, get: (key: string) => services[key], agentDefaultModel: defaults, llm: {resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low'}]}})}, agents: { create, resume } } as unknown as Context
  const manager = new ConversationManager(ctx, Config({ maxActiveConversations: max } as Config), 'persona', [], access, store)
  cleanup.push(() => manager.dispose())
  return { manager, store, create, resume, revoked, services, defaults }
}

describe('owned business conversation lifecycle', () => {
  it('shares an in-flight removal between the sidebar and central conversation management', async () => {
    const f = fixture(), c = (await f.manager.open(undefined, true, alice))!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const archive = vi.fn(async () => { await gate })
    f.services.workspaceRegistry = { archivedSessionIds: [], archiveSession: archive }
    const pending = f.manager.management().remove(alice, [c.id])
    try {
      await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce())
      await expect(f.manager.update(alice, { operation: 'delete', ids: [c.id] })).rejects.toMatchObject({ status: 409 })
      expect(archive).toHaveBeenCalledOnce()
    } finally { release(); await pending }
    expect(f.store.record(alice, c.id).removalState).toBe('removed')
  })
  it('opens a fresh conversation inside the declared Cordis service scope', async () => {
    const root = new Context(), store = new ConversationStore(':memory:')
    const access: Access = { mode: 'authenticated', ready() {}, resolve: () => alice, assert() {} }
    const create = vi.fn(async () => handle())
    await root.plugin(ctx => {
      for (const key of new Set([...inject, 'llm'])) ctx.provide(key, {})
      ctx.set('agents', { create })
      ctx.set('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'test' }) })
      ctx.set('llm', { resolveCallConfig: async (value: unknown) => value, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }) })
    })
    let manager: ConversationManager
    try {
      await root.plugin({ inject, apply(ctx: Context) { manager = new ConversationManager(ctx, Config({} as Config), 'persona', [], access, store) } })
      const conversation = await manager!.open(undefined, true, alice)
      expect(conversation?.id).toMatch(/^closedoff-web-/)
      expect(create).toHaveBeenCalledOnce()
    } finally { if (manager!) await manager.dispose(); else store.close(); await root.fiber.dispose() }
  })
  it('selects through the official controller only for the owner and while idle', async () => {
    const f=fixture(), selected={provider:'deepseek',model:'second'}
    const selectModel=vi.fn(async (request:unknown)=>{f.defaults.currentSelection=()=>selected;return{selected}})
    f.services.sessionController={modelCatalog:async()=>({groups:[{id:'deepseek',name:'DeepSeek',models:[{id:'second',name:'第二模型'}]}],failures:[]}),selectModel}
    f.services.llm={resolveCallConfig:async(value:unknown)=>value}
    const c=(await f.manager.open(undefined,true,alice))!
    await expect(f.manager.selectModel(c,selected,bob)).rejects.toThrow('无权')
    expect(selectModel).not.toHaveBeenCalled()
    await expect(f.manager.selectModel(c,{provider:'unknown',model:'second'},alice)).rejects.toThrow('目录')
    expect(c.active).toBe(false)
    await f.manager.selectModel(c,selected,alice)
    expect(selectModel).toHaveBeenCalledWith({sessionId:c.id,...selected})
    expect(f.defaults.currentSelection()).toEqual(selected)
    f.manager.followup(c,'hello',alice)
    await expect(f.manager.selectModel(c,selected,alice)).rejects.toThrow('上一条')
    expect(selectModel).toHaveBeenCalledTimes(1)
    await expect(f.manager.models(bob,c.id)).rejects.toThrow('无权')
  })
  it('keeps the recorded model on cold resume and follows the changed default only for a fresh session', async () => {
    const f=fixture(1)
    f.create.mockResolvedValueOnce(handle([{type:'request/header',data:{header:{config:{provider:'deepseek',model:'test',reasoningEffort:'high'}}}}]))
    const first=(await f.manager.open(undefined,true,alice))!
    f.defaults.currentSelection=()=>({provider:'new-provider',model:'new-model'})
    await f.manager.open(undefined,true,alice)
    f.resume.mockResolvedValueOnce(handle())
    await f.manager.open(first.id,false,alice)
    expect(f.create.mock.calls[1]?.[0]).toMatchObject({agentOptions:{provider:'new-provider',model:'new-model'}})
    expect(f.resume.mock.calls[0]?.[0]).toMatchObject({agentOptions:{provider:'deepseek',model:'test',reasoningEffort:'high'}})
  })
  it('previews read-only, fences failed removal and retries official archival without resurrecting history',async()=>{
    const {manager,store,create,resume,services}=fixture()
    const c=(await manager.open(undefined,true,alice))!,id=c.id
    const events=[{type:'user/message',seq:0,time:1000,data:{source:{kind:'user'},content:[{type:'text',text:'预览问题'}]}}]
    let closed=0,fail=true;const archived:string[]=[]
    services.sessionPersistence={async open(_id:string,mode:string){expect(mode).toBe('read');return{header:{id},async read(){return {events,eventState:"detached"}},async close(){closed++}}}}
    services.workspaceRegistry={archivedSessionIds:archived,async archiveSession(value:string){if(fail)throw Error('storage');archived.push(value)}}
    const provider=manager.management(),before=store.record(alice,id)
    expect((await provider.preview(alice,id)).messages).toEqual([{role:'user',text:'预览问题',time:1000}])
    expect(closed).toBe(1);expect(create).toHaveBeenCalledOnce();expect(resume).not.toHaveBeenCalled();expect(store.record(alice,id)).toEqual(before)
    await expect(provider.preview(bob,id)).rejects.toMatchObject({status:404})
    c.active=true;expect((await provider.remove(alice,[id])).results[0]?.status).toBe('blocked');c.active=false
    expect((await provider.remove(alice,[id])).results[0]?.status).toBe('failed')
    await expect(manager.open(id,true,alice)).rejects.toMatchObject({status:404})
    fail=false;expect((await provider.remove(alice,[id])).results[0]?.status).toBe('removed')
    expect((await provider.remove(alice,[id])).results[0]?.status).toBe('alreadyRemoved')
    expect(archived).toEqual([id]);expect(manager.list(alice,0,30)).toEqual([])
  })
  it('rejects foreign namespaces, unknown and unassigned ids instead of claiming them', async () => {
    const { manager, create, resume } = fixture()
    expect(() => manager.validateId('session-other')).toThrow('not a closed-off')
    await expect(manager.open(unknownId, true, alice)).rejects.toMatchObject({ status: 404 })
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })
  it('creates only server ids and rejects other owners before cache access', async () => {
    const { manager, create, resume } = fixture()
    const conversation = (await manager.open(undefined, true, alice))!
    expect(conversation.id).toMatch(/^closedoff-web-/)
    expect(resume).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledOnce()
    await expect(manager.open(conversation.id, false, bob)).rejects.toMatchObject({ status: 404 })
    expect(() => manager.cancel(conversation.id, bob)).toThrow()
    expect(manager.list(bob, 0, 30)).toEqual([])
    expect(manager.list(otherLogin, 0, 30)[0]?.id).toBe(conversation.id)
    await expect(manager.open(conversation.id, false, local)).rejects.toMatchObject({ status: 404 })
  })
  it('does not recreate missing durable history even when ownership exists', async () => {
    const { manager, store, create, resume } = fixture()
    store.reserve(unknownId, alice)
    store.publish(unknownId)
    await expect(manager.open(unknownId, true, alice)).resolves.toBeUndefined()
    expect(resume).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })
  it('evicts only an idle handle while retaining owner history', async () => {
    const { manager, create } = fixture()
    const first = (await manager.open(undefined, true, alice))!
    const second = (await manager.open(undefined, true, alice))!
    first.lastUsedAt = 1
    second.lastUsedAt = 2
    await manager.open(undefined, true, alice)
    expect((await create.mock.results[0]!.value).dispose).toHaveBeenCalledOnce()
    expect((await create.mock.results[1]!.value).dispose).not.toHaveBeenCalled()
    expect(manager.list(alice, 0, 30)).toHaveLength(3)
  })
  it('reserves capacity before concurrent creations complete', async () => {
    const { manager } = fixture(1)
    const first = manager.open(undefined, true, alice)
    await expect(manager.open(undefined, true, bob)).rejects.toThrow('active conversation limit 1')
    await expect(first).resolves.toBeDefined()
  })
  it('checks ownership before sharing an in-flight resume promise', async () => {
    const { manager, store, resume } = fixture()
    store.reserve(unknownId, alice)
    store.publish(unknownId)
    let release!: (value: ReturnType<typeof handle>) => void
    resume.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = manager.open(unknownId, false, alice)
    await expect(manager.open(unknownId, false, bob)).rejects.toMatchObject({ status: 404 })
    release(handle())
    await expect(pending).resolves.toBeDefined()
  })
  it('reserves capacity before restoring distinct durable Agents', async () => {
    const { manager, store, resume } = fixture(1)
    const secondId = unknownId.replace('01234567', '11234567')
    for (const id of [unknownId, secondId]) { store.reserve(id, alice); store.publish(id) }
    let release!: (value: ReturnType<typeof handle>) => void
    resume.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = manager.open(unknownId, false, alice)
    await expect(manager.open(secondId, false, alice)).rejects.toThrow('active conversation limit 1')
    expect(resume).toHaveBeenCalledOnce()
    release(handle())
    await expect(pending).resolves.toBeDefined()
  })
  it('does not rebind an active Agent to a different login session', async () => {
    const { manager, revoked } = fixture()
    const conversation = (await manager.open(undefined, true, alice))!
    manager.followup(conversation, 'first', alice)
    await manager.open(conversation.id, false, otherLogin)
    expect(() => manager.followup(conversation, 'second', otherLogin)).toThrow('上一条')
    revoked.add('alice-1')
    expect(() => manager.authorizeAgent(conversation.handle.agent)).toThrow('已退出')
    manager.revokeInvalid()
    expect(conversation.handle.agent.cancel).toHaveBeenCalledOnce()
    manager.finish(conversation.id)
    manager.followup(conversation, 'new turn', otherLogin)
    expect(() => manager.authorizeAgent(conversation.handle.agent)).not.toThrow()
    expect(() => manager.authorizeAgent(undefined)).toThrow('可信用户')
    expect(() => manager.authorizeAgent({})).toThrow('可信用户')
  })
  it('disposes an Agent created during revocation without publishing history', async () => {
    const { manager, create, revoked, store } = fixture()
    const delayed = handle()
    let release!: (value: ReturnType<typeof handle>) => void
    create.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = manager.open(undefined, true, alice)
    const rejected = expect(pending).rejects.toMatchObject({ status: 401 })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    revoked.add('alice-1')
    release(delayed)
    await rejected
    expect(delayed.dispose).toHaveBeenCalledOnce()
    expect(store.list(alice, 0, 30)).toEqual([])
  })
  it('disposes a handle created during plugin unloading', async () => {
    const { manager, create } = fixture()
    const delayed = handle()
    let release!: (value: ReturnType<typeof handle>) => void
    create.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = manager.open(undefined, true, alice)
    const rejected = expect(pending).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const closing = manager.dispose()
    cleanup.pop()
    release(delayed)
    await rejected
    await closing
    expect(delayed.dispose).toHaveBeenCalledOnce()
  })
  it('disposes an unpublished Agent when ownership publication fails', async () => {
    const { manager, create, store } = fixture(1)
    const publish = vi.spyOn(store, 'publish').mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(manager.open(undefined, true, alice)).rejects.toThrow('disk full')
    expect((await create.mock.results[0]!.value).dispose).toHaveBeenCalledOnce()
    expect(store.list(alice, 0, 30)).toEqual([])
    publish.mockRestore()
    await expect(manager.open(undefined, true, alice)).resolves.toBeDefined()
  })
  it('branches only a completed turn and persists the source owner', async () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: '查询' }] } } },
      { type: 'turn/end', seq: 2, time: 3, data: { reason: { kind: 'completed' } } },
      { type: 'turn/end', seq: 3, time: 4, data: { reason: { kind: 'aborted' } } },
    ]
    const { manager, create } = fixture()
    create.mockResolvedValueOnce(handle(events))
    const source = (await manager.open(undefined, true, alice))!
    await expect(manager.fork(source, SessionSeq(2), bob)).rejects.toMatchObject({ status: 404 })
    await expect(manager.fork(source, SessionSeq(3), alice)).rejects.toThrow('completed turn')
    const child = await manager.fork(source, SessionSeq(2), alice)
    expect(child.id).not.toBe(source.id)
    expect(manager.list(alice, 0, 30)).toHaveLength(2)
    await expect(manager.open(child.id, false, bob)).rejects.toMatchObject({ status: 404 })
    expect(create.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ inheritedEventCount: 3 }))
  })
  it('disposes an unpublished branch when ownership publication fails', async () => {
    const { manager, create, store } = fixture()
    create.mockResolvedValueOnce(handle([{ type: 'turn/end', seq: 0, time: 1, data: { reason: { kind: 'completed' } } }]))
    const source = (await manager.open(undefined, true, alice))!
    vi.spyOn(store, 'publish').mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(manager.fork(source, SessionSeq(0), alice)).rejects.toThrow('disk full')
    expect((await create.mock.results[1]!.value).dispose).toHaveBeenCalledOnce()
    expect(store.list(alice, 0, 30).map(row => row.id)).toEqual([source.id])
  })
})
