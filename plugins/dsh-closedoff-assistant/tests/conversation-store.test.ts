import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import { ConversationStore } from '../src/conversation-store.ts'

const user: Actor = { namespace: 'user', userId: 'one', sessionId: 'login-one' }
const local: Actor = { namespace: 'standalone', userId: 'local' }
describe('durable ownership', () => {
  it.each([2, 3])('migrates the deployed v%s index without losing titles, owners or removal state', version => {
    const root = mkdtempSync(join(tmpdir(), 'closedoff-v2-')), path = join(root, 'history.sqlite'), old = new DatabaseSync(path)
    old.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,owner_namespace TEXT NOT NULL,owner_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,ready INTEGER NOT NULL DEFAULT 0,deletedAt INTEGER,removalState TEXT NOT NULL DEFAULT ''); PRAGMA user_version=2; INSERT INTO conversations VALUES('old','user','one','旧标题 100%',10,20,1,NULL,''); INSERT INTO conversations VALUES('removed','user','one','已移除',10,20,1,30,'removed');")
    if (version === 3) old.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;')
    old.close()
    const store = new ConversationStore(path)
    try {
      expect(store.list(user, 0, 30)).toEqual([{ id: 'old', title: '旧标题 100%', titleSource: 'manual', createdAt: 10, updatedAt: 20, pinned: 0 }])
      expect(store.syncTitle('old', '迟到的标题', false, true)).toBe(false)
      store.mutate(user, { operation: 'pin', ids: ['old'], pinned: true })
      expect(store.list(user, 0, 30, '%')[0]?.pinned).toBe(1)
      expect(store.record(user, 'removed').removalState).toBe('removed')
      expect(() => store.mutate(local, { operation: 'rename', ids: ['old'], title: '越权' })).toThrow('无权')
      expect(store.list(user, 0, 30)[0]?.title).toBe('旧标题 100%')
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('projects first-prompt titles without touching activity or accepting late titles after manual rename', () => {
    const store = new ConversationStore(':memory:')
    try {
      store.reserve('new', user)
      expect(store.syncTitle('new', '未完成创建')).toBe(false)
      store.publish('new'); store.touch('new', '首句占位')
      const updatedAt = store.record(user, 'new').updatedAt
      expect(store.syncTitle('new', '首句回退')).toBe(true)
      expect(store.syncTitle('new', '车辆轨迹查询', false, true)).toBe(true)
      expect(store.list(user, 0, 30)[0]).toMatchObject({ title: '车辆轨迹查询', titleSource: 'generated', updatedAt })
      expect(store.syncTitle('new', '迟到的回退')).toBe(false)
      expect(store.syncTitle('new', '官方手动标题', true, true)).toBe(true)
      store.mutate(user, { operation: 'rename', ids: ['new'], title: '我的记录' })
      expect(store.syncTitle('new', '不能覆盖', false, true)).toBe(false)
      expect(store.record(user, 'new').title).toBe('我的记录')
      expect(store.syncTitle('new', '再次在宿主手动更名', true, true)).toBe(true)
      expect(store.record(user, 'new').title).toBe('再次在宿主手动更名')
      expect(store.syncTitle('new', '随后到达的自动标题', false, true)).toBe(false)
      store.reserve('removed', user); store.publish('removed'); store.mark(user, 'removed', 'removed')
      expect(store.syncTitle('removed', '不能复活', false, true)).toBe(false)
      expect(store.syncTitle('removed', '手动事件也不能复活', true, true)).toBe(false)
      expect(store.syncTitle('another-plugin-session', '无关会话', false, true)).toBe(false)
    } finally { store.close() }
  })
  it('retains private history across reopen and mode removal without exposing incomplete records', () => {
    const root = mkdtempSync(join(tmpdir(), 'closedoff-owners-'))
    const path = join(root, 'data', 'conversations.sqlite')
    let store = new ConversationStore(path)
    try {
      store.reserve('private', user); store.publish('private'); store.touch('private', '自己的对话')
      store.reserve('orphan', user)
      store.reserve('local', local); store.publish('local')
      store.close(); store = new ConversationStore(path)
      expect(store.list(user, 0, 10)).toEqual([expect.objectContaining({ id: 'private', title: '自己的对话' })])
      store.mutate(user, { operation: 'rename', ids: ['private'], title: '自己的对话' })
      store.close(); store = new ConversationStore(path)
      expect(store.syncTitle('private', '重启后迟到的自动标题', false, true)).toBe(false)
      expect(store.list({ ...user, sessionId: 'new-browser' }, 0, 10)).toHaveLength(1)
      expect(store.list(local, 0, 10).map(row => row.id)).toEqual(['local'])
      expect(() => store.assertOwner('private', local)).toThrow()
      expect(() => store.assertOwner('orphan', user)).toThrow()
      expect(() => store.assertOwner('legacy', user)).toThrow()
      expect(() => store.reserve('private', local)).toThrow()
      store.mark(user,'private','pending');store.close();store=new ConversationStore(path)
      expect(store.record(user,'private').removalState).toBe('failed')
      expect(()=>store.assertOwner('private',user)).toThrow()
      expect(store.managed(user,{offset:0,limit:30,q:'',state:'failed'},[],[]).total).toBe(1)
      store.mark(user,'private','removed');store.close();store=new ConversationStore(path)
      expect(store.managed(user,{offset:0,limit:30,q:'',state:''},[],[]).total).toBe(0)
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
