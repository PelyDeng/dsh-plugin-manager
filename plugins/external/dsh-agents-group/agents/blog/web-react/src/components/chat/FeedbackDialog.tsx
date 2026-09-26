/**
 * 评价备注弹窗（旧 #chat-feedback-dialog + saveFeedback 的等价迁移）。
 *
 * 旧码语义：打开时回填既有评价（缺省 helpful）；保存走 put、撤销走 delete；备注
 * 只有非空才提交；version-conflict 时把服务端当前值回填进表单并保持弹窗打开
 * （旧 saveFeedback 的 target.version 回写段）；成功后关闭并刷新。
 */
import { useEffect, useState } from 'react'
import { errorTextOf } from '@dsh-agents-group/web-common'
import { saveFeedbackDialog } from '../../chat-controller.ts'
import { useConversationStore } from '../../stores/conversation.ts'
import type { ReactElement } from 'react'
import { Modal } from '../common/Modal.tsx'

export interface FeedbackTarget {
  messageId: string
}

export function FeedbackDialog({ target, onClose }: {
  target: FeedbackTarget | null
  onClose: () => void
}): ReactElement {
  const feedback = useConversationStore(state => state.feedback)
  const conversationId = useConversationStore(state => state.conversationId)
  const [rating, setRating] = useState<'positive' | 'negative'>('positive')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 打开时回填既有评价（旧 openFeedback 的表单回填段）。
  useEffect(() => {
    if (target === null) return
    const existing = feedback.get(target.messageId)
    setRating(existing?.rating ?? 'positive')
    setNote(existing?.note ?? '')
    setError('')
  }, [target, feedback])

  const save = (operation: 'put' | 'delete'): void => {
    if (target === null) return
    setBusy(true)
    setError('')
    saveFeedbackDialog({
      conversationId,
      messageId: target.messageId,
      rating,
      note,
      ifVersion: feedback.get(target.messageId)?.version ?? null,
      operation,
    })
      .then(() => onClose())
      .catch((issue: unknown) => setError(errorTextOf(issue)))
      .finally(() => setBusy(false))
  }

  return (
    <Modal open={target !== null} onClose={onClose} title="评价这条回答" label="评价这条回答" busy={busy}>
      {error !== '' && <p className="blg-dialog-error" role="alert" tabIndex={-1}>{error}</p>}
      <label className="blg-field">
        评价
        <select value={rating} onChange={event => setRating(event.target.value === 'negative' ? 'negative' : 'positive')}>
          <option value="positive">有帮助</option>
          <option value="negative">有待改进</option>
        </select>
      </label>
      <label className="blg-field">
        补充说明（可选）
        <textarea rows={5} maxLength={4000} value={note} onChange={event => setNote(event.target.value)} />
      </label>
      <div className="blg-dialog-actions">
        <button type="button" className="btn" disabled={busy || feedback.get(target?.messageId ?? '') === undefined} onClick={() => save('delete')}>
          撤销评价
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => save('put')}>保存评价</button>
      </div>
    </Modal>
  )
}
