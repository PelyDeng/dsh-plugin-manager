/**
 * 同一 mission 的会话唯一性 —— **创建途中**（还没发布、还被 gate 住）也必须成立。
 *
 * ## 这个文件补的是哪条缝
 *
 * `runtime-minimal-agent.test.ts` 已经钉住"同一 mission 两次派活落在同一条会话里"，但那几条
 * 都是**等创建走完之后**才断言 `port.size`。实测到一个空档：**创建仍在进行时**（`ctx.agents.create`
 * 还没返回），存储里已经有一行 `ready = false` 的预留行，而它**没有出现在 `busyIds()` 里**。
 *
 * `busyIds()` 是侧栏移除围栏的一部分（`conversationRemover` 的 `busy(id)`），
 * 而它由 `isBusy()` 过滤：
 *
 * ```
 * isBusy(id) = conversations.get(id)?.active === true || openings.has(id) || forks.has(id)
 * ```
 *
 * 派生寻址**不走 `openings`**：`openByMission` 把在飞的 promise 记在**另一张表 `missionOpenings`**
 * （键是 missionKey，不是会话 id，见 `conversation.ts` 的注释），而 `busyIds()` **没有并上它**。
 * ⇒ 一条"正在创建"的派生会话对移除围栏是**不可见**的：用户可以在它创建途中把它移掉。
 *
 * ## 为什么用 `blog` 这个 agentId
 *
 * 报送的现象是"一次派活之后存储里有两条 `blog-chat-*` 会话"，而 `blog` 正是
 * `CONVERSATION_PREFIX` 里映射到 `blog-chat-` 的那一个（`conversation.ts:50-54`），
 * 也是唯一声明 `conversationAddressing: 'derived'` 的 Agent。用同一个 id 才能逐字复现现象里
 * 的可见形状（前缀、派生路径）。
 *
 * ## 只读诊断得出的调用链（一次 `lifecycle.open` = 几次 `store.create`）
 *
 * | 入口 | `store.create` 次数 | requestId | 铸点 |
 * | --- | --- | --- | --- |
 * | 派生寻址（`missionKey !== undefined`） | **1**（`reserveMissionRow`） | `missionRequestId(owner, missionId)` | `reserveMissionRow` 内 |
 * | 无 missionId / 非 derived | **1**（`open` 的预留段） | `''` | `open` 内 |
 * | `fork` | 1 | `''` | `fork` 内 |
 *
 * `participant.run()` **只调一次** `lifecycle.open`（`participant.ts:237`）⇒ 单次 `run()` 不可能
 * 凭空产生两行。两行必须来自**两次不同 requestId 的 create**（派生键一条 + `''` 一条）。
 * 本文件把这个不变量钉在"一次 open 只能落一行"上。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it } from 'vitest'
import { ConversationLifecycle, type RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import type { AgentDefinition } from '../packages/runtime/src/definition.ts'
import type { ConversationPort } from '../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'

/** 与报送现象同一形状：`CONVERSATION_PREFIX['blog'] === 'blog-chat-'`。 */
const AGENT_ID = 'blog'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-chat' }

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return
    await tick()
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 精简假宿主：只够 `ConversationLifecycle` 走完"预留 → 创建 → 发布"。
 * 与 `runtime-reply-e2e.test.ts` 的 `runtimeHost` 同源做法，但**只保留本文件要用的面**。
 */
