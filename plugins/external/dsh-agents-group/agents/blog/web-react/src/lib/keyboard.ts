/**
 * 输入区键盘语义的纯函数面（旧 web/chat.js shouldSendChatEnter 的 React 等价，
 * Composer 的 onKeyDown 消费）。
 *
 * 只含判定：Enter 发送，触摸/窄屏、Shift+Enter 与输入法合成中都不发送。
 * 组件与发送链路不在这里。
 */
export interface ChatEnterKeyEvent {
  key: string
  shiftKey: boolean
  /** KeyboardEvent.isComposing：合成进行中的按键事件。 */
  isComposing: boolean
  keyCode: number
}

/**
 * 是否按 Enter 发送（旧 shouldSendChatEnter 口径）：触摸/窄屏没有实体 Enter
 * 语义、Shift+Enter 是换行；合成中（isComposing / composition 引用位）与旧版
 * 浏览器的合成键码（keyCode 229）都不能触发发送，避免候选词上屏前误发。
 */
export function shouldSendChatEnter(event: ChatEnterKeyEvent, touch: boolean, composing: boolean): boolean {
  return event.key === 'Enter' && !touch && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229
}
