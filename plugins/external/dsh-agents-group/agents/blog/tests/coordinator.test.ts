/**
 * 协作入口驱动一轮时的**业务接线**（P7 阻塞 1 / 判据 J5、J7）。
 *
 * ## 这个文件补的是哪条缝
 *
 * 页面路径与协作路径的**回合驱动方不同**：
 *
 * - 页面路径：`BlogChat.run()` 自己建句柄、自己写 `jobs.bindings`；
 * - 协作路径：句柄由运行时的 `ConversationLifecycle.open()` 建 ⇒ **`BlogChat` 那一步不会发生**。
 *
 * 于是 `jobs.ts` 的授权口 `authorize: agent => this.bound(agent)` 在协作路径上永远取不到绑定，
 * 模型手里的**每一个 blog 工具都 403**——不是装载失败、界面上看不出来（`chat.ts:705-732`
 * 那段注释记的就是这件事）。本文件用**真** `BlogChat` + **真** `BlogJobs` + **真**运行时
 * `createParticipant` 把这条缝钉住：删掉 `withTurnBinding`，第一个用例就红。
 *
 * ## 夹具为什么是手搭的（与 `participant.test.ts` 不同源）
 *
 * 这里**不**复用 `chat.test.ts` 的夹具，而是照群组 `tests/runtime-reply-e2e.test.ts:162` 的既有做法
 * 手搭 `ConversationLifecycle` + `createParticipant`（那条路**不需要** `AgentDatabasePort`，
 * 因为端口是直接注入的）。代价是"两份夹具"，差别只有一处且是**刻意的**：
 *
 * | | `chat.test.ts` 的夹具 | 本文件 |
 * | --- | --- | --- |
 * | 语义面 | 页面路径（`BlogChat.run`） | 协作路径（运行时 `participant.run`） |
 * | 模型校验 | 由 `BlogChat` 自己做 | 由 `lifecycle.options()` 做 |
 *
 * 两份夹具**共用的**是产品代码（`BlogChat` / `BlogJobs` / `createBlogDefinition` /
 * `withTurnBinding`），所以"某条路径改了另一条没改"仍然会在这里红。
 *
 * ## 断言落在哪
 *
 * - **J5**：协调方派出去的那一轮，**页面那条读法**（`ChatStore` / `MemoryConversationPort`）
 *   能看到它——会话行、轮次行、结果行都在，且 `turn_id` 是**行 id**；
 * - **阻塞 1**：那一轮里真工具拿得到委派身份（`b.job` / `b.request.id` / `b.handle`），
 *   不是 403；
 * - **J7**：`b.request.id` === `turns.turnId(owner, requestId)`（**行 id**，不是幂等键），
 *   并且下一轮能按**会话**读到上一轮落下的候选 ⇒ `external_pending`。
 *
 * ⚠️ 全文件不碰 PG、不碰网络、不碰真实模型：事件由用例自己发。
 */
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import { BlogStore, ownerKey } from '../src/store.ts'
import { ChatStore } from '../src/chat-store.ts'
import { BlogJobs } from '../src/jobs.ts'
import { BlogChat } from '../src/chat.ts'
import type { BlogPgStorage } from '../src/storage/pg.ts'
import type { BlogAttachments } from '../src/attachments.ts'
import type { BlogApplication } from '../src/application.ts'
import { createBlogDefinition } from '../src/definition.ts'
import { withTurnBinding } from '../src/index.ts'
import { memoryIndex } from './index-fixture.ts'
import { ConversationLifecycle, createParticipant } from '../../../packages/runtime/src/index.ts'
import type { ParticipantRequest, ParticipantResult } from '../../../packages/runtime/src/index.ts'
import { MemoryConversationPort, MemoryTurnStore } from '../../../packages/runtime/src/storage/memory.ts'
// 假宿主只有一份（`participant-harness.ts` 也用它）：本仓的教训是"两份等价实现的结局是
// 某条路径改了另一条没改"。口径与坑都记在那个文件头上。
import { createFakeHost } from './fixtures/fake-host.ts'

