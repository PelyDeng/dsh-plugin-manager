/** Pure catalog operations shared by the browser and focused tests. */
export const TOOL_PAGE_SIZE = 15

/** Older third-party plugins may only supply a tool code. */
export const toolDisplayName = tool => tool.displayName?.trim() || tool.name

/** Match the display name, code, description, or serialized parameters. */
export function filterTools(tools, query) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return tools
  return tools.filter(tool => `${toolDisplayName(tool)}\n${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters, null, 2)}`.toLocaleLowerCase().includes(needle))
}

/** Clamp pagination after a changed search, including an empty result. */
export function pageTools(tools, query, requestedPage = 1) {
  const matches = filterTools(tools, query)
  const pages = Math.ceil(matches.length / TOOL_PAGE_SIZE)
  const page = Math.max(1, Math.min(requestedPage, pages || 1))
  return { items: matches.slice((page - 1) * TOOL_PAGE_SIZE, page * TOOL_PAGE_SIZE), total: matches.length, pages, page }
}

/**
 * 按分类标签给工具分组。
 *
 * 标签由各插件自己填写（`ToolDescriptor.category`），可能缺省 —— 老插件不填也要照常
 * 工作，所以未分类的工具统一归入「未分类」并排在最后。两组内部都保持原有顺序，
 * 这样搜索结果的相对顺序不会因为分组而变化。
 */
export function groupToolsByCategory(tools, uncategorized = '未分类') {
  const groups = new Map()
  for (const tool of tools) {
    const label = tool?.category?.trim() || uncategorized
    const list = groups.get(label)
    if (list) list.push(tool)
    else groups.set(label, [tool])
  }
  const named = [...groups].filter(([label]) => label !== uncategorized)
  const rest = groups.get(uncategorized)
  return [...named.map(([label, items]) => ({ label, tools: items })), ...(rest ? [{ label: uncategorized, tools: rest }] : [])]
}

/** 工具所属分类的显示标签；未分类时返回 undefined，调用方据此决定是否渲染标签。 */
export const toolCategory = tool => typeof tool?.category === 'string' && tool.category.trim() !== '' ? tool.category.trim() : undefined

/**
 * 插件分类标签的权威顺序与中文名。
 *
 * 与工具分类是两层：这里描述「插件在目录页属于哪一组」。名字由插件清单里的
 * `deepseekPlugin.category` 声明，管理器透传到目录；这个表只固定**展示顺序**，
 * 不限制取值范围 —— 第三方插件写别的名字也照常显示，只是排在已知分类之后。
 */
export const PLUGIN_CATEGORY_ORDER = ['system-default', 'universal-tools', 'agents', 'web-services']
export const PLUGIN_CATEGORY_LABELS = {
  'system-default': '系统默认',
  'universal-tools': '通用/工具',
  'agents': '智能体',
  'web-services': '网页服务',
}
const PLUGIN_CATEGORY_FALLBACK = '未分类'

/** 一个插件的分类显示名；未声明时归入「未分类」。 */
export function pluginCategoryLabel(plugin, uncategorized = PLUGIN_CATEGORY_FALLBACK) {
  const key = typeof plugin?.category === 'string' ? plugin.category.trim() : ''
  return PLUGIN_CATEGORY_LABELS[key] ?? (key === '' ? uncategorized : key)
}

/**
 * 按插件分类分组，并给出稳定的展示顺序。
 *
 * 已知分类按 {@link PLUGIN_CATEGORY_ORDER} 排列，未声明的排到「未分类」，
 * 其余自定义分类按**首次出现顺序**插在两者之间 —— 顺序稳定，不随搜索变化。
 * 空分类不返回，避免页面上出现一个没有内容的标题。
 */
export function groupPluginsByCategory(plugins, uncategorized = PLUGIN_CATEGORY_FALLBACK) {
  const groups = new Map()
  for (const plugin of plugins) {
    const key = typeof plugin?.category === 'string' ? plugin.category.trim() : ''
    const label = key === '' ? uncategorized : PLUGIN_CATEGORY_LABELS[key] ?? key
    const list = groups.get(label)
    if (list) list.push(plugin)
    else groups.set(label, [plugin])
  }
  const rank = label => {
    if (label === uncategorized) return PLUGIN_CATEGORY_ORDER.length + 1
    const index = PLUGIN_CATEGORY_ORDER.findIndex(key => PLUGIN_CATEGORY_LABELS[key] === label)
    return index === -1 ? PLUGIN_CATEGORY_ORDER.length : index
  }
  return [...groups]
    .map(([label, items], index) => ({ label, plugins: items, rank: rank(label), index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ label, plugins: items }) => ({ label, plugins: items }))
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
