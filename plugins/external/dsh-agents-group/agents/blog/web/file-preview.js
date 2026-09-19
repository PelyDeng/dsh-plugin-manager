/**
 * kkFileView 文件/图片预览共享模块（成员页面侧的**单一实现**）。
 *
 * ## 架构：拷贝分发，渲染无关
 *
 * 后续新的成员智能体要接预览能力时，走与 `chat-base.css` 相同的共享模式：
 * 1. 把本文件**原样复制**进成员的 `web/`（不要改各端拷贝的实现，改就改这一份再同步）；
 * 2. 在成员渲染消息正文（innerHTML 赋值）之后调一次 `enhancePreviews(container)`；
 * 3. 把本模块的样式段（搜 `md-file` / `kkp`）并进成员的聊天样式（chat-base.css）。
 *
 * 本模块**不依赖任何渲染器**：blog 的 markdown-it（linkify 后地址是 `<a href>`）、
 * closedoff 的轻量 md、将来的其他渲染——只要页面上有「地址文本或链接」，enhance 就能
 * 把它升级成预览。两类地址的分工与牛马大总管（受控渲染器内置同一套能力）一致：
 * - **图片**（http(s) + 图片后缀）：直接渲染成缩略图，看得见；
 * - **其他文件**（地址末段带扩展名：pdf/office/压缩包/音视频…）：着重文件卡，点击预览。
 *
 * ## kkFileView 的实测约定（2026-09-19，preview.pelycloud.com）
 *
 * `onlinePreview?url=` 的参数是**直接 Base64** 的地址——先做 encodeURIComponent 会被它
 * 拒成 403；必须走 https（http 端口不响应），页内弹窗的 iframe 因此同为 https。
 * 地址含非 ASCII 字符时先 encodeURI 转成纯 ASCII 再 Base64。
 */

const KKFILEVIEW_BASE = 'https://preview.pelycloud.com'

/** 图片后缀：直接缩略图（其余带扩展名的地址走文件卡）。 */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/iu
/** 裸文本里的 URL：只认 RFC 允许字符，中文标点天然截断。 */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gu

export function kkFileViewUrl(src) {
  const ascii = /^[\x00-\x7F]*$/.test(src) ? src : encodeURI(src)
  // 外层 encodeURIComponent 是官方可行形态（实测 ✅）：裸 Base64 的 "+" 进 query 有被
  // 解析成空格的风险（KK 5.0.2 有兜底，不赌它）。
  return `${KKFILEVIEW_BASE}/onlinePreview?url=${encodeURIComponent(btoa(ascii))}`
}

