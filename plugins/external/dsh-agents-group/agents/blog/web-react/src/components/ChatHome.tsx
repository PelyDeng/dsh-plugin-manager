/**
 * 对话主视图（旧 #chat-home 的组件化）：欢迎区三建议、消息流、流式 live 段、
 * 失败请求的继续入口、文章候选引用行、查看最新（chat-bottom）。
 *
 * live 段位置的数据驱动重写（旧 renderLive 的 DOM 搬运不等价复刻）：busy 时
 * chatTurns 投影会给最后的用户轮补 pending 组——live 内联进「未完成」的最后一组
 * （complete=false）；否则渲染为独立气泡（live 早于下一帧用户消息快照到达的场景，
 * 旧码注释「Never write it into a completed turn」由 complete 判定承接）。
 */
import { useEffect, useRef, useState } from 'react'
import { RichText } from '@dsh-agents-group/web-common'
import { chatAttachmentUrl } from '../lib/api.ts'
import { chatTurns, isOperationCard, isTurnGroup } from '../lib/chat-turns.ts'
import { compactTokens, formatMs, safeHttpUrl, statusLabel, toolLabel, usageRows } from '../lib/labels.ts'
import { send } from '../chat-controller.ts'
import { useComposerStore } from '../stores/composer.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import { useTurnStore } from '../stores/turn.ts'
import type { ChatHistoryResult, TurnSummary } from '../lib/types.ts'
import type { TurnGroup } from '../lib/chat-turns.ts'
import type { ReactElement } from 'react'
import { DshIcon } from './DshIcon.tsx'

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

/** 思考预览行（旧 chat-ui.js reasoningLine：最后一行非空占位）。 */
function reasoningLine(text: string | undefined): string {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && line !== '正在生成…')
  return lines.at(-1) ?? '正在生成…'
}

function ThinkingBlock({ text, running, defaultOpen = false }: { text: string; running: boolean; defaultOpen?: boolean }): ReactElement {
  return (
    <details className={`blg-thinking${running ? ' blg-thinking--running' : ''}`} open={defaultOpen}>
      <summary>
        <DshIcon name="think" size={14} />
        <span className="blg-thinking-title">思考</span>
        <span className="blg-thinking-preview">{reasoningLine(text)}</span>
      </summary>
      <div className="blg-thinking-body">{text}</div>
    </details>
  )
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

/** 回合用量/用时（旧 usage() 的 qa-meta 形态：details 就地折叠）。 */
function TurnUsage({ turn, group }: { turn: TurnSummary; group: TurnGroup }): ReactElement {
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
            <span><dt>模型</dt><dd>{group.model !== undefined ? `${group.provider ?? ''} / ${group.model}` : '未提供'}</dd></span>
          </dl>
        </div>
      </details>
    </>
  )
}

