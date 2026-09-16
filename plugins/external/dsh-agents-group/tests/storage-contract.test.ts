/**
 * 私有侧存储契约（真 PG）。
 *
 * ## 门控变量与**专属库**
 *
 * 用 `DSH_RUNTIME_TEST_PG_DSN`，缺省整文件跳过（跳过与通过是两件事，不报通过）。
 *
 * ⚠️ **它必须指向一个专属库**（CI 里是 `agents_group_runtime_test`），因为本文件会
 * `DROP SCHEMA public CASCADE` 重建结构。放进 `agents_group_test`（`migrate-blog-storage`
 * 与后续的运行时用例共用的那个库）会与它们互相破坏——实测就是两个别的用例红。
 * 这个库名与变量的对应关系写在 `.github/workflows/check.yml` 的 `postgres-contracts` job 里。
 *
 * ## 为什么按「领域语义」断言，而不是裸 SQL
 *
 * 裸 SQL 断言（"`UPDATE` 之后那一列是什么"）只证明语句语法对，证明不了**语义**对：
 * 授权有没有泄露存在性、幂等是不是真的只建一次、围栏方向是不是"pending 窗口内本地权威"、
 * 启动顺序能不能把崩溃窗口里的 pending 升格成 PG 的 failed —— 这些都要从**接口**走一遍。
 *
 * ## 三处最容易假绿的地方，这里都专门钉住
 *
 * 1. **同步面不能是异步的**：`record` / `mark` 一旦返回 `Promise`，kit 的分支判定就失效；
 *    `busy` 返回 `Promise` 则恒真 ⇒ 移除永远 409。所以断言里**不 await** 这两个。
 * 2. **本地遗留的 pending 必须升格、不能被抹掉**：这条只有"标记完就关进程、再起一个新实例"
 *    才测得出来——单实例里永远看不出方向错。
 * 3. **启动顺序**（排空 outbox → PG 清理 → 按 PG 收敛）：顺序反了会把本地 pending 抹成空，
 *    围栏失效而宿主可能已经归档 ⇒ 幽灵会话。
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import { createAgentDatabase, type AgentDatabaseFacade } from '../packages/runtime/src/storage/index.ts'
import { applySchema } from '../../../../private-deploy/db/create.mjs'

const DSN = process.env.DSH_RUNTIME_TEST_PG_DSN ?? ''
/** 用 DDL 里已有版本行的插件 id：本测试不该往生产表结构里加测试专用行。 */
const AGENT = 'closedoff'
const SQL_FILE = fileURLToPath(new URL('../../../../private-deploy/db/0001_init.sql', import.meta.url))

const actor = { namespace: 'user', userId: 'alice', sessionId: 'login-a' } as const
const otherActor = { namespace: 'user', userId: 'bob', sessionId: 'login-b' } as const
const owner = { namespace: actor.namespace, userId: actor.userId }
const otherOwner = { namespace: otherActor.namespace, userId: otherActor.userId }

let admin: Client
let dir: string

/** 每个用例一份**文件**本地库：`mark` 之后关掉、换个实例再开，才测得出"重启后的收敛"。 */
async function newFacade(agentId = AGENT, runtimeVersion?: number)
  : Promise<{ readonly db: AgentDatabaseFacade; readonly path: string }> {
  const path = join(dir, `${randomUUID()}.sqlite`)
  const db = createAgentDatabase({
    dsn: DSN,
    agentId,
    localPath: path,
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
  })
  await db.assertSchema()
  return { db, path }
}

/** 重启：同一个本地库文件、全新的实例（PG 连接也重来）。 */
function reopen(path: string): AgentDatabaseFacade {
  return createAgentDatabase({ dsn: DSN, agentId: AGENT, localPath: path })
}

const conversationId = () => `closedoff-web-${randomUUID()}`

async function removalStateOf(id: string): Promise<string> {
  const rows = await admin.query<{ removal_state: string }>('SELECT removal_state FROM dsh_conversations WHERE id = $1', [id])
  return rows.rows[0]?.removal_state ?? '<missing>'
}

/**
 * `titleSource` 不在端口暴露的 `ConversationRecordShape` 里（端口有意只给
 * `id/title/updatedAt/deletedAt/removalState/ready`），所以只能直接查库。
 */
async function titleSourceOf(id: string): Promise<string> {
  const rows = await admin.query<{ title_source: string }>('SELECT title_source FROM dsh_conversations WHERE id = $1', [id])
  return rows.rows[0]?.title_source ?? '<missing>'
}

