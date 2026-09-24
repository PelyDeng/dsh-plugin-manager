/**
 * 历史会话面板（旧 web/conversation-history.js 的 React 等价，批 1a 范围收敛）。
 *
 * 做：搜索（防抖）、分组渲染（置顶/今天/昨天/…）、加载更多、打开、新建、
 * 重命名、删除、忙碌会话可显示不可切、死行（pending/failed/legacy）过滤。
 * 批 1b/后续补：多选批量、置顶切换、分享导出（数据操作都在 /conversation-action，
 * 缺的是交互面）。
 *
 * 形态=桌面左侧常驻抽屉 + 移动端弹层（旧 dialog 口径）；回答进行中列表禁点
 * （旧 setBusy(blocked) 口径：busy 行保留显示但不可切）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { openConversation, refreshConversations, startFreshConversation } from '../chat-controller.ts'
import { api } from '../lib/api.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ConversationItem } from '../lib/types.ts'
import type { ReactElement } from 'react'
import { Icon, announce } from '@dsh-agents-group/web-common'

/** 列表里只显示打得开的会话行（旧 conversationRowVisible：busy 必须保留）。 */
function rowVisible(item: ConversationItem): boolean {
  return item.state === undefined || item.state === 'ready' || item.state === 'busy'
}

/** 按最近活动时间分组（旧 historyGroup 口径：置顶优先，其余按自然日差）。 */
function groupOf(item: ConversationItem, now: number): string {
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

export function ConversationPanel({ open, onClose, busy }: { open: boolean; onClose: () => void; busy: boolean }): ReactElement | null {
  const conversations = useSessionStore(state => state.conversations)
  const offset = useSessionStore(state => state.conversationsOffset)
  const error = useSessionStore(state => state.conversationsError)
  const currentId = useSessionStore(state => state.conversationId)
  const setQuery = useSessionStore(state => state.setConversationsQuery)

  const [searchOpen, setSearchOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [renaming, setRenaming] = useState<ConversationItem | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [mutating, setMutating] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => clearTimeout(debounceRef.current), [])

  if (!open) return null

  const now = Date.now()
  const shown = conversations.filter(rowVisible)
  const groups: Array<{ label: string; items: ConversationItem[] }> = []
  for (const item of shown) {
    const label = groupOf(item, now)
    const bucket = groups.find(group => group.label === label)
    if (bucket === undefined) groups.push({ label, items: [item] })
    else bucket.items.push(item)
  }

  const onKeywordChange = (value: string): void => {
    setKeyword(value)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      useSessionStore.getState().setConversationsQuery(value.trim())
      void refreshConversations()
    }, 200)
  }

  const submitRename = async (): Promise<void> => {
    const target = renaming
    if (target === null) return
    const title = renameValue.trim()
    if (title === '') return
    setMutating(true)
    try {
      await api.conversationAction({ operation: 'rename', ids: [target.id], title })
      // 手动改名后自动标题不再覆盖该会话（旧码 rename 当前会话停轮询）。
      if (target.id === currentId) useSessionStore.getState().stopTitlePoll()
      await refreshConversations()
      announce('已重命名')
      setRenaming(null)
    } catch {
      announce('重命名失败')
    } finally {
      setMutating(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setMutating(true)
    try {
      await api.conversationAction({ operation: 'delete', ids: [id] })
      if (id === currentId) void startFreshConversation()
      else await refreshConversations()
      announce('对话已移除')
    } catch {
      announce('删除失败')
    } finally {
      setMutating(false)
    }
  }

  return (
    <aside className="co-history" aria-label="历史对话">
      <div className="co-history-head">
        <strong>历史对话</strong>
        <button type="button" className="co-icon-button" title="收起历史对话" aria-label="收起历史对话" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <button
        type="button"
        className="co-history-new"
        disabled={busy}
        title={busy ? '请等待回答完成或先停止' : '开启新对话'}
        onClick={() => { void startFreshConversation().then(created => { if (created) onClose() }) }}
      >
        <Icon name="sparkles" size={14} /> 开启新对话
      </button>
      {searchOpen && (
        <input
          ref={searchRef}
          type="search"
          className="co-history-search"
          placeholder="搜索对话标题"
          maxLength={120}
          aria-label="搜索对话标题"
          value={keyword}
          onChange={event => onKeywordChange(event.target.value)}
        />
      )}
      {error !== null && <p className="co-history-status" role="alert">{error}</p>}
      <div className="co-history-rows">
        {groups.map(group => (
          <div key={group.label}>
            <h3 className="co-history-group">{group.label}</h3>
            {group.items.map(item => (
              <div className={`co-history-row${item.id === currentId ? ' co-history-row--current' : ''}`} key={item.id} data-conversation={item.id}>
                <button
                  type="button"
                  className="co-history-title"
                  disabled={busy || mutating}
                  aria-current={item.id === currentId}
                  title={busy ? '请等待回答完成或先停止' : item.title}
                  onClick={() => { void openConversation(item.id).then(opened => { if (opened) onClose() }) }}
                >
                  {item.title === '' ? '新对话' : item.title}
                </button>
                <button
                  type="button"
                  className="co-icon-button"
                  title="重命名"
                  aria-label={`重命名 ${item.title}`}
                  disabled={mutating}
                  onClick={() => { setRenaming(item); setRenameValue(item.title) }}
                >
                  <Icon name="pen_line" size={13} />
                </button>
                <button
                  type="button"
                  className="co-icon-button co-icon-button--danger"
                  title="删除"
                  aria-label={`删除 ${item.title}`}
                  disabled={mutating}
                  onClick={() => { void remove(item.id) }}
                >
                  <Icon name="trash_2" size={13} />
                </button>
              </div>
            ))}
          </div>
        ))}
        {shown.length === 0 && <p className="co-history-empty">{keyword.trim() !== '' ? '没有匹配的对话' : '还没有历史对话'}</p>}
      </div>
      {offset !== null && (
        <button type="button" className="co-history-more" disabled={mutating} onClick={() => { void refreshConversations(true) }}>
          加载更多
        </button>
      )}
      <p className="co-history-footer">对话按最近活动时间分组</p>

      {renaming !== null && (
        <div className="co-history-dialog" role="dialog" aria-modal="true" aria-label="重命名对话">
          <div className="co-history-dialog-body">
            <input
              value={renameValue}
              maxLength={100}
              aria-label="对话标题"
              onChange={event => setRenameValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submitRename()
              }}
            />
          </div>
          <div className="co-history-dialog-actions">
            <button type="button" className="co-history-action" onClick={() => setRenaming(null)}>取消</button>
            <button type="button" className="co-history-action co-history-action--primary" disabled={mutating} onClick={() => { void submitRename() }}>保存</button>
          </div>
        </div>
      )}
    </aside>
  )
}

/** 面板开合状态（AppShell 层持有）。 */
export function useConversationPanel(): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return useMemo(() => ({ open, setOpen }), [open])
}
