/**
 * 编辑器面板（旧 #editor 的组件化）：写作方式切换（AI/手动）、保存状态、
 * 文章设置与发布记录入口、标题、格式工具条（插入/图片上传）、原文-分屏-预览、
 * 字数与预览渲染（Markdown 受控渲染；HTML 原文走 DOMPurify 白名单）、
 * 保存/发布/发布记录底栏。
 *
 * 旧码语义对齐：受控输入变化 = markChanged()（900ms 去抖自动保存）；HTML 格式的
 * 插入工具直接拒绝（避免隐式转换）；切换写作方式不转换原文；预览不执行 HTML 脚本
 * （Markdown 路径本就不解析 HTML，HTML 路径经 DOMPurify 白名单）。
 */
import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { RichText } from '@dsh-agents-group/web-common'
import { createDraft, flush, getTextState, markChanged, preparePublish, setTextState, updateCursor, uploadAndInsertImage } from '../../workspace-controller.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useWorkspaceStore } from '../../stores/workspace.ts'
import type { ReactElement, ClipboardEvent as ReactClipboardEvent } from 'react'
import { MetadataDialog } from './MetadataDialog.tsx'
import { OperationsDialog } from './OperationsDialog.tsx'

const SAVE_STATE_TEXT: Record<string, string> = {
  saved: '已保存到博客草稿',
  'native-published': '博客已发布版本',
  legacy: '旧版内容 · 保存时自动转为博客草稿',
  dirty: '有未保存修改',
  saving: '保存中…',
  partial: '还有修改待保存',
  error: '保存失败 · 内容仍在编辑器',
}

/** 插入工具的文本模板（旧 data-insert 字典）。 */
function insertSnippet(kind: string, selected: string): string {
  switch (kind) {
    case 'heading': return `\n## ${selected === '' ? '小标题' : selected}\n`
    case 'bold': return `**${selected === '' ? '重点' : selected}**`
    case 'italic': return `*${selected === '' ? '文字' : selected}*`
    case 'code': return `\n\`\`\`text\n${selected === '' ? '代码' : selected}\n\`\`\`\n`
    case 'link': return `[${selected === '' ? '链接文字' : selected}](https://)`
    case 'list': return `\n- ${selected === '' ? '列表项' : selected}\n`
    default: return ''
  }
}

