import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fixture } from './fixture.mjs'

for (const firstStatus of ['failed', 'waiting']) test(`${firstStatus} 船员同轮重试完成后，解除本轮未完成状态`, async () => {
  let calls = 0
  const f = await fixture({ providers: [{ id: 'closedoff', async run() {
    return { status: ++calls === 1 ? firstStatus : 'completed', conversationId: 'same-owned', text: '阶段结果' }
  } }], model: async ({ assign }) => {
    await assign([{ crew: 'closedoff', message: '首次查询' }])
    await assign([{ crew: 'closedoff', message: '已补充范围，继续完成' }])
    return '本轮已完成。'
  } })
  try {
    const { mission } = await (await f.request('/message', { message: '查询', requestId: randomUUID() })).json()
    assert.equal((await f.settled(mission.id)).mission.state, 'completed')
    assert.equal(calls, 2)
  } finally { await f.close() }
})

test('只问已有进度不会清除此前尚待博客处理的确认', async () => {
  let calls = 0
  const f = await fixture({ providers: [{ id: 'blog', async run() {
    calls++
    return { status: 'waiting', conversationId: 'needs-confirmation', text: '待原生确认' }
  } }], model: async ({ message, assign }) => {
    if (!message.content[0].text.includes('现在等谁')) await assign([{ crew: 'blog', message: '准备保存' }])
    return '仍在等待用户处理。'
  } })
  try {
    const { mission } = await (await f.request('/message', { message: '准备', requestId: randomUUID() })).json()
    assert.equal((await f.settled(mission.id)).mission.state, 'waiting')
    await f.request('/message', { missionId: mission.id, message: '现在等谁', requestId: randomUUID() })
    assert.equal((await f.settled(mission.id)).mission.state, 'waiting')
    assert.equal(calls, 1)
  } finally { await f.close() }
})

test('执行中的补充进入原船长下一步，重复发送不再进入收件箱', async () => {
  const began = Promise.withResolvers(), released = Promise.withResolvers()
  const f = await fixture({ providers: [{ id: 'closedoff', async run(request) {
    began.resolve()
    await released.promise
    return { status: 'completed', conversationId: 'steer-owned', text: '原查询结果' }
  } }], model: async ({ message, assign }) => {
    if (message.content[0].text === '开始查询') await assign([{ crew: 'closedoff', message: '查询' }])
    return '已核对本轮要求。'
  } })
  try {
    const { mission } = await (await f.request('/message', { message: '开始查询', requestId: randomUUID() })).json()
    await began.promise
    const extra = { missionId: mission.id, message: '只整理汇总数据', target: 'closedoff', requestId: randomUUID() }
    assert.equal((await f.request('/message', extra)).status, 202)
    assert.equal((await f.request('/message', extra)).status, 202)
    assert.equal(f.handles.length, 1)
    assert.equal(f.handles[0].messages.length, 2)
    assert.match(f.handles[0].messages[1].content[0].text, /用户向 closedoff 补充交谈：只整理汇总数据/)
    released.resolve()
    const result = await f.settled(mission.id)
    assert.equal(result.events.filter(e => e.role === 'user' && e.text === extra.message).length, 1)
    assert.ok(result.events.some(e => e.text.startsWith('船长开始处理补充要求')))
  } finally { released.resolve(); await f.close() }
})

test('超时立即显示 stopping 和说明，业务实际返回前不伪装已停止', async () => {
  const began = Promise.withResolvers(), released = Promise.withResolvers()
  const f = await fixture({ providers: [{ id: 'closedoff', async run(request) {
    began.resolve(request.signal)
    await released.promise
    return { status: 'completed', conversationId: 'timeout-owned', text: '不应接受的迟到结果' }
  } }], model: async ({ assign }) => { await assign([{ crew: 'closedoff', message: '查询' }]); return '完成' } })
  try {
    const { mission } = await (await f.request('/message', { message: '查询', requestId: randomUUID() })).json()
    const signal = await began.promise
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    const during = await (await f.request('/mission?id=' + mission.id)).json()
    assert.equal(during.mission.state, 'stopping')
    assert.ok(during.events.some(e => e.text.startsWith('协作超时')))
    released.resolve()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, 'failed')
    assert.equal(JSON.stringify(result).includes('不应接受的迟到结果'), false)
  } finally { released.resolve(); await f.close() }
})

