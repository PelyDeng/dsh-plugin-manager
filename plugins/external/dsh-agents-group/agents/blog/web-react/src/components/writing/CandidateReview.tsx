/**
 * 候选稿对照视图（旧 #candidate-review + showCandidate/selectReview 的组件化）：
 * 「修改后全文」与「修改对比」双页签；对比段=标题/标签/文章设置的增删行 + 正文
 * 行级 diff（articleDiff，绿增红删——手账化重绘走 --bt-mint/--bt-coral 语义槽）。
 *
 * 操作按钮的可用性与旧码一致：只有「对照稿=当前待发布稿且基于当前 revision」时
 * 「采用并编辑」「预览并发布」可用；历史快照给「查看最新稿」；「删除候选稿」只对
 * 当前稿开放（走 discard-proposal 的确认链）。
 */
import { useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { RichText } from '@dsh-agents-group/web-common'
import { articleDiff } from '../../lib/article-diff.ts'
import { applyProposal, discardProposal, preparePublish, settingSummary } from '../../workspace-controller.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useWorkspaceStore } from '../../stores/workspace.ts'
import type { Proposal } from '../../lib/types.ts'
import type { ReactElement } from 'react'

function ProseBody({ format, text }: { format: string | undefined; text: string }): ReactElement {
  if (format === 'html') {
    return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text, { USE_PROFILES: { html: true } }) }} />
  }
  return <RichText text={text} links codeCopy />
}

