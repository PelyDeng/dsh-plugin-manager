/**
 * 管理弹窗（旧 web/management.js initManagement 的组件化重写）：分类 / 标签 /
 * 评论三域。
 *
 * 旧码语义对齐：
 * - kind 切换与关闭前的 canLeave（脏表单 window.confirm 确认）；
 * - 分类：全量分页读取（readTaxonomy）后本地推导层级——面包屑导航进入子分类、
 *   「编辑当前分类」、表格行（名称带路径/描述、子分类入口、slug、文章数、编辑）；
 * - 标签：标签云（字号按 sqrt(count/max)），点击编辑；本地搜索与排序（默认/名称/文章数）；
 * - 评论：服务端分页（page/status/cid 筛选），行内编辑/删除/回复；
 * - 编辑器：读取 manage-get → 表单（name、slug、父分类、描述、默认分类[默认项禁用]），
 *   提交一律走 prepare 预览（manage-prepare → 确认弹窗：摘要 pre + 确认执行 +
 *   核对执行结果 + 关闭）；删除按钮对默认分类禁用（提示先换默认分类）；
 * - 确认成功后 resetEditor + 重载列表 + 刷新文章设置元数据（旧 refresh=loadMetadata）；
 *   失败/无回执给「核对执行结果」（reconcile），提示勿重复创建。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { errorTextOf } from '@dsh-agents-group/web-common'
import { api } from '../../lib/api.ts'
import { categoryPath, managementSummary, parentChoices, readTaxonomy, type ManagementPreview, type TaxonomyItem } from '../../lib/management.ts'
import { loadMetadata } from '../../workspace-controller.ts'
import type { CommentRow, ManageRecord } from '../../lib/management-types.ts'
import type { ReactElement } from 'react'
import { Modal } from '../common/Modal.tsx'

type Kind = 'category' | 'tag' | 'comment'

const KIND_LABEL: Record<Kind, string> = { category: '分类', tag: '标签', comment: '评论' }
const KIND_SUBTITLE: Record<Kind, string> = {
  category: '按层级整理内容，让每一篇文章各有所属。',
  tag: '用标签串联主题，快速找到并整理你的内容。',
  comment: '查看读者反馈，管理评论与回复。',
}
const STATUS_LABEL: Record<string, string> = { all: '全部状态', approved: '已批准（公开）', waiting: '待审核', spam: '垃圾评论' }

export function ManagementDialog({ open, initialKind = 'category', articleCid = null, onClose }: {
  open: boolean
  initialKind?: Kind
  /** 文章设置入口的「管理此文章的评论」：预置文章 ID 过滤。 */
  articleCid?: number | null
  onClose: () => void
}): ReactElement {
  const [kind, setKind] = useState<Kind>(initialKind)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [cidText, setCidText] = useState(articleCid === null ? '' : String(articleCid))
  const [sort, setSort] = useState<'original' | 'name' | 'count'>('original')
  const [page, setPage] = useState(1)
  const [parent, setParent] = useState(0)

  const [items, setItems] = useState<TaxonomyItem[] | null>(null)
  const [comments, setComments] = useState<CommentRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [editing, setEditing] = useState<ManageRecord | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const [confirming, setConfirming] = useState<(ManagementPreview & { id: string; title: string; nonce?: string }) | null>(null)
  const [confirmMessage, setConfirmMessage] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [confirmBusy, setConfirmBusy] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
  const loadEpoch = useRef(0)

  const canLeave = (): boolean => !dirty || window.confirm('当前修改尚未预览，确定放弃这些修改吗？')

  const resetEditor = (): void => {
    setEditing(null)
    setSelectedId(null)
    setDirty(false)
  }

  const load = async (targetKind: Kind = kind, targetPage = page): Promise<void> => {
    const current = ++loadEpoch.current
    setLoading(true)
    setItems(null)
    setError('')
    try {
      if (targetKind === 'comment') {
        const result = await api.manageList({
          kind: 'comment',
          page: targetPage,
          query,
          status,
          ...(cidText === '' ? {} : { cid: Number(cidText) }),
        })
        if (current !== loadEpoch.current) return
        setComments((result.items ?? []) as unknown as CommentRow[])
        setHasMore(result.hasMore === true)
      } else {
        const result = await readTaxonomy(
          async (action, args) => api.manageList(args) as unknown as { items?: TaxonomyItem[]; hasMore?: boolean },
          targetKind,
          () => current === loadEpoch.current,
        )
        if (result === null) return
        if (current !== loadEpoch.current) return
        setItems(result)
        setParent(value => (result.some(item => item.id === value) || value === 0 ? value : 0))
      }
    } catch (issue) {
      if (current !== loadEpoch.current) return
      setError(errorTextOf(issue))
    } finally {
      if (current === loadEpoch.current) setLoading(false)
    }
  }

  // 打开/换域时装载。
  useEffect(() => {
    if (!open) return
    void load(kind, page)
    // eslint 不可用的最小依赖面：open/kind/page 变化触发装载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, page])

  const switchKind = (next: Kind): void => {
    if (next === kind) return
    if (!canLeave()) return
    setKind(next)
    setPage(1)
    setParent(0)
    setQuery('')
    setCidText(articleCid === null ? '' : String(articleCid))
    setStatus('all')
    resetEditor()
  }

  const requestClose = (): void => {
    if (!canLeave()) return
    onClose()
  }

  // ── 分类/标签的本地过滤与排序（旧 renderTaxonomy 的 visible 判定）──────────
  const visibleTaxonomy = useMemo(() => {
    if (items === null || kind === 'comment') return []
    const q = query.trim().toLocaleLowerCase()
    const byId = new Map(items.map(item => [item.id, item]))
    const children = new Map<number, number>()
    for (const item of items) children.set(item.parent ?? 0, (children.get(item.parent ?? 0) ?? 0) + 1)
    let visible = items.filter(item => {
      if (q !== '') return [item.name, item.slug].some(value => String(value ?? '').toLocaleLowerCase().includes(q))
      if (kind === 'tag') return true
      return item.parent === parent || (parent === 0 && (item.parent ?? 0) !== 0 && !byId.has(item.parent ?? 0))
    })
    if (sort === 'name') visible = [...visible].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    if (sort === 'count') visible = [...visible].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    return visible
  }, [items, kind, query, parent, sort])

  const childrenOf = useMemo(() => {
    const map = new Map<number, number>()
    for (const item of items ?? []) map.set(item.parent ?? 0, (map.get(item.parent ?? 0) ?? 0) + 1)
    return map
  }, [items])

  const editTaxonomy = async (id: number | null, initial: Partial<TaxonomyItem> = {}): Promise<void> => {
    if (editorBusy || !canLeave()) return
    setEditorBusy(true)
    setDirty(false)
    setSelectedId(id)
    setError('')
    try {
      if (id !== null) {
        const record = await api.manageGet({ kind, id })
        const item = (record.item ?? {}) as Partial<TaxonomyItem>
        setEditing({
          kind,
          id,
          isNew: false,
          ...(record.version === undefined ? {} : { version: record.version }),
          values: {
            name: String(item.name ?? ''),
            slug: String(item.slug ?? ''),
            description: String(item.description ?? ''),
            parent: item.parent ?? 0,
          },
          count: item.count ?? 0,
          defaultCategory: record.impact?.defaultCategory === true,
        })
      } else {
        setEditing({
          kind,
          id: null,
          isNew: true,
          values: { name: '', slug: '', description: '', parent: initial.parent ?? parent },
          count: 0,
          defaultCategory: false,
        })
      }
    } catch (issue) {
      setError(errorTextOf(issue))
    } finally {
      setEditorBusy(false)
    }
  }

  const editComment = async (row: CommentRow | null): Promise<void> => {
    if (row === null) {
      setEditing({ kind: 'comment', id: null, isNew: true, values: { author: '', text: '', mail: '', url: '', status: 'waiting', cid: cidText === '' ? '' : cidText, parent: '' }, count: 0, defaultCategory: false })
      return
    }
    const record = await api.manageGet({ kind: 'comment', id: row.id })
    const item = record.item ?? {}
    setEditing({
      kind: 'comment',
      id: row.id,
      isNew: false,
      ...(record.version === undefined ? {} : { version: record.version }),
      values: {
        author: String(item.author ?? ''),
        text: String(item.text ?? ''),
        mail: String(item.mail ?? ''),
        url: String(item.url ?? ''),
        status: String(item.status ?? 'waiting'),
        cid: String(item.cid ?? row.cid ?? ''),
        parent: item.parent === undefined || item.parent === null ? '' : String(item.parent),
      },
      count: 0,
      defaultCategory: false,
    })
  }

  /** 提交到 prepare 预览（表单提交/删除/评论编辑共用；旧 prepare）。 */
  const submitPrepare = async (args: Record<string, unknown>): Promise<void> => {
    const preview = await api.managePrepare({ kind, ...args })
    setConfirming(preview as unknown as ManagementPreview & { id: string; title: string; nonce?: string })
    setConfirmMessage('')
    setConfirmError('')
  }

  /** 确认/核对执行（旧 prepare 的 execute）。成功后确认弹窗保持打开并显示
   * 「已完成」结果态（旧码 confirm.hidden=true + message 文案），由用户手动关闭。 */
  const execute = async (checking: boolean): Promise<void> => {
    if (confirming === null) return
    setConfirmBusy(true)
    try {
      const result = checking
        ? await api.reconcile(confirming.id)
        : await api.confirm({ id: confirming.id, nonce: confirming.nonce ?? '', consumeSavedDraft: false })
      if (result.status === 'succeeded') {
        setConfirmMessage('已完成。若正在编辑受影响文章，请重新打开文章以读取最新设置。')
        resetEditor()
        await load()
        await loadMetadata()
      } else {
        setConfirmMessage('暂未取得成功回执，请稍后核对，勿重复创建。')
      }
    } catch (issue) {
      setConfirmError(errorTextOf(issue))
    } finally {
      setConfirmBusy(false)
    }
  }

  const breadcrumbs = kind === 'category' ? categoryPath(items ?? [], parent === 0 ? undefined : parent) : []
  const q = query.trim().toLocaleLowerCase()
  const footnote = kind === 'comment'
    ? '评论变更在确认后生效。'
    : kind === 'category'
      ? `${q !== '' ? '搜索结果' : parent !== 0 ? '本级' : '顶级'} ${visibleTaxonomy.length} 个分类 · 全站 ${items?.length ?? 0} 个分类`
      : `共 ${items?.length ?? 0} 个标签 · 字号按文章数呈现`

  return (
    <Modal open={open} onClose={requestClose} title={`管理${KIND_LABEL[kind]}`} label="分类、标签和评论管理" className="blg-management-dialog">
      <p className="blg-muted">{KIND_SUBTITLE[kind]}</p>
      <nav className="blg-management-tabs" aria-label="博客管理">
        {(['category', 'tag', 'comment'] as const).map(key => (
          <button key={key} type="button" aria-pressed={kind === key} onClick={() => switchKind(key)}>管理{KIND_LABEL[key]}</button>
        ))}
      </nav>
      {error !== '' && <p className="blg-dialog-error" role="alert" tabIndex={-1}>{error}</p>}
      <div className="blg-management-toolbar">
        <input
          type="search"
          aria-label="管理搜索"
          placeholder={kind === 'comment' ? '搜索作者或评论内容' : `搜索全部${KIND_LABEL[kind]}名称或别名`}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (kind === 'comment') { setPage(1); void load() }
            }
          }}
        />
        {kind === 'comment' && (
          <>
            <input
              type="number"
              min={1}
              placeholder="文章 ID（空为全站）"
              aria-label="筛选文章 ID"
              value={cidText}
              onChange={event => setCidText(event.target.value)}
            />
            <select aria-label="评论状态" value={status} onChange={event => setStatus(event.target.value)}>
              {(['all', 'approved', 'waiting', 'spam'] as const).map(key => (
                <option key={key} value={key}>{STATUS_LABEL[key]}</option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          className="btn btn--tiny"
          onClick={() => {
            if (kind === 'comment') { setPage(1); void load() }
          }}
        >
          查询
        </button>
        {kind !== 'comment' && (
          <select aria-label="排序方式" value={sort} onChange={event => setSort(event.target.value as 'original' | 'name' | 'count')}>
            <option value="original">默认顺序</option>
            <option value="name">名称排序</option>
            <option value="count">文章数最多</option>
          </select>
        )}
        <button
          type="button"
          className="btn btn--primary btn--tiny"
          disabled={kind !== 'comment' && items === null}
          onClick={() => { void (kind === 'comment' ? editComment(null) : editTaxonomy(null)) }}
        >
          {kind === 'category' && parent !== 0 ? '新增子分类' : `新增${KIND_LABEL[kind]}`}
        </button>
      </div>

      <div className="blg-management-context">
        {kind === 'category' && (
          <nav className="blg-management-crumbs" aria-label="分类层级">
            <button type="button" className="btn btn--tiny" onClick={() => { if (canLeave()) { setParent(0); setQuery(''); resetEditor() } }}>全部分类</button>
            {breadcrumbs.map(item => (
              <span key={item.id}>
                <span className="blg-crumb-separator" aria-hidden="true">›</span>
                <button type="button" className="btn btn--tiny" onClick={() => { if (canLeave()) { setParent(item.id); setQuery(''); resetEditor() } }}>{item.name}</button>
              </span>
            ))}
          </nav>
        )}
        {kind === 'category' && parent !== 0 && (
          <button type="button" className="btn btn--tiny blg-management-link" onClick={() => { void editTaxonomy(parent) }}>编辑当前分类</button>
        )}
      </div>

      <div className="blg-management-body">
        <div className="blg-management-list" ref={listRef} aria-busy={loading}>
          {loading && <p className="blg-management-empty">{`正在加载${KIND_LABEL[kind]}…`}</p>}
          {!loading && kind === 'category' && items !== null && (
            visibleTaxonomy.length === 0
              ? <EmptyTaxonomy kind={kind} query={q} parent={parent} onClear={() => setQuery('')} onCreate={() => { void editTaxonomy(null) }} />
              : (
                <table className="blg-management-table">
                  <thead>
                    <tr>{['分类名称', '子分类', '链接别名', '文章数', '操作'].map(label => <th key={label} scope="col">{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {visibleTaxonomy.map(item => (
                      <tr key={item.id}>
                        <td>
                          <button type="button" className="blg-management-category-name" onClick={() => { if (canLeave()) { setParent(item.id); setQuery(''); resetEditor() } }}>
                            {item.name}
                          </button>
                          {q !== '' && <small className="blg-management-path">{categoryPath(items, item.parent).map(node => node.name).join(' / ') || '顶级分类'}</small>}
                          {q === '' && item.description !== undefined && item.description !== '' && <small className="blg-management-path">{item.description}</small>}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn--tiny blg-management-link"
                            onClick={() => {
                              if (!canLeave()) return
                              if ((childrenOf.get(item.id) ?? 0) > 0) { setParent(item.id); setQuery(''); resetEditor() }
                              else void editTaxonomy(null, { parent: item.id })
                            }}
                          >
                            {(childrenOf.get(item.id) ?? 0) > 0 ? `${childrenOf.get(item.id)} 个子分类` : '新增子分类'}
                          </button>
                        </td>
                        <td className="blg-management-slug">{item.slug === undefined || item.slug === '' ? '—' : item.slug}</td>
                        <td><span className="blg-management-count">{String(item.count ?? 0)}</span></td>
                        <td>
                          <button type="button" className="btn btn--tiny blg-management-link" data-record={item.id} aria-label={`编辑分类：${item.name}`} onClick={() => { void editTaxonomy(item.id) }}>编辑</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          )}
          {!loading && kind === 'tag' && items !== null && (
            visibleTaxonomy.length === 0
              ? <EmptyTaxonomy kind={kind} query={q} parent={parent} onClear={() => setQuery('')} onCreate={() => { void editTaxonomy(null) }} />
              : (
                <div className="blg-management-tag-cloud" aria-label="标签云">
                  {visibleTaxonomy.map(item => {
                    const max = Math.max(...(items ?? []).map(node => node.count ?? 0), 1)
                    const size = 14 + Math.round(5 * Math.sqrt((item.count ?? 0) / max))
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="blg-management-tag"
                        style={{ ['--tag-size' as string]: `${size}px` }}
                        aria-label={`${item.name}，${item.count ?? 0} 篇文章`}
                        title={`${item.slug ?? ''} · ${item.count ?? 0} 篇文章`}
                        onClick={() => { void editTaxonomy(item.id) }}
                      >
                        <span>{item.name}</span>
                        <small>{String(item.count ?? 0)}</small>
                      </button>
                    )
                  })}
                </div>
              )
          )}
          {!loading && kind === 'comment' && (
            <>
              {comments.length === 0 && <p className="blg-management-empty">没有匹配的记录</p>}
              {comments.map(row => (
                <section key={row.id} className="blg-management-row">
                  <h3>{row.author} · ID {row.id}</h3>
                  <p>文章 {row.cid} · {STATUS_LABEL[row.status ?? ''] ?? row.status} · {row.text}</p>
                  <div className="blg-management-row-actions">
                    <button type="button" className="btn btn--tiny" onClick={() => { void editComment(row) }}>编辑</button>
                    <button type="button" className="btn btn--tiny btn--danger" onClick={() => { void submitPrepare({ operation: 'delete', id: row.id }).catch(issue => setError(errorTextOf(issue))) }}>删除</button>
                    <button type="button" className="btn btn--tiny" onClick={() => { void editComment(null).then(() => setEditing(current => current === null ? current : { ...current, values: { ...current.values, cid: String(row.cid), parent: String(row.id) } })) }}>回复</button>
                  </div>
                </section>
              ))}
            </>
          )}
        </div>

        <aside className="blg-management-editor" aria-label="分类与标签编辑" hidden={kind === 'comment'}>
          {editorBusy && <p className="blg-management-empty">正在读取…</p>}
          {!editorBusy && editing === null && <p className="blg-management-empty">选中左侧记录进行编辑，或新建{KIND_LABEL[kind]}。</p>}
          {!editorBusy && editing !== null && editing.kind !== 'comment' && (
            <TaxonomyEditor
              key={`${editing.kind}-${editing.id ?? 'new'}`}
              editing={editing}
              items={items ?? []}
              busy={dirty}
              onCancel={() => { if (canLeave()) resetEditor() }}
              onSubmit={async values => {
                if (editing === null) return
                setEditorBusy(true)
                try {
                  await submitPrepare(editing.id !== null
                    ? { operation: 'update', id: editing.id, version: editing.version, fields: values }
                    : { operation: 'create', fields: values })
                  setDirty(false)
                } catch (issue) {
                  setError(errorTextOf(issue))
                } finally {
                  setEditorBusy(false)
                }
              }}
              onDelete={editing.id !== null
                ? () => { void submitPrepare({ kind, operation: 'delete', id: editing.id, version: editing.version }).catch(issue => setError(errorTextOf(issue))) }
                : undefined}
            />
          )}
        </aside>
      </div>

      {kind === 'comment' && (
        <div className="blg-management-pager">
          <button type="button" className="btn btn--tiny" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
          <span>第 {page} 页</span>
          <button type="button" className="btn btn--tiny" disabled={!hasMore || loading} onClick={() => setPage(value => value + 1)}>下一页</button>
        </div>
      )}
      <p className="blg-management-footnote" role="status">{footnote}</p>

      {editing !== null && editing.kind === 'comment' && (
        <CommentEditor
          editing={editing}
          onCancel={() => { if (canLeave()) resetEditor() }}
          onSubmit={async values => {
            if (editing === null) return
            try {
              await submitPrepare(editing.id !== null
                ? { operation: 'update', id: editing.id, version: editing.version, fields: values }
                : { operation: 'create', fields: values })
              setDirty(false)
              resetEditor()
            } catch (issue) {
              setError(errorTextOf(issue))
            }
          }}
        />
      )}

      {confirming !== null && (
        <Modal open onClose={() => { if (!confirmBusy) { setConfirming(null); setConfirmMessage('') } }} title={`确认${confirming.title}`} label="确认博客管理操作" busy={confirmBusy}>
          <pre className="blg-operation-summary">{managementSummary(confirming)}</pre>
          {confirmError !== '' && <p className="blg-dialog-error" role="alert">{confirmError}</p>}
          {confirmMessage !== '' && <p className="blg-dialog-description" role="status">{confirmMessage}</p>}
          <div className="blg-dialog-actions">
            {!confirmError && confirmMessage === '' && (
              <button type="button" className="btn btn--primary" disabled={confirmBusy} onClick={() => { void execute(false) }}>确认执行</button>
            )}
            {/* 无成功回执才给「核对」（旧码 reconcile.hidden 语义；成功后只留关闭）。 */}
            {confirmMessage !== '' && !confirmMessage.startsWith('已完成') && (
              <button type="button" className="btn btn--primary" disabled={confirmBusy} onClick={() => { void execute(true) }}>核对执行结果</button>
            )}
            <button type="button" className="btn" disabled={confirmBusy} onClick={() => { setConfirming(null); setConfirmMessage('') }}>关闭</button>
          </div>
        </Modal>
      )}
    </Modal>
  )
}

function EmptyTaxonomy({ kind, query, parent, onClear, onCreate }: {
  kind: Kind
  query: string
  parent: number
  onClear: () => void
  onCreate: () => void
}): ReactElement {
  const label = query !== '' ? `没有匹配的${KIND_LABEL[kind]}，试试其他关键词。` : parent !== 0 ? '这个分类还没有子分类。' : `还没有${KIND_LABEL[kind]}。`
  return (
    <div className="blg-management-empty">
      <p>{label}</p>
      {query !== ''
        ? <button type="button" className="btn btn--tiny" onClick={onClear}>清除搜索</button>
        : <button type="button" className="btn btn--tiny btn--primary" onClick={onCreate}>新增{parent !== 0 ? '子分类' : KIND_LABEL[kind]}</button>}
    </div>
  )
}

/** 分类/标签编辑表单（旧 editTaxonomy 的表单段：字段、默认分类禁用、删除按钮）。 */
function TaxonomyEditor({ editing, items, onCancel, onSubmit, onDelete }: {
  editing: ManageRecord
  items: readonly TaxonomyItem[]
  busy: boolean
  onCancel: () => void
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  onDelete?: (() => void) | undefined
}): ReactElement {
  const [name, setName] = useState(String(editing.values.name ?? ''))
  const [slug, setSlug] = useState(String(editing.values.slug ?? ''))
  const [description, setDescription] = useState(String(editing.values.description ?? ''))
  const [parentValue, setParentValue] = useState(String(editing.values.parent ?? 0))
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus({ preventScroll: true }) }, [])

  const isCategory = editing.kind === 'category'
  const parentChoicesList = isCategory ? parentChoices(items, editing.id ?? undefined) : []

  const submit = async (): Promise<void> => {
    if (name.trim() === '') {
      setSubmitError('名称不能为空')
      return
    }
    setSubmitting(true)
    setSubmitError('')
    try {
      const values: Record<string, unknown> = { name, slug, description }
      if (isCategory) {
        values.parent = Number(parentValue)
        // isDefault 只在勾选时提交（旧 values 过滤：isDefault 且 checked&&!disabled）。
        values.isDefault = editing.defaultCategory
      }
      await onSubmit(values)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={event => { event.preventDefault(); void submit() }}
    >
      <p className="blg-management-eyebrow">{editing.id !== null ? `${KIND_LABEL[editing.kind]}详情 · ID ${editing.id}` : `创建新${KIND_LABEL[editing.kind]}`}</p>
      <h3>{editing.id !== null ? `编辑${KIND_LABEL[editing.kind]}` : `新增${KIND_LABEL[editing.kind]}`}</h3>
      {editing.id !== null && (
        <p className="blg-management-hint">{editing.count} 篇文章{editing.defaultCategory === true ? ' · 默认分类' : ''}</p>
      )}
      {submitError !== '' && <p className="blg-dialog-error" role="alert">{submitError}</p>}
      <label className="blg-field">
        名称 *
        <input ref={nameRef} value={name} maxLength={80} onChange={event => setName(event.target.value)} />
      </label>
      <label className="blg-field">
        链接别名
        <input value={slug} maxLength={200} onChange={event => setSlug(event.target.value)} />
        <small className="blg-muted">用于文章链接；留空时根据名称生成。</small>
      </label>
      {isCategory && (
        <label className="blg-field">
          父分类
          <select value={parentValue} onChange={event => setParentValue(event.target.value)}>
            <option value="0">无（顶级分类）</option>
            {parentChoicesList.map(choice => (
              <option key={choice.id} value={choice.id}>{categoryPath(items, choice.id).map(node => node.name).join(' / ')}</option>
            ))}
          </select>
        </label>
      )}
      <details className="blg-management-description" open={description !== ''}>
        <summary>补充描述</summary>
        <label className="blg-field">
          描述
          <textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} />
        </label>
      </details>
      {isCategory && (
        <label className="blg-check">
          <input type="checkbox" checked={editing.defaultCategory} disabled={editing.defaultCategory} onChange={() => undefined} />
          设为默认分类
        </label>
      )}
      <div className="blg-dialog-actions">
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          预览{editing.id !== null ? '修改' : '新增'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
      {editing.id !== null && (
        <button
          type="button"
          className="btn btn--danger"
          disabled={editing.defaultCategory === true || submitting}
          title={editing.defaultCategory === true ? '请先将其他分类设为默认分类' : undefined}
          onClick={() => { if (onDelete !== undefined) onDelete() }}
        >
          删除{KIND_LABEL[editing.kind]}
        </button>
      )}
    </form>
  )
}

/** 评论编辑/回复表单弹窗（旧 editItem 的 comment 分支）。 */
function CommentEditor({ editing, onCancel, onSubmit }: {
  editing: ManageRecord
  onCancel: () => void
  onSubmit: (values: Record<string, unknown>) => Promise<void>
}): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({
    author: String(editing.values.author ?? ''),
    text: String(editing.values.text ?? ''),
    mail: String(editing.values.mail ?? ''),
    url: String(editing.values.url ?? ''),
    status: String(editing.values.status ?? 'waiting'),
    cid: String(editing.values.cid ?? ''),
    parent: String(editing.values.parent ?? ''),
  })
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const field = (key: string, label: string, required = false, type: 'input' | 'textarea' = 'input'): ReactElement => (
    <label className="blg-field">
      {label}
      {type === 'textarea'
        ? <textarea rows={3} value={values[key] ?? ''} required={required} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} />
        : <input value={values[key] ?? ''} required={required} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} />}
    </label>
  )

  return (
    <Modal open onClose={onCancel} title={`${editing.id !== null ? '编辑' : '新建'}评论`} label={`${editing.id !== null ? '编辑' : '新建'}评论`}>
      {submitError !== '' && <p className="blg-dialog-error" role="alert">{submitError}</p>}
      <form onSubmit={event => {
        event.preventDefault()
        setSubmitting(true)
        setSubmitError('')
        onSubmit({
          author: values.author ?? '',
          text: values.text ?? '',
          mail: values.mail ?? '',
          url: values.url ?? '',
          status: values.status ?? 'waiting',
          ...(editing.id !== null ? {} : { cid: Number(values.cid ?? 0), parent: values.parent === '' || values.parent === undefined ? 0 : Number(values.parent) }),
        }).catch((issue: unknown) => setSubmitError(errorTextOf(issue))).finally(() => setSubmitting(false))
      }}>
        {field('author', '作者', true)}
        {field('text', '内容', true, 'textarea')}
        {field('mail', '邮箱')}
        {field('url', '网站')}
        <label className="blg-field">
          状态
          <select value={values.status ?? 'waiting'} onChange={event => setValues(current => ({ ...current, status: event.target.value }))}>
            <option value="waiting">待审核</option>
            <option value="approved">已批准（公开）</option>
            <option value="spam">垃圾评论</option>
          </select>
        </label>
        {editing.id === null && field('cid', '文章 ID', true)}
        <div className="blg-dialog-actions">
          <button type="submit" className="btn btn--primary" disabled={submitting}>预览修改</button>
          <button type="button" className="btn" onClick={onCancel}>取消</button>
        </div>
      </form>
    </Modal>
  )
}
