import { expect, test } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fixture } from './fixture.mjs'
import { buildReference } from '../scripts/build-reference.mjs'
import { renderFrameworkConfig } from '../../../packages/plugin-manager/src/framework-config.mjs'
import { referenceWorkspace } from './reference-fixture.mjs'
import { versionTemplates } from '../../../scripts/version.mjs'

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
    const page = JSON.parse(await read.execute({ path: 'README.md', lines: 120 }, execution))
    expect(page.content.split('\n')).toHaveLength(100)
    expect(page.nextLine).toBe(101)
    const next = JSON.parse(await read.execute({ path: 'README.md', startLine: page.nextLine, lines: 105 }, execution))
    expect(next.content).toMatch(/^101: /)
    expect(next.content.split('\n').length).toBeLessThanOrEqual(100)
    for (const lines of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(read.execute({ path: 'README.md', lines }, execution)).rejects.toThrow(/无效|invalid arguments/)
    }
    await expect(read.execute({ path: '../../.local/site.json' }, execution)).rejects.toThrow('不在随包')
    await expect(read.execute({ path: 'plugins/dsh-blog-assistant/config/config.json' }, execution)).rejects.toThrow('不在随包')
    await expect(read.execute({ path: 'package.json' }, { ...execution, agent: {} })).rejects.toThrow('当前示例会话')
    f.revoked.add('login-a')
    await expect(search.execute({ query: 'hello' }, execution)).rejects.toThrow('撤销')
  } finally { await response?.body.cancel(); await f.close() }
})

test('source snapshot includes all public framework layers and excludes private plugins and runtime configuration', () => {
  const root = referenceWorkspace()
  const output = join(root, 'out.json')
  try {
    for (const name of ['README.md', 'README.en.md']) writeFileSync(join(root, name), 'public')
    for (const path of ['packages/plugin-manager/src', 'packages/plugin-kit/src', 'plugins/dsh-auth/src', 'plugins/dsh-example/src', 'plugins/dsh-blog-assistant/src', 'deploy', '.local']) {
      mkdirSync(join(root, path), { recursive: true }); writeFileSync(join(root, path, 'implementation.mjs'), `// ${path}`)
    }
    writeFileSync(join(root, 'plugins/dsh-example', 'config.json'), '{"credential":"private-fixture"}')
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/check.yml'), 'name: Public checks')
    mkdirSync(join(root, 'doc/releases'), { recursive: true })
    writeFileSync(join(root, 'doc/releases/v0.1.0.md'), 'historical-release-fixture')
    writeFileSync(join(root, 'doc/unregistered.md.tmpl'), 'unregistered-template-fixture')
    writeFileSync(join(root, 'plugins/dsh-blog-assistant/private.md.tmpl'), 'private-template-fixture')
    for (const name of ['build.sh', 'build.ps1']) {
      writeFileSync(join(root, name), 'private-entry-fixture')
      writeFileSync(join(root, 'deploy', name), 'shared-public-entry-fixture')
    }
    writeFileSync(join(root, 'packages/plugin-kit/src/types.d.mts'), 'export type Identity = string')
    const publicTemplate = renderFrameworkConfig()
    writeFileSync(join(root, 'env.conf'), publicTemplate)
    writeFileSync(join(root, 'test-report.sh'), '#!/bin/sh\n')
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
    expect(value.files.some(file => file.path === 'test-report.sh')).toBe(true)
    for (const path of versionTemplates) expect(value.files.find(file => file.path === path).text).toContain('{{FRAMEWORK_VERSION}}')
    expect(value.files.some(file => file.path.startsWith('doc/releases/'))).toBe(false)
    for (const name of ['build.sh', 'build.ps1']) {
      expect(value.files.some(file => file.path === name)).toBe(false)
      expect(value.files.find(file => file.path === `deploy/${name}`).text).toBe('shared-public-entry-fixture')
    }
    for (const marker of ['historical-release-fixture', 'private-entry-fixture', 'unregistered-template-fixture', 'private-template-fixture']) expect(JSON.stringify(value)).not.toContain(marker)
    writeFileSync(join(root, 'env.conf'), publicTemplate.replace('DEEPSEEK_API_KEY=', 'DEEPSEEK_API_KEY=private-fixture'))
    expect(() => buildReference(root, output)).toThrow('公开env.conf')
    writeFileSync(join(root, 'env.conf'), publicTemplate)
    writeFileSync(join(root, 'packages/plugin-manager/src/implementation.mjs'), 'x'.repeat(19001))
    expect(() => buildReference(root, output)).toThrow('上限')
    writeFileSync(join(root, 'packages/plugin-manager/src/implementation.mjs'), '// public')
    symlinkSync(join(root, '.local'), join(root, 'scripts'), 'junction')
    expect(() => buildReference(root, output)).toThrow('符号链接')
  } finally { expect(dirname(root)).toBe(realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }) }
})
