/**
 * 同会话执行互斥（方案 G05，A 批）。
 *
 * chat、reply、supplement 三个受理入口共享每个会话一份「执行权」：拿到才能改子任务、
 * 换运行引用和事件日志。这里用真实 `ButlerConsole` 与真实 SQLite 索引，只把宿主 Agent、
 * 执行方和登录换成替身，验证四件事：
 *
 * 1. 同会话两次回话并发提交，后到的被 409 拒绝，且不改子任务状态；
 * 2. 回话执行中新回合被 409 拒绝，不能挤掉在跑的回话；
 * 3. 回合还活着时回话同样被 409 拒绝——接管会覆盖运行引用与日志；收尾后恢复受理；
 * 4. 补充在回话执行期间受理后等执行权，回话结束后继续处理，不会丢成「已接受未处理」。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor, ButlerDispatchResult } from '../src/protocol.ts'
import { TaskStore } from '../src/store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

async function untilAsync(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** 目录与调度入口。 */
function context(executor: ButlerAgentExecutor): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: executor.agentId, packageName: 'dsh-blog', version: '1.0.0', displayName: '博客',
          description: '', entryPath: '/agents/blog', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

/**
 * 装一个可控制节奏的协作现场：计划里两个子任务，各自能被卡在 dispatch 或 reply 上。
 * 规划那一轮由测试手动结束（要先喂计划）；之后的轮次（收尾汇总等）自动结束。
 */
async function fixture() {
  const dispatchImpls = new Map<string, () => Promise<ButlerDispatchResult>>()
  const replyDeferreds = new Map<string, ReturnType<typeof deferred<ButlerDispatchResult>>>()
  const executor: ButlerAgentExecutor = {
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async request => dispatchImpls.get(request.subtaskId)?.() ?? { status: 'succeeded', summary: 'done' },
    reply: async request => (replyDeferreds.get(request.subtaskId) ?? deferred()).promise,
  }
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, store, '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, { active: boolean }>
  }
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

  /** 走到「大总管正在理解」，返回受理凭据。 */
  const beginPlanning = async () => {
    const started = await console_.start(conversationId, '两件事都办了', actor)
    await until(() => agent.followup.mock.calls.length === 1, '大总管开始理解')
    return started
  }

  /** 喂一份两个子任务的计划并结束规划轮，等任务落库。 */
  const submitPlan = async () => {
    await planTool.execute({
      reply: '我先让博客起两版。',
      note: '',
      subtasks: [
        { goal: '第一件', agentId: 'blog', reason: '' },
        { goal: '第二件', agentId: 'blog', reason: '' },
      ],
    }, { signal: new AbortController().signal })
    endTurn()
    planningDone = true
    await until(() => tasks().length === 1, '任务落库')
    return tasks()[0]!.id
  }

  return {
    console_, agent, store, dispatchImpls, replyDeferreds, tasks, beginPlanning, submitPlan,
    isActive: () => inner.conversations.get(conversationId)?.active === true,
    waitDispatch(subtaskId: string) {
      dispatchImpls.set(subtaskId, () => Promise.resolve({ status: 'waiting_user', summary: `${subtaskId} 的材料`, question: `${subtaskId} 怎么办？` }))
    },
    holdDispatch(subtaskId: string) {
      const gate = deferred<ButlerDispatchResult>()
      dispatchImpls.set(subtaskId, () => gate.promise)
      return gate
    },
    holdReply(subtaskId: string) {
      const gate = deferred<ButlerDispatchResult>()
      replyDeferreds.set(subtaskId, gate)
      return gate
    },
    async acceptedNewTurn(): Promise<boolean> {
      try { await console_.start(conversationId, '再派个新活', actor); return true } catch { return false }
    },
  }
}

