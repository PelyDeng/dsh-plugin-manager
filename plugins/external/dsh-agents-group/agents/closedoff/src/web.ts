/** Dedicated HTTP and SSE surface for business users. */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { agentResource, agentResourcePath } from '@dsh-agents-group/common'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Conversation, ConversationLifecycle } from '../../../packages/runtime/src/conversation.ts'
import type { ConversationPort, RemovalResultShape } from '../../../packages/runtime/src/storage/ports.ts'
import type { AssistantDelta } from '../../../packages/runtime/src/index.ts'
import { onAssistantDelta } from '../../../packages/runtime/src/index.ts'
import type { Config } from './config.ts'
import { fencesFromResult, isFenceTool } from './fences.ts'
import {
  collectOpaqueResultValues,
  extractCards,
  extractDeviceGroups,
  emptyCardsPayload,
  extractTrackDeviceGroupsFromResult,
  extractTrackPointsFromResult,
  extractTrackVehicleNoFromResult,
  extractVehicleMediaFromResult,
  filterDeviceGroupsNearTrack,
  gatewayResultFailed,
  projectHistory,
  reasoningBlocks,
  textBlocks,
  turnUsageSummary,
  presentationDescriptor,
  projectReasoning,
  type TrackDeviceGroup,
  type TrackPoint,
} from './presentation.ts'
import { redactVisibleText } from './redaction.ts'
import { TOOL_BY_NAME } from './specs.ts'
import { isAccessError, createPluginHttp, actorKey, onRevoked, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function method(req: IncomingMessage, expected: string): void {
  if (req.method !== expected) throw new HttpError(405, `只支持 ${expected}`)
}

async function body(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type 必须是 application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error: unknown) {
    throw new HttpError(400, `请求体不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/**
 * 把子包抛出的错误渲染成响应。
 *
 * 导出给群组注入到 HTTP 注册器上：只有本子包知道哪些错误是可预期的（参数校验失败应当
 * 400、鉴权失败应当 401/403）。用通用的 500 兜底会让前端无法区分「用户输错了」和
 * 「服务炸了」。
 */
export function renderHttpError(res: ServerResponse, caught: unknown): void {
  const expected = caught instanceof HttpError || isAccessError(caught)
  const status = expected ? (caught as HttpError).status : 500
  if (!expected) console.error('closedoff-assistant web request failed', caught)
  const message = expected ? (caught as Error).message : '服务处理请求失败'
  json(res, status, { error: message })
}

function error(res: ServerResponse, caught: unknown): void {
  renderHttpError(res, caught)
}

function presentationValue(meta: unknown): unknown {
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'value' in meta
    ? (meta as Record<string, unknown>).value
    : undefined
}

/**
 * 页面入口用到的运行时能力。
 *
 * 三项都是**可选**的：存储未就绪（缺 PG 配置或连不上）时装配不会产出运行时，而页面本身
 * 照常装载、探针照常报未就绪。所以每个业务端点在使用前都要显式回答"没有运行时该怎么办"——
 * 这里统一给 503 并说明原因，而不是让一个 `undefined` 在深处变成 `TypeError`（那会报成 500，
 * 前端分不清"服务炸了"与"这个 Agent 没起来"）。
 */
export interface WebRuntimeDeps {
  readonly lifecycle?: ConversationLifecycle | undefined
  readonly store?: ConversationPort | undefined
  /**
   * 侧栏入口（kit 的 `ConversationProvider`）；页面上的"删除"走它，与侧栏是同一道围栏
   * （`storage/adapter.ts` 是唯一的移除装配点）。
   *
   * 只声明用到的那一个方法：本文件不需要 `list` / `preview`（页面自己有 `/conversations`
   * 与 `/history` 两个走端口的端点）。写全接口会把"页面依赖侧栏入口的哪一部分"藏起来。
   */
  readonly provider?: {
    remove(actor: Actor, ids: readonly string[]): Promise<{ readonly results: readonly RemovalResultShape[] }>
  } | undefined
}

/** 取运行时；没有就按"未就绪"拒绝，且理由与探针一致。 */
function runtimeOf(deps: WebRuntimeDeps): { lifecycle: ConversationLifecycle; store: ConversationPort } {
  if (deps.lifecycle === undefined || deps.store === undefined) {
    throw new HttpError(503, '本 Agent 的业务存储未就绪：请先配置 PostgreSQL（AGENTS_GROUP_PG_DSN 或 AGENTS_GROUP_PG_CONFIG）')
  }
  return { lifecycle: deps.lifecycle, store: deps.store }
}

/**
 * 侧栏改动（重命名 / 置顶 / 删除）的适配层。
 *
 * ## 为什么需要它，而不是把校验搬到存储端口
 *
 * 端口（`ConversationPort`）只提供**原子写**：`syncTitle` / `pin` / `record`。而"操作名是否
 * 合法、一次只能改一条、标题长度、置顶参数必须是布尔"这些是**这个页面的入参契约**，不是存储
 * 的语义——blog 的页面没有置顶，管家也不用 `conversation-action`。搬进端口会让一个业务页面的
 * 参数规则变成所有 Agent 共享的实现。
 *
 * ## 逐条对齐旧实现（`conversation-store.ts:89-96` 的 `mutate` + `agent.ts:457-471` 的 `update`）
 *
 * | 判定 | 旧位置 | 现在的落点 | 失败 |
 * | --- | --- | --- | --- |
 * | `operation ∈ {rename, pin}` 且 `ids.length === 1` | `mutate:90` | 本函数 | 400「请选择一条对话」 |
 * | `delete` 的 `ids` 非空、≤100、全字符串、**无重复** | `update:459` | 本函数（delete 分支） | 400「对话操作无效」 |
 * | `rename` 标题 `trim()` 后 1–100 字符 | `mutate:91` | 本函数 | 400「标题应为 1–100 个字符」 |
 * | `pin` 的 `pinned` 必须是 boolean | `mutate:92` | 本函数 | 400「置顶参数无效」 |
 * | 归属与存在性（未知 / 未发布 / 他人一律 404） | `mutate:93`（`assertOwner`） | `lifecycle.assertConversation` | 404 |
 * | 忙碌会话不能改名 | `agent.ts:468` | `lifecycle.isBusy` | 409「请等待回答完成或先停止」 |
 *
 * **归属判定选 `lifecycle.assertConversation` 而不是 `store.record`**：两条路的 404 文案与
 * 判据完全相同（`conversation.ts:263` 逐字对应 `conversation-store.ts:63`），但前者是运行时
 * 为"页面入口"提供的**唯一**入口——它把 `validateId`（不许寻址别的 DSH 会话）与围栏复核打包
 * 在一起，与 `/chat`、`/history`、`/branch` 走的是同一套。直接用 `store.record` 会绕开 id
 * 形状校验，于是"别的插件的会话 id"这类输入会以 404 而不是 400 返回，和 `/chat` 的口径分叉。
 */
async function applyConversationAction(
  deps: WebRuntimeDeps,
  actor: Actor,
  input: { operation: string; ids: readonly string[]; title?: string; pinned?: boolean },
): Promise<void> {
  const { lifecycle, store } = runtimeOf(deps)
  const id = input.ids[0]!
  // 删除**不是**端口原子写：它要走 kit 的移除围栏（宿主归档 + 持久标记），入口与侧栏同一个
  // （`storage/adapter.ts` 是唯一装配点）。旧实现在这里调 `manager.update` 的 delete 分支，
  // 而那条分支会落到一个 `ConversationStore` 并不满足的 `ConversationRemovalStore` 契约上
  // （缺 `conversationOf`），结果是 TypeError 被 kit 收成 `failed` ⇒ 一律 409。换成运行时
  // 的入口之后这条路径才真的可用。
  if (input.operation === 'delete') {
    if (input.ids.length === 0) throw new HttpError(400, '请选择一条对话')
    // 旧实现（`agent.ts:459-460`）在**进入操作分支之前**就把这条一起判掉了：`ids` 非空、
    // **≤100**、全字符串、**无重复**，否则 400「对话操作无效」。切换载体时只留下了"非空"，
    // 于是 `[a, a]`（重复）和 101 条这两种入参一路走到移除围栏，报出来的是围栏自己的
    // 400/409 与另一套文案，前端拿到的分类就和旧实现分叉了。字符串那一条在路由层
    // （`web.ts` 的 `conversation-action` 处理）已经判过一次，这里不复述。
    if (input.ids.length > 100 || new Set(input.ids).size !== input.ids.length) {
      throw new HttpError(400, '对话操作无效')
    }
    if (deps.provider === undefined) throw new HttpError(503, '会话管理入口未就绪')
    // 归属先判一次（404），**不能只靠移除围栏**：围栏对"别人已经移除过的会话"回答的是
    // `alreadyRemoved`（成功语义），于是一个外人能拿到 200、或拿到 409，就是拿不到 404。
    // 旧实现在这里逐个 `assertOwner`，判定与文案都一致，所以这一步是等价性要求，不是补丁。
    for (const id of input.ids) await lifecycle.assertConversation(id, actor)
    const result = await deps.provider.remove(actor, [...input.ids])
    if (result.results.some(item => item.status === 'failed' || item.status === 'blocked')) {
      throw new HttpError(409, '部分会话未移除，请在会话管理中查看并重试')
    }
    return
  }
  // 校验顺序与旧实现一致：先判操作与条数，再判参数，最后才是归属与忙碌。
  if (!['rename', 'pin'].includes(input.operation) || input.ids.length !== 1) throw new HttpError(400, '请选择一条对话')
  if (input.operation === 'rename'
    && (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 100)) {
    throw new HttpError(400, '标题应为 1–100 个字符')
  }
  if (input.operation === 'pin' && typeof input.pinned !== 'boolean') throw new HttpError(400, '置顶参数无效')
  await lifecycle.assertConversation(id, actor)
  if (lifecycle.isBusy(id)) throw new HttpError(409, '请等待回答完成或先停止')
  if (input.operation === 'rename') await store.syncTitle(actor, id, input.title!.trim(), 'manual')
  else await store.pin(actor, id, input.pinned!)
}

const ASSET_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.cjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

type EventSink = (event: SessionEvent | { type: 'assistant/live-chunk'; time: number; data: AssistantDelta }) => void

/**
 * Register the page, asset, chat, history, and cancellation routes.
 *
 * `http` 由群组注入（已经绑定好该 Agent 的访问校验与页面前缀），不再在这里创建：
 * 迁移进群组后，一个 Agent 只应有一套鉴权实例，重复创建会带来不一致的隐患。
 *
 * `deps` 换成**运行时的三个面**（生命周期 / 会话端口 / 侧栏入口），不再收一个业务管理器：
 * 会话生命周期、归属判定、移除围栏现在都只有运行时那一份实现，页面只调用它。
 */
export async function installWeb(
  ctx: Context,
  config: Config,
  deps: WebRuntimeDeps,
  access: Access,
  http: ReturnType<typeof createPluginHttp>,
): Promise<void> {
  // 前端双轨开关（群组二期批 0，比照 butler web.ts 的 existsSync 模式）：dist/web/app.js
  // 只由 React 构建链（tsdown.web-react.config.ts）产出、再由 copy-web-assets.mjs 落位
  // web/assets/，旧链完全不产 dist/web——构建哪个前端，这里就读哪副页面骨架，
  // 切一次构建即切前端。`/closedoff-qa` 前缀替换与 `__WEB_CONFIG__` 注入形态对
  // 两副骨架一视同仁（见下）。
  const reactSkeleton = existsSync(agentResourcePath(import.meta.url, 'closedoff', 'dist/web/app.js'))
  const sourceHtml = await readFile(agentResource(import.meta.url, 'closedoff', reactSkeleton ? 'web-react/index.html' : 'web/index.html'), 'utf8')
  const webConfig = JSON.stringify({
    routePrefix: config.routePrefix,
    map: {
      terrainUrl: config.terrainUrl,
      tilesetUrl: config.tilesetUrl,
      tilesetHeight: config.tilesetHeight,
      trackDeviceRadiusMeters: config.trackDeviceRadiusMeters,
    },
  }).replaceAll('<', '\\u003c')
  const html = sourceHtml.replaceAll('/closedoff-qa', config.routePrefix).replace('__WEB_CONFIG__', webConfig)
  const webAssetRoot = agentResourcePath(import.meta.url, 'closedoff', 'web/assets/')
  const webAssetPath = `${config.routePrefix}/assets`
  const waiters = new Map<string, Set<EventSink>>()
  const closeStreams = new Set<() => void>()
  const recheckStreams = new Set<() => void>()
  const recheck = () => { for (const check of [...recheckStreams]) check() }
  ctx.effect(() => onRevoked(ctx, recheck))
  ctx.effect(() => {
    const interval = setInterval(recheck, config.authRecheckMs)
    interval.unref()
    return () => clearInterval(interval)
  })
  const respond = (actor: Actor, res: ServerResponse, status: number, value: unknown) => {
    access.assert(actor)
    json(res, status, value)
  }
  const { register } = http
  // 存活与就绪探针由群组统一提供（/agents/health、/agents/ready，以及每个 Agent 的
  // /agents/<id>/ready）。子包这里不再注册：容器级探针是群组的职责，各 Agent 重复一份
  // 不但冗余，而且它的前缀来自自己的 config，与注入的页面前缀天然不一致。
  ctx.effect(() => register({
    kind: 'exact', path: `${config.routePrefix}/models`, handler: async (req, res, actor) => {
      method(req, 'GET')
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('conversationId') || undefined
      respond(actor, res, 200, await runtimeOf(deps).lifecycle.models(actor, id))
    },
  }))
  ctx.effect(() => register({
    kind: 'exact', path: `${config.routePrefix}/identity`, handler: (_req, res, actor) => {
      respond(actor, res, 200, { mode: access.mode, key: actorKey(actor), label: actor.namespace === 'standalone' ? '独立模式' : '已登录', authPath: '/auth' })
    },
  }))
  ctx.effect(() => register({
    kind: 'exact', path: `${config.routePrefix}/conversations`, handler: async (req, res, actor) => {
      method(req, 'GET')
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const offset = Number(params.get('offset') ?? '0')
      const limit = Number(params.get('limit') ?? '30')
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '历史分页参数无效')
      const query = params.get('q') ?? ''
      if (query.length > 120) throw new HttpError(400, '搜索文字过长')
      /**
       * 分页口径与旧实现逐字相同：**多取一条看还有没有下一页**。
       *
       * 旧实现是 `store.list(actor, offset, limit + 1, q)` 后按 `items.length > limit` 判断；
       * 现在走运行时的 `lifecycle.list`，它把查询交给会话端口（PG）并自带"本实例忙集合"的
       * 合并。`hostBusy` 与 `archived` 传空数组是**刻意的**：那两个集合只有侧栏入口
       * （`storage/adapter.ts` 的 `provider.list`）才需要——它们决定 `canRemove` 与"已归档但
       * 未标记移除的行是否出现"，而本端点不回可移除性。顺带一个好处：这条只读端点不依赖宿主
       * 的归档能力，宿主没有 `workspaceRegistry` 时不会像 provider 那样抛 503（列表还是能看）。
       *
       * `state` 传空串（端口的过滤是 `removal_state <> 'removed'`）⇒ 回来的行里既有
       * `ready` / `busy`，也有 `pending`（移除还没完成）/ `failed`（移除失败）/ `legacy`
       * （宿主已归档但没标移除）。**只有前两种是页面能打开的**：后三种点开会 404、在本页再删
       * 也 404（`lifecycle.assertConversation` 挡住），回给页面就是一条点不出东西、也删不掉的
       * 死行。旧实现（`conversation-store.ts` 的 `deletedAt IS NULL AND removal_state = ''`）
       * 正好是前两种，所以这里照同一判据滤掉后三种。
       *
       * ⚠️ **不要改成给端口传 `state: 'ready'` 这条"更小"的路**：`lifecycle.list` 会把本实例的
       * 忙集合合进 `scope.busy`（`conversation.ts:216`），于是 `ready` 会**连 `busy` 一起滤掉**
       * ——正在回答的那条会话会从侧栏凭空消失（刷新列表时尤其明显），比死行更糟。而 `busy` 是
       * 运行时现算出来的状态、旧 SQL 里没有对应的列，所以旧行为就是"保留它"。
       */
      const { lifecycle } = runtimeOf(deps)
      const page = await lifecycle.list(actor, {
        offset,
        limit: limit + 1,
        q: query.trim(),
        state: '',
        // 搜索框的 placeholder 写的是"搜索对话标题"，而端口缺省是"**标题 OR 会话 id**"。会话 id
        // 形如 `closedoff-web-<uuid>`，于是 `-` / `web` / 单个数字这类短 ASCII 查询会命中**全部**
        // 会话——搜索看起来完全没生效。口径开关由端口给（`ConversationQueryShape.titleOnly`），
        // 业务侧只声明"这个入口搜的是标题"。
        titleOnly: true,
      }, { hostBusy: [], archived: [] })
      const items = page.items
      respond(actor, res, 200, {
        items: items.slice(0, limit).filter(item => item.state === 'ready' || item.state === 'busy').map(item => ({
          id: item.id,
          title: item.title,
          updatedAt: item.updatedAt,
          // `state` 一并回给页面：它决定这一行能不能打开。页面侧照同一判据再跳一次（见
          // `web/conversation-history.js` 的 `conversationRowVisible`），两道都留着是因为
          // 页面可能连着旧服务端、服务端也可能连着一个更老/更新的端口实现。
          state: item.state,
          // `pinned` 的形状换了载体：端口给的是 boolean，旧 SQLite 行给的是 0|1。
          // 页面用的是真假判断（`if (item.pinned)`），语义没变；用例跟着改成 `true`。
          pinned: item.pinned === true,
          ...(item.titleSource === undefined ? {} : { titleSource: item.titleSource }),
        })),
        nextOffset: items.length > limit ? offset + limit : null,
      })
    },
  }))

  ctx.effect(() => register({
    kind: 'exact', path: `${config.routePrefix}/conversation-action`, handler: async (req, res, actor) => {
      method(req, 'POST')
      const input = await body(req, 24000)
      if (typeof input.operation !== 'string' || !Array.isArray(input.ids) || input.ids.some(id => typeof id !== 'string')) throw new HttpError(400, '对话操作无效')
      await applyConversationAction(deps, actor, {
        operation: input.operation,
        ids: input.ids as string[],
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        ...(typeof input.pinned === 'boolean' ? { pinned: input.pinned } : {}),
      })
      respond(actor, res, 200, { ok: true })
    },
  }))

  ctx.on('session/event', (session, event) => {
    // ⚠️ 这里**不能**用 `runtimeOf`（它会抛）：`session/event` 是宿主的事件分发，抛出去会变成
    // 宿主侧的未处理异常。未就绪时没有本实例的会话句柄要收尾，跳过即可。
    if (event.type === 'turn/end') deps.lifecycle?.finish(String(session.id))
    for (const sink of waiters.get(String(session.id)) ?? []) sink(event)
  })
  onAssistantDelta(ctx, (sessionId, delta) => {
    for (const sink of waiters.get(sessionId) ?? []) sink({ type: 'assistant/live-chunk', time: delta.time, data: delta })
  })

  ctx.effect(() => register({
    kind: 'exact',
    path: config.routePrefix,
    surface: 'page',
    handler: (req, res, actor) => {
      try {
        method(req, 'GET')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(html)
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'prefix',
    path: webAssetPath,
    handler: async (req, res, actor) => {
      try {
        method(req, 'GET')
        const requestUrl = new URL(req.url ?? webAssetPath, 'http://localhost')
        const suffix = decodeURIComponent(requestUrl.pathname.slice(webAssetPath.length)).replace(/^\/+/, '')
        if (suffix === '') throw new HttpError(404, '资源不存在')
        const file = resolve(webAssetRoot, suffix)
        const local = relative(webAssetRoot, file)
        if (local.startsWith('..') || isAbsolute(local)) throw new HttpError(404, '资源不存在')
        const content = await readFile(file)
        access.assert(actor)
        // 页面自己写的脚本与样式都按文件名直接引用（`./cards.js`、`/assets/app.css`），没有内容
        // 指纹，所以必须让浏览器回源核验：漏一个就会出现「新 app.js 配旧模块」的混跑。子目录里
        // 随包发布的第三方资源（Cesium、定制播放器）才用长缓存。
        const firstParty = !suffix.includes('/')
        res.writeHead(200, {
          'content-type': ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': firstParty ? 'no-cache' : 'public, max-age=31536000, immutable',
        })
        res.end(content)
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/history`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'GET')
        const requestUrl = new URL(req.url ?? config.routePrefix, 'http://localhost')
        const rawId = requestUrl.searchParams.get('conversationId')
        if (rawId === null || rawId === '') return respond(actor, res, 200, { history: [] })
        const { lifecycle } = runtimeOf(deps)
        const conversation = await lifecycle.open(rawId, false, actor)
        let feedback: Array<{ messageId: MessageId; rating: 'positive' | 'negative' }> = []
        let feedbackUnavailable = false
        if (conversation !== undefined) {
          try {
            const listed = await ctx.messageFeedback.list({ sessionId: SessionId(conversation.id) })
            if (listed.ok) feedback = listed.value.items.map(item => ({ messageId: item.messageId, rating: item.rating }))
            else feedbackUnavailable = true
          } catch {
            feedbackUnavailable = true
          }
        }
        respond(actor, res, 200, {
          history: conversation === undefined
            ? []
            : projectHistory(lifecycle.events(conversation), config.trackDeviceRadiusMeters),
          feedback,
          feedbackUnavailable,
        })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/feedback`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const rawId = payload.conversationId
        const rawMessageId = payload.messageId
        const rating = payload.rating
        if (typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        if (typeof rawMessageId !== 'string' || rawMessageId === '') throw new HttpError(400, 'messageId 必须是非空字符串')
        if (rating !== 'positive' && rating !== 'negative') throw new HttpError(400, 'rating 必须是 positive 或 negative')
        const conversation = await runtimeOf(deps).lifecycle.open(rawId, false, actor)
        if (conversation === undefined) throw new HttpError(404, '会话不存在')
        const sessionId = SessionId(conversation.id)
        const messageId = MessageId(rawMessageId)
        const listed = await ctx.messageFeedback.list({ sessionId })
        access.assert(actor)
        if (!listed.ok) throw new HttpError(404, '会话反馈不可用')
        const current = listed.value.items.find(item => item.messageId === messageId)
        const changed = current?.rating === rating
          ? await ctx.messageFeedback.delete({ sessionId, messageId, ifVersion: current.version })
          : await ctx.messageFeedback.put({
            sessionId,
            messageId,
            rating,
            ifVersion: current?.version ?? null,
          })
        if (!changed.ok) throw new HttpError(changed.error.code === 'version-conflict' ? 409 : 400, '反馈状态已变化，请重试')
        respond(actor, res, 200, { rating: current?.rating === rating ? null : rating })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/branch`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const rawId = payload.conversationId
        const atSeq = payload.atSeq
        if (typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        if (typeof atSeq !== 'number' || !Number.isSafeInteger(atSeq) || atSeq < 0) throw new HttpError(400, 'atSeq 必须是非负安全整数')
        const source = await runtimeOf(deps).lifecycle.open(rawId, false, actor)
        if (source === undefined) throw new HttpError(404, '会话不存在')
        // 忙碌判定统一走运行时的 `isBusy`：它把"活跃 + 正在打开 + 正在分支"三种占用算在一起，
        // 而页面侧的 `active` 集合只看得到"这条 SSE 还在推"。两套算法必然会漂移。
        if (runtimeOf(deps).lifecycle.isBusy(rawId)) throw new HttpError(409, '智能体仍在回答，暂时不能创建分支')
        const child = await runtimeOf(deps).lifecycle.fork(source, SessionSeq(atSeq), actor)
        respond(actor, res, 200, { conversationId: child.id })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/stop`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const rawId = payload.conversationId
        if (typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        runtimeOf(deps).lifecycle.cancel(rawId, actor)
        respond(actor, res, 200, { ok: true })
      } catch (caught: unknown) {
        error(res, caught)
      }
    },
  }))

  ctx.effect(() => register({
    kind: 'exact',
    path: `${config.routePrefix}/chat`,
    handler: async (req, res, actor) => {
      try {
        method(req, 'POST')
        const payload = await body(req, config.maxRequestBodyBytes)
        const message = typeof payload.message === 'string' ? payload.message.trim() : ''
        if (message === '') throw new HttpError(400, '消息不能为空')
        const rawId = payload.conversationId
        if (rawId !== undefined && typeof rawId !== 'string') throw new HttpError(400, 'conversationId 必须是字符串')
        const { lifecycle } = runtimeOf(deps)
        const conversation = await lifecycle.open(rawId === '' ? undefined : rawId, true, actor)
        if (conversation === undefined) throw new Error('failed to create business conversation')
        access.assert(actor)
        // 忙碌判定统一走 `lifecycle.isBusy`（活跃 + 正在打开 + 正在分支）：页面侧原来还额外看
        // 一个"这条 SSE 还在推"的本地集合，那是一个**同一个事实的第二份状态**——两个请求同时
        // 进来时它们会各判各的，而真正的占用只有运行时知道。`conversation.active` 是本实例
        // 这一份的状态，`isBusy` 已经把同一个字段算进去了（`conversation.ts:189`）。
        if (lifecycle.isBusy(conversation.id)) throw new HttpError(409, '智能体正在回答上一条问题，请稍候或点击停止')
        const selected = await lifecycle.selectModel(conversation, payload.modelSelection, actor)
        access.assert(actor)
        if (lifecycle.isBusy(conversation.id)) throw new HttpError(409, '智能体正在回答上一条问题，请稍候或点击停止')

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (value: unknown) => {
          if (finished) return
          try { access.assert(actor) } catch {
            finish()
            lifecycle.abort(conversation.id)
            return
          }
          if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`)
        }

        const tools = new Map<string, { name: string; api: string }>()
        const tracks = new Map<string, TrackPoint[]>()
        const reasoningSteps = new Map<number, { raw: string; released: boolean }>()
        const opaqueValues = new Set<string>()
        let deviceGroups: TrackDeviceGroup[] = []
        let finalText = ''
        let finished = false
        let thinkingDone = false
        let thinkingTimer: NodeJS.Timeout | undefined
        let lastThinkingAt = 0
        let lastThinkingPayload = ''
        let turnStartAt: number | undefined
        let firstStep: number | undefined
        let firstStepStartAt: number | undefined
        let firstTokenAt: number | undefined
        let finalMessageId: string | undefined
        let turnEvents: SessionEvent[] = []
        let sink: EventSink
        const listeners = waiters.get(conversation.id) ?? new Set<EventSink>()
        waiters.set(conversation.id, listeners)

        const thinkingText = () => [...reasoningSteps.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => projectReasoning(value.raw, thinkingDone || value.released, [...opaqueValues]))
          .filter(Boolean)
          .join('\n')
        const emitThinking = () => {
          const text = thinkingText()
          const payloadKey = `${thinkingDone ? '1' : '0'}:${text}`
          if (text === '' || payloadKey === lastThinkingPayload) return
          lastThinkingPayload = payloadKey
          lastThinkingAt = Date.now()
          send({ type: 'thinking_snapshot', text, done: thinkingDone })
        }
        const scheduleThinking = (force = false, done = false) => {
          if (done) thinkingDone = true
          if (thinkingTimer !== undefined) {
            clearTimeout(thinkingTimer)
            thinkingTimer = undefined
          }
          const wait = Math.max(0, 250 - (Date.now() - lastThinkingAt))
          if (force || wait === 0) {
            emitThinking()
            return
          }
          thinkingTimer = setTimeout(() => {
            thinkingTimer = undefined
            emitThinking()
          }, wait)
        }

        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(timeout)
          if (thinkingTimer !== undefined) clearTimeout(thinkingTimer)
          listeners.delete(sink)
          if (listeners.size === 0) waiters.delete(conversation.id)
          closeStreams.delete(close)
          recheckStreams.delete(checkAccess)
          if (!res.writableEnded) res.end()
        }
        const close = () => { lifecycle.abort(conversation.id); finish() }
        const timeout = setTimeout(() => lifecycle.abort(conversation.id), config.turnTimeoutMs)
        const checkAccess = () => {
          try { access.assert(actor) } catch {
            finish()
            lifecycle.abort(conversation.id)
          }
        }

        sink = (event) => {
          checkAccess()
          if (finished) return
          if (event.type === 'turn/start') turnEvents = [event]
          else if (event.type !== 'assistant/live-chunk' && turnEvents.length > 0) turnEvents.push(event)
          switch (event.type) {
            case 'turn/start': {
              turnStartAt = event.time
              firstStep = undefined
              firstStepStartAt = undefined
              firstTokenAt = undefined
              finalMessageId = undefined
              break
            }
            case 'step/start': {
              if (firstStep === undefined) {
                firstStep = event.data.step
                firstStepStartAt = event.time
              }
              break
            }
            case 'assistant/live-chunk': {
              const chunk = event.data.chunk
              if (event.data.step === firstStep && firstTokenAt === undefined) {
                const carriesToken = (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
                  ? chunk.text !== ''
                  : chunk.type === 'tool-call-delta' && (chunk.argumentsDelta !== '' || chunk.name !== undefined)
                if (carriesToken) firstTokenAt = event.time
              }
              if (chunk.type === 'text-delta') finalText += chunk.text
              else if (chunk.type === 'reasoning-delta') {
                const state = reasoningSteps.get(event.data.step) ?? { raw: '', released: false }
                state.raw += chunk.text
                reasoningSteps.set(event.data.step, state)
                scheduleThinking()
              }
              else if (chunk.type === 'tool-call-delta' && !tools.has(String(chunk.id))) {
                tools.set(String(chunk.id), { name: chunk.name ?? '', api: '' })
                send({
                  type: 'tool_start', callId: String(chunk.id), name: chunk.name ?? '',
                  presentation: presentationDescriptor(chunk.name ?? ''),
                })
              }
              break
            }
            case 'tool/call': {
              const callId = String(event.data.callId)
              const known = tools.get(callId)
              const api = TOOL_BY_NAME.get(event.data.name as `closedoff_${string}`)?.path ?? ''
              tools.set(callId, { name: event.data.name, api })
              if (known === undefined) send({
                type: 'tool_start', callId, name: event.data.name,
                presentation: presentationDescriptor(event.data.name),
              })
              break
            }
            case 'tool/result': {
              // 双形状兼容：宿主 0.1.7（Messages-only）把 toolCallId 提升到 message 顶层、
              // content 是块数组；旧事件形状 toolCallId/正文嵌在 content[0] 块内。
              // 任一形状取不到时按空结果处理（tool_end(done) 后查询行离开「查询中」）。
              const message = event.data.message
              const rawBlocks = Array.isArray(message.content) ? message.content : []
              const legacyBlock = rawBlocks[0] as { toolCallId?: unknown; content?: unknown; isError?: boolean } | undefined
              const callId = String(message.toolCallId ?? legacyBlock?.toolCallId ?? '')
              const fullResultText = textBlocks(Array.isArray(legacyBlock?.content) ? legacyBlock.content : rawBlocks)
              for (const value of collectOpaqueResultValues(fullResultText, event.data.meta)) opaqueValues.add(value)
              const failed = event.data.error !== undefined || message.isError === true || legacyBlock?.isError === true || gatewayResultFailed(fullResultText)
              send({ type: 'tool_end', callId, status: failed ? 'error' : 'done' })
              const tool = tools.get(callId)?.name ?? ''
              if (!failed && isFenceTool(tool)) send({ type: 'fences', callId, payload: fencesFromResult(fullResultText, event.data.meta) })
              if (!failed && tool === 'closedoff_vehicle_track') {
                const points = extractTrackPointsFromResult(fullResultText, event.data.meta)
                const bundledGroups = extractTrackDeviceGroupsFromResult(event.data.meta)
                if (bundledGroups.length > 0) deviceGroups = bundledGroups
                if (points.length > 0) {
                  tracks.set(callId, points)
                  send({ type: 'track', callId, points, vehicleNo: extractTrackVehicleNoFromResult(fullResultText, event.data.meta) })
                  if (deviceGroups.length > 0) {
                    send({
                      type: 'cameras',
                      callId,
                      cameras: filterDeviceGroupsNearTrack(deviceGroups, points, config.trackDeviceRadiusMeters),
                    })
                  }
                }
                else {
                  const cards = extractCards(tool, fullResultText)
                  send({ type: 'cards', callId, payload: cards ?? emptyCardsPayload(tool, '未返回可展示的轨迹点') })
                }
              } else if (!failed && tool === 'closedoff_vehicle_stream') {
                const media = extractVehicleMediaFromResult(event.data.meta)
                if (media.length > 0) send({ type: 'media', callId, items: media })
                else {
                  const cards = extractCards(tool, fullResultText)
                  if (cards !== undefined) send({ type: 'cards', callId, payload: cards })
                }
              } else if (!failed && tool === 'closedoff_device_page') {
                deviceGroups = extractDeviceGroups(presentationValue(event.data.meta))
                for (const [trackCallId, points] of tracks) {
                  send({
                    type: 'cameras',
                    callId: trackCallId,
                    cameras: filterDeviceGroupsNearTrack(deviceGroups, points, config.trackDeviceRadiusMeters),
                  })
                }
              } else if (!failed && tool !== '') {
                const cards = extractCards(tool, fullResultText)
                if (cards !== undefined) send({ type: 'cards', callId, payload: cards })
              }
              break
            }
            case 'assistant/message': {
              const completeText = textBlocks(event.data.message.content)
              if (completeText !== '') {
                finalText = completeText
                finalMessageId = String(event.data.message.id)
              }
              const reasoning = reasoningBlocks(event.data.message.content)
              if (reasoning !== '') reasoningSteps.set(event.data.step, { raw: reasoning, released: true })
              scheduleThinking(true)
              break
            }
            case 'turn/end': {
              const reason = event.data.reason
              scheduleThinking(true, true)
              if (finalText !== '') send({ type: 'delta', text: redactVisibleText(finalText) })
              if (reason.kind === 'error') send({ type: 'error', message: redactVisibleText(`智能体回答失败: ${reason.error.message}`) })
              const turnUsage = turnUsageSummary(turnEvents)
              const completed = reason.kind === 'completed'
              send({
                type: 'done',
                reason: reason.kind,
                ...(completed ? {
                  meta: {
                    ...(finalMessageId === undefined ? {} : { messageId: finalMessageId }),
                    branchSeq: event.seq,
                    completedAt: event.time,
                    ...(turnStartAt === undefined ? {} : { runMs: Math.max(0, event.time - turnStartAt) }),
                    ...(firstStepStartAt === undefined || firstTokenAt === undefined
                      ? {}
                      : { ttftMs: Math.max(0, firstTokenAt - firstStepStartAt) }),
                    ...(turnUsage === undefined ? {} : { usage: turnUsage }),
                  },
                } : {}),
              })
              finish()
              break
            }
          }
        }
        listeners.add(sink)
        closeStreams.add(close)
        recheckStreams.add(checkAccess)
        send({ type: 'conversation', conversationId: conversation.id, model: selected })
        res.once('close', () => {
          if (!finished) lifecycle.abort(conversation.id)
          finish()
        })
        try {
          if (finished) return
          await lifecycle.followup(conversation, message, actor)
        } catch (caught: unknown) {
          send({ type: 'error', message: redactVisibleText(caught instanceof Error ? caught.message : '消息发送失败，请重试') })
          finish()
          throw caught
        }
      } catch (caught: unknown) {
        if (!res.headersSent) error(res, caught)
        else if (!res.writableEnded) res.end()
      }
    },
  }))

  // 释放本页面登记的 SSE：`close()` 会各自 `lifecycle.abort` 掉自己的会话，
  // 所以这里不需要（也不该）再维护一份"哪些会话在推"的本地集合。
  ctx.effect(() => () => {
    for (const close of [...closeStreams]) close()
    waiters.clear()
  })
}
