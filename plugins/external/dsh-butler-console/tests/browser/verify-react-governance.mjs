/**
 * 批次三治理批浏览器验证（评审 #18/#19/#22/#10步4）：
 * - 设置页显隐单轨（body dataset 已删、React hidden 唯一开关）+ Tab 焦点陷阱 + 齿轮 ref 焦点往返；
 * - 回填单通道 pendingFill：欢迎板撕条（fill）/发送失败回填（restore，CDP 拦截 /chat）/追问芯片（fill）；
 * - 调度卡与消息流渲染回归（bubbleKeys 派生化、applyTurnEvent 拆函数后行为不变）；
 * - topStatus 枚举化后的顶栏显示词（已上线/正在处理/已上线）。
 * 真实键鼠输入 + DOM 断言只读（CDP + 原生 WebSocket，零新依赖）。
 *
 * 用法：node tests/browser/verify-react-governance.mjs（mock 8790→web-react；Edge CDP 9223）
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
  await new Promise(resolve => setTimeout(resolve, 300))
  return true
}
const typeText = async text => {
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
}
const pressKey = async (key, code, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
}
const tab = () => pressKey('Tab', 'Tab', 9)
const shiftTab = () => pressKey('Tab', 'Tab', 9, 1)
const escape = () => pressKey('Escape', 'Escape', 27)
const enter = () => pressKey('Enter', 'Enter', 13)
const selectAll = () => pressKey('a', 'KeyA', 65, 2)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })
// 新 tab 默认窗口 780×580：拉大窗口并前置（交接配方）。
await send('Browser.setWindowBounds', { windowId: (await send('Browser.getWindowForTarget')).result.windowId, bounds: { width: 1400, height: 1000 } })
await send('Page.bringToFront')
const nav = await send('Page.navigate', { url: `${PAGE}?fresh=${Date.now()}` })
if (nav.error !== undefined || nav.result?.errorText !== undefined) { console.error('导航失败'); process.exit(1) }
await sleep(1800)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? '✓' : '✗'}] ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

// ── A. 设置页单轨 + 焦点（评审 #22）──────────────────────────────────────
const a1 = await evaluate(`(() => ({
  bodyDataset: document.body.getAttribute('data-settings'),
  columnsVisible: document.querySelector('.columns')?.offsetParent !== null,
  settings: document.getElementById('settings') !== null,
}))()`)
check('[A1] 初始单轨：无 body dataset、三栏可见、设置未挂载', a1.bodyDataset === null && a1.columnsVisible && !a1.settings, JSON.stringify(a1))

await click(await centerOf('.icon-btn'))
await sleep(450)
const a2 = await evaluate(`(() => ({
  settings: document.getElementById('settings') !== null,
  columnsHidden: document.querySelector('.columns')?.hidden === true,
  columnsInvisible: document.querySelector('.columns')?.offsetParent === null,
  focus: document.activeElement?.id ?? '',
  gearExpanded: document.querySelector('.icon-btn')?.getAttribute('aria-expanded'),
}))()`)
check('[A2] 齿轮开设置：React 挂载+三栏 hidden（同一开关）+焦点落标题', a2.settings && a2.columnsHidden && a2.columnsInvisible && a2.focus === 'settings-title' && a2.gearExpanded === 'true', JSON.stringify(a2))

let trapOk = true
const trapTrace = []
for (let i = 0; i < 5; i += 1) {
  await tab()
  const inside = await evaluate(`document.getElementById('settings')?.contains(document.activeElement) === true`)
  trapTrace.push(inside ? 'in' : 'out')
  if (!inside) trapOk = false
}
for (let i = 0; i < 3; i += 1) {
  await shiftTab()
  const inside = await evaluate(`document.getElementById('settings')?.contains(document.activeElement) === true`)
  trapTrace.push(inside ? 'in' : 'out')
  if (!inside) trapOk = false
}
check('[A3] Tab 焦点陷阱：正反双向 8 次全部圈在设置页内', trapOk, trapTrace.join(','))

await escape()
await sleep(350)
const a4 = await evaluate(`(() => ({
  settings: document.getElementById('settings') !== null,
  columnsVisible: document.querySelector('.columns')?.offsetParent !== null,
  focusIsGear: document.activeElement?.classList.contains('icon-btn') === true,
  gearExpanded: document.querySelector('.icon-btn')?.getAttribute('aria-expanded'),
}))()`)
check('[A4] Escape 关：设置卸载+三栏复现+焦点回齿轮（ref 非 querySelector）', !a4.settings && a4.columnsVisible && a4.focusIsGear && a4.gearExpanded === 'false', JSON.stringify(a4))

await click(await centerOf('.icon-btn'))
await sleep(450)
await click(await centerOf('#settings .settings__head .btn'))
await sleep(350)
const a5 = await evaluate(`(() => ({
  settings: document.getElementById('settings') !== null,
  focusIsGear: document.activeElement?.classList.contains('icon-btn') === true,
}))()`)
check('[A5] 回群聊按钮关：卸载+焦点回齿轮（onClose 通道）', !a5.settings && a5.focusIsGear, JSON.stringify(a5))

// ── B. topStatus 枚举后的显示词（评审 #18）───────────────────────────────
const b1 = await evaluate(`document.querySelector('.topbar__status span:last-child')?.textContent ?? ''`)
check('[B1] 空闲顶栏=已上线（idle 派生词）', b1 === '已上线', b1)

// ── C. 回填单通道 pendingFill（评审 #10 步 4）────────────────────────────
await click(await centerOf('.left__actions .btn--primary'))
await sleep(450)
const c0 = await evaluate(`document.querySelectorAll('.board__tear').length`)
check('[C0] 新建会话出欢迎板（撕条可点）', c0 > 0, `tears=${c0}`)

const tearText = await evaluate(`document.querySelector('.board__tear-text')?.textContent ?? ''`)
await click(await centerOf('.board__tear'))
await sleep(300)
const c1 = await evaluate(`document.getElementById('message-input')?.value ?? ''`)
check('[C1] 撕条点击→输入框填入（fill 直接替换）', c1 === tearText && tearText !== '', `input="${c1.slice(0, 18)}…" tear="${tearText.slice(0, 18)}…"`)

// 失败回填（restore）：拦掉 /chat 让发送失败——草稿应回到输入框，重试行出现。
await send('Network.setBlockedURLs', { urls: ['*chat*'] })
await click(await centerOf('#message-input'))
await selectAll()
await typeText('治理批验证：这句要失败回填')
await enter()
await sleep(1200)
const c2 = await evaluate(`(() => ({
  input: document.getElementById('message-input')?.value ?? '',
  retryLine: document.querySelector('.error-line--retry') !== null,
  retryText: document.querySelector('.error-line--retry')?.textContent ?? '',
}))()`)
check('[C2] 发送失败→草稿回输入框（restore 不覆盖空外场景）+重试行出现', c2.input === '治理批验证：这句要失败回填' && c2.retryLine, JSON.stringify({ input: c2.input, retryLine: c2.retryLine }))
await send('Network.setBlockedURLs', { urls: [] })

// ── D. 协作剧本：调度卡/成员数据面/followups 芯片 + 流转中的顶栏（#18/#19 回归）──
await click(await centerOf('#message-input'))
await selectAll()
await typeText('一起写园区介绍并配图')
await enter()
await sleep(900)
const d1 = await evaluate(`(() => ({
  top: document.querySelector('.topbar__status span:last-child')?.textContent ?? '',
  dcard: document.querySelector('.dcard') !== null,
  userBubble: document.querySelectorAll('.msg--user').length,
}))()`)
check('[D1] 流转中：顶栏=正在处理+调度卡已建（plan 路径）', d1.top === '正在处理' && d1.dcard, JSON.stringify(d1))

let settled = false
for (let i = 0; i < 40; i += 1) {
  settled = await evaluate(`(() => { const list = [...document.querySelectorAll('.summary')]; return (list[list.length - 1]?.dataset.state ?? '') === 'completed' })()`)
  if (settled) break
  await sleep(500)
}
// summary 渲染与 finishTurn（streaming 复位→顶栏回已上线）之间有一拍窗口：等收敛再断言。
await sleep(1200)
const d2 = await evaluate(`(() => ({
  dcard: document.querySelector('.dcard') !== null,
  followChips: document.querySelectorAll('.follow-chip').length,
  top: document.querySelector('.topbar__status span:last-child')?.textContent ?? '',
  states: [...document.querySelectorAll('.dcard__statetext')].map(node => node.textContent),
}))()`)
check('[D2] 收尾：调度卡在场+两成员已完成+顶栏回已上线', settled && d2.dcard && d2.states.length >= 2 && d2.top === '已上线', JSON.stringify(d2))
// followups 样张已删（后端从不发送，评审二选一取删）：mock 仍发该字段，断言被容忍且不渲染。
const d3 = await evaluate(`document.querySelectorAll('.follow-chip').length`)
check('[D3] followups 字段容忍不渲染（样张已删）', d3 === 0, `chips=${d3}`)

// ── E. 请示剧本：ask 卡（waiting_user 兜底走 lastRunTaskId）+回话收卡（#18 回归）──
await click(await centerOf('#message-input'))
await selectAll()
await typeText('请示一个口径问题，该找谁确认')
await enter()
await sleep(4000)
const e1 = await evaluate(`(() => {
  const card = document.querySelector('.ask')
  return { card: card !== null, question: card?.querySelector('.md')?.textContent.slice(0, 10) ?? '' }
})()`)
check('[E1] ask 卡出现（waiting_user→ask.taskId 兜底不空）', e1.card, JSON.stringify(e1))
if (e1.card) {
  await click(await centerOf('.ask__row input'))
  await typeText('用 A 口径直接发')
  await click(await centerOf('.ask__row .btn--primary'))
  await sleep(3500)
  const e2 = await evaluate(`(() => {
    const list = [...document.querySelectorAll('.summary')]
    return { cardGone: document.querySelector('.ask') === null, last: list[list.length - 1]?.dataset.state ?? '', states: [...document.querySelectorAll('.dcard__statetext')].map(node => node.textContent) }
  })()`)
  check('[E2] 回话受理：收卡+调度卡收尾已完成', e2.cardGone && e2.last === 'completed' && e2.states.some(text => text === '已完成'), JSON.stringify(e2))
}

// ── G. 无障碍批（评审 #21）与首屏媒体（缩图后可用性）─────────────────────
const g1 = await evaluate(`(() => {
  // 样式表里五处 :focus-visible 应为 dashed 墨系（不再 solid sky）。
  // var() 参与的 shorthand 在 CSSOM 里 longhand 序列化为空，只能读 cssText 原文。
  const hits = []
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule.cssText !== undefined && rule.cssText.includes(':focus-visible')) hits.push(rule.cssText)
    }
  }
  return { total: hits.length, solidSky: hits.filter(h => h.includes('solid var(--bt-sky)')).length, dashed: hits.filter(h => h.includes('dashed')).length }
})()`)
check('[G1] 焦点环无 solid sky 残留（墨系 dashed）', g1.solidSky === 0 && g1.dashed >= 5 && g1.total >= 5, JSON.stringify(g1))

const g2 = await evaluate(`(() => ({
  inputLabel: document.getElementById('message-input')?.getAttribute('aria-label') ?? '',
  hiddenLabelGone: document.querySelector('label[for="message-input"]') === null,
  urlLabel: document.getElementById('attach-url-input')?.getAttribute('aria-label') ?? '(未开)',
  firstCheck: document.querySelector('.chat-row__check')?.getAttribute('aria-label') ?? '',
}))()`)
check('[G2] 输入口径统一 aria-label+复选框可达名', g2.inputLabel === '说句话' && g2.hiddenLabelGone && g2.firstCheck.startsWith('选择 '), JSON.stringify({ input: g2.inputLabel, hiddenGone: g2.hiddenLabelGone, check: g2.firstCheck }))

const g3 = await evaluate(`(() => ({
  titleLoaded: [...document.querySelectorAll('.brand__title img, .center__title img')].every(img => img.naturalWidth > 0),
  avatarLoaded: [...document.querySelectorAll('.avatar img')].every(img => img.naturalWidth > 0),
  avatarCount: document.querySelectorAll('.avatar img').length,
}))()`)
check('[G3] 缩图后标题图/头像全部可解码加载', g3.titleLoaded && g3.avatarLoaded && g3.avatarCount > 0, JSON.stringify(g3))

check('[F] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

ws.close()
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
process.exit(failed === 0 ? 0 : 1)
