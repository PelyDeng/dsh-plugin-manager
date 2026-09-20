/**
 * 生图 provider 与请求层的验证。
 *
 * 网络用替身注入。重点在三处：
 *
 * 1. **端点拼接**——中转站地址常已带 `/v1`，再拼一次会得到 `/v1/v1/...`，那是最常见的配置事故；
 * 2. **失败分类**——缺配置（503）与上游挂了（502）在运维上是两件事，混在一起会让用户以为服务坏了；
 * 3. **不静默降级**——不认识的 provider 取值必须当场报错，不能回落到一个"看起来能用"的适配器。
 */

import { describe, expect, it } from 'vitest'
import { createOpenAiImagesProvider } from '../src/image/openai-images.ts'
import { createImageProvider } from '../src/image/index.ts'
import { ImageGenerationError } from '../src/image/spec.ts'
import type { HuiyuEnvironment } from '../src/env.ts'

/** 造一个返回 base64 图片的成功响应体。 */
function b64Response(payload = 'aGVsbG8='): string {
  return JSON.stringify({ data: [{ b64_json: payload }] })
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init: init ?? {}, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return respond(url, init ?? {})
  }) as unknown as typeof fetch
  return { impl, calls }
}

const OPTIONS = {
  baseUrl: 'https://relay.example.com',
  apiKey: 'sk-test',
  model: 'gpt-image-1.5',
}

describe('端点拼接', () => {
  it('裸域名补上 /v1/images/generations', async () => {
    const { impl, calls } = fakeFetch(() => new Response(b64Response(), { status: 200 }))
    await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl }).generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    expect(calls[0]?.url).toBe('https://relay.example.com/v1/images/generations')
  })

  it('已带 /v1 的地址不再重复拼一层', async () => {
    const { impl, calls } = fakeFetch(() => new Response(b64Response(), { status: 200 }))
    await createOpenAiImagesProvider({ ...OPTIONS, baseUrl: 'https://relay.example.com/v1', fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    // 拼成 /v1/v1/... 会 404，而错误信息看起来像"上游没有这个接口"。
    expect(calls[0]?.url).toBe('https://relay.example.com/v1/images/generations')
  })

  it('末尾斜杠被吃掉', async () => {
    const { impl, calls } = fakeFetch(() => new Response(b64Response(), { status: 200 }))
    await createOpenAiImagesProvider({ ...OPTIONS, baseUrl: 'https://relay.example.com/', fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    expect(calls[0]?.url).toBe('https://relay.example.com/v1/images/generations')
  })
})

describe('请求体', () => {
  it('带上模型、尺寸、张数，并要求 base64 响应', async () => {
    const { impl, calls } = fakeFetch(() => new Response(b64Response(), { status: 200 }))
    await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: '一只猫', size: '1536x864', quality: 'standard', count: 2 })
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-image-1.5',
      prompt: '一只猫',
      size: '1536x864',
      n: 2,
      response_format: 'b64_json',
    })
  })

  it('Authorization 用 Bearer', async () => {
    const { impl, calls } = fakeFetch(() => new Response(b64Response(), { status: 200 }))
    await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl }).generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })
})

describe('响应解析', () => {
  it('解码 base64 成字节', async () => {
    const { impl } = fakeFetch(() => new Response(b64Response(), { status: 200 }))
    const result = await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    expect(result.model).toBe('gpt-image-1.5')
    expect(Buffer.from(result.images[0]?.data as Uint8Array).toString()).toBe('hello')
    expect(result.images[0]?.mediaType).toBe('image/png')
  })

  it('只给 url 不给 base64 时报"不支持"而不是悄悄去下载', async () => {
    // 静默改成下载会让"为什么慢了一倍"无从解释，也会掩盖上游没按 response_format 办这件事。
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ data: [{ url: 'https://x/y.png' }] }), { status: 200 }))
    const error = await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImageGenerationError)
    expect((error as ImageGenerationError).failure).toBe('unsupported')
  })

  it('空的 data 数组按上游失败处理', async () => {
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const error = await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).failure).toBe('upstream')
  })

  it('非法 base64 被拒绝（而不是解出一张坏图）', async () => {
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ data: [{ b64_json: '!!!not-base64!!!' }] }), { status: 200 }))
    const error = await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).message).toContain('base64')
  })

  it('响应不是 JSON 时报上游失败并带片段', async () => {
    const { impl } = fakeFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 200 }))
    const error = await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).failure).toBe('upstream')
    expect((error as ImageGenerationError).message).toContain('502 Bad Gateway')
  })
})

describe('失败分类', () => {
  it('401 归到"未配置"——对用户就是去改密钥', async () => {
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 }))
    const error = await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).failure).toBe('unconfigured')
    expect((error as ImageGenerationError).message).toContain('invalid api key')
  })

  it('500 归到"上游失败"', async () => {
    const { impl } = fakeFetch(() => new Response('boom', { status: 500 }))
    const error = await createOpenAiImagesProvider({ ...OPTIONS, fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).failure).toBe('upstream')
  })

  it('缺 apiKey 时直接以"未配置"拒绝，不发请求', async () => {
    const { impl, calls } = fakeFetch(() => new Response(b64Response(), { status: 200 }))
    const error = await createOpenAiImagesProvider({ ...OPTIONS, apiKey: '', fetchImpl: impl })
      .generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).failure).toBe('unconfigured')
    expect((error as ImageGenerationError).message).toContain('HUIYU_IMAGE_API_KEY')
    expect(calls).toHaveLength(0)
  })
})

describe('provider 选择', () => {
  const environment = (provider: string): HuiyuEnvironment => ({
    minio: { endpoint: 'http://127.0.0.1:3101', bucket: 'huiyu', region: 'us-east-1', accessKey: 'a', secretKey: 'b', publicBaseUrl: 'https://img.pelycloud.com' },
    image: { provider, baseUrl: 'https://relay.example.com', model: 'gpt-image-1.5', apiKey: '', coverStyle: '' },
  })

  it('OpenAI 兼容族建出可用 provider（密钥由参数传入）', () => {
    const provider = createImageProvider(environment('openai-images'), 'sk-key')
    expect(provider.kind).toBe('openai-images')
    expect(provider.available()).toEqual({ ok: true })
  })

  it('未识别的取值明确报错并列出可用取值，不回落默认适配器', () => {
    const provider = createImageProvider(environment('some-unknown-vendor'), 'sk-key')
    const state = provider.available()
    expect(state.ok).toBe(false)
    expect(state.error).toContain('some-unknown-vendor')
    expect(state.error).toContain('openai-images')
  })
})
