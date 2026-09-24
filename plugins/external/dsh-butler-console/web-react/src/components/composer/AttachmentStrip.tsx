/**
 * 待发附件条（评审 #20 从 Composer.tsx 拆出）：选文件、拖进来、粘链接都落到这里；
 * 空时整块收起。链接输入区的显示/聚焦/取回归本组件自治——「链接」按钮只把 store
 * 的 urlInputVisible 置 true，输入区出现后由这里拉焦点（原 rAF 聚焦语义随 ref 内聚）。
 * 附件三通道最后都落到一份服务端记录；元数据悬浮展示解析结果（评审 中11）。
 */
import { useEffect, useRef } from 'react'
import { useTurnStore } from '../../stores/turn.ts'
import { addUrl, dropAttachment } from '../../flows/attachments.ts'
import { fileSizeText, useAttachmentsStore } from '../../stores/attachments.ts'

export function AttachmentStrip() {
  const conversationId = useTurnStore(state => state.conversationId)
  const attachments = useAttachmentsStore(state => state.items)
  const urlInputVisible = useAttachmentsStore(state => state.urlInputVisible)
  const urlInputRef = useRef<HTMLInputElement>(null)

  // 链接输入区出现后拉焦点：rAF 等 DOM 挂稳（原按钮内 rAF 聚焦同口径）。
  useEffect(() => {
    if (!urlInputVisible) return
    const raf = window.requestAnimationFrame(() => urlInputRef.current?.focus())
    return () => window.cancelAnimationFrame(raf)
  }, [urlInputVisible])

  if (attachments.length === 0 && !urlInputVisible) return null
  return (
    <div className="attach" id="attach-strip">
      <div className="attach__items" id="attach-items">
        {attachments.map(entry => (
          <span key={entry.key} className="attach__item" data-phase={entry.phase}
            title={(() => {
              // 附件元数据悬浮（评审 中11）：解析了多少页/段、大概是什么、来自哪个链接。
              const item = entry.item
              if (item === null) return entry.name
              const parts = [item.name]
              if (item.kind !== undefined && item.kind !== '') parts.push(item.kind)
              if (item.totalUnits !== undefined) parts.push(`${item.totalUnits} 页/段`)
              if (item.characters !== undefined) parts.push(`${item.characters} 字`)
              if (item.preview !== undefined && item.preview !== '') parts.push(item.preview.slice(0, 80))
              if (item.sourceUrl !== undefined && item.sourceUrl !== '') parts.push(item.sourceUrl)
              return parts.join(' · ')
            })()}>
            <span className="attach__name">{entry.name}</span>
            {fileSizeText(entry.size) !== '' && <span className="attach__size">{fileSizeText(entry.size)}</span>}
            {(entry.phase !== 'ready' || entry.message !== '') && (
              <span className="attach__note">
                {entry.phase === 'uploading' ? (entry.message === '' ? '上传中…' : entry.message)
                  : entry.phase === 'failed' ? (entry.message === '' ? '没成' : entry.message)
                    : entry.message}
              </span>
            )}
            <button
              type="button"
              className="attach__remove"
              title="移除"
              aria-label={`移除 ${entry.name}`}
              onClick={() => { void dropAttachment(entry.key) }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {urlInputVisible && (
        <div className="attach__url" id="attach-url">
          <input
            ref={urlInputRef}
            type="url"
            id="attach-url-input"
            placeholder="粘贴文件或图片的链接，回车取回"
            aria-label="附件链接"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); useAttachmentsStore.getState().setUrlInputVisible(false); return }
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              // 回车是「取回这个链接」，不是发送（不该把没写完的消息发出去）。
              event.preventDefault()
              const url = urlInputRef.current?.value ?? ''
              useAttachmentsStore.getState().setUrlInputVisible(false)
              void addUrl(url, conversationId)
            }}
          />
          <button type="button" className="btn btn--tiny btn--ghost" id="attach-url-cancel" onClick={() => useAttachmentsStore.getState().setUrlInputVisible(false)}>
            取消
          </button>
        </div>
      )}
    </div>
  )
}
