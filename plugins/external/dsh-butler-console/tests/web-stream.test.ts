/**
 * HTTP 层的接口契约测试。
 *
 * 「执行与观察分离」在服务端内部已经由 `run-subscription.test.ts` 钉住；这里验证它对外的
 * 表现，也就是游戏侧真正会依赖的那几条：
 *
 * - 提交之后关掉连接，任务继续跑（不再被当成取消）。
 * - `/events` 只读，能把同一轮重放给第二个入口，且不重跑任务。
 * - 游标落后于窗口时返回 `reset`，而不是交回半轮事件。
 * - `/stop` 的响应区分「已受理」与「没停到东西」。
 *
 * 走的是真实的 `installWeb` 与真实的 `ButlerConsole`，只把宿主侧的 webServer 换成假的 ——
 * 真路由、真事件流，而不是另写一套模型去猜它们的行为。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { AccessError, type Access, type Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import { StorageError } from '../src/storage/errors.ts'
import { STORAGE_SCHEMA_VERSION } from '../src/storage/postgres.ts'
import type { ButlerStorage } from '../src/storage/types.ts'
import { installWeb } from '../src/web.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

/** 一条 SSE 响应。`disconnect()` 模拟浏览器关页面或断网。 */
class FakeResponse {
  status = 0
  headersSent = false
  writableEnded = false
  destroyed = false
  private readonly chunks: string[] = []
  private readonly closeListeners: (() => void)[] = []

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
    this.emitClose()
  }

  once(event: string, listener: () => void): void {
    if (event === 'close') this.closeListeners.push(listener)
  }

  /** 客户端断开：只触发一次，和真实响应一致。 */
  disconnect(): void {
    this.destroyed = true
    this.emitClose()
  }

  get text(): string {
    return this.chunks.join('')
  }

  /**
   * 解析出的 SSE 事件。
   *
   * 结束标记 `[DONE]` 归一成 `'[DONE]'`：它是协议的一部分，断言里要能一眼看出来
   * 「流正常收尾」和「流被掐断」的区别。
   */
  events(): (Record<string, unknown> & { type?: string })[] {
    return this.text.split('\n\n').filter(block => block !== '').map(block => {
      const line = block.split('\n').find(item => item.startsWith('data: ')) ?? 'data: '
      const payload = line.slice('data: '.length)
      return payload === '[DONE]' ? { type: '[DONE]' } : JSON.parse(payload) as Record<string, unknown>
    })
  }

  /** 只要事件类型，便于直接比对整条序列。 */
  types(): string[] {
    return this.events().map(event => String(event.type))
  }

  private emitClose(): void {
    for (const listener of this.closeListeners.splice(0)) listener()
  }
}

/** 一条 IncomingMessage 的最小替身；带正文时按异步可迭代提供，`body()` 就是这么读的。 */
function request(method: string, url: string, payload?: unknown): IncomingMessage {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  return {
    method,
    url,
    headers: payload === undefined
      ? {}
      : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield Buffer.from(body)
    },
  } as unknown as IncomingMessage
}

interface Call {
  readonly response: FakeResponse
  /** 路由处理完成。流式接口要等这一轮结束才 resolve。 */
  readonly pending: Promise<void>
}

interface Fixture {
  console_: ButlerConsole
  /** 大总管会话的替身，「任务只执行一次」这类断言要看它。 */
  agent: { followup: ReturnType<typeof vi.fn> }
  call: (method: 'GET' | 'POST', path: string, payload?: unknown) => Call
  endTurn: () => void
  /** 让大总管这一轮以失败收场，用来验证流内的错误事件。 */
  failTurn: () => void
  store: ButlerStorage
}

