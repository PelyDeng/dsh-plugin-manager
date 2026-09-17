/**
 * **运行时协作入口**的构造胶水（blog 的测试用）。
 *
 * ## 它是什么 / 不是什么
 *
 * 它**只是构造**：把 blog 的 `AgentDefinition`（`createBlogDefinition` + `withTurnBinding`）、
 * 运行时的 `ConversationLifecycle` 与 `createParticipant` 按装配的顺序拼起来，再把 `dispose`
 * 转发出去。**一行机制都不重新实现** —— 回合驱动、业务的回合绑定（`bindRuntimeTurn`）、
 * 结果行落库（`dsh_turn_results`）、授权（`jobs.mjs` 的 `authorize: agent => bound(agent)`）
 * 全部来自产品代码。评审时按这条判：本文件里出现任何"回合状态机 / 绑定写入 / 结果落库"的
 * 逻辑，就是越界。
 *
 * ## 为什么需要它（而不是让测试各写一份）
 *
 * `agents/blog/src/participant.ts` 在 P7 被删除（协作入口收敛到运行时），而两个测试文件
 * （`participant.test.mjs`、`chat.test.mjs`）此前直接 `createBlogParticipant({access, chat, index,
 * storage, routePrefix})`。**签名保持不变**是刻意的：那 27 条用例的用例体与断言因此可以**逐字不动**
 * ——"新入口能承载旧断言"这件事本身就是要证明的东西，改断言就把它抹掉了。
 *
 * ⚠️ 它**不**与 `coordinator.test.mjs` 共用夹具：那一边要的是**真** `BlogChat` / `BlogJobs`
 * 与真工具执行（钉"工具不 403"），这一边要的是旧用例的 `chat` 替身（钉协作入口的语义）。
 * 两份夹具的差别只有"业务边界换成替身"，产品代码那一侧是同一份。
 *
 * ## 与旧实现**已知**的两处差别（口径不同，如实登记，不是抹平）
 *
 * 1. 旧入口自己驱动一轮（`chat.send` → 订阅 → 收尾）；现在驱动方是运行时的
 *    `ConversationLifecycle`（`ctx.agents.create/resume` + `session/event`）。所以夹具必须提供
 *    一个**假宿主**（`ctx.agents` / `ctx.on` / 事件注入），旧入口不需要。
 * 2. 幂等身份从"`requestId` 派生"变成运行时的 `run:<requestId>`（`dsh_turns.request_id`）。
 *    这正是"同一 mission 只建一条会话"从业务表搬到 `dsh_conversations` 的部分唯一索引。
 */
import type { Context } from '@deepseek-ai/cordis'
import { ConversationLifecycle, createParticipant as createRuntimeParticipant, installTitleSink } from '../../../packages/runtime/src/index.ts'
import type { ParticipantRequest } from '../../../packages/runtime/src/contract.ts'
import type { AgentRuntime, RuntimeConfig, TitleSink } from '../../../packages/runtime/src/conversation.ts'
import type { AgentStoragePort } from '../../../packages/runtime/src/storage/ports.ts'
/**
 * ⚠️ `createBlogDefinition` 是**运行期的值**（下面真的调它造声明），**不能**写成 `import type`
 * ——那会被 strip-only 整个抹掉，报 `createBlogDefinition is not defined`（实测踩过）。
 * 只有 `withTurnBinding` 与它一起按值导入。
 */
import { createBlogDefinition } from '../src/definition.ts'
import { withTurnBinding } from '../src/index.ts'

/**
 * `createBlogParticipant` 用的**业务声明入参**（`createBlogDefinition` 的入参）。
 *
 * 取成品函数的入参类型而不是各字段抄一遍：抄一遍会在声明加字段时**静默**漂移，
 * 而漂移的后果正是本文件要修的那一类（`results` 早先写成裸函数）。
 */
type BlogDefinitionInput = Parameters<typeof createBlogDefinition>[0]

/** 协作入口的入参（`createParticipant` 的入参）：`access` 与 `runtime.store` 从它取。 */
type CreateParticipantInput = Parameters<typeof createRuntimeParticipant>[0]

