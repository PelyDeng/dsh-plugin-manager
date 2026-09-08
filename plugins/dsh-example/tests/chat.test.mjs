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

test('standalone works without auth and restricts the Agent to shipped public-source tools', async () => {
  const f = await setup({ mode: 'standalone' })
  f.removeProvider()
  expect((await f.request('', undefined, '')).status).toBe(200)
  const response = await f.request('/chat', { message: '你好' }, '')
  const h = f.handles[0]
  expect(h.allowed).toEqual(['example_search_framework', 'example_read_framework'])
  f.emit(h, 'assistant/chunk', { chunk: { type: 'text-delta', text: '你' } })
  f.emit(h, 'assistant/chunk', { chunk: { type: 'text-delta', text: '好' } })
  f.emit(h, 'assistant/message', { message: { content: [{ type: 'text', text: '你好！' }] } })
  f.emit(h, 'turn/end', { reason: { kind: 'completed' } })
  const events = []
  await readEvents(response, event => events.push(event))
  expect(events.map(e => e.type)).toEqual(['session', 'delta', 'delta', 'answer', 'meta', 'done'])
  expect(events.find(e => e.type === 'answer').text).toBe('你好！')
})

test('live runtime frames stream only for the request Agent and stop after revocation', async () => {
  const f = await setup()
  const response = await f.request('/chat', { message: 'first' })
  const agent = f.handles[0].agent
  const frame = text => ({ type: 'chunk', chunk: { type: 'reasoning-delta', text } })
  f.ctx.emit('agent/assistant-stream', { agent: {}, frame: frame('FOREIGN') })
  f.ctx.emit('agent/assistant-stream', { agent, frame: frame('你好') })
  f.revoked.add('login-a')
  f.ctx.emit('agent/assistant-stream', { agent, frame: frame('PRIVATE') })
  const body = await response.text()
  expect(body).toContain('你好')
  expect(body).not.toContain('FOREIGN')
  expect(body).not.toContain('PRIVATE')
  expect(f.handles[0].cancelled).toBe(true)
})

test.each(['legacy', 'live'])('%s reasoning and answer arrive before completion and history keeps them separate', async mode => {
  const f = await setup({ mode: 'standalone' })
  const response = await f.request('/chat', { message: '分步计算' }, '')
  const h = f.handles[0], events = []
  const reading = readEvents(response, event => events.push(event))
  const emit = (type, text) => {
    const chunk = { type, text }
    if (mode === 'live') f.ctx.emit('agent/assistant-stream', { agent: h.agent, frame: { type: 'chunk', chunk } })
    else f.emit(h, 'assistant/chunk', { chunk })
  }
  emit('reasoning-delta', '先分析'); emit('reasoning-delta', '条件。')
  await expect.poll(() => events.filter(e => e.type === 'reasoning').map(e => e.text).join('')).toBe('先分析条件。')
  expect(events.some(e => e.type === 'done')).toBe(false)
  emit('text-delta', '答案'); emit('text-delta', '是 2。')
  await expect.poll(() => events.filter(e => e.type === 'delta').map(e => e.text).join('')).toBe('答案是 2。')
  expect(events.some(e => e.type === 'done')).toBe(false)
  f.emit(h, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '先分析条件。' }, { type: 'text', text: '答案是 2。' }] } })
  f.emit(h, 'turn/end', { reason: { kind: 'completed' } })
  await reading
  const history = await (await f.request('/history?id=' + h.id, undefined, '')).json()
  expect(history.messages.at(-1)).toEqual({ role: 'assistant', reasoning: '先分析条件。', text: '答案是 2。' })
})

test('interrupted reasoning-only output remains visible in durable history', async () => {
  const f = await setup({ mode: 'standalone' })
  const response = await f.request('/chat', { message: 'q' }, '')
  const h = f.handles[0]
  f.emit(h, 'assistant/chunk', { chunk: { type: 'reasoning-delta', text: '已分析的部分' } })
  await response.body.cancel()
  await expect.poll(() => h.disposed).toBe(true)
  const history = await (await f.request('/history?id=' + h.id, undefined, '')).json()
  expect(history.messages.at(-1)).toEqual({ role: 'assistant', reasoning: '已分析的部分', text: '' })
})

test('released host inspection API restores persisted history after the Agent closes', async () => {
  const f = await setup({ mode: 'standalone', persistenceApi: 'inspection' })
  const response = await f.request('/chat', { message: '保存历史' })
  const h = f.handles[0]
  f.emit(h, 'assistant/message', { message: { content: [{ type: 'text', text: '已保存回答' }] } })
  await response.body.cancel()
  await expect.poll(() => h.disposed).toBe(true)
  const history = await f.request('/history?id=' + h.id)
  expect(history.status).toBe(200)
  expect((await history.json()).messages.at(-1).text).toBe('已保存回答')
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

test('changing the framework default affects new chats while cold resumes retain their recorded route', async () => {
  const directory=mkdtempSync(join(tmpdir(),'dsh-example-model-')), created=[]
  const options={historyPath:join(directory,'history.sqlite'),logs:new Map(),beforeCreate:async options=>{created.push(options.agentOptions)}}
  let f
  const complete=async id=>{
    const response=await f.request('/chat',{message:'hello',...(id?{conversationId:id}:{})})
    expect(response.status).toBe(200)
    const handle=f.handles.at(-1)
    f.emit(handle,'request/header',{header:{config:created.at(-1)}})
    f.emit(handle,'turn/end',{reason:{kind:'completed'}})
    await response.text();return handle.id
  }
  try {
    f=await setup(options)
    const id=await complete()
    fixtures.splice(fixtures.indexOf(f),1);await f.close()
    f=await setup(options)
    f.ctx.agentDefaultModel.currentSelection=()=>({provider:'new-provider',model:'new-model'})
    await complete(id)
    await complete()
    expect(created.map(({provider,model})=>({provider,model}))).toEqual([
      {provider:'test',model:'test'},{provider:'test',model:'test'},{provider:'new-provider',model:'new-model'},
    ])
  } finally { if(fixtures.includes(f)){fixtures.splice(fixtures.indexOf(f),1);await f.close()}rmSync(directory,{recursive:true,force:true}) }
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
