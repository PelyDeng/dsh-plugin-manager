/**
 * 会话删除（kit 移除围栏集成）与失败记录删除的存储/控制台行为。
 *
 * 覆盖（0.12.3）：
 * - 围栏 happy path：删除后侧栏不再列出、业务五表清干净、removal_state 落库为 removed；
 * - 围栏幂等：删过的会话再删返回 alreadyRemoved；
 * - 忙检查：runs 占用的会话删除返回 blocked；
 * - 镜像启动加载：重启（重建 ButlerConsole）后已删会话仍不出现；
 * - 失败记录删除（deleteTask）：终态任务连子任务与输入一并删除；活跃任务 409；不存在 404。
 */

import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import type { Context } from '@deepseek-ai/cordis'
import { ButlerConsole } from '../src/butler.ts'
import { SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

function makeConsole(store: TaskStore) {
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000,
    maxConversationEvents: 200, waitingTimeoutMs: 600_000, conversationsPageSize: 10,
  } as Config
  const archived: string[] = []
  const context = {
    root: { emit() {} },
    get(key: string) {
      if (key === 'sessionPersistence') {
        return { inspect: async (id: string) => ({ events: [], header: { id }, inheritedEventCount: 0 }) }
      }
      if (key === 'workspaceRegistry') {
        return { archivedSessionIds: archived, archiveSession: async (id: string) => { archived.push(id) } }
      }
      return undefined
    },
  } as unknown as Context
  const console_ = new ButlerConsole(context, config, access, new SqliteButlerStorage(store), '')
  return { console_, archived }
}

function seedConversation(store: TaskStore, id: string, taskState: 'failed' | 'completed' | 'active' = 'failed') {
  store.openOrReserveConversation(id, actor)
  store.touchConversation(id, actor, '一次测试任务')
  const taskId = `butler-task-${randomUUID()}`
  store.createTask({
    id: taskId, conversationId: id, actor, goal: '干点活', note: '',
    subtasks: [{ id: 's1', goal: '第一步', agentId: 'blog', reason: '' }],
  })
  if (taskState !== 'active') {
    store.setTaskState(taskId, taskState, { error: taskState === 'failed' ? '没干成' : '' })
    // 子任务同步收尾：终态任务的子任务不会停在活跃态（与 failInterrupted 的成对写入一致）。
    store.setSubtaskState(taskId, 's1', taskState === 'failed' ? 'failed' : 'succeeded', {})
  }
  // 'active'：createTask 的初态就是任务 running + 子任务 queued，直接模拟活跃。
  return taskId
}

describe('会话删除（移除围栏）', () => {
  it('删除后：侧栏不再列出、五张业务表清干净、removal_state 落库 removed', async () => {
    const store = new TaskStore(':memory:')
    const { console_, archived } = makeConsole(store)
    const idA = 'butler-web-01234567-89ab-4cde-8fab-0123456789aa'
    seedConversation(store, idA)
    await console_.loadConversationIndex()

    const results = await console_.deleteConversations(actor, [idA])
    expect(results).toMatchObject([{ id: idA, status: 'removed' }])
    expect(archived).toEqual([idA])

    const listed = await console_.listConversations(actor)
    expect(listed.items.some(item => item.id === idA)).toBe(false)

    const raw = store.conversationRemovals()
    expect(raw.find(row => row.key.endsWith(idA))?.state).toBe('removed')

    const remaining = store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' })
    expect(remaining.items.some(item => item.conversationId === idA)).toBe(false)
  })

  it('删过的会话再删返回 alreadyRemoved；不存在的会话 404（不泄露存在性）', async () => {
    const store = new TaskStore(':memory:')
    const { console_ } = makeConsole(store)
    const idB = 'butler-web-01234567-89ab-4cde-8fab-0123456789bb'
    seedConversation(store, idB)
    await console_.loadConversationIndex()

    await console_.deleteConversations(actor, [idB])
    const again = await console_.deleteConversations(actor, [idB])
    expect(again).toMatchObject([{ id: idB, status: 'alreadyRemoved' }])

    // 不存在的会话：围栏不 reject（逐条结果制），按 failed 带原因返回，不泄露存在性。
    const unknown = 'butler-web-01234567-89ab-4cde-8fab-0123456789fa'
    const miss = await console_.deleteConversations(actor, [unknown])
    expect(miss).toMatchObject([{ id: unknown, status: 'failed' }])
  })

  it('正在跑的会话删除返回 blocked（围栏忙检查），材料保留', async () => {
    const store = new TaskStore(':memory:')
    const { console_ } = makeConsole(store)
    const idC = 'butler-web-01234567-89ab-4cde-8fab-0123456789cc'
    seedConversation(store, idC)
    await console_.loadConversationIndex()
    // 把会话挂进 runs：围栏的 busy 会看到它。
    const inner = console_ as unknown as { runs: Map<string, unknown> }
    inner.runs.set(idC, { runId: 'r1', abort: new AbortController() })

    const results = await console_.deleteConversations(actor, [idC])
    expect(results[0]?.status).toBe('blocked')
    // 业务数据原样保留。
    const listed = await console_.listConversations(actor)
    expect(listed.items.some(item => item.id === idC)).toBe(true)
  })

  it('重启（重建 ButlerConsole + 重新加载镜像）后已删会话仍不出现', async () => {
    const store = new TaskStore(':memory:')
    const first = makeConsole(store)
    const idD = 'butler-web-01234567-89ab-4cde-8fab-0123456789dd'
    seedConversation(store, idD)
    await first.console_.loadConversationIndex()
    await first.console_.deleteConversations(actor, [idD])

    const second = makeConsole(store)
    await second.console_.loadConversationIndex()
    const listed = await second.console_.listConversations(actor)
    expect(listed.items.some(item => item.id === idD)).toBe(false)
    // 再删一次是 alreadyRemoved，不是 404：镜像从库里加载回了 removed 状态。
    const again = await second.console_.deleteConversations(actor, [idD])
    expect(again).toMatchObject([{ id: idD, status: 'alreadyRemoved' }])
  })
})

describe('失败记录删除（任务级）', () => {
  it('终态任务连子任务与输入一并删除；侧栏会话保留', async () => {
    const store = new TaskStore(':memory:')
    const { console_ } = makeConsole(store)
    const idE = 'butler-web-01234567-89ab-4cde-8fab-0123456789ee'
    const taskId = seedConversation(store, idE, 'failed')
    await console_.loadConversationIndex()

    await console_.deleteTask(actor, taskId)

    expect(await store.task(actor, taskId)).toBeUndefined()
    const listed = await console_.listConversations(actor)
    expect(listed.items.some(item => item.id === idE)).toBe(true)
  })

  it('活跃任务 409；不存在 404', async () => {
    const store = new TaskStore(':memory:')
    const { console_ } = makeConsole(store)
    const idF = 'butler-web-01234567-89ab-4cde-8fab-0123456789ff'
    const taskId = seedConversation(store, idF, 'active')

    await expect(console_.deleteTask(actor, taskId)).rejects.toSatisfy(
      (error: unknown) => error instanceof AccessError && error.status === 409)
    expect(await store.task(actor, taskId)).toBeDefined()

    await expect(console_.deleteTask(actor, 'task-does-not-exist')).rejects.toSatisfy(
      (error: unknown) => error instanceof AccessError && error.status === 404)
  })
})
