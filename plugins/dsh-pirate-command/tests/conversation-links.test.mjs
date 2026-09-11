import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fixture } from './fixture.mjs'
import { createSceneEventFeed } from '../web/src/scene-events.js'
import { getCompassState } from '../web/src/compass-state.js'

const entry = { kind: 'conversation', title: '查看原插件会话', path: '/custom-agent?conversationId=owned' }
const links = result => result.events.filter(event => event.type === 'artifact')

for (const ending of ['stop', 'failure', 'timeout']) test(`${ending} 保留已核验的原会话入口，不接收迟到链接或伪装完成`, async () => {
  const began = Promise.withResolvers(), released = Promise.withResolvers()
  const f = await fixture({ timeoutMs: ending === 'timeout' ? 1000 : 3000,
    providers: [{ id: 'blog', async run(request) {
      request.onProgress({ kind: 'status', text: '会话已连接', conversationId: 'owned',
        conversationArtifact: { ...entry, internalOnly: '不可转交的额外字段' } })
      began.resolve(request.signal)
      await released.promise
      if (ending === 'failure') throw new Error('业务执行中断')
      assert.throws(() => request.onProgress({ kind: 'status', text: '迟到的进度', conversationId: 'late',
        conversationArtifact: { ...entry, path: '/late' } }))
      return { status: 'completed', conversationId: 'late', text: '迟到的正文', artifacts: [{ ...entry, path: '/late' }] }
    } }], model: async ({ assign }) => { await assign([{ crew: 'blog', message: '查询' }]); return '本轮已收尾。' } })
  try {
    const { mission } = await (await f.request('/message', { message: '查询', requestId: randomUUID() })).json()
    const signal = await began.promise
    const before = await (await f.request('/mission?id=' + mission.id)).json()
    assert.equal(before.mission.state, 'running')
    assert.deepEqual(links(before).map(event => event.artifact), [entry])
    assert.equal(before.crewSessions[0].conversationId, 'owned')
    assert.ok(!before.events.some(event => ['returning', 'waiting'].includes(event.stage)))
    assert.equal(JSON.stringify(before).includes('不可转交的额外字段'), false)
    const feed = createSceneEventFeed()
    feed.push(before.mission, before.events)
    const scene = feed.drain()
    assert.equal(scene.roleStages.elizabeth, 'working')
    assert.equal(scene.replies.elizabeth, undefined)
    assert.equal(scene.phase, 'working')
    assert.equal(getCompassState(before.mission, before.events).phase, 'working')
    if (ending === 'stop') {
      const stopped = await (await f.request('/stop', { missionId: mission.id })).json()
      assert.equal(stopped.mission.state, 'stopping')
    } else if (ending === 'timeout') {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      assert.equal((await (await f.request('/mission?id=' + mission.id)).json()).mission.state, 'stopping')
    }
    released.resolve()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, ending === 'stop' ? 'cancelled' : 'failed')
    assert.deepEqual(links(result).map(event => event.artifact), [entry])
    assert.equal(JSON.stringify(result).includes('迟到的'), false)
    const restored = await (await f.request('/mission?id=' + mission.id)).json()
    assert.deepEqual(links(restored).map(event => event.artifact), [entry])
  } finally { released.resolve(); await f.close() }
})

test('单次派单的重复会话入口去重，保留同路径候选和确认；后续派单与新轮可再展示', async () => {
  let calls = 0
  const oldCallbacks = []
  const f = await fixture({ providers: [{ id: 'blog', async run(request) {
    calls++
    oldCallbacks.push(request.onProgress)
    for (let i = 0; i < 3; i++) request.onProgress({ kind: 'status', text: '读取中', conversationId: 'owned',
      conversationArtifact: { ...entry, title: i ? '重复会话标题' : entry.title } })
    return { status: 'waiting', conversationId: 'owned', text: '请在原插件处理。', artifacts: [entry,
      { ...entry, kind: 'draft', title: '查看候选稿' }, { ...entry, kind: 'confirmation', title: '核对确认操作' }] }
  } }], model: async ({ assign }) => {
    await assign([{ crew: 'blog', message: '整理' }])
    await assign([{ crew: 'blog', message: '补充整理' }])
    return '等待你在原插件处理。'
  } })
  try {
    let id
    for (let round = 1; round <= 2; round++) {
      const { mission } = await (await f.request('/message', { ...(id ? { missionId: id } : {}), message: '整理', requestId: randomUUID() })).json()
      id = mission.id
      const result = await f.settled(id)
      assert.equal(result.mission.state, 'waiting')
      for (const kind of ['conversation', 'draft', 'confirmation']) assert.equal(links(result).filter(event => event.artifact.kind === kind).length, round * 2)
      assert.equal(links(result).some(event => event.text === '重复会话标题'), false)
    }
    assert.equal(calls, 4)
    assert.throws(() => oldCallbacks[0]({ kind: 'status', text: '旧运行追加', conversationId: 'stale', conversationArtifact: { ...entry, path: '/stale' } }))
    assert.equal(JSON.stringify(await (await f.request('/mission?id=' + id)).json()).includes('/stale'), false)
  } finally { await f.close() }
})

