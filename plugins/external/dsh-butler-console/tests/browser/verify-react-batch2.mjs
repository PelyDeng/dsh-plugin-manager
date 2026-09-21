/**
 * React 迁移批 2.5 浏览器验证（对齐 main 0.12.4-0.12.7 形态：复选框常驻/⋯菜单/
 * 行内重命名/分页/搜索全量/失败菜单）。CDP 真实鼠标键盘注入，DOM 断言只读。
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
const rowCount = () => evaluate(`document.querySelectorAll('#chat-list .chat-row').length`)

// [1] 复选框常驻（0.12.5）与分页（0.12.4：mock 9 条/每页 5 → 2 页）。
const initial = await evaluate(`(() => ({
  rows: document.querySelectorAll('#chat-list .chat-row').length,
  checks: document.querySelectorAll('#chat-list .chat-row__check').length,
  pagerVisible: document.getElementById('chat-pager')?.hidden === false,
}))()`)
check('[1] 复选框常驻+分页条出现', initial.rows === 5 && initial.checks === 5 && initial.pagerVisible, JSON.stringify(initial))

// [2] 翻页：next → 行变化 + 计数 2/2 + 再 next 禁用。
await clickAt('#chat-pager-next')
await new Promise(resolve => setTimeout(resolve, 800))
const page2 = await evaluate(`(() => ({
  info: document.getElementById('chat-pager-info')?.textContent ?? '',
  nextDisabled: document.getElementById('chat-pager-next')?.disabled === true,
  firstTitle: document.querySelector('.chat-row__title')?.textContent.slice(0, 12) ?? '',
}))()`)
check('[2] 分页翻页（页码/末页禁用/内容变化）', page2.info === '2 / 2' && page2.nextDisabled && page2.firstTitle !== '', JSON.stringify(page2))
await clickAt('#chat-pager-prev')
await new Promise(resolve => setTimeout(resolve, 800))

// [3] 勾选与计数：勾 2 行 → 已选 2 条；全选三态。
await clickAt('#chat-list .chat-row:nth-child(1) .chat-row__check')
await new Promise(resolve => setTimeout(resolve, 250))
await clickAt('#chat-list .chat-row:nth-child(2) .chat-row__check')
await new Promise(resolve => setTimeout(resolve, 250))
const pickState = await evaluate(`(() => ({
  count: document.getElementById('chat-manage-count')?.textContent ?? '',
  all: document.getElementById('chat-manage-all')?.checked === true,
  indeterminate: document.getElementById('chat-manage-all')?.indeterminate === true,
}))()`)
check('[3] 勾选计数与全选半选态', pickState.count === '已选 2 条' && !pickState.all && pickState.indeterminate, JSON.stringify(pickState))
await clickAt('#chat-manage-all')
await new Promise(resolve => setTimeout(resolve, 250))
const pickAll = await evaluate(`(() => ({
  count: document.getElementById('chat-manage-count')?.textContent ?? '',
  all: document.getElementById('chat-manage-all')?.checked === true,
}))()`)
check('[3b] 全选（本页 5 条）', pickAll.count === '已选 5 条' && pickAll.all, JSON.stringify(pickAll))

// [4] ⋯ 菜单：打开 → 删除所选可用 → 点击 → 行减少且菜单关闭。
await clickAt('#records-menu')
await new Promise(resolve => setTimeout(resolve, 300))
const menuOpen = await evaluate(`(() => ({
  pop: document.getElementById('records-menu-pop')?.hidden === false,
  delDisabled: document.querySelector('#records-menu-pop .chat-manage-menu__item--danger')?.disabled === true,
  renameDisabled: document.querySelectorAll('#records-menu-pop .chat-manage-menu__item')[1]?.disabled === true,
}))()`)
check('[4] ⋯ 菜单打开（删除可用/重命名多选禁用）', menuOpen.pop && !menuOpen.delDisabled && menuOpen.renameDisabled, JSON.stringify(menuOpen))
await clickAt('#records-menu-pop .chat-manage-menu__item--danger')
await new Promise(resolve => setTimeout(resolve, 1000))
const afterDelete = await evaluate(`(() => ({
  rows: document.querySelectorAll('#chat-list .chat-row').length,
  popClosed: document.getElementById('records-menu-pop')?.hidden === true,
  count: document.getElementById('chat-manage-count')?.textContent ?? '',
}))()`)
check('[4b] 菜单删除所选（行减少/菜单关/计数清零）', afterDelete.rows === 4 && afterDelete.popClosed && afterDelete.count === '已选 0 条',
  JSON.stringify(afterDelete))

// [5] 重命名：勾 1 行 → ⋯ 重命名 → 行内输入框 → 改名回车 → 标题更新。
await clickAt('#chat-list .chat-row:nth-child(1) .chat-row__check')
await new Promise(resolve => setTimeout(resolve, 250))
await clickAt('#records-menu')
await new Promise(resolve => setTimeout(resolve, 250))
await clickAt('#records-menu-pop .chat-manage-menu__item:nth-child(2)')
await new Promise(resolve => setTimeout(resolve, 500))
const renameInputPoint = await centerOf('.chat-row__rename')
check('[5] 行内改名输入框出现', renameInputPoint !== null)
if (renameInputPoint !== null) {
  await click(renameInputPoint)
  await pressKey('a', 'KeyA', 65, 2)
  await pressKey('Backspace', 'Backspace', 8)
  await typeText('改名后的任务记录甲')
  await pressKey('Enter', 'Enter', 13)
  await new Promise(resolve => setTimeout(resolve, 900))
  const renamed = await evaluate(`document.querySelector('.chat-row__title')?.textContent ?? ''`)
  check('[5b] 改名生效', renamed === '改名后的任务记录甲', renamed)
}

// [6] 搜索全量过滤：输入「博客」→ 收窄；清空恢复。
const before = await rowCount()
await clickAt('#chat-search')
await typeText('博客')
await new Promise(resolve => setTimeout(resolve, 600))
const filtered = await rowCount()
check('[6] 搜索过滤（全量口径）', before > 0 && filtered > 0 && filtered < before, `${before} → ${filtered}`)
await clickAt('#chat-search')
await pressKey('a', 'KeyA', 65, 2)
await pressKey('Backspace', 'Backspace', 8)
await new Promise(resolve => setTimeout(resolve, 600))
check('[6b] 清空搜索恢复', (await rowCount()) === before)

// [7] 失败记录菜单删除（0.12.7）：勾 1 失败行 → ⋯ → 删除所选 → 行减少。
const failuresBefore = await evaluate(`document.querySelectorAll('.failure-row').length`)
if (failuresBefore > 0) {
  await clickAt('.failure-row .failure-row__check')
  await new Promise(resolve => setTimeout(resolve, 250))
  await clickAt('#failure-menu')
  await new Promise(resolve => setTimeout(resolve, 250))
  await clickAt('#failure-menu-pop .chat-manage-menu__item--danger')
  await new Promise(resolve => setTimeout(resolve, 1000))
  const failuresAfter = await evaluate(`document.querySelectorAll('.failure-row').length`)
  check('[7] 失败记录菜单删除', failuresAfter === failuresBefore - 1, `${failuresBefore} → ${failuresAfter}`)
} else {
  check('[7] 失败记录存在', false, '无失败记录（前轮已删光属正常形态，人工核对）')
}

check('[8] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
const stamp = new Date().toISOString().replaceAll(':', '').slice(0, 17)
// 截图是私有物不入 Git：必须显式传 env（约定写到 .local/butler-console/mock/）。
if (process.env.BATCH2_SHOT !== undefined) {
  writeFileSync(process.env.BATCH2_SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：${process.env.BATCH2_SHOT}`)
}
ws.close()
process.exit(failed === 0 ? 0 : 1)
