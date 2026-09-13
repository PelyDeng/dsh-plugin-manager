/**
 * 目标标识、替代与依赖。
 *
 * 三件事都属于「谁该跑、结论按谁算」这层编排语义，放在一起测：
 *
 * - **目标标识**：一轮里的「目标」和「尝试」是两回事。同一个目标可能做两次（第一次失败、
 *   换个人重做），而结论该按目标算 —— 少了这层区分，「重试成功了」会被前面那次已经作废的
 *   失败拉成「部分完成」。
 * - **替代**：新尝试沿用旧目标的标识并指向被替代的那条。
 * - **依赖**：只有前置**成功**才派下一步；前置失败、取消、还在等人回话、带着外部待办时都不派，
 *   如实说明「前提没有满足」，而不是伪造一次员工报错。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole, effectiveSubtasks } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { TaskStore, type SubtaskRecord } from '../src/store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

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

/** 按目标给不同结论：这样才能造出「一条成功、一条还在等」的组合。 */
function executorByGoal(byGoal: Record<string, { status: string; summary: string }>): ButlerAgentExecutor {
  const calls: string[] = []
  return {
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async request => {
      calls.push(request.goal)
      const found = byGoal[request.goal]
      if (found === undefined) return { status: 'succeeded', summary: `${request.goal} 做好了` }
      if (found.status === 'waiting_user') {
        return { status: 'waiting_user', summary: found.summary, question: '采用哪一版？' }
      }
      if (found.status === 'failed') return { status: 'failed', summary: found.summary }
      return { status: 'succeeded', summary: found.summary }
    },
    // 测试用：看某一步到底有没有被派出去。
    ...({ dispatched: calls } as object),
  } as ButlerAgentExecutor
}

/** 某一步有没有真的派出去。 */
const dispatched = (executor: ButlerAgentExecutor): readonly string[] =>
  ((executor as unknown as { dispatched?: readonly string[] }).dispatched) ?? []

async function fixture(executor: ButlerAgentExecutor) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, store, '')
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
  const tasks = () => store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' }).items
  return { store, console_, agent, planTool, endTurn, tasks }
}

const plan = (subtasks: readonly Record<string, unknown>[], reply = '这就安排。') => ({ reply, note: '', subtasks })
const run = { signal: new AbortController().signal }

/** 派第一轮：甲成功、乙还在等人回话，任务因此停在未终结的状态，可以接着补充。 */
async function twoGoals(f: Awaited<ReturnType<typeof fixture>>) {
  await f.console_.start(conversationId, '写两篇稿子', actor)
  await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
  await f.planTool.execute(plan([
    { goal: '甲', agentId: 'blog', reason: '写作' },
    { goal: '乙', agentId: 'blog', reason: '写作' },
  ]), run)
  f.endTurn()
  await until(() => f.tasks().length === 1, '任务落库')
  const taskId = f.tasks()[0]!.id
  await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
  return taskId
}

describe('目标标识的分配', () => {
  it('首次计划里每条子任务各自是一个目标，标识按顺序分配', async () => {
    const f = await fixture(executorByGoal({ 乙: { status: 'waiting_user', summary: '候选稿' } }))
    const taskId = await twoGoals(f)
    const record = f.store.task(actor, taskId)!
    expect(record.subtasks.map(item => [item.id, item.logicalId, item.supersedes])).toEqual([
      ['s1', 'g1', ''],
      ['s2', 'g2', ''],
    ])
    f.store.close()
  })

  it('追加的新目标从现有最大值往下排，不与已有的撞号', async () => {
    const f = await fixture(executorByGoal({ 乙: { status: 'waiting_user', summary: '候选稿' } }))
    const taskId = await twoGoals(f)

    const supplement = f.console_.submitSupplement({ taskId, text: '再加一篇', actor })
    await until(() => f.agent.followup.mock.calls.length >= 2, '补充轮开始')
    await f.planTool.execute(plan([{ goal: '丙', agentId: 'blog', reason: '写作' }]), run)
    f.endTurn()
    await supplement
    await until(() => f.store.task(actor, taskId)!.subtasks.length === 3, '新目标追加进来')

    const added = f.store.task(actor, taskId)!.subtasks[2]!
    expect(added).toMatchObject({ id: 's3', logicalId: 'g3', supersedes: '' })
    f.store.close()
  })
})

