import { afterEach, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HistoryStore } from '../src/history.ts'
import { fixture } from './fixture.mjs'

const alice = { namespace: 'user', userId: 'alice' }, bob = { namespace: 'user', userId: 'bob' }, fixtures = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close() })

test('真实 schema 3 索引迁移保留旧标题，新会话来源跨重启持久化', () => {
  const directory = mkdtempSync(join(tmpdir(), 'example-title-history-')), path = join(directory, 'history.sqlite'), old = new DatabaseSync(path)
  old.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,updatedAt INTEGER NOT NULL,ready INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,deletedAt INTEGER,removalState TEXT NOT NULL DEFAULT ''); PRAGMA user_version=3; INSERT INTO conversations(id,owner,title,updatedAt,ready) VALUES('old','user:alice','保留旧标题',1,1)")
  old.close()
  let store = new HistoryStore(path)
  try {
    expect(store.list(alice, 0, 30)[0]).toMatchObject({ title: '保留旧标题', titleSource: 'manual' })
    expect(store.syncTitle('old', '迟到标题', false, true)).toBe(false)
    store.reserve('new', alice, '首句'); store.publish('new')
    expect(store.syncTitle('new', '规范\n标题', false, true)).toBe(true)
    store.close(); store = new HistoryStore(path)
    expect(store.list(alice, 0, 30).find(row => row.id === 'new')).toMatchObject({ title: '规范 标题', titleSource: 'generated' })
    const db = new DatabaseSync(path)
    try { expect(db.prepare('PRAGMA user_version').get().user_version).toBe(4) } finally { db.close() }
  } finally { store.close(); expect(dirname(directory)).toBe(tmpdir()); rmSync(directory, { recursive: true, force: true }) }
})

test('标题同步不新增索引，不碰未发布/移除会话，手动和完成标题阻止后续自动覆盖', () => {
  const store = new HistoryStore(':memory:')
  try {
    expect(store.syncTitle('foreign-session', '未知标题', false, true)).toBe(false)
    store.reserve('new', alice, '首句')
    expect(store.syncTitle('new', '太早', false, true)).toBe(false)
    store.publish('new')
    expect(store.syncTitle('new', '回退标题', false, false)).toBe(true)
    expect(store.list(alice, 0, 30)[0].titleSource).toBe('automatic')
    store.mutate(alice, { operation: 'rename', ids: ['new'], title: '我手动指定' })
    expect(store.syncTitle('new', '晚到模型结果', false, true)).toBe(false)
    store.reserve('branch', alice, '分支对话', 'manual'); store.publish('branch')
    expect(store.syncTitle('branch', '继承旧首句', false, true)).toBe(false)
    store.reserve('bob', bob, '其他账号'); store.publish('bob')
    expect(store.syncTitle('bob', '第一轮结果', false, true)).toBe(true)
    expect(store.syncTitle('bob', '之后的自动结果', false, true)).toBe(false)
    expect(store.syncTitle('bob', '宿主用户指定', true, true)).toBe(true)
    expect(store.syncTitle('bob', '宿主再次改名', true, true)).toBe(true)
    expect(store.syncTitle('bob', '迟到自动结果', false, true)).toBe(false)
    expect(store.list(bob, 0, 30)[0]).toMatchObject({ title: '宿主再次改名', titleSource: 'manual' })
    expect(store.list(alice, 0, 30).some(row => row.id === 'bob')).toBe(false)
    store.mutate(alice, { operation: 'delete', ids: ['new'] })
    expect(store.syncTitle('new', '不得复活', true, true)).toBe(false)
    store.reserve('removing', alice, '待删除'); store.publish('removing'); store.mark(alice, 'removing', 'pending')
    expect(store.syncTitle('removing', '删除中', false, true)).toBe(false)
  } finally { store.close() }
})

test('首句标题通过当前 SSE 通知，turn/end 后仍同步列表，手改和删除拒绝迟到覆盖', async () => {
  const f = await fixture(); fixtures.push(f)
  const response = await f.request('/chat', { message: '我的第一句话' }), handle = f.handles[0]
  const title = (text, source = 'provider', messageSeqs = [1]) => f.emit(handle, 'session/title', { title: text, source: { kind: source }, messageSeqs })
  title('首句回退', 'fallback')
  f.ctx.emit('session/event', { id: 'unknown-session' }, { type: 'session/title', data: { title: '无关会话', source: { kind: 'provider' }, messageSeqs: [1] } })
  title('第二轮不得覆盖', 'provider', [1, 2])
  expect((await (await f.request('/conversations')).json()).items[0]).toMatchObject({ title: '首句回退', titleSource: 'automatic' })
  f.emit(handle, 'turn/end', { reason: { kind: 'completed' } })
  const stream = await response.text()
  expect(stream).toContain('"type":"title"'); expect(stream).toContain('首句回退'); expect(stream).not.toContain('无关会话')
  title('宿主晚到的提炼标题')
  expect((await (await f.request('/conversations')).json()).items[0]).toMatchObject({ title: '宿主晚到的提炼标题', titleSource: 'generated' })
  let renamed = false
  f.ctx.sessionTitle = { rename(session, name) {
    expect(session).toBe(handle.agent.session); expect(name).toBe('手动标题'); renamed = true
    title('手改中到达的旧结果')
    title(name, 'user', [])
  } }
  expect((await f.request('/conversation-action', { operation: 'rename', ids: [handle.id], title: '手动标题' })).status).toBe(200)
  expect(renamed).toBe(true)
  title('迟到自动标题')
  expect((await (await f.request('/conversations')).json()).items[0]).toMatchObject({ title: '手动标题', titleSource: 'manual' })
  title('宿主第二次改名', 'user', [])
  title('后续自动结果')
  expect((await (await f.request('/conversations')).json()).items[0]).toMatchObject({ title: '宿主第二次改名', titleSource: 'manual' })
  expect((await f.request('/conversation-action', { operation: 'delete', ids: [handle.id] })).status).toBe(200)
  title('删除后不得复活')
  expect((await (await f.request('/conversations')).json()).items).toEqual([])
})