test('早期入口在身份、类型与本站路径检查后才落库', async t => {
  const invalid = [
    ['缺少同条会话标识', { conversationId: undefined }],
    ['非字符串会话标识', { conversationId: 3 }],
    ['会话标识过长', { conversationId: 'x'.repeat(161) }],
    ['空白会话标识', { conversationId: ' ' }],
    ['确认操作不能提前作为会话入口', { conversationArtifact: { ...entry, kind: 'confirmation' } }],
    ['非字符串标题', { conversationArtifact: { ...entry, title: 3 } }],
    ['空标题', { conversationArtifact: { ...entry, title: ' ' } }],
    ['空对象', { conversationArtifact: null }],
    ...['https://external.invalid/x', '//external.invalid/x', '/\\external.invalid/x', '/unsafe\npath'].map(path =>
      [path, { conversationArtifact: { ...entry, path } }]),
  ]
  for (const [name, override] of invalid) await t.test(name, async () => {
    const f = await fixture({ providers: [{ id: 'blog', async run(request) {
      request.onProgress({ kind: 'status', text: '不应记录的进度', conversationId: 'owned', conversationArtifact: entry, ...override })
      throw new Error('不应执行到这里')
    } }], model: async ({ assign }) => { await assign([{ crew: 'blog', message: '查询' }]); return '本轮未完成。' } })
    try {
      const { mission } = await (await f.request('/message', { message: '查询', requestId: randomUUID() })).json()
      const result = await f.settled(mission.id)
      assert.equal(result.mission.state, 'failed')
      assert.equal(links(result).length, 0)
      assert.equal(result.crewSessions.length, 0)
      assert.equal(JSON.stringify(result).includes('不应记录的进度'), false)
    } finally { await f.close() }
  })
})

test('最终成果含无效入口时不先发布正文或返回阶段，已核验的早期链接保留', async () => {
  const f = await fixture({ providers: [{ id: 'blog', async run(request) {
    request.onProgress({ kind: 'status', text: '会话已连接', conversationId: 'owned', conversationArtifact: entry })
    return { status: 'completed', conversationId: 'not-accepted', text: '不应先显示的完成正文',
      artifacts: [entry, { ...entry, path: 'https://external.invalid/unsafe' }] }
  } }], model: async ({ assign }) => { await assign([{ crew: 'blog', message: '查询' }]); return '本轮未完成。' } })
  try {
    const { mission } = await (await f.request('/message', { message: '查询', requestId: randomUUID() })).json()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, 'failed')
    assert.deepEqual(links(result).map(event => event.artifact), [entry])
    assert.equal(result.crewSessions[0].conversationId, 'owned')
    assert.equal(result.events.some(event => event.stage === 'returning'), false)
    assert.equal(JSON.stringify(result).includes('不应先显示的完成正文'), false)
  } finally { await f.close() }
})

test('已有原会话链接随原插件撤权隐藏，撤权后的新入口不保存', async () => {
  const began = Promise.withResolvers(), released = Promise.withResolvers()
  const f = await fixture({ providers: [{ id: 'blog', async run(request) {
    request.onProgress({ kind: 'status', text: '连接完成', conversationId: 'owned', conversationArtifact: entry })
    began.resolve()
    await released.promise
    assert.throws(() => request.onProgress({ kind: 'status', text: '撤权后', conversationId: 'forbidden', conversationArtifact: { ...entry, path: '/forbidden' } }))
    return { status: 'completed', conversationId: 'forbidden', text: '禁止的新结果' }
  } }], model: async ({ assign }) => { await assign([{ crew: 'blog', message: '查询' }]); return '结束。' } })
  try {
    const { mission } = await (await f.request('/message', { message: '查询', requestId: randomUUID() })).json()
    await began.promise
    assert.equal((await f.request('/mission?id=' + mission.id, undefined, 'bob')).status, 404)
    f.revoked.add('alice-login:blog')
    assert.equal((await f.request('/mission?id=' + mission.id)).status, 403)
    released.resolve()
    await f.handles[0].agent.whenIdle()
    f.revoked.delete('alice-login:blog')
    const result = await f.settled(mission.id)
    assert.deepEqual(links(result).map(event => event.artifact), [entry])
    assert.equal(JSON.stringify(result).includes('/forbidden'), false)
  } finally { released.resolve(); f.revoked.clear(); await f.close() }
})
