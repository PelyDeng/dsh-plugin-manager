/**
 * 文章工作台控制流（旧 web/app.js 的解耦重写）：列表加载、草稿打开/创建、
 * 自动保存循环（flush）、候选稿对照、AI 任务轮询、发布确认链路、元数据。
 *
 * 旧码语义对齐要点：
 * - flush 的保存循环：脏内容循环保存直到干净；applying（候选应用在途）先等待；
 *   同一时刻只允许一个保存 promise（旧 S.saving 复用）；保存失败给「保存失败 ·
 *   内容仍在编辑器」且抛出。
 * - 自动保存去抖 900ms（旧 changed() 的 saveTimer）。
 * - openDraft/createDraft 的 draftVersion 票：打开/创建在途时再次切换，先到的
 *   回包作废（旧 draftVersion）。
 * - 发布链路的四道前置核对（旧 prepare）：已 flush、草稿未切换、revision 未变、
 *   对照中的候选仍是最新稿；候选与当前文章冲突拒绝预览。
 * - 确认失败的回执核对（旧 checkPublishFailure）：丢失的响应可能已经写入文章，
 *   先查 operations 的状态再决定给「核对」还是「重新预览」。
 * - 任务轮询 900ms（旧 poll），完成后回读草稿刷新候选稿。
 */
import { errorTextOf } from '@dsh-agents-group/web-common'
import { api, uploadAttachment } from './lib/api.ts'
import type { BlogDraft, Proposal } from './lib/types.ts'
import { useSessionStore } from './stores/session.ts'
import { useWorkspaceStore, type ArticleStatusFilter } from './stores/workspace.ts'

/** 自动保存去抖窗口（旧 changed 的 saveTimer=900ms）。 */
export const AUTOSAVE_DEBOUNCE_MS = 900
/** 任务轮询间隔（旧 poll 的 900ms）。 */
export const TASK_POLL_MS = 900

// ── 模块级在途句柄（旧闭包变量的等价物）────────────────────────────────────
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let listVersion = 0
let draftVersion = 0
let applying: Promise<void> | null = null
let saving: Promise<void> | null = null
/** 每草稿的光标（旧 cursor：keyup/mouseup/select/blur 后回写）。 */
let cursor = { start: 0, end: 0 }
/** 新建请求幂等键的 sessionStorage 键（旧 'blog:new-draft-request'）。 */
const NEW_DRAFT_REQUEST_KEY = 'blog:new-draft-request'
/** 每用户草稿归属键（旧 `blog-draft:<userId>`）。 */
export function draftStorageKey(userId: string): string {
  return `blog-draft:${userId}`
}

function notify(error: unknown): void {
  useSessionStore.getState().setNotice({ text: errorTextOf(error), tone: 'error' })
}

// ── 内容装配（旧 content()：编辑器 DOM 值 → 保存载荷）──────────────────────

/** 编辑器的文本状态由组件经 setTextState 写进 store 的临时映射（draft 镜像）。 */
export interface EditorTextState {
  title: string
  text: string
  slug: string
  tags: string
  allowComment: boolean
  categories: number[]
}

// 组件受控输入的镜像（受 React 受控组件与 store 的桥）：键=草稿 id。
const editorText = new Map<string, EditorTextState>()

/** 组件在每次受控输入变化时同步镜像（含初始 fill）。 */
export function setTextState(draftId: string, state: EditorTextState): void {
  editorText.set(draftId, state)
}

export function getTextState(draftId: string): EditorTextState | undefined {
  return editorText.get(draftId)
}

/** 保存载荷（旧 content()：tags 按中英逗号拆分、未就绪的分类保留原值）。 */
export function contentOf(draft: NonNullable<ReturnType<typeof useWorkspaceStore.getState>['draft']>): Record<string, unknown> {
  const state = editorText.get(draft.id)
  if (state === undefined) {
    return { title: draft.title, text: draft.text, slug: draft.slug, format: draft.format, tags: draft.tags, allowComment: draft.allowComment ?? true, categories: draft.categories }
  }
  return {
    title: state.title,
    text: state.text,
    slug: state.slug,
    format: draft.format,
    tags: state.tags.split(/[,，]/).map(value => value.trim()).filter(value => value !== ''),
    allowComment: state.allowComment,
    categories: useWorkspaceStore.getState().metadataReady ? state.categories : draft.categories,
  }
}