export function CandidateReview(): ReactElement | null {
  const review = useWorkspaceStore(state => state.review)
  const draft = useWorkspaceStore(state => state.draft)
  const [view, setView] = useState<'article' | 'changes'>('article')
  const [busy, setBusy] = useState(false)
  const onNotice = (issue: unknown): void =>
    useSessionStore.getState().setNotice({ text: issue instanceof Error ? issue.message : String(issue), tone: 'error' })

  const proposal = review
  // diff 的对比基准（旧 showCandidate 的 before/comparison 判定）。
  const comparison = useMemo(() => {
    if (proposal === null || draft === null) return null
    return proposal.baseRevision === draft.revision ? draft : draft
  }, [proposal, draft])

  if (proposal === null || draft === null || comparison === null) return null

  const current = proposal.id === draft.proposal?.id
  const compatible = current && proposal.baseRevision === draft.revision
  const stateLabel = current ? '本次修改 · 尚未发布' : '历史修改快照 · 只读'
  const note = compatible
    ? '这里展示本次修改后的全文。可先查看修改对比，确认后直接发布；如需继续调整，点击「采用并编辑」。'
    : current
      ? '这份候选生成后，编辑稿已有变化。请对比后合并，避免覆盖新修改。'
      : '这是你点击的那次修改，已不是当前待发布稿。可查看快照，或打开最新稿继续操作。'

  const before = proposal.baseRevision === draft.revision ? draft : null

  const runApply = async (): Promise<void> => {
    setBusy(true)
    try {
      await applyProposal(proposal.id, ['title', 'text', 'tags', 'categories', 'allowComment'])
    } catch (issue) {
      onNotice(issue)
    } finally {
      setBusy(false)
    }
  }

  const runDiscard = async (): Promise<void> => {
    if (!window.confirm('删除当前候选稿？当前正文和博客文章会保留。')) return
    setBusy(true)
    try {
      await discardProposal(proposal.id)
    } catch (issue) {
      onNotice(issue)
    } finally {
      setBusy(false)
    }
  }

  const runPublish = async (): Promise<void> => {
    setBusy(true)
    try {
      await preparePublish()
    } catch (issue) {
      onNotice(issue)
    } finally {
      setBusy(false)
    }
  }

  const openLatest = async (): Promise<void> => {
    setBusy(true)
    try {
      const { openDraft } = await import('../../workspace-controller.ts')
      await openDraft(draft.id, { latest: true })
    } catch (issue) {
      onNotice(issue)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="blg-review" aria-label="本次文章修改">
      <div className="blg-review-heading">
        <span className="blg-review-badge">{stateLabel}</span>
        <h1>{proposal.fields.title}</h1>
        <p className="blg-muted">{note}</p>
      </div>
      <div className="blg-tabs" role="group" aria-label="修改预览">
        <button type="button" aria-pressed={view === 'article'} onClick={() => setView('article')}>修改后全文</button>
        <button type="button" aria-pressed={view === 'changes'} onClick={() => setView('changes')}>修改对比</button>
      </div>
      <div className="blg-review-scroll">
        <article className="blg-prose md" hidden={view !== 'article'}>
          <ProseBody format={proposal.before?.format ?? draft.format} text={proposal.fields.text} />
          <p className="blg-review-tags">标签：{proposal.fields.tags.join('、') || '无'}</p>
          <p>{settingSummary(proposal.fields)}</p>
        </article>
        <section className="blg-review-changes" aria-label="文章修改对比" hidden={view !== 'changes'}>
          <ChangesView proposal={proposal} before={before} comparison={comparison} />
        </section>
      </div>
      <footer className="blg-review-actions">
        <button type="button" className="btn" onClick={() => useWorkspaceStore.getState().setReview(null)}>返回编辑稿</button>
        {!current && <button type="button" className="btn" disabled={busy} onClick={() => { void openLatest() }}>查看最新稿</button>}
        {current && <button type="button" className="btn btn--danger" disabled={busy} onClick={() => { void runDiscard() }}>删除候选稿</button>}
        <span className="blg-spacer" />
        <button type="button" className="btn" disabled={!compatible || busy} onClick={() => { void runApply() }}>采用并编辑</button>
        <button type="button" className="btn btn--primary" disabled={!compatible || busy} onClick={() => { void runPublish() }}>预览并发布</button>
      </footer>
    </section>
  )
}

/** 修改对比段（旧 showCandidate 的 add(...) 系列行）。 */
function ChangesView({ proposal, before, comparison }: {
  proposal: Proposal
  before: { title: string; text: string; tags: string[]; categories: number[]; allowComment?: boolean | undefined } | null
  comparison: { title: string; text: string; tags: string[]; categories: number[]; allowComment?: boolean | undefined }
}): ReactElement {
  const rows: Array<{ tag: 'h3' | 'p' | 'pre'; text: string; kind?: 'removed' | 'added' | 'legend' | undefined }> = []
  const add = (tag: 'h3' | 'p' | 'pre', text: string, kind?: 'removed' | 'added' | 'legend'): void => {
    rows.push({ tag, text, kind })
  }

  add('p', before !== null
    ? '对比本次修改前的文章；绿色为新增，红色为删除。'
    : '历史修改前版本未保存，以下与当前编辑稿比较；绿色为新增，红色为删除。', 'legend')

  if (comparison.title !== proposal.fields.title) {
    add('h3', '标题')
    add('p', `− ${comparison.title}`, 'removed')
    add('p', `＋ ${proposal.fields.title}`, 'added')
  }
  const removedTags = comparison.tags.filter(tag => !proposal.fields.tags.includes(tag))
  const addedTags = proposal.fields.tags.filter(tag => !comparison.tags.includes(tag))
  if (removedTags.length > 0 || addedTags.length > 0) {
    add('h3', '标签')
    if (removedTags.length > 0) add('p', `− ${removedTags.join('、')}`, 'removed')
    if (addedTags.length > 0) add('p', `＋ ${addedTags.join('、')}`, 'added')
  }
  add('h3', '正文')
  if (JSON.stringify(comparison.categories) !== JSON.stringify(proposal.fields.categories) || comparison.allowComment !== proposal.fields.allowComment) {
    add('h3', '文章设置')
    add('p', `− ${settingSummary(comparison)}`, 'removed')
    add('p', `＋ ${settingSummary(proposal.fields)}`, 'added')
  }
  const diff = articleDiff(comparison.text, proposal.fields.text)
  if (diff.every(row => row.kind === 'same')) add('p', '正文未修改', 'legend')
  else {
    for (const row of diff) {
      if (row.kind === 'same') add('p', '… 未改动内容 …', 'legend')
      else add('pre', row.lines.map(line => (row.kind === 'added' ? '＋ ' : '− ') + line).join('\n'), row.kind)
    }
  }

  return (
    <>
      {rows.map((row, index) => {
        const className = row.kind === undefined ? undefined : `blg-review-diff blg-review-diff--${row.kind}`
        switch (row.tag) {
          case 'h3': return <h3 key={index}>{row.text}</h3>
          case 'p': return <p key={index} className={className}>{row.text}</p>
          case 'pre': return <pre key={index} className={className}>{row.text}</pre>
        }
      })}
    </>
  )
}
