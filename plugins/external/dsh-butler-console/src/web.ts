/**
 * 牛马大总管工作台的 HTTP 与 SSE 接口。
 *
 * 所有受保护路由都经过 kit 的 `createPluginHttp`，因此每次访问都会重新核对登录
 * 身份；只有 `/health` 和 `/ready` 是公开探针。
 *
 * 页面不需要知道任何配置值、Token 或内部路径：这里返回的卡片、状态和错误都已经
 * 裁剪成可展示内容。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { actorKey, createPluginHttp, isAccessError, onRevoked, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { conversationModelCatalog } from '@dsh-plugin-manager/plugin-kit/models'
import { listAgentCards } from './agents.ts'
import type { ButlerAttachments } from './attachments.ts'
import { TRANSCRIPT_MAX_ITEMS, type ButlerConsole, type RunWatch, type StartedRun } from './butler.ts'
import type { Config } from './config.ts'
import { canResume } from './event-log.ts'
import { FetchFailure, fetchPublicResource, htmlToText } from './fetch-url.ts'
import { StorageError } from './storage/errors.ts'

/**
 * 存储就绪探针结果（方案 §2.5）：启动序列（init → failInterrupted）缓存的布尔与 schema
 * 版本；未就绪时带稳定码。`/ready` 把它与 auth 就绪合并汇报，任一不可用都按 503 拒绝。
 *
 * 启动缓存只证明「装载时校验通过」；`probe` 在每次 /ready 时核实 PG **此刻**可达且版本
 * 仍符合（运行期翻转：已配置但运行中不可达 = 已装载未就绪，业务与 /ready 同口径 503）。
 */
export interface StorageReadiness {
  readonly ready: boolean
  readonly schemaVersion: number
  /** 未就绪时的稳定码（storage_unreachable / storage_schema_missing / storage_schema_version / storage_closed）。 */
  readonly code?: string
  /** 运行期探针（生产为 PostgresTaskStorage.readyProbe）；缺省表示该装配不做运行期核实。 */
  readonly probe?: () => Promise<void>
}

/**
 * 存储层故障到 HTTP 的映射（方案 §3 错误分类层）：
 *
 * - 可用性类（unreachable / auth / schema_missing / schema_version / timeout / closed）→ 503，
 *   稳定码进响应体；`storage_transaction`（可重试事务冲突）同样按临时不可用给 503；
 * - `storage_constraint`（唯一约束等）按业务冲突给 409；
 * - `storage_unknown` → 500，只给固定文案，不泄露连接串等内部信息；
 * - 版本冲突（version_conflict）在存储层就是 kit 的 AccessError(409)，走既有通道，不经这里。
 */
const STORAGE_STATUS: Record<string, { status: number; message?: string }> = {
  storage_unreachable: { status: 503 },
  storage_auth: { status: 503 },
  storage_schema_missing: { status: 503 },
  storage_schema_version: { status: 503 },
  storage_timeout: { status: 503 },
  storage_closed: { status: 503 },
  storage_transaction: { status: 503 },
  storage_constraint: { status: 409 },
  storage_unknown: { status: 500, message: '服务处理请求失败' },
}

/**
 * 只按 HTTP 语义给出的兜底码。
 *
 * 具体业务码由抛出处给出（例如 `missing_field`、`run_busy`）；给不出时用这些，
 * 客户端至少还能按类别分支。**客户端一律按 `code` 分支，不要解析 `error` 的文案** ——
 * 文案是给人看的，会改；错误码不是。
 */
const STATUS_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'too_many_requests',
  500: 'internal_error',
  503: 'unavailable',
}

/** 一次可预期的请求错误；其余异常统一按 500 处理且不暴露内部细节。 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 稳定错误码，缺省按 HTTP 状态归类。 */
    readonly errorCode: string = STATUS_CODES[status] ?? 'error',
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * 把一次失败归类成一个稳定的错误码。
 *
 * 三种来源依次降级：本插件自己给的业务码、kit 的 `AccessError` 带的业务码、以及按状态
 * 归类的兜底码。最后那种一定给得出东西，所以客户端永远有码可判。
 */
function errorCodeOf(caught: unknown, status: number): string {
  if (caught instanceof HttpError) return caught.errorCode
  // `reason` 是加法字段：跨独立打包的旧副本里可能没有，所以按值检查而不是相信类型。
  if (isAccessError(caught) && typeof (caught as { reason?: unknown }).reason === 'string') {
    const reason = (caught as { reason: string }).reason
    if (reason !== '') return reason
  }
  return STATUS_CODES[status] ?? 'error'
}

/**
 * 对外 HTTP 契约的版本号。
 *
 * **加字段不升版本**（老客户端忽略即可）；语义变化、字段改名或删除才 +1。`/identity` 会把它
 * 连同 `routePrefix` 一起返回，第二客户端据此发现入口，不必硬编码 `/butler` —— 那是部署配置，
 * 换个部署就可能不一样。
 *
 * 1 → 2（P1 记忆系统）：新增 `/memories` 系列端点（治理 CRUD/确认卡落点/导出/产品资产只读）。
 */
