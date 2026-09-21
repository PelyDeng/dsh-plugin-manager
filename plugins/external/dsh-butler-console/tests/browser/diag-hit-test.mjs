/**
 * ActionDeck 按钮「点击无效」hit-test 诊断：按钮 rect + document.elementFromPoint 命中链 +
 * 遮挡元素 computedStyle + 真实鼠标注入点击验证。
 *
 * 安全约束：真实点击只落在「先不办」cancel 按钮；「确认」按钮只做只读 hit-test 分析。
 * 改点遮挡元素前二次校验命中元素，若疑似「确认」按钮则跳过点击、只交诊断数据。
 * 不做 Emulation 视口模拟（坐标错位坑），改用 Browser.setWindowBounds 把窗口调到 1400×1000。
 * 用法：node tests/browser/diag-hit-test.mjs <dsh_auth_session>
 */
const CDP = 'http://127.0.0.1:9223'
const ORIGIN = 'https://dsh.pelycloud.com'
const COOKIE = process.argv[2]
if (COOKIE === undefined) { console.error('用法：node diag-hit-test.mjs <dsh_auth_session>'); process.exit(1) }

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
    consoleErrors.push(message.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'unknown').slice(0, 300))
  }
  if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('/action')) {
    networkLog.push({ phase: 'request', url: message.params.request.url, method: message.params.request.method, body: (message.params.request.postData || '').slice(0, 200) })
  }
  if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/action')) {
    networkLog.push({ phase: 'response', status: message.params.response.status })
  }
})
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) {
    throw new Error('evaluate: ' + reply.result.exceptionDetails.text + ' ' + String(reply.result.exceptionDetails.exception?.description ?? '').slice(0, 300))
  }
  return reply.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const done = code => { void fetch(`${CDP}/json/close/${target.id}`).catch(() => {}).then(() => { console.log('[tab 已关闭] ' + target.id); process.exit(code) }) }

