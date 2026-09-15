import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ButlerClient, ButlerError, type ButlerStatus } from '../src/butler-client.ts'
import { ButlerStubServer, defaultSnapshot } from './butler-stub.ts'

/**
 * 管家契约消费测试：网络失败分支用本地桩验证；真实宿主行为另记，不在此冒充。
 */

let stub: ButlerStubServer
let statuses: ButlerStatus[]

beforeEach(async () => {
  stub = new ButlerStubServer()
  await stub.start()
  statuses = []
})
afterEach(async () => { await stub.close() })

const makeClient = (options: { delays?: number[] } = {}) => new ButlerClient({
  origin: stub.origin,
  delays: options.delays ?? [5, 5],
  onStatus: status => statuses.push(status),
})

describe('入口发现与只读接口', () => {
  it('identity 交出安全前缀后，后续请求改用返回的前缀', async () => {
    const client = makeClient()
    const found = await client.discover()
    expect(found.routePrefix).toBe('/fixture-butler')
    expect((await client.listConversations())[0]?.id).toBe('conv-1')
    expect((await client.history({ conversationId: 'conv-1' })).items[0]?.id).toBe('task-1')
    expect((await client.taskSnapshot('task-1')).goal).toBe('写博客')
    const run = await client.probe('conv-1')
    expect(run?.taskId).toBe('task-1')
  })

  it('契约版本不认得时拒绝继续并报 incompatible', async () => {
    stub.state.identityBody = { mode: 'authenticated', key: 'user:a', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 2 }
    const client = makeClient()
    await expect(client.discover()).rejects.toMatchObject({ kind: 'incompatible' })
    expect(statuses).toContain('incompatible')
    // 没有换前缀，后续读取仍然走默认前缀（桩上不存在）并失败，不误读别家接口。
    await expect(client.listConversations()).rejects.toBeInstanceOf(ButlerError)
  })

  it('路由前缀不安全时拒绝', async () => {
    stub.state.identityBody = { mode: 'authenticated', key: 'user:a', authPath: '/auth', routePrefix: '//evil', contractVersion: 1 }
    await expect(makeClient().discover()).rejects.toMatchObject({ kind: 'incompatible' })
  })

  it('未登录（401）归为 unauthorized', async () => {
    stub.state.identityStatus = 401
    await expect(makeClient().discover()).rejects.toMatchObject({ kind: 'unauthorized' })
  })

  it('迟到的旧身份发现结果不落地，不覆盖新身份', async () => {
    // A 的发现响应滞留 60ms；B 的发现立即返回。
    stub.state.identityBody = { mode: 'authenticated', key: 'user:slow', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }
    stub.state.identityDelayMs = 60
    const client = makeClient()
    const stale = client.discover()
    stub.state.identityBody = { mode: 'authenticated', key: 'user:fast', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }
    const fresh = await client.discover()
    expect(fresh.key).toBe('user:fast')
    // 旧结果后到：拒绝落地，客户端身份仍是新身份。
    await expect(stale).rejects.toMatchObject({ kind: 'stopped' })
    expect(client.identity?.key).toBe('user:fast')
    expect((await client.listConversations())[0]?.id).toBe('conv-1')
  })

  it('迟到的过期发现响应（不兼容）不污染当前状态', async () => {
    stub.state.identityBody = { mode: 'authenticated', key: 'user:slow', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }
    stub.state.identityDelayMs = 60
    const client = makeClient()
    const stale = client.discover()
    stub.state.identityBody = { mode: 'authenticated', key: 'user:fast', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 2 }
    // 新发现本身不兼容：这是当前状态，应当如实报错。
    await expect(client.discover()).rejects.toMatchObject({ kind: 'incompatible' })
    statuses.length = 0
    // 换回有效身份重试成功后，旧响应（也是不兼容）迟到返回：不得把状态改回不兼容。
    stub.state.identityBody = { mode: 'authenticated', key: 'user:fast', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }
    await client.discover()
    statuses.length = 0
    await expect(stale).rejects.toMatchObject({ kind: 'stopped' })
    expect(statuses).not.toContain('incompatible')
    expect(client.identity?.key).toBe('user:fast')
  })
})

