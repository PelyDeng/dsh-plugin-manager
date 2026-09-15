/**
 * 两项目贯通验收（方案 G06/G01/G02/G04，B 批补缺版）。
 *
 * 与上一版的差别：**执行入口与目录条目都来自真实群组装配**——用替身宿主上下文跑群组
 * 的 `apply()`，从 `butler/executors` 事件收执行入口、从 `ecosystem/catalog` 收目录
 * 条目，再把这两份「真实产物」喂给真实的 ButlerConsole。此前测试手工编造目录条目，
 * 掩盖了群组从未给成员注册目录条目的缺口；现在装配缺任何一环这里都会红。
 *
 * 同时验证验收成员的启用边界：不显式 `enabled` 时它不出现在装配产物里。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor, PluginDescriptor } from '@dsh-plugin-manager/plugin-kit'
// 群组侧的真实装配与管家实现（仅测试内跨插件引用；运行时两插件互不导入业务源码）。
import { apply as applyGroup } from '../src/index.ts'
import { Config as GroupConfig } from '../src/config.ts'
import { ButlerConsole } from '../../dsh-butler-console/src/butler.ts'
import type { Config } from '../../dsh-butler-console/src/config.ts'
import type { ButlerAgentExecutor } from '../../dsh-butler-console/src/protocol.ts'
import { TaskStore } from '../../dsh-butler-console/src/store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const PUBLIC_ORIGIN = 'https://butler.test'

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

/** 跑一次真实群组装配，收执行入口与目录条目。 */
async function assembleGroup(enableDoll: boolean) {
  writeGroupConfig()
  const { ctx } = fakeHost()
  // blog 的 SQLite 需要独立数据目录：与其他并行测试文件共用默认 dshHome 路径会锁库。
  const blogData = mkdtempSync(join(tmpdir(), 'doll-blog-'))
  const config = GroupConfig({
    accessMode: 'authenticated',
    publicOrigin: PUBLIC_ORIGIN,
    routePrefix: '/agents',
    authRecheckMs: 100,
    agents: {
      blog: { enabled: true, config: { dataPath: blogData }, models: { allow: [], deny: [] } },
      ...(enableDoll ? { 'verify-doll': { enabled: true, config: {}, models: { allow: [], deny: [] } } } : {}),
    },
  } as never)
  await applyGroup(ctx, config)
  const executors: ButlerAgentExecutor[] = []
  ctx.root.emit('butler/executors', (value: unknown) => { executors.push(value as ButlerAgentExecutor) })
  const catalog: PluginDescriptor[] = []
  ctx.root.emit('ecosystem/catalog', (value: unknown) => { catalog.push((value as { plugin: PluginDescriptor }).plugin) })
  return { executors, catalog }
}

/** 管家：执行入口与目录条目来自真实装配（不再手工编造）。 */
async function butlerFixture(executors: readonly ButlerAgentExecutor[], catalog: readonly PluginDescriptor[]) {
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
  const console_ = new ButlerConsole(ctx, config, access, store, '')
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
  const planTowardDoll = async () => {
    await console_.start(conversationId, '验收一次群组接入', actor)
    await until(() => agent.followup.mock.calls.length === 1, '大总管开始理解')
    await planTool.execute({
      reply: '让验收娃娃走一遍。',
      note: '',
      subtasks: [{ goal: '走完等待与续问', agentId: 'verify-doll', reason: '' }],
    }, { signal: new AbortController().signal })
    endTurn()
    planningDone = true
    await until(() => tasks().length === 1, '任务落库')
    const taskId = tasks()[0]!.id
    await until(() => store.task(actor, taskId)?.state === 'waiting_user', '娃娃停在等人回话')
    return taskId
  }
  return { console_, store, tasks, planTowardDoll, subtaskOf: (taskId: string) => store.task(actor, taskId)!.subtasks[0]! }
}

describe('验收娃娃的两项目贯通（真实装配）', () => {
  let spy: typeof console.error
  beforeEach(() => { spy = console.error; console.error = () => {} })
  afterEach(() => { console.error = spy; delete process.env.AGENTS_GROUP_CONFIG })

  it('真实装配提供目录条目与执行入口；显式启用才出现', async () => {
    const off = await assembleGroup(false)
    expect(off.catalog.some(plugin => plugin.id === 'verify-doll')).toBe(false)
    expect(off.executors.some(executor => executor.agentId === 'verify-doll')).toBe(false)
    // 普通成员不受验收开关影响。
    expect(off.catalog.some(plugin => plugin.id === 'blog')).toBe(true)

    const on = await assembleGroup(true)
    const entry = on.catalog.find(plugin => plugin.id === 'verify-doll')
    expect(entry?.category).toBe('agents')
    expect(entry?.entryPath).toBe('/agents/verify-doll')
    expect(on.executors.some(executor => executor.agentId === 'verify-doll')).toBe(true)
  })

  it('装配→派发→早期引用→两次续问→交差，全程不丢会话与材料', async () => {
    const { executors, catalog } = await assembleGroup(true)
    const f = await butlerFixture(executors, catalog)
    const taskId = await f.planTowardDoll()

    const waitingSubtask = f.subtaskOf(taskId)
    expect(waitingSubtask.state).toBe('waiting_user')
    expect(waitingSubtask.conversationId).toMatch(/^doll-/)
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
    const { executors, catalog } = await assembleGroup(true)
    const executor = executors.find(item => item.agentId === 'verify-doll')
    if (executor === undefined) throw new Error('验收娃娃未登记执行入口')
    const replySpy = vi.spyOn(executor, 'reply')
    const f = await butlerFixture(executors, catalog)
    const taskId = await f.planTowardDoll()

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
