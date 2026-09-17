/**
 * blog 的 HTTP 夹具（`test:host` 用）：把 `mount()` 装进一个最小的假宿主，再挂到临时 HTTP 服务上。
 *
 * ## 为什么不再调 `apply`
 *
 * blog 的装载入口在 P7 从插件级 `apply` 换成了群组注入式的
 * `mount(AgentMountContext)`（`src/index.ts:190`）：`access` 与 `http` 由群组提供
 * （一个 Agent 只应有一套鉴权实例，路由契约也不该在各子包各写一份），业务配置由群组翻译后交进来。
 * 所以夹具必须照群组的装配方式来（`src/host.ts:161-171`）：
 * `createAccess({mode:'authenticated', pluginId:'blog', publicOrigin})`
 * → `createPluginHttp({access, routePrefix, onError: blogStorageErrorHandler})` → `mount({ctx, access, http, …})`。
 * 少任何一环，测的都是宿主里不存在的那套装配。
 *
 * ## 存储：两种模式，都是**真走装载路径**
 *
 * - `storage: 'test-database'`（缺省）：**真 PostgreSQL**。业务存储与索引都已切到 PG
 *   （Q4 口径：只有 PG 一种后端），所以"会话 / 草稿 / 附件 / 备份授权"这几条老用例必须有一个
 *   真库。库由 `AGENTS_GROUP_TEST_PG_DSN` 给出，夹具自己建结构（见 {@link provisionSchema}），
 *   并要求库名以 `_test` 结尾——它会 `DROP SCHEMA public CASCADE`。
 * - `storage: 'unconfigured'`：**没有配置**。判据 J6 走这一支：装载照常、探针与业务端点按
 *   `storage_unconfigured` 拒绝、**绝不回退 SQLite**。夹具会先核实 `AGENTS_GROUP_PG_DSN`
 *   已清空，否则这一支会静默变成"配好了"的运行。
 *
 * ⚠️ 无 `AGENTS_GROUP_TEST_PG_DSN` 时**不能**真跑 `test-database` 这一支（没有库就没有后端，
 * 会话与草稿全都会 503）。测试侧用本文件导出的 {@link TEST_DSN} 门控并**打印跳过原因**
 * ——跳过与通过是两件事，不报通过。⚠️ 也别与 `pnpm test:pg` 并发跑：两者都会重建 `public`。
 *
 * ## 库形状：**一份**，就是生产那份
 *
 * 夹具直接用 `private-deploy/db/0001_init.sql` 建出全部 15 张表（{@link provisionSchema}）。
 *
 * ⚠️ 这里此前是"两块拼起来"：业务六表 + `blog_schema_version` 取自 blog 自己的旧迁移，框架四表
 * 从新 DDL 里筛出来。那是**业务存储还没迁到新形状**时的如实写照（当时 `src/storage/pg.mjs` 仍在读
 * `blog_schema_version`、仍用 `owner` + `data`）。业务六表切完之后那个拼接就没有理由了 ——
 * 它会让测试跑在一个**只有测试才有**的中间结构上，而"测试全绿"于是证明的是那个结构。
 * 现在夹具与生产是同一份 DDL，拼接逻辑与 `FRAMEWORK_STATEMENT` 一起删掉了。
 *
 * ## 其它两条约束
 *
 * - 加载的是**构建产物** `../dist/index.mjs`（`test:host` 测发布形态），跑之前要 `pnpm build`。
 * - `blog.sqlite` 在 PG 模式下是**正常的**：它是本地围栏镜像 + outbox（`storage/index.ts` 文件头），
 *   只有未配置模式才断言它不出现（判据 J6 ⑤）。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context, EventOptions, Events } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { createAccess, createPluginHttp } from '@dsh-plugin-manager/plugin-kit'
import type { Actor, ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import { applySchema } from '../../../../../../private-deploy/db/create.mjs'
import { Config, blogStorageErrorHandler, mount } from '../dist/index.mjs'
import type { AgentParticipant } from '../../../packages/common/src/participant.ts'

/**
 * `mount()` 返回面里**本夹具与用例用到的那几面**，显式写出来。
 *
 * ⚠️ **不能写成 `Awaited<ReturnType<typeof mount>>`**：`mount` 来自 **`dist/index.mjs`**，而那棵
 * 声明树把 `AgentParticipant` 声明成**未导出**的 interface ⇒ 本函数是 `export` 的，导出签名里出现
 * 一个"叫不出名字"的类型，`tsc` 直接报 **TS4058**（`declaration: true` 下必然发生）。
 * 这里改用**源头**的 `AgentParticipant`（`packages/common/src/participant.ts`，那边是导出的）
 * 并按 `src/index.ts:314-319` 的返回面逐字声明 ⇒ 与 dist 的返回值**结构等价**（赋值照样成立），
 * 但名字是可命名的。
 */
