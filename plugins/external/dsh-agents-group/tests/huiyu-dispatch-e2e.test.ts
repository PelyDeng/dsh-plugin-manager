/**
 * 绘语被牛马大总管**真的调用一次**的判据（就绪分支）。
 *
 * ## 为什么单独写这个文件
 *
 * `member-chain.test.ts` 核的是"绘语的目录条目与执行入口都在"——但它**从不调用**那个入口，
 * 而 2026-09-18 的实测缺陷（`runtime.lifecycle is not a function`）恰恰是"入口在、探针全绿、
 * 一派活整轮就炸"：入口是对象里的一个字段，字段在不在与它能不能用是两件事。
 *
 * 所以这里把绘语的执行入口**真调一次**，链路尽量用产品代码：
 *
 * | 环节 | 本文件用的是 |
 * | --- | --- |
 * | 智能体定义 | 绘语真实的 `createHuiyuDefinition`（人设、八个工具的目录条目、结果投影） |
 * | 工具注册 | 绘语真实的 `registerHuiyuTools`（分类标签由群组口径注入） |
 * | 运行时装配 | 共享运行时真实的 `createAgentRuntime`（不是手工拼 runtime 对象 —— `lifecycle` 必须是真 getter） |
 * | 桥接 | 群组真实的 `executorFor` |
 * | 调度方 | 牛马大总管真实的 `ButlerConsole` |
 *
 * 只有两端宿主是替身（假的会话宿主、内存存储端口、SQLite 任务库），它们不是被测对象。
 *
 * ## 这个替身宿主**不装配人设段**（与 `runtime-reply-e2e.test.ts` 同款）
 *
 * `agents.create` 只回一个会话句柄、不回 agent 作用域，所以交活工具（`report_result`）没有接线，
 * `ledger.available` 为假 —— 这正好让本用例走**投影兜底**那条路：没有交活工具时，结论由绘语自己的
 * `projectResult` 从会话正文里收（那正是本文件要核的东西）。
 * 人设段与工具限制的装配覆盖在 `runtime-closure.test.ts` 与 `visibility.test.ts`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it } from 'vitest'
import { ButlerConsole } from '../../dsh-butler-console/src/butler.ts'
import type { Config } from '../../dsh-butler-console/src/config.ts'
import { SqliteButlerStorage, TaskStore } from '../../dsh-butler-console/tests/helpers/sqlite-test-store.ts'
import { AGENT_MANIFESTS } from '../src/agents/registry.ts'
import { executorFor } from '../src/butler-bridge.ts'
import { createHuiyuDefinition, type HuiyuDefinitionInput } from '../agents/huiyu/src/definition.ts'
import { HUIYU_TOOL_NAMES, registerHuiyuTools } from '../agents/huiyu/src/tools/index.ts'
import type { HuiyuToolContext } from '../agents/huiyu/src/tools/context.ts'
import type { HuiyuEnvironment } from '../agents/huiyu/src/env.ts'
import type { ImageGenerationProvider } from '../agents/huiyu/src/image/index.ts'
import type { RuntimeConfig } from '../packages/runtime/src/conversation.ts'
import { createAgentRuntime } from '../packages/runtime/src/runtime.ts'
import type {
  AgentDatabasePort,
  AgentStoragePort,
  ConversationPort,
  TurnStorePort,
} from '../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from './fixtures/memory-conversation-port.ts'

const HUIYU = 'huiyu'
/** 工具分类标签：生产由群组从清单注入（`manifest.category`）。 */
const TOOL_CATEGORY = '图片与视觉'
const ACTOR: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const BUTLER_CONVERSATION = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-chat' }
/** 生图工具交回的那类正文：地址原样出现在结论里是本用例要断的东西。 */
const IMAGE_URL = 'https://img.pelycloud.com/huiyu/2026/09/18/1789703840622.png'

const huiyuManifest = AGENT_MANIFESTS.find(item => item.id === HUIYU)
if (huiyuManifest === undefined) throw new Error(`清单里没有 ${HUIYU}：本文件的前提是它已随包发布`)

const sleep = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await sleep()
  }
  throw new Error(`等待超时：${label}`)
}

