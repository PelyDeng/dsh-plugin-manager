/**
 * 历史对话抽屉（旧 conversation-history.js 的 React 化；数据面在 conversation
 * store，操作走 chat-update）。
 *
 * 批 2a 范围：分组、切换、新建、搜索（200ms 防抖）、重命名、置顶、删除。
 * 导出与多选批量面登记批 2b（弹层与批量操作面板一起做）。弹层形态=新基线
 * （方案 §3.2 登记差异项）：重命名用行内编辑、删除用行内确认，不再弹 dialog。
 */
import { useEffect, useRef, useState } from 'react'
import { activate, newConversation, refreshConversations } from '../chat-controller.ts'
import { api } from '../lib/api.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ChatListItem } from '../lib/types.ts'
import type { ReactElement } from 'react'

/** 列表里只显示打得开的会话行（旧 conversationRowVisible 同口径）。 */
function rowVisible(item: ChatListItem): boolean {
  return item.state === undefined || item.state === 'ready' || item.state === 'busy'
}

/** 分组标题（旧 historyGroup：置顶/今天/昨天/7 天内/30 天内/更早）。 */
function groupOf(item: ChatListItem, now = Date.now()): string {
  if (item.pinned === true) return '置顶'
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const updated = new Date(item.updatedAt)
  updated.setHours(0, 0, 0, 0)
  const age = Math.floor((day.getTime() - updated.getTime()) / 86400000)
  if (age <= 0) return '今天'
  if (age === 1) return '昨天'
  if (age < 7) return '7 天内'
  if (age < 30) return '30 天内'
  return '更早'
}

/** 抽屉小图标（旧 conversation-history.js 的 historyIcon shapes 原样内联）。 */
const GLYPHS: Record<string, string> = {
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  panel: 'M4 3h16v18H4zM9 3v18',
  plus: 'M12 5v14M5 12h14',
  edit: 'M15 5l4 4M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16z',
  pin: 'M9 3h6l-1 6 4 4v2H6v-2l4-4zM12 15v6',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  close: 'M5 5l14 14M19 5 5 19',
}

function Glyph({ name, size = 15 }: { name: keyof typeof GLYPHS; size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={GLYPHS[name] ?? GLYPHS.close} />
    </svg>
  )
}

