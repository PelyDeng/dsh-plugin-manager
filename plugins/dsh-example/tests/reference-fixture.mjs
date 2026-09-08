/** Minimal synchronized public workspace for snapshot boundary tests. */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { frameworkPackages, frameworkVersion, versionTemplates } from '../../../scripts/version.mjs'

export function referenceWorkspace() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'example-public-reference-')))
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)))
  write('package.json', JSON.stringify({ name: 'dsh-plugin-manager-workspace', version }))
  for (const path of frameworkPackages) write(path, JSON.stringify({ version }))
  for (const path of versionTemplates) write(path, '# Current framework {{FRAMEWORK_VERSION}}\n')
  frameworkVersion(root, { mode: 'sync' })
  return root
}
