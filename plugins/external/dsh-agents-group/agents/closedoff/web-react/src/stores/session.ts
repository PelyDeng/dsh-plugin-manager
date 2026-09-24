/**
 * 会话与身份 store：身份核验态、两个代次源、会话导航、会话列表与标题轮询。
 *
 * 代次建模（批 1a 关键决策，对照旧 app.js）：
 * - `identityEpoch`：身份域代次。登录状态变化（退出/401/403/503/账号变化）时 bump，
 *   在途的业务响应与 SSE 事件据此作废——旧 identityEpoch + responseEpochs 的合并体，
 *   JSON 响应的核对点收进 lib/api.ts，流事件的核对点在 chat-controller。
 * - `viewToken`：视图域代次。切换/新建会话时 bump（与清面板、abort 同在一个原子动作
 *   beginViewChange 里，方案 §4.3「守卫不得在各 store 复制」），restore 与活动流的
 *   迟到回包据此丢弃。
 *
 * 标题轮询沿用旧口径：首条消息后启动，2s 一拍、65s 窗口；手动改名或列表里出现
 * 非自动标题即停。
 */
import { create } from 'zustand'
import type { ConversationItem } from '../lib/types.ts'

/** 顶栏状态点（旧 setStatus 三态）。 */
export type StatusKind = 'ok' | 'thinking' | 'off'

export interface StatusState {
  kind: StatusKind
  text: string
}

/** localStorage 适配（node 测试注入内存版，避免环境分叉）。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function windowStorage(): StorageLike {
  return {
    getItem: key => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
    removeItem: key => globalThis.localStorage?.removeItem(key),
  }
}

let storage: StorageLike = windowStorage()

/** 测试注入点：生产代码不要调。 */
export function setStorageAdapter(adapter: StorageLike): void {
  storage = adapter
}

/** URL 上的会话 id（打开指定会话入口；浏览器环境才生效）。 */
export function linkedConversationId(): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('conversationId') ?? ''
}

