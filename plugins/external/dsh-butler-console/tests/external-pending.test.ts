/**
 * 外部待办的映射与兼容。
 *
 * 「材料交回但还要在外面办」与「等着用户回话」是两种不同的没办完，之前博客把两者都报成
 * `waiting`，管家也就只能把它们当成同一件事：任务永远停在等人回话，既没有结束，也没有
 * 「这事还没办完」的说法。
 *
 * 现在判定来源只有一个：员工给出的结构化声明。这里锁住四件事：
 *
 * 1. 声明齐备时映射为 `external_pending`，材料与原始状态一起留下，本轮结束。
 * 2. 声明缺理由时**不猜** —— 那是「返回不满足协作契约」，如实按失败收，材料仍保留。
 * 3. 旧版本员工仍然只说 `waiting` 时，保持原语义；不会因为结果里带着材料就自动升级。
 * 4. 数据结构从 v1 升到 v2 时就地增列，已有数据一条不动。
 */
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { TaskStore } from '../src/store.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

function context(executor: ButlerAgentExecutor): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: executor.agentId, packageName: 'dsh-blog', version: '1.0.0', displayName: '博客',
          description: '', entryPath: '/agents/blog', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

/** 派一个活并等它落地，返回任务 id。 */
async function dispatchOnce(executor: ButlerAgentExecutor) {
  const store = new TaskStore(':memory:')
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 200,
    // 真实值而不是留空：留空时 `setTimeout(fn, undefined)` 会立刻触发，测试结束、库关掉之后
    // 那个闹钟才醒过来写库。
    waitingTimeoutMs: 600_000,
  } as Config
  const console_ = new ButlerConsole(context(executor), config, access, store, '')
  const agent = { session: { id: conversationId }, followup: vi.fn(), cancel: vi.fn(), dispose: vi.fn(async () => {}) }
  const inner = console_ as unknown as {
    setup(ctx: unknown, sessionId: string): void
    conversations: Map<string, unknown>
  }
  vi.spyOn(console_, 'open').mockImplementation(async (requestedId?: string) => {
    store.openOrReserveConversation(String(requestedId), actor)
    const conversation = { id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now() }
    inner.conversations.set(conversationId, conversation)
    return conversation as never
  })
  const tools: { execute(args: unknown, exec: unknown): Promise<unknown> }[] = []
  inner.setup({
    systemPrompt: { section: vi.fn() },
    tools: { register: (tool: never) => { tools.push(tool) }, restrict: vi.fn() },
  }, conversationId)
  const planTool = tools[0]
  if (planTool === undefined) throw new Error('派活工具没有注册')

  await console_.start(conversationId, '写一篇园区封闭化管理介绍', actor)
  await until(() => agent.followup.mock.calls.length === 1, '大总管开始理解')
  await planTool.execute({
    reply: '我先让博客起一版。',
    note: '',
    subtasks: [{ goal: '起草园区封闭化管理介绍', agentId: 'blog', reason: '博客负责写作' }],
  }, { signal: new AbortController().signal })
  console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)

  await until(() => store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' }).items.length === 1, '任务落库')
  const taskId = store.history(actor, { offset: 0, limit: 10, keyword: '', state: '' }).items[0]!.id
  // 子任务全部失败或成功时还会跑一轮汇总，那一轮也要结束，否则任务一直停在 `summarizing`。
  // 等外部待办的那条路径不跑汇总，所以这里不会触发。
  let settledSummary = false
  await until(() => {
    const state = store.task(actor, taskId)!.state
    if (state === 'summarizing') {
      if (!settledSummary) {
        settledSummary = true
        console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
      }
      return false
    }
    return state !== 'running'
  }, '这一轮收尾')
  return { store, taskId }
}

const draftArtifact = { kind: 'draft', title: '在博客查看并采用候选稿', path: '/blog?conversationId=c-1' }

