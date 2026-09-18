/**
 * 绘语图片智能体的装配入口。
 *
 * 这一层只做装配，不含业务：把群组注入的公共字段补齐、把私有配置读进来、把几个接缝
 * （生图 provider、MinIO、PG 存储、运行时）装到一起，然后交回工具清单、协作参与者与就绪探针。
 *
 * ## Q4 口径：缺配置是"未就绪"，不是"装载失败"
 *
 * 没有 PG、没有 MinIO 时**照常装载**：目录条目、页面、工具定义都注册，参与者交回一个
 * 一律以 503 加稳定原因拒绝的占位。这样协作侧拿到的是"这个成员现在不能用、因为配置没到位"，
 * 而不是"这个成员不存在"。
 *
 * 这一条很关键：把"缺配置"报成"装载失败"，会让群组把整个成员标成失败，用户看到的是成员消失；
 * 而"未就绪"是一条能自愈的路——补齐配置后探针自动转绿，不需要重启装配。
 */

import { randomUUID } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { AccessError, createPluginHttp, onRevoked, registerPlugin, type Access, type Actor, type ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import { createAgentDatabase, createAgentRuntime } from '@dsh-agents-group/runtime'
/**
 * 协作契约按**源码相对路径**引入，不走包名。
 *
 * `packages/runtime` 只提供源码、不产出声明文件：打包器生成声明时按包名找不到 `.d.ts`，
 * 会把契约类型当成「没有这个导出」直接报 `MISSING_EXPORT`。相对路径是源码图里的普通模块，
 * 声明生成能正常跟随（与 blog、host.ts 同一写法）。
 */
import type { AgentParticipant } from '../../../packages/runtime/src/contract.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { resolveStorageDsn } from '../../../packages/runtime/src/storage/dsn.ts'
import { loadEnvConf, parseEnvConf, type HuiyuEnvironment } from './env.ts'
import { Config as ConfigSchema, createHuiyuDefinition, type PluginConfig } from './definition.ts'
import { HuiyuError, isHuiyuError } from './errors.ts'
import { createImageProvider } from './image/index.ts'
import { createMinioClient, type MinioClient } from './minio/index.ts'
import { createHuiyuStore, type HuiyuStore } from './store.ts'
import { attachmentsOf, readImageBytes } from './media/attachments.ts'
import { renderPage } from './page.ts'
import { registerHuiyuTools } from './tools/index.ts'
import type { HuiyuToolContext } from './tools/context.ts'

export { Config as ConfigSchema } from './definition.ts'
export type { PluginConfig } from './definition.ts'
export * from './errors.ts'

/** 本子包需要的宿主服务。少声明会让它在运行时才发现缺能力。 */
export const inject = [
  'agents',
  'agentDefaultModel',
  'webServer',
  'systemPrompt',
  'tools',
  'attachments',
  'llm',
  'sessions',
  'sessionPersistence',
  'messageFeedback',
] as const

/** 装配上下文（由群组适配层传入）。 */
export interface AgentMountContext {
  readonly ctx: import('@deepseek-ai/cordis').Context
  readonly access: Access
  /** 一个只允许注册本 Agent 前缀下路由的 HTTP 注册器（群组已按页面前缀限好）。 */
  readonly http: ReturnType<typeof createPluginHttp>
  readonly config: PluginConfig
  /**
   * 本 Agent 的**工具**分类标签，由群组从清单注入（如"图片与视觉"）。
   *
   * 子包注册工具时原样使用，**不要自己写字符串**：两处各写一份会漂移，而漂移的后果是
   * 本 Agent 的工具全部对其不可见，且这种失效在界面上完全看不出来。
   */
  readonly toolCategory: string
  /**
   * **目录条目**的分类，由群组注入。
   *
   * 与上面的 `toolCategory` 是两件事：那个是工具可见性用的业务分类，这个是"它是不是一个成员"
   * （值恒为 `'agents'`）。群组注入它，是因为只有群组手里有成员名单——子包自己抄一遍常量
   * 就是让信息不在手的一方替信息在手的一方回答。
   */
  readonly memberCategory: string
  readonly allowedTools: () => readonly string[]
  /** 群组级配置文件的路径；绘语从中读 `HUIYU_` 段。 */
  readonly groupConfigPath?: string
}

/**
 * 运行时的回合超时。
 *
 * 生图是慢活（一张高分辨率图可能十几秒），所以给得比纯对话宽：240 秒。再长就该由用户重试
 * 而不是让一个回合无限占着会话。
 */
const TURN_TIMEOUT_MS = 240_000

/**
 * 把私有配置读进来。
 *
 * 优先群组级配置文件（它的 `huiyu` 小节写成 `KEY=VALUE` 文本），这是运行时的正常来源；
 * 读不到时回落到插件根 `env.conf`——**这条回落只在文件不存在时走**，内容有问题要如实抛出，
 * 否则一个写坏的配置会被另一个来源悄悄掩盖。
 */
async function loadEnvironment(groupConfigPath: string | undefined): Promise<HuiyuEnvironment> {
  if (groupConfigPath !== undefined && groupConfigPath !== '') {
    try {
      const raw = await readFile(groupConfigPath, 'utf8')
      // 群组配置是 JSON（`{"agents-group":{...,"huiyu":{...}}}` 或直接的 `{"huiyu":{...}}`）。
      const document = JSON.parse(raw) as Record<string, unknown>
      const outer = document['agents-group']
      const section = (typeof outer === 'object' && outer !== null ? outer as Record<string, unknown> : document).huiyu
      if (section !== undefined && section !== null) {
        const text = typeof section === 'string'
          ? section
          : Object.entries(section as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
            .map(([key, value]) => `${key}=${String(value)}`)
            .join('\n')
        if (text.trim() !== '') return parseEnvConf(text)
      }
    } catch (cause: unknown) {
      // 只有「文件不存在」回落到插件根那份；读得到但内容有问题要如实抛出。
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause
    }
  }
  return loadEnvConf()
}

/**
 * 从 DSH 的凭据系统取一个密钥。
 *
 * 用 `ctx.get` 而不是 `ctx.credentials`：凭据服务是**可选**依赖，群组在 standalone 或裁剪过
 * 的宿主里可能没挂它，而属性代理在服务缺席时会抛错。取不到就如实返回空串，让 provider 的
 * `available()` 去报"未取到密钥"——那是用户能看懂、也能自己修的一句话。
 *
 * @param ctx 宿主上下文
 * @param key 凭据键名
 * @returns 密钥，取不到时为空串
 */
async function readCredential(ctx: { get(name: string): unknown }, key: string): Promise<string> {
  const service = ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value?: string } | undefined> } | undefined
  if (typeof service?.resolve !== 'function') return ''
  try {
    const resolved = await service.resolve(key)
    return typeof resolved?.value === 'string' ? resolved.value : ''
  } catch (error: unknown) {
    // 凭据文件损坏或权限不对时不该让整个成员装载失败：识图仍然可用。
    console.warn(`agents-group/huiyu: 读取凭据 ${key} 失败`, error)
    return ''
  }
}

