/**
 * 模型选择 store（旧 web/model-picker.js 的 React 等价，状态面收进 zustand，
 * 展示面在 components/ModelPicker.tsx）。
 *
 * 语义照旧：payload() 未就绪抛错；dirty 才随请求提交 modelSelection；新对话
 * （无会话上下文）刷新后默认选中目录默认值且视为 dirty（显式提交默认模型是
 * 旧行为：服务端 selectModel 会同步 Auth 默认）。conversation 事件 accept 后
 * 不再提交（会话已有自己的模型）。
 */
import { create } from 'zustand'
import { api } from '../lib/api.ts'
import type { ModelCatalog, ModelSelection } from '../lib/types.ts'
import { errorTextOf } from '@dsh-agents-group/web-common'

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
  contextId: string
  refresh: (conversationId: string, reset?: boolean) => Promise<void>
  /** 发送前取模型载荷；未就绪抛错（旧 payload 口径）。 */
  payload: () => { modelSelection?: ModelSelection }
  /** conversation 事件：会话已有模型，锁定不提交。 */
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
  contextId: '',

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
        dirty: reset ? conversationId === '' : state.dirty,
      }))
    } catch (error) {
      if (version !== get().epoch) return
      set({ ready: false, errorText: errorTextOf(error) })
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
