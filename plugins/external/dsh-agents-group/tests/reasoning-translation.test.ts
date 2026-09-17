/**
 * 译文留档契约与缓存命中（B2-2b 评审 P0 回归）。
 *
 * 背景：`translationWrite` 的 data 契约是**对象**（存储实现负责 JSON 序列化）；调用方若
 * 传入已序列化字符串会被双重编码，`translationLatest` 读回字符串而非对象，缓存命中分支
 * 取 `result.text` 抛 TypeError、经错误映射成 500——即"同一段思考第二次点中文译文必失败"。
 * 本文件同时钉住：①存储往返的对象契约；②`ReasoningTranslations.translate` 二次命中
 * （返回缓存且不再调用模型）；③running/failed 中间状态不参与命中。
 */
import { describe, expect, it } from 'vitest'
import { BlogStore } from '../agents/blog/src/store.ts'
import { ReasoningTranslations } from '../agents/blog/src/reasoning-translation.ts'

const actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const target = { conversationId: 'blog-chat-1', sourceId: 'msg-1' }
const ORIGINAL = 'This is a long enough english reasoning draft about architecture and design tradeoffs.'
const TRANSLATED = '这是一段中文译文，用于验证缓存命中的完整往返。'

function fakeContext(calls: { stream: number }) {
  return {
    on: () => () => {},
    llm: {
      resolveModelInfo: async () => ({}),
      stream: async function* () {
        calls.stream += 1
        yield { type: 'text-delta', index: 0, text: TRANSLATED }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

async function fixture() {
  const store = new BlogStore(':memory:')
  await store.init()
  const calls = { stream: 0 }
  const translations = new ReasoningTranslations({
    ctx: fakeContext(calls) as never,
    pluginId: 'blog',
    storage: store as never,
    access: { assert() {} },
    selectModel: () => ({ provider: 'test', model: 'test-model' }),
    readOriginal: async () => ({ text: ORIGINAL, partial: false }),
  })
  return { store, calls, translations }
}

describe('译文留档（B2-2b P0 回归）', () => {
  it('存储往返保持对象契约：写入对象、读回对象（不得双重序列化）', async () => {
    const { store } = await fixture()
    try {
      await store.translationWrite('id-1', 'key-1', 'user:alice', 'translated', { result: { text: '你好' }, textNormalized: true })
      const round = await store.translationLatest('key-1')
      expect(typeof round).toBe('object')
      expect(round.result.text).toBe('你好')
    } finally {
      store.close()
    }
  })

  it('缓存命中：第二次翻译返回上次结果且不再调用模型', async () => {
    const { store, calls, translations } = await fixture()
    try {
      const first = await translations.translate(actor as never, target, new AbortController().signal)
      expect(first.status).toBe('translated')
      expect(first.cached).toBe(false)
      expect(first.text).toBe(TRANSLATED)
      expect(calls.stream).toBe(1)
      const second = await translations.translate(actor as never, target, new AbortController().signal)
      expect(second.cached).toBe(true)
      expect(second.status).toBe('translated')
      expect(second.text).toBe(TRANSLATED)
      expect(calls.stream).toBe(1)
    } finally {
      await translations.close()
      store.close()
    }
  })

  it('running/failed 中间状态不参与缓存命中，成功留档才被读回', async () => {
    const { store } = await fixture()
    try {
      await store.translationWrite('id-r', 'key-2', 'user:alice', 'running', { result: { text: '进行中' }, textNormalized: true })
      await store.translationWrite('id-f', 'key-2', 'user:alice', 'failed', { error: '译文请求失败' })
      expect(await store.translationLatest('key-2')).toBeUndefined()
      await store.translationWrite('id-t', 'key-2', 'user:alice', 'translated', { result: { text: '完成' }, textNormalized: true })
      const latest = await store.translationLatest('key-2')
      expect(latest.result.text).toBe('完成')
    } finally {
      store.close()
    }
  })
})
