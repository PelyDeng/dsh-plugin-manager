/**
 * 调度卡 store 层单测（批 4b）：plan 建卡/fresh 有更新/结算收口/偏好读写。
 * 语义对齐 web/modules/dcard.js（mountDispatch/attachToDispatch/settleCardForSummary）。
 * 偏好走 localStorage：文件级 happy-dom 环境（不动全局配置）。
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { readCardPrefs, saveCardPref, useTurnStore } from '../web-react/src/stores/turn.ts'
import type { TurnEvent } from '../web-react/src/lib/turn-event.ts'

function apply(event: TurnEvent): void {
  useTurnStore.getState().applyTurnEvent(event)
}

function dispatchEntry() {
  return useTurnStore.getState().entries.find(entry => entry.kind === 'dispatch')
}

describe('调度卡数据面（plan/subtask/summary）', () => {
  beforeEach(() => {
    localStorage.clear()
    useTurnStore.setState({
      entries: [], bubbleKeys: new Map(), butlerSpeechKey: null,
      taskId: null, viewToken: 0, conversationId: null,
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
    // 数据面：两个 subtask entry 可按 bubbleKeys 找到
    const keys = useTurnStore.getState().bubbleKeys
    expect(keys.get('c1')).toBeDefined()
    expect(keys.get('c2')).toBeDefined()
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
    // summary 分支会清 bubbleKeys：条目 key 要在收口前记下。
    const keys = useTurnStore.getState().bubbleKeys
    const c1 = keys.get('c1')
    const c2 = keys.get('c2')
    apply({ type: 'summary', state: 'completed', text: '收尾', time: 3 } as TurnEvent)
    const entries = useTurnStore.getState().entries
    const c1Entry = entries.find(entry => entry.key === c1)
    const c2Entry = entries.find(entry => entry.key === c2)
    if (c1Entry?.kind !== 'subtask' || c2Entry?.kind !== 'subtask') throw new Error('entries missing')
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
    const key = useTurnStore.getState().bubbleKeys.get('c1')
    const entry = useTurnStore.getState().entries.find(candidate => candidate.key === key)
    if (entry?.kind !== 'subtask') throw new Error('missing')
    expect(entry.body).toBe('')
    expect(entry.terminal).toBe(false)
    expect(entry.live).toBe(true)
  })

  it('偏好读写（butler.card.{taskId}）：折叠/只看结论落本机', () => {
    saveCardPref('task-p', { open: false })
    expect(readCardPrefs('task-p').open).toBe(false)
    saveCardPref('task-p', { resultOnly: true })
    expect(readCardPrefs('task-p')).toEqual({ open: false, resultOnly: true })
    expect(readCardPrefs('')).toEqual({})
  })
})
