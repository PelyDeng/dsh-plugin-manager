/**
 * 会话控制流（旧 web/chat.js initChat 的解耦重写：activate/connect/refresh/
 * send/stop/ensureConversation，方案 §4.3「解耦重写而非搬运」）。
 *
 * 三守卫的单一实现（新旧对照）：
 * | 旧（chat.js）                          | 新（本文件）                                  |
 * |---------------------------------------|----------------------------------------------|
 * | epoch（state.epoch，activate ++）      | viewToken（session store，beginViewChange ++）|
 * | refreshVersion（模块级，回包乱序丢弃） | refreshTicket（同语义，只核对「还是最新」）   |
 * | liveClock（live 帧 ++，重拉合并判据）  | turn.liveClock + liveAt（显式新鲜度时限）     |
 *
 * 守卫语义：在途回包（chat-history 重拉）在落地前核对 viewToken + ticket；流事件
 * 在入口核对 viewToken + 会话 id 双项（旧 onmessage 的 epoch!==state.epoch||
 * id!==state.id）。任一不满足即丢弃且不写任何 store。
 *
 * 订阅-快照协议如实建模（与 butler 的 lastSeq 管线**不同构**，契约不换）：
 * EventSource 收 live/snapshot/changed 三类消息——live 整段替换（turn.applyLive）；
 * snapshot/changed 一律触发 60ms 防抖后全量 chat-history 重拉（snapshot 的 value
 * 不直接渲染，旧码同款：渲染真相以重拉结果为准）；ping 心跳忽略。
 */
import { api, uploadAttachment } from './lib/api.ts'
import { basePath } from './lib/config.ts'
import { chatConversationTarget, setStorageAdapter, storedConversationId, useConversationStore } from './stores/conversation.ts'
import { usePickerStore, useComposerStore } from './stores/composer.ts'
import { useSessionStore } from './stores/session.ts'
import { useTurnStore } from './stores/turn.ts'
import type { StreamMessage } from './lib/types.ts'

/** snapshot/changed 后全量重拉的防抖窗口（旧 chat.js:96 的 60ms）。 */
export const REFRESH_DEBOUNCE_MS = 60
/** 单份资料上限（旧 uploadFiles 的 20 MiB）。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

// ── 模块级在途句柄（同一时刻至多一条流、一个在途创建、一个待发指纹；旧码同形态）──
let activeStream: EventSource | null = null
let refreshTimer: ReturnType<typeof setTimeout> | undefined
/** 乱序守卫（旧 refreshVersion）：每次重拉 ++，回包只认最新票。 */
let refreshTicket = 0
/** 会话列表请求票（旧侧栏内部 version 守卫）。 */
let listTicket = 0
/** 进行中的会话创建（旧 creating：按代次判活，防并发双建）。 */
let creating: { view: number; promise: Promise<string> } | null = null
/** 待发请求指纹（旧 state.pending：同输入复用同一 requestId，chat-send 幂等键）。 */
type SendInput = Parameters<typeof api.send>[0]
let pendingSend: { fingerprint: string; input: SendInput } | null = null

function staleView(view: number): boolean {
  return view !== useSessionStore.getState().viewToken
}

function notifyError(error: unknown): void {
  useSessionStore.getState().setNotice({ text: error instanceof Error ? error.message : String(error), tone: 'error' })
}

// ── 订阅-快照：连接与消息分发 ─────────────────────────────────────────────

/**
 * 建立 EventSource 订阅（旧 connect 的解耦重写）。幂等：先关旧流再建——
 * StrictMode 双挂载（effect 建立→清理→再建立）与重连都不重复消费。
 * 返回清理函数；EventSource 断线由浏览器自动重连，onerror 只置提示（旧码同款）。
 */
export function connect(id: string, view: number): () => void {
  closeStream()
  if (id === '' || staleView(view)) return () => {}
  const stream = new EventSource(basePath(`/chat-events?conversationId=${encodeURIComponent(id)}`))
  activeStream = stream
  stream.onmessage = event => { handleStreamMessage(String(event.data ?? ''), id, view) }
  stream.onerror = () => {
    if (staleView(view) || id !== useConversationStore.getState().conversationId) return
    useComposerStore.getState().setConnectionHint('连接中断，正在重新连接；已提交的任务可在历史中查看')
  }
  return () => {
    if (activeStream === stream) {
      activeStream = null
      stream.close()
    }
  }
}

export function closeStream(): void {
  if (activeStream !== null) {
    activeStream.close()
    activeStream = null
  }
}