describe('替代：同一目标的新尝试', () => {
  it('沿用旧目标的标识，并指向被替代的那一条', async () => {
    const f = await fixture(executorByGoal({ 乙: { status: 'waiting_user', summary: '候选稿' } }))
    const taskId = await twoGoals(f)

    const supplement = f.console_.submitSupplement({ taskId, text: '甲那篇重做一遍', actor })
    await until(() => f.agent.followup.mock.calls.length >= 2, '补充轮开始')
    await f.planTool.execute(plan([
      { goal: '甲（重做）', agentId: 'blog', reason: '重写', logicalId: 'g1', supersedes: 's1' },
    ]), run)
    f.endTurn()
    await supplement
    await until(() => f.store.task(actor, taskId)!.subtasks.length === 3, '新尝试落库')

    const attempt = f.store.task(actor, taskId)!.subtasks[2]!
    // 沿用旧目标、指向旧尝试：这样聚合时才知道这两条是同一个目标的两条尝试。
    expect(attempt).toMatchObject({ id: 's3', logicalId: 'g1', supersedes: 's1', state: 'succeeded' })
    // 旧尝试留在历史里，没有被改写。
    expect(f.store.task(actor, taskId)!.subtasks[0]).toMatchObject({ id: 's1', state: 'succeeded' })
    f.store.close()
  })

  it('指向不存在的旧尝试时当场拒绝，让大总管改了再来', async () => {
    const f = await fixture(executorByGoal({ 乙: { status: 'waiting_user', summary: '候选稿' } }))
    const taskId = await twoGoals(f)

    const supplement = f.console_.submitSupplement({ taskId, text: '甲重做', actor })
    await until(() => f.agent.followup.mock.calls.length >= 2, '补充轮开始')
    await expect(f.planTool.execute(plan([
      { goal: '甲（重做）', agentId: 'blog', reason: '', logicalId: 'g1', supersedes: 's9' },
    ]), run)).rejects.toThrow(/s9 不在这一轮里/u)
    f.endTurn()
    await supplement
    f.store.close()
  })

  it('还在进行的尝试不能被替代', async () => {
    const f = await fixture(executorByGoal({ 乙: { status: 'waiting_user', summary: '候选稿' } }))
    const taskId = await twoGoals(f)

    const supplement = f.console_.submitSupplement({ taskId, text: '乙重做', actor })
    await until(() => f.agent.followup.mock.calls.length >= 2, '补充轮开始')
    // 乙还等着用户回话：它没有结束，替代它是把一件还在进行的活抹掉。
    await expect(f.planTool.execute(plan([
      { goal: '乙（重做）', agentId: 'blog', reason: '', logicalId: 'g2', supersedes: 's2' },
    ]), run)).rejects.toThrow(/还没有结束/u)
    f.endTurn()
    await supplement
    f.store.close()
  })

  it('借替代把目标换掉也会被拒：那是另一个目标，该用新标识', async () => {
    const f = await fixture(executorByGoal({ 乙: { status: 'waiting_user', summary: '候选稿' } }))
    const taskId = await twoGoals(f)

    const supplement = f.console_.submitSupplement({ taskId, text: '换个目标', actor })
    await until(() => f.agent.followup.mock.calls.length >= 2, '补充轮开始')
    await expect(f.planTool.execute(plan([
      { goal: '完全不同的活', agentId: 'blog', reason: '', logicalId: 'g9', supersedes: 's1' },
    ]), run)).rejects.toThrow(/不能改成 g9/u)
    f.endTurn()
    await supplement
    f.store.close()
  })

  it('新的一轮里没有可替代的旧尝试，填了就拒绝', async () => {
    const f = await fixture(executorByGoal({}))
    await f.console_.start(conversationId, '写一篇稿子', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '开始理解')
    await expect(f.planTool.execute(plan([
      { goal: '甲', agentId: 'blog', reason: '', supersedes: 's1' },
    ]), run)).rejects.toThrow(/不要填 supersedes/u)
    f.endTurn()
    f.store.close()
  })

  it('同一次计划里同一个目标只能有一条尝试', async () => {
    const f = await fixture(executorByGoal({}))
    await f.console_.start(conversationId, '写一篇稿子', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '开始理解')
    // 两条都指向 g1 会互相替代，聚合时谁也不算数 —— 当场说清楚比事后查好。
    await expect(f.planTool.execute(plan([
      { goal: '甲', agentId: 'blog', reason: '', logicalId: 'g1' },
      { goal: '甲之二', agentId: 'blog', reason: '', logicalId: 'g1' },
    ]), run)).rejects.toThrow(/出现了不止一次/u)
    f.endTurn()
    f.store.close()
  })
})

