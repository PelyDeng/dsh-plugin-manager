import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fixture } from './fixture.mjs'

const captain = { provider: 'fixture', model: 'captain' }
const navigator = { provider: 'fixture', model: 'navigator' }
const input = (extra = {}) => ({ message: '说明当前任务', requestId: randomUUID(), ...extra })
async function send(f, extra) {
  const response = await f.request('/message', input(extra))
  assert.equal(response.status, 202)
  const { mission } = await response.json()
  return f.settled(mission.id)
}

test('模型目录复用宿主，仅暴露安全字段，缺登录及越权历史在读取目录前拒绝', async () => {
  const f = await fixture()
  try {
    f.models.groups[0].key = 'fixture-private-value'
    f.models.failures.push({ id: 'offline', name: '不可用供应商', error: 'fixture-private-value' })
    const value = await (await f.request('/models')).json()
    assert.deepEqual(value.default, captain)
    assert.equal(value.selected, null)
    assert.deepEqual(value.failures, [{ id: 'offline', name: '不可用供应商' }])
    assert.equal(JSON.stringify(value).includes('fixture-private-value'), false)
    const { mission } = await send(f)
    let reads = 0
    f.ctx.sessionController.modelCatalog = async () => { reads++; throw new Error('must not read') }
    assert.equal((await f.request('/models', undefined, '')).status, 401)
    assert.equal((await f.request('/models?missionId=' + mission.id, undefined, 'bob')).status, 404)
    assert.equal(reads, 0)
  } finally { await f.close() }
})

test('新协作继承Auth默认，已有会话保留模型，显式切换经官方控制器并更新默认', async () => {
  const f = await fixture()
  try {
    const first = await send(f)
    assert.deepEqual(f.handles.at(-1).selection, captain)
    f.models.selected = navigator
    const catalog = await (await f.request('/models?missionId=' + first.mission.id)).json()
    assert.deepEqual(catalog.default, navigator)
    assert.deepEqual(catalog.selected, captain)
    await send(f, { missionId: first.mission.id })
    assert.deepEqual(f.handles.at(-1).selection, captain)
    await send(f)
    assert.deepEqual(f.handles.at(-1).selection, navigator)
    await send(f, { missionId: first.mission.id, modelSelection: null })
    assert.deepEqual(f.handles.at(-1).selection, navigator)
    assert.equal(f.models.selections.length, 1)
    await send(f, { missionId: first.mission.id, modelSelection: captain })
    assert.deepEqual(f.models.selected, captain)
    assert.deepEqual((await (await f.request('/models?missionId=' + first.mission.id)).json()).selected, captain)
    assert.equal(f.models.selections.length, 2)
  } finally { await f.close() }
})

test('目录外、非法和不可路由的显式模型在接受任务之前拒绝', async () => {
  const f = await fixture()
  try {
    for (const modelSelection of [{ provider: 'other', model: 'captain' }, { provider: 'fixture', model: 'missing' },
      { provider: '', model: 'captain' }, { ...captain, token: 'do-not-forward' }, [], 'captain']) {
      assert.equal((await f.request('/message', input({ modelSelection }))).status, 400)
    }
    f.ctx.llm.resolveCallConfig = async () => { throw new Error('private provider failure') }
    const failed = await f.request('/message', input({ modelSelection: navigator }))
    assert.equal(failed.status, 400)
    assert.equal((await failed.text()).includes('private provider failure'), false)
    assert.equal(f.handles.length, 0)
    assert.deepEqual((await (await f.request('/missions')).json()).missions, [])
  } finally { await f.close() }
})

