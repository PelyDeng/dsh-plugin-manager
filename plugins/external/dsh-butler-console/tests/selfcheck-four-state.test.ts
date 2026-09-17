/**
 * 自检结论跨边界之后的**落库往返**：四态（含 `absent`）必须原样读回。
 *
 * 为什么单列一个文件：`member_return` 是 JSON 列，写进去的是运行时回报的那一份，读回来要过
 * `parseMemberReturn` 的白名单。三态时期协调方只看得见 `passed` / `unverifiable` / `failed`，
 * 「执行方根本没有自检能力」被折进 `unverifiable`，只能靠 `detail` 文本区分——而文本不能当
 * 判据（P3 评审 P-2）。四态补齐之后，若这一侧的白名单不认 `absent`，那个区分会在**落库那一刻**
 * 退化成「没有自检结论」：上游改了、下游没接，正是本仓反复出现的形态。
 *
 * 这里只测**纯函数**；真 PG 的「写入 → 换实例 → 读回」在 `storage-postgres.smoke.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { parseMemberReturn } from '../src/storage/parse.ts'

/** 一份运行时回报的留存原文。 */
const raw = (selfCheck: unknown): string => JSON.stringify({ protocol: 1, text: '在线 42 台', selfCheck })

describe('自检四态的落库往返', () => {
  it.each(['passed', 'unverifiable', 'failed', 'absent'] as const)('%s 原样读回', (status) => {
    expect(parseMemberReturn(raw({ status, detail: '一句说明' }))?.selfCheck).toEqual({ status, detail: '一句说明' })
  })

  it('⚠️ `absent` 必须在白名单里：漏掉它就在**落库那刻**退化成「没有自检结论」', () => {
    // 把 `parseSelfCheck` 的 `'absent'` 从白名单去掉，本条必须变红——这是它存在的全部意义。
    expect(parseMemberReturn(raw({ status: 'absent' }))?.selfCheck?.status).toBe('absent')
  })

  it('拼错的状态名 / 缺 status / 不是对象 → 「没有自检结论」，**绝不降级成 passed**', () => {
    expect(parseMemberReturn(raw({ status: 'PASSED' }))?.selfCheck).toBeUndefined()
    expect(parseMemberReturn(raw({}))?.selfCheck).toBeUndefined()
    expect(parseMemberReturn(raw('absent'))?.selfCheck).toBeUndefined()
    expect(parseMemberReturn(raw(null))?.selfCheck).toBeUndefined()
  })

  it('老执行方不声明 selfCheck → 字段整体缺省（不是任何一种结论）', () => {
    const parsed = parseMemberReturn(JSON.stringify({ protocol: 1, text: '在线 42 台' }))
    expect(parsed?.selfCheck).toBeUndefined()
    expect(parsed === undefined || 'selfCheck' in parsed).toBe(false)
  })

  it('非法形状整体拒绝：留存读不出来时返回 undefined，而不是半份记录', () => {
    expect(parseMemberReturn('{')).toBeUndefined()
    expect(parseMemberReturn(JSON.stringify({ text: '缺少 protocol' }))).toBeUndefined()
  })
})
