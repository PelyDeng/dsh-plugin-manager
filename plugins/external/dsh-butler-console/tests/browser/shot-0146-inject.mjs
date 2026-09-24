/**
 * 0.14.6 ✋/✓ 图标渲染证据（注入式）：about:blank 注入最小结构（引 mock 的 app.css 与
 * lucide SVG 形态），验证 .ask__hand 与 .dcard__cell-check 的定位/着色与原 emoji 版一致。
 * 用法：node tests/browser/shot-0146-inject.mjs（截图存 .local/ui-review-0146/）。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
const CDP = 'http://127.0.0.1:9223'
const SHOT_DIR = 'E:/A_Git_CodeSource/dsh-plugin-manager-gitee/.local/ui-review-0146'
mkdirSync(SHOT_DIR, { recursive: true })

const CSS = readFileSync('E:/A_Git_CodeSource/dsh-plugin-manager-gitee/plugins/external/dsh-butler-console/dist/web/app.css', 'utf8')
const HAND = readFileSync('E:/A_Git_CodeSource/dsh-plugin-manager-gitee/plugins/external/dsh-butler-console/web/media/icons/lucide/hand.svg', 'utf8')
const CHECK = readFileSync('E:/A_Git_CodeSource/dsh-plugin-manager-gitee/plugins/external/dsh-butler-console/web/media/icons/lucide/check.svg', 'utf8')
const toInner = svg => svg.replace(/^[\s\S]*?>/, '').replace(/</g, '&lt;').replace(/^[\s\S]*?>/, m => m).replace(/<\//, '</').trim()

const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shot = async name => {
  await send('Page.bringToFront', {})
  await sleep(300)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log('截图:', name)
}

await send('Page.enable')
await send('Runtime.enable')
// 手账纸底 + 两块样例：提问卡（✋ 举手贴纸）与派工卡格子（✓ 选中对勾）。
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body style="background:#f7f1e3;padding:40px;display:flex;gap:40px;">
  <div style="width:420px;">
    <div class="ask">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ask__hand" aria-hidden="true" style="vertical-align:-0.15em;flex:none;">${HAND.replace(/^[\s\S]*?>/, '').replace(/<\/svg>[\s\S]*$/, '')}</svg>
      <div><p style="margin:0;">这篇先给你过目：发布口径用哪个？</p></div>
      <div class="ask__row"><input type="text" placeholder="补充说明"><button type="button" class="btn btn--tiny btn--primary">我来说</button><button type="button" class="btn btn--tiny">你看着办</button></div>
    </div>
  </div>
  <div style="width:420px;">
    <div class="dcard">
      <button type="button" class="dcard__cell dcard__cell--active">
        <span class="dcard__col">
          <span class="dcard__head"><span class="dcard__name">绘语（图片智能体）</span><span class="dcard__handle">@huiyu</span></span>
          <span class="dcard__meta"><span class="dcard__goal">生成配图 1 张</span><span class="dcard__status"><span class="dot dot--ok"></span><span class="dcard__statetext">已完成</span></span></span>
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="dcard__cell-check" aria-hidden="true" style="vertical-align:-0.15em;flex:none;">${CHECK.replace(/^[\s\S]*?>/, '').replace(/<\/svg>[\s\S]*$/, '')}</svg>
      </button>
    </div>
  </div>
</body></html>`
await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) })
await sleep(1200)
const probe = await evaluate(`(() => {
  const hand = document.querySelector('.ask__hand')
  const check = document.querySelector('.dcard__cell-check')
  const gs = el => el === null ? null : getComputedStyle(el)
  return {
    hand: hand === null ? null : { pos: gs(hand).position, top: gs(hand).top, right: gs(hand).right, transform: gs(hand).transform, color: gs(hand).color },
    check: check === null ? null : { pos: gs(check).position, top: gs(check).top, right: gs(check).right, color: gs(check).color, strokeWidth: gs(check).strokeWidth },
  }
})()`)
console.log('定位探测:', JSON.stringify(probe, null, 1))
await shot('图标注入-举手与对勾')
await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
process.exit(0)
