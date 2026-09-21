/**
 * 会话与成员 store：当前登录身份、成员清单（右栏档案与 @ 点名簿共用）、头像破缓存戳。
 * settingsOpen 在批 5 设置页迁移时随 UI 状态一起裁决去留，这里先不收。
 */
import { create } from 'zustand'
import type { MemberItem, ConversationItem } from '../lib/api.ts'
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
  /** 管理模式：开着时行首出复选框、批量操作条可见。 */
  chatManage: boolean
  /** 管理模式下勾选的会话 id。 */
  chatPicked: string[]
  overview: OverviewData | null
  /** 顶栏状态词（已上线/正在处理/没登录/读取失败）。streaming 优先，错误态覆盖。 */
  topStatus: string
  setIdentity: (label: string) => void
  setMembers: (members: MemberItem[]) => void
  setChatList: (items: ChatListItem[]) => void
  setChatKeyword: (keyword: string) => void
  setChatManage: (on: boolean) => void
  togglePicked: (id: string, picked: boolean) => void
  clearPicked: () => void
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
  chatManage: false,
  chatPicked: [],
  overview: null,
  topStatus: '',

  setIdentity: label => set({ identityLabel: label }),
  setMembers: members => set({ members }),
  setChatList: chatList => set({ chatList }),
  setChatKeyword: chatKeyword => set({ chatKeyword }),
  // 退出管理模式时清空选中（旧 setChatManage 语义）。
  setChatManage: on => set(on ? { chatManage: on } : { chatManage: on, chatPicked: [] }),
  togglePicked: (id, picked) => {
    const rest = get().chatPicked.filter(entry => entry !== id)
    set({ chatPicked: picked ? [...rest, id] : rest })
  },
  clearPicked: () => set({ chatPicked: [] }),
  setOverview: overview => set({ overview }),
  setTopStatus: topStatus => set({ topStatus }),
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
