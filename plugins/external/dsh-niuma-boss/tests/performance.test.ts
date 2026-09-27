import { describe, expect, it } from 'vitest'
import { activeSubtask, deriveStaffCommands, staffDialogueViews } from '../src/performance.ts'
import { applyEvent, applySnapshot, emptyTaskView, type TaskSnapshot, type TaskView } from '../src/task-projection.ts'

/**
 * 表现命令：权威投影 → 命令的纯映射。这里守住第五阶段切片 4 的三条硬性质：
 * 整轮只收到终态也能正确收尾、终态不从演出推算、3 位业务员工与普通 NPC 严格分开。
 */

const STAFF = ['example', 'closedoff', 'blog']

const sub = (overrides: Partial<TaskView['subtasks'][number]> = {}) => ({
  id: 's1', goal: '起草博客', state: 'running', agentId: 'blog', displayName: '博客',
  base: '', text: '草稿', coverage: { runId: 'run-1', boundary: 3, through: -1 }, replaying: [],
  uncertain: false, note: '', thinking: '', artifacts: [], ...overrides,
})

const view = (overrides: Partial<TaskView> = {}): TaskView => ({
  ...emptyTaskView('conv-1'), taskId: 'task-1', conversationId: 'conv-1', goal: '写博客',
  state: 'running', runState: 'running', lastRunId: 'run-1', subtasks: [sub()], ...overrides,
})

