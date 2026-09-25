/**
 * 弹层基元（批 2b）：React 对 <dialog> 的受控包装，全站弹层统一 butler 直角墨框
 * （方案 §3.2 弹层材质=新基线，对照表登记差异项）。
 *
 * - open 受控：showModal/close 的命令式 API 在 effect 内同步；
 * - 遮罩点击与 Esc 都走 onClose（busy 时取消被阻止，旧 publish-dialog.cancel 的
 *   publishBusy preventDefault 同语义）；
 * - 标题/关闭按钮形态与旧 dialog-head 一致。
 */
import { useEffect, useRef } from 'react'
import type { MouseEvent, ReactElement, ReactNode, SyntheticEvent } from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** 进行中：Esc/遮罩关闭被阻止（旧码 aria-busy + cancel preventDefault）。 */
  busy?: boolean
  /** a11y 标注（aria-label；缺省用 title）。 */
  label?: string
  /** 额外类名（弹窗宽度等差异由成员层样式承接）。 */
  className?: string
}

export function Modal({ open, onClose, title, children, busy = false, label, className }: ModalProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const handleCancel = (event: SyntheticEvent): void => {
    event.preventDefault()
    if (!busy) onClose()
  }

  const handleClick = (event: MouseEvent<HTMLDialogElement>): void => {
    // 只在点中遮罩（dialog 自身）时关闭；面板内点击不受影响。
    if (event.target === ref.current && !busy) onClose()
  }

  return (
    <dialog
      ref={ref}
      className={className === undefined ? 'blg-dialog' : `blg-dialog ${className}`}
      aria-label={label ?? title}
      aria-busy={busy}
      onClick={handleClick}
      onCancel={handleCancel}
    >
      <div className="blg-dialog-head">
        <h2>{title}</h2>
        <button type="button" className="blg-dialog-close" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}>×</button>
      </div>
      {children}
    </dialog>
  )
}
