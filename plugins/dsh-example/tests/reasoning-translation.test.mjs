/** Real translation service and in-memory SQLite; only the model stream and login provider are replaced. */
import { afterEach, expect, test, vi } from 'vitest'
import { ReasoningTranslations, reasoningOriginal } from '../src/reasoning-translation.ts'
import { projectHistory } from '../src/history.ts'
import { AccessError, actorKey } from '@dsh-plugin-manager/plugin-kit'
import { createHash } from 'node:crypto'

// The published development SDK predates durable assistant attempts. Keep its
// real message/assembler API; stand in only for this production-only decoder.
vi.mock('@deepseek-ai/dsh-llm', async importOriginal => ({
  ...await importOriginal(),
  expandAssistantStream: stream => stream.frames,
}))

const ORIGINAL = 'Read the original source carefully, preserve the meaning, and verify every important detail.'
const CHINESE = '仔细阅读原始资料，保留原意，并核对每个重要细节。'
const usage = { inputTokens: 31, outputTokens: 18, cacheReadTokens: 7, totalTokens: 56, reasoningTokens: 0 }
const alice = { namespace: 'user', userId: 'alice', sessionId: 'login-a' }
const otherLogin = { ...alice, sessionId: 'login-b' }
const bob = { namespace: 'user', userId: 'bob', sessionId: 'login-c' }
const target = { conversationId: 'example-fixture', sourceId: 'source-a' }
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const settled = promise => promise.then(value => ({ value }), error => ({ error }))
const success = () => [
  { type: 'text-delta', index: 0, text: CHINESE },
  { type: 'usage', usage },
  { type: 'finish', reason: { kind: 'stop' } },
]
const message = (id, reasoning, extra = {}) => ({
  type: 'assistant/message', seq: id === 'source-a' ? 2 : 4, surfaceOp: 'append',
  data: { message: { id, role: 'assistant', source: { kind: 'model', provider: 'original-provider', model: 'original-model' },
    content: [...reasoning ? [{ type: 'reasoning', text: reasoning }] : [], { type: 'text', text: 'original answer ' + id }] }, ...extra },
})

const fixtures = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close() })
function fixture({ chunks = success(), stream, partial = false } = {}) {
  const listeners = new Map(), calls = [], reads = [], revoked = new Set()
  const sources = new Map([
    ['example-fixture', { owner: actorKey(alice), events: [message('source-a', ORIGINAL, partial ? { interrupted: true } : {})] }],
    ['example-fork', { owner: actorKey(alice), events: [message('source-a', ORIGINAL)] }],
    ['example-bob', { owner: actorKey(bob), events: [message('source-a', ORIGINAL)] }],
  ])
  const access = { assert(actor) { if (revoked.has(actor.sessionId)) throw new AccessError(403, 'access revoked') } }
  const ctx = {
    on(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback) },
    llm: {
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }] } } },
      async *stream(options) {
        calls.push(options)
        if (stream) yield* stream(options)
        else for (const chunk of chunks) yield chunk
      },
    },
  }
  const service = new ReasoningTranslations({
    ctx, pluginId: 'example', path: ':memory:', access,
    selectModel: () => ({ provider: 'configured-provider', model: 'configured-model' }),
    async readOriginal(actor, locator) {
      reads.push({ actor, ...locator })
      const source = sources.get(locator.conversationId)
      if (!source || source.owner !== actorKey(actor)) throw new AccessError(404, 'not owned')
      return reasoningOriginal(source.events, locator.sourceId)
    },
  })
  let closed = false
  const f = { service, sources, calls, reads, revoked,
    run(actor = alice, locator = target, controller = new AbortController()) { return service.translate(actor, locator, controller.signal) },
    revoke(actor) { revoked.add(actor.sessionId); for (const callback of listeners.get('ecosystem/revoked') ?? []) callback({}) },
    async close() { if (!closed) { closed = true; await service.close() } },
  }
  fixtures.push(f)
  return f
}
function gate(signal, release) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    release.then(() => { cleanup(); resolve() })
    if (signal.aborted) abort()
  })
}

