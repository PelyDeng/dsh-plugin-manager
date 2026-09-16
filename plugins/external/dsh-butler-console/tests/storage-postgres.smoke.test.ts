/**
 * 牛马大总管 PostgreSQL 存储层冒烟测试（真实 PG 契约，T1-1 范围）。
 *
 * 无 `BUTLER_TEST_PG_DSN` 时整文件跳过（CI 无 PG 供给，方案 D6 门控；验收证据需明示跳过）。
 * 测试库专用 butler_test，允许在测试内重建 schema（DROP SCHEMA public CASCADE）。
 * 覆盖：初始化与版本校验、createTask 单事务与回滚、并发 claimRequest 唯一胜者、
 * 损坏 input_refs/depends_on 分类、addInput 并发版本冲突映射、appendSubtasks 并发编号与
 * 任务不存在语义、expireWaitingSubtask 与 setSubtaskState 的并发对抗、close 后拒绝。
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { AccessError, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { beforeAll, describe, expect, it } from 'vitest'
import { StorageError } from '../src/storage/errors.ts'
import { PostgresTaskStorage } from '../src/storage/postgres.ts'
import type { ButlerInputRef, ButlerStorage } from '../src/storage/types.ts'

const DSN = process.env.BUTLER_TEST_PG_DSN ?? ''

const actor: Actor = { namespace: 'user', userId: 'tester', sessionId: 'sess-smoke' }
const kind = 'chat'
const ttl = 24 * 60 * 60 * 1000

/** 稳定码断言：错误必须是 StorageError 且携带指定 code（toSatisfy 谓词）。 */
function hasStorageCode(error: unknown, code: StorageError['code']): boolean {
  return error instanceof StorageError && error.code === code
}

