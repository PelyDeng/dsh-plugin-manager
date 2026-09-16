import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ButlerClient, ButlerError, RECONNECT_DELAYS, reconnectDelay, type ButlerStatus } from '../src/butler-client.ts'
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

const makeClient = (options: { delays?: number[]; writeAcceptTimeoutMs?: number } = {}) => new ButlerClient({
  origin: stub.origin,
  delays: options.delays ?? [5, 5],
  writeAcceptTimeoutMs: options.writeAcceptTimeoutMs,
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

  it('并发 observe 只启动一条订阅循环：输家立即让位，不产生孤儿观察', async () => {
    // 修复前：守卫检查与置 observing=true 之间隔着 ensureDiscovered 的 await，
    // 两个并发 observe 都能穿过守卫各自开循环，先启动的成为孤儿（observeAbort 只指向后者）。
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 2, runId: 'run-1' },
    ], done: true })
    const client = makeClient()
    const eventsA: string[] = []
    const eventsB: string[] = []
    const results = await Promise.allSettled([
      client.observe('conv-1', 0, { onEvent: event => eventsA.push(event.type), onReset: async () => {} }),
      client.observe('conv-1', 0, { onEvent: event => eventsB.push(event.type), onReset: async () => {} }),
    ])
    // 恰好一条观察赢下守卫并消费事件；另一条同步让位，不是各开一条订阅。
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(Error)
    expect(rejected[0]?.reason.message).toBe('已有观察流在运行')
    expect(eventsA.length + eventsB.length).toBe(2) // run + summary 只送进一条 handlers
    expect(stub.state.subscriptions).toEqual([0])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.subscriptions).toEqual([0]) // 没有孤儿循环再续订
    expect(client.isObserving).toBe(false)
  })

  it('观察前的发现失败回退占位，后续 observe 可重新进入', async () => {
    stub.state.identityStatus = 401
    const client = makeClient()
    await expect(client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'unauthorized' })
    expect(client.isObserving).toBe(false)
    stub.state.identityStatus = 200
    stub.state.streamQueue.push({ events: [], done: true })
    await expect(client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} })).resolves.toBeUndefined()
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

