/**
 * 存量迁移工具（scripts/migrate-storage.ts）的行为验收。
 *
 * 绑定规格：《存量迁移/回滚验证方案》——源版本 0..8（0=空库直接初始化；9+ 拒绝）、逐版本
 * 直导不做就地升级、缺列投影等价、v5 logical_id 回填、claimed 人工核对项、停写点复核、
 * 回滚边界。等价性验收：同一 fixture 两路（直导 vs 副本先经旧 TaskStore.migrate() 升 8
 * 再导）逐列比对必须一致。
 *
 * 无 `BUTLER_MIGRATE_PG_DSN` 时整文件跳过（CI 无 PG 供给；验收证据需明示跳过）。目标库
 * 专用 butler_mig，测试内允许 DROP SCHEMA 重建（含库名防呆断言）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Pool } from 'pg'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TaskStore } from './helpers/sqlite-test-store.ts'
import { PostgresTaskStorage } from '../src/storage/postgres.ts'
import { main, runMigration } from '../scripts/migrate-storage.ts'

const DSN = process.env.BUTLER_MIGRATE_PG_DSN ?? ''
const silent = (): void => {}
/** 迁移要走真实网络与整库导入，放宽单用例时限。 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })

/** 用完就删的临时库；连同 WAL 旁文件一起清掉。 */
const opened: string[] = []
function tempDb(label: string): string {
  const path = join(tmpdir(), `butler-migrate-${label}-${randomUUID()}.sqlite`)
  opened.push(path)
  return path
}
afterEach(() => {
  for (const path of opened.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      // Windows 上文件可能仍被占着；临时目录会自己清，不必因此失败。
      try { rmSync(`${path}${suffix}`, { force: true }) } catch { /* 留给系统清理 */ }
    }
  }
})