describe('同会话执行互斥', () => {
  it('同会话第二次回话被 409 拒绝，且不改子任务状态', async () => {
    const f = await fixture()
    f.waitDispatch('s1'); f.waitDispatch('s2')
    await f.beginPlanning()
    const taskId = await f.submitPlan()
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    const first = f.holdReply('s1')

    await f.console_.startReply({ taskId, subtaskId: 's1', text: '听第一版的', decideByAgent: false, actor })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'running', '第一次回话在执行')

    await expect(f.console_.startReply({ taskId, subtaskId: 's2', text: '第二版也说说', decideByAgent: false, actor }))
      .rejects.toThrow(/已有一次回话或补充在执行/)
    // 被拒的那张卡原样保留：状态没被改成 running，等待上下文也没被消费。
    expect(f.store.task(actor, taskId)!.subtasks[1]!.state).toBe('waiting_user')

    first.resolve({ status: 'succeeded', summary: '按第一版定了' })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'succeeded', '第一次回话收尾')
    // 释放之后第二次回话可以受理。
    const second = f.holdReply('s2')
    await expect(f.console_.startReply({ taskId, subtaskId: 's2', text: '第二版也说说', decideByAgent: false, actor }))
      .resolves.toHaveProperty('runId')
    second.resolve({ status: 'succeeded', summary: '第二版也说完了' })
    await until(() => f.store.task(actor, taskId)!.subtasks[1]!.state === 'succeeded', '第二次回话收尾')
  })

  it('回话执行中新回合被 409 拒绝，回话结束后恢复受理', async () => {
    const f = await fixture()
    f.waitDispatch('s1'); f.waitDispatch('s2')
    await f.beginPlanning()
    const taskId = await f.submitPlan()
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    const held = f.holdReply('s1')
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '听第一版的', decideByAgent: false, actor })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'running', '回话在执行')

    await expect(f.console_.start(conversationId, '再派个新活', actor)).rejects.toThrow(/还有一次执行没有结束/)
    // 同一条消息再试也一样，直到回话收尾。
    await expect(f.console_.start(conversationId, '再派个新活', actor)).rejects.toThrow(/还有一次执行没有结束/)

    held.resolve({ status: 'succeeded', summary: '办完了' })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'succeeded', '回话收尾')
    await untilAsync(() => f.acceptedNewTurn(), '回话结束后新回合可受理')
  })

  it('回合还活着时回话被 409 拒绝，收尾后恢复受理', async () => {
    const f = await fixture()
    // s1 立刻停在等待；s2 卡住，让回合一直活着。
    f.waitDispatch('s1')
    const gate = f.holdDispatch('s2')
    await f.beginPlanning()
    const taskId = await f.submitPlan()
    await until(() => (f.store.task(actor, taskId)?.subtasks.some(item => item.state === 'waiting_user')) === true, 's1 停在等待')
    await until(() => f.isActive(), 's2 没派完，回合还活着')

    // 回合活着时回话不允许接管执行权：接管会覆盖运行引用和事件日志，把在跑的活变成
    // 不可停止。状态与等待上下文都不动。
    await expect(f.console_.startReply({ taskId, subtaskId: 's1', text: '听第一版的', decideByAgent: false, actor }))
      .rejects.toThrow(/这一轮还在执行/)
    expect(f.store.task(actor, taskId)!.subtasks[0]!.state).toBe('waiting_user')

    // 放开 s2：回合走到收尾，执行权释放，回话恢复受理。
    gate.resolve({ status: 'waiting_user', summary: 's2 的材料', question: 's2 怎么办？' })
    await until(() => !f.isActive(), '回合收尾')
    const held = f.holdReply('s1')
    await expect(f.console_.startReply({ taskId, subtaskId: 's1', text: '听第一版的', decideByAgent: false, actor }))
      .resolves.toHaveProperty('runId')
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'running', '回话开始执行')
    held.resolve({ status: 'succeeded', summary: '定了' })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'succeeded', '回话收尾')
    await untilAsync(() => f.acceptedNewTurn(), '回话结束后新回合可受理')
  })

  it('补充在回话执行期间受理后等待执行权，回话结束后继续处理', async () => {
    const f = await fixture()
    f.waitDispatch('s1'); f.waitDispatch('s2')
    await f.beginPlanning()
    const taskId = await f.submitPlan()
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    const held = f.holdReply('s1')
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '听第一版的', decideByAgent: false, actor })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'running', '回话在执行')

    const accepted = f.console_.submitSupplement({ taskId, text: '顺便也提一下通行卡', actor })
    await until(() => (f.store.inputVersions(taskId)?.accepted ?? 0) >= 1, '补充已受理落库')

    held.resolve({ status: 'succeeded', summary: '办完了' })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'succeeded', '回话收尾')
    // 回话释放执行权后，补充继续处理：已接受的输入版本被追平为已处理。
    await until(() => (f.store.inputVersions(taskId)?.processed ?? 0) >= (f.store.inputVersions(taskId)?.accepted ?? 1), '补充处理完成')
    await expect(accepted).resolves.toHaveProperty('runId')
  })
})
