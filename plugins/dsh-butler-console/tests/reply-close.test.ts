/**
 * 等待材料与补话收尾。
 *
 * 两条都是真实缺陷，而且都要走完「派活 → 等回话 → 补话 → 收尾」才看得见，所以这里用
 * 真实的 `ButlerConsole` 加真实的 SQLite 索引，只把宿主 Agent、执行方和登录换成替身：
 *
 * 1. 成员交回材料并说「等你答复」时，材料必须落库。之前这里只写了状态，材料只活在事件流
 *    和一个进程内的等待表里，刷新还看得见、重启就只剩一句追问。
 * 2. 老板答复完最后一位成员、那位成员也干完之后，这一轮必须收尾并给出结论。之前
 *    `waiting_user` 是条死路：补话把子任务送终了，任务却永远停在「等人回话」。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { TaskStore } from '../src/store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

/** 目录与调度入口：`runTurn` 读名单，`resolveExecutor` 找执行入口。 */
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
 * 装好一轮完整的协作。
 *
 * `planTool` 是牛马大总管真正会调用的那个派活工具：从 `setup()` 里取出来手动执行，
 * 而不是绕过它直接往内部计划表里塞数据 —— 这样「模型给出计划」这一步也走的是真代码。
 */
async function fixture(executor: ButlerAgentExecutor, options: { waitingTimeoutMs?: number } = {}) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: options.waitingTimeoutMs ?? 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, store, '')

  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, unknown>
  }
  // 会话归属仍然按真实路径登记：后面的任务写库要过 assertOwner 这一关。
  // 会话句柄也要进 `conversations`：真实的 `open()` 会登记它，而补话收尾时要靠它找汇总会话。
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
  return { console_, agent, store, planTool, endTurn, tasks }
}

/** 派一个活，让它走到「等人回话」。 */
async function dispatchUntilWaiting(f: Awaited<ReturnType<typeof fixture>>) {
  await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
  await until(() => f.agent.followup.mock.calls.length === 1, '大总管开始理解')

  await f.planTool.execute({
    reply: '我先让博客起一版，写完给你过目。',
    note: '',
    subtasks: [{ goal: '起草园区封闭化管理介绍，给出候选稿', agentId: 'blog', reason: '博客负责写作' }],
  }, { signal: new AbortController().signal })
  f.endTurn()

  await until(() => f.tasks().length === 1, '任务落库')
  const taskId = f.tasks()[0]!.id
  await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')
  return taskId
}

describe('成员交回材料但还等着答复', () => {
  it('材料落在子任务上，刷新和重启都还找得回来', async () => {
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({
        status: 'waiting_user',
        summary: '候选稿第一版与第二版都已交回，等你确认采用哪一版。',
        question: '采用第一版还是第二版？',
      }),
    }
    const f = await fixture(executor)
    const taskId = await dispatchUntilWaiting(f)

    const subtask = f.store.task(actor, taskId)!.subtasks[0]!
    expect(subtask.state).toBe('waiting_user')
    // 关键：材料在库里，不只在事件流里。
    expect(subtask.result).toBe('候选稿第一版与第二版都已交回，等你确认采用哪一版。')
    // 任务级摘要从子任务记录重建，所以这一轮交回的材料在这里也读得到。
    // 全部成员都在等待时，之前这里会是空的 —— 一份材料都没有的等待记录，读起来像是
    // 这一轮什么都没做。
    expect(f.store.task(actor, taskId)!.summary).toContain('候选稿第一版与第二版都已交回')

    f.store.close()
  })
})

