/**
 * 子包资源定位的测试。
 *
 * 这个解析器存在的理由是一个真实的坑：子包源码被打进群组 `dist/` 后，代码与资源的相对位置
 * 在开发与发布两种形态下不同。写死 `../` 层数会在换布局时静默错位 —— 装载期抛 ENOENT，
 * 而单测因为跑的是源码看不见。真实宿主验收已经抓到过这个失效，这里把它固化成断言。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { agentResource, agentResourcePath } from '../packages/common/src/agent-resources.ts'

describe('子包资源定位', () => {
  // 本测试文件位于 <插件根>/tests/，与群组产物 dist/ 一样距插件根一层；
  // 子包源码位于 <插件根>/agents/<id>/src/，距插件根两层。两种都必须解析到同一处。
  const fromTests = import.meta.url
  const fromDist = new URL('../dist/index.mjs', import.meta.url).href

  it('从测试目录解析到子包资源', () => {
    const persona = agentResourcePath(fromTests, 'closedoff', 'persona.txt')
    // 只断言「插件目录 + 子包资源」两段：分区层级（plugins/ 下直接放，还是 builtin|external/ 下）
    // 会随仓库布局变化，写死它等于把本测试要防的布局错位又请回来。
    expect(persona.replaceAll('\\', '/')).toMatch(/\/dsh-agents-group\/agents\/closedoff\/persona\.txt$/u)
    expect(existsSync(persona), `persona.txt 应当真实存在：${persona}`).toBe(true)
  })

  it('从群组产物位置解析到同一处', () => {
    // 这是发布形态：代码在 dist/，资源仍在 agents/<id>/ 下。
    const fromTestsPath = agentResourcePath(fromTests, 'closedoff', 'persona.txt')
    const fromDistPath = agentResourcePath(fromDist, 'closedoff', 'persona.txt')
    expect(fromDistPath).toBe(fromTestsPath)
  })

  it('两种形态对两个子包都成立', () => {
    for (const [id, relative] of [
      ['closedoff', 'persona.txt'],
      ['closedoff', 'web-react/index.html'],
      ['blog', 'runtime/chat-sdk.mjs'],
      ['blog', 'web-react/index.html'],
      ['blog', 'package.json'],
    ] as const) {
      const fromTestsPath = agentResourcePath(fromTests, id, relative)
      const fromDistPath = agentResourcePath(fromDist, id, relative)
      expect(fromDistPath, `${id}/${relative} 两种形态应一致`).toBe(fromTestsPath)
      expect(existsSync(fromDistPath), `${id}/${relative} 应当真实存在：${fromDistPath}`).toBe(true)
    }
  })

  it('返回值是 URL，可直接交给 readFile 与动态 import', () => {
    const url = agentResource(fromTests, 'blog', 'package.json')
    expect(url).toBeInstanceOf(URL)
    expect(url.protocol).toBe('file:')
  })

  it('找不到插件根时明确报错，而不是给出一个错误路径', () => {
    // 谎报路径会让调用方在读到 ENOENT 时误以为是文件缺失，而不是布局判断失败。
    expect(() => agentResource('file:///nowhere/at/all/index.mjs', 'closedoff', 'persona.txt')).toThrow(/找不到插件根/u)
  })

  it('解析结果不依赖子包自身是否已构建', () => {
    // 资源位置只由归档布局决定；子包 dist 是否存在与它无关。
    const path = fileURLToPath(agentResource(fromDist, 'closedoff', 'persona.txt'))
    expect(path).toContain('agents')
    expect(path).not.toContain('dist')
  })
})
