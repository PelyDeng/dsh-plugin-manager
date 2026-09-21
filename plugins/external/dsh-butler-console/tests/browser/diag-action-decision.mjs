/**
 * 摘卡失效诊断：真实点击确认按钮，抓 /action POST 的请求/响应与 console 错误，
 * 区分三个假设——streaming 守卫静默 return（POST 根本没发）/ act 流空或报错 / 摘卡匹配失败。
 * 用法：node tests/browser/diag-action-decision.mjs <dsh_auth_session>
 */
const CDP = 'http://127.0.0.1:9223'
const ORIGIN = 'https://dsh.pelycloud.com'
const COOKIE = process.argv[2]
if (COOKIE === undefined) { console.error('用法：node diag-action-decision.mjs <dsh_auth_session>'); process.exit(1) }

const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
const consoleErrors = []
const networkLog = []
ws.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
    consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown')
  }
  if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/action')) {
    networkLog.push({ phase: 'request', url: message.params.request.url, method: message.params.request.method, body: message.params.request.postData })
  }
  if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/action')) {
    networkLog.push({ phase: 'response', url: message.params.response.url, status: message.params.response.status })
  }
  if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
    const id = message.params.requestId
    const item = networkLog.findLast?.(e => e.phase === 'response')
    if (message.method === 'Network.loadingFailed') networkLog.push({ phase: 'failed', errorText: message.params.errorText, id })
  }
})
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${reply.result.exceptionDetails.text}`)
  return reply.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Network.setCookie', { name: 'dsh_auth_session', value: COOKIE, domain: 'dsh.pelycloud.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' })
await send('Page.navigate', { url: `${ORIGIN}/butler` })
for (let i = 0; i < 30; i++) { if (await evaluate("document.readyState === 'complete' && document.getElementById('message-input') !== null") === true) break; await sleep(1500) }
await sleep(2000)

// 发一条会出确认卡的删除任务（用不存在的标题，安全且必出卡——等待确认）
const msg = '请删除标题为《不存在的文章XZ-9901》的博客文章'
await evaluate("document.getElementById('message-input').focus()")
for (const ch of msg) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
}
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('[已发送]', msg)

let appeared = false
for (let i = 0; i < 120; i++) { if (await evaluate("document.querySelector('.action-deck') !== null") === true) { appeared = true; break; } await sleep(5000) }
if (!appeared) { console.log('❌ 8 分钟内 deck 未出现'); process.exit(1) }
await sleep(1500)

const before = await evaluate(`({
  deckText: document.querySelector('.action-deck')?.textContent.replace(/\\s+/g, ' '),
  sendDisabled: document.getElementById('send-btn')?.disabled ?? null,
  noteBefore: document.querySelector('.action-deck__note')?.textContent ?? null,
})`)
console.log('[点击前]', JSON.stringify(before))

// 真实点击「先不办」（cancel 更安全——不触发真实删除）
const btn = await evaluate(`(() => { const b = [...document.querySelectorAll('.action-deck button')].find(b => b.textContent.trim() === '先不办'); if (b === undefined) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
if (btn === null) { console.log('❌ 先不办按钮不存在'); process.exit(1) }
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
console.log('[已点击] 先不办')

for (const wait of [1000, 2000, 3000, 5000]) {
  await sleep(wait === 1000 ? 1000 : wait - (wait === 2000 ? 1000 : wait === 3000 ? 2000 : 3000))
  const after = await evaluate(`({
    deckGone: document.querySelector('.action-deck') === null,
    cardCount: document.querySelectorAll('.action-deck .action-deck__card').length,
    note: document.querySelector('.action-deck__note')?.textContent ?? null,
    sendDisabled: document.getElementById('send-btn')?.disabled ?? null,
  })`)
  console.log(`[点击后 ${wait}ms]`, JSON.stringify(after))
}
console.log('[网络 /action]', JSON.stringify(networkLog, null, 1))
console.log('[console 错误]', consoleErrors.length === 0 ? '无' : JSON.stringify(consoleErrors, null, 1))
process.exit(0)
