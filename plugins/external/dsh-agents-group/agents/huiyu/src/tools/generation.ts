/**
 * 生图工具：通用绘图、文章头图、段落配图。
 *
 * ## 后两个为什么单独开
 *
 * 用 `huiyu_draw` 其实都能实现，但工具的**召回靠描述文案**。只有 `huiyu_draw` 时，模型在
 * "这篇文章需要个头图"这个场景下得自己推理出"头图 = 横幅图 + 一段提示词"，中间容易走偏：
 * 尺寸不对、风格不搭、提示词写得太敷衍。而 `huiyu_cover` 的说明直接写"用户需要文章头图或
 * 封面图时用它"，召回率立刻上去。
 *
 * 代价是工具变多、模型选择变难。所以规矩是：**只有参数组合固定、场景明确时才开专用工具**，
 * 否则一律用通用工具加参数。
 *
 * ## 出图后的四步，顺序不能换
 *
 * 1. 调 provider 拿到字节（可能是 base64，也可能是临时 URL——那是 provider 的事）；
 * 2. 上传 MinIO，拿到**完整访问地址**；
 * 3. **立刻丢弃字节**，只留地址进对话——base64 留在上下文里会被反复读、反复计费；
 * 4. 写一条业务记录（地址、会话、提示词、模型）。
 *
 * 第 3 步是灵魂。第 4 步失败**不让整次生成失败**：图已经生出来了，因为记账失败而报错，
 * 用户会以为白花了钱。
 */

import { randomUUID } from 'node:crypto'
import { bannerSize, deliveredSize, resolveSize, sizeNames } from '../media/size.ts'
import type { HuiyuToolContext, HuiyuTool, ToolExecution } from './context.ts'
import { invalid, optionalString, ownerFor, requiredString, requiredStringArray } from './context.ts'
import { ImageGenerationError } from '../image/spec.ts'
import { HuiyuError } from '../errors.ts'
import { attachmentsOf, saveGeneratedImage } from '../media/attachments.ts'
import { ownerOf } from '../store.ts'

/** 一次生图的产物，供上层组装结果与记账。 */
interface GeneratedArtifact {
  readonly url: string
  readonly objectKey: string
  /** 响应用户/模型时说的尺寸——**从交付字节里读出来的**，不是请求值。 */
  readonly width?: number
  readonly height?: number
  /** 请求的尺寸（`宽x高`）。渠道可能不按它出图，所以要留着说清"我请求了什么"。 */
  readonly requestedSize: string
  readonly mediaType: string
  readonly data: Uint8Array
}

/** 单次提示词长度上限。上限不是洁癖：超长提示词会被上游拒绝，而报错指向"请求过大"，与真实原因差很远。 */
const MAX_PROMPT = 4000
/** 一次生成的张数上限。生图**真的花钱**，上限让模型在一次调用里就撞到边界。 */
const MAX_BATCH = 4

/**
 * 生成并落盘。
 *
 * @returns 每张图的地址与对象键
 * @throws {HuiyuError} 对象存储未配置时按 `unconfigured`——缺配置要明确拒绝，不静默降级
 */