/** 地址末段的扩展名（小写）；没有按「文件」理解的扩展名时返回 undefined。 */
export function fileExtensionOf(url) {
  const last = (url.split(/[?#]/)[0] ?? '').split('/').pop() ?? ''
  const match = /\.([a-z][a-z0-9]{0,6}|7z)$/i.exec(last)
  return match === null ? undefined : match[1].toLowerCase()
}

/** 展示用的文件名：取地址末段并解百分号编码；解不了就用原样。 */
function displayNameOf(url) {
  const last = (url.split(/[?#]/)[0] ?? '').split('/').pop() || url
  try { return decodeURIComponent(last) } catch { return last }
}

/** 把一个 `<a href>` 链接就地升级成图片缩略图或文件卡。 */
function upgradeLink(a) {
  const href = a.getAttribute('href') ?? ''
  const ext = fileExtensionOf(href)
  const isImage = IMAGE_EXT_RE.test(href)
  if (!isImage && ext === undefined) return
  a.setAttribute('data-preview', href)
  a.setAttribute('rel', 'noopener noreferrer')
  a.addEventListener('click', event => {
    event.preventDefault()
    openPreviewModal(href)
  })
  if (isImage) {
    a.classList.add('md-pic')
    const img = document.createElement('img')
    img.src = href
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    img.alt = a.textContent ?? ''
    a.replaceChildren(img)
    return
  }
  a.classList.add('md-file')
  const badge = document.createElement('span')
  badge.className = 'md-file__ext'
  badge.textContent = ext
  const name = document.createElement('span')
  name.className = 'md-file__name'
  name.textContent = displayNameOf(href)
  a.replaceChildren(badge, name)
}

/**
 * 把容器内已渲染的地址升级成预览（图片缩略图 / 文件卡）。
 *
 * 两遍扫描：`<a href>`（linkify 或模型给的链接）就地升级；纯文本节点里的裸地址拆出来
 * 造同样的节点。重复调用安全（升级过的节点会被跳过）。
 */
export function enhancePreviews(root) {
  if (root === null || root === undefined) return
  for (const a of root.querySelectorAll('a[href]')) {
    if (a.dataset.preview !== undefined) continue
    const href = a.getAttribute('href') ?? ''
    if (!/^https?:\/\//i.test(href)) continue
    upgradeLink(a)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    if (!/^https?:\/\//im.test(text)) continue
    if (URL_RE.test(text)) targets.push(node)
    URL_RE.lastIndex = 0
  }
  for (const node of targets) {
    const text = node.textContent ?? ''
    const parts = document.createDocumentFragment()
    let cursor = 0
    URL_RE.lastIndex = 0
    for (const match of text.matchAll(URL_RE)) {
      const url = match[0].replace(/[.,;:!?]+$/u, '')
      const ext = fileExtensionOf(url)
      const isImage = IMAGE_EXT_RE.test(url)
      if (!isImage && ext === undefined) continue
      const start = match.index ?? 0
      if (start > cursor) parts.appendChild(document.createTextNode(text.slice(cursor, start)))
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      upgradeLink(a)
      parts.appendChild(a)
      cursor = start + url.length
    }
    if (cursor === 0) continue
    if (cursor < text.length) parts.appendChild(document.createTextNode(text.slice(cursor)))
    node.replaceWith(parts)
  }
}

/* ── kkFileView 页内预览弹窗（与牛马大总管同构：遮罩 + 面板 + iframe，Esc/遮罩/按钮关闭） ── */

export function openPreviewModal(url) {
  if (url === '') return
  let mask = document.getElementById('kk-preview')
  if (mask === null) {
    mask = buildPreviewModal()
    document.body.appendChild(mask)
  }
  const title = mask.querySelector('.kkp__title')
  const frame = mask.querySelector('iframe')
  if (title !== null) title.textContent = displayNameOf(url)
  if (frame !== null) frame.src = kkFileViewUrl(url)
  mask.hidden = false
}

function closePreviewModal() {
  const mask = document.getElementById('kk-preview')
  if (mask === null) return
  mask.hidden = true
  const frame = mask.querySelector('iframe')
  if (frame !== null) frame.src = 'about:blank'
}

function buildPreviewModal() {
  const mask = document.createElement('div')
  mask.id = 'kk-preview'
  mask.className = 'kkp'
  mask.hidden = true

  const backdrop = document.createElement('div')
  backdrop.className = 'kkp__backdrop'
  backdrop.addEventListener('click', closePreviewModal)

  const panel = document.createElement('div')
  panel.className = 'kkp__panel'
  panel.addEventListener('click', event => event.stopPropagation())

  const bar = document.createElement('div')
  bar.className = 'kkp__bar'
  const title = document.createElement('span')
  title.className = 'kkp__title'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'kkp__close'
  close.textContent = '✕ 关闭'
  close.addEventListener('click', closePreviewModal)
  bar.appendChild(title)
  bar.appendChild(close)

  const frame = document.createElement('iframe')
  frame.className = 'kkp__frame'
  frame.title = '文件预览'
  frame.src = 'about:blank'

  panel.appendChild(bar)
  panel.appendChild(frame)
  mask.appendChild(backdrop)
  mask.appendChild(panel)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mask.hidden === false) closePreviewModal()
  })
  return mask
}
