/**
 * 调度卡 store 层单测（批 4b）：plan 建卡/fresh 有更新/结算收口/偏好读写。
 * 语义对齐 web/modules/dcard.js（mountDispatch/attachToDispatch/settleCardForSummary）。
 * 偏好走 localStorage：文件级 happy-dom 环境（不动全局配置）。
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { readCardPrefs, resolveActionLocally, saveCardPref, useTurnStore } from '../web-react/src/stores/turn.ts'
import { subtaskEntryOf } from '../web-react/src/stores/thread-entries.ts'
import type { TurnEvent } from '../web-react/src/lib/turn-event.ts'
import type { TaskRecord } from '../web-react/src/lib/api.ts'

function apply(event: TurnEvent): void {
  useTurnStore.getState().applyTurnEvent(event)
}

function dispatchEntry() {
  return useTurnStore.getState().entries.find(entry => entry.kind === 'dispatch')
}

/** 测试辅助：按 subtaskId 找数据面条目（评审 #18 后无 bubbleKeys 索引，派生查找）。 */
function sub(id: string) {
  const entry = subtaskEntryOf(useTurnStore.getState().entries, id)
  if (entry === undefined) throw new Error(`subtask ${id} missing`)
  return entry
}

describe('调度卡数据面（plan/subtask/summary）', () => {
  beforeEach(() => {
    localStorage.clear()
    useTurnStore.setState({
      entries: [], butlerSpeechKey: null,
      viewToken: 0, conversationId: null, lastRunTaskId: '',
    })
  })

  function seedPlan(): void {
    apply({ type: 'plan', taskId: 'task-x', subtasks: [
      { id: 'c1', agentId: 'blog', goal: '写文案', state: 'queued' },
      { id: 'c2', agentId: 'huiyu', goal: '配图', state: 'queued' },
    ] } as TurnEvent)
  }

  it('plan 建卡：一张 dispatch + 每个子任务一条数据面，默认收起', () => {
    seedPlan()
    const card = dispatchEntry()
    expect(card?.kind).toBe('dispatch')
    if (card?.kind !== 'dispatch') return
    expect(card.order).toEqual(['c1', 'c2'])
    expect(card.open).toBe(false)
    // 数据面：两个 subtask entry 按 subtaskId 派生可查（无并行索引，评审 #18）
    expect(subtaskEntryOf(useTurnStore.getState().entries, 'c1')).toBeDefined()
    expect(subtaskEntryOf(useTurnStore.getState().entries, 'c2')).toBeDefined()
  })

  it('收起时成员状态变化亮「有更新」；展开后清掉', () => {
    seedPlan()
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'running', time: 1 } as TurnEvent)
    let card = dispatchEntry()
    if (card?.kind !== 'dispatch') throw new Error('no card')
    // 默认收起：状态变化亮 fresh
    expect(card.fresh).toBe(true)
    // 展开（用户动作，写偏好）：清掉 fresh
    useTurnStore.setState(st => ({
      entries: st.entries.map(entry => entry.kind === 'dispatch' ? { ...entry, open: true, fresh: false } : entry),
    }))
    apply({ type: 'subtask', id: 'c2', agentId: 'huiyu', state: 'running', time: 2 } as TurnEvent)
    card = dispatchEntry()
    if (card?.kind !== 'dispatch') throw new Error('no card')
    expect(card.fresh).toBe(false)
  })

  it('summary 收口：未定论格子明确说「已停止」，已成的不改写', () => {
    seedPlan()
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'succeeded', detail: '结论', time: 1 } as TurnEvent)
    apply({ type: 'subtask', id: 'c2', agentId: 'huiyu', state: 'running', time: 2 } as TurnEvent)
    apply({ type: 'summary', state: 'completed', text: '收尾', time: 3 } as TurnEvent)
    const c1Entry = sub('c1')
    const c2Entry = sub('c2')
    // 成功的不动（真实结果不改写）；还在跑的明确改写为「已停止」并定格秒数
    // （settleCardForSummary 语义：结束的一轮里不能有永远在干活的成员）。
    expect(c1Entry.state).toBe('succeeded')
    expect(c2Entry.state).toBe('cancelled')
    expect(c2Entry.live).toBe(false)
    expect(c2Entry.finishedAt).toBeDefined()
  })

  it('重派（dispatched）清空正文：旧尝试的迟到增量不串进新版', () => {
    seedPlan()
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'running', time: 1 } as TurnEvent)
    apply({ type: 'subtask_delta', id: 'c1', delta: '旧版半截', } as TurnEvent)
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'dispatched', startedAt: 9, time: 2 } as TurnEvent)
    const entry = sub('c1')
    expect(entry.body).toBe('')
    expect(entry.terminal).toBe(false)
    expect(entry.live).toBe(true)
  })

  it('summary 之后同 id 重派：原地重置数据面，不再另起一条（评审 #18 派生化语义）', () => {
    seedPlan()
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'succeeded', detail: '结论', time: 1 } as TurnEvent)
    apply({ type: 'summary', state: 'completed', text: '收尾', time: 2 } as TurnEvent)
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'dispatched', startedAt: 9, time: 3 } as TurnEvent)
    const same = useTurnStore.getState().entries.filter(entry => entry.kind === 'subtask' && entry.subtaskId === 'c1')
    expect(same.length).toBe(1)
    expect(sub('c1').state).toBe('dispatched')
  })

  it('终态（external_pending）事件的 prepared 操作卡必须写入 entry——deck 派生源（0.13.1 生产实证）', () => {
    seedPlan()
    // 生产时序：running 事件先建立条目（不带 actions），终态才带 prepared 操作卡。
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'running', time: 1 } as TurnEvent)
    const prepared = [{ id: 'act-1', kind: 'blog.publish', state: 'prepared', title: '发布', confirmLabel: '确认' }]
    apply({
      type: 'subtask', id: 'c1', agentId: 'blog', state: 'external_pending',
      detail: '已写入草稿，等待确认', actions: prepared, time: 2,
    } as unknown as TurnEvent)
    expect(sub('c1').actions?.[0]?.state).toBe('prepared')
    expect(sub('c1').actions?.[0]?.confirmLabel).toBe('确认')
  })

  it('taskId 在终态事件补齐：running 先建（不带 taskId）不能让 /action 带空 taskId（0.13.4 生产实证 404 根因）', () => {
    seedPlan()
    // 生产时序：running 事件建条目时不带 taskId，终态才带。
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'running', time: 1 } as TurnEvent)
    apply({
      type: 'subtask', id: 'c1', agentId: 'blog', state: 'external_pending',
      taskId: 'task-real', detail: '等待确认', time: 2,
    } as unknown as TurnEvent)
    expect(sub('c1').taskId).toBe('task-real')
  })

  it('决策受理本地摘卡：resolveActionLocally 移除对应操作卡，其他成员不受影响（0.13.3）', () => {
    seedPlan()
    const preparedA = [{ id: 'act-a', kind: 'blog.publish', state: 'prepared', title: '发布' }]
    const preparedB = [{ id: 'act-b', kind: 'blog.publish', state: 'prepared', title: '发布' }]
    apply({ type: 'subtask', id: 'c1', agentId: 'blog', state: 'external_pending', actions: preparedA, time: 1 } as unknown as TurnEvent)
    apply({ type: 'subtask', id: 'c2', agentId: 'huiyu', state: 'external_pending', actions: preparedB, time: 2 } as unknown as TurnEvent)
    // 受理 c1 的确认：只有 c1 的卡被摘下
    resolveActionLocally('c1', 'act-a')
    expect(sub('c1').actions).toEqual([])
    expect(sub('c2').actions?.[0]?.id).toBe('act-b')
  })

  it('偏好读写（butler.card.{taskId}）：折叠/只看结论落本机', () => {
    saveCardPref('task-p', { open: false })
    expect(readCardPrefs('task-p').open).toBe(false)
    saveCardPref('task-p', { resultOnly: true })
    expect(readCardPrefs('task-p')).toEqual({ open: false, resultOnly: true })
    expect(readCardPrefs('')).toEqual({})
  })
})