type MountedBlog = {
  dispose(): Promise<void>
  tools: readonly ToolDescriptor[]
  participant: AgentParticipant
  health(): Promise<{ ok: boolean; error?: string }>
}

/** 夹具的 actor 都是 `Actor` 的 **user** 变体（standalone 那一支没有 `sessionId`）。 */
type UserActor = Extract<Actor, { namespace: 'user' }>

/**
 * `ecosystem/providers` 事件交出来的**接受者**签名（`kit` 的 `AuthProvider` 语义，
 * `packages/plugin-kit/src/access.ts:77`）。
 *
 * 用夹具自有的形状而不是 `AuthProvider` 本身，只有一个原因：`Actor` 是两支联合，而本夹具的
 * `actors` 与 `createAccess`（`authenticated` 模式）都只交出 user 那一支 —— 替身按它实际
 * 处理的那一支声明，比在每处访问 `sessionId` 前再收窄一次更如实。
 */
type ProviderAccept = (provider: {
  readonly protocol: 1
  ready(): void
  resolve(request: { readonly headers: { readonly cookie?: string } }): UserActor | undefined
  assertAccess(actor: UserActor, pluginId: string): void
}) => void

/**
 * 夹具的**宿主替身**（传给 `createAccess` / `createPluginHttp` / `mount` 的那个 `ctx`）。
 *
 * 只实现被测路径真正用到的面：事件通道（`on` / `emit` / `effect`）与服务查找（`get`），
 * 外加四个服务面（`attachments` / `jobs` / `tools` / `webServer`）。索引签名留着，是因为
 * `mount()` 守卫那条用例（`tests/http.test.ts:174`）会在 `extendCtx` 里把假宿主的面并进来。
 */
type HostStub = {
  [key: string]: unknown
  /** `ctx.root`：夹具里就是它自己（`ctx.root = ctx`）。 */
  root?: HostStub
  /**
   * 事件通道。事件名取 `keyof Events`（`kit` 的 `events.ts` 为 `ecosystem/*` 做了类型增强）：
   * 假宿主那一份 `on` 也收同样的键，`extendCtx` 里"组合两份 `on`"才不需要各自转换。
   */
  on(event: keyof Events, listener: (...args: unknown[]) => void, ...rest: [options?: boolean | EventOptions]): unknown
  emit(event: string, ...args: unknown[]): void
  effect(fn: () => unknown): unknown
  get(name: string): unknown
  attachments: {
    saveFileStream(input: { data: AsyncIterable<Uint8Array>; name: string }): Promise<{ attachmentId: string; name: string; bytes: number }>
    readFileStream(ref: { attachmentId: string }): AsyncGenerator<Uint8Array | undefined>
  }
  jobs: { attachController(): () => void }
  tools: { register(tool: unknown): () => void }
  webServer: { register(route: WebRoute): () => void }
}

