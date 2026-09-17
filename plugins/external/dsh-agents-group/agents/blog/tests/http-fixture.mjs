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
 * ## 库形状：两块拼起来，而**它们的不一致本身就是待办**
 *
 * 夹具建的形状 = **今天代码的真实形状**：
 *
 * 1. 业务六表 + `blog_schema_version` 取自 blog 自己的迁移
 *    （`migrations/postgres/0001_init.sql`）——`src/storage/pg.mjs:76` 今天仍在读
 *    `blog_schema_version`，用的仍是 `owner` + `data` 旧列；
 * 2. 框架四表（`dsh_schema_versions` / `dsh_conversations` / `dsh_turns` / `dsh_turn_results`）
 *    取自新库 DDL（`private-deploy/db/0001_init.sql`）里的 `dsh_` 语句——索引侧走运行时端口，
 *    要的正是这一套。
 *
 * ⚠️ 新库 DDL 里 `blog_*` 六表**已经是新形状**（`owner_namespace` / `owner_id` / `payload`），
 * 而且**没有** `blog_schema_version`（设计 §5.1：每插件一张版本表 → `dsh_schema_versions` 一行）。
 * 两处对不上 ⇒ **业务存储还没迁到新形状**：今天用 `private-deploy/db/create.mjs` 建出的库里，
 * blog 会以 `storage_schema_missing` 永久未就绪（不是装载失败，是"未就绪"，界面上只是探针 503）。
 * 本夹具把现状如实拼出来（不拼的话这几条用例根本跑不起来），**切完之后它会红——那是正确信号**，
 * 届时跟着改的应该是 `src/storage/pg.mjs` 的版本核验与列名。
 *
 * ## 其它两条约束
 *
 * - 加载的是**构建产物** `../dist/index.mjs`（`test:host` 测发布形态），跑之前要 `pnpm build`。
 * - `blog.sqlite` 在 PG 模式下是**正常的**：它是本地围栏镜像 + outbox（`storage/index.ts` 文件头），
 *   只有未配置模式才断言它不出现（判据 J6 ⑤）。
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { createAccess, createPluginHttp } from '@dsh-plugin-manager/plugin-kit'
import { applySchema, splitStatements, sqlWithAppliedAt } from '../../../../../../private-deploy/db/create.mjs'
import { Config, blogStorageErrorHandler, mount } from '../dist/index.mjs'

/** 真 PG 的门控变量：测试侧据此决定那几条依赖存储的用例跑还是跳过。 */
export const TEST_DSN = process.env.AGENTS_GROUP_TEST_PG_DSN ?? ''

/** 夹具用的路由前缀：与 `Config` 的缺省值一致，显式写出来是因为临时服务按它拼路径。 */
const ROUTE_PREFIX = '/blog'

/** blog 自己的业务结构（旧形状：`owner` + `data` + `blog_schema_version`）。 */
const BLOG_MIGRATION = new URL('../migrations/postgres/0001_init.sql', import.meta.url)
/** 新库 DDL：框架四表与 `dsh_schema_versions` 的唯一来源。 */
const PRIVATE_DDL = new URL('../../../../../../private-deploy/db/0001_init.sql', import.meta.url)

/**
 * 只取"定义 `dsh_` 表/索引"和"写版本行"的语句。
 *
 * 不能按"语句里出现过 `dsh_`"来筛：`butler_tasks` 的复合外键指向 `dsh_conversations`，
 * 那样会把管家表一起拖进来（而它自己的外键目标不在集合里 ⇒ 建表失败）。按**语句开头**筛就只见
 * `CREATE TABLE dsh_*` / `CREATE INDEX dsh_*` / `INSERT INTO dsh_schema_versions`，
 * 文件的 `BEGIN;` / `COMMIT;` 自然被排除（`applySchema` 自己会套一对事务）。
 */
