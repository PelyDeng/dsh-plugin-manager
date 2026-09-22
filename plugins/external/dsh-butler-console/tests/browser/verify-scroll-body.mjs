// 验证：产品资产展开正文（body）自身可滚到底（「怎么派活」长内容场景）。
const CDP = 'http://127.0.0.1:9223'
const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result?.result?.value }
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://127.0.0.1:8790/butler' })
await new Promise(r => { setTimeout(r, 1500) })
await evaluate(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.title ?? '').includes('设置'))?.click()`)
await new Promise(r => { setTimeout(r, 300) })
await evaluate(`[...document.querySelectorAll('[role="tab"], .settings__tabs button')].find(b => b.textContent.includes('记忆与要求'))?.click()`)
await new Promise(r => { setTimeout(r, 200) })
await evaluate(`[...document.querySelectorAll('.mem-settings__tabs button')].find(b => b.textContent === '产品资产')?.click()`)
await new Promise(r => { setTimeout(r, 300) })
const result = await evaluate(`(async () => {
  const cards = [...document.querySelectorAll('.mem-procedural__card')]
  const target = cards.find(c => c.textContent.includes('怎么派活'))
  target?.querySelector('button')?.click()
  await new Promise(r => setTimeout(r, 400))
  const body = target?.querySelector('.mem-procedural__body')
  if (body === null) return { error: 'body 不存在' }
  const scrollable = body.scrollHeight > body.clientHeight
  body.scrollTop = body.scrollHeight
  await new Promise(r => setTimeout(r, 100))
  const atBottom = Math.abs(body.scrollTop + body.clientHeight - body.scrollHeight) < 4
  return { scrollable, atBottom, maxHeight: getComputedStyle(body).maxHeight, tail: body.textContent.slice(-30) }
})()`)
console.log(JSON.stringify(result, null, 2))
await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
