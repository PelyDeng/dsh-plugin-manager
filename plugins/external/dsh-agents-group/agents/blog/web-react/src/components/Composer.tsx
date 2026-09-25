/**
 * 输入区（旧 chat-form 的组件化）：textarea、附件条数据面、联网查证、模型选择、
 * 发送/停止与状态行。
 *
 * 键盘与输入法语义照旧（旧 shouldSendChatEnter）：Enter 发送（触摸/窄屏与合成中
 * 除外）、Shift+Enter 换行、keyCode 229 视为合成中。粘贴/拖放的文件走上传链路。
 */
import { useEffect, useRef, useState } from 'react'
import { attachmentDownloadUrl } from '../lib/api.ts'
import { removeAttachment, send, stopAnswer, toggleAttachment, transferredFiles, uploadFiles } from '../chat-controller.ts'
import { useComposerStore, usePickerStore } from '../stores/composer.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import { DshIcon } from './DshIcon.tsx'
import { FilePreviewDialog } from './common/FilePreviewDialog.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import type { CompositionEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from 'react'

const touchInput = (): boolean =>
  window.matchMedia('(pointer: coarse), (max-width: 760px)').matches

export function Composer({ onNotice }: { onNotice: (text: string) => void }): ReactElement {
  const draft = useComposerStore(state => state.draft)
  const research = useComposerStore(state => state.research)
  const sending = useComposerStore(state => state.sending)
  const stopping = useComposerStore(state => state.stopping)
  const uploading = useComposerStore(state => state.uploading)
  const connectionHint = useComposerStore(state => state.connectionHint)
  const files = useComposerStore(state => state.files)
  const imageCapability = useComposerStore(state => state.imageCapability)
  const setDraft = useComposerStore(state => state.setDraft)
  const setResearch = useComposerStore(state => state.setResearch)
  const pickerBusy = usePickerStore(state => state.busy)

  const busy = useConversationStore(state => state.history?.busy === true)
  const identityReady = useSessionStore(state => state.identityReady)
  const setNotice = useSessionStore(state => state.setNotice)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const [dragOver, setDragOver] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const conversationId = useConversationStore(state => state.conversationId)

  const disabled = sending || stopping || busy || uploading || !identityReady
  const stopVisible = busy || stopping

  // 状态行（旧 controls() 的 chat-state 文案；连接提示优先，与旧 onerror 直写一致）。
  const stateText = connectionHint !== ''
    ? connectionHint
    : stopping
      ? '正在停止，保留已生成内容…'
      : uploading
        ? '正在上传和解析资料…'
        : busy || sending
          ? '正在回答 · 可随时停止'
          : touchInput()
            ? '换行继续输入 · 点击箭头发送 · 附件保持私有'
            : 'Enter 发送 · Shift+Enter 换行 · 附件保持私有'

  // 切会话后草稿由 store 恢复：焦点跟随（旧 focusInput；触摸设备不打断滚动）。
  useEffect(() => {
    if (!touchInput()) inputRef.current?.focus({ preventScroll: true })
  }, [])

  const submit = (): void => {
    void send(draft).catch((error: unknown) => {
      setNotice({ text: error instanceof Error ? error.message : String(error), tone: 'error' })
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !touchInput() && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) {
      event.preventDefault()
      submit()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const dropped = transferredFiles(event.clipboardData)
    if (dropped.length === 0) return
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (text !== '') {
      const area = event.currentTarget
      area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end')
      setDraft(area.value)
    }
    void uploadFiles(dropped).catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
  }

  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    const dropped = transferredFiles(event.dataTransfer)
    if (dropped.length === 0) return
    event.preventDefault()
    setDragOver(false)
    void uploadFiles(dropped).catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
  }

  return (
    <form
      className={`blg-composer${dragOver ? ' blg-composer--drag' : ''}`}
      onSubmit={event => { event.preventDefault(); submit() }}
      onDragOver={event => {
        if ([...(event.dataTransfer?.types ?? [])].includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <label className="visually-hidden" htmlFor="blg-chat-input">给博客智能体的消息</label>
      <textarea
        id="blg-chat-input"
        ref={inputRef}
        rows={2}
        maxLength={8000}
        placeholder="分享想法，支持粘贴图片或文件…"
        value={draft}
        disabled={!identityReady}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => { composingRef.current = false; setDraft(event.currentTarget.value) }}
        onPaste={onPaste}
      />

      {files.length > 0 && (
        <div className="blg-files">
          {files.map(file => (
            <div className="blg-file-row" key={file.id}>
              {file.kind.startsWith('image/') && file.status === 'ready' && (
                <img
                  className="blg-file-thumb"
                  alt={file.name}
                  src={attachmentDownloadUrl(useConversationStore.getState().conversationId, file.id, true)}
                />
              )}
              <label className="blg-file-pick">
                <input
                  type="checkbox"
                  checked={file.selected}
                  disabled={file.status !== 'ready' || disabled}
                  aria-label={`发送 ${file.name}`}
                  onChange={event => {
                    void toggleAttachment(file.id, event.target.checked)
                      .catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
                  }}
                />
                {file.name}
              </label>
              <small className={file.status !== 'ready' ? 'blg-file-state blg-file-state--pending' : 'blg-file-state'}>
                {file.range !== undefined && file.range !== null
                  ? `${file.range.from}–${file.range.to} ${file.unit ?? ''}`
                  : file.message ?? ({ ready: '已就绪', failed: '解析失败', parsing: '解析中', uploading: '上传中' })[file.status] ?? file.status}
              </small>
              {/* 资料内容弹窗（旧 previewFile → #chat-file-dialog 的等价）。 */}
              <button
                type="button"
                className="btn btn--tiny"
                disabled={file.status !== 'ready' || conversationId === ''}
                onClick={() => setPreviewId(file.id)}
              >
                查看
              </button>
              <button
                type="button"
                className="btn btn--tiny btn--ghost"
                disabled={disabled}
                onClick={() => {
                  void removeAttachment(file.id)
                    .catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
                }}
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}

      {imageCapability !== null && (
        <p id="blg-image-capability" className={imageCapability.warning ? 'blg-image-capability blg-image-capability--warn' : 'blg-image-capability'} role="status">
          {imageCapability.message}
        </p>
      )}

      <div className="blg-compose-actions">
        <button
          type="button"
          className="blg-icon-button"
          aria-label="添加资料"
          title="添加资料"
          disabled={uploading || sending}
          onClick={() => fileInputRef.current?.click()}
        >
          <DshIcon name="paperclip" size={16} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif"
          hidden
          onChange={event => {
            void uploadFiles([...event.target.files ?? []])
              .catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
              .finally(() => { event.target.value = '' })
          }}
        />
        <label className="blg-check">
          <input type="checkbox" checked={research} onChange={event => setResearch(event.target.checked)} />
          联网查证
        </label>
        <span className="blg-spacer" />
        <ModelPicker />
        {stopVisible && (
          <button
            type="button"
            className="blg-icon-button blg-icon-button--primary"
            aria-label={stopping ? '正在停止回答' : '停止回答'}
            title="停止回答"
            disabled={stopping || pickerBusy}
            onClick={() => {
              void stopAnswer().catch((error: unknown) => onNotice(error instanceof Error ? error.message : String(error)))
            }}
          >
            <DshIcon name="stop" size={14} />
          </button>
        )}
        <button
          type="submit"
          className="blg-icon-button blg-icon-button--primary"
          aria-label="发送"
          title="发送"
          disabled={disabled}
        >
          <DshIcon name="send" size={16} />
        </button>
      </div>
      <small id="blg-chat-state" role="status">{stateText}</small>
      {(() => {
        const file = previewId === null ? undefined : files.find(item => item.id === previewId)
        if (previewId === null || file === undefined || conversationId === '') return null
        return (
          <FilePreviewDialog
            target={{ draftId: conversationId, id: file.id, name: file.name, kind: file.kind, range: file.range ?? null, variant: 'chat' }}
            onClose={() => setPreviewId(null)}
            onNotice={text => setNotice({ text, tone: 'error' })}
          />
        )
      })()}
    </form>
  )
}
