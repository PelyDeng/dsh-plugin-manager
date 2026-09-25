/**
 * 应用外壳（旧 index.html 的 header/main 结构）：顶栏品牌与视图导航、对话主视图、
 * 快捷提问侧栏、历史对话侧栏与顶层提示行。
 *
 * 批 2c：历史对话回归旧版「桌面默认展开的左侧栏」——开合状态收敛在这里持久化：
 * - 键 `blog-history:<userId>`（旧 web/chat.js 传给侧栏的 storageKey，值
 *   'collapsed'/'expanded' 格式不变；`chat-history` 只是旧码未采用的默认参数）；
 * - 初次进入：窄屏不自动展开，桌面按存储决定（旧 layout() 语义，缺省=展开）；
 * - 断点切换时重算（旧 mobile change → layout 同款）；
 * - 顶栏「历史对话」按钮开/收左栏并同步 aria-expanded/aria-label（旧 syncToggle：
 *   展开时「收起历史对话」、收起时「展开历史对话」）；收起状态只在桌面写回
 *   （旧 remember 只在 !mobile 分支写）。
 *
 * 布局让位对照旧 qh-expanded：旧码给 body 挂 qh-expanded 类再由 CSS 隐藏 rail/
 * 快捷栏；React 版侧栏是 .blg-workbench 的 flex 子项（静态占位 264px），展开时
 * 主列自然收窄，无需 body 类——效果等价（左栏 + 主区让位），机制少一层全局类。
 *
 * 批 2b 起：文章/管理入口接真实视图——「文章」切 workspace 视图（文章库/编辑器/
 * 候选稿对照/AI 助手），「管理」开管理弹窗（分类/标签/评论 + 查看公开博客与账号
 * 设置链接，旧 #management-dialog 的中转面并入）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { newConversation } from '../chat-controller.ts'
import { isMobileViewport, MOBILE_QUERY, readHistoryExpanded, writeHistoryExpanded } from '../lib/history.ts'
import { loadList } from '../workspace-controller.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import { useWorkspaceStore } from '../stores/workspace.ts'
import type { ReactElement } from 'react'
import { BackupDialog } from './manage/BackupDialog.tsx'
import { ChatHome } from './ChatHome.tsx'
import { Composer } from './Composer.tsx'
import { DshIcon } from './DshIcon.tsx'
import { HistoryDrawer } from './HistoryDrawer.tsx'
import { ManagementDialog } from './manage/ManagementDialog.tsx'
import { Modal } from './common/Modal.tsx'
import { LibraryPanel } from './writing/LibraryPanel.tsx'
import { WorkspaceView } from './writing/WorkspaceView.tsx'

export function AppShell(): ReactElement {
  const view = useSessionStore(state => state.view)
  const setView = useSessionStore(state => state.setView)
  const notice = useSessionStore(state => state.notice)
  const identityReady = useSessionStore(state => state.identityReady)
  const blogUrl = useSessionStore(state => state.blogUrl)
  const userId = useSessionStore(state => state.userId)
  const backupAdmin = useSessionStore(state => state.backupAdmin)
  const conversationId = useConversationStore(state => state.conversationId)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  // 备份与恢复（旧 backup-dialog；仅 backupAdmin 可见入口）。
  const [backupOpen, setBackupOpen] = useState(false)
  // 文章库弹层（旧顶栏 library-toggle：任何视图可直接打开文章库，B3）。
  const [libraryOpen, setLibraryOpen] = useState(false)

  // 编辑中关闭/刷新页面的未保存警告（旧 beforeunload：S.dirty 时 preventDefault，A2）。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (useWorkspaceStore.getState().dirty) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // 提示行显示后焦点移入（旧 notice() 的 el.focus()；容器 tabIndex=-1 可聚焦，B11）。
  useEffect(() => {
    if (notice !== null) document.getElementById('blg-notice')?.focus({ preventScroll: true })
  }, [notice])

  // 身份就绪后按存储与断点定初始开合（旧 layout()：mobile 不展开；桌面
  // localStorage!=='collapsed' 即展开，无记录也展开）。
  useEffect(() => {
    if (userId === '') return
    setHistoryOpen(!isMobileViewport() && readHistoryExpanded(userId) !== 'collapsed')
  }, [userId])

  // 断点切换重算（旧 mobile.addEventListener('change', layout)）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const query = window.matchMedia(MOBILE_QUERY)
    const relayout = (): void => {
      if (userId === '') return
      setHistoryOpen(!query.matches && readHistoryExpanded(userId) !== 'collapsed')
    }
    query.addEventListener('change', relayout)
    return () => query.removeEventListener('change', relayout)
  }, [userId])

  // 开/收左栏（旧 toggle.onclick：桌面写回存储，窄屏只影响本次）。
  const toggleHistory = useCallback((): void => {
    setHistoryOpen(value => {
      const next = !value
      if (userId !== '' && !isMobileViewport()) {
        writeHistoryExpanded(userId, next ? 'expanded' : 'collapsed')
      }
      return next
    })
  }, [userId])

  // 收起（侧栏内收起钮/遮罩点击）：桌面写回 collapsed（旧 collapse.onclick 同款）。
  const closeHistory = useCallback((): void => {
    setHistoryOpen(false)
    if (userId !== '' && !isMobileViewport()) writeHistoryExpanded(userId, 'collapsed')
  }, [userId])

  return (
    <div className="blg-shell">
      <header className="blg-topbar">
        <span className="blg-brand">
          <span className="blg-brand-mark" aria-hidden="true"><DshIcon name="chat" size={15} /></span>
          博客助手
        </span>
        <nav className="blg-view-nav" aria-label="博客工作区">
          <button
            type="button"
            aria-pressed={view === 'chat'}
            onClick={() => setView('chat')}
          >
            对话
          </button>
          <button
            type="button"
            aria-pressed={view === 'writing'}
            onClick={() => setView('writing')}
          >
            文章
          </button>
          <button type="button" aria-haspopup="dialog" onClick={() => setManageOpen(true)}>
            管理
          </button>
        </nav>
        <div className="blg-topbar-actions">
          <button
            type="button"
            className="blg-topbar-btn"
            aria-expanded={historyOpen}
            aria-label={historyOpen ? '收起历史对话' : '展开历史对话'}
            title={historyOpen ? '收起历史对话' : '展开历史对话'}
            onClick={toggleHistory}
          >
            历史对话
          </button>
          {/* 旧 library-toggle：任意视图可直接打开文章库弹层（B3）。 */}
          <button
            type="button"
            className="blg-topbar-btn"
            aria-haspopup="dialog"
            onClick={() => setLibraryOpen(true)}
          >
            文章库
          </button>
          <button
            type="button"
            className="blg-topbar-btn"
            disabled={!identityReady}
            aria-label="新对话"
            title="新对话"
            onClick={() => newConversation()}
          >
            新对话
          </button>
        </div>
      </header>

      <div id="blg-notice" className="blg-notice" role="alert" tabIndex={-1} hidden={notice === null}>
        {notice?.text}
      </div>

      {view === 'chat' ? (
        <div className="blg-workbench">
          {/* 左栏在前（旧 panel.prepend 到 chat-home 的 DOM 序）。 */}
          <HistoryDrawer open={historyOpen} onClose={closeHistory} currentId={conversationId} />
          <div className="blg-chat-col">
            <ChatHome />
            <Composer onNotice={text => useSessionStore.getState().setNotice({ text, tone: 'error' })} />
          </div>
        </div>
      ) : (
        <WorkspaceView />
      )}

      <ManagementDialog open={manageOpen} onClose={() => setManageOpen(false)} />
      <BackupDialog open={backupOpen} onClose={() => setBackupOpen(false)} />
      {libraryOpen && <LibraryDialog onClose={() => setLibraryOpen(false)} />}

      {/* 管理弹窗底部的公开博客与账号设置链接（旧 #management-dialog 的链接行）；
          备份与恢复仅 backupAdmin 可见（旧 $('backup-open').hidden 口径）。 */}
      <div className="blg-management-links-bar">
        <a href={blogUrl} target="_blank" rel="noopener noreferrer">查看公开博客</a>
        {backupAdmin && (
          <button type="button" onClick={() => setBackupOpen(true)}>备份与恢复</button>
        )}
        <a href="/auth">账号与模型设置</a>
      </div>

      {/* announce() 的读屏播报区：容器常驻（live region 节点不卸载）。 */}
      <div id="sr-status" className="visually-hidden" role="status" aria-live="polite" />
    </div>
  )
}

/**
 * 文章库弹层（旧 library 面板挂 navigation-dialog 的弹层形态，B3）：复用
 * LibraryPanel 数据面；打开时刷新列表，打开文章后随草稿装配自动收起
 * （旧 fill 的 `$('library').classList.remove('open')`）。
 */
function LibraryDialog({ onClose }: { onClose: () => void }): ReactElement {
  const draftId = useWorkspaceStore(state => state.draft?.id)
  const openedWithRef = useRef(draftId)

  // 打开即刷新列表（旧 library() 可见时列表是最新的）。
  useEffect(() => {
    void loadList().catch(() => {}) // 失败由 LibraryPanel 的错误行展示
  }, [])

  // 打开文章（fill 装配了另一篇草稿）→ 自动收起（旧码同款；非本次打开的草稿不算）。
  useEffect(() => {
    if (draftId !== openedWithRef.current) onClose()
  }, [draftId, onClose])

  return (
    <Modal open onClose={onClose} title="文章库" className="blg-dialog--library">
      <LibraryPanel />
    </Modal>
  )
}
