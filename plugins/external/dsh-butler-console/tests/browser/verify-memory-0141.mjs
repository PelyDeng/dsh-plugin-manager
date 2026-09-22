/**
 * 0.14.1 反馈修正冒烟：markdown 渲染+滚动 / 输入区强化 / 三分区搜索高亮。
 * 用法：node tests/browser/verify-memory-0141.mjs（mock 8790 指向 web-react/ + CDP 9223）。
 */
const CDP = 'http://127.0.0.1:9223'
const PAGE = 'http://127.0.0.1:8790/butler'
const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', e => {
  const m = JSON.parse(String(e.data))
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '))
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'unknown')
})
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails !== undefined) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}
const sleep = ms => new Promise(r => { setTimeout(r, ms) })
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: PAGE })
await sleep(1500)
const results = []
const check = (name, pass, detail = '') => { results.push({ pass }); console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`) }
// 自清理：删掉 mock 内存里已有的全部 instruction（脚本幂等，可重复跑）。
await (async () => {
  const list = await fetch('http://127.0.0.1:8790/butler/memories?kind=instruction').then(r => r.json())
  const ids = (list.items ?? []).map(item => item.id)
  if (ids.length > 0) await fetch('http://127.0.0.1:8790/butler/memories', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) })
})()

const openMemoryTab = async () => {
  await evaluate(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.title ?? '').includes('设置'))?.click()`)
  await sleep(300)
  await evaluate(`[...document.querySelectorAll('[role="tab"], .settings__tabs button')].find(b => b.textContent.includes('记忆与要求'))?.click()`)
  await sleep(200)
}
await openMemoryTab()

// ①产品资产：markdown 渲染 + 滚动。
await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].find(b => b.textContent === '产品资产')?.click()`)
await sleep(300)
const procExpand = await evaluate(`(() => {
  const card = document.querySelector('.mem-procedural__card button')
  card?.click()
  return true
})()`)
await sleep(300)
const procBody = await evaluate(`(() => {
  const body = document.querySelector('.mem-procedural__body')
  if (body === null) return null
  const rich = body.querySelector('.mem-procedural__body > div') !== null
  const scrollable = getComputedStyle(body).overflowY === 'auto' || body.scrollHeight > body.clientHeight
  const rawMarkdownVisible = body.textContent.includes('## ')
  const structured = body.querySelectorAll('strong, li, p, h1, h2, h3').length
  return { rich, scrollable, rawMarkdownVisible, structured }
})()`)
check('①产品资产正文走 markdown 渲染（无裸 ## 标记，有结构节点）', procExpand && procBody !== null && procBody.rich && procBody.rawMarkdownVisible === false && procBody.structured > 0, JSON.stringify(procBody))
check('①展开区支持滚动', procBody !== null && procBody.scrollable === true)

// ②老大的要求：输入区强化 + <4 字提示 + 添加可用。
await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].find(b => b.textContent === '老大的要求')?.click()`)
await sleep(300)
const addUi = await evaluate(`(() => {
  const label = document.querySelector('.mem-add__label')?.textContent ?? ''
  const input = document.querySelector('#mem-instruction-input')
  const placeholder = input?.placeholder ?? ''
  return { label: label !== '', placeholder: placeholder.includes('60'), hasInputId: input !== null }
})()`)
check('②输入区有「✍ 写一条新规矩」标签 + placeholder 含 60 字', addUi.label && addUi.placeholder && addUi.hasInputId, JSON.stringify(addUi))
const shortWarn = await evaluate(`(async () => {
  const input = document.querySelector('#mem-instruction-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '测试')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const btn = document.querySelector('.mem-add > .btn')
  const warn = document.querySelector('.mem-warn')?.textContent ?? ''
  return { disabled: btn?.disabled, warn: warn.includes('还差') }
})()`)
check('②少于 4 字：按钮禁用且给出原因提示', shortWarn.disabled === true && shortWarn.warn === true, JSON.stringify(shortWarn))
const addOk = await evaluate(`(async () => {
  const input = document.querySelector('#mem-instruction-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '回复保持简短利落')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  document.querySelector('.mem-add > .btn')?.click()
  await new Promise(r => setTimeout(r, 300))
  return document.querySelectorAll('.mem-instructions .mem-row').length
})()`)
check('②满 4 字后添加成功（自清理后新增 1 条）', addOk === 1, `rows=${String(addOk)}`)

// ③搜索：要求分区关键字过滤 + 高亮。
await evaluate(`(async () => {
  const box = document.querySelector('.mem-instructions .mem-search input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(box, '简短')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
})()`)
const searchResult = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.mem-instructions .mem-row')]
  const marks = document.querySelectorAll('.mem-instructions .mem-hit')
  return { rows: rows.length, marks: marks.length }
})()`)
check('③要求分区搜索过滤+<mark> 高亮', searchResult.rows === 1 && searchResult.marks > 0, JSON.stringify(searchResult))

// ③b 记忆库搜索。
await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].find(b => b.textContent === '记忆库')?.click()`)
await sleep(250)
await evaluate(`(async () => {
  const box = document.querySelector('.mem-library .mem-search input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(box, '配图')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
})()`)
const libSearch = await evaluate(`(() => ({
  rows: document.querySelectorAll('.mem-library .mem-row').length,
  marks: document.querySelectorAll('.mem-library .mem-hit').length,
}))()`)
check('③记忆库搜索过滤+高亮', libSearch.rows >= 1 && libSearch.marks > 0, JSON.stringify(libSearch))

// ③c 产品资产搜索：命中卡片自动展开 + 命中数徽标。
await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].find(b => b.textContent === '产品资产')?.click()`)
await sleep(250)
await evaluate(`(async () => {
  const box = document.querySelector('.mem-procedural .mem-search input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(box, '派活')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 250))
})()`)
const procSearch = await evaluate(`(() => ({
  cards: document.querySelectorAll('.mem-procedural__card').length,
  openBodies: document.querySelectorAll('.mem-procedural__body').length,
  hits: document.querySelectorAll('.mem-procedural__hits').length,
}))()`)
check('③产品资产搜索命中卡自动展开+命中数徽标', procSearch.cards >= 1 && procSearch.openBodies >= 1 && procSearch.hits >= 1, JSON.stringify(procSearch))
// ③d AI 搜索占位。
const aiBtn = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.mem-procedural .mem-search button')].find(b => b.textContent.includes('AI'))
  if (btn === undefined) return false
  btn.click()
  return true
})()`)
check('③AI 搜索占位按钮存在（点击提示 P2 启用）', aiBtn === true)

// console 无错误。
check('console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data !== undefined) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(new URL('./memory-0141-smoke.png', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'), Buffer.from(shot.result.data, 'base64'))
}
await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
const failed = results.filter(r => !r.pass)
console.log(failed.length === 0 ? '\n全部通过' : `\n${failed.length} 项失败`)
process.exit(failed.length === 0 ? 0 : 1)
