/** Execute actual browser functions with delayed responses to model account-switch races. */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
function between(start: string, end: string): string {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first + start.length)
  if (first < 0 || last < 0) throw new Error('Browser function fixture no longer matches source')
  return source.slice(first, last)
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve))

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
  runInContext(between('  function businessFetch(', '  function loadHistory('), scope)
  return { scope, response, rows, release: (data: unknown) => release(data) }
}

describe('account switch discards late private responses', () => {
  it('does not render history whose JSON arrives after private state was cleared', async () => {
    const fixture = jsonFixture()
    runInContext(between('  function loadHistory(', "  $('#historyBtn').addEventListener"), fixture.scope)
    runInContext('loadHistory(false)', fixture.scope)
    await vi.waitFor(() => expect(fixture.response.json).toHaveBeenCalledOnce())
    fixture.scope.identityEpoch += 1
    fixture.rows.length = 0
    fixture.release({ items: [{ id: 'old-private', title: 'old private title', updatedAt: Date.now() }], nextOffset: null })
    await settled()
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
