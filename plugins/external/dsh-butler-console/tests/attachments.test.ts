/**
 * 附件服务：附件怎么进提示词、图片什么时候读、非法选择怎么拒。
 *
 * 这一层决定的是**模型实际看到什么**，所以断言都落在给出去的正文上：文件内容要照录、读不出的
 * 要如实说明、图片在多模态那条路上不该被读第二遍。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerAttachments } from '../src/attachments.ts'
import type { Config } from '../src/config.ts'
import type { ButlerAttachmentRecord } from '../src/storage/types.ts'

const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const other: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }

const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access

/** 内存存储替身：只实现附件那六个方法（`AttachmentStorage` 的全部）。 */
function memoryStorage() {
  const rows = new Map<string, ButlerAttachmentRecord>()
  const key = (who: Actor, id: string) => `${who.userId}:${id}`
  return {
    rows,
    async attachmentInsert(who: Actor, record: ButlerAttachmentRecord) { rows.set(key(who, record.id), record) },
    async attachmentWrite(who: Actor, record: ButlerAttachmentRecord) {
      if (!rows.has(key(who, record.id))) return 0
      rows.set(key(who, record.id), record)
      return 1
    },
    async attachment(who: Actor, id: string) { return rows.get(key(who, id)) },
    async attachments(who: Actor, conversationId: string) {
      return [...rows.values()].filter(row => row.conversationId === conversationId && row.taskId === '' && row.status !== 'removed')
    },
    async attachmentBind(who: Actor, ids: readonly string[], taskId: string, conversationId: string) {
      let changed = 0
      for (const id of ids) {
        const row = rows.get(key(who, id))
        if (row === undefined || row.status === 'removed') continue
        rows.set(key(who, id), { ...row, taskId, conversationId })
        changed += 1
      }
      return changed
    },
    async taskAttachments(taskId: string) {
      return [...rows.values()].filter(row => row.taskId === taskId && row.status !== 'removed')
    },
  }
}

