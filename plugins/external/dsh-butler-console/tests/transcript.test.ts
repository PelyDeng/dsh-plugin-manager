/**
 * 对话正文的读取。
 *
 * 第二入口要能拿到老板的原话与管家的答复，跨入口才算真的接得上；只有任务级摘要不够。
 * 但正文**不另存一份**：它是 DSH 官方会话日志的内容，这里只是按当前登录身份读出来。
 *
 * 三条性质要守住：
 *
 * 1. 只出用户可见的东西。注入的上下文、系统提示词、工具调用、没进过历史面的尝试都不出声 ——
 *    它们都是 user 角色或邻居事件，混进来会让人以为老板说过那些话。
 * 2. 能认回合。`user/message` 不带回合号，得从前面那条 `turn/start` 推；翻页从回合中间
 *    开始时也一样要认得出来。
 * 3. 日志读不到就如实报错。拿任务摘要冒充一段完整对话，比报错更糟。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import type { ButlerStorage } from '../src/storage/types.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

const text = (value: string) => [{ type: 'text', text: value }]

/** 真人说的话。 */
const said = (seq: number, value: string) => ({
  type: 'user/message', seq, time: 1000 + seq,
  data: { id: `msg-u-${seq}`, role: 'user', content: text(value), source: { kind: 'user' } },
})

/** 宿主塞给模型的背景（文件变更、AGENTS.md、技能内容……）。和上面同样是 user 角色。 */
const injected = (seq: number, value: string) => ({
  type: 'user/message', seq, time: 1000 + seq,
  data: { id: `msg-i-${seq}`, role: 'user', content: text(value), source: { kind: 'plugin', plugin: 'host' } },
})

const answered = (seq: number, value: string, turn: number, interrupted = false) => ({
  type: 'assistant/message', seq, time: 1000 + seq,
  data: {
    turn, step: 1,
    message: { id: `msg-a-${seq}`, role: 'assistant', content: text(value), source: { kind: 'model' } },
    stream: [],
    ...(interrupted ? { interrupted: true } : {}),
  },
})

const turnStart = (seq: number, turn: number) => ({ type: 'turn/start', seq, time: 1000 + seq, data: { turn } })
const stepStart = (seq: number, turn: number) => ({ type: 'step/start', seq, time: 1000 + seq, data: { turn, step: 1 } })
/** 没有提交到历史面的尝试：不该出现在对话里。 */
const attempt = (seq: number, value: string) => ({
  type: 'assistant/attempt', seq, time: 1000 + seq,
  data: { turn: 1, step: 1, stream: [{ type: 'text', text: value }] },
})

function fixture(all: readonly unknown[], options: { missingSession?: boolean; foreignOwner?: boolean } = {}) {
  const store = {
    assertOwner: vi.fn(() => {
      if (options.foreignOwner === true) throw new AccessError(404, '会话不存在或无权访问', 'conversation_not_found')
    }),
  } as unknown as ButlerStorage
  const access = { mode: 'authenticated', ready() {}, resolve: () => actor, assert() {} } as unknown as Access
  const config = { maxConversationEvents: 200, waitingTimeoutMs: 600_000, idempotencyTtlMs: 600_000 } as Config
  const ctx = {
    sessionPersistence: {
      open: async () => {
        if (options.missingSession === true) {
          throw Object.assign(new Error('没有这个会话'), { name: 'SessionPersistenceNotFoundError' })
        }
        return {
          read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) => ({
            eventState: 'owned', events: all.slice(offset, offset + length),
          }),
          close: async () => {},
        }
      },
    },
  } as unknown as Context
  return new ButlerConsole(ctx, config, access, store, '')
}

/** 一段两回合的会话：中间夹着注入的上下文与一次没提交的尝试。 */
const log = [
  turnStart(0, 1),
  stepStart(1, 1),
  injected(2, '以下是本目录的 AGENTS.md：……'),
  said(3, '帮我写一篇园区安全博客'),
  attempt(4, '这是一次被重试掉的尝试，不该出现'),
  answered(5, '我先让博客起一版，写完给你过目。', 1),
  { type: 'turn/end', seq: 6, time: 1006, data: { turn: 1, reason: { kind: 'completed' } } },
  turnStart(7, 2),
  said(8, '标题再短一点'),
  answered(9, '好，改成六个字以内。', 2, true),
]