/**
 * 业务边界替身（页面路径的真 `BlogChat` 也在这个形状里）。
 *
 * ## 为什么只写这三个面
 *
 * 本文件只碰 `chat` 的三个字段：`bindRuntimeTurn`（包 `withTurnBinding` 时要用）、
 * `titleSink`（缺省标题投递口）、`ctx`（拿不到 `input.ctx` 时的宿主回落）。
 * **不写成 `BlogChat`**：协作路径传进来的 `chat` 是**替身**，它刻意没有
 * `bindRuntimeTurn` / `unbindRuntimeTurn`（补上就是第二份实现），所以那一个方法在这里是**可选**的，
 * 由 `createBlogParticipant` 里那条"要绑却没方法就当场抛"的守卫负责把缺的挡下来。
 * 类实例（真 `BlogChat`）按结构照常满足这个接口——反过来把整个类写进接口，替身就传不进来了。
 */
interface ChatBoundary {
  /** 宿主 cordis Context（`input.ctx` 缺席时的回落来源）。 */
  readonly ctx?: Context
  /**
   * 本轮的委派身份绑定（唯一实现在 `chat.ts`）。
   *
   * 入参只写**被 `withTurnBinding` 透传进去的那几个字段名**，是刻意的：这里只做转发、
   * 不读它们，写死更细的 `Agent` / `AgentHandle` 类型只会让接口依赖本文件用不到的类型。
   */
  readonly bindRuntimeTurn?: (input: { readonly agent: unknown; readonly handle: unknown; readonly actor: unknown; readonly turnId: string }) => Promise<void>
  /** 业务自己那一份标题投递口（装配里 `titleSink: chat.titleSink` 那一行）。 */
  readonly titleSink?: TitleSink
}

/**
 * 业务索引库里被本文件读到的那一面：**跨轮候选判定**按会话读产出记录。
 *
 * 按 `createBlogDefinition` 的入参写（`results.list`），因为它就是投影要拿的那一份契约。
 */
interface ResultsIndex {
  results(owner: string, conversationId: string): Promise<readonly Record<string, unknown>[]>
}

/**
 * 运行时的存储端口：**就是 `AgentDatabasePort` 的那几个面**（`conversations` / `turns` / `titleSink` / …）。
 *
 * 从 `AgentStoragePort['db']` 里 `Pick` 出本文件唯一读到的那几个成员——它们正是下面
 * "缺哪个补哪个"的等值兜底要补的那几个（`assertSchema` / `query` / `close`，加端口自带的
 * `conversations` / `turns` / `titleSink`）。用 `Pick` 而不是自己再写一遍形状：抄一遍会在端口
 * 加字段时**静默**漂移，而漂移的后果正是本文件要修的这类隐式 `any`。
 *
 * `titleSink` 用 `NonNullable<...>` 剥掉"成员可选"那一层：端口的声明是 `titleSink?()`，而本文件对它
 * **原样转发、不兜底**（缺队列就缺队列）⇒ 转发出来的那一份必须**总是函数**（可能返回 `undefined`），
 * 只带 `| undefined` 的可选成员在 `exactOptionalPropertyTypes` 下与端口那一侧对不上（实测 TS2322）。
 */
type RuntimeDatabase = Pick<AgentStoragePort['db'], 'conversations' | 'turns' | 'assertSchema' | 'query' | 'transaction' | 'close'> & {
  readonly titleSink: NonNullable<AgentStoragePort['db']['titleSink']>
}

/**
 * `createBlogParticipant` 的入参。字段按**实际被读取**的那些写（见各自的注释）。
 *
 * ⚠️ 调用方还会挂别的字段（`f.sendGate` / `f.historyGate` / `f.lastHistoryId` / `f.peakListeners`
 * 之类）——那些挂在**夹具对象**上、由用例与驱动循环读写，本文件一个都不读，所以这里不声明。
 */
interface BlogParticipantInput {
  readonly access: CreateParticipantInput['access']
  readonly chat: ChatBoundary
  readonly index: ResultsIndex
  readonly storage: BlogDefinitionInput['storage']
  readonly routePrefix?: string
  readonly database: RuntimeDatabase
  /** 协作路径显式传 `false` 表示"这一侧不绑回合身份"（见下面 `bindTurn` 那段注释）。 */
  readonly bindTurn?: boolean
  /** 调用方自己已经建好的生命周期（同一个夹具一份，理由见下面 `lifecycle` 那段注释）。 */
  readonly lifecycle?: ConversationLifecycle
  /** 业务自己的标题投递口（落库 + 广播那一条完整路径）。 */
  readonly titleSink?: TitleSink
  /** 宿主 cordis `Context`。**必须由调用方给**，缺了当场抛（见下）。 */
  readonly ctx?: Context
  readonly persona?: string
  readonly tools?: BlogDefinitionInput['tools']
  readonly app?: BlogDefinitionInput['app']
  readonly results?: BlogDefinitionInput['results']
  readonly allowedTools?: AgentRuntime['allowedTools']
  readonly config?: Partial<RuntimeConfig>
}