export function EditorPanel(): ReactElement {
  const draft = useWorkspaceStore(state => state.draft)
  const review = useWorkspaceStore(state => state.review)
  const saveState = useWorkspaceStore(state => state.saveState)
  const mode = useWorkspaceStore(state => state.mode)
  const editorView = useWorkspaceStore(state => state.editorView)
  const setMode = useWorkspaceStore(state => state.setMode)
  const setEditorView = useWorkspaceStore(state => state.setEditorView)
  const metadataReady = useWorkspaceStore(state => state.metadataReady)

  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [slug, setSlug] = useState('')
  const [tags, setTags] = useState('')
  const [allowComment, setAllowComment] = useState(true)
  const [selectedCategories, setSelectedCategories] = useState<number[]>([])
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [wordCount, setWordCount] = useState(0)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const onNotice = (issue: unknown): void =>
    useSessionStore.getState().setNotice({ text: issue instanceof Error ? issue.message : String(issue), tone: 'error' })

  // 草稿切换时从镜像回填（旧 fill 的编辑器装配段）。
  useEffect(() => {
    if (draft === null) return
    const state = getTextState(draft.id)
    setTitle(state?.title ?? draft.title)
    setText(state?.text ?? draft.text)
    setSlug(state?.slug ?? draft.slug)
    setTags(state?.tags ?? draft.tags.join('，'))
    setAllowComment(state?.allowComment ?? draft.allowComment ?? true)
    setSelectedCategories(state?.categories ?? [...draft.categories])
    setWordCount((state?.text ?? draft.text).length)
  }, [draft])

  // 「在光标处插入正文」（AssistantPanel 的跨组件请求；旧 insert 的消费端）。
  const pendingInsert = useWorkspaceStore(state => state.pendingInsert)
  useEffect(() => {
    if (pendingInsert === null || pendingInsert === '') return
    const area = textRef.current
    if (area === null) return
    area.focus()
    area.setRangeText(pendingInsert, area.selectionStart, area.selectionEnd, 'end')
    setText(area.value)
    updateCursor({ start: area.selectionStart, end: area.selectionEnd })
    const current = getTextState(draft?.id ?? '')
    if (current !== undefined && draft !== null) {
      setTextState(draft.id, { ...current, text: area.value })
      markChanged()
    }
    setWordCount(area.value.length)
    useWorkspaceStore.getState().setPendingInsert(null)
  }, [pendingInsert, draft])

  // 空态（旧 #empty）；候选稿对照在场时编辑器隐藏（旧 showCandidate 的 editor.hidden）。
  if (draft === null) {
    return (
      <div className="blg-empty">
        <span className="blg-welcome-symbol" aria-hidden="true">✎</span>
        <h2>从一个想法开始</h2>
        <p>新建博客草稿，或从文章库打开已有文章。</p>
        <button type="button" className="btn btn--primary" onClick={() => { void createDraft().catch(onNotice) }}>新建第一篇草稿</button>
      </div>
    )
  }
  if (review !== null) return <></>

  const sync = (patch: Partial<{ title: string; text: string; slug: string; tags: string; allowComment: boolean; categories: number[] }>): void => {
    const state = getTextState(draft.id)
    if (state === undefined) return
    setTextState(draft.id, { ...state, ...patch })
    markChanged()
  }

  const insertAtCursor = (snippet: string): void => {
    const area = textRef.current
    if (area === null) return
    area.focus()
    area.setRangeText(snippet, area.selectionStart, area.selectionEnd, 'end')
    setText(area.value)
    updateCursor({ start: area.selectionStart, end: area.selectionEnd })
    sync({ text: area.value })
    setWordCount(area.value.length)
  }

  const doInsert = (kind: string): void => {
    if (draft.format === 'html') {
      onNotice(new Error('当前是 HTML 原文，请直接编辑标签，避免隐式转换格式'))
      return
    }
    const area = textRef.current
    const selected = area === null ? '' : area.value.slice(area.selectionStart, area.selectionEnd)
    insertAtCursor(insertSnippet(kind, selected))
  }

  const uploadImage = async (file: File): Promise<void> => {
    try {
      const snippet = await uploadAndInsertImage(file)
      insertAtCursor(snippet)
    } catch (issue) {
      onNotice(issue)
    }
  }

  const startPublish = async (): Promise<void> => {
    try {
      await flush()
      await preparePublish()
    } catch (issue) {
      onNotice(issue)
    }
  }

  const formatLabel = draft.format === 'html' ? 'HTML 原文 · 原格式保留' : 'Markdown 原文'
  const saveText = SAVE_STATE_TEXT[saveState] ?? saveState
  const remoteDeleted = draft.remote?.deleted === true

  return (
    <div className="blg-editor" id="blg-editor">
      <div className="blg-editor-top">
        <div className="blg-tabs" role="group" aria-label="写作方式">
          <button type="button" aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}>AI 辅助写作</button>
          <button type="button" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>自己写作</button>
        </div>
        <span role="status">{saveText}</span>
        <button type="button" className="btn btn--tiny" onClick={() => setMetadataOpen(true)}>文章设置</button>
      </div>
      {remoteDeleted && (
        <p className="blg-muted" role="status">博客原文已删除。这里保留的是工作台副本，可继续编辑；如需重新发布，请新建文章。</p>
      )}
      <label className="visually-hidden" htmlFor="blg-title">文章标题</label>
      <input
        id="blg-title"
        className="blg-title-input"
        placeholder="给这篇文章起个标题"
        maxLength={300}
        value={title}
        onChange={event => { setTitle(event.target.value); sync({ title: event.target.value }) }}
      />
      <div className="blg-document-summary">
        <span>{formatLabel}</span>
        <span>{wordCount.toLocaleString()} 字符</span>
      </div>
      <div className="blg-formatbar">
        <div className="blg-format-tools" aria-label="格式工具">
          <button type="button" title="插入标题" onClick={() => doInsert('heading')}>H₂</button>
          <button type="button" title="加粗" onClick={() => doInsert('bold')}>B</button>
          <button type="button" title="斜体" onClick={() => doInsert('italic')}>I</button>
          <button type="button" title="代码块" onClick={() => doInsert('code')}>&lt;/&gt;</button>
          <button type="button" title="链接" onClick={() => doInsert('link')}>链接</button>
          <button type="button" title="列表" onClick={() => doInsert('list')}>列表</button>
          <button type="button" onClick={() => imageInputRef.current?.click()}>插入图片</button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={event => {
              const file = event.target.files?.[0]
              if (file !== undefined) void uploadImage(file)
              event.target.value = ''
            }}
          />
        </div>
        <div className="blg-tabs blg-tabs--compact" role="group" aria-label="编辑视图">
          {(['source', 'split', 'preview'] as const).map(viewMode => (
            <button key={viewMode} type="button" aria-pressed={editorView === viewMode} onClick={() => setEditorView(viewMode)}>
              {viewMode === 'source' ? '原文' : viewMode === 'split' ? '分屏' : '预览'}
            </button>
          ))}
        </div>
      </div>
      <div className={`blg-document blg-document--${editorView}`}>
        <textarea
          ref={textRef}
          aria-label="文章原文"
          spellCheck={false}
          placeholder="写下正文，或在右侧告诉 AI 你想写什么…"
          value={text}
          onSelect={event => {
            const area = event.currentTarget
            updateCursor({ start: area.selectionStart, end: area.selectionEnd })
          }}
          onChange={event => {
            setText(event.target.value)
            setWordCount(event.target.value.length)
            updateCursor({ start: event.target.selectionStart, end: event.target.selectionEnd })
            sync({ text: event.target.value })
          }}
          onPaste={(event: ReactClipboardEvent<HTMLTextAreaElement>) => {
            // 粘贴文件不进正文（图片走「插入图片」通道）；文本走浏览器默认。
            if (event.clipboardData.files.length > 0) event.preventDefault()
          }}
        />
        {editorView !== 'source' && (
          <article className="blg-prose md" aria-label="文章预览">
            {draft.format === 'html'
              ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text, { USE_PROFILES: { html: true } }) }} />
              : <RichText text={text} links codeCopy />}
          </article>
        )}
      </div>
      <p className="blg-preview-note">预览不执行 HTML 脚本；主题短代码的最终样式以博客为准。切换写作方式不会转换原文格式。</p>
      <footer className="blg-editor-footer">
        <button type="button" className="btn" onClick={() => { void flush().catch(onNotice) }}>保存</button>
        <button type="button" className="btn" onClick={() => setOperationsOpen(true)}>发布记录</button>
        <span className="blg-spacer" />
        <button type="button" className="btn btn--primary" onClick={() => { void startPublish() }}>预览并发布</button>
      </footer>

      <MetadataDialog
        open={metadataOpen}
        onClose={() => setMetadataOpen(false)}
        draft={draft}
        metadataReady={metadataReady}
        title={title}
        slug={slug}
        tags={tags}
        allowComment={allowComment}
        selectedCategories={selectedCategories}
        onPatch={patch => {
          if (patch.slug !== undefined) setSlug(patch.slug)
          if (patch.tags !== undefined) setTags(patch.tags)
          if (patch.allowComment !== undefined) setAllowComment(patch.allowComment)
          if (patch.categories !== undefined) setSelectedCategories(patch.categories)
          sync(patch)
        }}
      />
      <OperationsDialog open={operationsOpen} onClose={() => setOperationsOpen(false)} />
    </div>
  )
}