/** 一条 SSE 消息的入口（旧 onmessage；单测直接驱动，不依赖 EventSource）。 */
export function handleStreamMessage(raw: string, id: string, view: number): void {
  // 双核对（旧 chat.js:93）：代次切换或会话已易主，迟到消息一律丢弃。
  if (staleView(view) || id !== useConversationStore.getState().conversationId) return
  let data: StreamMessage
  try {
    data = JSON.parse(raw) as StreamMessage
  } catch {
    notifyError(new Error('对话流返回异常，请重新打开此对话'))
    return
  }
  if (data.type === 'ping') return
  if (data.type === 'live') {
    useTurnStore.getState().applyLive(data.live)
    useComposerStore.getState().setConnectionHint('')
    return
  }
  if (data.type === 'snapshot' || data.type === 'changed') {
    useComposerStore.getState().setConnectionHint('')
    scheduleRefresh()
  }
}

// ── 全量重拉：防抖 + 三守卫 ───────────────────────────────────────────────

function clearRefreshTimer(): void {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer)
    refreshTimer = undefined
  }
}

/** snapshot/changed 的统一入口：60ms 防抖合并后全量重拉（旧码语义保留）。 */
export function scheduleRefresh(): void {
  clearRefreshTimer()
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    void refresh().catch(notifyError)
  }, REFRESH_DEBOUNCE_MS)
}

/** 测试/时序收敛用：清除挂起的防抖重拉（activate 的原子动作之一）。 */
export function clearScheduledRefresh(): void {
  clearRefreshTimer()
}

/** 全量 chat-history 重拉（旧 refresh 的解耦重写；守卫核对点全部内联）。 */
export async function refresh(): Promise<void> {
  const id = useConversationStore.getState().conversationId
  if (id === '') return
  const view = useSessionStore.getState().viewToken
  const ticket = ++refreshTicket
  const liveClockAtStart = useTurnStore.getState().liveClock
  const data = await api.history(id)
  // 乱序守卫（旧 version!==refreshVersion）：后发的重拉已取代本票。
  if (ticket !== refreshTicket) return
  // 代次守卫（旧 epoch!==state.epoch）：会话已切换。
  if (staleView(view)) return
  // live 段保护（旧 data.busy&&clock!==state.liveClock 的合并判据，含新鲜度时限）。
  const merged = useTurnStore.getState().mergeLive(data, liveClockAtStart)
  useConversationStore.getState().acceptHistory(merged)
  // live 投影位与快照对齐（旧码 live 寄存于 history、重拉整体覆盖的等价语义）：
  // 完成后快照 live=null 即收口流式区；busy 中受保护场景回写的是本地 live，无变化。
  useTurnStore.getState().setLive(merged.live)
}

// ── 会话导航与创建 ────────────────────────────────────────────────────────

/**
 * 打开一个会话（旧 activate 的解耦重写）。前半是**单一原子动作**：bump 代次 +
 * 断流 + 停防抖 + 清面板 + 重置输入域——守卫不在各 store 复制（方案 §4.3）。
 */
export async function activate(id: string | null): Promise<void> {
  const session = useSessionStore.getState()
  const conversation = useConversationStore.getState()
  const composer = useComposerStore.getState()
  composer.stashDraft(conversation.conversationId)
  session.beginViewChange()
  const view = useSessionStore.getState().viewToken
  closeStream()
  clearRefreshTimer()
  pendingSend = null
  conversation.resetPanel()
  useTurnStore.getState().resetLive()
  composer.resetTransient()
  session.setNotice(null)
  // 会话 id 落地（storage + URL 同步在 setConversationId 单点；'' 即移除）。
  useConversationStore.getState().setConversationId(id ?? '')
  useComposerStore.getState().restoreDraft(id)
  await usePickerStore.getState().refresh(id)
  if (staleView(view)) return
  if (id !== null) {
    await Promise.all([refresh(), loadFiles()])
    if (staleView(view)) return
  }
  void refreshConversations().catch(notifyError)
}

/** 开新对话（旧 newConversation → activate(null)：清面板聚焦输入）。 */
export function newConversation(): void {
  void activate(null).catch(notifyError)
}

