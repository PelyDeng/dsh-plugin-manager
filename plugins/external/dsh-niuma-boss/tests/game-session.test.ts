import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { GameSession } from '../src/game-session.ts'
import { LAST_SCOPE_KEY, RecoveryStore, STORAGE_PREFIX, scopeOf } from '../src/recovery.ts'
import { useTaskBookStore } from '../src/store.ts'
import { taskStateLabel } from '../src/task-projection.ts'
import { ButlerStubServer, defaultSnapshot } from './butler-stub.ts'

/**
 * 身份与归属边界：换登录人、空会话列表、登录失效、订阅授权失效、旧响应迟到
 * 都必须清空或丢弃旧用户的任务投影与历史，不保留可能属于他人的数据。
 * 世界模块带 Phaser（需要真实 DOM），会话层测试 mock 掉，不启动渲染；mock 记录会话
 * 传进来的位置选项与调用，用来断言按用户恢复、落盘内容与后台暂停/回前台刷新。
 */

/** 作者角色名册（与编译产物同形状）：员工走任务协议，普通 NPC 只给预写对白。 */
const staffCharacter = (id: string, label: string) => ({ id, label, role: 'staff' })
const npcCharacter = (id: string, label: string, mode: string, lines: string[]) =>
  ({ id, label, role: 'npc', dialogue: { mode, name: label, role: '岗位说明', lines } })
const worldRoster = [
  { id: 'boss', label: '老板', role: 'player' },
  { id: 'butler', label: '牛马大总管', role: 'butler' },
  staffCharacter('example', 'example'),
  staffCharacter('closedoff', 'closedoff'),
  staffCharacter('blog', '博客'),
  npcCharacter('npc_hr', '沈禾', 'authored_lines', ['这页先留白，你说完我再记。']),
  npcCharacter('sample_explorer', '探险NPC示例', 'unavailable', []),
]

const worldMock = vi.hoisted(() => ({
  options: undefined as {
    restore?: () => unknown
    onFeet?: (feet: { map: string; cell: [number, number]; facing: string }) => void
    onNearTargets?: (targets: unknown[]) => void
    onInteract?: (target: unknown) => void
    onInteractKey?: () => void
  } | undefined,
  feet: { map: 'office', cell: [34, 26] as [number, number], facing: 'south' },
  reloads: [] as unknown[],
  /** start 时的恢复候选：角色在身份确认前按上次活跃用户恢复。 */
  boot: undefined as unknown,
  /** 地图启动失败（出生图资产缺失/过期）：GameWorld.start 抛错。 */
  startFailed: false,
  paused: 0,
  resumed: 0,
  /** 作者角色名册：会话据此算员工表现与普通 NPC 对白归属。 */
  roster: [] as unknown[],
  /** 会话下发的表现命令（每次调用一帧快照）。 */
  performance: [] as unknown[],
  /** 就近范围内的可交互对象（表现层事实）。 */
  near: [] as unknown[],
}))

vi.mock('../src/game-world.ts', () => ({
  GameWorld: class {
    private readonly options: typeof worldMock.options
    constructor(_parent: unknown, options: typeof worldMock.options) { this.options = options; worldMock.options = options }
    get state() { return { map: worldMock.feet.map, cell: [...worldMock.feet.cell], facing: worldMock.feet.facing } }
    get mapId() { return worldMock.feet.map }
    get characters() { return worldMock.roster }
    get staffIds() { return (worldMock.roster as { id: string; role?: string }[]).filter(c => c.role === 'staff').map(c => c.id) }
    character(id: string) { return (worldMock.roster as { id: string }[]).find(c => c.id === id) }
    start() {
      worldMock.boot = this.options?.restore?.()
      if (worldMock.startFailed) return Promise.reject(new Error('地图资源加载失败：office（HTTP 404）'))
      return Promise.resolve()
    }
    pause() { worldMock.paused++ }
    resume() { worldMock.resumed++ }
    destroy() {}
    movementLocked() { return false }
    applyRestore(snapshot: unknown) { worldMock.reloads.push(snapshot) }
    applyPerformance(commands: unknown) { worldMock.performance.push(commands) }
    /** 测试驱动就近事实：会话据此解析唯一提示。 */
    near(targets: unknown[]) { worldMock.options?.onNearTargets?.(targets) }
    interact(target: unknown) { worldMock.options?.onInteract?.(target) }
    pressInteractKey() { worldMock.options?.onInteractKey?.() }
  },
}))

