/** Shared plugin identity and catalog protocol, transported by the host Cordis event bus. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'

export type AccessMode = 'standalone' | 'authenticated'
export type Actor =
  | { readonly namespace: 'standalone'; readonly userId: 'local' }
  | { readonly namespace: 'user'; readonly userId: string; readonly sessionId: string }

export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly permission: string
}

export interface PluginDescriptor {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly displayName: string
  readonly description: string
  readonly entryPath?: string
  readonly permissions: readonly string[]
  readonly tools: readonly ToolDescriptor[]
}

/** A provider validates the original login session on every access, including background tools. */
export interface AuthProvider {
  readonly protocol: 1
  ready(): void
  resolve(request: IncomingMessage): Actor | undefined
  assertAccess(actor: Actor, pluginId: string): void
}

export interface Revocation {
  readonly userId?: string
  readonly sessionId?: string
}

interface CatalogEntry { readonly protocol: number; readonly plugin: PluginDescriptor }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'ecosystem/catalog': (accept: (entry: CatalogEntry) => void) => void
    'ecosystem/providers': (accept: (provider: AuthProvider) => void) => void
    'ecosystem/revoked': (scope: Revocation) => void
  }
}

/** An expected HTTP authentication or authorization rejection. */
export class AccessError extends Error {
  readonly code = 'DSH_ACCESS_ERROR'
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AccessError'
  }
}

/** Recognize errors emitted by another independently bundled copy of this protocol. */
export function isAccessError(error: unknown): error is AccessError {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'DSH_ACCESS_ERROR'
    && 'status' in error && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    && 'message' in error && typeof error.message === 'string'
}

/** Stable business-data owner; login session identifiers must not become persistent owners. */
export function actorKey(actor: Actor): string {
  return `${actor.namespace}:${actor.userId}`
}

/** Collect every provider so duplicates cannot be hidden by listener order. */
export function collectProviders(ctx: Context): AuthProvider[] {
  const providers: AuthProvider[] = []
  ctx.root.emit('ecosystem/providers', provider => { providers.push(provider) })
  if (providers.some(provider => provider.protocol !== 1) || providers.length > 1) {
    throw new AccessError(503, '认证提供者重复或协议版本不兼容')
  }
  return providers
}

/** Publish revocation after the provider has committed the state change. */
export function emitRevoked(ctx: Context, scope: Revocation = {}): void {
  ctx.root.emit('ecosystem/revoked', scope)
}

/** Observe revocation within the current plugin's lifecycle. */
export function onRevoked(ctx: Context, listener: (scope: Revocation) => void): () => void {
  return ctx.on('ecosystem/revoked', listener, { global: true })
}

/** Register exactly one authentication provider; unloading invalidates active protected work. */
export function installProvider(ctx: Context, provider: AuthProvider): () => void {
  if (provider.protocol !== 1 || collectProviders(ctx).length !== 0) {
    throw new Error('认证提供者已存在或协议版本不兼容')
  }
  const stop = ctx.on('ecosystem/providers', accept => { accept(provider) }, { global: true })
  let active = true
  const dispose = () => {
    if (!active) return
    active = false
    stop()
    emitRevoked(ctx)
  }
  ctx.effect(() => dispose)
  return dispose
}

/** Read the current catalog; it includes live registrations, never secrets or deployment config. */
export function listPlugins(ctx: Context): PluginDescriptor[] {
  const entries: CatalogEntry[] = []
  ctx.root.emit('ecosystem/catalog', entry => { entries.push(entry) })
  if (entries.some(entry => entry.protocol !== 1)) throw new Error('插件目录协议版本不兼容')
  const ids = new Set<string>()
  const tools = new Set<string>()
  for (const { plugin } of entries) {
    if (plugin.id === 'dsh-console') throw new Error('dsh-console 是控制台保留授权标识')
    if (ids.has(plugin.id)) throw new Error(`插件重复登记：${plugin.id}`)
    ids.add(plugin.id)
    for (const tool of plugin.tools) {
      if (tools.has(tool.name)) throw new Error(`工具重复登记：${tool.name}`)
      tools.add(tool.name)
    }
  }
  return entries.map(entry => entry.plugin).sort((left, right) => left.id.localeCompare(right.id))
}

/** Register metadata from the same definitions used to mount the plugin's tools. */
export function registerPlugin(ctx: Context, descriptor: PluginDescriptor): () => void {
  if (descriptor.id === 'dsh-console') throw new Error('dsh-console 是控制台保留授权标识')
  const current = listPlugins(ctx)
  if (current.some(plugin => plugin.id === descriptor.id)) throw new Error(`插件重复登记：${descriptor.id}`)
  const names = new Set(current.flatMap(plugin => plugin.tools.map(tool => tool.name)))
  for (const tool of descriptor.tools) {
    if (names.has(tool.name)) throw new Error(`工具重复登记：${tool.name}`)
    if (!descriptor.permissions.includes(tool.permission)) throw new Error(`工具权限未声明：${tool.name}`)
    names.add(tool.name)
  }
  return ctx.on('ecosystem/catalog', accept => { accept({ protocol: 1, plugin: descriptor }) }, { global: true })
}

export interface Access {
  readonly mode: AccessMode
  ready(): void
  resolve(request: IncomingMessage): Actor
  assert(actor: Actor): void
}

/** Create one plugin's access checks. Missing authentication never changes the selected mode. */
export function createAccess(ctx: Context, options: {
  readonly mode: AccessMode
  readonly pluginId: string
  readonly publicOrigin: string
}): Access {
  if (options.mode !== 'standalone' && options.mode !== 'authenticated') throw new Error('无效访问模式')
  let origin = ''
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin)
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== options.publicOrigin) {
      throw new Error('publicOrigin 必须是完整 HTTP(S) origin，不带路径')
    }
    origin = url.origin
  }
  if (options.mode === 'authenticated' && !origin) throw new Error('认证模式必须配置 publicOrigin')
  const provider = (): AuthProvider => {
    const result = collectProviders(ctx)[0]
    if (!result) throw new AccessError(503, '认证服务不可用')
    result.ready()
    return result
  }
  const assert = (actor: Actor) => {
    if (options.mode === 'standalone') {
      if (actor.namespace !== 'standalone') throw new AccessError(403, '当前模式不能访问个人账号数据')
    } else {
      if (actor.namespace !== 'user') throw new AccessError(401, '请先登录')
      provider().assertAccess(actor, options.pluginId)
    }
  }
  return {
    mode: options.mode,
    ready() { if (options.mode === 'authenticated') provider() },
    assert,
    resolve(request) {
      if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET') && request.headers.origin !== origin) {
        throw new AccessError(403, '请求来源不受信任')
      }
      if (options.mode === 'standalone') return { namespace: 'standalone', userId: 'local' }
      const actor = provider().resolve(request)
      if (!actor) throw new AccessError(401, '请先登录')
      assert(actor)
      return actor
    },
  }
}
