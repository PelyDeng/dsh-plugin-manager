import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import { ConversationStore } from '../src/conversation-store.ts'

const user: Actor = { namespace: 'user', userId: 'one', sessionId: 'login-one' }
const local: Actor = { namespace: 'standalone', userId: 'local' }
describe('durable ownership', () => {
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
      expect(store.list({ ...user, sessionId: 'new-browser' }, 0, 10)).toHaveLength(1)
      expect(store.list(local, 0, 10).map(row => row.id)).toEqual(['local'])
      expect(() => store.assertOwner('private', local)).toThrow()
      expect(() => store.assertOwner('orphan', user)).toThrow()
      expect(() => store.assertOwner('legacy', user)).toThrow()
      expect(() => store.reserve('private', local)).toThrow()
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
