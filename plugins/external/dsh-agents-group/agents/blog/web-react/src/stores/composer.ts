/**
 * 输入域 store：composer（输入草稿/附件数据面/联网查证/发送停止标志）与模型选择
 * （任务批 2a 的域划分把模型选择归 composer 域；实现上拆成同文件的独立 store，
 * 与 closedoff 的 picker store 同构，两块状态互不纠缠）。
 *
 * 草稿真相源进 store 的原因同 closedoff：发送失败回填、跨会话草稿保存/恢复
 * （旧 inputs Map）都发生在 controller 层。
 */
import { create } from 'zustand'
import { api } from '../lib/api.ts'
import type { AttachmentItem, ModelCatalog, ModelSelection } from '../lib/types.ts'

export interface ComposerState {
  /** 当前输入框草稿。 */
  draft: string
  /** 各会话的草稿暂存（旧 inputs Map；'' 键=未落库新对话的草稿）。 */
  draftsByConversation: Record<string, string>
  /** 联网查证开关（旧 #chat-research，默认开）。 */
  research: boolean
  sending: boolean
  stopping: boolean
  uploading: boolean
  /** EventSource 连接提示（旧 onerror 直写 chat-state 文案；成功消息即清除）。 */
  connectionHint: string
  /** 附件数据面（旧 state.files；上传/选择/移除经 api，预览弹窗在批 2b）。 */
  files: AttachmentItem[]
  /** 图片模型能力提示（旧 #chat-image-capability；warning=能力不足/检查失败）。 */
  imageCapability: { message: string; warning: boolean } | null

  setDraft: (draft: string) => void
  /** 切走前把草稿存进暂存表（旧 inputs.set(state.id??'new', value)）。 */
  stashDraft: (conversationId: string) => void
  /** 切入后恢复草稿（旧 inputs.get(id??'new') ?? ''）。 */
  restoreDraft: (conversationId: string | null) => void
  setResearch: (research: boolean) => void
  setSending: (sending: boolean) => void
  setStopping: (stopping: boolean) => void
  setUploading: (uploading: boolean) => void
  setConnectionHint: (hint: string) => void
  setFiles: (files: AttachmentItem[]) => void
  setImageCapability: (capability: { message: string; warning: boolean } | null) => void
  resetTransient: () => void
}

export const useComposerStore = create<ComposerState>(set => ({
  draft: '',
  draftsByConversation: {},
  research: true,
  sending: false,
  stopping: false,
  uploading: false,
  connectionHint: '',
  files: [],
  imageCapability: null,

  setDraft: draft => set({ draft }),

  stashDraft: conversationId => set(state => ({
    draftsByConversation: { ...state.draftsByConversation, [conversationId]: state.draft },
  })),

  restoreDraft: conversationId => set(state => {
    const key = conversationId ?? 'new'
    return { draft: state.draftsByConversation[key] ?? '' }
  }),

  setResearch: research => set({ research }),
  setSending: sending => set({ sending }),
  setStopping: stopping => set({ stopping }),
  setUploading: uploading => set({ uploading }),
  setConnectionHint: connectionHint => set({ connectionHint }),
  setFiles: files => set({ files }),
  setImageCapability: imageCapability => set({ imageCapability }),

  resetTransient: () => set({
    sending: false,
    stopping: false,
    uploading: false,
    connectionHint: '',
    files: [],
    imageCapability: null,
  }),
}))

/**
 * 模型选择 store（旧 web/model-picker.js 的状态面；展示面在 components/ModelPicker.tsx）。
 *
 * 语义照旧：payload() 未就绪抛错；dirty 才随请求提交 modelSelection；新对话（无
 * 会话上下文）刷新后默认选中目录默认值且视为 dirty（显式提交默认模型是旧行为：
 * 服务端 selectModel 会同步 Auth 默认模型）。chat-send 的响应 accept 后不再提交
 * （会话已有自己的模型）。
 */
export interface PickerState {
  catalog: ModelCatalog | null
  ready: boolean
  busy: boolean
  errorText: string
  selected: ModelSelection | null
  dirty: boolean
  /** 请求代次：迟到目录作废（旧 picker epoch）。 */
  epoch: number
  /** 当前目录上下文（哪个会话的目录；重试按钮复用）。 */
  contextId: string | null

  refresh: (conversationId: string | null, reset?: boolean) => Promise<void>
  /** 发送前取模型载荷；未就绪抛错（旧 payload 口径）。 */
  payload: () => { modelSelection?: ModelSelection }
  /** chat-send 响应：服务端接受的模型回写并锁定。 */
  accept: (model: ModelSelection | null | undefined) => void
  setBusy: (busy: boolean) => void
}

export const usePickerStore = create<PickerState>((set, get) => ({
  catalog: null,
  ready: false,
  busy: false,
  errorText: '',
  selected: null,
  dirty: false,
  epoch: 0,
  contextId: null,

  refresh: async (conversationId, reset = true) => {
    const version = get().epoch + 1
    set({ epoch: version, contextId: conversationId })
    if (reset) set({ ready: false, selected: null, dirty: false, errorText: '' })
    try {
      const catalog = await api.models(conversationId)
      if (version !== get().epoch) return
      set(state => ({
        catalog,
        ready: true,
        errorText: '',
        selected: reset ? catalog.selected ?? null : state.selected,
        dirty: reset ? (conversationId ?? '') === '' : state.dirty,
      }))
    } catch (error) {
      if (version !== get().epoch) return
      set({ ready: false, errorText: error instanceof Error ? error.message : String(error) })
    }
  },

  payload: () => {
    const state = get()
    if (!state.ready) throw new Error(state.errorText || '模型目录正在加载，请稍后发送')
    return state.dirty && state.selected !== null ? { modelSelection: state.selected } : {}
  },

  accept: model => {
    if (model === null || model === undefined) return
    set({ selected: model, dirty: false })
  },

  setBusy: busy => set({ busy }),
}))
