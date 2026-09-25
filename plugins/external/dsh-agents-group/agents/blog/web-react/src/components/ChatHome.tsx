/**
 * 对话主视图（旧 #chat-home 的组件化）：欢迎区三建议、消息流、流式 live 段、
 * 失败请求的继续入口、文章候选引用行、查看最新（chat-bottom）。
 *
 * live 段位置的数据驱动重写（旧 renderLive 的 DOM 搬运不等价复刻）：busy 时
 * chatTurns 投影会给最后的用户轮补 pending 组——live 内联进「未完成」的最后一组
 * （complete=false）；否则渲染为独立气泡（live 早于下一帧用户消息快照到达的场景，
 * 旧码注释「Never write it into a completed turn」由 complete 判定承接）。
 *
 * 批 2b 收尾：操作卡确认/取消（OperationCardRow）、评价与分支（快捷赞踩 + 更多
 * 菜单：评价备注/重新生成）、思考区接推理译文（ThinkingBlock）。
 */
import { useEffect, useRef, useState } from 'react'
import { RichText } from '@dsh-agents-group/web-common'
import { branchFromMessage, rateAnswer, send } from '../chat-controller.ts'
import { chatAttachmentUrl } from '../lib/api.ts'
import { chatTurns, isOperationCard, isTurnGroup } from '../lib/chat-turns.ts'
import { compactTokens, formatMs, safeHttpUrl, statusLabel, toolLabel, usageRows } from '../lib/labels.ts'
import { useComposerStore } from '../stores/composer.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import { useWorkspaceStore } from '../stores/workspace.ts'
import { useTurnStore } from '../stores/turn.ts'
import type { ChatHistoryResult, TurnSummary } from '../lib/types.ts'
import type { TurnGroup } from '../lib/chat-turns.ts'
import type { ReactElement } from 'react'
import { DshIcon } from './DshIcon.tsx'
import { FeedbackDialog } from './chat/FeedbackDialog.tsx'
import { OperationCardRow } from './chat/OperationCardRow.tsx'
import { ThinkingBlock } from './chat/ThinkingBlock.tsx'

/** 欢迎区三建议（旧 data-prompt 按钮）。 */
const SUGGESTIONS: Array<{ prompt: string; label: string }> = [
  { prompt: '看看我的博客最近发布了哪些文章，帮我梳理一下。', label: '看看博客近况' },
  { prompt: '我想写一篇新博客，先帮我一起确定主题和提纲。', label: '一起写篇新文章' },
  { prompt: '我想修改一篇旧文章，请先帮我查找并确认目标文章。', label: '修改已有文章' },
]

/** 快捷提问侧栏（旧 aside.chat-prompts）。 */
const QUICK_GROUPS: Array<{ title: string; items: string[] }> = [
  { title: '快捷提问 · 博客近况', items: ['按北京时间查询今天新建和修改的文章与草稿，列出标题、状态和时间。', '看看我的博客最近发布了哪些文章，帮我梳理一下。'] },
  { title: '快捷提问 · 写作与整理', items: ['我想写一篇新博客，先帮我一起确定主题和提纲。', '我想修改一篇旧文章，请先帮我查找并确认目标文章。', '帮我按分类梳理博客文章，列出文章标题。'] },
]

/** 回合组是否已完结（旧 dataset.complete：tail 标记或回合已计时）。 */
function turnComplete(group: TurnGroup, turns: readonly TurnSummary[]): boolean {
  if (group.tail === true) return true
  const turn = turns.find(item => item.turn === group.turn)
  return turn !== undefined && typeof turn.runMs === 'number' && Number.isFinite(turn.runMs)
}

function ToolChips({ group }: { group: TurnGroup }): ReactElement | null {
  if (group.tools.length === 0) return null
  return (
    <section className="blg-tools">
      {group.tools.map(node => (
        <span key={node.id} className={`blg-tool-chip blg-tool-chip--${node.status ?? 'running'}`}>
          <DshIcon name="api" size={14} />
          {toolLabel(node.name)} · {statusLabel(node.status)}
        </span>
      ))}
    </section>
  )
}

/** 回合用量/用时（旧 usage() 的 qa-meta 形态：details 就地折叠）。
 * 摘要行场景（无 assistant 消息的回合）没有 message，模型行按旧 stat 口径显示
 * 「未提供」。 */