/**
 * 假宿主按会话交回的句柄（`sessionOf()` 的返回；形状见 `tests/fixtures/fake-host.ts`）。
 *
 * ⚠️ 事件形状**按夹具实际广播的那一份**声明（`type` / `data` / `time` / `seq`，见 fake-host 的
 * `FakeEvent`），而不是完整 `SessionEvent` 联合：sdk 替身与 `assert.rejects` 的判据回调都只读
 * `type` / `data` / `message` 这几个字段。
 */
interface FakeEventLike {
  readonly type: string
  readonly data: unknown
  readonly time: number
  readonly seq: number
}
interface FakeSession {
  readonly id: string
  readonly events: readonly FakeEventLike[]
  readonly agent: FakeAgentLike
}
/** 运行时（`ConversationLifecycle`）与 `jobs.bindings` 真的会读到的 agent 面。 */
interface FakeAgentLike {
  readonly id: string
  readonly session: { readonly id: string; readonly snapshotEvents: () => readonly FakeEventLike[] }
}

/**
 * 夹具交回的那一份（本文件用例真正读到的成员）。
 *
 * ⚠️ 这是**声明面收口**，不是替身：夹具是**未标注**的手写工厂，`src` 那侧的形状又比它窄
 * （`BlogJobs.bindings` 交回的 `BoundTurn` 上没有用例读的 `request`），所以对象字面量在
 * **一处**收口（`as unknown as CoordinatorFixture`）、成员按用例真正读到的面声明，
 * 而不是在几十个调用点散落断言。
 */
interface CoordinatorFixture {
  store: BlogStore
  index: ChatStore
  db: RawIndex
  turns: MemoryTurnStore
  conversations: MemoryConversationPort
  jobs: { readonly bindings: { get(agent: FakeAgentLike): TurnBinding | undefined } }
  chat: BlogChat
  participant: { run(request: ParticipantRequest): Promise<ParticipantResult> }
  tool(name: string): FixtureTool | undefined
  input(overrides?: Partial<ParticipantRequest>): ParticipantRequest
  sessionOf(conversationId: string): FakeSession
  accept(since?: number): string
  complete(conversationId: string, text: string, reason?: string): void
  selectDraft(agent: FakeAgentLike): Promise<{ draft: unknown }>
}

/**
 * `withTurnBinding` 写进 `jobs.bindings` 的那一份（用例读 `request` / `job` / `handle` 三个面）。
 *
 * `request.id` 是**行 id**（`dsh_turns.id`），不是幂等键——这正是用例要钉的那条语义。
 */
interface TurnBinding {
  readonly request: { readonly id: string }
  readonly job: { readonly owner: string; readonly input: { readonly research: boolean } }
  readonly handle: { readonly agent: FakeAgentLike }
}

/** 内存索引门面的两个端口（`index-fixture.ts` 的 `memoryIndex()` 交回的那两个真实现）。 */
interface RawIndex {
  readonly conversations: MemoryConversationPort
  readonly turns: MemoryTurnStore
}

/**
 * kit 交给 `ctx.tools.register` 的那一份（`tests/fixtures/fake-host.ts` 收在 `registeredTools` 里）。
 *
 * ⚠️ 假宿主的映射值类型带 `readonly execute?: unknown`（`ToolDescriptor` 本身没有 `execute`）：
 * 可执行体**总是**由 kit 的 `guardTool` 装上（见 fake-host 文件头 §`tools.register`），
 * 所以取用处按 `fixtureTool()` 收窄一次，而不是让每个用例各自断言。
 */
interface FixtureTool {
  readonly execute: (args: unknown, context: { agent: FakeAgentLike }) => Promise<unknown>
}

/** `registeredTools.get(name)` 的收口（见 `FixtureTool` 的说明）。 */
const fixtureTool = (tool: unknown): FixtureTool | undefined => tool as FixtureTool | undefined

/** 本文件从 `blog_propose` 的候选结果里读回的面。 */
interface ProposalDraft { draftId: string }