/** 装好插件：真路由 + 真会话，只有宿主与存储是替身。 */
async function fixture(options: {
  maxConversationEvents?: number
  assertOwner?: () => void
  /** /ready 的运行期存储探针；不传时 /ready 不做运行期核实（夹具口径）。 */
  storageProbe?: () => Promise<void>
  /** 让 access.ready() 抛错（认证服务不可用），验证 /ready 的第一道闸。 */
  accessFailReady?: boolean
} = {}): Promise<Fixture> {
  /**
   * 幂等记录在这里用一张内存表顶上。
   *
   * 本文件测的是 HTTP 层怎么用它（同一个 id 给回原凭据、冲突怎么拒），**跨重启的持久化**
   * 另有一组用真实索引的测试（见 `external-pending.test.ts` 与 `idempotency.test.ts`）。
   */
  const requests = new Map<string, { kind: string; digest: string; state: string; runId: string; conversationId: string }>()
  const requestKey = (who: Actor, kind: string, id: string) => `${who.userId}:${kind}:${id}`
  const store = {
    touchConversation: vi.fn(),
    assertOwner: vi.fn(options.assertOwner ?? (() => {})),
    task: vi.fn(() => undefined),
    setSubtaskState: vi.fn(),
    request: (who: Actor, kind: string, id: string) => requests.get(requestKey(who, kind, id)),
    // 唯一胜者语义：已经有人占过就把那条记录交回去，本次不算赢（真实存储在同一个事务里判）。
    claimRequest: (who: Actor, kind: string, id: string, digest: string, runId: string, conversationId: string) => {
      const key = requestKey(who, kind, id)
      const existing = requests.get(key)
      if (existing !== undefined) return existing
      requests.set(key, { kind, digest, state: 'claimed', runId, conversationId })
      return undefined
    },
    bindRequest: (who: Actor, kind: string, id: string, runId: string, conversationId: string) => {
      const found = requests.get(requestKey(who, kind, id))
      if (found !== undefined && found.conversationId === '') {
        found.runId = runId
        found.conversationId = conversationId
      }
    },
    finishRequest: (who: Actor, kind: string, id: string) => {
      const found = requests.get(requestKey(who, kind, id))
      if (found !== undefined) found.state = 'finished'
    },
    releaseRequest: (who: Actor, kind: string, id: string) => { requests.delete(requestKey(who, kind, id)) },
    cancelWaitingSubtasks: async () => [],
    staleWaitingSubtasks: async () => [],
  } as unknown as ButlerStorage
  const access = {
    mode: 'authenticated',
    ready() {
      if (options.accessFailReady === true) throw new Error('认证服务不可用')
    },
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
    maxConversationEvents: options.maxConversationEvents ?? 50,
  } as Config

  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => Promise<void>>()
  const ctx = {
    effect: (run: () => unknown) => { run(); return () => {} },
    /** 登录撤销通道：本文件不验证撤销，只需要它存在且可注销。 */
    on: () => () => {},
    webServer: {
      register: (route: { kind: string; path: string; handler: unknown }) => {
        routes.set(`${route.kind} ${route.path}`, route.handler as never)
        return () => {}
      },
    },
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: 'closedoff', packageName: 'dsh-closedoff', version: '1.0.0', displayName: '封闭化',
          description: '', entryPath: '/agents/closedoff', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context

  const console_ = new ButlerConsole(ctx, config, access, store, '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  vi.spyOn(console_, 'open').mockResolvedValue({
    id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now(),
  } as never)
  await installWeb(ctx, config, console_, access, {
    ready: true,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    ...(options.storageProbe === undefined ? {} : { probe: options.storageProbe }),
  })

  const call = (method: 'GET' | 'POST', target: string, payload?: unknown): Call => {
    // 路由按路径注册，查询串要留到 request.url 里给处理函数自己解析。
    const path = target.split('?')[0]!
    const handler = routes.get(`exact ${path}`)
    if (handler === undefined) throw new Error(`路由未注册：${path}`)
    const response = new FakeResponse()
    return { response, pending: handler(request(method, target, payload), response as unknown as ServerResponse) }
  }

  /** 结束当前这一轮（理解阶段）：`runTurn` 等的就是这个 `turn/end`。 */
  const endTurn = () => {
    console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
  }
  const failTurn = () => {
    console_.observe({ id: conversationId }, {
      type: 'turn/end', data: { reason: { kind: 'error', error: new Error('模型调用失败') } },
    } as never)
  }
  return { console_, agent, call, endTurn, failTurn, store }
}

/** 提交一轮并等到它开始跑。 */
async function startTurn(f: Fixture): Promise<Call> {
  const chat = f.call('POST', '/butler/chat', { conversationId, message: '看看今天园区的情况' })
  await until(() => chat.response.text.includes('"type":"user"'), '这一轮已经开始')
  return chat
}