describe('对话正文只给用户可见的内容', () => {
  it('真人输入与已提交答复都在，注入的上下文和没提交的尝试都不在', async () => {
    const page = await fixture(log).transcript(conversationId, actor, 0, 50)
    expect(page.items.map(item => item.text)).toEqual([
      '帮我写一篇园区安全博客',
      '我先让博客起一版，写完给你过目。',
      '标题再短一点',
      '好，改成六个字以内。',
    ])
    expect(page.items.map(item => item.role)).toEqual(['user', 'butler', 'user', 'butler'])
    expect(JSON.stringify(page)).not.toContain('AGENTS.md')
    expect(JSON.stringify(page)).not.toContain('被重试掉')
  })

  it('每条都带稳定的消息标识与事件序号，客户端能对上', async () => {
    const page = await fixture(log).transcript(conversationId, actor, 0, 50)
    expect(page.items[0]).toMatchObject({ seq: 3, messageId: 'msg-u-3', turn: 1 })
    expect(page.items[1]).toMatchObject({ seq: 5, messageId: 'msg-a-5', turn: 1 })
  })

  it('回合号认得出来；被打断的那一轮标注出来', async () => {
    const page = await fixture(log).transcript(conversationId, actor, 0, 50)
    // user 消息自己没有回合号，是从前面那条 turn/start 推的。
    expect(page.items.map(item => item.turn)).toEqual([1, 1, 2, 2])
    expect(page.items[3]?.interrupted).toBe(true)
    expect(page.items[0]?.interrupted).toBeUndefined()
  })

  it('从回合中间翻页时也认得出这条属于哪一轮', async () => {
    // 只读 seq 8 之后：前面那条 turn/start 不在这一页里，但它仍然认得出 turn 2。
    const page = await fixture(log).transcript(conversationId, actor, 8, 50)
    expect(page.items.map(item => item.seq)).toEqual([8, 9])
    expect(page.items.map(item => item.turn)).toEqual([2, 2])
  })
})

describe('对话正文的分页', () => {
  it('limit 生效，读完给 null，没读完给下一个游标', async () => {
    const first = await fixture(log).transcript(conversationId, actor, 0, 2)
    expect(first.items.map(item => item.seq)).toEqual([3, 5])
    expect(first.nextAfter).toBe(6)

    const second = await fixture(log).transcript(conversationId, actor, first.nextAfter!, 2)
    expect(second.items.map(item => item.seq)).toEqual([8, 9])
    // 这一页之后没有更多了。
    expect(second.nextAfter).toBeNull()
  })

  it('一段里没有可见消息时游标照样往前走，不会卡住', async () => {
    // seq 0..2 全是背景事件（turn/start、step/start、注入的上下文），一条可见的都没有。
    const page = await fixture(log).transcript(conversationId, actor, 0, 1)
    expect(page.items.map(item => item.seq)).toEqual([3])
    // 往前要的时候仍然能拿到后面那些，而不是停在同一处反复读。
    const next = await fixture(log).transcript(conversationId, actor, page.nextAfter!, 1)
    expect(next.items.map(item => item.seq)).toEqual([5])
  })
})

describe('尾读分页（C 批历史阅读：先看最新一页，再往更早翻）', () => {
  it('tail 取日志末尾一页；还有更早内容时给 prevBefore', async () => {
    const console_ = fixture(log)
    const page = await console_.transcript(conversationId, actor, 0, 2, { tail: true })
    expect(page.items.map(item => item.seq)).toEqual([8, 9])
    expect(page.items.map(item => item.turn)).toEqual([2, 2])
    expect(page.nextAfter).toBeNull()
    expect(page.prevBefore).toBe(8)
  })

  it('tail 一页能装下全部时 prevBefore 为 null（到底了）', async () => {
    const page = await fixture(log).transcript(conversationId, actor, 0, 50, { tail: true })
    expect(page.items.map(item => item.seq)).toEqual([3, 5, 8, 9])
    expect(page.prevBefore).toBeNull()
  })

  it('before 按游标往更早翻，直到没有更早的', async () => {
    const console_ = fixture(log)
    const older = await console_.transcript(conversationId, actor, 0, 2, { before: 8 })
    expect(older.items.map(item => item.seq)).toEqual([3, 5])
    expect(older.prevBefore).toBeNull()
    // limit 更小时游标给到本页最早一条（排他边界：下一页取 seq < 它），继续翻能拿到剩下的。
    const one = await console_.transcript(conversationId, actor, 0, 1, { before: 8 })
    expect(one.items.map(item => item.seq)).toEqual([5])
    expect(one.prevBefore).toBe(5)
    const last = await console_.transcript(conversationId, actor, 0, 5, { before: one.prevBefore! })
    expect(last.items.map(item => item.seq)).toEqual([3])
    expect(last.prevBefore).toBeNull()
  })

  it('before 早于任何可见消息时给空页，不报错不卡游标', async () => {
    const page = await fixture(log).transcript(conversationId, actor, 0, 10, { before: 3 })
    expect(page.items).toEqual([])
    expect(page.prevBefore).toBeNull()
  })

  it('注入上下文与未提交尝试在尾读里同样被滤掉', async () => {
    const page = await fixture(log).transcript(conversationId, actor, 0, 50, { tail: true })
    expect(JSON.stringify(page)).not.toContain('AGENTS.md')
    expect(JSON.stringify(page)).not.toContain('被重试掉')
  })
})

describe('读不到时如实报错', () => {
  it('官方日志里没有这段会话时明确说没有，不拿摘要冒充', async () => {
    const console_ = fixture([], { missingSession: true })
    await expect(console_.transcript(conversationId, actor, 0, 50))
      .rejects.toMatchObject({ reason: 'transcript_not_found', status: 404 })
  })

  it('别人的会话按同一种 404 拒绝，不泄露存在性', async () => {
    const console_ = fixture(log, { foreignOwner: true })
    await expect(console_.transcript(conversationId, actor, 0, 50))
      .rejects.toMatchObject({ reason: 'conversation_not_found', status: 404 })
  })
})
