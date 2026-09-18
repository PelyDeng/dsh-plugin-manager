/**
 * 生图工具的**运行路径**判据（此前只有 provider 层与目录层的用例，`run()` 一次都没跑过）。
 *
 * ## 这一组判据要钉住什么
 *
 * 正式环境实测暴露的缺陷：请求 `1536x864` 的封面，落地的文件是 `2048x768`，而**记录与工具
 * 文案都在报请求值**。于是模型照着工具文案对用户说"规格：1536×864"，用户按 16:9 去排版，
 * 拿到的却是 8:3。文件不会说话，文案会——所以真值只能来自交付的字节。
 *
 * 三条判据：
 *
 * 1. 渠道按请求出图时：记录与文案都是那一份尺寸，且**不出现**"渠道未按请求"这句话；
 * 2. 渠道不按请求出图时（本次线上就是这样）：记录里 `width/height` 是**交付**尺寸、
 *    `deliveredSize` 留痕，文案写明请求值是多少；
 * 3. 容器格式认不出时：**不写尺寸**，也绝不拿请求值顶替（宁可不说，不能说错）。
 *
 * 宿主面（ctx / 附件）与对象存储、生图渠道都是替身：本文件验的是工具自己的编排与文案。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { parseEnvConf } from '../src/env.ts'
import type { HuiyuStore, ImageRecordPayload } from '../src/store.ts'
import type { MinioClient } from '../src/minio/client.ts'
import type { ImageGenerationResult, ImageGenerationSpec } from '../src/image/spec.ts'
import { createGenerationTools } from '../src/tools/generation.ts'
import type { HuiyuToolContext, ToolExecution } from '../src/tools/context.ts'

/** 与生产同一套键的配置（尺寸相关的行为不受它影响，但环境对象必须完整）。 */
const ENVIRONMENT = parseEnvConf([
  'HUIYU_MINIO_ENDPOINT=http://127.0.0.1:3101',
  'HUIYU_MINIO_BUCKET=huiyu',
  'HUIYU_MINIO_ACCESS_KEY=ak',
  'HUIYU_MINIO_SECRET_KEY=sk',
  'HUIYU_PUBLIC_BASE_URL=https://img.pelycloud.com',
  'HUIYU_IMAGE_BASE_URL=https://img.ciyuan.fast',
  'HUIYU_IMAGE_MODEL=gpt-image-2',
].join('\n'))

const EXECUTION: ToolExecution = { signal: new AbortController().signal, agent: undefined, sessionId: 'session-1' }

/** 造一张只有头部的最小 PNG（宽高在 16/20 字节，大端）。 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 一次 run 的全部可观察结果。 */
async function runDraw(input: { readonly requested: string; readonly delivered: Uint8Array }) {
  const recorded: ImageRecordPayload[] = []
  const puts: { readonly key: string; readonly bytes: number }[] = []
  const specs: ImageGenerationSpec[] = []

  const provider = {
    kind: 'stub-images',
    available: () => ({ ok: true }),
    generate: async (spec: ImageGenerationSpec): Promise<ImageGenerationResult> => {
      specs.push(spec)
      return { model: 'stub-image-model', images: [{ data: input.delivered, mediaType: 'image/png' }] }
    },
  }
  const minio = {
    put: async (request: { readonly key: string; readonly data: Uint8Array }) => {
      puts.push({ key: request.key, bytes: request.data.byteLength })
      return { key: request.key, url: `${ENVIRONMENT.minio.publicBaseUrl}/${ENVIRONMENT.minio.bucket}/${request.key}` }
    },
  } as unknown as MinioClient
  const store = {
    record: async (row: { readonly payload: ImageRecordPayload }) => { recorded.push(row.payload) },
    conversationOwner: async () => undefined,
  } as unknown as HuiyuStore

  const context: HuiyuToolContext = {
    // 宿主面只用到 `ctx.get`（取附件服务）；附件未挂载 ⇒ 工具降级成"只给地址"。
    ctx: { get: () => undefined } as unknown as Context,
    environment: ENVIRONMENT,
    minio,
    imageProvider: provider,
    store,
    attachments: () => { throw new Error('本用例不挂附件服务') },
  }

  const tool = createGenerationTools(context).find(item => item.spec.name === 'huiyu_draw')
  if (tool === undefined) throw new Error('没有 huiyu_draw 工具')
  const blocks = await tool.run({ prompt: '一张测试图', size: input.requested }, EXECUTION)
  const text = blocks.flatMap(block => (block as { type?: string; text?: string }).type === 'text' ? [String((block as { text?: string }).text)] : []).join('\n')
  return { recorded, puts, specs, text }
}

describe('huiyu_draw 的运行路径', () => {
  it('渠道按请求出图：记录与文案都用交付尺寸，且不出现"未按请求"的说明', async () => {
    const { recorded, text, specs } = await runDraw({ requested: '1024x1024', delivered: pngHeader(1024, 1024) })

    expect(specs[0]?.size).toBe('1024x1024')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ size: '1024x1024', width: 1024, height: 1024, model: 'stub-image-model', provider: 'stub-images', tool: 'huiyu_draw' })
    // 一致时不留 `deliveredSize`：那一栏只在"渠道没照做"时才有值。
    expect(recorded[0]?.deliveredSize).toBeUndefined()
    expect(text).toContain('（1024×1024）')
    expect(text).not.toContain('未按请求')
  })

  it('渠道不按请求出图（线上实测如此）：记录交付尺寸并留痕，文案说清请求值', async () => {
    const { recorded, text } = await runDraw({ requested: '1536x864', delivered: pngHeader(2048, 768) })

    // ★ 这条就是本次要修的缺陷：以前这里写的是 1536/864（请求值），文案说"规格：1536×864"。
    expect(recorded[0]).toMatchObject({ size: '1536x864', deliveredSize: '2048x768', width: 2048, height: 768 })
    expect(text).toContain('2048×768')
    expect(text).toContain('渠道未按请求的 1536×864 出图')
  })

  it('容器格式认不出时不写尺寸——宁可不说，不能拿请求值冒充', async () => {
    const { recorded, text } = await runDraw({ requested: '1536x864', delivered: new Uint8Array(64) })

    expect(recorded[0]?.width).toBeUndefined()
    expect(recorded[0]?.height).toBeUndefined()
    expect(recorded[0]?.deliveredSize).toBeUndefined()
    expect(recorded[0]?.size).toBe('1536x864')
    expect(text).not.toContain('1536×864')
    expect(text).toContain('https://img.pelycloud.com/huiyu/')
  })

  it('对象键按交付的媒体类型给扩展名，图片本体照写', async () => {
    const { puts, recorded } = await runDraw({ requested: '1024x1024', delivered: pngHeader(1024, 1024) })
    expect(puts[0]?.bytes).toBe(24)
    expect(recorded[0]?.objectKey).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.png$/)
    expect(recorded[0]?.bucket).toBe('huiyu')
    expect(recorded[0]?.sessionId).toBe('session-1')
  })
})
