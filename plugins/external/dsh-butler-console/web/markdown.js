/**
 * 受控 Markdown 渲染（方案 5.4 / C 批）。
 *
 * 复用 dsh-example 已声明的同一解析依赖 markdown-it（版本一致），但管家不把解析结果
 * 变成 HTML 字符串：先解析成 token，映射为一份「节点计划」（纯数据），再由渲染器按
 * 白名单标签建 DOM，所有文本一律写文本节点。安全顺序是解析原文 → 映射允许节点 →
 * 文本写文本节点，不是先转 HTML 实体再重复转义。
 *
 * 首版边界：标题、段落、粗斜体、删除线、行内代码、代码块、列表、引用、分隔线、简单
 * 表格（表头/单元格/对齐）。外链只出可复制的纯文本（标题 + 完整地址），不生成可点击
 * 链接、不开自动链接；原生 HTML 原样显示为文本。未闭合围栏、半张表格按不完整输入
 * 处理，markdown-it 的容错解析不会抛错。
 *
 * **图片是链接之外的唯一例外**（2026-09-19）：图片地址渲染成受控缩略图并接入
 * kkFileView 在线预览。安全口径不变的部分：不执行任何 HTML、`<img>` 只由本文件按
 * 协议白名单（http/https）创建、DOM 全部由白名单标签构建。变化的部分：正文中的图片
 * 地址会发起一次图片请求（`loading=lazy`、`referrerpolicy=no-referrer`），点击新窗口
 * 进 kkFileView 看大图——抓取原图的是 kkFileView 服务端，不受本页的混合内容限制。
 */
import MarkdownIt from 'markdown-it'

// html:false 让模型输出的 HTML 全部变成待显示文本；linkify:false 关掉裸地址自动链接；
// breaks:true 与 example 一致，单个换行视为换行。
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true })

/**
 * 图片预览服务（kkFileView，站点私有部署）：聊天里的地址按两类渲染——
 *
 * - **图片**（http(s) 且图片后缀）：受控缩略图直接在会话里预览；
 * - **其他文件**（地址末段带扩展名：pdf/office/压缩包/音视频等）：渲染成着重文件卡，
 *   点击打开**页内预览弹窗**（iframe 嵌 kkFileView 的 onlinePreview）。
 *
 * 实测约定（2026-09-19，preview.pelycloud.com）：`url` 参数是**直接 Base64** 的地址，
 * 先做 encodeURIComponent 会被它拒成 403；且必须走 https（http 端口不响应）——弹窗的
 * iframe 也因此必须 https，否则被本页的混合内容策略拦掉。地址含非 ASCII 字符时先
 * encodeURI 转成纯 ASCII 再 Base64。
 */
const KKFILEVIEW_BASE = 'https://preview.pelycloud.com'

/** 裸文本里的 URL：只认 RFC 允许字符，中文标点天然截断（URL 后面跟"，。"不会吃进来）。 */
const IMAGE_URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gu
/** 自动识别为图片的后缀（裸 URL 靠它收窄；markdown 图片语法不必带这些后缀）。 */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/iu

function kkFileViewUrl(src) {
  const ascii = /^[\x00-\x7F]*$/.test(src) ? src : encodeURI(src)
  // 外层 encodeURIComponent 是官方可行形态（实测 ✅）：裸 Base64 里的 "+" 进 query 会被
  // 解析成空格——KK 5.0.2 有空格兜底，但不赌它。
  return `${KKFILEVIEW_BASE}/onlinePreview?url=${encodeURIComponent(btoa(ascii))}`
}

/** 块级标签白名单：标签由渲染器固定，模型只能决定文本与结构。 */
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'])
/** 行内标签白名单。删除线在 markdown-it 里是 `s` 标签（`del` 一并保留兼容）。 */
const INLINE_TAGS = new Set(['strong', 'em', 'del', 's'])

