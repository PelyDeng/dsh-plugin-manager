/** Execute actual browser functions with delayed responses to model account-switch races. */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function between(start: string, end: string): string {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first + start.length)
  if (first < 0 || last < 0) throw new Error('Browser function fixture no longer matches source')
  return source.slice(first, last)
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

describe('已验证身份下的会话深链接', () => {
  const linked = 'closedoff-web-01234567-89ab-4cde-8fab-0123456789ab'
  const choose = between('    var linkedConversation =', '    identityReady = true;')
  it('选择有效业务会话参数，由原 history 接口继续校验归属，不写入本机归属', () => {
    const scope = createContext({ URLSearchParams, window: { location: { search: '?conversationId=' + linked } },
      localStorage: { getItem: () => 'saved-session' }, storageKey: 'dsh_closedoff_conversationId:user:alice', conversationId: '' })
    runInContext(choose, scope)
    expect(scope.conversationId).toBe(linked)
  })
  it('拒绝其他命名空间和非 UUID 参数，沿用当前身份历史', () => {
    for (const value of ['foreign-session', 'closedoff-web-anything', '//other.invalid']) {
      const scope = createContext({ URLSearchParams, window: { location: { search: '?conversationId=' + encodeURIComponent(value) } },
        localStorage: { getItem: () => 'saved-session' }, storageKey: 'dsh_closedoff_conversationId:user:alice', conversationId: '' })
      runInContext(choose, scope)
      expect(scope.conversationId).toBe('saved-session')
    }
  })
  it('切换、新建、收到新 ID 与删除当前会话同步深链，保留其它 URL 和 history state', () => {
    const other = 'closedoff-web-11234567-89ab-4cde-8fab-0123456789ab'
    const created = 'closedoff-web-21234567-89ab-4cde-8fab-0123456789ab'
    let href = 'https://example.invalid/closedoff-qa?from=pirate&conversationId=' + linked + '&keep=1#answer'
    const saved = new Map<string, string>(), historyState = { scroll: 17, external: { keep: true } }
    const browser = { location: { get href() { return href }, get search() { return new URL(href).search } },
      history: { state: historyState, replaceState(state: unknown, _title: string, url: URL) { expect(state).toBe(historyState); href = String(url) } } }
    let options!: { openConversation(id: string): void; newConversation(): void; onDeleted(ids: string[]): void }
    const scope = createContext({ URL, URLSearchParams, window: browser, conversationId: linked,
      localStorage: { setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key), removeItem: (key: string) => saved.delete(key) },
      storageKey: 'dsh_closedoff_conversationId:user:alice', identityKey: 'user:alice', identityReady: true,
      identityEpoch: 0, epoch: 0, controller: new AbortController(), running: false, titleRefresh: undefined,
      activeRestoreController: null, followBottom: true, inner: { innerHTML: '' }, admitted: false, freshConversation: false,
      picker: { refresh() {}, accept() {} }, resetViewState() {}, restore() {}, welcome() {}, $: () => ({}),
      createConversationHistory(value: typeof options) { options = value; return { refresh() {}, render() {} } },
    })
    runInContext(between('  function stopTitleRefresh(', '  function startTitleRefresh('), scope)
    runInContext(between('  function openConversation(', '  function bindAnswerActions('), scope)
    runInContext(between('  function startFreshConversation(', "  $('#newBtn')"), scope)
    runInContext(between('  function initHistory(', "  $('#logoutBtn')"), scope)
    runInContext(between('    function handleEvent(', '\n  }\n\n  function autoGrow('), scope)
    runInContext('initHistory()', scope)
    const expectTarget = (id: string) => {
      const url = new URL(href)
      expect(scope.conversationId).toBe(id)
      expect(url.searchParams.get('conversationId') || '').toBe(id)
      expect(url.pathname).toBe('/closedoff-qa'); expect(url.searchParams.get('from')).toBe('pirate')
      expect(url.searchParams.get('keep')).toBe('1'); expect(url.hash).toBe('#answer')
      expect(browser.history.state).toBe(historyState)
      runInContext(choose, scope); expect(scope.conversationId).toBe(id)
    }
    options.openConversation(other); expectTarget(other)
    options.newConversation(); expectTarget('')
    expect(new URL(href).searchParams.has('conversationId')).toBe(false)
    scope.created = created; runInContext("handleEvent({type:'conversation',conversationId:created}, {})", scope); expectTarget(created)
    options.onDeleted([other]); expectTarget(created)
    options.onDeleted([created]); expectTarget('')
    expect(new URL(href).searchParams.has('conversationId')).toBe(false)
  })
})

