/**
 * AI 写作助手面板（旧 aside.assistant 的组件化）：回答 / 候选稿 / 来源 / 附件
 * 四页签 + 底部指令输入（预设：提纲/润色/续写、联网查证、停止、开始写作）。
 *
 * 旧码语义对齐：
 * - 任务状态行：状态字典 + 错误信息 + 「未完成原文查证」提示（旧 showJob）。
 * - 回答区：任务 thinking（busy 展开跟随、完成收起——旧 showThinking）+ Markdown
 *   正文 + 复制回答；回答与思考不接推理译文（旧码 assistant 侧无翻译）。
 * - 候选稿区：空态、生成时间与「保留的上一份候选」提示、正文、标签、设置摘要、
 *   冲突提示（baseRevision≠revision 时禁用应用）、字段勾选（应用全字段）、
 *   在光标处插入正文、删除候选稿（确认链）。
 * - 来源区：归属切换（最近任务/当前候选稿）+ 链接行（已抓取原文/仅搜索摘要）。
 * - 附件区：添加资料（上传逐份、20MiB 上限）、勾选=本次阅读、查看（弹窗）、移除。
 */
import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { RichText } from '@dsh-agents-group/web-common'
import { uploadAttachment } from '../../lib/api.ts'
import { safeHttpUrl } from '../../lib/labels.ts'
import {
  cancelTask,
  flush,
  getTextState,
  loadAttachments,
  loadTasks,
  removeWorkspaceAttachment,
  setTextState,
  startTask,
  toggleWorkspaceAttachment,
  applyProposal,
  discardProposal,
} from '../../workspace-controller.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useWorkspaceStore } from '../../stores/workspace.ts'
import type { ReactElement } from 'react'
import { FilePreviewDialog } from '../common/FilePreviewDialog.tsx'

type TabName = 'answer' | 'proposal' | 'sources' | 'attachments'

const JOB_STATUS_TEXT: Record<string, string> = {
  queued: '等待开始',
  running: '正在整理与写作',
  succeeded: '本次写作完成',
  failed: '本次写作未完成',
  cancelled: '已停止',
}

const INSTRUCTION_PRESETS: Array<{ label: string; text: string }> = [
  { label: '提纲', text: '请结合当前文章整理一份清晰的写作提纲。' },
  { label: '润色', text: '请润色当前文章，让表达更清晰，保留事实、代码和原有结构。' },
  { label: '续写', text: '请沿用当前文章的风格继续写作，先查证必要资料并保留来源。' },
]

const APPLY_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'title', label: '标题' },
  { key: 'text', label: '正文' },
  { key: 'tags', label: '标签' },
  { key: 'categories', label: '分类' },
  { key: 'allowComment', label: '评论开关' },
]

