/**
 * 续问与结果闭环（方案 G01/G02/G04，B 批）。
 *
 * 三件事都要走完「派活 → 等回话 → 回话」才看得见：
 *
 * 1. 早期引用（G02）：进度里上报的原会话在 final 前就落库——final 不带引用也不丢；
 * 2. 续问身份（G01）：回话交给执行方的是「这一次回话的幂等身份 + 原会话引用」，
 *    不再复用子任务 ID；
 * 3. 结果矩阵（G04）：回话的 external_pending 落成它自己而不是 failed，成功分支
 *    不丢材料与会话；回话再次引出等待时，等待上下文重新登记、可以继续回话。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor, ButlerDispatchResult } from '../src/protocol.ts'
import { SqliteButlerStorage } from '../src/storage/sqlite-adapter.ts'
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

async function fixture(executor: ButlerAgentExecutor) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, new SqliteButlerStorage(store), '')
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

  const dispatchUntilWaiting = async () => {
    await console_.start(conversationId, '写一份介绍', actor)
    await until(() => agent.followup.mock.calls.length === 1, '大总管开始理解')
    await planTool.execute({
      reply: '让博客起一版。',
      note: '',
      subtasks: [{ goal: '起草介绍', agentId: executor.agentId, reason: '' }],
    }, { signal: new AbortController().signal })
    endTurn()
    planningDone = true
    await until(() => tasks().length === 1, '任务落库')
    const taskId = tasks()[0]!.id
    await until(() => store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
    return taskId
  }

  return { console_, agent, store, tasks, dispatchUntilWaiting, subtaskOf: (taskId: string) => store.task(actor, taskId)!.subtasks[0]! }
}

describe('续问与结果闭环', () => {
  it('进度早期上报的原会话在 final 前落库，final 不带也不丢（G02）', async () => {
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async request => {
        // 业务一开始就交回会话引用；最终结果故意不带——早期落库的那份必须留住。
        request.onProgress?.({
          stage: '开工', conversationId: 'member-conv-early',
          conversationArtifact: { kind: 'conversation', title: '查看原会话', path: '/agents/blog?conversationId=member-conv-early' },
        })
        return { status: 'waiting_user', summary: '两版候选稿都在', question: '用哪一版？' }
      },
      reply: async () => ({ status: 'succeeded', summary: '定了' }),
    }
    const f = await fixture(executor)
    const taskId = await f.dispatchUntilWaiting()
    const subtask = f.subtaskOf(taskId)
    expect(subtask.conversationId).toBe('member-conv-early')
    expect(subtask.artifacts.some(item => item.kind === 'conversation')).toBe(true)
  })

  it('回话交给执行方的是新幂等身份与原会话引用，不再复用子任务 ID（G01）', async () => {
    const seen: { requestId?: string; conversationId?: string | undefined; missionId?: string } = {}
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async request => {
        request.onProgress?.({ stage: '开工', conversationId: 'member-conv-early' })
        return { status: 'waiting_user', summary: '材料都在', question: '用哪版？' }
      },
      reply: async request => {
        seen.requestId = request.requestId
        seen.conversationId = request.conversationId
        seen.missionId = request.taskId
        return { status: 'succeeded', summary: '按第一版定了' }
      },
    }
    const f = await fixture(executor)
    const taskId = await f.dispatchUntilWaiting()
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '用第一版', decideByAgent: false, actor })
    await until(() => f.subtaskOf(taskId).state === 'succeeded', '回话收尾')
    expect(seen.requestId).toBeTruthy()
    expect(seen.requestId).not.toBe('s1')
    expect(seen.requestId).toMatch(/^butler-run-/)
    expect(seen.conversationId).toBe('member-conv-early')
  })

  it('回话的 external_pending 落成它自己，成功分支不丢材料与会话（G04）', async () => {
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({ status: 'waiting_user', summary: '候选稿都在', question: '用哪版？' }),
      reply: async () => ({
        status: 'external_pending',
        summary: '草稿已保存',
        conversationId: 'member-conv-final',
        artifacts: [{ kind: 'draft', title: '去博客采用', path: '/agents/blog?conversationId=member-conv-final' }],
        externalPending: { reason: '等你到博客后台点发布', next: '打开博客工作台' },
      }) as ButlerDispatchResult,
    }
    const f = await fixture(executor)
    const taskId = await f.dispatchUntilWaiting()
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '用第一版', decideByAgent: false, actor })
    await until(() => ['external_pending', 'completed', 'partial'].includes(f.subtaskOf(taskId).state) || f.subtaskOf(taskId).state === 'external_pending', '回话收尾')
    const subtask = f.subtaskOf(taskId)
    // 之前这条路径把 external_pending 落成 failed。
    expect(subtask.state).toBe('external_pending')
    expect(subtask.result).toContain('等你到博客后台点发布')
    expect(subtask.conversationId).toBe('member-conv-final')
    expect(subtask.artifacts.some(item => item.kind === 'draft')).toBe(true)
  })

  it('回话再次引出等待时重新登记等待上下文，可以继续回话（G04）', async () => {
    let round = 0
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({ status: 'waiting_user', summary: '第一版还是第二版？', question: '第一版还是第二版？' }),
      reply: async () => {
        round += 1
        return round === 1
          ? { status: 'waiting_user', summary: '收到，那封面用哪张？', question: '封面用哪张？' }
          : { status: 'succeeded', summary: '都定了' }
      },
    }
    const f = await fixture(executor)
    const taskId = await f.dispatchUntilWaiting()
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '用第一版', decideByAgent: false, actor })
    await until(() => f.subtaskOf(taskId).state === 'waiting_user' && f.subtaskOf(taskId).result.includes('封面'), '回话引出新等待')
    // 新等待有登记：第二次回话能被受理并走到成功。
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '封面用蓝色', decideByAgent: false, actor })
    await until(() => f.subtaskOf(taskId).state === 'succeeded', '第二次回话收尾')
  })
})
