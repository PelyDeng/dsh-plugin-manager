/**
 * 牛马大总管 PostgreSQL 存储层冒烟测试（真实 PG 契约，T1-1 范围）。
 *
 * 无 `BUTLER_TEST_PG_DSN` 时整文件跳过（CI 无 PG 供给，方案 D6 门控；验收证据需明示跳过）。
 * 测试库专用 butler_test，允许在测试内重建 schema（DROP SCHEMA public CASCADE）。
 * 带 DSN 全量跑必须 `vitest run --no-file-parallelism`：本文件与 acceptance-pg-contract
 * 共用 butler_test 且均重建 schema，文件级并行会互撞。
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
import { PostgresTaskStorage, STORAGE_SCHEMA_VERSION } from '../src/storage/postgres.ts'
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
      // ⚠️ 读的是**新库形状**（`private-deploy/db/0001_init.sql`，15 表）：切库后管家的真实现走的是
      // `butler_*` + `dsh_conversations` + `dsh_schema_versions`。若这里仍读插件自带的**旧形状** DDL，
      // 这两个契约文件测的就是另一个库形状 —— 拿旧绿灯冒充新覆盖。旧 DDL 按 D-6 保留（回退路径需要），
      // 但它只服务于 `migrate-storage` 那一侧。该文件与插件同在**私有库**且被 git 跟踪，路径安全。
      const raw = await readFile(new URL('../../../../private-deploy/db/0001_init.sql', import.meta.url), 'utf8')
      // ⚠️ 这份 DDL **不是纯 SQL**：唯一的占位符 `:applied_at`（版本行的毫秒时间戳）由 psql 的 `-v`
      // 供给，`private-deploy/db/create.mjs` 在执行前把它替换成 `Date.now()` 的字面量（替换后仍是
      // 合法 SQL）。这里与建库脚本**同源处理**——不替换的话 pg 驱动直接报
      // `syntax error at or near ":"`（实测），而不是静默少写一行版本。
      const sql = raw.replaceAll(':applied_at', String(Date.now()))
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
    const version = await admin.query<{ version: string | number }>(`SELECT version FROM dsh_schema_versions WHERE plugin_id = 'butler'`)
    expect(Number(version.rows[0]?.version)).toBe(STORAGE_SCHEMA_VERSION)
    const counts = await storage.counts(actor)
    expect(counts.completed).toBe(0)
  })

  it('版本不符（schema_version=99）时初始化与读写都以 storage_schema_version 拒绝', async () => {
    await admin.query(`UPDATE dsh_schema_versions SET version = 99 WHERE plugin_id = 'butler'`)
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
      await admin.query(`UPDATE dsh_schema_versions SET version = $1 WHERE plugin_id = 'butler'`, [STORAGE_SCHEMA_VERSION])
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
      acceptance: '一篇已发布的发布说明链接',
      note: '',
      subtasks: [
        { id: 's1', goal: '收集要点', agentId: 'writer', reason: '写手最合适', acceptance: '一份列全要点的清单' },
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
    // 验收口径必须真的读得回来。此前**生产实现这一列零覆盖**：把 `postgres.ts` 的读映射改成
    // 恒 `''`，整个测试套件仍然 318 passed / 0 failed——那盏绿灯照不到这条路径。
    // 现在这两条就是"改坏读映射必须变红"的落点。
    expect(record?.acceptance).toBe('一篇已发布的发布说明链接')
    expect(record?.subtasks.map(item => item.acceptance)).toEqual(['一份列全要点的清单', ''])
    const inputs = await storage.inputs(taskId)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ version: 1, text: '把发布说明整理成三段', source: 'chat' })
  })

  it('acceptance 落库往返：换一个存储实例（等价于重启）后仍可读', async () => {
    // 判据要求的是"写入 → 重启 → 仍可读"。这里用一个全新的连接池重读同一行：内存里的东西
    // 全都换了，只剩库里的还在——只落库不读回、或者读映射丢字段，都会在这里露出来。
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '写一篇稿子',
      acceptance: '一份 800 字以上的候选稿',
      note: '',
      subtasks: [{ id: 's1', goal: '写稿', agentId: 'writer', reason: '', acceptance: '一份含标题与正文的候选稿' }],
    })
    const reopened = new PostgresTaskStorage(DSN)
    try {
      await reopened.init()
      const record = await reopened.task(actor, taskId)
      expect(record?.acceptance).toBe('一份 800 字以上的候选稿')
      expect(record?.subtasks[0]?.acceptance).toBe('一份含标题与正文的候选稿')
    } finally {
      await reopened.close()
    }
  })

  it('selfCheck 四态落库往返：`absent` 不在落库那刻被吃掉（换实例仍读得回）', async () => {
    // `absent`（执行方没有自检能力）是四态里唯一由**运行时代执行方**声明的态：老执行方什么都
    // 不报，两侧的解析白名单若只认三态，它就在落库那刻退化成"没有自检结论"——上游改了、下游
    // 没接。纯解析层在 `selfcheck-four-state.test.ts` 覆盖；这里证的是真的落了库、换实例读得回。
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId,
      conversationId,
      actor,
      goal: '看看今天园区的情况',
      note: '',
      subtasks: [{ id: 's1', goal: '查一下在线设备数', agentId: 'poller', reason: '' }],
    })
    // 状态机要求逐级推进（queued 不能直接到 succeeded），照真实派单路径走三步。
    await storage.setSubtaskState(taskId, 's1', 'dispatched')
    await storage.setSubtaskState(taskId, 's1', 'running')
    await storage.setSubtaskState(taskId, 's1', 'succeeded', {
      result: '在线 42 台',
      memberReturn: {
        protocol: 1,
        text: '在线 42 台',
        selfCheck: { status: 'absent', detail: '执行方没有回报自检结论（缺省不等于通过）' },
      },
    })
    const reopened = new PostgresTaskStorage(DSN)
    try {
      await reopened.init()
      const record = await reopened.task(actor, taskId)
      expect(record?.subtasks[0]?.memberReturn?.selfCheck).toEqual({
        status: 'absent',
        detail: '执行方没有回报自检结论（缺省不等于通过）',
      })
    } finally {
      await reopened.close()
    }
  })

  it('裁决四列落库往返：写入 → 换实例 → 四列都读得回（空串不等于「默认通过」）', async () => {
    // `butler_verdict` 的结论落在这四列上（`subtasks` 表，v10 起）。这里证的是**真的落了库、
    // 换个实例（等价重启）读得回**：上一批只把列加进 DDL 与迁移工具，而 PG 实现的读写映射
    // 一个字都没有——那一版里"有列、无人读写"，正是本项目反复出现的"中间的线没接"。
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
        { id: 's1', goal: '写草稿', agentId: 'blog', reason: '' },
        { id: 's2', goal: '这一步没人裁决过', agentId: 'blog', reason: '' },
      ],
    })
    // 先确认"没裁决过"的形状是**空串**，不是任何一种结论。
    const before = await storage.task(actor, taskId)
    expect(before?.subtasks.map(item => item.verdict)).toEqual(['', ''])

    // 写后核验：写进去必须恰好 1 行；写一条不存在的子任务必须返回 0（**不静默**）。
    expect(await storage.setSubtaskVerdict(actor, taskId, 's1', {
      verdict: 'accept', reason: '产出对得上口径', evidence: '一篇已发布的发布说明链接', observation: '首发',
    })).toBe(1)
    expect(await storage.setSubtaskVerdict(actor, taskId, 's404', { verdict: 'accept' })).toBe(0)

    const reopened = new PostgresTaskStorage(DSN)
    try {
      await reopened.init()
      const record = await reopened.task(actor, taskId)
      // ⚠️ 期望值按**新库的 JSONB 形态**写：`verdict_evidence` 是数组、`observation` 是对象
      // （两列的 DDL 默认值分别是 `'[]'::jsonb` 与 `'{}'::jsonb`）。旧库那两列是 TEXT、读回是
      // 裸字符串——切库后"读回什么形状"变了，这条断言正是那个变化的落点。
      expect(record?.subtasks[0]).toMatchObject({
        verdict: 'accept',
        verdictReason: '产出对得上口径',
        verdictEvidence: ['一篇已发布的发布说明链接'],
        observation: { why: '首发' },
      })
      // 没裁决过的那条仍是**列默认值**：读写映射不许把缺省补成任何结论。
      expect(record?.subtasks[1]).toMatchObject({
        verdict: '', verdictReason: '', verdictEvidence: [], observation: {},
      })
    } finally {
      await reopened.close()
    }
  })

  it('裁决写入按 owner 隔离：别人的 owner 一行也改不动', async () => {
    // 裁决由牛马大总管自己发起（不是用户请求），但写入必须带 owner 条件——漏了它，一次编程
    // 错误就会改到别人 owner 的任务上，而且**不报错**（受影响行数只是不为 0）。
    const otherActor: Actor = { namespace: 'user', userId: 'someone-else', sessionId: 'sess-other' }
    const conversationId = randomUUID()
    await storage.reserveConversation(conversationId, actor)
    const taskId = `butler-task-${randomUUID()}`
    await storage.createTask({
      id: taskId, conversationId, actor, goal: '只有本人能裁决', note: '',
      subtasks: [{ id: 's1', goal: '写草稿', agentId: 'blog', reason: '' }],
    })
    expect(await storage.setSubtaskVerdict(otherActor, taskId, 's1', { verdict: 'rework', reason: '越权' })).toBe(0)
    const record = await storage.task(actor, taskId)
    expect(record?.subtasks[0]?.verdict).toBe('')
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
    const left = await admin.query<{ total: string }>('SELECT count(*) AS total FROM butler_tasks WHERE id=$1', [taskId])
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
    // ⚠️ **切库带来的语义变化（如实记录，不是放宽断言）**：
    //  ① `input_refs` 在新库是 **JSONB** ⇒ `'{oops'` 这类非法 JSON **根本写不进去**（Postgres 报
    //     22P02）。旧库那条"直插损坏数据、再由解析器按 `damaged` 拒派"的手法在新库**无法构造** ——
    //     这个缺口被 **DB 的类型系统**关掉了（更强，不是更弱）。改为断言"写入被拒"。
    //  ② `input_refs = ''` 同样不再合法（空串不是 JSON）⇒ 新库表示"没落过值"的是列默认 `'[]'::jsonb`。
    await expect(
      admin.query(`UPDATE butler_subtasks SET input_refs = '{oops' WHERE task_id = $1 AND id = 's1'`, [taskId]),
    ).rejects.toThrow(/invalid input syntax for type json/u)
    // `depends_on` 仍是**合法 JSON**（数组里混了非字符串项）⇒ 损坏分类照旧可测。
    await admin.query(
      `UPDATE butler_subtasks SET depends_on = '[ "g9", 42, true ]', state = 'dispatched',
         started_at = $1 WHERE task_id = $2 AND id = 's1'`,
      [Date.now(), taskId],
    )
    const damaged = await storage.task(actor, taskId)
    const row = damaged?.subtasks[0]
    // depends_on 严格化（依赖重判方案 §3 条目 4）：损坏归类 damaged，编排层据此拒派。
    expect(row?.dependsOnState).toBe('damaged')
    // 取值与 SQLite 测试双实现的兜底一致：宽松过滤只留字符串项，不整列丢弃、也不伪装成空计划。
    expect(row?.dependsOn).toEqual(['g9'])
    // `input_refs` 停在列默认值（空数组）= 没落过值；这条记录**派出过** ⇒ 归类 unknown。
    await admin.query(`UPDATE butler_subtasks SET input_refs = '[]'::jsonb WHERE task_id = $1 AND id = 's1'`, [taskId])
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
    const left = await admin.query<{ total: string }>('SELECT count(*) AS total FROM butler_subtasks WHERE task_id=$1', [ghostId])
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

  it('会话隔离：同一个 owner 下，别的 agent_id 的会话管家既读不到、也不列出来', async () => {
    // `dsh_conversations` 是**所有 Agent 共用**的一张表，而 `(owner_namespace, owner_id)` 只区分
    // **人**、不区分 Agent —— 所以"只按 owner + id 查"会把别的 Agent 的会话判成管家自己的
    // （设计 §8.1 的实测结论：串 Agent）。这条用例就是那个缺口本身的判据：把 `agent_id` 从任一
    // 查询里去掉，它必须变红。
    const mine = `butler-web-${randomUUID()}`
    await storage.reserveConversation(mine, actor)
    const foreign = `blog-chat-${randomUUID()}`
    await admin.query(
      `INSERT INTO dsh_conversations(id, agent_id, owner_namespace, owner_id, ready, created_at, updated_at)
       VALUES($1,'blog',$2,$3,TRUE,$4,$4)`,
      [foreign, actor.namespace, actor.userId, Date.now()],
    )

    // ① 读别人的会话 ⇒ 与"不存在"同一个 404（不泄露存在性）。
    await expect(storage.assertOwner(foreign, actor))
      .rejects.toSatisfy((error: unknown) => error instanceof AccessError && error.status === 404)
    // 自己的照常读得到。
    await expect(storage.assertOwner(mine, actor)).resolves.toBeUndefined()
    // ② 侧栏列表里不许出现别的 Agent 的会话（漏 `agent_id` 时它会混进来）。
    const listed = (await storage.listConversations(actor, 50)).items
    expect(listed.map(item => item.id)).toContain(mine)
    expect(listed.map(item => item.id)).not.toContain(foreign)
  })
})
