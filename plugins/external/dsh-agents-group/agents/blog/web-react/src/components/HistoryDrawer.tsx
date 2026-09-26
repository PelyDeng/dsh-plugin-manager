/**
 * 历史对话侧栏（旧 web/conversation-history.js 的 React 化全量对齐，批 2c）。
 *
 * 形态回归旧版：桌面端默认展开的**左侧栏**（flex 子项静态占位，主区让位——
 * 旧 qh-expanded 机制在 React 布局下的等价实现，见 AppShell/CSS 注释）；窄屏
 * (≤960px) 维持左侧滑出浮层 + 遮罩（旧 mobile showModal 同语义）。开合状态由
 * AppShell 持久化到 localStorage（键 blog-history:<userId>，旧 chat.js 同键）。
 *
 * 批 2c 补齐的旧码行为（对照 conversation-history.js 逐项）：
 * - 行内操作菜单（旧 popover 菜单：重命名/置顶/分享 / 导出/多选/删除 + 键盘导航）；
 * - 多选批量栏（已选 N 条/选择已加载/导出/删除/取消，选中上限 100）；
 * - 分享 / 导出弹窗（conversationMarkdown 预览 + 复制 Markdown + 下载 .md）；
 * - 删除确认弹窗（旧 qh-dialog 文案原样）+ 删除含当前会话时回落新对话（旧 onDeleted）；
 * - 列表请求失败（非追加）清空列表（旧 refresh catch 同口径）；
 * - 搜索钮只展开不收起、点行/新建在窄屏才关侧栏（旧码分支同款）。
 *
 * 批 2d（B1③）：不设「回答进行中禁点历史行」。旧 blog 侧栏虽有 setBusy 实现
 * （conversation-history.js:73），但旧 chat.js 从不调用它（grep 证实只调
 * refresh/render/hide）——旧 blog 语义是回答中也可切换会话（activate 的原子
 * 动作断流清面板，迟到数据由代次守卫丢弃）。closedoff 的 setBusy 才是真接线。
 *
 * 已登记差异项（方案 §3.2 弹层形态=新基线）：重命名用行内编辑（保留批 2a 决策），
 * 空标题错误文案「请输入标题」对齐旧码。
 */
import { useEffect, useRef, useState } from 'react'
import { errorTextOf } from '@dsh-agents-group/web-common'
import { activate, newConversation, refreshConversations } from '../chat-controller.ts'
import { api } from '../lib/api.ts'
import { conversationMarkdown, conversationRowVisible, exportFileName, historyGroup } from '../lib/history.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ChatListItem } from '../lib/types.ts'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { Modal } from './common/Modal.tsx'

/** 抽屉小图标（旧 conversation-history.js 的 historyIcon shapes 原样内联）。 */
const GLYPHS: Record<string, string> = {
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  panel: 'M4 3h16v18H4zM9 3v18',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  edit: 'M15 5l4 4M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16z',
  pin: 'M9 3h6l-1 6 4 4v2H6v-2l4-4zM12 15v6',
  share: 'M12 16V3m-5 5 5-5 5 5M5 14v7h14v-7',
  select: 'M4 5h2m4 0h10M4 12h2m4 0h10M4 19h2m4 0h10',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  close: 'M5 5l14 14M19 5 5 19',
}

function Glyph({ name, size = 15 }: { name: keyof typeof GLYPHS; size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={GLYPHS[name] ?? GLYPHS.more} />
    </svg>
  )
}

/** 行内操作菜单的锚定项（旧 openMenu 的 item + anchor 定位参数）。 */
interface MenuTarget {
  item: ChatListItem
  x: number
  y: number
}

