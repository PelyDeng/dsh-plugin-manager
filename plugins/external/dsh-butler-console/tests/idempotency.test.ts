/**
 * 幂等记录的持久化。
 *
 * 之前这张表只在内存里：挡得住网络重试，挡不住「受理了、跑了一半、进程没了」。那一段在库里
 * 什么都没有，重启后同一个请求会被当成新的一次再跑一遍 —— 而那些可能带外部副作用的活
 * 正是最不该重跑的。
 *
 * 现在占用在**执行之前**落库，于是重启后能区分三件事：那一轮跑完了、受理过但没有下文、
 * 以及根本没受理过。三种都不会重新执行，客户端拿到的是原凭据加一个明确的码。
 *
 * 这里用真实的文件库跨两个「进程」（两次 `ButlerConsole` 实例）验证，因为要证的正是
 * **跨进程**的行为，内存里的东西证不了。
 */
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { TaskStore } from '../src/store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

/** 用完就删的临时库；连同 WAL 旁文件一起清掉。 */
const opened: string[] = []
function tempDb(): string {
  const path = join(tmpdir(), `butler-idem-${randomUUID()}.sqlite`)
  opened.push(path)
  return path
}
afterEach(() => {
  for (const path of opened.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      // Windows 上库里若还有未结束的执行，文件可能仍被占着；临时目录会自己清，不必因此失败。
      try { rmSync(`${path}${suffix}`, { force: true }) } catch { /* 留给系统清理 */ }
    }
  }
})

const executor: ButlerAgentExecutor = {
  protocol: 1,
  agentId: 'blog',
  capabilities: ['写作'],
  dispatch: async () => ({ status: 'succeeded', summary: '写好了' }),
}

function context(): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: 'blog', packageName: 'dsh-blog', version: '1.0.0', displayName: '博客',
          description: '', entryPath: '/agents/blog', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

/** 起一个「进程」：同一个库上的一整套存储与会话。 */
function session(path: string) {
  const store = new TaskStore(path)
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(), config, access, store, '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  // 会话对象要**缓存**：真实的 `open()` 会复用同一个实例，`active` 才是共享的。
  // 每次返回新对象的话，「上一轮还没完」这个状态根本传不出来。
  const conversation = { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() }
  vi.spyOn(console_, 'open').mockImplementation(async (requestedId?: string) => {
    store.openOrReserveConversation(String(requestedId), actor)
    return conversation as never
  })
  return { store, console_, agent }
}

