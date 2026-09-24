/**
 * 会话投影 store：当前打开会话的消息数组（历史复原结果 + 已归档轮次）。
 *
 * 活动中的流式轮次不在这里（stores/turn.ts）；done/停止/出错时由 chat-controller
 * 把 turn 固化成一条助手消息追加进来。切换会话的「清面板」也在这里——由
 * beginViewChange 原子动作链调用。
 */
import { create } from 'zustand'
import type { BoardMessage } from '../lib/restore.ts'

export type RestorePhase = 'idle' | 'loading' | 'error'

export interface BoardState {
  messages: BoardMessage[]
  restorePhase: RestorePhase
  restoreError: string | null
  /** 会话切换/新建的清面板（原子动作的一段，不做别的）。 */
  reset: () => void
  setRestoring: () => void
  setMessages: (messages: BoardMessage[]) => void
  setRestoreError: (message: string) => void
  appendMessage: (message: BoardMessage) => void
  /** 归档后覆写最后一条助手消息（评分等晚到信息）。 */
  patchMessage: (index: number, patch: Partial<Extract<BoardMessage, { kind: 'assistant' }>>) => void
}

export const useBoardStore = create<BoardState>((set) => ({
  messages: [],
  restorePhase: 'idle',
  restoreError: null,

  reset: () => set({ messages: [], restorePhase: 'idle', restoreError: null }),
  setRestoring: () => set({ restorePhase: 'loading', restoreError: null }),
  setMessages: messages => set({ messages, restorePhase: 'idle', restoreError: null }),
  setRestoreError: restoreError => set({ restorePhase: 'error', restoreError }),
  appendMessage: message => set(state => ({ messages: [...state.messages, message] })),
  patchMessage: (index, patch) => set(state => {
    const messages = [...state.messages]
    const current = messages[index]
    if (current === undefined || current.kind !== 'assistant') return state
    messages[index] = { ...current, ...patch }
    return { messages }
  }),
}))