/** 按该版本真实缺列建出旧形状库并写入样本行：跨 owner、claimed 请求、BLOB、损坏 JSON。 */
function createLegacyDb(path: string, version: number): void {
  const db = new DatabaseSync(path)
  const create = (name: string, columns: string[], primaryKey: string): void => {
    db.exec(`CREATE TABLE ${name} (${columns.join(',')}, PRIMARY KEY (${primaryKey}))`)
  }

  create('conversations', [
    'id TEXT NOT NULL', 'owner_namespace TEXT NOT NULL', 'owner_id TEXT NOT NULL', "title TEXT NOT NULL DEFAULT ''",
    'created_at INTEGER NOT NULL', 'updated_at INTEGER NOT NULL',
  ], 'id')
  const taskColumns = [
    'id TEXT NOT NULL', 'conversation_id TEXT NOT NULL', 'owner_namespace TEXT NOT NULL', 'owner_id TEXT NOT NULL',
    'goal TEXT NOT NULL', 'state TEXT NOT NULL', "note TEXT NOT NULL DEFAULT ''", "summary TEXT NOT NULL DEFAULT ''",
    "error TEXT NOT NULL DEFAULT ''",
    ...(version >= 4 ? ['accepted_version INTEGER NOT NULL DEFAULT 1', 'processed_version INTEGER NOT NULL DEFAULT 1'] : []),
    'created_at INTEGER NOT NULL', 'updated_at INTEGER NOT NULL', 'finished_at INTEGER',
  ]
  create('tasks', taskColumns, 'id')
  const subtaskColumns = [
    'task_id TEXT NOT NULL', 'id TEXT NOT NULL', 'seq INTEGER NOT NULL', 'goal TEXT NOT NULL',
    "agent_id TEXT NOT NULL DEFAULT ''", "reason TEXT NOT NULL DEFAULT ''", 'state TEXT NOT NULL',
    "result TEXT NOT NULL DEFAULT ''", "error TEXT NOT NULL DEFAULT ''",
    ...(version >= 2 ? ["artifacts TEXT NOT NULL DEFAULT ''", "conversation_id TEXT NOT NULL DEFAULT ''"] : []),
    ...(version >= 5 ? ["logical_id TEXT NOT NULL DEFAULT ''", "supersedes TEXT NOT NULL DEFAULT ''"] : []),
    ...(version >= 6 ? ["depends_on TEXT NOT NULL DEFAULT ''"] : []),
    ...(version >= 7 ? ['requires_external_action INTEGER NOT NULL DEFAULT 0'] : []),
    ...(version >= 8 ? ["input_refs TEXT NOT NULL DEFAULT ''", "member_return TEXT NOT NULL DEFAULT ''"] : []),
    'started_at INTEGER', 'finished_at INTEGER',
  ]
  create('subtasks', subtaskColumns, 'task_id, id')
  create('agent_aliases', [
    'owner_namespace TEXT NOT NULL', 'owner_id TEXT NOT NULL', 'agent_id TEXT NOT NULL',
    "display_name TEXT NOT NULL DEFAULT ''", "accent TEXT NOT NULL DEFAULT ''", 'avatar BLOB',
    "avatar_type TEXT NOT NULL DEFAULT ''", 'updated_at INTEGER NOT NULL',
  ], 'owner_namespace, owner_id, agent_id')
  if (version >= 3) {
    create('requests', [
      'owner_namespace TEXT NOT NULL', 'owner_id TEXT NOT NULL', 'kind TEXT NOT NULL', 'request_id TEXT NOT NULL',
      'digest TEXT NOT NULL', 'state TEXT NOT NULL', "run_id TEXT NOT NULL DEFAULT ''",
      "conversation_id TEXT NOT NULL DEFAULT ''", 'created_at INTEGER NOT NULL', 'updated_at INTEGER NOT NULL',
    ], 'owner_namespace, owner_id, kind, request_id')
  }
  if (version >= 4) {
    create('task_inputs', [
      'task_id TEXT NOT NULL', 'version INTEGER NOT NULL', 'text TEXT NOT NULL', 'source TEXT NOT NULL',
      'created_at INTEGER NOT NULL',
    ], 'task_id, version')
  }
  db.exec(`PRAGMA user_version = ${version}`)

  const insert = (table: string, row: Record<string, unknown>): void => {
    const columns = Object.keys(row)
    db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...columns.map(column => (row[column] ?? null) as SQLInputValue))
  }

  insert('conversations', { id: 'conv-alice-1', owner_namespace: 'user', owner_id: 'alice', title: '园区巡检', created_at: 1000, updated_at: 2000 })
  insert('conversations', { id: 'conv-bob-1', owner_namespace: 'user', owner_id: 'bob', title: '', created_at: 3000, updated_at: 4000 })
  insert('tasks', {
    id: 'task-a', conversation_id: 'conv-alice-1', owner_namespace: 'user', owner_id: 'alice', goal: '整理巡检报告',
    state: 'completed', note: '留意北门', summary: '三段报告', error: '', created_at: 5000, updated_at: 6000, finished_at: 7000,
    ...(version >= 4 ? { accepted_version: 2, processed_version: 2 } : {}),
  })
  insert('tasks', {
    id: 'task-b', conversation_id: 'conv-bob-1', owner_namespace: 'user', owner_id: 'bob', goal: '修北门灯',
    state: 'failed', note: '', summary: '', error: '灯没修好', created_at: 5100, updated_at: 6100, finished_at: 7100,
    ...(version >= 4 ? { accepted_version: 3, processed_version: 2 } : {}),
  })
  const subtask = (base: Record<string, unknown>): Record<string, unknown> => ({ task_id: 'task-a', ...base })
  const validInputRefs = JSON.stringify([{
    subtaskId: 's1', logicalId: 'g7', state: 'succeeded', text: '上游材料原文', artifacts: [{ title: '巡检表', path: '/blog/draft/9', kind: 'draft' }],
  }])
  const validMemberReturn = JSON.stringify({ protocol: 1, text: '协作返回原文' })
  insert('subtasks', subtask({
    id: 's1', seq: 1, goal: '汇总巡检记录', agent_id: 'blog', reason: '写手最合适', state: 'succeeded',
    result: '报告已整理', error: '', started_at: 6100, finished_at: 6500,
    ...(version >= 2 ? { artifacts: JSON.stringify([{ title: '巡检表', path: '/blog/draft/9', kind: 'draft' }]), conversation_id: 'blog-conv-1' } : {}),
    ...(version >= 5 ? { logical_id: 'g7', supersedes: '' } : {}),
    ...(version >= 6 ? { depends_on: '[]' } : {}),
    ...(version >= 7 ? { requires_external_action: 1 } : {}),
    ...(version >= 8 ? { input_refs: validInputRefs, member_return: validMemberReturn } : {}),
  }))
  insert('subtasks', subtask({
    id: 's2', seq: 2, goal: '等上游材料', agent_id: 'blog', reason: '', state: 'failed',
    result: '', error: '上游没给材料', started_at: 6200, finished_at: 6600,
    ...(version >= 2 ? { artifacts: '', conversation_id: '' } : {}),
    ...(version >= 5 ? { logical_id: '', supersedes: 'g7' } : {}),
    ...(version >= 6 ? { depends_on: '[ "g9", 42 ]' } : {}),
    ...(version >= 7 ? { requires_external_action: 0 } : {}),
    ...(version >= 8 ? { input_refs: '{oops', member_return: '' } : {}),
  }))
  insert('subtasks', subtask({
    id: 's3', seq: 3, goal: '排队中的一步', agent_id: 'verify-doll', reason: '', state: 'queued',
    result: '', error: '', started_at: null, finished_at: null,
    ...(version >= 2 ? { artifacts: '', conversation_id: '' } : {}),
    ...(version >= 5 ? { logical_id: 'g3', supersedes: '' } : {}),
    ...(version >= 6 ? { depends_on: '' } : {}),
    ...(version >= 7 ? { requires_external_action: 0 } : {}),
    ...(version >= 8 ? { input_refs: '', member_return: '' } : {}),
  }))
  insert('agent_aliases', {
    owner_namespace: 'user', owner_id: 'alice', agent_id: 'blog', display_name: '博客小姐', accent: '#aabbcc',
    avatar: new Uint8Array([137, 80, 78, 71, 13, 10]), avatar_type: 'image/png', updated_at: 9500,
  })
  insert('agent_aliases', {
    owner_namespace: 'user', owner_id: 'bob', agent_id: 'verify-doll', display_name: '', accent: '',
    avatar: null, avatar_type: '', updated_at: 9600,
  })
  if (version >= 3) {
    insert('requests', {
      owner_namespace: 'user', owner_id: 'alice', kind: 'chat', request_id: 'req-claimed', digest: 'digest-claimed',
      state: 'claimed', run_id: '', conversation_id: '', created_at: 8000, updated_at: 9000,
    })
    insert('requests', {
      owner_namespace: 'user', owner_id: 'bob', kind: 'chat', request_id: 'req-finished', digest: 'digest-finished',
      state: 'finished', run_id: 'run-1', conversation_id: 'conv-bob-1', created_at: 8100, updated_at: 9100,
    })
  }
  if (version >= 4) {
    insert('task_inputs', { task_id: 'task-a', version: 1, text: '最初请求', source: 'chat', created_at: 5100 })
    insert('task_inputs', { task_id: 'task-a', version: 2, text: '补充北门', source: 'supplement', created_at: 5200 })
  }
  db.close()
}

