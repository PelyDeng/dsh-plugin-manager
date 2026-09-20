/**
 * 视觉模型：判断当前对话模型能不能读图，以及在不能读图时用哪条路由把图读成文字。
 *
 * ## 两件事，别混
 *
 * 1. **当前对话模型支持图片** → 图片作为消息的一部分直接发过去（`butler.ts` 里的内容块）。
 *    这是最省事也最准的路，**不该**先读成文字再发——读一遍等于让模型看二手转述。
 * 2. **当前对话模型不支持图片**，但用户还是把图发过来了 → 用这里解析出的**视觉路由**读一次，
 *    把结果当文字用（进管家提示词、进派单简报）。
 *
 * ## 路由怎么定
 *
 * 先看配置：`visionModel` 写成 `provider/model`。没配就**自动挑**——在官方模型目录里找第一个
 * 声明了 `inputModalities` 含 `image` 的模型。挑不到就是挑不到：调用方据此如实告诉用户"这个
 * 部署读不了图"，而不是把图当成没内容。
 *
 * 自动挑的结果缓存十分钟：模型目录在运行期基本不变，而每次上传都去逐个 `resolveModelInfo`
 * 是几十次调用。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// 从包根导入而不是 `…/image` 子路径：子路径导出是给别的消费者按需引用的，而这里要的是
// **类型**——tsdown 的声明文件步骤跟不进 workspace 包的子路径（会把整个 dts 构建打挂）。
import type { VisionCall } from '@dsh-agents-group/document-parse'

/** 一个模型路由。 */
export interface VisionRoute {
  readonly provider: string
  readonly model: string
}

/** 宿主 `llm` 服务在本模块里用到的面。 */
export interface VisionLlm {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }>
  stream(options: {
    provider: string
    model: string
    messages: readonly unknown[]
    signal?: AbortSignal | undefined
  }): AsyncIterable<{ type?: string; text?: string }>
}

/**
 * 本模块用到的上下文面。
 *
 * 只声明 `get`：这一层只查服务，不注册任何东西。`Context` 与测试替身都满足它。
 */
export interface VisionContext {
  get(name: string): unknown
}

/** 自动挑路由的结果缓存多久。 */
const AUTO_PICK_TTL_MS = 10 * 60 * 1000
const autoPicked = new Map<string, { readonly route: VisionRoute | undefined, readonly at: number }>()

/** 取出宿主 `llm` 服务；没有就抛（宿主版本不对或服务未装载）。 */
export function llmOf(ctx: VisionContext): VisionLlm {
  const llm = ctx.get('llm') as VisionLlm | undefined
  if (llm === undefined || typeof llm.stream !== 'function' || typeof llm.resolveModelInfo !== 'function') {
    throw new Error('宿主没有提供模型服务（llm），无法读图')
  }
  return llm
}

/**
 * 这个模型能不能收图片。
 *
 * **没声明模态的按"不能"处理**：宁可多走一次读图调用，也不要把图片塞给一个会当场拒它的模型
 * ——那会让整轮对话失败，而失败原因离用户很远。
 */
export async function modelTakesImages(ctx: VisionContext, provider: string, model: string): Promise<boolean> {
  try {
    const info = await llmOf(ctx).resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') === true
  } catch {
    // 路由解析不了（模型被下线、provider 临时不可用）时按"不能读图"处理，让上层走读图那条路；
    // 读图那条路自己会再核验一次，两次都失败就如实报"读不了"。
    return false
  }
}

/** 解析 `provider/model` 形式的配置；不合法返回 undefined。 */
export function parseVisionRoute(configured: string): VisionRoute | undefined {
  const text = configured.trim()
  if (text === '') return undefined
  for (const separator of ['/', ':']) {
    const at = text.indexOf(separator)
    if (at <= 0 || at === text.length - 1) continue
    return { provider: text.slice(0, at), model: text.slice(at + 1) }
  }
  return undefined
}

/**
 * 自动挑一条支持图片的路由。
 *
 * 遍历官方目录（`conversationModelCatalog`）逐个问模态。目录本身来自宿主，插件不自己维护一份
 * 模型清单——那样两边一定会漂移。
 */
async function autoPickVisionRoute(ctx: VisionContext): Promise<VisionRoute | undefined> {
  const controller = ctx.get('sessionController') as { modelCatalog?: () => Promise<unknown> } | undefined
  if (controller?.modelCatalog === undefined) return undefined
  let catalog: unknown
  try {
    catalog = await controller.modelCatalog()
  } catch {
    return undefined
  }
  const groups = (catalog as { groups?: unknown })?.groups
  if (!Array.isArray(groups)) return undefined
  const llm = llmOf(ctx)
  for (const group of groups) {
    const id = (group as { id?: unknown }).id
    const models = (group as { models?: unknown }).models
    if (typeof id !== 'string' || !Array.isArray(models)) continue
    for (const entry of models) {
      const model = (entry as { id?: unknown }).id
      if (typeof model !== 'string') continue
      try {
        const info = await llm.resolveModelInfo(id, model)
        if (info.inputModalities?.includes('image') === true) return { provider: id, model }
      } catch {
        // 单条模型解析不了就跳过，不影响继续找下一条。
      }
    }
  }
  return undefined
}

/**
 * 定下读图用哪条路由。
 *
 * @param configured `provider/model`（部署配置）。空串表示自动挑。
 * @returns 挑不到时返回 undefined——调用方据此如实说明"这个部署读不了图"。
 */
export async function resolveVisionRoute(ctx: VisionContext, configured: string): Promise<VisionRoute | undefined> {
  const explicit = parseVisionRoute(configured)
  if (explicit !== undefined) return explicit
  const cached = autoPicked.get('auto')
  if (cached !== undefined && Date.now() - cached.at < AUTO_PICK_TTL_MS) return cached.route
  const route = await autoPickVisionRoute(ctx)
  autoPicked.set('auto', { route, at: Date.now() })
  return route
}

/** 清掉自动挑的缓存（测试用；运行期不需要）。 */
export function resetVisionRouteCache(): void {
  autoPicked.clear()
}

/**
 * 用**已经存好的图片引用**造一个读图调用。
 *
 * 入参里的 `bytes` / `mediaType` 这里不用：图片在上传时已经存进宿主附件服务了，而模型层只认
 * 那份引用（`ImageAttachmentRef`）——重存一遍等于把解码与规范化再做一次，白花 CPU。保留这两个
 * 参数是为了满足 `VisionCall` 的形状：那是解析包那边的接口，包不知道宿主有附件服务。
 *
 * 返回的文字由解析包负责裁剪与判空，这里只管把模型的话接完。
 */
export function visionCallFor(ctx: VisionContext, route: VisionRoute, ref: ImageAttachmentRef): VisionCall {
  return async ({ prompt, signal }) => {
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }, { type: 'image', attachment: ref }],
      source: { kind: 'user' },
    })
    let text = ''
    for await (const chunk of llmOf(ctx).stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    return text
  }
}