const actor = Object.freeze({ namespace: 'user', userId: 'writer', sessionId: 'login-a' })
/**
 * 两种 owner 形态在这里**都要**，别混：
 *
 * - `owner`（字符串 `user:writer`）是**业务**那一侧的口径（`BlogStore` / `ChatStore` 都收它）；
 * - `portOwner`（`{namespace, userId}`）是**运行时存储端口**的口径（`MemoryTurnStore.turnId` /
 *   `turnResultsOf` / `MemoryConversationPort.missionRequestId` 都收它）。
 *
 * 混用的后果不是报错而是**静默查不到**：`turnId(owner, key)` 拿字符串去查会拼出
 * `undefined\0undefined\0key` 这个键，永远命中不到行 —— 于是"这一轮没有行 id"，而
 * `withTurnBinding` 会当场抛（那正是它存在的意义）。这里统一用 `portOwner` 调端口。
 */
const owner = ownerKey(actor)
const portOwner = { namespace: actor.namespace, userId: actor.userId }
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

/**
 * `projectChat` 只用得到这几个面（与 `chat.test.ts` 的 sdk 同一份最小面）。
 *
 * ⚠️ 参数按**夹具自己广播的事件**声明（`FakeEventLike`），返回值按 `chat.ts` 的投影面收口：
 * 本替身把事件里的那份消息/流**原样转交**（真 sdk 会派生），所以在这两处把转交值
 * 如实断言成投影结果（`ChatMessage` / 流片段），而不是让它们退回 `unknown`。
 */
interface ProjectedMessage { id: string; role: string; time: number }
interface ProjectedChunk { readonly chunk: { readonly type: string; readonly text?: string }; readonly time: number }
interface ChatSdkLike {
  isAppendSurfaceEvent(event: FakeEventLike): boolean
  deriveEventMessage(event: FakeEventLike): ProjectedMessage | undefined
  expandAssistantStream(stream: unknown): Iterable<ProjectedChunk>
  deriveTurnTokenUsage(events: readonly unknown[]): unknown
}
const sdk:ChatSdkLike = {
  isAppendSurfaceEvent: event => ['user/message', 'assistant/message'].includes(event.type),
  deriveEventMessage: event => (event.type === 'user/message' ? event.data : (event.data as { message?: unknown }).message) as ProjectedMessage | undefined,
  expandAssistantStream: stream => (stream ?? []) as Iterable<ProjectedChunk>,
  deriveTurnTokenUsage: () => null,
}

/**
 * 手搭一套"协作路径"夹具。
 *
 * 返回的 `definition` **已经**过 `withTurnBinding`（装配跑的就是这一份），`participant` 是运行时的
 * 协作入口——本文件的所有用例都只经它驱动，不直接调 `definition.onTurnStart`。
 */
