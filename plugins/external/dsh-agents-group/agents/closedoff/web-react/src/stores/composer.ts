/**
 * 输入区 store：textarea 的草稿值。
 *
 * 收进 store 而不是组件局部 state 的原因：发送失败时旧页面会把原话回填输入框
 * （用户不必重打），这个动作发生在 controller 层——草稿真相源必须跨层共享。
 */
import { create } from 'zustand'

export interface ComposerState {
  draft: string
  setDraft: (draft: string) => void
}

export const useComposerStore = create<ComposerState>(set => ({
  draft: '',
  setDraft: draft => set({ draft }),
}))
