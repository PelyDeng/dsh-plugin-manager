/**
 * React 迁移批 0 浏览器验证（Edge headless + CDP 9223 + 原生 WebSocket，零新依赖）。
 *
 * 验证目标（方案 §4 批 0 DoD 的「三链路绿」第三环）：React hello 页在
 * 构建产物 → mock 服务 → 浏览器渲染 的完整链路上成立——
 *   [1] React 挂载成功（#root 内出现 .bt-hello，说明 app.js 执行无 ReferenceError）
 *   [2] __BUTLER_CONFIG__ 注入生效（web.ts / mock 的注入被页面读到）
 *   [3] Tailwind 产物 app.css 生效（手账桌面底色落上）
 *   [4] 手账 token 层生效（纸卡 .paper 的墨线 border-image 与手写体标题）
 *   [5] preflight 冲突修正①：html 上不开灰度抗锯齿（font-smoothing 回 auto）
 *   [6] 页面 console 无错误
 *
 * 用法：node tests/browser/verify-react-batch0.mjs
 *   （需 mock 8790 指向 web-react/ 且 Edge headless 已由外部启动：
 *     msedge --headless=new --remote-debugging-port=9223 --user-data-dir=<tmp>）
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
  if (reply.result?.exceptionDetails !== undefined) throw new Error(`evaluate 失败: ${reply.result.exceptionDetails.text}`)
  return reply.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
// headless 新 tab 默认视口只有 450px 高：给足渲染空间。
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

const nav = await send('Page.navigate', { url: PAGE })
if (nav.error !== undefined || nav.result?.errorText !== undefined) {
  console.error('导航失败：', JSON.stringify(nav))
  process.exit(1)
}
await new Promise(resolve => setTimeout(resolve, 1200))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? '✓' : '✗'}] ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const mounted = await evaluate(`(() => {
  const root = document.getElementById('root')
  return { children: root?.children.length ?? 0, hello: document.querySelector('.bt-hello') !== null, title: document.querySelector('.bt-hello__title')?.textContent ?? '' }
})()`)
check('[1] React 挂载（#root 内 .bt-hello）', mounted.hello === true, `title=${mounted.title}`)

const config = await evaluate(`(() => {
  const conf = globalThis.__BUTLER_CONFIG__
  const text = document.querySelector('.bt-hello__config')?.textContent ?? ''
  return { injected: conf !== undefined && conf.routePrefix === '/butler', shown: text.includes('routePrefix=/butler') }
})()`)
check('[2] __BUTLER_CONFIG__ 注入并被读取', config.injected && config.shown, JSON.stringify(config))

const css = await evaluate(`(() => {
  const bodyBg = getComputedStyle(document.body).backgroundColor
  const paper = document.querySelector('.bt-hello')
  const paperImage = paper !== null ? getComputedStyle(paper).borderImageSource : ''
  return { bodyBg, hasInkFrame: paperImage.includes('svg') }
})()`)
check('[3] Tailwind 产物生效（桌面底色）', css.bodyBg === 'rgb(243, 237, 222)', css.bodyBg)
check('[4] 手账 token 层生效（墨线 border-image + 手写体）', css.hasInkFrame === true)

const fonts = await evaluate(`(() => {
  const title = document.querySelector('.bt-hello__title')
  return { family: title !== null ? getComputedStyle(title).fontFamily : '', loaded: document.fonts.check('34px "Ma Shan Zheng"') }
})()`)
check('[4b] 手写标题字体（Ma Shan Zheng 打头）', fonts.family.includes('Ma Shan Zheng'), `fonts.check=${fonts.loaded}`)

const smoothing = await evaluate('getComputedStyle(document.documentElement).webkitFontSmoothing')
check('[5] preflight 修正①：不开灰度抗锯齿（Windows 手写体锐度）', smoothing === 'auto', smoothing)

// ── 手账化样张（shadcn/base-nova Dialog，产物零修改 + bt-overrides 换皮）────────
const trigger = await evaluate(`(() => {
  const el = document.querySelector('.bt-sample-open')
  if (el === null) return null
  const rect = el.getBoundingClientRect()
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, radius: getComputedStyle(el).borderRadius }
})()`)
check('[7] 样张触发按钮渲染（歪圆角椭圆）', trigger !== null && trigger.radius.includes('/'), JSON.stringify(trigger?.radius))
if (trigger !== null) {
  // 真实鼠标：Input.dispatchMouseEvent（禁 Runtime 模拟点击）。
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: trigger.x, y: trigger.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: trigger.x, y: trigger.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: trigger.x, y: trigger.y, button: 'left', clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 400))

  const dialog = await evaluate(`(() => {
    const popup = document.querySelector('[data-slot="dialog-content"]')
    const title = document.querySelector('[data-slot="dialog-title"]')
    if (popup === null) return { open: false }
    const style = getComputedStyle(popup)
    return {
      open: popup.getAttribute('data-open') !== null || popup !== null,
      inkFrame: style.borderImageSource.includes('svg'),
      hardShadow: style.boxShadow.includes('2px 3px'),
      handTitle: title !== null && getComputedStyle(title).fontFamily.includes('Ma Shan Zheng'),
      text: title?.textContent ?? '',
    }
  })()`)
  check('[8] Dialog 打开且墨线勾边（border-image）', dialog.open === true && dialog.inkFrame === true, dialog.text)
  check('[9] 硬阴影替代柔影（2px 3px 0）', dialog.hardShadow === true, dialog.hardShadow ? '' : String(await evaluate(`getComputedStyle(document.querySelector('[data-slot="dialog-content"]')).boxShadow`)))
  check('[10] 标题手写体（Ma Shan Zheng）', dialog.handTitle === true)
}

check('[6] console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(process.env.BATCH0_SHOT ?? 'batch0-hello.png', Buffer.from(shot.result.data, 'base64'))
console.log(`截图：${process.env.BATCH0_SHOT ?? 'batch0-hello.png'}`)

ws.close()
process.exit(failed === 0 ? 0 : 1)
