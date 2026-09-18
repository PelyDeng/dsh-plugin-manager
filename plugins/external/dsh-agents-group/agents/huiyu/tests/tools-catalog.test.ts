/**
 * 工具**说明书**的验证：名字、描述与参数。
 *
 * ## 为什么描述值得用测试钉住
 *
 * 模型是靠 `description` 决定"要不要调这个工具"的。设计稿里反复讲的一条经验是：
 * **模型最容易犯的错不是用错工具，是该用的时候没想起来用**。所以描述必须写清"什么时候用"，
 * 而不只是"这个工具做什么"。
 *
 * 这类退化不会报错、不会让任何用例变红——描述写成一句话实现说明，一切照常运行，只是模型不再
 * 想起它。本文件把几条要求变成判据：八个工具都在、名字带统一前缀、描述里含使用场景、
 * 每个参数都有说明（"别让模型猜格式"）、该必填的确实标了必填。
 *
 * 工厂只构造定义、不执行 `run`，所以这里传一个最小上下文即可。
 */

import { describe, expect, it } from 'vitest'
import { createVisionTools } from '../src/tools/vision.ts'
import { createGenerationTools } from '../src/tools/generation.ts'
import { createMaterialTools } from '../src/tools/material.ts'
import { HUIYU_TOOL_NAMES } from '../src/tools/index.ts'
import type { HuiyuTool } from '../src/tools/context.ts'

/** 只用来构造定义：`run` 不执行，所以上下文里什么都不需要。 */
const noopContext = {} as never

const TOOLS: readonly HuiyuTool[] = [
  ...createVisionTools(noopContext),
  ...createGenerationTools(noopContext),
  ...createMaterialTools(noopContext),
]

/** 八个工具的名字与预期清单。 */
const EXPECTED = [
  'huiyu_describe', 'huiyu_extract', 'huiyu_compare',
  'huiyu_draw', 'huiyu_cover', 'huiyu_illustrate',
  'huiyu_library', 'huiyu_upload',
] as const

describe('工具清单', () => {
  it('八个工具都在，且顺序与清单一致', () => {
    expect(TOOLS.map(tool => tool.spec.name)).toEqual([...EXPECTED])
  })

  it('导出给群组的名单与实现一致（漏报会让工具对该 Agent 不可见）', () => {
    expect([...HUIYU_TOOL_NAMES].sort()).toEqual([...EXPECTED].sort())
  })

  it('名字统一 huayu_ 前缀——前缀写错会让分类与可见性对不上', () => {
    for (const tool of TOOLS) {
      expect(tool.spec.name.startsWith('huiyu_'), `${tool.spec.name} 前缀不对`).toBe(true)
    }
  })

  it('每个工具都有显示名（认证页面按它展示）', () => {
    for (const tool of TOOLS) {
      expect(tool.spec.displayName.trim(), `${tool.spec.name} 缺显示名`).not.toBe('')
    }
  })
})

describe('描述就是说明书', () => {
  it('描述足够长，不是一句话实现说明', () => {
    for (const tool of TOOLS) {
      expect(tool.spec.description.length, `${tool.spec.name} 的描述太短`).toBeGreaterThan(40)
    }
  })

  /**
   * 每条描述都要写清**什么时候用它**。
   *
   * 判据是"含用户视角的触发词"——设计稿总结的规矩是：只写"这个工具做什么"不够，
   * 要写"用户说 X 时用它"，否则模型在该用的场合想不起来。
   */
  it('每条描述都写了使用场景（用户视角的触发语）', () => {
    const trigger = /时用它|用户说|用户问|用户想|时，先用|需要.+时/
    for (const tool of TOOLS) {
      expect(trigger.test(tool.spec.description), `${tool.spec.name} 的描述没写"什么时候用"`).toBe(true)
    }
  })

  it('工具之间互相指路，避免选错', () => {
    // 语义相邻的工具最容易选错：识图的三个、生图的三个各要有交叉指引。
    // 只单向指路不够——模型在"要头图"的场景里首先看到的是 huiyu_cover，那一侧也得说清另两个的差别。
    const descriptionOf = (name: string): string =>
      TOOLS.find(tool => tool.spec.name === name)?.spec.description ?? ''
    expect(descriptionOf('huiyu_extract')).toContain('huiyu_describe')
    expect(descriptionOf('huiyu_draw')).toContain('huiyu_cover')
    expect(descriptionOf('huiyu_draw')).toContain('huiyu_illustrate')
    expect(descriptionOf('huiyu_cover')).toContain('huiyu_draw')
    expect(descriptionOf('huiyu_illustrate')).toContain('huiyu_cover')
  })
})

describe('参数写得让模型不用猜', () => {
  it('每个参数都有说明文字', () => {
    for (const tool of TOOLS) {
      const properties = tool.spec.parameters.properties ?? {}
      // `huiyu_library` 的参数全是可选的，但仍有说明；这里逐个核。
      for (const [key, spec] of Object.entries(properties)) {
        expect(spec.description?.trim(), `${tool.spec.name}.${key} 缺参数说明`).toBeTruthy()
      }
    }
  })

  it('需要用户提供的关键参数标了必填', () => {
    const required = new Map(TOOLS.map(tool => [tool.spec.name, new Set(tool.spec.parameters.required ?? [])]))
    // 没有图片标识就无从识图；没有提示词就无从出图。
    expect(required.get('huiyu_describe')?.has('attachmentId')).toBe(true)
    expect(required.get('huiyu_extract')?.has('attachmentId')).toBe(true)
    expect(required.get('huiyu_compare')?.has('attachmentIds')).toBe(true)
    expect(required.get('huiyu_draw')?.has('prompt')).toBe(true)
    expect(required.get('huiyu_cover')?.has('title')).toBe(true)
    expect(required.get('huiyu_illustrate')?.has('paragraphs')).toBe(true)
  })

  it('可选项不标必填（模型不该为可选参数编值）', () => {
    const optional = new Map(TOOLS.map(tool => [tool.spec.name, new Set(tool.spec.parameters.required ?? [])]))
    expect(optional.get('huiyu_describe')?.has('question')).toBe(false)
    expect(optional.get('huiyu_draw')?.has('size')).toBe(false)
    expect(optional.get('huiyu_cover')?.has('summary')).toBe(false)
    // 素材工具的筛选与条数都是可选的。
    expect(optional.get('huiyu_library')?.has('limit')).toBe(false)
  })

  it('参数类型是模型能理解的 JSON Schema 词汇', () => {
    const allowed = new Set(['string', 'number', 'boolean', 'array', 'object'])
    for (const tool of TOOLS) {
      for (const [key, spec] of Object.entries(tool.spec.parameters.properties ?? {})) {
        expect(allowed.has(spec.type ?? ''), `${tool.spec.name}.${key} 的类型是 ${spec.type}`).toBe(true)
      }
    }
  })

  it('数组参数的项类型写清了（否则模型会塞进对象）', () => {
    for (const tool of TOOLS) {
      for (const [key, spec] of Object.entries(tool.spec.parameters.properties ?? {})) {
        if (spec.type !== 'array') continue
        expect(spec.items?.type, `${tool.spec.name}.${key} 没写 items.type`).toBeTruthy()
      }
    }
  })
})