/** 代码块语言标签：白名单外的字符一律丢弃，不采用模型提供的原始字符串。 */
function languageClass(info) {
  const language = info.trim().split(/\s+/)[0] ?? ''
  return /^[\w+#.-]{1,20}$/.test(language) ? `language-${language}` : ''
}

/** 单元格对齐：只接受 markdown-it 给出的三种 text-align，其余样式忽略。 */
function alignOf(token) {
  const style = token.attrGet?.('style') ?? ''
  const match = /^text-align:\s*(left|center|right)\s*;?$/.exec(style)
  return match === null ? '' : match[1]
}

/** 地址末段的扩展名（小写）；没有按「文件」理解的扩展名时返回 undefined。 */
function fileExtensionOf(url) {
  const last = (url.split(/[?#]/)[0] ?? '').split('/').pop() ?? ''
  // 首位必须字母（`v1.2` 的 `.2` 不算扩展名），长度 1–7；`7z` 这类数字开头归入特例。
  const match = /\.([a-z][a-z0-9]{0,6}|7z)$/i.exec(last)
  return match === null ? undefined : match[1].toLowerCase()
}

/** 展示用的文件名：取地址末段并解百分号编码；解不了就用原样。 */
function displayNameOf(url) {
  const last = (url.split(/[?#]/)[0] ?? '').split('/').pop() || url
  try { return decodeURIComponent(last) } catch { return last }
}

function pushText(parent, text) {
  if (text !== '') parent.children.push({ text })
}

/**
 * 受控图片节点：`a.md-pic` 包一张缩略图，点击打开页内预览弹窗。
 *
 * 只由本函数创建（协议白名单 http/https，`javascript:` 之类进不来）；`referrerpolicy`
 * 与 `rel` 收紧引用面；`alt`/`title` 是纯文本属性，注入不了标签。`target=_blank` 只是
 * JS 失效时的回退——正常点击被渲染器接管成弹窗。
 */
function imageSpec(src, alt) {
  return {
    tag: 'a',
    className: 'md-pic',
    attrs: {
      href: kkFileViewUrl(src),
      target: '_blank',
      rel: 'noopener noreferrer',
      'data-preview': src,
      ...(alt === '' ? {} : { title: alt }),
    },
    children: [{ tag: 'img', attrs: { src, alt, loading: 'lazy', referrerpolicy: 'no-referrer' } }],
  }
}

/**
 * 受控文件卡：非图片文件的地址渲染成着重卡片，点击打开页内预览弹窗。
 *
 * 与图片的分界：图片「直接预览」，文件「着重 + 点击预览」——长会话里一排地址能一眼
 * 分出哪个能看图、哪个要点击。扩展名徽标取自地址本身，不猜格式。
 */
function fileSpec(url, ext) {
  return {
    tag: 'a',
    className: 'md-file',
    attrs: {
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      'data-preview': url,
      title: '点击预览这个文件',
    },
    children: [
      { tag: 'span', className: 'md-file__ext', text: ext },
      { tag: 'span', className: 'md-file__name', text: displayNameOf(url) },
    ],
  }
}

/** 带预览识别的文本写入：图片地址→缩略图，文件地址→文件卡，其余保持纯文本。 */
function pushTextWithImages(parent, text) {
  let cursor = 0
  for (const match of text.matchAll(IMAGE_URL_RE)) {
    const raw = match[0]
    // 句尾标点是文章的，不是地址的：修剪后判断后缀，修剪掉的部分还给文本。
    const url = raw.replace(/[.,;:!?]+$/u, '')
    const start = match.index ?? 0
    const image = IMAGE_EXT_RE.test(url)
    const ext = fileExtensionOf(url)
    if (!image && ext === undefined) continue
    if (start > cursor) pushText(parent, text.slice(cursor, start))
    parent.children.push(image ? imageSpec(url, '') : fileSpec(url, ext))
    cursor = start + url.length
  }
  if (cursor === 0) { pushText(parent, text); return }
  if (cursor < text.length) pushText(parent, text.slice(cursor))
}

/** 行内 token：文本、行内代码、粗斜体删除线、换行；链接降级为纯文本，图片出受控缩略图。 */
function planInline(parent, tokens) {
  const stack = [parent]
  for (const token of tokens ?? []) {
    const top = stack[stack.length - 1]
    switch (token.type) {
      case 'text':
        pushTextWithImages(top, token.content)
        break
      case 'code_inline':
        top.children.push({ tag: 'code', text: token.content })
        break
      case 'softbreak':
      case 'hardbreak':
        top.children.push({ tag: 'br' })
        break
      case 'html_inline':
        // 原生 HTML 不执行：原样文本。
        pushText(top, token.content)
        break
      case 'image': {
        // markdown 图片语法是明确的展示意图：http(s) 的地址按后缀分流——图片出受控缩略图，
        // 非图片（pdf 等被当成"图"写出来的地址）出文件卡；其余（相对路径、data: 等）维持
        // 占位文本，把描述和地址都给全。alt 在 token.content 里。
        const src = token.attrGet?.('src') ?? ''
        const alt = token.content ?? token.attrGet?.('alt') ?? ''
        const httpLike = /^https?:\/\//iu.test(src) && !/\s/u.test(src)
        const ext = httpLike ? fileExtensionOf(src) : undefined
        if (httpLike && (IMAGE_EXT_RE.test(src) || ext === undefined)) top.children.push(imageSpec(src, alt))
        else if (httpLike) top.children.push(fileSpec(src, ext))
        else pushText(top, alt === '' ? `[图片：${src}]` : `[图片：${alt} ${src}]`)
        break
      }
      case 'link_open': {
        // 不建锚点：链接内容照常渲染，收尾补上完整地址，两边都可复制。
        const link = { link: true, href: token.attrGet?.('href') ?? '', children: [] }
        top.children.push(link)
        stack.push(link)
        break
      }
      case 'link_close': {
        const link = stack.pop()
        if (link === undefined || link.link !== true) break
        const parentOfLink = stack[stack.length - 1]
        parentOfLink.children.pop()
        parentOfLink.children.push(...link.children)
        const visible = link.children.map(child => child.text ?? '').join('')
        // 地址本身已是正文（如 `<https://…>` 自动链接）时不再重复一遍。
        if (link.href !== '' && link.href !== visible) pushTextWithImages(parentOfLink, `（${link.href}）`)
        break
      }
      default:
        if (token.type.endsWith('_open') && INLINE_TAGS.has(token.tag)) {
          const node = { tag: token.tag, children: [] }
          top.children.push(node)
          stack.push(node)
        } else if (token.type.endsWith('_close')) {
          const node = stack.pop()
          // 链接的虚拟节点不在这里收：交给 link_close。
          if (node === undefined || node.link === true) stack.push(node)
        }
    }
  }
  // 未闭合的行内标签（容错解析下少见）：把内容留在当前层，不丢文本。
  while (stack.length > 1) {
    const node = stack.pop()
    if (node.link === true) stack[stack.length - 1].children.push(...node.children)
  }
}

/**
 * 解析 Markdown 为节点计划（纯数据，不碰 DOM）。
 *
 * 每个节点是 `{ tag, text?, className?, align?, attrs?, children? }`；`text` 表示纯文本
 * 内容。这样安全映射可以脱离浏览器单测。
 */
export function markdownPlan(text) {
  const root = { tag: 'div', children: [] }
  const stack = [root]
  for (const token of markdown.parse(text ?? '', {})) {
    const top = stack[stack.length - 1]
    if (token.type === 'inline') {
      planInline(top, token.children)
      continue
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      top.children.push({
        tag: 'pre',
        className: 'md-code',
        children: [{ tag: 'code', className: languageClass(token.info), text: token.content }],
      })
      continue
    }
    if (token.type === 'hr') {
      top.children.push({ tag: 'hr' })
      continue
    }
    if (token.type === 'html_block') {
      pushText(top, token.content)
      continue
    }
    if (token.type.endsWith('_open')) {
      const tag = BLOCK_TAGS.has(token.tag) ? token.tag : 'div'
      const node = { tag, children: [] }
      if (tag === 'th' || tag === 'td') {
        const align = alignOf(token)
        if (align !== '') node.align = align
      }
      if (tag === 'ol') {
        // 起始编号：markdown-it 只在非 1 时给出 start；接受包括 0 在内的合法整数
        // （`0. / 1.` 必须从 0 开始），只省略默认值 1，其余属性一概不收。
        const start = Number(token.attrGet?.('start') ?? NaN)
        if (Number.isSafeInteger(start) && start !== 1 && Math.abs(start) <= 999999) node.attrs = { start: String(start) }
      }
      if (tag === 'table') {
        // 大表格横向滚动：滚动区域可聚焦（键盘能滚进去看）。包装层进父节点，
        // 后续 thead/tbody 继续压入 table 本身，不落到包装层外。
        top.children.push({ tag: 'div', className: 'table-scroll', attrs: { tabindex: '0', role: 'region', 'aria-label': '表格' }, children: [node] })
      } else {
        top.children.push(node)
      }
      stack.push(node)
    } else if (token.type.endsWith('_close')) {
      if (stack.length > 1) stack.pop()
    }
  }
  return root.children
}

function buildNode(spec) {
  // 没有 tag 的才是文本节点；带 tag 且有 text 的（如行内代码）是装着文本的元素。
  if (spec.tag === undefined) return document.createTextNode(spec.text ?? '')
  const node = document.createElement(spec.tag)
  if (spec.text !== undefined) node.textContent = spec.text
  if (spec.className !== undefined && spec.className !== '') node.className = spec.className
  if (spec.align !== undefined) node.style.textAlign = spec.align
  for (const [name, value] of Object.entries(spec.attrs ?? {})) node.setAttribute(name, value)
  for (const child of spec.children ?? []) node.appendChild(buildNode(child))
  // 预览类节点（图片缩略图 / 文件卡）把点击接管成**页内弹窗**：href 只作为 JS 失效时的
  // 回退（新窗口）。流式渲染会反复重建节点，监听器跟着节点走，不会累积。
  if (spec.className === 'md-pic' || spec.className === 'md-file') {
    node.addEventListener('click', event => {
      event.preventDefault()
      openPreviewModal(node.getAttribute('data-preview') ?? node.getAttribute('href') ?? '')
    })
  }
  return node
}

/** 把 Markdown 渲染进目标容器：先清空，再按节点计划建受控 DOM。 */
export function renderMarkdownInto(target, text) {
  while (target.firstChild !== null) target.removeChild(target.firstChild)
  for (const spec of markdownPlan(text)) target.appendChild(buildNode(spec))
  return target
}

/* ── kkFileView 页内预览弹窗 ─────────────────────────────────────────────
 *
 * 全页只有一个弹窗（按 id 复用）：图片与文件共用，iframe 嵌 kkFileView 的 onlinePreview。
 * 关闭有三条路：右上角按钮、点遮罩、Esc。iframe 的 src 在关闭时清空——停掉还在加载的
 * 预览，也不让关掉的文档继续占着内存。
 */
function openPreviewModal(url) {
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