describe('员工声明外部待办', () => {
  it('声明齐备时映射为 external_pending，材料、原始状态与本轮结束一起留下', async () => {
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({
        status: 'external_pending',
        summary: '候选稿已交回，正文与配图说明都在候选里。',
        conversationId: 'c-1',
        artifacts: [draftArtifact],
        externalPending: { reason: '候选稿须在博客原对话选择采用', next: '采用之后可以再派一轮' },
      }),
    }
    const { store, taskId } = await dispatchOnce(executor)

    const record = store.task(actor, taskId)!
    expect(record.state).toBe('external_pending')
    const subtask = record.subtasks[0]!
    expect(subtask.state).toBe('external_pending')
    // 材料落库：正文、引用、原会话三样都在，重启之后还找得回来。
    expect(subtask.result).toContain('候选稿已交回，正文与配图说明都在候选里。')
    // 待办理由也要落库：刷新之后任务详情得能看出还等着谁做什么。
    expect(subtask.result).toContain('候选稿须在博客原对话选择采用')
    expect(subtask.artifacts).toEqual([draftArtifact])
    expect(subtask.conversationId).toBe('c-1')
    // 任务级留下材料与外部待办说明，而不是一句「已完成」。
    expect(record.summary).toContain('候选稿已交回')
    expect(record.summary).toContain('外部待办')
    expect(record.finishedAt).not.toBeNull()
    // 终态任务不再占着这一轮，新活可以直接开。
    expect(store.counts(actor).externalPending).toBe(1)
    expect(store.counts(actor).completed).toBe(0)

    store.close()
  })

  it('声明了外部待办却没说清在等什么时按失败收，不替它编一个理由', async () => {
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({
        status: 'external_pending',
        summary: '材料在这里',
        artifacts: [draftArtifact],
        // reason 缺失：这正是「返回不满足协作契约」。
      }),
    }
    const { store, taskId } = await dispatchOnce(executor)

    const record = store.task(actor, taskId)!
    const subtask = record.subtasks[0]!
    expect(subtask.state).toBe('failed')
    expect(subtask.error).toContain('没说明在等什么')
    // 猜一个理由会在界面上显示一件没发生过的外部事项；材料本身仍然保留。
    expect(subtask.result).toBe('材料在这里')
    expect(subtask.artifacts).toEqual([draftArtifact])
    expect(record.state).toBe('failed')

    store.close()
  })

  it('旧版本员工只报 waiting 时保持原语义，不因有材料就自动结束', async () => {
    // 这是兼容的关键：老版本的子包没有 external_pending 这个值，也不带声明字段。
    // 它说 waiting 就是等着用户回话 —— 带没带材料都不改变这一点。
    const executor: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => ({
        status: 'waiting_user',
        summary: '候选稿已交回',
        artifacts: [draftArtifact],
      }),
    }
    const { store, taskId } = await dispatchOnce(executor)

    const record = store.task(actor, taskId)!
    expect(record.state).toBe('waiting_user')
    expect(record.subtasks[0]!.state).toBe('waiting_user')
    expect(store.counts(actor).externalPending).toBe(0)
    expect(store.counts(actor).waitingUser).toBe(1)

    store.close()
  })
})

describe('工作台索引的数据结构升级', () => {
  it('v1 的库就地升到 v2：新列补上，已有数据一条不动', () => {
    const path = join(tmpdir(), `butler-v1-${randomUUID()}.sqlite`)
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_namespace TEXT NOT NULL,
        owner_id TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE subtasks (
        task_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, goal TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        started_at INTEGER, finished_at INTEGER, PRIMARY KEY (task_id, id)
      );
      PRAGMA user_version = 1;
    `)
    legacy.prepare(`INSERT INTO tasks(id,conversation_id,owner_namespace,owner_id,goal,state,created_at,updated_at)
      VALUES('task-old','${conversationId}','user','alice','老任务','completed',1,2)`).run()
    legacy.prepare(`INSERT INTO subtasks(task_id,id,seq,goal,state,result)
      VALUES('task-old','s1',1,'老目标','succeeded','老结果')`).run()
    legacy.close()

    const store = new TaskStore(path)
    const record = store.task(actor, 'task-old')
    expect(record?.goal).toBe('老任务')
    expect(record?.subtasks[0]?.result).toBe('老结果')
    // 新列存在且是空值，不是把老记录判成损坏。
    expect(record?.subtasks[0]?.artifacts).toEqual([])
    expect(record?.subtasks[0]?.conversationId).toBe('')
    // 升级后能写新字段。
    store.setSubtaskState('task-old', 's1', 'succeeded', { artifacts: [draftArtifact], conversationId: 'c-9' })
    expect(store.task(actor, 'task-old')?.subtasks[0]?.artifacts).toEqual([draftArtifact])
    store.close()

    // 再开一次：版本已是 v2，不该重复迁移或报错。
    const reopened = new TaskStore(path)
    expect(reopened.task(actor, 'task-old')?.subtasks[0]?.conversationId).toBe('c-9')
    reopened.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  })
})
