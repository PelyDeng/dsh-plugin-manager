/**
 * 输入区 IME/键盘发送判定的等价单测（删码评审 B F3：旧 tests/chat-ui.test.ts 的
 * 「chat keyboard / composition events」两用例随 vanilla 前端删除，React 侧实现
 * 收敛为 lib/keyboard.ts 的 shouldSendChatEnter（Composer 的 onKeyDown 消费），
 * 这里补回护栏）。
 *
 * 语义：只有桌面 Enter 发送；触摸/窄屏、Shift+Enter 换行、输入法合成期间
 * （isComposing 事件位、composition 引用位、旧版浏览器的 keyCode 229）都不能
 * 触发发送，避免候选词上屏前误发。
 */
import { describe, expect, it } from 'vitest'

const { shouldSendChatEnter } = await import('../lib/keyboard.ts')

/** 桌面 Enter 基准事件（旧码同款夹具）。 */
const ENTER = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }

describe('输入区键盘判定（shouldSendChatEnter）', () => {
  it('只有桌面 Enter 发送：触摸窄屏、Shift+Enter 与其它键不发送', () => {
    expect(shouldSendChatEnter(ENTER, false, false)).toBe(true)
    expect(shouldSendChatEnter(ENTER, true, false)).toBe(false)
    expect(shouldSendChatEnter({ ...ENTER, shiftKey: true }, false, false)).toBe(false)
    expect(shouldSendChatEnter({ ...ENTER, key: 'a' }, false, false)).toBe(false)
  })

  it('输入法合成期间不能发送：isComposing、composition 引用位与 keyCode 229', () => {
    expect(shouldSendChatEnter({ ...ENTER, isComposing: true }, false, false)).toBe(false)
    expect(shouldSendChatEnter({ ...ENTER, keyCode: 229 }, false, false)).toBe(false)
    expect(shouldSendChatEnter(ENTER, false, true)).toBe(false)
    expect(shouldSendChatEnter(ENTER, false, false)).toBe(true)
  })
})