/** 真 PG 的门控变量：测试侧据此决定那几条依赖存储的用例跑还是跳过。 */
export const TEST_DSN = process.env.AGENTS_GROUP_TEST_PG_DSN ?? ''

/** 夹具用的路由前缀：与 `Config` 的缺省值一致，显式写出来是因为临时服务按它拼路径。 */
const ROUTE_PREFIX = '/blog'

/**
 * **唯一的**结构来源：新库 DDL（`private-deploy/db/0001_init.sql`，15 张表一次建出）。
 *
 * 本夹具此前把两块拼起来（旧 blog 迁移 + 新 DDL 里筛出的 `dsh_` 语句），那是**迁到一半**的形状。
 * 业务六表切到新形状之后，"拼"这件事就没有理由了：整份 DDL 才是生产那份结构，而拼接会引入
 * 一个只有测试才有的中间态 —— 那种结构一旦与生产不同，"测试全绿"证明的就是别的东西。
 *
 * 代价同 `tests/pg-smoke.test.mjs`：本文件因此依赖仓库布局（DDL 在 `private-deploy/` 下）。
 */
const PRIVATE_DDL = new URL('../../../../../../private-deploy/db/0001_init.sql', import.meta.url)

/** 安静地应用结构：夹具不关心语句条数，`applySchema` 的日志会污染 `node --test` 的 TAP 输出。 */
const QUIET = { log: () => {} }

/**
 * 在测试库里重建夹具需要的结构。
 *
 * 清库前核对库名确实以 `_test` 结尾（与 `tests/pg-smoke.test.mjs` 同一道闸）：配错 DSN 时
 * 立即失败，绝不 `DROP` 别的库。
 */
async function provisionSchema(dsn: string, { withIndex = true }: { withIndex?: boolean } = {}) {
  const client = new Client({ connectionString: dsn })
  await client.connect()
  try {
    const current = await client.query('SELECT current_database() AS name')
    const database = current.rows[0]?.name ?? ''
    if (!database.endsWith('_test')) {
      throw new Error(`AGENTS_GROUP_TEST_PG_DSN 指向的库「${database}」不是 *_test 一次性测试库，拒绝 DROP SCHEMA public CASCADE`)
    }
    await client.query('DROP SCHEMA public CASCADE')
    await client.query('CREATE SCHEMA public')
    // ⚠️ 去掉文件自带的那对 `BEGIN;` / `COMMIT;`：`applySchema` 自己会套一对事务，两层叠起来会变成
    // 嵌套 BEGIN（告警）与提前 COMMIT（后面的语句跑在事务外，失败就不回滚了）。
    let ddl = (await readFile(PRIVATE_DDL, 'utf8')).replace(/^[ \t]*(?:BEGIN|COMMIT)[ \t]*;[ \t]*$/gim, '')
    await applySchema(client, ddl, QUIET)
    /**
     * `withIndex: false` ⇒ **业务那半好、索引那半坏**。
     *
     * 用途只有一个：构造"**业务存储可用、索引存储不可用**"这个组合，验证就绪探针**不会说谎**。
     * 它与"缺配置"（没有 DSN）是两件事：那时两侧都不可用；这里是**业务侧确实可用**，
     * 只有索引侧坏了 —— 只探业务那一侧的实现会在这里报"就绪"，而侧栏列表 / 历史（都走索引侧）全失败。
     *
     * 做法：**删掉索引侧那三张表**（`CASCADE` 会一并去掉 `blog_attachments` 上指向
     * `dsh_conversations` 的复合外键，但**不删业务表本身**）。于是
     * ① 索引侧 `assertSchema()` 抛 `storage_schema_missing`；② 索引侧的读写也抛同一个码（表真的没了）
     * —— 两侧一致，这正是"索引死了"该有的形状。
     *
     * ⚠️ **不要**改成"按 `dsh_` 前缀筛 DDL 语句"：那样会连**引用** `dsh_conversations` 的
     * `blog_attachments` 一起筛掉，业务那半自己就先建不起来（实测报
     * `relation "butler_tasks" does not exist` —— 被引用者被筛掉了）。
     *
     * ⚠️ **也不要用"只删 `dsh_schema_versions` 的 `runtime` 那一行"** 来构造：实测那样
     * `chat-create` 会**返回 200** —— 版本行只在 `open()` 里核验一次，而 `AgentDatabaseFacade`
     * **没有把端口方法门禁在 `opened` 上**（`storage/index.ts:131-139` 只置标志位，没有任何读取
     * 检查它）⇒ `open()` 失败之后门面**照常读写**。那是另一条独立的缺口，已登记，不要在夹具里依赖它。
     */
    if (!withIndex) {
      await client.query('DROP TABLE IF EXISTS dsh_turn_results, dsh_turns, dsh_conversations CASCADE')
    }
  } finally {
    await client.end()
  }
}