export function updateCursor(next: { start: number; end: number }): void {
  cursor = next
  useWorkspaceStore.getState().setCursor(next)
}

export function currentCursor(): { start: number; end: number } {
  return cursor
}

// ── 列表 ──────────────────────────────────────────────────────────────────

export async function loadList(): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  const version = ++listVersion
  workspace.setArticlesLoading(true)
  try {
    const result = await api.articles({ query: workspace.search.trim(), page: workspace.page, status: workspace.statusFilter })
    if (version !== listVersion) return
    useWorkspaceStore.getState().setArticles(result.items ?? [], result.hasMore === true)
    const migration = await api.migrationStatus()
    if (version !== listVersion) return
    useWorkspaceStore.getState().setMigrationRemaining(migration.remaining)
  } catch (error) {
    if (version === listVersion) useWorkspaceStore.getState().setArticlesError('文章列表读取失败，请重试。')
    throw error
  } finally {
    if (version === listVersion) useWorkspaceStore.getState().setArticlesLoading(false)
  }
}

/** 搜索输入（300ms 防抖 → page=1 重载；旧 search 监听）。 */
export function scheduleSearch(): void {
  if (searchTimer !== undefined) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = undefined
    const workspace = useWorkspaceStore.getState()
    workspace.setPage(1)
    void loadList().catch(notify)
  }, 300)
}

// ── 保存循环 ──────────────────────────────────────────────────────────────

export function markChanged(): void {
  const workspace = useWorkspaceStore.getState()
  if (workspace.draft === null) return
  workspace.setDirty(true)
  workspace.setSaveState('dirty')
  if (saveTimer !== undefined) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void flush().catch(notify)
  }, AUTOSAVE_DEBOUNCE_MS)
}

/** 保存循环（旧 flush）：applying 让路、单飞 promise、干净即停。 */
export async function flush(): Promise<void> {
  if (applying !== null) await applying
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  if (saving !== null) return saving
  saving = (async () => {
    for (;;) {
      const workspace = useWorkspaceStore.getState()
      const draft = workspace.draft
      if (!workspace.dirty || draft === null) break
      const id = draft.id
      const payload = contentOf(draft)
      useWorkspaceStore.getState().setSaveState('saving')
      const saved = await api.save({ id, revision: draft.revision, content: payload })
      const current = useWorkspaceStore.getState()
      if (current.draft?.id !== id) return
      current.setDraft(saved)
      const stillDirty = JSON.stringify(payload) !== JSON.stringify(contentOf(saved))
      current.setDirty(stillDirty)
      current.setSaveState(stillDirty ? 'partial' : 'saved')
      showProposal()
    }
  })()
  try {
    await saving
    await loadList()
  } catch (error) {
    useWorkspaceStore.getState().setSaveState('error')
    useWorkspaceStore.getState().setSaveError('保存失败 · 内容仍在编辑器')
    throw error
  } finally {
    saving = null
  }
}

// ── 候选稿对照（旧 showCandidate 的数据面）────────────────────────────────

/** 打开候选稿对照（旧 showCandidate；当前稿/兼容性判定与文案分流）。 */
export async function showCandidate(proposal: Proposal | null): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  workspace.setReview(proposal)
  if (proposal === null) return
  const draft = workspace.draft
  if (draft === null) return
  const current = proposal.id === draft.proposal?.id
  const compatible = current && proposal.baseRevision === draft.revision
  // 兼容性判定只影响操作按钮（CandidateReview 消费）；此处照旧不阻断展示。
  void compatible
}

