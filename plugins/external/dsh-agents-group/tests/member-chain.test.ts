/**
 * 成员链路贯通验收（方案 G06/G01/G02/G04）。
 *
 * 与早先版本的关系：这里的「成员」是**测试内自建的替身**（`tests/fixtures/chain-member.ts`），
 * 不再依赖随包发布的验收成员。替身以前以 `verify-doll`（验收娃娃）随包发布，虽然默认关闭、
 * 要显式配置才装载，但任何站点的成员名单里都不该出现一只验收替身，所以它被移出产品代码。
 * 链路语义一条没少：派活→等待→两次续问→交差，外加同 ID 重试幂等与异文拒绝。
 *
 * 执行入口与目录条目都走**真实装配路径**：用替身宿主上下文跑群组 `apply()`，从
 * `butler/executors` 收执行入口、从 `ecosystem/catalog` 收目录条目，再把这两份真实产物喂给
 * 真实的 ButlerConsole。此前测试手工编造目录条目，掩盖了群组从未给成员注册目录条目的缺口；
 * 现在装配缺任何一环这里都会红。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AGENT_PLUGIN_CATEGORY, type Access, type Actor, type PluginDescriptor } from '@dsh-plugin-manager/plugin-kit'
// 群组侧的真实装配与管家实现（仅测试内跨插件引用；运行时两插件互不导入业务源码）。
import { apply as applyGroup } from '../src/index.ts'
import { AGENT_MANIFESTS } from '../src/agents/registry.ts'
import { Config as GroupConfig } from '../src/config.ts'
import { executorFor, onButlerExecutors } from '../src/butler-bridge.ts'
import { ButlerConsole } from '../../dsh-butler-console/src/butler.ts'
import { listAgentCards } from '../../dsh-butler-console/src/agents.ts'
import type { Config } from '../../dsh-butler-console/src/config.ts'
import type { ButlerAgentExecutor } from '../../dsh-butler-console/src/protocol.ts'
import { SqliteButlerStorage, TaskStore } from '../../dsh-butler-console/tests/helpers/sqlite-test-store.ts'
import { CHAIN_MEMBER_MANIFEST, mountChainMember } from './fixtures/chain-member.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const PUBLIC_ORIGIN = 'https://butler.test'
const MEMBER = CHAIN_MEMBER_MANIFEST.id

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

/** 群组业务配置（替身凭据）：closedoff/blog 必须齐，否则装载被拒——那是设计行为。 */
function writeGroupConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-group-'))
  const file = join(dir, 'group.json')
  writeFileSync(file, JSON.stringify({
    closedoff: {
      CLOSEDOFF_BASE_URL: 'https://gateway.test/',
      CLOSEDOFF_OPEN_CLIENT_ID: 'open-id', CLOSEDOFF_OPEN_CLIENT_SECRET: 'open-secret',
      CLOSEDOFF_APP_CODE: 'app-code', CLOSEDOFF_APP_CLIENT_ID: 'app-id', CLOSEDOFF_APP_CLIENT_SECRET: 'app-secret',
      CLOSEDOFF_USERNAME: 'tester',
    },
    blog: {
      schemaVersion: 1,
      models: { text: { provider: 'zhipu', model: 'glm-5.3' }, vision: { provider: 'zhipu', model: 'glm-5v-turbo' } },
      blog: { url: 'https://blog.test', username: 'tester', password: 'secret' },
      image: { url: 'https://image.test', username: 'tester', password: 'secret', strategyId: 2, maxBytes: 1048576 },
      backup: { url: 'http://127.0.0.1:7913', token: 'backup-token', allowedUserIds: [] },
    },
  }))
  process.env.AGENTS_GROUP_CONFIG = file
  return file
}

