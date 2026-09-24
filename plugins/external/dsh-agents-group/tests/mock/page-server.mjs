/**
 * 群组侧成员页面 mock 服务器（群组二期批 0，入库可复跑；方案 §4.1/§5 批 0）。
 *
 * 一套脚本服务两个成员的 React hello 页：静态服务成员 web-react/ 骨架与 dist 产物、
 * web-common 字体分片，外加 identity/会话列表的最小假数据端点（closedoff 与 blog
 * 各一套路由前缀）。hello 页不发业务请求，假数据端点为批 1/2 的页面迁移预留形状；
 * SSE 回放端点在批 1（closedoff 单向流）/批 2（blog 订阅-快照）各自增配。
 *
 * 注入形态各自复刻真实服务面：
 * - blog：index.html 的 __BASE__ 占位替换为 /blog，配置通道=body data-base 属性
 *   （CSP script-src 'self'，无 inline script）；
 * - closedoff：/closedoff-qa 前缀替换 + `window.CLOSEDOFF_CONFIG = __WEB_CONFIG__`
 *   inline 注入（与 src/web.ts 同形态）。
 *
 * 用法：node tests/mock/page-server.mjs [端口]（默认 8791，避开 butler mock 的 8790）
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] ?? 8791)
const GROUP_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const BLOG = resolve(GROUP_ROOT, 'agents/blog')
const CLOSEDOFF = resolve(GROUP_ROOT, 'agents/closedoff')
const WEB_COMMON = resolve(GROUP_ROOT, 'agents/web-common')

const BLOG_PREFIX = '/blog'
const CO_PREFIX = '/closedoff-qa'

// closedoff 的注入与 src/web.ts 同形态：routePrefix + 地图配置（mock 给最小合法值，
// hello 页不消费，批 1 的地图飞地才需要）。
const CO_CONFIG = JSON.stringify({
  routePrefix: CO_PREFIX,
  map: { terrainUrl: '', tilesetUrl: '', tilesetHeight: 0, trackDeviceRadiusMeters: 50 },
}).replaceAll('<', '\\u003c')

const HEADERS_JSON = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function serveFile(target, response) {
  const body = await readFile(target)
  response.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  response.end(body)
}

/** 骨架页：读源 html，做各自成员的占位替换（与真实服务面同一形态）。 */
async function serveSkeleton(file, response, replace) {
  let html = await readFile(file, 'utf8')
  for (const [from, to] of replace) html = html.replaceAll(from, to)
  response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
  response.end(html)
}

/** web-common 字体分片：/…(/assets)?/media/fonts/<lxgw|ma-shan-zheng>/<file>。 */
async function serveFont(pathname, response) {
  const relative = pathname.slice(pathname.indexOf('media/fonts/'))
  const target = normalize(join(WEB_COMMON, relative))
  if (!target.startsWith(resolve(WEB_COMMON, 'media/fonts'))) return false
  await serveFile(target, response)
  return true
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname
  try {
    // 浏览器自动请求的 favicon：给 204 兜底，别让它以 404 污染 console 零错误的断言。
    if (pathname === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    // ── blog 轨 ──────────────────────────────────────────────────────────
    if (pathname === BLOG_PREFIX || pathname === `${BLOG_PREFIX}/`) {
      await serveSkeleton(resolve(BLOG, 'web-react/index.html'), response, [['__BASE__', BLOG_PREFIX]])
      return
    }
    if (pathname === `${BLOG_PREFIX}/app.js`) return void await serveFile(resolve(BLOG, 'dist/web/app.js'), response)
    if (pathname === `${BLOG_PREFIX}/app.css`) return void await serveFile(resolve(BLOG, 'dist/web/app.css'), response)
    if (pathname.startsWith(`${BLOG_PREFIX}/media/fonts/`)) {
      if (await serveFont(pathname, response)) return
    }
    // identity：形状对齐 src/index.ts 的 /identity 端点。
    if (pathname === `${BLOG_PREFIX}/identity`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ userId: 'mock-user', version: '0.13.0-mock', backupAdmin: false, maxImageBytes: 26_214_400, blogUrl: 'https://blog.example.invalid' }))
      return
    }
    // 会话列表最小假数据（形状对齐 chat.list；hello 页不消费，批 2 迁移时增配）。
    if (pathname === `${BLOG_PREFIX}/api` && request.method === 'POST') {
      for await (const chunk of request) void chunk
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ items: [{ id: 'conv-mock-1', title: 'mock 会话', updatedAt: Date.now() }] }))
      return
    }

    // ── closedoff 轨 ─────────────────────────────────────────────────────
    if (pathname === CO_PREFIX || pathname === `${CO_PREFIX}/`) {
      await serveSkeleton(resolve(CLOSEDOFF, 'web-react/index.html'), response, [
        ['__WEB_CONFIG__', CO_CONFIG],
        [CO_PREFIX, CO_PREFIX],
      ])
      return
    }
    if (pathname === `${CO_PREFIX}/assets/app.js`) return void await serveFile(resolve(CLOSEDOFF, 'dist/web/app.js'), response)
    if (pathname === `${CO_PREFIX}/assets/app.css`) return void await serveFile(resolve(CLOSEDOFF, 'dist/web/app.css'), response)
    if (pathname.startsWith(`${CO_PREFIX}/assets/media/fonts/`)) {
      if (await serveFont(pathname, response)) return
    }
    // identity：形状对齐 src/web.ts 的 /identity 端点。
    if (pathname === `${CO_PREFIX}/identity`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ mode: 'standalone', key: 'mock-user', label: '独立模式', authPath: '/auth' }))
      return
    }
    // 会话列表最小假数据（形状对齐 lifecycle.list 的分页响应；批 1 迁移时增配 SSE 回放）。
    if (pathname === `${CO_PREFIX}/conversations`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ items: [{ id: 'conv-mock-1', title: 'mock 会话', updatedAt: Date.now(), hostBusy: [], archived: false }], hasMore: false }))
      return
    }
    if (pathname === `${CO_PREFIX}/models`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ items: [], defaultModel: null }))
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('mock 未实现该路径')
  } catch (error) {
    // 产物不存在（如切回旧链后 dist/web 清空）按 404，不崩 mock 服务。
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`mock 资源缺失：${error?.code ?? error}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agents-group-mock] blog       http://127.0.0.1:${PORT}${BLOG_PREFIX}`)
  console.log(`[agents-group-mock] closedoff   http://127.0.0.1:${PORT}${CO_PREFIX}`)
})
