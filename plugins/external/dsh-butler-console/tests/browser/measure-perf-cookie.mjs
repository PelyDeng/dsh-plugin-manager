/**
 * React 前端性能测量（cookie 版，0.14.6 LCP 优化基线）：?token= 查询参数已失效（401），
 * 改走 CDP Network.setCookie 注入 dsh_auth_session；顺带输出 LCP 元素定位（tagName/类名/来源）。
 * 用法：SESS=<dsh_auth_session cookie 值> node tests/browser/measure-perf-cookie.mjs（需 Edge CDP 9223）。
 * 登录取 cookie：POST /auth/api/login（字段 username，三头 Content-Type+Origin+x-dsh-csrf: login），
 * 响应 Set-Cookie 里的 dsh_auth_session 即 SESS。
 */
const CDP = 'http://127.0.0.1:9223'
const ORIGIN = 'https://dsh.pelycloud.com'
const SESS = process.env.SESS
if (!SESS) { console.error('用法：SESS=<dsh_auth_session> node tests/browser/measure-perf-cookie.mjs'); process.exit(1) }
const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
await send('Network.enable')
await send('Network.setCookie', { name: 'dsh_auth_session', value: SESS, domain: 'dsh.pelycloud.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' })
await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__perf = { fcp: null, lcp: null, lcpEl: null, longTasks: 0 }
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = Math.round(e.startTime) }).observe({ type: 'paint', buffered: true })
  new PerformanceObserver(l => {
    const es = l.getEntries()
    if (es.length) {
      const e = es.at(-1)
      window.__perf.lcp = Math.round(e.startTime)
      const el = e.element
      window.__perf.lcpEl = el ? {
        tag: el.tagName, id: el.id || null,
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80) || null,
        text: (el.textContent || '').trim().slice(0, 40) || null,
        url: e.url || null, size: Math.round(e.size),
      } : null
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver(l => { window.__perf.longTasks += l.getEntries().length }).observe({ type: 'longtask', buffered: true })
` })
await send('Page.navigate', { url: `${ORIGIN}/butler` })
await new Promise(r => { setTimeout(r, 7000) })
const metrics = await evaluate(`(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const fonts = [...document.fonts].filter(f => f.status === 'loading').length
  return {
    fcp: window.__perf.fcp, lcp: window.__perf.lcp, lcpEl: window.__perf.lcpEl,
    domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0), load: Math.round(nav?.loadEventEnd ?? 0),
    transferKB: Math.round((nav?.transferSize ?? 0) / 1024), longTasks: window.__perf.longTasks,
    reactMounted: (document.querySelector('#root')?.children.length ?? 0) > 0,
    fontsLoading: fonts,
  }
})()`)
console.log(JSON.stringify({ reactMounted: metrics.reactMounted, FCP_ms: metrics.fcp, LCP_ms: metrics.lcp, LCP_el: metrics.lcpEl, DCL_ms: metrics.domContentLoaded, load_ms: metrics.load, transferKB: metrics.transferKB, longTasks: metrics.longTasks, fontsLoading: metrics.fontsLoading }, null, 2))
await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
