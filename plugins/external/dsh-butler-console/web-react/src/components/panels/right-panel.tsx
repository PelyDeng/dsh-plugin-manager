/**
 * 右栏交互组件（评审 #20 按栏拆分自 left-right.tsx）：失败记录（0.12.7 与任务记录
 * 同款：⋯ 菜单 + 行前复选框 + 正文点击进详情）与座右铭（旧 renderMotto 语义）。
 */
import { useEffect, useRef, useState } from 'react'
import { formatClock } from '../../lib/time.ts'
import { MOTTO_KEY, DEFAULT_MOTTO } from '../../lib/config.ts'
import { useSessionStore } from '../../stores/session.ts'
import { openTask, removePickedFailures } from '../../hooks/use-turn.ts'
import { useClickOutside } from '../common/basics.tsx'

/** 失败记录（0.12.7 与任务记录同款）：failure-head ⋯ 菜单 + 行前复选框 + 正文点击进详情。 */
export function FailureList() {
  const overview = useSessionStore(state => state.overview)
  const failurePicked = useSessionStore(state => state.failurePicked)
  const toggleFailurePicked = useSessionStore(state => state.toggleFailurePicked)
  const [menuOpen, setMenuOpen] = useState(false)
  const headRef = useRef<HTMLDivElement>(null)
  const items = overview?.failures ?? []
  useClickOutside(headRef, () => setMenuOpen(false), menuOpen)
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      headRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    window.requestAnimationFrame(() => {
      headRef.current?.querySelector<HTMLElement>('[role="menu"]')?.querySelector<HTMLElement>('button')?.focus()
    })
    headRef.current?.addEventListener('keydown', onKey)
    return () => headRef.current?.removeEventListener('keydown', onKey)
  }, [menuOpen])
  return (
    <>
      <div className="failure-head" ref={headRef}>
        <h2 className="section-title section-title--failures">失败记录</h2>
        <span className="chat-records-actions">
          <button
            type="button"
            className="chat-manage-menu-btn chat-manage-menu-btn--sm"
            id="failure-menu"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            title="操作"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ⋯
          </button>
          <span className="chat-manage-menu" id="failure-menu-pop" hidden={!menuOpen} role="menu">
            <button
              type="button"
              role="menuitem"
              className="chat-manage-menu__item chat-manage-menu__item--danger"
              disabled={failurePicked.length === 0}
              onClick={() => { setMenuOpen(false); void removePickedFailures() }}
            >
              删除所选
            </button>
          </span>
        </span>
      </div>
      <div className="failure-note"><div id="failure-list">
        {items.length === 0
          ? <p className="empty">暂无失败记录</p>
          : items.map(item => (
            <label key={item.id} className="failure-row failure-row--pick">
              <input
                type="checkbox"
                className="failure-row__check"
                checked={failurePicked.includes(item.id)}
                onChange={event => toggleFailurePicked(item.id, event.target.checked)}
              />
              <span className="failure-row__body" onClick={() => { void openTask(item.id) }}>
                <span className="failure-row__goal">{formatClock(item.updatedAt)}　{item.goal}</span>
                <span className="failure-row__meta">{item.error || '没给原因'}</span>
              </span>
            </label>
          ))}
      </div></div>
    </>
  )
}

/** 座右铭：点击就地编辑，blur/回车提交，空值回落默认（旧 renderMotto 语义；Esc 退出编辑为增强）。 */
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
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit()
          if (event.key === 'Escape') setEditing(false)
        }}
      />
    </div>
  )
}
