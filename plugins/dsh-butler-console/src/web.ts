/**
 * 管家工作台的 HTTP 与 SSE 接口。
 *
 * 所有受保护路由都经过 kit 的 `createPluginHttp`，因此每次访问都会重新核对登录
 * 身份；只有 `/health` 和 `/ready` 是公开探针。
 *
 * 页面不需要知道任何配置值、Token 或内部路径：这里返回的卡片、状态和错误都已经
 * 裁剪成可展示内容。
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { actorKey, createPluginHttp, isAccessError, onRevoked, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { conversationModelCatalog } from '@dsh-plugin-manager/plugin-kit/models'
import { listAgentCards } from './agents.ts'
import type { ButlerConsole } from './butler.ts'
import type { Config } from './config.ts'

/** 一次可预期的请求错误；其余异常统一按 500 处理且不暴露内部细节。 */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

function method(request: IncomingMessage, expected: string): void {
  if (request.method !== expected) throw new HttpError(405, `只支持 ${expected}`)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type 必须是 application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是有效 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** 允许的头像类型。不接受 SVG：内联脚本在小图片里也一样能执行。 */
const AVATAR_TYPES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
}

/**
 * 读取原始请求体。
 *
 * 与 `body()` 的区别是不解析 JSON，并额外在超过上限时立即中断：头像上传不能先把
 * 整个文件读进内存再判断大小。
 */
async function rawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, '图片太大了')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new HttpError(413, '图片太大了')
    chunks.push(buffer)
  }
  if (size === 0) throw new HttpError(400, '没有收到图片内容')
  return Buffer.concat(chunks)
}

/**
 * 按魔数核对图片类型。
 *
 * 只信字节不信声明：把 `.png` 换成 `.js` 再上传是常见做法，类型必须落到实处。
 */