/** 打开指定会话的链接 id 形制（旧码同一正则：closedoff-web-<UUIDv4>）。 */
export function isLinkedConversationId(value: string): boolean {
  return /^closedoff-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

/** 标题轮询窗口与节拍（旧 startTitleRefresh 口径：2s tick / 65s 窗口）。 */
export const TITLE_POLL_TICK_MS = 2000
export const TITLE_POLL_WINDOW_MS = 65000

interface TitlePoll {
  id: string
  epoch: number
  until: number
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface SessionState {
  // ── 身份域 ──────────────────────────────────────────────────────────
  identityEpoch: number
  viewToken: number
  identityReady: boolean
  identityKey: string
  identityLabel: string
  identityMode: string
  /** 会话 id 的本地持久化键（按身份隔离）。 */
  storageKey: string
  status: StatusState

  // ── 会话域 ──────────────────────────────────────────────────────────
  conversationId: string
  conversations: ConversationItem[]
  conversationsOffset: number | null
  conversationsQuery: string
  conversationsError: string | null
  /** 回答进行中：列表行禁点、禁止切换/新建（旧码 running 口径）。 */
  listBlocked: boolean

  // ── actions ─────────────────────────────────────────────────────────
  setStatus: (kind: StatusKind, text: string) => void
  adoptIdentity: (identity: { key: string; label?: string; mode?: string }) => void
  /** 身份失效：bump 代次 + 中断在途 + 清会话导航（旧 clearPrivateView 等价）。 */
  clearPrivateView: () => void
  /** 视图切换原子动作的前半：bump viewToken + 停标题轮询（清面板由 board/turn 负责）。 */
  beginViewChange: () => void
  setConversationId: (id: string) => void
  setListBlocked: (blocked: boolean) => void
  setConversationsQuery: (query: string) => void
  acceptConversationPage: (items: ConversationItem[], nextOffset: number | null, append: boolean) => void
  setConversationsError: (message: string | null) => void

  // ── 标题轮询 ────────────────────────────────────────────────────────
  startTitlePoll: (id: string) => void
  stopTitlePoll: () => void
  /** 列表落地后的停轮询判断（旧 acceptTitleList：出现非自动标题即停）。 */
  shouldStopTitlePoll: (items: ConversationItem[]) => boolean
}

export const useSessionStore = create<SessionState>((set, get) => ({
  identityEpoch: 0,
  viewToken: 0,
  identityReady: false,
  identityKey: '',
  identityLabel: '',
  identityMode: '',
  storageKey: '',
  status: { kind: 'thinking', text: '正在验证访问权限…' },

  conversationId: '',
  conversations: [],
  conversationsOffset: null,
  conversationsQuery: '',
  conversationsError: null,
  listBlocked: false,

  setStatus: (kind, text) => set({ status: { kind, text } }),

  adoptIdentity: identity => set({
    identityReady: true,
    identityKey: identity.key,
    identityLabel: identity.label ?? '',
    identityMode: identity.mode ?? '',
    storageKey: `dsh_closedoff_conversationId:${identity.key}`,
  }),

  clearPrivateView: () => {
    get().stopTitlePoll()
    const state = get()
    // 代次先 bump：在途回包（业务响应/SSE/restore）在下一个核对点全部作废。
    set({
      identityEpoch: state.identityEpoch + 1,
      identityReady: false,
      viewToken: state.viewToken + 1,
      conversationId: '',
      listBlocked: false,
    })
    if (get().storageKey !== '') storage.removeItem(get().storageKey)
  },

  beginViewChange: () => {
    get().stopTitlePoll()
    set(state => ({ viewToken: state.viewToken + 1 }))
  },

  setConversationId: id => {
    set({ conversationId: id })
    const { storageKey } = get()
    if (storageKey === '') return
    if (id === '') storage.removeItem(storageKey)
    else storage.setItem(storageKey, id)
    syncConversationUrl(id)
  },

  setListBlocked: listBlocked => set({ listBlocked }),
  setConversationsQuery: conversationsQuery => set({ conversationsQuery }),
  acceptConversationPage: (items, nextOffset, append) => set(state => {
    if (!append) return { conversations: items, conversationsOffset: nextOffset, conversationsError: null }
    const merged = [...state.conversations]
    for (const item of items) {
      if (!merged.some(existing => existing.id === item.id)) merged.push(item)
    }
    return { conversations: merged, conversationsOffset: nextOffset, conversationsError: null }
  }),
  setConversationsError: conversationsError => set({ conversationsError }),

  startTitlePoll: id => {
    get().stopTitlePoll()
    const pending: TitlePoll = { id, epoch: get().identityEpoch, until: Date.now() + TITLE_POLL_WINDOW_MS, timer: undefined }
    titlePoll = pending
    const tick = (): void => {
      const state = get()
      const current = titlePoll
      if (current !== pending) return
      if (state.conversationId !== pending.id || state.identityEpoch !== pending.epoch || !state.identityReady || Date.now() >= pending.until) {
        get().stopTitlePoll()
        return
      }
      void refreshTick().finally(() => {
        if (titlePoll === pending) pending.timer = setTimeout(tick, TITLE_POLL_TICK_MS)
      })
    }
    pending.timer = setTimeout(tick, TITLE_POLL_TICK_MS)
  },

  stopTitlePoll: () => {
    if (titlePoll !== undefined && titlePoll.timer !== undefined) clearTimeout(titlePoll.timer)
    titlePoll = undefined
  },

  shouldStopTitlePoll: items => {
    const poll = titlePoll
    if (poll === undefined) return false
    const current = items.find(item => item.id === poll.id)
    return current !== undefined && current.titleSource !== undefined && current.titleSource !== 'automatic'
  },
}))

/** 标题轮询的句柄（模块级单例：同一时刻至多一个轮询在跑，旧码同形态）。 */
let titlePoll: TitlePoll | undefined

/** 轮询一拍的刷新动作（由 chat-controller 注入，避免 store 循环依赖 api 层）。 */
let refreshTick: () => Promise<unknown> = async () => {}

/** 注入标题轮询的一拍动作（chat-controller 装配时调用一次）。 */
export function setTitlePollTick(tick: () => Promise<unknown>): void {
  refreshTick = tick
}

function syncConversationUrl(id: string): void {
  if (typeof window === 'undefined' || typeof window.history === 'undefined') return
  const url = new URL(window.location.href)
  if (id !== '') url.searchParams.set('conversationId', id)
  else url.searchParams.delete('conversationId')
  window.history.replaceState(window.history.state, '', url)
}
