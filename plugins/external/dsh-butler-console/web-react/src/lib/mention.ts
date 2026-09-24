/**
 * @ 提及的纯检测/过滤逻辑（评审 #20 从 Composer.tsx 出 lib）：与 UI 无关，可独立
 * 单测。语义对齐旧 composer.js：
 * - 提及检测：光标前未闭合 @，其前须是行首/空白/非 ASCII（中文不打空格），@ 与光标
 *   间无空白；英文数字后不触发（防邮箱）。
 * - 过滤口径：外号、报名名、agentId 任一命中即可。
 */
import type { MemberItem } from '../stores/session.ts'

/** 一次提及会话的 UI 态：@ 的起始下标、过滤词、当前高亮项。 */
export interface MentionState {
  start: number
  query: string
  index: number
}

/** 光标前是否有一个未闭合的 @（旧 detectMention 口径）。 */
export function detectMention(text: string, pos: number): { start: number; query: string } | null {
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i] ?? ''
    if (ch === '@') {
      const prev = i === 0 ? '' : text[i - 1] ?? ''
      if (prev === '' || /[^\x00-\x7f]/.test(prev) || /\s/.test(prev)) {
        return { start: i, query: text.slice(i + 1, pos) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** 过滤口径：外号、报名名、agentId 任一命中即可。 */
export function mentionCandidates(members: MemberItem[], query: string): MemberItem[] {
  const q = query.trim().toLowerCase()
  return members.filter(member =>
    member.displayName.toLowerCase().includes(q)
    || member.declaredName.toLowerCase().includes(q)
    || member.agentId.toLowerCase().includes(q))
}