async function generate(
  context: HuiyuToolContext,
  prompt: string,
  size: string,
  count: number,
  execution: ToolExecution,
  tool: string,
): Promise<readonly GeneratedArtifact[]> {
  const minio = context.minio
  if (minio === undefined) {
    throw new HuiyuError('unconfigured', '图片生成未配置：缺少 MinIO 对象存储配置（HUIYU_MINIO_* ）')
  }
  let result
  try {
    result = await context.imageProvider.generate({
      prompt,
      size,
      quality: 'high',
      count,
      signal: execution.signal,
    })
  } catch (error: unknown) {
    // provider 已经把失败分好类了，这里只做一次平移到本子包的错误词汇。
    if (error instanceof ImageGenerationError) {
      throw new HuiyuError(error.failure === 'unsupported' ? 'unsupported' : error.failure, error.message, { cause: error })
    }
    throw error
  }

  const artifacts: GeneratedArtifact[] = []
  for (const image of result.images) {
    const key = objectKeyOf(image.mediaType)
    const stored = await minio.put({ key, data: image.data, contentType: image.mediaType }, execution.signal)
    /**
     * 尺寸**从交付的字节里读**，不用请求值。
     *
     * 2026-09-18 实测：本渠道不按 `size` 出图（请求 1536x864 的封面落地成 2048x768，
     * 另一次同样请求回来 1536x1024）。拿请求值当结果汇报，等于告诉用户"这是 16:9 的头图"，
     * 而拿到的可能是 8:3——**文件本身不会说话，文案会**。
     */
    const delivered = deliveredSize(image.data)
    const dims = delivered === undefined ? {} : { width: delivered.width, height: delivered.height }
    artifacts.push({
      url: stored.url,
      objectKey: stored.key,
      mediaType: image.mediaType,
      data: image.data,
      requestedSize: size,
      ...dims,
    })
    // 记账失败不影响已经拿到的地址（见文件头第 4 点）。
    await record(context, {
      tool, prompt, url: stored.url, objectKey: stored.key, bucket: context.environment.minio.bucket,
      model: result.model, provider: context.imageProvider.kind, size, mediaType: image.mediaType,
      sessionId: execution.sessionId,
      ...dims,
      // 只在"渠道没按请求出图"时留一行证据，方便以后按它统计渠道行为。
      ...(delivered !== undefined && `${delivered.width}x${delivered.height}` !== size
        ? { deliveredSize: `${delivered.width}x${delivered.height}` }
        : {}),
    }, execution.signal)
  }
  return artifacts
}

/**
 * 对象键：`<YYYY>/<MM>/<DD>/<uuid>.<ext>`。
 *
 * 沿用博客桶已验证的按天分目录约定（便于以后按时间清理或归档）。文件名用 uuid 而不是提示词
 * 摘要：提示词可能含中文、超长、含特殊字符，做成对象键要额外转义且容易踩坑。
 */
function objectKeyOf(mediaType: string): string {
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
  return `${yyyy}/${mm}/${dd}/${randomUUID()}.${ext}`
}

/** 写一条业务记录。存储未配置或写入失败时只记日志，不让整次生成失败。 */
async function record(
  context: HuiyuToolContext,
  payload: Parameters<typeof toRecordPayload>[0],
  signal: AbortSignal,
): Promise<void> {
  const store = context.store
  if (store === undefined) return
  try {
    signal.throwIfAborted()
    // 归属与查询共用 `ownerFor` 一份规则（见那里的说明）；两边漂移会让刚生成的图在
    // `huiyu_library` 里查不到。
    const { namespace, id } = ownerOf(await ownerFor(context, payload.sessionId))
    await store.record({
      id: randomUUID(),
      ownerNamespace: namespace,
      ownerId: id,
      createdAt: Date.now(),
      payload: toRecordPayload(payload),
    })
  } catch (error: unknown) {
    console.warn('agents-group/huiyu: 生成记录写入失败（图片本身已可用）', error)
  }
}

/** 组装记录的载荷。单独一处，避免调用点各自拼字段。 */
function toRecordPayload(input: {
  readonly tool: string
  readonly prompt: string
  readonly url: string
  readonly objectKey: string
  readonly bucket: string
  readonly model: string
  readonly provider: string
  readonly size: string
  readonly mediaType: string
  readonly sessionId: string
  readonly messageId?: string
  readonly deliveredSize?: string
  readonly width?: number
  readonly height?: number
}): import('../store.ts').ImageRecordPayload {
  return {
    url: input.url,
    sessionId: input.sessionId,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    size: input.size,
    mediaType: input.mediaType,
    ...(input.deliveredSize === undefined ? {} : { deliveredSize: input.deliveredSize }),
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
    bucket: input.bucket,
    objectKey: input.objectKey,
    tool: input.tool,
  }
}

/**
 * 尺寸那一小段文案。
 *
 * 三种情形分开写，因为它们的含义不同：
 *
 * - 读得出尺寸且与请求一致 → 只说尺寸；
 * - 读得出尺寸但与请求不一致 → 说清"交付的是这个、我请求的是那个"——
 *   本渠道实测会这样（见 `media/size.ts` 的文件头），瞒着会让用户按错误的比例去排版；
 * - 读不出尺寸（容器认不出）→ **什么都不说**，绝不用请求值冒充结果。
 */
function describeSize(artifact: GeneratedArtifact): string {
  if (artifact.width === undefined || artifact.height === undefined) return ''
  const delivered = `${artifact.width}×${artifact.height}`
  const requested = artifact.requestedSize.replace('x', '×')
  return delivered === requested ? `（${delivered}）` : `（${delivered}；渠道未按请求的 ${requested} 出图）`
}

