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
import type { ConversationPageShape } from '../packages/runtime/src/storage/ports.ts'
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

/** 同上：`pinned` 也不在 `ConversationRecordShape` 里，往返只能直接查库。 */
async function pinnedOf(id: string): Promise<boolean | string> {
  const rows = await admin.query<{ pinned: boolean }>('SELECT pinned FROM dsh_conversations WHERE id = $1', [id])
  return rows.rows[0]?.pinned ?? '<missing>'
}

/** `updated_at` 是排序键，也直接查库读——`list` 之外的路径（`touch`）看不到它。 */
async function updatedAtOf(id: string): Promise<number> {
  const rows = await admin.query<{ updated_at: string | number }>('SELECT updated_at FROM dsh_conversations WHERE id = $1', [id])
  return Number(rows.rows[0]?.updated_at ?? Number.NaN)
}

async function titleOf(id: string): Promise<string> {
  const rows = await admin.query<{ title: string }>('SELECT title FROM dsh_conversations WHERE id = $1', [id])
  return rows.rows[0]?.title ?? '<missing>'
}

/**
 * 等一个条件成立，**上限 ~2 秒**后放弃。
 *
 * 用于"运行期后台排空"这类**没有返回 promise 可以 await**的路径：排空是 `mark` / `titleSink`
 * 触发的后台动作，调用方拿不到句柄（那正是"同步契约 + 后台补写"的形状）。用有界轮询而不是
 * 固定 `delay()`：固定等待在慢一点的环境上会随机红，而这里要测的是"最终会到"，不是延迟值。
 */
async function waitFor(check: () => Promise<boolean>, label = '后台补写没有在 2 秒内到达 PG'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await delay(10)
  }
  throw new Error(label)
}

/**
 * 同上，但判据是**同步的**（本地队列深度这类零往返的观测）。
 *
 * 两个版本分开是因为代价差一个数量级：异步版每轮一次 PG 往返（跳板机上几百毫秒），
 * 用它等"队列清空"会在一条用例里打满 5 秒超时。
 */
