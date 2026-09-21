/**
 * React 迁移批 4b 浏览器验证：调度卡声明式重设计（协作剧本双成员全链 + 卡片交互全套）
 * + Suggestion 追问芯片样张占位（数据由 mock 驱动，完整功能是 0.13.x）。
 * 真实鼠标键盘注入，DOM 断言只读。
 *
 * 用法：node tests/browser/verify-react-batch4b.mjs（mock 8790→web-react；Edge CDP 9223）
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
const centerOf = async selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return null; const rect = el.getBoundingClientRect(); return rect.width === 0 || rect.height === 0 ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`)
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
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
const nav = await send('Page.navigate', { url: PAGE })
if (nav.error !== undefined || nav.result?.errorText !== undefined) { console.error('导航失败'); process.exit(1) }
await new Promise(resolve => setTimeout(resolve, 1500))
// 测试间隔离：偏好是本机持久态，上一轮的折叠/只看结论会污染本轮断言。
await evaluate(`localStorage.clear()`)
await send('Page.navigate', { url: PAGE })
await new Promise(resolve => setTimeout(resolve, 1500))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? '✓' : '✗'}] ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

// 发协作消息（两个成员并行剧本）。
await click(await centerOf('#message-input'))
await typeText('这个活我们协作完成，一起上')
await pressEnter()
await new Promise(resolve => setTimeout(resolve, 1200))

// [1] 调度卡出现：状态条 + 两个格子 + 折叠头内格子（收起也看得见谁被调了）。
const card1 = await evaluate(`(() => {
  const card = document.querySelector('.dcard')
  return {
    card: card !== null,
    barText: card?.querySelector('.dcard__bar-text')?.textContent ?? '',
    cells: card?.querySelectorAll('.dcard__cell').length ?? 0,
    open: card?.open === true,
  }
})()`)
check('[1] 调度卡出现（状态条+双格子）', card1.card && card1.cells === 2 && card1.barText.includes('2 位成员'), JSON.stringify(card1))

// [3] 折叠/「有更新」：展开（流式进行中）→ 收起 → fresh 出现 → 展开清掉。
// 卡默认收起，先点「展开」；流式仍在进行时收起，才有「新进展」可提示。
await clickAt('.dcard__bar .dcard__tool:last-child')
await new Promise(resolve => setTimeout(resolve, 250))
const expanded = await evaluate(`document.querySelector('.dcard')?.open === true`)
await clickAt('.dcard__bar .dcard__tool:last-child')
await new Promise(resolve => setTimeout(resolve, 250))
const folded = await evaluate(`document.querySelector('.dcard')?.open === false`)
check('[3] 展开再折叠按钮', expanded && folded === true, `expanded=${expanded}`)
// 轮询等 fresh：折叠后下一波状态变化（成员完成）会点亮「有更新」。
let fresh = false
for (let i = 0; i < 12; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 400))
  fresh = await evaluate(`(() => {
    const node = document.querySelector('.dcard__fresh')
    return node !== null && node.hidden === false
  })()`)
  if (fresh) break
}
check('[3b] 收起时「有更新」出现', fresh === true)
await clickAt('.dcard__bar .dcard__tool:last-child')
await new Promise(resolve => setTimeout(resolve, 300))
const freshCleared = await evaluate(`(() => {
  const node = document.querySelector('.dcard__fresh')
  return node === null || node.hidden === true
})()`)
check('[3c] 展开后「有更新」收掉', freshCleared === true)


// [2] 流式期间：格子状态推进（进行中）+ 切格子看结果区。
await new Promise(resolve => setTimeout(resolve, 2500))
const cells = await evaluate(`(() => {
  const cellList = [...document.querySelectorAll('.dcard__cell')]
  return {
    states: cellList.map(node => node.querySelector('.dcard__statetext')?.textContent ?? ''),
    second: (() => { const el = cellList[1]; if (el === null) return null; const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })(),
  }
})()`)
check('[2] 格子状态推进', cells.states.every(state => state !== ''), JSON.stringify(cells.states))
if (cells.second !== null) {
  await click(cells.second)
  await new Promise(resolve => setTimeout(resolve, 300))
  const switched = await evaluate(`(() => {
    const title = document.querySelector('.dcard__result-title')?.textContent ?? ''
    const selected = [...document.querySelectorAll('.dcard__cell')].map(node => node.getAttribute('aria-selected'))
    return { title: title.slice(0, 14), selected }
  })()`)
  check('[2b] 切格子选中（结果区标题换人）', switched.title.includes('@huiyu'), JSON.stringify(switched))
}

// [4] 只看结论切换。
await clickAt('.dcard__tools .dcard__tool:nth-child(1)')
await new Promise(resolve => setTimeout(resolve, 200))
const resultOnlyOn = await evaluate(`(() => ({
  slots: document.querySelector('.dcard__slots')?.className.includes('result-only') === true,
  btnText: document.querySelector('.dcard__tools .dcard__tool:nth-child(1)')?.textContent ?? '',
}))()`)
check('[4] 只看结论切换', resultOnlyOn.slots && resultOnlyOn.btnText === '看完整过程', JSON.stringify(resultOnlyOn))
await clickAt('.dcard__tools .dcard__tool:nth-child(1)')
await new Promise(resolve => setTimeout(resolve, 200))

// [5] 等收尾：全格完成 + 状态条含「位已交回」红波浪。
await new Promise(resolve => setTimeout(resolve, 5000))
const settled = await evaluate(`(() => ({
  barText: document.querySelector('.dcard__bar-text')?.textContent ?? '',
  states: [...document.querySelectorAll('.dcard__statetext')].map(node => node.textContent),
  wavy: document.querySelector('.dcard__bar-text .red-wavy') !== null,
}))()`)
check('[5] 收口（全格完成+红波浪批注）', settled.states.every(state => state === '已完成') && settled.wavy, JSON.stringify(settled))

// [6] Esc 收起 + 偏好持久化：收起后刷新，卡保持收起。
await clickAt('.dcard__tools .dcard__tool:last-child')
await new Promise(resolve => setTimeout(resolve, 200))
await click(await centerOf('.dcard__grid .dcard__cell'))
await pressEscape()
function pressEscape() {
  return send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() =>
    send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }))
}
await new Promise(resolve => setTimeout(resolve, 300))
const escFolded = await evaluate(`document.querySelector('.dcard')?.open === false`)
check('[6] Esc 收起', escFolded === true)
const prefStored = await evaluate(`(() => {
  const raw = localStorage.getItem('butler.card.' + (document.querySelector('.dcard')?.dataset.taskId ?? ''))
  return raw !== null && JSON.parse(raw).open === false
})()`)
check('[6b] 折叠偏好落本机（键名/格式沿用旧前端）', prefStored === true)

// [8] 追问芯片样张（协作剧本的 summary 带占位追问）。
const chips = await evaluate(`(() => ({
  chips: [...document.querySelectorAll('.follow-chip')].map(node => node.textContent),
}))()`)
check('[8] 追问芯片样张（mock 驱动）', chips.chips.length === 3, JSON.stringify(chips))

check('[7] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
if (process.env.BATCH4B_SHOT !== undefined) {
  writeFileSync(process.env.BATCH4B_SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：${process.env.BATCH4B_SHOT}`)
}
ws.close()
process.exit(failed === 0 ? 0 : 1)
