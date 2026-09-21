/**
 * 生产补验（0.13.1）：ActionDeck 待办交互区——用户复核反馈 1/2 的落地验证。
 *
 * 覆盖：
 *   P1 空态：无待办时 .action-deck 不渲染（不打扰）。
 *   P2 confirm 路径：真实发布任务 → deck 出现在输入框上方（几何断言）→ 滚动消息流
 *      deck 位置不动 → 真实鼠标点击确认按钮 → 该项从 deck 消失。
 *   P3 cancel 路径：真实删除任务 → 点「先不办」→ 项消失（任务 cancel 终态）。
 *   P4 清理：再发同一删除任务 → 点确认 → 文章真删（测试数据自清理）。
 *
 * 真实模型每轮数分钟；脚本总时长约 15-30 分钟。
 * 用法：node tests/browser/verify-react-prod-actiondeck.mjs <dsh_auth_session 值>
 */
const CDP = 'http://127.0.0.1:9223'
const ORIGIN = 'https://dsh.pelycloud.com'
const COOKIE = process.argv[2]
const SHOT_DIR = new URL('./screenshots/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
if (COOKIE === undefined) { console.error('用法：node verify-react-prod-actiondeck.mjs <dsh_auth_session>'); process.exit(1) }

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
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (expression, timeoutMs, intervalMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value === true) return true
    await sleep(intervalMs)
  }
  return false
}
const shot = async name => {
  try {
    const reply = await send('Page.captureScreenshot', { format: 'png' })
    if (reply?.data === undefined) { console.log(`  [截图失败] ${name}（target 可能已失效）`); return }
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(SHOT_DIR, { recursive: true })
    writeFileSync(`${SHOT_DIR}${name}.png`, Buffer.from(reply.data, 'base64'))
    console.log(`  [截图] ${SHOT_DIR}${name}.png`)
  } catch (error) {
    console.log(`  [截图失败] ${name}：${error instanceof Error ? error.message : String(error)}`)
  }
}
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail !== '' ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Network.enable')
await send('Network.setCookie', { name: 'dsh_auth_session', value: COOKIE, domain: 'dsh.pelycloud.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' })
await send('Page.navigate', { url: `${ORIGIN}/butler` })
const loaded = await waitFor("document.readyState === 'complete' && document.getElementById('message-input') !== null", 60000, 1500)
check('会话注入且 /butler 加载出输入框', loaded)
if (!loaded) { await shot('prod-ad-0-load-fail'); process.exit(1) }
await sleep(3000)

console.log('\n===== P1 空态：deck 不渲染 =====')
const deckEmpty = await evaluate("document.querySelector('.action-deck') === null")
check('无待办时 .action-deck 不存在', deckEmpty === true)

