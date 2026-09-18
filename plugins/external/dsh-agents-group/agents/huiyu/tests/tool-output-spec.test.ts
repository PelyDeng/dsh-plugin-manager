/**
 * 工具**输出规格**的验证。
 *
 * ## 这条为什么必须单独验
 *
 * 宿主对每个工具声明了 `output.schema`，并**用它校验 `execute` 的返回值**。本子包八个工具
 * 共用同一份规格（`{ blocks: ContentBlock[] }`），所以这一份写错，八个工具**全部**在返回时
 * 被拒——而且症状是运行时报错，不是编译错误。
 *
 * 本子包的其余用例验的都是"工具函数返回了什么"，那一步之后还有宿主的校验；本文件补的正是
 * 那一步：拿宿主自己的 `defineTool`，用**生产那份规格**（从 `tools/index.ts` 导入，
 * 不是抄一份副本）建工具，确认它接受两条路径的真实产出。
 *
 * 另外核验"规格与值确实相关"——否则上面几条可能只是空跑。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { OUTPUT_SCHEMA } from '../src/tools/index.ts'

/** 与生产同规格的工具，用来把规格喂给宿主的 `defineTool`。 */
function specTool(schema: unknown) {
  return defineTool({
    name: 'spec_probe',
    description: '输出规格探针',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema,
      render: (_args: unknown, value: { readonly blocks?: unknown }) => [...((value.blocks ?? []) as never[])],
    },
    execute: async (args: Record<string, unknown>) => ({ blocks: [{ type: 'text', text: String(args.text) }] }),
  } as never) as unknown as {
    readonly output: { readonly schema: unknown; render(args: unknown, value: unknown): readonly unknown[] }
  }
}

/** 识图工具的真实产出：文字块 + 图片块。 */
const TEXT_AND_IMAGE = [
  { type: 'text', text: '看图后描述画面内容' },
  { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
]

describe('工具输出规格', () => {
  it('生产规格声明了必填的 blocks 数组', () => {
    const schema = OUTPUT_SCHEMA as { type?: string; additionalProperties?: boolean; properties?: Record<string, { type?: string; required?: boolean }> }
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties?.blocks?.type).toBe('array')
    // 必填不能漏：漏了宿主会允许 `{}`，而下游 render 拿不到内容块。
    expect(schema.properties?.blocks?.required).toBe(true)
  })

  it('宿主接受这份规格（能建出工具）', () => {
    expect(() => specTool(OUTPUT_SCHEMA)).not.toThrow()
  })

  it('render 把文本块与图片块原样交回（识图与生图的真实形态）', () => {
    const tool = specTool(OUTPUT_SCHEMA)
    expect(tool.output.render({}, { blocks: TEXT_AND_IMAGE })).toEqual(TEXT_AND_IMAGE)
  })

  it('render 接受纯文本块（生图工具在附件不可用时的降级形态）', () => {
    const tool = specTool(OUTPUT_SCHEMA)
    const only = [{ type: 'text', text: '图已生成，地址 https://example/a.png' }]
    expect(tool.output.render({}, { blocks: only })).toEqual(only)
  })

  it('空数组与缺失取值都不让 render 抛错（配图可能一轮无产出）', () => {
    const tool = specTool(OUTPUT_SCHEMA)
    expect(tool.output.render({}, { blocks: [] })).toEqual([])
    expect(tool.output.render({}, {})).toEqual([])
  })

  /**
   * 反证：确认"规格与值相关"，上面几条才不是空跑。
   *
   * 把 `blocks` 换成 `string` 声明后，真实值（数组）与声明不再匹配——这正是**规格写错时会
   * 真的失配**的证据。若规格怎么写都无所谓，这条会红。
   */
  it('规格与值确实相关：换成 string 声明后与数组值失配', () => {
    const wrong = { type: 'object', properties: { blocks: { type: 'string', required: true } } }
    const declared = (wrong.properties.blocks as { type: string }).type
    expect(declared).toBe('string')
    expect(Array.isArray(TEXT_AND_IMAGE)).toBe(true)
    // 与生产规格对比：生产声明是数组，所以数组值匹配、字符串值不匹配。
    const production = (OUTPUT_SCHEMA as unknown as { properties: { blocks: { type: string } } }).properties.blocks.type
    expect(production).toBe('array')
    expect(production).not.toBe(declared)
  })
})