async function waitForSync(check: () => boolean, label = '条件没有在 5 秒内成立'): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return
    await delay(10)
  }
  throw new Error(label)
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

  it('syncTitle 的三道守卫：未发布 / 已删除 / 有围栏标记的会话都不写标题', async () => {
    // 守卫是 `ready = TRUE AND deleted_at IS NULL AND removal_state = ''`，此前**零覆盖**：
    // 既有"标题 outbox"用例覆盖的是"自动标题不覆盖手动标题"，删掉这三道里的任意一道都不会有
    // 用例变红。三道各自对应一个真实后果：给未发布的预留会话起标题会让它在侧栏提前可见；
    // 给已删除或待移除的会话改标题，会让移除围栏看到一条还在变的记录。
    const { db } = await newFacade()
    const titleOf = async (id: string): Promise<string> =>
      (await admin.query<{ title: string }>('SELECT title FROM dsh_conversations WHERE id = $1', [id])).rows[0]?.title ?? '<missing>'
    try {
      // ① 未发布（预留段，`ready = FALSE`）⇒ 写不进去。
      const reserved = conversationId()
      await db.conversations.create(owner, reserved, '')
      await db.conversations.syncTitle(owner, reserved, '预留段的标题', 'automatic')
      expect(await titleOf(reserved)).toBe('')

      // ② 已发布但已删除（`deleted_at` 非空）⇒ 写不进去。
      const deleted = conversationId()
      await db.conversations.create(owner, deleted, '')
      await db.conversations.publish(owner, deleted)
      await admin.query('UPDATE dsh_conversations SET deleted_at = $1 WHERE id = $2', [Date.now(), deleted])
      await db.conversations.syncTitle(owner, deleted, '删除后的标题', 'automatic')
      expect(await titleOf(deleted)).toBe('')

      // ③ 已发布但有围栏标记（`removal_state` 非空）⇒ 写不进去。
      const fenced = conversationId()
      await db.conversations.create(owner, fenced, '')
      await db.conversations.publish(owner, fenced)
      await admin.query("UPDATE dsh_conversations SET removal_state = 'pending' WHERE id = $1", [fenced])
      await db.conversations.syncTitle(owner, fenced, '围栏里的标题', 'automatic')
      expect(await titleOf(fenced)).toBe('')

      // 反向对照：同一条调用在**已发布、未删除、无围栏**的会话上必须真的写进去。少了这一条，
      // 上面三个"没写进去"可能只是整条路径没通（那就是三个天然假绿）。
      const healthy = conversationId()
      await db.conversations.create(owner, healthy, '')
      await db.conversations.publish(owner, healthy)
      await db.conversations.syncTitle(owner, healthy, '正常标题', 'automatic')
      expect(await titleOf(healthy)).toBe('正常标题')
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
  // 一·补、置顶与列表暴露的展示字段（业务页面依赖，kit 侧栏不用）
  // -------------------------------------------------------------------

  it('pin 往返：置位 / 复位都落 PG，换个实例（等价重启）仍读得回', async () => {
    const id = conversationId()
    const first = await newFacade()
    try {
      await first.db.conversations.create(owner, id, '')
      await first.db.conversations.publish(owner, id)
      expect(await pinnedOf(id)).toBe(false)
      await first.db.conversations.pin(owner, id, true)
      expect(await pinnedOf(id)).toBe(true)
    } finally { await first.db.close() }

    // 换一个实例（等价于重启）：置顶不是进程内状态，新实例的 `list` 也必须带着它。
    const second = reopen(first.path)
    try {
      const page = await second.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })
      expect(page.items.find(item => item.id === id)?.pinned).toBe(true)
      await second.conversations.pin(owner, id, false)
      expect(await pinnedOf(id)).toBe(false)
    } finally { await second.close() }
  })

  it('pin 按 owner 隔离：别人的 owner 调它一行都不动', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      // 两个 owner 的 namespace 相同、只有 `userId` 不同：能挡住这次写入的只有 `owner_id` 那一列
      // （删掉它，本条即红——这正是变异验证要确认的事）。方法不抛错，所以只能查库看有没有被改动。
      await db.conversations.pin(otherOwner, id, true)
      expect(await pinnedOf(id)).toBe(false)

      // 反向对照：本人调必须真的置上。少了这一条，上面那个"没生效"可能只是整条路径没通（天然假绿）。
      await db.conversations.pin(owner, id, true)
      expect(await pinnedOf(id)).toBe(true)
    } finally { await db.close() }
  })

  it('list 带出 pinned 与 titleSource（业务页面的置顶徽标与标题刷新靠这两个字段）', async () => {
    const { db } = await newFacade()
    const page = (): Promise<ConversationPageShape> =>
      db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')     // 空标题 ⇒ title_source = 'automatic'
      await db.conversations.publish(owner, id)
      // 未置顶时必须是 `false`（不是 `undefined`）：页面拿 `undefined` 会当成"不是置顶"，
      // 于是这条断言在"字段根本没带出来"和"带了但恒假"两种缺陷下各红一次。
      expect((await page()).items.find(item => item.id === id)).toMatchObject({ pinned: false, titleSource: 'automatic' })
      await db.conversations.pin(owner, id, true)
      expect((await page()).items.find(item => item.id === id)).toMatchObject({ pinned: true, titleSource: 'automatic' })

      // 反向对照：把 `titleSource` 写成常量 `'automatic'` 也能让上面两条通过，所以再来一条 manual 的会话。
      const manualId = conversationId()
      await db.conversations.create(owner, manualId, '', { title: '人工标题' })
      await db.conversations.publish(owner, manualId)
      expect((await page()).items.find(item => item.id === manualId)).toMatchObject({ pinned: false, titleSource: 'manual' })
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
  // 二·补、结果层（`dsh_turn_results`）：一轮交回的结构化产出
  // -------------------------------------------------------------------
  //
  // 这一层此前在运行时里**只出现在建表核验清单里、零读写方法**（`FRAMEWORK_TABLES` 有它）。
  // 下面钉住四件事：**行 id 与幂等键不同**（DDL 第 150 行的"同名不同义"）、JSONB 往返、
  // **按轮次隔离**、owner 隔离。

  it('结果层往返：行 id ≠ 幂等键；结果按轮次落库、JSONB 读回是对象、换实例仍读得回', async () => {
    const id = conversationId()
    const first = await newFacade()
    try {
      await first.db.conversations.create(owner, id, '')
      expect(await first.db.turns.claim(owner, id, 'req-res', 'hash')).toBe('claimed')
      const turnId = await first.db.turns.turnId(owner, 'req-res')
      expect(turnId).toBeDefined()
      // ⚠️ 这一条就是 DDL 第 150 行写的"同名不同义"：`turn_id` 装的是 turn 的**行 id**，
      // 而幂等身份是 `(agent, owner, request_id)` 上的部分唯一索引。接错了两者，"按轮次筛结果"
      // 会静默筛不到。
      expect(turnId).not.toBe('req-res')
      // 没落过结果时是空数组（"没有结果"是常态，不是异常）。
      expect(await first.db.turns.turnResults(owner, turnId!)).toEqual([])

      await first.db.turns.appendTurnResult(owner, {
        conversationId: id, turnId: turnId!, operationId: 'op-1',
        payload: { kind: 'candidate', draftId: 'd1', proposal: { id: 'p1' } },
      })
      await first.db.turns.appendTurnResult(owner, {
        conversationId: id, turnId: turnId!, operationId: 'op-1',
        payload: { kind: 'operation', status: 'prepared' },
      })
      const rows = await first.db.turns.turnResults(owner, turnId!)
      expect(rows).toHaveLength(2)
      // **同一次操作两条结果是允许的**（DDL 刻意不加 `(turn_id, operation_id)` 唯一约束：
      // 一轮同一操作可以有多条结果，身份是各自的 `id`）。
      expect(rows.map(row => row.operationId)).toEqual(['op-1', 'op-1'])
      expect(rows.map(row => row.payload.kind)).toEqual(['candidate', 'operation'])
      // JSONB 往返：读回是**对象**、字段还在（不是字符串，也不是被 parse 坏的形状）。
      expect(rows[0]!.payload.proposal).toEqual({ id: 'p1' })
      expect(rows[0]!.payload.draftId).toBe('d1')
      // `seq` / `createdAt` 是 BIGINT ⇒ 必须是 number：字符串会让排序静默退化成字典序
      // （"10" < "9"），而调用方按 `seq` 判插入序。
      expect(typeof rows[0]!.seq).toBe('number')
      expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq)
      expect(typeof rows[0]!.createdAt).toBe('number')
    } finally { await first.db.close() }

    // 换实例（等价于重启）：结果仍在，且仍按插入序。
    const second = reopen(first.path)
    try {
      const turnId = await second.turns.turnId(owner, 'req-res')
      expect(turnId).toBeDefined()
      expect((await second.turns.turnResults(owner, turnId!)).map(row => row.payload.kind))
        .toEqual(['candidate', 'operation'])
    } finally { await second.close() }
  })

  it('结果层按**轮次**隔离：两轮各自只看得到自己的结果', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.turns.claim(owner, id, 'req-a', 'hash-a')
      await db.turns.claim(owner, id, 'req-b', 'hash-b')
      const turnA = (await db.turns.turnId(owner, 'req-a'))!
      const turnB = (await db.turns.turnId(owner, 'req-b'))!
      // 同一个会话的两轮，行 id 不同（这是"按轮次筛"能成立的前提）。
      expect(turnA).not.toBe(turnB)
      await db.turns.appendTurnResult(owner, {
        conversationId: id, turnId: turnA, operationId: 'op-a', payload: { kind: 'a' },
      })
      expect((await db.turns.turnResults(owner, turnA)).map(row => row.payload.kind)).toEqual(['a'])
      // 另一轮看不到 —— 这是"结果串轮次"（把上一轮的材料当本轮交回）的判据。
      expect(await db.turns.turnResults(owner, turnB)).toEqual([])
    } finally { await db.close() }
  })

  it('结果层只认自己的 owner：别人的轮次读不到，也存在性也不泄露', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.turns.claim(owner, id, 'req-own', 'hash')
      const turnId = (await db.turns.turnId(owner, 'req-own'))!
      await db.turns.appendTurnResult(owner, {
        conversationId: id, turnId, operationId: 'op', payload: { kind: 'secret' },
      })
      // 同一个 requestId、不同的人：答出行 id 会让别人的重试被判成"已结算"而静默丢活。
      expect(await db.turns.turnId(otherOwner, 'req-own')).toBeUndefined()
      expect(await db.turns.turnResults(otherOwner, turnId)).toEqual([])
      // 空 requestId 表示"没有幂等身份" ⇒ 不该答出任何行 id。
      expect(await db.turns.turnId(owner, '')).toBeUndefined()
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

  it('★ 运行期删除：同一个已 open 的实例上 mark(\'removed\') 之后，PG 那行必须自己消失', async () => {
    // 这一条与上一条的**唯一**区别是它**不调 `await db.open()`**：上一条靠启动排空把 outbox
    // 补进 PG，所以它证明的是"启动收敛会补写"，**证明不了运行期**——而真实用户从不重启进程。
    // 此前的实现里 `drainOutboxes()` 的唯一调用点就是 `open()`，于是：移除接口返回 200、
    // `mark('removed')` 也真的生效（本地），但 `dsh_conversations` 里那行还在 ⇒ 侧栏照样列出它、
    // 点进去 404。删掉 `mark` 之后的 `scheduleDrain()`，本条即红。
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      db.conversations.mark(actor, id, 'removed')   // 同步，不 await
      // 后台排空是"稍后跑"的，不在这里 await 任何排空入口：等它就等于把运行期又测成启动期。
      await waitFor(async () => (await removalStateOf(id)) === 'removed')
      const page = await db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })
      expect(page.items.map(item => item.id)).toEqual([])
      // 队列也要真的被 ack（没 ack 说明是"碰巧 PG 里已经是 removed"，那就是假绿）。
      expect(db.health().fence.depth).toBe(0)
    } finally { await db.close() }
  })

  it('★ 运行期标题：官方标题经 titleSink 投递后，同一个实例内 PG 的 title 必须自己更新', async () => {
    // 与"标题 outbox"那条的分工同上：那条靠重启排空，本条只用**同一个实例**。
    // 投递口是同步回调（`registerConversationTitles` 的硬要求），只能写本地队列；
    // 没有运行期排空点的话，官方标题在本次进程内永远进不了 PG——而页面标题刷新等的就是它
    // （`title_source` 一直是 `automatic`，前端会一直空转到超时）。
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      db.titleSink().submit(AGENT, id, '官方给的名字', 'generated')
      await waitFor(async () => (await titleOf(id)) === '官方给的名字')
      expect(await titleSourceOf(id)).toBe('generated')
      expect(db.health().title.depth).toBe(0)
    } finally { await db.close() }
  })

  it('同一个实例里不会只排空"某一次"：一次触发要把两条队列、多个会话的条目全部补完', async () => {
    // 合并触发的代价必须被钉住：`titleSink` 两条（两个会话）+ `mark` 三条（其中一个会话连发
    // 两条），若实现只补"最后一次触发时的那一批"、或提前退出循环，这里会留下没补完的条目。
    //
    // ⚠️ 标题与删除**必须落在不同的会话上**：删除会话会让那条标题 UPDATE 的守卫
    // （`ready AND deleted_at IS NULL AND removal_state = ''`）不成立——那是对的行为（不给正在
    // 删除的会话改标题），不是本用例要测的东西。第一版就是踩了这个，读到的是空标题。
    //
    // ⚠️ 本用例**同时**投了标题，所以它能在"标题那一侧触发排空"时通过；只标记删除、不投标题的
    // 路径由下一条（`mark` 单独触发）覆盖，两条合起来才钉住两个触发点各自有效。
    //
    // 等待用**本地队列深度**（同步 SQLite 读，零网络）而不是轮询 PG：后者每轮一次往返，
    // 在跳板机上一条用例就能打满 5000ms 超时。队列空了之后一次性读回 PG 断言。
    const { db } = await newFacade()
    try {
      const titled = conversationId()
      const second = conversationId()
      for (const id of [titled, second]) {
        await db.conversations.create(owner, id, '')
        await db.conversations.publish(owner, id)
      }
      db.titleSink().submit(AGENT, titled, '第一条的标题', 'generated')
      db.conversations.mark(actor, titled, 'pending')
      db.conversations.mark(actor, titled, 'removed')
      db.conversations.mark(actor, second, 'removed')
      expect(db.health().fence.depth).toBe(3)
      expect(db.health().title.depth).toBe(1)

      await waitForSync(() => db.health().fence.depth === 0 && db.health().title.depth === 0,
        '后台排空没有在 5 秒内把两个 outbox 清空')

      // 每条都必须真的到了 PG（"队列空了"也可能是被错误地 ack 掉的）。
      expect(await removalStateOf(titled)).toBe('removed')
      expect(await removalStateOf(second)).toBe('removed')
    } finally { await db.close() }
  })

  it('★ `close()` 之前必须把队列排空：关掉实例不丢刚标记的删除', async () => {
    // 真实场景是"用户点了移除、进程随即重启/卸载插件"：排空是延迟 25ms 调度的，`close()` 不等它
    // 就等于丢掉这条指令——PG 里那行**永久**停在标记之前的状态（侧栏还能列出它、点开 404），
    // 而本地队列已经随进程消失。断言用**独立的 admin 连接**读（不经过待关闭的门面）。
    const { db } = await newFacade()
    const id = conversationId()
    await db.conversations.create(owner, id, '')
    await db.conversations.publish(owner, id)
    db.conversations.mark(actor, id, 'removed')
    // 立刻关：不给那次 25ms 的延迟排空任何机会。
    await db.close()

    await waitFor(async () => (await removalStateOf(id)) === 'removed')
  })

  it('标题 outbox 与围栏 outbox 互不阻塞：删除别的会话不影响本次标题落库', async () => {
    const { db } = await newFacade()
    try {
      const titled = conversationId()
      const doomed = conversationId()
      for (const id of [titled, doomed]) {
        await db.conversations.create(owner, id, '')
        await db.conversations.publish(owner, id)
      }
      db.titleSink().submit(AGENT, titled, '正常会话的官方标题', 'generated')
      db.conversations.mark(actor, doomed, 'removed')
      await waitForSync(() => db.health().fence.depth === 0 && db.health().title.depth === 0,
        '后台排空没有在 5 秒内把两个 outbox 清空')
      expect(await titleOf(titled)).toBe('正常会话的官方标题')
      expect(await removalStateOf(doomed)).toBe('removed')
    } finally { await db.close() }
  })

  it('★ `mark` 单独触发排空：只标记删除、不投标题，PG 那行也必须自己消失', async () => {
    // 与上一条的分工：那条同时投了标题（于是"标题那一侧"也能触发排空）。本用例**只**标记删除，
    // 于是唯一可能的触发点就是 `mark` 里那一次 `scheduleDrain()`——把它去掉，本条即红。
    // 断开"删除"这条路径的代价最高：移除接口返回 200 而侧栏那行还在（点开 404）。
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      db.conversations.mark(actor, id, 'pending')
      db.conversations.mark(actor, id, 'removed')
      expect(db.health().title.depth).toBe(0)
      expect(db.health().fence.depth).toBe(2)
      await waitForSync(() => db.health().fence.depth === 0,
        '后台排空没有在 5 秒内把围栏队列清空（`mark` 之后没人触发排空？）')
      expect(await removalStateOf(id)).toBe('removed')
    } finally { await db.close() }
  })

  // -------------------------------------------------------------------
  // 一·补二、用户发言推进 updated_at（侧栏排序 / 时间范围过滤的依据）
  // -------------------------------------------------------------------

  it('★ touch 推进 updated_at：严格变大，且 list 把刚发言的会话排到最前', async () => {
    // `syncTitle` 那条 UPDATE **不碰 `updated_at`**（它的守卫也只认 title / title_source），
    // 而列表排序是 `pinned DESC, updated_at DESC, id`。所以"受理一条用户消息"如果只调
    // `syncTitle`，侧栏的排序键就退化成创建时间：刚说过话的会话沉在下面，`from` / `to`
    // 过滤也按创建时间算。`followup` 里漏掉 `touch` 的话本条即红。
    const { db } = await newFacade()
    try {
      const older = conversationId()
      const newer = conversationId()
      const page = (): Promise<ConversationPageShape> =>
        db.conversations.list(owner, { offset: 0, limit: 10, q: '', state: '' }, { busy: [], archived: [] })

      await db.conversations.create(owner, older, '')
      await db.conversations.publish(owner, older)
      await db.conversations.syncTitle(owner, older, '旧会话', 'automatic')
      // 让 `newer` 的两个时刻严格大于 `older`（真实路径上也是这样：两行建在不同时刻）。
      await delay(5)
      await db.conversations.create(owner, newer, '')
      await db.conversations.publish(owner, newer)
      const before = await updatedAtOf(older)
      expect((await page()).items.map(item => item.id)).toEqual([newer, older])

      // 显式给一个"更晚"的时刻：不靠毫秒时钟碰运气，本用例要证的是**这一列被推进了**。
      const at = before + 1000
      await db.conversations.touch(owner, older, at)
      expect(await updatedAtOf(older)).toBe(at)
      expect(at).toBeGreaterThan(before)
      expect((await page()).items.map(item => item.id)).toEqual([older, newer])

      // ⚠️ **倒退必须被挡住**（`GREATEST`）：分页是 `from` / `to` 两个窗口，`updated_at` 一旦
      // 回退就会与上一页重叠或跳空——表现是"翻页时某些会话凭空消失"，而那一刻没有任何报错。
      await db.conversations.touch(owner, older, at - 500)
      expect(await updatedAtOf(older)).toBe(at)
      expect((await page()).items.map(item => item.id)).toEqual([older, newer])
    } finally { await db.close() }
  })

  it('touch 只认自己的 owner：别人的 owner 调它一行都不动', async () => {
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '')
      await db.conversations.publish(owner, id)
      const before = await updatedAtOf(id)
      // 同一个 namespace、只有 `userId` 不同：能挡住它的只有 `owner_id` 那一列。
      await db.conversations.touch(otherOwner, id, before + 5000)
      expect(await updatedAtOf(id)).toBe(before)
      // 反向对照：本人调必须真的推进（少了这条，上面那个"没生效"可能只是整条路径没通）。
      await db.conversations.touch(owner, id, before + 5000)
      expect(await updatedAtOf(id)).toBe(before + 5000)
    } finally { await db.close() }
  })

  // -------------------------------------------------------------------
  // 一·补三、搜索口径：`titleOnly` 决定要不要把 id 也当命中项
  // -------------------------------------------------------------------

  it('★ titleOnly：为真时按 id 片段搜不到，为假时能搜到（保住既有行为）', async () => {
    // 页面的 placeholder 写着"搜索对话标题"，而 PG 侧此前是 `title OR id`。会话 id 是
    // `closedoff-web-<uuid>`，所以输入 `-`、`web`、`e`、甚至单个数字都会命中**全部**会话——
    // 用户搜"标题"却得到整个列表。`titleOnly` 就是那个开关；忽略它（永远带上 id 分支）时
    // 本用例的第一条断言即红。
    const { db } = await newFacade()
    try {
      const id = conversationId()
      await db.conversations.create(owner, id, '', { title: '园区设备巡检' })
      await db.conversations.publish(owner, id)
      const search = (q: string, titleOnly?: boolean): Promise<ConversationPageShape> =>
        db.conversations.list(owner, {
          offset: 0, limit: 10, q, state: '', ...(titleOnly === undefined ? {} : { titleOnly }),
        }, { busy: [], archived: [] })
      // 取 id 里**一定不会出现在标题里**的一段（`closedoff-web-` 是 `CONVERSATION_PREFIX` 给的）。
      const fragment = 'closedoff-web'

      expect((await search(fragment)).items.map(item => item.id)).toEqual([id])
      expect((await search(fragment, false)).items.map(item => item.id)).toEqual([id])
      expect((await search(fragment, true)).items).toEqual([])
      expect((await search(fragment, true)).total).toBe(0)

      // 反向对照：同一个开关下标题命中必须照样有效——否则"搜不到"可以只是"搜索整体坏了"。
      expect((await search('设备', true)).items.map(item => item.id)).toEqual([id])
      expect((await search('设备', false)).items.map(item => item.id)).toEqual([id])
      // 大小写仍由 `lower()` 归一（带上这个开关不该改变匹配口径的任何其他部分）。
      expect((await search('CLOSEDOFF-WEB', true)).items).toEqual([])
      expect((await search('园区设备巡检', true)).items.map(item => item.id)).toEqual([id])
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
