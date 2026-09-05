/** Pure catalog operations shared by the browser and focused tests. */
export const TOOL_PAGE_SIZE = 15

/** Match the displayed tool name, description, or serialized parameters. */
export function filterTools(tools, query) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return tools
  return tools.filter(tool => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters, null, 2)}`.toLocaleLowerCase().includes(needle))
}

/** Clamp pagination after a changed search, including an empty result. */
export function pageTools(tools, query, requestedPage = 1) {
  const matches = filterTools(tools, query)
  const pages = Math.ceil(matches.length / TOOL_PAGE_SIZE)
  const page = Math.max(1, Math.min(requestedPage, pages || 1))
  return { items: matches.slice((page - 1) * TOOL_PAGE_SIZE, page * TOOL_PAGE_SIZE), total: matches.length, pages, page }
}

/** Return literal text runs; callers use text nodes and mark elements, never HTML. */
export function highlightParts(value, query) {
  const text = String(value)
  const needle = query.trim()
  if (!needle) return [{ text, match: false }]
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const parts = []
  let at = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index), match: false })
    parts.push({ text: match[0], match: true })
    at = match.index + match[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts
}

/** Entry links must remain on this origin, including after browser URL normalization. */
export function localEntry(path) {
  return typeof path === 'string' && /^\/(?!\/)/.test(path) && !/[\\\u0000-\u0020]/.test(path) ? path : undefined
}

/** User cards use six records per page and literal, case-insensitive identity search. */
export function pageUsers(users, query, requestedPage = 1) {
  const needle = query.trim().toLocaleLowerCase()
  const matches = users.filter(user => `${user.username} ${user.id} ${user.role === 'admin' ? '管理员 admin' : '普通用户 user'}`.toLocaleLowerCase().includes(needle))
  const pages = Math.ceil(matches.length / 6)
  const page = Math.max(1, Math.min(requestedPage, pages || 1))
  return { items: matches.slice((page - 1) * 6, page * 6), total: matches.length, pages, page }
}
