/**
 * 输入框回填单通道（评审 #10 步 4 收口）：撕条/追问芯片/发送失败回填，凡是
 * 「把话放进输入框」的跨组件动作统一走 pendingFill——此前三条注册回调通道
 * （registerDraftRestore/registerTearTap/registerDraftRestoreTap）名实纠缠已删。
 * Composer 订阅消费后清空；@点名插入在 Composer 内部就地改稿，不经此通道。
 */
import { create } from 'zustand'

/** restore：只在输入框为空时回填（发送失败回填，用户后来打过字就不覆盖——I02）。 */
export type FillMode = 'restore' | 'fill'

interface ComposerState {
  pendingFill: { text: string; mode: FillMode } | null
  /** fill 直接替换（撕条/追问芯片：点了就是要它）。 */
  requestFill: (text: string, mode?: FillMode) => void
  clearFill: () => void
}

export const useComposerStore = create<ComposerState>(set => ({
  pendingFill: null,
  requestFill: (text, mode = 'fill') => set({ pendingFill: { text, mode } }),
  clearFill: () => set({ pendingFill: null }),
}))