describe('写链路', () => {
  it('提交受理：onAccepted 先行，事件按序送达并以本轮结束收尾', async () => {
    stub.state.chatQueue.push({ events: [
      { type: 'conversation', conversationId: 'conv-1' },
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 2, runId: 'run-1' },
    ], done: true })
    const client = makeClient()
    const order: string[] = []
    await client.submitChat('conv-1', '写博客', 'req-1', {
      onEvent: event => order.push(event.type),
      onReset: async () => {},
      onRoundEnd: state => order.push('end:' + state),
    }, { onAccepted: () => order.push('accepted') })
    expect(order).toEqual(['accepted', 'conversation', 'run', 'summary', 'end:running'])
    // 请求体携带幂等标识；归属由服务端从登录身份判定，客户端不提交 owner。
    expect(stub.state.chatRequests).toEqual([{ conversationId: 'conv-1', message: '写博客', requestId: 'req-1' }])
  })

  it('回复成员：请求体按 decideByAgent 分形状', async () => {
    stub.state.replyQueue.push({ events: [{ type: 'run', runId: 'run-r', state: 'running', taskId: 'task-1' }], done: true })
    const client = makeClient()
    await client.submitReply({ conversationId: 'conv-1', taskId: 'task-1', subtaskId: 's1', text: '你看着办', decideByAgent: true, requestId: 'req-2' }, { onEvent: () => {}, onReset: async () => {} })
    expect(stub.state.replyRequests[0]).toEqual({ taskId: 'task-1', subtaskId: 's1', decideByAgent: true, requestId: 'req-2' })
  })

  it('受理后事件流中断：不重新提交，转只读订阅从最后序号续上', async () => {
    stub.state.chatQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', seq: 2, runId: 'run-1' },
    ], cut: true })
    stub.state.streamQueue.push({ events: [
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 3, runId: 'run-1' },
    ], done: true })
    const client = makeClient()
    await client.submitChat('conv-1', '写博客', 'req-1', { onEvent: () => {}, onReset: async () => {} })
    // 只提交过一次；断流后由只读订阅接管。
    expect(stub.state.chatRequests).toHaveLength(1)
    expect(stub.state.subscriptions).toEqual([2])
  })

  it('写流里的 reset：先回调重读快照，再转只读订阅从窗口左边缘之前续订', async () => {
    stub.state.chatQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'reset', runId: 'run-1', seq: 6, windowStart: 4 },
    ], done: true })
    stub.state.streamQueue.push({ events: [], done: true })
    const client = makeClient()
    const infos: { seq: number; windowStart?: number }[] = []
    await client.submitChat('conv-1', '写博客', 'req-1', {
      onEvent: () => {},
      onReset: async (_reason, info) => { infos.push({ seq: info.seq, ...(info.windowStart === undefined ? {} : { windowStart: info.windowStart }) }) },
    })
    expect(infos).toEqual([{ seq: 6, windowStart: 4 }])
    expect(stub.state.subscriptions).toEqual([3])
  })

  it('409 按冲突归类并保留服务端稳定码（version_conflict / run_result_unknown）', async () => {
    stub.state.chatQueue.push({ status: 409, body: { error: '这一轮已经更新到第 2 版，请按最新内容重新提交', code: 'version_conflict' } })
    const client = makeClient()
    await expect(client.submitChat('conv-1', '写博客', 'req-1', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'conflict', code: 'version_conflict' })
    stub.state.chatQueue.push({ status: 409, body: { error: '这次提交的结果不明，不会重新执行', code: 'run_result_unknown', runId: 'run-x', conversationId: 'conv-1' } })
    await expect(client.submitChat('conv-1', '写博客', 'req-2', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'conflict', code: 'run_result_unknown' })
    // 两类都是明确答复：客户端不重发。
    expect(stub.state.chatRequests).toHaveLength(2)
  })

  it('403 归为 forbidden', async () => {
    stub.state.chatQueue.push({ status: 403, body: { error: '请求来源不受信任', code: 'forbidden' } })
    await expect(makeClient().submitChat('conv-1', '写博客', 'req-1', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'forbidden' })
  })

  it('响应未知（连接被断开）：归为 unknown，不自动重试', async () => {
    stub.state.chatQueue.push({ destroy: true })
    await expect(makeClient().submitChat('conv-1', '写博客', 'req-1', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'unknown' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.chatRequests).toHaveLength(1)
  })

  it('响应未知（受理超时）：归为 unknown', async () => {
    stub.state.chatQueue.push({ hang: true })
    const client = makeClient({ writeAcceptTimeoutMs: 40 })
    await expect(client.submitChat('conv-1', '写博客', 'req-1', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'unknown' })
    expect(stub.state.chatRequests).toHaveLength(1)
  })

  it('stop：accepted 与幂等空操作都不是错误；不重试', async () => {
    const client = makeClient()
    expect(await client.requestStop('conv-1', 'task-1')).toEqual({ accepted: true, reason: '' })
    stub.state.stopPlan = { body: { ok: true, accepted: false, reason: '这个任务已经不在执行了' } }
    expect(await client.requestStop('conv-1', 'task-1')).toEqual({ accepted: false, reason: '这个任务已经不在执行了' })
    expect(stub.state.stopRequests).toEqual([
      { conversationId: 'conv-1', taskId: 'task-1' },
      { conversationId: 'conv-1', taskId: 'task-1' },
    ])
  })

  it('stop 的 404 归为 forbidden、连接断开归为 unknown；都不重发', async () => {
    stub.state.stopPlan = { status: 404, body: { error: '任务不存在或无权访问', code: 'not_found' } }
    await expect(makeClient().requestStop('conv-1', 'task-1')).rejects.toMatchObject({ kind: 'forbidden' })
    stub.state.stopPlan = { destroy: true }
    await expect(makeClient().requestStop('conv-1', 'task-1')).rejects.toMatchObject({ kind: 'unknown' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.stopRequests).toHaveLength(2)
  })

  it('stop 的 500 归为 http（不伪装成幂等空操作）；不重发', async () => {
    stub.state.stopPlan = { status: 500, body: { error: '服务处理请求失败' } }
    await expect(makeClient().requestStop('conv-1', 'task-1')).rejects.toMatchObject({ kind: 'http', status: 500 })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.stopRequests).toHaveLength(1)
  })
})

/**
 * 第五切片：有界重连/取消（退避上限、取消语义、断流不重发写请求）。
 * 写链路的「不重发」与「幂等重试不重复执行」分别由请求次数与桩的执行次数断言。
 */