function TurnUsage({ turn, provider, model }: { turn: TurnSummary; provider?: string | undefined; model?: string | undefined }): ReactElement {
  const usage = (turn.usage ?? null) as Record<string, unknown> | null
  return (
    <>
      <details className="blg-meta">
        <summary title={`用量 ${compactTokens(usage?.totalTokens)} tok`} aria-label={`用量 ${compactTokens(usage?.totalTokens)} tok`}>
          <DshIcon name="database" size={14} />
          <span>用量 {compactTokens(usage?.totalTokens)} tok</span>
        </summary>
        <div className="blg-meta-body">
          <strong>用量 {compactTokens(usage?.totalTokens)} tok</strong>
          <dl>
            {usageRows(turn).map(([key, value]) => <span key={key}><dt>{key}</dt><dd>{value}</dd></span>)}
          </dl>
        </div>
      </details>
      <details className="blg-meta">
        <summary title={`用时 ${formatMs(turn.runMs)}`} aria-label={`用时 ${formatMs(turn.runMs)}`}>
          <DshIcon name="clock" size={14} />
          <span>用时 {formatMs(turn.runMs)}</span>
        </summary>
        <div className="blg-meta-body">
          <strong>用时 {formatMs(turn.runMs)}</strong>
          <dl>
            <span><dt>总用时</dt><dd>{formatMs(turn.runMs)}</dd></span>
            <span><dt>首 Token 等待</dt><dd>{formatMs(turn.ttftMs)}</dd></span>
            <span><dt>输出速度</dt><dd>{typeof turn.tokensPerSecond === 'number' && Number.isFinite(turn.tokensPerSecond) ? `${turn.tokensPerSecond.toFixed(1)} Token/秒` : '未提供'}</dd></span>
            <span><dt>模型尝试</dt><dd>{String(turn.attempts)}</dd></span>
            <span><dt>模型</dt><dd>{model !== undefined ? `${provider ?? ''} / ${model}` : '未提供'}</dd></span>
          </dl>
        </div>
      </details>
    </>
  )
}

/** 回答操作区（旧 chat.js actions 段）：复制、赞/踩、分支、更多菜单、中断标记、
 * 用量/用时、时间。feedbackReady 之前赞踩禁用（旧 b.disabled=!state.feedbackReady）。
 * 更多菜单的开合由父级统一持有（旧 toggle 互斥 + Escape/点外关闭同款语义）。 */
