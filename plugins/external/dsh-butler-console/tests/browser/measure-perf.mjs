/**
 * React 前端性能测量（验收补项）：生产页面 FCP/LCP/传输量/长任务 + 滚动帧率。
 * 用法：TOKEN=<生产 ?token=> node tests/browser/measure-perf.mjs（需 Edge CDP 9223）。
 */
const CDP = 'http://127.0.0.1:9223'
const PAGE = `https://dsh.pelycloud.com/?token=${process.env.TOKEN}`
const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails !== undefined) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}
await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__perf = { fcp: null, lcp: null, longTasks: 0 }
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = Math.round(e.startTime) }).observe({ type: 'paint', buffered: true })
  new PerformanceObserver(l => { const es = l.getEntries(); if (es.length) window.__perf.lcp = Math.round(es.at(-1).startTime) }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver(l => { window.__perf.longTasks += l.getEntries().length }).observe({ type: 'longtask', buffered: true })
` })
await send('Page.navigate', { url: PAGE })
await new Promise(r => { setTimeout(r, 7000) })
const metrics = await evaluate(`(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  return {
    fcp: window.__perf.fcp, lcp: window.__perf.lcp,
    domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0), load: Math.round(nav?.loadEventEnd ?? 0),
    transferKB: Math.round((nav?.transferSize ?? 0) / 1024), longTasks: window.__perf.longTasks,
    reactMounted: (document.querySelector('#root')?.children.length ?? 0) > 0,
    composerVisible: document.querySelector('[class*=composer], textarea, [contenteditable]') !== null,
  }
})()`)
await evaluate(`(() => {
  window.__frames = []
  let last = performance.now()
  const loop = now => { window.__frames.push(now - last); last = now; requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  let step = 0
  const timer = setInterval(() => { step += 1; document.scrollingElement.scrollTop = (step % 2) * 300; if (step > 25) clearInterval(timer) }, 200)
})()`)
await new Promise(r => { setTimeout(r, 5200) })
const frames = await evaluate(`(() => {
  const deltas = window.__frames.slice(10).filter(d => d < 1000)
  const avg = deltas.reduce((s, d) => s + d, 0) / Math.max(1, deltas.length)
  return { fps: Math.round(1000 / avg), jank: deltas.filter(d => d > 32).length, samples: deltas.length }
})()`)
console.log(JSON.stringify({ reactMounted: metrics.reactMounted, composerVisible: metrics.composerVisible, FCP_ms: metrics.fcp, LCP_ms: metrics.lcp, DCL_ms: metrics.domContentLoaded, load_ms: metrics.load, transferKB: metrics.transferKB, longTasks: metrics.longTasks, scroll: frames }, null, 2))
await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