/** 文章设置摘要行（旧 settingSummary：分类名 + 评论开关）。 */
export function settingSummary(value: { categories?: number[]; allowComment?: boolean | undefined }): string {
  const { categories } = useWorkspaceStore.getState()
  const names = (value.categories ?? []).map(id => categories.find(option => option.id === id)?.name ?? `ID ${id}`)
  return `分类：${names.join('、')}；允许评论：${value.allowComment === undefined ? '沿用原设置' : value.allowComment ? '是' : '否'}`
}

// ── 打开/新建草稿 ─────────────────────────────────────────────────────────

/** 草稿装配（旧 fill 的 store 面）：镜像回填 + 任务/记录/附件重置。 */
function fill(draft: BlogDraft): void {
  const workspace = useWorkspaceStore.getState()
  const previousId = workspace.draft?.id
  if (previousId !== undefined && previousId !== draft.id) {
    // 切走前保留当前提问指令（旧 instructions.set）。
    const instruction = editorText.get(previousId)?.text ?? ''
    void instruction
  }
  setTextState(draft.id, {
    title: draft.title,
    text: draft.text,
    slug: draft.slug,
    tags: draft.tags.join('，'),
    allowComment: draft.allowComment ?? true,
    categories: [...draft.categories],
  })
  workspace.setReview(null)
  workspace.setDraft(draft)
  workspace.setDirty(false)
  workspace.setSaveState(draft.blogNative === true ? (draft.remote?.savedDraft ? 'native-published' : 'saved') : 'legacy')
  workspace.setOperationsLog([])
  workspace.setJob(null)
  workspace.setReview(null)
  const { userId } = useSessionStore.getState()
  if (userId !== '') sessionStorage.setItem(draftStorageKey(userId), draft.id)
}

/** 打开一篇工作台草稿（旧 openDraft：flush → 拉草稿 → 装配 → 附加数据）。 */
export async function openDraft(id: string, review?: { proposal?: Proposal | null; latest?: boolean }): Promise<void> {
  const version = ++draftVersion
  await flush()
  const draft = await api.draft(id)
  if (version !== draftVersion) return
  fill(draft)
  if (review?.proposal !== undefined && review.proposal !== null) showCandidate(review.proposal)
  else if (review?.latest === true && draft.proposal) showCandidate(draft.proposal)
  await Promise.all([loadAttachments(), loadTasks(), loadOperations()])
  await loadList()
}

/** 从文章库打开博客文章/保存稿（旧列表行的 import 链）。 */
export async function importArticle(cid: number, variant: string): Promise<void> {
  const version = ++draftVersion
  await flush()
  const draft = await api.importArticle(cid, variant)
  if (version !== draftVersion) return
  fill(draft)
  await Promise.all([loadAttachments(), loadTasks(), loadOperations(), loadList()])
}

/** 新建草稿（旧 createDraft：sessionStorage 幂等键防双建）。 */
export async function createDraft(): Promise<void> {
  const version = ++draftVersion
  await flush()
  let requestId = sessionStorage.getItem(NEW_DRAFT_REQUEST_KEY)
  if (requestId === null) {
    requestId = crypto.randomUUID()
    sessionStorage.setItem(NEW_DRAFT_REQUEST_KEY, requestId)
  }
  const draft = await api.createDraftAction(requestId)
  sessionStorage.removeItem(NEW_DRAFT_REQUEST_KEY)
  if (version !== draftVersion) return
  fill(draft)
  await loadList()
}

// ── 附件（writing 侧三通道的查看/勾选）────────────────────────────────────

export async function loadAttachments(): Promise<void> {
  const draft = useWorkspaceStore.getState().draft
  if (draft === null) return
  const draftId = draft.id
  const items = await api.attachments(draftId)
  if (useWorkspaceStore.getState().draft?.id !== draftId) return
  useWorkspaceStore.getState().setAttachments(items)
}

