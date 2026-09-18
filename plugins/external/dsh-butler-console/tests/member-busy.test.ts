/**
 * 群成员名单与此刻忙不忙。
 *
 * 名单只收能接活的成员：`/members` 从插件目录取「智能体」分类、再按调度执行入口过滤，
 * 所以名单上的人都能接活，页面上没有「在场但派不了活」这种状态。
 *
 * 剩下两个判断分开看，不能压成一个「能用」：
 *
 * - 当前用户有没有授权 → 本插件判不了，由执行方每次运行前自己鉴权
 * - 此刻是不是闲着 → `busy`（任务库里的活跃子任务），同时也说明在干活还是等着回话
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { SubtaskState } from '../src/task-model.ts'
import { advanceSubtask, SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const other: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }

/**
 * 目录里有两位「智能体」：`blog` 登记了执行入口，`ghost` 没有。
 *
 * `/members` 从目录取名单，`busy` 从库里取占用，所以这个假上下文只实现这两条通道。
 */
function context(): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'ecosystem/catalog') {
          for (const id of ['blog', 'ghost']) {
            accept({ protocol: 1, plugin: {
              id, packageName: `dsh-${id}`, version: '1.0.0', displayName: id === 'blog' ? '博客' : '没入口的应用',
              description: '', entryPath: `/agents/${id}`, permissions: [], tools: [], category: 'agents',
            } })
          }
        }
        if (name === 'butler/executors') {
          accept({ protocol: 1, agentId: 'blog', capabilities: ['写作'], dispatch: async () => ({ status: 'succeeded', summary: '' }) })
        }
      },
    },
  } as unknown as Context
}

function fixture() {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = { subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200, waitingTimeoutMs: 600_000 } as Config
  const console_ = new ButlerConsole(context(), config, access, new SqliteButlerStorage(store), '')

  /** 给某位用户开一条会话并派一个子任务（状态走合法路径推到 `state`）。 */
  const assign = (owner: Actor, taskId: string, agentId: string, state: SubtaskState) => {
    store.openOrReserveConversation(conversationId, owner)
    store.createTask({
      id: taskId, conversationId, actor: owner, goal: '写一篇介绍', note: '',
      subtasks: [{ id: 's1', goal: '起草', agentId, reason: '' }],
    })
    advanceSubtask(store, taskId, 's1', state)
  }
  return { store, console_, assign }
}

describe('任务库里的占用', () => {
  it('已派出、正在干、等着回话都算占用，计划里的不算', () => {
    const f = fixture()
    // 计划刚生成：子任务还停在 queued。
    f.assign(actor, 'task-1', 'blog', 'queued')

    // 计划里还没派出去的步骤不占人：成员没有接手。
    expect(f.store.busy(actor).size).toBe(0)

    for (const state of ['dispatched', 'running', 'waiting_user']) {
      f.store.setSubtaskState('task-1', 's1', state as never)
      expect(f.store.busy(actor).get('blog'), state).toMatchObject({
        taskId: 'task-1', subtaskId: 's1', state,
      })
    }

    // 终结之后就让开了。
    f.store.setSubtaskState('task-1', 's1', 'succeeded')
    expect(f.store.busy(actor).get('blog')).toBeUndefined()
    f.store.close()
  })

  it('只看自己的任务：别人的占用既不显示也不越界', () => {
    const f = fixture()
    f.assign(other, 'task-bob', 'blog', 'running')
    // 库里确实有人占着，但那不是 alice 的事。
    expect(f.store.busy(other).get('blog')).toMatchObject({ taskId: 'task-bob' })
    expect(f.store.busy(actor).get('blog')).toBeUndefined()
    f.store.close()
  })

  it('同一位成员有多条时留最先派出的那条', () => {
    const f = fixture()
    f.assign(actor, 'task-1', 'blog', 'running')
    f.store.createTask({
      id: 'task-2', conversationId, actor, goal: '再写一篇', note: '',
      subtasks: [{ id: 's1', goal: '起草', agentId: 'blog', reason: '' }],
    })
    f.store.setSubtaskState('task-2', 's1', 'dispatched')

    // 占用从派发那一刻起算，后来的活顶不掉先来的那条记录。
    expect(f.store.busy(actor).get('blog')).toMatchObject({ taskId: 'task-1', state: 'running' })
    f.store.close()
  })
})

describe('成员名单上的占用', () => {
  it('只收登记了执行入口的成员，没入口的应用不是群成员', async () => {
    const f = fixture()
    // `ghost` 是「智能体」分类但没登记执行入口：它不在名单里，页面与提示词都不会提到它。
    expect((await f.console_.members(actor)).map(member => member.agentId)).toEqual(['blog'])
    f.store.close()
  })

  it('空闲时 busy 是 null，有活时带上任务与子任务', async () => {
    const f = fixture()
    expect((await f.console_.members(actor))[0]).toMatchObject({ agentId: 'blog', busy: null })

    f.assign(actor, 'task-1', 'blog', 'waiting_user')
    expect((await f.console_.members(actor))[0]?.busy).toEqual({
      taskId: 'task-1', subtaskId: 's1', state: 'waiting_user',
    })
    f.store.close()
  })

  it('占用跟着任务走，不影响名单本身', async () => {
    const f = fixture()
    f.assign(actor, 'task-1', 'blog', 'running')
    const members = await f.console_.members(actor)
    // 手上有活不会把它从名单里挤掉，也不会因此多出别人。
    expect(members.map(member => member.agentId)).toEqual(['blog'])
    expect(members[0]?.busy).toMatchObject({ state: 'running' })
    f.store.close()
  })
})
