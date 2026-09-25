/**
 * 发布与同步记录弹窗（旧 #operations-dialog + loadOperations 的组件化）：
 * 每行 = 模式 + 状态 + 查看文章链接；running/uncertain 给「核对回执」
 * （reconcile 后刷新，uncertain 结果就地提示）。
 */
import { useEffect, useState } from 'react'
import { api } from '../../lib/api.ts'
import { safeHttpUrl } from '../../lib/labels.ts'
import { loadOperations } from '../../workspace-controller.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useWorkspaceStore } from '../../stores/workspace.ts'
import type { ReactElement } from 'react'
import { Modal } from '../common/Modal.tsx'

const OPERATION_STATUS: Record<string, string> = {
  prepared: '等待确认',
  running: '提交中',
  uncertain: '结果待核对',
  succeeded: '已确认成功',
  conflict: '版本冲突',
}

export function OperationsDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const rows = useWorkspaceStore(state => state.operationsLog)
  const [reconciling, setReconciling] = useState(false)
  const [message, setMessage] = useState('')

  // 打开时刷新记录（旧 loadOperations 的入口时点）。
  useEffect(() => {
    if (open) void loadOperations().catch(() => {})
  }, [open])

  const reconcile = async (id: string): Promise<void> => {
    setReconciling(true)
    setMessage('')
    try {
      const result = await api.reconcile(id)
      if (result.status === 'uncertain') setMessage(result.message ?? '操作结果待核对')
      await loadOperations()
    } catch (issue) {
      useSessionStore.getState().setNotice({ text: issue instanceof Error ? issue.message : String(issue), tone: 'error' })
    } finally {
      setReconciling(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="发布与同步记录" label="发布与同步记录">
      {message !== '' && <p className="blg-dialog-description" role="status">{message}</p>}
      <div className="blg-operations" aria-live="polite">
        {rows.length === 0 && <p className="blg-muted">这篇文章还没有发布或同步记录。</p>}
        {rows.map(row => {
          const href = safeHttpUrl(row.url ?? '')
          return (
            <div key={row.id} className="blg-operation-row">
              <span>{row.mode === 'publish' ? '发布/更新' : '保存博客草稿'} · {OPERATION_STATUS[row.status] ?? row.status}</span>
              {href !== null && <a href={href} target="_blank" rel="noopener noreferrer">查看文章 ↗</a>}
              {(row.status === 'running' || row.status === 'uncertain') && (
                <button type="button" className="btn btn--tiny" disabled={reconciling} onClick={() => { void reconcile(row.id) }}>
                  核对回执
                </button>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