describe('运行游标治理（评审 #18：taskId 字段已删，lastRunTaskId 唯一）', () => {
  beforeEach(() => {
    localStorage.clear()
    useTurnStore.setState({
      entries: [], butlerSpeechKey: null,
      viewToken: 0, conversationId: null, lastRunTaskId: '',
    })
  })

  const record = (id: string, state = 'completed'): TaskRecord => ({
    id, conversationId: 'conv-1', goal: '目标', state,
    note: '', summary: '', error: null, createdAt: 1, updatedAt: 2,
    subtasks: [{ id: `${id}-s1`, agentId: 'blog', goal: '活', state: 'succeeded', result: '完成', error: null, artifacts: [], startedAt: 1, finishedAt: 2 }],
  } as unknown as TaskRecord)

  it('renderTaskRecord（任务详情页视图）不写 lastRunTaskId：历史记录不得污染运行游标', () => {
    useTurnStore.setState({ lastRunTaskId: 'live-task' })
    useTurnStore.getState().renderTaskRecord(record('old-task'))
    expect(useTurnStore.getState().lastRunTaskId).toBe('live-task')
  })

  it('subtask/plan/run 头照旧推进 lastRunTaskId（stop/supplement 的目标）', () => {
    apply({ type: 'run', runId: 'r1' } as TurnEvent)
    apply({ type: 'plan', taskId: 'task-y', subtasks: [{ id: 'k1', agentId: 'blog' }] } as TurnEvent)
    expect(useTurnStore.getState().lastRunTaskId).toBe('task-y')
    apply({ type: 'subtask', id: 'k1', agentId: 'blog', state: 'waiting_user', taskId: 'task-z', detail: '等话', time: 1 } as TurnEvent)
    expect(useTurnStore.getState().lastRunTaskId).toBe('task-z')
    // ask 卡兜底也读运行游标：事件不带 taskId 时落到 lastRunTaskId（0.13.4 口径）
    apply({ type: 'subtask', id: 'k2', agentId: 'huiyu', state: 'waiting_user', detail: '再等一句', time: 2 } as TurnEvent)
    expect(sub('k2').ask?.taskId).toBe('task-z')
  })
})
