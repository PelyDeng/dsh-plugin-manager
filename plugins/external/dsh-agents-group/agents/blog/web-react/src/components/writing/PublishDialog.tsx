/**
 * 发布确认弹窗（旧 #publish-dialog + prepare/confirm/reconcile 链路的组件化）。
 *
 * 旧码语义对齐：
 * - 形态分流：publish=版本对照（发布前版本 vs 本次提交版本）+ 可选「消费已有博客
 *   保存稿」勾选；delete=删除目标列表 + 取消按钮文案（旧 publish-close 的三态）。
 * - 确认进行中：所有关闭路径被阻止（busy），按钮文案切换（正在发布/删除…）。
 * - 失败分流：丢响应时按回执状态给「核对操作结果」或「重新预览」，避免重复提交
 *   （旧 checkPublishFailure / retry-publish / reconcile-publish）。
 * - 成功：显示结果行与「查看博客文章」外链；关闭按钮变「完成」。
 */
import { useState } from 'react'
import { errorTextOf } from '@dsh-agents-group/web-common'
import { confirmPublish, prepareLibraryDelete, preparePublish, reconcilePublish } from '../../workspace-controller.ts'
import { safeHttpUrl } from '../../lib/labels.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useWorkspaceStore } from '../../stores/workspace.ts'
import type { ReactElement } from 'react'
import { Modal } from '../common/Modal.tsx'

