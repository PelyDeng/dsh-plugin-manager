/**
 * 消息流：board 消息 + 活动流式轮次 + 欢迎页。
 *
 * 跟底滚动沿用旧口径：用户在底部附近（≤24px）时新内容自动下滚，向上翻阅即停
 * （followBottom）。活动轮次是 turn store 的派生视图（与归档消息同构渲染）。
 */
import { useEffect, useRef } from 'react'
import { useBoardStore, useSessionStore, useTurnStore } from '../hooks/use-chat-stream.ts'
import type { ReactElement } from 'react'
import type { AssistantTurnView } from './AssistantTurn.tsx'
import { AssistantTurn } from './AssistantTurn.tsx'
import { Icon } from '@dsh-agents-group/web-common'

function Welcome(): ReactElement {
  return (
    <div className="co-welcome">
      <h2>您好，我是<em>封闭化管理助手</em></h2>
      <p>
        我可以自动调用园区业务接口，为您查询并分析：<br />
        预约审批、车辆轨迹与实时定位、路网停车、预警报警、出入记录、黑白名单等。
      </p>
      <div className="co-caps">
        <span className="co-cap"><Icon name="check" size={13} /> 预约审批</span>
        <span className="co-cap"><Icon name="camera" size={13} /> 人车物定位追踪</span>
        <span className="co-cap"><Icon name="arrow_up_right" size={13} /> 园区路网</span>
        <span className="co-cap"><Icon name="sparkles" size={13} /> 预警报警</span>
        <span className="co-cap"><Icon name="hand" size={13} /> 停车区</span>
        <span className="co-cap"><Icon name="search" size={13} /> 园区概览</span>
      </div>
    </div>
  )
}

export function MessageList({ onRated, onBranch, onNotice }: {
  onRated: (index: number, rating: 'positive' | 'negative' | null) => void
  onBranch: (conversationId: string) => void
  onNotice: (text: string) => void
}): ReactElement {
  const messages = useBoardStore(state => state.messages)
  const restorePhase = useBoardStore(state => state.restorePhase)
  const restoreError = useBoardStore(state => state.restoreError)
  const conversationId = useSessionStore(state => state.conversationId)
  const identityLabel = useSessionStore(state => state.identityLabel)
  const turnActive = useTurnStore(state => state.active)
  const turnText = useTurnStore(state => state.text)
  const turnThinking = useTurnStore(state => state.thinking)
  const turnThinkingDone = useTurnStore(state => state.thinkingDone)
  const turnTools = useTurnStore(state => state.tools)
  const turnCards = useTurnStore(state => state.cards)
  const turnTracks = useTurnStore(state => state.tracks)
  const turnFences = useTurnStore(state => state.fences)
  const turnMedia = useTurnStore(state => state.media)
  const turnHasStructured = useTurnStore(state => state.hasStructured)
  const turnFinishReason = useTurnStore(state => state.finishReason)
  const turnTerminalMessage = useTurnStore(state => state.terminalMessage)
  const turnTerminalTone = useTurnStore(state => state.terminalTone)
  const turnMeta = useTurnStore(state => state.meta)

  const scrollerRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    if (followRef.current) scroller.scrollTop = scroller.scrollHeight
  })

  const turnView: AssistantTurnView | null = turnActive
    ? {
      text: turnText,
      hasStructured: turnHasStructured,
      thinking: turnThinking,
      thinkingDone: turnThinkingDone,
      tools: turnTools,
      cards: turnCards,
      tracks: turnTracks,
      fences: turnFences,
      media: turnMedia,
      streaming: true,
      finishReason: turnFinishReason,
      terminalMessage: turnTerminalMessage,
      terminalTone: turnTerminalTone,
      meta: turnMeta,
      conversationId,
      onBranch,
      onNotice,
    }
    : null

  return (
    <div
      className="co-messages"
      ref={scrollerRef}
      onScroll={event => {
        const node = event.currentTarget
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24
      }}
    >
      <div className="co-inner">
        {messages.length === 0 && !turnActive && restorePhase !== 'loading' && (
          <>
            <Welcome />
            <p className="co-current-user sr-only">{identityLabel}</p>
          </>
        )}
        {restorePhase === 'loading' && <p className="co-restore-hint" role="status">正在恢复对话…</p>}
        {restorePhase === 'error' && (
          <p className="co-restore-hint co-restore-hint--error" role="alert">对话恢复失败：{restoreError}</p>
        )}
        {messages.map((message, index) => {
          if (message.kind === 'user') {
            return (
              <div className="co-msg co-msg--user" key={`u-${index}`}>
                <div className="co-bubble co-bubble--user">{message.text}</div>
                <div className="co-avatar co-avatar--usr" aria-hidden="true"><Icon name="hand" size={15} /></div>
              </div>
            )
          }
          return (
            <AssistantTurn
              key={`a-${index}`}
              view={{ ...message, streaming: false, conversationId, onRated: rating => onRated(index, rating), onBranch, onNotice }}
            />
          )
        })}
        {turnView !== null && <AssistantTurn view={turnView} />}
      </div>
    </div>
  )
}