function matchesImageSignature(bytes: Buffer, declared: string): boolean {
  if (bytes.length < 12) return false
  if (declared === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (declared === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (declared === 'image/webp') {
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

function stringField(input: Record<string, unknown>, name: string, max: number, required = true): string {
  const value = input[name]
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `缺少字段 ${name}`)
    return ''
  }
  if (typeof value !== 'string') throw new HttpError(400, `字段 ${name} 必须是字符串`)
  if (value.length > max) throw new HttpError(400, `字段 ${name} 过长`)
  return value
}

function integerField(input: Record<string, unknown>, name: string, fallback: number, max: number): number {
  const value = input[name]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new HttpError(400, `字段 ${name} 无效`)
  }
  return value
}

const ASSET_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/** 静态资源不做长期缓存，插件升级后页面不会继续引用旧脚本。 */
const NO_CACHE = 'no-cache'

/** 安装页面、接口与取消路由。 */
export async function installWeb(
  ctx: Context,
  config: Config,
  console_: ButlerConsole,
  access: Access,
): Promise<void> {
  const sourceHtml = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  // 页面里的 `/butler/...` 是包内默认前缀，部署改前缀时一并替换。
  // 配置注到 head 里而不是替换占位符：index.html 因此可以被浏览器直接打开预览。
  const injection = `<script>globalThis.__BUTLER_CONFIG__=${JSON.stringify({ routePrefix: config.routePrefix }).replaceAll('<', '\\u003c')};</script>`
  const html = sourceHtml
    .replaceAll('/butler', config.routePrefix)
    .replace('</head>', `${injection}</head>`)
  const assetRoot = fileURLToPath(new URL('../web/', import.meta.url))
  const { register, registerPublic } = createPluginHttp(ctx, {
    access,
    routePrefix: config.routePrefix,
    onError: (response, caught) => {
      const known = caught instanceof HttpError || isAccessError(caught)
      const status = known ? (caught as HttpError).status : 500
      if (!known) console.error('butler web request failed', caught)
      json(response, status, { error: known ? (caught as Error).message : '服务处理请求失败' })
    },
  })

  const respond = (actor: Actor, response: ServerResponse, status: number, value: unknown) => {
    access.assert(actor)
    json(response, status, value)
  }

  ctx.effect(() => registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/health`,
    handler: (_request, response) => json(response, 200, { ok: true }),
  }))
  ctx.effect(() => registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/ready`,
    handler: (request, response) => {
      try {
        method(request, 'GET')
        access.ready()
        json(response, 200, { ok: true })
      } catch (caught) {
        const known = caught instanceof HttpError || isAccessError(caught)
        json(response, known ? (caught as HttpError).status : 503, { error: known ? (caught as Error).message : '认证服务不可用' })
      }
    },
  }))

  // 页面本体。未登录时由 kit 重定向到登录页并带回跳地址。
  ctx.effect(() => register({
    kind: 'exact',
    path: config.routePrefix,
    surface: 'page',
    handler: (request, response) => {
      method(request, 'GET')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_CACHE })
      response.end(html)
    },
  }))

  // 静态资源：web/ 下的文件，打包后与 dist/ 同级。
  ctx.effect(() => register({
    kind: 'prefix',
    path: `${config.routePrefix}/assets`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const suffix = decodeURIComponent(url.pathname.slice(`${config.routePrefix}/assets`.length)).replace(/^\/+/, '')
      if (suffix === '') throw new HttpError(404, '资源不存在')
      const file = resolve(assetRoot, suffix)
      const local = relative(assetRoot, file)
      if (local.startsWith('..') || isAbsolute(local)) throw new HttpError(404, '资源不存在')
      let content: Buffer
      try {
        content = await readFile(file)
      } catch {
        throw new HttpError(404, '资源不存在')
      }
      access.assert(actor)
      response.writeHead(200, {
        'content-type': ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': NO_CACHE,
      })
      response.end(content)
    },
  }))

  // 身份：页面用它显示当前登录状态，不返回凭据。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/identity`,
    handler: (request, response, actor) => {
      method(request, 'GET')
      respond(actor, response, 200, {
        mode: access.mode,
        key: actorKey(actor),
        label: actor.namespace === 'standalone' ? '独立模式' : '已登录',
        authPath: '/auth',
      })
    },
  }))

  // 右栏：群成员。显示名已叠加该用户的本地别名，声明名单独返回保证可追溯。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/members`,
    handler: (request, response, actor) => {
      method(request, 'GET')
      respond(actor, response, 200, { items: console_.members(actor) })
    },
  }))

  // 兼容旧路径：与 /members 同源，字段较少。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/agents`,
    handler: (request, response, actor) => {
      method(request, 'GET')
      respond(actor, response, 200, { items: listAgentCards(ctx) })
    },
  }))

  // 保存一位成员的显示别名。空值表示恢复默认，会删除该行。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/members/alias`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const agentId = stringField(payload, 'agentId', 60).trim()
      if (agentId === '') throw new HttpError(400, '缺少 agentId')
      // 只允许给目录里真实存在的成员起别名，避免写出永远不显示的死配置。
      if (!listAgentCards(ctx).some(card => card.id === agentId)) throw new HttpError(404, '没有这个成员')
      console_.setAlias(actor, agentId, stringField(payload, 'displayName', 24, false), stringField(payload, 'accent', 9, false))
      respond(actor, response, 200, { items: console_.members(actor) })
    },
  }))

  /**
   * 上传成员头像。
   *
   * 直接收图片字节而不是 multipart：页面用 FileReader 读出来发过来就够了，省掉一个
   * 解析器。类型与大小在这里核验，不信任客户端声明的 content-type。
   */
  // 成员头像：读取走 GET，设置走 POST，清除走 DELETE。
  //
  // 三种方法合成**一个** exact 路由：宿主的 WebServer 要求 (kind, path) 唯一，同一路径注册
  // 两次会以 `webserver: duplicate exact route` 直接让插件装载失败、站点起不来。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/members/avatar`,
    handler: async (request, response, actor) => {
      if (request.method === 'DELETE') {
        const target = new URL(request.url ?? '/', 'http://localhost').searchParams.get('agentId')?.trim() ?? ''
        if (target === '') throw new HttpError(400, '缺少 agentId')
        console_.clearAvatar(actor, target)
        respond(actor, response, 200, { items: console_.members(actor) })
        return
      }
      // 读取头像：按当前登录用户鉴权，不能靠猜 id 读到别人的头像。
      if (request.method === 'GET') {
        const agentId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('agentId')?.trim() ?? ''
        const found = agentId === '' ? undefined : console_.avatar(actor, agentId)
        if (found === undefined) throw new HttpError(404, '没有设置头像')
        response.writeHead(200, {
          'content-type': found.contentType,
          'cache-control': 'private, max-age=60',
          'content-length': String(found.bytes.byteLength),
        })
        response.end(Buffer.from(found.bytes))
        return
      }
      method(request, 'POST')
      const agentId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('agentId')?.trim() ?? ''
      if (agentId === '' || !listAgentCards(ctx).some(card => card.id === agentId)) throw new HttpError(404, '没有这个成员')
      const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      const contentType = AVATAR_TYPES[declared]
      if (contentType === undefined) throw new HttpError(415, '头像只支持 PNG / JPEG / WebP')
      const bytes = await rawBody(request, config.maxAvatarBytes)
      if (!matchesImageSignature(bytes, declared)) throw new HttpError(415, '文件内容与图片格式不符')
      console_.setAvatar(actor, agentId, bytes, contentType)
      respond(actor, response, 200, { items: console_.members(actor) })
    },
  }))

  // 右栏：状态摘要与最近失败。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/overview`,
    handler: (request, response, actor) => {
      method(request, 'GET')
      respond(actor, response, 200, console_.overview(actor))
    },
  }))

  // 左栏：会话列表。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/conversations`,
    handler: (request, response, actor) => {
      method(request, 'GET')
      respond(actor, response, 200, { items: console_.listConversations(actor) })
    },
  }))

  // 左栏：运行历史。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/history`,
    handler: (request, response, actor) => {
      method(request, 'GET')
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      const state = params.get('state') ?? ''
      if (!['', 'queued', 'running', 'waiting_user', 'summarizing', 'completed', 'failed', 'cancelled'].includes(state)) {
        throw new HttpError(400, '状态筛选值无效')
      }
      respond(actor, response, 200, console_.history(actor, {
        offset: Number(params.get('offset') ?? '0'),
        limit: Number(params.get('limit') ?? '30'),
        keyword: (params.get('q') ?? '').trim(),
        state,
      }))
    },
  }))

  // 运行历史详情：一次任务的全部子任务与结果。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/task`,
    handler: (request, response, actor) => {
      method(request, 'GET')
      const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
      if (id === '') throw new HttpError(400, '缺少任务 id')
      respond(actor, response, 200, console_.task(actor, id))
    },
  }))

  // 停止当前这一轮。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/stop`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const conversationId = stringField(payload, 'conversationId', 200)
      console_.cancel(conversationId, actor)
      respond(actor, response, 200, { ok: true })
    },
  }))

  /**
   * 回应一位正在等你的成员。
   *
   * 与 `/chat` 一样走 SSE：回复之后那位成员会继续流式输出，页面接着往同一个气泡里追加。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/reply`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const taskId = stringField(payload, 'taskId', 80)
      const subtaskId = stringField(payload, 'subtaskId', 40)
      const decideByAgent = payload.decideByAgent === true
      const text = decideByAgent ? '' : stringField(payload, 'text', config.maxMessageChars).trim()
      if (!decideByAgent && text === '') throw new HttpError(400, '请先写点内容，或者让它自己拿主意')

      access.assert(actor)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      let closed = false
      const send = (value: unknown) => {
        if (closed || response.writableEnded || response.destroyed) return
        response.write(`data: ${JSON.stringify(value)}\n\n`)
      }
      response.once('close', () => { closed = true })
      try {
        for await (const event of console_.submitReply({ taskId, subtaskId, text, decideByAgent, actor })) {
          if (closed) break
          send(event)
        }
        if (!closed) {
          response.write('data: [DONE]\n\n')
          response.end()
        }
      } catch (caught) {
        const known = caught instanceof HttpError || isAccessError(caught)
        if (!known) console.error('butler reply failed', caught)
        if (!response.headersSent) {
          json(response, known ? (caught as HttpError).status : 500, { error: known ? (caught as Error).message : '服务处理请求失败' })
          return
        }
        send({ type: 'error', message: known ? (caught as Error).message : '服务处理请求失败' })
        if (!response.writableEnded) response.end()
      }
    },
  }))

  // 可用模型，供页面复用官方模型选择器。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/models`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const catalog = await conversationModelCatalog(ctx)
      access.assert(actor)
      respond(actor, response, 200, { groups: catalog.groups, failures: catalog.failures, default: catalog.selected })
    },
  }))

  /**
   * 对话主入口。
   *
   * 用 POST 带 SSE 响应体而不是 EventSource：请求要带 JSON 正文，响应要能被用户
   * 随时中断。断开连接时立即中止这一轮，不留后台任务。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/chat`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const message = stringField(payload, 'message', config.maxMessageChars).trim()
      if (message === '') throw new HttpError(400, '消息不能为空')
      const conversationId = stringField(payload, 'conversationId', 200)

      access.assert(actor)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      let closed = false
      const send = (value: unknown) => {
        if (closed || response.writableEnded || response.destroyed) return
        response.write(`data: ${JSON.stringify(value)}\n\n`)
      }
      response.once('close', () => {
        if (closed) return
        closed = true
        // 用户关掉页面或点停止：立刻中止这一轮，不继续消耗模型额度。
        try { console_.cancel(conversationId, actor) } catch { /* 会话可能已经不属于这个登录，忽略。 */ }
      })

      try {
        // 先告诉页面会话 id，新建会话时前端据此更新地址和左栏。
        send({ type: 'conversation', conversationId })
        for await (const event of console_.send(conversationId, message, actor)) {
          if (closed) break
          send(event)
        }
        if (!closed) {
          response.write('data: [DONE]\n\n')
          response.end()
        }
      } catch (caught) {
        const known = caught instanceof HttpError || isAccessError(caught)
        if (!known) console.error('butler chat failed', caught)
        if (!response.headersSent) {
          json(response, known ? (caught as HttpError).status : 500, { error: known ? (caught as Error).message : '服务处理请求失败' })
          return
        }
        send({ type: 'error', message: known ? (caught as Error).message : '服务处理请求失败' })
        if (!response.writableEnded) response.end()
      }
    },
  }))

  // 登录被撤销时中止仍在跑的任务，避免继续占用额度。
  //
  // `onRevoked` 只告诉有登录被撤销，不带会话归属；这里把所有活跃会话都中止一次是
  // 安全的：属于其他登录的会话本来就不会因为这次撤销而继续运行，而被撤销的那个
  // 恰好会停下来。真正的归属校验在每次访问时由 `access.assert` 完成。
  ctx.effect(() => onRevoked(ctx, () => { console_.cancelAll() }))
}