describe('提交之后，连接不再是任务的命门', () => {
  it('关掉 /chat 的连接，任务继续跑到结束，事件一条不少', async () => {
    const f = await fixture()
    const chat = await startTurn(f)

    // 页面在这里被关掉。
    chat.response.disconnect()
    await settle()

    // 关键：连接没了，这一轮还在跑。
    expect((await f.console_.watch(conversationId, actor, 0))!.head.state).toBe('running')
    await chat.pending

    f.endTurn()
    await until(async () => (await f.console_.watch(conversationId, actor, 0))!.head.state !== 'running', '这一轮跑完')

    // 断线之后产生的事件都在，重新订阅就补齐了。
    const replay = f.call('GET', `/butler/events?conversationId=${conversationId}&after=0`)
    await replay.pending
    expect(replay.response.types()).toEqual(['run', 'user', 'chat', '[DONE]'])
    // 每条业务事件都带游标，客户端断线后才知道从哪儿接着要。
    const cursors = replay.response.events()
      .filter(event => event.type === 'user' || event.type === 'chat')
      .map(event => event.seq)
    expect(cursors).toEqual([1, 2])
  })

  it('/chat 先给出会话标识与这一轮的头部，页面才知道自己在看什么', async () => {
    const f = await fixture()
    const chat = await startTurn(f)
    f.endTurn()
    await chat.pending

    const events = chat.response.events()
    expect(events[0]).toEqual({ type: 'conversation', conversationId })
    expect(events[1]).toMatchObject({ type: 'run', state: 'running', taskId: '' })
    expect(events.at(-1)).toEqual({ type: '[DONE]' })
  })
})

describe('/events 是只读订阅', () => {
  it('第二个入口能重放同一轮，且不会重跑任务', async () => {
    const f = await fixture()
    const chat = await startTurn(f)
    f.endTurn()
    await chat.pending
    expect(f.agent.followup).toHaveBeenCalledTimes(1)

    const second = f.call('GET', `/butler/events?conversationId=${conversationId}&after=0`)
    await second.pending

    expect(second.response.events()[0]).toMatchObject({ type: 'run', state: 'finished' })
    expect(second.response.types()).toEqual(['run', 'user', 'chat', '[DONE]'])
    // 观察不等于执行：两次读同一轮，执行仍然只有一次。
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
  })

  it('只要新事件时不传 after，游标落在当前末尾', async () => {
    const f = await fixture()
    const chat = await startTurn(f)
    f.endTurn()
    await chat.pending

    const tail = f.call('GET', `/butler/events?conversationId=${conversationId}`)
    await tail.pending
    expect(tail.response.types()).toEqual(['run', '[DONE]'])
    expect(tail.response.events()[0]).toMatchObject({ type: 'run', state: 'finished' })
  })

  it('没有可观察的一轮时如实回答 idle，而不是假装有任务', async () => {
    const f = await fixture()
    const idle = f.call('GET', `/butler/events?conversationId=${conversationId}`)
    await idle.pending
    expect(idle.response.events()).toEqual([
      { type: 'run', runId: '', state: 'idle', startedAt: 0, finishedAt: null, taskId: '' },
      { type: '[DONE]' },
    ])
  })

  it('会话不存在时按同一种 404 拒绝，不泄露存在性', async () => {    const f = await fixture({ assertOwner: () => { throw new AccessError(404, '会话不存在或无权访问') } })
    const denied = f.call('GET', `/butler/events?conversationId=${conversationId}`)
    await denied.pending
    expect(denied.response.status).toBe(404)
    expect(JSON.parse(denied.response.text)).toMatchObject({ error: '会话不存在或无权访问' })
  })

  it('游标落后于窗口时要求重取快照，不交回半轮事件', async () => {
    // 窗口只留 1 条：一轮产生两条事件之后，开头那条已经被挤掉。
    const f = await fixture({ maxConversationEvents: 1 })
    const chat = await startTurn(f)
    f.endTurn()
    await chat.pending

    const replay = f.call('GET', `/butler/events?conversationId=${conversationId}&after=0`)
    await replay.pending
    expect(replay.response.types()).toEqual(['reset', '[DONE]'])
    expect(replay.response.events()[0]).toMatchObject({ type: 'reset', windowStart: 2 })
    expect(String(replay.response.events()[0]!.reason)).toContain('快照')
  })

  it('probe=1 只回答有没有在跑的一轮，用 JSON 而不是事件流', async () => {
    const f = await fixture()
    const idle = f.call('GET', `/butler/events?conversationId=${conversationId}&probe=1`)
    await idle.pending
    expect(JSON.parse(idle.response.text)).toEqual({ run: null })

    const chat = await startTurn(f)
    const running = f.call('GET', `/butler/events?conversationId=${conversationId}&probe=1`)
    await running.pending
    const payload = JSON.parse(running.response.text) as { run: { state: string; taskId: string } }
    expect(payload.run.state).toBe('running')
    // 计划还没产生，所以此刻还没有 taskId。接上一轮之后要靠事件里的 plan 补。
    expect(payload.run.taskId).toBe('')

    // 问一句不等于看一场：任务不受影响，也没有被重跑。
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    f.endTurn()
    await chat.pending
  })

  it('after 不是合法游标时返回 400，不悄悄当成 0', async () => {
    const f = await fixture()
    const bad = f.call('GET', `/butler/events?conversationId=${conversationId}&after=-3`)
    await bad.pending
    expect(bad.response.status).toBe(400)
  })
})

