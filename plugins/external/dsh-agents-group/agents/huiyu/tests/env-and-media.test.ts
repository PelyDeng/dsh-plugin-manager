/**
 * 私有配置解析、尺寸换算与存储归属的验证。
 *
 * 这三块都是纯函数，也都有"错了很难查"的共同点：配置读错前缀会拿到别人的凭据、尺寸写错要等
 * 到上游拒绝、归属拆错会让记录串到另一个人名下。
 */

import { describe, expect, it } from 'vitest'
import { EnvConfError, parseEnvConf } from '../src/env.ts'
import { bannerSize, dimensionsOf, resolveSize, sizeNames } from '../src/media/size.ts'
import { ownerKey, ownerOf } from '../src/store.ts'

/** 一份完整的、能通过校验的配置。用例在它上面做单点变化。 */
const COMPLETE = [
  'HUIYU_MINIO_ENDPOINT=http://127.0.0.1:3101',
  'HUIYU_MINIO_BUCKET=huiyu',
  'HUIYU_MINIO_ACCESS_KEY=ak',
  'HUIYU_MINIO_SECRET_KEY=sk',
  'HUIYU_PUBLIC_BASE_URL=https://img.pelycloud.com',
  'HUIYU_IMAGE_BASE_URL=https://img.ciyuan.fast',
  'HUIYU_IMAGE_MODEL=gpt-image-2',
].join('\n')

describe('env.conf 解析', () => {
  it('完整配置解析成功', () => {
    const env = parseEnvConf(COMPLETE)
    expect(env.minio.endpoint).toBe('http://127.0.0.1:3101')
    expect(env.minio.bucket).toBe('huiyu')
    expect(env.minio.publicBaseUrl).toBe('https://img.pelycloud.com')
    expect(env.image.provider).toBe('ciyuan-images')
    expect(env.image.model).toBe('gpt-image-2')
  })

  it('生图密钥不是必填——它由 DSH 凭据系统提供', () => {
    // 把密钥写进 env.conf 会让它随配置进私有库；正常路径是凭据服务。
    const env = parseEnvConf(COMPLETE)
    expect(env.image.apiKey).toBe('')
  })

  it('env.conf 里显式给了密钥时也会读进来（独立开发环境的退路）', () => {
    expect(parseEnvConf(`${COMPLETE}\nHUIYU_IMAGE_API_KEY=sk-local`).image.apiKey).toBe('sk-local')
  })

  it('region 缺省为 us-east-1（MinIO 默认区域）', () => {
    expect(parseEnvConf(COMPLETE).minio.region).toBe('us-east-1')
    expect(parseEnvConf(`${COMPLETE}\nHUIYU_MINIO_REGION=cn-north-1`).minio.region).toBe('cn-north-1')
  })

  it('只认 HUIYU_ 前缀：同文件里别人的段不会被读进来', () => {
    // 这是关键隔离——群组下所有子 Agent 共用一份 env.conf，取错前缀就拿到别人的凭据。
    const mixed = [
      'CLOSEDOFF_BASE_URL=https://gateway.example/',
      'CLOSEDOFF_USERNAME=someone',
      'AGENTS_GROUP_BLOG={"schemaVersion":1}',
      'AGENTS_GROUP_PG_DSN=postgresql://u:p@h:5432/dsh',
      COMPLETE,
    ].join('\n')
    const env = parseEnvConf(mixed)
    expect(env.minio.endpoint).toBe('http://127.0.0.1:3101')
    // 没有 HUIYU_ 之外的键泄漏进结果。
    expect(JSON.stringify(env)).not.toContain('someone')
    expect(JSON.stringify(env)).not.toContain('gateway.example')
    expect(JSON.stringify(env)).not.toContain('postgresql://')
  })

  it('注释与空行不影响解析', () => {
    const withComments = ['# 绘语配置', '', '# --- MinIO ---', COMPLETE, ''].join('\n')
    expect(parseEnvConf(withComments).minio.bucket).toBe('huiyu')
  })

  it('必填键缺失时抛出，且错误里带键名', () => {
    const missing = COMPLETE.split('\n').filter(line => !line.startsWith('HUIYU_MINIO_BUCKET')).join('\n')
    const error = (() => { try { parseEnvConf(missing); return undefined } catch (e: unknown) { return e } })()
    expect(error).toBeInstanceOf(EnvConfError)
    expect((error as EnvConfError).key).toBe('HUIYU_MINIO_BUCKET')
    expect((error as Error).message).toContain('HUIYU_MINIO_BUCKET')
  })

  it('取值仍是 REPLACE_ME 时按缺失处理', () => {
    // 占位符被当成真值用，错误会推迟到调用上游时才以"认证失败"出现，那时看不出是没填。
    const placeholder = COMPLETE.replace('HUIYU_MINIO_SECRET_KEY=sk', 'HUIYU_MINIO_SECRET_KEY=REPLACE_ME')
    expect(() => parseEnvConf(placeholder)).toThrow(/REPLACE_ME/)
  })

  it('错误消息不回显取值本身（那是凭据）', () => {
    // 用一个**看起来像密钥**的值，确认它不会出现在错误消息里。
    const withSecret = COMPLETE.replace('HUIYU_MINIO_SECRET_KEY=sk', 'HUIYU_MINIO_SECRET_KEY=')
    const message = (() => { try { parseEnvConf(withSecret); return '' } catch (e: unknown) { return (e as Error).message } })()
    expect(message).toContain('HUIYU_MINIO_SECRET_KEY')
    expect(message).not.toContain('sk')
  })

  it('provider 缺省为 ciyuan-images', () => {
    expect(parseEnvConf(COMPLETE).image.provider).toBe('ciyuan-images')
    expect(parseEnvConf(`${COMPLETE}\nHUIYU_IMAGE_PROVIDER=openai-images`).image.provider).toBe('openai-images')
  })
})

