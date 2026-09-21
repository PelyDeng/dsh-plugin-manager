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

export interface SessionState {
  identityLabel: string
  members: MemberItem[]
  /** agentId → 头像版本号，用于破缓存。 */
  avatarStamps: Map<string, number>
  /** 左栏任务记录列表（批 1 基础渲染；删除/批量/管理模式批 2）。 */
  conversations: ConversationItem[]
  overview: OverviewData | null
  setIdentity: (label: string) => void
  setMembers: (members: MemberItem[]) => void
  setConversations: (items: ConversationItem[]) => void
  setOverview: (data: OverviewData | null) => void
  stampAvatar: (agentId: string) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  identityLabel: '',
  members: [],
  avatarStamps: new Map(),
  conversations: [],
  overview: null,

  setIdentity: label => set({ identityLabel: label }),
  setMembers: members => set({ members }),
  setConversations: conversations => set({ conversations }),
  setOverview: overview => set({ overview }),
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
