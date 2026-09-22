/**
 * 会话与成员 store：当前登录身份、成员清单（右栏档案与 @ 点名簿共用）、头像破缓存戳。
 * settingsOpen 在批 5 设置页迁移时随 UI 状态一起裁决去留，这里先不收。
 */
import { create } from 'zustand'
import type { MemberItem, ConversationItem } from '../lib/api.ts'
export type { MemberItem }
import { PALETTE } from '../lib/config.ts'

/** 右栏运行状态计数（/overview 的 counts 与失败记录）。 */
export interface OverviewData {
  counts: Record<string, number>
  failures: Array<{ id: string; goal: string; updatedAt: number; error: string | null }>
}

/** 左栏列表行：会话标题 + 预览（该会话最近一条任务的目标，refreshChatList 聚合）。 */
export interface ChatListItem {
  id: string
  title: string
  updatedAt: number
  preview: string
}

export interface SessionState {
  identityLabel: string
  members: MemberItem[]
  /** agentId → 头像版本号，用于破缓存。 */
  avatarStamps: Map<string, number>
  /** 左栏任务记录列表（聚合 preview 后的行）。 */
  chatList: ChatListItem[]
  /** 搜索关键词（小写；空串不过滤）。 */
  chatKeyword: string
  /** 0.12.4 分页：页码/总数/页大小（identity 下发）。 */
  chatPage: number
  chatTotal: number
  chatPageSize: number
  /** 0.12.5：复选框常驻，勾选的会话 id（跨勾选累积，翻页清空）。 */
  chatPicked: string[]
  /** 行内重命名：正在编辑的会话 id（同一时刻至多一处）。 */
  renamingId: string | null
  /** 失败记录勾选（0.12.7 与任务记录同款）。 */
  failurePicked: string[]
  overview: OverviewData | null
  /** 顶栏状态词（已上线/正在处理/没登录/读取失败）。streaming 优先，错误态覆盖。 */
  topStatus: string
  /** 「加载更早记录」控件状态（I10：两个游标都到底后换分界说明）。 */
  earlier: { phase: 'idle' | 'loading' | 'done' | 'error'; message?: string }
  /** 历史阅读游标（评审 #11：从 use-turn 模块级单例搬入——真相源单点）。 */
  historyCursor: import('../lib/history-merge.ts').HistoryCursor
  /** 设置页开关（I18：页面切换非模态）。 */
  settingsOpen: boolean
  setEarlier: (earlier: { phase: 'idle' | 'loading' | 'done' | 'error'; message?: string }) => void
  setHistoryCursor: (cursor: import('../lib/history-merge.ts').HistoryCursor) => void
  setSettingsOpen: (open: boolean) => void
  setIdentity: (label: string) => void
  setMembers: (members: MemberItem[]) => void
  /** 左栏列表读取失败（评审 #4）：视觉用户要看得到并能在原地重试，不能只进屏幕阅读器。 */
  chatListError: string | null
  setChatListError: (message: string | null) => void
  setChatList: (items: ChatListItem[]) => void
  setChatKeyword: (keyword: string) => void
  setChatPageMeta: (meta: { chatPage?: number; chatTotal?: number; chatPageSize?: number }) => void
  togglePicked: (id: string, picked: boolean) => void
  clearPicked: () => void
  setRenamingId: (id: string | null) => void
  toggleFailurePicked: (id: string, picked: boolean) => void
  clearFailurePicked: () => void
  setOverview: (data: OverviewData | null) => void
  setTopStatus: (status: string) => void
  stampAvatar: (agentId: string) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  identityLabel: '',
  members: [],
  avatarStamps: new Map(),
  chatList: [],
  chatKeyword: '',
  chatPage: 0,
  chatTotal: 0,
  chatPageSize: 10,
  chatPicked: [],
  renamingId: null,
  failurePicked: [],
  overview: null,
  topStatus: '',
  earlier: { phase: 'idle' },
  historyCursor: { transcriptBefore: null, taskOffset: null, loading: false, error: null, entriesCache: [] },
  settingsOpen: false,

  setIdentity: label => set({ identityLabel: label }),
  // 成员名单落地时为每人补头像版本号初值（旧 refreshPanels 口径）：有 stamp 才视为
  // 「可能有自定义头像」，设置页的「删除头像」入口据此显示。
  setMembers: members => set(state => {
    const stamps = new Map(state.avatarStamps)
    for (const member of members) {
      if (!stamps.has(member.agentId)) stamps.set(member.agentId, 1)
    }
    return { members, avatarStamps: stamps }
  }),
  chatListError: null,
  setChatListError: message => set({ chatListError: message }),
  setChatList: chatList => set({ chatList, chatListError: null }),
  setChatKeyword: chatKeyword => set({ chatKeyword }),
  setChatPageMeta: meta => set(meta),
  togglePicked: (id, picked) => {
    const rest = get().chatPicked.filter(entry => entry !== id)
    set({ chatPicked: picked ? [...rest, id] : rest })
  },
  clearPicked: () => set({ chatPicked: [] }),
  setRenamingId: renamingId => set({ renamingId }),
  toggleFailurePicked: (id, picked) => {
    const rest = get().failurePicked.filter(entry => entry !== id)
    set({ failurePicked: picked ? [...rest, id] : rest })
  },
  clearFailurePicked: () => set({ failurePicked: [] }),
  setOverview: overview => set({ overview }),
  setTopStatus: topStatus => set({ topStatus }),
  setEarlier: earlier => set({ earlier }),
  setHistoryCursor: cursor => set({ historyCursor: cursor }),
  setSettingsOpen: settingsOpen => set({ settingsOpen }),
  stampAvatar: agentId => {
    const next = new Map(get().avatarStamps)
    next.set(agentId, (next.get(agentId) ?? 0) + 1)
    set({ avatarStamps: next })
  },
}))

/** 按 agentId 稳定取色；配过本地配色时优先用本地配色。 */
export function accentOf(members: MemberItem[], agentId: string): string {
  const accent = members.find(item => item.agentId === agentId)?.accent
  if (accent !== undefined) return accent
  let hash = 0
  for (const char of String(agentId)) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return PALETTE[hash % PALETTE.length] ?? '#4d96ff'
}

export function displayNameOf(members: MemberItem[], agentId: string): string {
  return members.find(item => item.agentId === agentId)?.displayName ?? agentId
}