/** 进行中的会话创建按代次判活（旧 creating?.epoch===epoch）。 */
async function ensureConversation(): Promise<string> {
  const existing = useConversationStore.getState().conversationId
  if (existing !== '') return existing
  const view = useSessionStore.getState().viewToken
  if (creating?.view === view) return creating.promise
  const pending: { view: number; promise: Promise<string> } = { view, promise: Promise.resolve('') }
  creating = pending
  pending.promise = (async () => {
    const created = await api.create(crypto.randomUUID())
    if (staleView(view)) throw new Error('对话已切换，请在当前对话重试')
    useConversationStore.getState().setConversationId(created.id)
    connect(created.id, view)
    void refreshConversations().catch(notifyError)
    return created.id
  })()
  try {
    return await pending.promise
  } finally {
    if (creating === pending) creating = null
  }
}

// ── 会话列表（历史抽屉数据面）─────────────────────────────────────────────

export async function refreshConversations(append = false): Promise<void> {
  const store = useConversationStore.getState()
  const ticket = ++listTicket
  const offset = append ? store.conversationsOffset ?? 0 : 0
  const query = store.conversationsQuery
  try {
    const page = await api.list(offset, query)
    if (ticket !== listTicket) return
    useConversationStore.getState().acceptConversationPage(page.items, page.nextOffset, append)
  } catch (error) {
    if (ticket !== listTicket) return
    useConversationStore.getState().setConversationsError(error instanceof Error ? error.message : String(error))
  }
}

// ── 发送与停止 ────────────────────────────────────────────────────────────

export async function send(text: string, retryFrom: string | null = null): Promise<void> {
  const composer = useComposerStore.getState()
  const history = useConversationStore.getState().history
  // 忙判定与旧 controls/send 入口同序：sending/uploading/stopping/history.busy。
  if (composer.sending || composer.uploading || composer.stopping || history?.busy === true) return
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('请输入消息')
  composer.setSending(true)
  const view = useSessionStore.getState().viewToken
  try {
    const id = await ensureConversation()
    const picker = usePickerStore.getState()
    const modelPayload = picker.payload()
    const attachments = useComposerStore.getState().files
      .filter(file => file.selected && file.status === 'ready')
      .map(file => ({
        id: file.id,
        ...(file.version === undefined ? {} : { version: file.version }),
        ...(file.range === undefined ? {} : { range: file.range }),
      }))
    const input: SendInput = {
      conversationId: id,
      text: trimmed,
      research: useComposerStore.getState().research,
      attachments,
      ...modelPayload,
      ...(retryFrom === null ? {} : { retryFrom }),
    }
    const fingerprint = JSON.stringify(input)
    // 同一输入复用同一 requestId（旧 state.pending：chat-send 幂等，双击不重复计费）。
    if (pendingSend?.fingerprint !== fingerprint) {
      pendingSend = { fingerprint, input: { ...input, requestId: crypto.randomUUID() } }
    }
    const outbound = pendingSend
    if (outbound === null) return
    const accepted = await api.send(outbound.input)
    // 代次守卫：发送在途时切了会话，回包不再写任何状态（旧 epoch!==state.epoch return）。
    if (staleView(view)) return
    usePickerStore.getState().accept(accepted.model)
    pendingSend = null
    const composerNow = useComposerStore.getState()
    // 输入框仍是发送原文才清空（用户已改字则保留；旧码同判）。
    if (composerNow.draft === text) composerNow.setDraft('')
    useComposerStore.setState(state => {
      const stashed = { ...state.draftsByConversation }
      delete stashed[id]
      return { draftsByConversation: stashed }
    })
    await Promise.all(attachments.map(file => api.attachmentSelect({
      draftId: id,
      id: file.id,
      selected: false,
      ...(file.range === undefined ? {} : { range: file.range }),
    })))
    await Promise.all([refresh(), loadFiles(), refreshConversations()])
  } finally {
    if (!staleView(view)) useComposerStore.getState().setSending(false)
  }
}

/** 停止回答（旧 chat-stop 监听：置 stopping → 通知服务端 → 重拉收尾）。 */
export async function stopAnswer(): Promise<void> {
  const composer = useComposerStore.getState()
  if (composer.stopping) return
  const id = useConversationStore.getState().conversationId
  const view = useSessionStore.getState().viewToken
  composer.setStopping(true)
  try {
    if (id !== '') await api.stop(id)
    if (!staleView(view)) await refresh()
  } finally {
    if (!staleView(view)) useComposerStore.getState().setStopping(false)
  }
}

// ── 附件数据面 ────────────────────────────────────────────────────────────

export async function loadFiles(): Promise<void> {
  const id = useConversationStore.getState().conversationId
  if (id === '') return
  const view = useSessionStore.getState().viewToken
  const files = await api.attachments(id)
  if (staleView(view)) return
  useComposerStore.getState().setFiles(files)
  void refreshImageCapability()
}

