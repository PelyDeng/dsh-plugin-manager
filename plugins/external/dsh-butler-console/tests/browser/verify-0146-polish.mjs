/**
 * 0.14.6 小残留清理 mock 冒烟（Edge CDP 9223 + mock 8790 指向 web-react/）。
 *
 * 验证目标（四项修改逐项）：
 *   [1] 左下角裸文字不再出现：操作反馈走 .mem-flash 就近轻提示（保存一条要求后，操作区
 *       附近出现「要求已保存」，2.4s 动画结束文本清空；#sr-status 视觉隐藏且仍承载读屏）
 *   [2] AI 搜索占位点击 → 搜索框下方 flash（原 announce 泄漏同款修复）
 *   [3] 出厂规矩卡展开后底部有渐隐遮罩（::after 在场）
 *   [4] emoji 三处换 Lucide：提问卡 .ask__hand、composer 落款红心 .composer__hint-heart、
 *       派工卡选中对勾 .dcard__cell-check（聊天页渲染链路，本脚本只验 CSS 类与 SVG 在场性
 *       由组件测试覆盖，这里验设置页可见面 + console 无错误）
 *
 * 用法：node tests/browser/verify-0146-polish.mjs（截图存 .local/ui-review-0146/）。
 */
import { mkdirSync } from 'node:fs'
const CDP = 'http://127.0.0.1:9223'
const PAGE = 'http://127.0.0.1:8790/butler'
const SHOT_DIR = 'E:/A_Git_CodeSource/dsh-plugin-manager-gitee/.local/ui-review-0146'
mkdirSync(SHOT_DIR, { recursive: true })

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
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'unknown exception')
  }
})
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails !== undefined) {
    throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  }
  return r.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.result.data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: PAGE })
await sleep(2500)

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`) }

// 打开设置 → 记忆与要求 Tab（默认落点即「老大的要求」）。齿轮按钮按 aria/title 找（对齐 verify-memory-mock 同款）。
await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const gear = buttons.find(b => (b.getAttribute('aria-label') ?? b.title ?? '').includes('设置'))
  if (gear !== undefined) { gear.click(); return 'gear' }
  return 'not-found'
})()`)
await sleep(800)
// 切「记忆与要求」Tab（设置页默认落外观）。
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role="tab"], .settings__tabs button')]
  tabs.find(b => b.textContent.includes('记忆与要求'))?.click()
})()`)
await sleep(600)
const settingsReady = await evaluate(`document.querySelector('#mem-instruction-input') !== null`)
if (settingsReady === false) {
  // 再等一轮（默认 Tab 渲染有延迟时）
  await sleep(1200)
}

// [1] 保存反馈就近 flash：输入一条要求并保存
await evaluate(`(() => {
  const input = document.querySelector('#mem-instruction-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '验证用：测试就近提示')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(200)
await evaluate(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '添加')?.click() })()`)
await sleep(400)
const flash1 = await evaluate(`(() => {
  const el = document.querySelector('.mem-instructions .mem-flash')
  const span = el?.querySelector('span')
  const sr = document.getElementById('sr-status')
  const srHidden = sr ? getComputedStyle(sr).position === 'absolute' && parseFloat(getComputedStyle(sr).width) <= 2 : null
  return { flashText: span?.textContent ?? '', srText: sr?.textContent ?? '', srVisuallyHidden: srHidden, flashRole: el?.getAttribute('role') ?? '' }
})()`)
check('保存后 flash 就近出现（操作区内）', flash1.flashText === '要求已保存', JSON.stringify(flash1))
check('读屏通道保留：flash 容器 role=status、sr-status 视觉隐藏', flash1.srVisuallyHidden === true && flash1.flashRole === 'status')
await shot('flash-保存反馈')
await sleep(2600)
const flash2 = await evaluate(`(() => {
  const span = document.querySelector('.mem-instructions .mem-flash span')
  return { cleared: span === null, srRemain: document.getElementById('sr-status')?.textContent ?? '' }
})()`)
check('2.4s 后 flash 文本已清（左下角不再有残留裸文字）', flash2.cleared === true, JSON.stringify(flash2))

// 删掉验证数据
await evaluate(`(() => { window.confirm = () => true })()`)
await evaluate(`(() => {
  const row = [...document.querySelectorAll('.mem-row')].find(r => r.textContent.includes('验证用'))
  ;[...row.querySelectorAll('button')].find(b => b.textContent.includes('删除'))?.click()
})()`)
await sleep(500)

// [2] AI 搜索占位 flash
await evaluate(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('AI 搜索'))?.click() })()`)
await sleep(400)
const flash3 = await evaluate(`(() => {
  const el = document.querySelector('.mem-search-wrap .mem-flash span')
  return el?.textContent ?? ''
})()`)
check('AI 搜索占位点击 → 搜索框下方 flash', flash3.includes('后续版本启用'), flash3)

// [3] 出厂规矩卡渐隐遮罩
await evaluate(`(() => { const tabs = [...document.querySelectorAll('.mem-settings__tabs button')]; tabs.find(b => b.textContent === '出厂规矩')?.click() })()`)
await sleep(600)
const fade = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.mem-procedural__card')]
  const first = cards[0]
  first?.querySelector('.mem-procedural__head')?.click()
  return { cards: cards.length }
})()`)
await sleep(500)
const fade2 = await evaluate(`(() => {
  const card = document.querySelector('.mem-procedural__card')
  const after = getComputedStyle(card, '::after')
  return {
    content: after.content, height: after.height,
    bg: after.backgroundImage.includes('gradient') || after.background.includes('gradient'),
  }
})()`)
check('出厂规矩卡在场且展开后底部渐隐遮罩生效', fade.cards > 0 && fade2.content === '""' && fade2.bg === true, JSON.stringify({ cards: fade.cards, ...fade2 }))
await shot('出厂规矩-渐隐遮罩')

// [4] emoji 三处的 Lucide 替换在场性（静态资源检查由组件层保证，这里查欢迎页 ask 卡与全局无 emoji content）
const emoji = await evaluate(`(() => {
  const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
  const bad = css.filter(r => r.cssText && /content:\\s*['\"](\u270b|\u2764|\u2713)/.test(r.cssText))
  return bad.length
})()`)
check('样式表中不再有 ✋/❤/✓ emoji content 规则', emoji === 0, `残留 ${emoji} 条`)

const consoleOk = consoleErrors.length === 0
check('console 无错误', consoleOk, consoleErrors.slice(0, 3).join(' | '))

const pass = results.filter(r => r.ok).length
console.log(`\n${pass}/${results.length} 项通过`)
await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
process.exit(pass === results.length ? 0 : 1)
