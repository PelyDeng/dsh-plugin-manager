/** Verify the Agent receives the shipped knowledge on create and resume, not model quality. */
import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fixture } from './fixture.mjs'

test('setup FAQ remains readable with application authorization when the model is unavailable', async () => {
  const f = await fixture({ mode: 'authenticated', beforeCreate() { throw new Error('model unavailable') } })
  try {
    const page = await f.request('')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('首次配置 API 密钥')
    const faq = await f.request('/guide.md')
    expect(faq.status).toBe(200)
    const text = await faq.text()
    expect(text).toContain('dsh web authentication required')
    expect(text).toContain('bash deploy/scripts/set-api-key.sh --config .local/deployment.json')
    expect(f.handles).toHaveLength(0)
    expect((await f.request('/guide.md', undefined, '')).status).not.toBe(200)
  } finally { await f.close() }
})

test('package knowledge and supplemental instructions reach new and resumed Agents without tools', async () => {
  const pages = ['guide.md', 'prompts.md'].map(file => readFileSync(new URL('../knowledge/' + file, import.meta.url), 'utf8'))
  const text = pages.join('\n\n')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024)
  const revision = createHash('sha256').update(text).digest('hex').slice(0, 12)
  const f = await fixture({ mode: 'standalone', systemPrompt: '请优先给出 PowerShell 示例。' })
  try {
    const identity = await (await f.request('/identity')).json()
    expect(identity.knowledgeRevision).toBe(revision)
    const first = await f.request('/chat', { message: '独立仓库如何接入？' })
    const id = f.handles[0].id
    await first.body.cancel()
    await expect.poll(() => f.handles[0].disposed).toBe(true)
    const resumed = await f.request('/chat', { message: '第二个应用呢？', conversationId: id })
    for (const handle of f.handles) {
      expect(handle.sections.find(s => s.name === 'example:knowledge').text).toBe(`知识摘要 ${revision}\n\n${text}`)
      expect(handle.sections.find(s => s.name === 'example:developer').text).toContain('不能编造命令')
      expect(handle.sections.find(s => s.name === 'example:persona').text).toBe('请优先给出 PowerShell 示例。')
      expect(handle.allowed).toEqual([])
    }
    expect(f.handles).toHaveLength(2)
    await resumed.body.cancel()
  } finally { await f.close() }
})