describe('重复提交只执行一次', () => {
  it('带同一个 requestId 重试，拿回同一轮而不是再派一次', async () => {
    const f = await fixture()
    const body = { conversationId, message: '看看今天园区的情况', requestId: 'req-1' }

    const first = f.call('POST', '/butler/chat', body)
    await until(() => first.response.text.includes('"type":"user"'), '第一轮已经开始')

    // 网络重试：同一个 requestId 再提交一遍。
    const retry = f.call('POST', '/butler/chat', body)
    await until(() => retry.response.text.includes('"type":"user"'), '重试拿到了同一轮')

    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    const runIdOf = (call: Call) => call.response.events().find(event => event.type === 'run')?.runId
    expect(runIdOf(retry)).toBe(runIdOf(first))

    f.endTurn()
    await Promise.all([first.pending, retry.pending])
  })

  it('同一个 requestId 换了正文就拒绝，不悄悄当成同一次', async () => {
    const f = await fixture()
    const first = f.call('POST', '/butler/chat', { conversationId, message: '看看今天园区的情况', requestId: 'req-2' })
    await until(() => first.response.text.includes('"type":"user"'), '第一轮已经开始')

    const conflict = f.call('POST', '/butler/chat', { conversationId, message: '改查危化车', requestId: 'req-2' })
    await conflict.pending
    expect(conflict.response.status).toBe(409)
    expect(String(JSON.parse(conflict.response.text).error)).toContain('req-2')
    // 第二条需求没有被当成新一轮执行。
    expect(f.agent.followup).toHaveBeenCalledTimes(1)

    f.endTurn()
    await first.pending
  })

  it('不带 requestId 时维持原样：每次提交都是新的一轮', async () => {
    const f = await fixture()
    const chat = await startTurn(f)
    f.endTurn()
    await chat.pending

    const second = f.call('POST', '/butler/chat', { conversationId, message: '看看今天园区的情况' })
    await until(() => second.response.text.includes('"type":"user"'), '第二轮已经开始')
    expect(f.agent.followup).toHaveBeenCalledTimes(2)

    f.endTurn()
    await second.pending
  })

  it('原来的那一轮已经被新的一轮覆盖时，如实说无法回放', async () => {
    const f = await fixture()
    const body = { conversationId, message: '看看今天园区的情况', requestId: 'req-3' }
    const first = f.call('POST', '/butler/chat', body)
    await until(() => first.response.text.includes('"type":"user"'), '第一轮已经开始')
    f.endTurn()
    await first.pending

    // 会话上又开了一轮：事件日志只留最近一轮，旧的那次已经没得回放了。
    const other = f.call('POST', '/butler/chat', { conversationId, message: '换个活' })
    await until(() => other.response.text.includes('"type":"user"'), '新一轮已经开始')

    const retry = f.call('POST', '/butler/chat', body)
    await retry.pending
    expect(retry.response.status).toBe(409)
    expect(String(JSON.parse(retry.response.text).error)).toContain('已经结束')

    f.endTurn()
    await other.pending
  })
})