/**
 * 装着"当前这个生命周期收到的标题"的投递口，投给**业务自己那一份**（`input.titleSink`）。
 *
 * ## 为什么必须在这里接（本文件唯一一处"看起来像机制"的东西，写清理由）
 *
 * 生产装配里**唯一的标题订阅**由运行时的 `ConversationLifecycle` 构造函数注册
 * （`registerConversationTitles`），它往**槽位**投；而 `createAgentRuntime` 在装配期调
 * `installTitleSink(titleRouter)`，`blog/src/index.ts` 把 `chat.titleSink` 交给它
 * （§62 的裁定：一个订阅、一个写者 ⇒ 不能有两个订阅，否则同一标题写两次、后写被守卫拒、
 * 页面收不到 `changed`）。
 *
 * 本文件恰恰是**不建 `createAgentRuntime` 的那条路**（它要完整的 `AgentDatabasePort`），
 * 所以装配期那一次 `installTitleSink` **不会发生**。少了它，走运行时入口的夹具里
 * **没有任何人订阅标题**：迟到的官方标题不生效、"标题被接受时必须广播一次"数到 0。
 * 那不是产品缺陷，是**夹具漏接线**——旧入口自己订阅，新入口把这个订阅交给了运行时。
 *
 * ⇒ 这里补的正是**装配侧那一行**，没有第二份实现：分发器仍是运行时的 `titleRouter`，
 * 真正落库 + 广播的仍是业务自己的 `chat.titleSink`。
 *
 * ⚠️ 槽位是**模块级单槽**，所以按 `agentId` 分开存；释放时**只摘自己那一份**
 * （与 `createAgentRuntime` 同一套做法、同一条理由：摘多了会把别的装配方的投递口一起抹掉）。
 */
const titleSinks = new Map<string, TitleSink>()
const titleRouter = {
  submit: (agentId: string, conversationId: string, title: string, source: 'automatic' | 'generated' | 'manual') => { titleSinks.get(agentId)?.submit(agentId, conversationId, title, source) },
}

/**
 * 把业务自己的标题投递口装进槽位（**装配侧那一行的等价物**）。
 *
 * 导出它是为了让别的夹具（`chat.test.mjs`）用**同一份**槽位，而不是各自装一个——
 * 模块级单槽，各装一个就是互相顶掉，最后谁生效取决于装配顺序。
 *
 * @returns 摘除自己的那一份（槽位本身不动，理由同上）。
 */
export function installTitleDelivery(agentId: string, sink: TitleSink) {
  titleSinks.set(agentId, sink)
  installTitleSink(titleRouter)
  return () => { if (titleSinks.get(agentId) === sink) titleSinks.delete(agentId) }
}

/** 与 `agents/blog/src/index.ts` 的 `runtimeConfigOf` 同口径（那三个字段 blog 的 `Config` 没有）。 */
const config = Object.freeze({
  routePrefix: '/blog',
  turnTimeoutMs: 3000,
  authRecheckMs: 1000,
  maxActiveConversations: 4,
  reasoningEffort: '',
})

/**
 * 造一个"运行时协作入口"，签名与已删除的 `createBlogParticipant` 一致。
 *
 * @param input.chat 业务边界替身：`run`（页面路径的驱动方，本文件不用）、`history`、`stop`、
 *   `subscribe` 等。`bindRuntimeTurn` / `unbindRuntimeTurn` 在缺省（`bindTurn` 未传或 `true`）时**必须提供**；
 *   协作路径的替身通常**没有**它们，那就显式传 `input.bindTurn: false`（理由见 `bindTurn` 那段注释）。
 * @param input.bindTurn 缺省 `true`：照现状包 `withTurnBinding`（页面路径的真 `BlogChat` 用得到）。
 *   传 `false` 时用**朴素定义**（与 closedoff 已迁移的后继物一致），工具委派身份不由本文件覆盖。
 * @param input.ctx 宿主 cordis `Context`（运行时的驱动方需要 `agents` / `on` / `effect`）。
 *   **必须由调用方给**；缺了**当场抛**（见下）。
 * @param input.storage 业务存储（投影要按 owner 读草稿）。**没有** `db` / `turns` 时按缺省处理：
 *   运行时的存储端口是**另一个**参数（见 `input.database`），两者不要混。
 * @param input.database 运行时的存储端口（`AgentDatabasePort`：`conversations` / `turns`）。
 *   `participant.test.mjs` 的替身索引就是它。
 */
