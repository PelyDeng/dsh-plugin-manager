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
    // 会话列表假数据（形状对齐 src/web.ts /conversations 的分页响应：state/pinned/
    // titleSource 是页面行为依赖的字段；conv-mock-1 配有五类复原的 /history）。
    if (pathname === `${CO_PREFIX}/conversations`) {
      response.writeHead(200, HEADERS_JSON)
      response.end(JSON.stringify({
        items: [
          { id: 'conv-mock-1', title: '园区预约与轨迹演示会话', updatedAt: Date.now() - 3_600_000, state: 'ready', pinned: true, titleSource: 'manual' },
          { id: 'conv-mock-2', title: '批 1a 冒烟新会话', updatedAt: Date.now(), state: 'ready', pinned: false, titleSource: 'automatic' },
        ],
        nextOffset: null,
      }))
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
    if (pathname === `${CO_PREFIX}/conversation-action` && request.method === 'POST') {
      const body = await readBody(request)
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

// ── closedoff 批 1a 假数据与 SSE 回放 ─────────────────────────────────────

async function readBody(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

const MOCK_MESSAGE_ID = 'mock-msg-1'

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
              { lon: 102.7102, lat: 25.0408, time: '2026-09-25 08:00:00' },
              { lon: 102.7145, lat: 25.0431, time: '2026-09-25 08:01:00' },
              { lon: 102.7188, lat: 25.0455, time: '2026-09-25 08:02:00' },
              { lon: 102.7231, lat: 25.0472, time: '2026-09-25 08:03:00' },
            ],
            vehicleNo: '云A7D00M',
            groups: [{ name: '北门设备组', devices: [{ deviceId: 'dev-1', name: '北门-01', online: 1 }, { deviceId: 'dev-2', name: '北门-02', online: 0 }] }],
          },
        },
        fences: { 'call-fence': { name: '核心区围栏', points: [{ lon: 102.71, lat: 25.04 }, { lon: 102.72, lat: 25.04 }, { lon: 102.72, lat: 25.05 }] } },
        media: {
          'call-media': [
            { startTime: '2026-09-25 08:00:12', timeLength: '12s', deviceId: 'dev-1', mediaUrl: '' },
            { startTime: '2026-09-25 08:02:40', timeLength: '8s', deviceId: 'dev-1', mediaUrl: '' },
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
    { lon: 102.7102, lat: 25.0408, time: '2026-09-25 09:00:00' },
    { lon: 102.7145, lat: 25.0431, time: '2026-09-25 09:01:00' },
    { lon: 102.7188, lat: 25.0455, time: '2026-09-25 09:02:00' },
  ]
  await sendLater({ type: 'tool_start', callId: 'call-track-live', name: 'closedoff_vehicle_track', presentation: { tool: 'closedoff_vehicle_track', group: 'track', variant: 'records', sourceLabel: '车辆轨迹' } }, 60)
  await sendLater({ type: 'tool_end', callId: 'call-track-live', status: 'done' }, 100)
  await sendLater({ type: 'track', callId: 'call-track-live', points, vehicleNo: '云A7D00M' }, 80)
  await sendLater({ type: 'cameras', callId: 'call-track-live', cameras: [{ name: '北门设备组', devices: [{ deviceId: 'dev-1', name: '北门-01', online: 1 }] }] }, 80)
  await sendLater({ type: 'fences', callId: 'call-fence-live', payload: { name: '核心区围栏', points: [{ lon: 102.71, lat: 25.04 }, { lon: 102.72, lat: 25.05 }] } }, 80)
  await sendLater({ type: 'media', callId: 'call-media-live', items: [{ startTime: '2026-09-25 09:00:12', timeLength: '12s', deviceId: 'dev-1', mediaUrl: '' }] }, 80)

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