describe('只读订阅', () => {
  it('正常一轮：run/事件/[DONE]，结束后不再重连', async () => {
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', seq: 6 },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 7 },
    ], done: true })
    const client = makeClient()
    const events: string[] = []
    let roundEnd = ''
    await client.observe('conv-1', 5, {
      onEvent: event => events.push(event.type),
      onReset: async () => {},
      onRoundEnd: state => { roundEnd = state },
    })
    expect(events).toEqual(['run', 'subtask', 'summary'])
    expect(roundEnd).toBe('running')
    expect(stub.state.subscriptions).toEqual([5])
    expect(statuses.at(-1)).toBe('ready')
  })

  it('断线（无 [DONE]）用最后 seq 续订，有界重连后成功', async () => {
    stub.state.streamQueue.push({ events: [{ type: 'run', runId: 'r', state: 'running', taskId: 'task-1' }, { type: 'subtask', id: 's1', state: 'running', seq: 6 }], done: false })
    stub.state.streamQueue.push({ events: [], done: true })
    const client = makeClient({ delays: [5, 5] })
    await client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} })
    expect(stub.state.subscriptions).toEqual([0, 6])
    expect(statuses).toContain('offline')
  })

  it('reset 先回调重读快照，再从窗口内还剩的最早一条续订', async () => {
    // 跳到日志头（seq=7）会连窗口里还留着的 5、6 一起略过——那些正文可能还没落库。
    stub.state.streamQueue.push({ events: [{ type: 'reset', runId: 'r', seq: 7, windowStart: 5 }], done: true })
    stub.state.streamQueue.push({ events: [], done: true })
    const client = makeClient()
    const reasons: string[] = []
    const infos: { seq: number; windowStart?: number }[] = []
    await client.observe('conv-1', 0, {
      onEvent: () => {},
      onReset: async (reason, info) => { reasons.push(reason); infos.push({ seq: info.seq, ...(info.windowStart === undefined ? {} : { windowStart: info.windowStart }) }) },
    })
    expect(reasons).toEqual(['reset'])
    // 恢复边界仍是日志头（快照覆盖到这里），续订点回到窗口左边缘之前。
    expect(infos).toEqual([{ seq: 7, windowStart: 5 }])
    expect(stub.state.subscriptions).toEqual([0, 4])
  })

  it('403/404 终止订阅且不重试，状态归为 forbidden', async () => {
    stub.state.streamQueue.push({ status: 403 })
    const client = makeClient()
    await client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} })
    expect(stub.state.subscriptions).toEqual([0])
    expect(statuses.at(-1)).toBe('forbidden')
  })

  it('空闲轮（run idle + [DONE]）正常结束', async () => {
    stub.state.streamQueue.push({ events: [{ type: 'run', runId: '', state: 'idle', taskId: '' }], done: true })
    const client = makeClient()
    let roundEnd = 'unset'
    await client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {}, onRoundEnd: state => { roundEnd = state } })
    expect(roundEnd).toBe('idle')
  })

  it('stop() 在重连等待中立即返回', async () => {
    stub.state.streamQueue.push({ events: [], done: false })
    const client = makeClient({ delays: [10_000] })
    const finished = client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} })
    await new Promise(resolve => setTimeout(resolve, 5))
    client.stop()
    await expect(finished).resolves.toBeUndefined()
    expect(statuses.at(-1)).toBe('stopped')
  })

  it('cancelObserve 只停观察流，客户端仍可读取', async () => {
    stub.state.streamQueue.push({ events: [], done: false })
    const client = makeClient({ delays: [10_000] })
    const finished = client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} })
    await new Promise(resolve => setTimeout(resolve, 5))
    client.cancelObserve()
    await expect(finished).resolves.toBeUndefined()
    expect((await client.listConversations()).length).toBe(1)
  })

  it('跨轮重连识别换轮：重读正确任务快照后从 0 重放当前轮', async () => {
    // 旧轮断线后管家开了新轮：新轮序号从 1 重新计数，旧游标会让服务端跳过新轮早期事件。
    // 客户端级测试不经历装载 probe；换轮时的一次 probe 返回新轮身份（新任务 task-2）。
    stub.state.probeQueue.push({ runId: 'run-new', state: 'running', taskId: 'task-2', seq: 5, windowStart: 1 })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-old', state: 'running', taskId: 'task-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', seq: 2, runId: 'run-old' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-new', state: 'running', taskId: 'task-2' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-new', state: 'running', taskId: 'task-2' },
      { type: 'plan', taskId: 'task-2', goal: '新目标', subtasks: [{ id: 's1', goal: '新第一步', agentId: 'blog' }] },
      { type: 'summary', taskId: 'task-2', text: '完成', state: 'completed', seq: 2, runId: 'run-new' },
    ], done: true })
    const client = makeClient()
    const events: string[] = []
    const resets: { reason: string; taskId: string }[] = []
    await client.observe('conv-1', 0, {
      onEvent: event => events.push(event.type + ':' + (event.taskId ?? '')),
      onReset: async (reason, info) => { resets.push({ reason, taskId: info.taskId }) },
    })
    // 订阅序列：初始 after=0 → 断线后 after=2 → 换轮从 0 重放当前轮。
    expect(stub.state.subscriptions).toEqual([0, 2, 0])
    // 恢复上下文带着新轮的任务身份，会话据此读新任务快照。
    expect(resets).toEqual([{ reason: 'round', taskId: 'task-2' }])
    // 重放的新轮事件（含旧游标会跳过的 plan）照常送达。
    expect(events).toContain('plan:task-2')
    expect(events).toContain('summary:task-2')
  })

  it('换轮时原轮已结束：按结束收敛，不再续订', async () => {
    stub.state.probeQueue.push(null)
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-old', state: 'running', taskId: 'task-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', seq: 2, runId: 'run-old' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-new', state: 'running', taskId: 'task-1' },
    ], done: false })
    const client = makeClient()
    let roundEnd = ''
    await client.observe('conv-1', 0, {
      onEvent: () => {},
      onReset: async () => {},
      onRoundEnd: state => { roundEnd = state },
    })
    expect(stub.state.subscriptions).toEqual([0, 2])
    expect(roundEnd).toBe('running')
    expect(statuses.at(-1)).toBe('ready')
  })
})

describe('快照形状', () => {
  it('默认快照可被消费端直接投影', () => {
    expect(defaultSnapshot.subtasks[0]?.id).toBe('s1')
    expect(defaultSnapshot.state).toBe('running')
  })
})
