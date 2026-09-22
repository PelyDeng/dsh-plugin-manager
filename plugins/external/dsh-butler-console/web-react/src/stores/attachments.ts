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
  item: { id: string; name: string; bytes: number; status: string; message?: string } | null
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

/** 一次只传一个（按选择顺序）：并发上传会让服务端计数读到同一个旧值，多出的被 413 拒。 */
export async function addFiles(files: File[], conversationId: string | null): Promise<void> {
  const list = [...files]
  if (list.length === 0) return
  const room = attachmentRoom()
  if (room <= 0) {
    announce(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`)
    return
  }
  for (const file of list.slice(0, room)) {
    const key = attachmentKey()
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useAttachmentsStore.getState().add([{
        key, name: file.name, size: file.size, phase: 'failed',
        message: `超过 ${fileSizeText(MAX_ATTACHMENT_BYTES)}`, item: null,
      }])
      continue
    }
    useAttachmentsStore.getState().add([{ key, name: file.name, size: file.size, phase: 'uploading', message: '', item: null }])
    try {
      const item = await uploadAttachment(file, conversationId ?? '')
      const current = useAttachmentsStore.getState().items.find(value => value.key === key)
      if (current === undefined) continue
      // 服务端说读不出内容（failed）时照实标出：它还是能交出去的，只是管家看不到里面写了什么。
      useAttachmentsStore.getState().update(key, {
        item, name: item.name, size: item.bytes, message: item.message ?? '',
        phase: item.status === 'ready' ? 'ready' : 'failed',
      })
    } catch (error) {
      failAttachment(key, errorTextOf(error, '上传失败'))
    }
  }
  if (list.length > room) {
    announce(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件，多出来的没有加`)
  }
}

/** 从链接取回：地址合法性由服务端判断，页面只做「看起来是不是 http 地址」的预检。 */
export async function addUrl(raw: string, conversationId: string | null): Promise<void> {
  const url = raw.trim()
  if (url === '') return
  if (!/^https?:\/\/\S+$/iu.test(url)) {
    announce('只支持 http 或 https 链接')
    return
  }
  if (attachmentRoom() <= 0) {
    announce(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`)
    return
  }
  const key = attachmentKey()
  useAttachmentsStore.getState().add([{ key, name: url, size: 0, phase: 'uploading', message: '取回中…', item: null }])
  try {
    const item = await attachFromUrl(url, conversationId ?? '')
    const current = useAttachmentsStore.getState().items.find(value => value.key === key)
    if (current === undefined) return
    useAttachmentsStore.getState().update(key, {
      item, name: item.name, size: item.bytes, message: item.message ?? '',
      phase: item.status === 'ready' ? 'ready' : 'failed',
    })
  } catch (error) {
    failAttachment(key, errorTextOf(error, '取回失败'))
  }
}

/** 移除一条。有服务端记录的顺手通知服务端删掉；删不掉也不假装成功，刷新后它会回来。 */
export async function dropAttachment(key: string): Promise<void> {
  const entry = useAttachmentsStore.getState().items.find(value => value.key === key)
  if (entry === undefined) return
  useAttachmentsStore.getState().remove(key)
  if (entry.item === null) return
  try {
    await api.removeAttachment(entry.item.id)
  } catch { /* 服务端没删掉：那是服务端的事实，下次打开会话它会回来。 */ }
}

/** 这一轮要带的附件 id：只带服务端已收下且读得出内容的。 */
export function attachmentsForSend(): string[] {
  return useAttachmentsStore.getState().items
    .filter(entry => entry.item !== null && entry.item.status === 'ready')
    .map(entry => entry.item!.id)
}

export interface SentAttachment {
  key: string
  name: string
  size: number
}

/** 发送时把已交出去的那几条从输入框摘掉（它们随即画到用户消息下面）。 */
export function takeSentAttachments(ids: string[]): SentAttachment[] {
  const sent = new Set(ids)
  const items = useAttachmentsStore.getState().items
  const taken = items
    .filter(entry => entry.item !== null && sent.has(entry.item.id))
    .map(entry => ({ key: entry.key, name: entry.name, size: entry.size }))
  useAttachmentsStore.setState({ items: items.filter(entry => !(entry.item !== null && sent.has(entry.item.id))) })
  return taken
}

/** 清空（换会话/新建时：上一个会话攒的跟着上一个会话走）。 */
export function clearAttachments(): void {
  useAttachmentsStore.getState().reset()
}

/** 刷新/换入口后从服务端重建：附件是服务端的事实，不是页面内存。 */
export async function loadAttachments(conversationId: string | null): Promise<void> {
  clearAttachments()
  if (conversationId === null) return
  try {
    const { items } = await api.attachments(conversationId)
    // 期间切了会话：这份结果作废，不许写进新视图。
    if (useTurnConversationId() !== conversationId) return
    useAttachmentsStore.getState().add((items ?? []).map(item => ({
      key: attachmentKey(),
      name: item.name,
      size: item.bytes,
      phase: item.status === 'ready' ? 'ready' : 'failed',
      message: item.message ?? '',
      item,
    })))
  } catch { /* 读不到就当没有待发附件：不因为这一条失败挡住整个页面。 */ }
}

function useTurnConversationId(): string | null {
  return useTurnStore.getState().conversationId
}
