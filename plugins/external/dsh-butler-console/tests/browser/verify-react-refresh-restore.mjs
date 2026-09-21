/**
 * 生产验证（0.13.6）：刷新/切会话后确认卡恢复——用户反馈「不能因为页面刷新就无法展示或操作」。
 *
 * 流程：发发布任务 → 确认卡出现（不点）→ 刷新页面 → 断言①待办区（deck）确认卡恢复
 * → 断言②消息流内恢复的子任务卡带确认按钮 → 点击确认 → 卡摘除 → 收尾。
 * 用法：node tests/browser/verify-react-refresh-restore.mjs <dsh_auth_session>
 */
const CDP = 'http://127.0.0.1:9223'
const ORIGIN = 'https://dsh.pelycloud.com'
const COOKIE = process.argv[2]
if (COOKIE === undefined) { console.error('用法：node verify-react-refresh-restore.mjs <dsh_auth_session>'); process.exit(1) }

const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) throw new Error(`evaluate: ${reply.result.exceptionDetails.text}`)
  return reply.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const done = code => { void fetch(`${CDP}/json/close/${target.id}`).catch(() => {}).then(() => process.exit(code)) }

async function boot() {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Page.bringToFront', {})
  const win = await send('Browser.getWindowForTarget', { targetId: target.id })
  await send('Browser.setWindowBounds', { windowId: win.result?.windowId, bounds: { width: 1400, height: 1000, windowState: 'normal' } })
  await send('Network.setCookie', { name: 'dsh_auth_session', value: COOKIE, domain: 'dsh.pelycloud.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' })
  await send('Page.navigate', { url: `${ORIGIN}/butler` })
  for (let i = 0; i < 40; i++) { if (await evaluate("document.readyState === 'complete' && document.getElementById('message-input') !== null") === true) return true; await sleep(1500) }
  return false
}

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => { console.log(`  ${ok ? '✅' : '❌'} ${label}${detail !== '' ? ` — ${detail}` : ''}`); ok ? pass++ : fail++ }

if (await boot() !== true) { console.log('❌ 页面加载失败'); done(1) } else {
  await sleep(2000)
  console.log('===== 1. 发发布任务，等确认卡出现 =====')
  const title = `刷新恢复验证${Date.now() % 100000}`
  await evaluate("document.getElementById('message-input').focus()")
  const msg = `请发布一篇博客文章，标题《${title}》，正文：刷新恢复验证文章，无需配图。`
  for (const ch of msg) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  let appeared = false
  for (let i = 0; i < 120; i++) { if (await evaluate("document.querySelector('.action-deck') !== null") === true) { appeared = true; break; } await sleep(5000) }
  check('确认卡出现（在线态）', appeared)
  if (!appeared) { done(1) } else {
    await sleep(1500)
    console.log('===== 2. 刷新页面（关键场景） =====')
    await send('Page.reload', { ignoreCache: true })
    for (let i = 0; i < 40; i++) { if (await evaluate("document.readyState === 'complete' && document.getElementById('message-input') !== null") === true) break; await sleep(1500) }
    await sleep(4000) // 等 transcript+任务详情两路回包渲染完

    const after = await evaluate(`(() => {
      const deck = document.querySelector('.action-deck')
      const inlineConfirm = document.querySelector('#thread .act .btn--primary')
      const subtaskCards = document.querySelectorAll('#thread .subtask__goal').length
      const lastMsg = [...document.querySelectorAll('#thread .msg')].pop()
      return {
        deckBack: deck !== null,
        deckText: deck ? deck.textContent.replace(/\\s+/g, ' ').slice(0, 160) : null,
        deckConfirm: deck !== null && deck.querySelector('.btn--primary') !== null,
        inlineConfirmBack: inlineConfirm !== null,
        subtaskCards,
        msgCount: document.querySelectorAll('#thread .msg').length,
      }
    })()`)
    console.log('[刷新后]', JSON.stringify(after))
    check('刷新后待办区确认卡恢复', after.deckBack === true && after.deckConfirm === true, after.deckText ?? '')
    check('刷新后消息流内有恢复的子任务卡', after.subtaskCards > 0 || after.inlineConfirmBack === true, `goal 行 ${after.subtaskCards}`)
    check('消息流内确认按钮可点（就地操作）', after.inlineConfirmBack === true)

    console.log('===== 3. 点击消息流内恢复的确认按钮 =====')
    let clicked = false
    if (after.inlineConfirmBack === true) {
      const pt = await evaluate(`(() => { const b = document.querySelector('#thread .act .btn--primary'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      clicked = true
    } else if (after.deckConfirm === true) {
      const pt = await evaluate(`(() => { const b = document.querySelector('.action-deck .btn--primary'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      clicked = true
    }
    check('已发出确认点击', clicked)
    await sleep(4000)
    const afterClick = await evaluate(`({
      deckGone: document.querySelector('.action-deck') === null,
      inlineGone: document.querySelector('#thread .act') === null,
    })`)
    check('确认后卡摘除', afterClick.deckGone === true || afterClick.inlineGone === true, JSON.stringify(afterClick))

    console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
    done(fail === 0 ? 0 : 1)
  }
}