let stub: ButlerStubServer
let origin: string

beforeEach(async () => {
  setActivePinia(createPinia())
  worldMock.options = undefined
  worldMock.feet = { map: 'office', cell: [34, 26], facing: 'south' }
  worldMock.reloads = []
  worldMock.startFailed = false
  worldMock.paused = 0
  worldMock.resumed = 0
  worldMock.roster = worldRoster
  worldMock.performance = []
  worldMock.near = []
  stub = new ButlerStubServer()
  origin = await stub.start()
})
afterEach(async () => { await stub.close() })

/** 每份存储独立：位置快照按用户写，测试要能看到全量文本。 */
class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  get dump() { return [...this.values.entries()].map(([k, v]) => k + '=' + v).join('\n') }
}

const makeSession = (storage = new MemoryStorage()) => new GameSession({
  parent: {} as HTMLElement, // 世界已 mock，挂载点不会真的被使用
  assetsBase: '/niuma-boss/generated/',
  butler: { origin, delays: [5, 5] },
  recovery: new RecoveryStore(storage, id => ['office', 'street', 'cafe'].includes(id)),
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

describe('写意图闭环与错误语义', () => {
  it('提交→SSE 状态推进→终态后补读同一份历史', async () => {
    stub.state.run = null // 当前没有在跑的一轮，新提交即刻受理
    stub.state.history = [{ id: 'task-new', conversationId: 'conv-1', goal: '写一篇新博客', state: 'completed', createdAt: 3, updatedAt: 4, subtaskTotal: 1, subtaskDone: 1 }]
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await session.submitTask('写一篇新博客')
    await vi.waitFor(() => expect(store.task.state).toBe('completed'))
    expect(store.task.taskId).toBe('task-new')
    expect(store.task.goal).toBe('写一篇新博客')
    // 终态后补读历史：任务本与管家入口看到同一份权威记录。
    await vi.waitFor(() => expect(store.history.map(item => item.id)).toContain('task-new'))
    expect(store.pendingSubmit).toBeNull()
    expect(stub.state.chatRequests).toHaveLength(1)
    session.stop()
  })

  it('等待用户回复：reply 后继续执行并完成', async () => {
    stub.state.run = null
    stub.state.chatQueue.push({ events: [
      { type: 'conversation', conversationId: 'conv-1' },
      { type: 'run', runId: 'run-1', state: 'running', taskId: 'task-1' },
      { type: 'plan', taskId: 'task-1', goal: '写博客', seq: 1, runId: 'run-1', subtasks: [{ id: 's1', goal: '起草', agentId: 'blog', displayName: '博客' }] },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'running', seq: 2, runId: 'run-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'waiting_user', detail: '两个版本选哪个？', seq: 3, runId: 'run-1' },
    ], done: false }) // 等待中的轮不结束，连接保持打开
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    void session.submitTask('写博客')
    await vi.waitFor(() => expect(store.task.subtasks[0]?.state).toBe('waiting_user'))
    expect(store.task.subtasks[0]?.note).toBe('两个版本选哪个？')
    await session.replySubtask('s1', '采用第一版')
    await vi.waitFor(() => expect(store.task.state).toBe('completed'))
    expect(stub.state.replyRequests[0]).toMatchObject({ taskId: 'task-1', subtaskId: 's1', text: '采用第一版' })
    expect(stub.state.chatRequests).toHaveLength(1) // 回复不是再次派活
    session.stop()
  })

  it('停止本轮：请求一次即受理提示，收敛以管家事件为准', async () => {
    stub.state.streamQueue.push({ events: [], done: false }) // 先占住观察连接
    stub.state.streamQueue.push({ events: [
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'cancelled', seq: 6, runId: 'run-1' },
      { type: 'summary', taskId: 'task-1', text: '已按请求停止', state: 'cancelled', seq: 7, runId: 'run-1' },
    ], done: true })
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await session.stopRound()
    expect(stub.state.stopRequests).toEqual([{ conversationId: 'conv-1', taskId: 'task-1' }])
    expect(store.notice).toContain('已请求停止本轮')
    await vi.waitFor(() => expect(store.task.state).toBe('cancelled'))
    expect(store.task.runState === 'cancelled' || store.task.state === 'cancelled').toBe(true)
    expect(stub.state.stopRequests).toHaveLength(1) // stop 不重试
    session.stop()
  })

  it('403：提示且不重试，身份按不可信处理', async () => {
    stub.state.chatQueue.push({ status: 403, body: { error: '请求来源不受信任', code: 'forbidden' } })
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await session.submitTask('写一篇新博客')
    expect(store.notice).toContain('提交被拒绝')
    expect(store.status).toBe('forbidden')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.chatRequests).toHaveLength(1)
    session.stop()
  })

  it('409 version_conflict：提示按码给出，不重试', async () => {
    stub.state.chatQueue.push({ status: 409, body: { error: '这一轮已经更新到第 2 版，请按最新内容重新提交', code: 'version_conflict' } })
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await session.submitTask('写一篇新博客')
    expect(store.notice).toContain('已被另一入口更新')
    expect(store.pendingSubmit).toBeNull() // 明确拒绝：不留待重试
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.chatRequests).toHaveLength(1)
    session.stop()
  })

  it('409 run_result_unknown：提示不会重新执行、读快照确认，不重试', async () => {
    stub.state.chatQueue.push({ status: 409, body: { error: '这次提交的结果不明，不会重新执行', code: 'run_result_unknown', runId: 'run-x', conversationId: 'conv-1' } })
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await session.submitTask('写一篇新博客')
    expect(store.notice).toContain('不会重新执行')
    expect(store.notice).toContain('任务快照')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.chatRequests).toHaveLength(1)
    session.stop()
  })

  it('409 run_busy：提示等上一条消息，不重试', async () => {
    stub.state.chatQueue.push({ status: 409, body: { error: '牛马大总管正在处理上一条消息，请先停止或等待完成', code: 'run_busy' } })
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await session.submitTask('再派一个活')
    expect(store.notice).toContain('正在处理上一条消息')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.chatRequests).toHaveLength(1)
    session.stop()
  })

  it('响应未知：保留原任务 ID 与原正文，重试复用同一 requestId 与正文', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    expect(store.task.taskId).toBe('task-1')
    expect(store.task.subtasks[0]?.text).toBe('草稿写到一半')
    stub.state.chatQueue.push({ destroy: true })
    await session.submitTask('写一篇新博客')
    expect(store.notice).toContain('无法确认')
    // 不编造失败：原任务投影与正文原样保留。
    expect(store.task.taskId).toBe('task-1')
    expect(store.task.subtasks[0]?.text).toBe('草稿写到一半')
    expect(store.pendingSubmit?.message).toBe('写一篇新博客')
    // 手动重试同一份提交：requestId 与正文逐字相同（管家幂等只执行一次）。
    stub.state.chatQueue.push({ destroy: true })
    session.retrySubmit()
    await vi.waitFor(() => expect(stub.state.chatRequests).toHaveLength(2))
    expect(stub.state.chatRequests[1]).toEqual(stub.state.chatRequests[0])
    session.stop()
  })

  it('响应未知后 stop 返回 404：提示走 stop 路径，pendingSubmit 保留且重试仍发原正文', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    // 先冻结一份待重试的提交（响应未知）。
    stub.state.chatQueue.push({ destroy: true })
    await session.submitTask('写一篇新博客')
    expect(store.pendingSubmit?.message).toBe('写一篇新博客')
    // stop 遇 404 不构成「那份提交已失效」的证据：只提示 stop 失败，不清 pendingSubmit。
    stub.state.stopPlan = { status: 404, body: { error: '任务不存在或无权访问', code: 'not_found' } }
    await session.stopRound()
    expect(store.notice).toContain('停止请求失败')
    expect(store.pendingSubmit?.message).toBe('写一篇新博客')
    // 手动重试：仍是冻结的同一份 requestId 与正文。
    stub.state.chatQueue.push({ destroy: true })
    session.retrySubmit()
    await vi.waitFor(() => expect(stub.state.chatRequests).toHaveLength(2))
    expect(stub.state.chatRequests[1]).toEqual(stub.state.chatRequests[0])
    session.stop()
  })

  it('停止请求遇 500：提示失败而非「无需停止」，不重试', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    // 500 说明停止没有送达；不能解析成 accepted:false 被提示成「本轮无需停止」。
    stub.state.stopPlan = { status: 500, body: { error: '服务处理请求失败' } }
    await session.stopRound()
    expect(store.notice).toContain('停止请求失败')
    expect(store.notice).not.toContain('无需停止')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.state.stopRequests).toHaveLength(1)
    session.stop()
  })

  it('响应未知后 stop 返回 403：身份不可信，沿用清空规则', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    stub.state.chatQueue.push({ destroy: true })
    await session.submitTask('写一篇新博客')
    expect(store.pendingSubmit).not.toBeNull()
    stub.state.stopPlan = { status: 403, body: { error: '请求来源不受信任', code: 'forbidden' } }
    await session.stopRound()
    expect(store.notice).toContain('停止请求被拒绝')
    expect(store.pendingSubmit).toBeNull()
    expect(store.status).toBe('forbidden')
    session.stop()
  })

  it('external_pending：按待外部处理展示，不显示成完成', async () => {
    stub.state.run = null
    stub.state.chatQueue.push({ events: [
      { type: 'conversation', conversationId: 'conv-1' },
      { type: 'run', runId: 'run-x', state: 'running', taskId: '' },
      { type: 'plan', taskId: 'task-x', goal: '发布园区安全通告', seq: 1, runId: 'run-x', subtasks: [{ id: 's1', goal: '起草并交回', agentId: 'blog', displayName: '博客' }] },
      { type: 'subtask', taskId: 'task-x', id: 's1', state: 'external_pending', detail: '候选稿须在博客原对话选择采用', pending: { reason: '候选稿须在博客原对话选择采用', next: '采用之后可以再派一轮' }, artifacts: [{ kind: 'draft', title: '在博客查看并采用候选稿', path: '/blog?conversationId=x' }], seq: 2, runId: 'run-x' },
      { type: 'summary', taskId: 'task-x', text: '材料已交回，还有 1 件事要在外面办完。', state: 'external_pending', seq: 3, runId: 'run-x' },
    ], done: true })
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await session.submitTask('发布园区安全通告')
    await vi.waitFor(() => expect(store.task.state).toBe('external_pending'))
    expect(taskStateLabel(store.task.state)).toBe('待外部处理')
    expect(store.task.state).not.toBe('completed')
    expect(store.task.subtasks[0]?.pending?.reason).toContain('选择采用')
    session.stop()
  })
})