export function HistoryDrawer({ open, onClose, currentId }: {
  open: boolean
  onClose: () => void
  currentId: string
}): ReactElement {
  const conversations = useConversationStore(state => state.conversations)
  const offset = useConversationStore(state => state.conversationsOffset)
  const error = useConversationStore(state => state.conversationsError)
  const query = useConversationStore(state => state.conversationsQuery)
  const setConversationsQuery = useConversationStore(state => state.setConversationsQuery)
  const [searchOpen, setSearchOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [mutating, setMutating] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 打开时刷新列表（旧 sidebar.refresh）。
  useEffect(() => {
    if (open) void refreshConversations()
  }, [open])

  // 搜索 200ms 防抖计时器清理。
  useEffect(() => () => { if (debounceRef.current !== undefined) clearTimeout(debounceRef.current) }, [])

  const shown = conversations.filter(rowVisible)
  const groups: Array<[string, ChatListItem[]]> = []
  for (const item of shown) {
    const title = groupOf(item)
    const bucket = groups.find(([name]) => name === title)
    if (bucket !== undefined) bucket[1].push(item)
    else groups.push([title, [item]])
  }

  const setNotice = (text: string): void => useSessionStore.getState().setNotice({ text, tone: 'error' })

  const mutate = async (input: { operation: string; ids: string[]; title?: string; pinned?: boolean }): Promise<boolean> => {
    setMutating(true)
    try {
      await api.update(input)
      await refreshConversations()
      return true
    } catch (issue) {
      setNotice(issue instanceof Error ? issue.message : String(issue))
      return false
    } finally {
      setMutating(false)
    }
  }

  return (
    <aside className={`blg-history${open ? ' blg-history--open' : ''}`} aria-label="历史对话" aria-hidden={!open}>
      <div className="blg-history-head">
        <strong>历史对话</strong>
        <div className="blg-history-tools">
          <button
            type="button"
            className="blg-history-icon"
            aria-label="搜索对话"
            title="搜索对话"
            onClick={() => {
              setSearchOpen(value => !value)
              window.setTimeout(() => searchRef.current?.focus(), 0)
            }}
          >
            <Glyph name="search" />
          </button>
          <button type="button" className="blg-history-icon" aria-label="收起历史对话" title="收起历史对话" onClick={onClose}>
            <Glyph name="panel" />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="blg-history-new"
        onClick={() => {
          onClose()
          newConversation()
        }}
      >
        <Glyph name="plus" size={13} /> 开启新对话
      </button>
      {searchOpen && (
        <input
          ref={searchRef}
          type="search"
          className="blg-history-search"
          placeholder="搜索对话标题"
          maxLength={120}
          aria-label="搜索对话标题"
          defaultValue={query}
          onChange={event => {
            const value = event.target.value
            if (debounceRef.current !== undefined) clearTimeout(debounceRef.current)
            debounceRef.current = setTimeout(() => {
              setConversationsQuery(value.trim())
              void refreshConversations()
            }, 200)
          }}
        />
      )}
      {error !== null && <p className="blg-history-status" role="status">{error}</p>}
      <div className="blg-history-rows">
        {groups.map(([title, items]) => (
          <div key={title}>
            <h3>{title}</h3>
            {items.map(item => (
              <div key={item.id} className={`blg-history-row${item.id === currentId ? ' blg-history-row--current' : ''}`}>
                {editing === item.id ? (
                  <span className="blg-history-inline">
                    <input
                      value={editTitle}
                      maxLength={100}
                      aria-label="对话标题"
                      autoFocus
                      onChange={event => setEditTitle(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          const value = editTitle.trim()
                          if (value === '') return
                          void mutate({ operation: 'rename', ids: [item.id], title: value }).then(done => {
                            if (done) setEditing(null)
                          })
                        }
                        if (event.key === 'Escape') setEditing(null)
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn--tiny"
                      disabled={mutating}
                      onClick={() => {
                        const value = editTitle.trim()
                        if (value === '') return
                        void mutate({ operation: 'rename', ids: [item.id], title: value }).then(done => {
                          if (done) setEditing(null)
                        })
                      }}
                    >保存</button>
                    <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setEditing(null)}>取消</button>
                  </span>
                ) : confirming === item.id ? (
                  <span className="blg-history-inline">
                    <span className="blg-muted">将从历史列表移除，业务数据与附件保留。</span>
                    <button
                      type="button"
                      className="btn btn--tiny btn--danger"
                      disabled={mutating}
                      onClick={() => {
                        void mutate({ operation: 'delete', ids: [item.id] }).then(done => {
                          if (done) setConfirming(null)
                        })
                      }}
                    >确认删除</button>
                    <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setConfirming(null)}>取消</button>
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="blg-history-title"
                      aria-current={item.id === currentId}
                      title={item.title}
                      onClick={() => {
                        onClose()
                        // 旧码同款：回答进行中也可切换（activate 原子动作断流清面板，
                        // 迟到数据由 viewToken 守卫丢弃）。
                        void activate(item.id).catch(issue => setNotice(issue instanceof Error ? issue.message : String(issue)))
                      }}
                    >
                      {item.title || '新对话'}
                    </button>
                    <span className="blg-history-ops">
                      <button type="button" className="blg-history-icon" aria-label={`重命名 ${item.title || '新对话'}`} title="重命名" onClick={() => { setEditTitle(item.title); setEditing(item.id) }}>
                        <Glyph name="edit" size={13} />
                      </button>
                      <button
                        type="button"
                        className="blg-history-icon"
                        aria-label={item.pinned === true ? `取消置顶 ${item.title || '新对话'}` : `置顶 ${item.title || '新对话'}`}
                        title={item.pinned === true ? '取消置顶' : '置顶'}
                        disabled={mutating}
                        onClick={() => { void mutate({ operation: 'pin', ids: [item.id], pinned: item.pinned !== true }) }}
                      >
                        <Glyph name="pin" size={13} />
                      </button>
                      <button type="button" className="blg-history-icon blg-history-icon--danger" aria-label={`删除 ${item.title || '新对话'}`} title="删除" onClick={() => setConfirming(item.id)}>
                        <Glyph name="trash" size={13} />
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
        {shown.length === 0 && <p className="blg-history-empty">{query !== '' ? '没有匹配的对话' : '还没有历史对话'}</p>}
      </div>
      {offset !== null && (
        <button type="button" className="blg-history-more" onClick={() => { void refreshConversations(true) }}>
          加载更多
        </button>
      )}
      <p className="blg-history-foot">对话按最近活动时间分组</p>
    </aside>
  )
}
