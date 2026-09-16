/**
 * 左栏历史查询的契约。
 *
 * 背景：页面写死 `limit: 40`，服务端 `maxHistoryPageSize` 默认 30 —— 一次查询被服务端按
 * 「参数无效」拒掉，页面上只留下「读取记录失败」。两端的测试各自都过：谁都没写错，
 * 错的是它们之间的那个数。这个组合直到真机上第一次打开左栏才暴露。
 *
 * 而且它在服务端一点痕迹都没有：4xx 是**已知错误**，`onError` 只对未知错误打日志。
 *
 * 所以这里钉三件事：
 *
 * 1. 分页上限来自服务端注入的配置，页面里不留字面量。
 * 2. 页面将要发的那个请求，服务端真的接受 —— 拿注入出来的值打真路由。
 * 3. 按会话取活：打开一个历史会话，不因为「它的活不在第一页」而显示成没派过活。
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import { SqliteButlerStorage } from '../src/storage/sqlite-adapter.ts'
import { STORAGE_SCHEMA_VERSION } from '../src/storage/postgres.ts'
import { TaskStore } from '../src/store.ts'
import { installWeb } from '../src/web.ts'

const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const other: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }
const conversationA = 'butler-web-11111111-1111-4111-8111-111111111111'
const conversationB = 'butler-web-22222222-2222-4222-8222-222222222222'

/** 服务端的上限，下面几条断言都围绕它。 */
const PAGE_LIMIT = 30

class FakeResponse {
  status = 0
  headersSent = false
  writableEnded = false
  private readonly chunks: string[] = []

  writeHead(status: number): void {
    this.status = status
    this.headersSent = true
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(chunk)
    this.writableEnded = true
  }

  get text(): string {
    return this.chunks.join('')
  }
}

function request(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage
}

async function fixture() {
  const store = new TaskStore(':memory:')
  const access = {
    mode: 'authenticated',
    ready() {},
    resolve: () => actor,
    assert() {},
  } as unknown as Access
  const config = {
    accessMode: 'authenticated',
    publicOrigin: 'http://localhost:3080',
    routePrefix: '/butler',
    maxRequestBodyBytes: 65536,
    maxMessageChars: 8000,
    maxResultChars: 8000,
    maxAvatarBytes: 262144,
    subtaskTimeoutMs: 10_000,
    waitingTimeoutMs: 600_000,
    idempotencyTtlMs: 600_000,
    maxConversationEvents: 200,
    maxHistoryPageSize: PAGE_LIMIT,
  } as Config

  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>>()
  const ctx = {
    effect: (run: () => unknown) => { run(); return () => {} },
    on: () => () => {},
    webServer: {
      register: (route: { kind: string; path: string; handler: unknown }) => {
        routes.set(`${route.kind} ${route.path}`, route.handler as never)
        return () => {}
      },
    },
  } as unknown as Context

  const console_ = new ButlerConsole(ctx, config, access, new SqliteButlerStorage(store), '')
  await installWeb(ctx, config, console_, access, { ready: true, schemaVersion: STORAGE_SCHEMA_VERSION })

  /** 打真路由：查询串留在 url 里给处理函数自己解析。 */
  const get = async (target: string) => {
    const path = target.split('?')[0]!
    const handler = routes.get(`exact ${path}`)
    if (handler === undefined) throw new Error(`路由未注册：${path}`)
    const response = new FakeResponse()
    await handler(request('GET', target), response as unknown as ServerResponse)
    return response
  }

  /** 给某位用户开一条会话，并发一个活进去。 */
  const seed = (owner: Actor, conversationId: string, taskId: string, goal: string) => {
    store.openOrReserveConversation(conversationId, owner)
    store.createTask({
      id: taskId, conversationId, actor: owner, goal, note: '',
      subtasks: [{ id: 's1', goal: '起草', agentId: 'blog', reason: '' }],
    })
  }

  return { store, console_, config, get, seed }
}

/** 从服务端真正发出去的页面里取出注入的配置。 */
function injectedConfig(html: string): { historyPageSize?: number; routePrefix?: string } {
  const found = /globalThis\.__BUTLER_CONFIG__=(\{[\s\S]*?\});<\/script>/u.exec(html)
  if (found === null) throw new Error('页面里没有注入 __BUTLER_CONFIG__')
  return JSON.parse(found[1]!) as { historyPageSize?: number; routePrefix?: string }
}

const source = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8')

describe('分页上限只有一个来源：服务端配置', () => {
  it('页面拿到的上限就是服务端的上限，而且这个值真的能被服务端接受', async () => {
    const f = await fixture()
    const html = await f.get('/butler')
    const injected = injectedConfig(html.text)
    expect(injected.historyPageSize).toBe(PAGE_LIMIT)

    // 页面将要用注入的这个值去请求——服务端必须收下。
    const ok = await f.get(`/butler/history?offset=0&limit=${injected.historyPageSize}`)
    expect(ok.status).toBe(200)

    // 旧写法：页面自己写死 40。服务端拒了它，页面只会说「读取记录失败」。
    const stale = await f.get('/butler/history?offset=0&limit=40')
    expect(stale.status).toBe(400)
    expect(JSON.parse(stale.text)).toMatchObject({ code: 'history_query_invalid' })

    f.store.close()
  })

  it('第二入口也能从 /identity 问到上限，不必猜', async () => {
    const f = await fixture()
    const identity = await f.get('/butler/identity')
    expect(identity.status).toBe(200)
    expect(JSON.parse(identity.text)).toMatchObject({
      routePrefix: '/butler',
      historyPageSize: PAGE_LIMIT,
    })
    f.store.close()
  })

  it('页面里不再有写死的分页数', async () => {
    const [api, app] = await Promise.all([source('api.js'), source('app.js')])
    // 默认值取自注入的配置，而不是一个字面量。
    expect(api).toContain('config.historyPageSize')
    expect(api).not.toMatch(/limit\s*=\s*\d/u)
    // 调用处也别再传死数：传了就等于把上限又写回页面里。
    expect(app).not.toMatch(/api\.history\([^)]*limit/u)
  })
})

describe('按会话取活', () => {
  it('只返回那个会话的任务，不再靠在页面上筛第一页', async () => {
    const f = await fixture()
    f.seed(actor, conversationA, 'task-a', '写一篇园区安全博客')
    f.seed(actor, conversationB, 'task-b', '查一下今天的通行情况')

    const page = await f.get(`/butler/history?conversationId=${conversationA}`)
    expect(page.status).toBe(200)
    const items = JSON.parse(page.text).items as { id: string; conversationId: string }[]
    expect(items.map(item => item.id)).toEqual(['task-a'])
    expect(items.every(item => item.conversationId === conversationA)).toBe(true)

    // 不给会话时照旧看全部：这条过滤是可选的，不是新的必需条件。
    const all = await f.get('/butler/history')
    expect((JSON.parse(all.text).items as unknown[]).length).toBe(2)
    f.store.close()
  })

  it('别人的会话拿不到，也不泄露它存在', async () => {
    const f = await fixture()
    f.seed(other, conversationB, 'task-b', '别人的活')

    const denied = await f.get(`/butler/history?conversationId=${conversationB}`)
    expect(denied.status).toBe(404)
    expect(JSON.parse(denied.text)).toMatchObject({ code: 'conversation_not_found' })
    f.store.close()
  })

  it('会话 id 形状不对就当场拒，不让它走到查询里', async () => {
    const f = await fixture()
    const bad = await f.get('/butler/history?conversationId=../../etc/passwd')
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.text)).toMatchObject({ code: 'conversation_invalid' })
    f.store.close()
  })
})