test('真实 HTTP 派单按查询结果进入博客，保留原用户并过滤内部推理', async () => {
  const calls = []
  const f = await fixture({
    providers: ['closedoff', 'blog'].map(id => ({ id, async run(request) {
      calls.push({ id, actor: request.actor, message: request.message })
      request.onProgress({ kind: 'status', text: '正在处理', conversationId: id + '-owned' })
      return { status: 'completed', conversationId: id + '-owned', text: id === 'closedoff' ? '受授权的查询摘要' : '内部分析草稿内容' }
    } })),
    model: async ({ assign }) => {
      const first = JSON.parse(await assign([{ crew: 'closedoff', message: '查询授权范围内的记录' }]))
      await assign([{ crew: 'blog', message: '根据摘要整理：' + first[0].text }])
      return '查询与文章内容已完成，未声称实际保存或发布。'
    },
  })
  try {
    const response = await f.request('/message', { message: '查询并整理', requestId: randomUUID() })
    assert.equal(response.status, 202)
    const { mission } = await response.json()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, 'completed')
    assert.deepEqual(calls.map(call => call.id), ['closedoff', 'blog'])
    assert.ok(calls[1].message.includes('受授权的查询摘要'))
    assert.ok(calls.every(call => call.actor === f.actors.alice))
    assert.equal(JSON.stringify(result).includes('内部片段'), false)
    assert.equal(result.crewSessions.length, 2)
    assert.deepEqual(f.handles[0].allowed, ['pirate_assign', 'pirate_topic'])
    assert.equal(f.handles[0].disposed, true)
    assert.equal((await f.request('/mission?id=' + mission.id, undefined, 'bob')).status, 404)
    f.revoked.add('alice-login:blog')
    assert.equal((await f.request('/mission?id=' + mission.id)).status, 403)
  } finally { await f.close() }
})

test('原生确认返回 waiting，重试请求不重复派单', async () => {
  let count = 0
  const f = await fixture({ providers: [{ id: 'blog', async run(request) {
    count++
    return { status: 'waiting', conversationId: 'blog-existing', text: '请在博客确认卡片处理', artifacts: [{ kind: 'confirmation', title: '查看待确认操作', path: '/blog?conversationId=blog-existing' }] }
  } }], model: async ({ assign }) => { await assign([{ crew: 'blog', message: '准备操作' }]); return '等待你处理原生确认。' } })
  try {
    const input = { message: '准备操作', requestId: randomUUID() }
    const { mission } = await (await f.request('/message', input)).json()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, 'waiting')
    assert.ok(result.events.some(event => event.artifact?.kind === 'confirmation'))
    assert.equal((await f.request('/message', input)).status, 202)
    assert.equal(count, 1)
    assert.equal((await f.request('/message', { ...input, message: '换一条任务' })).status, 409)
    assert.equal((await f.request('/message', { ...input, actor: f.actors.bob })).status, 400)
    assert.equal((await f.request('/message', input, 'alice', { origin: 'https://other.invalid' })).status, 403)
    await assert.rejects(f.tools.get('pirate_assign').execute({ tasks: [{ crew: 'blog', message: '绕过入口' }] }, { agent: {}, signal: new AbortController().signal }), { status: 403 })
  } finally { await f.close() }
})