async function main() {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Browser.enable')

  // 1. 前置 tab + 窗口 1400×1000（新 tab 默认 780×580，窗口小于视口会让鼠标坐标错位）
  await send('Page.bringToFront', {})
  const win = await send('Browser.getWindowForTarget', { targetId: target.id })
  const windowId = win.result.windowId
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await send('Browser.setWindowBounds', { windowId, bounds: { width: 1400, height: 1000 } })

  await send('Network.setCookie', { name: 'dsh_auth_session', value: COOKIE, domain: 'dsh.pelycloud.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' })
  await send('Page.navigate', { url: `${ORIGIN}/butler` })
  let ready = false
  for (let i = 0; i < 30; i++) { if (await evaluate("document.readyState === 'complete' && document.getElementById('message-input') !== null") === true) { ready = true; break } await sleep(1500) }
  if (!ready) { console.log('❌ /butler 页面加载失败（无 #message-input）'); done(1); return }
  await sleep(2000)
  console.log('[页面就绪] 视口:', await evaluate("JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })"))

  // 2. 全局捕获阶段 click 监听（记录 clientX/Y、target、isTrusted 到 window.__c）
  const installed = await evaluate(`(() => {
    window.__c = []
    document.addEventListener('click', e => {
      const t = e.target
      const el = t instanceof Element ? t : null
      window.__c.push({
        x: e.clientX, y: e.clientY, isTrusted: e.isTrusted,
        tag: el ? el.tagName : String(t),
        cls: el && typeof el.className === 'string' ? el.className : '',
        id: el ? (el.id || '') : '',
        text: el ? (el.textContent || '').trim().slice(0, 40) : '',
      })
    }, true)
    return 'listener-installed'
  })()`)
  console.log('[全局 click 监听]', installed)

  // 3. 真实键盘发送触发确认卡的消息（生产有同名测试草稿）
  const msg = '请删除标题为《React迁移生产补验0131》的已公开博客文章。'
  await evaluate("document.getElementById('message-input').focus()")
  for (const ch of msg) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  console.log('[已发送]', msg)

  // 4. 每 5 秒轮询 .action-deck，最长 10 分钟
  const t0 = Date.now()
  let appeared = false
  for (let i = 0; i < 120; i++) {
    if (await evaluate("document.querySelector('.action-deck') !== null") === true) { appeared = true; break }
    await sleep(5000)
  }
  if (!appeared) {
    console.log('❌ 10 分钟内 .action-deck 未出现')
    console.log('[console 错误]', consoleErrors.length ? JSON.stringify(consoleErrors.slice(-5)) : '无')
    done(1); return
  }
  console.log('[出卡耗时]', Math.round((Date.now() - t0) / 1000) + 's')
  await sleep(1500)

  // 5a/5b. 全按钮 rect + elementFromPoint 命中链 + 遮挡元素 computedStyle
  const probe = await evaluate(`(() => {
    const describe = el => {
      const attrs = {}
      for (const a of el.attributes) attrs[a.name] = a.value
      return { tag: el.tagName, id: el.id || null, cls: typeof el.className === 'string' ? el.className : '', attrs, text: (el.textContent || '').trim().slice(0, 60) }
    }
    const inVp = (x, y) => x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
    return {
      vp: { w: innerWidth, h: innerHeight },
      deckCount: document.querySelectorAll('.action-deck').length,
      decks: [...document.querySelectorAll('.action-deck')].map(deck => ({
        rect: (() => { const r = deck.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })(),
        text: (deck.textContent || '').replace(/\\s+/g, ' ').slice(0, 160),
        buttons: [...deck.querySelectorAll('button')].map(b => {
          const r = b.getBoundingClientRect()
          const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
          const hit = inVp(cx, cy) ? document.elementFromPoint(cx, cy) : null
          // 命中元素向上到 .action-deck 的祖先链
          const chain = []
          let cur = hit
          while (cur && cur !== deck) { chain.push(describe(cur)); cur = cur.parentElement }
          if (cur === deck) chain.push(describe(deck))
          const hitInside = hit !== null && (hit === b || b.contains(hit))
          // 命中不是按钮/按钮内元素 → 输出遮挡元素及关键 computedStyle
          let occluder = null
          if (!hitInside && hit) {
            const cs = getComputedStyle(hit)
            const up = []
            let p = hit.parentElement
            while (p && p !== document.body) { const d = describe(p); up.push(d.tag + (d.cls ? '.' + d.cls.split(/\\s+/).join('.') : '')); p = p.parentElement }
            occluder = {
              describe: describe(hit),
              styles: { position: cs.position, zIndex: cs.zIndex, pointerEvents: cs.pointerEvents, transform: cs.transform, opacity: cs.opacity, visibility: cs.visibility, display: cs.display, overflow: cs.overflow },
              ancestors: up.slice(0, 6),
            }
          }
          return {
            label: (b.textContent || '').trim().slice(0, 20),
            cls: typeof b.className === 'string' ? b.className : '',
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            center: { x: cx, y: cy }, inViewport: inVp(cx, cy),
            hitElement: hit ? describe(hit) : null,
            hitInsideButton: hitInside,
            chain, occluder,
          }
        }),
      })),
    }
  })()`)
  console.log('\n=== elementFromPoint hit-test 分析 ===')
  console.log(JSON.stringify(probe, null, 1))

  // 安全约束：真实点击只落在 cancel 类按钮（文案含「先不/取消」或非 primary）；primary（删除/确认）不做真实点击
  let cancelBtn = null
  for (const d of probe.decks) {
    for (const b of d.buttons) {
      const safe = b.label.includes('先不') || b.label.includes('取消') || !b.cls.includes('btn--primary')
      if (safe && b.inViewport) { cancelBtn = b; break }
    }
    if (cancelBtn) break
  }
  if (!cancelBtn) { console.log('❌ 未找到安全 cancel 按钮，只交诊断数据'); done(1); return }

  const mouseClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(80)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const readState = () => evaluate(`({ deckGone: document.querySelector('.action-deck') === null, cardCount: document.querySelectorAll('.action-deck .action-deck__card').length, note: (document.querySelector('.action-deck__note') || {}).textContent ?? null })`)

  // 5c. 真实鼠标点击「先不办」中心；等 3 秒读 __c 与卡片数量
  console.log(`\n--- 真实鼠标点击「${cancelBtn.label}」中心 (${cancelBtn.center.x}, ${cancelBtn.center.y}) ---`)
  await mouseClick(cancelBtn.center.x, cancelBtn.center.y)
  await sleep(3000)
  const state1 = await readState()
  console.log('[点击后 3s 状态]', JSON.stringify(state1))
  console.log('[__c 全局监听记录]', JSON.stringify(await evaluate('window.__c')))
  let effective = state1.deckGone || state1.cardCount === 0

  // 5d-分支1. 点击无效且 elementFromPoint 显示被遮挡 → 改点命中顶层元素中心
  if (!effective && cancelBtn.occluder) {
    console.log('\n--- 第一次点击无效且被遮挡：改点命中顶层元素中心 ---')
    const retarget = await evaluate(`(() => {
      const deck = document.querySelector('.action-deck')
      if (!deck) return null
      const b = [...deck.querySelectorAll('button')].find(x => (x.textContent || '').trim().includes('先不办'))
      if (!b) return null
      const r = b.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
      const hit = document.elementFromPoint(cx, cy)
      if (!hit) return null
      const hr = hit.getBoundingClientRect()
      return {
        x: Math.round(hr.left + hr.width / 2), y: Math.round(hr.top + hr.height / 2),
        tag: hit.tagName, cls: typeof hit.className === 'string' ? hit.className : '',
        text: (hit.textContent || '').trim().slice(0, 40),
        isButton: hit.tagName === 'BUTTON',
      }
    })()`)
    if (!retarget) { console.log('[改点目标不可得，只交诊断数据]') }
    else if (retarget.isButton && /确认|删除/.test(retarget.text)) {
      console.log('⚠️ 命中顶层元素是含「确认/删除」的按钮（', JSON.stringify(retarget), '），为避免真的删除文章不点击，只交诊断数据')
    } else {
      console.log('[改点目标]', JSON.stringify(retarget))
      await mouseClick(retarget.x, retarget.y)
      await sleep(3000)
      const state2 = await readState()
      console.log('[改点后 3s 状态]', JSON.stringify(state2))
      console.log('[__c 全局监听记录]', JSON.stringify(await evaluate('window.__c')))
      effective = state2.deckGone || state2.cardCount === 0
    }
  }

  // 5d-分支2. 点击无效且无遮挡（elementFromPoint 命中按钮自身）→ 事件层诊断：
  // __c 是否记录到 isTrusted click 且 target 为该按钮；React props 是否挂 onClick。
  if (!effective && !cancelBtn.occluder) {
    console.log('\n--- 点击无效且无遮挡：事件层诊断（click 是否到达 / React handler 是否绑定） ---')
    const reactDiag = await evaluate(`(() => {
      const deck = document.querySelector('.action-deck')
      if (!deck) return { deckGone: true }
      const b = [...deck.querySelectorAll('button')].find(x => {
        const t = (x.textContent || '').trim()
        return (t.includes('先不') || t.includes('取消')) || !x.className.includes('btn--primary')
      })
      if (!b) return { buttonGone: true }
      const propsKey = Object.keys(b).find(k => k.startsWith('__reactProps$'))
      const fiberKey = Object.keys(b).find(k => k.startsWith('__reactFiber$'))
      const props = propsKey ? b[propsKey] : null
      return {
        label: (b.textContent || '').trim().slice(0, 20),
        hasReactProps: propsKey !== undefined, hasReactFiber: fiberKey !== undefined,
        propKeys: props ? Object.keys(props) : null,
        hasOnClick: !!(props && typeof props.onClick === 'function'),
        hasOnPointerDown: !!(props && typeof props.onPointerDown === 'function'),
        disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'),
      }
    })()`)
    console.log('[React 事件绑定]', JSON.stringify(reactDiag, null, 1))
    const clicks = await evaluate('window.__c')
    const hitClicks = (clicks || []).filter(c => c.isTrusted === true)
    console.log('[__c 中 isTrusted click 数]', hitClicks.length, '明细:', JSON.stringify(hitClicks))
  }

  // 6. 汇总
  console.log('\n=== 结论 ===')
  console.log('「先不办」鼠标点击是否生效（卡片消失）:', effective)
  console.log('[网络 /action 记录]', networkLog.length ? JSON.stringify(networkLog, null, 1) : '无')
  console.log('[console 错误]', consoleErrors.length === 0 ? '无' : JSON.stringify(consoleErrors.slice(-5)))
  done(effective ? 0 : 1)
}

await main()
