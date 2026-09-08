import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildReference } from '../scripts/build-reference.mjs'
import { renderFrameworkConfig } from '../../../packages/plugin-manager/src/framework-config.mjs'

test('public reference indexes only exact reviewed env defaults and excludes private runtime configuration', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-reference-template-')))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-plugin-manager-workspace' }))
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
