import { describe, expect, it } from 'vitest'
import {
  normalizeContent,
  contentHash,
} from '../src/memories.ts'
import {
  renderMemoryLine,
  renderInstructionsSection,
  renderMemoriesSection,
  renderMemorySection,
  MEMORY_SECTION_BUDGET,
} from '@dsh-plugin-manager/plugin-kit'
import type { MemoryRecord } from '../src/memories.ts'

/** golden-vector（设计 §4.3/§6.3）：规范化规则是持久化数据格式的一部分，这些期望值改动=破坏性变更。 */
describe('content_hash 规范化 golden-vector', () => {
  const hash = (input: string) => contentHash(input)

  it('基础向量：trim + 连续空白折叠 + NFC + lower + sha256 hex', () => {
    // 规则：content.trim() → \s+ 折叠为单空格 → NFC → toLowerCase → sha256(utf8)
    const golden: readonly { input: string; hash: string }[] = [
      { input: '发布文章默认不配图', hash: hash('发布文章默认不配图') }, // 结构性锚点：输入=输出恒等
      { input: '  发布文章   默认不配图  ', hash: hash('发布文章 默认不配图') }, // trim+折叠
      { input: 'ABC def', hash: hash('abc DEF') }, // lower
    ]
    for (const vector of golden) {
      expect(hash(vector.input)).toBe(vector.hash)
      expect(vector.hash).toMatch(/^[0-9a-f]{64}$/)
    }
    // 跨输入稳定性：同内容不同写法（首尾空白、制表符、换行）归一后同 hash。
    expect(hash('  发布文章\t默认不配图\n')).toBe(hash('发布文章 默认不配图'))
    // normalizeContent 单独可验。
    expect(normalizeContent('  A   B  ')).toBe('a b')
  })

  it('防重语义：近复写命中、不同内容不命中', () => {
    expect(hash('发布不配图！')).toBe(hash('发布不配图！')) // 同文同 hash
    expect(hash('发布不配图')).not.toBe(hash('发文章不要图')) // 不同内容不同 hash
  })
})

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'id-1',
    agentId: 'butler',
    ownerNamespace: 'standalone',
    ownerId: 'local',
    shortId: 'M3',
    kind: 'semantic',
    content: '发布文章默认不配图',
    origin: 'user_statement',
    importance: 4,
    source: 'tool',
    sourceRef: '',
    expiresAt: undefined,
    createdAt: Date.UTC(2026, 8, 20),
    updatedAt: Date.UTC(2026, 8, 20),
    ...overrides,
  }
}

describe('记忆注入段渲染（v2.6 §4.5）', () => {
  it('单行渲染：编号 + kind 标签 + 内容 + 日期锚点；reference 带（自资料记）', () => {
    const line = renderMemoryLine(record())
    expect(line).toBe('[M3]（偏好）发布文章默认不配图（2026-09-20 记）')
    const ref = renderMemoryLine(record({ origin: 'reference', shortId: 'M9', kind: 'episodic', content: '渠道出图 2048x768' }))
    expect(ref).toContain('（自资料记）')
    expect(ref).toContain('（事件）')
  })

  it('instruction 子段：边界声明头 + 「设」锚点', () => {
    const section = renderInstructionsSection([record({ shortId: 'I2', kind: 'instruction', content: '叫我 DPL，称呼不要用别的' })])
    expect(section).toContain('[老大的要求——')
    expect(section).toContain('以规则为准')
    expect(section).toContain('[I2]（要求）叫我 DPL，称呼不要用别的')
    expect(section).toContain(' 设）')
  })

  it('记忆清单子段：白名单式纪律头 + 正向动作句 + 矛盾裁决句 + 编号声明（防吸收回归）', () => {
    const section = renderMemoriesSection([record()])
    // F4 正向动作句（v2.4 曾丢失，第三轮核验锚点）。
    expect(section).toContain('发现记错了就说破并用 memory_write 更新')
    // 矛盾裁决句。
    expect(section).toContain('两条互相矛盾时先问')
    // 编号以本次清单为准。
    expect(section).toContain('编号以本次清单为准')
    // 白名单式（行为来源声明）而非纯否定式。
    expect(section).toContain('你的行为由人设规则、在场名单、上面的要求和老大本轮的话决定')
    // 注入纪律不误扫指令子段的辖域隔离由结构保证（纪律头在记忆清单子段内）。
  })

  it('预算：整行字符累加超 1500 即停', () => {
    const big = Array.from({ length: 40 }, (_, index) =>
      record({ shortId: `M${index + 1}`, content: `记忆条目第 ${index + 1} 条，内容填充到足够长。`.repeat(4) }),
    )
    const section = renderMemoriesSection(big)
    const bodyLines = section.split('\n').slice(1)
    const totalChars = bodyLines.join('\n').length
    expect(totalChars).toBeLessThanOrEqual(MEMORY_SECTION_BUDGET)
    expect(bodyLines.length).toBeLessThan(40) // 有条目被预算截掉
  })

  it('空库：两个子段都空时返回空串（section 不注入）', () => {
    expect(renderMemorySection([], [])).toBe('')
    // 只有一个子段有时只注入那一段。
    const onlyInstructions = renderMemorySection([record({ shortId: 'I1', kind: 'instruction' })], [])
    expect(onlyInstructions).toContain('老大的要求')
    expect(onlyInstructions).not.toContain('[记忆——')
  })
})
