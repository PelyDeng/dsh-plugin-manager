import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  .replace(/^import .*$/m, '').replace(/perform\(\(\) => load\(\)\)\s*$/, '')

function fixture(fetch: typeof globalThis.fetch) {
  const elements = new Map<string, {
    hidden: boolean; open: boolean; value: string; textContent: string; children: string[]; resets: number
    replaceChildren(): void; reset(): void; close(): void; addEventListener(): void
  }>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, open: false, value: 'private form value', textContent: 'private account', children: ['private row'], resets: 0,
      replaceChildren() { this.children = [] }, reset() { this.resets++; this.value = '' }, close() { this.open = false }, addEventListener() {},
    })
    return elements.get(id)!
  }
  const api = runInNewContext(`${source}\n;({ loggedOut, load, api })`, {
    document: { querySelector: element, querySelectorAll: () => [] },
    window: { addEventListener() {} }, location: { href: 'http://localhost/auth' }, URL, DOMException, fetch,
  }) as { loggedOut(): void; load(): Promise<void>; api(path: string): Promise<unknown> }
  return { ...api, element }
}

describe('account identity cleanup', () => {
  it('clears private forms, account labels, and plugin/user directories on logout or a storage identity change', () => {
    const f = fixture(globalThis.fetch)
    for (const id of ['#password-form', '#create-form', '#account-name', '#users', '#plugins']) f.element(id)
    f.loggedOut()
    expect(f.element('#password-form').value).toBe('')
    expect(f.element('#create-form').value).toBe('')
    expect(f.element('#account-name').textContent).toBe('')
    expect(f.element('#users').children).toEqual([])
    expect(f.element('#plugins').children).toEqual([])
    // Both provider cards and late save responses are exercised in model-cards.test.mjs.
    expect(f.element('#workspace').hidden).toBe(true)
  })

  it('hides and clears cached private UI before awaiting a restored-page identity request', async () => {
    let release!: (response: Response) => void
    const f = fixture(() => new Promise(resolve => { release = resolve }))
    f.element('#password-form'); f.element('#plugins')
    const pending = f.load()
    expect(f.element('#workspace').hidden).toBe(true)
    expect(f.element('#loading').hidden).toBe(false)
    expect(f.element('#password-form').value).toBe('')
    expect(f.element('#plugins').children).toEqual([])
    release(new Response(JSON.stringify({ user: null, initialized: true }), { status: 200 }))
    await pending
    expect(f.element('#loading').hidden).toBe(true)
  })

  it('rejects a delayed response body after the account identity changes', async () => {
    let release!: (value: unknown) => void
    let reading!: () => void
    const started = new Promise<void>(resolve => { reading = resolve })
    const response = { ok: true, json: () => new Promise(resolve => { release = resolve; reading() }) }
    // Only the two fetch Response members used by this browser path are needed.
    const f = fixture(async () => response as Response)
    const pending = f.api('plugins')
    await started
    f.loggedOut()
    release({ plugins: [{ displayName: 'previous private plugin' }] })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