const FRAMEWORK_STATEMENT = /^(?:CREATE (?:UNIQUE )?(?:TABLE|INDEX) dsh_|INSERT INTO dsh_schema_versions\b)/

/** 安静地应用结构：夹具不关心语句条数，`applySchema` 的日志会污染 `node --test` 的 TAP 输出。 */
const QUIET = { log: () => {} }

/**
 * 在测试库里重建夹具需要的结构。
 *
 * 清库前核对库名确实以 `_test` 结尾（与 `tests/pg-smoke.test.mjs` 同一道闸）：配错 DSN 时
 * 立即失败，绝不 `DROP` 别的库。
 */
async function provisionSchema(dsn) {
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
    await applySchema(client, await readFile(BLOG_MIGRATION, 'utf8'), QUIET)
    const privateDdl = sqlWithAppliedAt(await readFile(PRIVATE_DDL, 'utf8'))
    const framework = splitStatements(privateDdl).map(statement => statement.trim()).filter(statement => FRAMEWORK_STATEMENT.test(statement))
    if (framework.length === 0) throw new Error(`新库 DDL（${PRIVATE_DDL.pathname}）里没有找到框架表语句：夹具的结构来源已失效`)
    await applySchema(client, `${framework.join(';\n')};\n`, QUIET)
  } finally {
    await client.end()
  }
}

/**
 * 造一个夹具。
 *
 * @param options.storage `'test-database'`（真 PG，缺省）或 `'unconfigured'`（没有存储配置）
 * @param options.hostname 对外 origin 里的主机名（与 `publicOrigin` 一致）
 */