/** 发一条消息并等待 deck 出现（兼容 ask 型：先「你看着办」放行再等 confirm 型）。 */
const sendAndWaitDeck = async (message, maxWaitMs) => {
  await evaluate("document.getElementById('message-input').focus()")
  await typeText(message)
  await pressEnter()
  const deckSeen = await waitFor("document.querySelector('.action-deck') !== null", maxWaitMs, 5000)
  if (!deckSeen) return false
  // confirm 型判定：deck 内没有输入框（reply 型有 input +「我来说」）
  for (let i = 0; i < 2; i++) {
    const isConfirm = await evaluate("document.querySelector('.action-deck input') === null")
    if (isConfirm === true) return true
    const concede = await evaluate(`(() => { const b = [...document.querySelectorAll('.action-deck button')].find(b => b.textContent.trim() === '你看着办'); if (b === undefined) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (concede === null) return true // 无放行按钮也无输入框，视为 confirm
    await click(concede)
    await waitFor("document.querySelector('.action-deck') !== null", maxWaitMs / 2, 5000)
  }
  return await evaluate("document.querySelector('.action-deck input') === null")
}

console.log('\n===== P2 发布任务 → confirm 路径 =====')
const title = 'React迁移生产补验0131'
const sentP2 = await sendAndWaitDeck(
  `请发布一篇博客文章，标题《${title}》，正文：这是 React 迁移 0.13.1 生产补验自动测试文章，用于验证操作确认卡交互，无需配图。`,
  8 * 60 * 1000,
)
check('deck 出现（发布任务触发确认卡）', sentP2)
if (!sentP2) { await shot('prod-ad-p2-no-deck'); process.exit(1) }
await sleep(1500)

// 几何断言：deck 在输入框上方、在视口内
const geo = await evaluate(`(() => {
  const deck = document.querySelector('.action-deck')
  const input = document.getElementById('message-input')
  if (deck === null || input === null) return null
  const d = deck.getBoundingClientRect()
  const i = input.getBoundingClientRect()
  return { deckTop: d.top, deckBottom: d.bottom, inputTop: i.top, vh: innerHeight, above: d.bottom <= i.top + 6, inView: d.top >= 0 && d.bottom <= innerHeight }
})()`)
check('deck 底边在输入框顶边之上（固定醒目位）', geo !== null && geo.above, JSON.stringify(geo))
check('deck 完整在视口内', geo !== null && geo.inView)

// 滚动消息流：deck 位置不动
const scrollProbe = await evaluate(`(() => {
  const t = document.getElementById('thread')
  const before = document.querySelector('.action-deck').getBoundingClientRect().top
  t.scrollTop = t.scrollHeight
  return new Promise(r => setTimeout(() => r({ before, after: document.querySelector('.action-deck').getBoundingClientRect().top }), 300))
})()`)
check('滚动消息流后 deck 位置不动（不随消息滚）', scrollProbe !== null && Math.abs(scrollProbe.before - scrollProbe.after) < 2, JSON.stringify(scrollProbe))
await shot('prod-ad-p2-deck-visible')

// deck 内容概览
const deckText = await evaluate("document.querySelector('.action-deck').textContent")
console.log('  [deck] ', String(deckText).slice(0, 120))

// 真实点击确认按钮
const beforeCount = await evaluate("document.querySelectorAll('.action-deck .action-deck__card').length")
const confirmBtn = await evaluate(`(() => { const b = document.querySelector('.action-deck .btn--primary'); if (b === null) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.textContent.trim() } })()`)
check('确认按钮存在且可点', confirmBtn !== null, confirmBtn === null ? '' : `label=${confirmBtn.label}`)
if (confirmBtn === null) { await shot('prod-ad-p2-no-btn'); process.exit(1) }
await click({ x: confirmBtn.x, y: confirmBtn.y })
// 受理→摘卡要等回合收尾（waitForTurnIdle 窗口）+POST 受理，轮询最多 15s
let afterCount = -1
for (let i = 0; i < 5; i++) {
  await sleep(3000)
  afterCount = await evaluate("document.querySelectorAll('.action-deck .action-deck__card').length")
  if (afterCount < beforeCount || afterCount === 0) break
}
check('点击确认后该项从 deck 消失', afterCount < beforeCount, `before=${beforeCount} after=${afterCount}`)
await shot('prod-ad-p2-after-confirm')

console.log('\n===== P3 删除任务 → cancel 路径 =====')
const sentP3 = await sendAndWaitDeck(`请删除标题为《${title}》的博客文章。`, 8 * 60 * 1000)
check('deck 出现（删除任务触发确认卡）', sentP3)
if (!sentP3) { await shot('prod-ad-p3-no-deck'); process.exit(1) }
await sleep(1500)
const cancelLabel = await evaluate(`(() => { const b = [...document.querySelectorAll('.action-deck button')].find(b => b.textContent.trim() === '先不办'); if (b === undefined) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
check('「先不办」按钮存在', cancelLabel !== null)
if (cancelLabel !== null) {
  await click(cancelLabel)
  let gone = false
  for (let i = 0; i < 5; i++) {
    await sleep(3000)
    if (await evaluate("document.querySelector('.action-deck') === null") === true) { gone = true; break }
  }
  check('点击先不办后该项从 deck 消失', gone)
}
await shot('prod-ad-p3-after-cancel')

console.log('\n===== P4 清理：同任务 → 确认真删 =====')
const sentP4 = await sendAndWaitDeck(`请删除标题为《${title}》的博客文章。`, 8 * 60 * 1000)
check('deck 再次出现（清理删除任务）', sentP4)
if (sentP4) {
  await sleep(1500)
  const btn = await evaluate(`(() => { const b = document.querySelector('.action-deck .btn--primary'); if (b === null) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  if (btn !== null) {
    await click(btn)
    let gone = false
    for (let i = 0; i < 5; i++) {
      await sleep(3000)
      if (await evaluate("document.querySelector('.action-deck') === null") === true) { gone = true; break }
    }
    check('确认删除后 deck 项消失', gone)
  }
}
await shot('prod-ad-p4-after-cleanup')

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