function AssistantTurn({ group, onNotice }: { group: TurnGroup; onNotice: (text: string) => void }): ReactElement {
  const [copied, setCopied] = useState(false)
  const history = useConversationStore(state => state.history)
  const turn = history?.turns.find(item => item.turn === group.turn)
  const complete = turnComplete(group, history?.turns ?? [])
  return (
    <section className={`blg-message blg-message--assistant${complete ? '' : ' blg-message--open'}`} data-message={group.id}>
      <span className="blg-avatar" aria-hidden="true"><DshIcon name="chat" size={14} /></span>
      <div className="blg-bubble">
        {group.reasoning !== '' && <ThinkingBlock text={group.reasoning} running={false} />}
        <ToolChips group={group} />
        {group.statuses.length > 0 && <p className="blg-stream-status">{group.statuses.at(-1)}</p>}
        {group.steps !== undefined && group.steps.length > 1 && (
          <details className="blg-step-history">
            <summary>本轮过程（{group.steps.length} 个模型步骤）</summary>
            {group.steps.slice(0, -1).map(step => (
              <section key={step.id}>
                {step.reasoning !== undefined && step.reasoning !== '' && step.id !== group.reasoningSource && (
                  <ThinkingBlock text={step.reasoning} running={false} />
                )}
                {step.text !== undefined && step.text !== '' && <RichText text={step.text} />}
              </section>
            ))}
          </details>
        )}
        <div className="blg-answer">
          <RichText text={group.text} />
        </div>
        {group.attachments !== undefined && group.attachments.length > 0 && (
          <div className="blg-message-attachments">
            {group.attachments.map(file => (
              <a
                key={file.id}
                className="blg-file-link"
                href={chatAttachmentUrl(useConversationStore.getState().conversationId, group.id, file.id)}
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
            onClick={() => {
              void navigator.clipboard.writeText(group.text).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              }).catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
            }}
          >
            <DshIcon name="copy" size={14} />
          </button>
          {group.interrupted === true && <small className="blg-muted">本段回答已中断</small>}
          {turn !== undefined && typeof turn.runMs === 'number' && Number.isFinite(turn.runMs) && <TurnUsage turn={turn} group={group} />}
          {typeof group.time === 'number' && group.time > 0 && (
            <time className="blg-clock">{new Date(group.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
          )}
        </div>
      </div>
    </section>
  )
}

/** 流式 live 段（内联形态：挂在最后一组未完成回合的气泡里）。 */
function LiveInline(): ReactElement | null {
  const live = useTurnStore(state => state.live)
  const stopping = useComposerStore(state => state.stopping)
  if (live === null) return null
  const status = stopping ? '正在停止，保留已生成内容…' : live.text !== '' ? '正在回答…' : live.reasoning !== '' ? '正在思考…' : '正在连接模型…'
  return (
    <>
      {live.reasoning !== '' && <ThinkingBlock text={live.reasoning} running={live.text === ''} defaultOpen />}
      <div className="blg-answer blg-answer--streaming">
        <RichText text={live.text} streaming />
      </div>
      <small className="blg-stream-status" role="status">{status}</small>
    </>
  )
}

/** 独立 live 气泡（下一帧用户快照尚未落地时）。 */
function LiveBubble(): ReactElement | null {
  const live = useTurnStore(state => state.live)
  const stopping = useComposerStore(state => state.stopping)
  if (live === null) return null
  const status = stopping ? '正在停止，保留已生成内容…' : live.text !== '' ? '正在回答…' : live.reasoning !== '' ? '正在思考…' : '正在连接模型…'
  return (
    <section className="blg-message blg-message--assistant blg-message--streaming">
      <span className="blg-avatar" aria-hidden="true"><DshIcon name="chat" size={14} /></span>
      <div className="blg-bubble">
        {live.reasoning !== '' && <ThinkingBlock text={live.reasoning} running={live.text === ''} defaultOpen />}
        <div className="blg-answer blg-answer--streaming">
          <RichText text={live.text} streaming />
        </div>
        <small className="blg-stream-status" role="status">{status}</small>
      </div>
    </section>
  )
}

export function ChatHome(): ReactElement {
  const history = useConversationStore(state => state.history)
  const live = useTurnStore(state => state.live)
  const setDraft = useComposerStore(state => state.setDraft)
  const setNotice = useSessionStore(state => state.setNotice)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const [awayFromBottom, setAwayFromBottom] = useState(false)

  const messages = history?.messages ?? []
  const busy = history?.busy === true
  const display = chatTurns(messages, { busy, operations: history?.operations ?? [], requests: history?.requests ?? [] })

  // live 内联判定：最后一组回合未完结 → 内联；否则独立气泡（数据驱动，替代旧
  // renderLive 的 DOM 探测）。
  const lastGroup = [...display].reverse().find(isTurnGroup)
  const liveInline = live !== null && busy && lastGroup !== undefined && !turnComplete(lastGroup, history?.turns ?? [])

  const onNotice = (text: string): void => setNotice({ text, tone: 'error' })

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
                // 管理操作卡的确认/取消交互在批 2b 迁移：占位行保持可见（等价于
                // 旧码「确认已失效」形态的信息面，不冒充可交互）。
                return (
                  <section key={`op-${node.id}`} className="blg-message blg-operation" data-operation={node.id}>
                    <div className="blg-bubble">
                      <strong>{node.operation.mode === 'manage' ? '博客管理' : node.operation.mode === 'delete' ? '删除文章' : '发布草稿'} · {node.operation.title}</strong>
                      <p className="blg-muted">
                        {node.unassociated === true ? '历史操作（原轮次暂不可用）。' : ''}
                        操作确认面板在批 2b 迁移；当前状态：{node.operation.status}。
                      </p>
                    </div>
                  </section>
                )
              }
              if (isTurnGroup(node)) {
                return (
                  <div key={node.displayKey} className="blg-turn">
                    <AssistantTurn group={node} onNotice={onNotice} />
                    {liveInline && node === lastGroup && <LiveInline />}
                  </div>
                )
              }
              if (node.role === 'user') {
                return (
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
                              href={chatAttachmentUrl(useConversationStore.getState().conversationId, node.requestId ?? node.id, file.id)}
                            >
                              <DshIcon name="paperclip" size={12} />
                              {file.name ?? file.id}{file.range !== undefined && file.range !== null ? `（${file.range.from}–${file.range.to}）` : ''}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                )
              }
              // 其余原始消息形态（status/工具散行）以弱化行呈现。
              return (
                <div key={node.id} className="blg-message blg-message--raw">
                  <small className="blg-muted">{node.text ?? toolLabel(node.name)}</small>
                </div>
              )
            })}
            {live !== null && !liveInline && <LiveBubble />}
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
            <section key={card.id} className="blg-result-ref">
              <div className="blg-result-head">
                <strong>{card.proposal?.fields.title ?? card.title ?? '文章候选稿'}</strong>
                <button type="button" className="btn btn--tiny" onClick={() => onNotice('文章视图在批 2b 迁移，候选稿请稍后查看')}>
                  打开文章
                </button>
              </div>
              <small className="blg-muted">候选快照 · 基于版本 {card.revision}（批 2b 接入编辑器预览）</small>
            </section>
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
    </main>
  )
}
