/**
 * §7 验收合同的 ButlerConsole 级执行（真实 PG 存储，批 1 总验收 T1-5）。
 *
 * 绑定规格：《非框架插件业务库 PostgreSQL 默认方案》§7 验收合同，逐项：
 *
 * 1. owner 隔离：alice 建的任务 bob 同 ID 读不到（404/undefined）、跨 owner 更新被拒、
 *    子记录同样隔离；异步等待（settle）后归属仍成立。
 * 2. 并发幂等：两个并发 `start`（同 actor/kind/requestId，真 Promise.all）恰一执行，
 *    另一路重放拿到相同 runId/conversationId。
 * 3. 事务原子：createTask 后三表同落（任务 + 子任务 + 首版输入版本 1）。
 * 4. 重启恢复：实例 A 置 running 后直接 close；实例 B init 时 failInterrupted 把 running
 *    收成 failed，历史可读。
 * 5. 故障语义（存储级）：不可达 → storage_unreachable；错误密码 → storage_auth；
 *    schema_version 改 99 → storage_schema_version；tasks 改名（缺表）→ storage_schema_missing
 *    （均改完恢复）。只断言稳定码，不打印 DSN。
 * 6. 生命周期：close 后任何操作（含 readyProbe）→ storage_closed。
 *
 * 运行方式：本文件与 smoke 共用 butler_test 且 beforeAll 均重建 schema，带
 * `BUTLER_TEST_PG_DSN` 全量跑必须 `vitest run --no-file-parallelism`（文件级并行会互撞）。
 *
 * 顺带核对 §3 方言差异的真实 PG 行为：strpos(lower) 关键字检索、busy 的
 * ORDER BY started_at NULLS FIRST、BLOB→bytea 头像往返、int8/bigint 数值往返。
 *
 * 无 `BUTLER_TEST_PG_DSN` 时整文件跳过（CI 无 PG 供给，方案 D6 门控；验收证据必须明示
 * 跳过，不得把跳过报成通过）。测试库专用 butler_test，beforeAll 里 DROP SCHEMA 重建
 * （含 `_test` 库名防呆，参照 storage-postgres.smoke.test.ts）。SSE 帧序、恢复与并发
 * 对抗的其余证据引用既有套件（web-stream / run-subscription / subtask-stream /
 * input-refs-flow / storage-postgres.smoke），不在本文件重复实现。
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import { StorageError } from '../src/storage/errors.ts'
import { PostgresTaskStorage, STORAGE_SCHEMA_VERSION } from '../src/storage/postgres.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'

const DSN = process.env.BUTLER_TEST_PG_DSN ?? ''

/** 真实 PG 走远端网络，DROP SCHEMA 重建与迁移执行放宽单用例时限。 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const alice: Actor = { namespace: 'user', userId: 'alice', sessionId: 'acc-alice' }
const bob: Actor = { namespace: 'user', userId: 'bob', sessionId: 'acc-bob' }

/** 稳定码断言：错误必须是 StorageError 且携带指定 code。 */
function hasStorageCode(error: unknown, code: StorageError['code']): boolean {
  return error instanceof StorageError && error.code === code
}