/**
 * 位置恢复（第三切片）：localStorage 按用户只存地图/格子/朝向/偏好四项，
 * 任务正文与身份原文都不落盘；坏快照回安全出生点；后台暂停、回前台刷新权威快照。
 */
describe('按用户的位置恢复', () => {
  const identityOf = (key: string) => ({ mode: 'authenticated', key, label: '已登录', authPath: '/auth', routePrefix: '/fixture-butler', contractVersion: 1 })

  it('启动时按上次活跃用户恢复位置与界面偏好，身份确认后按该用户的作用域落盘', async () => {
    const storage = new MemoryStorage()
    const alice = scopeOf('user:a')
    storage.setItem(LAST_SCOPE_KEY, alice)
    storage.setItem(STORAGE_PREFIX + alice, JSON.stringify({ map: 'street', cell: [8, 12], facing: 'east', preferences: { taskBookOpen: true } }))
    const session = makeSession(storage)
    await session.start()
    const store = useTaskBookStore()
    // 启动就按上次活跃用户恢复：位置候选与任务本开合偏好都来自他自己的快照。
    expect(worldMock.boot).toMatchObject({ map: 'street', cell: [8, 12] })
    expect(store.bookOpen).toBe(true)
    // 登录人就是同一位：不需要再换位置，也不会被清成出生点。
    expect(worldMock.reloads).toHaveLength(0)
    // 位置变化按当前用户（user:a）落盘，只有四项。
    worldMock.options?.onFeet?.({ map: 'street', cell: [9, 13], facing: 'south' })
    expect(JSON.parse(storage.getItem(STORAGE_PREFIX + alice)!)).toEqual({ map: 'street', cell: [9, 13], facing: 'south', preferences: { taskBookOpen: true } })
    // 换用户：位置与界面偏好一起换成 B 自己的。
    storage.setItem(STORAGE_PREFIX + scopeOf('user:b'), JSON.stringify({ map: 'cafe', cell: [6, 11], facing: 'north', preferences: { taskBookOpen: false } }))
    stub.state.identityBody = identityOf('user:b')
    await session.refresh()
    expect(store.bookOpen).toBe(false)
    expect(worldMock.reloads[0]).toMatchObject({ map: 'cafe', cell: [6, 11], facing: 'north' })
    session.stop()
  })

  it('换用户：人物换到那位用户自己的落点，没有快照回安全出生点', async () => {
    const storage = new MemoryStorage()
    const session = makeSession(storage)
    await session.start()
    expect(worldMock.reloads).toHaveLength(1)
    // B 有自己的位置快照；把身份换成 user:b 后人物按 B 的落点重开。
    const bScope = scopeOf('user:b')
    storage.setItem(STORAGE_PREFIX + bScope, JSON.stringify({ map: 'cafe', cell: [6, 11], facing: 'north', preferences: { taskBookOpen: false } }))
    stub.state.identityBody = identityOf('user:b')
    await session.refresh()
    expect(worldMock.reloads[1]).toMatchObject({ map: 'cafe', cell: [6, 11], facing: 'north' })
    // C 没有快照：回安全出生点（null 由会话交给世界判定）。
    stub.state.identityBody = identityOf('user:c')
    await session.refresh()
    expect(worldMock.reloads[2]).toBeNull()
    session.stop()
  })

  it('落盘只有四项：没有任务正文、会话内容、requestId 或身份原文', async () => {
    const storage = new MemoryStorage()
    const session = makeSession(storage)
    await session.refresh()
    const store = useTaskBookStore()
    // 任务本里已经有权威正文（写博客/草稿写到一半），这些内容一律不进浏览器存储。
    expect(store.task.goal).toBe('写博客')
    worldMock.options?.onFeet?.({ map: 'office', cell: [30, 20], facing: 'west' })
    session.openBook()
    worldMock.options?.onFeet?.({ map: 'office', cell: [31, 20], facing: 'west' })
    const snapshotLine = [...storage.values.entries()].find(([key]) => key !== LAST_SCOPE_KEY && !key.endsWith('last'))
    expect(snapshotLine).toBeDefined()
    const parsed = JSON.parse(snapshotLine![1])
    expect(Object.keys(parsed)).toEqual(['map', 'cell', 'facing', 'preferences'])
    expect(parsed).toEqual({ map: 'office', cell: [31, 20], facing: 'west', preferences: { taskBookOpen: true } })
    expect(storage.dump).not.toContain('写博客')
    expect(storage.dump).not.toContain('草稿写到一半')
    expect(storage.dump).not.toContain('user:a')
    expect(storage.dump).not.toContain('requestId')
    session.stop()
  })

  it('后台暂停并立刻落盘，回前台恢复渲染并重读权威快照', async () => {
    const storage = new MemoryStorage()
    const session = makeSession(storage)
    await session.refresh()
    const store = useTaskBookStore()
    // 后台期间管家那边换了内容：回前台必须重读权威快照，而不是沿用本地视图。
    stub.state.history = [{ id: 'task-2', conversationId: 'conv-1', goal: '回来后读到的任务', state: 'completed', createdAt: 3, updatedAt: 4, subtaskTotal: 0, subtaskDone: 0 }]
    stub.state.snapshot = { ...defaultSnapshot, id: 'task-2', goal: '回来后读到的任务', state: 'completed' }
    stub.state.run = null
    session.onHidden()
    expect(worldMock.paused).toBe(1)
    const scope = scopeOf('user:a')
    expect(JSON.parse(storage.getItem(STORAGE_PREFIX + scope)!)).toMatchObject({ map: 'office', cell: [34, 26] })
    session.onVisible()
    expect(worldMock.resumed).toBe(1)
    await vi.waitFor(() => expect(store.history[0]?.goal).toBe('回来后读到的任务'))
    session.stop()
  })
})

