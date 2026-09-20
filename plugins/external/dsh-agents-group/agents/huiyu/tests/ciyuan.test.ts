/**
 * Ciyuan 渠道（异步任务制）与 provider 注册表的验证。
 *
 * Ciyuan 的链路有三步——创建任务、轮询到终态、下载图片——每一步都有自己的失败方式，也都能
 * 单独出错。这个文件把三步分开验，因为它们的症状在真实环境里会混在一起：
 * "生成失败"可能是创建被拒、任务跑了但失败、或者图片地址下载不到。
 *
 * 网络用替身注入，时钟与 sleep 也注入，所以用例是确定的、不等待真实时间。
 */

import { describe, expect, it } from 'vitest'
import { createCiyuanProvider, CIYUAN_KIND } from '../src/image/ciyuan.ts'
import { ImageGenerationError } from '../src/image/spec.ts'
import { createImageProvider, describeImageProviders, KNOWN_IMAGE_PROVIDERS } from '../src/image/index.ts'
import type { HuiyuEnvironment } from '../src/env.ts'

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

/**
 * 造一个按脚本应答的替身。
 *
 * `jobs` 是按轮询次数依次返回的状态序列，最后一项会被重复使用。
 */
function harness(options: {
  readonly create?: unknown
  readonly createStatus?: number
  readonly jobs?: readonly { readonly status: number; readonly body: string }[]
  readonly image?: { readonly body: Uint8Array; readonly contentType?: string; readonly status?: number }
}) {
  const calls: Call[] = []
  let poll = 0
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body })
    if (url.includes('/v1/images/generations')) {
      if (options.createStatus !== undefined && options.createStatus >= 400) {
        return new Response(String(options.create ?? ''), { status: options.createStatus })
      }
      return new Response(JSON.stringify(options.create), { status: 200 })
    }
    if (url.includes('/v1/image-jobs/')) {
      const script = options.jobs ?? [{ status: 200, body: JSON.stringify({ status: 'succeeded', result: { data: [{ url: 'https://cdn.example/a.png' }] } }) }]
      const step = script[Math.min(poll, script.length - 1)] as { status: number; body: string }
      poll += 1
      return new Response(step.body, { status: step.status })
    }
    // 下载图片
    if (options.image === undefined) return new Response('missing', { status: 404 })
    return new Response(Buffer.from(options.image.body), {
      status: options.image.status ?? 200,
      ...(options.image.contentType === undefined ? {} : { headers: { 'content-type': options.image.contentType } }),
    })
  }) as unknown as typeof fetch
  return { impl, calls, polls: () => poll }
}

/** 不等待真实时间的注入项。 */
function frozenClock() {
  let current = 1_000_000
  return {
    now: () => current,
    /** 每次 sleep 就把时钟往前推，让超时判断可测。 */
    sleep: async (ms: number) => { current += ms },
  }
}

const OK_JOBS = [{ status: 200, body: JSON.stringify({ status: 'succeeded', result: { data: [{ url: 'https://cdn.example/a.png' }] } }) }]

describe('创建任务', () => {
  it('POST 到 /v1/images/generations 并带模型、提示词、尺寸、张数', async () => {
    const { impl, calls } = harness({ create: { id: 'job-1', status: 'queued' }, jobs: OK_JOBS, image: { body: new Uint8Array([1]) } })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'gpt-image-2', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    await provider.generate({ prompt: '一只猫', size: '1536x1024', quality: 'high', count: 1 })
    const create = calls[0]
    expect(create?.url).toBe('https://img.ciyuan.fast/v1/images/generations')
    expect(create?.method).toBe('POST')
    expect(create?.body).toMatchObject({ model: 'gpt-image-2', prompt: '一只猫', size: '1536x1024', n: 1 })
  })

  it('创建任务不带请求头之外的额外字段（形如一次干净的 POST）', async () => {
    const { impl, calls } = harness({ create: { id: 'job-1' }, jobs: OK_JOBS, image: { body: new Uint8Array([1]) } })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'sk-test', fetchImpl: impl, ...frozenClock() })
    await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    // 请求体只该有四个业务字段：多带字段可能被上游拒绝，也可能改变语义。
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(['model', 'n', 'prompt', 'size'])
  })

  it('创建响应没有 id 时按上游失败处理', async () => {
    const { impl } = harness({ create: { status: 'queued' }, jobs: OK_JOBS })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImageGenerationError)
    expect((error as ImageGenerationError).message).toContain('未返回 id')
  })

  it('401 归到"未配置"——密钥错了对用户就是去改凭据', async () => {
    const { impl } = harness({ create: 'Unauthorized', createStatus: 401 })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'bad', fetchImpl: impl, ...frozenClock() })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).failure).toBe('unconfigured')
  })
})