/**
 * 造一个夹具。
 *
 * @param options.storage `'test-database'`（真 PG，缺省）或 `'unconfigured'`（没有存储配置）
 * @param options.hostname 对外 origin 里的主机名（与 `publicOrigin` 一致）
 * @param options.extendCtx 可选：`(ctx) => void`，在 `mount()` **之前**就地扩展 `ctx`。
 *
 * 存在的理由只有一个：本夹具原本只服务 HTTP 用例，`ctx` 里**没有 `agents` 与 `llm`**——
 * 那两个面只有"真的跑一轮协作"（`mounted.participant.run(...)`）时才用得到。用例要验
 * "`mount()` 真的给协作入口建立了委派身份"（`agents/blog/src/index.ts` 里那一行 `withTurnBinding`），
 * 就必须能把这两个面递给装配。
 *
 * 给的是**回调**而不是一个待合并的键值表：`on` 这一格**只能被"组合"、不能被"替换"**。
 * `kit` 的 `createAccess` 在 `access.ts:127` 用 **`ctx.root.emit('ecosystem/providers', …)`**
 * 收集鉴权提供方，而本夹具的提供方正是注册在下面那条 `ctx.on('ecosystem/providers', …)` 上的；
 * 一旦把 `on` 整个换成假宿主那一份，`ctx.root.emit` 就再也打不到它 ⇒ 鉴权解析恒失败。
 *
 * **并入的时机也是刻意的**：必须在下面注册 `ecosystem/providers` **之前**。
 *
 * ⚠️ **不要动 `webServer` 与 `jobs`**：路由表与 `attachController` 必须还是本夹具那两份，
 * 换掉它们破坏的是既有 HTTP 用例。协作路径真正要补的是 `agents` / `llm` / `tools`。
 */
