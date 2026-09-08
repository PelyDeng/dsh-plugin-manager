import { test, expect } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildReference } from '../scripts/build-reference.mjs'
import { renderFrameworkConfig } from '../../../packages/plugin-manager/src/framework-config.mjs'
import { referenceWorkspace } from './reference-fixture.mjs'

test('public reference indexes only exact reviewed env defaults and excludes private runtime configuration', () => {
  const root = referenceWorkspace()
  try {
    const template = renderFrameworkConfig()
    writeFileSync(join(root, 'env.conf'), template)
    mkdirSync(join(root, '.local')); writeFileSync(join(root, '.local/env.conf'), 'DEEPSEEK_API_KEY=private-sentinel\n')
    const output = join(root, 'reference.json')
    buildReference(root, output)
    const snapshot = JSON.parse(readFileSync(output))
    expect(snapshot.files.find(file => file.path === 'env.conf').text).toBe(template)
    expect(JSON.stringify(snapshot)).not.toContain('private-sentinel')
    for (const change of ['DEEPSEEK_API_KEY=private-sentinel', 'REGISTRY_PASSWORD=private-sentinel', 'DSH_PORT=27913', 'DSH_IMAGE_PLATFORM=linux/arm64', 'DSH_CONTAINER_IMAGE=private-sentinel']) {
      const key = change.split('=')[0]
      writeFileSync(join(root, 'env.conf'), template.replace(new RegExp(`^${key}=.*$`, 'm'), change))
      expect(() => buildReference(root, output)).toThrow('公开env.conf')
      expect(JSON.stringify(JSON.parse(readFileSync(output)))).not.toContain('private-sentinel')
    }
  } finally { expect(dirname(root)).toBe(realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }) }
})

test('stale package versions and generated docs reject snapshot replacement without repairing source', () => {
  const root = referenceWorkspace()
  try {
    const output = join(root, 'reference.json')
    buildReference(root, output)
    const previous = readFileSync(output, 'utf8')
    for (const [path, drift] of [
      ['packages/plugin-kit/package.json', '{"version":"0.0.1"}\n'],
      ['doc/versioning.md', '# stale generated version\n'],
    ]) {
      const original = readFileSync(join(root, path), 'utf8')
      writeFileSync(join(root, path), drift)
      expect(() => buildReference(root, output)).toThrow('框架版本或文档未同步')
      expect(readFileSync(output, 'utf8')).toBe(previous)
      expect(readFileSync(join(root, path), 'utf8')).toBe(drift)
      writeFileSync(join(root, path), original)
    }
  } finally { expect(dirname(root)).toBe(realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }) }
})
