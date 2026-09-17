/**
 * Real HTTP requests with local fake Agents: no model or business gateway is contacted.
 *
 * ## P4 之后的构造（夹具留下的部分没动，换的只是"谁提供会话"这一层）
 *
 * 迁移前这里 `new ConversationStore(':memory:')` + `new ConversationManager(...)`，再把它交给
 * `installWeb`。P4 之后会话生命周期、归属判定与存储都在运行时里，所以夹具改成装配
 * `createAgentRuntime`，把它的 `lifecycle` / `store` / `provider` 交给 `installWeb`。
 *
 * 替身的选择有明确理由：
 *
 * - **存储用 `tests/fixtures/memory-conversation-port.ts`**（群组共享的内存端口）：它逐条对齐
 *   真实实现的**可观测语义**（`create` 预留 + `publish` 发布两段握手、`syncTitle` 的"自动标题
 *   不覆盖手动标题"、`pin` 只改标记、归属不泄露存在性）。本文件要验的是 **HTTP 与鉴权**，不是
 *   存储后端；用真 PG 会把这一层测成另一种东西（而且 P4 明确不跑真 PG 契约）。
 * - **模型侧用 `bus` 上的假目录**：宿主与模型都不参与，`selectModel` 只走目录校验。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessError, createAccess, createPluginHttp, emitRevoked, installProvider, onRevoked, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type { RuntimeConfig } from '../../../packages/runtime/src/conversation.ts'
import { createAgentRuntime, type AgentRuntimeAssembly } from '../../../packages/runtime/src/runtime.ts'
import type { AgentDatabasePort, AgentStoragePort, ConversationPort, TurnStorePort } from '../../../packages/runtime/src/storage/ports.ts'
import { MemoryConversationPort } from '../../../tests/fixtures/memory-conversation-port.ts'
import { Config } from '../src/config.ts'
import { installWeb, renderHttpError } from '../src/web.ts'

/** 装配后从运行时里取出来的那几个面——本文件的用例只通过它们说话。 */
interface RuntimeFaces {
  readonly lifecycle: AgentRuntimeAssembly['lifecycle']
  readonly provider: AgentRuntimeAssembly['provider']
  readonly store: ConversationPort
  dispose(): Promise<void>
}

