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
 * 图片预览服务（kkFileView，站点私有部署）：聊天里的图片地址渲染成缩略图，点击新窗口
 * 打开在线预览。kkFileView 的约定是 `onlinePreview?url=<Base64(encodeURIComponent(原始地址))>`。
 */
const KKFILEVIEW_BASE = 'http://preview.pelycloud.com'

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

/** 裸文本里的 URL：只认 RFC 允许字符，中文标点天然截断（URL 后面跟"，。"不会吃进来）。 */
const IMAGE_URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gu
/** 自动识别为图片的后缀（裸 URL 靠它收窄；markdown 图片语法不必带这些后缀）。 */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/iu

/** kkFileView 的预览地址：先 encodeURIComponent（保证纯 ASCII）再 Base64，按它的约定。 */
function kkFileViewUrl(src) {
  return `${KKFILEVIEW_BASE}/onlinePreview?url=${encodeURIComponent(btoa(encodeURIComponent(src)))}`
}

/**
 * 受控图片节点：`a.md-pic` 包一张缩略图，点击新窗口进 kkFileView。
 *
 * 只由本函数创建（协议白名单 http/https，`javascript:` 之类进不来）；`referrerpolicy`
 * 与 `rel` 收紧引用面；`alt`/`title` 是纯文本属性，注入不了标签。
 */
function imageSpec(src, alt) {
  return {
    tag: 'a',
    className: 'md-pic',
    attrs: {
      href: kkFileViewUrl(src),
      target: '_blank',
      rel: 'noopener noreferrer',
      ...(alt === '' ? {} : { title: alt }),
    },
    children: [{ tag: 'img', attrs: { src, alt, loading: 'lazy', referrerpolicy: 'no-referrer' } }],
  }
}

function pushText(parent, text) {
  if (text !== '') parent.children.push({ text })
}

/** 带图片识别的文本写入：文本里的裸图片地址（https://…/x.png）替换成受控图片节点。 */
function pushTextWithImages(parent, text) {
  let cursor = 0
  for (const match of text.matchAll(IMAGE_URL_RE)) {
    const raw = match[0]
    // 句尾标点是文章的，不是地址的：修剪后判断后缀，修剪掉的部分还给文本。
    const url = raw.replace(/[.,;:!?]+$/u, '')
    if (!IMAGE_EXT_RE.test(url)) continue
    const start = match.index ?? 0
    if (start > cursor) pushText(parent, text.slice(cursor, start))
    parent.children.push(imageSpec(url, ''))
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
        // markdown 图片语法是明确的图片意图：http(s) 直接出受控缩略图；其余（相对路径、
        // data: 等）维持占位文本，把描述和地址都给全。alt 在 token.content 里。
        const src = token.attrGet?.('src') ?? ''
        const alt = token.content ?? token.attrGet?.('alt') ?? ''
        if (/^https?:\/\//iu.test(src) && !/\s/u.test(src)) top.children.push(imageSpec(src, alt))
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
  return node
}

/** 把 Markdown 渲染进目标容器：先清空，再按节点计划建受控 DOM。 */
export function renderMarkdownInto(target, text) {
  while (target.firstChild !== null) target.removeChild(target.firstChild)
  for (const spec of markdownPlan(text)) target.appendChild(buildNode(spec))
  return target
}
