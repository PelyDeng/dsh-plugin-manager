/** Execute the actual UI with a small DOM/fetch harness; no service or real credentials. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*$/m, '').replace(/perform\(\(\) => load\(\)\)\s*$/, '')
class Element {
  dataset = {}; value = ''; textContent = ''; hidden = false; open = false
  children = new Map(); handlers = new Map(); attributes = new Map()
  classList = { add() {}, remove() {}, toggle() {} }
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element())
    return this.children.get(selector)
  }
  addEventListener(event, handler) { this.handlers.set(event, handler) }
  setAttribute(name, value) { this.attributes.set(name, value) }
  replaceChildren() {}
  reset() { this.value = '' }
  fire(event) { return this.handlers.get(event)({ preventDefault() {}, currentTarget: this }) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const configured = fingerprint => ({ supported: true, writable: true, configured: true, source: 'file', fingerprint: `SHA-256:${fingerprint}` })
function fixture() {
  const document = new Element(), requests = []
  const query = document.querySelector.bind(document)
  document.querySelector = selector => selector === '#conversation-models' ? null : query(selector)
  const cards = ['deepseek', 'zhipu'].map(kind => { const card = new Element(); card.dataset.model = kind; return card })
  document.querySelectorAll = selector => selector === '[data-model]' ? cards : []
  const context = { document, window: { addEventListener() {} }, DOMException, fetch: (url, options) => new Promise(resolve => {
    requests.push({ url, options, reply: (body, status = 200) => resolve({ ok: status === 200, status, json: async () => body }) })
  }) }
  runInNewContext(`${source}\n globalThis.ui = { showPage, loggedOut, login() { session = { user: { role: 'admin' }, csrf: 'fixture-csrf' } } }`, context)
  context.ui.login()
  return { ...context.ui, cards, requests, field: (index, name) => cards[index].querySelector(`[data-field="${name}"]`) }
}
async function ready(f) {
  const loading = f.showPage('models')
  f.requests[0].reply(configured('deepseek-old'))
  f.requests[1].reply(configured('zhipu-old'))
  await loading
}

test('provider reads and failures are independent, and refresh does not display stale details', async () => {
  const f = fixture()
  const loading = f.showPage('models')
  assert.deepEqual(f.requests.map(r => r.url), ['/auth/api/model-key/deepseek', '/auth/api/model-key/zhipu'])
  f.requests[0].reply(configured('deepseek-old'))
  f.requests[1].reply({ error: 'zhipu unavailable' }, 503)
  await loading
  assert.equal(f.field(0, 'key').disabled, false)
  assert.equal(f.field(1, 'key').disabled, true)
  assert.equal(f.field(1, 'message').textContent, 'zhipu unavailable')
  const refresh = f.cards[0].querySelector('[data-action="refresh"]').fire('click')
  assert.equal(f.field(0, 'fingerprint').textContent, '')
  assert.equal(f.field(0, 'fingerprint-row').hidden, true)
  f.requests[2].reply({ error: 'refresh failed' }, 503)
  await refresh
  assert.equal(f.field(0, 'status').textContent, '状态读取失败')
  assert.equal(f.field(1, 'message').textContent, 'zhipu unavailable')
})

test('saves bind the correct provider and csrf while the other card remains usable', async () => {
  const f = fixture(); await ready(f)
  f.field(0, 'key').value = 'fixture-deepseek'
  f.cards[0].querySelector('form').fire('submit')
  assert.equal(f.field(0, 'key').value, '')
  assert.equal(f.field(0, 'save').disabled, true)
  assert.equal(f.field(1, 'save').disabled, false)
  f.cards[0].querySelector('form').fire('submit')
  assert.equal(f.requests.length, 3)
  f.field(1, 'key').value = 'fixture-zhipu'
  f.cards[1].querySelector('form').fire('submit')
  assert.equal(f.requests[2].url, '/auth/api/model-key/deepseek')
  assert.equal(f.requests[3].url, '/auth/api/model-key/zhipu')
  assert.equal(f.requests[2].options.headers['x-dsh-csrf'], 'fixture-csrf')
  assert.deepEqual(JSON.parse(f.requests[3].options.body), { apiKey: 'fixture-zhipu' })
  f.requests[3].reply(configured('zhipu-new')); await tick()
  assert.equal(f.field(1, 'save').disabled, false)
  assert.equal(f.field(0, 'save').disabled, true)
  f.requests[2].reply({ error: 'deepseek save failed' }, 503); await tick()
  assert.equal(f.field(0, 'message').textContent, 'deepseek save failed')
  assert.match(f.field(1, 'message').textContent, /尚未验证/)
})

test('logout clears both inputs and details and late writes cannot restore them', async () => {
  const f = fixture(); await ready(f)
  f.field(0, 'key').value = 'fixture-save'
  f.cards[0].querySelector('form').fire('submit')
  f.field(1, 'key').value = 'fixture-unsaved'
  f.cards[1].querySelector('details').open = true
  f.loggedOut()
  f.requests[2].reply(configured('late-save')); await tick()
  for (const i of [0, 1]) {
    assert.equal(f.field(i, 'key').value, '')
    assert.equal(f.field(i, 'fingerprint').textContent, '')
    assert.equal(f.field(i, 'message').textContent, '')
    assert.equal(f.field(i, 'save').disabled, true)
    assert.equal(f.cards[i].querySelector('details').open, false)
  }
  assert.equal(f.requests.length, 3)
})

test('reopening waits for in-flight writes then refreshes without accepting the old result', async () => {
  const f = fixture(); await ready(f)
  f.field(0, 'key').value = 'fixture-save'
  f.cards[0].querySelector('form').fire('submit')
  await f.showPage('account')
  const reopened = f.showPage('models')
  assert.equal(f.requests.length, 4)
  assert.equal(f.field(0, 'save').disabled, true)
  f.requests[2].reply(configured('old-page-result')); await tick()
  assert.equal(f.field(0, 'fingerprint').textContent, '')
  assert.equal(f.requests[4].url, '/auth/api/model-key/deepseek')
  assert.equal(f.requests[4].options.method, undefined)
  f.requests[4].reply(configured('fresh-deepseek'))
  f.requests[3].reply(configured('fresh-zhipu'))
  await reopened; await tick()
  assert.equal(f.field(0, 'fingerprint').textContent, 'fresh-deepseek')
  assert.equal(f.field(1, 'fingerprint').textContent, 'fresh-zhipu')
})
