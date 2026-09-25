/**
 * 批 2c（生产反馈修复：左侧会话记录栏回归）纯函数面与数据面等价单测：
 * - historyGroup / conversationRowVisible（旧 conversation-history.js 的分组与
 *   可见口径）；
 * - conversationMarkdown / exportFileName（导出链路，closedoff 批 1b 同口径）；
 * - 收起状态键与读写（旧 chat.js storageKey='blog-history:'+userId 的沿用）；
 * - refreshConversations 的分页追加去重与失败清列表（旧侧栏 refresh 语义）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installBrowserGlobals, resetStores } from './helpers.ts'

installBrowserGlobals()
const { conversationMarkdown, conversationRowVisible, exportFileName, historyGroup, historyStorageKey, isMobileViewport, readHistoryExpanded, writeHistoryExpanded } =
  await import('../lib/history.ts')
const { refreshConversations } = await import('../chat-controller.ts')
const { useConversationStore } = await import('../stores/conversation.ts')
const { vi } = await import('vitest')

const NOW = new Date('2026-09-25T12:00:00+08:00').getTime()
const DAY = 86_400_000

/** 以固定 now 造列表行（updatedAt 相对 now 前推 n 天）。 */
function row(daysAgo: number, pinned = false): { id: string; title: string; updatedAt: number; pinned: boolean } {
  return { id: `row-${daysAgo}-${String(pinned)}`, title: `d${daysAgo}`, updatedAt: NOW - daysAgo * DAY, pinned }
}

afterEach(() => {
  vi.unstubAllGlobals()
  // window 注入清理（storage 用例装的是内存替身）。
  const globalWindow = (globalThis as Record<string, unknown>).window
  if (globalWindow !== undefined && (globalWindow as { __testProbe?: boolean }).__testProbe === true) {
    delete (globalThis as Record<string, unknown>).window
  }
})

describe('historyGroup：时间分组（旧 historyGroup 语义）', () => {
  it('置顶优先于时间（pinned 项无论多旧都归「置顶」组）', () => {
    expect(historyGroup({ id: 'a', title: '', updatedAt: NOW - 40 * DAY, pinned: true }, NOW)).toBe('置顶')
  })

  it('今天/昨天/7 天内/30 天内/更早的边界', () => {
    expect(historyGroup(row(0), NOW)).toBe('今天')
    expect(historyGroup(row(1), NOW)).toBe('昨天')
    expect(historyGroup(row(2), NOW)).toBe('7 天内')
    expect(historyGroup(row(6), NOW)).toBe('7 天内')
    expect(historyGroup(row(7), NOW)).toBe('30 天内')
    expect(historyGroup(row(29), NOW)).toBe('30 天内')
    expect(historyGroup(row(30), NOW)).toBe('更早')
    expect(historyGroup(row(400), NOW)).toBe('更早')
  })

  it('自然日分界：按本地零点截断（凌晨仍属今天）', () => {
    const earlyMorning = NOW - 3 * 60 * 60 * 1000
    expect(historyGroup({ id: 'a', title: '', updatedAt: earlyMorning }, NOW)).toBe('今天')
  })
})

describe('conversationRowVisible：死行过滤（旧同口径）', () => {
  it('ready/busy/缺省可见，pending/failed/legacy 过滤', () => {
    expect(conversationRowVisible({ id: 'a', title: '', updatedAt: 0, state: 'ready' })).toBe(true)
    expect(conversationRowVisible({ id: 'a', title: '', updatedAt: 0, state: 'busy' })).toBe(true)
    expect(conversationRowVisible({ id: 'a', title: '', updatedAt: 0 })).toBe(true)
    expect(conversationRowVisible({ id: 'a', title: '', updatedAt: 0, state: 'pending' })).toBe(false)
    expect(conversationRowVisible({ id: 'a', title: '', updatedAt: 0, state: 'failed' })).toBe(false)
    expect(conversationRowVisible({ id: 'a', title: '', updatedAt: 0, state: 'legacy' })).toBe(false)
  })
})

describe('conversationMarkdown / exportFileName：导出链路', () => {
  it('标题换行消毒 + 问答分段 + --- 分隔', () => {
    const markdown = conversationMarkdown('第一行\n第二行', [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '你好！' },
      { role: 'tool', text: '工具记录不导出' },
      { role: 'user', text: '   ' },
    ])
    expect(markdown).toBe('# 第一行 第二行\n\n## 我\n\n你好\n\n---\n\n## 助手\n\n你好！\n')
  })

  it('空标题回落「对话记录」，空消息列表只剩标题', () => {
    expect(conversationMarkdown('', []).startsWith('# 对话记录\n')).toBe(true)
  })

  it('文件名：单选取标题并消毒截 60，多选/空回落「对话记录」', () => {
    expect(exportFileName(['我的: 文章?'])).toBe('我的_ 文章_.md')
    expect(exportFileName(['a', 'b'])).toBe('对话记录.md')
    expect(exportFileName([''])).toBe('对话记录.md')
    expect(exportFileName(['x'.repeat(80)])).toBe(`${'x'.repeat(60)}.md`)
  })
})