describe('补话之后这一轮要能收尾', () => {
  it('最后一位成员干完，任务给出结论而不是永远停在等人回话', async () => {
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({
        status: 'waiting_user',
        summary: '候选稿第一版与第二版都已交回，等你确认采用哪一版。',
        question: '采用第一版还是第二版？',
      }),
      reply: async () => ({ status: 'succeeded', summary: '已按第二版定稿，正文与配图说明一并交付。' }),
    }
    const f = await fixture(executor)
    const taskId = await dispatchUntilWaiting(f)

    await f.console_.startReply({ taskId, subtaskId: 's1', text: '采用第二版', decideByAgent: false, actor })
    // 补话送走了最后一位成员，于是要跑一轮汇总。
    await until(() => f.agent.followup.mock.calls.length === 2, '汇总轮开始')
    f.endTurn()

    await until(() => f.store.task(actor, taskId)!.state === 'completed', '任务收尾')
    const record = f.store.task(actor, taskId)!
    expect(record.subtasks[0]!.state).toBe('succeeded')
    expect(record.subtasks[0]!.result).toBe('已按第二版定稿，正文与配图说明一并交付。')
    // 结论来自真实汇总轮的材料重建，而不是一句「已完成」的占位。
    expect(record.summary).toContain('已按第二版定稿')
    expect(record.finishedAt).not.toBeNull()

    f.store.close()
  })

  it('同一个 requestId 重复补话只送达一次', async () => {
    const reply = vi.fn(async () => ({ status: 'succeeded' as const, summary: '已按第二版定稿。' }))
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({ status: 'waiting_user', summary: '两份候选稿', question: '采用哪一版？' }),
      reply,
    }
    const f = await fixture(executor)
    const taskId = await dispatchUntilWaiting(f)
    const request = { taskId, subtaskId: 's1', text: '采用第二版', decideByAgent: false, actor, requestId: 'reply-1' }

    const first = await f.console_.startReply(request)
    await until(() => f.agent.followup.mock.calls.length === 2, '汇总轮开始')
    f.endTurn()
    await until(() => f.store.task(actor, taskId)!.state === 'completed', '任务收尾')

    // 重试拿到的是同一轮。若没有幂等，这一步会因为在不是 waiting_user 的子任务上补话而报错，
    // 客户端于是把一次成功的补话误判成失败。
    const retry = await f.console_.startReply(request)
    expect(retry.runId).toBe(first.runId)
    expect(reply).toHaveBeenCalledTimes(1)

    f.store.close()
  })

  it('还有人没答复时不收尾，任务继续停在等人回话', async () => {
    let round = 0
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      // 两位成员依次派活时它只接第一位：第二位仍然返回等待，任务就不该收尾。
      dispatch: async () => ({ status: 'waiting_user', summary: `第 ${round += 1} 份材料`, question: '这版可以吗？' }),
      reply: async () => ({ status: 'waiting_user', summary: '还有一处需要你定：标题用哪个。', question: '标题用哪个？' }),
    }
    const f = await fixture(executor)
    await f.console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
    await until(() => f.agent.followup.mock.calls.length === 1, '大总管开始理解')
    await f.planTool.execute({
      reply: '我安排两版对照。',
      note: '',
      subtasks: [
        { goal: '起草正文', agentId: 'blog', reason: '写作' },
        { goal: '起草配图说明', agentId: 'blog', reason: '写作' },
      ],
    }, { signal: new AbortController().signal })
    f.endTurn()

    await until(() => f.tasks().length === 1, '任务落库')
    const taskId = f.tasks()[0]!.id
    await until(() => f.store.task(actor, taskId)?.state === 'waiting_user', '停在等人回话')

    // 答复第一位，它又问了一个问题：任务仍然不该收尾。
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '正文可以', decideByAgent: false, actor })
    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'waiting_user', '第一位又问了一句')
    expect(f.store.task(actor, taskId)!.state).toBe('waiting_user')
    // 没有跑汇总轮：followup 仍然只有最初那一次。
    expect(f.agent.followup).toHaveBeenCalledTimes(1)

    f.store.close()
  })
})

describe('没人回话的等待不能永远挂着', () => {
  const waiting = (): ButlerAgentExecutor => ({
    protocol: 1,
    agentId: 'blog',
    capabilities: ['写作'],
    dispatch: async () => ({ status: 'waiting_user', summary: '两份候选稿都在这里', question: '采用哪一版？' }),
    reply: async () => ({ status: 'succeeded', summary: '已按第二版定稿。' }),
  })

  it('到点收成超时失败，材料一个字都不丢', async () => {
    const f = await fixture(waiting(), { waitingTimeoutMs: 40 })
    const taskId = await dispatchUntilWaiting(f)

    await until(() => f.store.task(actor, taskId)!.subtasks[0]!.state === 'failed', '等待超时')

    const record = f.store.task(actor, taskId)!
    // 子任务：失败 + 说明，但材料（result）原样留着 —— 超时不该把员工交回的东西抹掉。
    expect(record.subtasks[0]!.result).toBe('两份候选稿都在这里')
    expect(record.subtasks[0]!.error).toContain('已经过期')
    // 任务：唯一一位成员超时，这一轮也随之收尾，不再挂着占位。
    expect(record.state).toBe('failed')
    expect(record.summary).toContain('两份候选稿都在这里')
    expect(record.finishedAt).not.toBeNull()

    f.store.close()
  })

  it('用户回话之后闹钟就撤了，不会把一个已经跑完的活改成超时', async () => {
    const f = await fixture(waiting(), { waitingTimeoutMs: 60 })
    const taskId = await dispatchUntilWaiting(f)
    // 在超时之前回话，成员接着干完。
    await f.console_.startReply({ taskId, subtaskId: 's1', text: '采用第二版', decideByAgent: false, actor })
    await until(() => f.agent.followup.mock.calls.length === 2, '汇总轮开始')
    f.endTurn()
    await until(() => f.store.task(actor, taskId)!.state === 'completed', '任务收尾')

    // 等过原来的超时点：状态必须还是完成，没有被那次等待的闹钟改回去。
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.store.task(actor, taskId)!.state).toBe('completed')
    expect(f.store.task(actor, taskId)!.subtasks[0]!.state).toBe('succeeded')

    f.store.close()
  })
})
