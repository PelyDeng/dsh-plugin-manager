import { describe, expect, it } from 'vitest'
import { modelKeyStatus, setModelKey, validateModelKey } from '../src/model-key.mjs'
import type { ModelKeyProvider } from '../src/model-key.mjs'

describe('fixed model credential references', () => {
  it('keeps providers separate and rejects arbitrary credential refs before accessing the host', async () => {
    const values = new Map<string, string>(), calls: string[] = []
    const provider = {
      describe: async (ref: string) => { calls.push(ref); return { writable: true } },
      resolve: async (ref: string) => values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined,
      set: async (ref: string, value: string) => { values.set(ref, value) },
    }
    await setModelKey(provider, 'deepseek', 'sk-deepseek-fixture')
    const first = await setModelKey(provider, 'zhipu', 'zhipu-id.fixture-secret')
    expect(values.get('DEEPSEEK_API_KEY')).toBe('sk-deepseek-fixture')
    expect(values.get('ZHIPU_API_KEY')).toBe('zhipu-id.fixture-secret')
    expect(JSON.stringify(first)).not.toContain('fixture-secret')
    const before = calls.length
    for (const invalid of ['constructor', '__proto__', 'OTHER_API_KEY']) {
      await expect(modelKeyStatus(provider, invalid as ModelKeyProvider)).rejects.toThrow('不支持')
      await expect(setModelKey(provider, invalid as ModelKeyProvider, 'fixture')).rejects.toThrow('不支持')
    }
    expect(calls).toHaveLength(before)
  })
  it('rejects whitespace and control characters without imposing a DeepSeek prefix on Zhipu', () => {
    expect(() => validateModelKey('zhipu', 'id.secret')).not.toThrow()
    for (const invalid of ['', 'a b', 'a\nb', 'a\u007fb', '密钥', 'a'.repeat(4097)]) expect(() => validateModelKey('zhipu', invalid)).toThrow('格式无效')
    expect(() => validateModelKey('deepseek', 'id.secret')).toThrow('sk-')
  })
})
