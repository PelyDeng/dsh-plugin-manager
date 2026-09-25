/**
 * 资料内容弹窗（旧 #chat-file-dialog / #attachment-dialog 的合并等价）：
 * 文本解析单元逐行列出、图片内联预览、范围选定（attachment-select）、下载原文件。
 *
 * 两处调用的旧文案差异保留：chat 侧 previewFile 的描述是「解析完成/部分解析…」，
 * writing 侧 viewAttachment 是「已提取 x/y unit，共 n 字符」（服务端 message 优先）。
 * 打开时的「加载中…」占位与旧码一致。
 */
import { useEffect, useState } from 'react'
import { api, attachmentDownloadUrl } from '../../lib/api.ts'
import type { AttachmentContent } from '../../lib/types.ts'
import type { ReactElement } from 'react'
import { Modal } from './Modal.tsx'

export interface FilePreviewTarget {
  draftId: string
  id: string
  /** 行名（旧 chat 侧用附件行 name；writing 侧回包 name 优先）。 */
  name: string
  kind: string
  /** 既有选定范围（范围输入的初值；旧 range-from/to 的回填）。 */
  range?: { from: number; to: number } | null | undefined
  /** 描述文案口径：chat=解析状态，writing=提取统计。 */
  variant: 'chat' | 'writing'
}

export function FilePreviewDialog({ target, onClose, onNotice }: {
  target: FilePreviewTarget | null
  onClose: () => void
  onNotice: (text: string) => void
}): ReactElement {
  const [content, setContent] = useState<AttachmentContent | null>(null)
  const [loadError, setLoadError] = useState('')
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(1)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (target === null) {
      setContent(null)
      setLoadError('')
      return
    }
    let cancelled = false
    setLoadError('')
    api.attachmentContent(target.draftId, target.id)
      .then(data => {
        if (cancelled) return
        setContent(data)
        setFrom(target.range?.from ?? 1)
        setTo(target.range?.to ?? data.range?.to ?? data.parsedUnits ?? 1)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [target])

  if (target === null) return <Modal open={false} onClose={onClose} title="资料内容">{null}</Modal>

  const title = target.variant === 'writing' && content !== null ? content.name : target.name
  const description = content === null
    ? '加载中…'
    : target.variant === 'chat'
      ? `${content.partial ? '部分解析；请明确选择范围' : '解析完成'}${content.totalUnits > 0 ? `，共 ${content.totalUnits} ${content.unit}` : ''}`
      : content.message ?? `已提取 ${content.parsedUnits}/${content.totalUnits} ${content.unit}，共 ${content.characters} 字符`
  const units = content?.units ?? []
  const download = attachmentDownloadUrl(target.draftId, target.id)
  const isImage = target.kind.startsWith('image/')

  const saveRange = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.attachmentSelect({ draftId: target.draftId, id: target.id, selected: true, range: { from: Number(from), to: Number(to) } })
      onClose()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={title} label="资料内容" busy={saving}>
      {loadError !== '' && <p className="blg-dialog-error" role="alert">{loadError}</p>}
      <p className="blg-dialog-description">{description}</p>
      {units.length > 0 && (
        <div className="blg-file-range">
          <label>从 <input type="number" min={1} value={from} onChange={event => setFrom(Number(event.target.value))} /></label>
          <label>至 <input type="number" min={1} value={to} onChange={event => setTo(Number(event.target.value))} /></label>
          <button type="button" className="btn" disabled={saving} onClick={() => { void saveRange() }}>选定此范围</button>
        </div>
      )}
      {isImage && <img className="blg-file-image" alt="私有图片资料预览" src={`${download}&inline=1`} />}
      <pre className="blg-file-text">{units.map(unit => `[${content?.unit ?? '段'} ${unit.number}] ${unit.text}`).join('\n')}</pre>
      <a className="blg-file-download" href={download}>下载原文件</a>
    </Modal>
  )
}
