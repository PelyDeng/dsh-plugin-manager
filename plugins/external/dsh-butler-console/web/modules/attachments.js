/**
 * 待发附件（拆分设计 v2 批 1c）：选文件/拖拽/粘贴/链接取回的统一簿记与附件条渲染。
 * 类型判定与抓取都在服务端，页面只画「上传中/就绪/读不出来」并把选择送出去。
 */

import { clear, make } from './dom.js'
import { el, state } from './state.js'
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, api, attachFromUrl, uploadAttachment } from '../api.js'

/* ── 待发附件 ──────────────────────────────────────────────────────────── */
/**
 * 附件的三个来源最后都落到同一个地方：**一份服务端记录**。
 *
 * - 选文件 / 拖进来 / 粘贴文件 → `uploadAttachment`（裸字节 POST）；
 * - 粘链接 → `attachFromUrl`（服务端去抓，页面不管地址合不合法、能跳几跳、多大）。
 *
 * 页面自己不解析文件、不判断类型：那些规则只有一处实现才不会两边不一致。页面只负责把
 * "上传中 / 就绪 / 读不出来"画出来，以及把用户的选择如实送出去。
 */

/** 页面的附件身份。上传中还没有服务端 id，所以不能拿 id 当键。 */
export function attachmentKey() {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 字节数的人话说法；与服务端 `sizeText` 同一口径。 */
export function fileSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 一条附件的状态行文字。空串表示"没什么要说的"。 */
export function attachmentNote(entry) {
  if (entry.phase === 'uploading') return entry.message === '' ? '上传中…' : entry.message
  if (entry.phase === 'failed') return entry.message === '' ? '没成' : entry.message
  return entry.message
}

export function attachmentChip(entry) {
  const chip = make('span', 'attach__item')
  chip.dataset.phase = entry.phase
  chip.appendChild(make('span', 'attach__name', entry.name))
  const size = fileSizeText(entry.size)
  if (size !== '') chip.appendChild(make('span', 'attach__size', size))
  const note = attachmentNote(entry)
  if (note !== '') chip.appendChild(make('span', 'attach__note', note))
  const remove = make('button', 'attach__remove', '×')
  remove.type = 'button'
  remove.title = '移除'
  remove.setAttribute('aria-label', `移除 ${entry.name}`)
  remove.addEventListener('click', () => { void dropAttachment(entry.key) })
  chip.appendChild(remove)
  return chip
}

/** 附件条为空时整块收起来，不白占输入框上方的地方。 */
export function syncAttachStrip() {
  el.attachStrip.hidden = state.attachments.length === 0 && el.attachUrl.hidden
}

export function renderAttachments() {
  clear(el.attachItems)
  for (const entry of state.attachments) el.attachItems.appendChild(attachmentChip(entry))
  syncAttachStrip()
}

/** 把已经发出去的那几条画在用户消息下面：发完就从输入框挪到消息里，不留一份重复的。 */
export function attachmentChipsRow(entries) {
  const row = make('div', 'attach attach--sent')
  const items = make('div', 'attach__items')
  for (const entry of entries) items.appendChild(attachmentChip({ ...entry, phase: 'ready' }))
  row.appendChild(items)
  return row
}

/** 收下服务端回来的那条记录；期间附件被移除时结果直接丢弃。 */
export function settleAttachment(key, item) {
  const current = state.attachments.find(value => value.key === key)
  if (current === undefined) return
  current.item = item
  current.name = item.name
  current.size = item.bytes
  current.message = item.message ?? ''
  // 服务端说读不出内容（`failed`）时页面照实标出来：它还是能交出去的，只是管家看不到里面写了什么。
  current.phase = item.status === 'ready' ? 'ready' : 'failed'
  renderAttachments()
}

export function failAttachment(key, message) {
  const current = state.attachments.find(value => value.key === key)
  if (current === undefined) return
  current.phase = 'failed'
  current.message = message
  renderAttachments()
}

/** 还能再收几个。上限是服务端配置，页面只跟着它走。 */
export function attachmentRoom() {
  return MAX_ATTACHMENTS_PER_MESSAGE - state.attachments.length
}

/**
 * 收下一批文件。
 *
 * **一次只传一个**（按选择顺序）：并发上传时服务端那边的"待发附件"计数会被几个请求同时读到
 * 同一个旧值，多出来的会被 413 拒掉，而页面上的失败顺序还跟选择顺序对不上。
 */
export async function addFiles(files) {
  const list = [...files]
  if (list.length === 0) return
  const room = attachmentRoom()
  if (room <= 0) {
    reportFailure(new Error(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`), '没加上')
    return
  }
  for (const file of list.slice(0, room)) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      state.attachments.push({
        key: attachmentKey(), name: file.name, size: file.size, phase: 'failed',
        message: `超过 ${fileSizeText(MAX_ATTACHMENT_BYTES)}`, item: null,
      })
      renderAttachments()
      continue
    }
    const entry = { key: attachmentKey(), name: file.name, size: file.size, phase: 'uploading', message: '', item: null }
    state.attachments.push(entry)
    renderAttachments()
    try {
      settleAttachment(entry.key, await uploadAttachment(file, state.conversationId ?? ''))
    } catch (error) {
      failAttachment(entry.key, error instanceof Error && error.message ? error.message : '上传失败')
    }
  }
  if (list.length > room) {
    reportFailure(new Error(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件，多出来的没有加`), '没全加上')
  }
}

/** 从一个链接取回附件。地址的合法性由服务端判断，页面只做"看起来是不是个 http 地址"的预检。 */
export async function addUrl(raw) {
  const url = raw.trim()
  if (url === '') return
  if (!/^https?:\/\/\S+$/iu.test(url)) {
    reportFailure(new Error('只支持 http 或 https 链接'), '没取回来')
    return
  }
  if (attachmentRoom() <= 0) {
    reportFailure(new Error(`一次最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`), '没取回来')
    return
  }
  const entry = { key: attachmentKey(), name: url, size: 0, phase: 'uploading', message: '取回中…', item: null }
  state.attachments.push(entry)
  renderAttachments()
  try {
    settleAttachment(entry.key, await attachFromUrl(url, state.conversationId ?? ''))
  } catch (error) {
    failAttachment(entry.key, error instanceof Error && error.message ? error.message : '取回失败')
  }
}

/** 移除一条。有服务端记录的顺手通知服务端删掉；删不掉也不假装成功，下次刷新它还会出现。 */
export async function dropAttachment(key) {
  const index = state.attachments.findIndex(value => value.key === key)
  if (index < 0) return
  const [entry] = state.attachments.splice(index, 1)
  renderAttachments()
  if (entry.item === null) return
  try {
    await api.removeAttachment(entry.item.id)
  } catch { /* 服务端没删掉：那是服务端的事实，下次打开会话它会回来。 */ }
}

/** 这一轮要带上的附件 id：只带服务端已经收下、而且读得出内容的那几条。 */
export function attachmentsForSend() {
  return state.attachments
    .filter(entry => entry.item !== null && entry.item.status === 'ready')
    .map(entry => entry.item.id)
}

/** 发送时把已经交出去的那几条从输入框上摘掉（它们随即画到用户消息下面）。 */
export function takeSentAttachments(ids) {
  const sent = new Set(ids)
  const taken = state.attachments.filter(entry => entry.item !== null && sent.has(entry.item.id))
  state.attachments = state.attachments.filter(entry => !(entry.item !== null && sent.has(entry.item.id)))
  renderAttachments()
  return taken
}

export function clearAttachments() {
  state.attachments = []
  renderAttachments()
}

export function hideAttachUrl() {
  el.attachUrl.hidden = true
  el.attachUrlInput.value = ''
  syncAttachStrip()
}

/**
 * 从服务端重建附件条。
 *
 * 附件是服务端的事实，不是页面的内存：刷新、换个入口、另一台设备打开同一个会话，看到的都该是
 * 同一份"还没发出去的文件"。
 */
export async function loadAttachments() {
  const conversationId = state.conversationId
  clearAttachments()
  if (conversationId === null) return
  try {
    const { items } = await api.attachments(conversationId)
    // 期间切了会话：这份结果作废，不许写进新视图。
    if (state.conversationId !== conversationId) return
    state.attachments = (items ?? []).map(item => ({
      key: attachmentKey(),
      name: item.name,
      size: item.bytes,
      phase: item.status === 'ready' ? 'ready' : 'failed',
      message: item.message ?? '',
      item,
    }))
    renderAttachments()
  } catch { /* 读不到就当没有待发附件：不因为这一条失败挡住整个页面。 */ }
}

/**
 * 附件入口：回形针、链接、拖拽、粘贴。
 *
 * 拖拽区挂在**整块输入区**（`el.composer`）上，不是只挂那个按钮：用户拖文件时瞄的是"输入框
 * 那一片"，而按钮只有二十几像素宽，要求精确落在它上面等于让功能时灵时不灵。
 */
export function bindAttachments() {
  el.attachButton.addEventListener('click', () => { el.attachInput.click() })
  el.attachInput.addEventListener('change', () => {
    const files = [...(el.attachInput.files ?? [])]
    // 清空 value：同一个文件选第二次也要能触发 change，否则第二次什么都不发生。
    el.attachInput.value = ''
    void addFiles(files)
  })

  el.attachLinkButton.addEventListener('click', () => {
    el.attachUrl.hidden = false
    syncAttachStrip()
    el.attachUrlInput.focus()
  })
  el.attachUrlCancel.addEventListener('click', () => { hideAttachUrl() })
  el.attachUrlInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      hideAttachUrl()
      return
    }
    if (event.key !== 'Enter' || event.isComposing) return
    // 回车是"取回这个链接"，不是"发送"：这里只是在填一个链接，不该把还没写完的消息发出去。
    event.preventDefault()
    const url = el.attachUrlInput.value
    hideAttachUrl()
    void addUrl(url)
  })

  el.composer.addEventListener('dragover', event => {
    if (event.dataTransfer?.types?.includes('Files') !== true) return
    event.preventDefault()
    el.composer.classList.add('composer--drop')
  })
  el.composer.addEventListener('dragleave', event => {
    // 在子元素之间移动也会触发 dragleave：只有真的离开整块区域时才撤掉反馈。
    const next = event.relatedTarget
    if (next !== null && next instanceof Node && el.composer.contains(next)) return
    el.composer.classList.remove('composer--drop')
  })
  el.composer.addEventListener('drop', event => {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    el.composer.classList.remove('composer--drop')
    void addFiles(files)
  })

  // 粘贴：截图与复制过来的文件走同一条路。纯文字粘贴不拦——用户很可能就是在贴一段话。
  el.composer.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    void addFiles(files)
  })
}