/** AccessError 断言：业务拒绝按 (status, reason) 核对。 */
function isAccessRejection(error: unknown, status: number, reason: string): boolean {
  return error instanceof AccessError && error.status === status && error.reason === reason
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** 把 DSN 的口令换成错误值（host/库名保持真实），只用于 storage_auth 断言，不打印。 */
function wrongPasswordDsn(source: string): string {
  const url = new URL(source)
  url.password = 'butler-acceptance-wrong-password'
  return url.toString()
}

const executor: ButlerAgentExecutor = {
  protocol: 1,
  agentId: 'blog',
  capabilities: ['写作'],
  dispatch: async () => ({ status: 'succeeded', summary: '写好了' }),
}

function context(): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: 'blog', packageName: 'dsh-blog', version: '1.0.0', displayName: '博客',
          description: '', entryPath: '/agents/blog', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

describe.skipIf(DSN === '')('§7 验收合同（butler_test，ButlerConsole 级 + 存储级）', () => {
  let admin: Pool
  let storage: PostgresTaskStorage
  /** 每个用例起的 ButlerConsole，afterEach 统一 dispose（后台回合不再写库）。 */
  const consoles: ButlerConsole[] = []
  /** 用例自开的专属存储（实例 A/B、生命周期等），afterAll 统一 close；主存储在最后收。 */
  const stores: PostgresTaskStorage[] = []

  /**
   * 起一个「进程」：真实 PG 存储 + 真实 ButlerConsole，只有宿主与 Agent 会话是替身
   * （open 被 mock 成登记归属并回缓存会话对象，不触模型）。
   */
  function session(store: PostgresTaskStorage): { console_: ButlerConsole; agent: { followup: ReturnType<typeof vi.fn> } } {
    const access = {
      mode: 'authenticated',
      ready() {},
      resolve: () => alice,
      assert() {},
    } as unknown as Access
    const config = {
      subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
      waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000, maxHistoryPageSize: 30,
    } as Config
    const console_ = new ButlerConsole(context(), config, access, store, '')
    const agent = { session: { id: 'agent-session' }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
    // 会话对象按 id 缓存：真实 open() 复用同一实例，`active` 状态才传得出去。
    const conversations = new Map<string, { id: string; handle: { agent: typeof agent }; active: boolean; lastUsedAt: number }>()
    vi.spyOn(console_, 'open').mockImplementation(async (requestedId: string | undefined, _createMissing: boolean, who: Actor) => {
      const id = requestedId ?? `butler-web-${randomUUID()}`
      if (requestedId !== undefined) await store.openOrReserveConversation(requestedId, who)
      let conversation = conversations.get(id)
      if (conversation === undefined) {
        conversation = { id, handle: { agent }, active: false, lastUsedAt: Date.now() }
        conversations.set(id, conversation)
      }
      return conversation as never
    })
    consoles.push(console_)
    if (store !== storage) stores.push(store)
    return { console_, agent }
  }

  /** 开一个真实存储（不复用共享实例，供「实例 A / 实例 B」类用例）。 */
  async function openStorage(): Promise<PostgresTaskStorage> {
    const store = new PostgresTaskStorage(DSN)
    await store.init()
    return store
  }

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

  afterEach(async () => {
    for (const console_ of consoles.splice(0)) await console_.dispose()
  })

  afterAll(async () => {
    for (const store of stores.splice(0)) await store.close().catch(() => {})
    // beforeAll 失败时 storage/admin 可能还没建起来：收尾不得再抛次生错误。
    await storage?.close().catch(() => {})
    await admin?.end().catch(() => {})
  })

  it('1. owner 隔离：bob 对 alice 的任务不可见、不可改，子记录同样隔离，settle 后仍成立', async () => {
    const { console_ } = session(storage)
    const conversationId = `butler-web-${randomUUID()}`
    const taskId = `butler-task-${randomUUID()}`
    await storage.reserveConversation(conversationId, alice)
    await storage.createTask({
      id: taskId,
      conversationId,
      actor: alice,
      goal: 'alice 的私有任务',
      note: '',
      subtasks: [{ id: 's1', goal: '只有 alice 能看到', agentId: 'blog', reason: '' }],
    })

    // bob 同 ID 查询：存储层 undefined、Console 层 404（不泄露存在性）。
    expect(await storage.task(bob, taskId)).toBeUndefined()
    await expect(console_.task(bob, taskId)).rejects.toSatisfy(error => isAccessRejection(error, 404, 'task_not_found'))
    // alice 自己读得到，子任务一起回来。
    const own = await console_.task(alice, taskId)
    expect(own.id).toBe(taskId)
    expect(own.subtasks).toHaveLength(1)

    // 跨 owner 更新被拒：addInput / appendSubtasks 都是 task_not_found，不落任何行。
    await expect(storage.addInput(bob, taskId, 'bob 想改别人的任务', 'supplement'))
      .rejects.toSatisfy(error => isAccessRejection(error, 404, 'task_not_found'))
    await expect(storage.appendSubtasks(bob, taskId, [{ id: 'intruder', goal: '塞私货', agentId: 'blog', reason: '' }]))
      .rejects.toSatisfy(error => isAccessRejection(error, 404, 'task_not_found'))
    const intruded = await admin.query<{ total: string }>('SELECT count(*) AS total FROM subtasks WHERE task_id=$1 AND id=$2', [taskId, 'intruder'])
    expect(Number(intruded.rows[0]?.total)).toBe(0)

    // 列表与计数同样按 owner 过滤：bob 的历史与指标里没有 alice 的任务。
    const bobHistory = await console_.history(bob, { offset: 0, limit: 10, keyword: '', state: '' })
    expect(bobHistory.items.some(item => item.id === taskId)).toBe(false)
    expect(bobHistory.total).toBe(0)
    const bobOverview = await console_.overview(bob)
    expect(bobOverview.counts.running).toBe(0)
    const aliceOverview = await console_.overview(alice)
    expect(aliceOverview.counts.running).toBe(1)

    // 异步等待后再验一次归属：并发窗口后隔离不变。
    await settle()
    expect(await storage.task(bob, taskId)).toBeUndefined()
    await expect(console_.task(bob, taskId)).rejects.toSatisfy(error => isAccessRejection(error, 404, 'task_not_found'))
    expect((await console_.task(alice, taskId)).id).toBe(taskId)

    // 方言差异（§3）真实 PG 行为：strpos(lower) 关键字检索命中；BLOB→bytea 头像往返一致。
    const byKeyword = await console_.history(alice, { offset: 0, limit: 10, keyword: '私有', state: '' })
    expect(byKeyword.items.some(item => item.id === taskId)).toBe(true)
    const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    await storage.setAvatar(alice, 'blog', avatarBytes, 'image/png')
    const avatarBack = await storage.avatar(alice, 'blog')
    expect(avatarBack?.contentType).toBe('image/png')
    expect(Array.from(avatarBack?.bytes ?? [])).toEqual(Array.from(avatarBytes))
    // bob 看不到 alice 的头像（按 owner 过滤）。
    expect(await storage.avatar(bob, 'blog')).toBeUndefined()
  })

  it('2. 并发幂等：两个并发 start（同 requestId）恰一执行，重放拿到相同凭据', async () => {
    const { console_: consoleA, agent } = session(storage)
    const conversationId = `butler-web-${randomUUID()}`

    // 真 Promise.all：两路同时受理。败者在 claimRequest 的唯一约束上出局，拿到胜者 runId。
    const [a, b] = await Promise.all([
      consoleA.start(conversationId, '看看今天园区的情况', alice, 'req-concurrent'),
      consoleA.start(conversationId, '看看今天园区的情况', alice, 'req-concurrent'),
    ])

    // 相同 runId：两路都被同一轮受理（这是「另一路重放」的核心证据）。
    expect(a.runId).toBe(b.runId)
    // conversationId：胜者必带真实会话；败者回读占位记录时绑定可能尚未落地，允许空串，
    // 但非空时必须与胜者一致（不出现第三种凭据）。
    const conversationIds = new Set([a.conversationId, b.conversationId])
    expect(conversationIds.size).toBeLessThanOrEqual(2)
    expect([...conversationIds].filter(id => id !== '').length).toBe(1)
    const boundConversationId = [...conversationIds].find(id => id !== '')!
    expect(boundConversationId).toBe(conversationId)

    // 恰一执行：模型会话只被驱动一次。
    expect(agent.followup).toHaveBeenCalledTimes(1)

    // 占位记录在库里指向胜者。
    const record = await storage.request(alice, 'chat', 'req-concurrent')
    expect(record).toMatchObject({ state: 'claimed', runId: a.runId, conversationId })

    // 受理完成后的串行重放：完整凭据（runId + conversationId）原样回来，不再执行。
    const replay = await consoleA.start(conversationId, '看看今天园区的情况', alice, 'req-concurrent')
    expect(replay.runId).toBe(a.runId)
    expect(replay.conversationId).toBe(conversationId)
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('3. 事务原子：createTask 后任务、子任务、首版输入三表同落', async () => {
    const { console_ } = session(storage)
    const conversationId = `butler-web-${randomUUID()}`
    const taskId = `butler-task-${randomUUID()}`
    const goal = '把发布说明整理成三段'
    await storage.reserveConversation(conversationId, alice)
    await storage.createTask({
      id: taskId,
      conversationId,
      actor: alice,
      goal,
      note: '',
      subtasks: [
        { id: 's1', goal: '收集要点', agentId: 'blog', reason: '写手最合适' },
        { id: 's2', goal: '校对成稿', agentId: 'blog', reason: '编辑收尾' },
      ],
    })

    // 三表直查（绕过存储实现）：一个事务同落，没有半个计划。
    const taskRow = await admin.query<{ state: string; accepted: string | number }>(
      'SELECT state, accepted_version AS accepted FROM tasks WHERE id=$1', [taskId],
    )
    expect(taskRow.rows[0]?.state).toBe('running')
    expect(Number(taskRow.rows[0]?.accepted)).toBe(1)
    const subtaskRows = await admin.query<{ total: string }>('SELECT count(*) AS total FROM subtasks WHERE task_id=$1', [taskId])
    expect(Number(subtaskRows.rows[0]?.total)).toBe(2)
    const inputRows = await admin.query<{ version: number; text: string; source: string }>(
      'SELECT version, text, source FROM task_inputs WHERE task_id=$1 ORDER BY version', [taskId],
    )
    expect(inputRows.rows).toEqual([{ version: 1, text: goal, source: 'chat' }])

    // Console 读出一致：首版输入即版本 1，编号在事务内分配。
    const record = await console_.task(alice, taskId)
    expect(record.state).toBe('running')
    expect(record.acceptedVersion).toBe(1)
    expect(record.subtasks.map(item => [item.id, item.seq])).toEqual([['s1', 1], ['s2', 2]])
    const inputs = await storage.inputs(taskId)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ version: 1, text: goal, source: 'chat' })

    // 方言差异（§3）：busy 的 ORDER BY started_at NULLS FIRST 在 PG 上同样把「从未开始」
    // 排在最前；派出一步后该成员即占用。
    expect((await storage.busy(alice)).size).toBe(0)
    await storage.setSubtaskState(taskId, 's1', 'dispatched')
    const busy = await storage.busy(alice)
    expect(busy.get('blog')).toMatchObject({ taskId, subtaskId: 's1', state: 'dispatched' })
  })

  it('4. 重启恢复：实例 A 置 running 后 close；实例 B init 时 failInterrupted 收成 failed，历史可读', async () => {
    const storeA = await openStorage()
    const { console_: consoleA } = session(storeA)
    const conversationId = `butler-web-${randomUUID()}`
    const taskId = `butler-task-${randomUUID()}`
    await storeA.reserveConversation(conversationId, alice)
    await storeA.createTask({
      id: taskId,
      conversationId,
      actor: alice,
      goal: '跑到一半就断电',
      note: '',
      subtasks: [{ id: 's1', goal: '进行中的一步', agentId: 'blog', reason: '' }],
    })
    await storeA.setSubtaskState(taskId, 's1', 'dispatched')
    await storeA.setSubtaskState(taskId, 's1', 'running')
    // 模拟进程在这里断掉：不做任何收尾，直接关库。
    await consoleA.dispose()
    await storeA.close()

    // 实例 B：新存储 + 新 ButlerConsole，同库；init 后按 index.ts 启动序列跑 failInterrupted。
    const storeB = await openStorage()
    const { console_: consoleB } = session(storeB)
    const interrupted = await storeB.failInterrupted()
    expect(interrupted).toBeGreaterThanOrEqual(1)

    const record = await consoleB.task(alice, taskId)
    expect(record.state).toBe('failed')
    expect(record.finishedAt).not.toBeNull()
    expect(record.subtasks[0]?.state).toBe('failed')
    // 历史可读：断电前的记录还在，能按状态筛出来。
    const history = await consoleB.history(alice, { offset: 0, limit: 10, keyword: '', state: 'failed' })
    expect(history.items.some(item => item.id === taskId)).toBe(true)
  })

  it('5. 故障语义：不可达 / 错误密码 / 版本不符 → 稳定码（不打印 DSN）', async () => {
    // 5.1 不可达（连接拒绝注入）：init 与 readyProbe 都以 storage_unreachable 拒绝。
    const unreachable = new PostgresTaskStorage('postgresql://127.0.0.1:1/butler_test')
    try {
      await expect(unreachable.init()).rejects.toSatisfy(error => hasStorageCode(error, 'storage_unreachable'))
      await expect(unreachable.readyProbe()).rejects.toSatisfy(error => hasStorageCode(error, 'storage_unreachable'))
    } finally {
      await unreachable.close()
    }

    // 5.2 错误密码（host 用真实主机，口令故意改错）：认证失败归类 storage_auth。
    const badAuth = new PostgresTaskStorage(wrongPasswordDsn(DSN))
    try {
      await expect(badAuth.init()).rejects.toSatisfy(error => hasStorageCode(error, 'storage_auth'))
    } finally {
      await badAuth.close()
    }

    // 5.3 版本不符：schema_version 改 99 后新存储 init 与已装载探针都以
    // storage_schema_version 拒绝；改完恢复，后续用例不受影响。
    await admin.query('UPDATE schema_version SET version = 99')
    const wrongVersion = new PostgresTaskStorage(DSN)
    try {
      await expect(wrongVersion.init()).rejects.toSatisfy(error => hasStorageCode(error, 'storage_schema_version'))
      await expect(wrongVersion.readyProbe()).rejects.toSatisfy(error => hasStorageCode(error, 'storage_schema_version'))
    } finally {
      await wrongVersion.close()
      await admin.query('UPDATE schema_version SET version = $1', [STORAGE_SCHEMA_VERSION])
    }

    // 5.4 缺表：tasks 暂时改名（保留数据），init 的表存在性核验以 storage_schema_missing
    // 拒绝、不自动建表；恢复后主存储继续可用。
    await admin.query('ALTER TABLE tasks RENAME TO tasks_hidden')
    const missingTable = new PostgresTaskStorage(DSN)
    try {
      await expect(missingTable.init()).rejects.toSatisfy(error => hasStorageCode(error, 'storage_schema_missing'))
    } finally {
      await missingTable.close()
      await admin.query('ALTER TABLE tasks_hidden RENAME TO tasks')
    }
    await expect(storage.counts(alice)).resolves.toBeDefined()
  })

  it('6. 生命周期：close 后任何操作与 readyProbe 都以 storage_closed 拒绝；readyProbe 正常路径通过', async () => {
    const disposable = await openStorage()
    // 已装载且版本正确：运行期探针通过（§2.5 成功路径）。
    await expect(disposable.readyProbe()).resolves.toBeUndefined()
    await disposable.close()
    await expect(disposable.counts(alice)).rejects.toSatisfy(error => hasStorageCode(error, 'storage_closed'))
    await expect(disposable.task(alice, 'butler-task-x')).rejects.toSatisfy(error => hasStorageCode(error, 'storage_closed'))
    await expect(disposable.readyProbe()).rejects.toSatisfy(error => hasStorageCode(error, 'storage_closed'))
    // 重复 close 安全。
    await expect(disposable.close()).resolves.toBeUndefined()
  })
})
