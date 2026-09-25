/**
 * 非安全上下文剪贴板回退的单测（评审三审 P1#2）：
 * navigator.clipboard 不存在（HTTP 内网部署）时 textarea + execCommand('copy')，
 * 成功/失败/抛错三种出口与旧 web/app.js writeClipboard 同口径。
 */
import { describe, expect, it, vi } from 'vitest'
import { legacyCopy } from '../lib/legacy-copy.ts'

interface AreaLike {
  value: string
  style: Record<string, string>
  setAttribute: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function stubDocument(execCommand: () => boolean): { area: AreaLike; append: ReturnType<typeof vi.fn> } {
  const area: AreaLike = { value: '', style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() }
  const append = vi.fn()
  vi.stubGlobal('document', {
    createElement: vi.fn(() => area),
    body: { append },
    execCommand,
  })
  return { area, append }
}

describe('legacyCopy（旧 writeClipboard 的回退分支）', () => {
  it('execCommand 成功：写入 textarea、选中、清理，返回 true', () => {
    const { area, append } = stubDocument(() => true)
    expect(legacyCopy('园区正常')).toBe(true)
    expect(area.value).toBe('园区正常')
    expect(area.select).toHaveBeenCalledTimes(1)
    expect(area.remove).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('execCommand 返回 false → false；抛错同样吞掉 → false', () => {
    stubDocument(() => false)
    expect(legacyCopy('x')).toBe(false)
    vi.unstubAllGlobals()
    stubDocument(() => { throw new Error('denied') })
    expect(legacyCopy('x')).toBe(false)
    vi.unstubAllGlobals()
  })
})