function AssistantTurn({ group, conversationId, feedbackReady, onNotice, onOpenFeedback, menuOpen, onMenuToggle }: {
  group: TurnGroup
  conversationId: string
  feedbackReady: boolean
  onNotice: (text: string) => void
  onOpenFeedback: (messageId: string) => void
  menuOpen: boolean
  onMenuToggle: (open: boolean) => void
}): ReactElement {
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const feedback = useConversationStore(state => state.feedback)
  const history = useConversationStore(state => state.history)
  const current = feedback.get(group.id)
  const turn = history?.turns.find(item => item.turn === group.turn)
  const complete = turnComplete(group, history?.turns ?? [])
  const hasMessage = typeof group.id === 'string' && group.id !== '' && !group.id.startsWith('pending-')

  const rate = (rating: 'positive' | 'negative'): void => {
    if (!hasMessage || pending || !feedbackReady) return
    setPending(true)
    Promise.resolve(rateAnswer(group.id, rating))
      .catch((issue: unknown) => onNotice(issue instanceof Error ? issue.message : String(issue)))
      .finally(() => setPending(false))
  }

  const branch = (regenerate: boolean): void => {
    if (!hasMessage || pending) return
    setPending(true)
    Promise.resolve(branchFromMessage(group.id, group.seq ?? 0, regenerate))
      .catch((issue: unknown) => onNotice(issue instanceof Error ? issue.message : String(issue)))
      .finally(() => setPending(false))
  }

  const copy = (): void => {
    void navigator.clipboard.writeText(group.text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }).catch((issue: unknown) => onNotice(issue instanceof Error ? issue.message : String(issue)))
  }

  return (
    <section className={`blg-message blg-message--assistant${complete ? '' : ' blg-message--open'}`} data-message={group.id}>
      <span className="blg-avatar" aria-hidden="true"><DshIcon name="chat" size={14} /></span>
      <div className="blg-bubble">
        {group.reasoning !== '' && (
          <ThinkingBlock
            text={group.reasoning}
            running={false}
            conversationId={conversationId}
            sourceId={group.reasoningSource}
            done
          />
        )}
        <ToolChips group={group} />
        {group.statuses.length > 0 && <p className="blg-stream-status">{group.statuses.at(-1)}</p>}
        {group.steps !== undefined && group.steps.length > 1 && (
          <details className="blg-step-history">
            <summary>本轮过程（{group.steps.length} 个模型步骤）</summary>
            {group.steps.slice(0, -1).map(step => (
              <section key={step.id}>
                {step.reasoning !== undefined && step.reasoning !== '' && step.id !== group.reasoningSource && (
                  <ThinkingBlock text={step.reasoning} running={false} conversationId={conversationId} sourceId={step.id} done />
                )}
                {step.text !== undefined && step.text !== '' && <RichText text={step.text} links codeCopy />}
              </section>
            ))}
          </details>
        )}
        <div className="blg-answer">
          <RichText text={group.text} links codeCopy />
        </div>
        {group.attachments !== undefined && group.attachments.length > 0 && (
          <div className="blg-message-attachments">
            {group.attachments.map(file => (
              <a
                key={file.id}
                className="blg-file-link"
                href={chatAttachmentUrl(conversationId, group.id, file.id)}
              >
                <DshIcon name="paperclip" size={12} />
                {file.name ?? file.id}{file.range !== undefined && file.range !== null ? `（${file.range.from}–${file.range.to}）` : ''}
              </a>
            ))}
          </div>
        )}
        <div className="blg-actions">
          <button
            type="button"
            className="blg-action"
            aria-label={copied ? '已复制回答' : '复制回答'}
            title={copied ? '已复制' : '复制回答'}
            onClick={copy}
          >
            <DshIcon name={copied ? 'check' : 'copy'} size={14} />
          </button>
          {group.feedback === true && hasMessage && (
            <>
              <button
                type="button"
                className="blg-action"
                aria-pressed={current?.rating === 'positive'}
                aria-label="有帮助"
                title="有帮助"
                disabled={!feedbackReady || pending}
                onClick={() => rate('positive')}
              >
                <DshIcon name="like" size={14} />
              </button>
              <button
                type="button"
                className="blg-action"
                aria-pressed={current?.rating === 'negative'}
                aria-label="有待改进"
                title="有待改进"
                disabled={!feedbackReady || pending}
                onClick={() => rate('negative')}
              >
                <DshIcon name="dislike" size={14} />
              </button>
            </>
          )}
          {group.forkCut !== undefined && group.forkCut !== null && hasMessage && (
            <button type="button" className="blg-action" aria-label="在新对话中继续" title="在新对话中继续" disabled={pending} onClick={() => branch(false)}>
              <DshIcon name="branch" size={14} />
            </button>
          )}
          {(group.feedback === true || (group.forkCut !== undefined && group.forkCut !== null)) && hasMessage && (
            <details className="blg-more" open={menuOpen} onToggle={event => { if ((event.target as HTMLDetailsElement).open !== menuOpen) onMenuToggle((event.target as HTMLDetailsElement).open) }}>
              <summary className="blg-action" aria-label="更多回答操作" title="更多回答操作">
                <DshIcon name="more" size={14} />
              </summary>
              <div className="blg-more-menu">
                {group.feedback === true && (
                  <button
                    type="button"
                    disabled={!feedbackReady}
                    onClick={() => { onMenuToggle(false); onOpenFeedback(group.id) }}
                  >
                    评价备注
                  </button>
                )}
                {group.forkCut !== undefined && group.forkCut !== null && (
                  <button
                    type="button"
                    title="保留原回答与文章，在新分支重新生成"
                    disabled={pending}
                    onClick={() => { onMenuToggle(false); branch(true) }}
                  >
                    重新生成
                  </button>
                )}
              </div>
            </details>
          )}
          {group.interrupted === true && <small className="blg-muted">本段回答已中断</small>}
          {turn !== undefined && typeof turn.runMs === 'number' && Number.isFinite(turn.runMs) && <TurnUsage turn={turn} provider={group.provider} model={group.model} />}
          {typeof group.time === 'number' && group.time > 0 && (
            <time className="blg-clock">{new Date(group.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
          )}
        </div>
      </div>
    </section>
  )
}

/** 流式 live 段（内联形态：挂在最后一组未完成回合的气泡里）。 */
function LiveInline({ conversationId }: { conversationId: string }): ReactElement | null {
  const live = useTurnStore(state => state.live)
  const stopping = useComposerStore(state => state.stopping)
  if (live === null) return null
  const status = stopping ? '正在停止，保留已生成内容…' : live.text !== '' ? '正在回答…' : live.reasoning !== '' ? '正在思考…' : '正在连接模型…'
  return (
    <>
      {live.reasoning !== '' && (
        <ThinkingBlock
          text={live.reasoning}
          running={live.text === ''}
          defaultOpen
          conversationId={conversationId}
          done={live.text !== ''}
        />
      )}
      <div className="blg-answer blg-answer--streaming">
        <RichText text={live.text} streaming links codeCopy />
      </div>
      <small className="blg-stream-status" role="status">{status}</small>
    </>
  )
}

/** 独立 live 气泡（下一帧用户快照尚未落地时）。 */
function LiveBubble({ conversationId }: { conversationId: string }): ReactElement | null {
  const live = useTurnStore(state => state.live)
  const stopping = useComposerStore(state => state.stopping)
  if (live === null) return null
  const status = stopping ? '正在停止，保留已生成内容…' : live.text !== '' ? '正在回答…' : live.reasoning !== '' ? '正在思考…' : '正在连接模型…'
  return (
    <section className="blg-message blg-message--assistant blg-message--streaming">
      <span className="blg-avatar" aria-hidden="true"><DshIcon name="chat" size={14} /></span>
      <div className="blg-bubble">
        {live.reasoning !== '' && (
          <ThinkingBlock
            text={live.reasoning}
            running={live.text === ''}
            defaultOpen
            conversationId={conversationId}
            done={live.text !== ''}
          />
        )}
        <div className="blg-answer blg-answer--streaming">
          <RichText text={live.text} streaming links codeCopy />
        </div>
        <small className="blg-stream-status" role="status">{status}</small>
      </div>
    </section>
  )
}

export function ChatHome(): ReactElement {
  const history = useConversationStore(state => state.history)
  const live = useTurnStore(state => state.live)
  const feedbackReady = useConversationStore(state => state.feedbackReady)
  const setDraft = useComposerStore(state => state.setDraft)
  const setNoticeState = useSessionStore(state => state.setNotice)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [feedbackTarget, setFeedbackTarget] = useState<string | null>(null)
  // 当前打开的「更多回答操作」菜单（displayKey；null=全部关闭）。旧 chat.js 用
  // toggle 捕获互斥（打开一个关其他）+ document click 点外关闭 + Escape 关闭并
  // 回焦 summary——单值 state 天然互斥，轻 dismissal 收敛在下方 effect。
  const [activeMenu, setActiveMenu] = useState<string | null>(null)

  const conversationId = useConversationStore(state => state.conversationId)
  const messages = history?.messages ?? []
  const busy = history?.busy === true
  const display = chatTurns(messages, { busy, operations: history?.operations ?? [], requests: history?.requests ?? [] })

  // 回合用量摘要行（旧 chat.js:195）：已计时但**没有** assistant 消息的回合，
  // 用量行插到该回合的用户消息之后（旧 findLast(seq<startSeq) 的 user 位置）。
  const summarizedTurns = (history?.turns ?? []).filter(turn =>
    typeof turn.runMs === 'number' && Number.isFinite(turn.runMs) &&
    !display.some(node => isTurnGroup(node) && String(node.turn ?? '') === String(turn.turn)))
  const summaryAfterUser = new Map<string, TurnSummary>()
  for (const turn of summarizedTurns) {
    const user = [...messages].reverse().find(m => m.role === 'user' && m.seq < turn.startSeq)
    if (user !== undefined && !summaryAfterUser.has(user.id)) summaryAfterUser.set(user.id, turn)
  }

  // live 内联判定：最后一组回合未完结 → 内联；否则独立气泡（数据驱动，替代旧
  // renderLive 的 DOM 探测）。
  const lastGroup = [...display].reverse().find(isTurnGroup)
  const liveInline = live !== null && busy && lastGroup !== undefined && !turnComplete(lastGroup, history?.turns ?? [])

  const onNotice = (text: string): void => setNoticeState({ text, tone: 'error' })

  // 切会话时关闭在开的评价弹窗与「更多」菜单（A5；旧码面板随 activate 整体重建，
  // React 的弹窗常驻组件需要显式收口）。
  useEffect(() => {
    setFeedbackTarget(null)
    setActiveMenu(null)
  }, [conversationId])

  // 近底部跟随（旧 nearBottom/bottom：阈值 90px；滚动即时无动画）。
  const measure = (): void => {
    const box = scrollRef.current
    if (box === null) return
    followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 90
    setAwayFromBottom(!followRef.current)
  }
  useEffect(() => {
    const box = scrollRef.current
    if (box === null || !followRef.current) return
    box.scrollTo({ top: box.scrollHeight, behavior: 'instant' as ScrollBehavior })
  }, [history, live])
  useEffect(() => {
    const box = scrollRef.current
    if (box === null) return undefined
    box.addEventListener('scroll', measure, { passive: true })
    return () => box.removeEventListener('scroll', measure)
  }, [])

  // 切回对话视图聚焦输入框（旧 view() 的 focusInput：非 touch 才聚焦）。
  useEffect(() => {
    if (window.matchMedia('(pointer: coarse), (max-width: 760px)').matches) return
    document.getElementById('blg-chat-input')?.focus({ preventScroll: true })
  }, [])

  // 消息菜单的轻 dismissal（旧 chat.js:340-341）：点击菜单外关闭；Escape 关闭
  // 并把焦点交回该菜单的 summary（读屏回焦点，preventScroll 同旧码）。
  useEffect(() => {
    if (activeMenu === null) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('.blg-more') !== null) return
      setActiveMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setActiveMenu(previous => {
        if (previous === null) return previous
        const summary = document.querySelector<HTMLElement>(`[data-message="${CSS.escape(previous)}"] .blg-more > summary`)
        summary?.focus({ preventScroll: true })
        event.preventDefault()
        return null
      })
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [activeMenu !== null])

  const sendPrompt = (prompt: string): void => {
    setDraft(prompt)
    if (!window.matchMedia('(pointer: coarse), (max-width: 760px)').matches) {
      document.getElementById('blg-chat-input')?.focus({ preventScroll: true })
    }
  }

  const hasContent = messages.length > 0 || live !== null

  return (
    <main className="blg-chat-home" aria-label="博客 AI 对话">
      <section className="blg-chat-main">
        <div className="blg-chat-scroll" ref={scrollRef}>
          {!hasContent && (
            <div className="blg-welcome">
              <span className="blg-welcome-symbol"><DshIcon name="chat" size={22} /></span>
              <h2>把想法，写成文章。</h2>
              <p>聊聊博客近况，或一起完成下一篇。</p>
              <div className="blg-suggestions">
                {SUGGESTIONS.map(item => (
                  <button key={item.label} type="button" onClick={() => sendPrompt(item.prompt)}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="blg-messages" aria-label="对话消息">
            {display.map(node => {
              if (isOperationCard(node)) {
                return (
                  <OperationCardRow
                    key={`op-${node.id}`}
                    operation={node.operation}
                    unassociated={node.unassociated === true}
                    onNotice={onNotice}
                  />
                )
              }
              if (isTurnGroup(node)) {
                return (
                  <div key={node.displayKey} className="blg-turn">
                    <AssistantTurn
                      group={node}
                      conversationId={conversationId}
                      feedbackReady={feedbackReady}
                      onNotice={onNotice}
                      onOpenFeedback={setFeedbackTarget}
                      menuOpen={activeMenu === node.displayKey}
                      onMenuToggle={open => setActiveMenu(open ? node.displayKey : null)}
                    />
                    {liveInline && node === lastGroup && <LiveInline conversationId={conversationId} />}
                  </div>
                )
              }
              if (node.role === 'user') {
                const summaryTurn = summaryAfterUser.get(node.id)
                return (
                  <>
                    <section key={node.id} className="blg-message blg-message--user" data-message={node.id}>
                      <span className="blg-avatar blg-avatar--user" aria-hidden="true"><DshIcon name="user" size={14} /></span>
                      <div className="blg-bubble">
                        <div className="blg-user-text">{node.text}</div>
                        {node.attachments !== undefined && node.attachments.length > 0 && (
                          <div className="blg-message-attachments">
                            {node.attachments.map(file => (
                              <a
                                key={file.id}
                                className="blg-file-link"
                                href={chatAttachmentUrl(conversationId, node.requestId ?? node.id, file.id)}
                              >
                                <DshIcon name="paperclip" size={12} />
                                {file.name ?? file.id}{file.range !== undefined && file.range !== null ? `（${file.range.from}–${file.range.to}）` : ''}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                    {/* 回合用量摘要行（A4）：该回合无 assistant 消息时用量插在用户消息后。 */}
                    {summaryTurn !== undefined && (
                      <div className="blg-turn-summary blg-actions" data-turn-summary={String(summaryTurn.turn)}>
                        <TurnUsage turn={summaryTurn} />
                      </div>
                    )}
                  </>
                )
              }
              // 其余原始消息形态（status/工具散行）以弱化行呈现。
              return (
                <div key={node.id} className="blg-message blg-message--raw">
                  <small className="blg-muted">{node.text ?? toolLabel(node.name)}</small>
                </div>
              )
            })}
            {live !== null && !liveInline && <LiveBubble conversationId={conversationId} />}
          </div>

          {(history?.requests ?? []).map(request => {
            const failed = request.status === 'failed' || request.status === 'interrupted'
            return (
              <div key={request.id} className="blg-request">
                {failed && (
                  <div className="blg-request-row" role="status">
                    <span>{request.message ?? '本轮未完成'}</span>
                    <button
                      type="button"
                      className="btn btn--tiny"
                      onClick={() => {
                        void send('请基于前面的资料继续完成上一轮未完成的请求。', request.id)
                          .catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
                      }}
                    >
                      继续本次请求
                    </button>
                  </div>
                )}
                {(request.sources?.length ?? 0) > 0 && (
                  <details className="blg-sources">
                    <summary>查证来源（{request.sources?.length ?? 0}）</summary>
                    {request.sources?.map((source, index) => {
                      const href = safeHttpUrl(source.url)
                      return (
                        <div key={`${request.id}-${index}`} className="blg-source-row">
                          {href !== null
                            ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title ?? source.url}</a>
                            : <span>{source.title ?? source.url}</span>}
                          <small>{source.fetched === true ? ' · 已读取原文' : ' · 搜索摘要'}</small>
                        </div>
                      )
                    })}
                  </details>
                )}
              </div>
            )
          })}

          {(history?.results ?? []).map(card => (
            <ArticleResultCard key={card.id} card={card} />
          ))}
        </div>

        {!awayFromBottom ? null : (
          <button
            type="button"
            className="blg-chat-bottom"
            onClick={() => {
              const box = scrollRef.current
              if (box !== null) box.scrollTo({ top: box.scrollHeight, behavior: 'instant' as ScrollBehavior })
              followRef.current = true
              setAwayFromBottom(false)
            }}
          >
            查看最新回答 ↓
          </button>
        )}
      </section>

      <aside className="blg-prompts" aria-label="快捷提问">
        {QUICK_GROUPS.map(group => (
          <div key={group.title}>
            <h2>{group.title}</h2>
            {group.items.map(item => (
              <button key={item} type="button" onClick={() => sendPrompt(item)}>{item}</button>
            ))}
          </div>
        ))}
        <h2>提问建议</h2>
        <p>带上标题、关键词、分类或时间范围，查找会更准确。</p>
        <p>添加资料后，可结合原文写作。公开发布前可预览确认。</p>
      </aside>

      <FeedbackDialog target={feedbackTarget === null ? null : { messageId: feedbackTarget }} onClose={() => setFeedbackTarget(null)} />
    </main>
  )
}

/**
 * 文章候选引用卡（旧 chat.js results 段）：打开文章 → workspace 视图打开该草稿
 * 并进入候选稿对照（openDraft(id,{proposal}) → view(false) 的组合经 pendingOpen
 * 待办位转交 WorkspaceView）。
 */
function ArticleResultCard({ card }: { card: NonNullable<ChatHistoryResult['results']>[number] }): ReactElement {
  const setPendingOpen = useWorkspaceStore(state => state.setPendingOpen)
  const setView = useSessionStore(state => state.setView)
  return (
    <section className="blg-result-ref">
      <div className="blg-result-head">
        <strong>{card.proposal?.fields.title ?? card.title ?? '文章候选稿'}</strong>
        <button
          type="button"
          className="btn btn--tiny"
          onClick={() => {
            setPendingOpen({ draftId: card.draftId, proposal: card.proposal ?? null })
            setView('writing')
          }}
        >
          打开文章
        </button>
      </div>
      <details>
        <summary>候选快照 · 基于版本 {card.revision}</summary>
        <RichText text={card.proposal?.fields.text ?? ''} links codeCopy />
        <small className="blg-muted">历史候选快照，当前文章状态以编辑器为准</small>
      </details>
    </section>
  )
}
