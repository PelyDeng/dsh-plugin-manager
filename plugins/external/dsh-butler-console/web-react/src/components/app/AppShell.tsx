/**
 * App shell：三栏布局 + 窄屏抽屉 + inert 结算（方案批 1「I18 结算 effect 化」）。
 *
 * 类名与旧 index.html 同源（手账组件层样式，见 app.css 搬运段说明）。抽屉语义与旧
 * app.js 同口径：一次只开一个、共享遮罩、Escape 依次收起、开关都记返回焦点；
 * 键盘可达性按断点与开合状态在 effect 里结算（自身离屏或被遮罩盖住即 inert）。
 * 左右栏批 1 只做基础渲染（列表/成员/状态/失败记录只读面），交互批 2 完整化。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.ts'
import { recallConversation } from '../../lib/turn-event.ts'
import { bindViewHistory, loadIdentity, openConversation, openNewChat, refreshChatList, refreshPanelsData, resumeLiveTurn } from '../../hooks/use-turn.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useTurnStore } from '../../stores/turn.ts'
import { Thread } from '../chat/Thread.tsx'
import { Avatar } from '../chat/entries.tsx'
import { ChatList, ChatPager, ChatSearch, FailureList, ManageBar, Motto } from '../panels/left-right.tsx'
import { Composer, StopButton } from '../composer/Composer.tsx'

const DRAWER_QUERY = '(max-width: 1200px)'
const SIDEBAR_QUERY = '(max-width: 880px)'

function formatTime(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date().toDateString()) return clock
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${clock}`
}

export function AppShell() {
  const identityLabel = useSessionStore(state => state.identityLabel)
  const members = useSessionStore(state => state.members)
  const topStatus = useSessionStore(state => state.topStatus)
  const overview = useSessionStore(state => state.overview)
  const streaming = useTurnStore(state => state.streaming)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const leftPanelRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)
  const centerRef = useRef<HTMLElement>(null)
  const drawerReturnFocus = useRef<HTMLElement | null>(null)
  const sidebarReturnFocus = useRef<HTMLElement | null>(null)

  // ── 启动装配 + 右栏低频轮询（streaming 时不打断）──────────────────────
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const [memberPage, overviewPage] = await Promise.all([api.members(), api.overview()])
        if (cancelled) return
        const session = useSessionStore.getState()
        session.setMembers(memberPage.items)
        session.setOverview(overviewPage)
      } catch { /* 右栏读不到保持现状：下一轮轮询再试。 */ }
    }
    bindViewHistory()
    void refresh()
    void loadIdentity()
    void refreshPanelsData()
    void refreshChatList()
    const timer = setInterval(() => { if (!useTurnStore.getState().streaming) void refresh() }, 15000)
    // 不 await：接续要跟到那一轮结束，不能把页面启动卡在这里。
    void resumeLiveTurn()
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  // ── inert 结算（I18）：自身离屏或被另一抽屉的遮罩盖住都拦在键盘外 ──────
  useEffect(() => {
    const apply = () => {
      const drawerNarrow = window.matchMedia(DRAWER_QUERY).matches
      const sidebarNarrow = window.matchMedia(SIDEBAR_QUERY).matches
      if (leftPanelRef.current !== null) leftPanelRef.current.inert = (sidebarNarrow && !sidebarOpen) || (drawerNarrow && drawerOpen)
      if (rightPanelRef.current !== null) rightPanelRef.current.inert = drawerNarrow && !drawerOpen
      if (centerRef.current !== null) centerRef.current.inert = (drawerNarrow && drawerOpen) || (sidebarNarrow && sidebarOpen)
    }
    apply()
    const drawer = window.matchMedia(DRAWER_QUERY)
    const sidebar = window.matchMedia(SIDEBAR_QUERY)
    drawer.addEventListener('change', apply)
    sidebar.addEventListener('change', apply)
    return () => {
      drawer.removeEventListener('change', apply)
      sidebar.removeEventListener('change', apply)
    }
  }, [drawerOpen, sidebarOpen])

  // ── Escape 依次收起：设置页（批 5）→ 右抽屉 → 左抽屉；输入法组合不抢键 ──
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      if (drawerOpen) { event.preventDefault(); closeDrawer(); return }
      if (sidebarOpen) { event.preventDefault(); closeSidebar() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const openDrawer = () => {
    drawerReturnFocus.current = document.activeElement as HTMLElement | null
    if (sidebarOpen) { setSidebarOpen(false); sidebarReturnFocus.current = null }
    setDrawerOpen(true)
    window.requestAnimationFrame(() => { rightPanelRef.current?.focus() })
  }
  const closeDrawer = () => {
    setDrawerOpen(false)
    // 遮罩是否还亮着取决于另一侧是否开着（共享遮罩，由下方渲染推导）。
    drawerReturnFocus.current?.focus?.()
    drawerReturnFocus.current = null
  }
  const openSidebar = () => {
    sidebarReturnFocus.current = document.activeElement as HTMLElement | null
    if (drawerOpen) { setDrawerOpen(false); drawerReturnFocus.current = null }
    setSidebarOpen(true)
    window.requestAnimationFrame(() => { leftPanelRef.current?.focus() })
  }
  const closeSidebar = () => {
    setSidebarOpen(false)
    sidebarReturnFocus.current?.focus?.()
    sidebarReturnFocus.current = null
  }
  const toggleDrawer = () => { drawerOpen ? closeDrawer() : openDrawer() }
  const toggleSidebar = () => { sidebarOpen ? closeSidebar() : openSidebar() }
  const backdropVisible = drawerOpen || sidebarOpen

  const total = members.length
  const busy = members.filter(member => member.busy !== null).length
  const working = busy > 0 ? ` · ${busy} 位手上有活` : ''
  const counts = overview?.counts ?? {}

  return (
    <div className="shell">
      <header className="topbar">
        <button type="button" className="btn btn--ghost sidebar-toggle" aria-label="打开任务记录" aria-expanded={sidebarOpen} onClick={toggleSidebar}>☰</button>
        <span className="topbar__dots" aria-hidden="true"><i /><i /><i /></span>
        <h1 className="topbar__brand">牛马台账</h1>
        <p className="topbar__motto">牛马虽苦，但一起干，<br />　　就不孤单了~加油!</p>
        <span className="topbar__status"><span className="dot dot--online" aria-hidden="true" /><span>{topStatus !== '' ? topStatus : streaming ? '正在处理' : '已上线'}</span></span>
        <span className="spacer" />
        <p className="topbar__slogan">把重复的事，<span className="red-wavy">交给牛马们!</span></p>
        <span className="topbar__smile" aria-hidden="true">☺</span>
        <span className="identity">{identityLabel}</span>
        <button type="button" className="btn btn--ghost drawer-toggle" aria-label="打开成员档案" aria-expanded={drawerOpen} onClick={toggleDrawer}>🐮</button>
      </header>

      <div className="columns desk">
        <aside className="column column--left" id="left-panel" ref={leftPanelRef} tabIndex={-1} aria-label="任务记录">
          <div className="left__top">
            <div className="brand">
              <svg className="brand__badge" viewBox="0 0 34 32" aria-hidden="true">
                <path d="M17 2.6 C 18 6.2, 19 8.4, 21.4 9.6 C 24.2 10.8, 27.4 10.6, 30.8 10 C 28.6 12.8, 27.2 15, 26.8 17.4 C 26.4 19.8, 27.2 22.4, 28.8 25.4 C 25.6 24.4, 23 24.2, 20.6 25.2 C 18.2 26.2, 16.4 28.2, 14.6 30.4 C 14.2 27, 13.4 24.6, 11.6 22.8 C 9.8 21, 7.2 20, 3.6 19.6 C 6.6 17.6, 8.6 15.6, 9.6 13.2 C 10.6 10.8, 10.4 8, 9.4 4.8 C 12.4 6.4, 14.8 6.8, 17 2.6 Z" fill="#ffb703" stroke="#4a423a" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
              <div className="brand__row">
                <h2 className="brand__title" aria-label="牛马台账">
                  <img src="/butler/assets/media/titles/title-left.png" alt="" height="58" />
                </h2>
                <div className="left__brandline">{total > 0 ? `${total} 个牛马${working}` : '—'}</div>
              </div>
              <svg className="brand__wave" viewBox="0 0 150 8" preserveAspectRatio="none" aria-hidden="true">
                <path d="M2 5 C 15 1, 28 8, 42 4 S 70 1, 84 5 S 112 8, 126 4 S 142 2, 148 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="left__actions">
              <ChatSearch />
              <button
                type="button"
                className="btn btn--primary btn--chunky"
                onClick={() => { void openNewChat() }}
              >
                ＋ 新建
              </button>
            </div>
            <div className="left__records">
              <h2 className="section-title">任务记录</h2>
            </div>
            <ManageBar />
          </div>
          <div className="left__list" id="chat-list">
            <ChatList />
          </div>
          <ChatPager />
          <div className="crew">
            <h2 className="section-title">我的成员</h2>
            <div className="crew__row">
              <div className="crew__faces">
                {members.map(member => <Avatar key={member.agentId} agentId={member.agentId} size="sm" />)}
              </div>
              <div className="crew__cheers" aria-hidden="true">好的<br />牛马们！<br />辛苦啦! ♡</div>
            </div>
            <div className="crew__line">{total > 0 ? `共 ${total} 位${working}` : '—'}</div>
          </div>
        </aside>

        <main className="column column--center" aria-label="牛马调度群" ref={centerRef}>
          <div className="center__head">
            <h2 className="center__title" aria-label="牛马调度群">
              <svg className="center__circle" viewBox="0 0 190 46" preserveAspectRatio="none" aria-hidden="true">
                <path d="M22 8 C 60 2, 150 2, 172 10 C 188 17, 186 30, 164 37 C 128 45, 52 44, 24 38 C 4 32, 4 18, 22 8 Z" fill="none" stroke="var(--bt-red)" strokeWidth="2.8" strokeLinecap="round" />
                <path d="M30 6 C 70 1, 150 3, 170 12" fill="none" stroke="var(--bt-red)" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
              </svg>
              <img src="/butler/assets/media/titles/title-center.png" alt="" height="74" />
            </h2>
            <span className="center__sub">{total > 0 ? `${total} 位成员${working}` : '—'}</span>
            <span className="spacer" />
            <StopButton />
            <button type="button" className="icon-btn" title="设置" aria-label="设置" aria-expanded={false}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M10 2 v2.4 M10 15.6 V18 M2 10 h2.4 M15.6 10 H18 M4.2 4.2 l1.7 1.7 M14.1 14.1 l1.7 1.7 M15.8 4.2 l-1.7 1.7 M5.9 14.1 l-1.7 1.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <Thread />
          <Composer />
        </main>

        <aside className="column column--right" id="drawer" ref={rightPanelRef} tabIndex={-1} aria-label="成员档案">
          <section>
            <div className="panel">
              <h2 className="section-title section-title--members">成员档案</h2>
              <div id="member-list">
                {members.map(member => (
                  <div key={member.agentId} className="member member--compact" title={`${member.displayName}（@${member.agentId}）：${member.declaredName}`}>
                    <Avatar agentId={member.agentId} size="sm" />
                    <div>
                      <div className="member__name">{member.displayName}</div>
                      <div className="member__declared">{member.declaredName}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <section>
            <div className="panel">
              <h2 className="section-title section-title--metrics">运行状态</h2>
              <div className="metrics" id="metrics">
                {[
                  { label: '在干活', value: counts.running },
                  { label: '等你回话', value: counts.waitingUser },
                  { label: '待外部处理', value: counts.externalPending },
                  { label: '部分完成', value: counts.partial },
                  { label: '失败', value: counts.failed },
                  { label: '已完成', value: counts.completed },
                ].map(tile => (
                  <div key={tile.label} className="metric">
                    <span className="metric__value">{tile.value ?? 0}</span>
                    <span className="metric__label">{tile.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <section>
            <div className="panel">
              <FailureList />
            </div>
          </section>
          <Motto />
        </aside>
      </div>

      <div
        className="drawer-backdrop"
        id="drawer-backdrop"
        hidden={!backdropVisible}
        onClick={() => { if (drawerOpen) closeDrawer(); else if (sidebarOpen) closeSidebar() }}
      />
      <div className="visually-hidden" id="sr-status" role="status" aria-live="polite" />
    </div>
  )
}
