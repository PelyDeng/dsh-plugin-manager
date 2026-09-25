/**
 * 管理弹窗的纯数据面（旧 web/management.js 导出函数的逐行等价迁移）：
 * managementSummary（确认弹窗的摘要文本）、readTaxonomy（全量分页读取）、
 * categoryPath（层级路径）、parentChoices（可选父分类）。
 *
 * 行为断言：web-react/src/__tests__/management.test.ts（旧 tests/management.test.ts
 * 仍在测旧 web/*.js，删码窗口才收敛——本文件是 React 载体的等价实现）。
 */

/** 管理域文案（旧 management.js labels 原表）。 */
export const MANAGEMENT_LABELS: Record<string, string> = {
  category: '分类',
  tag: '标签',
  comment: '评论',
  create: '新建',
  update: '修改',
  delete: '删除',
  name: '名称',
  slug: '链接别名',
  description: '描述',
  parent: '上级 ID（0 表示无）',
  isDefault: '设为默认分类',
  author: '作者',
  text: '内容',
  mail: '邮箱',
  url: '网站',
  status: '状态',
  cid: '文章 ID',
  approved: '已批准（公开）',
  waiting: '待审核',
  spam: '垃圾评论',
}

export interface TaxonomyItem {
  id: number
  name: string
  slug?: string | undefined
  description?: string | undefined
  parent?: number | undefined
  count?: number | undefined
  version?: number | undefined
}

export interface ManagementPreview {
  management?: {
    operation?: string | undefined
    kind?: string | undefined
    id?: number | undefined
    fields?: Record<string, unknown> | undefined
  } | undefined
  impact?: {
    relatedCount?: number | undefined
    childCategories?: number | undefined
    note?: string | undefined
    defaultCategory?: boolean | undefined
  } | undefined
}

/** 确认弹窗的摘要行（旧 managementSummary：标题行 + 字段行 + 影响行）。 */
export function managementSummary(preview: ManagementPreview): string {
  const m = preview.management ?? {}
  const rows = [`${MANAGEMENT_LABELS[m.operation ?? ''] ?? ''}${MANAGEMENT_LABELS[m.kind ?? ''] ?? ''}${m.id !== undefined ? ` · ID ${m.id}` : ''}`]
  for (const [key, value] of Object.entries(m.fields ?? {})) {
    rows.push(`${MANAGEMENT_LABELS[key] ?? key}：${key === 'status' ? MANAGEMENT_LABELS[String(value)] ?? String(value) : typeof value === 'boolean' ? (value ? '是' : '否') : String(value)}`)
  }
  if (preview.impact?.relatedCount !== undefined) rows.push(`${m.kind === 'comment' ? '关联回复' : '关联文章版本'}：${preview.impact.relatedCount}`)
  if (preview.impact?.childCategories !== undefined) rows.push(`子分类：${preview.impact.childCategories}`)
  if (preview.impact?.note !== undefined) rows.push(preview.impact.note)
  return rows.join('\n')
}

type IsCurrent = () => boolean

/**
 * 全量读取一个分类/标签表（旧 readTaxonomy）：分页读全后再推导层级与使用数——
 * 父分类可能在后面的页里。读取中途失焦（isCurrent=false）返回 null 调用方放弃。
 */
export async function readTaxonomy(
  api: (action: string, args: Record<string, unknown>) => Promise<{ items?: TaxonomyItem[]; hasMore?: boolean }>,
  kind: string,
  isCurrent: IsCurrent = () => true,
): Promise<TaxonomyItem[] | null> {
  const items: TaxonomyItem[] = []
  for (let page = 1; page <= 10000; page++) {
    const result = await api('manage-list', { kind, page, query: '' })
    if (!isCurrent()) return null
    items.push(...(result.items ?? []))
    if (result.hasMore !== true) return items
  }
  throw new Error('分类或标签数量超出读取范围，请缩小站点数据规模后重试。')
}

/** 从根到该分类的路径（旧 categoryPath：parent 链上溯，环保护）。 */
export function categoryPath(items: readonly TaxonomyItem[], id: number | undefined): TaxonomyItem[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const path: TaxonomyItem[] = []
  const seen = new Set<number>()
  for (let item = id !== undefined ? byId.get(id) : undefined; item !== undefined && !seen.has(item.id); item = item.parent !== undefined ? byId.get(item.parent) : undefined) {
    seen.add(item.id)
    path.unshift(item)
  }
  return path
}

/** 可选父分类：剔除自身及全部后代（旧 parentChoices）。 */
export function parentChoices(items: readonly TaxonomyItem[], id: number | undefined): TaxonomyItem[] {
  return items.filter(item => !categoryPath(items, item.id).some(parent => parent.id === id))
}
