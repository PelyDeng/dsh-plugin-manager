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
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import {
  MemoryConversationPort,
  MemoryTurnStore,
} from '../../../packages/runtime/src/storage/memory.ts'
import type { AgentDatabasePort, ConversationPort, TurnStorePort } from '../../../packages/runtime/src/storage/ports.ts'

/**
 * `owner` 字符串切出来的归属值对象。
 *
 * 它按结构等价于 `ports.ts` 的 `OwnerKey`（`{namespace, userId}`），但**不 import 那个名字**：
 * 本文件下面是 `ReturnType` 自引用，用本地接口能把"谁依赖谁"留在文件里看得见。
 */
interface Ownership {
  readonly namespace: string
  readonly userId: string
}

/**
 * 端口的标题来源取值。**不写 `string`**：`ConversationPort.syncTitle` 与 `MemoryConversationPort.deliverTitle`
 * 都只认这三个字面量，放宽成 `string` 会让 `titleSink` 与端口之间那一步在类型上失真。
 */
type TitleSource = 'automatic' | 'generated' | 'manual'

/**
 * 内存索引门面（`memoryIndex()` 的返回值）：两个内存端口 + 业务表访问 + 标题投递口 + 事务替身。
 *
 * `query` / `titleSink` / `transaction` 在这里写**必填**（即使真实端口把 `titleSink` 写成可选
 * `AgentDatabasePort.titleSink?()`）：本门面三个都实现了，而**可选成员不参与上下文类型推断**
 * ⇒ 写成 `titleSink?()` / `transaction?()` 时，下面字面量里的 `submit` 与 `fn` 会退回隐式 `any`
 * （实测 TS7006）。必填之后的类型与实际实现一致。
 *
 * ⚠️ `query` 必须是**泛型**：`AgentDatabasePort.query<T>` 就是泛型，而 `TitledIndex` 要交给
 * `ChatStore(db)`（它按 `AgentDatabasePort` 收），写成 `Promise<unknown[]>` 会在那一处报
 * "`unknown[]` 不能赋给 `T[]`"（实测 TS2345）。
 *
 * ⚠️ **它继承 `AgentDatabasePort`**：本门面就是运行时的存储端口替身，声明成"端口 + 三个收紧的
 * 必填成员"才与事实一致。先前只写成独立接口时，`memoryIndex()` 的返回值**不是** `AgentDatabasePort`
 * ⇒ 调用方（`participant.test.ts:550` 的 `f.db.conversations.size`）拿到的是裸 `ConversationPort`，
 * 连"这是一个内存替身、有 `size` 观测量"这件事都表达不出来。
 */
interface TitledIndex extends AgentDatabasePort {
  readonly conversations: ConversationPort
  readonly turns: TurnStorePort
  assertSchema(): Promise<void>
  query<T>(sql: string, values?: readonly unknown[]): Promise<T[]>
  close(): Promise<void>
  titleSink(): { submit(agentId: string, conversationId: string, title: string, source: TitleSource): void }
  /**
   * `T` 给**缺省值**是刻意的：`db` 是对象字面量、拿不到上下文类型 ⇒ 泛型参数没有推断来源，
   * 不给缺省就会在 `transaction: async (fn) => …` 这一处退回隐式 `any`（实测 TS7006）。
   *
   * `fn` 的返回值写成 `Promise<never>` 也是刻意的（**不是** `Promise<unknown>`）：`never` 是唯一
   * "对任何 `T` 都可赋"的返回类型，所以这个签名对任意 `T` 都成立，`ChatStore` 那一侧照旧只
   * `await` 事务、不读它的返回值。写成 `Promise<unknown>` 会让 `T` 无法满足（实测 TS2322）。
   */
  transaction<T = unknown>(fn: (tx: TransactionTarget) => Promise<never>): Promise<T>
}

/**
 * 事务替身交给回调的那一份：就是本门面自己。
 *
 * 用 `ReturnType<typeof memoryIndex>` 表达"自引用"——`db` 是对象字面量、拿不到类名，而写成
 * 内联重复的门面形状会在两条分支（回调入参与 `db` 自身）漂移时**静默**不一致。
 */
type TransactionTarget = ReturnType<typeof memoryIndex>

/**
 * 造一个内存索引门面。
 *
 * @param agentId 本 Agent 的 id（参与归属判定与 `missionRequestId` 派生）
 */
export function memoryIndex(agentId = 'blog'): TitledIndex {
  const conversations = new MemoryConversationPort(agentId)
  const turns = new MemoryTurnStore(agentId)
  const db = {
    conversations,
    turns,
    assertSchema: async () => {},
    // 业务表访问（`<agentId>_*`）不在这一层：blog 的业务存储在 `BlogPgStorage` 里，测试用
    // `BlogStore(':memory:')`。这里如实返回空集，而不是伪造一张表。
    // ⚠️ 显式写 `_values` 与类型参数是**必须**的（不是啰嗦）：`db` 是对象字面量、拿不到返回类型
    // 那一边的上下文类型 ⇒ 少一个就是隐式 `any`（实测 TS7006）。返回空集即"没有业务表"。
    query: async <T>(_sql: string, _values?: readonly unknown[]) => [] as T[],
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
      submit: (_agentId: string, conversationId: string, title: string, source: TitleSource) => {
        conversations.deliverTitle(conversationId, title, source)
      },
    }),
    /**
     * 快照回滚式事务：语义与 PG 的 `BEGIN` / `ROLLBACK` 在单线程下等价。
     *
     * ⚠️ 它与真实实现的差异要如实知道：真实事务里**别的连接看不到未提交的写**，而这里的状态是
     * 共享的（同一进程内的一个 Map）。所以"并发可见性"这类断言不能在内存替身上做。
     *
     * 这里 `fn` 写注解**只写参数类型**（`(tx: TransactionTarget) => Promise<never>`），是接口那一边
     * 定好的形状：`db` 是对象字面量、拿不到返回类型那一边的上下文类型，所以 `fn` 的类型只能显式写；
     * 而 `never` 的返回值对任意 `T` 都可赋，于是 `transaction` 仍是泛型的（`ChatStore` 只 `await` 它）。
     */
    transaction: async (fn: (tx: TransactionTarget) => Promise<never>) => {
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
export function ownerOf(owner: string): Ownership {
  const at = owner.indexOf(':')
  return { namespace: owner.slice(0, at), userId: owner.slice(at + 1) }
}

/**
 * `owner` 字符串 → `Actor`（同步围栏面 `mark` / `record` 要它）。
 *
 * `sessionId` 给一个固定的测试值：围栏的归属判定只用 `namespace` / `userId`，`sessionId` 是
 * 审计信息（`local.ts` 的 `record` 与内存实现都不拿它做条件）。
 *
 * ⚠️ `Actor` 是**字面量判别联合**（`namespace: 'user'` / `'standalone'`），而 `owner` 字符串切出来的
 * `namespace` 是 `string` ⇒ 直接拼出来的对象**不满足** `Actor`。本夹具的用例都用 `user:<id>`，
 * 所以这里如实核验一次：不是 `user:` 前缀就**当场抛**（说明这条用例在借一个夹具不支持的身份，
 * 而不是让类型层把它悄悄放过去）。
 */
export function ownerActor(owner: string, sessionId = 'test-login'): Actor {
  const ownership = ownerOf(owner)
  if (ownership.namespace !== 'user') throw new Error(`ownerActor：夹具只造 user 身份，收到 ${owner}`)
  return { namespace: 'user', userId: ownership.userId, sessionId }
}
