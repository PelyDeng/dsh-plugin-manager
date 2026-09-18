/**
 * 装配工厂（`packages/runtime/src/runtime.ts` 的 `createAgentRuntime`）的验收。
 *
 * ## 这个文件存在的理由：判据①是**缺口本身**
 *
 * `AgentDefinition.tools` 此前在全仓**零调用点**：钩子声明了、业务照它写了工具、运行时也在
 * agent 作用域里做了 `tools.restrict`——但没有任何代码调用它。后果是业务切到运行时之后模型
 * 手里一个业务工具都没有，而且**不报错、完全静默**（限制一份空集合是合法的，没有任何信号）。
 *
 * 所以第一条用例断的是"**钩子真的被调用了一次、并且拿到了装配 ctx**"，而不是"装配结果长得对"：
 * 把 `createAgentRuntime` 里那次调用删掉，这条必须变红。用例本身不解释这个前提——它是判据。
 *
 * ## 纪律
 *
 * - **不连真 PG**：存储用内存替身（`tests/fixtures/memory-conversation-port.ts`）包一个最小的
 *   `AgentDatabasePort` 假对象；`storage` 走注入路径，装配工厂就不会去 `createAgentDatabase`。
 * - **假宿主只造这条路径需要的面**：`ctx.on` / `ctx.effect`（真实的 `effect` 会立即执行 effect
 *   体并登记它返回的释放器）。装配不打开会话，所以不需要模型路由与会话持久化。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Access, ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it } from 'vitest'
import { installTitleSink, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import type { AgentDefinition, AgentToolContext } from '../packages/runtime/src/definition.ts'
import { createAgentRuntime } from '../packages/runtime/src/runtime.ts'
import type { AgentDatabasePort, AgentStoragePort, TurnStorePort } from '../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'

const AGENT_ID = 'assembly-agent'
const actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' } as const

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

/**
 * 只造装配路径需要的面。
 *
 * `effect` 刻意按真实 cordis 的语义实现：**立即执行 effect 体**，并把它返回的释放器登记下来
 * （`createParticipant` 用 `ctx.effect(() => stop)` 把入口的停止挂到插件作用域上）。
 */
function fakeHost() {
  const byEvent = new Map<string, Set<(...args: unknown[]) => void>>()
  const registeredEffects: (() => Promise<void> | void)[] = []
  const on = (name: string, listener: (...args: unknown[]) => void): (() => void) => {
    const group = byEvent.get(name) ?? new Set<(...args: unknown[]) => void>()
    group.add(listener)
    byEvent.set(name, group)
    return () => { group.delete(listener) }
  }
  /** 投递一条事件（与真实 cordis 一致：只给订阅了这个名字的监听器）。 */
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of [...(byEvent.get(name) ?? [])]) listener(...args)
  }
  const ctx = {
    effect: (execute: () => unknown) => {
      const disposable = execute()
      if (typeof disposable === 'function') registeredEffects.push(disposable as () => Promise<void> | void)
      return async () => {}
    },
    on,
    get: () => undefined,
    root: { emit: () => {} },
  } as unknown as Context
  return { ctx, registeredEffects, emit, listeners: () => [...byEvent.keys()] }
}

/** 一条投递到标题口的记录（真实实现里它会被写进本地 `title_outbox`，再后台补写 PG）。 */
interface TitleDelivery {
  readonly agentId: string
  readonly conversationId: string
  readonly title: string
  readonly source: string
}