describe('员工表现命令（agent_fsm.yaml#staff 的两个并行区域）', () => {
  it('每位业务员工都拿到一条命令，没有派活的停在工位待命', () => {
    const commands = deriveStaffCommands(view(), STAFF)
    expect(commands.map(c => c.agentId)).toEqual(STAFF)
    expect(commands[0]).toMatchObject({ agentId: 'example', work: 'free', action: 'at_post', rendezvous: 'workstation' })
  })

  it('派单→执行→等待回话→终结：动作与会合点语义逐段对应', () => {
    const steps: [string, string, string][] = [
      ['dispatched', 'assigned', 'walk_to_rendezvous'],
      ['executing', 'running', 'start_work'],
      ['running', 'running', 'start_work'],
      ['waiting_user', 'waiting_user', 'wait_for_reply'],
      ['succeeded', 'free', 'hand_back'],
      ['external_pending', 'free', 'hand_back'],
      ['failed', 'free', 'hand_back'],
      ['cancelled', 'free', 'hand_back'],
    ]
    for (const [state, work, action] of steps) {
      const command = deriveStaffCommands(view({ subtasks: [sub({ state })] }), STAFF).find(c => c.agentId === 'blog')!
      expect(command.work, state).toBe(work)
      expect(command.action, state).toBe(action)
      // 干活阶段去会合点（interaction_rules.yaml#rendezvous.default_kind = butler）；
      // 终态与自由态回自己的工位。
      expect(command.rendezvous, state).toBe(work === 'free' ? 'workstation' : 'butler')
    }
  })

  it('会合点槽位顺序按派单顺序（投影里的子任务先后）再按员工 id 收尾', () => {
    // 投影里 s2 排在 s1 前面：谁先派就先选槽位，与员工 id 的字母序无关。
    const subtasks = [
      sub({ id: 's2', agentId: 'blog', state: 'dispatched' }),
      sub({ id: 's1', agentId: 'example', state: 'dispatched' }),
      sub({ id: 's3', agentId: 'closedoff', state: 'dispatched' }),
    ]
    const commands = deriveStaffCommands(view({ subtasks }), STAFF)
    const order = [...commands].sort((a, b) => a.dispatchOrder - b.dispatchOrder || a.agentId.localeCompare(b.agentId)).map(c => c.agentId)
    expect(order).toEqual(['blog', 'example', 'closedoff'])
    expect(commands.find(c => c.agentId === 'blog')!.dispatchOrder).toBe(0)
    expect(commands.find(c => c.agentId === 'example')!.dispatchOrder).toBe(1)
    // 没有派活的员工排到最后：不会插进正在派单的员工前面抢槽位。
    expect(commands.find(c => c.agentId === 'closedoff')!.dispatchOrder).toBe(2)
    const idle = deriveStaffCommands(view({ subtasks: [sub({ id: 's1', agentId: 'blog', state: 'dispatched' })] }), STAFF)
    expect(idle.find(c => c.agentId === 'example')!.dispatchOrder).toBeGreaterThan(1)
  })

  it('还没派出的计划不占员工：queued 停在工位待命', () => {
    const command = deriveStaffCommands(view({ subtasks: [sub({ state: 'queued' })] }), STAFF).find(c => c.agentId === 'blog')!
    expect(command).toMatchObject({ work: 'free', action: 'at_post' })
  })

  it('同一员工最多一个在跑的子任务：重试期间看新尝试，旧失败不抢表现', () => {
    const subtasks = [sub({ id: 's1', state: 'failed', note: '超时' }), sub({ id: 's2', state: 'running', note: '' })]
    const command = deriveStaffCommands(view({ subtasks }), STAFF).find(c => c.agentId === 'blog')!
    expect(command).toMatchObject({ subtaskId: 's2', work: 'running', action: 'start_work' })
    expect(activeSubtask(view({ subtasks }), 'blog')?.id).toBe('s2')
  })

  it('无进度事件也能正确收尾：整轮只收到终态快照，命令直接收敛到交回并回工位', () => {
    // 演出事件一条都没有：只有一条 succeeded 的权威快照。
    const snapshot: TaskSnapshot = {
      id: 'task-1', conversationId: 'conv-1', goal: '写博客', state: 'completed', summary: '完成', error: '', finishedAt: 9,
      subtasks: [{ id: 's1', goal: '起草博客', state: 'succeeded', agentId: 'blog', displayName: '博客', result: '定稿' }],
    }
    const projected = applySnapshot(emptyTaskView('conv-1'), snapshot, 1, { runId: 'run-1', seq: 0, final: true })
    const command = deriveStaffCommands(projected, STAFF).find(c => c.agentId === 'blog')!
    expect(projected.state).toBe('completed')
    expect(command).toMatchObject({ subtaskId: 's1', state: 'succeeded', work: 'free', action: 'hand_back' })
  })

  it('演出缺失或乱序不改变权威终态：命令只是投影的读数', () => {
    // 反例一：终态快照之后又来了迟到事件（重复成功、未知子任务的增量、另一轮的头）。
    const snapshot: TaskSnapshot = {
      id: 'task-1', conversationId: 'conv-1', goal: '写博客', state: 'completed', summary: '完成', error: '', finishedAt: 9,
      subtasks: [{ id: 's1', goal: '起草博客', state: 'succeeded', agentId: 'blog', displayName: '博客', result: '定稿' }],
    }
    let projected = applySnapshot(emptyTaskView('conv-1'), snapshot, 1, { runId: 'run-1', seq: 0, final: true })
    const before = structuredClone(projected)
    projected = applyEvent(projected, { type: 'subtask', taskId: 'task-1', id: 's1', state: 'succeeded', seq: 9, runId: 'run-1' })
    projected = applyEvent(projected, { type: 'subtask_delta', taskId: 'task-1', id: 's9', delta: '乱序增量', seq: 10, runId: 'run-1' })
    projected = applyEvent(projected, { type: 'run', runId: 'run-2', state: 'running', taskId: 'task-1' })
    // 迟到事件不生成任何业务事实：终态、汇总与子任务结论都不变。
    const commands = deriveStaffCommands(projected, STAFF)
    const blog = commands.find(c => c.agentId === 'blog')!
    expect(projected.state).toBe(before.state)
    expect(projected.summary).toBe(before.summary)
    expect(blog.state).toBe(before.subtasks[0]!.state)
    expect(blog.action).toBe('hand_back')
    // 反例二：表现命令自己不能制造业务状态——命令是投影的读数，投影一个字节也不被改写；
    // 旧一轮的命令也不会因为「还在画面里」而出现在新投影上。
    const viewNow = view()
    const frozen = structuredClone(viewNow)
    deriveStaffCommands(viewNow, STAFF)
    expect(viewNow).toEqual(frozen)
    const terminal = deriveStaffCommands(projected, STAFF)
    expect(terminal.find(c => c.agentId === 'blog')!.taskId).toBe('task-1')
    expect(deriveStaffCommands(emptyTaskView('conv-1'), STAFF).every(c => c.action === 'at_post')).toBe(true)
  })

  it('普通 NPC 永不出现在员工命令里，也不参与任务投影', () => {
    // 投影里出现一个普通 NPC 的执行者（脏数据/迟到事件）：员工名单之外的人一律不生成命令。
    const dirty = applyEvent(emptyTaskView('conv-1'), {
      type: 'plan', taskId: 'task-1', goal: '写博客', seq: 1, runId: 'run-1',
      subtasks: [{ id: 's1', goal: '闲聊', agentId: 'npc_hr', displayName: '沈禾' }],
    })
    const commands = deriveStaffCommands(dirty, STAFF)
    expect(commands.map(c => c.agentId)).toEqual(STAFF)
    expect(commands.some(c => c.agentId === 'npc_hr')).toBe(false)
    // 普通 NPC 的对白在作者数据里（GameWorld 的 roster），不在这条链上。
    expect(commands.every(c => c.rendezvous === 'workstation')).toBe(true)
  })
})

