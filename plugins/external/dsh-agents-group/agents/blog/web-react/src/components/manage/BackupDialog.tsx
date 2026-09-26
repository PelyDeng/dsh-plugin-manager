/**
 * 备份与恢复弹窗（旧 web/app.js backup 段 + index.html backup-dialog 的组件化）。
 *
 * 仅 backupAdmin 可见入口（identity.backupAdmin，旧 $('backup-open').hidden 口径）。
 * 功能对齐旧码逐项：
 * - 计划表单：启用/北京时间/日备份保留/周备份保留 → backup-schedule 后重拉状态；
 * - 「刷新状态」→ backup-status；状态行三段文案（下次计划/当前/最近）+
 *   recoveryPending 追加行，状态标签映射同旧码；
 * - 「立即备份」→ backup-run 后重拉；
 * - 备份列表行：id + 状态标签 +「校验」（backup-verify → 组件数文案）+ 两个恢复
 *   入口（隔离演练/恢复到生产；仅 status==='complete' 可用）；
 * - 恢复确认弹窗：说明文案分模式原样、显示备份 id、输入完整备份标识核对（不一致
 *   报「请输入与所选版本一致的完整备份标识」）→ backup-restore-confirm → 关闭并
 *   提示「恢复任务已提交，点击刷新查看状态；生产恢复期间服务会短暂停止。」。
 */
import { useEffect, useState } from 'react'
import { errorTextOf } from '@dsh-agents-group/web-common'
import { api } from '../../lib/api.ts'
import type { BackupStatus, RestoreTicket } from '../../lib/types.ts'
import type { FormEvent, ReactElement } from 'react'
import { Modal } from '../common/Modal.tsx'

/** 状态标签（旧 labels 映射原样）。 */
const STATUS_LABEL: Record<string, string> = { running: '进行中', succeeded: '已完成', failed: '失败', complete: '完整', writing: '写入中' }

const RESTORE_NOTES: Record<'isolated' | 'production', string> = {
  production: '将先备份当前状态，再恢复所选博客版本、文章编辑恢复数据和 pelyblog 图片。过程会短暂停止相关服务；原目录与数据库会保留。其他图床策略不会被覆盖。',
  isolated: '将备份还原到独立目录与数据库，核验文件和数据。不会覆盖生产网站。',
}

