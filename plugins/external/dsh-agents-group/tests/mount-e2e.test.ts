/**
 * 群组端到端挂载验证。
 *
 * 构建通过只证明编译正确；这个测试证明**群组真的把子包注册到了正确的位置**：
 * 页面路由挂在 /agents/closedoff 下、目录条目 id 与授权标识一致、各项注册都发生。
 *
 * 这是迁移后最关键的回归点 —— 路径、权限、id 三者只要有一处不一致，就会出现
 * 「授权了但页面进不去」或「会话管理找不到 provider」这类极难查的问题。
 *
 * 全部用替身：不连真实网关、不建真实会话、不访问网络。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyGroup } from '../src/index.ts'
import { Config as GroupConfig } from '../src/config.ts'
/** 测试用的站点 origin。认证模式的 Agent 必须能拿到它，否则会如实拒绝装载。 */
const PUBLIC_ORIGIN = 'https://butler.test'

/**
 * 写一份群组业务配置，并让 AGENTS_GROUP_CONFIG 指向它。全部是替身凭据。
 *
 * 博客的业务配置（Typecho、图床、备份、模型路由）也必须在这里给出，否则
 * `loadSettings` 会因为缺少必需小节而拒绝装载 —— 那是设计上的正确行为。
 */
function writeGroupConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-group-'))
  const file = join(dir, 'group.json')
  writeFileSync(file, JSON.stringify({
    closedoff: {
      CLOSEDOFF_BASE_URL: 'https://gateway.test/',
      CLOSEDOFF_OPEN_CLIENT_ID: 'open-id',
      CLOSEDOFF_OPEN_CLIENT_SECRET: 'open-secret',
      CLOSEDOFF_APP_CODE: 'app-code',
      CLOSEDOFF_APP_CLIENT_ID: 'app-id',
      CLOSEDOFF_APP_CLIENT_SECRET: 'app-secret',
      CLOSEDOFF_USERNAME: 'tester',
    },
    blog: {
      schemaVersion: 1,
      models: {
        text: { provider: 'zhipu', model: 'glm-5.3' },
        vision: { provider: 'zhipu', model: 'glm-5v-turbo' },
      },
      blog: { url: 'https://blog.test', username: 'tester', password: 'secret' },
      image: { url: 'https://image.test', username: 'tester', password: 'secret', strategyId: 2, maxBytes: 1048576 },
      backup: { url: 'http://127.0.0.1:7913', token: 'backup-token', allowedUserIds: [] },
    },
  }))
  process.env.AGENTS_GROUP_CONFIG = file
  return file
}

interface Route { kind: string; path: string; handler: unknown }

/** 本文件各测试装载后注册的释放函数；afterEach 逆序排空，避免句柄跨测试泄漏。 */
const pendingCleanups: (() => unknown)[] = []