async function fixture(t: TestContext): Promise<CoordinatorFixture> {
  const root = new Context(), registry = root.plugin(AgentRegistry)
  await registry
  const runtimeJobs = root.plugin(LocalJobRegistry)
  await runtimeJobs

  const store = new BlogStore(':memory:')
  await store.init()
  // 索引门面就用运行时的两个内存端口（`index-fixture.ts` 把它们拼成一个 `AgentDatabasePort`）：
  // 与 `chat.test.ts` 同一份后端，所以"页面那条读法"在这里没有第二套替身。
  const db = memoryIndex('blog')
  const index = new ChatStore(db)
  const { conversations, turns } = db
  t.after(async () => {
    await chat.close()
    await jobs.close()
    store.close()
    await runtimeJobs.dispose()
    await registry.dispose()
  })

  // ---- 假宿主：与 `participant-harness.ts` 共用的一份（`tests/fixtures/fake-host.ts`） ----
  // 口径与坑（事件先写日志再广播、`setup` 必须 await、`tools.register` 不能是空壳）都记在那个文件头上。
  const host = createFakeHost(root)
  const { ctx, access, sessionOf, emit, complete, accept, followups, registeredTools, byEvent } = host
  /**
   * 远端博客的替身。**只补本文件真的会跑到的那几个方法**，其余留空（用到时报
   * `xxx is not a function`，比静默返回 `{}` 好查）。
   *
   * `report` 是**目录条目**（`JobsBlogPort` 的四个方法之一），本文件一次也不走统计那条路；
   * 补它是为了让替身够到端口形状——写成**当场抛**，而不是回一个看起来像结果的 `{}`
   * （那正是"静默放过"的来源：`jobs` 的统计工具会拿它当"0 条统计"用）。
   */
  const blog = {
    call: async () => ({}),
    search: async () => ({ items: [], total: 0, hasMore: false }),
    get: async () => { throw new Error('本夹具不实现远端读取（get）：协调路径的用例不走到这里') },
    report: async () => { throw new Error('本夹具不实现远端统计（report）：协调路径的用例不走到这里') },
  }
  const jobs = new BlogJobs(ctx, access, store, blog, { freeze: async () => [] }, 3000)
  const app = { operations: async () => [] }
  /**
   * ⚠️ **`BlogStore` 是刻意的**（不是"夹具用错了类"）：本文件头写明"不碰 PG"，而
   * `BlogStore`（SQLite）与 `BlogPgStorage` 是**同一套异步方法面**的两份实现
   * （`store.ts` 类头那张表逐条对着 `BlogPgStorage` 的方法面写）。
   *
   * 装配口声明的是**具体类**（`chat.ts:336`：`BlogPgStorage` / `BlogAttachments` /
   * `BlogApplication`），而本文件按"只实现被测路径会用到的那几个方法"手搭替身
   * （文件头"夹具为什么是手搭的"）⇒ 三个替身都够不到具体类，在这一处集中越界。
   * 口径与 `index.ts:109` 的 `unconfiguredBusinessStorage(...) as unknown as BlogPgStorage`
   * 同一套；**装配口一旦把形参换成端口接口，这三个断言就该删掉**。
   */
  const chat = new BlogChat(
    ctx, access,
    store as unknown as BlogPgStorage,
    index,
    { freeze: async () => [] } as unknown as BlogAttachments,
    jobs,
    app as unknown as BlogApplication,
    sdk, 3000,
  )

  const definition = withTurnBinding(createBlogDefinition({
    persona: '你是伊丽莎白，负责查询博客与整理稿子。',
    // 真工具：`BlogJobs` 的构造函数里已经注册过，这里只交回目录条目（与 `index.ts` 的装配同一形状）。
    tools: () => jobs.chatTools,
    storage: store,
    app,
    routePrefix: '/blog',
    results: { list: async (owner_, conversationId) => index.results(owner_, conversationId) },
  }), chat)

  const config = { routePrefix: '/blog', turnTimeoutMs: 3000, authRecheckMs: 1000, maxActiveConversations: 4, reasoningEffort: '' }
  const lifecycle = new ConversationLifecycle({ ctx, definition, access, store: conversations, config, allowedTools: () => [] })
  const runtime = { ctx, definition, access, store: conversations, config, lifecycle, allowedTools: () => [] }
  const storage = { db, access }
  const participant = createParticipant({ definition, runtime: { ...runtime, lifecycle: () => lifecycle }, storage, access, config })
  t.after(async () => { await participant.dispose(); await lifecycle.dispose(); await host.disposeAll() })

  return {
    ctx, store, index, turns, conversations, jobs, chat, definition, participant, followups,
    /** 一轮 `run` 的请求（每次调用自带一个进度收集器）。 */
    input: (overrides = {}) => ({
      actor, missionId: 'mission-a', requestId: 'request-a', message: '看看博客最近情况',
      signal: new AbortController().signal, onProgress() { }, ...overrides,
    }),
    /**
     * `accept` / `complete` / `sessionOf` / `emit` 都由共享夹具提供（`tests/fixtures/fake-host.ts`）——
     * 口径只留一份。它们的说明（尤其"按**投递次数**算，不按会话 id 去重算"）也搬到了那里。
     */
    complete, accept,
    /**
     * 拿一个**可执行**的工具（kit 的 `guardTool` 结果，**带授权**）。
     *
     * ⚠️ 不要用 `jobs.tools` / `jobs.chatTools`：那两个都是**目录条目**（`ToolDescriptor`：
     * `{name, description, parameters}`），上面**没有** `execute` ⇒ 报
     * `tool.execute is not a function`。可执行的那一份是 kit 交给 `ctx.tools.register` 的，
     * 本夹具把它收在 `registeredTools` 里（见上面 `tools.register` 的注释）。
     */
    tool: (name: string) => fixtureTool(registeredTools.get(name)),
    /**
     * 走**真工具**把这一轮绑定到一份新建草稿上（`blog_select_draft`），供 `blog_propose` 用。
     *
     * ⚠️ 不能用 `newArticle: true`：那条路要求 `app.createBlogDraft`（远端真正建稿），本夹具的
     * `app` 只有 `operations`（收尾投影要的那一个）。所以先经**业务库**造一份草稿、再让工具按
     * `draftId` 选中它 —— 走的是 `selectDraft` 里 `args.draftId` 那一条真实分支。
     */
    async selectDraft(agent: FakeAgentLike) {
      const draft = await store.create(owner)
      const selected = await fixtureTool(registeredTools.get('blog_select_draft'))!.execute({ draftId: draft.id }, { agent })
      return { draft, selected }
    },
    sessionOf,
  } as unknown as CoordinatorFixture
}