/** 记录型替身宿主（与群组 mount-e2e 同一套最小面），外加认证提供者。 */
function fakeHost() {
  const effects: (() => void)[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const emit = (name: string, accept: (value: unknown) => void) => {
    if (name === 'ecosystem/providers') {
      accept({ protocol: 1, ready: () => {}, resolve: () => ({ namespace: 'user', userId: 'tester', sessionId: 'login-1' }), assertAccess: () => {} })
      return
    }
    for (const listener of listeners.get(name) ?? []) listener(accept)
  }
  const ctx = {
    effect: (factory: () => unknown) => { const d = factory(); if (typeof d === 'function') effects.push(d as () => void); return () => {} },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    get: () => undefined,
    set: (name: string, value: unknown) => value,
    provide: (name: string, value: unknown) => value,
    root: { emit },
    webServer: { register: () => () => {} },
    llm: { resolveModelInfo: async () => undefined, resolveCallConfig: async (v: unknown) => v },
    agents: { list: () => [], get: () => undefined },
    tools: { register: () => () => {}, restrict: () => () => {} },
    jobs: { attachController: () => () => {}, start: () => 'job-1', wait: async () => ({ status: 'completed' }), get: () => ({ status: 'completed' }), kill: () => {} },
    attachments: { saveFileStream: async () => ({ id: 'att-1' }) },
  } as unknown as Context
  return { ctx, effects }
}

/**
 * 跑一次真实群组装配，并把测试替身按同样的桥接路径登记进去。
 *
 * 替身走的是与随包成员完全相同的 `registerPlugin` + `executorFor` + `onButlerExecutors`，
 * 所以「目录条目 / 执行入口」这两条链路由它覆盖时，被测的仍是产品代码那条通路。
 */
async function assembleWithMember() {
  writeGroupConfig()
  const { ctx } = fakeHost()
  // blog 的 SQLite 需要独立数据目录：与其他并行测试文件共用默认 dshHome 路径会锁库。
  const blogData = mkdtempSync(join(tmpdir(), 'chain-blog-'))
  const config = GroupConfig({
    accessMode: 'authenticated',
    publicOrigin: PUBLIC_ORIGIN,
    routePrefix: '/agents',
    authRecheckMs: 100,
    agents: {
      blog: { enabled: true, config: { dataPath: blogData }, models: { allow: [], deny: [] } },
    },
  } as never)
  await applyGroup(ctx, config)
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const member = await mountChainMember({ ctx, access, routePrefix: '/agents' })
  ctx.effect(() => onButlerExecutors(ctx, executorFor(CHAIN_MEMBER_MANIFEST, member.participant)))
  const executors: ButlerAgentExecutor[] = []
  ctx.root.emit('butler/executors', (value: unknown) => { executors.push(value as ButlerAgentExecutor) })
  const catalog: PluginDescriptor[] = []
  ctx.root.emit('ecosystem/catalog', (value: unknown) => { catalog.push((value as { plugin: PluginDescriptor }).plugin) })
  return { ctx, executors, catalog }
}

/** 管家：执行入口与目录条目来自真实装配（不再手工编造）。 */
async function butlerFixture(executors: readonly ButlerAgentExecutor[], catalog: readonly PluginDescriptor[]) {
  // `TaskStore` 是同步 SQLite 替身；交给 `SqliteButlerStorage` 适配成 `ButlerStorage`
  // （`init`/`readyProbe`/`expireWaitingSubtask` 在适配器里，与管家自家
  // `tests/target-identity.test.ts:88` 同款用法），`store` 保留供下面直接操作。
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000,
  } as Config
  const ctx = {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') { for (const executor of executors) accept(executor); return }
        if (name === 'ecosystem/catalog') { for (const plugin of catalog) accept({ protocol: 1, plugin }); return }
      },
    },
  } as unknown as Context
  const console_ = new ButlerConsole(ctx, config, access, new SqliteButlerStorage(store), '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as { setup(ctx: unknown, sessionId: string): void; conversations: Map<string, unknown> }
  vi.spyOn(console_, 'open').mockImplementation(async (requestedId?: string) => {
    store.openOrReserveConversation(String(requestedId), actor)
    const conversation = { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() }
    inner.conversations.set(conversationId, conversation)
    return conversation as never
  })
  const tools: { execute(args: unknown, exec: unknown): Promise<unknown> }[] = []
  inner.setup({
    systemPrompt: { section: vi.fn() },
    tools: { register: (tool: never) => { tools.push(tool) }, restrict: vi.fn() },
  }, conversationId)
  const planTool = tools[0]
  if (planTool === undefined) throw new Error('派活工具没有注册')
  const endTurn = () => {
    console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
  }
  let planningDone = false
  agent.followup.mockImplementation(() => { if (planningDone) queueMicrotask(endTurn) })
  const tasks = () => store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' }).items
  const planTowardMember = async () => {
    await console_.start(conversationId, '验收一次群组接入', actor)
    await until(() => agent.followup.mock.calls.length === 1, '大总管开始理解')
    await planTool.execute({
      reply: '让链路替身走一遍。',
      note: '',
      subtasks: [{ goal: '走完等待与续问', agentId: MEMBER, reason: '' }],
    }, { signal: new AbortController().signal })
    endTurn()
    planningDone = true
    await until(() => tasks().length === 1, '任务落库')
    const taskId = tasks()[0]!.id
    await until(() => store.task(actor, taskId)?.state === 'waiting_user', '替身停在等人回话')
    return taskId
  }
  return { console_, store, tasks, planTowardMember, subtaskOf: (taskId: string) => store.task(actor, taskId)!.subtasks[0]! }
}