export const CONTRACT_VERSION = 2

function method(request: IncomingMessage, expected: string): void {
  if (request.method !== expected) throw new HttpError(405, `只支持 ${expected}`, 'method_not_allowed')
}

import { registerMemoryRoutes } from './web-memories.ts'

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type 必须是 application/json', 'unsupported_media_type')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new HttpError(413, '请求体过大', 'payload_too_large')
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是有效 JSON', 'invalid_body')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象', 'invalid_body')
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
 * 与 `body()` 的区别是不解析 JSON，并额外在超过上限时立即中断：上传不能先把整个文件读进内存
 * 再判断大小。`label` 只影响文案（头像说"图片"、附件说"文件"）。
 */
async function rawBody(request: IncomingMessage, limit: number, label = '内容'): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `${label}超出大小限制`, 'payload_too_large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new HttpError(413, `${label}超出大小限制`, 'payload_too_large')
    chunks.push(buffer)
  }
  if (size === 0) throw new HttpError(400, `没有收到${label}内容`, 'invalid_body')
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
    if (required) throw new HttpError(400, `缺少字段 ${name}`, 'missing_field')
    return ''
  }
  if (typeof value !== 'string') throw new HttpError(400, `字段 ${name} 必须是字符串`, 'invalid_field')
  if (value.length > max) throw new HttpError(400, `字段 ${name} 过长`, 'invalid_field')
  return value
}

function integerField(input: Record<string, unknown>, name: string, fallback: number, max: number): number {
  const value = input[name]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new HttpError(400, `字段 ${name} 无效`, 'invalid_field')
  }
  return value
}

/** 解析一个字符串数组字段（附件 id 列表）。缺省返回空数组；有非法项一律拒。 */
function stringArrayField(input: Record<string, unknown>, name: string, max: number): string[] {
  const value = input[name]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, `字段 ${name} 无效`, 'invalid_field')
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > 120) {
      throw new HttpError(400, `字段 ${name} 无效`, 'invalid_field')
    }
    items.push(item)
  }
  return items
}

/** 解析事件游标。必须是 0 或正整数；空白按「从头」处理。 */
function cursorField(value: string): number {
  const text = value.trim()
  if (text === '') return 0
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, '字段 after 必须是从 0 开始的整数', 'invalid_field')
  return parsed
}

/** 解析对话正文的每页条数；缺省一页 50。 */
function transcriptLimit(value: string | null): number {
  if (value === null || value.trim() === '') return 50
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > TRANSCRIPT_MAX_ITEMS) {
    throw new HttpError(400, `字段 limit 必须是 1 到 ${TRANSCRIPT_MAX_ITEMS} 之间的整数`, 'invalid_field')
  }
  return parsed
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

/**
 * URL 抓取接受的媒体类型前缀。
 *
 * 不收 `application/octet-stream`：那等于"什么都可以"，白名单也就没有意义了。要求对方说清楚
 * 自己是什么——说不清就拒，用户仍然可以把文件下载下来再上传。
 */
