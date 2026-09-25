/**
 * 会话与身份 store：身份核验态、视图切换代次、当前视图名。
 *
 * 代次建模（批 2a 关键决策，对照旧 web/chat.js 的 state.epoch）：
 * - 旧码只有一个代次 `epoch`（chat.js:33），语义是「会话视图切换代次」——activate()
 *   时 ++，流事件与重拉回包在途时据此作废（chat.js:93/105）。迁移映射：epoch →
 *   viewToken（方案 §4.3 守卫映射表第一行）。
 * - blog 与 closedoff 不同构：旧页面没有身份失效中途作废机制（/identity 只在启动
 *   时核验一次，401 由接口错误文案透出），因此**不设 identityEpoch**——如实建模，
 *   不引入 closedoff 的双代次（方案 §4.3「两成员两套模型，不通用化」）。
 */
import { create } from 'zustand'

/** 顶层视图名（旧 body.dataset.view：chat=对话 / writing=文章工作台）。 */
export type ViewName = 'chat' | 'writing'

export interface SessionState {
  /** 会话切换代次（旧 state.epoch）：activate/新建时 bump，在途数据据此丢弃。 */
  viewToken: number
  identityReady: boolean
  /** 登录身份（/identity 的 userId；storageKey 与草稿归属用）。 */
  userId: string
  view: ViewName
  /** 顶层提示行（旧 #notice / #chat-error 的兜底锚点；组件局部错误不入此）。 */
  notice: { text: string; tone: 'error' | 'info' } | null

  beginViewChange: () => void
  adoptIdentity: (identity: { userId: string }) => void
  setView: (view: ViewName) => void
  setNotice: (notice: { text: string; tone: 'error' | 'info' } | null) => void
}

export const useSessionStore = create<SessionState>(set => ({
  viewToken: 0,
  identityReady: false,
  userId: '',
  view: 'chat',
  notice: null,

  beginViewChange: () => set(state => ({ viewToken: state.viewToken + 1 })),

  adoptIdentity: identity => set({ identityReady: true, userId: identity.userId }),

  setView: view => set({ view }),

  setNotice: notice => set({ notice }),
}))

/** 会话 id 的 sessionStorage 键（旧 `blog-chat:<userId>`）。 */
export function chatStorageKey(userId: string): string {
  return `blog-chat:${userId}`
}
