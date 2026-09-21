/**
 * 点击链路分流诊断：同一次出卡上先 JS click 再（可选）真实鼠标点击，抓 /action POST。
 * 不做视口模拟（Emulation.setDeviceMetricsOverride 可能造成鼠标注入坐标错位）。
 * 任务用「删除不存在的文章」——出确认卡且 cancel 安全。
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
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 300))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown').slice(0, 300))
  }
  if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/action')) {
    networkLog.push({ phase: 'request', url: message.params.request.url, method: message.params.request.method, body: message.params.request.postData })
  }
  if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/action')) {
    networkLog.push({ phase: 'response', status: message.params.response.status })
  }
})
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${reply.result.exceptionDetails.text}`)
  return reply.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const done = code => { void fetch(`${CDP}/json/close/${target.id}`).catch(() => {}).then(() => process.exit(code)) }

async function main() {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Page.bringToFront', {})
  await send('Network.setCookie', { name: 'dsh_auth_session', value: COOKIE, domain: 'dsh.pelycloud.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' })
  await send('Page.navigate', { url: `${ORIGIN}/butler` })
  for (let i = 0; i < 30; i++) { if (await evaluate("document.readyState === 'complete' && document.getElementById('message-input') !== null") === true) break; await sleep(1500) }
  await sleep(2000)

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
  if (!appeared) { console.log('❌ 10 分钟内 deck 未出现'); done(1); return }
  await sleep(1500)

  const probe = await evaluate(`(() => {
    const deck = document.querySelector('.action-deck')
    const btn = [...deck.querySelectorAll('button')].find(b => b.textContent.trim() === '先不办')
    return { deckText: deck.textContent.replace(/\\s+/g, ' ').slice(0, 120), cancelExists: btn !== undefined }
  })()`)
  console.log('[出卡]', JSON.stringify(probe))
  if (!probe.cancelExists) { console.log('❌ 先不办按钮不存在'); done(1); return }

  console.log('\n--- 分流 A：JS 原生 click()（绕过鼠标注入命中） ---')
  await evaluate(`(() => { const btn = [...document.querySelectorAll('.action-deck button')].find(b => b.textContent.trim() === '先不办'); btn.click(); return 'clicked' })()`)
  for (let i = 0; i < 6; i++) {
    await sleep(2500)
    const state = await evaluate(`({
      deckGone: document.querySelector('.action-deck') === null,
      cardCount: document.querySelectorAll('.action-deck .action-deck__card').length,
      note: document.querySelector('.action-deck__note')?.textContent ?? null,
    })`)
    console.log(`[JS click 后 ${(i + 1) * 2.5}s]`, JSON.stringify(state))
    if (state.deckGone || state.cardCount === 0) break
  }
  console.log('[网络 /action 记录]', JSON.stringify(networkLog, null, 1))
  console.log('[console 错误]', consoleErrors.length === 0 ? '无' : JSON.stringify(consoleErrors.slice(-5)))
  done(0)
}

await main()