test('server-owned source, provider and independent usage are preserved without changing original events', async () => {
  const f = fixture(), before = structuredClone(f.sources.get(target.conversationId).events)
  const result = await f.run()
  expect(result).toMatchObject({ status: 'translated', text: CHINESE, partial: false, cached: false,
    provider: 'configured-provider', model: 'configured-model', usage })
  expect(result.sourceHash).toBe(createHash('sha256').update(ORIGINAL).digest('hex'))
  expect(f.calls).toHaveLength(1)
  const call = f.calls[0]
  expect(call).toMatchObject({ provider: 'configured-provider', model: 'configured-model', tools: [], reasoningEffort: 'off' })
  expect(call.sessionId).toBeUndefined()
  expect(call.purpose).toBeUndefined()
  expect(call.messages).toHaveLength(1)
  expect(call.messages[0].source).toMatchObject({ kind: 'plugin', plugin: 'example' })
  expect(JSON.parse(call.messages[0].content[0].text)).toEqual({ original: ORIGINAL })
  expect(f.sources.get(target.conversationId).events).toEqual(before)
  expect(before[0].data.usage).toBeUndefined()
})

test('cached reads revalidate ownership; cache keys separate owner, fork and exact source hash', async () => {
  const f = fixture()
  await f.run()
  expect((await f.run(otherLogin)).cached).toBe(true)
  expect(f.reads).toHaveLength(2)
  await expect(f.run(bob)).rejects.toMatchObject({ status: 404 })
  await expect(f.run(alice, { ...target, sourceId: 'missing' })).rejects.toMatchObject({ status: 404 })
  expect(f.calls).toHaveLength(1)
  await f.run(alice, { ...target, conversationId: 'example-fork' })
  await f.run(bob, { ...target, conversationId: 'example-bob' })
  expect(f.calls).toHaveLength(3)
  f.sources.get(target.conversationId).events = [message('source-a', ORIGINAL + ' A changed source must not reuse an old translation.')]
  expect((await f.run()).cached).toBe(false)
  expect(f.calls).toHaveLength(4)
  f.revoke(alice)
  await expect(f.run()).rejects.toMatchObject({ status: 403 })
  expect(f.calls).toHaveLength(4)
})

test('same source shares one call and disconnecting one login does not abort the remaining reader', async () => {
  const started = pending(), release = pending()
  const f = fixture({ stream: async function*(options) {
    started.resolve()
    await gate(options.signal, release.promise)
    yield* success()
  } })
  const firstController = new AbortController()
  const first = settled(f.run(alice, target, firstController)), second = f.run(otherLogin)
  await started.promise
  firstController.abort()
  expect((await first).error).toMatchObject({ status: 499 })
  expect(f.calls[0].signal.aborted).toBe(false)
  release.resolve()
  expect((await second).status).toBe('translated')
  expect(f.calls).toHaveLength(1)
})

test('revoking one login leaves another authorized login sharing the same translation running', async () => {
  const started = pending(), release = pending()
  const f = fixture({ stream: async function*(options) {
    started.resolve()
    await gate(options.signal, release.promise)
    yield* success()
  } })
  const first = settled(f.run(alice)), second = f.run(otherLogin)
  await started.promise
  f.revoke(alice)
  expect((await first).error).toMatchObject({ status: 499 })
  expect(f.calls[0].signal.aborted).toBe(false)
  release.resolve()
  expect((await second).text).toBe(CHINESE)
})

test.each(['disconnect', 'revoke', 'close'])('%s cancels the last reader and prevents a successful cached result', async action => {
  const started = pending(), release = pending()
  const f = fixture({ stream: async function*(options) {
    if (f.calls.length === 1) { started.resolve(); await gate(options.signal, release.promise) }
    yield* success()
  } })
  const controller = new AbortController(), result = settled(f.run(alice, target, controller))
  await started.promise
  if (action === 'disconnect') controller.abort()
  if (action === 'revoke') f.revoke(alice)
  if (action === 'close') await f.close()
  expect((await result).error).toBeDefined()
  expect(f.calls[0].signal.aborted).toBe(true)
  if (action !== 'close') {
    await expect.poll(() => f.service.active.size).toBe(0)
    expect((await f.run(otherLogin)).cached).toBe(false)
    expect(f.calls).toHaveLength(2)
  }
})