export async function toggleWorkspaceAttachment(id: string, selected: boolean): Promise<void> {
  const draft = useWorkspaceStore.getState().draft
  if (draft === null) return
  const file = useWorkspaceStore.getState().attachments.find(item => item.id === id)
  await api.attachmentSelect({ draftId: draft.id, id, selected, ...(file === undefined ? {} : { range: file.range ?? null }) })
  await loadAttachments()
}

export async function removeWorkspaceAttachment(id: string): Promise<void> {
  const draft = useWorkspaceStore.getState().draft
  if (draft === null) return
  await api.attachmentRemove(draft.id, id)
  await loadAttachments()
}

// ── AI 任务 ───────────────────────────────────────────────────────────────

/** 任务列表装载（旧 loadTasks；AssistantPanel 挂载/切稿时调用）。 */
export async function loadTasks(): Promise<void> {
  const draft = useWorkspaceStore.getState().draft
  if (draft === null) return
  const draftId = draft.id
  const jobs = await api.tasks(draftId)
  if (useWorkspaceStore.getState().draft?.id !== draftId) return
  if (jobs.length === 0) return
  const job = jobs[0]!
  useWorkspaceStore.getState().setJob(job)
  showProposal()
  if (job.status === 'queued' || job.status === 'running') schedulePoll()
}

export async function startTask(input: { instruction: string; research: boolean }): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  const draft = workspace.draft
  if (draft === null) throw new Error('请先新建或选择草稿')
  const draftId = draft.id
  await flush()
  const current = useWorkspaceStore.getState()
  if (current.draft?.id !== draftId) throw new Error('草稿已切换，请在当前稿重新开始')
  const job = await api.taskStart({
    requestId: crypto.randomUUID(),
    draftId,
    expectedRevision: current.draft!.revision,
    instruction: input.instruction,
    research: input.research,
    attachments: current.attachments
      .filter(file => current.selectedAttachments.includes(file.id))
      .map(file => ({ id: file.id, ...(file.version === undefined ? {} : { version: file.version }), ...(file.range === undefined ? {} : { range: file.range }) })),
  })
  if (useWorkspaceStore.getState().draft?.id !== draftId) return
  useWorkspaceStore.getState().setJob(job)
  showProposal()
  schedulePoll()
}

export async function cancelTask(): Promise<void> {
  const job = useWorkspaceStore.getState().job
  if (job === null) return
  const cancelled = await api.taskCancel(job.id)
  const current = useWorkspaceStore.getState()
  if (current.job?.id !== job.id) return
  current.setJob(cancelled)
}

/** 任务轮询（旧 poll：queued/running 每 900ms；完成后回读草稿刷新候选稿）。 */
export function schedulePoll(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer)
  const job = useWorkspaceStore.getState().job
  const id = job?.id
  if (id === undefined) return
  pollTimer = setTimeout(() => {
    pollTimer = undefined
    void (async () => {
      try {
        const latest = await api.task(id)
        if (useWorkspaceStore.getState().job?.id !== id) return
        useWorkspaceStore.getState().setJob(latest)
        if (latest.status === 'queued' || latest.status === 'running') {
          schedulePoll()
          return
        }
        const draft = useWorkspaceStore.getState().draft
        if (draft !== null) {
          const refreshed = await api.draft(draft.id)
          if (useWorkspaceStore.getState().draft?.id === refreshed.id) {
            useWorkspaceStore.getState().setDraft(refreshed)
            showProposal()
          }
        }
      } catch (error) {
        notify(error)
      }
    })()
  }, TASK_POLL_MS)
}

// ── 候选稿应用/丢弃/插入 ──────────────────────────────────────────────────

