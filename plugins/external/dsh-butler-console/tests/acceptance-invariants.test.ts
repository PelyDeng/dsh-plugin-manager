/**
 * 受理与收尾的并发不变量。
 *
 * 这五条来自独立验收复现的问题：既有用例全绿，但它们一条都没覆盖到 —— 都是在「两个入口
 * 同时动同一个任务」或者「受理与收尾交叉」的窗口里才会露出来。窗口很窄，真机上要靠运气撞，
 * 所以用确定性替身把窗口撑开，把不变量钉死。
 *
 * 每一条都对应一个真实后果：
 *
 * 1. 同一版本并发补充全被接受 → 两份互相矛盾的补充都落到同一轮里，版本涨到 3。
 * 2. 同一个 `requestId` 并发提交被调度两次 → 带外部副作用的活干两遍。
 * 3. 任务在打开会话的异步窗口里结束，补充仍被接受 → 终态任务被改。
 * 4. 补充已接受但没处理，任务报成完成 → 老板改的目标被丢掉，还被告诉活干完了。
 * 5. 运行中的幂等占位被超时清掉 → 那次请求随后重试会再执行一遍。
 *
 * 会话打开与会话泵都用替身：这里测的是**受理与记账**，不测模型执行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import { TaskStore } from '../src/store.ts'

const actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' } as const
const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const stores: TaskStore[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})

function fixture() {
  const store = new TaskStore(':memory:')
  stores.push(store)
  store.openOrReserveConversation(conversationId, actor)
  store.createTask({
    id: 'task-invariants', conversationId, actor, goal: '原来的目标', note: '',
    subtasks: [{ id: 's1', goal: '旧范围', agentId: 'blog', reason: '写作' }],
  })
  const concurrency = {
    idempotencyTtlMs: 600_000, maxConversationEvents: 200,
  } as Config
  const service = new ButlerConsole(
    {} as never, concurrency,
    { assert() {} } as never, store, '',
  )
  const conversation = { id: conversationId, active: false, lastUsedAt: Date.now(), handle: { agent: {} } }
  const open = vi.spyOn(service, 'open').mockImplementation(async () => conversation as never)
  // 执行泵换成记录函数：只看调度了几次，不跑模型。
  const pump = vi.spyOn(service as unknown as { pump: () => Promise<void> }, 'pump').mockResolvedValue(undefined)
  const task = () => store.task(actor, 'task-invariants')!
  return { store, service, open, pump, task, conversation }
}

describe('受理的并发不变量', () => {
  it('两个入口带同一版本并发补充，只接受一次', async () => {
    const f = fixture()
    const results = await Promise.allSettled(['第一条', '第二条'].map(text => f.service.submitSupplement({
      taskId: 'task-invariants', actor, text, expectVersion: 1, requestId: text,
    })))
    expect({
      accepted: results.filter(item => item.status === 'fulfilled').length,
      version: f.task().acceptedVersion,
    }).toEqual({ accepted: 1, version: 2 })
  })

  it('同一个 requestId 并发提交只调度一次、只接受一条输入', async () => {
    const f = fixture()
    const request = { taskId: 'task-invariants', actor, text: '同一句补充', requestId: 'same-id' }
    const results = await Promise.all([
      f.service.submitSupplement(request),
      f.service.submitSupplement(request),
    ])
    expect({
      // 两次调用给回的是**同一轮**的凭据，而不是各起一轮。
      runs: new Set(results.map(item => item.runId)).size,
      executions: f.pump.mock.calls.length,
      acceptedVersion: f.task().acceptedVersion,
    }).toEqual({ runs: 1, executions: 1, acceptedVersion: 2 })
  })

  it('受理失败时撤掉占位，同一个 requestId 还能再提交', async () => {
    const f = fixture()
    // 版本对不上：受理会失败。
    await expect(f.service.submitSupplement({
      taskId: 'task-invariants', actor, text: '版本不对', expectVersion: 9, requestId: 'retry-id',
    })).rejects.toThrowError(/第 1 版/u)
    // 占位必须撤掉：留着会把一次根本没开始的请求报成「结果不明」。
    expect(f.store.request(actor, 'supplement', 'retry-id')).toBeUndefined()
    expect(f.task().acceptedVersion).toBe(1)
    await expect(f.service.submitSupplement({
      taskId: 'task-invariants', actor, text: '这次对了', expectVersion: 1, requestId: 'retry-id',
    })).resolves.toMatchObject({ runId: expect.stringContaining('butler-run-') })
    expect(f.task().acceptedVersion).toBe(2)
  })

  it('任务在打开会话的窗口里结束，补充不再被接受', async () => {
    const f = fixture()
    // 打开会话是异步的，任务正好在这段时间里被收尾。
    f.open.mockImplementation(async () => {
      f.store.setTaskState('task-invariants', 'completed', { summary: '已经收尾了' })
      return f.conversation as never
    })
    const results = await Promise.allSettled([
      f.service.submitSupplement({ taskId: 'task-invariants', actor, text: '迟到的补充' }),
    ])
    expect({
      accepted: results.filter(item => item.status === 'fulfilled').length,
      version: f.task().acceptedVersion,
    }).toEqual({ accepted: 0, version: 1 })
  })

  it('运行中的幂等占位不会被超时清理掉', () => {
    const f = fixture()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    f.store.claimRequest(actor, 'chat', 'long-running', 'digest-a', 'run-a', conversationId, 600_000)
    // 超过重放保留期之后，另一笔提交触发了清理。
    now.mockReturnValue(1_600_001)
    f.store.claimRequest(actor, 'chat', 'another-request', 'digest-b', 'run-b', conversationId, 600_000)
    // 运行中的占位是「可能已经执行过」的唯一依据，清掉它等于把那次请求放行重跑。
    expect(f.store.request(actor, 'chat', 'long-running')?.state).toBe('claimed')
  })

  it('已完成的占位过了保留期会被清掉，表不会只涨不消', () => {
    const f = fixture()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    f.store.claimRequest(actor, 'chat', 'done-request', 'digest-a', 'run-a', conversationId, 600_000)
    f.store.finishRequest(actor, 'chat', 'done-request')
    now.mockReturnValue(1_600_001)
    f.store.claimRequest(actor, 'chat', 'another-request', 'digest-b', 'run-b', conversationId, 600_000)
    expect(f.store.request(actor, 'chat', 'done-request')).toBeUndefined()
  })
})

describe('收尾的输入屏障', () => {
  /** 把一条补充塞进库里而不起回合：模拟「已接受、还没处理」。 */
  const acceptOnly = (f: ReturnType<typeof fixture>) =>
    f.store.addInput(actor, 'task-invariants', '改了范围', 'supplement')

  it('补充还没处理时，收尾不写完成', async () => {
    const f = fixture()
    f.store.setSubtaskState('task-invariants', 's1', 'dispatched')
    f.store.setSubtaskState('task-invariants', 's1', 'succeeded', { result: '旧范围结果' })
    acceptOnly(f)
    const events: unknown[] = []
    for await (const event of (f.service as unknown as {
      closeTask: (input: unknown) => AsyncGenerator<unknown>
    }).closeTask({
      taskId: 'task-invariants', goal: '原来的目标',
      subtasks: [{ id: 's1', state: 'succeeded' }], reports: ['旧范围结果'],
      signal: new AbortController().signal, stopped: false,
    })) events.push(event)
    // 任务停在 running：这一轮没结账，剩下的交给那条输入自己的回合。
    expect({
      state: f.task().state, acceptedVersion: f.task().acceptedVersion, processedVersion: f.task().processedVersion,
    }).toEqual({ state: 'running', acceptedVersion: 2, processedVersion: 1 })
    expect(JSON.stringify(events)).toContain('先不结账')
  })

  it('输入都处理完了，正常写完成', async () => {
    const f = fixture()
    f.store.setSubtaskState('task-invariants', 's1', 'dispatched')
    f.store.setSubtaskState('task-invariants', 's1', 'succeeded', { result: '结果' })
    acceptOnly(f)
    f.store.setProcessedVersion('task-invariants', 2)
    for await (const _event of (f.service as unknown as {
      closeTask: (input: unknown) => AsyncGenerator<unknown>
    }).closeTask({
      taskId: 'task-invariants', goal: '原来的目标',
      subtasks: [{ id: 's1', state: 'succeeded' }], reports: ['结果'],
      signal: new AbortController().signal, stopped: false,
    })) { /* 事件内容不在这里断言。 */ }
    expect(f.task().state).toBe('completed')
  })

  it('被取消时可以带着未处理的输入结束，但不报成完成', async () => {
    const f = fixture()
    f.store.setSubtaskState('task-invariants', 's1', 'dispatched')
    f.store.setSubtaskState('task-invariants', 's1', 'cancelled', { error: '已停止' })
    acceptOnly(f)
    for await (const _event of (f.service as unknown as {
      closeTask: (input: unknown) => AsyncGenerator<unknown>
    }).closeTask({
      taskId: 'task-invariants', goal: '原来的目标',
      subtasks: [{ id: 's1', state: 'cancelled' }], reports: [],
      signal: new AbortController().signal, stopped: true,
    })) { /* 同上。 */ }
    expect(f.task().state).toBe('cancelled')
  })

  it('汇总跑到一半进来的补充，让这份结论作废（写入与核对同事务）', async () => {
    const f = fixture()
    f.store.setSubtaskState('task-invariants', 's1', 'dispatched')
    f.store.setSubtaskState('task-invariants', 's1', 'succeeded', { result: '旧范围结果' })
    /**
     * 汇总那一轮是异步的：这里用替身把「跑到一半」这一刻撑开，让补充正好落在这段窗口里。
     * 只在汇总开始前核对是不够的 —— 那份结论按旧范围总结，写下去就等于用旧结论盖住新目标。
     */
    const console_ = f.service as unknown as {
      summarize: (...args: unknown[]) => AsyncGenerator<unknown>
      closeTask: (input: unknown) => AsyncGenerator<unknown>
    }
    console_.summarize = async function* () {
      expect(f.task().state).toBe('summarizing')
      await Promise.resolve()
      f.store.addInput(actor, 'task-invariants', '改成上周', 'supplement', 1)
      yield { type: 'chat', role: 'butler', text: '按旧范围写的结论', time: Date.now() }
    }
    const events: { type?: string; text?: string }[] = []
    for await (const event of console_.closeTask({
      taskId: 'task-invariants', conversation: { id: conversationId }, goal: '原来的目标',
      subtasks: f.task().subtasks, reports: ['旧范围结果'],
      signal: new AbortController().signal, stopped: false,
    })) events.push(event as { type?: string })
    const task = f.task()
    expect({
      terminal: ['completed', 'partial', 'external_pending'].includes(task.state),
      accepted: task.acceptedVersion, processed: task.processedVersion,
    }).toEqual({ terminal: false, accepted: 2, processed: 1 })
    // 结论不冒充最终答复：没有 summary 事件，只有一句「先当草稿」。
    expect(events.some(event => event.type === 'summary')).toBe(false)
    expect(events.some(event => event.type === 'chat' && (event.text ?? '').includes('先当草稿'))).toBe(true)
    // 任务回到执行中，由那条补充自己的回合继续 —— 停在「在写总结」等于骗人。
    expect(task.state).toBe('running')
  })
})