test('J5：协调方驱动的一轮在页面那条读法里可见（会话行 / 轮次行 / 结果行）', async t => {
  const f = await fixture(t)
  const running = f.participant.run(f.input())
  const conversationId = await f.accept()
  // 会话行由**运行时的生命周期**建（页面路径与协作路径共用同一张表）。
  assert.equal(f.conversations.rawOf(conversationId)!.requestId, f.conversations.missionRequestId(portOwner, 'mission-a'))
  f.complete(conversationId, '最近一周没有新文章。')
  const result = await running
  assert.equal(result.status, 'completed')
  assert.equal(result.text, '最近一周没有新文章。')
  assert.equal(result.conversationId, conversationId)
  // 会话已发布 ⇒ 页面能列到它（未发布的行在侧栏口径下不可见）。
  const page = await f.chat.list(actor, 0, '')
  assert.deepEqual(page.items.map((item: { id: string }) => item.id), [conversationId])
  // 轮次行落库，且 `dsh_turn_results` 没有凭空多出记录（这一轮没准备候选）。
  assert.equal((await f.turns.turnStatus(portOwner, 'run:request-a')), 'finished')
  assert.deepEqual(await f.turns.turnResultsOf(portOwner, conversationId), [])
})

/**
 * **J5 的反向**。设计原文（`20260917-143532-blog索引库切PG方案.md:141`）是
 * "**页面上能看见协调方派活的会话（反向亦然）**"，而上一条用例只验了"协调方 → 页面"**一个**方向。
 * 这一条补**反向**：**页面路径建的会话，协调方看得见**。
 *
 * 判据取最强的那种形式：**协调方在页面建的那条上继续，拿回来的必须是同一个 id**
 * —— 若两条路径读的不是同一份存储，协调方要么找不到它、要么另建一条，`assert.equal` 当场红。
 * （只断言"运行时端口里能查到这一行"要弱得多：那可能只是端口恰好共享，不代表协调方真的用得上。）
 *
 * ⚠️ 页面侧的建会话入口是 `BlogChat.create`：`chat.provider` **只有**
 * `list`/`preview`/`remove`（见 `src/chat.ts:384-399`），**没有** create ⇒ 不能拿 provider 建。
 * 这里也不驱动一整轮页面 `run`（那要更全的模型面），因为本用例要验的是**存储同源**，不是页面回合本身。
 */
