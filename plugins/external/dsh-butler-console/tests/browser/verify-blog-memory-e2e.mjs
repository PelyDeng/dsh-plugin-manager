/**
 * blog 记忆接入 E2E（P1.5-3 验收）：token 登录生产 → blog 会话发消息（让 blog 记住域名）
 * → 等模型回合 → 生产库 + 管家治理 API 双向核验 → 清理验证数据。
 * 用法：TOKEN=<生产token> node tests/browser/verify-blog-memory-e2e.mjs（需 Edge CDP 9223）。
 */
const CDP = 'http://127.0.0.1:9223'
const TOKEN = process.env.TOKEN
const HOST = 'https://dsh.pelycloud.com'
const BLOG_PAGE = `${HOST}/?token=${TOKEN}`

const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails !== undefined) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}
const sleep = ms => new Promise(r => { setTimeout(r, ms) })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: BLOG_PAGE })
await sleep(3500)
// 登录确认页：点授权按钮（如有）。
await evaluate(`(() => { const btn = [...document.querySelectorAll('button, a')].find(b => /登录|继续|确认|打开/.test(b.textContent)); btn?.click(); return btn?.textContent.trim() ?? 'none' })()`)
await sleep(3500)
// 跳 blog 页面入口。
await send('Page.navigate', { url: `${HOST}/blog` })
await sleep(4000)
const mounted = await evaluate(`(() => ({ path: location.pathname, inputs: [...document.querySelectorAll('textarea, [contenteditable="true"]')].length, body: document.body.textContent.slice(0, 60) }))()`)
console.log('blog 页面:', JSON.stringify(mounted))

// 在输入框输入并发送（Enter 或发送按钮）。
const sent = await evaluate(`(async () => {
  const input = document.querySelector('textarea, [contenteditable="true"]')
  if (input === null) return 'no-input'
  const text = '请记住一件事：我的博客正式域名是 https://dpl.example.com ，以后提到博客地址就用这个。另外回复一句「已记住」即可。'
  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    input.focus()
    document.execCommand('insertText', false, text)
  }
  await new Promise(r => setTimeout(r, 200))
  const sendBtn = [...document.querySelectorAll('button')].find(b => /发送|→/.test(b.textContent + (b.title ?? '') + (b.getAttribute('aria-label') ?? '')))
  if (sendBtn !== undefined) { sendBtn.click(); return 'send-btn' }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return 'enter'
})()`)
console.log('发送方式:', sent)
await sleep(30000) // 模型回合。

// 管家 API 双向核验（同浏览器会话，admin actor）。
await send('Page.navigate', { url: `${HOST}/butler/identity` })
await sleep(2000)
const verify = await evaluate(`(async () => {
  const r = await fetch('/butler/memories?agentId=blog', { headers: { origin: location.origin } })
  const body = await r.json()
  return { status: r.status, items: (body.items ?? []).map(i => i.shortId + ' ' + i.content.slice(0, 30)) }
})()`)
console.log('管家治理可见 blog 记忆:', JSON.stringify(verify))
await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
