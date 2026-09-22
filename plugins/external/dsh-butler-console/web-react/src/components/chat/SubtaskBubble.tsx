/**
 * 子任务气泡主体（评审 #13：entries 消息流卡与 DispatchCard 结果区两处近复制收拢）。
 * 差异通过 props 表达：resultOnly=调度卡「只看结论」模式（藏思考/工具行）；
 * goal=历史恢复卡的目标行；pendingMeta=external_pending 的结构化说明。
 */
import { STREAM_RICH_LIMIT } from '../../lib/config.ts'
import { ThinkBlock } from '../common/basics.tsx'
import { RichText } from './RichText.tsx'

export interface SubtaskBubbleProps {
  state: string
  body: string
  thinking?: string | undefined
  toolLine?: { tool?: string | undefined; detail?: string | undefined } | null | undefined
  live?: boolean | undefined
  terminal?: boolean | undefined
  /** 调度卡「只看结论」模式：藏思考与工具行。 */
  resultOnly?: boolean | undefined
  /** 历史恢复卡的目标行（实时卡的目标在调度卡里，不重复显示）。 */
  goal?: string | undefined
  /** external_pending 的结构化说明（在等谁做什么/办完能做什么）。 */
  pending?: { reason: string; next?: string } | undefined
}

export function SubtaskBubble({ state, body, thinking, toolLine, live = false, terminal = false, resultOnly = false, goal, pending }: SubtaskBubbleProps) {
  const waiting = state === 'waiting_user' || state === 'external_pending'
  return (
    <div className={`bubble${waiting ? ' bubble--wait' : ''}${state === 'succeeded' ? ' bubble--done' : ''}${state === 'failed' ? ' bubble--fail' : ''}`}>
      {thinking !== undefined && thinking !== '' && !resultOnly && <ThinkBlock text={thinking} />}
      {toolLine !== null && (toolLine?.tool !== undefined || toolLine?.detail !== undefined) && !resultOnly && (
        <div className="tool-line">
          <span>{toolLine.tool !== undefined ? '正在翻资料：' : ''}</span>
          <span className="tool-line__name">{toolLine.tool ?? toolLine.detail}</span>
        </div>
      )}
      {goal !== undefined && goal !== '' && <div className="subtask__goal">{goal}</div>}
      {body === ''
        ? state === 'running' && <div className="typing"><i /><i /><i /></div>
        : body.length > STREAM_RICH_LIMIT && live
          ? <span>{body}</span>
          : <RichText text={body} streaming={live && !terminal} />}
      <span className="caret" hidden={terminal || !live} />
      {pending !== undefined && (
        <div className="msg__meta">
          {`待外部处理：${pending.reason}${pending.next !== undefined ? `；${pending.next}` : ''}`}
        </div>
      )}
    </div>
  )
}
