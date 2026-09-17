/**
 * MinIO 客户端的验证。
 *
 * 网络用替身注入，所以这些用例不依赖真实 MinIO，跑在任何机器上都是确定的。重点在三个容易
 * 出错、且错了不好查的地方：
 *
 * 1. **拼出来的访问地址**——它是用户唯一能看到的东西，多一个斜杠或少一段都会 404；
 * 2. **错误分类**——"桶不存在"和"凭据没权限"对用户是完全不同的两件事；
 * 3. **available() 不抛出**——它被就绪探针调用，抛出去会把探针打成异常。
 */

import { describe, expect, it } from 'vitest'
import { createMinioClient, type MinioConfig } from '../src/minio/client.ts'
import { HuiyuError } from '../src/errors.ts'

const CONFIG: MinioConfig = {
  endpoint: 'http://127.0.0.1:3101',
  bucket: 'huiyu',
  region: 'us-east-1',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  publicBaseUrl: 'https://img.pelycloud.com',
}

const FIXED_NOW = () => new Date('2026-09-18T02:30:45.000Z')

/** 一个记下请求的替身，按需返回给定响应。 */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init: init ?? {} })
    return respond(url, init ?? {})
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('put：访问地址的拼装', () => {
  it('地址形如 <publicBaseUrl>/<bucket>/<key>', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 200 }))
    const client = createMinioClient(CONFIG, impl, FIXED_NOW)
    const result = await client.put({ key: '2026/09/18/abc.png', data: new Uint8Array([1]), contentType: 'image/png' })
    expect(result.url).toBe('https://img.pelycloud.com/huiyu/2026/09/18/abc.png')
    expect(result.key).toBe('2026/09/18/abc.png')
  })

  it('配置里的多余斜杠不会拼出双斜杠', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 200 }))
    const client = createMinioClient(
      { ...CONFIG, endpoint: 'http://127.0.0.1:3101/', bucket: '/huiyu/', publicBaseUrl: 'https://img.pelycloud.com/' },
      impl,
      FIXED_NOW,
    )
    const result = await client.put({ key: '/2026/09/18/abc.png', data: new Uint8Array([1]), contentType: 'image/png' })
    expect(result.url).toBe('https://img.pelycloud.com/huiyu/2026/09/18/abc.png')
  })

  it('上传打到内网 endpoint，且带上签名与内容类型', async () => {
    const { impl, calls } = fakeFetch(() => new Response('', { status: 200 }))
    const client = createMinioClient(CONFIG, impl, FIXED_NOW)
    await client.put({ key: '2026/09/18/abc.png', data: new Uint8Array([1]), contentType: 'image/jpeg' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:3101/huiyu/2026/09/18/abc.png')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(headers['content-type']).toBe('image/jpeg')
  })

  it('非 2xx 抛出带状态码与上游摘要的错误', async () => {
    const { impl } = fakeFetch(() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }))
    const client = createMinioClient(CONFIG, impl, FIXED_NOW)
    await expect(client.put({ key: 'a.png', data: new Uint8Array([1]), contentType: 'image/png' }))
      .rejects.toThrow(/HTTP 403/)
  })

  it('连接失败抛出可读错误而不是原始异常', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const client = createMinioClient(CONFIG, impl, FIXED_NOW)
    const error = await client.put({ key: 'a.png', data: new Uint8Array([1]), contentType: 'image/png' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HuiyuError)
    expect((error as HuiyuError).message).toContain('无法连接')
  })
})

describe('available：探测不抛出', () => {
  it('200 视为可用', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 200 }))
    expect(await createMinioClient(CONFIG, impl, FIXED_NOW).available()).toEqual({ ok: true })
  })

  it('403 也算"端点与桶都在"——那是权限问题，会在 put 时更明确地报出来', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 403 }))
    expect(await createMinioClient(CONFIG, impl, FIXED_NOW).available()).toEqual({ ok: true })
  })

  it('404 报"桶不存在"并给出怎么建', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 404 }))
    const state = await createMinioClient(CONFIG, impl, FIXED_NOW).available()
    expect(state.ok).toBe(false)
    expect(state.error).toContain('huiyu')
    expect(state.error).toContain('建桶')
  })

  it('网络异常被收成 ok:false，不抛出', async () => {
    const impl = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    const state = await createMinioClient(CONFIG, impl, FIXED_NOW).available()
    expect(state.ok).toBe(false)
    expect(state.error).toContain('不可达')
  })

  it('探测用 HEAD 打到桶路径', async () => {
    const { impl, calls } = fakeFetch(() => new Response('', { status: 200 }))
    await createMinioClient(CONFIG, impl, FIXED_NOW).available()
    expect(calls[0]?.url).toBe('http://127.0.0.1:3101/huiyu')
    expect(calls[0]?.init.method).toBe('HEAD')
  })
})
