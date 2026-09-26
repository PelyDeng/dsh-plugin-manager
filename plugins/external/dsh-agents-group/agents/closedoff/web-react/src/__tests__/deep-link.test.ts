/**
 * 深链会话 id 形制的等价单测（删码评审 B F2：旧 tests/web-identity.test.ts 的
 * 深链用例随 vanilla 前端删除，正则语义在 React 侧补回护栏）。
 *
 * 语义：只有 `closedoff-web-<UUIDv4>`（version 位 4 + variant 位 89ab）算
 * 「打开指定会话」的链接 id；其他命名空间、非 v4 版本位、非法变体位、大写
 * 十六进制、截断串一律拒绝——拒绝后由 bootstrap 回落本地存储的上次会话，
 * 归属校验交给原 history 接口（选择标识不授予访问权）。
 */
import { describe, expect, it } from 'vitest'

const { isLinkedConversationId, linkedConversationId } = await import('../stores/session.ts')

const VALID = 'closedoff-web-01234567-89ab-4cde-8fab-0123456789ab'

describe('深链会话 id 形制（isLinkedConversationId）', () => {
  it('合法的 closedoff-web-<UUIDv4> 匹配', () => {
    expect(isLinkedConversationId(VALID)).toBe(true)
    expect(isLinkedConversationId('closedoff-web-ffffffff-ffff-4fff-bfff-ffffffffffff')).toBe(true)
  })

  it('其他命名空间和非 UUID 参数拒绝（旧码同口径反例）', () => {
    for (const value of ['foreign-session', 'closedoff-web-anything', '//other.invalid']) {
      expect(isLinkedConversationId(value)).toBe(false)
    }
  })

  it('version 位与 variant 位不符、大小写、截断一律拒绝', () => {
    // version 位不是 4（v1 形状）。
    expect(isLinkedConversationId('closedoff-web-01234567-89ab-1cde-8fab-0123456789ab')).toBe(false)
    // variant 位不在 8/9/a/b。
    expect(isLinkedConversationId('closedoff-web-01234567-89ab-4cde-0fab-0123456789ab')).toBe(false)
    // 正则无 i 标志：大写十六进制不算合法 id。
    expect(isLinkedConversationId(VALID.toUpperCase())).toBe(false)
    // 缺段截断与前后缀污染。
    expect(isLinkedConversationId('closedoff-web-01234567-89ab-4cde-8fab-0123456789')).toBe(false)
    expect(isLinkedConversationId(` ${VALID}`)).toBe(false)
    expect(isLinkedConversationId('')).toBe(false)
  })

  it('node/无 window 环境下链接参数读取返回空串（不回落本地存储语义的边界）', () => {
    expect(linkedConversationId()).toBe('')
  })
})
