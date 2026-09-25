/**
 * 会话域 store：当前会话、全量历史快照、会话列表（旧 web/chat.js 的 state.id /
 * state.history 与 conversation-history 侧栏的数据面）。
 *
 * 「会话 id 的本地持久化与 URL 同步」收敛在 setConversationId（旧
 * sessionStorage.setItem + syncConversationUrl 的单一实现点）。
 */
import { create } from 'zustand'
import { chatStorageKey, useSessionStore } from './session.ts'
import type { ChatHistoryResult, ChatListItem, FeedbackEntry } from '../lib/types.ts'

/** sessionStorage 适配（node 测试注入内存版，避免环境分叉）。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function windowStorage(): StorageLike {
  return {
    getItem: key => globalThis.sessionStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.sessionStorage?.setItem(key, value),
    removeItem: key => globalThis.sessionStorage?.removeItem(key),
  }
}

let storage: StorageLike = windowStorage()

/** 测试注入点：生产代码不要调。 */
export function setStorageAdapter(adapter: StorageLike): void {
  storage = adapter
}

export interface ConversationState {
  /** 当前会话 id；'' = 未落库的新对话（旧 state.id 的 null）。 */
  conversationId: string
  /** 最近一次重拉落地的全量快照（chat-history 投影；null=面板空）。 */
  history: ChatHistoryResult | null
  conversations: ChatListItem[]
  conversationsOffset: number | null
  conversationsQuery: string
  conversationsError: string | null
  /** 评价映射（旧 state.feedback：messageId → 条目）与就绪位（回合结束后可写）。 */
  feedback: Map<string, FeedbackEntry>
  feedbackReady: boolean

  setConversationId: (id: string) => void
  /** 重拉结果落地（守卫核对在 controller，这里只写）。 */
  acceptHistory: (data: ChatHistoryResult) => void
  /** 切会话原子动作的一段：清历史面板（live 清理由 turn.reset 负责）。 */
  resetPanel: () => void
  /** 评价映射整体替换（旧 refresh 的 feedback list 段）。 */
  setFeedback: (items: readonly FeedbackEntry[]) => void
  /** 单条评价写入（旧 rememberFeedback）。 */
  setFeedbackEntry: (entry: FeedbackEntry) => void
  deleteFeedbackEntry: (messageId: string) => void
  /** 切会话清空评价面（旧 activate 的 feedback.clear()）。 */
  resetFeedback: () => void
  acceptConversationPage: (items: readonly ChatListItem[], nextOffset: number | null, append: boolean) => void
  setConversationsQuery: (query: string) => void
  setConversationsError: (message: string | null) => void
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversationId: '',
  history: null,
  conversations: [],
  conversationsOffset: null,
  conversationsQuery: '',
  conversationsError: null,
  feedback: new Map(),
  feedbackReady: false,

  setConversationId: id => {
    set({ conversationId: id })
    const { userId } = useSessionStore.getState()
    if (userId !== '') {
      const key = chatStorageKey(userId)
      if (id === '') storage.removeItem(key)
      else storage.setItem(key, id)
    }
    syncConversationUrl(id)
  },

  acceptHistory: history => set({ history }),

  resetPanel: () => set({ history: null }),

  setFeedback: items => {
    const feedback = new Map(items.map(item => [item.messageId, item]))
    set({ feedback, feedbackReady: true })
  },

  setFeedbackEntry: entry => set(state => {
    const feedback = new Map(state.feedback)
    feedback.set(entry.messageId, entry)
    return { feedback }
  }),

  deleteFeedbackEntry: messageId => set(state => {
    if (!state.feedback.has(messageId)) return {}
    const feedback = new Map(state.feedback)
    feedback.delete(messageId)
    return { feedback }
  }),

  resetFeedback: () => set({ feedback: new Map(), feedbackReady: false }),

  acceptConversationPage: (items, nextOffset, append) => set(state => {
    if (!append) return { conversations: [...items], conversationsOffset: nextOffset, conversationsError: null }
    const merged = [...state.conversations]
    for (const item of items) {
      if (!merged.some(existing => existing.id === item.id)) merged.push(item)
    }
    return { conversations: merged, conversationsOffset: nextOffset, conversationsError: null }
  }),

  setConversationsQuery: conversationsQuery => set({ conversationsQuery }),
  setConversationsError: conversationsError => set({ conversationsError }),
}))

/** URL 同步（旧 syncConversationUrl：replaceState，不产生历史记录）。 */
function syncConversationUrl(id: string): void {
  if (typeof window === 'undefined' || typeof window.history === 'undefined') return
  const url = new URL(window.location.href)
  if (id !== '') url.searchParams.set('conversationId', id)
  else url.searchParams.delete('conversationId')
  window.history.replaceState(window.history.state, '', url)
}

/** 深链接目标（旧 chatConversationTarget：URL 的 conversationId 优先，回落上次会话）。 */
export function chatConversationTarget(search: string, previous: string | null): string {
  return new URLSearchParams(search).get('conversationId') || previous || ''
}

/** 测试/启动读取用：当前 storage 适配器里的会话 id。 */
export function storedConversationId(userId: string): string | null {
  return storage.getItem(chatStorageKey(userId))
}
