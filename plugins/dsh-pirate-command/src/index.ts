import { readFile, mkdir } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AccessError, conversationModel, conversationModelCatalog, createAccess, createPluginHttp, isAccessError, registerPlugin, type ConversationModel } from '@dsh-plugin-manager/plugin-kit'
import { PirateCoordinator } from './coordinator.ts'
import { MissionStore, type Mission } from './store.ts'
import type { Config } from './config.ts'
export { Config } from './config.ts'

export const name = 'pirate-command'
export const inject = ['agents', 'agentDefaultModel', 'llm', 'webServer', 'systemPrompt', 'tools', 'sessionPersistence'] as const

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(data))
}
function publicMission(mission: Mission) {
  const { id, title, state, updatedAt } = mission
  return { id, title, state, updatedAt }
}
function missionId(value: unknown): string {
  if (typeof value !== 'string' || !/^pirate-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new AccessError(400, '协作标识无效')
  return value
}
async function body(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (request.method !== 'POST') throw new AccessError(405, '只支持 POST')
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw new AccessError(415, '需要 JSON 请求')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > limit * 4 + 2048) throw new AccessError(413, '请求过长')
    chunks.push(bytes)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new AccessError(400, '无效 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError(400, '无效请求')
  return value as Record<string, unknown>
}
function onlyGet(request: IncomingMessage): void { if (request.method !== 'GET') throw new AccessError(405, '只支持 GET') }

export async function apply(ctx: Context, config: Config): Promise<void> {
  const access = createAccess(ctx, { pluginId: 'pirate', mode: config.accessMode, publicOrigin: config.publicOrigin })
  const http = createPluginHttp(ctx, { access, routePrefix: config.routePrefix })
  const workspace = dshHomePath('plugins', 'pirate')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const store = new MissionStore(config.historyPath || resolve(workspace, 'history.sqlite'))
  const coordinator = new PirateCoordinator(ctx, access, store, config, workspace)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  ctx.effect(() => registerPlugin(ctx, {
    id: 'pirate', packageName: manifest.name, version: manifest.version, displayName: '黑珍珠号指挥台',
    description: manifest.description, entryPath: config.routePrefix, permissions: ['pirate:access'], tools: coordinator.tools,
  }))
  const route = (path: string, handler: Parameters<typeof http.register>[0]['handler']) => {
    ctx.effect(() => http.register({ kind: 'exact', path: config.routePrefix + path, handler }))
  }
  ctx.effect(() => http.registerPublic({ kind: 'exact', path: config.routePrefix + '/ready', handler: (_req, res) => {
    try { access.ready(); json(res, { ok: true }) } catch { json(res, { ok: false }, 503) }
  } }))
  route('/crew', (req, res, actor) => { onlyGet(req); json(res, { crew: coordinator.crew(actor), maxMessageChars: config.maxMessageChars }) })
  route('/models', async (req, res, actor) => {
    onlyGet(req)
    const value = new URL(req.url ?? '/', 'http://localhost').searchParams.get('missionId')
    const id = value === null ? undefined : missionId(value)
    if (id) coordinator.assertRead(actor, id)
    try {
      const catalog = await conversationModelCatalog(ctx)
      const mission = id ? store.get(actor, id) : undefined
      const selected = mission?.sessionReady ? await conversationModel(ctx, mission.sessionId) : null
      access.assert(actor)
      if (id) coordinator.assertRead(actor, id)
      json(res, { ...catalog, default: catalog.selected, selected })
    } catch (error) {
      access.assert(actor)
      if (id) coordinator.assertRead(actor, id)
      if (isAccessError(error)) throw error
      throw new AccessError(503, '模型目录或会话模型暂时无法读取，请稍后重试')
    }
  })
  route('/missions', (req, res, actor) => {
    onlyGet(req)
    const offset = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('offset') ?? 0)
    const missions = store.list(actor, offset).map(publicMission)
    json(res, { missions, nextOffset: missions.length === 30 ? offset + 30 : null })
  })
  route('/mission', (req, res, actor) => {
    onlyGet(req)
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams
    const id = missionId(query.get('id'))
    coordinator.assertRead(actor, id)
    const events = store.events(actor, id, Number(query.get('after') ?? 0))
    json(res, { mission: publicMission(store.get(actor, id)), events, crewSessions: store.crew(actor, id) })
  })
  route('/message', async (req, res, actor) => {
    const input = await body(req, config.maxMessageChars)
    if (Object.keys(input).some(key => !['missionId', 'target', 'message', 'requestId', 'modelSelection'].includes(key))) throw new AccessError(400, '请求包含不支持的字段')
    const selection = input.modelSelection
    if (selection !== undefined && selection !== null && (typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).some(key => !['provider', 'model'].includes(key))
      || !('provider' in selection) || typeof selection.provider !== 'string' || !selection.provider || selection.provider.length > 200
      || !('model' in selection) || typeof selection.model !== 'string' || !selection.model || selection.model.length > 200)) throw new AccessError(400, '请选择有效模型')
    if (typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)) throw new AccessError(400, '请求标识无效')
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > config.maxMessageChars) throw new AccessError(400, '请输入有效指令')
    const target = input.target ?? 'jack'
    if (target !== 'jack' && target !== 'blog' && target !== 'closedoff') throw new AccessError(400, '交谈对象无效')
    access.assert(actor)
    const mission = await coordinator.start(actor, input.message.trim(), input.missionId === undefined ? undefined : missionId(input.missionId), target, input.requestId,
      selection as ConversationModel | null | undefined)
    json(res, { mission: publicMission(mission) }, 202)
  })
  route('/stop', async (req, res, actor) => {
    const input = await body(req, 512)
    if (Object.keys(input).some(key => key !== 'missionId')) throw new AccessError(400, '停止请求包含不支持的字段')
    access.assert(actor)
    json(res, { mission: publicMission(coordinator.stop(actor, missionId(input.missionId))) })
  })

  const webRoot = fileURLToPath(new URL('../web/dist/', import.meta.url))
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    onlyGet(req)
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== config.routePrefix && !path.startsWith(config.routePrefix + '/')) throw new AccessError(404, '资源不存在')
    let suffix: string
    try { suffix = decodeURIComponent(path.slice(config.routePrefix.length)).replace(/^\//, '') } catch { throw new AccessError(400, '资源路径无效') }
    const file = resolve(webRoot, suffix || 'index.html')
    if (!file.startsWith(resolve(webRoot) + sep) || /[\\\0]/.test(suffix)) throw new AccessError(404, '资源不存在')
    let content: Buffer
    try { content = await readFile(file) } catch { throw new AccessError(404, '资源尚未构建或不存在') }
    if (extname(file) === '.html') content = Buffer.from(content.toString('utf8').replaceAll('__BASE__', config.routePrefix))
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
    if (!mime[extname(file)]) throw new AccessError(404, '资源不存在')
    res.writeHead(200, { 'content-type': mime[extname(file)]!, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' })
    res.end(content)
  }
  ctx.effect(() => http.register({ kind: 'exact', path: config.routePrefix, surface: 'page', handler: serve }))
  ctx.effect(() => http.register({ kind: 'prefix', path: config.routePrefix, surface: 'asset', handler: serve }))
}
