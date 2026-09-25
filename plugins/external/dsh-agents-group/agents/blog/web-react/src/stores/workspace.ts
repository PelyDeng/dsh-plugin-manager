/**
 * 文章工作台域 store（旧 web/app.js 的 S 状态袋的域化拆分）：
 * - 列表（search/status/page/迁移入口）；
 * - 当前草稿与保存循环（dirty/saveTimer→flush 的状态面；定时器仍在 controller）；
 * - 视图模式（ai/manual、source/split/preview）与光标（格式工具的插入点）；
 * - 候选稿对照（review）与 AI 任务（job 轮询面）、附件、发布记录、文章设置。
 *
 * 旧码的同名语义照搬；「待打开请求」（pendingOpen）是 chat 结果卡 → 工作台的
 * 跨视图通信位（旧 openDraft(id,{proposal}) + view(false) 的组合）。
 */
import { create } from 'zustand'
import type { ArticleListItem, AttachmentItem, BlogCategory, BlogDraft, OperationLogRow, Proposal, WritingJob } from '../lib/types.ts'
import type { PreparedPublish } from '../workspace-controller.ts'

export type EditorViewMode = 'source' | 'split' | 'preview'
export type WriteMode = 'ai' | 'manual'
export type ArticleStatusFilter = 'all' | 'published' | 'draft'

export interface WorkspaceState {
  // 列表
  articles: ArticleListItem[]
  articlesHasMore: boolean
  articlesLoading: boolean
  articlesError: string | null
  search: string
  statusFilter: ArticleStatusFilter
  page: number
  migrationRemaining: number | null

  // 当前草稿与保存
  draft: BlogDraft | null
  dirty: boolean
  saveState: 'saved' | 'dirty' | 'saving' | 'partial' | 'error' | 'native-published' | 'legacy'
  saveError: string | null
  /** 元数据就绪位（旧 metadataReady：分类选项加载完成前保留原分类）。 */
  metadataReady: boolean
  categories: BlogCategory[]

  // 视图与光标
  mode: WriteMode
  editorView: EditorViewMode
  /** 文本域光标（格式工具的插入点；旧 cursor 变量）。 */
  cursor: { start: number; end: number }

  // 候选稿对照与 AI 任务
  /** 对照中的候选稿（null=编辑器视图）。 */
  review: Proposal | null
  job: WritingJob | null
  /** 提问指令的按草稿暂存（旧 instructions Map）。 */
  instructions: Record<string, string>

  // 附件与发布记录（writing 侧）
  attachments: AttachmentItem[]
  selectedAttachments: string[]
  operationsLog: OperationLogRow[]

  // 发布确认链路（prepare → confirm/reconcile）
  prepared: PreparedPublish | null
  publishBusy: boolean
  /** 发布确认弹窗开合（prepare 成功后由 controller 打开）。 */
  publishDialogOpen: boolean

  /** chat 结果卡的待打开请求（旧 openDraft({proposal}) + 切视图）。 */
  pendingOpen: { draftId: string; proposal: Proposal | null } | null
  /** 「在光标处插入正文」的跨组件请求（Assistant → Editor）。 */
  pendingInsert: string | null

  // ── 动作（页面只写状态；网络在 controller）──
  setArticles: (items: ArticleListItem[], hasMore: boolean) => void
  setArticlesLoading: (loading: boolean) => void
  setArticlesError: (message: string | null) => void
  setSearch: (search: string) => void
  setStatusFilter: (filter: ArticleStatusFilter) => void
  setPage: (page: number) => void
  setMigrationRemaining: (remaining: number | null) => void

  setDraft: (draft: BlogDraft | null) => void
  setDirty: (dirty: boolean) => void
  setSaveState: (state: WorkspaceState['saveState']) => void
  setSaveError: (message: string | null) => void
  setMetadata: (categories: BlogCategory[]) => void

  setMode: (mode: WriteMode) => void
  setEditorView: (view: EditorViewMode) => void
  setCursor: (cursor: { start: number; end: number }) => void

  setReview: (proposal: Proposal | null) => void
  setJob: (job: WritingJob | null) => void
  stashInstruction: (draftId: string, instruction: string) => void

