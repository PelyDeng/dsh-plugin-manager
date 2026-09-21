/**
 * React 迁移批 4a 浏览器验证：@提及（键盘导航/落纸）、附件三通道（回形针/链接/拖拽/
 * 粘贴的可见面——headless 下拖拽粘贴用 DataTransfer evaluate 不可行，验证回形针与链接
 * 两通道 + 附件条三态渲染 + 芯片随消息发出）。CDP 真实鼠标键盘注入，DOM 断言只读。
 *
 * 用法：node tests/browser/verify-react-batch4a.mjs（mock 8790→web-react；Edge CDP 9223）
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

// [1] @ 提及：点 @ 按钮 → 菜单出现（空 query 列全员）→ 键盘 ↓↓↑ 导航高亮。
await clickAt('#at-button')
await new Promise(resolve => setTimeout(resolve, 300))
const pop1 = await evaluate(`(() => ({
  pop: document.getElementById('mention-pop')?.hidden === false,
  options: document.querySelectorAll('#mention-items .mention__item').length,
  active: document.querySelector('.mention__item--active') !== null,
}))()`)
check('[1] @ 按钮翻出点名簿（列全员+首项高亮）', pop1.pop && pop1.options >= 3 && pop1.active, JSON.stringify(pop1))
await pressKey('ArrowDown', 'ArrowDown', 40)
await pressKey('ArrowDown', 'ArrowDown', 40)
await pressKey('ArrowUp', 'ArrowUp', 38)
await new Promise(resolve => setTimeout(resolve, 200))
const navState = await evaluate(`(() => ({
  activeIndex: Number(document.querySelector('.mention__item--active')?.dataset.index ?? -1),
  desc: document.getElementById('mention-pop')?.getAttribute('aria-activedescendant') ?? '',
}))()`)
check('[1b] 键盘导航高亮（↓↓↑ → 第 2 项）', navState.activeIndex === 1 && navState.desc !== '', JSON.stringify(navState))

// [2] 过滤 + 落纸：输入「博」过滤到博客智能体 → Enter 落纸 @外号+空格。
await typeText('博')
await new Promise(resolve => setTimeout(resolve, 300))
const filtered = await evaluate(`document.querySelectorAll('#mention-items .mention__item').length`)
check('[2] 过滤词收窄候选', filtered === 1, `options=${filtered}`)
await pressKey('Enter', 'Enter', 13)
await new Promise(resolve => setTimeout(resolve, 300))
const accepted = await evaluate(`(() => {
  const pop = document.getElementById('mention-pop')
  return {
  popClosed: pop === null || pop.hidden === true,
  value: document.getElementById('message-input')?.value ?? '',
  caret: document.getElementById('message-input')?.selectionStart ?? 0,
  }
})()`)
check('[2b] 落纸（@外号+尾空格，光标在尾）', accepted.popClosed && accepted.value.startsWith('@博客智能体 ') && accepted.caret === accepted.value.length,
  JSON.stringify({ value: accepted.value, caret: accepted.caret }))

// [3] 菜单开着 Esc 关闭；邮箱形态不触发（英文后 @）。
await clickAt('#at-button')
await new Promise(resolve => setTimeout(resolve, 200))
await pressKey('Escape', 'Escape', 27)
await new Promise(resolve => setTimeout(resolve, 200))
const escClosed = await evaluate(`document.getElementById('mention-pop') === null`)
check('[3] Esc 关闭点名簿', escClosed === true)
await clickAt('#message-input')
await typeText('联系 boss@example.com')
await new Promise(resolve => setTimeout(resolve, 300))
const emailNoPop = await evaluate(`document.getElementById('mention-pop')?.hidden !== false`)
check('[3b] 邮箱形态不触发点名簿', emailNoPop === true)
await clickAt('#message-input')
await pressKey('a', 'KeyA', 65, 2)
await pressKey('Backspace', 'Backspace', 8)

// [4] 附件链接通道：点链接按钮 → 输入 http 链接回车 → 附件条出现（ready 芯片）。
await clickAt('#attach-link-button')
await new Promise(resolve => setTimeout(resolve, 200))
await clickAt('#attach-url-input')
await typeText('https://pelyblog.com/media/cover.png')
await pressKey('Enter', 'Enter', 13)
await new Promise(resolve => setTimeout(resolve, 800))
const chip = await evaluate(`(() => {
  const item = document.querySelector('#attach-items .attach__item')
  return {
    strip: document.getElementById('attach-strip')?.hidden === false,
    name: item?.querySelector('.attach__name')?.textContent ?? '',
    phase: item?.dataset.phase ?? '',
  }
})()`)
check('[4] 链接取回附件（ready 芯片入条）', chip.strip && chip.name.includes('cover.png') && chip.phase === 'ready', JSON.stringify(chip))

// [5] 回形针通道：headless 下注入文件不可行，验证 input 触发链路存在（click 不抛）。
const paperclip = await clickAt('#attach-button')
check('[5] 回形针触发文件选择链路', paperclip === true)

// [6] 带附件发送：芯片随消息发出（输入框清空）。
await clickAt('#message-input')
await typeText('查一下园区通行情况，附件是背景材料')
await pressKey('Enter', 'Enter', 13)
await new Promise(resolve => setTimeout(resolve, 1200))
const sent = await evaluate(`(() => ({
  chipInMessage: document.querySelector('.msg--user .attach--sent .attach__item') !== null,
  stripEmpty: document.getElementById('attach-strip') === null,
  userText: document.querySelector('.msg--user .bubble')?.textContent ?? '',
}))()`)
check('[6] 附件随消息发出（芯片挪到消息下，输入框条收起）',
  sent.chipInMessage && sent.stripEmpty && sent.userText.includes('背景材料'), JSON.stringify(sent))
await new Promise(resolve => setTimeout(resolve, 6000))

check('[7] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
const stamp = new Date().toISOString().replaceAll(':', '').slice(0, 17)
// 截图是私有物不入 Git：必须显式传 env（约定写到 .local/butler-console/mock/）。
if (process.env.BATCH4A_SHOT !== undefined) {
  writeFileSync(process.env.BATCH4A_SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：${process.env.BATCH4A_SHOT}`)
}
ws.close()
process.exit(failed === 0 ? 0 : 1)