// ---------------------------------------------------------------------------
// 假宿主：一轮回合真正会读到的服务面
// ---------------------------------------------------------------------------

function fakeHost() {
  const byEvent = new Map<string, Set<(...args: unknown[]) => void>>()
  const sessions = new Map<string, { id: string; events: SessionEvent[]; agent: Agent }>()
  const followups: { readonly id: string; readonly text: string }[] = []
  const openedIds: string[] = []
  /** 注册进宿主的工具（`ctx.tools.register` 的实参），按名字断言。 */
  const registeredTools: { readonly name?: unknown }[] = []
  let seq = 0

  const sessionOf = (id: string) => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const session = { id, events: [] as SessionEvent[] } as { id: string; events: SessionEvent[]; agent: Agent }
    session.agent = {
      id,
      session: { id, snapshotEvents: () => session.events },
      followup: (message: unknown) => {
        followups.push({ id, text: (message as { content?: readonly { text?: string }[] }).content?.[0]?.text ?? '' })
        seq += 1
        session.events.push({ type: 'user/message', data: message, time: Date.now(), seq } as unknown as SessionEvent)
      },
      whenIdle: async () => {},
      cancel: () => {},
    } as unknown as Agent
    sessions.set(id, session)
    return session
  }
  const emit = (type: string, data: unknown, conversationId: string): void => {
    const session = sessionOf(conversationId)
    seq += 1
    const value = { type, data, time: Date.now(), seq } as unknown as SessionEvent
    session.events.push(value)
    for (const listener of [...(byEvent.get('session/event') ?? [])]) listener({ id: conversationId }, value)
  }

  const agents = {
    create: async (input: { readonly sessionId: unknown }) => {
      const session = sessionOf(String(input.sessionId))
      openedIds.push(session.id)
      return { agent: session.agent, dispose: async () => {} }
    },
    resume: async (input: { readonly resumeSessionId: unknown }) => {
      const session = sessionOf(String(input.resumeSessionId))
      openedIds.push(session.id)
      return { agent: session.agent, dispose: async () => {} }
    },
    list: () => [],
    get: () => undefined,
  }
  const llm = { resolveCallConfig: async (value: unknown) => value, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'medium' }] } }) }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ ...DEFAULT_MODEL }) },
    sessionController: {
      modelCatalog: async () => ({ groups: [{ id: DEFAULT_MODEL.provider, name: 'DeepSeek', models: [{ id: DEFAULT_MODEL.model, name: 'DeepSeek Chat' }] }], failures: [], selected: { ...DEFAULT_MODEL } }),
      selectModel: async (input: { readonly provider: string; readonly model: string }) => ({ selected: { provider: input.provider, model: input.model } }),
    },
    llm,
    sessionPersistence: { inspect: async (id: string) => ({ events: sessions.get(id)?.events ?? [], header: { id } }) },
    sessionProjections: { restore: () => ({ checkpoint: { modelSelection: { val: { pending: null, lastUsed: { ...DEFAULT_MODEL } } } } }) },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    agents,
  }
  const tools = { register: (tool: { readonly name?: unknown }) => { registeredTools.push(tool); return () => {} }, restrict: () => () => {} }
  const ctx = {
    // 立即执行：注册与订阅都发生在工厂回调里，丢掉返回值只影响"卸载"这条本用例不走的路径。
    effect: (effect: () => unknown) => { void effect(); return () => {} },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const group = byEvent.get(name) ?? new Set<(...args: unknown[]) => void>()
      group.add(listener); byEvent.set(name, group)
      return () => { group.delete(listener) }
    },
    get: (name: string) => services[name],
    llm,
    agents,
    tools,
    webServer: { register: () => () => {} },
    root: { emit: () => {} },
  } as unknown as Context

  return {
    ctx,
    registeredTools,
    followups: () => followups,
    lastConversation: () => openedIds[openedIds.length - 1] ?? '',
    /** 造一轮完整的回合：开始 → 助手正文 → 结束（参与者据此收尾并投影）。 */
    complete: (conversationId: string, text: string, reason = 'completed') => {
      emit('turn/start', { turn: 1 }, conversationId)
      emit('assistant/message', { message: { content: [{ type: 'text', text }] }, step: 0 }, conversationId)
      emit('turn/end', { reason: { kind: reason } }, conversationId)
    },
  }
}