test('J5 反向：页面路径建的会话对协调方可见（协调方在同一条上继续，而不是另建一条）', async t => {
  const f = await fixture(t)
  // ① 页面路径建一条会话。
  const pageCreated = await f.chat.create(actor, 'request-page-side')
  assert.ok(pageCreated.id, '页面路径必须建出一条会话')

  /**
   * ⚠️ **页面路径的"新建对话"是两段**（`chat-store.ts:333-335`）：`create` 先**预留**（`ready=false`），
   * **用户打完第一条消息才发布**。⇒ **未发布的会话协调方本来就接不上**，这是设计口径、不是缺陷。
   *
   * 下面这半步是有意加的**负向对照**：它证明后面那条正向断言**有判别力**——
   * 若"协调方能不能看见"和发布无关（比如它读的是另一份空存储、或者断言恒真），
   * 这一条就会**先红**。
   */
  await assert.rejects(
    f.participant.run(f.input({
      requestId: 'request-before-publish', conversationId: pageCreated.id, message: '还没发布就接着问',
    })),
    error => /会话不存在或无权访问/.test(String((error as { message?: unknown })?.message)),
    '未发布的会话协调方不该能接上（否则后面那条正向断言没有判别力）',
  )

  // ② 补上页面路径的第二段：发布（`ChatStore.save` 是页面侧的发布入口，`ready:true` 才 publish）。
  await f.index.save(owner, pageCreated.id, { ready: true })

  /**
   * ③ 反向的判据：**协调方（运行时）看得见这一行** —— 取"**不再是 404**"这个二分。
   *
   * `ConversationLifecycle.open()` → `openExisting()` → `assertConversation()` 先做**归属与可见性**核验，
   * 过了才轮到 `assertMission()` 的**派生寻址交叉核验**（`conversation.ts:362` / `:618` / `:656`）。
   * 于是两种结局把"是不是同一份存储"分得很干净：
   *
   * - **读的是同一份存储** ⇒ 可见性过 ⇒ 只在 mission 交叉核验上被拒 ⇒
   *   `403「这条会话属于另一个协作任务」`（页面建的会话没有 mission 归属，`row.requestId` 不是 missionKey）；
   * - **读的不是同一份存储**（本用例要防的那种回归）⇒ 那一步就 `404「会话不存在或无权访问」`。
   *
   * 所以这里断言的是 **403 而不是 404**；上面那条"发布前必须 404"则是它的**对照**，
   * 两者合起来证明这个探针**有判别力**（不是恒真、也不是恒假）。
   */
  await assert.rejects(
    f.participant.run(f.input({
      requestId: 'request-reverse', conversationId: pageCreated.id, message: '接着这条说',
    })),
    error => /另一个协作任务/.test(String((error as { message?: unknown })?.message)),
    '发布之后协调方必须**看得见**页面路径建的这条会话（判据：不再是 404，而是走到 mission 交叉核验那一步）',
  )

  /**
   * ⚠️ **登记：反向的边界（此前无人写明）**
   *
   * 反向成立的是"**共享存储 ⇒ 协调方看得见页面建的会话**"，**不是**"协调方能接着页面建的会话跑一轮"。
   * 后者在本设计下**不被支持**：`participant.run` 会带上自己的 `missionId`，而
   * `assertMission()`（`conversation.ts`）要求 `row.requestId === missionKey`，
   * 页面建的会话（`BlogChat.create(actor, requestId)`，**没有 mission 入参**）不满足 ⇒ **403 拒绝**。
   * 这是**有意的守卫**（一个 mission 只能驱动自己的会话），不是缺陷；
   * 但它意味着反向**只能断言到"可见"这一层**。若将来要支持"接管页面会话"，那是**新能力**，需要新的设计裁定。
   */
})

test('阻塞 1：协调方驱动的那一轮里，真 blog 工具拿得到委派身份（不是 403）', async t => {
  const f = await fixture(t)
  const running = f.participant.run(f.input())
  const conversationId = await f.accept()
  const turnId = await f.turns.turnId(portOwner, 'run:request-a')
  assert.ok(turnId, '这一轮必须有行 id')

  // 这一轮的句柄由运行时建（`lifecycle.open()` → `ctx.agents.create`），**不是** `BlogChat.run()` 建的。
  const handle = f.sessionOf(conversationId)
  const binding = f.jobs.bindings.get(handle.agent)
  assert.ok(binding, 'onTurnStart 必须为运行时驱动的这一轮写下业务绑定（删掉 withTurnBinding 这里就是 undefined，随后每个工具 403）')
  // ⚠️ 必须是**行 id**（`dsh_turns.id`），不是幂等键：`dsh_turn_results.turn_id` 要的是它。
  assert.equal(binding.request.id, turnId)
  assert.notEqual(binding.request.id, 'request-a')
  assert.equal(binding.job.owner, owner)
  assert.equal(binding.job.input.research, false, '协作任务不启用联网查证（与旧协作入口逐字一致）')
  assert.equal(binding.handle.agent, handle.agent)

  // 真工具真的能跑：`authorize` 走 `jobs.bound(agent)`，没有绑定就是 403「没有有效的委派身份」。
  const tool = f.tool('blog_search_posts')
  assert.ok(tool, 'blog_search_posts 必须已注册')
  const value = await tool.execute({ query: '不存在的关键词-协调路径' }, { agent: handle.agent })
  assert.equal(typeof value, 'object')

  f.complete(conversationId, '查了一下，没有匹配的文章。')
  assert.equal((await running).status, 'completed')
  // 收尾必须摘掉绑定：不摘的话下一轮同名 Agent 会复用**上一轮的行 id**，产出写到别的轮次。
  assert.equal(f.jobs.bindings.get(handle.agent), undefined, 'onTurnFinish 必须摘掉绑定')
})

