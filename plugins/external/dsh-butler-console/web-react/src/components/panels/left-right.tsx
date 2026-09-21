/**
 * 左右栏交互组件（批 2：任务记录删除/批量删除/管理模式/搜索、失败记录删除、座右铭）。
 * 类名与语义对齐旧 panels.js；两段式确认（armRowDelete）在 React 里以组件状态承载。
 */
import { useEffect, useRef, useState } from 'react'
import { MOTTO_KEY, DEFAULT_MOTTO } from '../../lib/config.ts'
import type { ChatListItem } from '../../stores/session.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useTurnStore } from '../../stores/turn.ts'
import {
  deletePickedConversations, openConversation, openNewChat, refreshChatList, removeConversationsWithFeedback,
} from '../../hooks/use-turn.ts'
import { api, ApiError } from '../../lib/api.ts'
import { announce } from '../../lib/announce.ts'

function formatTime(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date().toDateString()) return clock
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${clock}`
}

/**
 * 行内删除的两段式确认：第一段武装（亮起并提示再点确认），3 秒没确认就还原；
 * 第二段执行。与旧 armRowDelete 同语义，状态从 Map 换成组件 state。
 */
export function RowDelete({ title, onConfirm }: { title: string; onConfirm: () => Promise<void> | void }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current) }, [])
  const activate = async () => {
    if (armed) {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      setArmed(false)
      setBusy(true)
      await onConfirm()
      setBusy(false)
      return
    }
    setArmed(true)
    timerRef.current = setTimeout(() => setArmed(false), 3000)
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className={`row-delete${armed ? ' row-delete--armed' : ''}`}
      title={title}
      onClick={event => { event.stopPropagation(); void activate() }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void activate() } }}
    >
      {busy ? '…' : armed ? '确认删除' : '×'}
    </span>
  )
}

/** 单条会话删除（围栏接口；列表刷新在 removeConversationsWithFeedback 内）。 */
function deleteOneConversation(id: string): Promise<void> {
  return removeConversationsWithFeedback([id]).then(() => {})
}

/** 左栏任务记录列表：preview 行/关键词过滤/管理模式行形态/aria-current/单条删除。 */
export function ChatList() {
  const chatList = useSessionStore(state => state.chatList)
  const keyword = useSessionStore(state => state.chatKeyword)
  const manage = useSessionStore(state => state.chatManage)
  const picked = useSessionStore(state => state.chatPicked)
  const togglePicked = useSessionStore(state => state.togglePicked)
  const conversationId = useTurnStore(state => state.conversationId)

  const filtered = keyword === ''
    ? chatList
    : chatList.filter(item =>
      (item.title ?? '').toLowerCase().includes(keyword) ||
      (item.preview ?? '').toLowerCase().includes(keyword))
  if (filtered.length === 0) {
    return <p className="empty">{chatList.length === 0 ? '还没有任务记录' : '没有匹配结果'}</p>
  }
  if (manage) {
    // 管理模式：整行是 label（点击即勾选），不再承担「打开会话」。
    return (
      <>
        {filtered.map(item => (
          <label key={item.id} className={`chat-row chat-row--manage${picked.includes(item.id) ? ' chat-row--picked' : ''}`}>
            <input
              type="checkbox"
              className="chat-row__check"
              checked={picked.includes(item.id)}
              onChange={event => togglePicked(item.id, event.target.checked)}
            />
            <span>
              <span className="chat-row__title">{item.title || '（还没起名）'}</span>
              {item.preview !== '' && <span className="chat-row__preview">{item.preview}</span>}
            </span>
          </label>
        ))}
      </>
    )
  }
  return (
    <>
      {filtered.map(item => (
        <button
          key={item.id}
          type="button"
          className="chat-row"
          aria-current={item.id === conversationId ? 'true' : undefined}
          onClick={() => { void openConversation(item.id) }}
        >
          <span>
            <span className="chat-row__title">{item.title || '（还没起名）'}</span>
            {item.preview !== '' && <span className="chat-row__preview">{item.preview}</span>}
          </span>
          <span className="chat-row__time">{formatTime(item.updatedAt)}</span>
          <RowDelete title="删除这条任务记录" onConfirm={() => deleteOneConversation(item.id)} />
        </button>
      ))}
    </>
  )
}

/** 管理模式操作条：全选/已选计数/删除所选（按钮上两段式）/退出。 */
export function ManageBar() {
  const manage = useSessionStore(state => state.chatManage)
  const picked = useSessionStore(state => state.chatPicked)
  const chatList = useSessionStore(state => state.chatList)
  const clearPicked = useSessionStore(state => state.clearPicked)
  const togglePicked = useSessionStore(state => state.togglePicked)
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { if (!manage) setArmed(false) }, [manage])

  if (!manage) return null
  const allPicked = chatList.length > 0 && chatList.every(item => picked.includes(item.id))
  const toggleAll = () => {
    for (const item of chatList) togglePicked(item.id, !allPicked)
  }
  const confirmDelete = async () => {
    if (!armed) {
      setArmed(true)
      timerRef.current = setTimeout(() => setArmed(false), 3000)
      return
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    setArmed(false)
    await deletePickedConversations()
  }
  return (
    <div className="chat-manage-bar" id="chat-manage-bar">
      <button type="button" className="chat-manage-bar__pick" id="chat-manage-all" onClick={toggleAll}>全选</button>
      <span className="chat-manage-bar__count" id="chat-manage-count">已选 {picked.length} 条</span>
      <button
        type="button"
        className="chat-manage-bar__delete"
        id="chat-manage-delete"
        disabled={picked.length === 0}
        onClick={() => { void confirmDelete() }}
      >
        {armed ? `确认删除 ${picked.length} 条` : '删除所选'}
      </button>
      <button
        type="button"
        className="chat-manage-bar__exit"
        id="chat-manage-exit"
        onClick={() => { useSessionStore.getState().setChatManage(false) }}
      >
        退出管理
      </button>
    </div>
  )
}

/** 失败记录列表：行点击进任务详情（批 3 接 openTask），行内删除两段式（终态任务）。 */
export function FailureList() {
  const overview = useSessionStore(state => state.overview)
  const items = overview?.failures ?? []
  if (items.length === 0) return <p className="empty">暂无失败记录</p>
  const removeFailed = async (taskId: string) => {
    try {
      await api.removeTask(taskId)
      announce('失败记录已删除')
    } catch (error) {
      announce(error instanceof ApiError ? error.message : '删除失败，稍后再试')
    }
    await refreshChatList()
    // 失败计数与列表同源于 /overview：删除后刷新右栏。
    try {
      const next = await api.overview()
      useSessionStore.getState().setOverview(next)
    } catch { /* 下一轮轮询会再试。 */ }
  }
  return (
    <>
      {items.map(item => (
        <button key={item.id} type="button" className="failure-row">
          <span className="failure-row__goal">{formatTime(item.updatedAt)}　{item.goal}</span>
          <span className="failure-row__meta">{item.error || '没给原因'}</span>
          <RowDelete title="删除这条失败记录" onConfirm={() => removeFailed(item.id)} />
        </button>
      ))}
    </>
  )
}

/** 座右铭：点击就地编辑，blur/回车提交，空值回落默认（旧 renderMotto 语义）。 */
export function Motto() {
  const [current, setCurrent] = useState(() => {
    try { return localStorage.getItem(MOTTO_KEY) ?? DEFAULT_MOTTO } catch { return DEFAULT_MOTTO }
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(current)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])
  const commit = () => {
    const next = draft.trim() || DEFAULT_MOTTO
    try { localStorage.setItem(MOTTO_KEY, next) } catch { /* 隐私模式下忽略。 */ }
    setCurrent(next)
    setEditing(false)
  }
  if (!editing) {
    return (
      <button type="button" className="motto" id="motto" title="点一下改掉" onClick={() => { setDraft(current); setEditing(true) }}>
        {current} ☺
      </button>
    )
  }
  return (
    <div className="motto">
      <input
        ref={inputRef}
        type="text"
        maxLength={24}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') setEditing(false)
        }}
      />
    </div>
  )
}

/** 搜索框（200ms 防抖过滤；数据在 ChatList 内按 keyword 过滤）。 */
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
        timerRef.current = setTimeout(() => { setKeyword(value.trim().toLowerCase()) }, 200)
      }}
    />
  )
}

/** 管理模式开关按钮（管理/管理中 + aria-pressed）。 */
export function ChatManageToggle() {
  const manage = useSessionStore(state => state.chatManage)
  return (
    <button
      type="button"
      className="chat-manage-toggle"
      id="chat-manage-toggle"
      aria-pressed={manage}
      onClick={() => useSessionStore.getState().setChatManage(!manage)}
    >
      {manage ? '管理中' : '管理'}
    </button>
  )
}

export { openNewChat, refreshChatList }