/**
 * 启动边界：任务本与地图互不影响（game-world 头注释声明）。出生地图资产失效/过期时
 * world.start 抛错，任务本（列表 + 订阅）必须照常装载，错误如实记录、不静默吞掉。
 */
describe('地图启动失败不连带任务本', () => {
  it('world.start 抛错：错误如实记录，任务本仍刷新（列表与订阅可用）', async () => {
    worldMock.startFailed = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const session = makeSession()
      await session.start()
      const store = useTaskBookStore()
      // 地图挂了但任务本入口照常走到底：会话列表、当前任务与历史都是权威数据。
      expect(store.conversations).toHaveLength(1)
      expect(store.selectedId).toBe('conv-1')
      expect(store.task.taskId).toBe('task-1')
      expect(store.task.goal).toBe('写博客')
      expect(store.task.subtasks[0]?.text).toBe('草稿写到一半')
      // 订阅可用：probe 说这一轮在跑，只读观察流按 after=0 接上，链路状态由流接通给出「已连接」。
      await vi.waitFor(() => expect(store.status).toBe('ready'))
      expect(stub.state.subscriptions[0]).toBe(0)
      // 错误如实记录（不静默），原样带上异常对象。
      expect(errors).toHaveBeenCalledWith('牛马-老板：地图启动失败', expect.any(Error))
      session.stop()
    } finally {
      errors.mockRestore()
    }
  })
})