function missionHost(conversationAddressing?: 'derived' | 'per-dispatch') {
  const byEvent = new Map<string, Set<(...args: unknown[]) => void>>()
  const sessions = new Map<string, { id: string; events: SessionEvent[]; agent: Agent }>()
  /** 被 gate 住的创建：测试自己决定何时放行。 */
  const pendingCreates: (() => void)[] = []
  /** 每次 `agents.create` 拿到的会话 id —— 它就**是**会话 id（`SessionId(id)`），公开可得。 */
  const createdIds: string[] = []
  let gated = false
  let createCalls = 0
  let resumedCalls = 0
  let seq = 0

  const sessionOf = (id: string) => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [] as SessionEvent[] } as { id: string; events: SessionEvent[]; agent: Agent }
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: () => { seq += 1 },
      whenIdle: async () => {},
      cancel: () => {},
    } as unknown as Agent
    sessions.set(id, session)
    return session
  }

  const agents = {
    create: async (input: { readonly sessionId: unknown }) => {
      createCalls += 1
      createdIds.push(String(input.sessionId))
      if (gated) await new Promise<void>(resolve => { pendingCreates.push(resolve) })
      const session = sessionOf(String(input.sessionId))
      return { agent: session.agent, dispose: async () => {} }
    },
    resume: async (input: { readonly resumeSessionId: unknown }) => {
      resumedCalls += 1
      const session = sessionOf(String(input.resumeSessionId))
      return { agent: session.agent, dispose: async () => {} }
    },
    list: () => [],
    get: () => undefined,
  }

  const llm = {
    resolveCallConfig: async (value: unknown) => value,
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'medium' }] } }),
  }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ ...DEFAULT_MODEL }) },
    sessionController: {
      modelCatalog: async () => ({
        groups: [{ id: DEFAULT_MODEL.provider, name: 'DeepSeek', models: [{ id: DEFAULT_MODEL.model, name: 'DeepSeek Chat' }] }],
        failures: [], selected: { ...DEFAULT_MODEL },
      }),
      selectModel: async (input: { readonly provider: string; readonly model: string }) => ({ selected: { provider: input.provider, model: input.model } }),
    },
    llm,
    sessionPersistence: { inspect: async (id: string) => ({ events: sessions.get(id)?.events ?? [], header: { id } }) },
    sessionProjections: { restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { ...DEFAULT_MODEL } } } } }) },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    agents,
  }
  const ctx = {
    effect: (effect: () => () => Promise<void> | void) => { void effect() },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const group = byEvent.get(name) ?? new Set<(...args: unknown[]) => void>()
      group.add(listener); byEvent.set(name, group)
      return () => { group.delete(listener) }
    },
    get: (name: string) => services[name],
    llm,
    agents,
    root: { emit: () => {} },
  } as unknown as Context

  const access: Access = {
    mode: 'authenticated', ready: () => {}, resolve: () => actor,
    assert: value => { if (value !== actor) throw new AccessError(403, '无权访问') },
  }
  /**
   * ⚠️ 保留**具体类型**的引用：`size` 与 `rawOf` 是内存实现的检视面，**不在 `ConversationPort` 契约里**
   * （端口只承诺行为，不承诺让你数行）。断言要用它们，就得拿具体实例，别把它们加进端口类型。
   */
  const memory = new MemoryConversationPort(AGENT_ID)
  const port: ConversationPort = memory
  const definition = {
    id: AGENT_ID,
    displayName: '唯一性验收 Agent',
    description: '验收用：派生寻址',
    persona: '你只回答一句话。',
    tools: () => [],
    config: {},
    ...(conversationAddressing === undefined ? {} : { conversationAddressing }),
  } as unknown as AgentDefinition
  const config: RuntimeConfig = {
    routePrefix: '/mission-uniq', turnTimeoutMs: 30_000, authRecheckMs: 10_000,
    maxActiveConversations: 8, reasoningEffort: 'medium',
  }
  const lifecycle = new ConversationLifecycle({ ctx, definition, access, store: port, config, allowedTools: () => [] })

  return {
    port: memory, lifecycle,
    /** gate 住接下来的 `agents.create`（模拟"创建还没返回"）。 */
    gate: () => { gated = true },
    release: () => { gated = false; for (const resolve of pendingCreates.splice(0)) resolve() },
    /** 有没有真的走到 `agents.create`（而不是卡在更早的地方）。 */
    enteredCreate: () => createCalls > 0,
    createCalls: () => createCalls,
    resumedCalls: () => resumedCalls,
    /** 每次 `agents.create` 拿到的会话 id（会话 id 就是它）。 */
    createdIds: () => [...createdIds],
    busyIds: () => [...lifecycle.busyIds()],
    size: () => memory.size,
    raw: (id: string) => memory.rawOf(id),
  }
}