/** 未就绪时的协作入口占位。身份三项与正式定义逐字相同，只把能力换成明确拒绝。 */
function unavailableParticipant(reason: string): AgentParticipant {
  const refuse = (): never => { throw new AccessError(503, `绘语未就绪：${reason}`) }
  return {
    protocol: 1,
    id: 'huiyu',
    displayName: '绘语',
    description: '图片理解与生成：看懂图片内容，也能按描述生成图片',
    assertAccess: refuse,
    run: async () => refuse(),
  }
}

/** HTTP 错误渲染：只有本子包知道哪些错误是可预期的。 */
export function renderHttpError(response: ServerResponse, error: unknown): boolean {
  if (!isHuiyuError(error)) return false
  response.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ ok: false, error: error.message }))
  return true
}

/**
 * 装载绘语。
 *
 * @param mountContext 群组注入的装配上下文
 * @returns 工具清单、协作参与者、就绪探针与释放函数
 */
export async function mount(mountContext: AgentMountContext): Promise<{
  dispose(): Promise<void>
  tools: readonly ToolDescriptor[]
  participant: AgentParticipant
  health(): Promise<{ ok: boolean; error?: string }>
}> {
  const { ctx, access, config } = mountContext

  // ---- 私有配置：缺配置不是装载失败，而是"未就绪" ----
  let environment: HuiyuEnvironment | undefined
  let configFailure: string | undefined
  try {
    environment = await loadEnvironment(mountContext.groupConfigPath)
  } catch (error: unknown) {
    configFailure = error instanceof Error ? error.message : String(error)
    console.warn(`agents-group/huiyu: 私有配置未就绪（${configFailure}）`)
  }

  // ---- 三个接缝：任何一个缺配置都只影响对应的能力，不让整体装载失败 ----
  // 生图密钥走 DSH 凭据系统（`CIYUAN_API_KEY`），不进 env.conf——这样它在模型设置界面里
  // 统一管理、可轮换，也不会随配置文件进私有库。凭据服务未挂载或没配该键时取到空串，
  // 由 provider 的 `available()` 明确报告"未取到密钥"，而不是让装配失败。
  const imageApiKey = environment === undefined ? '' : await readCredential(ctx, 'CIYUAN_API_KEY')
  const imageProvider = environment === undefined
    ? undefined
    : createImageProvider(environment, imageApiKey)
  const minio: MinioClient | undefined = environment === undefined
    ? undefined
    : createMinioClient({
      endpoint: environment.minio.endpoint,
      bucket: environment.minio.bucket,
      region: environment.minio.region,
      accessKey: environment.minio.accessKey,
      secretKey: environment.minio.secretKey,
      publicBaseUrl: environment.minio.publicBaseUrl,
    })

  // ---- 业务存储：与群组共用同一个 DSN、同一份库，表按 huiyu_ 前缀平铺 ----
  const dsnSource = await resolveStorageDsn(
    process.env,
    dshHomePath('plugins', 'agents-group', 'env.conf'),
    async (path: string) => (await import('node:fs/promises')).readFile(path, 'utf8'),
  )
  const store: HuiyuStore | undefined = dsnSource === undefined ? undefined : createHuiyuStore(dsnSource.dsn)
  let storageFailure: string | undefined
  if (store !== undefined) {
    try {
      await store.init()
    } catch (error: unknown) {
      storageFailure = error instanceof Error ? error.message : String(error)
      console.warn(`agents-group/huiyu: 业务存储未就绪（${storageFailure}）`)
    }
  }

  // ---- 工具装配上下文 ----
  const toolContext: HuiyuToolContext = {
    ctx,
    environment: environment as HuiyuEnvironment,
    minio,
    imageProvider: imageProvider as HuiyuToolContext['imageProvider'],
    store,
    attachments: () => attachmentsOf(ctx),
  }

  // 工具**无论是否就绪都注册**：未就绪时它们各自以稳定的 503 拒绝并说清缺什么，
  // 而不是从目录里消失——"工具不见了"是最难查的一类失效。
  //
  // ⚠️ 注册**只在这里发生一次**，`AgentDefinition.tools` 只交回下面这份条目。在定义里再
  // 注册一次会撞上宿主的同名保护（`is already registered`），那会把整个运行时装配打成失败。
  const tools = registerHuiyuTools(toolContext, mountContext.toolCategory, 'huiyu:access')
  const definition = createHuiyuDefinition({
    category: mountContext.toolCategory,
    permission: 'huiyu:access',
    tools: toolContext,
    registered: tools,
  })

  /** 能否建运行时：需要私有配置与 PG 两样都在。 */
  const runnable = environment !== undefined && store !== undefined && storageFailure === undefined

  let participant: AgentParticipant
  let disposeRuntime: (() => Promise<void>) | undefined
  if (!runnable) {
    const reason = configFailure ?? storageFailure ?? '私有配置或数据库未就绪'
    participant = unavailableParticipant(reason)
  } else {
    try {
      // 索引侧三张框架表由运行时自己建库句柄；`localPath` 是本地围栏存储（同步契约的
      // 会话行镜像 + 持久 outbox），PG 短暂不可达时它保证 `record`/`mark` 仍能同步回答。
      const localPath = join(dshHomePath('plugins', 'huiyu'), 'huiyu.sqlite')
      await mkdir(dirname(localPath), { recursive: true }).catch(() => {})
      const index = createAgentDatabase({
        dsn: (dsnSource as { dsn: string }).dsn,
        agentId: 'huiyu',
        localPath,
      })
      await index.open()
      const assembly = await createAgentRuntime({
        ctx,
        definition,
        access,
        config: {
          routePrefix: config.routePrefix,
          turnTimeoutMs: TURN_TIMEOUT_MS,
          authRecheckMs: 1000,
          maxActiveConversations: 4,
          // 空串＝不在这里插一脚，由运行时按会话选择模型（与 blog 同一口径）。
          reasoningEffort: '',
        },
        allowedTools: mountContext.allowedTools,
        database: { dsn: (dsnSource as { dsn: string }).dsn, localPath },
      })
      participant = assembly.participant
      disposeRuntime = () => assembly.dispose()
    } catch (error: unknown) {
      /**
       * ⚠️ **装配失败不能让整个成员装载失败。**
       *
       * 抛出去的话群组会把 huiyu 标成"装载失败"，它的目录条目、页面、工具与执行入口
       * **全部消失**——用户看到的是成员不见了，而不是"它现在不能用"。所以这里收成
       * 不可用参与者：条目照旧、执行入口照旧，只是每次调用如实报 503 与原因。
       */
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`agents-group/huiyu: 运行时装配失败，已按未就绪装载（${reason}）`)
      participant = unavailableParticipant(reason)
    }
  }

  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly name: string
    readonly version: string
    readonly description: string
  }

  /**
   * 目录条目：由本子包注册（与 closedoff、blog 同一范式）。
   *
   * ⚠️ **`category` 必须用群组注入的 `memberCategory`，不能用 `toolCategory`。**
   *
   * 这是两个不同的分类，很容易混：
   *
   * | 分类 | 取值来源 | 谁在用 |
   * | --- | --- | --- |
   * | 目录条目的分类 | **`mountContext.memberCategory`**（恒为 `'agents'`） | 牛马大总管按它筛成员：`listAgentCards` 只收 `category === 'agents'` 的插件 |
   * | 工具分类标签 | **`mountContext.toolCategory`**（清单里的"图片与视觉"） | 群组按它算"这个 Agent 能看见哪些工具" |
   *
   * 用错成后者的话，条目本身还在、探针也正常，但**牛马大总管的成员列表里没有这个成员**，
   * 于是它永远不会被派活——而这一点在任何探针上都看不出来（2026-09-18 绘语的实际缺陷）。
   * 所以这个值由群组注入：只有群组手里有成员名单，子包没有回答"我是不是成员"的信息。
   */
  ctx.effect(() => registerPlugin(ctx, {
    id: 'huiyu',
    packageName: manifest.name,
    version: manifest.version,
    displayName: '绘语（图片智能体）',
    description: manifest.description,
    entryPath: config.routePrefix,
    permissions: ['huiyu:access'],
    category: mountContext.memberCategory,
    tools,
  }))

  /**
   * 页面。
   *
   * `surface: 'page'` 不能省：未登录时 kit 会据此把 401 转成跳认证的 303，而不是抛一个
   * JSON 错误。少了它，用户在地址栏直接打开 `/agents/huiyu` 会看到一段 JSON。
   *
   * 页面内容里**不含任何密钥**，只展示桶名、访问前缀与模型名这类非敏感项。
   */
  ctx.effect(() => mountContext.http.register({
    kind: 'exact',
    path: config.routePrefix,
    surface: 'page',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(renderPage({
        ...(configFailure === undefined ? {} : { unavailable: configFailure }),
        ...(environment === undefined ? {} : { environment }),
      }))
    },
  }))

  /**
   * 读图路由：把附件标识映射成可访问地址。
   *
   * ## 为什么需要它
   *
   * 生成图的地址来自 MinIO 直链（公开可读），但**用户上传的图留在宿主附件存储里**——
   * 那是个不透明的持久引用，不是 URL。没有这条路由，页面就没法显示用户自己传的图。
   *
   * ## 为什么不做成公开
   *
   * 上传图属于用户私有素材。这条路由**要求 `huiyu:access`**（由群组注入的 access 校验），
   * 并且把宿主抛出的不可读统一收成 404——**不区分"不存在"与"无权访问"**，否则它就成了一个
   * 探测他人附件是否存在的接口。
   *
   * ## 为什么可以长缓存
   *
   * 附件标识是**内容寻址**的：同一个 id 对应的字节永不改变。所以 `immutable` 是安全的，
   * 而且省掉重复读取。
   */
  const imagePrefix = `${config.routePrefix}/images`
  ctx.effect(() => mountContext.http.register({
    kind: 'prefix',
    path: imagePrefix,
    handler: async (req, res, actor: Actor) => {
      access.assert(actor)
      // 注册路径不能带尾斜杠（`isPluginPath` 拒绝以 `/` 结尾的路径），但浏览器可能带，
      // 所以两种形态都要接受：先把可能的分隔符统一掉再取标识。
      const path = (req.url ?? '').split('?')[0] ?? ''
      const rest = path.startsWith(imagePrefix) ? path.slice(imagePrefix.length) : ''
      const attachmentId = decodeURIComponent(rest.replace(/^\/+/, ''))
      if (attachmentId === '') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('缺少图片标识')
        return
      }
      let data: Uint8Array
      let mediaType: string
      try {
        const read = await readImageBytes(attachmentsOf(ctx), attachmentId)
        data = read.data
        mediaType = read.ref.mediaType
      } catch {
        // 不可读与无权访问同为 404：区分它们等于给调用方一个探测接口。
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('找不到这张图片')
        return
      }
      res.writeHead(200, {
        'content-type': mediaType,
        'content-length': String(data.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
      })
      res.end(data)
    },
  }))

  /** 权限被撤时让在飞轮次尽早收尾（与 closedoff / blog 同一口径）。 */
  ctx.effect(() => onRevoked(ctx, () => { void 0 }))

  const health = async (): Promise<{ ok: boolean; error?: string }> => {
    if (configFailure !== undefined) return { ok: false, error: configFailure }
    if (dsnSource === undefined) return { ok: false, error: '缺少 PostgreSQL 存储配置（AGENTS_GROUP_PG_DSN）' }
    if (storageFailure !== undefined) return { ok: false, error: storageFailure }
    if (store !== undefined) {
      const state = await store.probe()
      if (!state.ok) return { ok: false, error: state.error ?? '业务存储不可用' }
    }
    // 生图能力缺配置不算"未就绪"：识图仍然可用，而"未就绪"会让整个成员在协作侧消失。
    // 它的缺配置由工具在调用时明确报出（见文件头 Q4 的取舍）。
    return { ok: true }
  }

  return {
    tools,
    participant,
    health,
    async dispose() {
      await disposeRuntime?.().catch(() => {})
      await store?.close().catch(() => {})
    },
  }
}

export { ConfigSchema as Config }
export type { HuiyuEnvironment }
export type { Actor }
export { randomUUID }