describe.skipIf(DSN === '')('私有侧存储契约（真 PG）', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-storage-'))
    admin = new Client({ connectionString: DSN })
    await admin.connect()
    // 重建 public schema（与 CI 的做法一致），保证每次跑都是干净结构。
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE')
    await admin.query('CREATE SCHEMA public')
    await applySchema(admin, readFileSync(SQL_FILE, 'utf8'), { log: () => { /* 静默 */ } })
  }, 60_000)

  afterAll(async () => {
    await admin?.end()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // 一行都不留：每个用例自带全部前置数据（用例之间不依赖执行顺序）。
    await admin.query('DELETE FROM dsh_conversations')
    await admin.query('DELETE FROM dsh_turns')
  })

  // -------------------------------------------------------------------
  // 一、授权：owner + agent 双维度隔离
  // -------------------------------------------------------------------

  it('conversationOf 只认自己的 owner，别人的返回 undefined（不泄露存在性）', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      expect(await db.conversations.conversationOf(owner, id)).toMatchObject({ conversationId: id, agentId: AGENT })
      expect(await db.conversations.conversationOf(otherOwner, id)).toBeUndefined()
    } finally { await db.close() }
  })

  it('D4 回归：空标题（缺省 / {} / 空串）落 automatic，只有非空标题才落 manual', async () => {
    const { db } = await newFacade()
    try {
      // 生产路径传的正是 `{ title: '' }`（不是缺省）。只看 `undefined` 会把它当人工标题，
      // 于是 `syncTitle(..., 'automatic')` 被 `title_source = 'automatic'` 守卫拒绝 ⇒
      // 侧栏标题永久为空。三种"没给标题"的写法必须都落 `automatic`。
      for (const initial of [undefined, {}, { title: '' }] as const) {
        const id = conversationId()
        const record = await db.conversations.create(owner, id, '', initial)
        expect(record.title, `initial=${JSON.stringify(initial)}`).toBe('')
        expect(await titleSourceOf(id), `initial=${JSON.stringify(initial)}`).toBe('automatic')
      }
      // 反向：非空标题仍必须是人工来源，否则自动结果会覆盖用户明确取的标题。
      const manualId = conversationId()
      const manual = await db.conversations.create(owner, manualId, '', { title: '人工标题' })
      expect(manual.title).toBe('人工标题')
      expect(await titleSourceOf(manualId)).toBe('manual')
    } finally { await db.close() }
  })

  it('同步 record：他人 actor 与「不是本 Agent 的行」都抛同一个 404', async () => {
    const { db } = await newFacade()
    const other = await newFacade('blog')
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      // 同步调用：这里**不能** await —— 契约要求同步。
      expect(db.conversations.record(actor, id)).toMatchObject({ id, ready: false, removalState: '' })
      expect(() => db.conversations.record(otherActor, id)).toThrow(AccessError)

      // 同一个人、不同 agent_id：必须也看不见（跨 Agent 串数据是实测过的坑）。
      const blogId = `blog-chat-${randomUUID()}`
      await other.db.conversations.create(owner, blogId, '')
      expect(() => db.conversations.record(actor, blogId)).toThrow(AccessError)
    } finally {
      await other.db.close()
      await db.close()
    }
  })

  it('list 带 agent_id 过滤：不会串到别的 Agent', async () => {
    const { db } = await newFacade()
    const other = await newFacade('blog')
    try {
      const mine = conversationId()
      const blogId = `blog-chat-${randomUUID()}`
      await db.conversations.create(owner, mine, '', { title: '我的会话' })
      await db.conversations.publish(owner, mine)
      await other.db.conversations.create(owner, blogId, '', { title: '博客的会话' })
      await other.db.conversations.publish(owner, blogId)
      const page = await db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })
      // 漏 agent_id 的话这里会列出两条（实测过：管家侧栏列出别的 Agent 的会话）。
      expect(page.items.map(item => item.id)).toEqual([mine])
      expect(page.total).toBe(1)
    } finally {
      await other.db.close()
      await db.close()
    }
  })

  it('未发布的会话不进侧栏（ready 是可见性/可删的门）', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '', { title: '还没发布' })
      const before = await db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })
      expect(before.items).toHaveLength(0)
      await db.conversations.publish(owner, id)
      const after = await db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })
      expect(after.items.map(item => item.id)).toEqual([id])
    } finally { await db.close() }
  })

  // -------------------------------------------------------------------
  // 二、幂等：创建幂等 / 轮次幂等
  // -------------------------------------------------------------------

  it('同一个 requestId 再 create 返回原行，不新建', async () => {
    const { db } = await newFacade()
    try {
      const first = conversationId()
      const second = conversationId()
      const created = await db.conversations.create(owner, first, 'mission-1', { title: '第一次' })
      const again = await db.conversations.create(owner, second, 'mission-1', { title: '第二次' })
      expect(again.id).toBe(created.id)
      expect(again.title).toBe('第一次')
      const rows = await admin.query<{ total: number }>('SELECT count(*)::int AS total FROM dsh_conversations')
      expect(rows.rows[0]?.total).toBe(1)
    } finally { await db.close() }
  })

  it('requestId 为空串时不参与幂等（管家语义）：两次 create 建两行', async () => {
    const { db } = await newFacade()
    try {
      await db.conversations.create(owner, conversationId(), '')
      await db.conversations.create(owner, conversationId(), '')
      const rows = await admin.query<{ total: number }>('SELECT count(*)::int AS total FROM dsh_conversations')
      // 部分唯一索引的谓词 `WHERE request_id <> ''` 把空串排除在外——没有它，所有管家会话会互相冲突。
      expect(rows.rows[0]?.total).toBe(2)
    } finally { await db.close() }
  })

  it('missionRequestId 是纯函数，且跨 Agent / 跨 owner 不撞键', async () => {
    const { db } = await newFacade()
    const other = await newFacade('blog')
    try {
      expect(db.conversations.missionRequestId(owner, 'm1')).toBe(db.conversations.missionRequestId(owner, 'm1'))
      expect(db.conversations.missionRequestId(owner, 'm1')).not.toBe(db.conversations.missionRequestId(otherOwner, 'm1'))
      expect(other.db.conversations.missionRequestId(owner, 'm1')).not.toBe(db.conversations.missionRequestId(owner, 'm1'))
    } finally {
      await other.db.close()
      await db.close()
    }
  })

  it('轮次幂等：同 requestId 同输入 = duplicate，换输入 = 409', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      expect(await db.turns.claim(owner, id, 'req-1', 'hash-a')).toBe('claimed')
      expect(await db.turns.claim(owner, id, 'req-1', 'hash-a')).toBe('duplicate')
      // 换输入必须报冲突：静默重跑会让带副作用的活干两遍。
      await expect(db.turns.claim(owner, id, 'req-1', 'hash-b')).rejects.toThrow(AccessError)
      await db.turns.finish(owner, 'req-1')
      expect(await db.turns.claim(owner, id, 'req-1', 'hash-a')).toBe('duplicate')
    } finally { await db.close() }
  })

  it('轮次缺少 requestId 时明确拒绝（不伪造幂等身份）', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await expect(db.turns.claim(owner, id, '', 'hash')).rejects.toThrow(/缺少幂等身份/u)
    } finally { await db.close() }
  })

  it('turnStatus 三态：无行 ⇒ undefined；认领未结算 ⇒ claimed；结算后 ⇒ finished（跨实例仍可读）', async () => {
    const id = conversationId()
    const first = await newFacade()
    try {
      await first.db.conversations.create(owner, id, '')
      // 还没有行时必须答 `undefined`，**不能**答 `'claimed'` —— 后者会让"从没跑过"看起来像
      // "跑到一半崩了"，接线处就会放行一次本该被拒的重放。
      expect(await first.db.turns.turnStatus(owner, 'req-t')).toBeUndefined()
      expect(await first.db.turns.claim(owner, id, 'req-t', 'hash')).toBe('claimed')
      expect(await first.db.turns.turnStatus(owner, 'req-t')).toBe('claimed')
      await first.db.turns.finish(owner, 'req-t')
      expect(await first.db.turns.turnStatus(owner, 'req-t')).toBe('finished')
      // 空 requestId 表示"没有幂等身份"，不该答出任何状态。
      expect(await first.db.turns.turnStatus(owner, '')).toBeUndefined()
    } finally { await first.db.close() }

    // 换个实例（等价于重启）—— 这正是接线要解决的问题：重启后能分辨"已交付"与"崩在半路"。
    const second = reopen(first.path)
    try {
      expect(await second.turns.turnStatus(owner, 'req-t')).toBe('finished')
    } finally { await second.close() }
  })

  it('turnStatus 只认自己的 owner（别人的轮次返回 undefined，不泄露状态）', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.turns.claim(owner, id, 'req-o', 'hash')
      expect(await db.turns.turnStatus(owner, 'req-o')).toBe('claimed')
      // 同一个 requestId、不同的人：答出状态会让别人的重试被判成"已结算"而静默丢活。
      expect(await db.turns.turnStatus(otherOwner, 'req-o')).toBeUndefined()
    } finally { await db.close() }
  })

  // -------------------------------------------------------------------
  // 三、待答问题：重启后仍能恢复"在等什么"
  // -------------------------------------------------------------------

  it('待答问题落 PG：换个实例（等价于重启）仍读得回来', async () => {
    const id = conversationId()
    const first = await newFacade()
    try {
      await first.db.conversations.create(owner, id, '')
      await first.db.conversations.publish(owner, id)
      await first.db.turns.setPendingQuestion(owner, id, '采用哪一版？')
      expect(await first.db.turns.pendingQuestion(owner, id)).toBe('采用哪一版？')
    } finally { await first.db.close() }

    const second = reopen(first.path)
    try {
      expect(await second.turns.pendingQuestion(owner, id)).toBe('采用哪一版？')
      await second.turns.setPendingQuestion(owner, id, undefined)
      expect(await second.turns.pendingQuestion(owner, id)).toBeUndefined()
    } finally { await second.close() }
  })

  it('待答问题按 owner 隔离：别人的会话读不到', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.turns.setPendingQuestion(owner, id, '等你确认')
      expect(await db.turns.pendingQuestion(otherOwner, id)).toBeUndefined()
    } finally { await db.close() }
  })

  // -------------------------------------------------------------------
  // 四、删除围栏：方向 + 原子性 + 启动顺序（本任务的要害）
  // -------------------------------------------------------------------

  it('mark 是同步的，且立刻改变同步 record 的结果', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      db.conversations.mark(actor, id, 'pending')   // 同步，不 await
      expect(db.conversations.record(actor, id).removalState).toBe('pending')
    } finally { await db.close() }
  })

  it('mark 在同一本地事务里写标记 + outbox：标记生效时指令一定在队列里', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      expect(db.health().fence.depth).toBe(0)
      db.conversations.mark(actor, id, 'pending')
      // 两者必须同生：标记写了而指令丢了，PG 永远不知道这次移除。
      expect(db.conversations.record(actor, id).removalState).toBe('pending')
      expect(db.health().fence.depth).toBe(1)
      expect(db.health().fence.oldestAt).toBeTypeOf('number')
    } finally { await db.close() }
  })

  it('removed 时补 deletedAt，且重复标记不刷新它', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      db.conversations.mark(actor, id, 'removed')
      const first = db.conversations.record(actor, id).deletedAt
      expect(first).toBeTypeOf('number')
      await delay(5)
      db.conversations.mark(actor, id, 'removed')
      expect(db.conversations.record(actor, id).deletedAt).toBe(first)
    } finally { await db.close() }
  })

  it('★ 崩溃窗口：本地遗留的 pending 先升格进 PG，再由 PG 清理翻成 failed（不是被抹掉）', async () => {
    const id = conversationId()
    const first = await newFacade()
    await first.db.conversations.create(owner, id, '')
    await first.db.conversations.publish(owner, id)
    first.db.conversations.mark(actor, id, 'pending')
    expect(first.db.health().fence.depth).toBe(1)
    // PG 此刻还是空的：那条指令只在本地队列里（这正是崩溃窗口）。
    expect(await removalStateOf(id)).toBe('')
    await first.db.close()

    const second = reopen(first.path)
    try {
      await second.open()
      // ① 排空把本地 pending 补成 PG pending；② PG 清理翻 failed；③ 收敛回本地。
      expect(await removalStateOf(id)).toBe('failed')
      expect(second.conversations.record(actor, id).removalState).toBe('failed')
      expect(second.health().fence.depth).toBe(0)
    } finally { await second.close() }
  })

  it('★ 每会话 FIFO：pending → removed 按序补写，最终不会倒挂成 pending', async () => {
    const id = conversationId()
    const first = await newFacade()
    await first.db.conversations.create(owner, id, '')
    await first.db.conversations.publish(owner, id)
    first.db.conversations.mark(actor, id, 'pending')
    first.db.conversations.mark(actor, id, 'removed')
    expect(first.db.health().fence.depth).toBe(2)
    await first.db.close()

    const second = reopen(first.path)
    try {
      await second.open()
      // 反序补写的话 removed 会先写、pending 后写把它盖掉，会话从此既删不掉也打不开。
      // 两条都补完后 PG 是 removed，但**启动清理**只翻 pending，所以最终仍是 removed。
      expect(await removalStateOf(id)).toBe('removed')
      expect(await second.conversations.conversationOf(owner, id)).toBeDefined()
      expect(second.health().fence.depth).toBe(0)
    } finally { await second.close() }
  })

  it('标题 outbox：同步投递 → 后台补写，且自动标题不覆盖手动标题', async () => {
    const id = conversationId()
    const first = await newFacade()
    await first.db.conversations.create(owner, id, '')
    await first.db.conversations.publish(owner, id)
    await first.db.conversations.syncTitle(owner, id, '老板取的名字', 'manual')
    first.db.titleSink().submit(AGENT, id, '自动生成的名字', 'generated')
    expect(first.db.health().title.depth).toBe(1)
    await first.db.close()

    const second = reopen(first.path)
    try {
      await second.open()
      const rows = await admin.query<{ title: string; title_source: string }>(
        'SELECT title, title_source FROM dsh_conversations WHERE id = $1', [id])
      expect(rows.rows[0]?.title).toBe('老板取的名字')
      expect(rows.rows[0]?.title_source).toBe('manual')
      expect(second.health().title.depth).toBe(0)
    } finally { await second.close() }
  })

  it('同步投递同一会话的多次标题只留最后一条（覆盖语义，不补中间态）', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      db.titleSink().submit(AGENT, id, '第一版', 'automatic')
      db.titleSink().submit(AGENT, id, '第二版', 'automatic')
      db.titleSink().submit(AGENT, id, '第三版', 'automatic')
      expect(db.health().title.depth).toBe(1)
    } finally { await db.close() }
  })

  it('busy 的项在 list 里是 busy 且不可移除（围栏据此拒绝）', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      const page = await db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [id], archived: [] })
      const item = page.items.find(entry => entry.id === id)
      expect(item?.state).toBe('busy')
      expect(item?.canRemove).toBe(false)
      expect(item?.blockedReason).toContain('正在运行')
    } finally { await db.close() }
  })

  it('删除围栏行不出现在侧栏（removed 之后列表为空）', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      db.conversations.mark(actor, id, 'removed')
      // 把 outbox 补进 PG（不重启，直接排空一次）。
      await db.open()
      const page = await db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })
      expect(page.items).toHaveLength(0)
    } finally { await db.close() }
  })

  // -------------------------------------------------------------------
  // 五、结构核验：缺表 / 版本
  // -------------------------------------------------------------------

  it('结构缺失与版本不符各自归类（不混成一个错）', async () => {
    // 缺表
    await admin.query('ALTER TABLE dsh_turn_results RENAME TO dsh_turn_results_hidden')
    const missing = createAgentDatabase({ dsn: DSN, agentId: AGENT, localPath: join(dir, `${randomUUID()}.sqlite`) })
    try {
      await expect(missing.assertSchema()).rejects.toMatchObject({ code: 'storage_schema_missing' })
    } finally {
      await missing.close()
      await admin.query('ALTER TABLE dsh_turn_results_hidden RENAME TO dsh_turn_results')
    }
    // 本 Agent 版本严格相等：改成 2 就拒绝。
    await admin.query('UPDATE dsh_schema_versions SET version = 2 WHERE plugin_id = $1', [AGENT])
    const mismatch = createAgentDatabase({ dsn: DSN, agentId: AGENT, localPath: join(dir, `${randomUUID()}.sqlite`) })
    try {
      await expect(mismatch.assertSchema()).rejects.toMatchObject({ code: 'storage_schema_version' })
    } finally {
      await mismatch.close()
      await admin.query('UPDATE dsh_schema_versions SET version = 1 WHERE plugin_id = $1', [AGENT])
    }
  })

  it('runtime 版本用「库 ≥ 插件内联」：库高一版仍然通过（rolling 升级不被一刀切）', async () => {
    await admin.query("UPDATE dsh_schema_versions SET version = 2 WHERE plugin_id = 'runtime'")
    const { db } = await newFacade(AGENT, 1)
    try {
      await expect(db.assertSchema()).resolves.toBeUndefined()
    } finally {
      await db.close()
      await admin.query("UPDATE dsh_schema_versions SET version = 1 WHERE plugin_id = 'runtime'")
    }
  })

  it('插件内联版本高于库版本时拒绝（要先跑升级入口）', async () => {
    const db = createAgentDatabase({ dsn: DSN, agentId: AGENT, localPath: join(dir, `${randomUUID()}.sqlite`), runtimeVersion: 99 })
    try {
      await expect(db.assertSchema()).rejects.toMatchObject({ code: 'storage_schema_version' })
    } finally { await db.close() }
  })
})
