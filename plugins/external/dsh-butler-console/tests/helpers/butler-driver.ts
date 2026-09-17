/**
 * 驱动牛马大总管跑完「派活 → 子任务 → 汇总轮 → 裁决 → 落终态」的可复用夹具。
 *
 * ## 为什么需要它（以及一条被误传了三批的"夹具根因"）
 *
 * 三批判据被降级成"只有静态保证"，理由都记成"夹具驱动不起来主路径"。**实测不成立**：
 * `tests/external-pending.test.ts:50-105` 早就在驱动完整主路径（含汇总轮）。真实原因是
 * **使用方式**，不是夹具缺失：
 *
 * 1. **`planTool.execute()` 不派单。** 它只做校验并把计划推进 `turn.plans`（`src/butler.ts`
 *    的 `planTool`），派单发生在 `turnBody` 的第二段（`for await … dispatchSubtask`）。
 *    所以"派单抛错会让 `planTool.execute` 挂住"这个说法把两个环节混为一谈 —— `execute`
 *    根本没有派单这一步，它是个普通的 `async` 函数（不是 generator）。
 * 2. **每一轮收尾都要模型再响应一次。** `settleTask` 在有观众时先 `setTaskState('summarizing')`
 *    再跑 `summarize(...)`，而 `summarize` 等的是模型（`followup` + `turn/end`）。更要紧的是
 *    `rework`/`replace` 会走 `applyReworkAttempts` **再收尾一次**（递归 `settleTask`）⇒ 又要
 *    一轮模型响应。**只驱动一次的实现会在第二/第三轮等不到终态**，表现像"夹具坏了"。
 *
 * 所以本夹具只做一件额外的事：**按需驱动任意多轮** —— 循环观察任务状态，只要还在
 * `running` / `summarizing` 就继续（汇总轮按调用方给的 `onSummarize` 决定要不要调工具，
 * 例如调 `butler_verdict`），直到落终态或超过轮数上限。**超上限时抛可读错误，绝不挂到
 * vitest 的 `testTimeout`** —— 后者会把"机制问题"伪装成"跑得慢"（本仓踩过多次）。
 *
 * ## 它能驱动到哪一步、不能驱动什么
 *
 * 能：派活轮（`butler_plan`）· 子任务派发（真的走 `dispatchSubtask` → 执行方 → 落库）·
 * 汇总轮（含 `butler_verdict` 裁决）· `rework`/`replace` 的追加尝试与**再次收尾** ·
 * 任务落终态。等待超时路径（`expireWaiting`）**不在**这里 —— 它需要真定时器，见
 * `dependency-recheck.test.ts` / `reply-close.test.ts` 的既有写法。
 *
 * 不能：真模型（`agent.followup` 是 `vi.fn()`，汇总正文由 `summarize` 的兜底或事件流给出）·
 * 真 PG（用 `SqliteButlerStorage` 替身）· 真 HTTP/SSE（那是 `web-*` 套件的事）。
 */
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../../src/butler.ts'
import type { Config } from '../../src/config.ts'
import type { ButlerAgentExecutor } from '../../src/protocol.ts'
import { SqliteButlerStorage, TaskStore } from './sqlite-test-store.ts'

/** 一次"模型被调用"最多等多少个微任务轮次（配合 `until` 的上限一起兜底）。 */
const TICK_LIMIT = 500
/** 驱动到终态时最多处理几轮收尾。正常路径 1 轮、`rework` 后 2 轮；给足余量。 */
const ROUND_LIMIT = 8

