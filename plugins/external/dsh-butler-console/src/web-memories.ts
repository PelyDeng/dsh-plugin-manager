/**
 * 记忆治理的 HTTP API（v2.6 设计 §4.6/§6.2 步骤 5）。
 *
 * 端点（全部经 `register` 的鉴权包装，owner 取自鉴权 actor——不接受请求体传入，§4.4 红线）：
 * - GET  /memories/summary            右栏轻摘要：计数拆口径（记忆/要求分列）+ 最近 3 条（只取记忆库）
 * - GET  /memories                    治理列表（agentId/kind 过滤维度；owner 等值强制）
 * - POST /memories                    手动新增（source=manual，origin 默认 user_statement）
 * - PUT  /memories                    编辑（id + patch；跨 agent 行=用户终裁豁免）
 * - DELETE /memories                  删除（id 列表；批量逐行插审计）
 * - POST /memories/purge              一键清空本 agent 记忆库（两步确认在前端；不含 instruction）
 * - POST /memories/forget/confirm     工具发起的删除确认卡落点（消费 pendingForgets，TTL 10 分钟）
 * - GET  /memories/export             导出两区 JSON（内存流式、no-store、不落服务器文件）
 * - GET  /memories/procedural         产品资产只读展示（agent 白名单等值；无 owner 维度及其理由见 §4.6）
 *
 * 红线分层（§4.3）：治理查询 owner 等值 + agent_id 过滤维度；`procedural` 是唯一无 owner
 * 维度的读端点（产品资产全局同构、不含用户数据），agent 参数走固定白名单防路径拼接。
 */

import { readFileSync } from 'node:fs'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import { MEMORY_CONTENT_LIMIT } from './memories.ts'
import { confirmForget, type MemoryToolsDeps } from './butler/memories-tool.ts'
import type { MemoryKind, MemoryRecord } from './memories.ts'

/** 产品资产展示的 agent 白名单（P1.5 增成员时显式扩，禁止动态拼接路径）。 */
const PROCEDURAL_AGENT_WHITELIST = new Set(['butler'])

/** persona 六段（等价期后目标形状）的中文导览标题（§4.6 定案：标题导览视角、内容原文第二人称）。 */
const PROCEDURAL_TITLES: Record<string, string> = {
  identity: '它是谁',
  duties: '管什么、不管什么',
  dispatch: '怎么派活',
  acceptance: '怎么算干完',
  fidelity: '忠实铁律',
  tools: '工具边界',
}

interface MemoryHttpDeps {
  readonly memories: import('./memories.ts').MemoryStore
  readonly routePrefix: string
  readonly maxRequestBodyBytes: number
  readonly register: (route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: IncomingMessage, response: ServerResponse, actor: Actor) => void | Promise<void>
  }) => void
  readonly method: (request: IncomingMessage, expected: string) => void
  readonly body: (request: IncomingMessage, limit: number) => Promise<Record<string, unknown>>
  readonly stringField: (input: Record<string, unknown>, name: string, max: number, required?: boolean) => string
  readonly json: (response: ServerResponse, status: number, value: unknown) => void
  readonly pendingForgets: NonNullable<MemoryToolsDeps['pendingForgets']>
}

