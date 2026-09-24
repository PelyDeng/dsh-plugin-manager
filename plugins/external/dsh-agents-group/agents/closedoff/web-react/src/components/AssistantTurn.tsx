/**
 * 助手回合展示（历史归档消息与活动流式轮次共用的规范化视图）。
 *
 * 两个消费方都把数据归一成 AssistantTurnView 再进来：board 里的已归档消息直接
 * 展开；活动轮次从 turn store 派生（streaming=true，带光标与进行中态）。
 * 轨迹/围栏/媒体在批 1a 只渲染「已保留」引用行——真实可视化是批 1b 的 Cesium
 * 飞地，锚点 id（co-track-<callId> / co-media-<callId>）已在占位上留好。
 */
import { RichText } from '@dsh-agents-group/web-common'
import { assistantDisplayText, finishReasonMessage } from '../lib/format.ts'
import { toolLabel } from '../lib/labels.ts'
import type { BoardTool, BoardTrack } from '../lib/restore.ts'
import type { ReactElement } from 'react'
import type { CardsPayload, FencePayload, MediaItem, TurnMeta } from '../lib/types.ts'
import { progressSummary } from '../stores/turn.ts'
import type { Rating } from './AnswerActions.tsx'
import { AnswerActions } from './AnswerActions.tsx'
import { DshIcon } from './DshIcon.tsx'
import { MediaPlayStub } from './EnclavePlaceholders.tsx'
import { ResultSections } from './ResultSections.tsx'

export interface AssistantTurnView {
  text: string
  hasStructured: boolean
  thinking: string
  thinkingDone: boolean
  tools: BoardTool[]
  cards: Record<string, CardsPayload>
  tracks: Record<string, BoardTrack>
  fences: Record<string, FencePayload>
  media: Record<string, MediaItem[]>
  streaming: boolean
  finishReason?: string | undefined
  terminalMessage?: string | undefined
  terminalTone?: '' | 'error' | 'warning' | undefined
  meta?: TurnMeta | undefined
  rating?: Rating | null | undefined
  feedbackUnavailable?: boolean | undefined
  /** 评分/分支/就地提示的回传（活动流式轮次不传——未完成没有操作区）。 */
  conversationId?: string | undefined
  onRated?: ((rating: Rating | null) => void) | undefined
  onBranch?: ((conversationId: string) => void) | undefined
  onNotice?: ((text: string) => void) | undefined
}

/** 思考预览行：进行中取最后一行，完成取第一行（旧 reasoningLine 口径）。 */
export function reasoningLine(text: string, done: boolean): string {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && line !== '正在生成…')
  if (lines.length === 0) return '正在生成…'
  return done ? (lines[0] ?? '正在生成…') : (lines[lines.length - 1] ?? '正在生成…')
}

function toolStatusText(tool: BoardTool): string {
  const suffix = tool.durMs === undefined ? '' : ` · ${(tool.durMs / 1000).toFixed(1)}s`
  switch (tool.phase) {
    case 'calling': return '调用中'
    case 'empty': return '无记录'
    case 'error': return `调用失败${suffix}`
    default: return `已完成${suffix}`
  }
}