test('J7：跨轮候选经会话读法可见，下一轮如实报 external_pending', async t => {
  const f = await fixture(t)
  // —— 第 1 轮：模型调 `blog_propose` 准备一份候选稿 ——
  const first = f.participant.run(f.input())
  const conversationId = await f.accept()
  const propose = f.tool('blog_propose')
  assert.ok(propose, 'blog_propose 必须已注册')
  const firstHandle = f.sessionOf(conversationId)
  // 先选文章再提候选——两步都走**真工具**，中间隔着 `jobs.bound(agent)` 那道授权口。
  await f.selectDraft(firstHandle.agent)
  const proposal = await propose.execute({ title: '候选标题', text: '候选正文' }, { agent: firstHandle.agent }) as ProposalDraft
  assert.equal(typeof proposal.draftId, 'string')
  f.complete(conversationId, '已经准备好一份候选稿。')
  const firstResult = await first
  // 候选稿待采用 ⇒ 这一轮**本来就不是** completed。
  assert.equal(firstResult.status, 'external_pending')
  assert.equal(firstResult.artifacts![0]!.kind, 'draft')

  // —— 落库的那条结果记录的 `turn_id` 必须是**行 id** ——
  const firstTurnId = await f.turns.turnId(portOwner, 'run:request-a')
  const recorded = await f.turns.turnResultsOf(portOwner, conversationId)
  assert.equal(recorded.length, 1, '`chat.propose` 是 dsh_turn_results 的唯一生产写入点')
  assert.equal(recorded[0]!.turnId, firstTurnId, 'turn_id 必须是该轮的**行 id**（不是幂等键）')
  assert.notEqual(recorded[0]!.turnId, 'request-a')
  assert.equal(recorded[0]!.payload.kind, 'candidate')

  // —— 第 2 轮：**本轮没有新候选**，但上一轮那份仍待采用 ⇒ 跨轮那半必须报出来 ——
  const second = f.participant.run(f.input({ requestId: 'request-b', conversationId, message: '再说明一下来源' }))
  await f.accept(1)
  f.complete(conversationId, '来源是站内文章。')
  const secondResult = await second
  assert.equal(secondResult.status, 'external_pending',
    '跨轮候选看不到时会报 completed ⇒ 用户以为没事了（设计 §18 那条静默语义丢失）')
  assert.equal(secondResult.artifacts![0]!.kind, 'draft')
  assert.match(secondResult.text, /候选稿/)
})

test('J7 的负向对照：候选被丢弃之后，下一轮如实回到 completed', async t => {
  const f = await fixture(t)
  const first = f.participant.run(f.input())
  const conversationId = await f.accept()
  await f.selectDraft(f.sessionOf(conversationId).agent)
  const proposal = await f.tool('blog_propose')!.execute({ title: '候选标题', text: '候选正文' }, { agent: f.sessionOf(conversationId).agent }) as ProposalDraft
  f.complete(conversationId, '已准备候选稿。')
  assert.equal((await first).status, 'external_pending')
  // 用户在博客原页面**丢弃**了那一稿候选（业务库里不再有待采用的 proposal）。
  const draft = await f.store.get(owner, proposal.draftId)
  await f.store.discardProposal(owner, draft.id, draft.revision, draft.proposal.id)
  const second = f.participant.run(f.input({ requestId: 'request-c', conversationId, message: '继续' }))
  await f.accept(1)
  f.complete(conversationId, '好的。')
  const secondResult = await second
  assert.equal(secondResult.status, 'completed', '候选已丢弃却仍报 external_pending 会让用户永远收不到"办完了"')
})
