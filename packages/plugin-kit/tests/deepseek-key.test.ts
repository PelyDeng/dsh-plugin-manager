import { describe, expect, it } from 'vitest'
import { deepSeekKeyStatus, setDeepSeekKey } from '../src/deepseek-key.mjs'

function fixture() {
  let value: string | undefined
  const provider = {
    describe: async () => ({ writable: true }),
    resolve: async () => value ? { value, source: 'file' } : undefined,
    set: async (ref: string, next: string) => { expect(ref).toBe('DEEPSEEK_API_KEY'); value = next },
  }
  return provider
}

describe('shared DeepSeek credentials', () => {
  it('updates the same runtime provider and exposes only a stable one-way fingerprint', async () => {
    const provider = fixture()
    expect(await deepSeekKeyStatus(provider)).toMatchObject({ configured: false, fingerprint: null })
    const first = await setDeepSeekKey(provider, 'sk-first-fixture')
    expect(first).toMatchObject({ configured: true, writable: true, source: 'file' })
    expect(first.fingerprint).toMatch(/^SHA-256:[a-f0-9]{64}$/)
    expect(await deepSeekKeyStatus(provider)).toEqual(first)
    expect(JSON.stringify(first)).not.toContain('sk-first-fixture')
    expect((await setDeepSeekKey(provider, 'sk-second-fixture')).fingerprint).not.toBe(first.fingerprint)
    expect(await provider.resolve()).toEqual({ value: 'sk-second-fixture', source: 'file' })
  })
  it('refuses malformed input, missing service, readonly environment and revoked authorization without writing', async () => {
    const provider = fixture()
    await expect(setDeepSeekKey(provider, 'sk-good\nOTHER=value')).rejects.toThrow('格式无效')
    await expect(setDeepSeekKey(undefined, 'sk-fixture')).rejects.toThrow('未提供')
    await expect(setDeepSeekKey({ ...provider, describe: async () => ({ writable: false }) }, 'sk-fixture')).rejects.toThrow('只读')
    await expect(setDeepSeekKey(provider, 'sk-fixture', () => { throw new Error('revoked') })).rejects.toThrow('revoked')
    expect((await deepSeekKeyStatus(provider)).configured).toBe(false)
  })
  it('never reflects secret-bearing provider errors or arbitrary source metadata', async () => {
    const provider = fixture()
    await expect(setDeepSeekKey({ ...provider, set: async () => { throw new Error('sk-private-debug') } }, 'sk-fixture')).rejects.toThrow('保存失败')
    const status = await deepSeekKeyStatus({ ...provider, resolve: async () => ({ value: 'sk-private', source: 'sk-metadata' }) })
    expect(JSON.stringify(status)).not.toContain('sk-')
    expect(status.source).toBe(null)
  })
})
