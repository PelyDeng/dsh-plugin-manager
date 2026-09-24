/**
 * 左栏交互组件（批 2.5 回灌；评审 #20 按栏拆分自 left-right.tsx）：任务记录列表——
 * 复选框常驻、⋯ 操作菜单、行内重命名、分页、搜索全量。类名与语义对齐 main 版
 * panels.js；两段式行内删除已被 0.12.4 淘汰（删除统一走菜单）。
 */
import { useEffect, useRef, useState } from 'react'
import { formatClock } from '../../lib/time.ts'
import type { ChatListItem } from '../../stores/session.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useTurnStore } from '../../stores/turn.ts'
import {
  deletePickedConversations, gotoChatPage, openConversation, refreshChatList, renameConversation,
} from '../../hooks/use-turn.ts'
import { useClickOutside } from '../common/basics.tsx'


/** 可见行（keyword 过滤后）：全选三态与搜索态判定共用这份口径。 */
export function visibleChatList(chatList: ChatListItem[], keyword: string): ChatListItem[] {
  return keyword === ''
    ? chatList
    : chatList.filter(item =>
      (item.title ?? '').toLowerCase().includes(keyword) ||
      (item.preview ?? '').toLowerCase().includes(keyword))
}

/**
 * ⋯ 操作菜单（0.12.5：没有管理模式了，菜单固定「删除所选 / 重命名」）。
 * 再点 ⋯ 关闭（标准 toggle）；勾选变化的可用态由 picked 派生（React 声明式天然满足，
 * 旧 refreshOpenMenu 的竞态防护不再需要——关闭权只归 toggle 与外点，语义保留）。
 */
function RecordsMenu() {
  const picked = useSessionStore(state => state.chatPicked)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  // 外点关闭走 useClickOutside（评审 #13）——hook 只能在组件顶层调用，不能进 effect。
  useClickOutside(rootRef, () => setOpen(false), open)
  useEffect(() => {
    // Escape 关闭+焦点回扳机（评审 #16：全页「Escape 依次收起」承诺，菜单不能把键盘
    // 用户困住）；打开时焦点进第一项（手写实现，不引 Base UI——见第二轮评审 §3.2 裁决）。
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      rootRef.current?.querySelector<HTMLButtonElement>('.chat-manage-menu-btn')?.focus()
    }
    window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>('[role="menu"]')?.querySelector<HTMLElement>('button')?.focus()
    })
    rootRef.current?.addEventListener('keydown', onKey)
    return () => rootRef.current?.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <span className="chat-records-actions" ref={rootRef}>
      <button
        type="button"
        className="chat-manage-menu-btn"
        id="records-menu"
        aria-haspopup="true"
        aria-expanded={open}
        title="操作"
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      <span className="chat-manage-menu" id="records-menu-pop" hidden={!open} role="menu">
        <button
          type="button"
          role="menuitem"
          className="chat-manage-menu__item chat-manage-menu__item--danger"
          disabled={picked.length === 0}
          onClick={() => { setOpen(false); void deletePickedConversations() }}
        >
          删除所选
        </button>
        {/* 重命名只在恰好选中一条时可用（多条没有一致的改名语义）。 */}
        <button
          type="button"
          role="menuitem"
          className="chat-manage-menu__item"
          disabled={picked.length !== 1}
          onClick={() => {
            setOpen(false)
            useSessionStore.getState().setRenamingId(picked[0] ?? null)
            void refreshChatList()
          }}
        >
          重命名
        </button>
      </span>
    </span>
  )
}

/** 操作条（0.12.6 常驻）：全选三态（作用域=当前可见行）+ 已选计数 + ⋯ 菜单。 */
export function ManageBar() {
  const chatList = useSessionStore(state => state.chatList)
  const keyword = useSessionStore(state => state.chatKeyword)
  const picked = useSessionStore(state => state.chatPicked)
  const togglePicked = useSessionStore(state => state.togglePicked)
  const allRef = useRef<HTMLInputElement>(null)
  const visible = visibleChatList(chatList, keyword)
  const checked = visible.filter(item => picked.includes(item.id)).length
  const allChecked = visible.length > 0 && checked === visible.length
  const someChecked = checked > 0 && checked < visible.length
  return (
    <div className="chat-manage-bar" id="chat-manage-bar">
      <input
        type="checkbox"
        id="chat-manage-all"
        className="chat-manage-bar__all"
        aria-label="全选本页"
        checked={allChecked}
        ref={node => { if (node !== null) node.indeterminate = someChecked }}
        onChange={event => {
          // 全选作用于可见行（搜索态下不会选中并删除用户看不见的会话）。
          for (const item of visible) togglePicked(item.id, event.target.checked)
        }}
      />
      <span className="chat-manage-bar__count" id="chat-manage-count">已选 {picked.length} 条</span>
      <RecordsMenu />
    </div>
  )
}