describe('员工气泡与状态文案', () => {
  it('气泡用权威正文并按 balance_params 截断，状态文案走任务的展示映射', () => {
    const long = '草稿'.repeat(48)
    const commands = deriveStaffCommands(view({ subtasks: [sub({ text: long })] }), STAFF)
    const views = staffDialogueViews(view({ subtasks: [sub({ text: long })] }), commands, [{ id: 'blog', label: '博客' }])
    const blog = views.find(v => v.id === 'blog')!
    expect(blog.label).toBe('博客')
    expect(blog.stateLabel).toBe('进行中')
    expect(blog.actionLabel).toBe('开工')
    expect(blog.truncated).toBe(true)
    expect(blog.bubble.length).toBe(49) // 48 字 + 省略号
  })

  it('权威事件里的英文 token 有中文文案，不把原文直接端到界面上', () => {
    // dispatched/executing/succeeded 是 task_protocol 的子任务状态原文：投影里没有映射，
    // 由 labels 补上（员工面板与任务本共用同一份文案）。
    const states: [string, string][] = [['dispatched', '已派出'], ['executing', '执行中'], ['succeeded', '已完成']]
    for (const [state, label] of states) {
      const views = staffDialogueViews(view({ subtasks: [sub({ state })] }), deriveStaffCommands(view({ subtasks: [sub({ state })] }), STAFF), [])
      expect(views.find(v => v.id === 'blog')!.stateLabel, state).toBe(label)
    }
    // 投影已经认识的状态照旧走 task-projection 的映射，不会被覆盖。
    const running = staffDialogueViews(view(), deriveStaffCommands(view(), STAFF), [])
    expect(running.find(v => v.id === 'blog')!.stateLabel).toBe('进行中')
  })

  it('没有派活的员工显示「本轮没有派活」，不显示成在忙', () => {
    const views = staffDialogueViews(view({ subtasks: [] }), deriveStaffCommands(view({ subtasks: [] }), STAFF), [])
    expect(views.map(v => v.stateLabel)).toEqual(['本轮没有派活', '本轮没有派活', '本轮没有派活'])
    expect(views.every(v => v.bubble === '')).toBe(true)
  })
})
