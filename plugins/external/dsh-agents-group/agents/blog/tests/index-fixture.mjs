/**
 * blog 测试的内存索引门面：把运行时的两个内存端口（会话 / 轮次）拼成一个可用的
 * `AgentDatabasePort`。
 *
 * ## 为什么需要它
 *
 * 索引库从 `blog.sqlite` 三表切到运行时端口之后，blog 的测试**失去了后端**：`ChatStore` 现在
 * 只经端口读写，而 `packages/runtime/src/storage/local.ts` 是"围栏镜像 + outbox"，不实现会话与
 * 轮次。所以夹具必须是**运行时提供的**那份内存实现（`storage/memory.ts`）——跨包 import 另一个
 * 包的测试夹具做不到，这也是它当初从 `tests/fixtures/` 提升进 `src/` 的原因。
 *
 * ⚠️ 它**不是**"已经接上存储"的证据：没有持久化、没有真并发、没有崩溃窗口，`query()` 是空的、
 * 事务是快照回滚（见下）。不要拿它推断真实实现的时序。真 PG 的对照在
 * `packages/runtime/../tests/storage-contract.test.ts`（`DSH_RUNTIME_TEST_PG_DSN`）。
 *
 * ## 事务：快照 + 回滚（这是真行为，不是摆设）
 *
 * 真实门面的 `transaction()` 是 PG 的 `BEGIN` / `ROLLBACK`。内存端口没有事务，所以这里的替身
 * 用 `snapshot()` / `restore()` 实现同样的**可观测语义**：回调抛错 ⇒ 状态回到事务开始那一刻。
 * 少了它，"逐条核验失败时不留下半完成的修改"这条断言就只能被删掉（旧 SQLite 实现是靠
 * `BEGIN IMMEDIATE` 保证的）。
 */
import {
  MemoryConversationPort,
  MemoryTurnStore,
} from '../../../packages/runtime/src/storage/memory.ts'

/**
 * 造一个内存索引门面。
 *
 * @param agentId 本 Agent 的 id（参与归属判定与 `missionRequestId` 派生）
 */
export function memoryIndex(agentId = 'blog') {
  const conversations = new MemoryConversationPort(agentId)
  const turns = new MemoryTurnStore(agentId)
  const db = {
    conversations,
    turns,
    assertSchema: async () => {},
    // 业务表访问（`<agentId>_*`）不在这一层：blog 的业务存储在 `BlogPgStorage` 里，测试用
    // `BlogStore(':memory:')`。这里如实返回空集，而不是伪造一张表。
    query: async () => [],
    close: async () => {},
    /**
     * 标题投递口：真实现是"**同步**写本地 outbox + 后台按会话 FIFO 补写 PG"。
     *
     * 内存门面没有 outbox（文件头那张表写着"无持久 outbox"），所以这里**同步转发**到端口的补写点
     * （`deliverTitle`）——守卫（已发布 / 未删除 / 无围栏 / 自动标题可覆盖）在那一侧，语义等价。
     * 差别只有一个：这里没有"崩溃后仍能补上"那一层（内存实现本来就没有崩溃窗口）。
     *
     * ⚠️ 少了这个口子，`ChatStore.syncTitle` 的标题**永远写不进库**（它只负责"投递 + 判定"），
     * 而测试会看到"标题没变"这种看起来像业务缺陷的现象。
     */
    titleSink: () => ({
      submit: (_agentId, conversationId, title, source) => {
        conversations.deliverTitle(conversationId, title, source)
      },
    }),
    /**
     * 快照回滚式事务：语义与 PG 的 `BEGIN` / `ROLLBACK` 在单线程下等价。
     *
     * ⚠️ 它与真实实现的差异要如实知道：真实事务里**别的连接看不到未提交的写**，而这里的状态是
     * 共享的（同一进程内的一个 Map）。所以"并发可见性"这类断言不能在内存替身上做。
     */
    transaction: async (fn) => {
      const before = { conversations: conversations.snapshot(), turns: turns.snapshot() }
      try {
        return await fn(db)
      } catch (error) {
        conversations.restore(before.conversations)
        turns.restore(before.turns)
        throw error
      }
    },
  }
  return db
}

/**
 * `owner` 字符串 → 端口的归属值对象（与 `chat-store.ts` 里那份私有实现同一口径：切**第一个**冒号）。
 *
 * 测试要直接调端口（`db.conversations.touch(...)` 之类）时用得到——那些调用不带业务包装，
 * 得自己把字符串变成双列。
 */
export function ownerOf(owner) {
  const at = owner.indexOf(':')
  return { namespace: owner.slice(0, at), userId: owner.slice(at + 1) }
}

/**
 * `owner` 字符串 → `Actor`（同步围栏面 `mark` / `record` 要它）。
 *
 * `sessionId` 给一个固定的测试值：围栏的归属判定只用 `namespace` / `userId`，`sessionId` 是
 * 审计信息（`local.ts` 的 `record` 与内存实现都不拿它做条件）。
 */
export function ownerActor(owner, sessionId = 'test-login') {
  return { ...ownerOf(owner), sessionId }
}