export function AssistantPanel(): ReactElement {
  const draft = useWorkspaceStore(state => state.draft)
  const job = useWorkspaceStore(state => state.job)
  const attachments = useWorkspaceStore(state => state.attachments)
  const selectedAttachments = useWorkspaceStore(state => state.selectedAttachments)
  const [tab, setTab] = useState<TabName>('answer')
  const [instruction, setInstruction] = useState('')
  const [research, setResearch] = useState(true)
  const [starting, setStarting] = useState(false)
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [checkedFields, setCheckedFields] = useState<string[]>(['title', 'text', 'tags', 'categories', 'allowComment'])
  const [previewTarget, setPreviewTarget] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)
  const thinkingFollowRef = useRef(true)

  const onNotice = (issue: unknown): void =>
    useSessionStore.getState().setNotice({ text: issue instanceof Error ? issue.message : String(issue), tone: 'error' })

  // 切稿回填指令（旧 instructions Map）。
  useEffect(() => {
    if (draft === null) return
    setInstruction(useWorkspaceStore.getState().instructions[draft.id] ?? '')
  }, [draft?.id, draft])

  // 首次挂载与草稿切换拉一次任务（旧 loadTasks 的入口时点）。
  useEffect(() => {
    if (draft === null) return
    void loadTasks().catch(onNotice)
  }, [draft?.id, draft])

  // 回答区跟随滚动（旧 showJob 的 follow 判定）。
  useEffect(() => {
    const box = answerRef.current
    if (box === null || !thinkingFollowRef.current) return
    box.scrollTop = box.scrollHeight
  }, [job?.text, job?.thinking])

  if (draft === null) {
    return (
      <aside className="blg-assistant" aria-label="AI 写作助手">
        <div className="blg-assistant-heading">
          <h2>AI 写作助手</h2>
          <p className="blg-muted" id="blg-assistant-context">选择文章后开始协作</p>
        </div>
      </aside>
    )
  }

  const proposal = draft.proposal ?? null
  const busyJob = job !== null && (job.status === 'queued' || job.status === 'running')
  const conflict = proposal !== null && proposal.baseRevision !== draft.revision
  const thinkingText = (job?.thinking ?? '').trim()
  const previewFile = previewTarget === null ? undefined : attachments.find(item => item.id === previewTarget)

  const start = async (): Promise<void> => {
    if (draft === null) return
    setStarting(true)
    try {
      await startTask({ instruction, research })
      setTab('answer')
    } catch (issue) {
      onNotice(issue)
    } finally {
      setStarting(false)
      const currentJob = useWorkspaceStore.getState().job
      if (currentJob !== null && !['queued', 'running'].includes(currentJob.status)) setStarting(false)
    }
  }

  const stop = async (): Promise<void> => {
    try {
      await cancelTask()
    } catch (issue) {
      onNotice(issue)
    }
  }

  const addAttachments = async (files: FileList): Promise<void> => {
    setUploadingAttachment(true)
    try {
      await flush()
      const draftId = useWorkspaceStore.getState().draft!.id
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error('单文件不能超过 20 MiB')
        await uploadAttachment(draftId, file.name, file)
      }
      if (useWorkspaceStore.getState().draft?.id === draftId) await loadAttachments()
    } catch (issue) {
      onNotice(issue)
    } finally {
      setUploadingAttachment(false)
      if (attachmentInputRef.current !== null) attachmentInputRef.current.value = ''
    }
  }

  const doApply = async (): Promise<void> => {
    if (proposal === null) return
    setApplyBusy(true)
    try {
      const valid = checkedFields.filter(key => Object.hasOwn(proposal.fields, key))
      await applyProposal(proposal.id, valid)
    } catch (issue) {
      onNotice(issue)
    } finally {
      setApplyBusy(false)
    }
  }

  const insertProposalText = (): void => {
    if (proposal === null) return
    // 跨组件插入请求：EditorPanel 在光标处消费（旧 insert(S.draft.proposal.fields.text)）。
    useWorkspaceStore.getState().setPendingInsert(proposal.fields.text)
  }

  const taskState = job === null
    ? ''
    : `${JOB_STATUS_TEXT[job.status] ?? job.status}${job.error ? ` · ${job.error.message}` : ''}${job.input.research === true && !(job.sources ?? []).some(source => source.fetched === true) ? ' · 未完成原文查证' : ''}`
  const jobText = job?.text ?? ''
  const answerHtml = draft.format === 'html' && jobText !== ''
    ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(jobText, { USE_PROFILES: { html: true } }) }} />
    : <RichText text={jobText} links codeCopy />

  const sourceScope = job !== null ? 'task' : proposal !== null ? 'proposal' : 'task'
  const sources = sourceScope === 'proposal' ? proposal?.sources ?? [] : job?.sources ?? []
  const sourceSummary = sources.length > 0
    ? `${sources.length} 条来源 · ${sources.filter(item => item.fetched === true).length} 条已读原文，${sources.filter(item => item.fetched !== true).length} 条仅搜索摘要`
    : '尚无本次查证来源；启用联网后，真实链接将在这里显示。'

  return (
    <aside className="blg-assistant" aria-label="AI 写作助手">
      <div className="blg-assistant-heading">
        <div>
          <h2>AI 写作助手</h2>
          <p className="blg-muted" id="blg-assistant-context" title={draft.title === '' ? '未命名草稿' : draft.title}>{draft.title === '' ? '未命名草稿' : draft.title}</p>
        </div>
        <span className="blg-badge">候选经确认后应用</span>
      </div>
      <div className="blg-assistant-tabs" role="tablist" aria-label="写作结果与资料">
        {(['answer', 'proposal', 'sources', 'attachments'] as const).map(name => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name === 'answer' ? '回答' : name === 'proposal' ? `候选稿 ${proposal === null ? 0 : 1}` : name === 'sources' ? '来源' : `附件 ${attachments.length}`}
          </button>
        ))}
      </div>
      {taskState !== '' && <div role="status" aria-live="polite">{taskState}</div>}
      <div className="blg-assistant-panels">
        {tab === 'answer' && (
          <section ref={answerRef} className="blg-assistant-panel" role="tabpanel" aria-label="回答">
            {jobText === '' && !busyJob && (
              <div className="blg-panel-empty">
                <h3>与当前文章一起写作</h3>
                <p>说清这次想调整什么，候选稿是 AI 提出的修改建议，采用后才保存到博客草稿。查证链接可随时从「来源」查看。</p>
              </div>
            )}
            {thinkingText !== '' && (
              <details className="blg-thinking" open={busyJob} onToggle={event => { thinkingFollowRef.current = (event.target as HTMLDetailsElement).open }}>
                <summary><span className="blg-thinking-title">思考过程</span></summary>
                <pre className="blg-thinking-body">{thinkingText}</pre>
              </details>
            )}
            {jobText !== '' && <div className="blg-prose md blg-answer">{answerHtml}</div>}
            {jobText !== '' && (
              <button
                type="button"
                className="btn btn--tiny"
                onClick={() => {
                  void navigator.clipboard.writeText(jobText).then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1800)
                  }).catch((issue: unknown) => onNotice(issue))
                }}
              >
                {copied ? '已复制' : '复制回答'}
              </button>
            )}
          </section>
        )}
        {tab === 'proposal' && (
          <section className="blg-assistant-panel" role="tabpanel" aria-label="候选稿">
            {proposal === null ? (
              <div className="blg-panel-empty">
                <h3>还没有候选稿</h3>
                <p>让 AI 起草或修改后，先在这里预览，再选择应用到文章。</p>
              </div>
            ) : (
              <>
                <div className="blg-prose md">
                  <h3>候选稿</h3>
                  <p className="blg-muted">生成于 {new Date(proposal.createdAt).toLocaleString('zh-CN')}</p>
                  <h2>{proposal.fields.title}</h2>
                  <ProseHtml proposal={proposal} format={draft.format} />
                  <p>标签：{proposal.fields.tags.join('、')}</p>
                </div>
                {conflict && <p className="blg-warning">生成后原文已改变。请比较后手动合并，当前稿不会被覆盖。</p>}
                <div className="blg-proposal-actions">
                  <div className="blg-checks">
                    {APPLY_FIELDS.map(field => (
                      <label key={field.key}>
                        <input
                          type="checkbox"
                          checked={checkedFields.includes(field.key)}
                          onChange={event => {
                            setCheckedFields(current => event.target.checked
                              ? [...current, field.key]
                              : current.filter(key => key !== field.key))
                          }}
                        />
                        {field.label}
                      </label>
                    ))}
                  </div>
                  <button type="button" className="btn btn--primary" disabled={conflict || applyBusy} onClick={() => { void doApply() }}>应用选定字段</button>
                  <button type="button" className="btn" onClick={insertProposalText}>在光标处插入正文</button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={applyBusy}
                    onClick={() => {
                      if (!window.confirm('删除当前候选稿？当前正文和博客文章会保留。')) return
                      void discardProposal(proposal.id).catch(onNotice)
                    }}
                  >
                    删除候选稿
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {tab === 'sources' && (
          <section className="blg-assistant-panel" role="tabpanel" aria-label="来源">
            <p id="blg-source-summary" className="blg-muted">{sourceSummary}</p>
            <div>
              {sources.length === 0 && <p className="blg-muted">尚无查证来源</p>}
              {sources.map((source, index) => {
                const href = safeHttpUrl(source.url)
                return (
                  <div key={`${source.url}-${index}`} className="blg-source-row">
                    {href !== null
                      ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title ?? source.url}</a>
                      : <span>{source.title ?? source.url}</span>}
                    <small>{source.fetched === true ? '已抓取原文' : '仅搜索摘要'}</small>
                  </div>
                )
              })}
            </div>
          </section>
        )}
        {tab === 'attachments' && (
          <section className="blg-assistant-panel" role="tabpanel" aria-label="附件">
            <div className="blg-attachment-head">
              <div>
                <h3>文章参考附件</h3>
                <p className="blg-muted">选中的资料供本次模型阅读</p>
              </div>
              <button type="button" className="btn btn--tiny" disabled={uploadingAttachment} onClick={() => attachmentInputRef.current?.click()}>
                {uploadingAttachment ? '资料处理中…' : '添加资料'}
              </button>
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                accept=".txt,.md,.csv,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif"
                hidden
                onChange={event => {
                  if (event.target.files !== null && event.target.files.length > 0) void addAttachments(event.target.files)
                  else event.target.value = ''
                }}
              />
            </div>
            <div>
              {attachments.map(file => (
                <div key={file.id} className="blg-file-row">
                  <label className="blg-file-pick">
                    <input
                      type="checkbox"
                      checked={selectedAttachments.includes(file.id)}
                      disabled={file.status !== 'ready' || (file.partial === true && file.range === undefined)}
                      aria-label={`本次阅读 ${file.name}`}
                      onChange={event => {
                        void toggleWorkspaceAttachment(file.id, event.target.checked).catch(onNotice)
                      }}
                    />
                    {file.name}
                  </label>
                  <small className={file.status !== 'ready' ? 'blg-file-state blg-file-state--pending' : 'blg-file-state'}>
                    {file.status === 'ready'
                      ? file.partial === true
                        ? `部分解析${file.range !== undefined && file.range !== null ? ` · ${file.range.from}–${file.range.to} ${file.unit ?? ''}` : ''}`
                        : '图片可阅读'
                      : file.message ?? file.status}
                  </small>
                  <button type="button" className="btn btn--tiny" disabled={file.status !== 'ready'} onClick={() => setPreviewTarget(file.id)}>查看</button>
                  <button type="button" className="btn btn--tiny btn--ghost" onClick={() => { void removeWorkspaceAttachment(file.id).catch(onNotice) }}>移除</button>
                </div>
              ))}
              {attachments.length === 0 && <p className="blg-muted">还没有附件。支持文档、PDF 和图片；资料保持私有。</p>}
            </div>
          </section>
        )}
      </div>
      <div className="blg-assistant-compose">
        <div className="blg-compose-heading">
          <label htmlFor="blg-instruction">这次需要什么帮助？</label>
          <div className="blg-instruction-presets">
            {INSTRUCTION_PRESETS.map(preset => (
              <button key={preset.label} type="button" onClick={() => { setInstruction(preset.text); setTextState(draft.id, { ...(getTextState(draft.id) ?? { title: draft.title, text: draft.text, slug: draft.slug, tags: draft.tags.join('，'), allowComment: draft.allowComment ?? true, categories: [...draft.categories] }), text: draft.text }); useWorkspaceStore.getState().stashInstruction(draft.id, preset.text) }}>
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          id="blg-instruction"
          rows={3}
          maxLength={8000}
          placeholder="结合当前文章，告诉 AI 想补充或修改什么…"
          value={instruction}
          onChange={event => { setInstruction(event.target.value); useWorkspaceStore.getState().stashInstruction(draft.id, event.target.value) }}
        />
        <div className="blg-ai-actions">
          <label className="blg-check">
            <input type="checkbox" checked={research} onChange={event => setResearch(event.target.checked)} />
            联网查证
          </label>
          <span className="blg-spacer" />
          {busyJob && <button type="button" className="btn" onClick={() => { void stop() }}>停止</button>}
          <button type="button" className="btn btn--primary" disabled={starting || busyJob} onClick={() => { void start() }}>开始写作</button>
        </div>
      </div>
      {previewFile !== undefined && (
        <FilePreviewDialog
          target={{ draftId: draft.id, id: previewFile.id, name: previewFile.name, kind: previewFile.kind, range: previewFile.range ?? null, variant: 'writing' }}
          onClose={() => setPreviewTarget(null)}
          onNotice={text => useSessionStore.getState().setNotice({ text, tone: 'error' })}
        />
      )}
    </aside>
  )
}

/** 候选稿正文（HTML 格式走 DOMPurify；Markdown 走受控渲染）。 */
function ProseHtml({ proposal, format }: { proposal: { fields: { text: string } }; format: string }): ReactElement {
  if (format === 'html') {
    return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(proposal.fields.text, { USE_PROFILES: { html: true } }) }} />
  }
  return <RichText text={proposal.fields.text} links codeCopy />
}