export interface ButlerTool {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** 交给 `butler_plan` 的一次计划（就是模型会给的那份形状）。 */
export interface PlanInput {
  readonly reply?: string
  readonly note?: string
  readonly acceptance?: string
  readonly subtasks: readonly {
    readonly goal: string
    readonly agentId: string
    readonly reason?: string
    readonly acceptance?: string
    readonly logicalId?: string
    readonly supersedes?: string
    readonly dependsOn?: readonly string[]
  }[]
}

export interface DriveOptions {
  readonly executor: ButlerAgentExecutor
  readonly actor?: Actor
  readonly conversationId?: string
  /** 老板说的那句话（会成为任务目标）。 */
  readonly message?: string
  readonly config?: Partial<Config>
}

export interface Driver {
  readonly console_: ButlerConsole
  readonly store: TaskStore
  readonly actor: Actor
  readonly conversationId: string
  /** 按注册名索引的工具（`butler_plan` / `butler_verdict`）。 */
  readonly tools: ReadonlyMap<string, ButlerTool>
  /** 已经模拟过几次"模型被调用"。 */
  followups(): number
  /** 每次"模型被调用"时收到的第一个参数（提示词）——用它断言提示词内容。 */
  followupArgs(): readonly unknown[]
  /** 模拟"这一轮模型说完了"：发 `turn/end`。 */
  endTurn(): void
  /** 按注册名调一个工具（例如 `butler_verdict`）。 */
  callTool(name: string, args: unknown): Promise<unknown>
  /** 当前任务状态（读库）。 */
  state(): string
  /** 任务 id（落库之后才有值）。 */
  taskId(): string
  /** 等条件成立；超上限抛可读错误（**不会**挂到 vitest 的 testTimeout）。 */
  until(check: () => boolean, label: string): Promise<void>
  /** 轮询一次微任务。 */
  tick(): Promise<void>
  close(): void
}

/** 起一个可驱动的大总管：建场、注册工具、走完"模型交计划"这一步（派单随即开始）。 */
export async function startButler(options: DriveOptions): Promise<{ driver: Driver; plan: (input: PlanInput) => Promise<unknown> }> {
  const actor: Actor = options.actor ?? { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
  const conversationId = options.conversationId ?? 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
  const message = options.message ?? '写一篇园区封闭化管理介绍'
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000,
    maxResultChars: 8000,
    maxMessageChars: 8000,
    maxConversationEvents: 200,
    // 真实值而不是留空：留空时 `setTimeout(fn, undefined)` 会立刻触发，测试结束、库关掉之后
    // 那个闹钟才醒过来写库（既有用例的注释里记着这个坑）。
    waitingTimeoutMs: 600_000,
    ...options.config,
  } as Config
  const executor = options.executor
  const context = {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') {
          accept({
            protocol: 1,
            plugin: {
              id: executor.agentId, packageName: `dsh-${executor.agentId}`, version: '1.0.0',
              displayName: executor.agentId, description: '', entryPath: `/agents/${executor.agentId}`,
              permissions: [], tools: [], category: 'agents',
            },
          })
        }
      },
    },
  } as unknown as Context
  const console_ = new ButlerConsole(context, config, access, new SqliteButlerStorage(store), '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, unknown>
  }
  vi.spyOn(console_, 'open').mockImplementation(async (requestedId?: string) => {
    store.openOrReserveConversation(String(requestedId), actor)
    const conversation = { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() }
    inner.conversations.set(conversationId, conversation)
    return conversation as never
  })
  const registered: ButlerTool[] = []
  inner.setup({
    systemPrompt: { section: vi.fn() },
    tools: { register: (tool: never) => { registered.push(tool as ButlerTool) }, restrict: vi.fn() },
  } as unknown, conversationId)
  const tools = new Map(registered.map(tool => [tool.name, tool]))
  const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

  const findTask = (): string => {
    const page = store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' })
    return page.items[0]?.id ?? ''
  }

  const driver: Driver = {
    console_, store, actor, conversationId, tools,
    followups: () => agent.followup.mock.calls.length,
    followupArgs: () => agent.followup.mock.calls.map(call => call[0]),
    endTurn: () => {
      console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    },
    callTool: async (name, args) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`工具 ${name} 没有注册`)
      return tool.execute(args, { signal: new AbortController().signal })
    },
    state: () => store.task(actor, findTask())?.state ?? '',
    taskId: findTask,
    tick: settle,
    until: async (check, label) => {
      for (let attempt = 0; attempt < TICK_LIMIT; attempt += 1) {
        if (check()) return
        await settle()
      }
      throw new Error(`等待超时：${label}`)
    },
    close: () => { store.close() },
  }

  await console_.start(conversationId, message, actor)
  await driver.until(() => driver.followups() === 1, '大总管开始理解')

  /** 模拟模型调 `butler_plan`：**它只登记计划，不派单**（派单要等这一轮 `turn/end`）。 */
  const plan = async (input: PlanInput): Promise<unknown> => {
    const value = await driver.callTool('butler_plan', {
      reply: input.reply ?? '我先安排一下。',
      note: input.note ?? '',
      ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
      subtasks: input.subtasks.map(item => ({
        goal: item.goal,
        agentId: item.agentId,
        reason: item.reason ?? '',
        ...(item.acceptance === undefined ? {} : { acceptance: item.acceptance }),
        ...(item.logicalId === undefined ? {} : { logicalId: item.logicalId }),
        ...(item.supersedes === undefined ? {} : { supersedes: item.supersedes }),
        ...(item.dependsOn === undefined ? {} : { dependsOn: [...item.dependsOn] }),
      })),
    })
    return value
  }

  return { driver, plan }
}

export interface SettleOptions {
  /**
   * 每一轮汇总被驱动前调用：在这里调 `butler_verdict`（模拟模型裁决）。
   * `round` 从 1 开始 —— `rework` 之后的那次收尾是第 2 轮。
   */
  readonly onSummarize?: (round: number, driver: Driver) => void | Promise<void>
  /** 处理几轮收尾的上限（缺省 `ROUND_LIMIT`）。 */
  readonly maxRounds?: number
}

/**
 * 驱动到终态：循环处理 `summarizing`（调 `onSummarize` 后发 `turn/end`）与 `running`
 * （等派单/追加尝试推进），直到状态不再是这两者。
 *
 * 返回值是落定的终态。超轮数上限时抛错，并带上**看到的状态序列**——排查时先看它。
 */
export async function driveToTerminal(driver: Driver, options: SettleOptions = {}): Promise<string> {
  const maxRounds = options.maxRounds ?? ROUND_LIMIT
  const seen: string[] = []
  let round = 0
  for (let step = 0; step < TICK_LIMIT; step += 1) {
    const state = driver.state()
    if (seen[seen.length - 1] !== state) seen.push(state)
    if (state === '') { await driver.tick(); continue }
    if (state !== 'running' && state !== 'summarizing') return state
    if (state === 'summarizing') {
      if (round >= maxRounds) {
        throw new Error(`收尾轮数超过上限 ${maxRounds}；状态序列：${seen.join(' → ')}`)
      }
      round += 1
      if (options.onSummarize !== undefined) await options.onSummarize(round, driver)
      driver.endTurn()
      // 给 `summarize` 一点时间消费这一轮；下一次循环就会看到新状态。
      await driver.tick()
      await driver.tick()
      continue
    }
    await driver.tick()
  }
  throw new Error(`驱动没有收敛；状态序列：${seen.join(' → ')}`)
}

/** `driveToTerminal` 的简化用法：起场 → 交计划 → 驱动到终态。 */
export async function runPlannedTask(
  options: DriveOptions & { readonly plan: PlanInput } & SettleOptions,
): Promise<{ driver: Driver; state: string }> {
  const { driver, plan } = await startButler(options)
  await plan(options.plan)
  driver.endTurn()
  await driver.until(() => driver.taskId() !== '', '任务落库')
  const state = await driveToTerminal(driver, options)
  return { driver, state }
}