export async function httpFixture({
  hostname = '127.0.0.1',
  storage = 'test-database',
  extendCtx,
}: {
  hostname?: string
  storage?: 'test-database' | 'business-only' | 'unconfigured'
  extendCtx?: (ctx: HostStub) => void
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-blog-http-')), routes = new Map<string, WebRoute>(), listeners = new Map<string, Set<(...args: unknown[]) => void>>(), effects: (() => unknown)[] = [], files = new Map<string, Buffer>(), revoked = new Set<string>()
  const actors: Record<string, UserActor> = { alice: { namespace: 'user', userId: 'alice', sessionId: 'session-a' }, bob: { namespace: 'user', userId: 'bob', sessionId: 'session-b' }, eve: { namespace: 'user', userId: 'eve', sessionId: 'session-e' } }
  const token = randomBytes(32).toString('hex'), configPath = join(directory, 'config.json')
  const posts = new Map(), receipts = new Map(); let nextCid = 1
  const attachments: HostStub['attachments'] = { async saveFileStream({ data, name }) { const parts = []; for await (const p of data) parts.push(p); const b = Buffer.concat(parts), attachmentId = createHash('sha256').update(b).digest('hex'); files.set(attachmentId, b); return { attachmentId, name, bytes: b.length } }, async *readFileStream(ref) { yield files.get(ref.attachmentId) } }
  // ---- 环境：这两个变量归夹具所有，`close()` 还原。宿主 shell 里已有的值不该改变断言。 ----
  const previous = { dsn: process.env.AGENTS_GROUP_PG_DSN, config: process.env.AGENTS_GROUP_PG_CONFIG }
  const restoreEnv = () => {
    if (previous.dsn === undefined) delete process.env.AGENTS_GROUP_PG_DSN; else process.env.AGENTS_GROUP_PG_DSN = previous.dsn
    if (previous.config === undefined) delete process.env.AGENTS_GROUP_PG_CONFIG; else process.env.AGENTS_GROUP_PG_CONFIG = previous.config
  }
  /** 起不来时把环境与临时目录收干净，别把宿主的配置漏给后面的用例。 */
  const abandon = async (message: string) => { restoreEnv(); await rm(directory, { recursive: true, force: true }); throw new Error(message) }
  // 缺文件 = "没有配置"（`storage/dsn.ts:47-51`），所以指向夹具目录里一个**不存在**的文件：
  // 开发机上恰好存在缺省 storage.json 时也不改变结论。
  process.env.AGENTS_GROUP_PG_CONFIG = join(directory, 'no-such-storage.json')
  if (storage === 'test-database') {
    if (TEST_DSN === '') await abandon("storage:'test-database' 需要 AGENTS_GROUP_TEST_PG_DSN（真 PostgreSQL 测试库）；测试侧应先按 TEST_DSN 门控")
    process.env.AGENTS_GROUP_PG_DSN = TEST_DSN
    await provisionSchema(TEST_DSN)
  } else if (storage === 'business-only') {
    /**
     * **业务存储好、索引存储坏**：只建 `blog_*`，不建 `dsh_*`。
     *
     * 用来验证就绪探针**不会说谎**：只探业务那一侧的实现会在这里报"就绪"，
     * 而侧栏列表 / 历史 / 发消息（都走索引侧）全失败。见 `provisionSchema` 的 `withIndex`。
     */
    if (TEST_DSN === '') await abandon("storage:'business-only' 需要 AGENTS_GROUP_TEST_PG_DSN（真 PostgreSQL 测试库）；测试侧应先按 TEST_DSN 门控")
    process.env.AGENTS_GROUP_PG_DSN = TEST_DSN
    await provisionSchema(TEST_DSN, { withIndex: false })
  } else if (storage === 'unconfigured') {
    if ((previous.dsn ?? '').trim() !== '') await abandon("storage:'unconfigured' 要求调用方先清掉 AGENTS_GROUP_PG_DSN：否则这一支会静默变成'配置好了'的运行")
    delete process.env.AGENTS_GROUP_PG_DSN
  } else {
    await abandon(`未知的 storage 模式：${storage}（只接受 'test-database' / 'unconfigured'）`)
  }
  const ctx: HostStub = { on(event, fn) { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); return () => group.delete(fn) }, emit(event, ...args) { for (const f of [...listeners.get(event) ?? []]) f(...args) }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup as () => unknown); return cleanup ?? (() => { }) }, get(name) { return name === 'attachments' ? attachments : undefined }, attachments, jobs: { attachController() { return () => { } } }, tools: { register() { return () => { } } }, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } }
  ctx.root = ctx
  /** 替身就是 `Context`：本夹具只实现被测路径用到的面（见 {@link HostStub}），其余成员
   *  （`root` / `events` / `logger` / `reflect` / …）夹具不读也不写，故在此越界一次。 */
  const host = ctx as unknown as Context
  // 就地扩展（见 `extendCtx` 的说明）：必须在下面那条 `ecosystem/providers` 之前。
  extendCtx?.(ctx)
  // 替身的事件通道是宽签名（见 {@link HostStub.on}），所以 `accept` 在这里是 `unknown`；
  // 它的形状由 kit 的 `AuthProvider` 定（见 {@link ProviderAccept}），就地收窄一次。
  ctx.on('ecosystem/providers', accept => (accept as ProviderAccept)({ protocol: 1, ready() { }, resolve(req) { return actors[req.headers.cookie as string] }, assertAccess(actor, pluginId) { if (pluginId !== 'blog' || !Object.values(actors).some(a => a.userId === actor.userId && a.sessionId === actor.sessionId) || actor.userId === 'eve' || revoked.has(actor.sessionId)) { const error = new Error('没有授权') as Error & { code?: string; status?: number }; error.code = 'DSH_ACCESS_ERROR'; error.status = 403; throw error } } }))
  const server = createServer((req, res) => {
    const path = new URL(req.url as string, 'http://localhost').pathname
    if (path === '/action/dsh-blog-bridge') {
      void (async () => {
        let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); let data
        if (input.action === 'status') data = { nativeDrafts: true, management: true, categories: [] }
        else if (input.action === 'list') data = { items: [...posts].map(([cid, p]) => ({ cid, title: p.savedDraft.title, hasSavedDraft: true, hasPublished: false })), status: input.status, hasMore: false }
        else if (input.action === 'get') data = posts.get(input.cid)
        else if (input.action === 'save') {
          if (receipts.has(input.requestId)) data = receipts.get(input.requestId)
          else { const cid = input.base?.savedDraft?.cid ?? nextCid++, snapshot = { version: String(receipts.size + 1), published: null, savedDraft: { ...input.content, cid }, selectedVariant: 'savedDraft' }; posts.set(cid, snapshot); data = { cid, snapshot }; receipts.set(input.requestId, data) }
        } else if (input.action === 'receipt') data = receipts.has(input.requestId) ? { status: 'succeeded', result: receipts.get(input.requestId) } : { status: 'unknown' }
        else if (input.action === 'manage-list') data = { items: [], hasMore: false, page: 1 }
        else if (input.action === 'manage-preview') data = { title: input.fields?.name ?? '条目', input: { kind: input.kind, operation: input.operation, fields: input.fields }, impact: { note: '测试数据' } }
        else if (input.action === 'manage-write') data = { id: 1, kind: input.kind }
        /**
         * ⚠️ `search` 这个动作**此前没有实现**（落进下面的 `else` ⇒ 400 `{ok:false,code:'invalid'}`
         * ⇒ 连接层报 `博客请求字段无效`）。后果：`blog_search_posts` 在本夹具里**从来没有成功执行过**，
         * 而 `mount()` 守卫那条用例原先只断言"错误信息里没有『委派身份』"⇒ 这个业务失败**被静默放过**
         * （错误文案里当然没有"委派身份"）。补上这个动作，守卫才能真正断言"工具**执行成功**"。
         *
         * 形状照 `connectors.mjs:48-55` 的 `search()` 要的字段给：`items` 必填，`pageSize` 可省
         * （省了按 30 算），条目里的 `created`/`modified` 是**秒**。
         */
        else if (input.action === 'search') data = { items: [], total: 0, page: 1, hasMore: false }
        else { res.writeHead(400); res.end(JSON.stringify({ ok: false, code: 'invalid' })); return }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data }))
      })().catch(() => { res.writeHead(500); res.end() }); return
    }
    if (path === '/fixture-login') { res.writeHead(302, { 'set-cookie': 'alice', location: ROUTE_PREFIX }); res.end(); return }
    const route = routes.get(path); if (!route) { res.writeHead(404); res.end(); return }
    void Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  // `Promise<void>` 的 resolve 才能直接当 `listen` 的回调（它不带参数）；`address()` 在
  // `listen` 的回调之后必然已绑定，故按 `AddressInfo` 取一次端口。
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const origin = `http://${hostname}:${(server.address() as AddressInfo).port}`
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, blog: { url: 'https://blog-fixture.invalid', username: 'fixture', password: 'fixture' }, image: { url: 'https://example.invalid', username: 'fixture', password: 'fixture', strategyId: 2 }, backup: { token, url: 'http://127.0.0.1:1', allowedUserIds: ['alice'] } }))
  // 群组给每个 Agent 各建一套鉴权与路由注册器（`src/host.ts:161-171`）；这里照同一套装配。
  const access = createAccess(host, { mode: 'authenticated', pluginId: 'blog', publicOrigin: origin })
  const http = createPluginHttp(host, { access, routePrefix: ROUTE_PREFIX, onError: blogStorageErrorHandler })
  const realFetch = globalThis.fetch; globalThis.fetch = (url, options) => realFetch(String(url).replace('https://blog-fixture.invalid', origin), options)
  let instance: MountedBlog
  try {
    instance = await mount({
      ctx: host,
      access,
      http,
      // `Schema<Config>` 的调用签名要完整的 `Config`，而 `accessMode` / `turnTimeoutMs` 由 schema 的
      // `.default(...)` 补齐（`src/config.ts:20/26`）——部署侧只覆盖这四个键，故在此越界一次。
      config: Config({ runtimeConfig: configPath, dataPath: join(directory, 'data'), publicOrigin: origin, routePrefix: ROUTE_PREFIX } as unknown as Config),
      category: 'agents',
      // 惰性取值（群组也是惰性的：取值发生在子包创建 Agent 时，那时通用工具已注册）。
      // 夹具没有工具目录，如实回本子包自己注册的工具名——它是"本分类"的唯一已知集合。
      // `instance` 的类型是非空的（`Awaited<ReturnType<typeof mount>>`），`?.` / `?? []` 留在这里
      // 是**构造期自引用**的如实写法：这个回调可能在本行所在的 `mount()` 返回之前被调用。
      allowedTools: () => (instance?.tools ?? []).map(tool => tool.name),
    })
  } catch (error) {
    server.closeAllConnections(); await new Promise(r => server.close(r)); for (const cleanup of [...effects].reverse()) await cleanup?.()
    restoreEnv(); await rm(directory, { recursive: true, force: true }); throw error
  } finally { globalThis.fetch = realFetch }
  return {
    origin, ctx, actors, revoked, token,
    /** `mount()` 的返回值：`tools` 是"装载照常"的证据，`health` 是 Q4 口径的就绪探针。 */
    mounted: instance,
    health: instance.health,
    request(path: string, { actor = 'alice', method = 'GET', body, headers = {} }: { actor?: string | null; method?: string; body?: string; headers?: Record<string, string> } = {}) { return fetch(origin + ROUTE_PREFIX + path, { method, redirect: 'manual', headers: { origin, ...actor ? { cookie: actor } : {}, ...headers }, ...body === undefined ? {} : { body } }) },
    api(action: unknown, args: unknown = {}, actor: string | null = 'alice') { return this.request('/api', { method: 'POST', actor, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) }) },
    /**
     * 夹具目录下有没有落下 SQLite 文件（判据 J6 ⑤：未配置时**绝不回退 SQLite**）。
     *
     * PG 模式下 `blog.sqlite` 是**正常的**（本地围栏镜像 + outbox），所以只有未配置模式才该断言它为空。
     */
    async sqliteFiles() { return (await readdir(directory, { recursive: true })).filter(entry => /\.sqlite(?:-(?:journal|wal|shm))?$/.test(entry)) },
    async close() {
      try {
        await instance.dispose()
      } finally {
        try {
          server.closeAllConnections(); await new Promise(r => server.close(r))
          for (const cleanup of [...effects].reverse()) await cleanup?.()
        } finally {
          restoreEnv(); await rm(directory, { recursive: true, force: true })
        }
      }
    },
  }
}