test('失效默认和历史模型明确失败，不暗中使用其他模型；历史读取失败也不回退', async () => {
  const f = await fixture()
  try {
    const first = await send(f)
    f.models.groups[0].models = [{ id: 'navigator', name: '领航员' }]
    assert.equal((await send(f)).mission.state, 'failed')
    f.models.selected = navigator
    assert.equal((await send(f, { missionId: first.mission.id })).mission.state, 'failed')
    assert.equal(f.handles.length, 1)
    f.ctx.sessionPersistence.open = async () => { throw new Error('history unavailable') }
    assert.equal((await f.request('/models?missionId=' + first.mission.id)).status, 503)
    assert.equal((await send(f, { missionId: first.mission.id })).mission.state, 'failed')
    assert.equal(f.handles.length, 1)
    delete f.ctx.sessionController.modelCatalog
    assert.equal((await f.request('/models')).status, 503)
  } finally { await f.close() }
})

test('目录为空可显示但不执行模型；显式使用失效默认在接受前拒绝', async () => {
  const f = await fixture()
  try {
    f.models.groups = []
    assert.deepEqual((await (await f.request('/models')).json()).groups, [])
    assert.equal((await f.request('/message', input({ modelSelection: null }))).status, 400)
    assert.equal((await send(f)).mission.state, 'failed')
    assert.equal(f.handles.length, 0)
  } finally { await f.close() }
})

test('运行中拒绝显式换模型，补充要求沿用运行模型且只接收一次', async () => {
  const began = Promise.withResolvers(), released = Promise.withResolvers()
  const f = await fixture({ model: async () => { began.resolve(); await released.promise; return '已处理' } })
  try {
    const { mission } = await (await f.request('/message', input())).json()
    await began.promise
    assert.equal((await f.request('/message', input({ missionId: mission.id, modelSelection: navigator }))).status, 409)
    const extra = input({ missionId: mission.id, message: '补充范围' })
    assert.equal((await f.request('/message', extra)).status, 202)
    assert.equal((await f.request('/message', extra)).status, 202)
    released.resolve()
    await f.settled(mission.id)
    assert.equal(f.handles.length, 1)
    assert.equal(f.handles[0].messages.length, 2)
    assert.equal(f.models.selections.length, 0)
  } finally { released.resolve(); await f.close() }
})

test('并发重复提交换模型只创建一次，变更模型不得复用同一个请求号', async () => {
  const released = Promise.withResolvers(), began = Promise.withResolvers()
  const f = await fixture()
  try {
    const catalog = f.ctx.sessionController.modelCatalog
    f.ctx.sessionController.modelCatalog = async () => { began.resolve(); await released.promise; return catalog() }
    const request = input({ modelSelection: navigator })
    const a = f.request('/message', request), b = f.request('/message', request)
    await began.promise; released.resolve()
    const responses = await Promise.all([a, b])
    assert.deepEqual(responses.map(r => r.status), [202, 202])
    const [first, second] = await Promise.all(responses.map(r => r.json()))
    assert.equal(first.mission.id, second.mission.id)
    await f.settled(first.mission.id)
    assert.equal(f.handles.length, 1)
    assert.equal(f.models.selections.length, 1)
    assert.equal((await f.request('/message', { ...request, modelSelection: captain })).status, 409)
    f.models.groups = []
    assert.equal((await f.request('/message', request)).status, 202)
    assert.equal(f.handles.length, 1)
  } finally { released.resolve(); await f.close() }
})

test('等待目录期间撤销身份，读取和切换请求均不返回目录或创建任务', async () => {
  for (const path of ['/models', '/message']) {
    const f = await fixture()
    const began = Promise.withResolvers(), released = Promise.withResolvers()
    try {
      const catalog = f.ctx.sessionController.modelCatalog
      f.ctx.sessionController.modelCatalog = async () => { began.resolve(); await released.promise; return catalog() }
      const pending = f.request(path, path === '/message' ? input({ modelSelection: navigator }) : undefined)
      await began.promise
      f.revoked.add('alice-login'); released.resolve()
      assert.equal((await pending).status, 403)
      assert.equal(f.handles.length, 0)
      assert.equal(f.models.selections.length, 0)
    } finally { released.resolve(); await f.close() }
  }
})

