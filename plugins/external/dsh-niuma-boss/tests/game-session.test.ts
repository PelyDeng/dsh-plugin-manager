import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { GameSession } from '../src/game-session.ts'
import { useTaskBookStore } from '../src/store.ts'
import { ButlerStubServer, defaultSnapshot } from './butler-stub.ts'

/**
 * 身份与归属边界：换登录人、空会话列表、登录失效、订阅授权失效、旧响应迟到
 * 都必须清空或丢弃旧用户的任务投影与历史，不保留可能属于他人的数据。
 * 世界模块带 Phaser（需要真实 DOM），会话层测试 mock 掉，不启动渲染。
 */

vi.mock('../src/game-world.ts', () => ({
  GameWorld: class {
    start() { return {} }
    pause() {}
    resume() {}
    destroy() {}
  },
}))

let stub: ButlerStubServer
let origin: string

beforeEach(async () => {
  setActivePinia(createPinia())
  stub = new ButlerStubServer()
  origin = await stub.start()
})
afterEach(async () => { await stub.close() })

const makeSession = () => new GameSession({
  parent: {} as HTMLElement, // 世界已 mock，挂载点不会真的被使用
  assetsBase: '/niuma-boss/generated/',
  butler: { origin, delays: [5, 5] },
})

describe('身份与归属边界', () => {
  it('正常装载：任务本展示当前用户的权威数据', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    expect(store.conversations).toHaveLength(1)
    expect(store.task.goal).toBe('写博客')
    expect(store.task.subtasks[0]?.text).toBe('草稿写到一半')
    session.stop()
  })

  it('换成没有会话的账号：旧任务、历史与选择全部清空', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    expect(store.task.goal).toBe('写博客')
    stub.state.identityBody = { mode: 'authenticated', key: 'user:b', label: '已登录', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }
    stub.state.conversations = []
    stub.state.history = []
    stub.state.run = null
    await session.refresh()
    expect(store.conversations).toHaveLength(0)
    expect(store.selectedId).toBe('')
    expect(store.task.taskId).toBe('')
    expect(store.task.goal).toBe('')
    expect(store.task.subtasks).toHaveLength(0)
    expect(store.history).toHaveLength(0)
    session.stop()
  })

  it('登录失效（401）：清空可能属于他人的数据并给出未登录状态', async () => {
    const session = makeSession()
    await session.refresh()
    stub.state.identityStatus = 401
    await session.refresh()
    const store = useTaskBookStore()
    expect(store.status).toBe('unauthorized')
    expect(store.conversations).toHaveLength(0)
    expect(store.task.goal).toBe('')
    expect(store.history).toHaveLength(0)
    session.stop()
  })

  it('旧刷新的迟到失败（401）不清空新身份的有效数据', async () => {
    const session = makeSession()
    const store = useTaskBookStore()
    // A 的列表请求滞留 80ms 后按 401 失败。
    stub.state.listDelayMs = 80
    stub.state.listStatus = 401
    const stale = session.refresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    // 切到 B（有效会话）并完成刷新。
    stub.state.identityBody = { mode: 'authenticated', key: 'user:b', label: '已登录', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }
    stub.state.conversations = [{ id: 'conv-9', title: 'B 的任务', createdAt: 1, updatedAt: 2, taskCount: 0 }]
    stub.state.history = []
    stub.state.run = null
    await session.refresh()
    expect(store.selectedId).toBe('conv-9')
    expect(store.status).toBe('ready')
    // A 的迟到 401 返回：不覆盖 B 的状态、不清空数据。
    await stale
    expect(store.status).toBe('ready')
    expect(store.conversations).toHaveLength(1)
    expect(store.selectedId).toBe('conv-9')
    session.stop()
  })

  it('订阅流授权失效（403）：清空旧数据并显示无权限', async () => {
    stub.state.eventsStatus = 403
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await vi.waitFor(() => expect(store.task.goal).toBe('写博客'))
    await vi.waitFor(() => expect(store.status).toBe('forbidden'))
    expect(store.conversations).toHaveLength(0)
    expect(store.selectedId).toBe('')
    expect(store.task.goal).toBe('')
    expect(store.history).toHaveLength(0)
    session.stop()
  })

  it('旧身份的迟到列表响应不得写回当前页面', async () => {
    stub.state.listDelayMs = 80
    const session = makeSession()
    const store = useTaskBookStore()
    const staleRefresh = session.refresh() // A 的列表请求滞留在途
    await new Promise(resolve => setTimeout(resolve, 15))
    // A 请求未返回前切换为没有会话的 B。
    stub.state.identityBody = { mode: 'authenticated', key: 'user:b', label: '已登录', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 }
    stub.state.conversations = []
    stub.state.history = []
    stub.state.run = null
    await session.refresh() // B 完成刷新并清空
    expect(store.conversations).toHaveLength(0)
    await staleRefresh // A 的旧响应最后返回
    expect(store.conversations).toHaveLength(0)
    expect(store.selectedId).toBe('')
    expect(store.task.goal).toBe('')
    session.stop()
  })

  it('原选择不属于当前用户时按不存在处理并清空', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    expect(store.selectedId).toBe('conv-1')
    // 同一身份下列表里换了会话集合，旧选择消失且无历史可回退。
    stub.state.conversations = [{ id: 'conv-2', title: '另一个会话', createdAt: 1, updatedAt: 2, taskCount: 0 }]
    stub.state.history = []
    stub.state.run = null
    await session.refresh()
    expect(store.selectedId).toBe('conv-2')
    expect(store.task.taskId).toBe('')
    session.stop()
  })
})

