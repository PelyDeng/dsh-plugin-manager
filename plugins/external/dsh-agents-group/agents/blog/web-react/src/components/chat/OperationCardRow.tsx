/**
 * 管理操作卡（旧 chat.js operationCard 的等价迁移）：发布/删除/管理三类操作的
 * 确认、取消与结果核对。
 *
 * 旧码语义逐条对齐：
 * - 标题行 `${标签} · ${title}`（manage=博客管理 / delete=删除文章 / publish=发布草稿）；
 * - publish 展示发布来源行 + 「查看将发布的完整内容」details（全文 + 标签/分类/评论）；
 * - manage 展示 managementSummary 的 pre 摘要；delete 展示将删除的目标列表与保留说明；
 * - 状态行字典：prepared 按 busy/canConfirm 分三态；running/uncertain 提示核对；
 *   succeeded/conflict/cancelled 落定；result.url 给「查看博客文章」外链；
 * - prepared+publish+hasSavedDraft：需勾选「替换现有博客保存稿」后确认才可用；
 * - prepared 给「确认执行/确认删除/确认发布」+「取消」；running/uncertain 给
 *   「核对操作结果」；进行中防重入，错误行就地显示并随重拉清除。
 */
import { useState } from 'react'
import { operationErrorOf, runOperationAction } from '../../chat-controller.ts'
import { managementSummary } from '../../lib/management.ts'
import { safeHttpUrl } from '../../lib/labels.ts'
import { useConversationStore } from '../../stores/conversation.ts'
import type { OperationRecord } from '../../lib/types.ts'
import type { ReactElement } from 'react'
import { RichText, errorTextOf } from '@dsh-agents-group/web-common'

/** 状态行文案（旧 operationCard 的 status 字典；prepared 的三态在组件内分流）。 */
function statusText(op: OperationRecord, busy: boolean): string {
  switch (op.status) {
    case 'prepared':
      return busy ? '请等待本轮回答完成后确认' : op.canConfirm === true ? '请核对内容后确认' : '确认已失效，请重新发起操作'
    case 'running':
      return '执行结果待核对，请查询回执'
    case 'uncertain':
      return '执行结果待核对，请勿重复操作'
    case 'succeeded':
      return op.mode === 'manage' ? '已完成' : op.mode === 'delete' ? '已删除' : '已发布'
    case 'conflict':
      return '文章已变化，请重新核对并发起操作'
    case 'cancelled':
      return '已取消'
    default:
      return op.status
  }
}

export function OperationCardRow({ operation, unassociated, onNotice }: {
  operation: OperationRecord
  unassociated?: boolean
  onNotice: (text: string) => void
}): ReactElement {
  const busy = useConversationStore(state => state.history?.busy === true)
  const [pending, setPending] = useState(false)
  const [consume, setConsume] = useState(false)

  const deleting = operation.mode === 'delete'
  const label = operation.mode === 'manage' ? '博客管理' : deleting ? '删除文章' : '发布草稿'
  const consentRequired = operation.status === 'prepared' && !deleting && operation.hasSavedDraft === true
  const confirmDisabled = pending || busy || operation.canConfirm !== true || (consentRequired && !consume)
  const cancelDisabled = pending || busy || operation.canConfirm !== true
  const reconcileVisible = operation.status === 'running' || operation.status === 'uncertain'
  const errorMessage = operationErrorOf(operation.id)

  const run = (action: 'confirm' | 'cancel' | 'reconcile'): void => {
    if (pending) return
    setPending(true)
    void runOperationAction(operation, action, consume)
      .catch((issue: unknown) => onNotice(errorTextOf(issue)))
      .finally(() => setPending(false))
  }

  return (
    <section className="blg-message blg-operation" data-operation={operation.id}>
      <div className="blg-bubble">
        {unassociated === true && <small className="blg-muted">历史操作（原轮次暂不可用）</small>}
        <h3>{label} · {operation.title}</h3>
        {operation.mode === 'publish' && (
          <>
            <p>{operation.source === 'proposal' ? '发布内容：AI 候选稿（确认后应用并发布）' : '发布内容：当前草稿'}</p>
            <details className="blg-operation-preview">
              <summary>查看将发布的完整内容</summary>
              <RichText text={operation.after?.text ?? ''} links codeCopy />
              <p>标签：{operation.after?.tags?.join('、') || '无'}；分类 ID：{operation.after?.categories?.join('、') || '无'}；允许评论：{operation.after?.allowComment === undefined ? '沿用原设置' : operation.after.allowComment ? '是' : '否'}</p>
            </details>
          </>
        )}
        {operation.mode === 'manage' && <pre className="blg-operation-summary">{managementSummary(operation)}</pre>}
        {operation.mode === 'delete' && (
          <>
            <p>确认后永久删除以下博客内容及关联评论。图床文件和编辑恢复数据保留。</p>
            <ul className="blg-operation-targets">
              {(operation.deletedArticles ?? []).map(article => (
                <li key={article.cid}>{article.title} · {article.type === 'post_draft' ? '博客保存稿' : '博客文章'} · ID {article.cid}</li>
              ))}
            </ul>
          </>
        )}
        <p className="blg-operation-status" role="status">{pending ? '正在处理…' : statusText(operation, busy)}</p>
        {(() => {
          const href = safeHttpUrl(operation.result?.url ?? '')
          return href !== null ? <a href={href} target="_blank" rel="noopener noreferrer">查看博客文章</a> : null
        })()}
        {consentRequired && (
          <label className="blg-check">
            <input type="checkbox" checked={consume} onChange={event => setConsume(event.target.checked)} />
            我确认此次发布会替换现有博客保存稿
          </label>
        )}
        <div className="blg-operation-actions">
          {operation.status === 'prepared' && (
            <>
              <button type="button" className="btn btn--primary" disabled={confirmDisabled} onClick={() => run('confirm')}>
                {operation.mode === 'manage' ? '确认执行' : deleting ? '确认删除' : '确认发布'}
              </button>
              <button type="button" className="btn" disabled={cancelDisabled} onClick={() => run('cancel')}>取消</button>
            </>
          )}
          {reconcileVisible && (
            <button type="button" className="btn" disabled={pending || busy} onClick={() => run('reconcile')}>核对操作结果</button>
          )}
        </div>
        {errorMessage !== undefined && <p className="blg-dialog-error" role="alert">{errorMessage}</p>}
      </div>
    </section>
  )
}
