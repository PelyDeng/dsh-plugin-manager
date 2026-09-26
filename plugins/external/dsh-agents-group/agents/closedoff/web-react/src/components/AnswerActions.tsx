/**
 * 回答操作区（旧 assistant-actions 段的 React 等价）：复制、赞/踩、从该回合
 * 创建新对话、用量/用时详情（details 折叠=新弹层基线）、完成时间。
 *
 * 图标保留 DSH 官方 outline 形制；反馈与分支直接走 api（失败就地提示，
 * 旧 actionMessage 同语义——提示文案短暂显示后消失）。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { compactDuration, compactTokens, exactTokens, fmtClock, summaryDuration } from '../lib/format.ts'
import { legacyCopy } from '../lib/legacy-copy.ts'
import type { ReactElement } from 'react'
import type { TurnMeta } from '../lib/types.ts'
import { DshIcon } from './DshIcon.tsx'
import { errorTextOf } from '@dsh-agents-group/web-common'

export type Rating = 'positive' | 'negative'

export interface AnswerActionsProps {
  meta: TurnMeta
  /** 回答正文（复制用；空串时隐藏复制按钮——旧码 copyAction.hidden 口径）。 */
  answerText: string
  conversationId: string
  rating?: Rating | null | undefined
  feedbackUnavailable?: boolean | undefined
  /** 评分落定后的回传（归档消息 patch）。 */
  onRated: (rating: Rating | null) => void
  onNotice: (text: string, error?: boolean) => void
  /** 分支创建成功后打开新会话。 */
  onBranch: (conversationId: string) => void
  /** 分支需要会话处于空闲态。 */
  busy: boolean
}

export function AnswerActions({ meta, answerText, conversationId, rating, feedbackUnavailable, onRated, onNotice, onBranch, busy }: AnswerActionsProps): ReactElement {
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  const hasMessage = typeof meta.messageId === 'string' && meta.messageId !== ''
  const blocked = feedbackUnavailable === true && hasMessage
  const usage = meta.usage
  const hasRunTime = typeof meta.runMs === 'number'
  const completedAt = Number(meta.completedAt)

  const copy = (): void => {
    const text = answerText.trim()
    if (text === '') return
    // 旧 app.js writeClipboard 同款：非安全上下文（HTTP 内网部署）下 navigator.clipboard
    // 不存在，回退 textarea + execCommand('copy')。
    const write = navigator.clipboard?.writeText !== undefined
      ? navigator.clipboard.writeText(text)
      : Promise.resolve(legacyCopy(text)).then(ok => { if (!ok) throw new Error('复制失败') })
    write.then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    }).catch((error: unknown) => {
      onNotice(errorTextOf(error, '复制失败'), true)
    })
  }

  const rate = (value: Rating): void => {
    if (!hasMessage || pending) return
    setPending(true)
    api.feedback(conversationId, meta.messageId ?? '', value)
      .then(result => onRated(result.rating))
      .catch((error: unknown) => onNotice(errorTextOf(error, '反馈失败'), true))
      .finally(() => setPending(false))
  }

  const branch = (): void => {
    if (busy || typeof meta.branchSeq !== 'number') return
    setPending(true)
    api.branch(conversationId, meta.branchSeq)
      .then(result => onBranch(result.conversationId))
      .catch((error: unknown) => onNotice(errorTextOf(error, '创建分支失败'), true))
      .finally(() => setPending(false))
  }

  const usageRows: Array<[string, string]> = usage === undefined
    ? []
    : [
      ['未缓存输入', exactTokens(usage.inputTokens)],
      ...(usage.cacheReadTokens === undefined ? [] : [['缓存读取', exactTokens(usage.cacheReadTokens)] as [string, string]]),
      ['输出', exactTokens(usage.outputTokens)],
      ...(usage.cacheWriteTokens === undefined ? [] : [['缓存写入', exactTokens(usage.cacheWriteTokens)] as [string, string]]),
      ['总计', exactTokens(usage.totalTokens)],
      ...(usage.reasoningTokens === undefined ? [] : [['其中推理', exactTokens(usage.reasoningTokens)] as [string, string]]),
    ]

  return (
    <div className="co-actions">
      {answerText.trim() !== '' && (
        <button type="button" className="co-action" onClick={copy} title={copied ? '已复制' : '复制回答'} aria-label={copied ? '已复制' : '复制回答'}>
          <DshIcon name={copied ? 'check' : 'copy'} />
        </button>
      )}
      {hasMessage && (
        <>
          <button
            type="button"
            className={`co-action${rating === 'positive' ? ' co-action--active' : ''}`}
            onClick={() => rate('positive')}
            disabled={pending || blocked}
            aria-pressed={rating === 'positive'}
            title={blocked ? '评价状态暂时无法恢复' : '好回答'}
            aria-label={blocked ? '好回答，评价状态暂时无法恢复' : '好回答'}
          >
            <DshIcon name="like" />
          </button>
          <button
            type="button"
            className={`co-action${rating === 'negative' ? ' co-action--active' : ''}`}
            onClick={() => rate('negative')}
            disabled={pending || blocked}
            aria-pressed={rating === 'negative'}
            title={blocked ? '评价状态暂时无法恢复' : '差回答'}
            aria-label={blocked ? '差回答，评价状态暂时无法恢复' : '差回答'}
          >
            <DshIcon name="dislike" />
          </button>
        </>
      )}
      {typeof meta.branchSeq === 'number' && (
        <button type="button" className="co-action" onClick={branch} disabled={busy || pending} title="从这里创建新对话" aria-label="从这里创建新对话">
          <DshIcon name="branch" />
        </button>
      )}
      {usage !== undefined && (
        <details className="co-stat">
          <summary className="co-stat-summary" title="查看本轮用量" aria-label="查看本轮用量">
            <DshIcon name="database" />
            <span className="co-stat-label">用量 {compactTokens(usage.totalTokens)}</span>
          </summary>
          <dl className="co-stat-detail">
            {usageRows.map(([k, v]) => (<FragmentRow key={k} k={k} v={v} />))}
          </dl>
        </details>
      )}
      {hasRunTime && (
        <details className="co-stat">
          <summary className="co-stat-summary" title="查看本轮用时" aria-label="查看本轮用时">
            <DshIcon name="clock" />
            <span className="co-stat-label">用时 {summaryDuration(meta.runMs)}</span>
          </summary>
          <dl className="co-stat-detail">
            <dt>总用时</dt>
            <dd>{compactDuration(meta.runMs)}</dd>
            {typeof meta.ttftMs === 'number' && <><dt>首字延迟</dt><dd>{compactDuration(meta.ttftMs)}</dd></>}
          </dl>
        </details>
      )}
      {Number.isFinite(completedAt) && (
        <time className="co-action-clock" dateTime={new Date(completedAt).toISOString()} title={new Date(completedAt).toLocaleString('zh-CN')}>
          {fmtClock(completedAt).slice(0, 5)}
        </time>
      )}
    </div>
  )
}

function FragmentRow({ k, v }: { k: string; v: string }): ReactElement {
  return (
    <div className="co-stat-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}