// ---------------------------------------------------------------------------
// 存储端口替身（会话 / 轮次 / 待答问题），事务直接用它自己
// ---------------------------------------------------------------------------

function fakeStorage(agentId: string, questions: Map<string, string>) {
  const port: ConversationPort = new MemoryConversationPort(agentId)
  const turns: TurnStorePort = {
    claim: async () => 'claimed',
    finish: async () => {},
    turnStatus: async () => undefined,
    turnId: async () => undefined,
    appendTurnResult: async () => '',
    turnResults: async () => [],
    // 本用例用不到的端口增量**故意抛**：静默返回空值会把"线接到了这里"伪装成成功。
    turnById: async () => { throw new Error('本用例的替身不实现 turnById') },
    turnsOf: async () => { throw new Error('本用例的替身不实现 turnsOf') },
    turnResultsOf: async () => { throw new Error('本用例的替身不实现 turnResultsOf') },
    turnsByOperationId: async () => { throw new Error('本用例的替身不实现 turnsByOperationId') },
    patchTurnPayload: async () => { throw new Error('本用例的替身不实现 patchTurnPayload') },
    pendingQuestion: async (owner, conversationId) => questions.get(`${owner.namespace}:${owner.userId}:${conversationId}`),
    setPendingQuestion: async (owner, conversationId, question) => {
      const key = `${owner.namespace}:${owner.userId}:${conversationId}`
      if (question === undefined) questions.delete(key)
      else questions.set(key, question)
    },
  }
  const db = {
    assertSchema: async () => {},
    conversations: port,
    turns,
    query: async () => [],
    transaction: async (fn: (tx: AgentDatabasePort) => Promise<unknown>) => fn(db as unknown as AgentDatabasePort),
    close: async () => {},
  } as unknown as AgentDatabasePort
  const storage: AgentStoragePort = { db, access: { mode: 'authenticated' } as unknown as Access }
  return { storage, db }
}

const RUNTIME_CONFIG: RuntimeConfig = {
  routePrefix: '/agents/huiyu',
  turnTimeoutMs: 30_000,
  authRecheckMs: 10_000,
  maxActiveConversations: 4,
  // 空串＝不在运行时这一层插一脚，按会话选模型（与生产同一口径）。
  reasoningEffort: '',
}

/**
 * 走一遍**真实的装配**：绘语的定义 + 真实的 `createAgentRuntime`（存储注入内存替身）。
 *
 * 工具用 `registerHuiyuTools` 真注册一次，返回的目录条目原样交给定义 —— 与 `src/index.ts`
 * 里那条装配路径同形，所以"定义交回的条目"与"真正注册的工具"在这里也是同一份。
 */
async function assembleHuiyu() {
  const host = fakeHost()
  const questions = new Map<string, string>()
  const { storage } = fakeStorage(HUIYU, questions)

  /**
   * 工具装配上下文：本用例只**注册**工具、不调用它们，所以涉及网络与存储的三项用占位。
   * 注册期真正会被读到的只有 `ctx`（`createPluginTools` 拿它 `effect` + `tools.register`）。
   */
  const toolContext = {
    ctx: host.ctx,
    environment: {} as HuiyuEnvironment,
    minio: undefined,
    imageProvider: {} as ImageGenerationProvider,
    store: undefined,
    attachments: () => { throw new Error('本用例不读附件') },
  } satisfies HuiyuToolContext
  const toolCategory = TOOL_CATEGORY
  const registered = registerHuiyuTools(toolContext, toolCategory, `${HUIYU}:access`)

  const definition = createHuiyuDefinition({
    category: toolCategory,
    permission: `${HUIYU}:access`,
    tools: toolContext,
    registered,
  } satisfies HuiyuDefinitionInput)

  const access: Access = {
    mode: 'authenticated',
    ready: () => {},
    resolve: () => ACTOR,
    assert: value => { if (value !== ACTOR) throw new AccessError(403, '无权访问') },
  }
  const assembly = await createAgentRuntime({
    ctx: host.ctx,
    definition,
    access,
    config: RUNTIME_CONFIG,
    // 群组算出来的可见工具：本分类的八个 + 通用集。这里按同一规则现算一次。
    allowedTools: () => [...HUIYU_TOOL_NAMES, 'common_weather'],
    storage,
  })
  return { host, assembly, registered, questions }
}