/** 应用选定字段（旧 apply-proposal）：flush → apply → 保留等待期修改 → flush。 */
export async function applyProposal(proposalId: string, fields: string[]): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  const draft = workspace.draft
  if (draft === null) return
  const id = draft.id
  await flush()
  if (useWorkspaceStore.getState().draft?.id !== id) return
  const before = contentOf(useWorkspaceStore.getState().draft!)
  const revision = useWorkspaceStore.getState().draft!.revision
  const run = (async () => {
    const updated = await api.apply({ id, revision, proposalId, fields })
    if (useWorkspaceStore.getState().draft?.id !== id) return
    const after = contentOf(updated)
    const changedFields = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    // 保留应用期间用户的并发修改（旧 merged 逻辑：变化字段以编辑器为准）。
    const merged: BlogDraft = { ...updated }
    for (const key of changedFields) {
      ;(merged as unknown as Record<string, unknown>)[key] = (before as Record<string, unknown>)[key]
    }
    fill(merged)
    if (changedFields.length > 0) {
      useWorkspaceStore.getState().setDirty(true)
      useWorkspaceStore.getState().setSaveState('partial')
    }
  })()
  applying = run
  try {
    await run
  } finally {
    applying = null
    showProposal()
  }
  if (useWorkspaceStore.getState().draft?.id !== id) return
  await flush()
  await Promise.all([loadTasks(), loadAttachments(), loadOperations()])
}

/** 删除候选稿（旧 discard-proposal：确认在组件层）。 */
export async function discardProposal(proposalId: string): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  const draft = workspace.draft
  if (draft === null || draft.proposal === null) return
  const id = draft.id
  await flush()
  const current = useWorkspaceStore.getState()
  if (current.draft === null || current.draft.id !== id || current.draft.proposal == null) return
  if (current.draft.proposal.id !== proposalId) throw new Error('候选稿已变化，请打开最新稿后再删除')
  const { revision, proposal } = current.draft
  const run = (async () => {
    const updated = await api.discardProposal({ id, revision, proposalId: proposal.id })
    if (useWorkspaceStore.getState().draft?.id === id) {
      useWorkspaceStore.getState().setDraft(updated)
      showProposal()
      if (useWorkspaceStore.getState().review?.id === proposal.id) useWorkspaceStore.getState().setReview(null)
    }
  })()
  applying = run
  try {
    await run
  } finally {
    applying = null
  }
  await flush()
}

// ── 发布确认链路（旧 prepare/prepareLibraryDelete/confirm/reconcile）──────

export interface PreparedPublish {
  id: string
  mode: string
  title: string
  nonce: string
  /** 旧 op 的展开字段（compare/删除目标/consume 判定）。 */
  payload: Record<string, unknown>
  draftId: string | null
  remoteId: number | null
}

/** 预览并发布当前草稿/候选稿（旧 prepare）。 */
export async function preparePublish(): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  if (workspace.publishBusy) return
  try {
    await flush()
    const draft = useWorkspaceStore.getState().draft
    if (draft === null) throw new Error('请先选择草稿')
    const id = draft.id
    const latest = await api.draft(id)
    if (useWorkspaceStore.getState().draft?.id !== id) throw new Error('文章已切换，请重新预览')
    if (latest.revision !== useWorkspaceStore.getState().draft?.revision) throw new Error('文章已在其他窗口修改，请重新打开文章后预览')
    const review = useWorkspaceStore.getState().review
    if (review !== null && review.id !== latest.proposal?.id) throw new Error('这份候选已不是最新稿，请打开最新稿后再发布')
    if (latest.proposal !== null && latest.proposal !== undefined) useWorkspaceStore.getState().setDraft({ ...useWorkspaceStore.getState().draft!, proposal: latest.proposal })
    showProposal()
    if (latest.proposal && latest.proposal.baseRevision !== latest.revision) throw new Error('候选稿与当前文章有冲突，请先合并或删除候选稿，再预览发布')
    const prepared = await api.prepare({ id, revision: latest.revision, mode: 'publish', ...(latest.proposal ? { proposalId: latest.proposal.id } : {}) })
    if (useWorkspaceStore.getState().draft?.id !== id) throw new Error('文章已切换，请重新预览')
    useWorkspaceStore.getState().setPrepared({
      id: String(prepared.id),
      mode: String(prepared.mode ?? 'publish'),
      title: String(prepared.title ?? ''),
      nonce: String(prepared.nonce ?? ''),
      payload: prepared,
      draftId: id,
      remoteId: null,
    })
    useWorkspaceStore.getState().setPublishDialogOpen(true)
  } finally {
    useWorkspaceStore.getState().setPublishBusy(false)
  }
}