describe('收起状态：键沿用 blog-history:<userId>，读写往返', () => {
  it('键格式（旧 chat.js storageKey 同款）', () => {
    expect(historyStorageKey('mock-user')).toBe('blog-history:mock-user')
  })

  it('读写往返；非法值按未设置处理', () => {
    const map = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).window = {
      __testProbe: true,
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value) },
      },
      matchMedia: () => ({ matches: false }),
    } as unknown as Window & typeof globalThis
    expect(readHistoryExpanded('tester')).toBeNull()
    writeHistoryExpanded('tester', 'collapsed')
    expect(readHistoryExpanded('tester')).toBe('collapsed')
    expect(map.get('blog-history:tester')).toBe('collapsed')
    writeHistoryExpanded('tester', 'expanded')
    expect(readHistoryExpanded('tester')).toBe('expanded')
    map.set('blog-history:tester', 'junk')
    expect(readHistoryExpanded('tester')).toBeNull()
  })

  it('存储不可用时静默（写不抛、读回落 null——旧 try/catch 同口径）', () => {
    ;(globalThis as Record<string, unknown>).window = {
      __testProbe: true,
      get localStorage(): Storage {
        throw new Error('privacy mode')
      },
      matchMedia: () => ({ matches: false }),
    } as unknown as Window & typeof globalThis
    expect(() => writeHistoryExpanded('tester', 'collapsed')).not.toThrow()
    expect(readHistoryExpanded('tester')).toBeNull()
  })

  it('移动端断点常量与旧码一致（max-width: 960px）', () => {
    // isMobileViewport 无 window 时按桌面处理（SSG/node 安全）。
    expect(isMobileViewport()).toBe(false)
  })
})

describe('refreshConversations：分页追加去重与失败清列表（旧侧栏 refresh 语义）', () => {
  it('追加去重 + nextOffset 落地；非追加整页替换', async () => {
    await resetStores()
    const list = vi.fn(async (args: Record<string, unknown>) => {
      if (Number(args.offset ?? 0) === 0) {
        return {
          items: [
            { id: 'a', title: 'A', updatedAt: 3 },
            { id: 'b', title: 'B', updatedAt: 2 },
          ],
          nextOffset: 2,
        }
      }
      return {
        items: [
          { id: 'b', title: 'B', updatedAt: 2 },
          { id: 'c', title: 'C', updatedAt: 1 },
        ],
        nextOffset: null,
      }
    })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { action: string; args: Record<string, unknown> }
      if (body.action !== 'chat-list') throw new Error(`stub 未实现 action：${body.action}`)
      return new Response(JSON.stringify(await list(body.args)), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    await refreshConversations()
    expect(useConversationStore.getState().conversations.map(item => item.id)).toEqual(['a', 'b'])
    expect(useConversationStore.getState().conversationsOffset).toBe(2)
    await refreshConversations(true)
    expect(useConversationStore.getState().conversations.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(useConversationStore.getState().conversationsOffset).toBeNull()
    await refreshConversations()
    expect(useConversationStore.getState().conversations.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('非追加失败清空列表并落错误；追加失败保留已加载内容', async () => {
    await resetStores()
    let failing = false
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { action: string }
      if (body.action !== 'chat-list') throw new Error(`stub 未实现 action：${body.action}`)
      if (failing) return new Response(JSON.stringify({ error: '列表暂不可用' }), { status: 500, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ items: [{ id: 'a', title: 'A', updatedAt: 1 }], nextOffset: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    await refreshConversations()
    expect(useConversationStore.getState().conversations).toHaveLength(1)
    failing = true
    await refreshConversations(true)
    // 追加失败：已加载行保留，错误落状态行。
    expect(useConversationStore.getState().conversations).toHaveLength(1)
    expect(useConversationStore.getState().conversationsError).toBe('列表暂不可用')
    await refreshConversations()
    // 非追加失败：列表清空（旧码 items=[]; render()）。
    expect(useConversationStore.getState().conversations).toHaveLength(0)
    expect(useConversationStore.getState().conversationsOffset).toBeNull()
    expect(useConversationStore.getState().conversationsError).toBe('列表暂不可用')
  })
})
