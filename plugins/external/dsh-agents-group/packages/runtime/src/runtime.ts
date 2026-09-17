/**
 * Agent 运行时的**装配工厂**：把一条完整的装配链收成一处，机制只实现一次。
 *
 * ```
 * 建存储（createAgentDatabase + await open()）
 *   → 调 definition.tools(...) 取业务工具描述符        ← ★ 这个钩子的唯一调用点
 *   → new ConversationLifecycle({ ctx, definition, access, store, config, allowedTools })
 *   → createParticipant({ definition, runtime, access, config, storage })
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
  type AgentRuntime,
  type LifecycleHost,
  type RuntimeConfig,
} from './conversation.ts'
import type { AgentDefinition } from './definition.ts'
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

  const host: LifecycleHost = { ctx, definition, access, store: db.conversations, config, allowedTools }
  const lifecycle = new ConversationLifecycle(host)
  const runtime: AgentRuntime = { ...host, lifecycle }
  const participant = createParticipant({ definition, runtime, storage, access, config })
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
    runtime,
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
