import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fixture } from './fixture.mjs'
import { MissionStore } from '../dist/store.mjs'

const topics = value => value.events.filter(event => event.type === 'topic')
const read = async (f, id) => {
  const response = await f.request('/mission?id=' + id)
  assert.equal(response.status, 200)
  return response.json()
}
const submit = async (f, message, missionId) => {
  const response = await f.request('/message', { message, requestId: randomUUID(), ...(missionId ? { missionId } : {}) })
  assert.equal(response.status, 202)
  return (await response.json()).mission
}
const execute = (f, agent, keywords, signal = new AbortController().signal) =>
  f.tools.get('pirate_topic').execute({ keywords }, { agent, signal, callId: randomUUID() })

test('公开主题通过真实工具与 HTTP 历史返回，续轮更新不改变业务状态', async () => {
  const secondPublished = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture({ model: async ({ message, publishTopic }) => {
    await publishTopic(message.content[0].text === '第一轮简单问题' ? ['概念说明'] : ['范围核对', '后续处理'])
    if (message.content[0].text !== '第一轮简单问题') { secondPublished.resolve(); await release.promise }
    return '已公开说明，没有业务派单。'
  } })
  try {
    const mission = await submit(f, '第一轮简单问题')
    const first = await f.settled(mission.id)
    assert.equal(first.mission.state, 'completed')
    assert.deepEqual(topics(first).map(event => ({ role: event.role, text: event.text, stage: event.stage })), [
      { role: 'jack', text: '概念说明', stage: undefined },
    ])
    assert.equal(first.crewSessions.length, 0)
    assert.equal(JSON.stringify(first).includes('内部片段'), false)
    assert.equal((await f.request('/mission?id=' + mission.id, undefined, 'bob')).status, 404)
    await submit(f, '第二轮简单问题', mission.id)
    await secondPublished.promise
    const running = await read(f, mission.id)
    assert.equal(running.mission.state, 'running')
    assert.deepEqual(topics(running).map(event => event.text), ['概念说明', '范围核对 · 后续处理'])
    await assert.rejects(execute(f, f.handles[0].agent, ['旧船长迟到']), { status: 403 })
    assert.equal(topics(await read(f, mission.id)).length, 2)
    release.resolve()
    assert.equal((await f.settled(mission.id)).mission.state, 'completed')
  } finally { release.resolve(); await f.close() }
})

test('主题在运行时验证数量、类型、Unicode 长度和控制字符，规范化后去重', async () => {
  const active = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture({ model: async ({ handle }) => { active.resolve(handle); await release.promise; return '完成' } })
  try {
    const mission = await submit(f, '输入边界')
    const handle = await active.promise
    const initialCount = (await read(f, mission.id)).events.length
    // 官方 defineTool 先拒绝结构错误；数量和文本约束由本插件的运行时检查负责。
    const schemaInvalid = [
      [undefined, 'missing required property "keywords"'],
      [null, '"keywords" must be an array'],
      ['主题', '"keywords" must be an array'],
      [Array(1), '"keywords" must be a dense lossless JSON array'],
      [[1], '"keywords[0]" must be a string'],
      [[null], '"keywords[0]" must be a string'],
    ]
    for (const [keywords, violation] of schemaInvalid) {
      await assert.rejects(execute(f, handle.agent, keywords), { name: 'ToolArgsError', code: 'INVALID_ARGS', message: 'invalid arguments: ' + violation })
      assert.equal((await read(f, mission.id)).events.length, initialCount)
    }
    const invalid = [[], ['一', '二', '三', '四'], [''], ['   '],
      ['123456789'], ['😀'.repeat(9)], ['词\n语'], ['词\t语'], ['\n词'], ['词\u0000语'], ['词\u0085语'],
      ['词\u2028语'], ['词\u2029语'], ['词\u202e语']]
    for (const keywords of invalid) {
      await assert.rejects(execute(f, handle.agent, keywords), { status: 400 })
      assert.equal((await read(f, mission.id)).events.length, initialCount)
    }
    assert.equal(await execute(f, handle.agent, ['  查询  ', '查询', '分析']), '查询 · 分析')
    assert.equal(await execute(f, handle.agent, ['😀'.repeat(8)]), '😀'.repeat(8))
    const current = await read(f, mission.id)
    assert.equal(current.mission.state, 'running')
    assert.deepEqual(topics(current).map(event => event.text), ['查询 · 分析', '😀'.repeat(8)])
  } finally { release.resolve(); await f.close() }
})