/** 记录 → JSON（时间毫秒原样；expiresAt null 归一）。 */
function memoryJson(record: MemoryRecord) {
  return {
    id: record.id,
    agentId: record.agentId,
    shortId: record.shortId,
    kind: record.kind,
    content: record.content,
    origin: record.origin,
    importance: record.importance,
    source: record.source,
    sourceRef: record.sourceRef,
    expiresAt: record.expiresAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function registerMemoryRoutes(deps: MemoryHttpDeps): void {
  const { memories, register, routePrefix } = deps
  const base = `${routePrefix}/memories`

  // 右栏轻摘要：计数拆口径 + 最近 3 条（只取记忆库）。
  register({
    kind: 'exact',
    path: `${base}/summary`,
    handler: async (request, response, actor) => {
      deps.method(request, 'GET')
      const all = await memories.list(actor)
      const library = all.filter(item => item.kind !== 'instruction')
      const instructions = all.filter(item => item.kind === 'instruction')
      const recent = [...library]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3)
        .map(memoryJson)
      deps.json(response, 200, {
        memoryCount: library.length,
        instructionCount: instructions.length,
        recent,
      })
    },
  })

  // `/memories` 同一路径四个方法（宿主 exact 路由不区分 method，必须合并注册）：
  //   GET    治理列表（owner 等值强制；agentId/kind 是过滤维度）
  //   POST   手动新增（source=manual；origin 默认 user_statement）
  //   PUT    编辑（id + patch；跨 agent=用户终裁豁免）
  //   DELETE 删除（id 数组；批量逐行审计）
  register({
    kind: 'exact',
    path: base,
    handler: async (request, response, actor) => {
      const method = request.method ?? 'GET'

      if (method === 'GET') {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const agentId = url.searchParams.get('agentId') ?? undefined
        const kind = url.searchParams.get('kind') ?? undefined
        if (kind !== undefined && kind !== '' && !['semantic', 'episodic', 'instruction'].includes(kind)) {
          throw new Error(`未知的 kind：${kind}`)
        }
        const items = await memories.list(actor, {
          agentId: agentId ?? undefined,
          kind: (kind === '' ? undefined : kind) as MemoryKind | undefined,
        })
        deps.json(response, 200, { items: items.map(memoryJson) })
        return
      }

      if (method === 'POST') {
        // 手动新增（source=manual；origin 默认 user_statement）。
        const payload = await deps.body(request, deps.maxRequestBodyBytes)
        const kind = deps.stringField(payload, 'kind', 20)
        if (kind !== 'semantic' && kind !== 'episodic' && kind !== 'instruction') {
          throw new Error(`未知的 kind：${kind}`)
        }
        const content = deps.stringField(payload, 'content', 200)
        const origin = deps.stringField(payload, 'origin', 20, false) || 'user_statement'
        if (origin !== 'user_statement' && origin !== 'reference') throw new Error('origin 只能是 user_statement 或 reference')
        const importanceRaw = Number.parseInt(deps.stringField(payload, 'importance', 2, false), 10)
        const importance = Number.isSafeInteger(importanceRaw) && importanceRaw >= 1 && importanceRaw <= 5 ? importanceRaw : undefined
        const record = await memories.write(actor, {
          kind: kind as MemoryKind,
          content,
          origin: origin as 'user_statement' | 'reference',
          importance,
          sourceRef: deps.stringField(payload, 'sourceRef', 200, false),
          source: 'manual',
        })
        deps.json(response, record === undefined ? 409 : 200, record === undefined
          ? { error: '同样的内容已经存在', code: 'memory_duplicate' }
          : { item: memoryJson(record) })
        return
      }

      if (method === 'PUT') {
        // 编辑（id + patch；跨 agent=用户终裁豁免）。
        const payload = await deps.body(request, deps.maxRequestBodyBytes)
        const id = deps.stringField(payload, 'id', 60)
        const content = deps.stringField(payload, 'content', MEMORY_CONTENT_LIMIT * 4, false)
        const importanceRaw = Number.parseInt(deps.stringField(payload, 'importance', 2, false), 10)
        const expiresAtRaw = payload['expiresAt']
        const record = await memories.update(
          actor,
          id,
          {
            content: content === '' ? undefined : content,
            importance: Number.isSafeInteger(importanceRaw) && importanceRaw >= 1 && importanceRaw <= 5 ? importanceRaw : undefined,
            expiresAt: typeof expiresAtRaw === 'number' ? expiresAtRaw : expiresAtRaw === null ? null : undefined,
          },
          deps.stringField(payload, 'agentId', 60, false) || undefined,
        )
        if (record === undefined) throw new Error('没有这条记忆')
        deps.json(response, 200, { item: memoryJson(record) })
        return
      }

      if (method === 'DELETE') {
        // 删除（id 数组；批量逐行审计）。
        const payload = await deps.body(request, deps.maxRequestBodyBytes)
        const idsRaw = payload['ids']
        if (!Array.isArray(idsRaw) || idsRaw.length === 0) throw new Error('ids 必须是非空数组')
        const ids = idsRaw.map(value => String(value))
        const agentId = deps.stringField(payload, 'agentId', 60, false) || undefined
        const deleted = await memories.delete(actor, ids, agentId)
        deps.json(response, 200, { deleted })
        return
      }

      throw new Error(`只支持 GET/POST/PUT/DELETE（当前 ${method}）`)
    },
  })

  // 工具删除确认卡的落点：消费 pendingForgets（TTL 内、鉴权 actor 下）真删+审计。
  register({
    kind: 'exact',
    path: `${base}/forget/confirm`,
    handler: async (request, response, actor) => {
      deps.method(request, 'POST')
      const payload = await deps.body(request, deps.maxRequestBodyBytes)
      const memoryId = deps.stringField(payload, 'memoryId', 60)
      const result = await confirmForget({
        store: memories,
        actor: () => actor,
        sessionId: deps.stringField(payload, 'sessionId', 120),
        pendingForgets: deps.pendingForgets,
        memoryId,
      })
      deps.json(response, result.deleted ? 200 : 409, result)
    },
  })

  // 一键清空本 agent 记忆库（不含 instruction——前端两步确认文案已明示）。
  register({
    kind: 'exact',
    path: `${base}/purge`,
    handler: async (request, response, actor) => {
      deps.method(request, 'POST')
      const deleted = await memories.purge(actor)
      deps.json(response, 200, { deleted })
    },
  })

  // 导出两区 JSON（内存流式、no-store、不落服务器文件）。
  register({
    kind: 'exact',
    path: `${base}/export`,
    handler: async (request, response, actor) => {
      deps.method(request, 'GET')
      const all = await memories.list(actor)
      const payload = {
        exportedAt: new Date().toISOString(),
        instructions: all.filter(item => item.kind === 'instruction').map(memoryJson),
        memories: all.filter(item => item.kind !== 'instruction').map(memoryJson),
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="memories-export.json"',
      })
      response.end(JSON.stringify(payload, null, 2))
    },
  })

  // 产品资产只读展示：agent 白名单等值（防 ?agent=../ 路径拼接），sections 由已知 key 清单构造。
  // 无 owner 维度——产品资产全局同构、不含用户数据（与记忆类 API 的 owner 范式显式区分）。
  register({
    kind: 'exact',
    path: `${base}/procedural`,
    handler: async (request, response, actor) => {
      deps.method(request, 'GET')
      void actor
      const url = new URL(request.url ?? '/', 'http://localhost')
      const agent = url.searchParams.get('agent') ?? 'butler'
      if (!PROCEDURAL_AGENT_WHITELIST.has(agent)) {
        throw new Error(`没有这个智能体的产品资产：${agent}`)
      }
      const sections = Object.entries(PROCEDURAL_TITLES).map(([key, title], index) => ({
        key,
        title,
        order: index + 1,
        content: readFileSync(new URL(`../persona/${sectionFile(key)}.md`, import.meta.url), 'utf8'),
      }))
      deps.json(response, 200, { agentId: agent, sections })
    },
  })
}

/** 六段 → 六文件名（等价期已收口合并；key 与 §4.6 展示契约一致）。 */
function sectionFile(key: string): string {
  switch (key) {
    case 'identity': return 'identity'
    case 'duties': return 'duties'
    case 'dispatch': return 'dispatch'
    case 'acceptance': return 'acceptance'
    case 'fidelity': return 'fidelity'
    case 'tools': return 'tools'
    default: throw new Error(`未知的 persona 段：${key}`)
  }
}
