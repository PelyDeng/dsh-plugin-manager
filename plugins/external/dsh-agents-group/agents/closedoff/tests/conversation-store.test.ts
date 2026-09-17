/**
 * 会话索引的**端口语义**验收。
 *
 * ## 这个文件在 P4 里换掉了什么（不是删掉旧用例，是换了被测对象）
 *
 * 迁移前它测 `src/conversation-store.ts` 的 `ConversationStore`（closedoff 自己那份 SQLite
 * 归属索引，v4 schema）。P4 之后那份实现被删除，索引迁到运行时：权威数据在 PG 的
 * `dsh_conversations`，本地只留**围栏镜像 + 持久 outbox**。所以用例的目标换了，但**判据一条没少**：
 *
 * | 旧用例守的东西 | 现在的落点 |
 * | --- | --- |
 * | `title_source` 三态与"自动标题不覆盖手动标题" | 端口 `syncTitle`（第 2 条） |
 * | `ready` 发布握手、未发布会话不可见 | 端口 `create` / `publish` / `list`（第 2、4 条） |
 * | 归属与存在性：未知 / 他人 / 未发布 同一个 404 | 端口 `record`（第 3、4 条） |
 * | `removal_state` 的 `pending → failed` 收敛与 `removed` 从列表消失 | 端口 `mark` + `list`（第 4 条） |
 * | `pinned` 参与排序、只改标记 | 端口 `pin`（第 4 条） |
 * | **v2/v3 SQLite 的 DDL 与样本数据**（旧 `:14-15`） | 原样搬进第 1 条，作为"旧载体"的证据 |
 *
 * ## 旧载体（v2/v3 的 `conversations.sqlite`）现在是什么
 *
 * 设计 §6.1 的决策是 closedoff 存量**直接删除**（实测 22 行 / 16 KB、单 namespace、无保留价值）。
 * 所以那个文件既不被迁移、也不被读取；第 1 条验的正是这件事——**旧结构对新机制不可见**。
 * 数据本身原样留在用例里：它是"曾经存在过什么"的唯一可执行记录，删掉就只剩一句注释。
 *
 * ## 为什么不连真 PG
 *
 * 端口替身（`tests/fixtures/memory-conversation-port.ts`）与真实现**逐条对齐可观测语义**
 * （它的文件头列了逐条对照与差异）。PG 侧的 SQL 级契约由 `tests/storage-contract.test.ts`
 * 用一次性库覆盖，那是另一个动作（需要真 PG）。本文件不越界去测那一层。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AccessError, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { LocalFenceStore } from '../../../packages/runtime/src/storage/local.ts'
import { MemoryConversationPort } from '../../../tests/fixtures/memory-conversation-port.ts'
import { closedoffLocalMirrorPath } from '../src/runtime.ts'

const user: Actor = { namespace: 'user', userId: 'one', sessionId: 'login-one' }
const local: Actor = { namespace: 'standalone', userId: 'local' }
const agent = 'closedoff'

/** 造一个内存端口（一个实例代表一个 Agent）。 */
const port = (): MemoryConversationPort => new MemoryConversationPort(agent)

/** 一次"新会话"：`create` 是预留段，`publish` 才让它可见、可发消息。 */
async function openConversation(target: MemoryConversationPort, id: string, actor: Actor = user): Promise<void> {
  await target.create({ namespace: actor.namespace, userId: actor.userId }, id, '', { title: '' })
  await target.publish({ namespace: actor.namespace, userId: actor.userId }, id)
}