/** 建一个旧版本的库，用来验证迁移。 */
function legacyDb(path: string, version: 1 | 2): void {
  const db = new DatabaseSync(path)
  const subtaskColumns = version === 1
    ? `task_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, goal TEXT NOT NULL,
       agent_id TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
       result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
       started_at INTEGER, finished_at INTEGER, PRIMARY KEY (task_id, id)`
    : `task_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, goal TEXT NOT NULL,
       agent_id TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
       result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
       artifacts TEXT NOT NULL DEFAULT '', conversation_id TEXT NOT NULL DEFAULT '',
       started_at INTEGER, finished_at INTEGER, PRIMARY KEY (task_id, id)`
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_namespace TEXT NOT NULL,
      owner_id TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE TABLE subtasks (${subtaskColumns});
    PRAGMA user_version = ${version};
  `)
  db.prepare(`INSERT INTO tasks(id,conversation_id,owner_namespace,owner_id,goal,state,created_at,updated_at)
    VALUES('task-old','${conversationId}','user','alice','老任务','completed',1,2)`).run()
  db.prepare(`INSERT INTO subtasks(task_id,id,seq,goal,state,result)
    VALUES('task-old','s1',1,'老目标','succeeded','老结果')`).run()
  db.close()
}

describe('幂等占用在执行前落库', () => {
  it('受理之后、执行还没结束时，库里就已经有这笔占用', async () => {
    const path = tempDb()
    const first = session(path)
    const started = await first.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')

    const record = first.store.request(actor, 'chat', 'req-1')
    expect(record).toMatchObject({ state: 'claimed', runId: started.runId, conversationId })
    // 这一轮还在跑（没人结束它），占用却已经在库里了 —— 这就是「执行前」的意思。
    expect(first.store.request(actor, 'chat', 'req-1')?.state).toBe('claimed')
    first.store.close()
  })

  it('同进程内重试仍然正常重放，不会因为落了库就变成「结果不明」', async () => {
    const path = tempDb()
    const first = session(path)
    const started = await first.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')
    const again = await first.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')
    expect(again.runId).toBe(started.runId)
    expect(again.unknown).toBeUndefined()
    expect(first.agent.followup).toHaveBeenCalledTimes(1)
    first.store.close()
  })

  it('受理失败的那一次不留占用，同一个 id 还能重新提交', async () => {
    const path = tempDb()
    const f = session(path)
    await f.console_.start(conversationId, '第一轮', actor)
    // 上一轮还没完，这次会被 409 挡住 —— 它根本没有开始执行。
    await expect(f.console_.start(conversationId, '第二轮', actor, 'req-2')).rejects.toThrow(/正在处理上一条/u)
    expect(f.store.request(actor, 'chat', 'req-2')).toBeUndefined()
    f.store.close()
  })
})

describe('重启之后绝不重跑', () => {
  it('受理过但结果不明的请求：给原凭据，不执行', async () => {
    const path = tempDb()
    const first = session(path)
    const started = await first.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')
    // 模拟进程在这里断掉：这一轮没有走到任何终态，库直接关。
    first.store.close()

    const second = session(path)
    const replay = await second.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')
    expect(replay.unknown).toBe(true)
    expect(replay.unknownCode).toBe('run_result_unknown')
    // 原凭据原样带回来：客户端要拿它去找任务记录。
    expect(replay.runId).toBe(started.runId)
    expect(replay.conversationId).toBe(conversationId)
    // 关键：没有重新执行。
    expect(second.agent.followup).not.toHaveBeenCalled()
    second.store.close()
  })

  it('跑完过的请求：同样不重跑，但码不同 —— 结果是有的，去读快照', async () => {
    const path = tempDb()
    const first = session(path)
    const started = await first.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')
    // 让这一轮正常跑完：理解轮结束后直接收尾（没有计划，等于大总管自己回答完了）。
    await new Promise(resolve => setTimeout(resolve, 0))
    first.console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(first.store.request(actor, 'chat', 'req-1')?.state).toBe('finished')
    first.store.close()

    const second = session(path)
    const replay = await second.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')
    expect(replay.unknownCode).toBe('run_already_finished')
    expect(replay.runId).toBe(started.runId)
    expect(second.agent.followup).not.toHaveBeenCalled()
    second.store.close()
  })

  it('换了正文的同一个 id 直接拒绝，重启前后一个样', async () => {
    const path = tempDb()
    const first = session(path)
    await first.console_.start(conversationId, '看看今天园区的情况', actor, 'req-1')
    first.store.close()

    const second = session(path)
    await expect(second.console_.start(conversationId, '改查危化车', actor, 'req-1'))
      .rejects.toThrow(/已经用在另一次请求上/u)
    second.store.close()
  })
})

describe('索引结构升级与回滚约束', () => {
  it('v1 的库一路升到 v3：新表建好，老数据一条不动', () => {
    const path = tempDb()
    legacyDb(path, 1)
    const store = new TaskStore(path)
    expect(store.task(actor, 'task-old')?.subtasks[0]?.result).toBe('老结果')
    // 新表可用。
    store.claimRequest(actor, 'chat', 'req-9', 'd', 'run-9', conversationId, 600_000)
    expect(store.request(actor, 'chat', 'req-9')).toMatchObject({ state: 'claimed', runId: 'run-9' })
    store.close()
  })

  it('v2 的库升到 v3：只补新表，材料列照旧', () => {
    const path = tempDb()
    legacyDb(path, 2)
    const store = new TaskStore(path)
    const record = store.task(actor, 'task-old')
    expect(record?.subtasks[0]?.artifacts).toEqual([])
    expect(record?.subtasks[0]?.result).toBe('老结果')
    store.claimRequest(actor, 'chat', 'req-8', 'd', 'run-8', conversationId, 600_000)
    expect(store.request(actor, 'chat', 'req-8')?.runId).toBe('run-8')
    store.close()
  })

  it('版本比当前新的库直接拒绝启动，而不是拿错结构去读写', () => {
    const path = tempDb()
    legacyDb(path, 2)
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 99')
    db.close()
    expect(() => new TaskStore(path)).toThrowError(/不支持的工作台数据结构版本：99/u)
  })
})