/** 左栏任务记录列表（0.12.4/0.12.5）：复选框常驻、行内重命名、正文点击打开。 */
export function ChatList() {
  const chatList = useSessionStore(state => state.chatList)
  const chatListError = useSessionStore(state => state.chatListError)
  const keyword = useSessionStore(state => state.chatKeyword)
  const picked = useSessionStore(state => state.chatPicked)
  const togglePicked = useSessionStore(state => state.togglePicked)
  const renamingId = useSessionStore(state => state.renamingId)
  const conversationId = useTurnStore(state => state.conversationId)
  // 读取失败要在原地可见可重试（评审 #4）：不能清空列表冒充「还没有任务记录」。
  if (chatListError !== null) {
    return (
      <div className="empty">
        <p>{chatListError}</p>
        <button type="button" className="btn btn--tiny" onClick={() => { void refreshChatList() }}>重试</button>
      </div>
    )
  }
  const visible = visibleChatList(chatList, keyword)
  if (visible.length === 0) {
    return <p className="empty">{chatList.length === 0 ? '还没有任务记录' : '没有匹配结果'}</p>
  }
  return (
    <>
      {visible.map(item => {
        const renaming = item.id === renamingId
        return (
          <div
            key={item.id}
            className={`chat-row chat-row--pickable${picked.includes(item.id) ? ' chat-row--picked' : ''}${renaming ? ' chat-row--renaming' : ''}`}
            aria-current={item.id === conversationId ? 'true' : undefined}
          >
            <input
              type="checkbox"
              className="chat-row__check"
              aria-label={`选择 ${item.title || '未命名会话'}`}
              checked={picked.includes(item.id)}
              onChange={event => togglePicked(item.id, event.target.checked)}
            />
            <span className="chat-row__body" onClick={() => { if (!renaming) void openConversation(item.id) }}>
              {renaming
                ? <RenameInput id={item.id} current={item.title} />
                : (
                    <>
                      <span className="chat-row__title">{item.title || '（还没起名）'}</span>
                      {item.preview !== '' && <span className="chat-row__preview">{item.preview}</span>}
                      <span className="chat-row__time">{formatClock(item.updatedAt)}</span>
                    </>
                  )}
            </span>
          </div>
        )
      })}
    </>
  )
}

/** 行内改名（0.12.4）：Enter 提交、Escape 取消、blur 提交；空值视为取消。 */
function RenameInput({ id, current }: { id: string; current: string }) {
  const [value, setValue] = useState(current)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const submit = () => {
    useSessionStore.getState().setRenamingId(null)
    void renameConversation(id, value)
  }
  const cancel = () => {
    useSessionStore.getState().setRenamingId(null)
    void refreshChatList()
  }
  return (
    <input
      ref={ref}
      type="text"
      className="chat-row__rename"
      value={value}
      placeholder="起个新名字"
      aria-label="会话的新名字"
      maxLength={80}
      onChange={event => setValue(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
        else if (event.key === 'Escape') { event.preventDefault(); cancel() }
      }}
      onBlur={() => { if (useSessionStore.getState().renamingId === id) submit() }}
    />
  )
}

/** 分页条（0.12.4）：搜索态或多于一页才出现；翻页清选中（跨页选中容易误删）。 */
export function ChatPager() {
  const chatPage = useSessionStore(state => state.chatPage)
  const chatTotal = useSessionStore(state => state.chatTotal)
  const chatPageSize = useSessionStore(state => state.chatPageSize)
  const keyword = useSessionStore(state => state.chatKeyword)
  const searching = keyword !== ''
  const pages = Math.max(1, Math.ceil(chatTotal / chatPageSize))
  if (searching || pages <= 1) return null
  return (
    <div className="chat-pager" id="chat-pager">
      <button
        type="button"
        className="chat-pager__btn"
        id="chat-pager-prev"
        aria-label="上一页"
        disabled={chatPage === 0}
        onClick={() => { void gotoChatPage(chatPage - 1) }}
      >
        ‹
      </button>
      <span className="chat-pager__info" id="chat-pager-info">{chatPage + 1} / {pages}</span>
      <button
        type="button"
        className="chat-pager__btn"
        id="chat-pager-next"
        aria-label="下一页"
        disabled={chatPage >= pages - 1}
        onClick={() => { void gotoChatPage(chatPage + 1) }}
      >
        ›
      </button>
    </div>
  )
}

/** 搜索框（200ms 防抖；0.12.5 搜索拉全量再本地过滤，分页条隐藏）。 */
export function ChatSearch() {
  const setKeyword = useSessionStore(state => state.setChatKeyword)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  return (
    <input
      type="search"
      id="chat-search"
      className="doodle-input"
      placeholder="搜索任务记录"
      autoComplete="off"
      aria-label="搜索任务记录"
      onChange={event => {
        const value = event.target.value
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          setKeyword(value.trim().toLowerCase())
          void refreshChatList()
        }, 200)
      }}
    />
  )
}
