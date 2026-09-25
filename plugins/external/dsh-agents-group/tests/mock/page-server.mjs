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

// closedoff 的注入与 src/web.ts 同形态：routePrefix + 地图配置（批 1b：terrainUrl/
// tilesetUrl 留空——React 飞地对空配置降级椭球地形+跳过 3D Tiles，mock/离线环境
// 无地形与三维模型服务，降级后底图与标绘可真实渲染；真实部署两项恒非空，行为不变）。
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
    // 批 2a：mock 状态重置（verify 脚本开跑时调用，从两个初始会话出发）。
    if (pathname === `${BLOG_PREFIX}/__mock/reset` && request.method === 'POST') {
      await readBody(request)
      resetBlogStore()
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ ok: true }))
      return
    }
    // 业务接口（批 2a 有状态化）：POST /api 的 {action,args} 信封，形状对齐
    // src/index.ts 的 /api 分发（chat 域 + 附件最小集）。
    if (pathname === `${BLOG_PREFIX}/api` && request.method === 'POST') {
      const body = await readBody(request)
      const action = blogActions[body.action]
      if (action === undefined) {
        response.writeHead(200, HEADERS_JSON)
        response.end(JSON.stringify({ error: `mock 未实现 action：${body.action}` }))
        return
      }
      try {
        const result = await action(body.args ?? {})
        response.writeHead(200, HEADERS_JSON)
        response.end(JSON.stringify(result ?? {}))
      } catch (error) {
        response.writeHead(200, HEADERS_JSON)
        response.end(JSON.stringify({ error: error?.message ?? String(error) }))
      }
      return
    }
    // 订阅-快照流（批 2a）：GET /chat-events，首条 snapshot，其后 live/changed 广播
    // + 1s ping 心跳——形状对齐 src/index.ts 的 /chat-events 端点与 chat.subscribe。
    if (pathname === `${BLOG_PREFIX}/chat-events`) {
      const id = url.searchParams.get('conversationId') ?? ''
      const conv = blogConversations.get(id)
      if (conv === undefined) {
        response.writeHead(404, HEADERS_JSON)
        response.end(JSON.stringify({ error: '会话不存在' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      let closed = false
      const send = value => {
        if (closed) return
        try { response.write(`data: ${JSON.stringify(value)}\n\n`) } catch { closed = true }
      }
      send({ type: 'snapshot', value: blogHistory(id) })
      const listener = value => send(value)
      conv.listeners.add(listener)
      const ping = setInterval(() => send({ type: 'ping' }), 1000)
      ping.unref?.()
      request.on('close', () => {
        closed = true
        clearInterval(ping)
        conv.listeners.delete(listener)
        response.end()
      })
      return
    }
    // 附件缩略图（1x1 透明 PNG；inline=1 的内联预览）。
    if (pathname === `${BLOG_PREFIX}/attachment-download`) {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      response.end(png)
      return
    }

    // ── closedoff 轨 ─────────────────────────────────────────────────────
    // 批 1b：mock 状态重置（verify 脚本开跑时调用，保证会话列表从初始态出发）。
    if (pathname === `${CO_PREFIX}/__mock/reset` && request.method === 'POST') {
      await readBody(request)
      conversationStore = [
        { id: 'conv-mock-1', title: '园区预约与轨迹演示会话', updatedAt: Date.now() - 3_600_000, state: 'ready', pinned: true, titleSource: 'manual' },
        { id: 'conv-mock-2', title: '批 1a 冒烟新会话', updatedAt: Date.now(), state: 'ready', pinned: false, titleSource: 'automatic' },
      ]
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ ok: true }))
      return
    }
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
    // 批 1b：三方静态资产（Cesium/@hy-media/vue）——与真实 /assets 路由同根直引，
    // 源=closedoff/web/assets/（构建产物不入 Git，需先 npm run build:web 落位）。
    if (pathname.startsWith(`${CO_PREFIX}/assets/cesium/`) || pathname.startsWith(`${CO_PREFIX}/assets/video-player/`)) {
      const relative = decodeURIComponent(pathname.slice(`${CO_PREFIX}/assets/`.length))
      const target = normalize(join(CLOSEDOFF, 'web/assets', relative))
      if (!target.startsWith(resolve(CLOSEDOFF, 'web/assets'))) throw new Error('越界路径')
      await serveFile(target, response)
      return
    }
    // identity：形状对齐 src/web.ts 的 /identity 端点。
    if (pathname === `${CO_PREFIX}/identity`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ mode: 'standalone', key: 'mock-user', label: '独立模式', authPath: '/auth' }))
      return
    }
    // 会话列表（形状对齐 src/web.ts /conversations 的分页响应）——批 1b 起有状态：
    // conversation-action 的 pin/rename/delete 落在本存储上，验证面板的置顶切换/
    // 批量删除后列表真实变化。state/pinned/titleSource 是页面行为依赖的字段；
    // conv-mock-1 配有五类复原的 /history。
    if (pathname === `${CO_PREFIX}/conversations`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ items: conversationStore.map(item => ({ ...item })), nextOffset: null }))
      return
    }
    if (pathname === `${CO_PREFIX}/models`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({
        groups: [{ id: 'mock-provider', name: '演示模型组', models: [{ id: 'mock-pro', name: '演示模型 Pro' }, { id: 'mock-lite', name: '演示模型 Lite' }] }],
        failures: [],
        selected: { provider: 'mock-provider', model: 'mock-pro' },
        default: { provider: 'mock-provider', model: 'mock-pro' },
      }))
      return
    }
    // 历史复原假数据：五类要素齐全（tools/tracks+fences/media/cards + 回合元信息
    // + 评分），conv-mock-1 专用，其余会话给空历史。
    if (pathname === `${CO_PREFIX}/history`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify(historyPayload(url.searchParams.get('conversationId') ?? '')))
      return
    }
    // SSE 回放：按脚本回放完整十类事件（间隔与顺序对齐真实服务面；thinking 快照
    // 故意以 60ms 密集发送，用于验证客户端投影层的 250ms 合并节流——真实服务端
    // 已按 250ms 限频，这里的密集序列是节流逻辑的测试素材）。
    if (pathname === `${CO_PREFIX}/chat` && request.method === 'POST') {
      const body = await readBody(request)
      await replayChat(body, response)
      return
    }
    if (pathname === `${CO_PREFIX}/stop` && request.method === 'POST') {
      await readBody(request)
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (pathname === `${CO_PREFIX}/feedback` && request.method === 'POST') {
      const body = await readBody(request)
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ rating: body.rating === 'positive' ? null : 'positive' }))
      return
    }
    if (pathname === `${CO_PREFIX}/branch` && request.method === 'POST') {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ conversationId: 'conv-mock-branch' }))
      return
    }
    // 会话操作（批 1b 起有状态）：pin/rename/delete 落在 conversationStore 上。
    if (pathname === `${CO_PREFIX}/conversation-action` && request.method === 'POST') {
      const body = await readBody(request)
      const ids = Array.isArray(body.ids) ? body.ids : []
      for (const id of ids) {
        const item = conversationStore.find(entry => entry.id === id)
        if (item === undefined) continue
        if (body.operation === 'pin') item.pinned = body.pinned === true
        if (body.operation === 'rename' && typeof body.title === 'string' && body.title.trim() !== '') item.title = body.title.trim()
        if (body.operation === 'delete') item.state = 'pending'
      }
      // 删除在刷新时从列表剔除（真实服务端是 pending→消失两拍，这里直接收敛）。
      if (typeof body.operation === 'string') {
        conversationStore = conversationStore.filter(item => !(body.operation === 'delete' && ids.includes(item.id)))
      }
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({ ok: true, operation: body.operation ?? '' }))
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