describe('换轮恢复边界', () => {
  it('运行中增量未落库（真实情形）：重放补回，正文不丢', async () => {
    stub.state.probeQueue.push({ runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 })
    stub.state.probeQueue.push({ runId: 'run-2', state: 'running', taskId: 'task-1', seq: 2, windowStart: 1 })
    // 真实生产语义：subtask_delta 先进事件日志，执行结束才落库；恢复时快照没有 result。
    stub.state.snapshotFor = () => ({ ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0], result: undefined }] })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'A', seq: 1, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 2, runId: 'run-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'C', seq: 1, runId: 'run-2' },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 2, runId: 'run-2' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.task.state).toBe('completed'))
    // A、B 只存在于事件日志：换轮恢复从 0 重放当前轮，页面不缺 A。
    expect(store.task.subtasks[0]?.text).toBe('ABC')
    // 订阅序列：装载 after=0 → 断线 after=2 → 换轮从 0 重放。
    expect(stub.state.subscriptions).toEqual([0, 2, 0])
    session.stop()
  })

  it('快照已有最终结果：真实历史顺序（plan/running/增量/succeeded）重放不重复计入', async () => {
    // 页面刷新重进：s1 已在同一轮里执行完毕落库（result=AB），当前轮日志重放会再次
    // 送达它的历史事件——包括会改动投影的 plan 与 running 迁移。
    stub.state.probeQueue.push({ runId: 'run-1', state: 'running', taskId: 'task-1', seq: 5, windowStart: 1 })
    stub.state.snapshotFor = () => ({ ...defaultSnapshot,
      subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'succeeded', result: 'AB' }] })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'plan', taskId: 'task-1', runId: 'run-1', seq: 1, subtasks: [
        { id: 's1', goal: '起草博客', agentId: 'blog', displayName: '博客' },
      ] },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', seq: 2, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'A', seq: 3, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 4, runId: 'run-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'succeeded', seq: 5, runId: 'run-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    // 恢复边界以内的历史增量不重复计入：正文仍是快照里的 AB。
    expect(store.task.subtasks[0]?.text).toBe('AB')
    expect(store.task.subtasks[0]?.text).not.toContain('ABAB')
    expect(stub.state.subscriptions).toEqual([0, 5])
    session.stop()
  })

  it('waiting_user 形态无法证明落库：保留增量并如实标记可能重复', async () => {
    // 管家在 waiting_user 上也写 result，但同一状态也可能是只改状态的进度上报；
    // 事件载荷分不出来，所以不按文本相似删字：增量保留、子任务标记可能重复。
    stub.state.probeQueue.push({ runId: 'run-1', state: 'running', taskId: 'task-1', seq: 5, windowStart: 1 })
    stub.state.snapshotFor = () => ({ ...defaultSnapshot,
      subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'waiting_user', result: 'AB' }] })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'plan', taskId: 'task-1', runId: 'run-1', seq: 1, subtasks: [
        { id: 's1', goal: '起草博客', agentId: 'blog', displayName: '博客' },
      ] },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', seq: 2, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'A', seq: 3, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 4, runId: 'run-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'waiting_user', seq: 5, runId: 'run-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    expect(store.task.subtasks[0]?.text).toBe('ABAB')
    expect(store.task.subtasks[0]?.uncertain).toBe(true)
    expect(store.task.incomplete).toBe(false)
    session.stop()
  })

  it('事件窗口滚出：保留窗口内片段并如实提示正文可能不完整', async () => {
    // 真实截断路径：游标落在窗口外拿到 reset；窗口里还留着的 B 要补回来（A 已不可恢复），
    // 并且不能静默展示残缺正文。这里让本轮结束时的补取失败，以便断言中间状态。
    stub.state.run = { runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 }
    stub.state.snapshotFor = () => ({ ...defaultSnapshot,
      subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'running', result: undefined }] })
    stub.state.snapshotStatus = 500
    stub.state.snapshotStatusFromRead = 3 // 只让本轮结束后的补取失败
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'reset', runId: 'run-1', seq: 3, windowStart: 2 },
    ], done: true })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 2, runId: 'run-1' },
      { type: 'subtask_thinking', taskId: 'task-1', id: 's1', thinking: '想一下结构', seq: 3, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'C', seq: 4, runId: 'run-1' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    expect(store.task.subtasks[0]?.text).toBe('BC')
    expect(store.task.incomplete).toBe(true)
    // 续订从窗口左边缘之前开始，而不是跳到日志头。
    expect(stub.state.subscriptions).toEqual([0, 1])
    session.stop()
  })

  it('窗口滚出的本轮结束后补取权威快照：正文补齐并清除提示', async () => {
    stub.state.run = { runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 }
    // 前两次读（装载、reset 恢复）正文还没落库；本轮结束后的补取读到完整正文。
    stub.state.snapshotFor = reads => reads <= 2
      ? { ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'running', result: undefined }] }
      : { ...defaultSnapshot, state: 'completed', subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'succeeded', result: 'ABC' }] }
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'reset', runId: 'run-1', seq: 3, windowStart: 2 },
    ], done: true })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 2, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'C', seq: 3, runId: 'run-1' },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 4, runId: 'run-1' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.task.incomplete).toBe(false))
    await vi.waitFor(() => expect(store.task.subtasks[0]?.text).toBe('ABC'))
    expect(store.task.state).toBe('completed')
    session.stop()
  })

  it('全部正文滚出且补取仍为空：不完整提示不被清除', async () => {
    // 运行中产生过正文但已全部滚出窗口，窗口内只剩状态事件，快照也没有 result；
    // 随后普通失败只写 error，补取同样取不到正文——提示必须保留。
    stub.state.run = { runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 }
    stub.state.snapshotFor = () => ({ ...defaultSnapshot, state: 'failed',
      subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'failed', result: undefined }] })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'reset', runId: 'run-1', seq: 3, windowStart: 2 },
    ], done: true })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_thinking', taskId: 'task-1', id: 's1', agentId: 'blog', thinking: '想一下结构', seq: 2, runId: 'run-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'failed', detail: '没干成', seq: 3, runId: 'run-1' },
      { type: 'summary', taskId: 'task-1', text: '没干成', state: 'failed', seq: 4, runId: 'run-1' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    expect(store.task.subtasks[0]?.text).toBe('')
    expect(store.task.incomplete).toBe(true)
    expect(store.task.state).toBe('failed')
    session.stop()
  })

  it('普通失败后的补取不改正文也不清除提示：旧 result 不是本轮正文', async () => {
    // 复审 L2 的真实形态：补取读到的是普通失败（只写 error、result 沿用上一轮的 A），
    // 窗口内取回的 B、C 不能被这次「补齐」删掉，不完整提示也要保留。
    stub.state.run = { runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 }
    stub.state.snapshotFor = () => ({ ...defaultSnapshot, state: 'failed',
      subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'failed', result: 'A' }] })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'reset', runId: 'run-1', seq: 3, windowStart: 2 },
    ], done: true })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 2, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'C', seq: 3, runId: 'run-1' },
      { type: 'summary', taskId: 'task-1', text: '没干成', state: 'failed', seq: 4, runId: 'run-1' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    // 补取前 ABC（旧 result A + 窗口内取回的 B、C），补取后仍是 ABC，提示保留。
    expect(store.task.subtasks[0]?.text).toBe('ABC')
    expect(store.task.incomplete).toBe(true)
    expect(store.task.state).toBe('failed')
    session.stop()
  })

  it('回复轮已 running 且保留旧结果：恢复后的新增正文不被吞掉', async () => {
    // prepareReply 先把子任务置为 running，落库用 COALESCE，上一轮的 AB 仍在快照里；
    // 新轮重放里的 running 事件不带来状态变化，新增的 C 照样要计入。
    stub.state.probeQueue.push({ runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 })
    stub.state.probeQueue.push({ runId: 'run-2', state: 'running', taskId: 'task-1', seq: 2, windowStart: 1 })
    stub.state.snapshotFor = reads => reads <= 1
      ? { ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0], result: undefined }] }
      : { ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'running', result: 'AB' }] }
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'A', seq: 1, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 2, runId: 'run-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', detail: '继续执行', seq: 1, runId: 'run-2' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'C', seq: 2, runId: 'run-2' },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 3, runId: 'run-2' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.task.state).toBe('completed'))
    // 快照里的旧 result 是基准，恢复之后的新增量继续累积。
    expect(store.task.subtasks[0]?.text).toBe('ABC')
    expect(stub.state.subscriptions).toEqual([0, 2, 0])
    session.stop()
  })

  it('换轮继续同一任务：权威材料保留，再次活跃后新增量继续累积', async () => {
    stub.state.probeQueue.push({ runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 })
    stub.state.probeQueue.push({ runId: 'run-2', state: 'running', taskId: 'task-1', seq: 2, windowStart: 1 })
    // 装载时运行中无 result；换轮恢复时该子任务已交回材料落库（等回话）。
    stub.state.snapshotFor = reads => reads <= 1
      ? { ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0], result: undefined }] }
      : { ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'waiting_user', result: 'AB' }] }
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'A', seq: 1, runId: 'run-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'B', seq: 2, runId: 'run-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-1' },
    ], done: false })
    // 新轮日志只有新轮事件：子任务再次活跃（状态迁移解除权威标记）后 C 继续累积。
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', detail: '继续执行', runId: 'run-2' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: 'C', seq: 1, runId: 'run-2' },
      { type: 'summary', taskId: 'task-1', text: '完成', state: 'completed', seq: 2, runId: 'run-2' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.task.state).toBe('completed'))
    expect(store.task.subtasks[0]?.text).toBe('ABC')
    expect(store.task.subtasks[0]?.text).not.toContain('ABAB')
    expect(stub.state.subscriptions).toEqual([0, 2, 0])
    session.stop()
  })

  it('新轮对应新任务：按新轮任务身份读快照，目标与子任务完整', async () => {
    stub.state.probeQueue.push({ runId: 'run-1', state: 'running', taskId: 'task-1', seq: 0, windowStart: 1 })
    stub.state.probeQueue.push({ runId: 'run-2', state: 'running', taskId: 'task-2', seq: 2, windowStart: 1 })
    stub.state.snapshotFor = reads => reads <= 1
      ? { ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0], result: undefined }] }
      : { id: 'task-2', conversationId: 'conv-1', goal: '新目标', state: 'running', summary: '', error: '', finishedAt: null,
          subtasks: [{ id: 's1', goal: '新第一步', state: 'running', agentId: 'blog', displayName: '博客', result: undefined }] }
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: '旧任务增量', seq: 1, runId: 'run-1' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-2' },
    ], done: false })
    stub.state.streamQueue.push({ events: [
      { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-2' },
      { type: 'subtask_delta', taskId: 'task-2', id: 's1', agentId: 'blog', delta: 'X', seq: 1, runId: 'run-2' },
      { type: 'summary', taskId: 'task-2', text: '完成', state: 'completed', seq: 2, runId: 'run-2' },
    ], done: true })
    const session = makeSession()
    const store = useTaskBookStore()
    await session.refresh()
    await vi.waitFor(() => expect(store.task.state).toBe('completed'))
    // 读到的是新任务快照：目标、子任务来自 task-2，旧任务正文不残留。
    expect(store.task.taskId).toBe('task-2')
    expect(store.task.goal).toBe('新目标')
    expect(store.task.subtasks).toHaveLength(1)
    expect(store.task.subtasks[0]?.goal).toBe('新第一步')
    expect(store.task.subtasks[0]?.text).toBe('X')
    session.stop()
  })
})
