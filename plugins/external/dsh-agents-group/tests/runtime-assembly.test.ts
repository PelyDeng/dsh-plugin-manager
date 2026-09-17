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
import type { RuntimeConfig } from '../packages/runtime/src/conversation.ts'
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
  return { ctx, registeredEffects, listeners: () => [...byEvent.keys()] }
}

/** 内存存储门面：会话走替身，其余面是最小实现。 */
function fakeDatabase(agentId: string) {
  const port = new MemoryConversationPort(agentId)
  let closes = 0
  const turns: TurnStorePort = {
    claim: async () => 'claimed',
    finish: async () => {},
    turnStatus: async () => undefined,
    pendingQuestion: async () => undefined,
    setPendingQuestion: async () => {},
  }
  const db = {
    assertSchema: async () => {},
    conversations: port,
    turns,
    query: async () => [],
    transaction: async (fn: (tx: AgentDatabasePort) => Promise<unknown>) => fn(db as unknown as AgentDatabasePort),
    close: async () => { closes += 1 },
  } as unknown as AgentDatabasePort
  return { db, port, closes: () => closes }
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
function fixture() {
  const host = fakeHost()
  const database = fakeDatabase(AGENT_ID)
  /** 每次调用记一条：`ctx` 一并记下，判据①要的就是"拿到的是装配 ctx"。 */
  const hookCalls: AgentToolContext[] = []
  const hookResult: readonly ToolDescriptor[] = [
    { name: 'assembly_demo', displayName: '装配用例工具', description: '装配用例用', parameters: {}, permission: '' },
  ]
  const definition: AgentDefinition = {
    id: AGENT_ID,
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
    expect(assembly.lifecycle).toBe(assembly.runtime.lifecycle)
    expect(assembly.runtime.store).toBe(assembly.store)
    // 侧栏入口的装配只发生一次（`conversationRemover` 的移除互斥是进程内的）。
    expect(assembly.provider.protocol).toBe(1)
    expect(assembly.provider.pluginId).toBe(AGENT_ID)
    // 运行时的两个监听都挂在装配 ctx 上：标题（生命周期的）与模型增量（入口的）。
    expect(f.host.listeners()).toEqual(['session/event', 'agent/assistant-stream'])
    expect(f.host.registeredEffects).toHaveLength(1)
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
