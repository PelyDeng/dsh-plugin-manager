/**
 * 批 0 hello 页浏览器真实验证（Edge CDP 9223 + 原生 WebSocket，照 butler mock 的
 * browser-verify.mjs 形态；方案 §5 批 0 DoD：三链路的浏览器段 + 字体实际渲染核对）。
 *
 * 断言面：React 挂载、Icon SVG 在场、RichText 受控渲染、overrides 焦点环、
 * document.fonts 核对 LXGW WenKai **实际加载**（非回退栈）、console 零错误；
 * closedoff 另核 CLOSEDOFF_CONFIG 注入与 textures 材质（paper/胶带）。
 * 截图存 .local/dsh-agents-group/docs/验收/hello-{blog,closedoff}.png。
 *
 * 用法：node tests/mock/verify-hello.mjs [blog|closedoff|all]（默认 all；
 * 需 mock 8791（tests/mock/page-server.mjs）与 Edge --remote-debugging-port=9223 已启动）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CDP = 'http://127.0.0.1:9223'
const MOCK = 'http://127.0.0.1:8791'
// 截图落仓库根 .local/dsh-agents-group/docs/验收/（本脚本位于 plugins/external/dsh-agents-group/tests/mock/，
// 上溯五级是仓库根：mock→tests→群组根→agents→external→plugins）。
const SHOT_DIR = resolve(fileURLToPath(new URL('../../../../../.local/dsh-agents-group/docs/验收', import.meta.url)))
const which = process.argv[2] ?? 'all'

let seq = 0
const pending = new Map()
// console/日志错误收集：hello 页要求零错误；监听器挂在 connect() 里，容器提升到模块级。
const consoleErrors = []

async function connect() {
  const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    ws.addEventListener('open', done, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
  // Node 22 的原生 WebSocket 是 addEventListener 形态；CDP 消息分发与 console/日志
  // 错误收集都挂在这一个监听里。
  ws.addEventListener('message', raw => {
    const message = JSON.parse(raw.data.toString())
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push(message.params.args?.map(arg => arg.value ?? arg.description ?? '').join(' '))
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      consoleErrors.push(`${message.params.entry.source}: ${message.params.entry.text}`)
    }
  })
  const send = (method, params = {}) => new Promise(done => {
    const id = ++seq
    pending.set(id, done)
    ws.send(JSON.stringify({ id, method, params }))
  })
  return { ws, send }
}

async function verify(member) {
  const url = member === 'blog' ? `${MOCK}/blog` : `${MOCK}/closedoff-qa`
  const { ws, send } = await connect()
  consoleErrors.length = 0
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await new Promise(done => setTimeout(done, 1200))

  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.result?.exceptionDetails) return { __exception: reply.result.exceptionDetails.text }
    return reply.result?.result?.value
  }

  const checks = await evaluate(`(async () => {
    await document.fonts.ready
    const root = document.querySelector('#root .bt-page')
    const icons = document.querySelectorAll('#root svg[viewBox="0 0 24 24"]').length
    const rich = {
      container: document.querySelector('#root .md') !== null,
      strong: document.querySelector('#root .md strong')?.textContent ?? null,
      code: document.querySelector('#root .md pre.md-code code') !== null,
    }
    const loadedLxgw = [...document.fonts].filter(f => f.family === 'LXGW WenKai' && f.status === 'loaded').length
    const loadedMashan = [...document.fonts].filter(f => f.family === 'Ma Shan Zheng' && f.status === 'loaded').length
    const h1 = document.querySelector('#root h1')
    const h1Family = h1 === null ? null : getComputedStyle(h1).fontFamily
    const h1UsesHand = h1Family !== null && h1Family.includes('LXGW WenKai') || (h1Family ?? '').includes('Ma Shan Zheng')
    return {
      reactMounted: root !== null,
      icons,
      rich,
      bodyFont: getComputedStyle(document.body).fontFamily,
      loadedLxgw,
      loadedMashan,
      h1Family,
      h1UsesHand,
      closeoffConfig: typeof window.CLOSEDOFF_CONFIG === 'object' ? window.CLOSEDOFF_CONFIG?.routePrefix ?? null : null,
      dataBase: document.body.getAttribute('data-base'),
      texture: {
        paper: document.querySelector('#root .paper') !== null,
        tape: document.querySelector('#root .bt-tape') !== null,
        srStatus: document.querySelector('#sr-status.visually-hidden') !== null,
      },
    }
  })()`)

  // 焦点环验证走**真实键盘**（Tab）：程序化 focus() 不触发 :focus-visible（Chromium
  // 启发式），只有键盘路径才等价于用户的「这是键盘在这」。hello 页按钮是首个可聚焦元素。
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await new Promise(done => setTimeout(done, 150))
  const focusRing = await evaluate(`(() => {
    const button = document.querySelector('#root .btn')
    if (button === null) return null
    return { focused: document.activeElement === button, focusVisible: button.matches(':focus-visible'), style: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth }
  })()`)
  Object.assign(checks, { focusRing })

  // 点击按钮验证交互与轻提示贴纸（真实输入走 Input 域）。
  const coords = await evaluate(`(() => {
    const button = document.querySelector('#root .btn')
    if (button === null) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`)
  let stickerAfterClick = false
  if (coords !== null) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
    await new Promise(done => setTimeout(done, 300))
    stickerAfterClick = await evaluate(`document.querySelector('#root .sticker') !== null`)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data !== undefined) {
    await mkdir(SHOT_DIR, { recursive: true })
    await writeFile(resolve(SHOT_DIR, `hello-${member}.png`), Buffer.from(shot.result.data, 'base64'))
  }
  ws.close()

  const summary = { member, url, checks, stickerAfterClick, consoleErrors }
  console.log(JSON.stringify(summary, null, 2))
  const failed = summary.checks.__exception !== undefined
    || summary.checks.reactMounted !== true
    || summary.checks.icons < 1
    || summary.checks.rich.container !== true
    || summary.checks.rich.strong === null
    || summary.checks.loadedLxgw < 1
    || summary.checks.h1UsesHand !== true
    || summary.checks.focusRing?.focused !== true
    || summary.checks.focusRing?.focusVisible !== true
    || summary.checks.focusRing?.style !== 'dashed'
    || stickerAfterClick !== true
    || consoleErrors.length > 0
  if (member === 'closedoff') {
    if (summary.checks.closeoffConfig !== '/closedoff-qa') console.error(`[verify] CLOSEDOFF_CONFIG 注入异常：${summary.checks.closeoffConfig}`)
    else if (summary.checks.texture.paper !== true || summary.checks.texture.tape !== true) { console.error('[verify] textures 材质缺失'); return false }
  }
  if (member === 'blog' && summary.checks.dataBase !== '/blog') {
    console.error(`[verify] data-base 属性异常：${summary.checks.dataBase}`)
    return false
  }
  return !failed
}

const members = which === 'all' ? ['blog', 'closedoff'] : [which]
let ok = true
for (const member of members) {
  ok = (await verify(member)) && ok
}
console.log(ok ? '[verify-hello] 全部断言通过' : '[verify-hello] 存在失败断言（见上）')
process.exit(ok ? 0 : 1)
