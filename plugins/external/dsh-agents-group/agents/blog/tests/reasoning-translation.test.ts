/**
 * 译文失败状态的落库兜底（B8）：`write('failed')` 失败时**吞掉写错误但不吞日志**。
 *
 * 历史实现是 `.catch(() => {})`：状态机停在 `'running'`、失败原因两处皆无，运维既看不到
 * 译文失败也看不到状态写失败——这是质量方案点名的唯一必改吞错。本用例用替身驱动：
 * 模型解析抛错（进入 catch 分支）+ 状态写拒绝（`translationWrite` 直接失败），
 * 断言 `console.warn` 留下了含请求标识的日志，且对外仍是原有的 `AccessError` 502。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningTranslations } from '../src/reasoning-translation.ts'

const actor = { namespace: 'user' as const, userId: 'alice', sessionId: 'alice-login' }
// needsChineseTranslation 的判定要求：拉丁字母 ≥16、单词 ≥4、拉丁多于汉字两倍。
const original = { text: 'This is a long English reasoning passage written for translation testing.', partial: false }

test('a failed status write is logged, never silently dropped', async t => {
  const ctx = new Context()
  const written: Array<{ status: string }> = []
  const storage = {
    // 无缓存：让请求真正进入翻译执行路径。
    translationLatest: async () => undefined,
    // 状态写直接失败：模拟业务库不可用。
    translationWrite: async (_requestId: string, _key: string, _owner: string, status: string) => {
      written.push({ status })
      throw new Error('pg down')
    },
  }
  // 只挂 run() 会用到的 llm 面：resolveModelInfo 抛错即可进入 catch 分支（Context 的 llm
  // 服务声明来自宿主类型，替身按 unknown 写入绕开完整形状）。
  ;(ctx as unknown as { llm: unknown }).llm = {
    resolveModelInfo: async () => { throw new Error('model down') },
  }
  const warnings: string[] = []
  const originalWarn = console.warn
  t.after(() => { console.warn = originalWarn })
  console.warn = (...parts: unknown[]) => warnings.push(parts.map(String).join(' '))

  const translations = new ReasoningTranslations({
    ctx,
    pluginId: 'blog',
    storage: storage as never,
    access: { assert() {} },
    selectModel: () => ({ provider: 'fixture', model: 'fixture-model' }),
    readOriginal: async () => original,
  })
  t.after(() => translations.close())

  await assert.rejects(translations.translate(actor, { conversationId: 'c1', sourceId: 'm1' }, new AbortController().signal), error => {
    assert.equal((error as { status?: number }).status, 502)
    return true
  })
  // 状态机先写 'running'（成功）、失败时尝试写 'failed'（被拒）——失败路径确实尝试过落库。
  assert.deepEqual(written.map(entry => entry.status), ['running', 'failed'])
  assert.ok(warnings.some(line => line.includes('译文失败状态写入未落库') && line.includes('c1') && line.includes('pg down')), warnings.join('\n'))
})
