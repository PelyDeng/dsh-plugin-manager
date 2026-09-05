import { afterEach, expect, test } from 'vitest'
import { fixture } from './fixture.mjs'
import { readEvents } from '../web/stream.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtures = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close() })
async function setup(options) { const f = await fixture(options); fixtures.push(f); return f }

test('auth protects page, assets and APIs; missing provider never opens the plugin', async () => {
  const f = await setup()
  expect((await f.request('', undefined, '')).status).toBe(303)
  for (const path of ['/app.js', '/identity', '/chat']) expect((await f.request(path, undefined, '')).status).toBe(401)
  expect((await f.request('/chat', { message: 'hello' }, 'alice', { origin: 'https://foreign.invalid' })).status).toBe(403)
  f.revoked.add('login-a')
  expect((await f.request('', undefined)).status).toBe(403)
  f.removeProvider()
  expect((await f.request('/ready')).status).toBe(503)
  expect((await f.request('/identity')).status).toBe(503)
})

test('standalone works without auth and restricts the Agent to zero tools', async () => {
  const f = await setup({ mode: 'standalone' })
  f.removeProvider()
  expect((await f.request('', undefined, '')).status).toBe(200)
  const response = await f.request('/chat', { message: '你好' }, '')
  const h = f.handles[0]
  expect(h.allowed).toEqual([])
  f.emit(h, 'assistant/chunk', { chunk: { type: 'text-delta', text: '你' } })
  f.emit(h, 'assistant/chunk', { chunk: { type: 'text-delta', text: '好' } })
  f.emit(h, 'assistant/message', { message: { content: [{ type: 'text', text: '你好！' }] } })
  f.emit(h, 'turn/end', { reason: { kind: 'completed' } })
  const events = []
  await readEvents(response, event => events.push(event))
  expect(events.map(e => e.type)).toEqual(['session', 'delta', 'delta', 'answer', 'done'])
  expect(events.find(e => e.type === 'answer').text).toBe('你好！')
})

test('followups reuse owned Agent; concurrent, foreign and other-login requests fail', async () => {
  const f = await setup()
  const response = await f.request('/chat', { message: 'first' })
  const h = f.handles[0]
  expect((await f.request('/chat', { message: 'q', conversationId: h.id, userId: 'alice' }, 'bob')).status).toBe(404)
  expect((await f.request('/chat', { message: 'q', conversationId: h.id }, 'other')).status).toBe(409)
  expect((await f.request('/chat', { message: 'q', conversationId: h.id })).status).toBe(409)
  f.emit(h, 'turn/end', { reason: { kind: 'completed' } })
  await response.text()
  const next = await f.request('/chat', { message: 'second', conversationId: h.id })
  expect(f.handles).toHaveLength(1)
  expect(h.messages).toHaveLength(2)
  f.emit(h, 'turn/end', { reason: { kind: 'completed' } })
  await next.text()
})

test('revocation terminates stream, cancels Agent and suppresses late private output', async () => {
  const f = await setup()
  const response = await f.request('/chat', { message: 'q' })
  const h = f.handles[0]
  f.revoked.add('login-a'); f.ctx.emit('ecosystem/revoked', {})
  f.emit(h, 'assistant/chunk', { chunk: { type: 'text-delta', text: 'PRIVATE' } })
  expect(await response.text()).not.toContain('PRIVATE')
  expect(h.cancelled).toBe(true); await expect.poll(() => h.disposed).toBe(true)
})

test('each delta revalidates auth even if a revocation event was missed', async () => {
  const f = await setup()
  const response = await f.request('/chat', { message: 'q' })
  const h = f.handles[0]
  f.revoked.add('login-a')
  f.emit(h, 'assistant/chunk', { chunk: { type: 'text-delta', text: 'PRIVATE' } })
  expect(await response.text()).not.toContain('PRIVATE')
  expect(h.cancelled).toBe(true)
})

test('disconnect cancels model work; invalid input and capacity reject before creating Agents', async () => {
  const f = await setup({ maxConversations: 1, maxMessageChars: 10 })
  for (const data of [{ message: '' }, { message: 'x'.repeat(11) }, { message: 'q', conversationId: '../other' }]) {
    expect((await f.request('/chat', data)).status).toBe(400)
  }
  const response = await f.request('/chat', { message: 'q' })
  expect((await f.request('/chat', { message: 'other' })).status).toBe(429)
  await response.body.cancel()
  await expect.poll(() => f.handles[0].cancelled).toBe(true)
})

test('plugin disposal terminates streams and unregisters every route', async () => {
  const f = await setup()
  const response = await f.request('/chat', { message: 'q' })
  fixtures.splice(fixtures.indexOf(f), 1)
  await f.close()
  await response.text().catch(() => {})
  expect(f.handles[0].disposed).toBe(true)
})