export function PublishDialog(): ReactElement | null {
  const prepared = useWorkspaceStore(state => state.prepared)
  const busy = useWorkspaceStore(state => state.publishBusy)
  const open = useWorkspaceStore(state => state.publishDialogOpen)
  const setPublishDialogOpen = useWorkspaceStore(state => state.setPublishDialogOpen)
  const setPrepared = useWorkspaceStore(state => state.setPrepared)

  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [success, setSuccess] = useState(false)
  const [consume, setConsume] = useState(false)
  const [phase, setPhase] = useState<'confirm' | 'result' | 'reconcile' | 'retry'>('confirm')
  const [resultUrl, setResultUrl] = useState('')

  const onNotice = (issue: unknown): void =>
    useSessionStore.getState().setNotice({ text: errorTextOf(issue), tone: 'error' })

  if (prepared === null) return null
  const deleting = prepared.mode === 'delete'
  const payload = prepared.payload as {
    before?: { title?: string; text?: string } | null
    after?: { title?: string; text?: string; tags?: string[] } | null
    title?: string
    source?: string
    hasSavedDraft?: boolean
    deletedArticles?: readonly { title: string; type: string; cid: number }[]
  }

  const close = (): void => {
    setPublishDialogOpen(false)
    setPrepared(null)
    setError('')
    setStatus('')
    setSuccess(false)
    setConsume(false)
    setPhase('confirm')
    setResultUrl('')
  }

  const runConfirm = async (): Promise<void> => {
    setError('')
    setStatus(deleting ? '正在删除，请稍候…' : '正在发布，请稍候…')
    const outcome = await confirmPublish(consume)
    if (outcome.kind === 'success') {
      setSuccess(true)
      setStatus(deleting ? '文章已删除' : '发布成功')
      setResultUrl(outcome.url)
      setPhase('result')
    } else if (outcome.kind === 'reconcile') {
      setStatus('操作结果待核对，请点击「核对操作结果」，避免重复执行。')
      setPhase('reconcile')
    } else {
      setStatus('准备已就绪，可重新预览提交。')
      setPhase('retry')
    }
  }

  const runReconcile = async (): Promise<void> => {
    setError('')
    setStatus('正在核对操作结果…')
    const outcome = await reconcilePublish()
    if (outcome.kind === 'success') {
      setSuccess(true)
      setStatus('核对完成：操作已生效')
      setResultUrl(outcome.url)
      setPhase('result')
    } else {
      setError('暂未取得成功回执，请稍后核对，勿重复提交。')
      setPhase('reconcile')
    }
  }

  const runRetry = async (): Promise<void> => {
    setError('')
    try {
      if (deleting && prepared.remoteId !== null) await prepareLibraryDelete(prepared.remoteId)
      else await preparePublish()
      setPhase('confirm')
      setStatus('')
    } catch (issue) {
      setError(errorTextOf(issue))
    }
  }

  const heading = deleting ? (phase === 'result' ? '删除完成' : '确认删除博客文章') : phase === 'result' ? '发布结果' : payload.before ? '确认更新公开文章' : '确认发布文章'
  const description = deleting
    ? phase === 'result'
      ? `《${payload.title ?? ''}》已从博客删除，工作台副本和图床文件保留。`
      : `即将永久删除《${payload.title ?? ''}》及下列博客内容和关联评论。图床文件和工作台副本会保留。`
    : `《${payload.title ?? ''}》 · ${payload.source === 'proposal' ? '本次发布最新候选稿，确认成功后保存到博客' : '本次发布当前编辑器已保存的内容'}。请核对正文与标签。`

  return (
    <Modal open={open} onClose={close} title={heading} label={heading} busy={busy}>
      {error !== '' && <p className="blg-dialog-error" role="alert" tabIndex={-1}>{error}</p>}
      {status !== '' && <p className={success ? 'blg-publish-status blg-publish-status--ok' : 'blg-publish-status'} role="status" tabIndex={-1}>{status}</p>}
      {resultUrl !== '' && safeHttpUrl(resultUrl) !== null && (
        <a href={safeHttpUrl(resultUrl) ?? '#'} target="_blank" rel="noopener noreferrer">查看博客文章 ↗</a>
      )}
      <p className="blg-dialog-description">{description}</p>

      {deleting && phase === 'confirm' && (
        <ul className="blg-operation-targets">
          {(payload.deletedArticles ?? []).map(article => (
            <li key={article.cid}>{article.title} · {article.type === 'post_draft' ? '保存稿' : '博客文章'} · ID {article.cid}</li>
          ))}
        </ul>
      )}
      {!deleting && phase === 'confirm' && (
        <div className="blg-publish-compare">
          <section>
            <h3>发布前版本</h3>
            <pre>{payload.before ? `${payload.before.title ?? ''}\n\n${payload.before.text ?? ''}` : '尚无公开版本'}</pre>
          </section>
          <section>
            <h3>本次提交版本</h3>
            <pre>{payload.after ? `${payload.after.title ?? ''}\n\n${payload.after.text ?? ''}\n\n标签：${(payload.after.tags ?? []).join('、')}` : ''}</pre>
          </section>
        </div>
      )}
      {!deleting && phase === 'confirm' && payload.hasSavedDraft === true && (
        <label className="blg-check">
          <input type="checkbox" checked={consume} onChange={event => setConsume(event.target.checked)} />
          我确认发布本稿并消费已有博客保存稿
        </label>
      )}
      <div className="blg-dialog-actions">
        {phase === 'confirm' && (
          <>
            <button type="button" className="btn" onClick={close}>{deleting ? '取消' : '继续编辑'}</button>
            <button
              type="button"
              className={deleting ? 'btn btn--danger' : 'btn btn--primary'}
              disabled={busy || (!deleting && payload.hasSavedDraft === true && !consume)}
              onClick={() => { void runConfirm() }}
            >
              {deleting ? (busy ? '正在删除…' : '确认删除') : busy ? '正在发布…' : '确认提交'}
            </button>
          </>
        )}
        {phase === 'result' && <button type="button" className="btn btn--primary" onClick={close}>完成</button>}
        {phase === 'reconcile' && (
          <>
            <button type="button" className="btn" onClick={close}>关闭</button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => { void runReconcile() }}>核对操作结果</button>
          </>
        )}
        {phase === 'retry' && (
          <>
            <button type="button" className="btn" onClick={close}>继续编辑</button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => { void runRetry() }}>重新预览</button>
          </>
        )}
      </div>
    </Modal>
  )
}