/** 内存存储门面：会话走替身，其余面是最小实现。 */
function fakeDatabase(agentId: string) {
  const port = new MemoryConversationPort(agentId)
  const titles: TitleDelivery[] = []
  let closes = 0
  const turns: TurnStorePort = {
    claim: async () => 'claimed',
    finish: async () => {},
    turnStatus: async () => undefined,
    // 结果层（`dsh_turn_results`）本文件用不到；真实覆盖在 `runtime-turn-results.test.ts`。
    turnId: async () => undefined,
    appendTurnResult: async () => '',
    turnResults: async () => [],
    // ③-A 的端口增量（`turnById` / `turnsOf` / `patchTurnPayload`）本文件也用不到。这里**故意抛**
    // 而不是返回空值：静默返回 `undefined` / `[]` / `{}` 会把"线接到了这里"伪装成成功（假绿）。
    // 真实覆盖在 `storage-contract.test.ts`（真 PG）与 `MemoryTurnStore`。
    turnById: async () => { throw new Error('本文件的替身不实现 turnById') },
    turnsOf: async () => { throw new Error('本文件的替身不实现 turnsOf') },
    turnResultsOf: async () => { throw new Error('本文件的替身不实现 turnResultsOf') },
    turnsByOperationId: async () => { throw new Error('本文件的替身不实现 turnsByOperationId') },
    patchTurnPayload: async () => { throw new Error('本文件的替身不实现 patchTurnPayload') },
    pendingQuestion: async () => undefined,
    setPendingQuestion: async () => {},
  }
  const db = {
    assertSchema: async () => {},
    conversations: port,
    turns,
    /**
     * 标题投递口。
     *
     * 真实现是 `AgentDatabaseFacade.titleSink()`：**只接收自己 agentId 的投递**（别人的会话在
     * 这个门面上根本不存在），落点是本地 `title_outbox`（持久，后台补写 PG）。这里只记录投递，
     * 够断言"装配有没有把线接上"。
     */
    titleSink: () => ({
      submit: (sinkAgentId: string, conversationId: string, title: string, source: string) => {
        if (sinkAgentId !== agentId) return
        titles.push({ agentId: sinkAgentId, conversationId, title, source })
      },
    }),
    query: async () => [],
    transaction: async (fn: (tx: AgentDatabasePort) => Promise<unknown>) => fn(db as unknown as AgentDatabasePort),
    close: async () => { closes += 1 },
  } as unknown as AgentDatabasePort
  return { db, port, titles, closes: () => closes }
}

const config: RuntimeConfig = {
  routePrefix: '/assembly-agent',
  turnTimeoutMs: 30_000,
  authRecheckMs: 10_000,
  maxActiveConversations: 8,
  reasoningEffort: 'medium',
}

const access: Access = {
  mode: 'authenticated',
  ready: () => {},
  resolve: () => actor,
  assert: value => { if (value !== actor) throw new Error('无权访问') },
}

/** 装配一个被测运行时。`tools` 钩子的返回值是固定的那一份数组——② 要按**引用**比。 */
function fixture(agentId = AGENT_ID) {
  const host = fakeHost()
  const database = fakeDatabase(agentId)
  /** 每次调用记一条：`ctx` 一并记下，判据①要的就是"拿到的是装配 ctx"。 */
  const hookCalls: AgentToolContext[] = []
  const hookResult: readonly ToolDescriptor[] = [
    { name: 'assembly_demo', displayName: '装配用例工具', description: '装配用例用', parameters: {}, permission: '' },
  ]
  const definition: AgentDefinition = {
    id: agentId,
    displayName: '装配用例 Agent',
    description: '只用来验证装配链',
    persona: '你是一个装配用例。',
    config: {} as AgentDefinition['config'],
    tools: context => {
      hookCalls.push(context)
      return hookResult
    },
  }
  const storage: AgentStoragePort = { db: database.db, access }
  const assemble = () => createAgentRuntime({
    ctx: host.ctx,
    definition,
    access,
    config,
    allowedTools: () => ['assembly_demo'],
    storage,
  })
  return { host, database, hookCalls, hookResult, definition, storage, assemble }
}

/** 取一次同步抛错（同步面用 try/catch 断言，避免把"同步抛"写成"promise 拒绝"）。 */
function caught(run: () => unknown): { readonly status?: number } | undefined {
  try { run(); return undefined } catch (error) { return error as { readonly status?: number } }
}

// ---------------------------------------------------------------------------
// 判据①：definition.tools 真的被调用了一次（缺口判据）
// ---------------------------------------------------------------------------

