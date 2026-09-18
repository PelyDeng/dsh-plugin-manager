/**
 * Agent 运行时的**装配工厂**：把一条完整的装配链收成一处，机制只实现一次。
 *
 * ```
 * 建存储（createAgentDatabase + await open()）
 *   → 调 definition.tools(...) 取业务工具描述符        ← ★ 这个钩子的唯一调用点
 *   → 把存储端口的 titleSink() 接上 installTitleSink    ← ★ 标题投递的唯一装配点（经进程级路由）
 *   → 造 participant（先于 lifecycle：交活工具的按会话注册要它的 `handoffFor`）
 *   → new ConversationLifecycle({ ctx, definition, access, store, config, allowedTools, registerScopedTools })
 *   → createConversationProvider(...) 侧栏入口
 * ```
 *
 * ## 为什么必须有一个装配工厂
 *
 * 装配此前散在各业务的 `index.ts` 里，于是**声明与实现各自都在、中间的线没接**这一类缺陷
 * 反复出现。已经踩过一次的是 `definition.tools`：钩子声明了、业务照它写了工具、运行时也在
 * agent 作用域里做了 `tools.restrict`——**但没有任何代码调用它**。结果是业务一旦切到运行时，
 * 模型手里一个业务工具都没有，而且**不报错、完全静默**（限制一份空集合是合法的）。
 * 收成一处之后，钩子与它的调用点在同一条链上，装配顺序也只写一遍。
 *
 * ## 顺序与职责边界（都不是随意排的）
 *
 * - **存储先 `open()` 再取工具**：`open()` 做的是启动收敛（排空 outbox → PG 侧清理 → 按 PG
 *   收敛本地镜像，顺序不可交换），业务工具注册时拿到的门面必须是收敛完的那一份。
 * - **`definition.tools` 只在这里调一次**（装配期、插件级）。它**不**在 `createParticipant`
 *   的每会话路径上：那是会话作用域，重复注册会改变工具的生命周期语义，而工具限制本来就已经
 *   由运行时在 agent 作用域里做了（`ConversationLifecycle.setup()` 的 `restrict`）。
 * - **侧栏入口也只装配一次**：`conversationRemover` 内部的"移除时序"互斥是**进程内**的
 *   （`storage/adapter.ts` 是它唯一的装配点），装配两处就有两个互斥集合，同一会话经两条路径
 *   并发移除时两道闸互相看不见。本文件是这个唯一装配点的调用者。
 * - **注册与否由调用方决定**：本文件只**造出** `provider`；要不要 `registerConversations`
 *   是鉴权模式的问题（旧实现只在 `authenticated` 下登记），运行时不替业务做这个决定。
 *
 * ## 释放
 *
 * `dispose()` 按"先停入口、再停会话、最后关存储"的顺序释放，**幂等**（重复调用返回同一个
 * promise，不抛）：入口先停是为了让在飞轮次按 503 收尾，而不是在存储关掉之后才发现会话没了。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Access, ConversationProvider, ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import {
  ConversationLifecycle,
  installTitleSink,
  type AgentRuntime,
  type LifecycleHost,
  type RuntimeConfig,
  type TitleSink,
} from './conversation.ts'
import type { AgentDefinition } from './definition.ts'
import { reportResultTool } from './handoff.ts'
import { createParticipant, type RuntimeParticipant } from './participant.ts'
import { createConversationProvider } from './storage/adapter.ts'
import { createAgentDatabase, type CreateAgentDatabaseInput } from './storage/index.ts'
import type { AgentDatabasePort, AgentStoragePort, ConversationPort } from './storage/ports.ts'

/**
 * 装配一个 Agent 运行时的输入。
 *
 * 存储**必须**给，两条路二选一：`storage`（已建好的门面，装配侧测试传内存替身）或
 * `database`（自建参数）。两个都给或都不给都是**装配错误**，直接抛——静默挑一个会让
 * "我以为用的是这个库"这种问题在运行很久之后才暴露。
 */
