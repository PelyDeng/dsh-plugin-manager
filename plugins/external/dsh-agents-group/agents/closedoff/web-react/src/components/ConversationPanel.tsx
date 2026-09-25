/**
 * 历史会话面板（旧 web/conversation-history.js 的 React 等价，批 1b 补齐）。
 *
 * 做：搜索（防抖）、分组渲染（置顶/今天/昨天/…）、加载更多、打开、新建、
 * 行操作菜单（重命名/置顶切换/分享导出/多选/删除，旧 qh-menu 五项一一对应）、
 * 多选批量（勾选上限 100 / 选择已加载 / 批量导出 / 批量删除 / 取消）、
 * 导出对话框（读 /history → Markdown 预览 → 复制/下载，旧 exportItems 口径）、
 * 删除确认（说明只从列表移除，业务数据不删）、忙碌会话可显示不可切、
 * 死行（pending/failed/legacy）过滤。
 *
 * 形态=桌面左侧常驻抽屉 + 移动端弹层；回答进行中列表禁点（旧 setBusy(blocked)）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { openConversation, refreshConversations, startFreshConversation } from '../chat-controller.ts'
import { api } from '../lib/api.ts'
import { conversationMarkdown, exportFileName } from '../lib/conversation-export.ts'
import { isMobileViewport } from '../lib/viewport.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ConversationItem } from '../lib/types.ts'
import type { ReactElement } from 'react'
import { Icon, announce } from '@dsh-agents-group/web-common'

/** 多选上限（旧码 check.disabled=!checked&&selected.size>=100 口径）。 */
const MULTI_SELECT_LIMIT = 100