/** 记录型假上下文：只实现挂载路径真正用到的东西。 */
function fakeHost() {
  const routes: Route[] = []
  const effects: (() => unknown)[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const provided = new Map<string, unknown>()
  const catalog: unknown[] = []
  const conversations: unknown[] = []
  /** 全局注册的工具名，以及每一次 restrict 规则。 */
  const registeredTools: string[] = []
  const restrictions: { allow?: readonly string[]; deny?: readonly string[] }[] = []
  // 每次装载注册的释放函数要真的执行（afterEach 统一排空）：closedoff 装载会打开
  // ~/.dsh 下的真实会话库，泄漏的句柄会在多次装载后以 database is locked 暴露。
  pendingCleanups.push(() => {
    for (const dispose of [...effects].reverse()) {
      const outcome = dispose()
      if (outcome instanceof Promise) outcome.catch(() => {})
    }
  })

  const emit = (name: string, accept: (value: unknown) => void) => {
    if (name === 'ecosystem/providers') return
    for (const listener of listeners.get(name) ?? []) listener(accept)
  }

  const ctx = {
    effect: (factory: () => unknown) => { const d = factory(); if (typeof d === 'function') effects.push(d as () => void); return () => {} },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      // 只登记监听器，不预置任何条目：预置会让 listPlugins 读到结构不完整的记录。
      // registerPlugin / registerConversations 注册的受理回调由 root.emit 触发。
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    get: (name: string) => provided.get(name),
    set: (name: string, value: unknown) => { provided.set(name, value); return value },
    provide: (name: string, value: unknown) => { provided.set(name, value); return value },
    root: { emit },
    webServer: { register: (route: Route) => { routes.push(route); return () => {} } },
    // 子包在挂载期会用到这几个服务；给最小替身即可，不需要真实实现。
    llm: { resolveModelInfo: async () => undefined, resolveCallConfig: async (v: unknown) => v },
    agents: { list: () => [], get: () => undefined },
    tools: {
      register: (tool: { name: string }) => {
        // 记录全局注册的工具：分类限制算的就是这些名字。
        registeredTools.push(tool.name)
        return () => {}
      },
      restrict: (rule: { allow?: readonly string[]; deny?: readonly string[] }) => {
        // 记录插件级 restrict 调用。
        //
        // 群组**不应该**走到这里：宿主要求 restrict 只能落在 agent 作用域里，插件级限制会
        // 波及所有 Agent（包括牛马大总管自己，它需要 butler_plan）。群组改为把 allow 列表通过
        // `allowedToolsOf` 注入子包、由子包在 agent 作用域内应用。保留这条记录是为了让
        // 「误在插件级做限制」这件事有迹可循，而不是变成静默的越权。
        restrictions.push(rule)
        return () => {}
      },
    },
    // 博客用到作业运行时与附件服务：挂载期只注册控制器，不真正跑任务。
    jobs: {
      attachController: () => () => {},
      start: () => 'job-1',
      wait: async () => ({ status: 'completed' }),
      get: () => ({ status: 'completed' }),
      kill: () => {},
    },
    attachments: { saveFileStream: async () => ({ id: 'att-1' }) },
  } as unknown as Context

  return { ctx, routes, effects, catalog, conversations, listeners, provided, registeredTools, restrictions }
}

/**
 * 群组配置。
 *
 * 默认用 authenticated：博客的业务前提是可信身份，只有配了 origin 它才会装载；
 * 用 standalone 会得到一个「合法但没用」的群组，测不出真实装配。
 */
function groupConfig(accessMode: 'standalone' | 'authenticated' = 'authenticated') {
  return GroupConfig({
    accessMode,
    publicOrigin: PUBLIC_ORIGIN,
    routePrefix: '/agents',
    authRecheckMs: 100,
  } as never)
}

/** 认证模式下需要一个提供者，否则 access.ready() 会失败。 */
function installProvider(ctx: Context) {
  const listeners: ((accept: (value: unknown) => void) => void)[] = []
  const root = (ctx as unknown as { root: { emit: (name: string, accept: (v: unknown) => void) => void } }).root
  const fire = root.emit
  root.emit = (name: string, accept: (v: unknown) => void) => {
    if (name === 'ecosystem/providers') {
      accept({
        protocol: 1,
        ready: () => {},
        resolve: () => ({ namespace: 'user', userId: 'tester', sessionId: 'login-1' }),
        assertAccess: () => {},
      })
      return
    }
    fire(name, accept)
  }
  return listeners
}

describe('群组端到端挂载', () => {
  let errors: string[]
  let spy: typeof console.error
  let previousHome: string | undefined
  beforeEach(() => {
    errors = []
    spy = console.error
    // 隔离 DSH 主目录：closedoff 装载会打开真实主目录下的会话库，测试并发访问它
    // 会以 database is locked 偶发失败，也不该碰用户数据。
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'agents-group-e2e-home-'))
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '))
    }
  })
  afterEach(async () => {
    console.error = spy
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    for (const dispose of pendingCleanups.splice(0).reverse()) {
      const outcome = dispose()
      if (outcome instanceof Promise) await outcome.catch(() => {})
    }
  })

  it('把两个子包的页面路由注册在各自前缀下', async () => {
    const host = fakeHost()
    writeGroupConfig()
    installProvider(host.ctx)
    await applyGroup(host.ctx, groupConfig())

    const paths = host.routes.map(route => route.path)
    // 任何一个子包装载失败都要把原因带出来，否则这里会变成一个查不出原因的断言。
    expect(errors, `子包装载失败：${errors.join(' | ')}`).toEqual([])
    // 群组自身的探针
    expect(paths).toContain('/agents/health')
    expect(paths).toContain('/agents/ready')
    // 每个子包的页面与探针都挂在它自己的前缀下
    expect(paths).toContain('/agents/closedoff')
    expect(paths).toContain('/agents/blog')
    expect(paths).toContain('/agents/closedoff/ready')
    expect(paths).toContain('/agents/blog/ready')
    // 不能有人占用群组根，否则总览页以后没有位置
    expect(paths.filter(path => path === '/agents').length).toBe(0)
  }, 30000)

  it('每个注册的路由都落在自己的前缀内，没有越界注册', async () => {
    const host = fakeHost()
    writeGroupConfig()
    installProvider(host.ctx)
    await applyGroup(host.ctx, groupConfig())
    for (const route of host.routes) {
      const allowed = route.path === '/agents' || route.path.startsWith('/agents/')
      expect(allowed, `越界路由：${route.path}`).toBe(true)
    }
  }, 30000)

  it('挂载失败被隔离：子系统报错不影响群组自身的探针', async () => {
    const host = fakeHost()
    // 故意让业务配置缺失，迫使两个子包都装载失败。
    process.env.AGENTS_GROUP_CONFIG = ''
    delete process.env.CLOSEDOFF_ENV_CONF
    await applyGroup(host.ctx, groupConfig('standalone'))
    // 子包失败，但群组探针仍然挂上了：这是合并成单进程后的硬要求。
    const paths = host.routes.map(route => route.path)
    expect(paths).toContain('/agents/health')
    expect(paths).toContain('/agents/ready')
    // 两个子包各自的探针也仍然存在，只是会报不就绪 —— 运维才能看出是谁坏了。
    expect(paths).toContain('/agents/closedoff/ready')
    expect(paths).toContain('/agents/blog/ready')
  }, 30000)

  it('强制认证的子包在 standalone 群里仍能挂载，认证缺失在使用时才暴露', async () => {
    const host = fakeHost()
    writeGroupConfig()
    // 不装提供者：群组是 standalone，但博客的 access 建为 authenticated。
    // 缺 provider 不该让装载失败 —— 页面路由照常注册，请求时才报告认证不可用，
    // 这样运维能看到「谁在这儿」，而不是整个子包凭空消失。
    await applyGroup(host.ctx, groupConfig('standalone'))
    expect(errors, `不应有装载失败：${errors.join(' | ')}`).toEqual([])
    const paths = host.routes.map(route => route.path)
    expect(paths).toContain('/agents/blog')
    expect(paths).toContain('/agents/blog/ready')
  }, 30000)

  it('群组自身缺少 publicOrigin 时快速失败，并给出可读原因', async () => {
    const host = fakeHost()
    writeGroupConfig()
    // authenticated 模式必须配 origin。这是宿主级配置错误：静默降级成匿名可写是安全事故，
    // 所以群组自己就不该装起来，而且原因要能一眼看懂。
    await expect(applyGroup(host.ctx, GroupConfig({
      accessMode: 'authenticated',
      publicOrigin: '',
      routePrefix: '/agents',
      authRecheckMs: 100,
    } as never))).rejects.toThrow(/publicOrigin/u)
  }, 30000)

  it('注册了通用工具，且群组不在插件级做工具限制', async () => {
    const host = fakeHost()
    writeGroupConfig()
    installProvider(host.ctx)
    await applyGroup(host.ctx, groupConfig())

    // 通用工具真的注册了，而且是「通用工具」分类。
    expect(host.registeredTools).toContain('common_weather')

    /**
     * 群组**不该**自己调用 `ctx.tools.restrict`。
     *
     * 宿主要求 restrict 只能落在 agent 作用域里（`requires a scoped context (agent.ctx)`）：
     * 插件级限制会波及所有 Agent，包括牛马大总管自己的 —— 而牛马大总管需要 `butler_plan`。所以群组的职责
     * 只到「算出 allow 列表并通过 `allowedToolsOf` 注入子包」，应用限制是子包在 agent 作用域里
     * 的事。
     *
     * 这条断言守的就是这个边界：一旦有人在群组里图省事直接 restrict，会先在这里失败。
     */
    expect(host.restrictions, '群组不应在插件级设置工具限制').toEqual([])
  }, 30000)

  it('可见性规则的算式由独立模块覆盖，这里只守「群组不越界」', async () => {
    const host = fakeHost()
    writeGroupConfig()
    installProvider(host.ctx)
    await applyGroup(host.ctx, groupConfig())

    // 取值函数只在装载时被注入子包、不会留在假上下文里，所以规则本身由
    // tests/visibility.test.ts 覆盖；这里确认注册与路由仍然正常。
    expect(host.registeredTools).toContain('common_weather')
    expect(host.routes.map(route => route.path)).toContain('/agents/closedoff')
  }, 30000)

  it('Q4 口径：缺 PG 配置时 blog 与 closedoff 都未就绪（503+稳定原因）但群组照常装载', async () => {
    const host = fakeHost()
    writeGroupConfig()
    installProvider(host.ctx)
    const previousConfig = process.env.AGENTS_GROUP_PG_CONFIG
    const previousDsn = process.env.AGENTS_GROUP_PG_DSN
    // 显式指向不存在的配置文件：默认路径是否存在不应影响测试结果。
    process.env.AGENTS_GROUP_PG_CONFIG = join(tmpdir(), 'agents-group-test-missing-env.conf')
    delete process.env.AGENTS_GROUP_PG_DSN
    try {
      await applyGroup(host.ctx, groupConfig())
    } finally {
      if (previousConfig === undefined) delete process.env.AGENTS_GROUP_PG_CONFIG
      else process.env.AGENTS_GROUP_PG_CONFIG = previousConfig
      if (previousDsn === undefined) delete process.env.AGENTS_GROUP_PG_DSN
      else process.env.AGENTS_GROUP_PG_DSN = previousDsn
    }

    // 群组照常装载：页面与探针都在，两个 Agent 的路由也都已注册（未就绪 ≠ 不装载）。
    const paths = host.routes.map(route => route.path)
    expect(paths).toContain('/agents/blog')
    expect(paths).toContain('/agents/blog/ready')
    expect(paths).toContain('/agents/closedoff')
    expect(paths).toContain('/agents/closedoff/ready')
    const blogReady = await probe(host, '/agents/blog/ready')
    expect(blogReady.status).toBe(503)
    expect(blogReady.body.ok).toBe(false)
    expect(blogReady.body.error).toContain('未配置')
    /**
     * ⚠️ **P4 的行为变更，断言必须跟着改（不是把 `toBe(true)` 改成 `toBe(false)` 就完事）**。
     *
     * 迁移前 closedoff 的会话索引是它自己的 SQLite 文件 ⇒ 不依赖任何外部服务 ⇒ **永远就绪**，
     * 所以这里原来断的是 `ready === true`。P4 之后它和其他私有 Agent 一样用 PG 的
     * `dsh_conversations`（设计 §3.2），**缺配置就是未就绪**。
     *
     * 断言强度刻意保留在**原因**上：只断 `ready === false` 的话，"未配置"与"配了但连不上"
     * 这两件事在测试里就分不开了，而它们对运维是两个完全不同的动作（去写配置 / 去查网络与库）。
     * 所以下一条在 PG 不可达场景里断的是 `storage_unreachable`，两条合起来才钉住"原因如实上报"。
     */
    const closedoffReady = await probe(host, '/agents/closedoff/ready')
    expect(closedoffReady.status).toBe(503)
    expect(closedoffReady.body.ok).toBe(false)
    expect(closedoffReady.body.error).toContain('未配置')
    // 原因里必须带**配置方法**：只说"未配置"会让接手的人不知道去配哪个变量。
    expect(closedoffReady.body.error).toContain('AGENTS_GROUP_PG_DSN')
    expect(closedoffReady.body.error).toContain('AGENTS_GROUP_PG_CONFIG')
    /**
     * ⚠️ **未就绪也必须注册业务工具**，这条是判据而不是补充。
     *
     * `createAgentRuntime` 是 `definition.tools` 的唯一调用点，而它只在存储建好之后才走到那里。
     * 所以"缺配置"这条路径上如果不同样注册一次，`runtime.tools` 就是空数组 ⇒ 群组算出的
     * `allowedTools` 里一个 closedoff 工具都没有 ⇒ 模型手里空无一物，**而且不报错**（限制一份
     * 空集合是合法的）。同时，群组的 `/ready` 只依据探针，页面也不显示工具数，所以这件事在
     * 界面上完全看不出来。
     *
     * 实测：把未就绪路径上那次显式调用删掉，**只有这条断言变红**。
     */
    expect(host.registeredTools).toContain('closedoff_park_status')
    expect(host.registeredTools.filter(name => name.startsWith('closedoff_')).length).toBeGreaterThan(0)
    // 群组就绪汇总：两个 Agent 都未就绪 ⇒ 整体 503 且 `ok` 为假，明细如实标出各自原因。
    // （`authReady` 仍然是真：认证本身是好的，坏的是两个 Agent 的存储。）
    const groupReady = await probe(host, '/agents/ready')
    expect(groupReady.status).toBe(503)
    expect(groupReady.body.authReady).toBe(true)
    expect(groupReady.body.ok).toBe(false)
    const agents = (groupReady.body as { agents?: { id: string, ready: boolean, error?: string }[] }).agents ?? []
    for (const id of ['blog', 'closedoff']) {
      const agent = agents.find(item => item.id === id)
      expect(agent?.ready, id).toBe(false)
      expect(agent?.error, id).toContain('未配置')
    }
  }, 30000)

  it('Q4 口径：PG 不可达（127.0.0.1:1）时 blog 与 closedoff 探针都是 503+storage_unreachable，群组仍在线', async () => {
    const host = fakeHost()
    writeGroupConfig()
    installProvider(host.ctx)
    const previousDsn = process.env.AGENTS_GROUP_PG_DSN
    const previousConfig = process.env.AGENTS_GROUP_PG_CONFIG
    process.env.AGENTS_GROUP_PG_DSN = 'postgres://127.0.0.1:1/agents_group'
    // 顺手把配置文件指到不存在的位置：这条场景要验的是"**配了但连不上**"，
    // 不该因为开发机上恰好存在缺省配置文件而变成另一条路径。
    process.env.AGENTS_GROUP_PG_CONFIG = join(tmpdir(), 'agents-group-test-missing-env.conf')
    try {
      await applyGroup(host.ctx, groupConfig())
    } finally {
      if (previousDsn === undefined) delete process.env.AGENTS_GROUP_PG_DSN
      else process.env.AGENTS_GROUP_PG_DSN = previousDsn
      if (previousConfig === undefined) delete process.env.AGENTS_GROUP_PG_CONFIG
      else process.env.AGENTS_GROUP_PG_CONFIG = previousConfig
    }

    // 连接被拒：两个 Agent 都已装载但未就绪，healthPath 按稳定码说明原因。
    const blogReady = await probe(host, '/agents/blog/ready')
    expect(blogReady.status).toBe(503)
    expect(blogReady.body.ok).toBe(false)
    expect(blogReady.body.error).toContain('storage_unreachable')
    /**
     * closedoff 同上（P4 的行为变更）：它现在依赖 PG，所以"PG 不可达"对它同样是未就绪。
     * 断的是**稳定码**而不是一句布尔：`storage_unreachable` 与上一条的"未配置"是两种不同的
     * 故障，运维看到的原因必须能区分它们（这是改写这条断言时唯一被允许的改动方向）。
     */
    const closedoffReady = await probe(host, '/agents/closedoff/ready')
    expect(closedoffReady.status).toBe(503)
    expect(closedoffReady.body.ok).toBe(false)
    expect(closedoffReady.body.error).toContain('storage_unreachable')
    /**
     * ⚠️ **"配了但不可达"也必须登记业务工具目录**，这条是与上面"未配置"那条并列的判据。
     *
     * `createAgentRuntime` 是 `definition.tools` 的唯一调用点，而它只在存储建好之后才走到那里。
     * 不可达路径（`runtime.ts` 的 `catch` 分支）此前**只记日志**：`tools` 空数组 ⇒ 群组算出空
     * 的 `allowedTools` ⇒ 模型手里一个 closedoff 工具都没有，而且**完全静默**（限制一份空集合
     * 是合法的、页面也不显示工具数）。这个缺口比"未配置"那条更危险：线上 PG 抖一次就会走到它。
     *
     * 实测：把 `catch` 分支里那次显式调用删掉，**只有本条断言变红**（上面"未配置"那条走的是另一条
     * 分支，不受影响）。
     */
    expect(host.registeredTools).toContain('closedoff_park_status')
    expect(host.registeredTools.filter(name => name.startsWith('closedoff_')).length).toBeGreaterThan(0)
    const groupReady = await probe(host, '/agents/ready')
    // 两个 Agent 都未就绪 ⇒ 汇总 503（迁移前 closedoff 恒就绪，这里是 200）。
    expect(groupReady.status).toBe(503)
    expect(groupReady.body.ok).toBe(false)
    const agents = (groupReady.body as { agents?: { id: string, ready: boolean, error?: string }[] }).agents ?? []
    for (const id of ['blog', 'closedoff']) {
      const agent = agents.find(item => item.id === id)
      expect(agent?.ready, id).toBe(false)
      expect(agent?.error, id).toContain('storage_unreachable')
    }
  }, 30000)

  it('Q4 口径：blog 的 HTTP 错误渲染把存储稳定码映射为 503/409，其余保持 kit 默认', async () => {
    const { blogStorageErrorHandler } = await import('../src/agents/blog.ts')
    const render = (error: unknown) => {
      const response = {
        headersSent: false,
        statusCode: 0,
        body: '',
        writeHead(status: number) { this.statusCode = status },
        end(chunk: string) { this.body = String(chunk) },
      }
      blogStorageErrorHandler(response as never, error)
      return { status: response.statusCode, body: JSON.parse(response.body) }
    }
    const { AccessError } = await import('@dsh-plugin-manager/plugin-kit')
    const { StorageError } = await import('../agents/blog/src/storage/errors.ts')
    const unreachable = render(new StorageError('storage_unreachable', '存储连接失败'))
    expect(unreachable.status).toBe(503)
    expect(unreachable.body.code).toBe('storage_unreachable')
    expect(render(new StorageError('storage_unconfigured', '未配置')).status).toBe(503)
    expect(render(new StorageError('storage_constraint', '存储约束冲突')).status).toBe(409)
    expect(render(new StorageError('storage_unknown', '存储未知故障')).status).toBe(500)
    const business = render(new AccessError(404, '草稿不存在或无权访问'))
    expect(business.status).toBe(404)
    expect(business.body.error).toBe('草稿不存在或无权访问')
    expect(render(new Error('boom'))).toEqual({ status: 500, body: { error: '请求处理失败' } })

    /**
     * ⚠️ **跨副本**：上面那些 `StorageError` 全是 `errors.ts` **自己那一份类**的实例，
     * 所以 `instanceof` 当然认得出 —— 那样的断言**分不出两种实现**（正是"假绿"的形状）。
     * 而生产上索引侧的一切故障都由**运行时那一份类**抛出（`packages/runtime/src/storage/errors.ts`，
     * 与这一份是各自独立的 `class StorageError extends Error`）。用 `instanceof` 时它们会掉进
     * "未知错误"分支变成 **500**，把 runbook 第 5 步要看的那颗稳定码抹掉。
     * 这里直接用**运行时真正的那个类**构造，所以它只在 `isStorageError` 生效时才是绿的。
     */
    const { StorageError: RuntimeStorageError } = await import('../packages/runtime/src/storage/errors.ts')
    const foreign = render(new RuntimeStorageError('storage_schema_missing', '索引库结构未初始化'))
    expect(foreign.status).toBe(503)
    expect(foreign.body.code).toBe('storage_schema_missing')
    // 未发布/不可达也各走一遍，确认不是"恰好那条码被特判"。
    expect(render(new RuntimeStorageError('storage_unreachable', '连接被拒绝')).status).toBe(503)
    expect(render(new RuntimeStorageError('storage_constraint', '唯一约束冲突')).status).toBe(409)
    // 未知码仍要有归宿：500 且**带上原码**（不能既降级又丢码）。
    // 这一条刻意**不用任何一份类**构造：运行时的 `StorageErrorCode` 是一个联合类型，本来就**写不出**
    // 未知码 —— 而 `isStorageError` 认的是三个稳定字段、不是原型链，所以"第三份副本"（形状相同、
    // 类不同、码不在联合里）也必须被认出来。
    const thirdCopy = Object.assign(new Error('没见过的码'), { name: 'StorageError', code: 'storage_something_new' })
    expect(render(thirdCopy))
      .toEqual({ status: 500, body: { error: '服务处理请求失败', code: 'storage_something_new' } })
  }, 30000)
})

/** 直接调用群组注册的公共探针路由，取回状态码与 JSON 正文。 */
async function probe(host: ReturnType<typeof fakeHost>, path: string): Promise<{ status: number, body: Record<string, never> & { [key: string]: unknown } }> {
  const route = host.routes.find(item => item.path === path)
  expect(route, `路由未注册：${path}`).toBeDefined()
  const response = {
    headersSent: false,
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status },
    end(chunk: string) { this.body = String(chunk) },
  }
  await (route!.handler as (request: unknown, response: unknown) => Promise<void>)({}, response)
  return { status: response.statusCode, body: JSON.parse(response.body) }
}