const record = (patch: Partial<ButlerAttachmentRecord> & { id: string }): ButlerAttachmentRecord => ({
  conversationId: 'c1',
  taskId: '',
  name: '文件.txt',
  kind: 'text',
  mediaType: 'text/plain',
  bytes: 10,
  status: 'ready',
  message: '',
  sourceUrl: '',
  original: { attachmentId: `obj-${patch.id}` },
  parsed: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

const config = (patch: Partial<Config> = {}): Config => ({
  accessMode: 'authenticated',
  publicOrigin: '',
  authRecheckMs: 1000,
  reasoningEffort: 'low',
  routePrefix: '/butler',
  subtaskTimeoutMs: 10_000,
  waitingTimeoutMs: 600_000,
  turnTimeoutMs: 600_000,
  maxMessageChars: 8000,
  maxResultChars: 8000,
  maxSubtasks: 6,
  maxRequestBodyBytes: 65536,
  maxAvatarBytes: 262144,
  maxAttachmentBytes: 1_048_576,
  maxAttachmentsPerMessage: 5,
  attachmentParseChars: 100_000,
  attachmentBriefChars: 2000,
  // 固定成一条路由，跳过"自动挑"（那个分支由 vision.ts 自己的用例覆盖）。
  visionModel: 'test/vision',
  attachmentFetchTimeoutMs: 5000,
  maxActiveConversations: 32,
  maxHistoryPageSize: 30,
  maxConversationEvents: 2000,
  idempotencyTtlMs: 600_000,
  ...patch,
} as unknown as Config)

/** 一张最小 PNG（够过魔数判定）。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

/** 读图用的模型替身：每次调用记一笔，回一句固定的话。顺带给出宿主附件服务（读图要读回原字节）。 */
function fakeVision(answer = '图里写着：合计 1200') {
  const calls: unknown[] = []
  const ctx = {
    get: (name: string) => {
      if (name === 'llm') {
        return {
          async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
          async *stream(options: unknown) {
            calls.push(options)
            yield { type: 'text-delta', text: answer }
          },
        }
      }
      if (name === 'attachments') {
        return {
          imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxImageBytes: 1024 * 1024 },
          async readImage() { return { data: PNG } },
          async saveFileStream() { return { attachmentId: 'x', name: 'x', bytes: 0 } },
          async *readFileStream() { yield new Uint8Array() },
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

function service(patch: Partial<Config> = {}, ctx: unknown = fakeVision().ctx) {
  const storage = memoryStorage()
  return { storage, service: new ButlerAttachments(ctx as never, config(patch), access, storage) }
}

describe('提示词里的附件段', () => {
  it('解析出来的正文照录，并说清这是哪一份文件', async () => {
    const { service: attachments } = service()
    const text = await attachments.promptBlock([
      record({
        id: 'a1',
        name: '需求.txt',
        parsed: { kind: 'text', unit: '行', totalUnits: 2, characters: 7, partial: false, units: [{ number: 1, text: '第一行' }, { number: 2, text: '第二行' }] },
      }),
    ], 2000)
    expect(text).toContain('【1】需求.txt')
    expect(text).toContain('第一行')
    expect(text).toContain('第二行')
  })

  it('读不出来的文件如实说明，并带上原因', async () => {
    const { service: attachments } = service()
    const text = await attachments.promptBlock([
      record({ id: 'a1', name: '坏的.json', kind: 'json', status: 'failed', message: 'JSON 格式无效' }),
    ], 2000)
    expect(text).toContain('没有读出来')
    expect(text).toContain('JSON 格式无效')
  })

  it('还没读过的图片说"文字内容还没有读出来"，不假装它没有内容', async () => {
    const { service: attachments } = service()
    const text = await attachments.promptBlock([record({ id: 'a1', name: '截图.png', kind: 'image', mediaType: 'image/png' })], 2000)
    expect(text).toContain('这是一张图片')
    expect(text).toContain('还没有读出来')
  })

  it('认得出但读不出文字的格式照实说', async () => {
    const { service: attachments } = service()
    const text = await attachments.promptBlock([
      record({ id: 'a1', name: '东西.zip', kind: 'binary', message: '这类文件读不出文字，只能原样转交' }),
    ], 2000)
    expect(text).toContain('读不出文字')
  })

  it('超过预算时截断并标明"只是这份文件的一部分"', async () => {
    const { service: attachments } = service()
    const units = Array.from({ length: 50 }, (_, index) => ({ number: index + 1, text: 'x'.repeat(40) }))
    const text = await attachments.promptBlock([
      record({ id: 'a1', name: '长文.txt', parsed: { kind: 'text', unit: '行', totalUnits: 50, characters: 2000, partial: false, units } }),
    ], 200)
    expect(text).toContain('只是这份文件的一部分')
    // 预算 200 字：加上"【1】名字（…）"那一行与这句提示，总长仍在一个很窄的范围内。
    expect(text.length).toBeLessThan(400)
  })

  it('没有附件时给空串（调用方据此不往提示词里加空段）', async () => {
    const { service: attachments } = service()
    expect(await attachments.promptBlock([], 2000)).toBe('')
  })
})

describe('图片', () => {
  it('只有"就绪的图片 + 已存好的引用"才当图片块交出去', () => {
    const { service: attachments } = service()
    const refs = attachments.imageRefs([
      record({ id: 'a1', kind: 'image', mediaType: 'image/png', original: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 9, width: 1, height: 1 } }),
      record({ id: 'a2', kind: 'image', status: 'failed' }),
      record({ id: 'a3', kind: 'text' }),
    ])
    expect(refs).toHaveLength(1)
    expect((refs[0] as { attachmentId: string }).attachmentId).toBe('img-1')
  })

  it('读一次落库，第二次不再调模型', async () => {
    const vision = fakeVision('图里写着：合计 1200')
    const storage = memoryStorage()
    const attachments = new ButlerAttachments(vision.ctx as never, config(), access, storage)
    const image = record({ id: 'a1', name: '报表.png', kind: 'image', mediaType: 'image/png', original: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 9, width: 1, height: 1 } })
    await storage.attachmentInsert(actor, image)

    await attachments.ensureImageText(actor, [image])
    expect(vision.calls).toHaveLength(1)
    const stored = await storage.attachment(actor, 'a1')
    expect(stored?.parsed?.units[0]?.text).toContain('合计 1200')
    // 落库之后正文就能进提示词了。
    expect(await attachments.promptBlock([stored as ButlerAttachmentRecord], 2000)).toContain('合计 1200')

    // 第二轮：已经有文字了，不再读。
    await attachments.ensureImageText(actor, [stored as ButlerAttachmentRecord])
    expect(vision.calls).toHaveLength(1)
  })

  it('读不出来不改附件状态，只写一句说明（文件本身没坏）', async () => {
    const vision = {
      get: (name: string) => name === 'llm' ? {
        async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
        // eslint-disable-next-line require-yield
        async *stream(): AsyncGenerator<{ type: string, text: string }> { throw new Error('没有额度了') },
      } : undefined,
    }
    const storage = memoryStorage()
    const attachments = new ButlerAttachments(vision as never, config(), access, storage)
    const image = record({ id: 'a1', name: '报表.png', kind: 'image', original: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 9, width: 1, height: 1 } })
    await storage.attachmentInsert(actor, image)
    await attachments.ensureImageText(actor, [image])
    const stored = await storage.attachment(actor, 'a1')
    expect(stored?.status).toBe('ready')
    expect(String(stored?.message)).toContain('读图失败')
  })

  it('这个部署没有能读图的模型时明说，而不是把图片当成没有内容', async () => {
    // 目录里一个支持图片的模型都没有 → 自动挑不到路由。
    const ctx = {
      get: (name: string) => {
        if (name === 'llm') return { async resolveModelInfo() { return { inputModalities: ['text'] } }, async *stream() { /* 不该被调到 */ } }
        if (name === 'sessionController') return { async modelCatalog() { return { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] } } }
        return undefined
      },
    }
    const storage = memoryStorage()
    const attachments = new ButlerAttachments(ctx as never, config({ visionModel: '' }), access, storage)
    const image = record({ id: 'a1', kind: 'image', original: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 9, width: 1, height: 1 } })
    await storage.attachmentInsert(actor, image)
    await attachments.ensureImageText(actor, [image])
    expect(String((await storage.attachment(actor, 'a1'))?.message)).toContain('没有能读图的模型')
  })
})

describe('选择一批附件', () => {
  it('顺序与传入一致，空数组直接返回空', async () => {
    const { service: attachments, storage } = service()
    await storage.attachmentInsert(actor, record({ id: 'a1' }))
    await storage.attachmentInsert(actor, record({ id: 'a2' }))
    const picked = await attachments.select(actor, ['a2', 'a1'])
    expect(picked.map(item => item.id)).toEqual(['a2', 'a1'])
    expect(await attachments.select(actor, [])).toEqual([])
  })

  it('不存在、别人的、已删除都按同一个答案拒绝（不泄露存在性）', async () => {
    const { service: attachments, storage } = service()
    await storage.attachmentInsert(other, record({ id: 'b1' }))
    await expect(attachments.select(actor, ['b1'])).rejects.toMatchObject({ status: 404 })
    await expect(attachments.select(actor, ['没有这个'])).rejects.toMatchObject({ status: 404 })
  })

  it('重复的与超过上限的一律拒', async () => {
    const { service: attachments, storage } = service({ maxAttachmentsPerMessage: 2 })
    await storage.attachmentInsert(actor, record({ id: 'a1' }))
    await expect(attachments.select(actor, ['a1', 'a1'])).rejects.toMatchObject({ status: 400 })
    await expect(attachments.select(actor, ['a1', 'a2', 'a3'])).rejects.toMatchObject({ status: 413 })
  })
})

describe('绑定到任务', () => {
  it('绑上之后就不再算"待发"，按任务也读得到', async () => {
    const { service: attachments, storage } = service()
    await storage.attachmentInsert(actor, record({ id: 'a1', conversationId: 'c1' }))
    expect(await attachments.bindToTask(actor, ['a1'], 'task-1', 'c1')).toBe(1)
    expect(await attachments.list(actor, 'c1')).toEqual([])
    expect((await attachments.forTask('task-1')).map(item => item.id)).toEqual(['a1'])
  })

  it('已删除的不绑，并如实回报改了几行', async () => {
    const { service: attachments, storage } = service()
    await storage.attachmentInsert(actor, record({ id: 'a1', conversationId: 'c1' }))
    await storage.attachmentInsert(actor, record({ id: 'a2', conversationId: 'c1', status: 'removed' }))
    expect(await attachments.bindToTask(actor, ['a1', 'a2'], 'task-1', 'c1')).toBe(1)
  })
})

describe('上传', () => {
  it('宿主没有附件服务时按 503 拒绝，而不是抛一个说不清的错误', async () => {
    const attachments = new ButlerAttachments({ get: () => undefined } as never, config(), access, memoryStorage())
    await expect(attachments.upload(actor, { name: 'a.txt', bytes: new TextEncoder().encode('x') }))
      .rejects.toMatchObject({ status: 503, reason: 'attachment_store_unavailable' })
  })

  it('空文件与超限在落库之前就被拒', async () => {
    const provider = { saveFileStream: vi.fn(), readFileStream: vi.fn() }
    const attachments = new ButlerAttachments({ get: () => provider } as never, config({ maxAttachmentBytes: 8 }), access, memoryStorage())
    await expect(attachments.upload(actor, { name: 'a.txt', bytes: new Uint8Array() }))
      .rejects.toMatchObject({ status: 400 })
    await expect(attachments.upload(actor, { name: 'a.txt', bytes: new TextEncoder().encode('x'.repeat(9)) }))
      .rejects.toMatchObject({ status: 413 })
    expect(provider.saveFileStream).not.toHaveBeenCalled()
  })
})