describe('轮询任务', () => {
  it('queued / running 之后 succeeded 才停', async () => {
    const { impl, polls } = harness({
      create: { id: 'job-1' },
      jobs: [
        { status: 200, body: JSON.stringify({ status: 'queued' }) },
        { status: 200, body: JSON.stringify({ status: 'running' }) },
        { status: 200, body: JSON.stringify({ status: 'succeeded', result: { data: [{ url: 'https://cdn.example/a.png' }] } }) },
      ],
      image: { body: new Uint8Array([1, 2, 3]) },
    })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    expect(polls()).toBe(3)
  })

  it('任务 failed 时立即失败，不继续轮询', async () => {
    const { impl, polls } = harness({
      create: { id: 'job-1' },
      jobs: [{ status: 200, body: JSON.stringify({ status: 'failed', error: '内容审核未通过' }) }],
    })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).message).toContain('内容审核未通过')
    expect(polls()).toBe(1)
  })

  it('刚创建的任务短暂 404 会被重试，而不是当失败', async () => {
    // 协议来源的脚本里明确写了这条：创建后可能短暂 404，15 秒宽限期内要重试。
    const { impl, polls } = harness({
      create: { id: 'job-1' },
      jobs: [
        { status: 404, body: 'not found' },
        { status: 404, body: 'not found' },
        { status: 200, body: JSON.stringify({ status: 'succeeded', result: { data: [{ url: 'https://cdn.example/a.png' }] } }) },
      ],
      image: { body: new Uint8Array([1]) },
    })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    expect(polls()).toBe(3)
  })

  it('一直不到终态时超时，并报出最后的任务状态', async () => {
    const { impl } = harness({
      create: { id: 'job-1' },
      jobs: [{ status: 200, body: JSON.stringify({ status: 'running' }) }],
    })
    const clock = frozenClock()
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, timeoutMs: 6000, ...clock })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).message).toContain('超时')
    expect((error as ImageGenerationError).message).toContain('running')
  })

  it('任务成功但没有图片地址时按上游失败处理', async () => {
    const { impl } = harness({ create: { id: 'job-1' }, jobs: [{ status: 200, body: JSON.stringify({ status: 'succeeded', result: { data: [] } }) }] })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).message).toContain('没有返回图片地址')
  })
})

describe('下载图片', () => {
  it('拿到字节并按响应头定媒体类型', async () => {
    const { impl } = harness({ create: { id: 'job-1' }, jobs: OK_JOBS, image: { body: new Uint8Array([9, 9]), contentType: 'image/jpeg' } })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    const result = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })
    expect(result.model).toBe('m')
    expect(result.images[0]?.mediaType).toBe('image/jpeg')
    expect(Array.from(result.images[0]?.data ?? [])).toEqual([9, 9])
  })

  it('缺 content-type 时按 PNG 处理', async () => {
    const { impl } = harness({ create: { id: 'job-1' }, jobs: OK_JOBS, image: { body: new Uint8Array([1]) } })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    expect((await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 })).images[0]?.mediaType).toBe('image/png')
  })

  it('下载失败按上游失败处理', async () => {
    const { impl } = harness({ create: { id: 'job-1' }, jobs: OK_JOBS, image: { body: new Uint8Array([1]), status: 500 } })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).message).toContain('下载')
  })

  it('空字节按上游失败处理', async () => {
    const { impl } = harness({ create: { id: 'job-1' }, jobs: OK_JOBS, image: { body: new Uint8Array(0) } })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k', fetchImpl: impl, ...frozenClock() })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).message).toContain('空')
  })
})