const FETCH_MEDIA_TYPES = [
  'image/',
  'text/',
  'application/pdf',
  'application/json',
  'application/xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const

/** 抓取失败 → HTTP 状态。`code` 原样进响应的 `code` 字段，客户端按它分支。 */
const FETCH_STATUS: Record<string, number> = {
  url_invalid: 400,
  dns_failed: 502,
  unreachable: 502,
  http_error: 502,
  too_large: 413,
  unsupported_type: 415,
  redirect_refused: 502,
}

/** 安装页面、接口与取消路由。 */
export async function installWeb(
  ctx: Context,
  config: Config,
  console_: ButlerConsole,
  access: Access,
  storageReady: StorageReadiness,
): Promise<void> {
  // 附件服务从这一份应用对象上取，不另开一个参数：路由只是它的一个入口，另造实例等于让
  // 两处各持一份状态。`console_` 本身要在上面构造时就绪，所以这里直接读。
  const attachments: ButlerAttachments = console_.attachments
  // 前端双轨开关（React 迁移，方案 §3.1 唯一定型的信号）：dist/web/app.css 只由
  // React 构建链（tsdown.web-react + tailwindcss）产出，且两条构建链都以 dist/web
  // 为清空再产出的目录——构建哪个前端，那里就只有哪个前端的产物。以此选页面骨架，
  // 切一次构建即切前端，这里不需要自己的开关配置。
  const reactSkeleton = existsSync(fileURLToPath(new URL('../dist/web/app.css', import.meta.url)))
  const sourceHtml = await readFile(new URL(reactSkeleton ? '../web-react/index.html' : '../web/index.html', import.meta.url), 'utf8')
  // 页面里的 `/butler/...` 是包内默认前缀，部署改前缀时一并替换。
  // 配置注到 head 里而不是替换占位符：index.html 因此可以被浏览器直接打开预览。
  //
  // `historyPageSize` 一并注进去，页面就不必猜服务端的上限：它曾经写死 40，而默认上限是 30，
  // 于是左栏每次拉历史都被服务端按 `history_query_invalid` 拒掉，页面只显示「读取记录失败」。
  // 上限是部署配置，唯一的来源只能是服务端。
  const pageConfig = {
    routePrefix: config.routePrefix,
    historyPageSize: config.maxHistoryPageSize,
    chatPageSize: config.conversationsPageSize,
    // 附件的上限一并注进去：页面要在**选文件之前**就知道能传多大，等传上去被服务端 413 拒掉
    // 才发现，那已经是白等一次上传了。头像上限写死在前端是一处既有不一致，这里不重犯。
    maxAttachmentBytes: config.maxAttachmentBytes,
    maxAttachmentsPerMessage: config.maxAttachmentsPerMessage,
  }
  const injection = `<script>globalThis.__BUTLER_CONFIG__=${JSON.stringify(pageConfig).replaceAll('<', '\\u003c')};</script>`
  const html = sourceHtml
    .replaceAll('/butler', config.routePrefix)
    .replace('</head>', `${injection}</head>`)
  const assetRoot = fileURLToPath(new URL('../web/', import.meta.url))
  const { register, registerPublic } = createPluginHttp(ctx, {
    access,
    routePrefix: config.routePrefix,
    onError: (response, caught) => {
      // 存储层故障先按稳定码归类（§3 错误分类层），可用性类 503、约束冲突 409、未知 500
      // 且不泄露连接信息；文案沿用 StorageError 的固定描述（不含连接串）。
      if (caught instanceof StorageError) {
        const mapped = STORAGE_STATUS[caught.code] ?? STORAGE_STATUS.storage_unknown!
        if (mapped.status >= 500) console.error('butler web storage failed', caught)
        json(response, mapped.status, {
          error: mapped.message ?? caught.message,
          code: caught.code,
        })
        return
      }
      const known = caught instanceof HttpError || isAccessError(caught)
      const status = known ? (caught as HttpError).status : 500
      if (!known) console.error('butler web request failed', caught)
      // `error` 是给人看的，`code` 是给客户端分支用的；两个都在，谁也不用去猜另一个。
      json(response, status, {
        error: known ? (caught as Error).message : '服务处理请求失败',
        code: errorCodeOf(caught, status),
      })
    },
  })

  const respond = (actor: Actor, response: ServerResponse, status: number, value: unknown) => {
    access.assert(actor)
    json(response, status, value)
  }

  /**
   * 重复提交但原来那一轮没有可回放的记录时，如实回答，**不重跑**。
   *
   * 响应里带上原凭据：客户端要拿 `conversationId` 去读任务快照，拿 `runId` 去对上自己那一次
   * 提交。丢开凭据只说一句「已经处理过了」，客户端就无从下手了。
   *
   * @returns 是否已经作答（true 时调用方应当直接返回，不要再开事件流）。
   */
  const reportUnknownRun = (actor: Actor, response: ServerResponse, started: StartedRun): boolean => {
    if (started.unknown !== true) return false
    respond(actor, response, 409, {
      error: started.message ?? '这次提交的结果不明，不会重新执行',
      code: started.unknownCode ?? 'run_result_unknown',
      runId: started.runId,
      conversationId: started.conversationId,
    })
    return true
  }

  /**
   * 把一条观察写进 SSE 响应。
   *
   * 提交、补话、只读订阅三条路径共用这一段：它们对「怎么发」的要求完全一样，区别只在
   * 从哪一轮、从哪个游标开始。**连接关闭只会结束这一次观察**，后台那一轮该跑还是跑。
   *
   * `watch` 收一个中止信号而不是现成的事件流，因为「客户端断线」这件事要在建流的那一刻
   * 就接上：否则断开之后这条响应会一直等到下一个事件才醒过来。
   */
  const streamRun = async (input: {
    readonly response: ServerResponse
    readonly after: number
    readonly watch: (signal: AbortSignal) => Promise<RunWatch | undefined>
    readonly preamble?: Record<string, unknown>
  }): Promise<void> => {
    const { response, after, watch, preamble } = input
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // 反向代理默认会缓冲响应体，那会把整条流攒成一坨再发，边收边上就不发生了。
      'x-accel-buffering': 'no',
    })
    const detached = new AbortController()
    let closed = false
    const send = (value: unknown) => {
      if (closed || response.writableEnded || response.destroyed) return
      // 流式诊断（方案 S01）：HTTP **写出**点，与应用入队（butler.ts pump）区分开，两者
      // 的间隔就是队列与连接造成的滞留。时间为服务端墙钟。
      if (process.env.BUTLER_STREAM_DEBUG === '1' && typeof value === 'object' && value !== null) {
        const logged = value as { type?: unknown; seq?: unknown; runId?: unknown }
        console.debug('butler-stream server-write', {
          type: String(logged.type ?? ''), seq: logged.seq ?? null, runId: logged.runId ?? null,
          len: JSON.stringify(value).length, t: Date.now(),
        })
      }
      response.write(`data: ${JSON.stringify(value)}\n\n`)
    }
    const done = () => {
      if (closed) return
      response.write('data: [DONE]\n\n')
      response.end()
    }
    response.once('close', () => {
      closed = true
      // 叫醒还在等事件的订阅：断线只该结束这一次观察，不该让响应挂在内存里。
      detached.abort()
    })
    if (preamble !== undefined) send(preamble)

    const ready = await watch(detached.signal)
    if (ready === undefined) {
      // 没有可观察的一轮：如实说明，让调用方自己决定是等还是去读历史。
      send({ type: 'run', runId: '', state: 'idle', startedAt: 0, finishedAt: null, taskId: '' })
      done()
      return
    }

    const { head, events } = ready
    // 游标落在窗口之前：中间的事件确实已经没了，如实要求重取快照，不假装补齐。
    if (!canResume(head, after)) {
      send({
        type: 'reset',
        runId: head.runId,
        seq: head.seq,
        windowStart: head.windowStart,
        reason: '这一轮的早期事件已经滚出窗口，请重新获取任务快照',
      })
      done()
      return
    }

    send({
      type: 'run',
      runId: head.runId,
      state: head.state,
      startedAt: head.startedAt,
      finishedAt: head.finishedAt,
      taskId: head.taskId,
    })
    try {
      for await (const logged of events) {
        if (closed) break
        // 每条都带游标：客户端断线后从这里接着要，才知道自己读到哪儿了。
        send({ ...logged.event, seq: logged.seq, runId: logged.runId })
      }
    } catch (caught) {
      // 通道自己坏了不能静默：读者会以为「任务没动静」，而其实是流断了。
      if (!closed) {
        console.error('butler events stream failed', caught)
        send({ type: 'error', message: '事件流中断，请重新打开页面', code: 'stream_broken' })
      }
    }
    done()
  }

  ctx.effect(() => registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/health`,
    handler: (_request, response) => json(response, 200, { ok: true }),
  }))
  ctx.effect(() => registerPublic({
    kind: 'exact',
    path: `${config.routePrefix}/ready`,
    handler: async (request, response) => {
      try {
        method(request, 'GET')
        access.ready()
        // 存储就绪（§2.5）：auth 可用但存储未就绪同样是 503，带稳定码；两者都可用时把
        // schema 版本一并汇报，运维区分「服务没起来」与「结构版本不对」。
        if (!storageReady.ready) {
          json(response, 503, {
            error: '工作台存储未就绪',
            code: storageReady.code ?? 'storage_unknown',
            schemaVersion: storageReady.schemaVersion,
          })
          return
        }
        // 运行期翻转（§2.5）：启动缓存只说明「装载过」；此刻是否服务由探针回答。探针失败
        // 按稳定码 503（StorageError 的固定描述不含连接串等内部信息），兜住任何抛错，
        // 不把连接细节外泄到公开探针。
        if (storageReady.probe !== undefined) {
          try {
            await storageReady.probe()
          } catch (probeError) {
            const code = probeError instanceof StorageError ? probeError.code : 'storage_unknown'
            json(response, 503, {
              error: probeError instanceof StorageError ? probeError.message : '工作台存储此刻不可用',
              code,
              schemaVersion: storageReady.schemaVersion,
            })
            return
          }
        }
        json(response, 200, { ok: true, storage: { ready: true, schemaVersion: storageReady.schemaVersion } })
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

  // 静态资源：web/ 下的文件，打包后与 dist/ 同级。入口脚本 app.js 例外：浏览器不解析
  // 裸包名（markdown-it 等依赖），走 tsdown.web 的打包产物 dist/web/app.js——与
  // dsh-example 服务 dist/web 入口是同一模式。
  const entryBundle = fileURLToPath(new URL('../dist/web/app.js', import.meta.url))
  // React 前端的样式单文件（Tailwind v4 产物），与 app.js 同一套 /assets 特例；
  // 旧前端没有这个文件，请求会落进下面的 readFile 404，行为安全。
  const appStyles = fileURLToPath(new URL('../dist/web/app.css', import.meta.url))
  ctx.effect(() => register({
    kind: 'prefix',
    path: `${config.routePrefix}/assets`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const suffix = decodeURIComponent(url.pathname.slice(`${config.routePrefix}/assets`.length)).replace(/^\/+/, '')
      if (suffix === '') throw new HttpError(404, '资源不存在', 'asset_not_found')
      let file: string
      if (suffix === 'app.js') {
        file = entryBundle
      } else if (suffix === 'app.css') {
        file = appStyles
      } else {
        file = resolve(assetRoot, suffix)
        const local = relative(assetRoot, file)
        if (local.startsWith('..') || isAbsolute(local)) throw new HttpError(404, '资源不存在', 'asset_not_found')
      }
      let content: Buffer
      try {
        content = await readFile(file)
      } catch {
        throw new HttpError(404, '资源不存在', 'asset_not_found')
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
  //
  // 顺带回答「入口在哪、契约是哪一版、分页上限是多少」：这些是部署配置，第二客户端不该把它写死；
  // 三个字段都是新增的，老客户端忽略即可。
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
        routePrefix: config.routePrefix,
        contractVersion: CONTRACT_VERSION,
        historyPageSize: config.maxHistoryPageSize,
    chatPageSize: config.conversationsPageSize,
        // 页面上限从服务端取：写死一个比服务端小的值会白跑一次上传，写大则被 413 拒。
        maxAttachmentBytes: config.maxAttachmentBytes,
        maxAttachmentsPerMessage: config.maxAttachmentsPerMessage,
      })
    },
  }))

  // 右栏：群成员。显示名已叠加该用户的本地别名，声明名单独返回保证可追溯。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/members`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      respond(actor, response, 200, { items: await console_.members(actor) })
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
      if (agentId === '') throw new HttpError(400, '缺少 agentId', 'missing_field')
      // 只允许给目录里真实存在的成员起别名，避免写出永远不显示的死配置。
      if (!listAgentCards(ctx).some(card => card.id === agentId)) throw new HttpError(404, '没有这个成员', 'member_not_found')
      await console_.setAlias(actor, agentId, stringField(payload, 'displayName', 24, false), stringField(payload, 'accent', 9, false))
      respond(actor, response, 200, { items: await console_.members(actor) })
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
        if (target === '') throw new HttpError(400, '缺少 agentId', 'missing_field')
        await console_.clearAvatar(actor, target)
        respond(actor, response, 200, { items: await console_.members(actor) })
        return
      }
      // 读取头像：按当前登录用户鉴权，不能靠猜 id 读到别人的头像。
      if (request.method === 'GET') {
        const agentId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('agentId')?.trim() ?? ''
        const found = agentId === '' ? undefined : await console_.avatar(actor, agentId)
        if (found === undefined) throw new HttpError(404, '没有设置头像', 'avatar_not_found')
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
      if (agentId === '' || !listAgentCards(ctx).some(card => card.id === agentId)) throw new HttpError(404, '没有这个成员', 'member_not_found')
      const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      const contentType = AVATAR_TYPES[declared]
      if (contentType === undefined) throw new HttpError(415, '头像只支持 PNG / JPEG / WebP', 'unsupported_media_type')
      const bytes = await rawBody(request, config.maxAvatarBytes, '图片')
      if (!matchesImageSignature(bytes, declared)) throw new HttpError(415, '文件内容与图片格式不符', 'unsupported_media_type')
      await console_.setAvatar(actor, agentId, bytes, contentType)
      respond(actor, response, 200, { items: await console_.members(actor) })
    },
  }))

  // 右栏：状态摘要与最近失败。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/overview`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      respond(actor, response, 200, await console_.overview(actor))
    },
  }))

  /**
   * 附件：上传走 POST，下载走 GET，删除走 DELETE。
   *
   * 三种方法合成**一个** exact 路由，理由与头像那条一样：宿主的 WebServer 要求 (kind, path)
   * 唯一，同一路径注册两次会以 `webserver: duplicate exact route` 让插件装载失败。
   *
   * 正文是**裸文件字节**，不是 multipart：省掉一个解析器，也避免把整个文件 base64 一遍
   * （base64 会让内存占用涨三分之一，还多一次编解码）。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/attachments`,
    handler: async (request, response, actor) => {
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      if (request.method === 'GET') {
        const id = (params.get('id') ?? '').trim()
        if (id === '') throw new HttpError(400, '缺少附件 id', 'missing_field')
        const found = await attachments.download(actor, id)
        response.writeHead(200, {
          'content-type': found.mediaType === '' ? 'application/octet-stream' : found.mediaType,
          'content-length': String(found.bytes.byteLength),
          // 下载而不是内联打开：附件是用户自己传上来的东西，别让浏览器猜它的类型去执行它。
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=60',
        })
        response.end(Buffer.from(found.bytes))
        return
      }
      if (request.method === 'DELETE') {
        const id = (params.get('id') ?? '').trim()
        if (id === '') throw new HttpError(400, '缺少附件 id', 'missing_field')
        await attachments.remove(actor, id)
        respond(actor, response, 200, { ok: true })
        return
      }
      method(request, 'POST')
      const name = (params.get('name') ?? '').trim()
      if (name === '') throw new HttpError(400, '缺少文件名', 'missing_field')
      const conversationId = (params.get('conversationId') ?? '').trim()
      const declared = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      const bytes = await rawBody(request, config.maxAttachmentBytes, '文件')
      const item = await attachments.upload(actor, {
        name,
        bytes,
        ...(declared === '' ? {} : { mediaType: declared }),
        conversationId,
      })
      respond(actor, response, 200, { item })
    },
  }))

  /**
   * 从 URL 取一个附件。
   *
   * 与上传分开一条路由：那条收的是裸字节，这条收 JSON。抓取本身在 `fetch-url.ts`——地址先校验
   * 再钉住、不跟跨源跳转、只接未压缩的响应、字节与时间都有上限。
   *
   * 网页（`text/html`）在这里就地剥成纯文本再存：原始 HTML 对模型来说是几千行标签噪声，
   * 真正有用的那几段埋在中间。剥得粗，这一点在 `htmlToText` 的注释里写明了。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/attachments/url`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const url = stringField(payload, 'url', 2048).trim()
      if (url === '') throw new HttpError(400, '请填写地址', 'missing_field')
      const conversationId = stringField(payload, 'conversationId', 200, false).trim()
      access.assert(actor)

      let fetched
      try {
        fetched = await fetchPublicResource(url, {
          maxBytes: config.maxAttachmentBytes,
          timeoutMs: config.attachmentFetchTimeoutMs,
          allowedMediaTypes: FETCH_MEDIA_TYPES,
        })
      } catch (error) {
        if (error instanceof FetchFailure) {
          throw new HttpError(
            FETCH_STATUS[error.code] ?? 502,
            error.message,
            `attachment_fetch_${error.code}`,
          )
        }
        throw error
      }

      let { name, mediaType, bytes } = fetched
      if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
        const text = htmlToText(Buffer.from(bytes).toString('utf8'))
        bytes = new Uint8Array(Buffer.from(text, 'utf8'))
        name = `${name.replace(/\.[^.]*$/u, '')}.txt`
        mediaType = 'text/plain'
      }
      const item = await attachments.uploadFromUrl(actor, {
        url: fetched.url,
        name,
        mediaType,
        bytes,
        conversationId,
      })
      respond(actor, response, 200, { item })
    },
  }))

  /**
   * 这个会话下还没删除的附件。
   *
   * 页面刷新后靠它把输入框上方的附件条重建出来——附件是服务端的事实，不能只活在页面的内存里。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/attachments/list`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      respond(actor, response, 200, { items: await attachments.list(actor, (params.get('conversationId') ?? '').trim()) })
    },
  }))

  /**
   * 对话正文：按当前登录身份读出这段会话里用户可见的消息。
   *
   * 第二入口要能拿到老板的原话与管家的答复才真的接得上；只有任务级摘要，跨入口继续处理
   * 就没有依据。正文**不另存一份** —— 它本来就是 DSH 官方会话日志的内容，这里只是鉴权后
   * 读出来；日志不存在或读不到时如实报错，不拿任务摘要冒充一段完整对话。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/transcript`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      const conversationId = (params.get('conversationId') ?? '').trim()
      if (conversationId === '') throw new HttpError(400, '缺少 conversationId', 'missing_field')
      const after = cursorField(params.get('after') ?? '')
      const limit = transcriptLimit(params.get('limit'))
      // 尾读模式（C 批历史阅读）：tail 取最新一页，before 取该序号之前更早的一页；两者互斥。
      const tail = params.get('tail') === '1'
      const beforeText = params.get('before')
      if (tail && beforeText !== null) throw new HttpError(400, 'tail 与 before 不能同时使用', 'invalid_field')
      const options: { before?: number; tail?: boolean } = {}
      if (tail) options.tail = true
      if (beforeText !== null) options.before = cursorField(beforeText)
      access.assert(actor)
      respond(actor, response, 200, await console_.transcript(conversationId, actor, after, limit, options))
    },
  }))

  // 左栏：会话列表（分页，0.12.4）。`offset` 缺省 0；响应带 `total` 供分页控件计算页数。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/conversations`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      const offset = Number(params.get('offset') ?? '0')
      // 0.12.5：limit 由前端在搜索（全量拉取再本地过滤）时显式给出；浏览态缺省用配置页大小。
      const limitParam = params.get('limit')
      const limit = limitParam === null ? undefined : Number(limitParam)
      respond(actor, response, 200, await console_.listConversations(actor, offset, limit))
    },
  }))

  // 左栏：改会话标题（管理操作「重命名」，仅前端单选时可用）。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/conversations/rename`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const id = stringField(payload, 'id', 60).trim()
      if (id === '') throw new HttpError(400, '缺少 id', 'missing_field')
      await console_.renameConversation(actor, id, stringField(payload, 'title', 200))
      respond(actor, response, 200, { items: (await console_.listConversations(actor, 0)).items, ok: true })
    },
  }))

  // 左栏：删除会话（单条/批量）。围栏逐条返回 removed / alreadyRemoved / blocked / failed，
  // 页面按结果提示；忙检查在围栏内（管家轮次 + 宿主侧占用），这里只做形状校验。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/conversations/remove`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const raw = payload.ids
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) throw new HttpError(400, 'ids 必须是 1-50 个会话编号', 'remove_ids_invalid')
      const ids = raw.map(item => String(item).trim())
      if (ids.some(id => id.length === 0 || id.length > 80)) throw new HttpError(400, 'ids 含无效会话编号', 'remove_ids_invalid')
      respond(actor, response, 200, { results: await console_.deleteConversations(actor, ids) })
    },
  }))

  // 右栏：删除一条失败记录（终态任务）。活跃任务 409，让页面提示先停止。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/tasks/remove`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const id = stringField(payload, 'id', 60).trim()
      if (id === '') throw new HttpError(400, '缺少 id', 'missing_field')
      await console_.deleteTask(actor, id)
      respond(actor, response, 200, { ok: true })
    },
  }))

  // 左栏：运行历史。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/history`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      const state = params.get('state') ?? ''
      if (!['', 'queued', 'running', 'waiting_user', 'summarizing', 'external_pending', 'partial', 'completed', 'failed', 'cancelled'].includes(state)) {
        throw new HttpError(400, '状态筛选值无效', 'history_query_invalid')
      }
      respond(actor, response, 200, await console_.history(actor, {
        offset: Number(params.get('offset') ?? '0'),
        limit: Number(params.get('limit') ?? '30'),
        keyword: (params.get('q') ?? '').trim(),
        state,
        conversationId: (params.get('conversationId') ?? '').trim(),
      }))
    },
  }))

  // 运行历史详情：一次任务的全部子任务与结果。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/task`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
      if (id === '') throw new HttpError(400, '缺少任务 id', 'missing_field')
      respond(actor, response, 200, await console_.task(actor, id))
    },
  }))

  // 停止当前这一轮。
  //
  // `taskId` 可选：给了就只中止这一轮确实在跑那个任务的情况，旧任务迟到的取消请求
  // 不会碰到该会话随后开的新任务。`accepted` 只表示中止请求发出去了，不代表执行已停。
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/stop`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const conversationId = stringField(payload, 'conversationId', 200)
      const taskId = stringField(payload, 'taskId', 80, false).trim()
      const outcome = await console_.cancel(conversationId, actor, taskId)
      respond(actor, response, 200, {
        ok: true,
        accepted: outcome.accepted,
        ...(outcome.reason === '' ? {} : { reason: outcome.reason }),
      })
    },
  }))

  /**
   * 只读订阅：观察一个会话最近一轮的事件。
   *
   * 与 `/chat` 的区别是它**不启动任何执行**，所以第二个入口可以拿它跟同一轮，
   * 不会把任务重跑一遍。断线只是这一个观察者不再读，其他观察者和执行都不受影响。
   *
   * `after` 是上一次收到的最后一条事件的 `seq`。不传表示只看从现在开始的新事件；
   * 传了但已经滚出窗口时，会收到一条 `reset`，要求重新取任务快照 —— 中间的事件
   * 确实没有了，不假装补齐。
   *
   * 带 `probe=1` 时只回答「现在有没有在跑的一轮」，用 JSON 而不是事件流。想接上一轮
   * 之前先问一句，可以避免为一个根本没在跑的任务把整轮事件重新拉一遍。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/events`,
    handler: async (request, response, actor) => {
      method(request, 'GET')
      const params = new URL(request.url ?? '/', 'http://localhost').searchParams
      const conversationId = (params.get('conversationId') ?? '').trim()
      if (conversationId === '') throw new HttpError(400, '缺少 conversationId', 'missing_field')

      if (params.get('probe') === '1') {
        respond(actor, response, 200, { run: (await console_.watch(conversationId, actor, 0))?.head ?? null })
        return
      }

      const requested = params.get('after')
      access.assert(actor)
      // 先取一次头部才知道「现在」在哪；这个探测用的生成器没有被消费，不会执行。
      const probe = await console_.watch(conversationId, actor, 0)
      const after = requested === null ? (probe?.head.seq ?? 0) : cursorField(requested)
      await streamRun({
        response,
        after,
        watch: async signal => await console_.watch(conversationId, actor, after, signal),
      })
    },
  }))

  /**
   * 回应一位正在等你的成员。
   *
   * 与 `/chat` 一样：受理走一遍校验，执行在后台跑，连接只负责把事件推给这个观察者。
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
      if (!decideByAgent && text === '') throw new HttpError(400, '请输入内容，或留空让管家决定', 'reply_text_missing')

      access.assert(actor)
      const started = await console_.startReply({
        taskId, subtaskId, text, decideByAgent, actor,
        requestId: stringField(payload, 'requestId', 120, false).trim(),
      })
      if (reportUnknownRun(actor, response, started)) return
      await streamRun({
        response,
        after: started.from,
        watch: async signal => await console_.watch(started.conversationId, actor, started.from, signal),
      })
    },
  }))

  /**
   * 对一条待确认操作做决策（就地确认 / 取消）。
   *
   * 与 `/reply` 同一套语义：受理走一遍校验，执行在后台跑，连接只把事件推给这个观察者。
   * 请求体里**没有凭据**：确认凭据留在执行方自己的记录里，协调方只转交"用户点了确认"这件事。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/action`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const taskId = stringField(payload, 'taskId', 80)
      const subtaskId = stringField(payload, 'subtaskId', 40)
      const actionId = stringField(payload, 'actionId', 120)
      const decision = payload.decision === 'cancel' ? 'cancel' : 'confirm'
      const note = stringField(payload, 'note', 500, false).trim()

      access.assert(actor)
      const started = await console_.startAction({
        taskId, subtaskId, actionId, decision, actor,
        ...(note === '' ? {} : { note }),
        requestId: stringField(payload, 'requestId', 120, false).trim(),
      })
      if (reportUnknownRun(actor, response, started)) return
      await streamRun({
        response,
        after: started.from,
        watch: async signal => await console_.watch(started.conversationId, actor, started.from, signal),
      })
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
   * 补充当前这一轮的目标。
   *
   * 与 `/chat`（开新的一轮）、`/reply`（回答成员的问题）是三件事：把补充塞进 `/chat` 会另开
   * 一轮，任务记录就此分家；塞进 `/reply` 会被当成对某位成员的回答。这里改的是**当前这一轮**，
   * 新活追加到同一个任务里。
   *
   * `expectVersion` 是并发依据：两个入口同时改同一轮时，后提交的那个会被拒，而不是让两份
   * 补充互相覆盖。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/supplement`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const taskId = stringField(payload, 'taskId', 80)
      const text = stringField(payload, 'text', config.maxMessageChars).trim()
      if (text === '') throw new HttpError(400, '补充内容不能为空', 'message_empty')
      const requestId = stringField(payload, 'requestId', 120, false).trim()
      const expectVersion = payload.expectVersion === undefined
        ? undefined
        : integerField(payload, 'expectVersion', 0, Number.MAX_SAFE_INTEGER)

      access.assert(actor)
      const started = await console_.submitSupplement({
        taskId,
        text,
        actor,
        ...(requestId === '' ? {} : { requestId }),
        ...(expectVersion === undefined ? {} : { expectVersion }),
      })
      if (reportUnknownRun(actor, response, started)) return
      await streamRun({
        response,
        after: started.from,
        watch: async signal => await console_.watch(started.conversationId, actor, started.from, signal),
      })
    },
  }))

  /**
   * 对话主入口。
   *
   * 用 POST 带 SSE 响应体而不是 EventSource：请求要带 JSON 正文，响应要能被随时中断。
   *
   * 但**中断连接不再等于取消这一轮**：提交之后任务由后台继续跑，事件进会话日志。
   * 关掉页面、切到另一个入口、断网，都只是这个观察者不再读；想真停下来要显式调
   * `/stop`。这样「游戏里派了活就关页面」才不会把活掐掉。
   */
  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/chat`,
    handler: async (request, response, actor) => {
      method(request, 'POST')
      const payload = await body(request, config.maxRequestBodyBytes)
      const message = stringField(payload, 'message', config.maxMessageChars).trim()
      if (message === '') throw new HttpError(400, '消息不能为空', 'message_empty')
      const conversationId = stringField(payload, 'conversationId', 200)
      // 附件是**加字段**：老客户端不带它，行为与原来逐字一致。加字段不升契约版本（见文件头）。
      const attachmentIds = stringArrayField(payload, 'attachmentIds', config.maxAttachmentsPerMessage)

      access.assert(actor)
      // 受理与执行分开：这一步之后谁断线都不影响这一轮继续跑完。
      // `requestId` 让重试拿到同一轮，而不是把同一条需求再派一次。
      const started = await console_.start(
        conversationId,
        message,
        actor,
        stringField(payload, 'requestId', 120, false).trim(),
        attachmentIds,
      )
      if (reportUnknownRun(actor, response, started)) return
      await streamRun({
        response,
        after: started.from,
        watch: async signal => await console_.watch(started.conversationId, actor, started.from, signal),
        preamble: { type: 'conversation', conversationId: started.conversationId },
      })
    },
  }))

  // 登录被撤销时中止仍在跑的任务，避免继续占用额度。
  //
  // `onRevoked` 只告诉有登录被撤销，不带会话归属；这里把所有活跃会话都中止一次是
  // 安全的：属于其他登录的会话本来就不会因为这次撤销而继续运行，而被撤销的那个
  // 恰好会停下来。真正的归属校验在每次访问时由 `access.assert` 完成。
  ctx.effect(() => onRevoked(ctx, () => { console_.cancelAll() }))

  // 记忆治理（v2.6 设计 §4.6/§6.2 步骤 5）：三分区 CRUD + 轻摘要 + 确认卡落点 + 导出 +
  // 产品资产只读。未配置记忆存储时不注册（前端 summary 404 时隐藏右栏摘要即可）。
  if (console_.memories !== undefined) {
    registerMemoryRoutes({
      memories: console_.memories,
      routePrefix: config.routePrefix,
      maxRequestBodyBytes: config.maxRequestBodyBytes,
      register,
      method,
      body: (request, limit) => body(request, limit),
      stringField,
      json,
      pendingForgets: console_.pendingForgets,
    })
  }
}
