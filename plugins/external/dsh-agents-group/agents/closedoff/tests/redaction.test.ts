import { describe, expect, it } from 'vitest'
import { maskIdCard, maskPhone, redactJsonValue, redactVisibleText } from '../src/redaction.ts'

describe('sensitive value redaction', () => {
  it('masks phone and identity values deterministically', () => {
    expect(maskPhone('138-0013-8000')).toBe('138****8000')
    expect(maskIdCard('110101-19900101-1234')).toBe('110101********1234')
  })

  it('redacts persisted text and nested media fields', () => {
    expect(redactVisibleText('电话 13800138000，证件 110101199001011234，地址 https://private.invalid/a')).toBe(
      '电话 138****8000，证件 110101********1234，地址 [地址已隐藏]',
    )
    expect(redactVisibleText('电话 138-0013-8000；证件 110101-19900101-1234，地址 https://private.invalid/a，保留此句')).toBe(
      '电话 138****8000；证件 110101********1234，地址 [地址已隐藏]，保留此句',
    )
    expect(redactVisibleText('抓拍文件 /media/capture/secret.m3u8?token=value，继续核验')).toBe(
      '抓拍文件 [地址已隐藏]，继续核验',
    )
    expect(redactVisibleText('抓拍 /media/play?token=x，备用 //private.invalid/live')).toBe(
      '抓拍 [地址已隐藏]，备用 [地址已隐藏]',
    )
    expect(redactJsonValue({
      userPhone: '13800138000',
      videoAddress: 'wss://private.invalid/live',
      nested: [{ idCard: '110101199001011234', name: '示例' }],
    })).toEqual({
      userPhone: '138****8000',
      videoAddress: '已隐藏',
      nested: [{ idCard: '110101********1234', name: '示例' }],
    })
  })
})
