/**
 * 消息流容器：entries 渲染 + 滚动跟随（I11）+ 回到最新。
 *
 * 跟随语义与旧 dom.js 同口径：程序化滚动挂标记（滚动事件异步投递，不标记会把
 * 自己的贴底误判成用户上滚）；上滚离开底部 160px 暂停、回到 40px 内恢复；
 * 选字复制期间不强拉滚动。视口锚定（stabilizeViewport 语义）随批 3 流式落定
 * 一并落地——批 1 的内容增长以追加为主，贴底口径已覆盖。
 */
import { useEffect, useRef } from 'react'
import { useTurnStore } from '../../stores/turn.ts'
import { renderEntry, Welcome } from './entries.tsx'

export function Thread() {
  const entries = useTurnStore(state => state.entries)
  const following = useTurnStore(state => state.following)
  const setFollowing = useTurnStore(state => state.setFollowing)
  const setSelecting = useTurnStore(state => state.setSelecting)
  const threadRef = useRef<HTMLDivElement>(null)
  const programmaticRef = useRef(false)

  // 跟随中内容增长贴底：程序化标记 + 下一帧释放（与旧 scrollToBottom 同竞态口径）。
  useEffect(() => {
    const thread = threadRef.current
    if (thread === null || !following) return
    programmaticRef.current = true
    thread.scrollTop = thread.scrollHeight
    const timer = requestAnimationFrame(() => { programmaticRef.current = false })
    return () => cancelAnimationFrame(timer)
  }, [entries, following])

  // 选字判定：selectionchange 挂 document（旧语义：锚点在线程内才算选字）。
  useEffect(() => {
    const onSelectionChange = () => {
      const selection = document.getSelection()
      const thread = threadRef.current
      setSelecting(selection !== null && !selection.isCollapsed && thread !== null && thread.contains(selection.anchorNode))
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [setSelecting])

  const onScroll = () => {
    if (programmaticRef.current) return
    const thread = threadRef.current
    if (thread === null) return
    const distance = thread.scrollHeight - thread.scrollTop - thread.clientHeight
    if (distance > 160) setFollowing(false)
    else if (distance < 40) setFollowing(true)
  }

  return (
    <div className="thread-wrap">
      <div className="thread" id="thread" ref={threadRef} onScroll={onScroll}>
        <div className="thread__inner">
          {entries.length === 0 ? <Welcome /> : entries.map(renderEntry)}
        </div>
      </div>
      {/* 跟随暂停时出现（I11）：点一下回到最新并恢复跟随。 */}
      <button
        type="button"
        className="jump-latest"
        hidden={following}
        onClick={() => {
          setFollowing(true)
          const thread = threadRef.current
          if (thread !== null) thread.scrollTop = thread.scrollHeight
        }}
      >
        ↓ 回到最新
      </button>
    </div>
  )
}