type Route = { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
// The test bus hosts multiple event signatures and forwards the original argument tuple unchanged.
type Listener = (...args: any[]) => void
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture(mode: 'standalone' | 'authenticated' = 'authenticated') {
  const effects: (() => void)[] = []
  const listeners = new Map<string, Set<Listener>>()
  const routes = new Map<string, Route>()
  const revoked = new Set<string>()
  const actors = new Map<string, Actor>([
    ['alice', { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }],
    ['alice-other', { namespace: 'user', userId: 'alice', sessionId: 'alice-other-login' }],
    ['bob', { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }],
  ])
  const cancel = vi.fn()
  const followup = vi.fn()
  const feedback = vi.fn(async () => ({ ok: true, value: { items: [] } }))
  const port = new MemoryConversationPort('closedoff')
  /** 宿主侧能力：`get` 走这张表，符合 cordis 的 `ctx.get(name)` 形状。 */
  const provided = new Map<string, unknown>()
  // 会话移除需要宿主的归档能力与只读日志（kit 的 `conversationRemover` 会核验两者）。
  // 给最小替身即可：本文件验的是"删除走通了同一条围栏"，不是归档实现。
  provided.set('workspaceRegistry', {
    archivedSessionIds: [],
    archiveSession: async () => {},
  })
  provided.set('sessionPersistence', { inspect: async () => ({ events: [], inheritedEventCount: 0 }) })
  const services = {
    llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }), resolveCallConfig: async (value: unknown) => value },
    sessionController: { modelCatalog: vi.fn(async () => ({ groups: [{ id: 'test', name: 'Test', models: [{ id: 'test', name: 'Test' }] }], failures: [] })) },
    webServer: { register(route: Route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
    messageFeedback: { list: feedback, put: vi.fn(), delete: vi.fn() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: {
      create: vi.fn(async () => ({ agent: { cancel, followup, whenIdle: vi.fn(async () => {}), session: { snapshotEvents: () => [] } }, dispose: vi.fn(async () => undefined) })),
      resume: vi.fn(async () => ({ agent: { cancel, followup, whenIdle: vi.fn(async () => {}), session: { snapshotEvents: () => [] } }, dispose: vi.fn(async () => undefined) })),
      list: () => [],
    },
  }
  const bus = {
    ...services,
    // `get` 是 cordis 的取值入口：kit 与运行时都用 `ctx.get('名字')` 拿服务。
    // 两条来源都要通：`services`（本文件提供的宿主面）与 `provided`（用例按需布置的）。
    get: (key: string): unknown => provided.get(key) ?? (services as Record<string, unknown>)[key],
    on(name: string, listener: Listener) {
      const group = listeners.get(name) ?? new Set<Listener>()
      group.add(listener); listeners.set(name, group)
      const dispose = () => { group.delete(listener) }
      effects.push(dispose); return dispose
    },
    emit(name: string, ...args: unknown[]) { for (const listener of [...listeners.get(name) ?? []]) listener(...args) },
    effect(effect: () => (() => void)) { const dispose = effect(); effects.push(dispose); return dispose },
  }
  const ctx = Object.assign(bus, { root: bus }) as unknown as Context
  const removeProvider = installProvider(ctx, {
    protocol: 1,
    ready: () => {},
    resolve: req => actors.get(req.headers.cookie ?? ''),
    assertAccess: actor => { if (actor.namespace !== 'user' || revoked.has(actor.sessionId)) throw new AccessError(401, '登录失效') },
  })
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.get(path) ?? [...routes.values()].find(item => item.kind === 'prefix' && path.startsWith(`${item.path}/`))
    if (!route) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const access: Access = createAccess(ctx, { mode, pluginId: 'closedoff', publicOrigin: origin })
  const config = Config({ accessMode: mode, publicOrigin: origin, authRecheckMs: 100 } as Config)
  const runtimeConfig: RuntimeConfig = {
    routePrefix: config.routePrefix,
    turnTimeoutMs: config.turnTimeoutMs,
    authRecheckMs: config.authRecheckMs,
    maxActiveConversations: config.maxActiveConversations,
    reasoningEffort: config.reasoningEffort,
  }
  // 工具钩子返回空目录：本文件不验业务工具，只验 HTTP 与鉴权。
  let lifecycle: AgentRuntimeAssembly['lifecycle'] | undefined
  const assembled = await createAgentRuntime({
    ctx,
    definition: {
      id: 'closedoff',
      displayName: '封闭化管理智能助手',
      description: '用例替身',
      persona: 'persona',
      config: {} as never,
      // 与装配侧同一条口径：`lifecycle.authorizeAgent`，悬空调用时返回 undefined（本文件不调工具）。
      tools: () => [],
    },
    access,
    config: runtimeConfig,
    allowedTools: () => [],
    // 注入已建好的门面 ⇒ 装配不会去 `createAgentDatabase`，也就不会碰真 PG 或本地文件。
    storage: {
      db: {
        assertSchema: async () => {},
        conversations: port,
        turns: {
          claim: async () => 'claimed',
          finish: async () => {},
          turnStatus: async () => undefined,
          // 结果层本文件不涉及；真实覆盖在 `dsh-agents-group/tests/runtime-turn-results.test.ts`。
          turnId: async () => undefined,
          appendTurnResult: async () => '',
          turnResults: async () => [],
          // ③-A 的端口增量（`turnById` / `turnsOf` / `patchTurnPayload`）本文件也不涉及。这里**故意抛**
          // 而不是返回空值：静默返回 `undefined` / `[]` / `{}` 会把"线接到了这里"伪装成成功（假绿）。
          // 真实覆盖在 `dsh-agents-group/tests/storage-contract.test.ts`（真 PG）。
          turnById: async () => { throw new Error('本文件的替身不实现 turnById') },
          turnsOf: async () => { throw new Error('本文件的替身不实现 turnsOf') },
          patchTurnPayload: async () => { throw new Error('本文件的替身不实现 patchTurnPayload') },
          pendingQuestion: async () => undefined,
          setPendingQuestion: async () => {},
        } as TurnStorePort,
        query: async () => [],
        transaction: async <T>(fn: (tx: AgentDatabasePort) => Promise<T>) => fn({} as AgentDatabasePort),
        close: async () => {},
      } as unknown as AgentDatabasePort,
      access,
    } satisfies AgentStoragePort,
  })
  lifecycle = assembled.lifecycle
  const runtime: RuntimeFaces = {
    lifecycle: assembled.lifecycle,
    provider: assembled.provider,
    store: assembled.store,
    dispose: assembled.dispose,
  }
  onRevoked(ctx, () => runtime.lifecycle.revokeInvalid())
  // installWeb 接收注入的 HTTP 注册器（由群组创建）。这里按群组的真实做法构造：
  // 带上本子包自己的错误渲染器，否则参数校验失败会被报成 500，前端无法区分输错和服务故障。
  const http = createPluginHttp(ctx, { access, routePrefix: config.routePrefix, onError: renderHttpError })
  await installWeb(ctx, config, { lifecycle: runtime.lifecycle, store: runtime.store, provider: runtime.provider }, access, http)
  cleanup.push(async () => {
    for (const dispose of effects.reverse()) dispose()
    await runtime.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const request = (path: string, cookie = 'alice', data?: unknown, extra: Record<string, string> = {}) => fetch(origin + path, {
    redirect: 'manual', method: data === undefined ? 'GET' : 'POST',
    headers: { cookie, origin, 'content-type': 'application/json', ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  return { request, actors, runtime, bus, ctx, revoked, cancel, followup, feedback, port, removeProvider, lifecycle }
}

describe('HTTP authentication and conversation ownership', () => {
  it('searches, pins and renames only owned idle sidebar conversations', async () => {
    const { request, actors, lifecycle } = await fixture()
    const actor = actors.get('alice')!, first = (await lifecycle.open(undefined, true, actor))!, second = (await lifecycle.open(undefined, true, actor))!
    const action = (data: unknown, cookie = 'alice') => request('/closedoff-qa/conversation-action', cookie, data)
    expect((await action({ operation: 'rename', ids: [first.id], title: '园区概览' })).status).toBe(200)
    expect((await action({ operation: 'pin', ids: [first.id], pinned: true })).status).toBe(200)
    const list = await (await request('/closedoff-qa/conversations?q=' + encodeURIComponent('园区'))).json()
    // `pinned` 换了载体：端口给的是 **boolean**，旧 SQLite 行给的是 `0|1` 数字。页面用的是真假
    // 判断（`if (item.pinned)`），所以行为等价；断言跟着载体改成 `true`。
    expect(list.items).toEqual([expect.objectContaining({ id: first.id, title: '园区概览', pinned: true })])
    expect((await action({ operation: 'rename', ids: [first.id], title: '越权' }, 'bob')).status).toBe(404)
    expect((await action({ operation: 'rename', ids: [first.id], title: ' ' })).status).toBe(400)
    expect((await action({ operation: 'pin', ids: [first.id, second.id], pinned: true })).status).toBe(400)
    // 忙碌判定走运行时的 `isBusy`（同一个 `active` 字段 + 正在打开 + 正在分支）。
    first.active = true
    expect((await action({ operation: 'rename', ids: [first.id], title: '忙碌' })).status).toBe(409)
    first.active = false
    expect((await action({ operation: 'rename', ids: [first.id], title: '拒绝' }, '')).status).toBe(401)
    expect((await request('/closedoff-qa/conversation-action', 'alice', { operation: 'pin', ids: [first.id], pinned: false }, { origin: 'https://foreign.test' })).status).toBe(403)
  })
  it('removes an owned conversation through the same fence as the sidebar', async () => {
    const { request, actors, lifecycle } = await fixture()
    const actor = actors.get('alice')!
    const target = (await lifecycle.open(undefined, true, actor))!
    expect((await lifecycle.list(actor, { offset: 0, limit: 30, q: '', state: '' }, { hostBusy: [], archived: [] })).items.map(item => item.id)).toEqual([target.id])
    // 先钉住"删除真的走通了围栏"，再说它比迁移前更好：旧实现这里会落到一个 `ConversationStore`
    // 并不满足的 `ConversationRemovalStore` 契约上（缺 `conversationOf`），TypeError 被 kit 收成
    // `failed` ⇒ 一律 409。页面上的"删除"从此不再必然失败。
    expect((await request('/closedoff-qa/conversation-action', 'alice', { operation: 'delete', ids: [target.id] })).status).toBe(200)
    expect((await lifecycle.list(actor, { offset: 0, limit: 30, q: '', state: '' }, { hostBusy: [], archived: [] })).items).toEqual([])
    expect((await request('/closedoff-qa/conversation-action', 'bob', { operation: 'delete', ids: [target.id] })).status).toBe(404)

    // 旧 `manager.update`（`agent.ts:459`）在进入操作分支**之前**就把这三条一起判掉了：`ids` 非空、
    // ≤100、全字符串、**无重复** ⇒ 400「对话操作无效」。切换载体时只剩"非空"，重复 id 会一路走到
    // 移除围栏，报出来的是围栏自己的 400/409 与另一套文案 —— 前端拿到的分类就和旧实现分叉了。
    const other = (await lifecycle.open(undefined, true, actor))!
    const duplicate = await request('/closedoff-qa/conversation-action', 'alice', { operation: 'delete', ids: [other.id, other.id] })
    expect(duplicate.status).toBe(400)
    expect((await duplicate.json()).error).toBe('对话操作无效')
    // 同一条上限（101 条）也走同一个 400，而不是让围栏去回答。
    const tooMany = Array.from({ length: 101 }, (_, index) => `closedoff-web-00000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`)
    const oversized = await request('/closedoff-qa/conversation-action', 'alice', { operation: 'delete', ids: tooMany })
    expect(oversized.status).toBe(400)
    expect((await oversized.json()).error).toBe('对话操作无效')
    // 被拦住的两条都没有真的移除任何东西。
    expect((await lifecycle.list(actor, { offset: 0, limit: 30, q: '', state: '' }, { hostBusy: [], archived: [] })).items.map(item => item.id)).toEqual([other.id])
  })
  it('lists only the conversations the page can open, and keeps the busy one', async () => {
    const { request, actors, lifecycle, port } = await fixture()
    const actor = actors.get('alice')!
    const ready = (await lifecycle.open(undefined, true, actor))!
    const doomed = (await lifecycle.open(undefined, true, actor))!
    // 端口那一层（真实现同样是 `removal_state <> 'removed'`）**会**把这条查出来，而它点开是 404、
    // 在本页再删也是 404（`assertConversation` 挡住）⇒ 页面上的死行。旧实现的列表判据是
    // `deletedAt IS NULL AND removal_state = ''`，本来就不含它。
    port.mark(actor, doomed.id, 'failed')
    const listed = await (await request('/closedoff-qa/conversations')).json()
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([ready.id])
    // 留下的行必须带 `state`：页面靠它决定能不能打开（把 `state` 丢掉，就退回"看着能点、点开 404"）。
    expect(listed.items[0]).toMatchObject({ id: ready.id, state: 'ready' })

    // `busy`（正在回答）**照旧出现**，而且必须带 `state: 'busy'`：这条路不能退回"给端口传
    // `state: 'ready'`"——`lifecycle.list` 会把本实例的忙集合合进 `scope.busy`，那样切会把正在
    // 回答的这一条也滤掉（列表刷新时它凭空消失）。旧实现里 `busy` 是运行时现算的，不参与过滤。
    ready.active = true
    const busy = await (await request('/closedoff-qa/conversations')).json()
    expect(busy.items.map((item: { id: string }) => item.id)).toEqual([ready.id])
    expect(busy.items[0]).toMatchObject({ state: 'busy' })
  })
  it('searches conversation titles instead of ids', async () => {
    const { request, actors, lifecycle, port } = await fixture()
    const actor = actors.get('alice')!
    const titled = (await lifecycle.open(undefined, true, actor))!
    await lifecycle.open(undefined, true, actor)
    await port.syncTitle({ namespace: 'user', userId: 'alice' }, titled.id, '园区概览', 'manual')

    // 页面的 placeholder 是"搜索对话标题"，端口缺省却是"标题 OR 会话 id"。id 形如
    // `closedoff-web-<uuid>` ⇒ `titleOnly` 没传下去时 `q=web` 会命中**全部**会话（搜索框看起来
    // 完全没生效），而单看标题时一条都不该命中。
    expect((await (await request('/closedoff-qa/conversations?q=web')).json()).items).toEqual([])
    const searched = await (await request('/closedoff-qa/conversations?q=' + encodeURIComponent('园区'))).json()
    expect(searched.items.map((item: { id: string }) => item.id)).toEqual([titled.id])
  })
  it('reports a removed cached model as an SSE error without dispatching a followup', async () => {
    const { request, actors, lifecycle, bus, followup } = await fixture()
    const c = (await lifecycle.open(undefined, true, actors.get('alice')!))!
    bus.sessionController.modelCatalog.mockResolvedValueOnce({ groups: [], failures: [] })
    const response = await request('/closedoff-qa/chat', 'alice', { conversationId: c.id, message: '不可派发' })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('该模型不在当前目录中')
    expect(followup).not.toHaveBeenCalled()
    expect(c.active).toBe(false)
  })
  it('stopping during catalog await prevents the later HTTP continuation from calling the Agent', async () => {
    const { request, actors, lifecycle, bus, followup } = await fixture()
    const c = (await lifecycle.open(undefined, true, actors.get('alice')!))!
    const catalog = await bus.sessionController.modelCatalog()
    let release!: (value: typeof catalog) => void
    bus.sessionController.modelCatalog.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const response = await request('/closedoff-qa/chat', 'alice', { conversationId: c.id, message: '等待目录' })
    const reader = response.body!.getReader()
    await reader.read()
    expect(c.active).toBe(true)
    expect((await request('/closedoff-qa/stop', 'alice', { conversationId: c.id })).status).toBe(200)
    release(catalog)
    let remaining = ''
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value) }
    expect(remaining).toContain('本轮操作已停止')
    expect(followup).not.toHaveBeenCalled()
    expect(c.active).toBe(false)
  })
  it('redirects the page, rejects anonymous APIs and validates mutation origin', async () => {
    const { request } = await fixture()
    expect((await request('/closedoff-qa', '')).status).toBe(303)
    for (const path of ['/identity', '/conversations', '/history']) expect((await request('/closedoff-qa' + path, '')).status).toBe(401)
    expect((await request('/closedoff-qa/chat', 'alice', { message: 'q' }, { origin: 'https://foreign.test' })).status).toBe(403)
    expect((await request('/closedoff-qa/conversations?limit=100000')).status).toBe(400)
    // 存活与就绪探针由群组统一提供（/agents/health、/agents/ready 与 /agents/<id>/ready）。
    // 子包不再注册自己的探针：容器级探针是群组的职责，重复一份还会因前缀来源不同而冲突。
    expect((await request('/closedoff-qa/health', '')).status).toBe(404)
    expect((await request('/closedoff-qa/ready', '')).status).toBe(404)
  })
  it('rejects every foreign conversation operation before reading history or feedback', async () => {
    const { request, actors, lifecycle, feedback, cancel } = await fixture()
    const owned = (await lifecycle.open(undefined, true, actors.get('alice')!))!
    expect((await request('/closedoff-qa/history?conversationId=' + owned.id, 'bob')).status).toBe(404)
    for (const route of ['chat', 'stop', 'branch', 'feedback']) {
      const response = await request('/closedoff-qa/' + route, 'bob', { conversationId: owned.id, message: 'q', atSeq: 2, messageId: 'm', rating: 'positive', userId: 'alice' })
      expect(response.status, route).toBe(404)
    }
    expect(feedback).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect((await (await request('/closedoff-qa/conversations', 'alice')).json()).items).toHaveLength(1)
    expect((await (await request('/closedoff-qa/conversations', 'bob')).json()).items).toEqual([])
  })
  it('ends an active SSE on revocation and never sends a late private event', async () => {
    const { request, revoked, ctx, bus, cancel } = await fixture()
    const response = await request('/closedoff-qa/chat', 'alice', { message: 'q' })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const initial = new TextDecoder().decode((await reader.read()).value)
    const id = JSON.parse(initial.slice(6).trim()).conversationId
    revoked.add('alice-login'); emitRevoked(ctx, { sessionId: 'alice-login' })
    bus.emit('session/event', { id }, { type: 'assistant/message', data: { step: 1, message: { id: 'm', content: [{ type: 'text', text: 'SECRET' }] } } })
    expect(await reader.read()).toEqual({ value: undefined, done: true })
    expect(cancel).toHaveBeenCalled()
    expect((await request('/closedoff-qa/chat', 'alice-other', { conversationId: id, message: 'new login' })).status).toBe(409)
    bus.emit('session/event', { id }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    const next = await request('/closedoff-qa/chat', 'alice-other', { conversationId: id, message: 'new login' })
    expect(next.status).toBe(200)
    await next.body!.cancel()
  })
  it('bounds session expiry even without a revocation event', async () => {
    const { request, revoked } = await fixture()
    const response = await request('/closedoff-qa/chat', 'alice', { message: 'q' })
    const reader = response.body!.getReader()
    await reader.read()
    revoked.add('alice-login')
    expect(await reader.read()).toEqual({ value: undefined, done: true })
  })
  it('fails closed when a provider is removed while standalone remains usable', async () => {
    const authenticated = await fixture()
    authenticated.removeProvider()
    expect((await authenticated.request('/closedoff-qa/history')).status).toBe(503)
    // 探针归群组所有；这里只确认业务接口在认证不可用时的失败关闭行为。
    const standalone = await fixture('standalone')
    standalone.removeProvider()
    expect((await standalone.request('/closedoff-qa', '')).status).toBe(200)
    expect((await standalone.request('/closedoff-qa/conversations', '')).status).toBe(200)
    expect(() => standalone.lifecycle.authorizeAgent(undefined)).not.toThrow()
  })

  // 页面模块按文件名直接引用、没有内容指纹：长缓存会让回访浏览器跑「新 app.js + 旧 cards.js」。
  // 这里对真实响应头取证；`pnpm test` 会先跑 build:web 生成 web/assets。
  it.skipIf(!existsSync(fileURLToPath(new URL('../web/assets/cards.js', import.meta.url))))('revalidates first-party page modules and still long-caches vendored bundles', async () => {
    const { request } = await fixture()
    for (const asset of ['cards.js', 'app.js', 'app.css', 'labels.js', 'format.js', 'render-text.js', 'model-picker.js', 'trajectory.js']) {
      const response = await request(`/closedoff-qa/assets/${asset}`)
      expect(response.status, asset).toBe(200)
      expect(response.headers.get('cache-control'), asset).toBe('no-cache')
    }
    const vendored = await request('/closedoff-qa/assets/video-player/vue.global.prod.js')
    expect(vendored.status).toBe(200)
    expect(vendored.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    // 认证仍然在读取文件之后、写响应之前生效：未登录拿不到内容。
    expect((await request('/closedoff-qa/assets/cards.js', '')).status).toBe(401)
  })
})