/** 该版本导入后期望的子任务投影列（s1 成功行 / s2 失败行 / s3 排队行）。 */
function expectedSubtask(version: number, id: 's1' | 's2' | 's3'): Record<string, unknown> {
  const logicalBackfilled = `g${id === 's1' ? 1 : id === 's2' ? 2 : 3}`
  if (id === 's1') {
    return {
      artifacts: version >= 2 ? JSON.stringify([{ title: '巡检表', path: '/blog/draft/9', kind: 'draft' }]) : '',
      conversation_id: version >= 2 ? 'blog-conv-1' : '',
      logical_id: version >= 5 ? 'g7' : logicalBackfilled,
      supersedes: '',
      depends_on: version >= 6 ? '[]' : '',
      requires_external_action: version >= 7 ? 1 : 0,
      state: 'succeeded',
    }
  }
  if (id === 's2') {
    return {
      artifacts: '',
      conversation_id: '',
      // v5+ 已有值（含空值）原样保留；v1..v4 缺列按 'g'||seq 回填。
      logical_id: version >= 5 ? '' : logicalBackfilled,
      supersedes: version >= 5 ? 'g7' : '',
      depends_on: version >= 6 ? '[ "g9", 42 ]' : '',
      requires_external_action: 0,
      state: 'failed',
    }
  }
  return {
    artifacts: '',
    conversation_id: '',
    logical_id: 'g3',
    supersedes: '',
    depends_on: '',
    requires_external_action: 0,
    state: 'queued',
  }
}

