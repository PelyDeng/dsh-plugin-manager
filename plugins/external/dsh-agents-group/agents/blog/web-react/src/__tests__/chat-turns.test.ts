/**
 * chatTurns 分组投影的等价单测（行为基准=旧 web/chat-turns.js，逐场景对照）。
 */
import { describe, expect, it } from 'vitest'
import { chatTurns, isOperationCard, isTurnGroup } from '../lib/chat-turns.ts'
import type { ChatMessage, OperationRecord } from '../lib/types.ts'

const user = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', seq: 1, time: 0, text, ...extra })
const assistant = (id: string, text: string, turn: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'assistant', seq: 2, time: 0, turn, text, interrupted: false, feedback: true, ...extra })
const tool = (id: string, name: string, status: string, turn: number): ChatMessage =>
  ({ id, role: 'tool', seq: 3, time: 0, turn, name, status })

/** noUncheckedIndexedAccess 下的索引收窄（越界即断言失败）。 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`索引越界：${index}`)
  return value
}

describe('回合分组', () => {
  it('user 开组，助手/工具/状态归组，turn 切换开新组', () => {
    const display = chatTurns([
      user('u1', '第一条'),
      tool('t1', 'blog_search_posts', 'succeeded', 1),
      assistant('a1', '第一个回答', 1),
      user('u2', '第二条'),
      assistant('a2', '第二个回答', 2),
    ])
    expect(display).toHaveLength(4)
    expect(isTurnGroup(display[1])).toBe(true)
    const group1 = at(display, 1)
    if (!isTurnGroup(group1)) throw new Error('unreachable')
    expect(group1.tools.map(node => node.id)).toEqual(['t1'])
    expect(group1.text).toBe('第一个回答')
    expect(group1.displayKey).toBe('answer-u1-0')
    expect(display[3]).toMatchObject({ id: 'a2' })
    const group2 = at(display, 3)
    if (!isTurnGroup(group2)) throw new Error('unreachable')
    expect(group2.displayKey).toBe('answer-u2-1')
  })

  it('busy 且末条是用户消息：补 pending 组承接 live 段', () => {
    const display = chatTurns([user('u1', '正在问', { turn: 7 })], { busy: true })
    expect(isTurnGroup(display[1])).toBe(true)
    const pending = at(display, 1)
    if (!isTurnGroup(pending)) throw new Error('unreachable')
    expect(pending.id).toBe('pending-u1')
    expect(pending.turn).toBe(7)
    expect(pending.text).toBe('')
  })

  it('非 busy 不补 pending 组', () => {
    const display = chatTurns([user('u1', '已完成的问题', { turn: 7 })])
    expect(display).toHaveLength(1)
  })

  it('reasoning 聚合到组，steps 收全量助手步骤', () => {
    const display = chatTurns([
      user('u1', '问'),
      assistant('a-step1', '', 1, { reasoning: '先想一下' }),
      assistant('a-step2', '最终回答', 1),
    ])
    const group = at(display, 1)
    if (!isTurnGroup(group)) throw new Error('unreachable')
    expect(group.reasoning).toBe('先想一下')
    expect(group.reasoningSource).toBe('a-step1')
    expect(group.steps).toHaveLength(2)
    expect(group.text).toBe('最终回答')
  })
})

describe('操作卡时间线', () => {
  it('操作卡挂在归属回合组之后（下一条用户消息之前）', () => {
    const operation: OperationRecord = { id: 'op-1', mode: 'publish', title: '草稿一', status: 'prepared', requestId: 'req-1' }
    const display = chatTurns(
      [user('u1', '发一篇', { requestId: 'req-1' }), assistant('a1', '已准备', 1)],
      { operations: [operation] },
    )
    const positions = display.map(node => (isOperationCard(node) ? 'op' : isTurnGroup(node) ? 'group' : node.id))
    expect(positions).toEqual(['u1', 'group', 'op'])
  })

  it('缺归属请求的操作卡前置并标 unassociated', () => {
    const operation: OperationRecord = { id: 'op-x', mode: 'delete', title: '旧文', status: 'prepared' }
    const display = chatTurns([user('u1', '问'), assistant('a1', '答', 1)], { operations: [operation] })
    const card = at(display, 0)
    expect(isOperationCard(card)).toBe(true)
    if (!isOperationCard(card)) throw new Error('unreachable')
    expect(card.unassociated).toBe(true)
    expect(card.operation.id).toBe('op-x')
  })
})