describe('同一 mission 的会话唯一性（创建途中也必须成立）', () => {
  it('派生派活在**创建途中**只落一行，释放后仍是同一行', async () => {
    const f = missionHost('derived')
    f.gate()
    const pending = f.lifecycle.open(undefined, true, actor, 'mission-A')
    await until(() => f.enteredCreate(), '创建进入 agents.create')
    // 被测：创建还没返回时，存储里**只能有一行**（预留段只写一行）。
    expect(f.size()).toBe(1)
    expect(f.createdIds()).toHaveLength(1)
    f.release()
    const conversation = await pending
    expect(conversation?.id).toMatch(/^blog-chat-/)
    expect(conversation?.id).toBe(f.createdIds()[0])
    expect(f.size()).toBe(1)
    expect(f.createCalls()).toBe(1)
  })

  it('⚠️ 创建途中的派生会话必须出现在 busyIds 里（移除围栏要看得见它）', async () => {
    const f = missionHost('derived')
    f.gate()
    const pending = f.lifecycle.open(undefined, true, actor, 'mission-A')
    await until(() => f.enteredCreate(), '创建进入 agents.create')
    // 存储里那一行此刻是 `ready = false` 的预留行，而它**正在被创建** ⇒ 移除围栏必须看得见它，
    // 否则用户能在创建途中把它移掉（移除与创建会各写一次同一行）。
    const id = f.createdIds()[0]
    expect(id).toMatch(/^blog-chat-/)
    expect(f.busyIds()).toContain(id)
    f.release()
    await pending
    /**
     * ⚠️ **清理必须在 `finally`**：那个"铸出即登记"的 id 若在创建走完之后还留在表里，这条会话就
     * **永远显示为忙** ⇒ 移除围栏一直 409、侧栏永远不给"可移除"。
     * 本条钉的就是那次清理（把 `reserveMissionRow` 的 `finally` 去掉 ⇒ 本条变红）。
     */
    expect(f.busyIds()).not.toContain(id)
  })

  it('同一 mission 第二次派活复用同一行，不建第二条', async () => {
    const f = missionHost('derived')
    const first = await f.lifecycle.open(undefined, true, actor, 'mission-A')
    expect(first?.id).toMatch(/^blog-chat-/)
    const second = await f.lifecycle.open(undefined, true, actor, 'mission-A')
    expect(second?.id).toBe(first?.id)
    expect(f.size()).toBe(1)
    // 第二次是**句柄复用**（本实例已经在用这条会话），不该再 resume 一个 Agent 实例。
    expect(f.createCalls()).toBe(1)
    expect(f.resumedCalls()).toBe(0)
  })

  it('并发打开同一 mission 合并成一次 create', async () => {
    const f = missionHost('derived')
    const [left, right] = await Promise.all([
      f.lifecycle.open(undefined, true, actor, 'mission-race'),
      f.lifecycle.open(undefined, true, actor, 'mission-race'),
    ])
    expect(left?.id).toBe(right?.id)
    expect(f.size()).toBe(1)
    expect(f.createCalls()).toBe(1)
  })

  it('没有 missionId 时不派生：两次派活各建一条（既有口径，防被"唯一化"改坏）', async () => {
    const f = missionHost('derived')
    const first = await f.lifecycle.open(undefined, true, actor)
    const second = await f.lifecycle.open(undefined, true, actor)
    expect(first?.id).not.toBe(second?.id)
    expect(f.size()).toBe(2)
  })

  /**
   * **差分对照（证明上一条断言不是空断言）**：同一条断言、同一个 `busyIds()`，
   * 换成**非派生**路径（`requestId = ''`）就**看得见**了——因为它走 `openings`。
   *
   * 这条同时把缺陷的边界钉死：不是"创建途中的会话都看不见"，而是**只有派生寻址那条路**看不见
   * （`openByMission` 把在飞 promise 记在 `missionOpenings`，那张表 `busyIds` 没并）。
   */
  it('对照：非派生的创建途中，busyIds 里看得见它（走 openings）', async () => {
    const f = missionHost('derived')
    f.gate()
    const pending = f.lifecycle.open(undefined, true, actor)
    await until(() => f.enteredCreate(), '创建进入 agents.create')
    const id = f.createdIds()[0]
    expect(id).toMatch(/^blog-chat-/)
    expect(f.busyIds()).toContain(id)
    f.release()
    await pending
  })

  /**
   * **"两条会话"到底怎么来的**：唯一性是按 `requestId` 成立的，不是按 mission 全局成立的。
   * ⇒ 两条 `blog-chat-*` 必须来自**两次 requestId 不同**的 `create`：
   * 派生键一条（`missionRequestId`）+ 非派生 `''` 一条（页面侧那条路）。
   *
   * 这条用例把报送现象的**成立条件**写成可执行的判据——它**不是**"一次派生派活建了两条"。
   */
  it('两条会话的成立条件：派生键一行 + 非派生空 requestId 一行', async () => {
    const f = missionHost('derived')
    const derived = await f.lifecycle.open(undefined, true, actor, 'mission-A')
    const pageSide = await f.lifecycle.open(undefined, true, actor)
    expect(derived?.id).not.toBe(pageSide?.id)
    expect(f.size()).toBe(2)
    // 两行的来历：一行键是 mission 的纯函数，一行键是空串。
    const key = f.port.missionRequestId({ namespace: actor.namespace, userId: actor.userId }, 'mission-A')
    expect(f.raw(derived?.id ?? '')?.requestId).toBe(key)
    expect(f.raw(pageSide?.id ?? '')?.requestId).toBe('')
  })
})
