const names = new Set([
  'copy', 'like', 'dislike', 'more', 'branch', 'refresh', 'comment', 'paperclip',
  'send', 'stop', 'menu', 'close', 'new-chat', 'chat', 'article', 'settings',
  'search', 'chevron-down', 'external', 'image', 'bold', 'italic', 'heading',
  'code', 'list', 'link', 'save', 'backup',
])
const namespace = 'http://www.w3.org/2000/svg'

/** Decorative official glyph; the enclosing control supplies its accessible name. */
export function icon(name) {
  if (!names.has(name)) throw new TypeError(`Unknown icon: ${name}`)
  const base = document.body.dataset.base
  if (!base || !/^\/(?!\/)/.test(base) || /[\\\s?#]/.test(base)) {
    throw new TypeError('Icon base must be an absolute same-origin path')
  }
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('width', '20')
  svg.setAttribute('height', '20')
  const use = document.createElementNS(namespace, 'use')
  use.setAttribute('href', `${base}/icons.svg#${name}`)
  svg.append(use)
  return svg
}
