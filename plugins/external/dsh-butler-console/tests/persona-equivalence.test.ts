import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PERSONA_SECTION_ORDER } from '../src/index.ts'

/**
 * P0a 等价验收（设计 §6.1 步骤 4）：persona/ 目录按权威顺序拼装、trim 后与迁移前的
 * persona.txt 快照逐字节一致。快照基线 = 迁移前最后一个 commit 的 persona.txt 经整体 trim
 * （与 loader 的 trim 口径一致）。等价期收口（§6.1 步骤 2 合并完成）后本测试移除。
 */
const BASELINE_SHA256 = '253e92253bc0f42dc211062e9f05776217bcd9a06e315c31a69c4dde39423a32'

describe('persona 目录化等价验收（P0a）', () => {
  it('拼装结果与迁移前 persona.txt 快照逐字节一致', () => {
    const sections = PERSONA_SECTION_ORDER.map(name =>
      readFileSync(new URL(`../persona/${name}.md`, import.meta.url), 'utf8').trim(),
    )
    sections.forEach((section, index) => {
      expect(section, `${PERSONA_SECTION_ORDER[index]}.md 不得为空`).not.toBe('')
    })
    const joined = sections.join('\n\n')
    const actual = createHash('sha256').update(joined, 'utf8').digest('hex')
    expect(actual).toBe(BASELINE_SHA256)
  })

  it('目录里没有权威顺序之外的文件（防止拼装遗漏）', () => {
    const files = readdirSync(new URL('../persona', import.meta.url))
    expect(files.sort()).toEqual([...PERSONA_SECTION_ORDER].map(name => `${name}.md`).sort())
  })
})
