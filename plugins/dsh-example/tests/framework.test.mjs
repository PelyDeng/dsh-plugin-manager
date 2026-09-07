import { expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from './fixture.mjs'
import { buildReference } from '../scripts/build-reference.mjs'

test('authorized conversations can cite actual source, but cannot read runtime files or act as another Agent', async () => {
  const f = await fixture({ mode: 'authenticated' })
  let response
  try {
    response = await f.request('/chat', { message: '安装恢复怎么实现？' })
    const execution = { agent: f.handles[0].agent, signal: new AbortController().signal }
    const search = f.tools.get('example_search_framework'), read = f.tools.get('example_read_framework')
    const found = JSON.parse(await search.execute({ query: 'synchronize desiredHash' }, execution))
    expect(found.results.some(result => result.path === 'packages/plugin-manager/src/installation.mjs')).toBe(true)
    const source = JSON.parse(await read.execute({ path: 'packages/plugin-manager/src/installation.mjs', startLine: 165, lines: 60 }, execution))
    expect(source.content).toContain('desiredHash')
    expect(source.content).toContain('assessVerification')
    expect(source.nextLine).toBe(225)
    await expect(read.execute({ path: '../../.local/site.json' }, execution)).rejects.toThrow('不在随包')
    await expect(read.execute({ path: 'plugins/dsh-blog-assistant/config/config.json' }, execution)).rejects.toThrow('不在随包')
    await expect(read.execute({ path: 'package.json' }, { ...execution, agent: {} })).rejects.toThrow('当前示例会话')
    f.revoked.add('login-a')
    await expect(search.execute({ query: 'hello' }, execution)).rejects.toThrow('撤销')
  } finally { await response?.body.cancel(); await f.close() }
})

test('source snapshot includes all public framework layers and excludes private plugins and runtime configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-public-reference-'))
  const output = join(root, 'out.json')
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-plugin-manager-workspace' }))
    for (const name of ['README.md', 'README.en.md']) writeFileSync(join(root, name), 'public')
    for (const path of ['packages/plugin-manager/src', 'packages/plugin-kit/src', 'plugins/dsh-auth/src', 'plugins/dsh-example/src', 'plugins/dsh-blog-assistant/src', 'deploy', '.local']) {
      mkdirSync(join(root, path), { recursive: true }); writeFileSync(join(root, path, 'implementation.mjs'), `// ${path}`)
    }
    writeFileSync(join(root, 'plugins/dsh-example', 'config.json'), '{"credential":"private-fixture"}')
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/check.yml'), 'name: Public checks')
    writeFileSync(join(root, 'packages/plugin-kit/src/types.d.mts'), 'export type Identity = string')
    writeFileSync(join(root, 'env.conf'), '# 公开空模板\nDEEPSEEK_API_KEY=\n')
    buildReference(root, output)
    const value = JSON.parse(readFileSync(output))
    expect(value.files.some(file => file.path === 'packages/plugin-manager/src/implementation.mjs')).toBe(true)
    expect(value.files.some(file => file.path === 'packages/plugin-kit/src/implementation.mjs')).toBe(true)
    expect(value.files.some(file => file.path === 'plugins/dsh-auth/src/implementation.mjs')).toBe(true)
    expect(value.files.some(file => file.path === '.github/workflows/check.yml')).toBe(true)
    expect(value.files.some(file => file.path === 'packages/plugin-kit/src/types.d.mts')).toBe(true)
    expect(JSON.stringify(value)).not.toContain('dsh-blog-assistant')
    expect(JSON.stringify(value)).not.toContain('private-fixture')
    expect(value.files.some(file => file.path.startsWith('.local/'))).toBe(false)
    expect(value.files.some(file => file.path === 'env.conf')).toBe(true)
    writeFileSync(join(root, 'env.conf'), 'DEEPSEEK_API_KEY=private-fixture\n')
    expect(() => buildReference(root, output)).toThrow('只能包含空值')
    writeFileSync(join(root, 'env.conf'), 'DEEPSEEK_API_KEY=\n')
    writeFileSync(join(root, 'packages/plugin-manager/src/implementation.mjs'), 'x'.repeat(19001))
    expect(() => buildReference(root, output)).toThrow('上限')
    writeFileSync(join(root, 'packages/plugin-manager/src/implementation.mjs'), '// public')
    symlinkSync(join(root, '.local'), join(root, 'scripts'), 'junction')
    expect(() => buildReference(root, output)).toThrow('符号链接')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
