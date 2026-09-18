/**
 * 派单材料快照与协作返回留存的持久化语义。
 *
 * 这里覆盖**存储层**能独立验证的部分：schema 9 的口径列与快照列、三态（未知 / `[]` / 非空）、
 * 首次派单固定后不再被改写（含 `[]` 也是已固定值）、协作返回原文的留存（合法空文本要编码成
 * JSON，不能因为空串被 COALESCE 当成「不传」）、嵌套损坏按未知处理而不是修补成可派单材料、
 * 以及关闭重开后仍然可读。旧库（v8 及更早）升上来的投影语义由 migrate-storage.test.ts 的
 * v1..v9 fixture 与等价性验收承接。
 *
 * 派单链路的端到端断言（员工实际收到的 message、缺材料拒绝派单、外部待办经重开进入下游、
 * 续问后既有下游快照不变）在 `input-refs-flow.test.ts`；对外响应不含内部字段的断言在
 * `input-refs-http.test.ts`。
 */
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import { advanceSubtask, TaskStore } from './helpers/sqlite-test-store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const opened: string[] = []
function tempDb(): string {
  const path = join(tmpdir(), `butler-inputrefs-${randomUUID()}.sqlite`)
  opened.push(path)
  return path
}
afterEach(() => {
  for (const path of opened.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${path}${suffix}`, { force: true }) } catch { /* 留给系统清理 */ }
    }
  }
})

/** 直接落一条任务与子任务：这些用例只验存储层语义，不走需要会话归属校验的公开写入口。 */
function newTask(path: string): void {
  // 先让 store 建表，再直接落数据（不调公开写入口，绕开会话归属校验）。
  new TaskStore(path).close()
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO tasks(id,conversation_id,owner_namespace,owner_id,goal,state,note,summary,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('task-1', conversationId, actor.namespace, actor.userId, '写博客', 'running', '', '', '', 1, 2)
  db.prepare('INSERT INTO subtasks(task_id,id,seq,goal,agent_id,reason,state,depends_on) VALUES(?,?,?,?,?,?,?,?)')
    .run('task-1', 's1', 1, '起草', 'blog', '', 'queued', '')
  db.close()
}

const subtaskOf = (store: TaskStore) => store.task(actor, 'task-1')?.subtasks[0]

/** 一条形状完整的材料来源快照。 */
function refOf(text: string, externalPending?: { reason: string; next?: string }) {
  return {
    subtaskId: 's0',
    logicalId: 'g1',
    state: 'succeeded' as const,
    text,
    artifacts: [],
    ...(externalPending === undefined ? {} : { externalPending }),
  }
}

/** 直接改库：模拟旧版本写入或人工改库留下的损坏数据。 */
function damage(path: string, column: 'input_refs' | 'member_return', raw: string): void {
  const db = new DatabaseSync(path)
  db.prepare(`UPDATE subtasks SET ${column}=? WHERE task_id='task-1' AND id='s1'`).run(raw)
  db.close()
}

/** 直接改库：摆出历史形态（例如「开始过但没留材料」）。 */
function rawRun(path: string, sql: string): void {
  const db = new DatabaseSync(path)
  db.exec(sql)
  db.close()
}

/** 直接读库里的原始列，绕开解析层看真实落库的字节。 */
function rawColumn(path: string, column: 'input_refs' | 'member_return'): string {
  const db = new DatabaseSync(path)
  const row = db.prepare(`SELECT ${column} AS value FROM subtasks WHERE task_id='task-1' AND id='s1'`).get() as unknown as { value: string }
  db.close()
  return row.value
}

describe('schema 10：当前结构', () => {
  it('新库为 schema 10，口径列、快照列与裁决四列都存在', () => {
    const path = tempDb()
    const store = new TaskStore(path)
    const db = new DatabaseSync(path)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    const columns = (db.prepare('PRAGMA table_info(subtasks)').all() as unknown as { name: string }[]).map(row => row.name)
    expect(columns).toContain('input_refs')
    expect(columns).toContain('member_return')
    // v9 的验收口径：任务级与子任务级各一列，缺任一个都会让派单时读不到口径。
    expect(columns).toContain('acceptance')
    const taskColumns = (db.prepare('PRAGMA table_info(tasks)').all() as unknown as { name: string }[]).map(row => row.name)
    expect(taskColumns).toContain('acceptance')
    db.close()
    store.close()
  })
})

describe('派单材料快照与协作返回留存', () => {
  it('内部读取分得出「还没固定」「旧已派出未知」「损坏」「已固定」', () => {
    // 新任务：排队中、从未开始 —— 唯一允许首次固定的那一种。
    const fresh = tempDb()
    newTask(fresh)
    const freshStore = new TaskStore(fresh)
    expect(subtaskOf(freshStore)?.inputRefsState).toBe('unfixed')
    freshStore.close()

    // 派出过但没留材料：开始过，列还是空的。
    const legacyDispatched = tempDb()
    newTask(legacyDispatched)
    const legacyStore = new TaskStore(legacyDispatched)
    legacyStore.setSubtaskState('task-1', 's1', 'dispatched')
    expect(subtaskOf(legacyStore)?.inputRefsState).toBe('unknown')
    legacyStore.close()

    // 还排在队列里但已经开始过（旧版本留下的形态）：仍是未知，不是「等着首次固定」。
    const queuedButStarted = tempDb()
    newTask(queuedButStarted)
    rawRun(queuedButStarted, "UPDATE subtasks SET started_at=1 WHERE task_id='task-1' AND id='s1'")
    const queuedStore = new TaskStore(queuedButStarted)
    expect(subtaskOf(queuedStore)?.inputRefsState).toBe('unknown')
    queuedStore.close()

    // 列里有值但读不出来：损坏。
    const broken = tempDb()
    newTask(broken)
    damage(broken, 'input_refs', '{not json')
    const brokenStore = new TaskStore(broken)
    expect(subtaskOf(brokenStore)?.inputRefsState).toBe('damaged')
    brokenStore.close()

    // 已固定的合法快照。
    const good = tempDb()
    newTask(good)
    const goodStore = new TaskStore(good)
    goodStore.setSubtaskState('task-1', 's1', 'dispatched', { inputRefs: [refOf('原件')] })
    expect(subtaskOf(goodStore)?.inputRefsState).toBe('fixed')
    goodStore.close()
  })

  it('旧已派出但没留材料的记录不会被补造：写入层拒绝，原值保持空串', () => {
    const path = tempDb()
    newTask(path)
    const store = new TaskStore(path)
    store.setSubtaskState('task-1', 's1', 'dispatched')
    // 拿此刻的上游结果补一份历史来源：写入层必须拒绝。
    store.setSubtaskState('task-1', 's1', 'running', { inputRefs: [refOf('现在才拿到的材料')] })
    expect(subtaskOf(store)?.inputRefs).toBeUndefined()
    expect(subtaskOf(store)?.inputRefsState).toBe('unknown')
    expect(rawColumn(path, 'input_refs')).toBe('')
    store.close()
  })

  it('损坏的快照不会被重算值盖掉：读取按损坏，写入原样保留', () => {
    const path = tempDb()
    newTask(path)
    damage(path, 'input_refs', '{not json')
    const store = new TaskStore(path)
    store.setSubtaskState('task-1', 's1', 'running', { inputRefs: [refOf('现在才拿到的材料')] })
    expect(subtaskOf(store)?.inputRefsState).toBe('damaged')
    expect(subtaskOf(store)?.inputRefs).toBeUndefined()
    expect(rawColumn(path, 'input_refs')).toBe('{not json')
    store.close()
  })

  it('三态可区分：未知 / 空数组 / 非空', () => {
    const path = tempDb()
    newTask(path)
    const store = new TaskStore(path)
    expect(subtaskOf(store)?.inputRefs).toBeUndefined()
    store.setSubtaskState('task-1', 's1', 'dispatched', { inputRefs: [] })
    expect(subtaskOf(store)?.inputRefs).toEqual([])
    expect(subtaskOf(store)?.inputRefsState).toBe('fixed')
    store.close()
  })

  it('首次派单固定后不再被改写：空数组与非空快照都保持第一次的值', () => {
    const path = tempDb()
    newTask(path)
    const store = new TaskStore(path)
    // `[]` 是「已核验无需上游材料」，也是已固定值：后面带材料的写入不改写它。
    store.setSubtaskState('task-1', 's1', 'dispatched', { inputRefs: [] })
    store.setSubtaskState('task-1', 's1', 'running', { inputRefs: [refOf('后来才拿到的材料')] })
    expect(subtaskOf(store)?.inputRefs).toEqual([])
    expect(rawColumn(path, 'input_refs')).toBe('[]')
    store.close()

    const second = tempDb()
    newTask(second)
    const store2 = new TaskStore(second)
    // 非空 → 另一份非空：仍是第一次派单时发出去的那份。
    store2.setSubtaskState('task-1', 's1', 'dispatched', {
      inputRefs: [refOf('第一次派单的材料', { reason: '待在原页面采用', next: '采用后继续' })],
    })
    store2.setSubtaskState('task-1', 's1', 'running', { inputRefs: [refOf('第二次算出来的材料')] })
    expect(subtaskOf(store2)?.inputRefs?.[0]?.text).toBe('第一次派单的材料')
    expect(subtaskOf(store2)?.inputRefs?.[0]?.externalPending?.next).toBe('采用后继续')
    expect(rawColumn(second, 'input_refs')).toContain('第一次派单的材料')
    expect(rawColumn(second, 'input_refs')).not.toContain('第二次算出来的材料')
    store2.close()
  })

  it('不带快照的普通上报保留已固定值，重开后仍是那一份', () => {
    const path = tempDb()
    newTask(path)
    const first = new TaskStore(path)
    first.setSubtaskState('task-1', 's1', 'dispatched', { inputRefs: [refOf('原件')] })
    first.setSubtaskState('task-1', 's1', 'running')
    first.setSubtaskState('task-1', 's1', 'succeeded', { result: '摘要' })
    expect(subtaskOf(first)?.inputRefs?.[0]?.text).toBe('原件')
    first.close()

    const reopened = new TaskStore(path)
    expect(subtaskOf(reopened)?.inputRefs?.[0]?.text).toBe('原件')
    expect(subtaskOf(reopened)?.result).toBe('摘要')
    reopened.close()
  })

  it('协作返回原文按未裁剪文本留存；合法空文本编码成 JSON，不会被当成「不传」', () => {
    const path = tempDb()
    newTask(path)
    const store = new TaskStore(path)
    const long = '长'.repeat(12000)
    advanceSubtask(store, 'task-1', 's1', 'succeeded', {
      result: '裁剪后的展示摘要',
      memberReturn: { protocol: 1, text: long },
    })
    expect(subtaskOf(store)?.result).toBe('裁剪后的展示摘要')
    expect(subtaskOf(store)?.memberReturn?.text).toHaveLength(12000)
    // 空文本那一条另起一份库：`succeeded` 是终态，同一条子任务不能再被改写（迁移表守着）。
    const other = tempDb()
    newTask(other)
    const second = new TaskStore(other)
    advanceSubtask(second, 'task-1', 's1', 'waiting_user', { memberReturn: { protocol: 1, text: '' } })
    expect(subtaskOf(second)?.memberReturn).toEqual({ protocol: 1, text: '' })
    second.close()
    store.close()
  })

  it('顶层损坏或版本非法的留存按未知处理，不降级为空数组/空对象', () => {
    const path = tempDb()
    newTask(path)
    damage(path, 'input_refs', '{not json')
    damage(path, 'member_return', '{"protocol":2,"text":"x"}')
    const store = new TaskStore(path)
    expect(subtaskOf(store)?.inputRefs).toBeUndefined()
    expect(subtaskOf(store)?.memberReturn).toBeUndefined()
    store.close()
  })

  it('嵌套损坏（正文正常、待办或附件非法）整体按未知处理，不修补字段', () => {
    const path = tempDb()
    newTask(path)
    const cases: { label: string; refs: string; holding: string }[] = [
      {
        // 审查举出的那一种：正文正常、`externalPending` 是 null，不能被展开成 `{}`。
        label: '待办为 null',
        refs: '[{"subtaskId":"s0","logicalId":"g1","state":"succeeded","text":"正常正文","artifacts":[],"externalPending":null}]',
        holding: '{"protocol":1,"text":"正常正文","externalPending":null}',
      },
      {
        label: '待办的 reason 不是字符串',
        refs: '[{"subtaskId":"s0","logicalId":"g1","state":"succeeded","text":"正常正文","artifacts":[],"externalPending":{"reason":7}}]',
        holding: '{"protocol":1,"text":"正常正文","externalPending":{"reason":"在等采用","next":3}}',
      },
      {
        label: '状态取值不在允许集合里',
        refs: '[{"subtaskId":"s0","logicalId":"g1","state":"在看","text":"正常正文","artifacts":[]}]',
        holding: '',
      },
      {
        label: '附件字段缺失',
        refs: '[{"subtaskId":"s0","logicalId":"g1","state":"succeeded","text":"正常正文"}]',
        holding: '',
      },
      {
        label: '附件项字段不全',
        refs: '[{"subtaskId":"s0","logicalId":"g1","state":"succeeded","text":"正常正文","artifacts":[{"title":"草稿"}]}]',
        holding: '',
      },
    ]
    for (const item of cases) {
      damage(path, 'input_refs', item.refs)
      damage(path, 'member_return', item.holding)
      const store = new TaskStore(path)
      expect(subtaskOf(store)?.inputRefs, item.label).toBeUndefined()
      expect(subtaskOf(store)?.inputRefsState, item.label).toBe('damaged')
      if (item.holding !== '') expect(subtaskOf(store)?.memberReturn, item.label).toBeUndefined()
      store.close()
    }
  })

  it('形状完整的快照照常读回（严格校验不是一律拒绝）', () => {
    const path = tempDb()
    newTask(path)
    damage(path, 'input_refs', JSON.stringify([{
      subtaskId: 's0',
      logicalId: 'g1',
      state: 'external_pending',
      text: '正常正文',
      artifacts: [{ title: '草稿', path: '/agents/blog/draft/1', kind: 'draft' }],
      externalPending: { reason: '待在原页面采用', next: '采用后继续' },
    }]))
    damage(path, 'member_return', '{"protocol":1,"text":"正常正文","externalPending":{"reason":"待在原页面采用"}}')
    const store = new TaskStore(path)
    expect(subtaskOf(store)?.inputRefs?.[0]?.artifacts[0]?.path).toBe('/agents/blog/draft/1')
    expect(subtaskOf(store)?.inputRefs?.[0]?.externalPending?.next).toBe('采用后继续')
    expect(subtaskOf(store)?.inputRefsState).toBe('fixed')
    expect(subtaskOf(store)?.memberReturn?.externalPending?.reason).toBe('待在原页面采用')
    store.close()
  })

  it('关闭重开后快照与留存仍可读', () => {
    const path = tempDb()
    newTask(path)
    const first = new TaskStore(path)
    first.setSubtaskState('task-1', 's1', 'dispatched', {
      inputRefs: [{ subtaskId: 's0', logicalId: 'g1', state: 'external_pending', text: '原文', artifacts: [] }],
      memberReturn: { protocol: 1, text: '上一轮原文', externalPending: { reason: '未发布' } },
    })
    first.close()
    const reopened = new TaskStore(path)
    expect(subtaskOf(reopened)?.inputRefs?.[0]?.state).toBe('external_pending')
    expect(subtaskOf(reopened)?.memberReturn?.externalPending?.reason).toBe('未发布')
    reopened.close()
  })
})