describe('第二客户端发现入口', () => {
  it('/identity 交出路由前缀与契约版本，不必把 /butler 写死', async () => {
    const f = await fixture()
    const identity = f.call('GET', '/butler/identity')
    await identity.pending
    const payload = JSON.parse(identity.response.text) as Record<string, unknown>
    // 前缀是部署配置，换个部署就可能不一样；客户端据此拼后续请求。
    expect(payload.routePrefix).toBe('/butler')
    expect(payload.contractVersion).toBe(1)
    // 原有字段一个不少：这是加法，不是替换。
    expect(payload).toMatchObject({ mode: 'authenticated', key: 'user:alice', authPath: '/auth' })
  })
})

describe('失败都带一个稳定的码', () => {
  it('入参错误给的是具体码，不只是 HTTP 状态', async () => {
    const f = await fixture()
    const missing = f.call('POST', '/butler/stop', {})
    await missing.pending
    expect(missing.response.status).toBe(400)
    expect(JSON.parse(missing.response.text)).toMatchObject({ code: 'missing_field' })

    const bad = f.call('GET', `/butler/events?conversationId=${conversationId}&after=-3`)
    await bad.pending
    expect(JSON.parse(bad.response.text)).toMatchObject({ code: 'invalid_field' })
  })

  it('同一类失败在不同接口上给同一个码', async () => {
    const f = await fixture()
    // 两个入口都可能撞上「上一轮还没完」，客户端只需要认一个码。
    const chat = await startTurn(f)
    const busy = f.call('POST', '/butler/chat', { conversationId, message: '再来一个' })
    await busy.pending
    expect(busy.response.status).toBe(409)
    expect(JSON.parse(busy.response.text)).toMatchObject({ code: 'run_busy' })

    f.endTurn()
    await chat.pending
  })

  it('幂等冲突与「那一轮已经过去」是两个码，客户端能分开处理', async () => {
    const f = await fixture()
    const body = { conversationId, message: '看看今天园区的情况', requestId: 'req-code' }
    const first = f.call('POST', '/butler/chat', body)
    await until(() => first.response.text.includes('"type":"user"'), '第一轮已经开始')

    const conflict = f.call('POST', '/butler/chat', { ...body, message: '换了个说法' })
    await conflict.pending
    expect(JSON.parse(conflict.response.text)).toMatchObject({ code: 'idempotency_conflict' })

    f.endTurn()
    await first.pending

    // 原来的那一轮被下一轮覆盖之后再重试：事件没了，但那一轮是跑完的，给的是另一个码。
    const other = f.call('POST', '/butler/chat', { conversationId, message: '换个活' })
    await until(() => other.response.text.includes('"type":"user"'), '新一轮已经开始')
    const gone = f.call('POST', '/butler/chat', body)
    await gone.pending
    const payload = JSON.parse(gone.response.text) as { code: string; runId?: string; conversationId?: string }
    expect(payload.code).toBe('run_already_finished')
    // 原凭据要带回来：客户端拿它去读任务快照，否则无从下手。
    expect(payload.conversationId).toBe(conversationId)
    expect(typeof payload.runId).toBe('string')

    f.endTurn()
    await other.pending
  })

  it('插件自己给的码优先；没给时按状态兜底，绝不出现空码', async () => {
    // 替身抛的 AccessError 没带业务码，走的是按状态归类的兜底路径。
    const bare = await fixture({ assertOwner: () => { throw new AccessError(404, '会话不存在或无权访问') } })
    const denied = bare.call('GET', `/butler/events?conversationId=${conversationId}`)
    await denied.pending
    expect(JSON.parse(denied.response.text)).toMatchObject({ code: 'not_found' })

    const forbidden = await fixture({ assertOwner: () => { throw new AccessError(403, '来源不受信任') } })
    const blocked = forbidden.call('GET', `/butler/events?conversationId=${conversationId}`)
    await blocked.pending
    expect(JSON.parse(blocked.response.text)).toMatchObject({ code: 'forbidden' })

    // 而真实存储的归属校验带了具体码：同一个 404，客户端能分清是会话还是任务。
    const f = await fixture()
    const task = f.call('GET', '/butler/task?id=butler-task-nope')
    await task.pending
    expect(JSON.parse(task.response.text)).toMatchObject({ code: 'task_not_found' })
  })

  it('流已经开出去之后的错误同样带码，不必让客户端去猜', async () => {
    const f = await fixture()
    const chat = await startTurn(f)
    f.failTurn()
    await chat.pending

    const error = chat.response.events().find(event => event.type === 'error')
    expect(error).toMatchObject({ code: 'turn_failed' })
    // 文案仍然给人看，两边都在。
    expect(String(error?.message)).toContain('失败')
  })
})