describe('可用性', () => {
  it('缺密钥时明确说去哪配', () => {
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: '' })
    const state = provider.available()
    expect(state.ok).toBe(false)
    expect(state.error).toContain('CIYUAN_API_KEY')
  })

  it('齐备时报告可用', () => {
    expect(createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: 'k' }).available()).toEqual({ ok: true })
  })

  it('缺密钥时 generate 直接拒绝，不发请求', async () => {
    const { impl, calls } = harness({ create: { id: 'job-1' }, jobs: OK_JOBS })
    const provider = createCiyuanProvider({ baseUrl: 'https://img.ciyuan.fast', model: 'm', apiKey: '', fetchImpl: impl, ...frozenClock() })
    const error = await provider.generate({ prompt: 'x', size: '1024x1024', quality: 'high', count: 1 }).catch((e: unknown) => e)
    expect((error as ImageGenerationError).failure).toBe('unconfigured')
    expect(calls).toHaveLength(0)
  })
})

describe('provider 注册表', () => {
  const environment = (provider: string): HuiyuEnvironment => ({
    minio: { endpoint: 'http://127.0.0.1:3101', bucket: 'huiyu', region: 'us-east-1', accessKey: 'a', secretKey: 'b', publicBaseUrl: 'https://img.pelycloud.com' },
    image: { provider, baseUrl: 'https://img.ciyuan.fast', model: 'gpt-image-2', apiKey: '', coverStyle: '' },
  })

  it('已注册的 kind 都能建出可用 provider（给齐输入时）', () => {
    for (const kind of KNOWN_IMAGE_PROVIDERS) {
      const provider = createImageProvider(environment(kind), 'sk-key')
      expect(provider.kind).toBe(kind)
      expect(provider.available(), `${kind} 应可用`).toEqual({ ok: true })
    }
  })

  it('密钥来自凭据系统（作为参数传入），不是 env.conf', () => {
    // env 里 apiKey 为空，凭据侧给了值——provider 必须可用。
    expect(createImageProvider(environment(CIYUAN_KIND), 'sk-from-credentials').available()).toEqual({ ok: true })
  })

  it('env.conf 里显式给了密钥时以它为准（独立开发环境）', () => {
    const withLocalKey: HuiyuEnvironment = { ...environment(CIYUAN_KIND), image: { ...environment(CIYUAN_KIND).image, apiKey: 'sk-local' } }
    expect(createImageProvider(withLocalKey, '').available()).toEqual({ ok: true })
  })

  it('缺密钥时不可用，且原因说清去哪配', () => {
    const state = createImageProvider(environment(CIYUAN_KIND), '').available()
    expect(state.ok).toBe(false)
    expect(state.error).toContain('CIYUAN_API_KEY')
  })

  it('未识别的取值明确报错并列出全部可用取值，不回落默认适配器', () => {
    const provider = createImageProvider(environment('some-new-vendor'), 'sk')
    const state = provider.available()
    expect(state.ok).toBe(false)
    expect(state.error).toContain('some-new-vendor')
    for (const kind of KNOWN_IMAGE_PROVIDERS) expect(state.error).toContain(kind)
  })

  it('注册表可枚举，供页面与诊断展示', () => {
    const list = describeImageProviders()
    expect(list.length).toBeGreaterThanOrEqual(2)
    for (const entry of list) {
      expect(entry.kind).not.toBe('')
      expect(entry.displayName).not.toBe('')
    }
    expect(list.map(entry => entry.kind)).toContain(CIYUAN_KIND)
  })
})