describe('成员链路贯通（真实装配 + 测试内替身）', () => {
  let spy: typeof console.error
  beforeEach(() => { spy = console.error; console.error = () => {} })
  afterEach(() => { console.error = spy; delete process.env.AGENTS_GROUP_CONFIG })

  it('随包名单里没有任何验收专用成员，成员都从真实装配拿到目录条目与执行入口', async () => {
    // 回归护栏：接入期的验收替身只活在测试里，不再随包发布。
    expect(AGENT_MANIFESTS.filter(item => item.verificationOnly === true)).toEqual([])
    expect(AGENT_MANIFESTS.map(item => item.id)).toEqual(['closedoff', 'blog', 'huiyu'])

    const { executors, catalog } = await assembleWithMember()
    // huiyu 与 closedoff / blog 同一条判据：两条装配路径都必须产出目录条目与执行入口。
    // 执行入口这条尤其关键——它就是"能被牛马大总管调用"的判据：缺了它，群组侧不会登记
    // 执行器，牛马大总管的成员名单里就没有绘语，它连计划都不会做。
    for (const id of ['closedoff', 'blog', 'huiyu']) {
      const entry = catalog.find(plugin => plugin.id === id)
      expect(entry, `${id} 缺少目录条目`).toBeDefined()
      expect(executors.some(executor => executor.agentId === id), `${id} 缺少执行入口`).toBe(true)
      /**
       * ★ **条目的分类必须逐字是 `'agents'`。**
       *
       * 牛马大总管按它筛成员——`listAgentCards` 只收 `category === AGENT_PLUGIN_CATEGORY`
       * （值就是 `'agents'`）的插件。写成别的值（例如清单里的业务分类"图片与视觉"）时，
       * 条目还在、探针也正常、执行入口也登记了，**但成员列表里没有它**，于是永远不会被派活。
       *
       * 这条判据是补出来的：2026-09-18 绘语就是这么错的——`registerPlugin` 传了群组注入的
       * 业务分类而非 `'agents'`，而当时这里只验了条目与执行入口，全绿。
       */
      expect(entry?.category, `${id} 的目录分类必须是 'agents'，否则进不了牛马大总管的成员列表`).toBe(AGENT_PLUGIN_CATEGORY)
    }
    // 替身自己那条也必须齐：分类是 agents，条目路径落在群组前缀下。
    const entry = catalog.find(plugin => plugin.id === MEMBER)
    expect(entry?.category).toBe('agents')
    expect(entry?.entryPath).toBe(`/agents/${MEMBER}`)
    expect(executors.some(executor => executor.agentId === MEMBER)).toBe(true)
  })

  /**
   * 成员卡片的**每个字段**都要真的能派活。
   *
   * ## 为什么单独断一张卡片
   *
   * 上一条判据只核了"目录条目 + 执行入口"，就漏掉了 `category`（2026-09-18 绘语的实际缺陷）。
   * 卡片是牛马大总管真正读的东西，它的字段各有用途，缺一个就是一处静默失效：
   *
   * | 字段 | 缺了会怎样 |
   * | --- | --- |
   * | `dispatchable` | 不进可派活名单（`resolveExecutor` 直接拒绝） |
   * | `capabilities` | 拼进提示词时显示"未声明，按子任务语义自行判断"（`butler.ts:1559`）⇒ 大总管不知道该派什么活给它 |
   * | `entryPath` | 卡片上的入口点不开 |
   * | `toolCount` | 界面显示"0 个工具"，看起来这个成员什么都不会 |
   *
   * 这里调**真实的** `listAgentCards`，不手工拼卡片——手拼就验不到 `filter(category)` 那一步。
   */
  it('绘语在牛马大总管的成员卡片里，字段足以被派活', async () => {
    const { ctx } = await assembleWithMember()
    const cards = listAgentCards(ctx)
    const card = cards.find(item => item.id === 'huiyu')

    expect(card, '绘语没有出现在牛马大总管的成员列表里').toBeDefined()
    expect(card?.dispatchable, '绘语不可派活').toBe(true)
    // 提示词靠它决定"把什么活派给谁"；空数组会让大总管按语义自己猜。
    expect(card?.capabilities.length, '绘语没有声明能力，大总管不知道该派什么活').toBeGreaterThan(0)
    // 八个工具都要被数进去——显示 0 会让界面上看起来它什么都不会。
    expect(card?.toolCount, '工具数不对').toBe(8)
    expect(card?.entryPath).toBe('/agents/huiyu')
    expect(card?.permissions).toContain('huiyu:access')
    expect(card?.displayName.trim()).not.toBe('')
    expect(card?.description.trim()).not.toBe('')
  })

  it('三个随包成员都在成员列表里且都可派活', async () => {
    const { ctx } = await assembleWithMember()
    const cards = listAgentCards(ctx)
    for (const id of ['closedoff', 'blog', 'huiyu']) {
      const card = cards.find(item => item.id === id)
      expect(card, `${id} 不在成员列表里`).toBeDefined()
      expect(card?.dispatchable, `${id} 不可派活`).toBe(true)
    }
  })

  it('装配→派发→早期引用→两次续问→交差，全程不丢会话与材料', async () => {
    const { executors, catalog } = await assembleWithMember()
    const f = await butlerFixture(executors, catalog)
    const taskId = await f.planTowardMember()

    const waitingSubtask = f.subtaskOf(taskId)
    expect(waitingSubtask.state).toBe('waiting_user')
    expect(waitingSubtask.conversationId).toMatch(/^chain-/)
    expect(waitingSubtask.artifacts.some(item => item.kind === 'conversation')).toBe(true)
    const memberConversation = waitingSubtask.conversationId

    await f.console_.startReply({ taskId, subtaskId: 's1', text: '先用第一版', decideByAgent: false, actor })
    await until(() => f.subtaskOf(taskId).state === 'waiting_user' && f.subtaskOf(taskId).result.includes('先用第一版'), '第一次回话引出新等待')

    await f.console_.startReply({ taskId, subtaskId: 's1', text: '补充一句封面用蓝色', decideByAgent: false, actor })
    await until(() => f.subtaskOf(taskId).state === 'succeeded', '第二次回话交差')
    const done = f.subtaskOf(taskId)
    expect(done.conversationId).toBe(memberConversation)
    expect(done.result).toContain('先用第一版')
    expect(done.result).toContain('封面用蓝色')
    expect(done.artifacts.some(item => item.kind === 'report')).toBe(true)
    await until(() => ['completed', 'partial'].includes(f.store.task(actor, taskId)!.state), '任务收尾')
  })

  it('同一次回话重试不重复执行业务，同 ID 异文被成员拒绝', async () => {
    const { executors, catalog } = await assembleWithMember()
    const executor = executors.find(item => item.agentId === MEMBER)
    if (executor === undefined) throw new Error('替身未登记执行入口')
    const replySpy = vi.spyOn(executor, 'reply')
    const f = await butlerFixture(executors, catalog)
    const taskId = await f.planTowardMember()

    const first = await f.console_.startReply({ taskId, subtaskId: 's1', text: '先用第一版', decideByAgent: false, actor, requestId: 'retry-me-once' })
    await until(() => f.subtaskOf(taskId).state === 'waiting_user' && f.subtaskOf(taskId).result.includes('先用第一版'), '第一次回话完成')
    const callsAfterFirst = replySpy.mock.calls.length

    // 同 ID 同内容：服务端幂等层直接给原凭据，成员不会再被叫一次。
    const retried = await f.console_.startReply({ taskId, subtaskId: 's1', text: '先用第一版', decideByAgent: false, actor, requestId: 'retry-me-once' })
    expect(retried.runId).toBe(first.runId)
    expect(replySpy.mock.calls.length).toBe(callsAfterFirst)

    // 新 ID 是新回话：交差。成员侧的幂等身份是这一次受理的 runId（受理 ID 归服务端幂等层）。
    const second = await f.console_.startReply({ taskId, subtaskId: 's1', text: '补充封面用蓝色', decideByAgent: false, actor, requestId: 'a-brand-new-one' })
    await until(() => f.subtaskOf(taskId).state === 'succeeded', '第二次回话交差')
    expect(replySpy.mock.calls.length).toBe(callsAfterFirst + 1)

    // 成员侧的异文防线（先于缓存）：同一回话身份配不同内容直接拒绝。
    const direct = await executor.reply?.({
      taskId, subtaskId: 's1', requestId: second.runId, text: '同一身份换句话',
      decideByAgent: false, owner: 'user:alice', actor, signal: new AbortController().signal,
      conversationId: f.subtaskOf(taskId).conversationId,
    })
    expect(direct?.status).toBe('failed')
    expect(direct?.summary).toContain('不能用在不同内容上')
  })
})
