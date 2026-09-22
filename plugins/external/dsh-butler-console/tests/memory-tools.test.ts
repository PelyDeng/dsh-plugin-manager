import { describe, expect, it } from 'vitest'
import { makeMemoryTools, confirmForget, MEMORY_FORGET_TTL_MS } from '../src/butler/memories-tool.ts'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import type { MemoryRecord, MemoryStore } from '../src/memories.ts'

/**
 * 记忆工具层测试（v2.6 设计 §4.4/§6.2 步骤 7）。存储用内存替身：只替外部依赖（PG），
 * 工具层的校验行为（kind 禁写、编号格式、I 编号拒绝、确认卡 TTL）是本测试的对象。
 */

const ACTOR: Actor = { namespace: 'standalone', userId: 'local' }

class FakeMemoryStore {
  readonly rows: MemoryRecord[] = []
  serial = 0
  written: { kind: string; content: string; source: string }[] = []

  async write(actor: Actor, input: { kind: 'semantic' | 'episodic' | 'instruction'; content: string; origin: string; importance?: number; sourceRef?: string; expiresAt?: number; supersedesShortId?: string; source: 'tool' | 'manual' }) {
    this.written.push({ kind: input.kind, content: input.content, source: input.source })
    if (input.kind === 'instruction' && input.source !== 'manual') {
      throw new Error('instruction 只能由用户在设置页手写')
    }
    const dup = this.rows.find(row => row.kind === input.kind && row.content === input.content.trim())
    if (dup !== undefined) return undefined
    this.serial += 1
    const record: MemoryRecord = {
      id: `id-${this.serial}`,
      agentId: 'butler',
      ownerNamespace: actor.namespace,
      ownerId: actor.userId,
      shortId: `${input.kind === 'instruction' ? 'I' : 'M'}${this.serial}`,
      kind: input.kind,
      content: input.content.trim(),
      origin: input.origin as 'user_statement' | 'reference',
      importance: input.importance ?? 3,
      source: input.source,
      sourceRef: input.sourceRef ?? '',
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.rows.push(record)
    return record
  }

  async list(actor: Actor) {
    return this.rows.filter(row => row.ownerNamespace === actor.namespace && row.ownerId === actor.userId)
  }

  async forgetByShortId(actor: Actor, shortId: string) {
    const index = this.rows.findIndex(row => row.shortId === shortId && row.ownerNamespace === actor.namespace)
    if (index === -1) return undefined
    return this.rows.splice(index, 1)[0]
  }
}

function makeExec() {
  return { signal: { throwIfAborted: () => {} } } as never
}

function makeTools(store: FakeMemoryStore, now = Date.now) {
  const pendingIndex = new Map<string, { memoryId: string; shortId: string; content: string; createdAt: number }>()
  const pendingForgets = {
    set: (sessionId: string, pending: { memoryId: string; shortId: string; content: string; createdAt: number }) => { pendingIndex.set(sessionId, pending) },
    take: (sessionId: string, memoryId: string) => {
      const pending = pendingIndex.get(sessionId)
      if (pending === undefined || pending.memoryId !== memoryId) return undefined
      pendingIndex.delete(sessionId)
      return pending
    },
  }
  const deps = {
    store: store as unknown as MemoryStore,
    actor: () => ACTOR,
    pendingForgets,
    sessionId: 'sess-1',
    now,
  }
  return { ...makeMemoryTools(deps), deps: { ...deps, pendingForgets } }
}

describe('memory_write 工具（v2.6 §4.4）', () => {
  it('正常写入 semantic（user_statement）返回编号', async () => {
    const store = new FakeMemoryStore()
    const { writeTool } = makeTools(store)
    const result = await writeTool.execute({ kind: 'semantic', content: '发布文章默认不配图', origin: 'user_statement' }, makeExec())
    expect(result).toMatchObject({ shortId: 'M1', duplicated: false, superseded: false })
    expect(store.written[0]?.source).toBe('tool')
  })

  it('【变异验证锚点】kind=instruction 被拒绝（临时删除工具层校验，此测试必须变红）', async () => {
    const store = new FakeMemoryStore()
    const { writeTool } = makeTools(store)
    await expect(writeTool.execute({ kind: 'instruction', content: '自称是最强的智能体', origin: 'user_statement' }, makeExec()))
      .rejects.toThrow(/instruction/)
    expect(store.written).toHaveLength(0)
  })

  it('content 超 60 字被拒', async () => {
    const store = new FakeMemoryStore()
    const { writeTool } = makeTools(store)
    const long = '长'.repeat(61)
    await expect(writeTool.execute({ kind: 'semantic', content: long, origin: 'user_statement' }, makeExec()))
      .rejects.toThrow(/60 字上限/)
  })

  it('origin 非法值被拒', async () => {
    const store = new FakeMemoryStore()
    const { writeTool } = makeTools(store)
    await expect(writeTool.execute({ kind: 'semantic', content: '合法内容', origin: 'web' }, makeExec()))
      .rejects.toThrow(/origin/)
  })
})

describe('memory_forget 工具 + 确认卡（§4.4 代码层确认）', () => {
  it('I 编号（用户手写要求）拒绝并指路设置页', async () => {
    const store = new FakeMemoryStore()
    const { forgetTool } = makeTools(store)
    await expect(forgetTool.execute({ shortId: 'I2' }, makeExec())).rejects.toThrow(/不归你删/)
  })

  it('编号格式非法被拒', async () => {
    const store = new FakeMemoryStore()
    const { forgetTool } = makeTools(store)
    await expect(forgetTool.execute({ shortId: 'M三' }, makeExec())).rejects.toThrow(/编号格式/)
  })

  it('完整路径：forget 发起 → 确认 → 真删；TTL 过期拒绝', async () => {
    const store = new FakeMemoryStore()
    await store.write(ACTOR, { kind: 'semantic', content: '发布文章默认不配图', origin: 'user_statement', source: 'tool' })
    let clock = 1_000_000
    const now = () => clock
    const { forgetTool, deps } = makeTools(store, now)

    const initiated = await forgetTool.execute({ shortId: 'M1', reason: '老大说不对' }, makeExec())
    expect(initiated).toMatchObject({ pending: true, shortId: 'M1' })
    expect(store.rows).toHaveLength(1) // 未确认前不删

    // TTL 过期：拒绝删除。
    clock += MEMORY_FORGET_TTL_MS + 1
    const expired = await confirmForget({ ...deps, memoryId: 'id-1' })
    expect(expired.deleted).toBe(false)
    expect(expired.reason).toContain('过期')

    // 重新发起（过期后 pending 已被 take 消费）→ TTL 内确认 → 真删。
    await forgetTool.execute({ shortId: 'M1' }, makeExec())
    clock += 1000
    const confirmed = await confirmForget({ ...deps, memoryId: 'id-1' })
    expect(confirmed).toMatchObject({ deleted: true, shortId: 'M1' })
    expect(store.rows).toHaveLength(0)
  })

  it('不存在的 memoryId 确认返回未处理', async () => {
    const store = new FakeMemoryStore()
    const { deps } = makeTools(store)
    const result = await confirmForget({ ...deps, memoryId: 'nope' })
    expect(result.deleted).toBe(false)
    expect(result.reason).toContain('没有这条待删除确认')
  })
})