describe('聚合只看有效尝试', () => {
  const subtask = (id: string, logicalId: string, supersedes: string, state: string): SubtaskRecord => ({
    id, seq: Number(id.slice(1)), logicalId, supersedes, dependsOn: [], goal: id, agentId: 'blog', reason: '',
    state: state as SubtaskRecord['state'], result: '', error: '', artifacts: [], conversationId: '',
    startedAt: null, finishedAt: null,
  })

  it('被替代掉的那条不算数，链末端的尝试才算', () => {
    const attempts = [
      subtask('s1', 'g1', '', 'failed'),
      subtask('s2', 'g1', 's1', 'succeeded'),
      subtask('s3', 'g2', '', 'waiting_user'),
    ]
    // g1 上失败过的第一条不该再参与结论：重试成功的那个才是这个目标的结果。
    expect(effectiveSubtasks(attempts).map(item => item.id)).toEqual(['s2', 's3'])
  })

  it('没有替代关系时原样返回', () => {
    const attempts = [subtask('s1', 'g1', '', 'succeeded'), subtask('s2', 'g2', '', 'failed')]
    expect(effectiveSubtasks(attempts).map(item => item.id)).toEqual(['s1', 's2'])
  })
})

describe('依赖：只有前置成功才派下一步', () => {
  /** 一步依赖另一步的计划。 */
  const chained = () => plan([
    { goal: '甲', agentId: 'blog', reason: '写作' },
    { goal: '乙', agentId: 'blog', reason: '写作', dependsOn: ['g1'] },
  ])

  async function startWith(executor: ButlerAgentExecutor) {
    const f = await fixture(executor)
    await f.console_.start(conversationId, '先甲后乙', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '大总管开始理解')
    await f.planTool.execute(chained(), run)
    f.endTurn()
    await until(() => f.tasks().length === 1, '任务落库')
    const taskId = f.tasks()[0]!.id
    // 子任务都终结之后还会跑一轮汇总，那一轮也要放掉才会落到终态。
    let released = false
    await until(() => {
      const state = f.store.task(actor, taskId)!.state
      if (state === 'summarizing' && !released) { released = true; f.endTurn(); return false }
      return state !== 'running' && state !== 'summarizing'
    }, '这一轮收尾')
    return { f, taskId }
  }

  it('前置成功时下一步照常派出去', async () => {
    const executor = executorByGoal({})
    const { f, taskId } = await startWith(executor)
    expect(dispatched(executor)).toEqual(['甲', '乙'])
    expect(f.store.task(actor, taskId)!.subtasks.map(item => item.state)).toEqual(['succeeded', 'succeeded'])
    f.store.close()
  })

  it('前置失败时下一步不派，并说清是哪一条没成', async () => {
    const executor = executorByGoal({ 甲: { status: 'failed', summary: '甲炸了' } })
    const { f, taskId } = await startWith(executor)

    // 关键：乙根本没有被派出去 —— 不该让员工去做一件前提不成立的事。
    expect(dispatched(executor)).toEqual(['甲'])
    const second = f.store.task(actor, taskId)!.subtasks[1]!
    expect(second.state).toBe('failed')
    expect(second.error).toContain('前置没有完成')
    expect(second.error).toContain('g1')
    expect(second.error).toContain('failed')
    f.store.close()
  })

  it('前置还在等人回话时同样不派', async () => {
    const executor = executorByGoal({ 甲: { status: 'waiting_user', summary: '候选稿' } })
    const { f, taskId } = await startWith(executor)

    expect(dispatched(executor)).toEqual(['甲'])
    const second = f.store.task(actor, taskId)!.subtasks[1]!
    expect(second.state).toBe('failed')
    expect(second.error).toContain('waiting_user')
    f.store.close()
  })

  it('前置带着外部待办时也不派：那件事还没办完', async () => {
    const executor: ButlerAgentExecutor = {
      protocol: 1, agentId: 'blog', capabilities: ['写作'],
      dispatch: async request => (request.goal === '甲'
        ? { status: 'external_pending', summary: '候选稿已交回', externalPending: { reason: '等你采用' } }
        : { status: 'succeeded', summary: '乙做好了' }),
    }
    const { f, taskId } = await startWith(executor)
    const second = f.store.task(actor, taskId)!.subtasks[1]!
    expect(second.state).toBe('failed')
    expect(second.error).toContain('external_pending')
    f.store.close()
  })

  it('依赖关系落库，能读出前置是哪一条', async () => {
    const f = await fixture(executorByGoal({}))
    await f.console_.start(conversationId, '先甲后乙', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '开始理解')
    await f.planTool.execute(chained(), run)
    f.endTurn()
    await until(() => f.tasks().length === 1, '任务落库')
    const taskId = f.tasks()[0]!.id
    let released = false
    await until(() => {
      const state = f.store.task(actor, taskId)!.state
      if (state === 'summarizing' && !released) { released = true; f.endTurn(); return false }
      return state !== 'running' && state !== 'summarizing'
    }, '这一轮收尾')
    const record = f.store.task(actor, taskId)!
    expect(record.subtasks[0]!.dependsOn).toEqual([])
    expect(record.subtasks[1]!.dependsOn).toEqual(['g1'])
    f.store.close()
  })

  it('引用不存在的目标、或把自己当前置，都在派活那一刻被拒', async () => {
    const f = await fixture(executorByGoal({}))
    await f.console_.start(conversationId, '先甲后乙', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '开始理解')

    await expect(f.planTool.execute(plan([
      { goal: '甲', agentId: 'blog', reason: '', dependsOn: ['g9'] },
    ]), run)).rejects.toThrow(/g9 不在这一轮里/u)

    await expect(f.planTool.execute(plan([
      { goal: '甲', agentId: 'blog', reason: '', logicalId: 'g1', dependsOn: ['g1'] },
    ]), run)).rejects.toThrow(/不能把自己当作前置/u)
    f.endTurn()
    f.store.close()
  })

  it('只能依赖排在它前面的目标，环因此不可能出现', async () => {
    const f = await fixture(executorByGoal({}))
    await f.console_.start(conversationId, '先甲后乙', actor)
    await until(() => f.agent.followup.mock.calls.length >= 1, '开始理解')
    // 第二条依赖第一条的标识：合法。
    await expect(f.planTool.execute(plan([
      { goal: '甲', agentId: 'blog', reason: '', logicalId: 'g1' },
      { goal: '乙', agentId: 'blog', reason: '', logicalId: 'g2', dependsOn: ['g1'] },
    ]), run)).resolves.toMatchObject({ accepted: true })

    // 第一条依赖后面那条：那时它还不存在。
    await expect(f.planTool.execute(plan([
      { goal: '丙', agentId: 'blog', reason: '', logicalId: 'g3', dependsOn: ['g4'] },
      { goal: '丁', agentId: 'blog', reason: '', logicalId: 'g4' },
    ]), run)).rejects.toThrow(/g4 不在这一轮里/u)
    f.endTurn()
    f.store.close()
  })
})