describe.skipIf(DSN === '')('butler 存量迁移工具（butler_mig）', () => {
  let admin: Pool

  beforeAll(() => {
    admin = new Pool({ connectionString: DSN, max: 2 })
  })

  /** 重建目标 schema。清库前核对 DSN 确实指向 *_mig 专用库，配错时立即失败，绝不 DROP 别的库。 */
  async function resetTarget(): Promise<void> {
    const client = await admin.connect()
    try {
      const current = await client.query<{ name: string }>('SELECT current_database() AS name')
      const databaseName = current.rows[0]?.name ?? ''
      expect(databaseName.endsWith('_mig'), `DSN 指向的数据库「${databaseName}」不是 *_mig 迁移测试库，拒绝 DROP SCHEMA public CASCADE`).toBe(true)
      await client.query('DROP SCHEMA public CASCADE')
      await client.query('CREATE SCHEMA public')
    } finally {
      client.release()
    }
  }

  async function businessTableCount(): Promise<number> {
    const result = await admin.query<{ total: string }>(
      "SELECT count(*) AS total FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    )
    return Number(result.rows[0]?.total ?? 0)
  }

  /** 目标库全量内容的规范化快照：逐表全列 JSON 化后排序，两路导入结果逐列比对的载体。 */
  async function dumpAll(): Promise<Record<string, string[]>> {
    const tables: readonly (readonly [string, string])[] = [
      ['conversations', 'id'],
      ['tasks', 'id'],
      ['subtasks', 'task_id, id'],
      ['agent_aliases', 'owner_namespace, owner_id, agent_id'],
      ['requests', 'owner_namespace, owner_id, kind, request_id'],
      ['task_inputs', 'task_id, version'],
    ]
    const dump: Record<string, string[]> = {}
    for (const [table, order] of tables) {
      const result = await admin.query(`SELECT * FROM ${table} ORDER BY ${order}`)
      dump[table] = result.rows
        .map(row => JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value))
        .sort()
    }
    return dump
  }

  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`v${version} 旧形状库直导：投影默认、v5 回填、损坏原样、owner 不变，并与旧 migrate() 链等价`, async () => {
      const source = tempDb(`v${version}`)
      createLegacyDb(source, version)

      // 路一：逐版本直导。日志收下来核 claimed 人工核对清单；源库文件字节前后必须
      // 一致——只读保证的直接证据，不靠间接推断。
      await resetTarget()
      const logs: string[] = []
      const sourceHashBefore = createHash('sha256').update(readFileSync(source)).digest('hex')
      await runMigration({ sourcePath: source, dsn: DSN, log: line => { logs.push(line) } })
      expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceHashBefore)
      if (version >= 3) {
        expect(logs.some(line => line.includes('claimed 结果不明请求：1 条'))).toBe(true)
        expect(logs.some(line => line.includes('req-claimed'))).toBe(true)
      }

      const versionRow = await admin.query<{ version: number }>('SELECT version FROM schema_version')
      expect(Number(versionRow.rows[0]?.version)).toBe(8)
      const counts = new Map<string, number>()
      for (const table of ['conversations', 'tasks', 'subtasks', 'agent_aliases', 'requests', 'task_inputs']) {
        const result = await admin.query<{ total: string }>(`SELECT count(*) AS total FROM ${table}`)
        counts.set(table, Number(result.rows[0]?.total ?? 0))
      }
      expect(counts.get('conversations')).toBe(2)
      expect(counts.get('tasks')).toBe(2)
      expect(counts.get('subtasks')).toBe(3)
      expect(counts.get('agent_aliases')).toBe(2)
      expect(counts.get('requests')).toBe(version >= 3 ? 2 : 0)
      expect(counts.get('task_inputs')).toBe(version >= 4 ? 2 : 0)

      // 投影列与既有值逐列核对（含损坏 JSON 原样、v5 空值不补造）。
      const subtasks = await admin.query<Record<string, unknown>>("SELECT * FROM subtasks WHERE task_id='task-a' ORDER BY seq")
      expect(subtasks.rows).toHaveLength(3)
      expect(subtasks.rows[0]).toMatchObject(expectedSubtask(version, 's1'))
      expect(subtasks.rows[1]).toMatchObject(expectedSubtask(version, 's2'))
      expect(subtasks.rows[2]).toMatchObject(expectedSubtask(version, 's3'))
      if (version >= 8) {
        // 损坏 input_refs 原样搬入，不修补。
        expect(subtasks.rows[1]?.input_refs).toBe('{oops')
        expect(subtasks.rows[0]?.input_refs).toContain('上游材料原文')
        expect(subtasks.rows[0]?.member_return).toContain('协作返回原文')
      }

      // 输入版本投影：v1..v3 缺列按 1/1；v4+ 保留既有值。
      const taskA = await admin.query<Record<string, unknown>>("SELECT accepted_version, processed_version FROM tasks WHERE id='task-a'")
      expect(Number(taskA.rows[0]?.accepted_version)).toBe(version >= 4 ? 2 : 1)
      expect(Number(taskA.rows[0]?.processed_version)).toBe(version >= 4 ? 2 : 1)

      // BLOB 与 owner 归属不变。
      const avatar = await admin.query<{ avatar: Buffer }>("SELECT avatar FROM agent_aliases WHERE owner_id='alice' AND agent_id='blog'")
      expect(new Uint8Array(avatar.rows[0]?.avatar ?? new Uint8Array(0))).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10]))
      const bobTasks = await admin.query<{ id: string }>("SELECT id FROM tasks WHERE owner_namespace='user' AND owner_id='bob'")
      expect(bobTasks.rows.map(row => row.id)).toEqual(['task-b'])
      if (version >= 3) {
        const claimed = await admin.query<{ state: string }>("SELECT state FROM requests WHERE request_id='req-claimed'")
        expect(claimed.rows[0]?.state).toBe('claimed')
      }

      // 路二（等价性验收）：副本先经旧 TaskStore.migrate() 升 8 再导出导入，两路逐列比对。
      const dumpDirect = await dumpAll()
      const upgraded = tempDb(`v${version}-upgraded`)
      copyFileSync(source, upgraded)
      const store = new TaskStore(upgraded)
      store.close()
      const verify = new DatabaseSync(upgraded, { readOnly: true })
      const sourceVersionRow = verify.prepare('PRAGMA user_version').get() as unknown as { user_version?: number } | undefined
      expect(Number(sourceVersionRow?.user_version ?? 0)).toBe(8)
      verify.close()

      await resetTarget()
      await runMigration({ sourcePath: upgraded, dsn: DSN, log: silent })
      const dumpUpgraded = await dumpAll()
      expect(dumpUpgraded).toEqual(dumpDirect)
    })
  }

  it('空库（user_version=0）只初始化目标结构，六张表全空', async () => {
    const source = tempDb('empty')
    const db = new DatabaseSync(source)
    db.close()
    await resetTarget()
    await runMigration({ sourcePath: source, dsn: DSN, log: silent })
    const versionRow = await admin.query<{ version: number }>('SELECT version FROM schema_version')
    expect(Number(versionRow.rows[0]?.version)).toBe(8)
    for (const table of ['conversations', 'tasks', 'subtasks', 'agent_aliases', 'requests', 'task_inputs']) {
      const result = await admin.query<{ total: string }>(`SELECT count(*) AS total FROM ${table}`)
      expect(Number(result.rows[0]?.total ?? 0)).toBe(0)
    }
  })

  it('user_version=9 拒绝迁移：main 返回退出码 2（支持环境变量 DSN）', async () => {
    const source = tempDb('v9')
    createLegacyDb(source, 8)
    const db = new DatabaseSync(source)
    db.exec('PRAGMA user_version = 9')
    db.close()
    await resetTarget()
    const code = await main(['--source', source], { BUTLER_MIGRATE_PG_DSN: DSN }, silent)
    expect(code).toBe(2)
    // 拒绝时目标库不落任何表。
    expect(await businessTableCount()).toBe(0)
  })

  it('user_version=0 但已有表：来历不明拒绝（退出码 2）', async () => {
    const source = tempDb('v0-with-tables')
    createLegacyDb(source, 8)
    const db = new DatabaseSync(source)
    db.exec('PRAGMA user_version = 0')
    db.close()
    await resetTarget()
    await expect(runMigration({ sourcePath: source, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 2 })
    expect(await businessTableCount()).toBe(0)
  })

  it('目标库业务表非空：拒绝叠加导入（退出码 3）', async () => {
    const source = tempDb('target-nonempty')
    createLegacyDb(source, 8)
    await resetTarget()
    await runMigration({ sourcePath: source, dsn: DSN, log: silent })
    await expect(runMigration({ sourcePath: source, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 3 })
    // 已导入的数据不被第二次尝试破坏。
    const tasks = await admin.query<{ total: string }>('SELECT count(*) AS total FROM tasks')
    expect(Number(tasks.rows[0]?.total)).toBe(2)
  })

  it('目标库版本不符（schema_version=7）：拒绝（退出码 3）', async () => {
    const source = tempDb('target-v7')
    createLegacyDb(source, 8)
    await resetTarget()
    const client = await admin.connect()
    try {
      const sql = readFileSync(new URL('../migrations/postgres/0001_init.sql', import.meta.url), 'utf8')
      await client.query(sql)
      await client.query('UPDATE schema_version SET version = 7')
    } finally {
      client.release()
    }
    await expect(runMigration({ sourcePath: source, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 3 })
  })

  it('停写点复核失败：导入期间源库被并发写入，整体回滚且退出码 4', async () => {
    const source = tempDb('stopwrite')
    createLegacyDb(source, 8)
    await resetTarget()
    await expect(runMigration({
      sourcePath: source,
      dsn: DSN,
      log: silent,
      // 双连接模拟「停写被破坏」：导入写入完成、复核之前，第二个读写连接插进一条新会话。
      onBeforeStopWriteRecheck: () => {
        const writer = new DatabaseSync(source)
        writer.prepare("INSERT INTO conversations(id,owner_namespace,owner_id,title,created_at,updated_at) VALUES('conv-late','user','carol','',99000,99100)").run()
        writer.close()
      },
    })).rejects.toMatchObject({ exitCode: 4 })
    // 整体回滚：结构初始化与数据都不留痕。
    expect(await businessTableCount()).toBe(0)
  })

  it('dry-run：只盘点与校验，目标库不落任何表', async () => {
    const source = tempDb('dry-run')
    createLegacyDb(source, 8)
    await resetTarget()
    const code = await main(['--source', source, '--dsn', DSN, '--dry-run'], {}, silent)
    expect(code).toBe(0)
    expect(await businessTableCount()).toBe(0)
  })

  it('缺少 --source 与 DSN：退出码 1', async () => {    expect(await main([], {}, silent)).toBe(1)
    expect(await main(['--source', 'whatever.sqlite'], {}, silent)).toBe(1)
  })

  it('未知参数疑似连接串：回显脱敏不含其值（退出码 1）', async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    try {
      const code = await main(['--bogus=postgresql://user:secret@host:5432/db'])
      expect(code).toBe(1)
      const joined = errors.join('\n')
      expect(joined).not.toContain('secret')
      expect(joined).not.toContain('postgresql://')
      expect(joined).toContain('--bogus=<…>')
    } finally {
      spy.mockRestore()
    }
  })

  it('表存在但主键列缺失：结构无法识别，拒绝而非静默按空表导入（退出码 2）', async () => {
    const source = tempDb('broken-shape')
    const db = new DatabaseSync(source)
    db.exec("CREATE TABLE conversations (cid TEXT NOT NULL, owner_namespace TEXT NOT NULL, owner_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (cid))")
    db.exec('PRAGMA user_version = 8')
    db.close()
    await resetTarget()
    await expect(runMigration({ sourcePath: source, dsn: DSN, log: silent })).rejects.toMatchObject({ exitCode: 2 })
    await expect(businessTableCount()).resolves.toBe(0)
  })

  it('迁移导入后首次启动：running 遗留被 failInterrupted 收敛（定稿 §7 组合场景）', async () => {
    const source = tempDb('v8-first-start')
    createLegacyDb(source, 8)
    await resetTarget()
    await runMigration({ sourcePath: source, dsn: DSN, log: silent })
    // 模拟「导入内容正是停写时的在途状态」：把一条已完成任务改回 running 带在途子任务。
    await admin.query("UPDATE tasks SET state='running', finished_at=NULL WHERE id='task-a'")
    await admin.query("UPDATE subtasks SET state='running', started_at=6000, finished_at=NULL WHERE id='s1' AND task_id='task-a'")
    const storage = new PostgresTaskStorage(DSN)
    await storage.init()
    const interrupted = await storage.failInterrupted()
    expect(interrupted).toBeGreaterThanOrEqual(1)
    const taskRow = await admin.query<{ state: string; finished_at: string | null }>("SELECT state, finished_at FROM tasks WHERE id='task-a'")
    expect(taskRow.rows[0]?.state).toBe('failed')
    expect(taskRow.rows[0]?.finished_at).not.toBeNull()
    const subRow = await admin.query<{ state: string }>("SELECT state FROM subtasks WHERE id='s1' AND task_id='task-a'")
    expect(subRow.rows[0]?.state).toBe('failed')
    await storage.close()
  })
})
