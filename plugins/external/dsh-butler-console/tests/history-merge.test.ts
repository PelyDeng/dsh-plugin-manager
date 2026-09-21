/**
 * 历史合并纯数据层的单测（批 1：全局时间序/数值序号比较/跨页去重与插入计划）。
 * 语义对齐 web/modules/history.js（复核 1/复核 2 的教训都在断言里）。
 */
import { describe, expect, it } from 'vitest'
import { compareHistoryEntries, mergeHistoryEntries, planHistoryInsertion, timeOf } from '../web-react/src/lib/history-merge.ts'
import type { TaskRecord, TranscriptItem } from '../web-react/src/lib/api.ts'

function transcript(seq: string, text: string, time: number, role = 'butler'): TranscriptItem {
  return { seq, role, text, time, interrupted: false }
}

function task(id: string, goal: string, updatedAt: number): TaskRecord {
  return {
    id, conversationId: 'conv-1', goal, note: null, state: 'completed',
    createdAt: updatedAt - 1000, updatedAt, summary: null, error: null, subtasks: [],
  }
}

describe('mergeHistoryEntries', () => {
  it('字符串序号按数值比较：t:10 排在 t:2 之后（复核 2）', () => {
    const entries = mergeHistoryEntries(
      [transcript('10', '晚', 3000), transcript('2', '早', 3000)],
      [],
    )
    expect(entries.map(entry => entry.id)).toEqual(['t:2', 't:10'])
  })

  it('任务按收尾时间锚定，同刻排在对话之后（摘要属于结局）', () => {
    const entries = mergeHistoryEntries(
      [transcript('t:1', '对话', 3000)],
      [task('task-1', '任务', 3000)],
    )
    expect(compareHistoryEntries(entries[0]!, entries[1]!)).toBeLessThan(0)
    expect(entries[1]!.kind).toBe('task')
  })

  it('时间错序输入被排成全局时间序', () => {
    const entries = mergeHistoryEntries(
      [transcript('5', '后', 9000)],
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

describe('planHistoryInsertion', () => {
  it('跨页时间交叉：新条目插到已显示内容中间，不是整体垫顶（复核 1）', () => {
    const existing = mergeHistoryEntries(
      [transcript('9', '后', 9000), transcript('10', '最新', 10_000)],
      [],
    )
    // 更早一页里有一条时间落在两页已显示内容之间。
    const fresh = mergeHistoryEntries([transcript('3', '中间', 9500)], [])
    const plan = planHistoryInsertion(existing, fresh)
    expect(plan.merged.map(entry => entry.id)).toEqual(['t:9', 't:3', 't:10'])
    expect(plan.insertions).toHaveLength(1)
    expect(plan.insertions[0]!.entry.id).toBe('t:3')
    expect(plan.insertions[0]!.beforeId).toBe('t:10')
  })

  it('跨页去重：同一稳定标识只保留一份，计划为空', () => {
    const existing = mergeHistoryEntries([transcript('t:1', '已有', 1000)], [])
    const fresh = mergeHistoryEntries([transcript('t:1', '重复', 1000)], [])
    const plan = planHistoryInsertion(existing, fresh)
    expect(plan.merged).toHaveLength(1)
    expect(plan.insertions).toHaveLength(0)
  })

  it('定位计划幂等：同一批 fresh 重复并入不产生新插入', () => {
    const base = mergeHistoryEntries([transcript('t:1', 'a', 1000)], [])
    const fresh = mergeHistoryEntries([transcript('t:2', 'b', 2000)], [])
    const once = planHistoryInsertion(base, fresh)
    const twice = planHistoryInsertion(once.merged, fresh)
    expect(twice.insertions).toHaveLength(0)
    expect(twice.merged).toHaveLength(2)
  })
})
