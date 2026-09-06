/** Shipped examples stay parseable and cover the complete plugin configuration. */
import { expect, test } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { Config } from '../src/config.ts'
import { resolveDeployment } from '../../../packages/plugin-manager/src/config.mjs'
import { resolvePluginSettings } from '../../../packages/plugin-manager/src/plugin-settings.mjs'

const read = name => JSON.parse(readFileSync(new URL('../examples/' + name, import.meta.url), 'utf8'))

test('example template explicitly supplies every Schema field at its default', () => {
  const settings = read('plugin.json.example')
  const complete = { ...settings.config, accessMode: settings.accessMode, publicOrigin: '' }
  expect(complete).toEqual(Config({}))
  expect(Config(complete)).toEqual(complete)
  expect(settings.schemaVersion).toBe(1)
  expect(settings.enabled).toBe(true)
})

test('deployment and plugin templates resolve together without changing the shared origin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-example-config-'))
  try {
    cpSync(new URL('../examples/deployment.json.example', import.meta.url), join(root, 'deployment.json'))
    const config = read('deployment.json.example')
    for (const [id, file] of [['example', 'plugin.json.example'], ['auth', 'auth.plugin.json.example']]) {
      const target = join(root, config.instances[id].settingsFile)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(new URL('../examples/' + file, import.meta.url), target)
    }
    const deployment = resolveDeployment({ root, config: 'deployment.json' }, {})
    const plugins = ['auth', 'example'].map(id => {
      const meta = JSON.parse(readFileSync(new URL('../../dsh-' + id + '/package.json', import.meta.url), 'utf8')).deepseekPlugin
      return { id, configuration: meta.configuration, healthPath: meta.healthPath }
    })
    const result = resolvePluginSettings(deployment, { plugins })
    expect(result.entries).toHaveLength(2)
    for (const entry of result.entries) expect(entry.config.publicOrigin).toBe(config.publicOrigin)
    expect(Config(result.entries.find(entry => entry.id === 'example').config).accessMode).toBe('authenticated')
    expect(result.entries.find(entry => entry.id === 'auth').config.stateDir).toBe('/data/dsh-home/auth')
  } finally {
    expect(dirname(root)).toBe(resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})
