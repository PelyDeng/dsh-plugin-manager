/**
 * 素材工具：翻看历史生成、登记用户上传。
 *
 * ## 为什么要有"翻历史"
 *
 * 生图**真的花钱**。用户经常说"上次那张再给我来张差不多的""把之前做的封面找出来"——
 * 能翻出来就别重画。这条不是锦上添花：没有它，模型在"再要一张"的场景下只能重新生成，
 * 而用户要的可能就是原来那张。
 *
 * ## 登记上传为什么不是"再传一次"
 *
 * 用户上传的图已经在宿主附件存储里了（那是输入侧的正常路径）。`huiyu_upload` 做的事是把它
 * **登记进业务记录**，这样它能出现在素材列表里、能被后续复用。它**不复制图片**——复制一份到
 * 公开的 MinIO 桶会把用户的私有素材变成公开可访问，那是数据泄露。
 */

import { randomUUID } from 'node:crypto'
import type { HuiyuToolContext, HuiyuTool } from './context.ts'
import { invalid, optionalString, requiredString } from './context.ts'
import { attachmentsOf, readImageBytes } from '../media/attachments.ts'
import { HuiyuError } from '../errors.ts'

/** 列表默认返回条数。太多了会把上下文撑满，而模型只需要看个大概。 */
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/** 读条数参数。 */
function limitOf(args: Record<string, unknown>): number {
  const value = args.limit
  if (value === undefined || value === null) return DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid('参数 limit 必须是整数')
  if (value < 1 || value > MAX_LIMIT) throw invalid(`参数 limit 必须在 1 到 ${MAX_LIMIT} 之间`)
  return value
}

/**
 * 造两个素材工具。
 *
 * @param context 装配上下文
 */
export function createMaterialTools(context: HuiyuToolContext): readonly HuiyuTool[] {
  const library: HuiyuTool = {
    spec: {
      name: 'huiyu_library',
      displayName: '查找历史图片',
      description: '翻看此前生成过的图片记录。用户说“上次那张”“之前做的封面”“再要一张差不多的”时，先用它找出来，'
        + '不要直接重新生成——重新生成要花钱，而且结果多半不一样。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: `返回条数，1 到 ${MAX_LIMIT}，缺省 ${DEFAULT_LIMIT}。按时间倒序。` },
          keyword: { type: 'string', description: '按提示词里的关键词筛选，例如“封面”“猫咪”。留空则返回全部最近记录。' },
        },
      },
    },
    run: async (args, execution) => {
      const store = context.store
      if (store === undefined) {
        throw new HuiyuError('unconfigured', '素材库未配置：缺少 PostgreSQL 存储配置（AGENTS_GROUP_PG_DSN）')
      }
      const limit = limitOf(args)
      const keyword = optionalString(args, 'keyword', 200)
      // 归属按会话派生（与记账同一口径），空会话归到占位分组。
      const owner = execution.sessionId === '' ? 'unknown' : execution.sessionId
      const rows = await store.list(`huiyu:${owner}`, MAX_LIMIT)
      const filtered = keyword === undefined
        ? rows
        : rows.filter(row => row.payload.prompt.includes(keyword) || row.payload.url.includes(keyword))
      if (filtered.length === 0) {
        return [{ type: 'text', text: keyword === undefined ? '素材库里还没有生成过的图片。' : `没有找到与“${keyword}”相关的图片。` }]
      }
      const lines = filtered.slice(0, limit).map((row, index) => {
        const at = new Date(row.createdAt).toISOString().replace('T', ' ').slice(0, 16)
        const dims = row.payload.width === undefined ? '' : `${row.payload.width}×${row.payload.height} `
        return `${index + 1}. ${at}　${dims}${row.payload.url}\n   提示词：${row.payload.prompt.slice(0, 120)}`
      })
      return [{
        type: 'text',
        text: `找到 ${filtered.length} 条${keyword === undefined ? '' : `与“${keyword}”相关的`}记录：\n${lines.join('\n')}`,
      }]
    },
  }

  const upload: HuiyuTool = {
    spec: {
      name: 'huiyu_upload',
      displayName: '登记图片到素材库',
      description: '把用户上传的图片登记进素材库，便于以后查找与复用。用户说“把这张图存起来”“这张以后还要用”时用它。'
        + '需要看图内容时用 huiyu_describe，不需要登记。',
      parameters: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: '要登记的图片附件标识。' },
          note: { type: 'string', description: '备注，例如用途或来源。会跟着记录保存，便于以后检索。' },
        },
        required: ['attachmentId'],
      },
    },
    run: async (args, execution) => {
      const store = context.store
      if (store === undefined) {
        throw new HuiyuError('unconfigured', '素材库未配置：缺少 PostgreSQL 存储配置（AGENTS_GROUP_PG_DSN）')
      }
      const attachmentId = requiredString(args, 'attachmentId', 200)
      const note = optionalString(args, 'note', 500)
      const service = attachmentsOf(context.ctx)
      // 先读一次确认这张图真的存在且可读：登记一条指向不存在附件的记录，比拒绝登记更糟。
      const { ref } = await readImageBytes(service, attachmentId, execution.signal)
      const owner = execution.sessionId === '' ? 'unknown' : execution.sessionId
      const recordedAt = Date.now()
      await store.record({
        id: randomUUID(),
        ownerNamespace: 'huiyu',
        ownerId: owner,
        createdAt: recordedAt,
        payload: {
          // 上传图**没有** MinIO 直链：它的访问要走带鉴权的读图路由（见 `media/attachments.ts`）。
          url: `/agents/huiyu/images/${ref.attachmentId}`,
          sessionId: execution.sessionId,
          prompt: note ?? '用户上传的图片',
          provider: 'upload',
          model: 'n/a',
          size: `${ref.width}x${ref.height}`,
          mediaType: ref.mediaType,
          width: ref.width,
          height: ref.height,
          bucket: '',
          objectKey: ref.attachmentId,
          tool: 'huiyu_upload',
        },
      })
      return [{
        type: 'text',
        text: `已登记到素材库：${ref.width}×${ref.height}，${Math.round(ref.bytes / 1024)} KB${note === undefined ? '' : `（${note}）`}。以后可以用 huiyu_library 找到它。`,
      }]
    },
  }

  return [library, upload]
}