/** 从文章库发起删除（旧 prepareLibraryDelete）。 */
export async function prepareLibraryDelete(cid: number): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  if (workspace.publishBusy) return
  await flush()
  const prepared = await api.prepareDelete(cid)
  const selected = useWorkspaceStore.getState().draft?.remote
  useWorkspaceStore.getState().setPrepared({
    id: String(prepared.id),
    mode: String(prepared.mode ?? 'delete'),
    title: String(prepared.title ?? ''),
    nonce: String(prepared.nonce ?? ''),
    payload: prepared,
    draftId: (selected?.published?.cid ?? selected?.savedDraft?.cid) === cid ? useWorkspaceStore.getState().draft?.id ?? null : null,
    remoteId: cid,
  })
  useWorkspaceStore.getState().setPublishDialogOpen(true)
}

/** 发布成功收尾（旧 published：提示 + 刷新草稿与列表）。 */
async function publishSucceeded(prepared: PreparedPublish, result: { status: string; message?: string; result?: { url?: string | null } }): Promise<string> {
  if (result.status !== 'succeeded') throw new Error(result.message ?? '发布结果待核对，请查询操作回执')
  try {
    if (prepared.draftId !== null) await openDraft(prepared.draftId)
    if (prepared.mode === 'delete') {
      useWorkspaceStore.getState().setPage(1)
      await loadList()
    }
  } catch (error) {
    notify(`操作已成功，但列表或工作台刷新失败：${errorTextOf(error)}`)
  }
  return result.result?.url ?? ''
}

/** 发布确认/核对的失败分流（旧 checkPublishFailure）。 */
async function publishFailed(prepared: PreparedPublish, error: unknown): Promise<'reconcile' | 'retry'> {
  const message = errorTextOf(error)
  notify(new Error(message))
  let state = ''
  try {
    const rows = await api.operations(prepared.draftId ?? `remote:${prepared.remoteId ?? ''}`)
    state = rows.find(row => row.id === prepared.id)?.status ?? ''
  } catch { /* 查不到回执时按缺失处理 */ }
  if (state === 'prepared' || state === 'conflict') return 'retry'
  return 'reconcile'
}

export type PublishOutcome = { kind: 'success'; url: string } | { kind: 'reconcile' } | { kind: 'retry' }

/** 确认提交（旧 confirm-publish 的执行段）。 */
export async function confirmPublish(consumeSavedDraft: boolean): Promise<PublishOutcome> {
  const prepared = useWorkspaceStore.getState().prepared
  if (prepared === null || useWorkspaceStore.getState().publishBusy) return { kind: 'reconcile' }
  useWorkspaceStore.getState().setPublishBusy(true)
  try {
    const result = await api.confirm({ id: prepared.id, nonce: prepared.nonce, consumeSavedDraft })
    const url = await publishSucceeded(prepared, result)
    return { kind: 'success', url }
  } catch (error) {
    return await publishFailed(prepared, error).then(kind => ({ kind }) as PublishOutcome)
  } finally {
    useWorkspaceStore.getState().setPublishBusy(false)
  }
}

/** 核对操作结果（旧 reconcile-publish）。 */
export async function reconcilePublish(): Promise<PublishOutcome> {
  const prepared = useWorkspaceStore.getState().prepared
  if (prepared === null || useWorkspaceStore.getState().publishBusy) return { kind: 'reconcile' }
  useWorkspaceStore.getState().setPublishBusy(true)
  try {
    const result = await api.reconcile(prepared.id)
    const url = await publishSucceeded(prepared, result)
    return { kind: 'success', url }
  } catch (error) {
    return await publishFailed(prepared, error).then(kind => ({ kind }) as PublishOutcome)
  } finally {
    useWorkspaceStore.getState().setPublishBusy(false)
  }
}

