/**
 * React 迁移批 1 浏览器验证（Edge headless + CDP 9223 + 原生 WebSocket，零新依赖）。
 *
 * 批 1 DoD 的浏览器面：空会话页三栏骨架 + 打开会话看到历史消息（richText 渲染）。
 *   [1] 三栏骨架挂载（topbar/columns/左右栏/中栏）
 *   [2] 左栏任务记录列表（mock 假数据行）与右栏成员/运行状态/失败记录基础渲染
 *   [3] 空会话欢迎板（board + 六撕条）
 *   [4] 真实点击会话行 → 历史消息渲染（user/butler 气泡 + 任务摘要卡）
 *   [5] richText 飞地生效（气泡正文落 .md 受控类；流式分级判断不在此验证）
 *   [6] __BUTLER_CONFIG__ 注入 + 手写体 + antialiased 修正（批 0 断言回归）
 *   [7] console 无错误
 *
 * 用法：node tests/browser/verify-react-batch1.mjs
 *   （mock 8790 指向 web-react/；Edge headless CDP 9223 已由外部启动）
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
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown exception')
  }
})
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) throw new Error(`evaluate 失败: ${reply.result.exceptionDetails.text} ${JSON.stringify(reply.result.exceptionDetails)}`)
  return reply.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
const nav = await send('Page.navigate', { url: PAGE })
if (nav.error !== undefined || nav.result?.errorText !== undefined) {
  console.error('导航失败：', JSON.stringify(nav))
  process.exit(1)
}
await new Promise(resolve => setTimeout(resolve, 1500))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? '✓' : '✗'}] ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const shell = await evaluate(`(() => ({
  topbar: document.querySelector('.topbar') !== null,
  columns: document.querySelector('.columns.desk') !== null,
  left: document.getElementById('left-panel') !== null,
  right: document.getElementById('drawer') !== null,
  center: document.querySelector('.column--center') !== null,
  thread: document.getElementById('thread') !== null,
  reactMounted: document.getElementById('root')?.children.length > 0,
}))()`)
check('[1] 三栏骨架挂载', shell.reactMounted && shell.topbar && shell.columns && shell.left && shell.right && shell.center && shell.thread, JSON.stringify(shell))

const panels = await evaluate(`(() => ({
  chatRows: document.querySelectorAll('#chat-list .chat-row').length,
  members: document.querySelectorAll('#member-list .member').length,
  metrics: document.querySelectorAll('#metrics .metric').length,
  failures: document.querySelectorAll('.failure-row').length,
}))()`)
check('[2] 左右栏基础渲染（列表/成员/状态/失败）', panels.chatRows > 0 && panels.members > 0 && panels.metrics === 6 && panels.failures > 0, JSON.stringify(panels))

const welcome = await evaluate(`(() => ({
  board: document.querySelector('.welcome--board .board') !== null,
  tears: document.querySelectorAll('.board__tear').length,
}))()`)
check('[3] 空会话欢迎板（六撕条）', welcome.board && welcome.tears === 6, `tears=${welcome.tears}`)

// 真实鼠标点击第一行任务记录 → 打开历史会话。
const row = await evaluate(`(() => {
  const el = document.querySelector('#chat-list .chat-row')
  if (el === null) return null
  const rect = el.getBoundingClientRect()
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
})()`)
check('[4] 任务记录行可点', row !== null)
if (row !== null) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'left', clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 1200))

  const history = await evaluate(`(() => {
    const inner = document.querySelector('.thread__inner')
    const msgs = inner?.querySelectorAll('.msg') ?? []
    const firstUser = inner?.querySelector('.msg--user .bubble')?.textContent ?? ''
    const butlerMd = inner?.querySelector('.msg--butler .bubble .md') !== null
    const taskCards = inner?.querySelectorAll('.task-card').length ?? 0
    const current = document.querySelector('#chat-list .chat-row[aria-current="true"]') !== null
    return { count: msgs.length, firstUser: firstUser.slice(0, 24), butlerMd, taskCards, current }
  })()`)
  check('[4b] 历史消息渲染（气泡+任务卡+当前态）', history.count > 0 && history.taskCards > 0 && history.current, JSON.stringify(history))
  check('[5] richText 飞地生效（butler 正文落 .md 受控类）', history.butlerMd === true)
}

const regress = await evaluate(`(() => ({
  config: globalThis.__BUTLER_CONFIG__?.routePrefix === '/butler',
  hand: document.fonts.check('34px "Ma Shan Zheng"'),
  smoothing: getComputedStyle(document.documentElement).webkitFontSmoothing,
}))()`)
check('[6] 批 0 断言回归（config 注入/手写体/antialiased=auto）', regress.config && regress.hand && regress.smoothing === 'auto', JSON.stringify(regress))
check('[7] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(process.env.BATCH1_SHOT ?? 'batch1-history.png', Buffer.from(shot.result.data, 'base64'))
console.log(`截图：${process.env.BATCH1_SHOT ?? 'batch1-history.png'}`)

ws.close()
process.exit(failed === 0 ? 0 : 1)