/**
 * 把生成结果收成工具结果：文字给地址，图片块让模型也能看到。
 *
 * 附件存储写失败时降级成"只有地址"：地址已经可用，用户能打开，不该因为模型看不到图而报错。
 */
async function present(
  context: HuiyuToolContext,
  artifacts: readonly GeneratedArtifact[],
  lead: string,
): Promise<readonly unknown[]> {
  const lines = artifacts.map((artifact, index) => {
    const dims = describeSize(artifact)
    return artifacts.length === 1
      ? `${lead}：${artifact.url}${dims}`
      : `${index + 1}. ${artifact.url}${dims}`
  })
  const content: unknown[] = [{ type: 'text', text: lines.join('\n') }]
  const service = ((): ReturnType<typeof attachmentsOf> | undefined => {
    try {
      return attachmentsOf(context.ctx)
    } catch {
      return undefined
    }
  })()
  if (service !== undefined) {
    for (const artifact of artifacts) {
      try {
        const ref = await saveGeneratedImage(service, artifact.data, artifact.mediaType, `huiyu-${artifact.objectKey.split('/').pop() ?? 'image'}`)
        content.push({ type: 'image', attachment: ref })
      } catch {
        // 附件不可用时只少一个图片块，地址仍然给出（见函数头）。
      }
    }
  }
  return content
}

/**
 * 造三个生图工具。
 *
 * @param context 装配上下文
 */
export function createGenerationTools(context: HuiyuToolContext): readonly HuiyuTool[] {
  const draw: HuiyuTool = {
    spec: {
      name: 'huiyu_draw',
      displayName: '生成图片',
      description: '按文字描述生成一张图片。用户说“画一张……”“生成一张……的图”“帮我做个配图”时用它。'
        + '需要文章头图或封面图时改用 huiyu_cover，需要给文章段落批量配图时改用 huiyu_illustrate。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片描述。写清主体、风格、构图、氛围；越具体效果越好。' },
          size: { type: 'string', description: `期望尺寸。可填 ${sizeNames().join(' / ')}，或写成 1024x1024 这样的具体像素。缺省为方图。这是**请求**：渠道可能按自己的规格出图，实际尺寸见返回文案。` },
          count: { type: 'number', description: `生成张数，1 到 ${MAX_BATCH}，缺省 1。生成需要时间与费用，不要一次要很多张。` },
        },
        required: ['prompt'],
      },
    },
    run: async (args, execution) => {
      const prompt = requiredString(args, 'prompt', MAX_PROMPT)
      const size = resolveSize(optionalString(args, 'size', 40))
      const count = countOf(args)
      const artifacts = await generate(context, prompt, size, count, execution, 'huiyu_draw')
      return present(context, artifacts, '图已生成，地址')
    },
  }

  const cover: HuiyuTool = {
    spec: {
      name: 'huiyu_cover',
      displayName: '生成文章头图',
      description: '为文章生成头图或封面图，按横幅比例请求。用户说“给这篇文章配个头图”“生成封面图”时用它。'
        + '只需给标题和摘要，提示词由工具按横幅构图组织。'
        + '要生成普通图片（不限定横幅）时用 huiyu_draw；要给正文段落逐段配图时用 huiyu_illustrate。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文章标题。' },
          summary: { type: 'string', description: '文章摘要或核心内容，用于让头图贴合主题。留空则只按标题构思。' },
          style: { type: 'string', description: '风格偏好，例如“扁平插画”“写实摄影”“手账线稿风”。留空用站点配置的默认画风（HUIYU_COVER_STYLE，未配置则按标题判断）。头图会把文章标题文字排进画面。' },
        },
        required: ['title'],
      },
    },
    run: async (args, execution) => {
      const title = requiredString(args, 'title', 300)
      const summary = optionalString(args, 'summary', 2000)
      const style = optionalString(args, 'style', 200)
      const prompt = coverPrompt(title, summary, style, context.environment.image.coverStyle)
      const artifacts = await generate(context, prompt, bannerSize(), 1, execution, 'huiyu_cover')
      return present(context, artifacts, '文章头图已生成，地址')
    },
  }

  const illustrate: HuiyuTool = {
    spec: {
      name: 'huiyu_illustrate',
      displayName: '为段落配图',
      description: '为文章的若干段落各生成一张配图，并给出建议的插入位置。'
        + '用户说“给这几段配图”“每段来一张插图”时用它。段落较多时不要一次全做，先问用户要配哪几段。'
        + '整篇文章只要一张头图时用 huiyu_cover，只要一张普通图片时用 huiyu_draw。',
      parameters: {
        type: 'object',
        properties: {
          paragraphs: { type: 'array', items: { type: 'string' }, description: `要配图的段落文字，按文中顺序给出，最多 ${MAX_BATCH} 段。` },
          style: { type: 'string', description: '统一的风格描述，例如“极简线条插画”。留空则由工具按段落内容判断。' },
        },
        required: ['paragraphs'],
      },
    },
    run: async (args, execution) => {
      const paragraphs = requiredStringArray(args, 'paragraphs', MAX_BATCH, 2000)
      const style = optionalString(args, 'style', 200)
      // 并行一批：段数上限与 ciyuan 适配器的分批上限（4）一致，上游 4 路并行已实测安全。
      const batches = await Promise.all(paragraphs.map(paragraph =>
        generate(context, paragraphPrompt(paragraph, style, context.environment.image.coverStyle), resolveSize('landscape'), 1, execution, 'huiyu_illustrate')))
      const artifacts: GeneratedArtifact[] = batches.flat()
      const lines = artifacts.map((artifact, index) => `第 ${index + 1} 段配图${describeSize(artifact)}：${artifact.url}`)
      const content = await present(context, artifacts, '配图已生成')
      return [{ type: 'text', text: `建议插入位置（按原段落顺序）：\n${lines.join('\n')}` }, ...content.slice(1)]
    },
  }

  return [draw, cover, illustrate]
}