/** 多选上限（旧 render 的 selected.size>=100 与「选择已加载」slice(0,100)）。 */
const SELECT_LIMIT = 100

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
  const [editError, setEditError] = useState('')
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [multi, setMulti] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [mutating, setMutating] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [confirming, setConfirming] = useState<readonly string[] | null>(null)
  const [exporting, setExporting] = useState<readonly ChatListItem[] | null>(null)
  const [exportText, setExportText] = useState('')
  const [exportNote, setExportNote] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 打开时刷新列表（旧 sidebar.refresh；收起再展开也重拉，旧 show 不刷但 layout 后
  // 初次挂载会刷——这里按「可见即新鲜」口径，避免常驻侧栏数据过期）。
  useEffect(() => {
    if (open) void refreshConversations()
  }, [open])

  // 搜索 200ms 防抖计时器清理。
  useEffect(() => () => { if (debounceRef.current !== undefined) clearTimeout(debounceRef.current) }, [])

  // 选中清理（旧 refresh：列表刷新后剔除已不在列表里的选中项）。
  useEffect(() => {
    setSelected(previous => {
      if (previous.size === 0) return previous
      const next = new Set([...previous].filter(id => conversations.some(item => item.id === id)))
      return next.size === previous.size ? previous : next
    })
  }, [conversations])

  // 菜单的轻 dismissal（旧 popover=auto：点击外部关闭）与打开后聚焦首项。
  useEffect(() => {
    if (menu === null) return
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    first?.focus()
    const dismiss = (event: MouseEvent): void => {
      if (menuRef.current !== null && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setMenu(null)
      }
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [menu !== null])

  const shown = conversations.filter(conversationRowVisible)
  // 分组标题随行序插入（旧 render：遇到不同分组就插 h3；服务端置顶优先排序时
  // 「置顶」组自然落在最前）。
  const groups: Array<[string, ChatListItem[]]> = []
  for (const item of shown) {
    const title = historyGroup(item)
    const bucket = groups.find(([name]) => name === title)
    if (bucket !== undefined) bucket[1].push(item)
    else groups.push([title, [item]])
  }

  const setNotice = (text: string): void => useSessionStore.getState().setNotice({ text, tone: 'error' })

  /** 会话操作（重命名/置顶/删除，旧 update）：失败落到状态行（旧 report 同位）。 */
  const mutate = async (input: { operation: string; ids: readonly string[]; title?: string; pinned?: boolean }): Promise<boolean> => {
    setMutating(true)
    try {
      await api.update(input as { operation: string; ids: string[] })
      await refreshConversations()
      return true
    } catch (issue) {
      setNotice(errorTextOf(issue))
      return false
    } finally {
      setMutating(false)
    }
  }

  // ── 菜单（旧 openMenu）─────────────────────────────────────────────────

  const openMenu = (item: ChatListItem, anchor: HTMLButtonElement): void => {
    menuAnchorRef.current = anchor
    const rect = anchor.getBoundingClientRect()
    // 旧码定位：clamp 到视口内（左 8 / 距底一个菜单高度）。
    const x = Math.max(8, Math.min(window.innerWidth - 200, rect.left))
    const y = Math.max(8, Math.min(window.innerHeight - 228, rect.bottom + 5))
    setMenu({ item, x, y })
  }

  const closeMenu = (): void => {
    setMenu(null)
    menuAnchorRef.current?.focus()
  }

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  /** 菜单动作统一出口：先收菜单再执行（旧 onclick: menu.hidePopover(); fn()）。 */
  const runMenuAction = (fn: () => void): void => {
    setMenu(null)
    fn()
  }

  // ── 多选（旧 multi/selected/renderBatch）──────────────────────────────

  const enterMulti = (id: string): void => {
    setMulti(true)
    setSelected(new Set([id]))
  }

  const toggleSelect = (id: string, checked: boolean): void => {
    setSelected(previous => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const selectLoaded = (): void => {
    setSelected(new Set(shown.slice(0, SELECT_LIMIT).map(item => item.id)))
  }

  const exitMulti = (): void => {
    setMulti(false)
    setSelected(new Set())
  }

  // ── 删除（旧 confirmDelete + onDeleted）────────────────────────────────

  const confirmDelete = (ids: readonly string[]): void => {
    if (ids.length === 0) return
    setConfirming(ids)
  }

  const runDelete = async (): Promise<void> => {
    const ids = confirming ?? []
    const done = await mutate({ operation: 'delete', ids })
    if (!done) return
    setConfirming(null)
    // 旧 onDeleted：删掉的是当前打开的会话 → 回落新对话（activate(null) 清面板）。
    if (ids.includes(currentId)) await activate(null)
  }

  // ── 导出（旧 exportItems：逐条 read → markdown 合并 → 复制/下载）────────

  const exportItems = async (chosen: readonly ChatListItem[]): Promise<void> => {
    if (chosen.length === 0) return
    setExporting(chosen)
    setExportText('正在读取…')
    setExportNote('')
    try {
      const all: string[] = []
      for (const item of chosen) {
        const data = await api.history(item.id)
        all.push(conversationMarkdown(item.title, data.messages))
      }
      setExportText(all.join('\n\n---\n\n'))
    } catch (issue) {
      setExportText('')
      setExportNote(errorTextOf(issue))
    }
  }

  const copyExport = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(exportText)
      setExportNote('已复制')
    } catch {
      setExportNote('无法访问剪贴板，请选择上方文本复制')
    }
  }

  const downloadExport = (): void => {
    const chosen = exporting ?? []
    const blob = new Blob([exportText], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = exportFileName(chosen.map(item => item.title))
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  return (
    <>
      {open && <div className="blg-history-backdrop" aria-hidden="true" onClick={onClose} />}
      <aside className={`blg-history${open ? ' blg-history--open' : ''}`} aria-label="历史对话" aria-hidden={!open}>
        <div className="blg-history-head">
          <strong>历史对话</strong>
          <div className="blg-history-tools">
            {/* 旧 search.onclick：只展开搜索框并聚焦，不收起。 */}
            <button
              type="button"
              className="blg-history-icon"
              aria-label="搜索对话"
              title="搜索对话"
              onClick={() => {
                setSearchOpen(true)
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
        {/* 旧 create.onclick：窄屏先收侧栏再新建；桌面侧栏保持打开。 */}
        <button
          type="button"
          className="blg-history-new"
          onClick={() => {
            if (window.matchMedia('(max-width: 960px)').matches) onClose()
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
        {multi && (
          <div className="blg-history-batch">
            <span>已选 {selected.size} 条</span>
            <button type="button" disabled={mutating} onClick={selectLoaded}>选择已加载</button>
            <button type="button" disabled={mutating || selected.size === 0} onClick={() => { void exportItems(conversations.filter(item => selected.has(item.id))) }}>导出</button>
            <button type="button" disabled={mutating || selected.size === 0} onClick={() => { confirmDelete([...selected]) }}>删除</button>
            <button type="button" disabled={mutating} onClick={exitMulti}>取消</button>
          </div>
        )}
        <div className="blg-history-rows">
          {groups.map(([title, items]) => (
            <div key={title}>
              <h3>{title}</h3>
              {items.map(item => {
                const rowTitle = item.title || '新对话'
                const isCurrent = item.id === currentId
                return (
                  <div key={item.id} className={`blg-history-row${isCurrent ? ' blg-history-row--current' : ''}`}>
                    {multi && (
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        // 旧 render：未勾选且已到上限时禁用（最多选 100 条）。
                        disabled={!selected.has(item.id) && selected.size >= SELECT_LIMIT}
                        aria-label={`选择 ${rowTitle}`}
                        onChange={event => { toggleSelect(item.id, event.target.checked) }}
                      />
                    )}
                    {editing === item.id ? (
                      <span className="blg-history-inline">
                        <input
                          value={editTitle}
                          maxLength={100}
                          aria-label="对话标题"
                          autoFocus
                          onChange={event => { setEditTitle(event.target.value); setEditError('') }}
                          onKeyDown={event => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                              event.preventDefault()
                              const value = editTitle.trim()
                              // 旧 rename：空标题拦截并提示「请输入标题」。
                              if (value === '') { setEditError('请输入标题'); return }
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
                            if (value === '') { setEditError('请输入标题'); return }
                            void mutate({ operation: 'rename', ids: [item.id], title: value }).then(done => {
                              if (done) setEditing(null)
                            })
                          }}
                        >保存</button>
                        <button type="button" className="btn btn--tiny btn--ghost" onClick={() => { setEditing(null); setEditError('') }}>取消</button>
                        {editError !== '' && <span className="blg-history-inline-error" role="alert">{editError}</span>}
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="blg-history-title"
                          aria-current={isCurrent}
                          // 旧 blog 无「回答中禁点」语义（setBusy 从未被调用），始终可切换。
                          title={rowTitle}
                          onClick={() => {
                            if (window.matchMedia('(max-width: 960px)').matches) onClose()
                            // 旧码同款：回答进行中也可切换（activate 原子动作断流清面板，
                            // 迟到数据由 viewToken 守卫丢弃）。
                            void activate(item.id).catch(issue => setNotice(errorTextOf(issue)))
                          }}
                        >
                          {rowTitle}
                        </button>
                        <span className="blg-history-ops">
                          <button
                            type="button"
                            className="blg-history-icon"
                            aria-haspopup="menu"
                            aria-label={`操作 ${rowTitle}`}
                            title="操作"
                            onClick={event => { openMenu(item, event.currentTarget) }}
                          >
                            <Glyph name="more" size={13} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {shown.length === 0 && <p className="blg-history-empty">{query !== '' ? '没有匹配的对话' : '还没有历史对话'}</p>}
        </div>
        {/* 旧 more：offset 为 null（没有下一页）时隐藏；加载中禁用防重复追加。 */}
        {offset !== null && (
          <button
            type="button"
            className="blg-history-more"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true)
              void refreshConversations(true).finally(() => setLoadingMore(false))
            }}
          >
            加载更多
          </button>
        )}
        <p className="blg-history-foot">对话按最近活动时间分组</p>
      </aside>

      {/* 行内操作菜单（旧 qh-menu popover：固定定位 + 视口内 clamp）。 */}
      {menu !== null && (
        <div ref={menuRef} className="blg-history-menu" role="menu" aria-label="对话操作" style={{ left: menu.x, top: menu.y }} onKeyDown={onMenuKeyDown}>
          <button type="button" role="menuitem" className="blg-history-menu-item" disabled={mutating} onClick={() => { runMenuAction(() => { setEditTitle(menu.item.title); setEditError(''); setEditing(menu.item.id) }) }}>
            <Glyph name="edit" size={13} /> 重命名
          </button>
          <button
            type="button"
            role="menuitem"
            className="blg-history-menu-item"
            disabled={mutating}
            onClick={() => { runMenuAction(() => { void mutate({ operation: 'pin', ids: [menu.item.id], pinned: menu.item.pinned !== true }) }) }}
          >
            <Glyph name="pin" size={13} /> {menu.item.pinned === true ? '取消置顶' : '置顶'}
          </button>
          <button type="button" role="menuitem" className="blg-history-menu-item" disabled={mutating} onClick={() => { const item = menu.item; runMenuAction(() => { void exportItems([item]) }) }}>
            <Glyph name="share" size={13} /> 分享 / 导出
          </button>
          <button type="button" role="menuitem" className="blg-history-menu-item" disabled={mutating} onClick={() => { const item = menu.item; runMenuAction(() => { enterMulti(item.id) }) }}>
            <Glyph name="select" size={13} /> 多选
          </button>
          <button type="button" role="menuitem" className="blg-history-menu-item blg-history-menu-item--danger" disabled={mutating} onClick={() => { const id = menu.item.id; runMenuAction(() => { confirmDelete([id]) }) }}>
            <Glyph name="trash" size={13} /> 删除
          </button>
        </div>
      )}

      {/* 删除确认弹窗（旧 qh-dialog 文案原样；批量与单条共用）。 */}
      <Modal open={confirming !== null} onClose={() => { setConfirming(null) }} title={`删除 ${confirming?.length ?? 0} 条对话？`}>
        <div className="blg-history-dialog-body">
          <p>将从历史列表移除，无法从此页面恢复。业务数据、附件文件和官方留存日志不会被删除。</p>
          {error !== null && <p className="blg-history-status" role="alert">{error}</p>}
          <div className="blg-history-dialog-actions">
            <button type="button" onClick={() => { setConfirming(null) }}>取消</button>
            <button type="button" className="btn--danger" disabled={mutating} onClick={() => { void runDelete() }}>删除</button>
          </div>
        </div>
      </Modal>

      {/* 分享 / 导出弹窗（旧 exportItems：说明 + 只读预览 + 复制/下载）。 */}
      <Modal open={exporting !== null} onClose={() => { setExporting(null) }} title="分享对话">
        <div className="blg-history-dialog-body">
          <p>仅导出问答正文，不包含思考原文、附件文件或工具记录。不会生成公开链接。</p>
          <textarea readOnly aria-label="导出内容预览" value={exportText} onChange={() => {}} />
          {exportNote !== '' && <p className="blg-history-note" role="status">{exportNote}</p>}
          <div className="blg-history-dialog-actions">
            <button type="button" disabled={exportText === '正在读取…' || exportText === ''} onClick={() => { void copyExport() }}>复制 Markdown</button>
            <button type="button" disabled={exportText === '正在读取…' || exportText === ''} onClick={downloadExport}>下载 .md</button>
          </div>
        </div>
      </Modal>
    </>
  )
}
