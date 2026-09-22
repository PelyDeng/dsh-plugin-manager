import { errorTextOf } from '../lib/error-text.ts'
/**
 * 待发附件 store（批 4a）：选文件/拖拽/粘贴/链接取回的统一簿记（语义对齐 web/modules/
 * attachments.js）。三个来源最后都落到一份服务端记录；页面只画「上传中/就绪/读不出来」。
 */
import { create } from 'zustand'
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, api, attachFromUrl, uploadAttachment } from '../lib/api.ts'
import { announce } from '../lib/announce.ts'
import { useTurnStore } from './turn.ts'

/** 页面侧附件条目。上传中还没有服务端 id，key 是页面自己的身份。 */
export interface AttachmentEntry {
  key: string
  name: string
  size: number
  phase: 'uploading' | 'ready' | 'failed'
  message: string
  item: { id: string; name: string; bytes: number; status: string; message?: string; kind?: string; preview?: string; totalUnits?: number; characters?: number; sourceUrl?: string } | null
}

export interface AttachmentsState {
  items: AttachmentEntry[]
  urlInputVisible: boolean
  add: (entries: AttachmentEntry[]) => void
  update: (key: string, patch: Partial<AttachmentEntry>) => void
  remove: (key: string) => void
  setUrlInputVisible: (visible: boolean) => void
  reset: () => void
}

export const useAttachmentsStore = create<AttachmentsState>((set, get) => ({
  items: [],
  urlInputVisible: false,
  add: entries => set(state => ({ items: [...state.items, ...entries] })),
  update: (key, patch) => set(state => ({
    items: state.items.map(entry => entry.key === key ? { ...entry, ...patch } : entry),
  })),
  remove: key => set(state => ({ items: state.items.filter(entry => entry.key !== key) })),
  setUrlInputVisible: urlInputVisible => set({ urlInputVisible }),
  reset: () => set({ items: [], urlInputVisible: false }),
}))

const attachmentKey = () => `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 字节数的人话说法；与服务端 sizeText 同一口径。 */
export function fileSizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 还能再收几个：上限是服务端配置，页面只跟着它走。 */
export function attachmentRoom(): number {
  return MAX_ATTACHMENTS_PER_MESSAGE - useAttachmentsStore.getState().items.length
}

function failAttachment(key: string, message: string): void {
  useAttachmentsStore.getState().update(key, { phase: 'failed', message })
}

// 附件的 IO 编排（上传/链接取回/拉取已有）已迁 flows/attachments.ts（评审 #10 步 4）——
// store 只保留状态簿记；本文件遗留的导入为簿记函数所需。