export function AssistantTurn({ view }: { view: AssistantTurnView }): ReactElement {
  const display = assistantDisplayText(view.text, view.hasStructured).trim()
  const hasResult = view.hasStructured || display !== ''
  // 终态提示：流内显式文案优先，否则从 finishReason 派生（旧 applyFinishReason 口径）。
  const explicit = view.terminalMessage !== undefined && view.terminalMessage !== ''
  const terminal = explicit
    ? view.terminalMessage ?? ''
    : finishReasonMessage(view.finishReason, hasResult)
  const terminalTone = explicit
    ? view.terminalTone ?? ''
    : (view.finishReason === undefined || view.finishReason === '' || view.finishReason === 'completed' ? '' : 'warning')

  const trackEntries = Object.entries(view.tracks)
  const mediaEntries = Object.entries(view.media).filter(([, items]) => items.length > 0)
  const fenceCount = Object.keys(view.fences).length

  return (
    <div className="co-msg co-msg--assistant">
      <div className="co-avatar co-avatar--bot" aria-hidden="true">封</div>
      <div className="co-bubble" aria-busy={view.streaming}>
        {view.thinking !== '' && (
          <details
            className={`co-thinking${view.streaming && !view.thinkingDone ? ' co-thinking--running' : ''}`}
            open={view.streaming}
          >
            <summary className="co-thinking-summary">
              <DshIcon name="think" />
              <span className="co-thinking-title">思考</span>
              <span className="co-thinking-sep" aria-hidden="true" />
              <span className="co-thinking-preview">{reasoningLine(view.thinking, view.thinkingDone || !view.streaming)}</span>
            </summary>
            <div className="co-thinking-body">{view.thinking}</div>
          </details>
        )}

        {view.tools.length > 0 && (
          <section className="co-tool-progress" aria-label="工具调用">
            <div className="co-tool-progress-head">
              <span className="co-tool-progress-title">工具调用</span>
              <span className="co-tool-progress-summary">{progressSummary(view.tools, !view.streaming)}</span>
            </div>
            <div className="co-tool-strip">
              {view.tools.map(tool => (
                <span className={`co-tool-chip co-tool-chip--${tool.phase}`} key={tool.callId}>
                  <DshIcon name="api" className={`co-tool-icon${tool.phase === 'calling' ? ' co-tool-icon--calling' : ''}`} />
                  <span className="co-tool-label" title={toolLabel(tool.name)}>{toolLabel(tool.name)}</span>
                  <span className="co-tool-status">{toolStatusText(tool)}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        <ResultSections cards={view.cards} />

        {(trackEntries.length > 0 || fenceCount > 0 || mediaEntries.length > 0) && (
          <div className="co-enclave-refs">
            {trackEntries.map(([callId, track]) => (
              <p className="co-enclave-ref" id={`co-track-${callId}`} key={callId} data-enclave="track">
                车辆轨迹{track.vehicleNo === undefined || track.vehicleNo === '' ? '' : ` · ${track.vehicleNo}`} · {track.points.length} 个点
                （轨迹视图批 1b 接入）
              </p>
            ))}
            {fenceCount > 0 && (
              <p className="co-enclave-ref" data-enclave="fences">电子围栏 · {fenceCount} 组（围栏视图批 1b 接入）</p>
            )}
            {mediaEntries.map(([callId, items]) => (
              <div className="co-enclave-ref" id={`co-media-${callId}`} key={callId} data-enclave="media">
                <p>车辆抓拍视频 · 共 {items.length} 段</p>
                <ul>
                  {items.map((item, index) => (
                    <li key={index}>
                      <span>抓拍片段 {index + 1} · {item.startTime ?? '--'} · {item.timeLength ?? '--'}</span>
                      <MediaPlayStub label="查看抓拍视频" />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {display !== '' && (
          <>
            <h3 className="co-analysis-heading">结论与建议</h3>
            <div className="co-md">
              <RichText text={display} streaming={view.streaming} />
              {view.streaming && <span className="co-cursor" aria-hidden="true" />}
            </div>
          </>
        )}

        {terminal !== '' && (
          <p
            className={`co-turn-status${terminalTone === 'error' ? ' co-turn-status--error' : ''}`}
            role={terminalTone === 'error' ? 'alert' : 'status'}
          >
            {terminal}
          </p>
        )}

        {view.meta !== undefined && view.conversationId !== undefined && view.onRated !== undefined && view.onBranch !== undefined && (
          <AnswerActions
            meta={view.meta}
            answerText={display}
            conversationId={view.conversationId}
            rating={view.rating}
            feedbackUnavailable={view.feedbackUnavailable}
            onRated={view.onRated}
            onNotice={view.onNotice ?? (() => {})}
            onBranch={view.onBranch}
            busy={false}
          />
        )}
      </div>
    </div>
  )
}