export function createBlogParticipant(input: BlogParticipantInput) {
  const { access, chat, index, storage, routePrefix = '/blog', database, titleSink, ctx: host } = input
  /**
   * 宿主的 cordis Context。**必须由调用方给**（`ctx` 或 `chat.ctx`）：运行时的生命周期要用
   * `ctx.agents` / `ctx.on` / `ctx.effect` / `ctx.get('llm')` 等一整套宿主面，而这里**不替它
   * 兜底**——兜底就等于在这里悄悄实现一个假宿主，"测试跑的是谁"从此说不清。给不出来时**当场抛**。
   */
  const ctx = host ?? chat.ctx
  if (ctx?.agents === undefined || typeof ctx.on !== 'function') {
    throw new Error('createBlogParticipant（运行时入口）：需要宿主 ctx（含 agents / on / effect）；页面路径的旧夹具没有它，要按假宿主补上')
  }
  /**
   * ⚠️ **缺省保持现状：包 `withTurnBinding`**（`chat.test.mjs` 走页面路径、它的 `chat` 是真
   * `BlogChat`，`withTurnBinding` 在那里能工作，那 65 条是绿的）。**不要为了让协作路径通过而
   * 把缺省改成"不包"** —— 那会**静默**改掉 `chat.test.mjs` 那一侧的行为，而且它可能一条断言都不红
   * （"没红"与"没影响"在测试里不是一回事）。
   *
   * **协作路径显式退出**：本仓已完成的同一次迁移（`agents/closedoff/tests/participant.test.ts:35`）
   * 用的就是**朴素定义**、不包 `withTurnBinding`、全程不碰 `chat.send`。
   * 那里退出的理由有两条，都成立：
   * 1. **业务工具的委派身份已由 `coordinator.test.mjs` 覆盖**（J5 / 阻塞1 / J7 / J7 负向对照，4/4 绿，
   *    且 M1 变异可证伪：删掉绑定「阻塞 1」就红）⇒ **不重复覆盖**；
   * 2. 协作路径的 `chat` **替身**没有 `bindRuntimeTurn` / `unbindRuntimeTurn`（实现只有一份：
   *    `chat.ts` 的 `bindRuntimeTurn` / `unbindRuntimeTurn`）。**给替身补上就是第二份实现**，
   *    正是本仓明令禁止的；而且它会**静默**——绑不上只让工具各 403 一次，看起来像"工具没注册"。
   *
   * ⇒ **`input.bindTurn === false`** 时用朴素定义（调用方显式声明"这一侧不绑"）。
   * 传 `true` 时若 `chat` 没有那两个方法，**当场抛**，不静默降级（与"缺 `ctx` 就抛"同一条口径）。
   */
  const bindTurn = input.bindTurn ?? true
  if (bindTurn && typeof chat.bindRuntimeTurn !== 'function') {
    throw new Error('createBlogParticipant：要包 withTurnBinding，但传入的 chat 没有 bindRuntimeTurn / unbindRuntimeTurn —— 那是协作路径缺了半边业务面。若这一侧本就不该绑，请显式传 bindTurn: false')
  }
  const baseDefinition = createBlogDefinition({
    persona: input.persona ?? '你是伊丽莎白 · 博客：查询博客、整理资料并提出文章候选。',
    tools: input.tools ?? (() => []),
    storage,
    app: input.app ?? { operations: async () => [] },
    routePrefix,
    /**
     * ⚠️ **契约是 `{ list }`，不是裸函数**（`agents/blog/src/definition.ts:129-131`：
     * `readonly results: { list(owner, conversationId): Promise<readonly Record<string, unknown>[]> }`；
     * 唯一的调用点是 `:301` 的 `input.results.list(owner, conversationId)`，走"跨轮候选"那条路）。
     *
     * 之前这里写的是裸函数，**只在跨轮候选那条路上炸**（`input.results.list is not a function`），
     * 所以它是**潜伏**的：不带候选的用例一条都碰不到。这是夹具的契约失真，不是实现问题。
     */
    results: input.results ?? { list: (owner, conversationId) => index.results(owner, conversationId) },
  })
  // 边界断言：`ChatBoundary` 是"页面路径的真 `BlogChat` 与协作路径的替身"共同满足的最小形状，
  // 而立刻上面那条守卫已经核过 `bindRuntimeTurn` 真的在（缺了就当场抛），所以这里按 `BlogChat`
  // 交给 `withTurnBinding` 是"守卫核过的窄化"，不是把类型检查绕过。
  const definition = bindTurn ? withTurnBinding(baseDefinition, chat as unknown as Parameters<typeof withTurnBinding>[1]) : baseDefinition

  const runtimeConfig = { ...config, routePrefix, ...(input.config ?? {}) }
  /**
   * 标题投递口：**装配期装一次**（与 `createAgentRuntime` 同一个位置、同一顺序——必须在
   * `new ConversationLifecycle(...)` **之前**，因为标题订阅就是那个构造函数注册的）。
   *
   * 缺省取 `input.titleSink`；没传就**不装**（如实反映"这一侧没有订阅标题"，
   * 而不是悄悄编一个投递口把差异抹平）。
   */
  const sink = titleSink ?? input.chat?.titleSink
  const uninstallTitle = sink === undefined ? undefined : installTitleDelivery(definition.id, sink)
  /**
   * 生命周期**可以由调用方复用**（`input.lifecycle`）：一个夹具一个生命周期，与生产一致。
   *
   * 什么时候要传：夹具自己已经建了一个（`chat.test.mjs` 的夹具为了让**页面路径**的标题事件
   * 有人订阅而必须建一个——`BlogChat` 自 P7 起不再自己订阅）。此时这里再建第二个，
   * 同一条标题会被两个订阅各投一次 ⇒ **写两次**（后一次被守卫拒 ⇒ 页面收不到 `changed`）。
   */
  const lifecycle = input.lifecycle ?? new ConversationLifecycle({
    ctx, definition, access, store: database.conversations, config: runtimeConfig, allowedTools: input.allowedTools ?? (() => []),
  })
  const runtime = { ctx, definition, access, store: database.conversations, config: runtimeConfig, lifecycle, allowedTools: input.allowedTools ?? (() => []) }
  /**
   * 运行时的存储端口：**原样转发**调用方给的 `database`（内存端口自带 `titleSink` —— 那是
   * **outbox**：`ChatStore.syncTitle` 用 `this.db.titleSink?.()` 把镜像的标题投进持久队列）。
   *
   * ⚠️ 这里**不要**用 `input.titleSink` 去覆盖 `db.titleSink`。**两个"标题投递口"不是一回事**：
   * - `db.titleSink()`：**存储侧**的持久队列（PG / 本地 outbox 的补写点）；
   * - `input.titleSink`（= 装配里的 `titleSink: chat.titleSink`）：**业务**那条完整路径
   *   （落库 + 给页面广播 `changed`），它由运行时的标题订阅驱动。
   *
   * `createAgentRuntime` 里 `const sink = input.titleSink ?? db.titleSink?.()` 之所以"二选一"，
   * 正是因为**同一个槽位**装的是"往哪投"，而业务自带一条完整路径时就不该再叠一份存储侧的
   * （叠了 = 同一条标题写两次，后写被守卫拒 ⇒ 页面收不到 `changed`）。
   */
  const storagePort = {
    db: {
      ...database,
      assertSchema: database.assertSchema ?? (async () => { }),
      query: database.query ?? (async () => []),
      close: database.close ?? (async () => { }),
    },
    access,
  }
  const participant = createRuntimeParticipant({ definition, runtime, storage: storagePort, access, config: runtimeConfig })

  return {
    definition,
    lifecycle,
    participant,
    /** 与旧 `createBlogParticipant(...)` 的返回值形状一致（`{run, dispose}` 之外多给几个观测量）。 */
    run: (request: ParticipantRequest) => participant.run(request),
    /**
     * 续问入口。`!` 的理由：`createParticipant` 的返回值**逐次**都带 `reply`
     * （`participant.ts:822` `reply: request => runTurn(request, 'reply')`），只是契约把成员声明成
     * `reply?`（"实现了才暴露"）⇒ 这一处非空是**实现事实**，不是"大概有"。
     */
    reply: (request: ParticipantRequest) => participant.reply!(request),
    dispose: async () => {
      await participant.dispose()
      // 复用的那个生命周期归调用方（它的订阅不是本函数建的，本函数就不该拆）。
      if (input.lifecycle === undefined) await lifecycle.dispose()
      uninstallTitle?.()
    },
  }
}