export async function httpFixture({ hostname = '127.0.0.1', storage = 'test-database' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-blog-http-')), routes = new Map(), listeners = new Map(), effects = [], files = new Map(), revoked = new Set()
  const actors = { alice: { namespace: 'user', userId: 'alice', sessionId: 'session-a' }, bob: { namespace: 'user', userId: 'bob', sessionId: 'session-b' }, eve: { namespace: 'user', userId: 'eve', sessionId: 'session-e' } }
  const token = randomBytes(32).toString('hex'), configPath = join(directory, 'config.json')
  const posts = new Map(), receipts = new Map(); let nextCid = 1
  const attachments = { async saveFileStream({ data, name }) { const parts = []; for await (const p of data) parts.push(p); const b = Buffer.concat(parts), attachmentId = createHash('sha256').update(b).digest('hex'); files.set(attachmentId, b); return { attachmentId, name, bytes: b.length } }, async *readFileStream(ref) { yield files.get(ref.attachmentId) } }
  // ---- 环境：这两个变量归夹具所有，`close()` 还原。宿主 shell 里已有的值不该改变断言。 ----
  const previous = { dsn: process.env.AGENTS_GROUP_PG_DSN, config: process.env.AGENTS_GROUP_PG_CONFIG }
  const restoreEnv = () => {
    if (previous.dsn === undefined) delete process.env.AGENTS_GROUP_PG_DSN; else process.env.AGENTS_GROUP_PG_DSN = previous.dsn
    if (previous.config === undefined) delete process.env.AGENTS_GROUP_PG_CONFIG; else process.env.AGENTS_GROUP_PG_CONFIG = previous.config
  }
  /** 起不来时把环境与临时目录收干净，别把宿主的配置漏给后面的用例。 */
  const abandon = async message => { restoreEnv(); await rm(directory, { recursive: true, force: true }); throw new Error(message) }
  // 缺文件 = "没有配置"（`storage/dsn.ts:47-51`），所以指向夹具目录里一个**不存在**的文件：
  // 开发机上恰好存在缺省 storage.json 时也不改变结论。
  process.env.AGENTS_GROUP_PG_CONFIG = join(directory, 'no-such-storage.json')
  if (storage === 'test-database') {
    if (TEST_DSN === '') await abandon("storage:'test-database' 需要 AGENTS_GROUP_TEST_PG_DSN（真 PostgreSQL 测试库）；测试侧应先按 TEST_DSN 门控")
    process.env.AGENTS_GROUP_PG_DSN = TEST_DSN
    await provisionSchema(TEST_DSN)
  } else if (storage === 'unconfigured') {
    if ((previous.dsn ?? '').trim() !== '') await abandon("storage:'unconfigured' 要求调用方先清掉 AGENTS_GROUP_PG_DSN：否则这一支会静默变成'配置好了'的运行")
    delete process.env.AGENTS_GROUP_PG_DSN
  } else {
    await abandon(`未知的 storage 模式：${storage}（只接受 'test-database' / 'unconfigured'）`)
  }
  const ctx = { on(event, fn) { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); return () => group.delete(fn) }, emit(event, ...args) { for (const f of [...listeners.get(event) ?? []]) f(...args) }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup); return cleanup ?? (() => { }) }, get(name) { return name === 'attachments' ? attachments : undefined }, attachments, jobs: { attachController() { return () => { } } }, tools: { register() { return () => { } } }, webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } }
  ctx.root = ctx
  ctx.on('ecosystem/providers', accept => accept({ protocol: 1, ready() { }, resolve(req) { return actors[req.headers.cookie] }, assertAccess(actor, pluginId) { if (pluginId !== 'blog' || !Object.values(actors).some(a => a.userId === actor.userId && a.sessionId === actor.sessionId) || actor.userId === 'eve' || revoked.has(actor.sessionId)) { const error = new Error('没有授权'); error.code = 'DSH_ACCESS_ERROR'; error.status = 403; throw error } } }))
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
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
        else { res.writeHead(400); res.end(JSON.stringify({ ok: false, code: 'invalid' })); return }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data }))
      })().catch(() => { res.writeHead(500); res.end() }); return
    }
    if (path === '/fixture-login') { res.writeHead(302, { 'set-cookie': 'alice', location: ROUTE_PREFIX }); res.end(); return }
    const route = routes.get(path); if (!route) { res.writeHead(404); res.end(); return }
    void Promise.resolve(route.handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://${hostname}:${server.address().port}`
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, blog: { url: 'https://blog-fixture.invalid', username: 'fixture', password: 'fixture' }, image: { url: 'https://example.invalid', username: 'fixture', password: 'fixture', strategyId: 2 }, backup: { token, url: 'http://127.0.0.1:1', allowedUserIds: ['alice'] } }))
  // 群组给每个 Agent 各建一套鉴权与路由注册器（`src/host.ts:161-171`）；这里照同一套装配。
  const access = createAccess(ctx, { mode: 'authenticated', pluginId: 'blog', publicOrigin: origin })
  const http = createPluginHttp(ctx, { access, routePrefix: ROUTE_PREFIX, onError: blogStorageErrorHandler })
  const realFetch = globalThis.fetch; globalThis.fetch = (url, options) => realFetch(String(url).replace('https://blog-fixture.invalid', origin), options)
  let instance
  try {
    instance = await mount({
      ctx,
      access,
      http,
      config: Config({ runtimeConfig: configPath, dataPath: join(directory, 'data'), publicOrigin: origin, routePrefix: ROUTE_PREFIX }),
      category: 'agents',
      // 惰性取值（群组也是惰性的：取值发生在子包创建 Agent 时，那时通用工具已注册）。
      // 夹具没有工具目录，如实回本子包自己注册的工具名——它是"本分类"的唯一已知集合。
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
    request(path, { actor = 'alice', method = 'GET', body, headers = {} } = {}) { return fetch(origin + ROUTE_PREFIX + path, { method, redirect: 'manual', headers: { origin, ...actor ? { cookie: actor } : {}, ...headers }, ...body === undefined ? {} : { body } }) },
    api(action, args = {}, actor = 'alice') { return this.request('/api', { method: 'POST', actor, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) }) },
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