describe('会话索引：运行时端口语义', () => {
  it('旧载体（v2/v3 的 conversations.sqlite）对新机制不可见：围栏库另立文件，不读也不迁移旧行', () => {
    const root = mkdtempSync(join(tmpdir(), 'closedoff-legacy-'))
    const legacyPath = join(root, 'conversations.sqlite')
    try {
      // ↓↓↓ 旧 `conversation-store.test.ts:14-15` 的 DDL 与样本数据，逐字保留 ↓↓↓
      const old = new DatabaseSync(legacyPath)
      old.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,owner_namespace TEXT NOT NULL,owner_id TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,ready INTEGER NOT NULL DEFAULT 0,deletedAt INTEGER,removalState TEXT NOT NULL DEFAULT ''); PRAGMA user_version=2; INSERT INTO conversations VALUES('old','user','one','旧标题 100%',10,20,1,NULL,''); INSERT INTO conversations VALUES('removed','user','one','已移除',10,20,1,30,'removed');")
      old.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;')
      old.close()
      // ↑↑↑ 到此为止 ↑↑↑

      // 旧文件仍在盘上（设计 §6.1：存量直接删除，不清文件）。
      const legacyReader = new DatabaseSync(legacyPath)
      expect(legacyReader.prepare('SELECT count(*) AS n FROM conversations').get()?.n).toBe(2)
      legacyReader.close()
      // 新机制的本地库是**另一个文件**（`mirror.sqlite`）。这不是命名口味：旧索引是
      // `user_version = 3` 的 `conversations` 表结构，本地围栏库只认 0 与 1（见本用例末尾
      // 的反向取证）——两者互不兼容，复用同名只会让"新机制误读旧文件"变成一次启动失败。
      expect(closedoffLocalMirrorPath()).not.toBe(legacyPath)
      expect(closedoffLocalMirrorPath().endsWith('mirror.sqlite')).toBe(true)

      const mirrorPath = join(root, 'mirror.sqlite')
      const fence = new LocalFenceStore(agent, mirrorPath)
      try {
        // 镜像库是空的：旧行没有被当成归属索引搬进来。
        expect(fence.mirrorAll()).toEqual([])
        // 旧会话在新机制里就是"不存在"——同一个 404，不泄露它曾在旧索引里。
        expect(() => fence.record(user, 'old')).toThrow('会话不存在或无权访问')
      } finally { fence.close() }

      // 反向取证：**如果**把旧文件当新库打开，机制的回答是"结构版本不认识 ⇒ 拒绝启动"
      // （旧文件是 `user_version = 3`，围栏库只认 0 与 1）。所以这不是含混，而是一条会拦住
      // 启动的硬校验——旧索引与本地围栏库是两种**互不兼容**的结构，不能共用一个文件名。
      expect(() => new LocalFenceStore(agent, legacyPath))
        .toThrow('不支持的本地围栏结构版本：3（期望 1）；本地库可以删除重建')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('★ 首版镜像库（无 payload 列）原地升级：旧库照用，不要求运维删文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'closedoff-mirror-v1-'))
    const mirrorPath = join(root, 'mirror.sqlite')
    try {
      // ↓↓↓ 首版 `conversation_mirror` 的 DDL，逐字保留（**没有** `payload` 列）↓↓↓
      const old = new DatabaseSync(mirrorPath)
      old.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS conversation_mirror (
          id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
          owner_namespace TEXT NOT NULL, owner_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '', title_source TEXT NOT NULL DEFAULT 'automatic',
          ready INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
          removal_state TEXT NOT NULL DEFAULT '', deleted_at INTEGER, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fence_outbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS title_outbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
        INSERT INTO conversation_mirror(id, agent_id, owner_namespace, owner_id, title, title_source, ready, pinned, removal_state, deleted_at, updated_at)
          VALUES('old-row','closedoff','user','one','旧镜像行','manual',1,0,'',NULL,20);
        INSERT INTO fence_outbox(agent_id, conversation_id, state, created_at)
          VALUES('closedoff','old-row','pending',30);`)
      old.close()
      // ↑↑↑ 到此为止 ↑↑↑

      // 老库必须**开得起来**：升 `LOCAL_SCHEMA_VERSION` 才是"拒绝启动、要求删文件"，
      // 而删文件会连带丢掉 `fence_outbox` 里那条未补写的 pending（PG 那边什么都没有）。
      const fence = new LocalFenceStore(agent, mirrorPath)
      try {
        // 旧行原样还在，载荷是真值"空对象"（它本来就没有业务余项）。
        const row = fence.mirrorGet('old-row')
        expect(row?.title).toBe('旧镜像行')
        expect(row?.payload).toEqual({})
        // 那条围栏指令没被升级动作吃掉。
        expect(fence.fencePendingConversations().has('old-row')).toBe(true)
        // 补列之后**写得进去**：不补的话 `mirrorUpsert` 会因"表里没有这一列"直接抛。
        fence.mirrorUpsert({ ...(row!), payload: { parent: 'p-1' }, updatedAt: 40 })
        expect(fence.mirrorGet('old-row')?.payload).toEqual({ parent: 'p-1' })
        // 同步 `record` 也要带得出它——这正是这一列存在的理由。
        expect(fence.record(user, 'old-row').payload).toEqual({ parent: 'p-1' })
      } finally { fence.close() }

      // 幂等：再开一次不该重复 ALTER（重复补列会抛 "duplicate column name"）。
      const again = new LocalFenceStore(agent, mirrorPath)
      try { expect(again.mirrorGet('old-row')?.payload).toEqual({ parent: 'p-1' }) } finally { again.close() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('标题三道守卫：未发布不写、自动不覆盖手动、围栏标记后不复活', async () => {
    const store = port()
    const owner = { namespace: user.namespace, userId: user.userId }
    // 预留段（`ready = false`）不接受标题：会话还没发布。
    await store.create(owner, 'new', '', { title: '' })
    expect(store.rawOf('new')?.title).toBe('')
    await store.syncTitle(owner, 'new', '未完成创建', 'automatic')
    expect(store.rawOf('new')?.title).toBe('')

    await store.publish(owner, 'new')
    await store.syncTitle(owner, 'new', '首句回退', 'automatic')
    // 逐字对应旧用例的 `syncTitle('new','首句回退') === true`：自动标题可以写。
    expect(store.rawOf('new')).toMatchObject({ title: '首句回退', titleSource: 'automatic' })
    await store.syncTitle(owner, 'new', '车辆轨迹查询', 'generated')
    expect(store.rawOf('new')).toMatchObject({ title: '车辆轨迹查询', titleSource: 'generated' })
    // 官方手动标题可以覆盖（旧用例的 `syncTitle(..., true, true)`）。
    await store.syncTitle(owner, 'new', '官方手动标题', 'manual')
    expect(store.rawOf('new')).toMatchObject({ title: '官方手动标题', titleSource: 'manual' })
    // 手动之后，自动/生成都不再覆盖（旧用例的 `syncTitle('new','不能覆盖',false,true) === false`）。
    await store.syncTitle(owner, 'new', '不能覆盖', 'generated')
    await store.syncTitle(owner, 'new', '随后到达的自动标题', 'automatic')
    expect(store.rawOf('new')?.title).toBe('官方手动标题')

    // 围栏标记之后连手动标题都不能复活它（旧用例的 `syncTitle('removed', …, true, true) === false`）。
    await openConversation(store, 'removed')
    store.mark(user, 'removed', 'removed')
    expect(store.record(user, 'removed').removalState).toBe('removed')
    await store.syncTitle(owner, 'removed', '不能复活', 'manual')
    expect(store.rawOf('removed')?.title).toBe('')
    /**
     * 不属于本 Agent 的会话 id：**抛 404**。
     *
     * 这条与旧实现**不同形**，但语义更硬：旧 `syncTitle` 对不存在的行返回 `false`（静默假），
     * 端口契约把它定成"归属不存在 ⇒ 404"——因为端口**只**该回答"这个 owner 的这条会话"，
     * 而静默假会让"拼错 id"与"守卫拒绝"变成同一个观测。运行时的 `TitleSink` 只投递已知会话，
     * 所以这条路径在生产上不会被自动标题触发。
     */
    await expect(store.syncTitle(owner, 'another-plugin-session', '无关会话', 'generated'))
      .rejects.toThrow('会话不存在或无权访问')
    expect(store.rawOf('another-plugin-session')).toBeUndefined()
  })

  it('归属判定：未知 / 他人一律同一个 404，`removed` 的行照常返回', async () => {
    const store = port()
    await openConversation(store, 'private')
    await store.create({ namespace: user.namespace, userId: user.userId }, 'orphan', '', { title: '' })
    await openConversation(store, 'local', local)

    expect(store.record(user, 'private').ready).toBe(true)
    /**
     * ⚠️ **分层差异，如实记在这里**：`record` 是**围栏读**，它**不**看 `ready`。
     *
     * 旧 `ConversationStore.record`（`:99`）同样不看 `ready`，而"未发布 ⇒ 404"那条判定在旧实现
     * 里属于另一个方法（`assertOwner`）。迁移后它落在**运行时**的 `lifecycle.assertConversation`
     * （`conversation.ts:263`：`ready !== true || deletedAt !== null || removalState !== ''` ⇒ 404），
     * 页面与协作入口都走那一条。所以"未发布不可用"在端口这一层测不到，**不是回归**；本文件
     * 只测端口自己的契约，那一层由运行时侧的用例覆盖。
     */
    expect(store.record(user, 'orphan').ready).toBe(false)
    // 他人：同一个 404，且文案与"未知"完全一致（旧用例 `assertOwner('private', local)`）。
    expect(() => store.record(local, 'private')).toThrow('会话不存在或无权访问')
    // 未知。
    expect(() => store.record(user, 'legacy')).toThrow('会话不存在或无权访问')
    const errors = ['another-plugin-session', 'legacy'].map(id => {
      try { store.record(user, id); return undefined } catch (error) { return error as AccessError }
    })
    expect(errors.map(error => error?.status)).toEqual([404, 404])
    expect(new Set(errors.map(error => error?.message)).size).toBe(1)
    // `removed` 的行**照常返回**：kit 的 `alreadyRemoved` 分支靠它，过滤掉会让重复移除报失败。
    store.mark(user, 'private', 'removed')
    expect(store.record(user, 'private').removalState).toBe('removed')
  })

  it('列表语义：发布才可见、围栏与归档的分工、置顶参与排序', async () => {
    const store = port()
    const owner = { namespace: user.namespace, userId: user.userId }
    const query = { offset: 0, limit: 30, q: '', state: '' }
    const scope = { busy: [] as string[], archived: [] as string[] }
    await openConversation(store, 'private')
    await store.syncTitle(owner, 'private', '自己的对话', 'automatic')
    await store.create(owner, 'orphan', '', { title: '' })          // 未发布
    await openConversation(store, 'local', local)                    // 别人的

    expect((await store.list({ namespace: user.namespace, userId: user.userId }, query, scope)).items
      .map(item => ({ id: item.id, title: item.title })))
      .toEqual([{ id: 'private', title: '自己的对话' }])

    // `pending → failed` 是启动收敛的方向（PG 侧把遗留 pending 翻成 failed），行仍在列表里。
    store.mark(user, 'private', 'pending')
    expect((await store.list(owner, { ...query, state: 'failed' }, scope)).items).toEqual([])
    expect(store.record(user, 'private').removalState).toBe('pending')
    store.mark(user, 'private', 'failed')
    expect((await store.list(owner, { ...query, state: 'failed' }, scope)).total).toBe(1)

    // `removed` 从列表消失（旧用例的 `managed(... state: '') .total === 0`）。
    store.mark(user, 'private', 'removed')
    expect((await store.list(owner, query, scope)).total).toBe(0)

    // 置顶：只改标记，不改内容与围栏状态，并且**参与排序**（页面徽标与"置顶在最前"都靠它）。
    await openConversation(store, 'second')
    await store.syncTitle(owner, 'second', '第二条', 'automatic')
    await store.pin(owner, 'second', true)
    const pinned = await store.list(owner, query, scope)
    expect(pinned.items[0]).toMatchObject({ id: 'second', pinned: true })
    expect(pinned.items.find(item => item.id === 'second')?.title).toBe('第二条')
    await store.pin(owner, 'second', false)
    expect((await store.list(owner, query, scope)).items.find(item => item.id === 'second')?.pinned).toBe(false)
    // 置顶不要求已发布（端口注释写明）：先给未发布的行置顶，再发布——标记跟着走。
    // 替身没有把 `pinned` 放进 `rawOf`（那是 `ConversationRecordShape`，本就不含展示字段），
    // 所以这里用发布后的 `list` 观测，而不是读一个它不承诺的字段。
    await store.pin(owner, 'orphan', true)
    await store.publish(owner, 'orphan')
    expect((await store.list(owner, query, scope)).items.find(item => item.id === 'orphan')?.pinned).toBe(true)
    // 他人置不了。
    await expect(store.pin(local, 'second', true)).rejects.toThrow('会话不存在或无权访问')
  })
})