// ── blog 批 2a 假数据与订阅-快照回放 ──────────────────────────────────────

/**
 * 会话状态（形状对齐 src/chat.ts 的内存态与 chat-history 投影）：
 * - info/messages/turns 直接投影进 chat-history；
 * - busy/live 是流式期状态；listeners 是 /chat-events 的订阅者集合。
 */
const blogConversations = new Map()
let blogSeq = 100

function makeBlogConversation(id, title, pinned = false) {
  return {
    info: { id, title, updatedAt: Date.now(), ready: true, parent: null, pinned },
    messages: [],
    turns: [],
    busy: false,
    live: null,
    turn: 0,
    listeners: new Set(),
  }
}

/** 初始两个会话：conv-mock-1 带一轮完整历史（切会话场景），conv-mock-2 空会话。 */
function resetBlogStore() {
  blogConversations.clear()
  blogSeq = 100
  const seeded = makeBlogConversation('conv-mock-1', '博客近况梳理会话', true)
  seeded.updatedAt = Date.now() - 3_600_000
  seeded.messages.push(
    { id: 'msg-user-1', role: 'user', seq: 101, time: Date.now() - 3_590_000, turn: 1, text: '看看我的博客最近发布了哪些文章？', requestId: 'req-mock-1', attachments: [] },
    {
      id: 'msg-assistant-1', role: 'assistant', seq: 102, time: Date.now() - 3_580_000, turn: 1,
      text: '最近一周发布了《手账工作台实践》与《订阅-快照模型浅析》两篇文章；草稿箱里还有一篇待发布。\n\n需要我帮你起草下一篇吗？',
      reasoning: '先按时间倒序列出已发布文章\n再看草稿箱的待发布内容',
      interrupted: false, feedback: true, tail: true, model: 'mock-pro', provider: 'mock-provider',
    },
  )
  seeded.turns.push({
    turn: 1, startSeq: 101, startedAt: Date.now() - 3_590_000, status: 'succeeded',
    usage: { uncachedInputTokens: 320, outputTokens: 96, totalTokens: 416, cacheReadTokens: 128 },
    runMs: 2400, ttftMs: 320, tokensPerSecond: 61.5, attempts: 1, cut: 103,
  })
  blogConversations.set('conv-mock-1', seeded)
  const fresh = makeBlogConversation('conv-mock-2', '批 2a 冒烟新会话')
  blogConversations.set('conv-mock-2', fresh)
}