  setAttachments: (items: AttachmentItem[]) => void
  toggleSelectedAttachment: (id: string, selected: boolean) => void
  setOperationsLog: (rows: OperationLogRow[]) => void

  setPrepared: (prepared: WorkspaceState['prepared']) => void
  setPublishBusy: (busy: boolean) => void
  setPublishDialogOpen: (open: boolean) => void
  setPendingOpen: (pending: WorkspaceState['pendingOpen']) => void
  setPendingInsert: (text: string | null) => void
}

export const useWorkspaceStore = create<WorkspaceState>(set => ({
  articles: [],
  articlesHasMore: false,
  articlesLoading: false,
  articlesError: null,
  search: '',
  statusFilter: 'all',
  page: 1,
  migrationRemaining: null,

  draft: null,
  dirty: false,
  saveState: 'saved',
  saveError: null,
  metadataReady: false,
  categories: [],

  mode: 'ai',
  editorView: 'split',
  cursor: { start: 0, end: 0 },

  review: null,
  job: null,
  instructions: {},

  attachments: [],
  selectedAttachments: [],
  operationsLog: [],

  prepared: null,
  publishBusy: false,
  publishDialogOpen: false,

  pendingOpen: null,
  pendingInsert: null,

  setArticles: (articles, hasMore) => set({ articles: [...articles], articlesHasMore: hasMore }),
  setArticlesLoading: articlesLoading => set({ articlesLoading }),
  setArticlesError: articlesError => set({ articlesError }),
  setSearch: search => set({ search }),
  setStatusFilter: statusFilter => set({ statusFilter }),
  setPage: page => set({ page }),
  setMigrationRemaining: migrationRemaining => set({ migrationRemaining }),

  setDraft: draft => set({ draft: draft === null ? null : { ...draft } }),
  setDirty: dirty => set({ dirty }),
  setSaveState: saveState => set({ saveState }),
  setSaveError: saveError => set({ saveError }),
  setMetadata: categories => set({ categories, metadataReady: true }),

  setMode: mode => set({ mode }),
  setEditorView: editorView => set({ editorView }),
  setCursor: cursor => set({ cursor }),

  setReview: review => set({ review }),
  setJob: job => set({ job: job === null ? null : { ...job } }),
  stashInstruction: (draftId, instruction) => set(state => ({ instructions: { ...state.instructions, [draftId]: instruction } })),

  setAttachments: items => set(state => ({
    attachments: [...items],
    selectedAttachments: items.filter(item => item.selected !== false && item.status === 'ready').map(item => item.id),
  })),
  toggleSelectedAttachment: (id, selected) => set(state => {
    const has = state.selectedAttachments.includes(id)
    if (selected && !has) return { selectedAttachments: [...state.selectedAttachments, id] }
    if (!selected && has) return { selectedAttachments: state.selectedAttachments.filter(item => item !== id) }
    return {}
  }),
  setOperationsLog: operationsLog => set({ operationsLog: [...operationsLog] }),

  setPrepared: prepared => set({ prepared }),
  setPublishBusy: publishBusy => set({ publishBusy }),
  setPublishDialogOpen: publishDialogOpen => set({ publishDialogOpen }),
  setPendingOpen: pendingOpen => set({ pendingOpen }),
  setPendingInsert: pendingInsert => set({ pendingInsert }),
}))

/** 测试/启动用：整域重置。 */
export function resetWorkspaceStore(): void {
  useWorkspaceStore.setState({
    articles: [],
    articlesHasMore: false,
    articlesLoading: false,
    articlesError: null,
    search: '',
    statusFilter: 'all',
    page: 1,
    migrationRemaining: null,
    draft: null,
    dirty: false,
    saveState: 'saved',
    saveError: null,
    metadataReady: false,
    categories: [],
    mode: 'ai',
    editorView: 'split',
    cursor: { start: 0, end: 0 },
    review: null,
    job: null,
    instructions: {},
    attachments: [],
    selectedAttachments: [],
    operationsLog: [],
    prepared: null,
    publishBusy: false,
    publishDialogOpen: false,
    pendingOpen: null,
    pendingInsert: null,
  })
}