test('SSE decoder survives split Chinese bytes and detects missing terminal event', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"delta","text":"你好"}\n\ndata: {"type":"done"}\n\n')
  const events = []
  const response = new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } }))
  await readEvents(response, event => events.push(event))
  expect(events[0].text).toBe('你好')
  await expect(readEvents(new Response('data: {"type":"delta","text":"partial"}\n\n'), () => {})).rejects.toThrow('连接已中断')
})

test('same-home auth off → on → off → on preserves separate persistent histories and resumes DSH context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-example-history-'))
  const options = { historyPath: join(directory, 'history.sqlite'), logs: new Map() }
  const close = async f => { fixtures.splice(fixtures.indexOf(f), 1); await f.close() }
  async function chat(f, message, id) {
    const response = await f.request('/chat', { message, ...(id ? { conversationId: id } : {}) })
    const h = f.handles.at(-1)
    f.emit(h, 'assistant/message', { message: { content: [{ type: 'text', text: 'answer:' + message }] } })
    f.emit(h, 'turn/end', { reason: { kind: 'completed' } })
    await response.text(); return h.id
  }
  try {
    let f = await setup({ ...options, mode: 'standalone' })
    const sharedId = await chat(f, 'standalone question')
    await close(f)
    f = await setup(options)
    expect((await (await f.request('/conversations')).json()).items).toEqual([])
    expect((await f.request('/history?id=' + sharedId)).status).toBe(404)
    expect((await f.request('/chat', { message: 'steal', conversationId: sharedId })).status).toBe(404)
    const personalId = await chat(f, 'alice question')
    expect((await (await f.request('/conversations', undefined, 'bob')).json()).items).toEqual([])
    expect((await f.request('/history?id=' + personalId, undefined, 'bob')).status).toBe(404)
    expect((await (await f.request('/conversations', undefined, 'other')).json()).items[0].id).toBe(personalId)
    await close(f)
    f = await setup({ ...options, mode: 'standalone' })
    expect((await (await f.request('/conversations')).json()).items.map(i => i.id)).toEqual([sharedId])
    expect((await f.request('/history?id=' + personalId)).status).toBe(404)
    expect((await (await f.request('/history?id=' + sharedId)).json()).messages[0].text).toBe('standalone question')
    await close(f)
    f = await setup(options)
    expect((await (await f.request('/conversations')).json()).items.map(i => i.id)).toEqual([personalId])
    expect((await (await f.request('/history?id=' + personalId)).json()).messages).toHaveLength(2)
    await chat(f, 'followup after restart', personalId)
    expect((await (await f.request('/history?id=' + personalId)).json()).messages.map(m => m.text)).toEqual([
      'alice question', 'answer:alice question', 'followup after restart', 'answer:followup after restart',
    ])
    await close(f)
  } finally { for (const f of fixtures.splice(0)) await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('unload waits for delayed creation and disposes the late Agent', async () => {
  let release, entered = false
  const gate = new Promise(resolve => { release = resolve })
  const f = await setup({ beforeCreate: async () => { entered = true; await gate } })
  const request = f.request('/chat', { message: 'q' }).catch(() => undefined)
  await expect.poll(() => entered).toBe(true)
  fixtures.splice(fixtures.indexOf(f), 1)
  let closed = false
  const closing = f.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(closed).toBe(false)
  release()
  await closing; await request
  expect(f.handles[0].disposed).toBe(true)
})

test('a request waiting for old disposal cannot start a new Agent after unload', async () => {
  let release, disposing = false
  const gate = new Promise(resolve => { release = resolve })
  const f = await setup({ beforeDispose: async () => { disposing = true; await gate } })
  const first = await f.request('/chat', { message: 'q' })
  const id = f.handles[0].id
  await first.body.cancel()
  await expect.poll(() => disposing).toBe(true)
  const next = f.request('/chat', { message: 'retry', conversationId: id }).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 30))
  fixtures.splice(fixtures.indexOf(f), 1)
  const closing = f.close()
  release()
  await closing; await next
  expect(f.handles).toHaveLength(1)
  expect(f.handles[0].disposed).toBe(true)
})

test('disconnect during resume serializes an immediate retry behind the late handle disposal', async () => {
  let release, creates = 0
  const gate = new Promise(resolve => { release = resolve })
  const f = await setup({ beforeCreate: async () => { if (++creates === 2) await gate } })
  const first = await f.request('/chat', { message: 'q' })
  const id = f.handles[0].id
  await first.body.cancel()
  await expect.poll(() => f.handles[0].disposed).toBe(true)
  const controller = new AbortController()
  const delayed = f.request('/chat', { message: 'delayed', conversationId: id }, 'alice', {}, controller.signal).catch(() => undefined)
  await expect.poll(() => creates).toBe(2)
  controller.abort(); await delayed
  const retry = f.request('/chat', { message: 'retry', conversationId: id })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(creates).toBe(2)
  release()
  const response = await retry
  expect(response.status).toBe(200)
  expect(f.handles[1].disposed).toBe(true)
  f.emit(f.handles[2], 'turn/end', { reason: { kind: 'completed' } })
  await response.text()
})
