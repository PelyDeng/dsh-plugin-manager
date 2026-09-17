/**
 * 八个工具的注册入口。
 *
 * 分类标签由**群组从清单注入**，本子包绝不自己再写一份分类字符串：群组按分类算"这个智能体能
 * 看见哪些工具"，两份字符串一旦漂移，后果是"该 Agent 的工具全部不可见"，而那种失效在界面上
 * 完全看不出来。
 *
 * ## 两处形状转换，都集中在这里
 *
 * 宿主的 `defineTool` 用的是**本项目自定义的 schema 词汇**，不是标准 JSON Schema：参数对象里
 * 每个属性直接写规格并自带 `required: true`，而不是另外给一个 `required` 数组。
 *
 * 工具模块里仍按**标准 JSON Schema** 写参数（那是所有人都会写的形状，也是模型看到的形状文案
 * 的来源），在注册这一处统一翻译。这样两边的词汇各自干净，翻译规则只有一份。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterPropertySpec, ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createPluginTools, type ToolAuthorizer, type ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type { HuiyuToolContext, HuiyuTool, ToolExecution } from './context.ts'
import { createVisionTools } from './vision.ts'
import { createGenerationTools } from './generation.ts'
import { createMaterialTools } from './material.ts'

/** 本子包注册的全部工具名，供自检与文档引用。 */
export const HUIYU_TOOL_NAMES: readonly string[] = [
  'huiyu_describe', 'huiyu_extract', 'huiyu_compare',
  'huiyu_draw', 'huiyu_cover', 'huiyu_illustrate',
  'huiyu_library', 'huiyu_upload',
]

/** 标准 JSON Schema 里的一个属性。 */
interface JsonSchemaProperty {
  readonly type?: string
  readonly description?: string
  readonly items?: { readonly type?: string }
  readonly enum?: readonly string[]
}

/** 标准 JSON Schema 的开放形状。 */
interface JsonSchema {
  readonly type?: string
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>
  readonly required?: readonly string[]
}

/**
 * 把标准 JSON Schema 翻成宿主认识的参数规格。
 *
 * 三处对应关系：`type` 直传（只是词汇不同）；`required` 从数组改成属性内的布尔标记；
 * `items.type` 折成单值（宿主的数组项只声明一种类型）。
 *
 * 未识别的 `type` 落到 `'json'`——那是宿主的"任意值"。
 */
function toParameterSchema(schema: JsonSchema): ParameterSchemaSpec {
  const required = new Set(schema.required ?? [])
  const properties: Record<string, ParameterPropertySpec> = {}
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    properties[key] = propertySpec(spec, required.has(key))
  }
  return properties
}

/** 单个属性的规格。宿主的属性规格是值规格的联合，所以先造值规格再挂 `required`。 */
function propertySpec(spec: JsonSchemaProperty, isRequired: boolean): ParameterPropertySpec {
  const description = spec.description === undefined ? {} : { description: spec.description }
  // 逐类型分支构造：宿主的 `ValueSchemaSpec` 是**按 `type` 区分的联合**，把 `type` 收成
  // 一个联合字面量再拼对象，TS 无法确认它落在哪一个成员上。
  const value: ValueSchemaSpec = ((): ValueSchemaSpec => {
    switch (spec.type) {
      case 'string': return { type: 'string', ...description }
      case 'number': return { type: 'number', ...description }
      case 'boolean': return { type: 'boolean', ...description }
      case 'array': return { type: 'array', items: { type: itemType(spec.items?.type) }, ...description }
      default: return { type: 'json', ...description }
    }
  })()
  return isRequired ? { ...value, required: true } : value
}

/** 数组项类型映射。 */
function itemType(type: string | undefined): 'string' | 'number' | 'boolean' | 'json' {
  switch (type) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    default: return 'json'
  }
}

/** 工具输出的规范化值：一个内容块数组。 */
interface ToolOutput {
  readonly blocks: readonly ContentBlock[]
}

/**
 * 输出规格。
 *
 * `blocks` 用一个宽松的数组描述：块的内部结构属于宿主的内容块词汇，由 `render` 交回宿主自己
 * 解释，本层不重复声明一遍（声明一份就等于多一处会漂移的定义）。
 */
const OUTPUT_SCHEMA: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    blocks: { type: 'array', required: true, description: '工具产出的内容块序列' },
  },
} as ValueSchemaSpec

/**
 * 从宿主的执行上下文里取本子包关心的运行时信息。
 *
 * 宿主的工具执行面只保证 `agent` 与 `signal`；会话 id 要从 agent 的会话上读得到。读不到时
 * **如实留空**而不是编一个——记一条归属错误的账比不记账更难查。
 */
function executionOf(execution: { readonly signal: AbortSignal; readonly agent?: unknown }): ToolExecution {
  const agent = execution.agent as { readonly session?: { readonly id?: unknown } } | undefined
  const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : ''
  return { signal: execution.signal, agent: agent as object | undefined, sessionId }
}

/**
 * 注册全部八个工具。
 *
 * @param context 装配上下文
 * @param category 工具分类标签，由群组从 Agent 清单注入
 * @param permission 授权标识，由群组推导
 * @returns 全部已注册工具的目录条目——**必须一条不漏**，群组据此算可见性
 */
export function registerHuiyuTools(
  context: HuiyuToolContext,
  category: string,
  permission: string,
): readonly ToolDescriptor[] {
  const authorize: ToolAuthorizer = agent => {
    // 工具只能由 Agent 调用；没有 agent 作用域的调用是接线错误，不是业务错误。
    if (agent === undefined) throw new Error('绘语的工具必须由智能体调用')
  }
  const tools = createPluginTools(context.ctx, { permission, authorize })
  const all: readonly HuiyuTool[] = [
    ...createVisionTools(context),
    ...createGenerationTools(context),
    ...createMaterialTools(context),
  ]
  return all.map(tool => tools.register(defineHuiyuTool(tool), tool.spec.displayName, category))
}

/** 把本子包的工具定义包成宿主认识的形状。 */
function defineHuiyuTool(tool: HuiyuTool) {
  return defineTool({
    name: tool.spec.name,
    description: tool.spec.description,
    parameters: toParameterSchema(tool.spec.parameters as JsonSchema),
    // `schema` 直接内联：`InferValue` 靠字面量推断输出类型，引用一个外部常量会让它退化成 `never`。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          blocks: { type: 'array', required: true, description: '工具产出的内容块序列' },
        },
      },
    render: (_args: unknown, value: { readonly blocks?: unknown }) => [...((value.blocks ?? []) as readonly ContentBlock[])],
    },
    execute: async (args: Record<string, unknown>, execution: { readonly signal: AbortSignal; readonly agent?: unknown }) => {
      const blocks = await tool.run(args, executionOf(execution))
      return { blocks: blocks as readonly ContentBlock[] }
    },
  } as never)
}
