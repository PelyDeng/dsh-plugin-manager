/**
 * 应用外壳（旧 index.html 的 header/main 结构）：顶栏品牌与视图导航、对话主视图、
 * 快捷提问侧栏、历史对话抽屉与顶层提示行。
 *
 * 批 2b 起：文章/管理入口接真实视图——「文章」切 workspace 视图（文章库/编辑器/
 * 候选稿对照/AI 助手），「管理」开管理弹窗（分类/标签/评论 + 查看公开博客与账号
 * 设置链接，旧 #management-dialog 的中转面并入）。
 */
import { useState } from 'react'
import { newConversation } from '../chat-controller.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ReactElement } from 'react'
import { ChatHome } from './ChatHome.tsx'
import { Composer } from './Composer.tsx'
import { DshIcon } from './DshIcon.tsx'
import { HistoryDrawer } from './HistoryDrawer.tsx'
import { ManagementDialog } from './manage/ManagementDialog.tsx'
import { WorkspaceView } from './writing/WorkspaceView.tsx'

export function AppShell(): ReactElement {
  const view = useSessionStore(state => state.view)
  const setView = useSessionStore(state => state.setView)
  const notice = useSessionStore(state => state.notice)
  const identityReady = useSessionStore(state => state.identityReady)
  const blogUrl = useSessionStore(state => state.blogUrl)
  const conversationId = useConversationStore(state => state.conversationId)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)

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
            aria-label="打开对话历史"
            title="打开对话历史"
            onClick={() => setHistoryOpen(value => !value)}
          >
            历史对话
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
          <div className="blg-chat-col">
            <ChatHome />
            <Composer onNotice={text => useSessionStore.getState().setNotice({ text, tone: 'error' })} />
          </div>
          <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} currentId={conversationId} />
        </div>
      ) : (
        <WorkspaceView />
      )}

      <ManagementDialog open={manageOpen} onClose={() => setManageOpen(false)} />

      {/* 管理弹窗底部的公开博客与账号设置链接（旧 #management-dialog 的链接行）。 */}
      <div className="blg-management-links-bar">
        <a href={blogUrl} target="_blank" rel="noopener noreferrer">查看公开博客</a>
        <a href="/auth">账号与模型设置</a>
      </div>

      {/* announce() 的读屏播报区：容器常驻（live region 节点不卸载）。 */}
      <div id="sr-status" className="visually-hidden" role="status" aria-live="polite" />
    </div>
  )
}
