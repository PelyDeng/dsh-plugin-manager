/**
 * 消息流跟随滚动判定的等价单测（删码评审 B F2：旧 vanilla 前端的 followBottom
 * 随退役删除，React 侧实现收敛为 lib/viewport.ts 的纯函数后补回护栏）。
 *
 * 语义（MessageList 的消费方式）：距底 ≤24px 视为「在底部附近」，新内容到达时
 * 自动下滚；向上翻阅超过容差即停，不再打扰用户阅读位置。
 */
import { describe, expect, it } from 'vitest'

const { followsBottom, FOLLOW_BOTTOM_TOLERANCE_PX } = await import('../lib/viewport.ts')

describe('消息流跟随滚动（followsBottom）', () => {
  it('容差与旧口径一致（24px）', () => {
    expect(FOLLOW_BOTTOM_TOLERANCE_PX).toBe(24)
  })

  it('在底部与容差边界内算跟随，恰好超出即停', () => {
    // 恰好贴底：scrollHeight - scrollTop - clientHeight = 0。
    expect(followsBottom(976, 1000, 24)).toBe(true)
    // 距底恰好 24px：边界保留（旧码 <=）。
    expect(followsBottom(652, 1000, 324)).toBe(true)
    // 距底 25px：向上翻阅即停。
    expect(followsBottom(651, 1000, 324)).toBe(false)
  })

  it('内容不足一屏与长时间阅读位置各自成立', () => {
    // 内容不足一屏（无滚动）：scrollHeight === clientHeight，恒跟随。
    expect(followsBottom(0, 300, 324)).toBe(true)
    // 长内容顶部（scrollTop=0）：不跟随。
    expect(followsBottom(0, 5000, 300)).toBe(false)
    // 长内容中部：不跟随。
    expect(followsBottom(2000, 5000, 300)).toBe(false)
  })
})
