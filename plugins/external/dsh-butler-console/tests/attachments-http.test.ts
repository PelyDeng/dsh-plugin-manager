/**
 * 附件的对外边界：上传、下载、删除、列表、从链接取回。
 *
 * 走**真路由 + 真响应体**：这里要守的是"谁能读到什么"。附件按 owner 落库，下载路由按当前登录
 * 身份过滤——猜 id 读不到别人的东西，这一点必须在 HTTP 这一层验证，而不是在服务对象上验证。
 *
 * 宿主的附件服务用替身（内容按内容寻址存在内存里）：解析、上限、归属都是本插件的事，
 * 而"字节存在哪"是宿主的事，这里不假装验证它。
 */
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import { STORAGE_SCHEMA_VERSION } from '../src/storage/postgres.ts'
import { SqliteButlerStorage, TaskStore } from './helpers/sqlite-test-store.ts'
import { installWeb } from '../src/web.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const alice: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }
const bob: Actor = { namespace: 'user', userId: 'bob', sessionId: 'bob-login' }

const opened: string[] = []
afterEach(() => {
  for (const path of opened.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${path}${suffix}`, { force: true }) } catch { /* 留给系统清理 */ }
    }
  }
})

/** 响应替身：JSON 与二进制两条路都要记下正文。 */
class FakeResponse {
  status = 0
  headers: Record<string, string> = {}
  text = ''
  raw: Buffer = Buffer.alloc(0)

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status
    this.headers = headers
  }

  end(chunk?: string | Buffer): void {
    if (chunk === undefined) return
    if (typeof chunk === 'string') this.text = chunk
    else this.raw = chunk
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.text) as Record<string, unknown>
  }
}

/** 宿主附件服务替身：按内容寻址存字节，读回来逐字节相同。 */
function fakeProvider() {
  const objects = new Map<string, Uint8Array>()
  let counter = 0
  return {
    objects,
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxImageBytes: 1024 * 1024 },
    async saveFileStream(input: { data: AsyncIterable<Uint8Array>, name: string }) {
      const chunks: Buffer[] = []
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const attachmentId = `file-${++counter}`
      objects.set(attachmentId, new Uint8Array(bytes))
      return { attachmentId, name: input.name, bytes: bytes.length }
    },
    async *readFileStream(ref: { attachmentId: string }) {
      yield objects.get(ref.attachmentId) ?? new Uint8Array()
    },
    async saveImage(input: { data: Uint8Array, mediaType: string, name?: string }) {
      const attachmentId = `img-${++counter}`
      objects.set(attachmentId, input.data)
      return { attachmentId, mediaType: input.mediaType, bytes: input.data.length, width: 2, height: 2, ...(input.name === undefined ? {} : { name: input.name }) }
    },
    async readImage(ref: { attachmentId: string }) {
      return { ref, data: objects.get(ref.attachmentId) ?? new Uint8Array() }
    },
  }
}

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

async function fixture(options: { provider?: unknown, maxAttachmentBytes?: number, maxAttachmentsPerMessage?: number } = {}) {
  const path = join(tmpdir(), `butler-att-http-${randomUUID()}.sqlite`)
  opened.push(path)
  const store = new TaskStore(path)
  const provider = options.provider ?? fakeProvider()
  const config = {
    accessMode: 'authenticated',
    publicOrigin: 'http://localhost:3080',
    routePrefix: '/butler',
    maxRequestBodyBytes: 65536,
    maxMessageChars: 8000,
    maxResultChars: 8000,
    maxAvatarBytes: 262144,
    maxAttachmentBytes: options.maxAttachmentBytes ?? 1_048_576,
    maxAttachmentsPerMessage: options.maxAttachmentsPerMessage ?? 5,
    attachmentParseChars: 10_000,
    attachmentBriefChars: 2000,
    visionModel: '',
    attachmentFetchTimeoutMs: 5000,
    subtaskTimeoutMs: 10_000,
    maxConversationEvents: 50,
  } as Config
  const routes = new Map<string, Handler>()
  const access = {
    mode: 'authenticated',
    ready() {},
    resolve: (request: IncomingMessage) => (request.headers['x-test-user'] === 'bob' ? bob : alice),
    assert() {},
  } as unknown as Access
  const ctx = {
    effect: (run: () => unknown) => { run(); return () => {} },
    on: () => () => {},
    get: (name: string) => (name === 'attachments' ? provider : undefined),
    webServer: {
      register: (route: { kind: string, path: string, handler: unknown }) => {
        routes.set(`${route.kind} ${route.path}`, route.handler as Handler)
        return () => {}
      },
    },
    root: { emit() {} },
  } as unknown as Context
  const console_ = new ButlerConsole(ctx, config, access, new SqliteButlerStorage(store), '')
  await installWeb(ctx, config, console_, access, { ready: true, schemaVersion: STORAGE_SCHEMA_VERSION })

  const call = async (route: string, request: Partial<IncomingMessage> & { body?: Buffer }): Promise<FakeResponse> => {
    const handler = routes.get(route)
    if (handler === undefined) throw new Error(`路由没有注册：${route}`)
    const response = new FakeResponse()
    const source = request.body === undefined ? Readable.from([]) : Readable.from([request.body])
    const incoming = source as unknown as IncomingMessage
    incoming.method = request.method ?? 'GET'
    incoming.url = request.url ?? '/'
    incoming.headers = request.headers ?? {}
    await handler(incoming, response as unknown as ServerResponse)
    return response
  }

  return { store, provider, call, routes }
}

const upload = (name: string, body: Buffer, headers: Record<string, string> = {}) => ({
  method: 'POST',
  url: `/butler/attachments?name=${encodeURIComponent(name)}`,
  headers: { 'content-type': 'text/plain', 'content-length': String(body.length), ...headers },
  body,
})

describe('附件上传与读取', () => {
  it('文本文件上传后立刻解析，能下载回逐字节相同的原文件', async () => {
    const f = await fixture()
    const bytes = Buffer.from('第一行\n第二行\n第三行', 'utf8')
    const uploaded = await f.call('exact /butler/attachments', upload('需求.txt', bytes))
    expect(uploaded.status).toBe(200)
    const item = uploaded.json().item as Record<string, unknown>
    expect(item.status).toBe('ready')
    expect(item.kind).toBe('text')
    expect(item.unit).toBe('行')
    expect(item.totalUnits).toBe(3)
    expect(item.bytes).toBe(bytes.length)
    // 内部引用不外泄：`original` 是宿主附件服务的结构，页面拿不到它。
    expect(item).not.toHaveProperty('original')
    expect(item).not.toHaveProperty('parsed')

    const downloaded = await f.call('exact /butler/attachments', {
      method: 'GET',
      url: `/butler/attachments?id=${String(item.id)}`,
    })
    expect(downloaded.status).toBe(200)
    expect(downloaded.raw.equals(bytes)).toBe(true)
    expect(downloaded.headers['content-disposition']).toContain('attachment')
  })

  it('图片走宿主的图片通道，媒体类型取引用里核验过的那个', async () => {
    const f = await fixture()
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
    // 声明的类型是 text/plain（客户端在撒谎），按字节判出来仍是图片。
    const uploaded = await f.call('exact /butler/attachments', upload('图.png', png))
    const item = uploaded.json().item as Record<string, unknown>
    expect(item.kind).toBe('image')
    expect(item.mediaType).toBe('image/png')
    // 图片不在上传时读内容：当前对话模型收图片时根本不需要读，读了是白花钱。
    expect(item.unit).toBeUndefined()
  })

  it('读不出内容的格式照收，状态照实标出来', async () => {
    const f = await fixture()
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])
    const item = (await f.call('exact /butler/attachments', upload('东西.zip', zip))).json().item as Record<string, unknown>
    expect(item.status).toBe('ready')
    expect(String(item.message)).toContain('读不出文字')
  })

  it('解析失败不回 4xx，稳稳地带着原因回来', async () => {
    const f = await fixture()
    // 名字说 json，内容不是：解析以 corrupt 收场，记录带着原因回到页面。
    const item = (await f.call('exact /butler/attachments', upload('假的.json', Buffer.from('{ 不是 json')))).json().item as Record<string, unknown>
    expect(item.status).toBe('failed')
    expect(String(item.message)).toContain('JSON')
  })

  it('字节说了算：扩展名说是 PDF、内容其实是文本，就按文本读', async () => {
    const f = await fixture()
    const item = (await f.call('exact /butler/attachments', upload('其实是文本.pdf', Buffer.from('第一行\n第二行')))).json().item as Record<string, unknown>
    expect(item.kind).toBe('text')
    expect(item.status).toBe('ready')
  })

  it('缺文件名、空正文、超限各有专属状态码', async () => {
    const f = await fixture({ maxAttachmentBytes: 1024 })
    expect((await f.call('exact /butler/attachments', { method: 'POST', url: '/butler/attachments' })).status).toBe(400)
    expect((await f.call('exact /butler/attachments', upload('空的.txt', Buffer.alloc(0)))).status).toBe(400)
    expect((await f.call('exact /butler/attachments', upload('大的.txt', Buffer.alloc(4096, 0x41)))).status).toBe(413)
  })

  it('待发附件攒到上限就不再收', async () => {
    const f = await fixture({ maxAttachmentsPerMessage: 2 })
    expect((await f.call('exact /butler/attachments', upload('一.txt', Buffer.from('a')))).status).toBe(200)
    expect((await f.call('exact /butler/attachments', upload('二.txt', Buffer.from('b')))).status).toBe(200)
    const third = await f.call('exact /butler/attachments', upload('三.txt', Buffer.from('c')))
    expect(third.status).toBe(413)
    expect(String(third.json().code)).toBe('attachment_limit')
  })
})

describe('归属：猜 id 读不到别人的东西', () => {
  it('上传后只有本人列得到、下载得到；换个人一律 404', async () => {
    const f = await fixture()
    const item = (await f.call('exact /butler/attachments', upload('私有.txt', Buffer.from('悄悄话')))).json().item as Record<string, unknown>
    const id = String(item.id)

    const mine = await f.call('exact /butler/attachments/list', { method: 'GET', url: '/butler/attachments/list' })
    expect((mine.json().items as unknown[]).length).toBe(1)

    const others = await f.call('exact /butler/attachments/list', {
      method: 'GET',
      url: '/butler/attachments/list',
      headers: { 'x-test-user': 'bob' },
    })
    expect((others.json().items as unknown[]).length).toBe(0)

    const stolen = await f.call('exact /butler/attachments', {
      method: 'GET',
      url: `/butler/attachments?id=${id}`,
      headers: { 'x-test-user': 'bob' },
    })
    expect(stolen.status).toBe(404)
    expect(String(stolen.json().code)).toBe('attachment_not_found')

    const deleted = await f.call('exact /butler/attachments', {
      method: 'DELETE',
      url: `/butler/attachments?id=${id}`,
      headers: { 'x-test-user': 'bob' },
    })
    expect(deleted.status).toBe(404)
  })

  it('删除之后列表里没有了，也读不到原文件', async () => {
    const f = await fixture()
    const item = (await f.call('exact /butler/attachments', upload('删掉的.txt', Buffer.from('x')))).json().item as Record<string, unknown>
    const id = String(item.id)
    expect((await f.call('exact /butler/attachments', { method: 'DELETE', url: `/butler/attachments?id=${id}` })).status).toBe(200)
    const listed = await f.call('exact /butler/attachments/list', { method: 'GET', url: '/butler/attachments/list' })
    expect((listed.json().items as unknown[]).length).toBe(0)
    expect((await f.call('exact /butler/attachments', { method: 'GET', url: `/butler/attachments?id=${id}` })).status).toBe(404)
  })
})

describe('从链接取回', () => {
  const post = (url: string, headers: Record<string, string> = {}) => ({
    method: 'POST',
    url: '/butler/attachments/url',
    headers: { 'content-type': 'application/json', 'content-length': '64', ...headers },
    body: Buffer.from(JSON.stringify({ url }), 'utf8'),
  })

  it('非 http(s) 与内网地址在发请求之前就被拒', async () => {
    const f = await fixture()
    const scheme = await f.call('exact /butler/attachments/url', post('file:///etc/passwd'))
    expect(scheme.status).toBe(400)
    expect(String(scheme.json().code)).toBe('attachment_fetch_url_invalid')

    const internal = await f.call('exact /butler/attachments/url', post('http://127.0.0.1:7780/'))
    expect(internal.status).toBe(400)
    expect(String(internal.json().code)).toBe('attachment_fetch_url_invalid')
  })

  it('空地址被拒', async () => {
    const f = await fixture()
    const empty = await f.call('exact /butler/attachments/url', post('   '))
    expect(empty.status).toBe(400)
    expect(String(empty.json().code)).toBe('missing_field')
  })
})

describe('契约：上限随 /identity 下发，/chat 收附件 id', () => {
  it('/identity 带上附件的两个上限', async () => {
    const f = await fixture({ maxAttachmentBytes: 2048, maxAttachmentsPerMessage: 3 })
    const body = (await f.call('exact /butler/identity', { method: 'GET', url: '/butler/identity' })).json()
    expect(body.maxAttachmentBytes).toBe(2048)
    expect(body.maxAttachmentsPerMessage).toBe(3)
  })

  it('/chat 的 attachmentIds 超过上限时在受理之前就被拒', async () => {
    const f = await fixture({ maxAttachmentsPerMessage: 2 })
    const body = Buffer.from(JSON.stringify({
      conversationId,
      message: '干活',
      attachmentIds: ['a', 'b', 'c'],
    }), 'utf8')
    const rejected = await f.call('exact /butler/chat', {
      method: 'POST',
      url: '/butler/chat',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      body,
    })
    expect(rejected.status).toBe(400)
    expect(String(rejected.json().code)).toBe('invalid_field')
  })
})
