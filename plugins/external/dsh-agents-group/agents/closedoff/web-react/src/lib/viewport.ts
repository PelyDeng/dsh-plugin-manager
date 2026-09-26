/**
 * 视口断点（旧 web/conversation-history.js 的 mobile 口径：max-width 960px）。
 *
 * 历史面板的浮层/常驻形态切换、行操作与新建后的收起判断（旧码
 * `if (mobile.matches) hide()`）共用这一个来源，断点数值不散落。
 */
export const MOBILE_QUERY = '(max-width: 960px)'

/** 当前是否处于窄屏浮层形态（node/测试环境按桌面处理）。 */
export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
}

/** 跟随滚动的距底容差（旧 followBottom 口径：≤24px 视为在底部）。 */
export const FOLLOW_BOTTOM_TOLERANCE_PX = 24

/** 消息流跟随滚动判定（旧 followBottom：在底部附近时新内容自动下滚，向上翻阅即停）。 */
export function followsBottom(scrollTop: number, scrollHeight: number, clientHeight: number, tolerance: number = FOLLOW_BOTTOM_TOLERANCE_PX): boolean {
  return scrollHeight - scrollTop - clientHeight <= tolerance
}
