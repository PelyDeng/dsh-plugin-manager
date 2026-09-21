/**
 * React 迁移批 5 浏览器验证：设置页全链 + localStorage 键沿用核验。
 * 真实鼠标键盘注入，DOM 断言只读（CDP + 原生 WebSocket，零新依赖）。
 *
 * 用法：node tests/browser/verify-react-batch5.mjs（mock 8790→web-react；Edge CDP 9223）
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
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown')
  }
})
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) {
    const detail = reply.result.exceptionDetails
    throw new Error(`evaluate 失败: ${detail.text} ${detail.exception?.description ?? ''}`)
  }
  return reply.result?.result?.value
}
const centerOf = async selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return null; el.scrollIntoView({ block: 'nearest' }); const rect = el.getBoundingClientRect(); return rect.width === 0 || rect.height === 0 ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`)
const click = async point => {
  if (point === null) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return true
}
const clickAt = async selector => click(await centerOf(selector))
const typeText = async text => {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
}
const pressKey = async (key, code, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(modifiers ? { modifiers } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
const nav = await send('Page.navigate', { url: PAGE })
if (nav.error !== undefined || nav.result?.errorText !== undefined) { console.error('导航失败'); process.exit(1) }
await new Promise(resolve => setTimeout(resolve, 1500))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? '✓' : '✗'}] ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

// [1] 齿轮进设置页（页面切换非模态，焦点落标题）。
await clickAt('.icon-btn')
await new Promise(resolve => setTimeout(resolve, 600))
const opened = await evaluate(`(() => ({
  section: document.getElementById('settings') !== null,
  cards: document.querySelectorAll('.set-card').length,
  focusedTitle: document.activeElement?.id === 'settings-title',
}))()`)
check('[1] 设置页进入（卡片+焦点落标题）', opened.section && opened.cards >= 3 && opened.focusedTitle, JSON.stringify(opened))

// [2] 改名保存（草稿语义：输入→未保存→保存→已保存→右栏同步）。
const firstAlias = await centerOf('.set-card:nth-child(1) .field input')
check('[2-pre] 改名输入框存在可点', firstAlias !== null)
await click(firstAlias)
await new Promise(resolve => setTimeout(resolve, 200))
await pressKey('a', 'KeyA', 65, 2)
await pressKey('Backspace', 'Backspace', 8)
await typeText('博客智能体·笔杆子')
await new Promise(resolve => setTimeout(resolve, 200))
const dirty = await evaluate(`document.querySelector('.set-card .set-card__status')?.textContent ?? ''`)
check('[2] 草稿状态（未保存的改动）', dirty === '未保存的改动', dirty)
await clickAt('.set-card:nth-child(1) .set-card__actions .btn--primary')
await new Promise(resolve => setTimeout(resolve, 800))
const saved = await evaluate(`(() => ({
  status: document.querySelector('.set-card .set-card__status')?.textContent ?? '',
  rightPanelName: [...document.querySelectorAll('#member-list .member__name')].some(node => node.textContent === '博客智能体·笔杆子'),
}))()`)
check('[2b] 保存生效（已保存+右栏同步）', saved.status === '已保存' && saved.rightPanelName, JSON.stringify(saved))

// [3] 配色草稿：点色块 → 未保存 → 保存。
await clickAt('.set-card:nth-child(1) .swatches .swatch:nth-child(3)')
await new Promise(resolve => setTimeout(resolve, 200))
await clickAt('.set-card:nth-child(1) .set-card__actions .btn--primary')
await new Promise(resolve => setTimeout(resolve, 800))
const accentSaved = await evaluate(`document.querySelector('.set-card .set-card__status')?.textContent ?? ''`)
check('[3] 配色草稿保存', accentSaved === '已保存' || accentSaved === '刚提交的已存上；之后的新改动还没保存', accentSaved)

// [4] 内置换脸：点第一个内置头像 → 已更新。
await clickAt('.set-card:nth-child(1) .builtin-strip .builtin-strip__item:nth-child(1)')
await new Promise(resolve => setTimeout(resolve, 800))
const avatarDone = await evaluate(`(() => {
  const statuses = [...document.querySelectorAll('.set-card__status')].map(node => node.textContent)
  return statuses.some(text => text === '头像已更新')
})()`)
check('[4] 内置头像换脸', avatarDone === true)

// [5] Escape 链：设置页优先于抽屉。
await pressKey('Escape', 'Escape', 27)
await new Promise(resolve => setTimeout(resolve, 300))
const closedByEsc = await evaluate(`document.getElementById('settings') === null`)
check('[5] Esc 关闭设置页（链首优先）', closedByEsc === true)

// [6] localStorage 键沿用核验（方案批 5：键名与格式原样）。
// 造一份 butler.card.* 与 motto，再读回。
const keys = await evaluate(`(() => {
  const cardKey = Object.keys(localStorage).find(key => key.startsWith('butler.card.'))
  return {
    cardKey,
    cardValue: cardKey !== null && cardKey !== undefined ? JSON.parse(localStorage.getItem(cardKey)) : null,
    motto: localStorage.getItem('butler.motto'),
    conversation: localStorage.getItem('butler.conversationId'),
  }
})()`)
check('[6] localStorage 键沿用（butler.card.*/motto/conversationId）',
  keys.cardKey !== null && keys.cardKey !== undefined && typeof keys.cardValue.open === 'boolean' && keys.conversation !== null,
  JSON.stringify(keys))

check('[7] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
if (process.env.BATCH5_SHOT !== undefined) {
  writeFileSync(process.env.BATCH5_SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：${process.env.BATCH5_SHOT}`)
}
ws.close()
process.exit(failed === 0 ? 0 : 1)