resetBlogStore()

function blogHistory(id) {
  const conv = blogConversations.get(id)
  if (conv === undefined) throw new Error('会话不存在')
  return {
    conversation: { ...conv.info },
    messages: conv.messages.map(message => ({ ...message })),
    turns: conv.turns.map(turn => ({ ...turn })),
    busy: conv.busy,
    live: conv.live === null ? null : { ...conv.live },
    requests: [],
    results: [],
    operations: [],
  }
}

function blogBroadcast(conv, value) {
  for (const listener of conv.listeners) listener(value)
}

function blogTouch(conv) {
  conv.info.updatedAt = Date.now()
}

/**
 * chat-send 的一轮流式回放：reasoning live 帧 → 分段正文 live 帧 → 落一条完整
 * assistant 消息 + turn 摘要 → changed 广播（客户端防抖重拉后消息落位）。
 */
async function replayBlogTurn(conv, text) {
  blogTouch(conv)
  const turn = ++conv.turn
  const startSeq = ++blogSeq
  conv.busy = true
  conv.live = { text: '', reasoning: '' }
  blogBroadcast(conv, { type: 'changed' })

  for (const piece of ['先梳理写作范围', '按时间倒序盘点文章与草稿']) {
    await sleep(150)
    if (!conv.busy) return
    conv.live = { text: conv.live?.text ?? '', reasoning: piece }
    blogBroadcast(conv, { type: 'live', live: { ...conv.live } })
  }

  const segments = [
    `已收到「${text}」。`,
    '近况小结：两篇新文已发布，草稿箱还有一篇待发。',
    '建议下一步：把提纲落成草稿，我可以直接保存候选稿。',
  ]
  let streamed = ''
  for (const segment of segments) {
    await sleep(170)
    if (!conv.busy) return
    streamed += segment
    conv.live = { text: streamed, reasoning: '' }
    blogBroadcast(conv, { type: 'live', live: { ...conv.live } })
  }

  await sleep(130)
  const endSeq = ++blogSeq
  const finalText = streamed
  conv.busy = false
  conv.live = null
  conv.messages.push({
    id: `assistant-${endSeq}`, role: 'assistant', seq: endSeq, time: Date.now(), turn,
    text: finalText,
    reasoning: '先梳理写作范围',
    interrupted: false, feedback: true, tail: true, model: 'mock-pro', provider: 'mock-provider',
  })
  conv.turns.push({
    turn, startSeq, startedAt: startSeq, status: 'succeeded',
    usage: { uncachedInputTokens: 210, outputTokens: 88, totalTokens: 298, cacheReadTokens: 64 },
    runMs: 920, ttftMs: 160, tokensPerSecond: 88.4, attempts: 1, cut: endSeq + 1,
  })
  blogBroadcast(conv, { type: 'changed' })
}