test('停止传递给正在执行的业务插件，实际结束前保持 stopping', async () => {
  let started, release
  const began = new Promise(resolve => { started = resolve })
  const released = new Promise(resolve => { release = resolve })
  const f = await fixture({ providers: [{ id: 'closedoff', async run(request) {
    request.onProgress({ kind: 'status', text: '读取中', conversationId: 'closedoff-wait' })
    started(request.signal)
    await released
    return { status: 'completed', conversationId: 'closedoff-wait', text: '停止后迟到结果，禁止进入记录' }
  } }], model: async ({ assign }) => { await assign([{ crew: 'closedoff', message: '查询' }]); return '不应生成的完成回复' } })
  try {
    const { mission } = await (await f.request('/message', { message: '查询', requestId: randomUUID() })).json()
    const signal = await began
    const stopped = await (await f.request('/stop', { missionId: mission.id })).json()
    assert.equal(signal.aborted, true)
    assert.equal(stopped.mission.state, 'stopping')
    assert.equal((await f.request('/message', { missionId: mission.id, message: '抢先重启', requestId: randomUUID() })).status, 409)
    release()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, 'cancelled')
    assert.equal(JSON.stringify(result).includes('停止后迟到结果'), false)
  } finally { release(); await f.close() }
})

test('独立任务同时启动，局部失败不丢弃另一个船员成果', async () => {
  const started = new Set()
  let release
  const both = new Promise(resolve => { release = resolve })
  const f = await fixture({ providers: ['closedoff', 'blog'].map(id => ({ id, async run(request) {
    started.add(id)
    if (started.size === 2) release()
    await both
    if (id === 'closedoff') throw new Error('测试中断')
    return { status: 'completed', conversationId: 'blog-kept', text: '保留这份独立完成的提纲' }
  } })), model: async ({ assign }) => {
    const results = JSON.parse(await assign([{ crew: 'closedoff', message: '查询' }, { crew: 'blog', message: '准备不依赖查询的空提纲' }]))
    assert.equal(results.find(result => result.crew === 'closedoff').status, 'failed')
    assert.equal(results.find(result => result.crew === 'blog').status, 'completed')
    return '查询失败；提纲保留。'
  } })
  try {
    const { mission } = await (await f.request('/message', { message: '查询，同时准备提纲', requestId: randomUUID() })).json()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, 'partial')
    assert.equal(started.size, 2)
    assert.ok(result.events.some(event => event.text === '保留这份独立完成的提纲'))
  } finally { release(); await f.close() }
})

test('创建 Agent 失败后可明确重试，不把不存在的模型会话当成恢复对象', async () => {
  let attempts = 0
  const f = await fixture({ beforeCreate() { if (++attempts === 1) throw new Error('首次创建失败') } })
  try {
    const { mission } = await (await f.request('/message', { message: '开始', requestId: randomUUID() })).json()
    assert.equal((await f.settled(mission.id)).mission.state, 'failed')
    assert.equal((await f.request('/message', { missionId: mission.id, message: '重试', requestId: randomUUID() })).status, 202)
    assert.equal((await f.settled(mission.id)).mission.state, 'completed')
    assert.equal(f.handles.length, 1)
  } finally { await f.close() }
})

test('船员未返回会话标识便失败，已留存业务摘要仍受原插件撤权约束', async () => {
  const summary = '授权查询得到的业务摘要'
  const f = await fixture({ providers: [{ id: 'closedoff', async run(request) {
    request.onProgress({ kind: 'message', text: summary })
    throw new Error('返回业务会话标识前中断')
  } }], model: async ({ assign }) => {
    await assign([{ crew: 'closedoff', message: '查询授权范围内的记录' }])
    return '查询中断，已收到的摘要保留。'
  } })
  try {
    const response = await f.request('/message', { message: '查询', requestId: randomUUID() })
    assert.equal(response.status, 202)
    const { mission } = await response.json()
    const result = await f.settled(mission.id)
    assert.equal(result.mission.state, 'failed')
    assert.deepEqual(result.crewSessions, [])
    assert.ok(result.events.some(event => event.text === summary))
    f.revoked.add('alice-login:closedoff')
    assert.equal((await f.request('/mission?id=' + mission.id)).status, 403)
  } finally { await f.close() }
})
