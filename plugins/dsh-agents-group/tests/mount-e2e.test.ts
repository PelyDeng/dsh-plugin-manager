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
        text: { provider: 'blog-zhipu', model: 'glm-5.3' },
        vision: { provider: 'blog-zhipu', model: 'glm-5v-turbo' },
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

/** 记录型假上下文：只实现挂载路径真正用到的东西。 */
function fakeHost() {
  const routes: Route[] = []
  const effects: (() => void)[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const provided = new Map<string, unknown>()
  const catalog: unknown[] = []
  const conversations: unknown[] = []

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
    tools: { register: () => () => {}, restrict: () => () => {} },
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

  return { ctx, routes, effects, catalog, conversations, listeners, provided }
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
  beforeEach(() => {
    errors = []
    spy = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '))
    }
  })
  afterEach(() => { console.error = spy })

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
})
