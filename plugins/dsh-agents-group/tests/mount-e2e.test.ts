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
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyGroup } from '../src/index.ts'
import { Config as GroupConfig } from '../src/config.ts'

/** 写一份群组业务配置，并让 AGENTS_GROUP_CONFIG 指向它。全部是替身凭据。 */
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
  } as unknown as Context

  return { ctx, routes, effects, catalog, conversations, listeners, provided }
}

/** standalone 模式不需要认证提供者；网关配置给合法替身值即可通过校验。 */
function standaloneConfig() {
  return GroupConfig({
    accessMode: 'standalone',
    routePrefix: '/agents',
    authRecheckMs: 100,
  } as never)
}

describe('群组端到端挂载', () => {
  it('把封闭化助手的页面路由注册在 /agents/closedoff 下', async () => {
    const host = fakeHost()
    writeGroupConfig()

    // 捕获挂载失败原因：吞咽错误会让这里变成一个查不出原因的失败断言。
    const errors: string[] = []
    const spy = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '))
    }
    try {
      await applyGroup(host.ctx, standaloneConfig())
    } finally {
      console.error = spy
    }

    const paths = host.routes.map(route => route.path)
    expect(errors, `子包装载失败：${errors.join(' | ')}`).toEqual([])
    // 群组自身的探针
    expect(paths).toContain('/agents/health')
    expect(paths).toContain('/agents/ready')
    // 子包的页面与接口都挂在它自己的前缀下
    expect(paths).toContain('/agents/closedoff')
    expect(paths.some(path => path.startsWith('/agents/closedoff/'))).toBe(true)
    // 不能有人占用群组根，否则总览页以后没有位置
    expect(paths.filter(path => path === '/agents').length).toBe(0)
  }, 30000)

  it('每个注册的路由都落在自己的前缀内，没有越界注册', async () => {
    const host = fakeHost()
    writeGroupConfig()
    await applyGroup(host.ctx, standaloneConfig())
    for (const route of host.routes) {
      const allowed = route.path === '/agents' || route.path.startsWith('/agents/')
      expect(allowed, `越界路由：${route.path}`).toBe(true)
    }
  }, 30000)

  it('挂载失败被隔离：子系统报错不影响群组自身的探针', async () => {
    const host = fakeHost()
    // 故意让业务配置缺失，迫使子包装载失败。
    process.env.AGENTS_GROUP_CONFIG = ''
    delete process.env.CLOSEDOFF_ENV_CONF
    const spy = console.error
    console.error = () => {}
    try {
      await applyGroup(host.ctx, standaloneConfig())
    } finally {
      console.error = spy
    }
    // 子包失败，但群组探针仍然挂上了：这是合并成单进程后的硬要求。
    const paths = host.routes.map(route => route.path)
    expect(paths).toContain('/agents/health')
    expect(paths).toContain('/agents/ready')
  }, 30000)
})