describe('尺寸换算', () => {
  it('语义名映射到具体像素', () => {
    expect(resolveSize('square')).toBe('1024x1024')
    expect(resolveSize('banner')).toBe('1536x864')
    expect(bannerSize()).toBe('1536x864')
  })

  it('语义名大小写不敏感', () => {
    expect(resolveSize('SQUARE')).toBe('1024x1024')
  })

  it('具体像素原样通过', () => {
    expect(resolveSize('1280x720')).toBe('1280x720')
  })

  it('缺省为方图', () => {
    expect(resolveSize(undefined)).toBe('1024x1024')
    expect(resolveSize('')).toBe('1024x1024')
  })

  it('非法取值明确报错并列出可用语义名', () => {
    const error = (() => { try { resolveSize('随便'); return undefined } catch (e: unknown) { return e as Error } })()
    expect(error?.message).toContain('尺寸无效')
    for (const name of sizeNames()) expect(error?.message).toContain(name)
  })

  it('宽高能拆出来，拆不出时不报错（尺寸已校验过，记账不该让生成失败）', () => {
    expect(dimensionsOf('1536x864')).toEqual({ width: 1536, height: 864 })
    expect(dimensionsOf('不是尺寸')).toEqual({})
  })
})

describe('存储归属的拆分', () => {
  it('ownerKey 拼成 <namespace>:<userId>', () => {
    expect(ownerKey({ namespace: 'user', userId: 'alice', sessionId: 's' })).toBe('user:alice')
  })

  it('ownerOf 切第一个冒号——userId 里可以再有冒号', () => {
    expect(ownerOf('user:alice')).toEqual({ namespace: 'user', id: 'alice' })
    expect(ownerOf('user:alice:extra')).toEqual({ namespace: 'user', id: 'alice:extra' })
  })

  it('没有冒号时整串当 namespace，不抛异常', () => {
    expect(ownerOf('bare')).toEqual({ namespace: 'bare', id: '' })
  })

  it('往返一致', () => {
    const key = ownerKey({ namespace: 'user', userId: 'u-1', sessionId: 's' })
    expect(ownerOf(key)).toEqual({ namespace: 'user', id: 'u-1' })
  })
})