export function BackupDialog({ open, onClose }: {
  open: boolean
  onClose: () => void
}): ReactElement {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [time, setTime] = useState('03:00')
  const [daily, setDaily] = useState(7)
  const [weekly, setWeekly] = useState(4)
  const [statusLine, setStatusLine] = useState('')
  // 恢复确认弹窗状态（旧 restore-dialog）。
  const [restore, setRestore] = useState<{ ticket: RestoreTicket; mode: 'isolated' | 'production' } | null>(null)
  const [checkText, setCheckText] = useState('')
  const [restoreError, setRestoreError] = useState('')

  /** 状态行渲染（旧 loadBackups 的三段拼接原样）。 */
  const renderStatusLine = (data: BackupStatus): string => {
    const lines = [
      `下次计划：${data.nextRun || '未启用'}`,
      `当前：${STATUS_LABEL[data.current?.status ?? ''] ?? '空闲'} ${data.current?.message ?? data.current?.note ?? ''}`,
      `最近：${data.last?.id ?? data.last?.backupId ?? '暂无'} · ${STATUS_LABEL[data.last?.status ?? ''] ?? ''}`,
    ]
    if (data.recoveryPending === true) lines.push('服务恢复尚未确认，请检查运维状态')
    return lines.join('\n')
  }

  const load = async (): Promise<void> => {
    setError('')
    try {
      const data = await api.backupStatus()
      setStatus(data)
      setEnabled(data.schedule.enabled)
      setTime(data.schedule.time)
      setDaily(data.schedule.daily)
      setWeekly(data.schedule.weekly)
      setStatusLine(renderStatusLine(data))
    } catch (issue) {
      setError(errorTextOf(issue))
    }
  }

  // 打开即拉取（旧 backup-open：showModal + loadBackups）。
  useEffect(() => {
    if (open) void load()
  }, [open])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (issue) {
      setError(errorTextOf(issue))
    } finally {
      setBusy(false)
    }
  }

  const saveSchedule = (event: FormEvent): void => {
    event.preventDefault()
    void run(async () => {
      await api.backupSchedule({ enabled, time, daily, weekly })
      await load()
    })
  }

  const startRestore = (id: string, mode: 'isolated' | 'production'): void => {
    void run(async () => {
      const ticket = await api.backupRestorePrepare({ id, mode })
      setRestore({ ticket, mode })
      setCheckText('')
      setRestoreError('')
    })
  }

  const confirmRestore = (): void => {
    const ticket = restore?.ticket
    if (ticket === undefined) return
    // 旧 restore-confirm：输入必须与票面备份标识完全一致。
    if (checkText !== ticket.backupId) {
      setRestoreError('请输入与所选版本一致的完整备份标识')
      return
    }
    setBusy(true)
    void (async () => {
      try {
        await api.backupRestoreConfirm({ id: ticket.id, nonce: ticket.nonce, backupId: ticket.backupId })
        setRestore(null)
        setStatusLine('恢复任务已提交，点击刷新查看状态；生产恢复期间服务会短暂停止。')
      } catch (issue) {
        setRestoreError(errorTextOf(issue))
      } finally {
        setBusy(false)
      }
    })()
  }

  const backups = status?.backups ?? []

  return (
    <>
      <Modal open={open} onClose={onClose} title="备份与恢复">
        <div className="blg-backup">
          <p className="blg-muted">备份包含博客、图片及必要数据；同机副本不能替代异机容灾。</p>
          {error !== '' && <p className="blg-history-status" role="alert">{error}</p>}
          <form className="blg-backup-schedule" onSubmit={saveSchedule}>
            <label className="blg-check">
              <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
              启用定时备份
            </label>
            <label>
              北京时间 <input type="time" value={time} required onChange={event => setTime(event.target.value)} />
            </label>
            <label>
              日备份保留 <input type="number" min={1} max={90} value={daily} required onChange={event => setDaily(Number(event.target.value))} />
            </label>
            <label>
              周备份保留 <input type="number" min={1} max={52} value={weekly} required onChange={event => setWeekly(Number(event.target.value))} />
            </label>
            <button type="submit" className="btn btn--tiny" disabled={busy}>保存计划</button>
          </form>
          <div className="blg-backup-actions">
            <button type="button" disabled={busy} onClick={() => { void load() }}>刷新状态</button>
            <button type="button" disabled={busy} onClick={() => { void run(async () => { await api.backupRun(); await load() }) }}>立即备份</button>
          </div>
          <pre className="blg-backup-status" role="status">{statusLine}</pre>
          <div className="blg-backup-list">
            {backups.map(backup => (
              <div key={backup.id} className="blg-backup-row">
                <span>{backup.id} · {STATUS_LABEL[backup.status] ?? backup.status} </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      const result = await api.backupVerify(backup.id)
                      setStatusLine(`${result.id}：${result.components} 个组件校验通过`)
                    })
                  }}
                >校验</button>
                <button type="button" disabled={busy || backup.status !== 'complete'} onClick={() => { startRestore(backup.id, 'isolated') }}>隔离恢复演练</button>
                <button type="button" disabled={busy || backup.status !== 'complete'} onClick={() => { startRestore(backup.id, 'production') }}>恢复到生产</button>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* 恢复确认弹窗（旧 restore-dialog：说明 + 备份 id + 输入核对）。 */}
      <Modal
        open={restore !== null}
        onClose={() => { setRestore(null) }}
        title={restore?.mode === 'production' ? '恢复到生产' : '隔离恢复演练'}
      >
        <div className="blg-history-dialog-body">
          <p>{restore === null ? '' : RESTORE_NOTES[restore.mode]}</p>
          <p>备份标识：<strong>{restore?.ticket.backupId}</strong></p>
          {restoreError !== '' && <p className="blg-history-status" role="alert">{restoreError}</p>}
          <input
            type="text"
            aria-label="完整备份标识"
            placeholder="输入上方完整备份标识以确认"
            value={checkText}
            onChange={event => { setCheckText(event.target.value); setRestoreError('') }}
          />
          <div className="blg-history-dialog-actions">
            <button type="button" onClick={() => { setRestore(null) }}>取消</button>
            <button type="button" className="btn--danger" disabled={busy || checkText === ''} onClick={confirmRestore}>确认恢复</button>
          </div>
        </div>
      </Modal>
    </>
  )
}