test.each([
  ['missing finish', [{ type: 'text-delta', index: 0, text: CHINESE }]],
  ['max tokens', [{ type: 'text-delta', index: 0, text: CHINESE }, { type: 'finish', reason: { kind: 'max-tokens' } }]],
  ['error finish', [{ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL', message: 'failure' } } }]],
  ['English output', [{ type: 'text-delta', index: 0, text: ORIGINAL }, { type: 'finish', reason: { kind: 'stop' } }]],
  ['tool call delta', [{ type: 'tool-call-delta', index: 0, id: 'tool-a', name: 'tool', argumentsDelta: '{}' }]],
  ['tool call close', [{ type: 'text-delta', index: 0, text: CHINESE },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'tool-a', name: 'tool', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'stop' } }]],
  ['duplicate finish', [...success(), { type: 'finish', reason: { kind: 'stop' } }]],
])('%s cannot be reported or cached as a successful translation', async (_label, chunks) => {
  const f = fixture({ chunks })
  await expect(f.run()).rejects.toMatchObject({ status: 502 })
  await expect(f.run()).rejects.toMatchObject({ status: 502 })
  expect(f.calls).toHaveLength(2)
})

test('official block-end content is authoritative and can be the only text delivery', async () => {
  const onlyClose = fixture({ chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: CHINESE } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  expect((await onlyClose.run()).text).toBe(CHINESE)
  const authoritative = fixture({ chunks: [
    { type: 'text-delta', index: 0, text: '临时片段' },
    { type: 'block-end', index: 0, block: { type: 'text', text: CHINESE } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  expect((await authoritative.run()).text).toBe(CHINESE)
})

test('Example retained thought A is located independently from final answer B; no fallback to a different source', async () => {
  const events = [message('source-a', ORIGINAL), message('source-b', '')], before = structuredClone(events)
  const projected = projectHistory(events).at(-1)
  expect(projected).toMatchObject({ text: 'original answer source-b', reasoning: ORIGINAL, reasoningSource: 'source-a' })
  expect(reasoningOriginal(events, projected.reasoningSource)).toEqual({ text: ORIGINAL, partial: false })
  expect(reasoningOriginal(events, 'source-b')).toEqual({ text: '', partial: false })
  const f = fixture()
  f.sources.get(target.conversationId).events = events
  await expect(f.run(alice, { ...target, sourceId: 'source-b' })).rejects.toMatchObject({ status: 404 })
  expect(f.calls).toHaveLength(0)
  expect((await f.run()).text).toBe(CHINESE)
  expect(events).toEqual(before)
})

test('saved interrupted messages and attempts return explicitly partial copies without changing the source', async () => {
  const f = fixture({ partial: true })
  expect((await f.run()).partial).toBe(true)
  expect((await f.run()).partial).toBe(true)
  const attempt = { type: 'assistant/attempt', seq: 9, data: { stream: { frames: [
    { chunk: { type: 'reasoning-delta', index: 0, text: ORIGINAL } },
  ] } } }
  const before = structuredClone(attempt)
  f.sources.get(target.conversationId).events.push(attempt)
  expect(reasoningOriginal([attempt], 'attempt-9')).toEqual({ text: ORIGINAL, partial: true })
  const result = await f.run(alice, { ...target, sourceId: 'attempt-9' })
  expect(result).toMatchObject({ status: 'translated', partial: true, text: CHINESE })
  expect(attempt).toEqual(before)
  expect(() => reasoningOriginal([attempt], 'attempt-10')).toThrow()
})

test('the displayed original of an attempt matches the exact authoritative content submitted for translation', () => {
  const attempt = { type: 'assistant/attempt', seq: 12, data: { stream: { frames: [
    { chunk: { type: 'reasoning-delta', index: 0, text: 'Earlier partial thinking.' } },
    { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: ORIGINAL } } },
  ] } } }
  const projected = projectHistory([attempt]).at(-1)
  expect(projected.reasoningSource).toBe('attempt-12')
  expect(projected.reasoning).toBe(reasoningOriginal([attempt], projected.reasoningSource).text)
})

test('native Chinese thoughts do not consume a model request and absent usage stays unknown', async () => {
  const f = fixture({ chunks: success().filter(c => c.type !== 'usage') })
  const translation = await f.run()
  expect(translation.usage).toBeNull()
  f.sources.get(target.conversationId).events = [message('source-a', '先检查资料，再组织中文回答。')]
  expect(await f.run()).toMatchObject({ status: 'native', text: '先检查资料，再组织中文回答。', partial: false })
  expect(f.calls).toHaveLength(1)
})
