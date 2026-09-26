/**
 * 批 2b 纯数据面的等价单测：
 * - articleDiff（旧 web/article-diff.js 的行为语义：首尾收敛/超大段整组/逐行 LCS）；
 * - management 纯函数（旧 management.js 导出：managementSummary/categoryPath/
 *   parentChoices/readTaxonomy 的分页读取与中断）；
 * - thinking-translation 的 needsChineseTranslation（与旧 web/thinking-translation.js
 *   及服务端同一保守判定）。
 * 旧 tests/article-diff.test.ts / tests/management.test.ts 已随批 C1 删码退役，
 * 等价语义由本文件的 React 载体用例承接（方案 §4.3「删码安全前提」）。
 */
import { describe, expect, it } from 'vitest'
import { articleDiff } from '../lib/article-diff.ts'
import { categoryPath, managementSummary, parentChoices, readTaxonomy, type TaxonomyItem } from '../lib/management.ts'
import { installBrowserGlobals } from './helpers.ts'

// thinking-translation 依赖 config（模块加载期读 data-base 注入）：
// 先装测试全局再动态加载（helpers 的时序约束）。
installBrowserGlobals()
const { needsChineseTranslation } = await import('../lib/thinking-translation.ts')

describe('articleDiff：行级对比（旧 article-diff.js 语义）', () => {
  it('首尾相同行收敛，中段逐行标增删', () => {
    const rows = articleDiff('a\nb\nc', 'a\nX\nc')
    expect(rows).toEqual([
      { kind: 'same', lines: ['a'] },
      { kind: 'removed', lines: ['b'] },
      { kind: 'added', lines: ['X'] },
      { kind: 'same', lines: ['c'] },
    ])
  })

  it('全文重写（超大段）整删整增分组，不做逐行对齐', () => {
    const before = Array.from({ length: 1200 }, (_, i) => `旧 ${i}`).join('\n')
    const after = Array.from({ length: 1200 }, (_, i) => `新 ${i}`).join('\n')
    const rows = articleDiff(before, after)
    // n*m > 1_000_000：只出两个组（removed + added）。
    expect(rows).toHaveLength(2)
    expect(rows[0]?.kind).toBe('removed')
    expect(rows[1]?.kind).toBe('added')
  })

  it('相同文本全 same；空串与纯新增（空串是一个空行，与旧码一致）', () => {
    expect(articleDiff('同\n文', '同\n文')).toEqual([{ kind: 'same', lines: ['同', '文'] }])
    expect(articleDiff('', '新行')).toEqual([
      { kind: 'removed', lines: [''] },
      { kind: 'added', lines: ['新行'] },
    ])
    expect(articleDiff('旧行', '')).toEqual([
      { kind: 'removed', lines: ['旧行'] },
      { kind: 'added', lines: [''] },
    ])
  })
})

const TAXONOMY: TaxonomyItem[] = [
  { id: 1, name: '技术', slug: 'tech', count: 12 },
  { id: 2, name: '前端', parent: 1, count: 5 },
  { id: 3, name: '生活', count: 3 },
  { id: 4, name: '后端', parent: 1, count: 7 },
]

describe('management 纯函数（旧 management.js 导出语义）', () => {
  it('categoryPath：parent 链上溯到根；环不发散', () => {
    const path = categoryPath(TAXONOMY, 2)
    expect(path.map(item => item.name)).toEqual(['技术', '前端'])
    // 顶级分类路径只有自己。
    expect(categoryPath(TAXONOMY, 3).map(item => item.id)).toEqual([3])
    expect(categoryPath(TAXONOMY, undefined)).toEqual([])
  })

  it('parentChoices：剔除自身与全部后代（防自嵌套）', () => {
    const choices = parentChoices(TAXONOMY, 1).map(item => item.id)
    expect(choices).toEqual([3])
  })

  it('managementSummary：操作标题行 + 字段行 + 影响行（旧 managementSummary 同文案）', () => {
    const text = managementSummary({
      management: { operation: 'create', kind: 'category', fields: { name: '随笔', parent: 0, isDefault: false } },
      impact: { relatedCount: 4, childCategories: 0 },
    })
    expect(text.split('\n')).toEqual([
      '新建分类',
      '名称：随笔',
      '上级 ID（0 表示无）：0',
      '设为默认分类：否',
      '关联文章版本：4',
      '子分类：0',
    ])
  })

  it('managementSummary：评论删除给出「关联回复」与状态翻译', () => {
    const text = managementSummary({
      management: { operation: 'delete', kind: 'comment', id: 9, fields: { status: 'waiting' } },
      impact: { relatedCount: 2 },
    })
    expect(text).toContain('删除评论 · ID 9')
    expect(text).toContain('状态：待审核')
    expect(text).toContain('关联回复：2')
  })

  it('readTaxonomy：分页读全后合并；读取中途失焦返回 null；超页数抛错', async () => {
    // 两页读全。
    const pages = [
      { items: [{ id: 1, name: '技术' }], hasMore: true },
      { items: [{ id: 3, name: '生活' }], hasMore: false },
    ]
    let call = 0
    const merged = await readTaxonomy(async (_action, args) => {
      const page = args.page as number
      expect(page).toBe(call + 1)
      return pages[Math.min(call++, pages.length - 1)]!
    }, 'category')
    expect(merged).toEqual([{ id: 1, name: '技术' }, { id: 3, name: '生活' }])
    // isCurrent=false（会话已切）→ null。
    const abandoned = await readTaxonomy(async () => ({ items: [], hasMore: true }), 'category', () => false)
    expect(abandoned).toBeNull()
    // 永远 hasMore → 超范围报错。
    await expect(readTaxonomy(async () => ({ items: [], hasMore: true }), 'category')).rejects.toThrow('分类或标签数量超出读取范围')
  })
})

describe('needsChineseTranslation（旧 thinking-translation.js 同一保守判定）', () => {
  it('英文散文命中：拉丁字母充足且超汉字两倍', () => {
    expect(needsChineseTranslation('The reasoning trace explains why the model chose the fallback path')).toBe(true)
  })
  it('中文为主不命中；代码块与链接剔除后再判；短文本不命中', () => {
    expect(needsChineseTranslation('这是中文思考，包含很少的 English words 混排')).toBe(false)
    expect(needsChineseTranslation('```js\nconst someVeryLongEnglishVariableName = 1\n```\n结论是中文的')).toBe(false)
    expect(needsChineseTranslation('see https://example.com/very/long/path/for/details here')).toBe(false)
    expect(needsChineseTranslation('short text')).toBe(false)
  })
})
