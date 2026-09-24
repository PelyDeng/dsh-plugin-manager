/**
 * restore 五类复原投影的等价单测（批 1 DoD：restore）。
 *
 * 行为基准=旧 web/app.js restore 段（app.js:733-798）：工具 chips 相位、
 * error 卡复原、轨迹（含 groups/cameras 两个来源）、围栏、媒体、卡片、
 * hasStructured 汇总、completed 元信息与评分绑定。
 */
import { describe, expect, it } from 'vitest'
import { installBrowserGlobals } from './helpers.ts'

installBrowserGlobals()

const { projectRestoredHistory, projectRestoredAssistant } = await import('../lib/restore.ts')
const { stripMarkdownTables } = await import('../lib/render-text.ts')
import type { HistoryResponse } from '../lib/types.ts'

const baseAssistant = {
  role: 'assistant' as const,
  text: '',
  thinking: '',
  thinkingDone: false,
  tools: [],
  tracks: {},
  fences: {},
  media: {},
  cards: {},
  time: 0,
  done: true,
}

describe('projectRestoredHistory：五类复原', () => {
  it('完整回合：chips/cards/tracks/fences/media/feedback 全部入数据面', () => {
    const response: HistoryResponse = {
      history: [
        { role: 'user', text: '查一下园区' },
        {
          ...baseAssistant,
          text: '园区一切正常\n\n| 多余 | 表格 |\n| --- | --- |\n| a | b |',
          thinking: '第一步：查总览\n第二步：查预警',
          thinkingDone: true,
          tools: [
            { callId: 'c1', name: 'closedoff_vehicle_comprehensive_page', status: 'ok', time: 100, durMs: 200 },
            { callId: 'c2', name: 'closedoff_vehicle_track', status: 'ok', time: 400, durMs: 600 },
            { callId: 'c3', name: 'closedoff_black_page', status: 'error', time: 1100, durMs: 50, presentation: { tool: 'closedoff_black_page', group: 'authorization', variant: 'records', sourceLabel: '黑名单' } },
          ],
          tracks: { c2: { points: [{ lon: 1, lat: 2 }], vehicleNo: '云A7D00M', groups: [{ name: '东门组' }] } },
          fences: { c4: { name: '围栏A' } },
          media: { c5: [{ startTime: 't', timeLength: '10s', deviceId: 1, mediaUrl: 'u' }] },
          cards: {
            c1: { tool: 'closedoff_vehicle_comprehensive_page', group: 'overview', variant: 'summary', sourceLabel: '车辆概览', state: 'data', count: 1, shown: 1, note: '', cards: [{ title: '概览', fields: [{ k: '在园车辆', v: '8', tone: '' }] }] },
            c3: { tool: 'closedoff_black_page', group: 'authorization', variant: 'records', sourceLabel: '黑名单', state: 'error', count: 0, shown: 0, note: '', cards: [] },
          },
          finishReason: 'completed',
          messageId: 'm-1',
          branchSeq: 7,
          completedAt: 1700,
          runMs: 1600,
          ttftMs: 90,
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ],
      feedback: [{ messageId: 'm-1', rating: 'negative' }],
    }
    const messages = projectRestoredHistory(response)
    expect(messages).toHaveLength(2)
    const assistant = messages[1]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')

    expect(assistant.tools).toHaveLength(3)
    expect(assistant.tools[0]).toMatchObject({ callId: 'c1', phase: 'done', durMs: 200 })
    expect(assistant.tools[2]).toMatchObject({ callId: 'c3', phase: 'error' })
    // 失败 + 带展示描述 → 复原 error 卡。
    expect(assistant.cards['c3']?.state).toBe('error')
    expect(assistant.tracks['c2']).toMatchObject({ vehicleNo: '云A7D00M', groups: [{ name: '东门组' }] })
    expect(assistant.fences['c4']).toEqual({ name: '围栏A' })
    expect(assistant.media['c5']).toHaveLength(1)
    expect(assistant.hasStructured).toBe(true)
    expect(assistant.meta).toMatchObject({ messageId: 'm-1', branchSeq: 7, runMs: 1600, ttftMs: 90 })
    expect(assistant.rating).toBe('negative')
  })

  it('空轨迹点位不产生 track（旧码 points.length 守卫）；空 media 不入面', () => {
    const assistant = projectRestoredAssistant({
      ...baseAssistant,
      tracks: { c1: { points: [], vehicleNo: 'X' } },
      media: { c2: [] },
      cards: {},
    })
    expect(assistant.tracks).toEqual({})
    expect(assistant.media).toEqual({})
    expect(assistant.hasStructured).toBe(false)
  })

  it('非 completed 不携带 meta；feedbackUnavailable 传播', () => {
    const messages = projectRestoredHistory({
      history: [{ ...baseAssistant, text: '中断的回答', finishReason: 'aborted', done: true }],
      feedback: [],
      feedbackUnavailable: true,
    })
    const assistant = messages[0]
    if (assistant?.kind !== 'assistant') return expect.fail('助手消息缺失')
    expect(assistant.meta).toBeUndefined()
    expect(assistant.finishReason).toBe('aborted')
    expect(assistant.feedbackUnavailable).toBe(true)
  })

  it('hasStructured 判定：data/empty 卡算结构化，loading/error 不算', () => {
    const payload = (state: string) => ({
      tool: 't', group: 'other', variant: 'records', sourceLabel: 'x', state, count: 0, shown: 0, note: '', cards: [],
    })
    expect(projectRestoredAssistant({ ...baseAssistant, cards: { a: payload('data') } }).hasStructured).toBe(true)
    expect(projectRestoredAssistant({ ...baseAssistant, cards: { a: payload('empty') } }).hasStructured).toBe(true)
    expect(projectRestoredAssistant({ ...baseAssistant, cards: { a: payload('error') } }).hasStructured).toBe(false)
  })

  it('正文剥离重复 Markdown 表格（存在结构化结果时）', () => {
    const text = '结论如下\n\n| 字段 | 值 |\n| --- | --- |\n| 在园 | 8 |\n\n补充说明'
    // 旧码口径：删除表格行后前后空行原样保留（不补删空行）。
    expect(stripMarkdownTables(text)).toBe('结论如下\n\n\n补充说明')
    // 代码块内的表格不剥。
    const inCode = '```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```'
    expect(stripMarkdownTables(inCode)).toBe(inCode)
  })
})