/**
 * 切片 4：权威投影 → 表现命令 → 表现层；就近交互按作者优先级只留一个提示；
 * 普通 NPC 与业务员工严格分开（一个只有预写对白，一个只给名牌与权威状态）。
 * 「不调用模型或业务工具」用管家的**总请求数不变**来断言：普通对白通路不碰网络。
 */
describe('人物表现与业务状态映射', () => {
  const performanceOf = () => {
    // worldMock.performance 记录每次下发的命令帧；取最后一帧。
    const frames = worldMock.performance as { agentId: string; action: string; work: string; state: string }[][]
    return frames[frames.length - 1] ?? []
  }
  /** 表现层事实（就近对象与点击）由世界回调报上来，这里按同一条通路驱动。 */
  const near = (targets: unknown[]) => worldMock.options?.onNearTargets?.(targets)
  const interact = (target: unknown) => worldMock.options?.onInteract?.(target)

  it('权威快照 → 员工表现命令：整轮只有终态时直接收敛到交回并回工位', async () => {
    stub.state.run = null
    stub.state.snapshot = { ...defaultSnapshot, state: 'completed', subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'succeeded', result: '定稿' }] }
    const session = makeSession()
    await session.refresh()
    const commands = performanceOf()
    const blog = commands.find(c => c.agentId === 'blog')!
    expect(blog).toMatchObject({ state: 'succeeded', work: 'free', action: 'hand_back' })
    // 没有派活的两位员工停在工位待命，不会被别人的终态带着走。
    expect(commands.filter(c => c.agentId !== 'blog').every(c => c.action === 'at_post')).toBe(true)
    session.stop()
  })

  it('任务终态不从演出推算：权威终态之后晚到的增量/重复成功事件不改命令与状态', async () => {
    // 权威快照已经是终态；观察流随后才把「迟到的增量」和「重复的成功事件」送进来。
    stub.state.snapshot = {
      ...defaultSnapshot, state: 'completed', summary: '完成', finishedAt: 9,
      subtasks: [{ ...defaultSnapshot.subtasks[0], state: 'succeeded', result: '定稿' }],
    }
    stub.state.run = { runId: 'run-1', state: 'running', taskId: 'task-1', seq: 5, windowStart: 1 }
    stub.state.streamQueue.push({ events: [
      { type: 'subtask_delta', taskId: 'task-1', id: 's1', agentId: 'blog', delta: '（迟到的增量）', seq: 6, runId: 'run-1' },
      { type: 'subtask', taskId: 'task-1', id: 's1', state: 'succeeded', agentId: 'blog', displayName: '博客', detail: '又报了一次完成', seq: 7, runId: 'run-1' },
    ], done: true })
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    await vi.waitFor(() => expect(store.task.state).toBe('completed'))
    // 迟到事件确实到了（正文按覆盖边界如实追加，不静默丢弃），但业务事实一个都不变。
    await vi.waitFor(() => expect(store.task.subtasks[0]!.text).toContain('迟到的增量'))
    expect(store.task.state).toBe('completed')
    expect(store.task.summary).toBe('完成')
    expect(store.task.subtasks[0]!.state).toBe('succeeded')
    // 正文基准仍然只有权威快照里的那份结果，迟到增量只是显示层追加。
    expect(store.task.subtasks[0]!.base).toBe('定稿')
    // 员工命令只读投影：终态之后仍然是「交回并回工位」，没有被演出再推回开工。
    const commands = performanceOf()
    expect(commands.find(c => c.agentId === 'blog')).toMatchObject({ state: 'succeeded', work: 'free', action: 'hand_back' })
    session.stop()
  })

  it('就近提示按作者优先级只留一个，牛马大总管赢过普通 NPC', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    near([
      { id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles: 0.5, dialogueMode: 'authored_lines' },
      { id: 'butler', label: '牛马大总管', kind: 'butler', distanceTiles: 1.2 },
    ])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('supplement_hint'))
    expect(store.prompt?.label).toBe('补充一句')
    // 走远后只剩普通 NPC 的交谈提示。
    near([{ id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles: 0.5, dialogueMode: 'authored_lines' }])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    near([])
    await vi.waitFor(() => expect(store.prompt).toBeNull())
    session.stop()
  })

  it('普通 NPC 对白用作者预写内容，0 次模型/业务工具调用（管家的总请求数不变）', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    // 等只读订阅接通（一次长连接）再计数：对白通路本身不产生任何请求。
    await vi.waitFor(() => expect(store.status).toBe('ready'))
    await new Promise(resolve => setTimeout(resolve, 30))
    const before = [...stub.state.requests]
    near([{ id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles: 0.8, dialogueMode: 'authored_lines' }])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    session.interactKey()
    expect(store.dialogue).toMatchObject({ kind: 'npc', id: 'npc_hr', title: '沈禾', mode: 'authored_lines', inputAllowed: false })
    expect(store.dialogue?.lines).toEqual(['这页先留白，你说完我再记。'])
    // 关掉面板、再点一次头像：整条通路不产生任何请求（模型与业务工具都不在其中）。
    session.closeDialogue()
    expect(store.dialogue).toBeNull()
    interact({ id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles: 0.8, dialogueMode: 'authored_lines' })
    expect(store.dialogue?.mode).toBe('authored_lines')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stub.state.requests).toEqual(before)
    expect(stub.state.chatRequests).toHaveLength(0)
    expect(stub.state.replyRequests).toHaveLength(0)
    expect(stub.state.stopRequests).toHaveLength(0)
    session.stop()
  })

  it('任务本或对白开着时不渲染就近提示（requires.input_open: false）', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    near([{ id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles: 0.5, dialogueMode: 'authored_lines' }])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    session.openBook()
    expect(store.prompt).toBeNull()
    session.closeBook()
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    // 对白面板同理：开着的时候一个提示都不生效，关掉才恢复。
    session.interactKey()
    expect(store.dialogue).not.toBeNull()
    expect(store.prompt).toBeNull()
    session.closeDialogue()
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    session.stop()
  })

  it('就近会话随走远、换图与角色离场自动关闭，且不碰任务状态', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    const target = (distanceTiles: number) =>
      ({ id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles, dialogueMode: 'authored_lines' })
    near([target(0.5)])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    session.interactKey()
    expect(store.dialogue?.id).toBe('npc_hr')
    // 走出交互半径但还没走远（< walk_away_tiles = 3.5）：会话留着，提示不闪。
    near([target(3.4)])
    expect(store.dialogue?.id).toBe('npc_hr')
    // 走远了：自动关闭。
    near([target(3.6)])
    expect(store.dialogue).toBeNull()
    // 再开一次：角色离场（本图近邻里没有这个人）同样关闭。
    near([target(0.5)])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    session.interactKey()
    expect(store.dialogue).not.toBeNull()
    near([{ id: 'npc_admin', label: '陆小周', kind: 'npc', distanceTiles: 0.5, dialogueMode: 'authored_lines' }])
    expect(store.dialogue).toBeNull()
    // 换到另一张图：旧图的角色不在近邻事实里，会话随之关闭。
    near([target(0.5)])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_talk_hint'))
    session.interactKey()
    expect(store.dialogue).not.toBeNull()
    worldMock.options?.onFeet?.({ map: 'street', cell: [5, 12], facing: 'north' })
    expect(store.dialogue).toBeNull()
    // 对白只是表现：任务投影与命令一个字节都没变。
    expect(store.task.state).toBe('running')
    expect(performanceOf().find(c => c.agentId === 'blog')).toMatchObject({ action: 'start_work' })
    session.stop()
  })

  it('没有对白通道的角色只给名牌，不回退到员工通道', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    near([{ id: 'sample_explorer', label: '探险NPC示例', kind: 'npc', distanceTiles: 1, dialogueMode: 'unavailable' }])
    await vi.waitFor(() => expect(store.prompt?.id).toBe('npc_status_hint'))
    session.interactKey()
    expect(store.dialogue).toMatchObject({ id: 'sample_explorer', mode: 'unavailable', inputAllowed: false })
    expect(store.dialogue?.lines).toEqual([])
    session.stop()
  })

  it('员工名牌上的状态用中文文案：dispatched/executing/succeeded 不留英文 token', async () => {
    for (const [state, label] of [['dispatched', '已派出'], ['executing', '执行中'], ['succeeded', '已完成']] as const) {
      stub.state.run = null
      stub.state.snapshot = { ...defaultSnapshot, subtasks: [{ ...defaultSnapshot.subtasks[0]!, state }] }
      const session = makeSession()
      await session.refresh()
      const store = useTaskBookStore()
      const world = session['world'] as unknown as { interact: (t: unknown) => void }
      world.interact({ id: 'blog', label: '博客', kind: 'staff', distanceTiles: 1 })
      expect(store.dialogue?.stateLabel, state).toContain(label)
      session.stop()
    }
  })

  it('业务员工只给名牌与权威状态：超范围点击只给轻微反馈，不打开任何输入', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    const world = session['world'] as unknown as { interact: (t: unknown) => void }
    world.interact({ id: 'blog', label: '博客', kind: 'staff', distanceTiles: 3 })
    expect(store.dialogue).toBeNull()
    expect(store.notice).toContain('走近一点')
    // 范围内：名牌显示权威状态与当前表现动作，没有搭话入口。
    world.interact({ id: 'blog', label: '博客', kind: 'staff', distanceTiles: 1 })
    expect(store.dialogue).toMatchObject({ kind: 'staff', id: 'blog', inputAllowed: false })
    expect(store.dialogue?.stateLabel).toContain('进行中')
    expect(store.dialogue?.lines).toEqual([])
    session.stop()
  })

  it('切到没有员工的会话时命令复位，回到有派活的会话再按权威状态复位', async () => {
    stub.state.conversations = [
      { id: 'conv-1', title: '博客任务', createdAt: 1, updatedAt: 2, taskCount: 1 },
      { id: 'conv-2', title: '另一个会话', createdAt: 1, updatedAt: 2, taskCount: 0 },
    ]
    const session = makeSession()
    await session.refresh()
    expect(performanceOf().find(c => c.agentId === 'blog')).toMatchObject({ state: 'running', action: 'start_work' })
    // 空会话：投影清空，命令回到工位待命（不保留上一份任务的演出）。
    stub.state.history = []
    stub.state.run = null
    await session.selectConversation('conv-2')
    expect(performanceOf().every(c => c.action === 'at_post')).toBe(true)
    session.stop()
  })

  it('身份失效时表现与对白一起作废，不把上一份任务的状态留在画面上', async () => {
    const session = makeSession()
    await session.refresh()
    const store = useTaskBookStore()
    near([{ id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles: 0.5, dialogueMode: 'authored_lines' }])
    await vi.waitFor(() => expect(store.prompt).not.toBeNull())
    session.interactKey()
    expect(store.dialogue).not.toBeNull()
    stub.state.identityStatus = 401
    await session.refresh()
    expect(store.dialogue).toBeNull()
    expect(store.prompt).toBeNull()
    expect(performanceOf().every(c => c.action === 'at_post')).toBe(true)
    session.stop()
  })
})
