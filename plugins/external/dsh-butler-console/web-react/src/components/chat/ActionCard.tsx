/**
 * 操作确认卡（统一封装，问题 1 的答案）：**所有智能体**的「待用户确认/决策」交互
 * 共用这一张卡——协议是 plugin-kit 的 AgentAction（呈现数据面），协调方不认识 kind
 * 也能渲染。prepared 态出「确认/先不办」双按钮；执行中/已办完/没办成/过期按状态呈现。
 * 决策走 /action（幂等，requestId 同一回话复用）；确认产生的是一次决策，凭据不进前端。
 */
import { useState } from 'react'
import { runActionDecision } from '../../hooks/use-turn.ts'
import { resolveActionLocally } from '../../stores/turn.ts'
import { newConversationId } from '../../lib/turn-event.ts'
import { RichText } from './RichText.tsx'
import { errorTextOf } from '../../lib/error-text.ts'

export interface AgentActionView {
  id: string
  kind?: string
  title?: string
  summary?: string
  detail?: string
  fields?: ReadonlyArray<{ label?: string; value?: string }> | undefined
  resultText?: string
  errorText?: string
  state?: string
  expiresAt?: number
  confirmLabel?: string
  cancelLabel?: string
}

const STATE_TEXT: Record<string, string> = {
  prepared: '等你确认',
  executing: '正在办',
  succeeded: '已办完',
  failed: '没办成',
  cancelled: '先不办',
  expired: '确认已过期',
}

/** prepared 但已过确认有效期：恢复的历史卡常见（expiresAt 只有 10 分钟），不可再点。 */
/** 期限提示文案（旧前端 cards.js 语义：有紧迫感才有确认率）。 */
export function actionDeadline(action: { expiresAt?: number }): string | null {
  if (typeof action.expiresAt !== 'number' || action.expiresAt < Date.now()) return null
  const at = new Date(action.expiresAt)
  return `请在 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 前确认`
}

export function actionExpired(action: { state?: string; expiresAt?: number }): boolean {
  return (action.state ?? 'prepared') === 'prepared'
    && typeof action.expiresAt === 'number'
    && action.expiresAt < Date.now()
}

export function ActionCard({ action, taskId, subtaskId }: {
  action: AgentActionView
  taskId: string
  subtaskId: string
}) {
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const expired = actionExpired(action)
  const state = expired ? 'expired' : action.state ?? 'prepared'
  const actionable = state === 'prepared' && !locked

  const run = async (decision: 'confirm' | 'cancel') => {
    setLocked(true)
    setNote(decision === 'confirm' ? '正在办理…' : '正在撤回…')
    try {
      // 与 ActionDeck 同款：走 runActionDecision（事件进 store+跟随到终态），受理即本地摘卡。
      await runActionDecision({
        taskId, subtaskId, actionId: action.id, decision, requestId: newConversationId(),
      }, {
        onAccepted: () => { resolveActionLocally(subtaskId, action.id); setNote(decision === 'confirm' ? '已受理，正在办理' : '已撤回') },
        onRejected: error => { setNote(`${decision === 'confirm' ? '确认' : '撤回'}没成功：${errorTextOf(error)}`); setLocked(false) },
      })
    } catch (error) {
      setNote(`${decision === 'confirm' ? '确认' : '撤回'}没成功：${errorTextOf(error)}`)
      setLocked(false)
    }
  }

  return (
    <section className="act" data-action-id={action.id} data-subtask-id={subtaskId} data-task-id={taskId} data-kind={action.kind ?? ''} data-state={state}>
      <div className="act__head">
        <span className="act__title">{action.title ?? '待确认的操作'}</span>
        <span className="act__state">{STATE_TEXT[state] ?? state}</span>
        {state === 'prepared' && actionDeadline(action) !== null && <span className="act__deadline">{actionDeadline(action)}</span>}
      </div>
      {action.summary !== undefined && action.summary !== '' && <p className="act__summary">{action.summary}</p>}
      {action.detail !== undefined && action.detail !== '' && <div className="act__detail md"><RichText text={action.detail} variant="card" /></div>}
      {action.fields !== undefined && action.fields.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="操作详情">
          <table>
            <tbody>
              {action.fields.map((field, index) => (
                <tr key={index}><th>{field.label ?? ''}</th><td>{field.value ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {action.resultText !== undefined && action.resultText !== '' && <div className="act__result md"><RichText text={action.resultText} variant="card" /></div>}
      {action.errorText !== undefined && action.errorText !== '' && <p className="act__error">{action.errorText}</p>}
      {actionable && (
        <div className="act__row">
          <button type="button" className="btn btn--tiny btn--primary" disabled={locked} onClick={() => { void run('confirm') }}>
            {action.confirmLabel ?? '确认'}
          </button>
          <button type="button" className="btn btn--tiny" disabled={locked} onClick={() => { void run('cancel') }}>
            {action.cancelLabel ?? '先不办'}
          </button>
        </div>
      )}
      {note !== null && <p className="act__note">{note}</p>}
    </section>
  )
}