/** 牛马大总管：执行入口与目录条目都从真装配收（与 `member-chain.test.ts` 同一套最小面）。 */
function butlerFixture(executor: ReturnType<typeof executorFor>) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => ACTOR, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 20_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const ctx = {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') {
          accept({ protocol: 1, plugin: {
            id: HUIYU, packageName: 'dsh-agents-group', version: '0.0.0', displayName: '绘语',
            description: huiyuManifest!.description, entryPath: '/agents/huiyu', permissions: [`${HUIYU}:access`],
            tools: [], category: 'agents',
          } })
        }
      },
    },
  } as unknown as Context
  const console_ = new ButlerConsole(ctx, config, access, new SqliteButlerStorage(store), '')
  store.reserveConversation(BUTLER_CONVERSATION, ACTOR)
  return { store, console_ }
}

describe('绘语被牛马大总管派活：真执行入口 + 真装配 + 真桥接', () => {
  it('派给绘语的子任务真的跑完一轮，结论带图地址回到大总管的账上', async () => {
    const { host, assembly, registered } = await assembleHuiyu()
    const { store, console_ } = butlerFixture(executorFor(huiyuManifest!, assembly.participant))

    try {
      // 前置断言：装配出来的是"绘语"，八件工具一件不少，且分类就是群组注入的那个。
      expect(assembly.participant.id).toBe(HUIYU)
      expect(registered.map(tool => tool.name).sort()).toEqual([...HUIYU_TOOL_NAMES].sort())
      expect(registered.every(tool => tool.category === TOOL_CATEGORY)).toBe(true)
      expect(host.registeredTools.map(tool => tool.name).sort()).toEqual([...HUIYU_TOOL_NAMES].sort())

      const goal = '给这篇文章生成一张海边日落的头图'
      store.createTask({
        id: 'task-1', conversationId: BUTLER_CONVERSATION, actor: ACTOR, goal, note: '',
        subtasks: [{ id: 's1', goal, agentId: HUIYU, reason: '只有它会生图' }],
      })
      const dispatchSubtask = (console_ as unknown as {
        dispatchSubtask(value: unknown): AsyncGenerator<unknown, unknown>
      }).dispatchSubtask.bind(console_)

      const dispatched: unknown[] = []
      const dispatching = (async () => {
        for await (const event of dispatchSubtask({
          taskId: 'task-1', subtaskId: 's1', goal, agentId: HUIYU, displayName: '绘语',
          taskGoal: '给文章配图', actor: ACTOR, signal: new AbortController().signal,
        })) dispatched.push(event)
      })()

      // ① 派活真的把活交到了绘语的会话里（简报原样过去，不是空消息）。
      await until(() => host.followups().length >= 1, '绘语接单')
      const conversationId = host.lastConversation()
      expect(host.followups()[0]?.text).toContain(goal)

      // ② 一轮回合：模型答出图地址 → 收尾 → 绘语的 `projectResult` 收成结论。
      host.complete(conversationId, `图生成好了，地址：${IMAGE_URL}`)
      await dispatching

      // ③ 结论过大总管那一跳之后仍然成立。
      const subtask = store.task(ACTOR, 'task-1')?.subtasks[0]
      expect(subtask?.state).toBe('succeeded')
      expect(subtask?.result).toContain(IMAGE_URL)
      // 原会话引用一起回传：大总管的卡片据此能点回绘语那一轮。
      expect(store.task(ACTOR, 'task-1')?.subtasks[0]?.conversationId).toBe(conversationId)
      expect(dispatched.some(event => (event as { state?: string }).state === 'succeeded')).toBe(true)
    } finally {
      await assembly.dispose()
      store.close()
    }
  })
})
