/**
 * React 迁移批 2 浏览器验证（CDP + 原生 WebSocket，零新依赖）。
 *
 * 批 2 DoD 的浏览器面：左右栏功能对照——搜索过滤、管理模式（勾选/全选/计数/批量删除
 * 两段式）、单条删除两段式、失败记录删除。全部真实鼠标/键盘注入，DOM 断言只读。
 *
 * 用法：node tests/browser/verify-react-batch2.mjs（mock 8790→web-react；Edge CDP 9223）
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
    throw new Error(`evaluate 失败: ${detail.text} ${detail.exception?.description ?? ''} @行${detail.lineNumber ?? '?'}:${detail.columnNumber ?? '?'}`)
  }
  return reply.result?.result?.value
}
const centerOf = selector => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (el === null) return null
  const rect = el.getBoundingClientRect()
  return rect.width === 0 ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
})()`)
const click = async point => {
  if (point === null) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  return true
}
const clickAt = async selector => click(await centerOf(selector))
const typeText = async text => {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
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

const rowCount = () => evaluate(`document.querySelectorAll('#chat-list .chat-row').length`)

// [1] 搜索过滤：输入「博客」→ 行数收窄；清空恢复。
const before = await rowCount()
const searchPoint = await centerOf('#chat-search')
if (searchPoint !== null) {
  await click(searchPoint)
  await typeText('博客')
  await new Promise(resolve => setTimeout(resolve, 500))
  const filtered = await rowCount()
  check('[1] 搜索过滤（输入「博客」收窄）', before > 0 && filtered > 0 && filtered < before, `${before} → ${filtered}`)
  // 清空：Ctrl+A 全选（modifiers=2 是 CDP 的 Ctrl 位掩码）+ Backspace。
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await new Promise(resolve => setTimeout(resolve, 1000))
  check('[1b] 清空搜索恢复全部', (await rowCount()) === before)
} else {
  check('[1] 搜索框存在', false)
}

// [2] 管理模式：进入 → 勾 1 行 → 计数 → 全选 → 退出。
await clickAt('#chat-manage-toggle')
await new Promise(resolve => setTimeout(resolve, 300))
const manageOn = await evaluate(`(() => ({
  checks: document.querySelectorAll('.chat-row__check').length,
  bar: document.getElementById('chat-manage-bar')?.hidden === false,
}))()`)
check('[2] 管理模式进入（行变勾选+操作条）', manageOn.checks > 0 && manageOn.bar, JSON.stringify(manageOn))
if (manageOn.checks > 0) {
  await clickAt('.chat-row__check')
  await new Promise(resolve => setTimeout(resolve, 400))
  const picked1 = await evaluate(`document.getElementById('chat-manage-count')?.textContent ?? ''`)
  await clickAt('#chat-manage-all')
  await new Promise(resolve => setTimeout(resolve, 400))
  const pickedAll = await evaluate(`(() => { const count = document.getElementById('chat-manage-count')?.textContent ?? ''; const checked = document.querySelectorAll('.chat-row__check:checked').length; const total = document.querySelectorAll('.chat-row__check').length; return { count, checked, total } })()`)
  check('[2b] 勾选计数与全选', picked1.includes('已选 1 条') && pickedAll.checked === pickedAll.total, JSON.stringify({ picked1, pickedAll }))
}

// [3] 批量删除两段式：删所选 → 按钮变「确认删除」→ 确认 → 行减少。
const rowsBeforeBatch = await rowCount()
const deleteBtnBefore = await evaluate(`document.getElementById('chat-manage-delete')?.textContent ?? ''`)
await clickAt('#chat-manage-delete')
await new Promise(resolve => setTimeout(resolve, 200))
const deleteBtnArmed = await evaluate(`document.getElementById('chat-manage-delete')?.textContent ?? ''`)
await clickAt('#chat-manage-delete')
await new Promise(resolve => setTimeout(resolve, 1000))
const rowsAfterBatch = await rowCount()
check('[3] 批量删除两段式', deleteBtnBefore === '删除所选' && deleteBtnArmed.includes('确认删除') && rowsAfterBatch < rowsBeforeBatch,
  `${deleteBtnBefore} → ${deleteBtnArmed}; ${rowsBeforeBatch} → ${rowsAfterBatch} 行`)

// [4] 退出管理模式。
await clickAt('#chat-manage-exit')
await new Promise(resolve => setTimeout(resolve, 300))
const manageOff = await evaluate(`document.getElementById('chat-manage-bar')?.hidden !== false && document.querySelectorAll('.chat-row__check').length === 0`)
check('[4] 退出管理模式', manageOff === true)

// [5] 单条删除两段式：第一段武装 → 3 秒内第二段确认 → 行减少。
const rowsBeforeOne = await rowCount()
await clickAt('#chat-list .chat-row .row-delete')
await new Promise(resolve => setTimeout(resolve, 200))
const armedText = await evaluate(`document.querySelector('#chat-list .chat-row .row-delete')?.textContent ?? ''`)
await clickAt('#chat-list .chat-row .row-delete')
await new Promise(resolve => setTimeout(resolve, 1000))
const rowsAfterOne = await rowCount()
check('[5] 单条删除两段式（×→确认删除→消失）', armedText === '确认删除' && rowsAfterOne === rowsBeforeOne - 1,
  `${armedText}; ${rowsBeforeOne} → ${rowsAfterOne}`)

// [6] 失败记录删除两段式。武装窗口 3 秒：两次点击背靠背（复用首次靶心，armed 后
// 布局微移不换靶心），armed 文案 250ms 快查，确认断言看行数。
const failuresBefore = await evaluate(`document.querySelectorAll('.failure-row').length`)
if (failuresBefore > 0) {
  const armPoint = await centerOf('.failure-row .row-delete')
  await click(armPoint)
  await new Promise(resolve => setTimeout(resolve, 250))
  const armedText = await evaluate(`document.querySelector('.failure-row .row-delete')?.textContent ?? ''`)
  const hit = await evaluate(`(() => { const el = document.querySelector('.failure-row .row-delete'); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(${armPoint.x}, ${armPoint.y}); return hit ? hit.className : 'none' })()`)
  await click(armPoint)
  await new Promise(resolve => setTimeout(resolve, 1200))
  const failuresAfter = await evaluate(`document.querySelectorAll('.failure-row').length`)
  check('[6] 失败记录删除两段式', armedText === '确认删除' && failuresAfter === failuresBefore - 1,
    `${armedText}; hit=${hit}; ${failuresBefore} → ${failuresAfter}`)
} else {
  check('[6] 失败记录存在可删', false, '无失败记录（前面轮次已删光则算通过形态）')
}

check('[7] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(process.env.BATCH2_SHOT ?? 'batch2-panels.png', Buffer.from(shot.result.data, 'base64'))
console.log(`截图：${process.env.BATCH2_SHOT ?? 'batch2-panels.png'}`)
ws.close()
process.exit(failed === 0 ? 0 : 1)
