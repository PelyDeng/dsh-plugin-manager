/**
 * 做完的活显示「耗时」多少。
 *
 * 这一段没有浏览器验收，但用户一眼就能看出对错：真实耗时 57 秒的一个活，被显示成
 * 「12 分 30 秒」——因为算的是「开始到现在」，页面开着就一直在涨，隔十几分钟再看就更大。
 * 真机上就是这么暴露的（数据库里 `finished_at - started_at` 是 57 秒）。
 *
 * 两条性质：结束时刻给了就必须按它算（不再涨）；渲染处必须把结束时刻传进来。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { webSource } from './helpers/web-source.ts'
import { describe, expect, it } from 'vitest'

const source = webSource()

/** 取出 `formatElapsed`：页面是浏览器模块，测试只拿这一个函数的行为。 */
function loadFormatElapsed(): (from: number, to?: number) => string {
  const body = source.match(/function formatElapsed\(from, to = Date\.now\(\)\) \{[\s\S]*?\n\}\n/)?.[0]
  if (body === undefined) throw new Error('formatElapsed 源码未找到')
  return Function(`${body}; return formatElapsed`)() as (from: number, to?: number) => string
}

describe('耗时只在跑的时候涨', () => {
  it('结束时刻给了就按它算，之后再问还是那个数', () => {
    const formatElapsed = loadFormatElapsed()
    const startedAt = 1_700_000_000_000
    const finishedAt = startedAt + 57_000
    expect(formatElapsed(startedAt, finishedAt)).toBe('57 秒')
    // 页面重新渲染、或隔一段时间再看：还是 57 秒，不跟着当前时间涨。
    expect(formatElapsed(startedAt, finishedAt)).toBe('57 秒')
    expect(formatElapsed(startedAt, finishedAt + 13 * 60_000)).toBe('13 分 57 秒')
  })

  it('还在跑的时候才用当前时间', () => {
    const formatElapsed = loadFormatElapsed()
    expect(formatElapsed(Date.now() - 5_000)).toBe('5 秒')
    expect(formatElapsed(Date.now() - 125_000)).toBe('2 分 5 秒')
  })

  it('没有开始时刻就不显示', () => {
    const formatElapsed = loadFormatElapsed()
    expect(formatElapsed(0)).toBe('')
    expect(formatElapsed(undefined as unknown as number)).toBe('')
  })

  it('两处渲染都把结束时刻传了进去', () => {
    // 少传一个参数就会退回「算到现在」，正是这个 bug 的形态。
    expect(source).toContain('formatElapsed(subtask.startedAt, subtask.finishedAt)')
    expect(source).toContain('formatElapsed(view.startedAt, event.time)')
    expect(source).not.toMatch(/formatElapsed\((subtask\.startedAt|view\.startedAt)\)/u)
  })
})
