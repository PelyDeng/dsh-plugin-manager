/**
 * 深链 URL 写回的等价单测（删码评审 B F3：旧 tests/chat-ui.test.ts 的
 * 「deep links follow switching… without changing other URL or history state」
 * 用例随 vanilla 前端删除，React 侧实现收敛在 conversation store 的
 * setConversationId 单点（sessionStorage 与 URL 同步），这里补回护栏）。
 *
 * 语义（旧 syncConversationUrl 口径）：写回只动 conversationId 一个参数，
 * replaceState 不产生历史记录、不碰 history.state；'' = 开新对话/删除当前会话，
 * 从 URL 上摘除该参数；node/无 window 环境整体跳过不抛错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource, installBrowserGlobals, resetStores } from './helpers.ts'

installBrowserGlobals()

const { useConversationStore, storedConversationId } = await import('../stores/conversation.ts')

/** 假浏览器地址栏：记录 replaceState，按 URL 串推进 href。 */
function installFakeBrowser(initialHref: string): { href: string; historyState: unknown; replaceCalls: Array<{ state: unknown; url: string }> } {
  const browser = {
    href: initialHref,
    historyState: { scroll: 17, external: { keep: true } },
    replaceCalls: [] as Array<{ state: unknown; url: string }>,
  }
  vi.stubGlobal('window', {
    location: {
      get href() { return browser.href },
    },
    history: {
      state: browser.historyState,
      replaceState(state: unknown, _title: string, url: string | URL) {
        browser.replaceCalls.push({ state, url: String(url) })
        browser.href = String(url)
      },
    },
  })
  return browser
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  FakeEventSource.reset()
  installBrowserGlobals()
  await resetStores()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('深链 URL 写回（setConversationId 的 URL 同步）', () => {
  it('打开会话写回 conversationId，保留其它参数、hash 与 history state', () => {
    const browser = installFakeBrowser('https://example.invalid/blog?from=entry&keep=1#answer')
    useConversationStore.getState().setConversationId('chat-b')
    const url = new URL(browser.href)
    expect(url.pathname).toBe('/blog')
    expect(url.searchParams.get('conversationId')).toBe('chat-b')
    // 其它参数与 hash 不动（旧码同口径：只动一个参数）。
    expect(url.searchParams.get('from')).toBe('entry')
    expect(url.searchParams.get('keep')).toBe('1')
    expect(url.hash).toBe('#answer')
    // replaceState 不产生历史记录：传入的 state 是原 state 引用。
    expect(browser.replaceCalls).toHaveLength(1)
    expect(browser.replaceCalls[0]?.state).toBe(browser.historyState)
  })

  it('开新对话（空 id）从 URL 摘除参数，其它参数保留，本地存储同步清除', () => {
    const browser = installFakeBrowser('https://example.invalid/blog?from=entry&conversationId=chat-a&keep=1#answer')
    useConversationStore.getState().setConversationId('')
    const url = new URL(browser.href)
    expect(url.searchParams.has('conversationId')).toBe(false)
    expect(url.searchParams.get('from')).toBe('entry')
    expect(url.searchParams.get('keep')).toBe('1')
    expect(url.hash).toBe('#answer')
    expect(storedConversationId('tester')).toBeNull()
  })

  it('会话 id 随身份写入 sessionStorage（blog-chat:<userId>），无身份不写', async () => {
    installFakeBrowser('https://example.invalid/blog')
    const { useSessionStore } = await import('../stores/session.ts')
    useConversationStore.getState().setConversationId('chat-c')
    expect(storedConversationId('tester')).toBe('chat-c')
    // 身份未就绪（userId 空）时不动本地存储。
    useSessionStore.getState().adoptIdentity({ userId: '' })
    useConversationStore.getState().setConversationId('chat-d')
    expect(storedConversationId('tester')).toBe('chat-c')
  })

  it('node/无 window 环境跳过 URL 同步，不抛错', async () => {
    // 未安装假浏览器：globalThis 无 window，store 的其它写入照常。
    const { useSessionStore } = await import('../stores/session.ts')
    expect(globalThis.window).toBeUndefined()
    useSessionStore.getState().adoptIdentity({ userId: 'tester' })
    expect(() => useConversationStore.getState().setConversationId('chat-x')).not.toThrow()
    expect(useConversationStore.getState().conversationId).toBe('chat-x')
  })
})