describe('有界重连与取消', () => {
  it('退避序列逐级增长、末项即上限（不无限增长）', () => {
    // 默认 1/2/5/10 秒；第 5 次及以后一直停在末项。
    expect([0, 1, 2, 3, 4, 9, 100].map(attempt => reconnectDelay(RECONNECT_DELAYS, attempt)))
      .toEqual([1000, 2000, 5000, 10000, 10000, 10000, 10000])
    // 序列只有一项时（测试注入的短退避）永不增长；空序列不等待。
    expect([0, 5].map(attempt => reconnectDelay([7], attempt))).toEqual([7, 7])
    expect(reconnectDelay([], 3)).toBe(0)
  })

  it('连续断线一直重连：每次都用最后 seq 续订，间隔不增长', async () => {
    for (let index = 0; index < 4; index++) {
      stub.state.streamQueue.push({ events: [{ type: 'subtask', id: 's1', state: 'running', seq: index + 1, runId: 'run-1' }], done: false })
    }
    stub.state.streamQueue.push({ events: [], done: true })
    const client = makeClient({ delays: [5, 5] })
    const seen: number[] = []
    await client.observe('conv-1', 0, {
      onEvent: event => seen.push(event.seq ?? 0),
      onReset: async () => {},
    })
    // 五次订阅：0 → 1 → 2 → 3 → 4，最后一次正常收尾。
    expect(stub.state.subscriptions).toEqual([0, 1, 2, 3, 4])
    expect(seen).toEqual([1, 2, 3, 4])
    expect(statuses.at(-1)).toBe('ready')
  })

  it('重连等待中 cancelObserve：立即返回且不再续订（不产生孤儿循环）', async () => {
    stub.state.streamQueue.push({ events: [{ type: 'subtask', id: 's1', state: 'running', seq: 3 }], done: false })
    const client = makeClient({ delays: [10_000] })
    const finished = client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.subscriptions).toEqual([0])
    client.cancelObserve()
    await expect(finished).resolves.toBeUndefined()
    expect(client.isObserving).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stub.state.subscriptions).toEqual([0]) // 取消后没有再次续订
  })

  it('取消后再观察：按新游标重新订阅，互不干扰', async () => {
    stub.state.streamQueue.push({ events: [], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 9, runId: 'run-1' },
    ], done: true })
    const client = makeClient({ delays: [10_000] })
    const first = client.observe('conv-1', 0, { onEvent: () => {}, onReset: async () => {} })
    await new Promise(resolve => setTimeout(resolve, 30))
    client.cancelObserve()
    await first
    let roundEnd = ''
    await client.observe('conv-1', 8, { onEvent: () => {}, onReset: async () => {}, onRoundEnd: state => { roundEnd = state } })
    expect(stub.state.subscriptions).toEqual([0, 8])
    expect(roundEnd).toBe('running')
  })

  it('断流不重发写请求：受理后流断掉只续订，不重新提交（幂等记录只有一次执行）', async () => {
    // 「断流不重发写请求」的证据在这里：本用例真的发过一次写、真的断过流，
    // 请求次数与执行次数都有区分度（游戏层那条断流用例全程没有写请求，只断言续订）。
    stub.state.chatQueue.push({ events: [
      { type: 'conversation', conversationId: 'conv-1' },
      { type: 'run', runId: 'run-cut', state: 'running', taskId: '', seq: 0 },
      { type: 'subtask', taskId: 'task-cut', id: 's1', state: 'running', seq: 2, runId: 'run-cut' },
    ], cut: true })
    stub.state.streamQueue.push({ events: [
      { type: 'summary', taskId: 'task-cut', text: '完成', state: 'completed', seq: 3, runId: 'run-cut' },
    ], done: true })
    const client = makeClient({ delays: [5] })
    const events: string[] = []
    await client.submitChat('conv-1', '写博客', 'req-cut', {
      onEvent: event => events.push(event.type),
      onReset: async () => {},
    })
    expect(events).toContain('summary')
    expect(stub.state.chatRequests).toHaveLength(1) // 断流后没有重新提交
    expect(stub.state.chatExecutions).toBe(1)
    // 续订带着最后读到的序号。
    expect(stub.state.subscriptions).toEqual([2])
    // 再过一段时间仍然只有这一份提交：重连与收尾的后续路径都不会补发写请求。
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(stub.state.chatRequests).toHaveLength(1)
    expect(stub.state.chatExecutions).toBe(1)
  })

  it('受理后响应丢失：手动重试同 requestId 只执行一次，回放首次那一轮', async () => {
    // 第一份剧本受理成立（这一轮在服务端跑），但响应没送到：客户端只能按结果不明处理。
    stub.state.chatQueue.push({ events: [
      { type: 'conversation', conversationId: 'conv-1' },
      { type: 'run', runId: 'run-unknown', state: 'running', taskId: '', seq: 0 },
      { type: 'summary', taskId: 'task-unknown', text: '完成', state: 'completed', seq: 1, runId: 'run-unknown' },
    ], acceptThenDestroy: true, done: true })
    const client = makeClient({ delays: [5] })
    await expect(client.submitChat('conv-1', '写博客', 'req-unknown', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'unknown' })
    expect(stub.state.chatExecutions).toBe(1)
    // 手动重试同一份提交：同一个 runId 的事件流从头回放，执行次数不增加。
    const events: { type: string; runId?: string }[] = []
    let ended = ''
    await client.submitChat('conv-1', '写博客', 'req-unknown', {
      onEvent: event => events.push({ type: event.type, ...(event.runId === undefined ? {} : { runId: event.runId }) }),
      onReset: async () => {},
      onRoundEnd: state => { ended = state },
    })
    expect(stub.state.duplicateSubmits).toEqual(['req-unknown'])
    expect(stub.state.chatExecutions).toBe(1)
    expect(events[0]).toEqual({ type: 'conversation' })
    expect(events.find(event => event.type === 'run')?.runId).toBe('run-unknown')
    expect(events.at(-1)?.type).toBe('summary')
    // onRoundEnd 报的是**观察流的头部状态**（这里回放里只有一条 running 头）；权威终态由投影从 summary 得出。
    expect(ended).toBe('running')
    expect(stub.state.chatRequests).toHaveLength(2) // 两次请求都是同一份内容
  })

  it('同 requestId 换正文：409 idempotency_conflict，不执行也不覆盖首次那一轮', async () => {
    stub.state.chatQueue.push({ events: [
      { type: 'run', runId: 'run-first', state: 'running', taskId: '' },
      { type: 'summary', taskId: 'task-first', text: '完成', state: 'completed', seq: 1, runId: 'run-first' },
    ], done: true })
    const client = makeClient()
    await client.submitChat('conv-1', '写博客', 'req-same', { onEvent: () => {}, onReset: async () => {} })
    await expect(client.submitChat('conv-1', '写别的', 'req-same', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'conflict', code: 'idempotency_conflict' })
    expect(stub.state.chatExecutions).toBe(1)
    expect(stub.state.duplicateSubmits).toEqual([]) // 换了正文不是同一次提交，不算幂等重放
  })

  it('受理后未终态且日志已不可回放：同 requestId 重试回 409 run_result_unknown，不重新执行', async () => {
    // 受理成立（这一轮在服务端跑），但响应没有送到：结果不明；随后事件日志不可回放
    // （契约里 claimed 的那一行：受理过、没有终态证据，重试只能读快照）。
    stub.state.chatQueue.push({ acceptThenDestroy: true, lostLog: true, events: [
      { type: 'conversation', conversationId: 'conv-1' },
      { type: 'run', runId: 'run-claimed', state: 'running', taskId: '' },
    ] })
    const client = makeClient()
    await expect(client.submitChat('conv-1', '写博客', 'req-claimed', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'unknown' })
    expect(stub.state.chatExecutions).toBe(1)
    // 重试同一份提交：没有过程可回放，管家按稳定码拒绝；错误里带着原凭据供读快照。
    await expect(client.submitChat('conv-1', '写博客', 'req-claimed', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'conflict', code: 'run_result_unknown', status: 409 })
    expect(stub.state.chatExecutions).toBe(1)
    expect(stub.state.duplicateSubmits).toEqual([]) // 没有回放，也没有重跑
  })

  it('那一轮已跑完但日志已不可回放：同 requestId 重试回 409 run_already_finished', async () => {
    stub.state.chatQueue.push({ lostLog: true, done: true, events: [
      { type: 'conversation', conversationId: 'conv-1' },
      { type: 'run', runId: 'run-done', state: 'running', taskId: '' },
      { type: 'summary', taskId: 'task-done', text: '完成', state: 'completed', seq: 1, runId: 'run-done' },
    ] })
    const client = makeClient()
    await client.submitChat('conv-1', '写博客', 'req-done', { onEvent: () => {}, onReset: async () => {} })
    expect(stub.state.chatExecutions).toBe(1)
    // 重试同一份提交：那一轮有终态证据（summary），但没有可回放的日志。
    await expect(client.submitChat('conv-1', '写博客', 'req-done', { onEvent: () => {}, onReset: async () => {} }))
      .rejects.toMatchObject({ kind: 'conflict', code: 'run_already_finished', status: 409 })
    expect(stub.state.chatExecutions).toBe(1)
    expect(stub.state.duplicateSubmits).toEqual([])
  })
})