function jsonFixture() {
  let release!: (data: unknown) => void
  const response = { ok: true, status: 200, json: vi.fn(() => new Promise(resolve => { release = resolve })) }
  const rows: unknown[] = []
  const ui = {
    '#historyList': { children: rows, replaceChildren: () => { rows.length = 0 }, appendChild: (row: unknown) => { rows.push(row) } },
    '#historyStatus': { textContent: '' }, '#historyMore': { disabled: false, hidden: false },
  }
  const scope = createContext({
    identityEpoch: 0, historyOffset: 0, responseEpochs: new WeakMap(),
    checkIdentity: () => Promise.resolve(), fetch: () => Promise.resolve(response), rejectAccess: (value: unknown) => value,
    routePath: (path: string) => '/closedoff-qa' + path,
    $: (selector: keyof typeof ui) => ui[selector],
    document: { createElement: () => ({ append() {}, addEventListener() {} }) },
  })
  runInContext(between('  function readJson(', '  function rejectAccess('), scope)
  runInContext(between('  function businessFetch(', '  function initHistory('), scope)
  return { scope, response, rows, release: (data: unknown) => release(data) }
}

describe('account switch discards late private responses', () => {
  it('rejects sidebar history whose JSON arrives after private state was cleared', async () => {
    const fixture = jsonFixture()
    const result = runInContext("businessFetch('/closedoff-qa/conversations').then(readJson)", fixture.scope) as Promise<unknown>
    const rejected = expect(result).rejects.toThrow('登录状态已变化')
    await vi.waitFor(() => expect(fixture.response.json).toHaveBeenCalledOnce())
    fixture.scope.identityEpoch += 1
    fixture.rows.length = 0
    fixture.release({ items: [{ id: 'old-private', title: 'old private title', updatedAt: Date.now() }], nextOffset: null })
    await rejected
    expect(fixture.rows).toEqual([])
  })

  it('rejects a delayed POST result after the account epoch changes', async () => {
    const fixture = jsonFixture()
    runInContext(between('  function postJson(', '  function setFeedbackState('), fixture.scope)
    const result = runInContext("postJson('/closedoff-qa/branch', {})", fixture.scope) as Promise<unknown>
    const rejected = expect(result).rejects.toThrow('登录状态已变化')
    await vi.waitFor(() => expect(fixture.response.json).toHaveBeenCalledOnce())
    fixture.scope.identityEpoch += 1
    fixture.release({ conversationId: 'private-child' })
    await rejected
  })

  it('does not open a branch when the account changes after POST completion', async () => {
    const listeners = new Map<string, () => void>()
    const element = () => ({ addEventListener: vi.fn() })
    const branch = { addEventListener: (_name: string, callback: () => void) => listeners.set('branch', callback), disabled: false }
    let release!: (result: unknown) => void
    const openConversation = vi.fn()
    const scope = createContext({ identityEpoch: 0, running: false, conversationId: 'parent', routePath: (path: string) => path,
      openConversation, postJson: () => new Promise(resolve => { release = resolve }),
    })
    runInContext(between('  function bindAnswerActions(', '  function applyTurnMeta('), scope)
    scope.ast = {
      turnMeta: { branchSeq: 2 }, copyAction: element(), likeAction: element(), dislikeAction: element(), branchAction: branch,
      usageAction: { button: element(), popover: element() }, timeAction: { button: element(), popover: element() },
    }
    runInContext('bindAnswerActions(ast)', scope)
    listeners.get('branch')!()
    scope.identityEpoch += 1
    release({ conversationId: 'old-private-child' })
    await settled()
    expect(openConversation).not.toHaveBeenCalled()
  })

  it('cancels a buffered SSE frame instead of dispatching it after an account switch', async () => {
    let release!: (value: unknown) => void
    const reader = { read: vi.fn(() => new Promise(resolve => { release = resolve })), cancel: vi.fn(async () => undefined) }
    const handleEvent = vi.fn()
    const scope = createContext({
      identityEpoch: 0, epoch: 0, controller: new AbortController(), TextDecoder,
      handleEvent, finishRunning: vi.fn(), response: { body: { getReader: () => reader } },
    })
    runInContext(between('    async function stream(', '    function handleEvent('), scope)
    const pending = runInContext('stream(response,{})', scope) as Promise<void>
    scope.identityEpoch += 1
    release({ done: false, value: new TextEncoder().encode('data: {"type":"conversation","conversationId":"private"}\n\n') })
    await pending
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(handleEvent).not.toHaveBeenCalled()
  })
})