test('官方切换失败或提交前撤权时不发起模型调用，也不写会话选择和默认', async () => {
  for (const revoke of [false, true]) {
    let calls = 0
    const f = await fixture({ model: async () => { calls++; return '不应执行' } })
    try {
      const original = f.ctx.sessionController.selectModel
      f.ctx.sessionController.selectModel = async request => {
        if (revoke) { f.revoked.add('alice-login'); return original(request) }
        throw new Error('private select failure')
      }
      const { mission } = await (await f.request('/message', input({ modelSelection: navigator }))).json()
      if (revoke) {
        await f.handles[0]?.agent.whenIdle()
        assert.equal((await f.request('/mission?id=' + mission.id)).status, 403)
      } else {
        const result = await f.settled(mission.id)
        assert.equal(result.mission.state, 'failed')
        assert.equal(JSON.stringify(result).includes('private select failure'), false)
      }
      assert.equal(calls, 0)
      assert.equal(f.models.selections.length, 0)
      assert.deepEqual(f.models.selected, captain)
    } finally { await f.close() }
  }
})

test('船长选择不混入参与者模型或认证字段，子插件仍收到同一服务端Actor', async () => {
  const requests = []
  const f = await fixture({ providers: ['blog', 'closedoff'].map(id => ({ id, async run(request) {
    requests.push(request)
    return { status: 'completed', conversationId: id + '-own', text: '结果' }
  } })), model: async ({ assign }) => { await assign([{ crew: 'closedoff', message: '查询' }, { crew: 'blog', message: '提纲' }]); return '汇总' } })
  try {
    await send(f, { modelSelection: navigator })
    assert.equal(requests.length, 2)
    for (const request of requests) {
      assert.equal(request.actor, f.actors.alice)
      assert.deepEqual(Object.keys(request).sort(), ['actor', 'message', 'missionId', 'onProgress', 'requestId', 'signal'])
    }
  } finally { await f.close() }
})

test('新会话保留Auth默认的推理强度，恢复待用选择时不被默认覆盖', async () => {
  const f = await fixture()
  try {
    f.models.selected = { ...captain, reasoningEffort: 'high' }
    const first = await send(f)
    assert.deepEqual(f.handles.at(-1).selection, { ...captain, reasoningEffort: 'high' })
    f.models.selected = navigator
    await send(f, { missionId: first.mission.id })
    assert.deepEqual(f.handles.at(-1).selection, { ...captain, reasoningEffort: 'high' })
    f.ctx.sessionProjections.restore = () => ({ checkpoint: { modelSelection: { val: {
      lastUsed: { ...captain, reasoningEffort: 'low' }, pending: { ...captain, reasoningEffort: 'high' },
    } } } })
    await send(f, { missionId: first.mission.id })
    assert.deepEqual(f.handles.at(-1).selection, { ...captain, reasoningEffort: 'high' })
    await send(f, { missionId: first.mission.id, modelSelection: navigator })
    assert.deepEqual(f.handles.at(-1).selection, navigator)
  } finally { await f.close() }
})

test('恢复已有业务成果时在模型目录等待期间撤销原插件权限，不再调用船长', async () => {
  let calls = 0
  const f = await fixture({ providers: [{ id: 'blog', async run() {
    return { status: 'completed', conversationId: 'owned-blog', text: '原业务成果' }
  } }], model: async ({ assign }) => {
    if (++calls === 1) await assign([{ crew: 'blog', message: '准备资料' }])
    return '处理完成'
  } })
  try {
    const first = await send(f)
    const catalog = f.ctx.sessionController.modelCatalog
    f.ctx.sessionController.modelCatalog = async () => {
      const result = await catalog()
      f.revoked.add('alice-login:blog')
      return result
    }
    assert.equal((await f.request('/message', input({ missionId: first.mission.id }))).status, 202)
    // 新的 HTTP 读取在目录回调之后处理，检查真实副作用和公开访问边界。
    assert.equal((await f.request('/mission?id=' + first.mission.id)).status, 403)
    assert.equal(calls, 1)
    assert.equal(f.handles.length, 1)
  } finally { await f.close() }
})