describe('createAgentRuntime 的装配链', () => {
  it('definition.tools 在装配期被调用一次，并且拿到装配 ctx / 存储 / 无会话', async () => {
    const f = fixture()
    const assembly = await f.assemble()

    // ★ 判据①：删掉工厂里那次 `definition.tools(...)` 调用，这条立刻变红
    //   （钩子零调用点 ⇒ 业务工具一个都不会被注册，且不报错）。
    expect(f.hookCalls).toHaveLength(1)
    const call = f.hookCalls[0]
    // 收到的必须是**装配侧那一份** ctx：业务拿它 `ctx.effect(...)` 登记的东西要跟着装配释放。
    expect(call?.ctx).toBe(f.host.ctx)
    // 存储是装配好的门面（注入的那一份），不是自建的另一个连接。
    expect(call?.storage?.db).toBe(f.database.db)
    // 注册发生在装配期：那时还没有任何会话。
    expect(call?.conversationId).toBeUndefined()

    // ② 返回值就是钩子的返回值（同一份引用），装配侧据此 `registerPlugin({ tools })`。
    expect(assembly.tools).toBe(f.hookResult)
    expect(assembly.tools).toHaveLength(1)

    // 装配链的其余部分都拿到了同一个存储：会话端口由生命周期与侧栏入口共用一份。
    expect(assembly.db).toBe(f.database.db)
    expect(assembly.store).toBe(f.database.port)
    expect(assembly.runtime.store).toBe(assembly.store)
    // 侧栏入口的装配只发生一次（`conversationRemover` 的移除互斥是进程内的）。
    expect(assembly.provider.protocol).toBe(1)
    expect(assembly.provider.pluginId).toBe(AGENT_ID)
    // 运行时的两个监听都挂在装配 ctx 上：模型增量（participant 的）与标题（lifecycle 的）。
    //
    // ⚠️ **顺序与装配顺序同源，不是随意排的**：交活工具按会话注册，接线点要 participant 的
    // `handoffFor`，所以工厂改成"先造 participant、后造 lifecycle"——于是增量出口的订阅先挂、
    // 标题订阅后挂。**不要**把它当成降级成无序比较：这两个监听的注册顺序是装配顺序的直接
    // 可观测结果，写死顺序才能在有人调回去时变红（标题订阅晚于增量出口不影响行为，但那说明
    // 装配顺序变了，而那件事影响的是接线本身）。
    expect(f.host.listeners()).toEqual(['agent/assistant-stream', 'session/event'])
    expect(f.host.registeredEffects).toHaveLength(1)

    /**
     * ★ **交活工具的接线点在工厂里确实存在**（对应 `report_result` 那条"声明了却零接线"）。
     *
     * 为什么要单独断言它：删掉工厂里那几行，交付照样成功（走投影兜底），任何一条"结果对不对"
     * 的用例都不会红——所以只能直接看"线接上了没有"。
     *
     * 怎么读到它：`registerScopedTools` 住在 `ConversationLifecycle` 私有的 `host` 上，正常途径
     * 从外部看不见。这里**刻意**穿透读一次，而不是在假 ctx 上留一个探针位——探针位由工厂写、
     * 也由测试读，看着更"干净"，实测却会给出"写入成功但读回 `undefined`"的假象（本批踩过）。
     * 穿透读是唯一能真正区分"注入了"与"没注入"的写法。
     *
     * ★ **变异验证（本批实测）**：把工厂里那三行注释掉，这一条**变红**；而
     * `runtime-closure.test.ts` 的三条接线断言**仍然全绿**（它们的替身自己复刻了接线）。
     * 所以"装配那一环"只由这一条守住，别把它删了换成别处的间接证据。
     *
     * 运行期"注入了就会被调用、且按会话取账本、且不受 `restrict` 影响"由 `runtime-closure.test.ts`
     * 那三条覆盖（那里真的打开会话、真的跑 `setup`）。
     */
    const host = (assembly.lifecycle as unknown as { host: { registerScopedTools?: unknown } }).host
    expect(typeof host.registerScopedTools).toBe('function')
  })

  it('storage 与 database 二选一：两个都给、或都不给，都是装配错误', async () => {
    const f = fixture()
    const common = { ctx: f.host.ctx, definition: f.definition, access, config, allowedTools: () => [] }
    // 都不给：没有存储就没法服务（工具与投影拿不到业务状态），直接抛、不静默降级。
    // ⚠️ 两条都**不会**碰真 PG：自建路径还没走到 `createAgentDatabase` 就已经拒绝了。
    await expect(createAgentRuntime(common)).rejects.toThrow(/必须给 storage/)
    await expect(createAgentRuntime({ ...common, storage: f.storage, database: { dsn: 'postgres://unused', localPath: ':memory:' } }))
      .rejects.toThrow(/只能给一个/)
  })

  it('dispose 幂等：先停入口、再停会话、最后关存储，重复调用返回同一个 promise', async () => {
    const f = fixture()
    const assembly = await f.assemble()
    expect(assembly.lifecycle.stopped).toBe(false)
    expect(f.database.closes()).toBe(0)

    await assembly.dispose()

    // participant 真的被释放了：入口此后一律 503（`assertAccess` 是 run / reply 的第一道门）。
    expect(caught(() => assembly.participant.assertAccess(actor))).toMatchObject({ status: 503 })
    expect(assembly.lifecycle.stopped).toBe(true)
    expect(f.database.closes()).toBe(1)

    // 幂等：重复调用不抛、也不再关一次存储；两次拿到的是同一个 promise。
    const first = assembly.dispose()
    const second = assembly.dispose()
    expect(first).toBe(second)
    await expect(first).resolves.toBeUndefined()
    expect(f.database.closes()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 判据③：标题投递口真的被接上了（与 definition.tools 同源的"零接线"缺口）
// ---------------------------------------------------------------------------

/**
 * `installTitleSink` 此前全仓只有**定义与测试调用**、没有任何装配点：`registerConversationTitles`
 * 的回调投出去就消失，宿主标题永不落库，侧栏标题永久停在首句压缩值——不报错、完全静默。
 *
 * 下面两条用例分别钉住两件事：**线接上了**（删掉工厂里那次 `installTitleSink(...)` ⇒ 红），
 * 以及**模块级单槽没有互踩**（改回"直接装 `db.titleSink()`" ⇒ 同进程两个 Agent 时先装配那个的
 * 标题被顶掉 ⇒ 红）。
 */
describe('createAgentRuntime 接上标题投递口', () => {
  /** 造一条宿主的标题事件（形状照 `registerConversationTitles` 的判据：provider + 单条 messageSeqs）。 */
  const titleEvent = (title: string, source: { readonly kind: string }, messageSeqs: readonly number[] = [0]) => ({
    type: 'session/title',
    data: { title, messageSeqs: [...messageSeqs], source },
    time: Date.now(),
    seq: 1,
  })

  it('宿主标题经 TitleSink 投到存储端口的投递口（装配之后标题回调真的走通了）', async () => {
    const f = fixture()
    // 标题口是**进程级单槽**，同一个测试文件里前面的用例可能已经把它装上了（模块状态不随用例
    // 重置）。这里先显式清空，否则"这次装配到底有没有装它"就测不出来 —— 前一条用例留下的路由
    // 会替它装上，把缺口掩盖成绿灯。
    installTitleSink(undefined)
    const assembly = await f.assemble()
    const conversationId = 'assembly-agent-01234567-89ab-4cde-8fab-0123456789ab'
    // 装配期就装上了：标题回调是同步的，投递口必须在任何事件到达之前就在位。
    expect(f.database.titles).toHaveLength(0)

    f.host.emit('session/event', { id: conversationId }, titleEvent('车辆轨迹查询', { kind: 'provider' }))
    // ★ 判据：删掉工厂里那次 `installTitleSink(...)`，投递就进了模块级单槽的空值 ⇒ 静默丢弃，
    //   下面的断言必然红。
    expect(f.database.titles).toEqual([
      { agentId: AGENT_ID, conversationId, title: '车辆轨迹查询', source: 'generated' },
    ])

    // 手动改名走同一条路（`source.kind === 'user'` ⇒ `manual`），来源映射不能写反。
    f.host.emit('session/event', { id: conversationId }, titleEvent('我的车辆记录', { kind: 'user' }, []))
    expect(f.database.titles.at(-1)).toMatchObject({ title: '我的车辆记录', source: 'manual' })
    expect(f.database.titles).toHaveLength(2)

    await assembly.dispose()
  })

  it('调用方自带的标题投递口优先：投递只进注入的那一份，存储端口那一份一次都不收', async () => {
    const f = fixture('assembly-agent-own')
    installTitleSink(undefined)
    const delivered: { readonly title: string; readonly source: string }[] = []
    const assembly = await createAgentRuntime({
      ctx: f.host.ctx,
      definition: f.definition,
      access,
      config,
      allowedTools: () => ['assembly_demo'],
      storage: f.storage,
      /**
       * 业务自带投递口。
       *
       * 场景是真实的：blog 的 `chat.ts` 自己注册 `registerConversationTitles`，在回调里
       * ①写 `index.syncTitle`（落库）②给页面发 `changed`（通知）。此时运行时若还按存储端口
       * 另装一份，同一条标题会被**写两次**：第二次被"自动标题不覆盖手动标题"的守卫拒掉，
       * 业务那次判定的 `applied` 于是变成假 ⇒ **页面不刷新**，而两边都不报错。
       */
      titleSink: { submit: (_agentId, _conversationId, title, source) => { delivered.push({ title, source }) } },
    })
    const conversationId = 'assembly-agent-own-01234567-89ab-4cde-8fab-0123456789ab'
    f.host.emit('session/event', { id: conversationId }, titleEvent('自带投递口的标题', { kind: 'provider' }))

    expect(delivered).toEqual([{ title: '自带投递口的标题', source: 'generated' }])
    // ★ 判据（对应变异 M4）：把工厂里的 `input.titleSink ??` 去掉、恒用 `db.titleSink()`，
    //   投递就会落进存储端口那一份 ⇒ 下面这条必然红（而上面那条也会红）。
    expect(f.database.titles).toHaveLength(0)

    // 路由仍然按 `agentId` 分发：自带的那一份也要能被同进程的其它 Agent 分辨开
    // （槽位装的是 `titleRouter`，不是「最近一次装配的那一份」）。
    f.host.emit('session/event', { id: conversationId }, titleEvent('我的车辆记录', { kind: 'user' }, []))
    expect(delivered.at(-1)).toEqual({ title: '我的车辆记录', source: 'manual' })

    await assembly.dispose()
  })

  it('同进程两个 Agent：标题按 agentId 各归各的投递口，后装配的不会顶掉先装配的', async () => {
    const a = fixture('assembly-agent-a')
    const b = fixture('assembly-agent-b')
    // 同上：从空槽位开始，这样"装的是不是可分发的那一个"才由这两次装配决定。
    installTitleSink(undefined)
    const first = await a.assemble()
    const second = await b.assemble()
    const idOf = (agentId: string): string => `${agentId}-01234567-89ab-4cde-8fab-0123456789ab`

    // `installTitleSink` 是**模块级单槽**，而每个 Agent 的投递口只管自己 agentId 的会话。
    // 所以"直接装 `db.titleSink()`"会让 A 的标题落进 B 的投递口、被它按 agentId 丢掉（静默）。
    // ★ 判据：把工厂里的路由换成直接 `installTitleSink(sink)`，第一条断言必然红。
    a.host.emit('session/event', { id: idOf('assembly-agent-a') }, titleEvent('A 的标题', { kind: 'provider' }))
    expect(a.database.titles).toHaveLength(1)
    expect(b.database.titles).toHaveLength(0)

    // B 有自己的那条：两边都收得到，谁也不挡谁。
    b.host.emit('session/event', { id: idOf('assembly-agent-b') }, titleEvent('B 的标题', { kind: 'provider' }))
    expect(b.database.titles).toEqual([
      { agentId: 'assembly-agent-b', conversationId: idOf('assembly-agent-b'), title: 'B 的标题', source: 'generated' },
    ])
    expect(a.database.titles).toHaveLength(1)

    await first.dispose()
    await second.dispose()
  })

  /**
   * 判据：**运行时能力对象上不许有 `lifecycle`**。
   *
   * ## 这条判据的由来（两次生产事故，2026-09-18）
   *
   * `AgentRuntime.lifecycle` 曾经存在过，而且与 `createParticipant` 入参里的
   * `lifecycle: () => ConversationLifecycle` **同名不同形**（一个是实例、一个是取值器）。
   * 两次线上事故都出在这里：
   *
   * 1. 先是"装配期先占位、末尾再赋值"，依赖一条跨模块的对象同一性约定；约定被展开副本破坏后
   *    participant 读到 `undefined`，第一次真实回合炸成
   *    `TypeError: runtime.lifecycle is not a function`；
   * 2. 改成 getter 之后**报错一模一样**——因为真正的成因是**形状**（实例不是取值器），
   *    而当时那个 `as unknown as` 断言把类型检查关掉了。
   *
   * 两次都是"入口在、探针绿、一派活就炸"。修法不是再补一条更聪明的判据，而是**让错路不存在**：
   * 字段删掉、生命周期只从 `assembly.lifecycle` 出、participant 的入参收到只剩两样
   * （`ctx` 与取值器）。这条判据就是那个决定的守卫——字段一旦被加回来，它变红。
   *
   * 形状那一半（"入口真的能被调用"）由 `huiyu-dispatch-e2e.test.ts` 覆盖：真装配 + 真桥接 +
   * 真大总管真调一次，对本文件引入的旧实现实测变红。
   */
  it('运行时能力对象上不暴露 lifecycle：生命周期只从 assembly.lifecycle 出，形状不再有两种', async () => {
    const f = fixture()
    const assembly = await f.assemble()

    expect('lifecycle' in assembly.runtime, 'AgentRuntime 上不该再有 lifecycle —— 那正是两种形状的来源').toBe(false)
    // 生命周期本身照旧可用，只是出口唯一。
    expect(assembly.lifecycle).toBeDefined()
    for (const method of ['open', 'finish', 'assertConversation', 'events', 'followup'] as const) {
      expect(typeof (assembly.lifecycle as unknown as Record<string, unknown>)[method], `lifecycle.${method} 应是函数`).toBe('function')
    }

    await assembly.dispose()
  })
})