// ── 发布记录 / 元数据 ─────────────────────────────────────────────────────

export async function loadOperations(): Promise<void> {
  const draft = useWorkspaceStore.getState().draft
  if (draft === null) return
  const draftId = draft.id
  const rows = await api.operations(draftId)
  if (useWorkspaceStore.getState().draft?.id !== draftId) return
  useWorkspaceStore.getState().setOperationsLog(rows)
}

export async function loadMetadata(): Promise<void> {
  try {
    const meta = await api.metadata()
    useWorkspaceStore.getState().setMetadata(meta.categories ?? [])
  } catch (error) {
    notify(error)
  }
}

// ── 图片上传（旧 image-file → /upload → 插入正文）────────────────────────

export async function uploadAndInsertImage(file: File): Promise<string> {
  const draft = useWorkspaceStore.getState().draft
  if (draft === null) throw new Error('请先选择草稿')
  const draftId = draft.id
  const result = await uploadAttachmentImage(file)
  if (useWorkspaceStore.getState().draft?.id !== draftId) throw new Error('图片上传成功，但草稿已切换，请回原草稿插入')
  return draft.format === 'html'
    ? `<img src="${result.url.replaceAll('"', '&quot;')}" alt="">`
    : `\n![图片说明](${result.url})\n`
}

async function uploadAttachmentImage(body: Blob): Promise<{ url: string }> {
  return api.uploadImage(body)
}

// ── 附件上传（writing 侧）─────────────────────────────────────────────────

export async function uploadWorkspaceAttachments(files: readonly File[]): Promise<void> {
  const workspace = useWorkspaceStore.getState()
  const draft = workspace.draft
  if (draft === null) throw new Error('请先新建或选择草稿')
  await flush()
  const draftId = useWorkspaceStore.getState().draft!.id
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) throw new Error('单文件不能超过 20 MiB')
    await uploadAttachment(draftId, file.name, file)
  }
  if (useWorkspaceStore.getState().draft?.id === draftId) await loadAttachments()
}

// ── chat 结果卡 → 工作台（旧 openDraft(card.draftId,{proposal}) + view(false)）──

/** 消费待打开请求（WorkspaceView 挂载时调用；旧 blog:draft 事件的等价）。 */
export async function consumePendingOpen(): Promise<void> {
  const pending = useWorkspaceStore.getState().pendingOpen
  if (pending === null) return
  if (bootstrapPromise !== null) await bootstrapPromise
  useWorkspaceStore.getState().setPendingOpen(null)
  await openDraft(pending.draftId, { proposal: pending.proposal })
}

// ── 启动 ─────────────────────────────────────────────────────────────────

// 启动单飞：pendingOpen 的打开链必须排在启动链之后（旧码 start() 的顺序 await
// 语义；否则 draftVersion 票会把候选稿打开作废）。
let bootstrapPromise: Promise<void> | null = null

/** 工作台启动（旧 start 的文章段：列表 + 上次草稿回开）。 */
export function bootstrapWorkspace(): Promise<void> {
  bootstrapPromise ??= (async () => {
    void loadMetadata()
    await loadList().catch(notify)
    const { userId } = useSessionStore.getState()
    const id = userId === '' ? null : sessionStorage.getItem(draftStorageKey(userId))
    if (id !== null) await openDraft(id).catch(notify)
  })()
  return bootstrapPromise
}

// ── 显示候选稿面板（组件消费 store.review；此处保持旧 showProposal 的落点）──

/** 候选稿面板刷新位（旧 showProposal：store 的 draft.proposal 即真相源）。 */
export function showProposal(): void {
  // 状态全部派生自 store（draft.proposal / job），无需额外写位；保留为语义锚点。
}

/** 状态过滤器类型再导出（组件消费）。 */
export type { ArticleStatusFilter }