test('执行信号取消或陌生 Agent 调用不能写入主题', async () => {
  const active = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture({ model: async ({ handle }) => { active.resolve(handle); await release.promise; return '完成' } })
  try {
    const mission = await submit(f, '工具调用身份')
    const handle = await active.promise
    await assert.rejects(execute(f, {}, ['陌生调用']), { status: 403 })
    await assert.rejects(execute(f, undefined, ['无身份']), { status: 403 })
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(execute(f, handle.agent, ['取消后写入'], cancelled.signal))
    const current = await read(f, mission.id)
    assert.equal(current.mission.state, 'running')
    assert.equal(topics(current).length, 0)
  } finally { release.resolve(); await f.close() }
})

test('任务停止后即使执行信号尚未取消，也不能追加迟到主题', async () => {
  const active = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture({ model: async ({ handle }) => { active.resolve(handle); await release.promise; return '完成' } })
  try {
    const mission = await submit(f, '停止保护')
    const handle = await active.promise
    assert.equal((await f.request('/stop', { missionId: mission.id })).status, 200)
    await assert.rejects(execute(f, handle.agent, ['迟到主题']))
    assert.equal(topics(await read(f, mission.id)).length, 0)
    release.resolve()
    assert.equal((await f.settled(mission.id)).mission.state, 'cancelled')
  } finally { release.resolve(); await f.close() }
})

for (const revokedKey of ['alice-login', 'alice-login:closedoff']) test(`${revokedKey} 撤权后当前 Agent 不能发布主题`, async () => {
  const active = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture({ providers: [{ id: 'closedoff', async run() {
    return { status: 'completed', conversationId: 'topic-permission-check', text: '自造公开结果' }
  } }], model: async ({ handle, assign }) => {
    await assign([{ crew: 'closedoff', message: '自造权限检查' }])
    active.resolve(handle); await release.promise; return '完成'
  } })
  try {
    const mission = await submit(f, '撤权保护')
    const handle = await active.promise
    f.revoked.add(revokedKey)
    await assert.rejects(execute(f, handle.agent, ['越权主题']), { status: 403 })
    assert.equal((await f.request('/mission?id=' + mission.id)).status, 403)
    f.revoked.delete(revokedKey)
    assert.equal(topics(await read(f, mission.id)).length, 0)
  } finally { release.resolve(); await f.close() }
})

test('公开主题复用现有事件存储，旧 runId 无法污染新轮或改变任务状态', () => {
  const actor = { namespace: 'user', userId: 'topic-owner', sessionId: 'topic-login' }
  const store = new MissionStore(':memory:')
  try {
    const first = store.begin(actor, '旧轮')
    assert.equal(store.add(actor, first.id, { type: 'topic', role: 'jack', text: '旧轮主题' }, first.runId), true)
    assert.equal(store.finish(actor, first.id, first.runId, 'completed'), true)
    const second = store.begin(actor, '新轮', first.id)
    assert.equal(store.add(actor, first.id, { type: 'topic', role: 'jack', text: '迟到主题' }, first.runId), false)
    assert.equal(store.add(actor, first.id, { type: 'topic', role: 'jack', text: '当前主题' }, second.runId), true)
    assert.equal(store.get(actor, first.id).state, 'running')
    assert.deepEqual(store.events(actor, first.id).filter(event => event.type === 'topic').map(event => event.text), ['旧轮主题', '当前主题'])
  } finally { store.close() }
})
