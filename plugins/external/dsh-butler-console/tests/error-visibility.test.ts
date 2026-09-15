/**
 * 失败原因的可读化与脱敏测试。
 *
 * 背景：模型调用失败时宿主事件里的 `reason.error` 不保证是 `Error` —— 实测出现过
 * 非 Error 的抛出物，旧实现一律显示「未知错误」，导致页面上看不出失败来自哪一类，
 * 排查只能靠猜。这里锁定三条：
 *
 * 1. 有信息量的部分必须被取出来（对象取 code/name/message，认不出来给字段摘要）。
 * 2. 本机路径与密钥形状的片段必须被抹掉，不能因为「多说一点」而泄露。
 * 3. 真的什么都没有时仍然是「未知错误」，不编造原因。
 */
import { describe, expect, it } from 'vitest'
import { visibleError } from '../src/butler.ts'

const clip = (value: string, limit: number) => value.length <= limit

describe('visibleError', () => {
  it('keeps the message of a real Error and prefixes a non-generic name', () => {
    expect(visibleError(new Error('连接被拒绝'), 500)).toBe('连接被拒绝')
    class LlmError extends Error {
      override name = 'LlmError'
    }
    expect(visibleError(new LlmError('MISSING_CREDENTIAL'), 500)).toBe('LlmError: MISSING_CREDENTIAL')
  })

  it('reads code, name and message out of a plain thrown object instead of saying 未知错误', () => {
    expect(visibleError({ code: 'MISSING_CREDENTIAL', message: '缺少凭据' }, 500)).toBe('MISSING_CREDENTIAL: 缺少凭据')
    expect(visibleError({ name: 'TimeoutError', message: '8 秒未响应' }, 500)).toBe('TimeoutError: 8 秒未响应')
    expect(visibleError({ code: 'QUOTA' }, 500)).toBe('QUOTA')
  })

  it('summarises an unrecognisable object rather than discarding it', () => {
    const result = visibleError({ alpha: 1, beta: 2 }, 500)
    expect(result).toContain('alpha')
    expect(result).toContain('beta')
    expect(result).not.toBe('未知错误')
  })

  it('passes through strings and primitives', () => {
    expect(visibleError('上游返回 502', 500)).toBe('上游返回 502')
    expect(visibleError(429, 500)).toBe('429')
  })

  it('redacts local paths and credential-shaped fragments from every shape', () => {
    expect(visibleError(new Error('打开 /opt/plugin-project/dist/index.mjs 失败'), 500)).not.toContain('/opt/plugin-project')
    expect(visibleError('C:\\Users\\me\\secret.txt 不存在', 500)).not.toContain('Users')
    expect(visibleError({ code: 'BAD', message: 'key sk-abcdefghijklmnop 被拒绝' }, 500)).not.toContain('sk-abcdefghijklmnop')
  })

  it('still reports 未知错误 when there is genuinely nothing to say', () => {
    for (const value of [undefined, null, '', '   ', {}, []]) expect(visibleError(value, 500)).toBe('未知错误')
  })

  it('honours the caller limit', () => {
    const long = 'x'.repeat(900)
    expect(clip(visibleError(new Error(long), 500), 500)).toBe(true)
    expect(clip(visibleError({ code: 'C', message: long }, 120), 120)).toBe(true)
  })
})