/** 读张数参数。给非整数或越界时明确报错，不替调用方取整。 */
function countOf(args: Record<string, unknown>): number {
  const value = args.count
  if (value === undefined || value === null) return 1
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid('参数 count 必须是整数')
  if (value < 1 || value > MAX_BATCH) throw invalid(`参数 count 必须在 1 到 ${MAX_BATCH} 之间`)
  return value
}

/**
 * 按标题与摘要组织横幅提示词。
 *
 * 这段组装就是"专用工具比通用工具好用"的地方：模型只说标题，工具负责补上构图与叙事
 * 约束。**标题文字要上图**（2026-09-21 老板要求：头图要带文章标题、要能看出文章讲什么，
 * 万能贴纸拼贴不算配图）——短中文标题的渲染质量可用；除标题外的文字仍然禁止，防乱码。
 */
function coverPrompt(title: string, summary: string | undefined, style: string | undefined, configStyle: string): string {
  const styleHint = style ?? (configStyle.trim() !== '' ? configStyle.trim() : '编辑插画风格：造型简练、色彩克制、有明确视觉焦点')
  return [
    `为一篇文章设计横幅头图。文章标题：${title}`,
    ...(summary === undefined ? [] : [`文章摘要：${summary}`]),
    '画面要求：',
    `1. 图上必须出现这篇文章的标题「${title}」，作为画面主体之一认真排版：位置醒目、字体气质与画风一致；除这个标题外不要出现其他文字、字母或水印。`,
    '2. 从标题与摘要里提炼一两个**具体的核心概念**，转成看得懂的画面元素——读者看图 10 秒内应该能说出"这篇文章讲什么"；禁止堆砌齿轮、机器人、电路、灯泡这类放在任何科技文章上都成立的万能贴纸。',
    '3. 横幅构图：画面元素与标题字相互呼应，留出呼吸空间，整体像一张杂志专栏的题图。',
    `4. 画风：${styleHint}。`,
  ].join('\n')
}

/** 按段落内容组织配图提示词。段落插图不带文字（那是头图的事），但意象要具体、对应段落观点。 */
function paragraphPrompt(paragraph: string, style: string | undefined, configStyle: string): string {
  const styleHint = style ?? (configStyle.trim() !== '' ? configStyle.trim() : '与文章气质一致的编辑插画风格')
  return [
    '为下面这段文章内容配一张插图：',
    paragraph,
    `画面要求：${styleHint}；横构图；不要出现任何文字、字母或水印；插图要表达这段内容的具体观点或场景，不要直白复述段落，也不要用放在任何文章上都成立的通用装饰元素。`,
  ].join('\n')
}