/** 行操作菜单项（旧 qh-menu 五项，顺序一致）。 */
const MENU_ITEMS = ['重命名', '置顶', '分享导出', '多选', '删除'] as const

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
  const [renameError, setRenameError] = useState('')
  const [mutating, setMutating] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [multi, setMulti] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState<{ ids: string[] } | null>(null)
  const [exporting, setExporting] = useState<{ ids: string[] } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(debounceRef.current), [])

  // 关闭面板即收起菜单/多选瞬时态（导出对话框挂 document.body 语义，保留）。
  useEffect(() => {
    if (!open) {
      setMenuFor(null)
    }
  }, [open])

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

  /** 行操作统一入口（旧 update：执行 → 删行后处理 → 刷新）。 */
  const mutate = async (run: () => Promise<unknown>): Promise<void> => {
    setMutating(true)
    try {
      await run()
    } catch {
      announce('操作失败')
    } finally {
      setMutating(false)
    }
  }

  const submitRename = (target: ConversationItem): Promise<void> => mutate(async () => {
    const title = renameValue.trim()
    // 旧码 rename submit：空标题不提交，就地给「请输入标题」提示（role=alert）。
    if (title === '') {
      setRenameError('请输入标题')
      return
    }
    await api.conversationAction({ operation: 'rename', ids: [target.id], title })
    // 手动改名后自动标题不再覆盖该会话（旧码 rename 当前会话停轮询）。
    if (target.id === currentId) useSessionStore.getState().stopTitlePoll()
    await refreshConversations()
    announce('已重命名')
    setRenaming(null)
  })

  const togglePin = (item: ConversationItem): Promise<void> => mutate(async () => {
    await api.conversationAction({ operation: 'pin', ids: [item.id], pinned: item.pinned !== true })
    await refreshConversations()
    announce(item.pinned === true ? '已取消置顶' : '已置顶')
  })

  const removeIds = (ids: string[]): Promise<void> => mutate(async () => {
    await api.conversationAction({ operation: 'delete', ids })
    // 当前会话被删 → 回到新对话（旧 onDeleted 口径）。
    if (ids.includes(currentId)) void startFreshConversation()
    else await refreshConversations()
    setSelectedIds(previous => {
      const next = new Set(previous)
      for (const id of ids) next.delete(id)
      return next
    })
    announce(ids.length === 1 ? '对话已移除' : `已移除 ${ids.length} 条对话`)
    setConfirming(null)
  })

  const openExport = (ids: string[]): void => {
    setMenuFor(null)
    setExporting({ ids })
  }

  const toggleSelected = (id: string): void => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else if (next.size < MULTI_SELECT_LIMIT) next.add(id)
      return next
    })
  }

  const exitMulti = (): void => {
    setMulti(false)
    setSelectedIds(new Set())
  }


  return (
    <aside className="co-history" aria-label="历史对话">
      <div className="co-history-head">
        <strong>历史对话</strong>
        <button type="button" className="co-icon-button" title="收起历史对话" aria-label="收起历史对话" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {/* 新建/打开行后仅窄屏浮层态收起（旧码 `if (mobile.matches) hide()`）：
          桌面常驻形态收起会打断「连续翻历史」的操作流。 */}
      <button
        type="button"
        className="co-history-new"
        disabled={busy}
        title={busy ? '请等待回答完成或先停止' : '开启新对话'}
        onClick={() => { void startFreshConversation().then(created => { if (created && isMobileViewport()) onClose() }) }}
      >
        <Icon name="sparkles" size={14} /> 开启新对话
      </button>
      {searchOpen && (
        <input
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

      {/* 多选批量条（旧 renderBatch：已选计数 + 选择已加载/导出/删除/取消）。 */}
      {multi && (
        <div className="co-history-batch">
          <span>已选 {selectedIds.size} 条</span>
          <button
            type="button"
            disabled={mutating}
            onClick={() => setSelectedIds(new Set(shown.slice(0, MULTI_SELECT_LIMIT).map(item => item.id)))}
          >
            选择已加载
          </button>
          <button type="button" disabled={mutating || selectedIds.size === 0} onClick={() => openExport([...selectedIds])}>导出</button>
          <button
            type="button"
            className="co-history-batch--danger"
            disabled={mutating || selectedIds.size === 0}
            onClick={() => setConfirming({ ids: [...selectedIds] })}
          >
            删除
          </button>
          <button type="button" disabled={mutating} onClick={exitMulti}>取消</button>
        </div>
      )}

      <div className="co-history-rows">
        {groups.map(group => (
          <div key={group.label}>
            <h3 className="co-history-group">{group.label}</h3>
            {group.items.map(item => (
              <div className={`co-history-row${item.id === currentId ? ' co-history-row--current' : ''}`} key={item.id} data-conversation={item.id}>
                {multi && (
                  <input
                    type="checkbox"
                    className="co-history-check"
                    checked={selectedIds.has(item.id)}
                    disabled={!selectedIds.has(item.id) && selectedIds.size >= MULTI_SELECT_LIMIT}
                    aria-label={`选择 ${item.title || '新对话'}`}
                    onChange={() => toggleSelected(item.id)}
                  />
                )}
                <button
                  type="button"
                  className="co-history-title"
                  disabled={busy || mutating}
                  aria-current={item.id === currentId}
                  title={busy ? '请等待回答完成或先停止' : item.title}
                  onClick={() => { void openConversation(item.id).then(opened => { if (opened && isMobileViewport()) onClose() }) }}
                >
                  {item.title === '' ? '新对话' : item.title}
                </button>
                <button
                  type="button"
                  className="co-icon-button"
                  title="操作"
                  aria-label={`操作 ${item.title || '新对话'}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === item.id}
                  disabled={mutating}
                  onClick={() => setMenuFor(previous => previous === item.id ? null : item.id)}
                >
                  <Icon name="hand" size={13} />
                </button>
                {menuFor === item.id && (
                  <div className="co-history-menu" role="menu" aria-label={`对话操作 ${item.title || '新对话'}`}>
                    {MENU_ITEMS.map(label => {
                      const props =
                        label === '重命名'
                          ? { onClick: () => { setMenuFor(null); setRenaming(item); setRenameValue(item.title); setRenameError('') } }
                          : label === '置顶'
                            ? { onClick: () => { setMenuFor(null); void togglePin(item) } }
                            : label === '分享导出'
                              ? { onClick: () => openExport([item.id]) }
                              : label === '多选'
                                ? { onClick: () => { setMenuFor(null); setMulti(true); setSelectedIds(new Set([item.id])) } }
                                : { onClick: () => { setMenuFor(null); setConfirming({ ids: [item.id] }) } }
                      return (
                        <button
                          key={label}
                          type="button"
                          role="menuitem"
                          className={`co-history-menu-item${label === '删除' ? ' co-history-menu-item--danger' : ''}`}
                          disabled={mutating}
                          {...props}
                        >
                          {label === '置顶' ? (item.pinned === true ? '取消置顶' : '置顶') : label}
                        </button>
                      )
                    })}
                  </div>
                )}
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
              onChange={event => {
                setRenameValue(event.target.value)
                // 输入即清除旧提示（旧码每次 submit 重算 error）。
                if (renameError !== '') setRenameError('')
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submitRename(renaming)
              }}
            />
            <p className="co-history-dialog-error" role="alert">{renameError}</p>
          </div>
          <div className="co-history-dialog-actions">
            <button type="button" className="co-history-action" onClick={() => setRenaming(null)}>取消</button>
            <button type="button" className="co-history-action co-history-action--primary" disabled={mutating} onClick={() => { void submitRename(renaming) }}>保存</button>
          </div>
        </div>
      )}

      {confirming !== null && (
        <div className="co-history-dialog" role="dialog" aria-modal="true" aria-label={`删除 ${confirming.ids.length} 条对话？`}>
          <div className="co-history-dialog-body">
            <h2 className="co-history-dialog-title">删除 {confirming.ids.length} 条对话？</h2>
            <p className="co-history-dialog-copy">将从历史列表移除，无法从此页面恢复。业务数据、附件文件和官方留存日志不会被删除。</p>
          </div>
          <div className="co-history-dialog-actions">
            <button type="button" className="co-history-action" onClick={() => setConfirming(null)}>取消</button>
            <button type="button" className="co-history-action co-history-action--danger" disabled={mutating} onClick={() => { void removeIds(confirming.ids) }}>删除</button>
          </div>
        </div>
      )}

      {exporting !== null && (
        <ExportDialog ids={exporting.ids} onDone={() => setExporting(null)} />
      )}
    </aside>
  )
}

/** 分享导出对话框（旧 exportItems：读 /history → Markdown 预览 → 复制/下载）。 */
function ExportDialog({ ids, onDone }: { ids: string[]; onDone: () => void }): ReactElement {
  const [preview, setPreview] = useState('正在读取…')
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const titleRef = useRef('对话记录')

  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      try {
        const titles: string[] = []
        const parts: string[] = []
        for (const id of ids) {
          const data = await api.history(id)
          const title = useSessionStore.getState().conversations.find(item => item.id === id)?.title ?? '对话记录'
          titles.push(title)
          parts.push(conversationMarkdown(title, data.history))
        }
        if (cancelled) return
        titleRef.current = exportFileName(titles)
        setPreview(parts.join('\n\n---\n\n'))
        setReady(true)
      } catch (caught) {
        if (!cancelled) {
          setPreview('')
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }
    void run()
    return () => { cancelled = true }
  }, [ids])

  const copy = (): void => {
    navigator.clipboard?.writeText(preview)
      .then(() => setError('已复制'))
      .catch(() => setError('无法访问剪贴板，请选择上方文本复制'))
  }

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([preview], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = titleRef.current
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="co-history-dialog" role="dialog" aria-modal="true" aria-label="分享对话">
      <div className="co-history-dialog-body">
        <h2 className="co-history-dialog-title">分享对话</h2>
        <p className="co-history-dialog-copy">仅导出问答正文，不包含思考原文、附件文件或工具记录。不会生成公开链接。</p>
        <textarea className="co-history-export-preview" readOnly aria-label="导出内容预览" value={preview} />
        <p className="co-history-export-status" role="status">{error}</p>
      </div>
      <div className="co-history-dialog-actions">
        <button type="button" className="co-history-action" disabled={!ready} onClick={copy}>复制 Markdown</button>
        <button type="button" className="co-history-action co-history-action--primary" disabled={!ready} onClick={download}>下载 .md</button>
        <button type="button" className="co-history-action" onClick={onDone}>关闭</button>
      </div>
    </div>
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
