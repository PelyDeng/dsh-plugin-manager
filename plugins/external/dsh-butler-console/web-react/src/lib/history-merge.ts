/**
 * 历史阅读的纯数据层（语义自 web/modules/history.js 逐条迁移：时间锚点/合并去重/插入计划）。
 * 不碰 React 与 DOM——vitest 直接覆盖这里的排序与翻页语义。
 */

import type { TaskRecord, TaskSummary, TranscriptItem } from './api.ts'

/** 历史条目：对话（user/butler）与任务摘要，带稳定标识供跨页去重与定位插入。 */
export interface HistoryEntry {
  id: string
  at: number
  /** 对话条目：role（user/butler）。 */
  kind: string
  text: string
  time: number | string
  interrupted: boolean
  /** 任务条目才有：列表投影（无 subtasks，方案 P0-1 修复后的真实契约）。 */
  task?: TaskSummary
}

/** 历史条目的时间锚点：对话用消息时间，任务用收尾时间（摘要属于结局）。 */
export function timeOf(value: number | string | null | undefined): number {
  const at = new Date(value ?? 0).getTime()
  return Number.isNaN(at) ? 0 : at
}

/**
 * 历史条目的全局比较规则（初次加载与分页共用）。
 *
 * 先按时间；同刻的对话按事件序号**数值**比较——字符串比较会把 `t:10` 排到 `t:2` 前面；
 * 任务按收尾时间锚定、属于结局，同刻排在对话之后，再按 id 决胜。
 */
export function compareHistoryEntries(a: HistoryEntry, b: HistoryEntry): number {
  if (a.at !== b.at) return a.at - b.at
  const seqOf = (entry: HistoryEntry) => entry.kind === 'task' ? Number.POSITIVE_INFINITY : Number(entry.id.slice(2))
  const left = seqOf(a)
  const right = seqOf(b)
  if (Number.isNaN(left) || Number.isNaN(right)) return a.id < b.id ? -1 : 1
  if (left !== right) return left - right
  return a.id < b.id ? -1 : 1
}

/**
 * 把一页对话正文与一页任务摘要合成按时间排序的展示序列（纯数据）。
 *
 * 任务是摘要不是对话（S13）：在序列里以 `task` 出现，渲染成明确标注的摘要卡；
 * 被打断的管家答复标出来，不冒充完整结论。
 */
export function mergeHistoryEntries(transcriptItems: TranscriptItem[] | null | undefined, taskItems: TaskSummary[] | null | undefined): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const item of transcriptItems ?? []) {
    entries.push({
      id: `t:${item.seq}`,
      at: timeOf(item.time),
      kind: item.role,
      text: item.text,
      time: item.time,
      interrupted: item.interrupted === true,
    })
  }
  for (const task of taskItems ?? []) {
    entries.push({ id: `task:${task.id}`, at: timeOf(task.updatedAt ?? task.createdAt), kind: 'task', text: task.goal, time: task.updatedAt ?? task.createdAt, interrupted: false, task })
  }
  entries.sort(compareHistoryEntries)
  return entries
}

export interface InsertionPlan {
  merged: HistoryEntry[]
  insertions: Array<{ entry: HistoryEntry; beforeId: string | null }>
}

/**
 * 把新页条目并入全局序列并给出定位插入计划（纯数据）。
 *
 * 正文与任务的分页时间范围会交叉：只排新页再整体前插得不到全局时间序。按稳定标识去重后
 * 用与初次加载同一套比较规则全局排序（幂等），新条目降序逐一「插到后继之前」——降序保证
 * 处理到某条时，比它晚的新条目都已就位，后继一定有节点可参照。
 */
export function planHistoryInsertion(existing: HistoryEntry[], fresh: HistoryEntry[]): InsertionPlan {
  const known = new Map(existing.map(entry => [entry.id, entry]))
  const additions: HistoryEntry[] = []
  for (const entry of fresh) {
    if (known.has(entry.id)) continue
    known.set(entry.id, entry)
    additions.push(entry)
  }
  const merged = [...existing, ...additions].sort(compareHistoryEntries)
  const position = new Map(merged.map((entry, index) => [entry.id, index]))
  const insertions = additions
    .slice()
    .sort((a, b) => -compareHistoryEntries(a, b))
    .map(entry => {
      const index = position.get(entry.id) ?? 0
      return { entry, beforeId: merged[index + 1]?.id ?? null }
    })
  return { merged, insertions }
}
