/**
 * 反馈③实证：任务记录标题「字体加粗不一致」根因检测。
 *
 * 1) CSS.getPlatformFontsForNode 读每个 .chat-row__title 实际渲染字体与字符分布；
 * 2) 逐字符 document.fonts.check 检测 LXGW 分片覆盖，列出回退字符。
 * 用法：node tests/browser/probe-font-fallback.mjs <dsh_auth_session>
 */
const CDP = 'http://127.0.0.1:9223'
const ORIGIN = 'https://dsh.pelycloud.com'
const COOKIE = process.argv[2]
if (COOKIE === undefined) { console.error('用法：node probe-font-fallback.mjs <dsh_auth_session>'); process.exit(1) }

const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
})
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
await send('CSS.enable')
await send('Network.enable')
await send('Network.setCookie', { name: 'dsh_auth_session', value: COOKIE, domain: 'dsh.pelycloud.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' })
await send('Page.navigate', { url: `${ORIGIN}/butler` })
for (let i = 0; i < 40; i++) {
  const ready = await send('Runtime.evaluate', { expression: "document.readyState === 'complete' && document.querySelector('.chat-row') !== null", returnByValue: true })
  if (ready.result?.result?.value === true) break
  await sleep(1500)
}
await sleep(2000)

console.log('=== 1) 各任务记录标题的实际渲染字体（CDP platformFonts）===')
const docReply = await send('DOM.getDocument')
const doc = docReply.result.root.nodeId
const queryReply = await send('DOM.querySelectorAll', { nodeId: doc, selector: '.chat-row__title' })
const nodeIds = queryReply.result.nodeIds
console.log(`标题行数: ${nodeIds.length}`)
for (const nodeId of nodeIds) {
  const textReply = await send('DOM.getOuterHTML', { nodeId })
  const title = textReply.result.outerHTML.replace(/<[^>]*>/g, '').slice(0, 24)
  const fontReply = await send('CSS.getPlatformFontsForNode', { nodeId })
  const fonts = fontReply.result.fonts.map(f => `${f.familyName}×${f.glyphCount}`).join(', ')
  console.log(`  [${title}] → ${fonts}`)
}

console.log('\n=== 2) 标题字符的 LXGW 分片覆盖检测（fonts.check）===')
const checkReply = await send('Runtime.evaluate', {
  expression: `(() => {
    const titles = [...document.querySelectorAll('.chat-row__title')].map(el => el.textContent)
    const chars = new Set(titles.join('').split(''))
    const missing = []
    for (const ch of chars) {
      if (ch.trim() === '') continue
      const ok = document.fonts.check('600 14.5px "LXGW WenKai"', ch)
      if (!ok) missing.push(ch)
    }
    return { total: chars.size, missingCount: missing.length, missing: missing.join(''), loaded: document.fonts.status }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log(JSON.stringify(checkReply.result?.result?.value, null, 2))
process.exit(0)