export interface CreateAgentRuntimeInput {
  /**
   * 装配这个 Agent 的 cordis Context。
   *
   * 它是**业务自己的作用域**（会话级的东西由运行时在 `setup()` 里做），也是 `definition.tools`
   * 拿到的 `ctx`：注册在装配期发生，那时会话还不存在。
   */
  readonly ctx: Context
  readonly definition: AgentDefinition
  readonly access: Access
  readonly config: RuntimeConfig
  /** 这个 Agent 能用的工具名（本分类 + 通用集）；运行时在每个会话的 agent 作用域里应用它。 */
  readonly allowedTools: () => readonly string[]
  /** 已建好的存储门面。与 {@link CreateAgentRuntimeInput.database} 二选一。 */
  readonly storage?: AgentStoragePort
  /**
   * 自建存储的连接参数。
   *
   * 里面**没有** `agentId`：它取 `definition.id`——身份只有一份权威声明，两处各写一份迟早
   * 漂移，而漂移的后果是会话落到别的 Agent 名下。
   */
  readonly database?: Omit<CreateAgentDatabaseInput, 'agentId'>
  /**
   * **调用方自带的标题投递口**；缺省用存储端口那一份（`db.titleSink()`）。
   *
   * 什么时候需要它：业务**自己已经有完整的标题路径**——既落库、又通知页面（blog 的
   * `chat.ts` 就是：它注册 `registerConversationTitles`，写 `index.syncTitle` 之后再给页面发
   * `changed`）。此时若运行时再按存储端口另装一份，同一条标题会被**写两次**：第二次被守卫
   * （"自动标题不覆盖手动标题"）拒掉 ⇒ 业务那次判定的 `applied` 变成假 ⇒ **页面不刷新**，
   * 用户看到的是"改了名但列表里还是旧的"，而两边都不报错。
   *
   * ⚠️ 它**不改变**槽位的路由方式：传进来的这一份仍按 `agentId` 登记进 `titleRouter`，
   * 所以一个进程里多个 Agent 各用各的投递口、互不顶掉（见 `titleRouter` 的注释）。
   */
  readonly titleSink?: TitleSink
}

/** 装配结果。 */
export interface AgentRuntimeAssembly {
  /** 协作入口与页面入口共用的那部分运行时能力。 */
  readonly runtime: AgentRuntime
  /** 协作入口（唯一通道）。 */
  readonly participant: RuntimeParticipant
  /** 会话生命周期的唯一实现。 */
  readonly lifecycle: ConversationLifecycle
  /** 会话端口（`db.conversations` 的简写）。 */
  readonly store: ConversationPort
  /** 存储门面（自建时是 `AgentDatabaseFacade`，注入时是注入方那一份）。 */
  readonly db: AgentDatabasePort
  /**
   * `definition.tools` 的返回值，交给装配侧 `registerPlugin({ tools })`。
   *
   * 它是**已经注册过的**工具的目录条目（`registerTools` 这类业务实现内部就调了注册），
   * 装配侧只需要把它转交给清单登记，不要在这里再注册一次。
   */
  readonly tools: readonly ToolDescriptor[]
  /** 侧栏入口（kit 的 `ConversationProvider`）；是否登记由调用方决定。 */
  readonly provider: ConversationProvider
  /** 释放全部装配物；**幂等**，重复调用返回同一个 promise。 */
  dispose(): Promise<void>
}

/**
 * 标题投递口的**进程级路由**。
 *
 * `installTitleSink` 是**模块级单槽**（`conversation.ts:122`），而生命周期是**每个 Agent 一份**。
 * 所以"在工厂里直接 `installTitleSink(db.titleSink())`"会互踩：同进程里每装配一个 Agent 就把
 * 上一个的投递口顶掉，而被顶掉那些 Agent 的标题会被**静默丢弃** ——
 * `AgentDatabaseFacade.titleSink()` 只接受自己 `agentId` 的投递（`storage/index.ts:147`），
 * 别人的投递到了它手里一律 `return`。标题不可重建（宿主不会再发同一条事件），丢一条就是侧栏
 * 少一个标题，且不报错。
 *
 * 槽位里装的因此是这层**分发器**，不是第二份投递口实现：真正落库的仍然是存储端口已有的
 * `titleSink()`（它底层是本地持久 outbox，装配侧不重写）。`TitleSink.submit` 的第一个参数
 * 就是 agentId，分发是一对一的；每个运行时登记自己那一份，释放时摘掉自己那一份。
 *
 * **释放时不移除槽位**：槽位可能已经被别的装配方（业务 `mount()`）装上了它自己的投递口，
 * `installTitleSink(undefined)` 会把别人的一起抹掉。空转的分发器没有任何副作用。
 */
