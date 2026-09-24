/**
 * @ 提及选择器（评审 #20 从 Composer.tsx 拆出）：listbox/option/activedescendant 的
 * aria 语义与键盘导航提示在这里呈现；键盘导航事件本身留在输入框（Composer），点击
 * 选中与落纸也归 Composer——本组件只负责展示与指针交互（悬停高亮、点选回传下标）。
 */
import type { RefObject } from 'react'
import type { MemberItem } from '../../stores/session.ts'
import type { MentionState } from '../../lib/mention.ts'

interface MentionPopoverProps {
  mention: MentionState
  /** 过滤后的候选（空 = 展示全部成员的空态提示）。 */
  candidates: MemberItem[]
  members: MemberItem[]
  /** 菜单列表容器（Composer 的输入框 onBlur 靠它判断焦点是否还在菜单内）。 */
  itemsRef: RefObject<HTMLDivElement | null>
  /** 悬停换高亮项。 */
  onHover: (index: number) => void
  /** 点击选中（Composer 按传入下标落纸，React 闭包取不到最新 index 的老问题）。 */
  onPick: (index: number) => void
}

export function MentionPopover({ mention, candidates, members, itemsRef, onHover, onPick }: MentionPopoverProps) {
  return (
    <div className="mention" id="mention-pop" role="listbox" aria-label="点名成员" aria-activedescendant={`mention-option-${mention.index}`}>
      <p className="mention__hint" aria-hidden="true">↑↓ 选 · 回车点名 · Esc 关</p>
      <div className="mention__items" id="mention-items" ref={itemsRef}>
        {candidates.length === 0 && (
          <p className="mention__none">
            {members.length === 0 ? '还没有可点名的成员' : '没有对得上的成员'}
          </p>
        )}
        {candidates.map((member, index) => (
          <div
            key={member.agentId}
            id={`mention-option-${index}`}
            data-index={index}
            role="option"
            aria-selected={index === mention.index}
            className={`mention__item${index === mention.index ? ' mention__item--active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={event => event.preventDefault()}
            onClick={() => onPick(index)}
          >
            <span className="avatar avatar--sm" style={{ background: 'var(--bt-ink-faint)' }}>
              <span>{[...member.displayName][0] ?? '?'}</span>
            </span>
            <div className="member__col">
              <div className="member__name">{member.displayName}</div>
              <div className="member__declared">{member.declaredName}</div>
            </div>
            <span className="mention__handle">@{member.agentId}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
