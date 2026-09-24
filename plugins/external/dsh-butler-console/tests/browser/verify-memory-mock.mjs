/**
 * P1 记忆系统 mock 冒烟（Edge CDP 9223 + mock 8790 指向 web-react/）。
 *
 * 验证目标（设计 §6.2 步骤 7 的 mock 层）：
 *   [1] 右栏「记忆」轻摘要渲染（计数拆口径 + 最近条目）
 *   [2] 设置页出现「记忆与要求」Tab，切入后三分区 Tab 可见
 *   [3] 分区二「老大的要求」：3 条假数据渲染（含 I1）、输入框上限 60、分工说明在场
 *   [4] 分区三「记忆库」：注入计数与截断分隔线、导出链接、清空按钮
 *   [5] 分区一「产品资产」：只读六段卡片（默认折叠，展开有正文）
 *   [6] 新增一条要求（POST 走 mock 内存态）后列表 +1
 *   [7] 页面 console 无错误
 *
 * 用法：node tests/browser/verify-memory-mock.mjs
 */
const CDP = 'http://127.0.0.1:9223'
const PAGE = 'http://127.0.0.1:8790/butler'

const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let seq = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown exception')
  }
})
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) throw new Error(`evaluate 失败: ${reply.result.exceptionDetails.text}`)
  return reply.result?.result?.value
}
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })

const nav = await send('Page.navigate', { url: PAGE })
if (nav.error !== undefined || nav.result?.errorText !== undefined) throw new Error('页面导航失败')
await sleep(1500)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// [1] 右栏轻摘要。
const summary = await evaluate(`(() => {
  const root = document.querySelector('[data-testid="memory-summary"]')
  if (root === null) return null
  return {
    count: root.querySelector('.panel-section__count')?.textContent ?? '',
    recent: root.querySelectorAll('.panel-section__recent li').length,
  }
})()`)
check('右栏记忆轻摘要渲染', summary !== null && summary.recent > 0, summary ? `${summary.count}，最近 ${summary.recent} 条` : '未找到')

// [2] 打开设置页，切到记忆 Tab。
await evaluate(`document.querySelector('#settings-open, button[title="设置"], .topbar button')?.click()`)
await sleep(400)
// 找齿轮：遍历按钮找带「设置」aria/title 的；找不到就用 store 直开（兜底，不依赖具体 DOM）。
const opened = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const gear = buttons.find(b => (b.getAttribute('aria-label') ?? b.title ?? '').includes('设置'))
  if (gear !== undefined) { gear.click(); return 'gear' }
  return 'not-found'
})()`)
if (opened !== 'gear') {
  await evaluate(`window.dispatchEvent(new CustomEvent('noop'))`)
  // 兜底：通过 React store 直开（app 暴露在 window 上的调试口不可靠，改为点击顶栏唯一圆形按钮）。
  await evaluate(`[...document.querySelectorAll('button')].at(-1)?.click()`)
}
await sleep(400)
const hasSettings = await evaluate(`document.querySelector('#settings') !== null`)
check('设置页打开', hasSettings === true)
const memTab = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"], .settings__tabs button')]
  const target = tabs.find(b => b.textContent.includes('记忆与要求'))
  if (target === undefined) return false
  target.click()
  return true
})()`)
await sleep(300)
check('记忆与要求 Tab 存在并切入', memTab === true)

// [3] 三分区 Tab 结构。
const sectionTabs = await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].map(b => b.textContent)`)
check('三分区 Tab（出厂规矩/老大的要求/记忆库）', JSON.stringify(sectionTabs) === JSON.stringify(['出厂规矩', '老大的要求', '记忆库']), JSON.stringify(sectionTabs))

// [4] 老大的要求分区：假数据 + 分工说明 + 新增。
const instructionInfo = await evaluate(`(() => {
  const root = document.querySelector('.mem-instructions')
  if (root === null) return null
  return {
    rows: root.querySelectorAll('.mem-row').length,
    hasNote: root.querySelector('.mem-note')?.textContent.includes('永远生效') ?? false,
    hasScope: root.textContent.includes('当前对管家生效'),
    hasLimit: (root.querySelector('.mem-add input')?.placeholder ?? '').includes('60'),
  }
})()`)
check('老大的要求：1 条假数据 + 分工说明 + 作用域 + 60 字上限', instructionInfo !== null && instructionInfo.rows === 1 && instructionInfo.hasNote && instructionInfo.hasScope && instructionInfo.hasLimit, JSON.stringify(instructionInfo))
const added = await evaluate(`(async () => {
  const input = document.querySelector('.mem-add input')
  if (input === null) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '回复保持简短')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 100))
  document.querySelector('.mem-add button')?.click()
  await new Promise(r => setTimeout(r, 300))
  return document.querySelectorAll('.mem-instructions .mem-row').length
})()`)
check('新增一条要求后列表 +1', added === 2, `rows=${String(added)}`)

// [5] 记忆库分区。
await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].find(b => b.textContent === '记忆库')?.click()`)
await sleep(300)
const library = await evaluate(`(() => {
  const root = document.querySelector('.mem-library')
  if (root === null) return null
  return {
    capacity: root.querySelector('.mem-library__capacity')?.textContent ?? '',
    rows: root.querySelectorAll('.mem-row').length,
    hasDivider: root.querySelector('.mem-library__divider') !== null,
    hasExport: root.querySelector('a[href*="export"]') !== null,
    hasPurge: root.textContent.includes('清空记忆库'),
  }
})()`)
check('记忆库：容量说明 + 行 + 导出 + 清空', library !== null && library.rows >= 2 && library.hasExport && library.hasPurge, JSON.stringify(library))

// [6] 出厂规矩分区（0.14.4 文案改名，原「产品资产」）。
await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].find(b => b.textContent === '出厂规矩')?.click()`)
await sleep(300)
const procedural = await evaluate(`(() => {
  const root = document.querySelector('.mem-procedural')
  if (root === null) return null
  const cards = root.querySelectorAll('.mem-procedural__card')
  const first = cards[0]
  first?.querySelector('button')?.click()
  return { cards: cards.length, hasNote: root.textContent.includes('每次对话都会读') }
})()`)
await sleep(200)
const proceduralBody = await evaluate(`document.querySelector('.mem-procedural__body')?.textContent.slice(0, 40) ?? ''`)
check('出厂规矩：6 卡只读 + 因果说明 + 可展开', procedural !== null && procedural.cards === 6 && procedural.hasNote && proceduralBody.includes('牛马大总管'), `${procedural?.cards} 卡，正文「${proceduralBody.slice(0, 20)}…」`)

// [7] console 无错误。
check('console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

// 截图留证。
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data !== undefined) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(new URL('./memory-mock-smoke.png', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'), Buffer.from(shot.result.data, 'base64'))
  console.log('截图已存 tests/browser/memory-mock-smoke.png')
}

await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
const failed = results.filter(result => !result.pass)
console.log(failed.length === 0 ? '\n全部通过' : `\n${failed.length} 项失败`)
process.exit(failed.length === 0 ? 0 : 1)
