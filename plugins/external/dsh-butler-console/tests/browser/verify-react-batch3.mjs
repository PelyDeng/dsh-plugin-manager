/**
 * React 迁移批 3 浏览器验证：基础发送链路三轮 mock 对话全绿 + 停止 + ask 回话。
 * 真实键盘输入 + Enter 提交，DOM 断言只读（CDP + 原生 WebSocket，零新依赖）。
 *
 * 剧本（mock chatScript 关键词路由）：[A] 查询 / [B] 出图（默认）/ [C] 请示（waiting_user
 * → ask 卡回话 → 收尾）/ [D] 停止（流式期间喊停，mock accepted）。
 *
 * 用法：node tests/browser/verify-react-batch3.mjs（mock 8790→web-react；Edge CDP 9223）
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
const sendAndEnter = async text => {
  await click(await centerOf('#message-input'))
  await typeText(text)
  await pressEnter()
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

// [A] 查询对话：发送 → user 气泡受理回放（不重复）→ 流式成形 → summary。
await sendAndEnter('查一下园区最近的通行情况')
await new Promise(resolve => setTimeout(resolve, 400))
const accepted = await evaluate(`(() => ({
  users: document.querySelectorAll('.msg--user .bubble').length,
  butlers: document.querySelectorAll('.msg--butler').length,
  stopVisible: document.getElementById('stop-button') !== null && document.getElementById('stop-button')?.hidden === false,
}))()`)
check('[A1] 发送受理（user 气泡×1 + 停止显形）', accepted.users === 1 && accepted.butlers >= 1 && accepted.stopVisible, JSON.stringify(accepted))
await new Promise(resolve => setTimeout(resolve, 2500))
const flowing = await evaluate(`(() => {
  const bodies = [...document.querySelectorAll('.msg--butler .bubble .md')]
  return { mdCount: bodies.length, total: bodies.reduce((sum, node) => sum + node.textContent.length, 0) }
})()`)
check('[A2] 流式正文实时成形（richText 受控类）', flowing.mdCount >= 1 && flowing.total > 10, JSON.stringify(flowing))
await new Promise(resolve => setTimeout(resolve, 2500))
const settledA = await evaluate(`(() => ({
  summary: document.querySelector('.summary[data-state="completed"]') !== null,
  caretHidden: [...document.querySelectorAll('.caret')].every(node => node.hidden),
}))()`)
check('[A3] 查询对话收尾（summary+光标收起）', settledA.summary && settledA.caretHidden, JSON.stringify(settledA))

// [D] 停止：出图剧本流式期间喊停（mock accepted，终态以事件为准）。
await sendAndEnter('帮我生成一张园区宣传图')
await new Promise(resolve => setTimeout(resolve, 600))
const stopPoint = await centerOf('#stop-button')
const stopClicked = await click(stopPoint)
await new Promise(resolve => setTimeout(resolve, 500))
const stopState = await evaluate(`(() => ({
  topStatus: document.querySelector('.topbar__status span:last-child')?.textContent ?? '',
}))()`)
check('[D] 流式期间喊停（accepted 后回「已上线」或保持处理态，无崩溃）', stopClicked && consoleErrors.length === 0, JSON.stringify(stopState))
await new Promise(resolve => setTimeout(resolve, 6000))

// [C] 请示对话：waiting_user → ask 卡 → 回话 → 收卡收尾。
await sendAndEnter('请示一个口径问题，该找谁确认')
await new Promise(resolve => setTimeout(resolve, 3500))
const askShown = await evaluate(`(() => {
  const card = document.querySelector('.ask')
  return {
    card: card !== null,
    question: card?.querySelector('.md')?.textContent.slice(0, 16) ?? '',
    row: card?.querySelector('.ask__row') !== null,
  }
})()`)
check('[C1] ask 卡出现（waiting_user）', askShown.card && askShown.row, JSON.stringify(askShown))
if (askShown.card) {
  await click(await centerOf('.ask__row input'))
  await typeText('用 A 口径直接发')
  await click(await centerOf('.ask__row .btn--primary'))
  await new Promise(resolve => setTimeout(resolve, 3000))
  const afterReply = await evaluate(`(() => ({
    cardGone: document.querySelector('.ask') === null,
    succeeded: [...document.querySelectorAll('.dcard__statetext')].some(node => node.textContent === '已完成'),
    lastSummary: [...document.querySelectorAll('.summary')].pop()?.dataset.state ?? '',
  }))()`)
  // 会话是多回合连续的：只认「最后一个」汇总的状态（旧回合的 completed 一直在页面上）。
  check('[C2] 回话受理（收卡+收尾）', afterReply.cardGone && afterReply.succeeded && afterReply.lastSummary === 'completed', JSON.stringify(afterReply))
}

// [E] 幂等粗检：整页 user 气泡数与发送次数一致（StrictMode 双调用不重复渲染）。
const users = await evaluate(`document.querySelectorAll('.msg--user').length`)
check('[E] 三个回合 user 气泡各一次（幂等）', users === 3, `users=${users}`)
check('[F] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
const stamp = new Date().toISOString().replaceAll(':', '').slice(0, 17)
// 截图是私有物不入 Git：必须显式传 env（约定写到 .local/butler-console/mock/）。
if (process.env.BATCH3_SHOT !== undefined) {
  writeFileSync(process.env.BATCH3_SHOT, Buffer.from(shot.result.data, 'base64'))
  console.log(`截图：${process.env.BATCH3_SHOT}`)
}
ws.close()
process.exit(failed === 0 ? 0 : 1)