describe.skipIf(DSN === '')('butler PostgreSQL 存储冒烟（butler_test）', () => {
  let admin: Pool
  let storage: ButlerStorage

  beforeAll(async () => {
    admin = new Pool({ connectionString: DSN, max: 2 })
    const client = await admin.connect()
    try {
      // 防呆：清库前核对 DSN 确实指向 *_test 专用库，配错时立即失败，绝不 DROP 别的库。
      const current = await client.query<{ name: string }>('SELECT current_database() AS name')
      const databaseName = current.rows[0]?.name ?? ''
      expect(databaseName.endsWith('_test'), `DSN 指向的数据库「${databaseName}」不是 *_test 测试库，拒绝 DROP SCHEMA public CASCADE`).toBe(true)
      await client.query('DROP SCHEMA public CASCADE')
      await client.query('CREATE SCHEMA public')
      const sql = await readFile(new URL('../migrations/postgres/0001_init.sql', import.meta.url), 'utf8')
      await client.query(sql)
    } finally {
      client.release()
    }
    storage = new PostgresTaskStorage(DSN)
    await storage.init()
  })

  it('初始化：0001 迁移执行后版本校验通过，且可正常读写', async () => {
    // 幂等：再次 init 也应通过。
    await expect(storage.init()).resolves.toBeUndefined()
    const version = await admin.query<{ version: string | number }>('SELECT version FROM schema_version')
    expect(Number(version.rows[0]?.version)).toBe(8)
    const counts = await storage.counts(actor)
    expect(counts.completed).toBe(0)
  })

  it('版本不符（schema_version=99）时初始化与读写都以 storage_schema_version 拒绝', async () => {
    await admin.query('UPDATE schema_version SET version = 99')
    const rejected = new PostgresTaskStorage(DSN)
    try {
      await expect(rejected.init()).rejects.toSatisfy((error: unknown) => hasStorageCode(error, 'storage_schema_version'))
      // 未就绪即不服务：读与写同样拒绝。
      await expect(rejected.counts(actor)).rejects.toSatisfy((error: unknown) => hasStorageCode(error, 'storage_schema_version'))
      await expect(rejected.reserveConversation(randomUUID(), actor)).rejects.toSatisfy(
        (error: unknown) => hasStorageCode(error, 'storage_schema_version'),
      )
    } finally {
      await rejected.close()
      await admin.query('UPDATE schema_version SET version = 8')
    }
  })

  it('createTask 单事务：任务、子任务、首版输入同事务落齐，编号在事务内分配', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '把发布说明整理成三段',
      note: '',
      subtasks: [
        { id: 's1', goal: '收集要点', agentId: 'writer', reason: '写手最合适' },
        { id: 's2', goal: '校对成稿', agentId: 'editor', reason: '编辑收尾', logicalId: 'g9' },
      ],
    })
    const record = await storage.task(actor, taskId)
    expect(record).toBeDefined()
    expect(record?.state).toBe('running')
    expect(record?.acceptedVersion).toBe(1)
    expect(record?.subtasks.map(item => [item.id, item.seq, item.logicalId, item.state])).toEqual([
      ['s1', 1, 'g1', 'queued'],
      ['s2', 2, 'g9', 'queued'],
    ])
    const inputs = await storage.inputs(taskId)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ version: 1, text: '把发布说明整理成三段', source: 'chat' })
  })

  it('createTask 中途注入失败（子任务主键冲突）全回滚：任务与输入都不留痕', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await expect(storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '这条计划注定失败',
      note: '',
      subtasks: [
        { id: 's1', goal: '第一段', agentId: 'writer', reason: '' },
        { id: 's1', goal: '重复编号', agentId: 'writer', reason: '' },
      ],
    })).rejects.toSatisfy((error: unknown) => hasStorageCode(error, 'storage_constraint'))
    // 三张表都不留半个计划。
    expect(await storage.task(actor, taskId)).toBeUndefined()
    expect(await storage.inputs(taskId)).toEqual([])
    const left = await admin.query<{ total: string }>('SELECT count(*) AS total FROM tasks WHERE id=$1', [taskId])
    expect(Number(left.rows[0]?.total)).toBe(0)
  })

  it('并发 claimRequest：同一 requestId 恰有一个胜者，败者同事务读到胜者记录', async () => {
    const requestId = randomUUID()
    const [a, b] = await Promise.all([
      storage.claimRequest(actor, kind, requestId, 'digest-A', 'run-A', '', ttl),
      storage.claimRequest(actor, kind, requestId, 'digest-A', 'run-B', '', ttl),
    ])
    // 恰一个胜者；败者拿到的必须是**对方**的记录（runId 为胜者的）。
    const records = [a, b]
    expect(records.filter(record => record === undefined)).toHaveLength(1)
    const loser = records.find(record => record !== undefined)
    const winnerRunId = a === undefined ? 'run-A' : 'run-B'
    expect(loser).toMatchObject({ kind, digest: 'digest-A', state: 'claimed', runId: winnerRunId })
    // claimed 永不按时间清除：把 TTL 拉成负数再占一次，仍是同一份记录（结果不明不放行重跑）。
    const again = await storage.claimRequest(actor, kind, requestId, 'digest-A', 'run-C', '', -1_000_000_000)
    expect(again).toMatchObject({ state: 'claimed', runId: winnerRunId })
  })

  it('损坏 input_refs / depends_on 直插后读取按 damaged 分类；首次固定守卫生效', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '损坏分类与首次固定',
      note: '',
      subtasks: [{ id: 's1', goal: '坏数据行', agentId: 'writer', reason: '' }],
    })
    // 绕过存储层直插损坏 JSON，模拟历史脏数据。depends_on 用「字符串混非字符串项」的数组，
    // 验证损坏分类下取值与 SQLite 测试双实现（helpers/sqlite-test-store.ts）一致：宽松过滤
    // 出能读的字符串项。
    await admin.query(
      `UPDATE subtasks SET input_refs = '{oops', depends_on = '[ "g9", 42, true ]', state = 'dispatched',
         started_at = $1 WHERE task_id = $2 AND id = 's1'`,
      [Date.now(), taskId],
    )
    const damaged = await storage.task(actor, taskId)
    const row = damaged?.subtasks[0]
    expect(row?.inputRefsState).toBe('damaged')
    expect(row?.inputRefs).toBeUndefined()
    // depends_on 严格化（依赖重判方案 §3 条目 4）：损坏归类 damaged，编排层据此拒派。
    expect(row?.dependsOnState).toBe('damaged')
    // 取值与 SQLite 测试双实现的兜底一致：宽松过滤只留字符串项，不整列丢弃、也不伪装成空计划。
    expect(row?.dependsOn).toEqual(['g9'])
    // 派出过却留空 = 旧记录未知，不是「等着首次固定」。
    await admin.query(`UPDATE subtasks SET input_refs = '' WHERE task_id = $1 AND id = 's1'`, [taskId])
    const unknown = await storage.task(actor, taskId)
    expect(unknown?.subtasks[0]?.inputRefsState).toBe('unknown')
    // 重建一条干净的 queued 行验证首次固定：只有 unfixed 才允许写入，此后原样保留。
    const cleanTaskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: cleanTaskId,
      conversationId,
      actor,
      goal: '首次固定守卫',
      note: '',
      subtasks: [{ id: 's1', goal: '干净行', agentId: 'writer', reason: '' }],
    })
    const snapshot: ButlerInputRef[] = [{
      subtaskId: 'up-1',
      logicalId: 'g1',
      state: 'succeeded',
      text: '上游原文材料',
      artifacts: [{ title: '看这里', path: '/blog/draft/1', kind: 'draft' }],
    }]
    await storage.setSubtaskState(cleanTaskId, 's1', 'dispatched', { inputRefs: snapshot })
    const fixed = await storage.task(actor, cleanTaskId)
    expect(fixed?.subtasks[0]?.inputRefsState).toBe('fixed')
    expect(fixed?.subtasks[0]?.inputRefs).toEqual(snapshot)
    // 二次携带不同快照的派出写入不得覆盖首次固定的材料。
    await storage.setSubtaskState(cleanTaskId, 's1', 'dispatched', {
      inputRefs: [{ ...snapshot[0]!, text: '被人重算过的假材料' }],
    })
    const kept = await storage.task(actor, cleanTaskId)
    expect(kept?.subtasks[0]?.inputRefsState).toBe('fixed')
    expect(kept?.subtasks[0]?.inputRefs?.[0]?.text).toBe('上游原文材料')
  })

  it('addInput 并发版本冲突：恰有一个受理成功，另一个按 version_conflict（409）拒绝', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '并发补充只收一条',
      note: '',
      subtasks: [],
    })
    const settled = await Promise.allSettled([
      storage.addInput(actor, taskId, '第一条并发补充', 'supplement', 1),
      storage.addInput(actor, taskId, '第二条并发补充', 'supplement', 1),
    ])
    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled')
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // 行锁内复核：胜者拿到版本 2；败者读到的是行锁释放后的新版本，expectedVersion 对不上。
    expect(fulfilled[0]?.value).toBe(2)
    const error = rejected[0]?.reason
    expect(error).toBeInstanceOf(AccessError)
    expect((error as AccessError).status).toBe(409)
    expect((error as AccessError).reason).toBe('version_conflict')
    const versions = await storage.inputVersions(taskId)
    expect(versions).toEqual({ accepted: 2, processed: 1 })
  })

  it('appendSubtasks 并发追加：任务行锁串行化，seq/logicalId 各自接续不撞号', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '并发追加编号',
      note: '',
      subtasks: [{ id: 's1', goal: '开头那条', agentId: 'writer', reason: '' }],
    })
    const [idsA, idsB] = await Promise.all([
      storage.appendSubtasks(actor, taskId, [
        { id: 'a1', goal: '追加一之一', agentId: 'writer', reason: '' },
        { id: 'a2', goal: '追加一之二', agentId: 'writer', reason: '' },
      ]),
      storage.appendSubtasks(actor, taskId, [
        { id: 'b1', goal: '追加二之一', agentId: 'writer', reason: '' },
        { id: 'b2', goal: '追加二之二', agentId: 'writer', reason: '' },
      ]),
    ])
    expect(idsA).toEqual(['a1', 'a2'])
    expect(idsB).toEqual(['b1', 'b2'])
    const rows = (await storage.task(actor, taskId))?.subtasks ?? []
    // seq 接现有最大值往下排：5 条恰好是 1..5，无重复无跳号（两路并发在任务行锁上串行化）。
    expect([...rows.map(row => row.seq)].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
    // logicalId 同规则：默认标识从现有最大 gN 接续，恰好 g1..g5 无重复。
    expect([...rows.map(row => row.logicalId)].sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'g5'])
    // 每一路内部保持调用顺序、占一段连续编号：先抢到锁的接 2、3，后到的接 4、5。
    const seqOf = new Map(rows.map(row => [row.id, row.seq]))
    const consecutive = (ids: [string, string]) => {
      const [first, second] = ids.map(id => seqOf.get(id)!)
      expect(second).toBe(first! + 1)
      return first!
    }
    expect([consecutive(['a1', 'a2']), consecutive(['b1', 'b2'])].sort((x, y) => x - y)).toEqual([2, 4])
  })

  it('appendSubtasks 任务不存在：按既有语义以 task_not_found（404）拒绝且不落任何行', async () => {
    const ghostId = `butler-task-${randomUUID()}`
    await expect(storage.appendSubtasks(actor, ghostId, [
      { id: 'ghost-1', goal: '不存在的任务', agentId: 'writer', reason: '' },
    ])).rejects.toSatisfy((error: unknown) =>
      error instanceof AccessError && error.status === 404 && error.reason === 'task_not_found',
    )
    const left = await admin.query<{ total: string }>('SELECT count(*) AS total FROM subtasks WHERE task_id=$1', [ghostId])
    expect(Number(left.rows[0]?.total)).toBe(0)
  })

  it('commitTaskState 的输入版本关卡：有未处理输入时拒绝完成，追平后放行', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '终态关卡',
      note: '',
      subtasks: [],
    })
    await storage.addInput(actor, taskId, '还没处理的一条', 'supplement')
    // accepted(2) > processed(1)：宣称完成的写入必须什么都不改。
    expect(await storage.commitTaskState(taskId, 'completed', { summary: '旧范围的结论' })).toBe(false)
    expect((await storage.task(actor, taskId))?.state).toBe('running')
    await storage.setProcessedVersion(taskId, 2)
    expect(await storage.commitTaskState(taskId, 'completed', { summary: '追平后的结论' })).toBe(true)
    const done = await storage.task(actor, taskId)
    expect(done?.state).toBe('completed')
    expect(done?.finishedAt).not.toBeNull()
  })

  it('等待超时原子结账：仅 waiting_user 被置 failed，其余状态不动且不碰 result', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '等待超时结账',
      note: '',
      subtasks: [{ id: 's1', goal: '等人回话的一步', agentId: 'writer', reason: '' }],
    })
    await storage.setSubtaskState(taskId, 's1', 'dispatched')
    await storage.setSubtaskState(taskId, 's1', 'running', { result: '阶段性成果要保留' })
    await storage.setSubtaskState(taskId, 's1', 'waiting_user')
    expect(await storage.expireWaitingSubtask(taskId, 's1', '等待超过时限，已按超时收尾')).toBe(true)
    const settled = await storage.task(actor, taskId)
    expect(settled?.subtasks[0]?.state).toBe('failed')
    expect(settled?.subtasks[0]?.error).toBe('等待超过时限，已按超时收尾')
    expect(settled?.subtasks[0]?.result).toBe('阶段性成果要保留')
    // 已结账后重复结账不生效；非 waiting_user 的子任务也不该被这条路径碰到。
    expect(await storage.expireWaitingSubtask(taskId, 's1', '再来一次')).toBe(false)
  })

  it('并发对抗：expireWaitingSubtask 与 setSubtaskState(running) 真并发，恰有一方生效', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '超时收账与恢复派跑的竞争',
      note: '',
      subtasks: [{ id: 's1', goal: '等人回话的一步', agentId: 'writer', reason: '' }],
    })
    await storage.setSubtaskState(taskId, 's1', 'dispatched')
    await storage.setSubtaskState(taskId, 's1', 'running', { result: '阶段性成果要保留' })
    await storage.setSubtaskState(taskId, 's1', 'waiting_user')

    // 同一 waiting_user 行上两路真并发：一路超时收账成 failed，一路恢复成 running。
    // 两条都是单条条件 UPDATE，行锁把竞争收敛为「先提交者生效、后到者条件落空」。
    const settled = await Promise.allSettled([
      storage.expireWaitingSubtask(taskId, 's1', '等待超过时限，已按超时收尾'),
      storage.setSubtaskState(taskId, 's1', 'running'),
    ])
    // 条件 UPDATE 各自以 0 行或 1 行收场，不抛错。
    expect(settled.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    const expireWon = (settled[0] as PromiseFulfilledResult<boolean>).value === true

    const row = (await storage.task(actor, taskId))?.subtasks[0]
    // 终态只有一种，两方不得同时落库：超时方赢 = failed + 超时 error（result 不被收账路径碰掉）；
    // 恢复方赢 = running 且没有超时 error（ expire 返回 false，它的 UPDATE 一行都没改到）。
    if (expireWon) {
      expect(row?.state).toBe('failed')
      expect(row?.error).toBe('等待超过时限，已按超时收尾')
      expect(row?.result).toBe('阶段性成果要保留')
      expect(row?.finishedAt).not.toBeNull()
    } else {
      expect(settled[0]).toMatchObject({ value: false })
      expect(row?.state).toBe('running')
      expect(row?.error).toBe('')
      expect(row?.result).toBe('阶段性成果要保留')
      expect(row?.finishedAt).toBeNull()
    }
  })

  it('failInterrupted 单事务恢复：任务与子任务一起收成 failed', async () => {
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '重启遗留',
      note: '',
      subtasks: [{ id: 's1', goal: '跑到一半', agentId: 'writer', reason: '' }],
    })
    await storage.setSubtaskState(taskId, 's1', 'dispatched')
    await storage.setSubtaskState(taskId, 's1', 'running')
    const changed = await storage.failInterrupted()
    expect(changed).toBeGreaterThanOrEqual(1)
    const record = await storage.task(actor, taskId)
    expect(record?.state).toBe('failed')
    expect(record?.subtasks[0]?.state).toBe('failed')
    expect(record?.finishedAt).not.toBeNull()
  })

  it('close 之后拒绝继续读写（稳定码 storage_closed），重复 close 安全', async () => {
    const disposable = new PostgresTaskStorage(DSN)
    await disposable.init()
    await disposable.close()
    // 关闭后拒绝带专属稳定码，与 storage_unknown 区分。
    await expect(disposable.counts(actor)).rejects.toSatisfy((error: unknown) => hasStorageCode(error, 'storage_closed'))
    await expect(disposable.close()).resolves.toBeUndefined()
  })
})