/** 勾选/取消一份资料随消息发送（旧附件行的 checkbox 动作）。 */
export async function toggleAttachment(id: string, selected: boolean): Promise<void> {
  const conversationId = useConversationStore.getState().conversationId
  const file = useComposerStore.getState().files.find(item => item.id === id)
  if (file === undefined) return
  await api.attachmentSelect({
    draftId: conversationId,
    id,
    selected,
    ...(file.range === undefined ? { range: null } : { range: file.range }),
  })
  await loadFiles()
}

/** 移除一份资料。 */
export async function removeAttachment(id: string): Promise<void> {
  const conversationId = useConversationStore.getState().conversationId
  await api.attachmentRemove(conversationId, id)
  await loadFiles()
}

/** 选中图片附件时检查当前模型的图片能力（旧 showImageCapability）。 */
export async function refreshImageCapability(): Promise<void> {
  const composer = useComposerStore.getState()
  const id = useConversationStore.getState().conversationId
  if (id === '' || !composer.files.some(file => file.selected && file.kind.startsWith('image/'))) {
    composer.setImageCapability(null)
    return
  }
  const view = useSessionStore.getState().viewToken
  composer.setImageCapability({ message: '正在检查图片模型…', warning: false })
  try {
    const modelSelection = usePickerStore.getState().payload().modelSelection
    const result = await api.imageCapability(id, modelSelection)
    const composerNow = useComposerStore.getState()
    if (staleView(view)) return
    if (!composerNow.files.some(file => file.selected && file.kind.startsWith('image/'))) return
    composerNow.setImageCapability({
      message: result.message,
      warning: !result.available || !result.currentSupportsImages,
    })
  } catch (error) {
    if (!staleView(view)) {
      useComposerStore.getState().setImageCapability({
        message: `暂时无法检查图片模型：${error instanceof Error ? error.message : String(error)}`,
        warning: true,
      })
    }
  }
}

/** 粘贴/选择/拖放的资料上传（旧 uploadFiles；先建会话再逐份上传）。 */
export async function uploadFiles(files: readonly File[]): Promise<void> {
  if (files.length === 0) return
  const composer = useComposerStore.getState()
  if (composer.uploading || composer.sending) throw new Error('正在处理资料，请稍后再粘贴或选择文件')
  composer.setUploading(true)
  const view = useSessionStore.getState().viewToken
  try {
    const id = await ensureConversation()
    for (const [index, file] of files.entries()) {
      if (staleView(view)) return
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('单份资料不能超过 20 MiB')
      await uploadAttachment(id, attachmentName(file, index), file)
      if (staleView(view)) return
    }
  } finally {
    try {
      if (!staleView(view)) await loadFiles()
    } finally {
      useComposerStore.getState().setUploading(false)
    }
  }
}

/** 粘贴文件命名（旧 clipboard.js attachmentName：无名二进制给时间戳名）。 */
export function attachmentName(file: File, index = 0): string {
  if (file.name !== '' && /\.[a-z0-9]+$/i.test(file.name)) return file.name
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
  const extension = extensions[file.type]
  return extension !== undefined ? `粘贴图片-${Date.now()}-${index + 1}.${extension}` : file.name !== '' ? file.name : `粘贴文件-${index + 1}`
}

/** Clipboard/drop 同源的文件提取（旧 clipboard.js transferredFiles）。 */
export function transferredFiles(transfer: DataTransfer | null): File[] {
  const files = [...transfer?.files ?? []]
  if (files.length > 0) return files
  return [...transfer?.items ?? []]
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
}

// ── 启动 ──────────────────────────────────────────────────────────────────

/**
 * 页面启动（旧 initChat 尾序列 + app.js start 的身份段）：身份核验 → 深链接/
 * 存储回落目标 → activate。失败回落空对话（旧 catch(e){error(e);activate(null)}）。
 */
export async function bootstrap(): Promise<void> {
  const session = useSessionStore.getState()
  try {
    const identity = await api.identity()
    session.adoptIdentity(identity)
    const search = typeof window === 'undefined' ? '' : window.location.search
    const target = chatConversationTarget(search, storedConversationId(identity.userId))
    if (new URLSearchParams(search).has('conversationId')) useSessionStore.getState().setView('chat')
    await activate(target === '' ? null : target)
  } catch (error) {
    notifyError(error)
    await activate(null).catch(() => {})
  }
}

// 测试装配：内存 storage 注入点随 controller 一并导出（helpers 用）。
export { setStorageAdapter }