const titleSinks = new Map<string, TitleSink>()
const titleRouter: TitleSink = {
  submit: (agentId, conversationId, title, source) => {
    titleSinks.get(agentId)?.submit(agentId, conversationId, title, source)
  },
}

/**
 * 装配一个 Agent 运行时。
 *
 * 这是 `definition.tools` 的**唯一调用点**：删掉下面那次调用，业务工具就一个都不会被注册，
 * 而且不会有任何报错（`packages/runtime/src/definition.ts` 的 `tools` 注释写了这条）。
 */
export async function createAgentRuntime(input: CreateAgentRuntimeInput): Promise<AgentRuntimeAssembly> {
  const { ctx, definition, access, config, allowedTools } = input
  const db = await openDatabase(input, definition.id)
  const storage: AgentStoragePort = { db, access }

  // ★ 业务工具：装配期调用一次。返回值原样交给装配侧登记。
  const tools = definition.tools({ ctx, storage, conversationId: undefined })

  // ★ 标题投递口：装配期接一次。此前全仓只有 `installTitleSink` 的**定义与测试调用**、没有任何
  //   装配点 ⇒ `registerConversationTitles` 的回调（生命周期的构造函数里注册）投出去就消失，
  //   宿主标题永不落库，侧栏标题永久停在首句压缩值。这与 `definition.tools` 是同一类"零接线"
  //   缺陷（声明与实现都在、中间的线没接，而且完全静默）。
  //
  //   端点缺省用存储端口已有的那一份（`AgentDatabaseFacade.titleSink()`，底层是本地持久
  //   outbox：内存队列会在崩溃或卸载时丢标题），不另写实现；也可以由调用方自带一份
  //   （`input.titleSink`，见那个字段的注释：业务自己有"落库 + 通知页面"的完整标题路径时，
  //   再让运行时另装一份就是**双写**——同一条标题被写两次，后写那次会被守卫拒 ⇒ `applied`
  //   为假 ⇒ 页面不刷新，表现成"标题还是旧的"而没有任何报错）；槽位为什么要路由见 `titleRouter`。
  //   装在 `new ConversationLifecycle(...)` **之前**：标题订阅就是那个构造函数注册的，
  //   投递口必须在任何事件可能到达之前就在位。
  const sink = input.titleSink ?? db.titleSink?.()
  if (sink !== undefined) {
    titleSinks.set(definition.id, sink)
    installTitleSink(titleRouter)
  }

  // `storage` 一并交给生命周期：回合钩子（`onTurnStart` / `onTurnFinish`）要把它给业务，
  // 而业务在那个时点只能靠它读自己的表（`definition` 是每 Agent 一份，拿不到每请求的东西）。
  //
  // ⚠️ **装配顺序：先 participant、后 lifecycle**。交活工具是**按会话**的，账本住在 participant
  // 里（`handoffFor(conversationId)`），而工具注册发生在 lifecycle 的 `setup()` 里 ⇒ 先造
  // participant，才能把那个闭包交给 lifecycle。`createParticipant` 只在**回合运行时**读
  // `lifecycle()`（`participant.ts` 里 `lifecycle.*` 全在 `runTurn` 内），构造期不读，
  // 所以"先给取值器、后让 `const lifecycle` 初始化"这个顺序成立。
  const host: LifecycleHost = { ctx, definition, access, store: db.conversations, config, allowedTools, storage }
  /**
   * 交给 participant 的只有两样：装配上下文与**lifecycle 的惰性取值器**。
   *
   * 这两行是本文件最容易出事故的地方（2026-09-18 两次线上事故都在这附近），所以刻意写窄：
   *
   * - 不传 `host`、更不传 `runtime`：`AgentRuntime` **没有** `lifecycle` 字段了，"顺手把整份
   *   运行时传进去"这条路不存在；
   * - 取值器而不是实例：`const lifecycle` 在这一行之后才初始化；
   * - 不留任何 `as unknown as`：形状不对就是编译错误。
   */
  const participant = createParticipant({
    definition,
    runtime: { ctx, lifecycle: () => lifecycle },
    storage,
    access,
    config,
  })
  /**
   * **交活工具的接线点**（`report_result` 唯一的注册处）。
   *
   * 两件事必须一起做完，缺一件都是**静默失效**：
   *
   * - `agentCtx.tools.register(...)`：把工具挂进**这个会话**的 agent 作用域。挂会话作用域是有意
   *   的——账本按会话分，工具就必须按会话取账本，否则多会话并发时会串到别人的账本上。宿主的
   *   `register` 语义正是"按调用时的作用域注册"，且 scoped 工具**不受 `restrict` 影响**
   *   （所以它不需要、也不该出现在 `allowedTools` 名册里）。
   * - `ledger.install()`：告诉运行时"模型手里**真的**有这个工具"。补交轮的门槛就是
   *   `ledger.available`（`handoff.ts:64-67`）：没装它时运行时不敢补交（怕模型手里没工具、
   *   补交只是白花一轮预算），于是 ⑦ 把"没交活"记成 `unverified` 而不是判失败。
   *
   * 删掉这一段**不会报任何错**：交付照常走投影兜底，只是补交轮、⑦ 的 `report-called`、超时兜底
   * 三条路径一起消失。`tests/runtime-closure.test.ts` 的接线断言就是为了让这种删除变成红灯。
   */
  host.registerScopedTools = (
    agentCtx: Parameters<NonNullable<LifecycleHost['registerScopedTools']>>[0],
    conversationId: Parameters<NonNullable<LifecycleHost['registerScopedTools']>>[1],
  ) => {
    const ledger = participant.handoffFor(conversationId)
    ledger.install()
    agentCtx.tools.register(reportResultTool(ledger))
  }
  const lifecycle = new ConversationLifecycle(host)
  const provider = createConversationProvider({
    ctx,
    port: db.conversations,
    access,
    busy: conversationId => lifecycle.isBusy(conversationId),
    list: (actor, query, scope) => lifecycle.list(actor, query, scope),
    release: conversationId => lifecycle.release(conversationId),
    stopping: () => lifecycle.stopped,
    projectHistory: events => lifecycle.previewOf(events),
  })

  let disposing: Promise<void> | undefined
  return {
    runtime: host,
    participant,
    lifecycle,
    store: db.conversations,
    db,
    tools,
    provider,
    dispose: () => {
      disposing ??= (async () => {
        // 顺序不可交换：先停入口（在飞轮次按 503 收尾），再停本实例持有的会话句柄，
        // 最后关存储。反过来的话，收尾里的存储调用会落在一个已经关掉的门面上。
        await participant.dispose()
        await lifecycle.dispose()
        // 标题投递口要在关存储**之前**摘掉：它指向的就是这个即将关闭的门面。只摘**自己那一份**
        // （同一 agentId 可能已经换了新装配，那张表里已经不是这个 sink 了）；槽位本身不动，
        // 理由见 `titleRouter`。
        if (sink !== undefined && titleSinks.get(definition.id) === sink) titleSinks.delete(definition.id)
        await db.close()
      })()
      return disposing
    },
  }
}

/**
 * 二选一拿到存储门面：注入的那一份，或按参数自建并 `open()` 的那一份。
 *
 * **自建必须走 `open()`**：它按不可交换的顺序做启动收敛（排空 outbox → PG 侧清理 → 按 PG
 * 收敛本地镜像）。只 `assertSchema()` 就开服务，会让本地围栏与 PG 对不上。
 *
 * **注入的那一份不由这里 `open()`**：`AgentStoragePort` 上没有 `open`，而"什么时候做启动
 * 收敛"是注入方的决定（内存替身根本没有收敛这回事）。
 */
async function openDatabase(input: CreateAgentRuntimeInput, agentId: string): Promise<AgentDatabasePort> {
  const { storage, database } = input
  if (storage !== undefined && database !== undefined) {
    throw new Error('createAgentRuntime：storage 与 database 只能给一个（注入的门面由注入方负责 open）')
  }
  if (storage !== undefined) return storage.db
  if (database === undefined) {
    throw new Error('createAgentRuntime：必须给 storage（已建好的门面）或 database（自建参数）')
  }
  const facade = createAgentDatabase({ ...database, agentId })
  await facade.open()
  return facade
}
