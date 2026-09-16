/**
 * 内部派单材料的对外边界：任务详情接口只给既有公开字段。
 *
 * `inputRefs`（派单材料原文与来源快照）和 `memberReturn`（协作返回原文）是管家内部数据，
 * 长度不受页面展示摘要边界约束。这里走**真路由 + 真响应体**，断言它们没有因为直接序列化
 * store 记录而漏进 HTTP 响应，同时确认内部读取没被一起裁掉、权限行为不变。
 */
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import { STORAGE_SCHEMA_VERSION } from '../src/storage/postgres.ts'
import { SqliteButlerStorage } from '../src/storage/sqlite-adapter.ts'
import { TaskStore } from '../src/store.ts'
import { installWeb } from '../src/web.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
/** 只出现在内部材料里的哨兵值：出现即说明内部数据漏进了响应。 */
const REF_TEXT = '内部派单原文哨兵-不该出现在响应里'
const RETURN_TEXT = '协作返回原文哨兵-不该出现在响应里'

const opened: string[] = []
afterEach(() => {
  for (const path of opened.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${path}${suffix}`, { force: true }) } catch { /* 留给系统清理 */ }
    }
  }
})

/** 一条 JSON 响应的最小替身（`json()` 只用到 `writeHead` 与 `end`）。 */
class FakeResponse {
  status = 0
  body = ''

  writeHead(status: number): void {
    this.status = status
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body = chunk
  }
}

async function fixture() {
  const path = join(tmpdir(), `butler-inputrefs-http-${randomUUID()}.sqlite`)
  opened.push(path)
  new TaskStore(path).close()
  const db = new DatabaseSync(path)
  const task = (id: string, owner: string) => db.prepare(
    'INSERT INTO tasks(id,conversation_id,owner_namespace,owner_id,goal,state,note,summary,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, conversationId, actor.namespace, owner, '写博客', 'completed', '', '', '', 1, 2)
  task('task-1', actor.userId)
  task('task-2', 'bob')
  db.prepare(`INSERT INTO subtasks(task_id,id,seq,goal,agent_id,reason,state,result,error,artifacts,conversation_id,input_refs,member_return,depends_on,requires_external_action)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'task-1', 's1', 1, '起草', 'blog', '', 'succeeded', '展示摘要', '', '', '',
    JSON.stringify([{
      subtaskId: 's0', logicalId: 'g1', state: 'succeeded', text: REF_TEXT,
      artifacts: [{ title: '草稿', path: '/agents/blog/draft/1', kind: 'draft' }],
    }]),
    JSON.stringify({ protocol: 1, text: RETURN_TEXT, externalPending: { reason: '待在原页面采用' } }),
    '', 0,
  )
  db.close()

  const store = new TaskStore(path)
  const config = {
    accessMode: 'authenticated',
    publicOrigin: 'http://localhost:3080',
    routePrefix: '/butler',
    maxRequestBodyBytes: 65536,
    maxMessageChars: 8000,
    maxResultChars: 8000,
    maxAvatarBytes: 262144,
    subtaskTimeoutMs: 10_000,
    maxConversationEvents: 50,
  } as Config
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
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
    root: { emit() {} },
  } as unknown as Context
  const console_ = new ButlerConsole(ctx, config, access, new SqliteButlerStorage(store), '')
  await installWeb(ctx, config, console_, access, { ready: true, schemaVersion: STORAGE_SCHEMA_VERSION })

  /** 真跑一次任务详情 GET，拿响应状态与原始响应体。 */
  const get = async (id: string) => {
    const handler = routes.get('exact /butler/task')
    if (handler === undefined) throw new Error('任务详情路由没有注册')
    const response = new FakeResponse()
    const request = { method: 'GET', url: `/butler/task?id=${encodeURIComponent(id)}`, headers: {} } as unknown as IncomingMessage
    await handler(request, response as unknown as ServerResponse)
    return {
      status: response.status,
      text: response.body,
      body: JSON.parse(response.body) as Record<string, unknown>,
    }
  }

  return { store, get }
}

describe('任务详情接口只给公开字段', () => {
  it('响应体里没有内部材料两个字段，原文哨兵一个字都不出现', async () => {
    const f = await fixture()
    const { status, text, body } = await f.get('task-1')
    expect(status).toBe(200)
    expect(text).not.toContain(REF_TEXT)
    expect(text).not.toContain(RETURN_TEXT)
    const subtasks = body.subtasks as Record<string, unknown>[]
    expect(subtasks).toHaveLength(1)
    expect(Object.keys(subtasks[0]!)).not.toContain('inputRefs')
    expect(Object.keys(subtasks[0]!)).not.toContain('memberReturn')
    // 内部判定信息（这份快照是「还没固定」还是「未知」还是「损坏」）同样不进对外响应。
    expect(Object.keys(subtasks[0]!)).not.toContain('inputRefsState')
    expect(Object.keys(body)).not.toContain('inputRefs')
    // 既有公开字段照旧：裁剪不等于把这一步的信息一起删掉。
    expect(subtasks[0]).toMatchObject({
      id: 's1', goal: '起草', agentId: 'blog', state: 'succeeded', result: '展示摘要',
    })
    expect(body).toMatchObject({ id: 'task-1', goal: '写博客', state: 'completed' })
    f.store.close()
  })

  it('内部读取没被一起剪掉：管家自己仍读得到完整材料', async () => {
    const f = await fixture()
    const record = f.store.task(actor, 'task-1')
    expect(record?.subtasks[0]?.inputRefs?.[0]?.text).toBe(REF_TEXT)
    expect(record?.subtasks[0]?.memberReturn?.text).toBe(RETURN_TEXT)
    f.store.close()
  })

  it('权限行为不变：别人的任务与不存在的任务都是同一种 404', async () => {
    const f = await fixture()
    const missing = await f.get('task-不存在')
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('task_not_found')
    const other = await f.get('task-2')
    expect(other.status).toBe(404)
    expect(other.body.code).toBe('task_not_found')
    f.store.close()
  })
})