/** chat-stop：停止即把已生成内容落成 interrupted 消息（真实服务面同口径）。 */
async function stopBlogTurn(conv) {
  if (!conv.busy) return
  const partial = conv.live?.text ?? ''
  conv.busy = false
  conv.live = null
  const seq = ++blogSeq
  if (partial !== '') {
    conv.messages.push({
      id: `assistant-${seq}`, role: 'assistant', seq, time: Date.now(), turn: conv.turn,
      text: partial, reasoning: '', interrupted: true, feedback: false, tail: false,
      model: 'mock-pro', provider: 'mock-provider',
    })
  }
  blogTouch(conv)
  blogBroadcast(conv, { type: 'changed' })
}

const MOCK_MODELS = {
  groups: [
    { id: 'mock-provider', name: '演示模型组', models: [{ id: 'mock-pro', name: '演示模型 Pro' }, { id: 'mock-lite', name: '演示模型 Lite' }] },
  ],
  failures: [],
  selected: null,
  default: { provider: 'mock-provider', model: 'mock-pro' },
}

/** POST /api 的 action 分发（blog 域最小集；形状对齐 src/index.ts 的 switch）。 */
const blogActions = {
  'chat-create': () => {
    const id = `conv-blog-${Date.now().toString(36)}`
    blogConversations.set(id, makeBlogConversation(id, '新对话'))
    return { id, title: '新对话', updatedAt: Date.now(), ready: true, parent: null, pinned: false }
  },
  'chat-list': args => {
    const items = [...blogConversations.values()]
      .map(conv => ({
        id: conv.info.id,
        title: conv.info.title,
        updatedAt: conv.info.updatedAt,
        state: conv.busy ? 'busy' : 'ready',
        pinned: conv.info.pinned,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const offset = Number(args.offset ?? 0)
    void args.query
    return { items: offset > 0 ? [] : items, nextOffset: null }
  },
  'chat-models': () => ({ ...MOCK_MODELS }),
  'chat-update': args => {
    for (const id of args.ids ?? []) {
      const conv = blogConversations.get(id)
      if (conv === undefined) continue
      if (args.operation === 'rename' && typeof args.title === 'string' && args.title.trim() !== '') conv.info.title = args.title.trim()
      if (args.operation === 'pin') conv.info.pinned = args.pinned === true
      if (args.operation === 'delete') blogConversations.delete(id)
      blogTouch(conv)
    }
    return { ok: true }
  },
  'chat-history': args => blogHistory(String(args.conversationId)),
  'chat-send': args => {
    const conv = blogConversations.get(String(args.conversationId))
    if (conv === undefined) throw new Error('会话不存在')
    if (conv.busy) throw new Error('上一轮回答还在进行，请先停止')
    const seq = ++blogSeq
    conv.messages.push({
      id: `user-${seq}`, role: 'user', seq, time: Date.now(), turn: conv.turn + 1,
      text: String(args.text ?? ''), requestId: String(args.requestId ?? `req-${seq}`),
      attachments: (args.attachments ?? []).map(file => ({ id: file.id, name: `资料 ${file.id}`, kind: 'text/plain', range: file.range ?? null, partial: false })),
    })
    blogTouch(conv)
    void replayBlogTurn(conv, String(args.text ?? ''))
    return { model: { provider: 'mock-provider', model: 'mock-pro' } }
  },
  'chat-stop': args => {
    const conv = blogConversations.get(String(args.conversationId))
    if (conv === undefined) throw new Error('会话不存在')
    void stopBlogTurn(conv)
    return { ok: true }
  },
  'chat-image-capability': () => ({ message: '当前模型可读取图片资料', available: true, currentSupportsImages: true }),
  attachments: () => [],
  'attachment-select': () => ({}),
  'attachment-remove': () => ({}),
}

// ── closedoff 批 1a/1b 假数据与 SSE 回放 ──────────────────────────────────

async function readBody(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

/** 会话列表的有状态存储（conversation-action 的 pin/rename/delete 落在这里）。 */
let conversationStore = [
  { id: 'conv-mock-1', title: '园区预约与轨迹演示会话', updatedAt: Date.now() - 3_600_000, state: 'ready', pinned: true, titleSource: 'manual' },
  { id: 'conv-mock-2', title: '批 1a 冒烟新会话', updatedAt: Date.now(), state: 'ready', pinned: false, titleSource: 'automatic' },
]

const MOCK_MESSAGE_ID = 'mock-msg-1'

/** 轨迹沿途设备组（形状对齐 src/presentation-track.ts TrackDeviceGroup/TrackDevice）。 */
function deviceGroup(id, name, lon, lat, devices) {
  return { groupId: id, groupName: name, lon, lat, h: 1892, devices }
}

const NORTH_GATE_GROUP = deviceGroup('group-north', '北门设备组', 102.7138, 25.0425, [
  {
    id: 'dev-1', name: '北门-01', code: 'CAM-N1', status: 1, deviceType: 6,
    deviceIp: '10.20.0.11', accessAddress: 'rtsp://mock.invalid/stream/n1',
    cameraCode: 'CAM-N1', lastHeartbeatTime: Date.now() - 30_000,
  },
  {
    id: 'dev-2', name: '北门-02', code: 'CAM-N2', status: 0, deviceType: 6,
    deviceIp: '10.20.0.12', videoAddress: 'rtsp://mock.invalid/stream/n2',
    cameraCode: 'CAM-N2', lastHeartbeatTime: Date.now() - 600_000,
  },
  { id: 'dev-9', name: '北门门禁', code: 'GATE-N1', status: 1, deviceType: 3 },
])

/** /history 假数据：conv-mock-1 带五类复原要素，其余会话空历史。 */
function historyPayload(conversationId) {
  if (conversationId !== 'conv-mock-1') return { history: [], feedback: [], feedbackUnavailable: false }
  const warningCards = {
    tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询',
    state: 'data', count: 2, shown: 2, note: '',
    cards: [
      { title: '东门车辆报警', fields: [{ k: '状态', v: '持续', tone: 'orange' }, { k: '位置', v: '东门卡口', tone: '' }] },
      { title: '南园超速报警', fields: [{ k: '状态', v: '已解除', tone: 'green' }, { k: '位置', v: '南园路段', tone: '' }] },
    ],
  }
  const overview = {
    tool: 'closedoff_vehicle_comprehensive_page', group: 'overview', variant: 'summary', sourceLabel: '车辆概览',
    state: 'data', count: 3, shown: 1, note: '',
    cards: [{ title: '园区车辆概览', fields: [{ k: '在园车辆', v: '3', tone: 'blue' }, { k: '今日预警总数', v: '2', tone: 'orange' }, { k: '黑名单命中', v: '0', tone: 'green' }] }],
  }
  const parkingEmpty = {
    tool: 'closedoff_parking_area_page', group: 'infrastructure', variant: 'records', sourceLabel: '停车区',
    state: 'empty', count: 0, shown: 0, note: '', cards: [],
  }
  return {
    history: [
      { role: 'user', text: '园区现在整体情况怎么样？顺带查一下云A7D00M 的轨迹。', time: Date.now() - 7_200_000 },
      {
        role: 'assistant',
        text: [
          '园区整体运行平稳：在园车辆 3 台，今日预警 2 条（1 条持续、1 条已解除），无黑名单命中。',
          '',
          '| 指标 | 数值 |',
          '| --- | --- |',
          '| 在园车辆 | 3 |',
          '| 持续预警 | 1 |',
          '',
          '云A7D00M 正沿园区主干道行驶，附近有北门设备组可回看抓拍。',
        ].join('\n'),
        thinking: '先查车辆概览拿到整体状态\n再查预警报警确认风险\n最后调车辆轨迹并联动附近设备组',
        thinkingDone: true,
        tools: [
          { callId: 'call-overview', name: 'closedoff_vehicle_comprehensive_page', status: 'ok', time: Date.now() - 7_100_000, durMs: 320 },
          { callId: 'call-warning', name: 'closedoff_warning_page', status: 'ok', time: Date.now() - 7_000_000, durMs: 280 },
          { callId: 'call-track', name: 'closedoff_vehicle_track', status: 'ok', time: Date.now() - 6_800_000, durMs: 540 },
          { callId: 'call-parking', name: 'closedoff_parking_area_page', status: 'error', time: Date.now() - 6_600_000, durMs: 900, presentation: { tool: 'closedoff_parking_area_page', group: 'infrastructure', variant: 'records', sourceLabel: '停车区' } },
        ],
        tracks: {
          'call-track': {
            points: [
              { lon: 102.7102, lat: 25.0408, h: 1892, t: '2026-09-25 08:00:00' },
              { lon: 102.7145, lat: 25.0431, h: 1893, t: '2026-09-25 08:01:00' },
              { lon: 102.7188, lat: 25.0455, h: 1895, t: '2026-09-25 08:02:00' },
              { lon: 102.7231, lat: 25.0472, h: 1896, t: '2026-09-25 08:03:00' },
            ],
            vehicleNo: '云A7D00M',
            groups: [NORTH_GATE_GROUP],
          },
        },
        // 围栏形状对齐 src/fences.ts（geometries；批 1a 的旧形状无 geometries，
        // 页面侧守卫不可视化——批 1b 起给真实形状以验证围栏快照）。
        fences: {
          'call-fence': {
            geometries: [
              { name: '核心区围栏', kind: 'wall', positions: [[102.7118, 25.0418, 1892], [102.7165, 25.0438, 1893], [102.7168, 25.0470, 1895]], height: 12 },
              { name: '停车控制区', kind: 'polygon', positions: [[102.7190, 25.0450, 1895], [102.7225, 25.0455, 1896], [102.7228, 25.0478, 1896], [102.7195, 25.0472, 1895]], height: 0 },
            ],
            note: '围栏来自园区标绘存档，按保存的边界坐标与高度展示',
          },
        },
        media: {
          'call-media': [
            { deviceId: 'dev-1', startTime: '2026-09-25 08:00:12', timeLength: '12s', mediaUrl: 'rtsp://mock.invalid/capture/1' },
            { deviceId: 'dev-1', startTime: '2026-09-25 08:02:40', timeLength: '8s', mediaUrl: '' },
          ],
        },
        cards: {
          'call-overview': overview,
          'call-warning': warningCards,
          // call-track 无卡：轨迹工具的结果以轨迹呈现（旧码口径，points 非空时不发卡）。
          'call-parking': { ...parkingEmpty, state: 'error' },
        },
        time: Date.now() - 6_500_000,
        done: true,
        finishReason: 'completed',
        messageId: MOCK_MESSAGE_ID,
        branchSeq: 12,
        completedAt: Date.now() - 6_500_000,
        runMs: 6400,
        ttftMs: 410,
        usage: { inputTokens: 1840, outputTokens: 326, totalTokens: 2166, cacheReadTokens: 512, reasoningTokens: 96 },
      },
    ],
    feedback: [{ messageId: MOCK_MESSAGE_ID, rating: 'positive' }],
    feedbackUnavailable: false,
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** POST /chat 的脚本回放：conversation→思考→工具与五类结构化结果→done+meta。 */
async function replayChat(body, response) {
  const message = typeof body.message === 'string' ? body.message : ''
  const conversationId = typeof body.conversationId === 'string' && body.conversationId !== ''
    ? body.conversationId
    : `closedoff-web-${crypto.randomUUID()}`
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  let closed = false
  response.on('close', () => { closed = true })
  const send = value => {
    if (!closed) response.write(`data: ${JSON.stringify(value)}\n\n`)
  }
  const sendLater = async (value, ms) => {
    await sleep(ms)
    if (!closed) send(value)
  }

  send({ type: 'conversation', conversationId, model: { provider: 'mock-provider', model: 'mock-pro' } })

  // 思考：密集快照（客户端节流素材）+ 终态直投。
  const snapshots = ['收到，先梳理查询范围', '拆解为：概览、预警、轨迹三路', '并行调用业务查询', '概览与预警已回', '轨迹点已取回，联动设备组', '汇总结论中']
  for (const text of snapshots) await sendLater({ type: 'thinking_snapshot', text, done: false }, 60)
  await sendLater({ type: 'thinking_snapshot', text: `${snapshots.at(-1)}\n整理完毕`, done: true }, 60)

  // 预警查询：完整生命周期（loading 卡 → 完成 → data 卡）。
  await sendLater({
    type: 'tool_start', callId: 'call-warning-live', name: 'closedoff_warning_page',
    presentation: { tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询' },
  }, 80)
  await sendLater({ type: 'cards', callId: 'call-warning-live', payload: { tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询', state: 'loading', count: 0, shown: 0, note: '', cards: [] } }, 120)
  await sendLater({ type: 'tool_end', callId: 'call-warning-live', status: 'done' }, 80)
  await sendLater({
    type: 'cards', callId: 'call-warning-live',
    payload: {
      tool: 'closedoff_warning_page', group: 'risk', variant: 'records', sourceLabel: '预警报警查询',
      state: 'data', count: 2, shown: 2, note: '',
      cards: [
        { title: '东门车辆报警', fields: [{ k: '状态', v: '持续', tone: 'orange' }] },
        { title: '南园超速报警', fields: [{ k: '状态', v: '已解除', tone: 'green' }] },
      ],
    },
  }, 100)

  // 停车区查询失败：chip 置败（无 presentation 错误卡——与真实服务面一致，错误卡
  // 只在 restore 的 error presentation 场景出现）。
  await sendLater({ type: 'tool_start', callId: 'call-parking-live', name: 'closedoff_parking_area_page', presentation: { tool: 'closedoff_parking_area_page', group: 'infrastructure', variant: 'records', sourceLabel: '停车区' } }, 60)
  await sendLater({ type: 'tool_end', callId: 'call-parking-live', status: 'error' }, 120)

  // 轨迹 + 附近设备组 + 围栏 + 抓拍媒体。
  const points = [
    { lon: 102.7102, lat: 25.0408, h: 1892, t: '2026-09-25 09:00:00' },
    { lon: 102.7145, lat: 25.0431, h: 1893, t: '2026-09-25 09:01:00' },
    { lon: 102.7188, lat: 25.0455, h: 1895, t: '2026-09-25 09:02:00' },
  ]
  await sendLater({ type: 'tool_start', callId: 'call-track-live', name: 'closedoff_vehicle_track', presentation: { tool: 'closedoff_vehicle_track', group: 'track', variant: 'records', sourceLabel: '车辆轨迹' } }, 60)
  await sendLater({ type: 'tool_end', callId: 'call-track-live', status: 'done' }, 100)
  await sendLater({ type: 'track', callId: 'call-track-live', points, vehicleNo: '云A7D00M' }, 80)
  // 设备组形状对齐 src/presentation-track.ts（页面弹窗按 deviceType/status 消费）。
  await sendLater({ type: 'cameras', callId: 'call-track-live', cameras: [NORTH_GATE_GROUP] }, 80)
  // 围栏形状对齐 src/fences.ts（geometries）。
  await sendLater({
    type: 'fences', callId: 'call-fence-live',
    payload: {
      geometries: [
        { name: '核心区围栏', kind: 'wall', positions: [[102.7118, 25.0418, 1892], [102.7165, 25.0438, 1893], [102.7168, 25.0470, 1895]], height: 12 },
      ],
      note: '围栏来自园区标绘存档',
    },
  }, 80)
  // 抓拍媒体：一段有地址（验证播放器挂载）、一段无地址（验证占位态）。
  await sendLater({
    type: 'media', callId: 'call-media-live',
    items: [
      { deviceId: 'dev-1', startTime: '2026-09-25 09:00:12', timeLength: '12s', mediaUrl: 'rtsp://mock.invalid/capture/live1' },
    ],
  }, 80)

  // 正文（真实服务面在收尾发一次全量脱敏 delta）与 done+meta。
  const finalText = `已收到「${message}」。园区整体平稳：在园车辆 3 台、今日预警 2 条；云A7D00M 正沿主干道行驶，可回看北门设备组抓拍。`
  await sendLater({ type: 'delta', text: finalText }, 100)
  await sendLater({
    type: 'done',
    reason: 'completed',
    meta: {
      messageId: `mock-${Date.now()}`,
      branchSeq: 42,
      completedAt: Date.now(),
      runMs: 2600,
      ttftMs: 190,
      usage: { inputTokens: 900, outputTokens: 180, totalTokens: 1080 },
    },
  }, 60)

  response.end()
}
