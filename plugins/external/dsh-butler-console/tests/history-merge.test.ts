/**
 * 历史合并纯数据层的单测（批 1：全局时间序/数值序号比较/跨页去重与插入计划）。
 * 语义对齐 web/modules/history.js（复核 1/复核 2 的教训都在断言里）。
 */
import { describe, expect, it } from 'vitest'
import { compareHistoryEntries, mergeHistoryEntries, mergeTaskDetails, planHistoryInsertion, subtaskEntry, timeOf } from '../web-react/src/lib/history-merge.ts'
import type { TaskRecord, TaskSubtask, TaskSummary, TranscriptItem } from '../web-react/src/lib/api.ts'

function transcript(seq: number, text: string, time: number, role = 'butler'): TranscriptItem {
  return { seq, role, text, time, interrupted: false }
}

/** 列表投影（/history 真实形状：无 subtasks，只有收尾计数——批 1 评审 P0-1 后的契约）。 */
function task(id: string, goal: string, updatedAt: number): TaskSummary {
  return {
    id, conversationId: 'conv-1', goal, state: 'completed',
    createdAt: updatedAt - 1000, updatedAt, subtaskTotal: 2, subtaskDone: 2,
  }
}

describe('mergeHistoryEntries', () => {
  it('字符串序号按数值比较：t:10 排在 t:2 之后（复核 2）', () => {
    const entries = mergeHistoryEntries(
      [transcript(10, '晚', 3000), transcript(2, '早', 3000)],
      [],
    )
    expect(entries.map(entry => entry.id)).toEqual(['t:2', 't:10'])
  })

  it('任务按收尾时间锚定，同刻排在对话之后（摘要属于结局）', () => {
    const entries = mergeHistoryEntries(
      [transcript(1, '对话', 3000)],
      [task('task-1', '任务', 3000)],
    )
    expect(compareHistoryEntries(entries[0]!, entries[1]!)).toBeLessThan(0)
    expect(entries[1]!.kind).toBe('task')
  })

  it('时间错序输入被排成全局时间序', () => {
    const entries = mergeHistoryEntries(
      [transcript(5, '后', 9000)],
      [task('task-9', '中', 5000)],
    )
    entries.push({ id: 't:1', at: 1000, kind: 'user', text: '先', time: 1000, interrupted: false })
    const sorted = [...entries].sort(compareHistoryEntries)
    expect(sorted.map(entry => entry.id)).toEqual(['t:1', 'task:task-9', 't:5'])
  })

  it('timeOf：无效时间落到 0，不产出 NaN 锚点', () => {
    expect(timeOf('不是时间')).toBe(0)
    expect(timeOf(0)).toBe(0)
    expect(timeOf('2026-09-21T00:00:00Z')).toBeGreaterThan(0)
  })
})

describe('mergeTaskDetails（0.13.6 刷新恢复确认卡）', () => {
  const sub = (overrides: Partial<TaskSubtask> = {}): TaskSubtask => ({
    id: 's1', agentId: 'blog', goal: '发布文章', state: 'external_pending',
    startedAt: 1000, finishedAt: 2000, result: '已写入草稿，等待确认', error: null,
    ...overrides,
  })
  const record = (subtasks: TaskSubtask[]): TaskRecord => ({
    id: 'task-x', conversationId: 'conv-1', goal: '发文章', state: 'external_pending',
    createdAt: 900, updatedAt: 2000, subtasks, note: '', summary: '', error: '',
  })

  it('子任务卡锚定收尾时间，插到同刻对话之后、更新更晚的对话之前（用户要求的位置语义）', () => {
    const base = mergeHistoryEntries(
      [transcript(1, '第 2 条', 1500), transcript(2, '第 4 条', 3000)],
      [],
    )
    const merged = mergeTaskDetails(base, [record([sub()])])
    // 子任务 finishedAt=2000：排在 1500 的对话（第 2 条）之后、3000 的对话（第 4 条）之前
    expect(merged.map(entry => entry.id)).toEqual(['t:1', 'subtask:2000:task-x:s1', 't:2'])
  })

  it('actions 随详情投影带到条目上——刷新后确认卡的数据源', () => {
    const actions = [{ id: 'act-1', kind: 'blog.publish', state: 'prepared', confirmLabel: '确认' }]
    const merged = mergeTaskDetails([], [record([sub({ actions })])])
    expect(merged[0]?.subtask?.sub.actions).toEqual(actions)
  })

  it('同刻多任务子任务卡按 id 稳定排序，同一任务跨页去重不重复', () => {
    const a = subtaskEntry('task-a', sub({ id: 's1' }))
    const b = subtaskEntry('task-b', sub({ id: 's1' }))
    expect(a.id).not.toBe(b.id)
    // 同一任务的同一子任务重复并入（跨页重取）：稳定标识去重后只留一份
    const once = mergeTaskDetails([a], [record([sub({ id: 's1' })])].map(r => ({ ...r, id: 'task-a' })))
    expect(once.filter(entry => entry.kind === 'subtask')).toHaveLength(1)
    // 不同任务的同号子任务：都保留（各自独立的卡）
    const both = mergeTaskDetails([], [record([sub({ id: 's1' })]), { ...record([sub({ id: 's1' })]), id: 'task-b' }])
    expect(both.filter(entry => entry.kind === 'subtask')).toHaveLength(2)
  })

  it('没跑完的子任务用开始时刻锚定（waiting/running 也有位置）', () => {
    const entry = subtaskEntry('task-w', sub({ state: 'waiting_user', finishedAt: null, result: '在等你回话' }))
    expect(entry.at).toBe(1000)
  })
})

describe('planHistoryInsertion', () => {
  it('跨页时间交叉：新条目插到已显示内容中间，不是整体垫顶（复核 1）', () => {
    const existing = mergeHistoryEntries(
      [transcript(9, '后', 9000), transcript(10, '最新', 10_000)],
      [],
    )
    // 更早一页里有一条时间落在两页已显示内容之间。
    const fresh = mergeHistoryEntries([transcript(3, '中间', 9500)], [])
    const plan = planHistoryInsertion(existing, fresh)
    expect(plan.merged.map(entry => entry.id)).toEqual(['t:9', 't:3', 't:10'])
    expect(plan.insertions).toHaveLength(1)
    expect(plan.insertions[0]!.entry.id).toBe('t:3')
    expect(plan.insertions[0]!.beforeId).toBe('t:10')
  })

  it('跨页去重：同一稳定标识只保留一份，计划为空', () => {
    const existing = mergeHistoryEntries([transcript(1, '已有', 1000)], [])
    const fresh = mergeHistoryEntries([transcript(1, '重复', 1000)], [])
    const plan = planHistoryInsertion(existing, fresh)
    expect(plan.merged).toHaveLength(1)
    expect(plan.insertions).toHaveLength(0)
  })

  it('定位计划幂等：同一批 fresh 重复并入不产生新插入', () => {
    const base = mergeHistoryEntries([transcript(1, 'a', 1000)], [])
    const fresh = mergeHistoryEntries([transcript(2, 'b', 2000)], [])
    const once = planHistoryInsertion(base, fresh)
    const twice = planHistoryInsertion(once.merged, fresh)
    expect(twice.insertions).toHaveLength(0)
    expect(twice.merged).toHaveLength(2)
  })
})
