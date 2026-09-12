/**
 * 共享组件包的测试。
 *
 * P0 只抽了一个能力（错误裁剪）。这一条是确认两件事：抽象确实可用，
 * 以及它会在构建期被内联、不会变成运行时依赖。
 */
import { describe, expect, it } from 'vitest'
import { COMMON_VERSION, visibleErrorMessage } from '../packages/common/src/index.ts'

describe('共享包可用', () => {
  it('导出内部版本，用于确认内联生效', () => {
    expect(COMMON_VERSION).toBe('0.1.0')
  })
})

describe('错误信息裁剪', () => {
  it('抹掉 Windows 本机路径', () => {
    const text = visibleErrorMessage(new Error('打不开 C:\\Users\\dpl\\secret\\config.json'))
    expect(text).not.toContain('dpl')
    expect(text).toContain('（本机路径）')
  })

  it('抹掉类 Unix 本机路径', () => {
    const text = visibleErrorMessage(new Error('ENOENT /home/deploy/app/data.sqlite'))
    expect(text).not.toContain('/home/deploy')
    expect(text).toContain('（本机路径）')
  })

  it('抹掉凭据形状的片段', () => {
    const text = visibleErrorMessage(new Error('unauthorized: sk-abcdef1234567890 rejected'))
    expect(text).not.toContain('sk-abcdef1234567890')
    expect(text).toContain('（凭据）')
  })

  it('压平空白并限制长度', () => {
    const text = visibleErrorMessage(new Error(`第一行\n\n第二行    第三行`), 100)
    expect(text).toBe('第一行 第二行 第三行')
    expect(visibleErrorMessage(new Error('x'.repeat(200)), 20).length).toBeLessThanOrEqual(20)
  })

  it('非 Error 输入也有可读输出', () => {
    expect(visibleErrorMessage('字符串错误')).toBe('字符串错误')
    expect(visibleErrorMessage(undefined)).toBe('未知错误')
    expect(visibleErrorMessage(new Error('   '))).toBe('未知错误')
  })
})
