/**
 * 子任务状态的**写入**守卫：迁移表说什么，存储层就照什么写。
 *
 * ## 为什么单开一个文件
 *
 * 2026-09-18 的生产事故不是判定写错了，而是**写入被静默丢掉**：老板点掉确认卡之后，
 * `setSubtaskState(s1, 'succeeded')` 的条件 UPDATE 影响 0 行、不报错、也没人核验 ——
 * 库里那一步仍是 `external_pending`，等它的下游永远留在队列里。查了很久才定位到"写入没落地"。
 *
 * 根因是同一件事有两份实现：迁移表在 `task-model.ts`，写入白名单又是 PG 里手抄的一段 SQL。
 * 表里加了 `external_pending` 的出边，SQL 没跟上。这里三条判据把它钉住：
 *
 * 1. 迁移表允许的迁移，替身真的写得进去（含这次那条 `external_pending → succeeded`）；
 * 2. 表外的迁移写不进去，而且**返回 0 行**（调用方能核验，不再无声无息）；
 * 3. PG 侧的白名单由迁移表生成，源码里不再有第二份手抄的状态清单。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import { TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

function store(): TaskStore {
  const db = new TaskStore(':memory:')
  db.openOrReserveConversation(conversationId, actor)
  db.createTask({
    id: 'task-1', conversationId, actor, goal: '删掉这篇草稿', note: '',
    subtasks: [{ id: 's1', goal: '删 cid 347', agentId: 'blog', reason: '' }],
  })
  return db
}

const stateOf = (db: TaskStore) => db.task(actor, 'task-1')?.subtasks[0]?.state

describe('子任务状态写入的守卫', () => {
  it('等外部办的那一步，被办掉之后真的写得进去（这一次生产事故那一行）', () => {
    const db = store()
    db.setSubtaskState('task-1', 's1', 'dispatched')
    db.setSubtaskState('task-1', 's1', 'running')
    db.setSubtaskState('task-1', 's1', 'external_pending', { result: '确认卡已生成，等你点确认。' })
    expect(stateOf(db)).toBe('external_pending')

    // 老板点掉那张卡：这一步要落成真实终态，等它的下游才谈得上重新核验依赖。
    const written = db.setSubtaskState('task-1', 's1', 'succeeded', { result: '已经按你确认的办了。' })
    expect(written, '写入行数为 0 就是被白名单挡掉了 —— 下游会永远等下去').toBe(1)
    expect(stateOf(db)).toBe('succeeded')
    db.close()
  })

  it('表外的迁移写不进去，并如实返回 0 行', () => {
    const db = store()
    // 越级：跳过派发直接成功（真实路径一定先写 dispatched）。
    expect(db.setSubtaskState('task-1', 's1', 'succeeded')).toBe(0)
    expect(stateOf(db)).toBe('queued')
    // 终态不能改写：重试是新建子任务，不是把旧状态改回去。
    db.setSubtaskState('task-1', 's1', 'dispatched')
    db.setSubtaskState('task-1', 's1', 'succeeded')
    expect(db.setSubtaskState('task-1', 's1', 'running')).toBe(0)
    expect(stateOf(db)).toBe('succeeded')
    db.close()
  })

  it('写入白名单在 PG 侧只有一份实现（由迁移表生成，不再手抄 SQL）', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/storage/postgres.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain('subtaskTransitionSources')
    // 手抄的那份长这样：`OR (state='dispatched' AND $1 IN (…))`。它和迁移表必然漂移。
    expect(source).not.toMatch(/OR \(state='/)
  })
})
