/**
 * 应用外壳（旧 index.html 的 header/main 结构）：顶栏品牌与视图导航、对话主视图、
 * 快捷提问侧栏、历史对话抽屉与顶层提示行。
 *
 * 批 2a 范围：chat 视图与外壳。文章工作台/管理弹窗只渲染导航入口（点击提示
 * 批 2b 占位），workspace 视图给占位面。
 */
import { useState } from 'react'
import { announce } from '@dsh-agents-group/web-common'
import { newConversation } from '../chat-controller.ts'
import { useComposerStore } from '../stores/composer.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ReactElement } from 'react'
import { ChatHome } from './ChatHome.tsx'
import { Composer } from './Composer.tsx'
import { DshIcon } from './DshIcon.tsx'
import { HistoryDrawer } from './HistoryDrawer.tsx'

export function AppShell(): ReactElement {
  const view = useSessionStore(state => state.view)
  const setView = useSessionStore(state => state.setView)
  const notice = useSessionStore(state => state.notice)
  const identityReady = useSessionStore(state => state.identityReady)
  const busy = useConversationStore(state => state.history?.busy === true)
  const stopping = useComposerStore(state => state.stopping)
  const conversationId = useConversationStore(state => state.conversationId)
  const [historyOpen, setHistoryOpen] = useState(false)

  const batch2b = (name: string): void => {
    announce(`${name}在批 2b 迁移`)
    useSessionStore.getState().setNotice({ text: `${name}在批 2b 迁移，当前批只交付对话视图`, tone: 'info' })
  }

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
            onClick={() => batch2b('文章工作台')}
          >
            文章
          </button>
          <button type="button" onClick={() => batch2b('管理弹窗')}>
            管理
          </button>
        </nav>
        <div className="blg-topbar-actions">
          <button
            type="button"
            className="blg-topbar-btn"
            aria-expanded={historyOpen}
            aria-label={historyOpen ? '收起历史对话' : '打开对话历史'}
            title="历史对话"
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
        <main className="blg-workspace" aria-label="文章工作台">
          <section className="paper blg-workspace-card">
            <h1>文章工作台</h1>
            <p className="section-title">批 2b 迁移中</p>
            <p>
              文章库、编辑器、候选稿对比与管理弹窗随批 2b 落地；当前批（2a）交付的是
              订阅-快照数据层与对话视图。对话框视图不受影响，可先切回「对话」继续。
            </p>
            <button type="button" className="btn btn--primary" onClick={() => setView('chat')}>
              返回对话
            </button>
          </section>
        </main>
      )}

      {/* announce() 的读屏播报区：容器常驻（live region 节点不卸载）。 */}
      <div id="sr-status" className="visually-hidden" role="status" aria-live="polite" />
    </div>
  )
}
