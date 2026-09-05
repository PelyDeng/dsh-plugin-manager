import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  AccessError, actorKey, collectProviders, createAccess, installProvider, isAccessError,
  listPlugins, onRevoked, registerPlugin,
  type Actor, type AuthProvider, type PluginDescriptor,
} from '../src/index.ts'

const user: Actor = { namespace: 'user', userId: 'a', sessionId: 'login-a' }
const descriptor: PluginDescriptor = {
  id: 'example', packageName: 'dsh-example', version: '1.0.0', displayName: '示例',
  description: '示例插件', entryPath: '/example', permissions: ['example:access'],
  tools: [{ name: 'example_query', description: '查询', parameters: {}, permission: 'example:access' }],
}
function request(method = 'GET', origin?: string): IncomingMessage {
  // Only the public headers/method consumed by the access interface are needed in this test.
  return { method, headers: origin ? { origin } : {} } as IncomingMessage
}
function provider(check = (_actor: Actor, _pluginId: string) => {}): AuthProvider {
  return { protocol: 1, ready() {}, resolve: () => user, assertAccess: check }
}

describe('explicit access mode', () => {
  it('keeps standalone usable without auth and separate from user data', () => {
    const ctx = new Context()
    const access = createAccess(ctx, { mode: 'standalone', pluginId: 'example', publicOrigin: '' })
    expect(actorKey(access.resolve(request()))).toBe('standalone:local')
    expect(() => access.assert(user)).toThrow(AccessError)
  })

  it('refuses missing authentication rather than switching modes', () => {
    const access = createAccess(new Context(), { mode: 'authenticated', pluginId: 'example', publicOrigin: 'https://example.test' })
    expect(() => access.resolve(request())).toThrowError(expect.objectContaining({ status: 503 }))
    expect(() => access.ready()).toThrowError(expect.objectContaining({ status: 503 }))
  })

  it('checks current permissions on every tool or request and rejects cross-origin writes', () => {
    const ctx = new Context()
    let allowed = true
    const remove = installProvider(ctx, provider(() => {
      if (!allowed) throw new AccessError(403, 'denied')
    }))
    const access = createAccess(ctx, { mode: 'authenticated', pluginId: 'example', publicOrigin: 'https://example.test' })
    expect(access.resolve(request())).toEqual(user)
    expect(() => access.resolve(request('POST', 'https://attacker.test'))).toThrowError(expect.objectContaining({ status: 403 }))
    expect(access.resolve(request('POST', 'https://example.test'))).toEqual(user)
    allowed = false
    expect(() => access.assert(user)).toThrowError(expect.objectContaining({ status: 403 }))
    remove()
    expect(() => access.assert(user)).toThrowError(expect.objectContaining({ status: 503 }))
  })
})

describe('host-owned event protocol', () => {
  it('reserves the console grant outside the business plugin catalog', () => {
    const ctx = new Context()
    expect(() => registerPlugin(ctx, { ...descriptor, id: 'dsh-console' })).toThrow(/保留授权/)
    ctx.on('ecosystem/catalog', accept => accept({ protocol: 1, plugin: { ...descriptor, id: 'dsh-console' } }))
    expect(() => listPlugins(ctx)).toThrow(/保留授权/)
  })
  it('shares registrations and identity between independently emitted module copies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-kit-bundles-'))
    try {
      const cli = join(dirname(createRequire(import.meta.url).resolve('tsdown/package.json')), 'dist/run.mjs')
      execFileSync(process.execPath, [cli, fileURLToPath(new URL('../src/index.ts', import.meta.url)), '--out-dir', directory, '--format', 'esm', '--no-config'], { stdio: 'pipe' })
      const url = pathToFileURL(join(directory, 'index.mjs')).href
      const first: typeof import('../src/index.ts') = await import(`${url}?first-package`)
      const second: typeof import('../src/index.ts') = await import(`${url}?second-package`)
      expect(first.AccessError).not.toBe(second.AccessError)
      const ctx = new Context()
      first.registerPlugin(ctx, descriptor)
      expect(second.listPlugins(ctx)).toEqual([descriptor])
      first.installProvider(ctx, provider())
      expect(second.createAccess(ctx, { mode: 'authenticated', pluginId: 'example', publicOrigin: 'https://example.test' }).resolve(request())).toEqual(user)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('recognizes protocol errors across independent package copies', () => {
    const foreign = { code: 'DSH_ACCESS_ERROR', name: 'AccessError', status: 403, message: 'denied' }
    expect(foreign instanceof AccessError).toBe(false)
    expect(isAccessError(foreign)).toBe(true)
    expect(isAccessError({ ...foreign, status: 200 })).toBe(false)
  })
  it('collects child registrations and removes them with the plugin fiber', async () => {
    const root = new Context()
    const fork = root.plugin(ctx => { registerPlugin(ctx, descriptor) })
    await fork.await()
    expect(listPlugins(root)).toEqual([descriptor])
    expect(listPlugins(new Context())).toEqual([])
    await fork.dispose()
    expect(listPlugins(root)).toEqual([])
  })

  it('rejects duplicate plugins and tool names without partially registering', () => {
    const ctx = new Context()
    const remove = registerPlugin(ctx, descriptor)
    expect(() => registerPlugin(ctx, descriptor)).toThrow('重复')
    expect(() => registerPlugin(ctx, { ...descriptor, id: 'other' })).toThrow('重复')
    expect(listPlugins(ctx)).toHaveLength(1)
    remove()
    registerPlugin(ctx, descriptor)
    expect(listPlugins(ctx)).toHaveLength(1)
  })

  it('rejects a second provider and broadcasts global revocation when unloaded', async () => {
    const ctx = new Context()
    const notices: unknown[] = []
    onRevoked(ctx, scope => { notices.push(scope) })
    const fork = ctx.plugin(child => { installProvider(child, provider()) })
    await fork.await()
    expect(collectProviders(ctx)).toHaveLength(1)
    expect(() => installProvider(ctx, provider())).toThrow('已存在')
    await fork.dispose()
    expect(collectProviders(ctx)).toEqual([])
    expect(notices).toEqual([{}])
  })

  it('rejects multiple or unknown protocol responses instead of selecting one', () => {
    const ctx = new Context()
    const incompatible = { ...provider(), protocol: 2 } as unknown as AuthProvider
    const stop = ctx.on('ecosystem/providers', accept => { accept(incompatible) })
    expect(() => collectProviders(ctx)).toThrowError(expect.objectContaining({ status: 503 }))
    stop()
    ctx.on('ecosystem/providers', accept => { accept(provider()); accept(provider()) })
    expect(() => collectProviders(ctx)).toThrowError(expect.objectContaining({ status: 503 }))
  })
})
