import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionStore } from '../dist/store.mjs'

const alice = { namespace: 'user', userId: 'alice', sessionId: 'a-login' }
const bob = { namespace: 'user', userId: 'bob', sessionId: 'b-login' }

test('协作所有权、请求去重记录和旧执行回调相互隔离', () => {
  const store = new MissionStore(':memory:')
  try {
    const first = store.begin(alice, '查询并整理', undefined, { requestId: 'request-a', signature: 'same-input' })
    assert.throws(() => store.get(bob, first.id), { status: 404 })
    assert.throws(() => store.events(bob, first.id), { status: 404 })
    assert.throws(() => store.link(bob, first.id, first.runId, 'blog', 'blog-forged'), { status: 404 })
    assert.equal(store.list(bob).length, 0)
    assert.equal(store.submitted(alice, 'request-a', 'same-input').id, first.id)
    assert.throws(() => store.submitted(alice, 'request-a', 'different-input'), { status: 409 })
    assert.throws(() => store.begin(alice, '同时提交', first.id), { status: 409 })
    assert.equal(store.link(alice, first.id, first.runId, 'closedoff', 'closedoff-owned'), true)
    assert.equal(store.finish(alice, first.id, first.runId, 'completed'), true)
    const second = store.begin({ ...alice, sessionId: 'new-login' }, '继续整理', first.id)
    assert.notEqual(second.runId, first.runId)
    assert.equal(store.add(alice, first.id, { type: 'message', role: 'blog', text: '旧请求迟到的结果' }, first.runId), false)
    assert.equal(store.finish(alice, first.id, first.runId, 'failed'), false)
    assert.equal(store.get(alice, first.id).state, 'running')
    assert.equal(store.events(alice, first.id).some(event => event.text.includes('迟到')), false)
    assert.deepEqual(store.crew(alice, first.id).map(row => ({ ...row })), [{ role: 'closedoff', conversationId: 'closedoff-owned' }])
  } finally { store.close() }
})

test('重启保留成果引用并标记中断，读取历史不重新执行', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pirate-store-')), 'history.sqlite')
  const first = new MissionStore(path)
  const mission = first.begin(alice, '处理中')
  first.sessionReady(alice, mission.id, mission.runId)
  first.link(alice, mission.id, mission.runId, 'blog', 'blog-existing')
  first.add(alice, mission.id, { type: 'message', role: 'blog', text: '已返回的内容' }, mission.runId)
  first.close()
  const restored = new MissionStore(path)
  try {
    assert.equal(restored.get(alice, mission.id).state, 'interrupted')
    assert.equal(restored.get(alice, mission.id).runId, null)
    assert.equal(restored.get(alice, mission.id).sessionReady, 1)
    const events = restored.events(alice, mission.id)
    assert.equal(events.filter(event => event.text === '已返回的内容').length, 1)
    assert.equal(events.filter(event => event.text.includes('宿主重启')).length, 1)
    const cursor = events[0].seq
    assert.ok(restored.events(alice, mission.id, cursor).every(event => event.seq > cursor))
    assert.equal(restored.crew(alice, mission.id)[0].conversationId, 'blog-existing')
  } finally { restored.close() }
})