describe('/stop 说清楚它到底停没停', () => {
  it('有正在跑的一轮时受理，并如实报告已受理', async () => {
    const f = await fixture()
    const chat = await startTurn(f)

    const stop = f.call('POST', '/butler/stop', { conversationId })
    await stop.pending
    expect(JSON.parse(stop.response.text)).toEqual({ ok: true, accepted: true })

    await until(async () => (await f.console_.watch(conversationId, actor, 0))!.head.state !== 'running', '这一轮被取消')
    await chat.pending
    expect((await f.console_.watch(conversationId, actor, 0))!.head.state).toBe('cancelled')
  })

  it('没有在跑的任务时仍然返回 ok，但明说没有停到东西', async () => {
    const f = await fixture()
    const stop = f.call('POST', '/butler/stop', { conversationId })
    await stop.pending
    const payload = JSON.parse(stop.response.text) as { ok: boolean; accepted: boolean; reason?: string }
    expect(payload.ok).toBe(true)
    expect(payload.accepted).toBe(false)
    expect(payload.reason).not.toBe('')
  })

  it('taskId 对不上时拒绝，且不误伤当前这一轮', async () => {
    const f = await fixture()
    f.store.task = vi.fn((_actor: Actor, id: string) => (id === 'butler-task-1'
      ? { id: 'butler-task-1', conversationId, subtasks: [] }
      : undefined)) as unknown as ButlerStorage['task']

    const chat = await startTurn(f)
    const stop = f.call('POST', '/butler/stop', { conversationId, taskId: 'butler-task-1' })
    await stop.pending

    expect(JSON.parse(stop.response.text)).toMatchObject({ ok: true, accepted: false })
    expect((await f.console_.watch(conversationId, actor, 0))!.head.state).toBe('running')

    f.endTurn()
    await chat.pending
  })
})

describe('/ready 按运行期探针如实翻转（§2.5）', () => {
  it('探针通过：200，带 schema 版本', async () => {
    const f = await fixture({ storageProbe: async () => {} })
    const ready = f.call('GET', '/butler/ready')
    await ready.pending
    expect(ready.response.status).toBe(200)
    expect(JSON.parse(ready.response.text)).toEqual({ ok: true, storage: { ready: true, schemaVersion: STORAGE_SCHEMA_VERSION } })
  })

  it('运行中 PG 不可达：503 + storage_unreachable，不外泄连接信息', async () => {
    const f = await fixture({
      storageProbe: async () => {
        throw new StorageError('storage_unreachable', '存储连接失败')
      },
    })
    const ready = f.call('GET', '/butler/ready')
    await ready.pending
    expect(ready.response.status).toBe(503)
    expect(JSON.parse(ready.response.text)).toMatchObject({
      code: 'storage_unreachable',
      schemaVersion: STORAGE_SCHEMA_VERSION,
    })
    // 公开探针不外泄内部信息：响应里不得出现连接串或主机细节。
    expect(ready.response.text).not.toMatch(/postgres|127\.0\.0\.1|pelycloud/iu)
  })

  it('探针抛出非 StorageError：兜成 503 + storage_unknown，固定文案', async () => {
    const f = await fixture({
      storageProbe: async () => {
        throw new Error('boom postgres://secret@internal-host/db')
      },
    })
    const ready = f.call('GET', '/butler/ready')
    await ready.pending
    expect(ready.response.status).toBe(503)
    expect(JSON.parse(ready.response.text)).toMatchObject({
      error: '工作台存储此刻不可用',
      code: 'storage_unknown',
    })
    expect(ready.response.text).not.toContain('boom')
    expect(ready.response.text).not.toContain('internal-host')
  })

  it('auth 未就绪仍是第一道闸：原语义 503，不触发存储探针', async () => {
    let probed = false
    const f = await fixture({
      accessFailReady: true,
      storageProbe: async () => { probed = true },
    })
    const ready = f.call('GET', '/butler/ready')
    await ready.pending
    expect(ready.response.status).toBe(503)
    expect(JSON.parse(ready.response.text)).toEqual({ error: '认证服务不可用' })
    // 认证都不可用时不必再碰存储：探针没有被调用。
    expect(probed).toBe(false)
  })
})
