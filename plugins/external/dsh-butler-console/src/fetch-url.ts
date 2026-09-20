/**
 * 有界抓取：把一个 http(s) 地址安全地取成字节。
 *
 * ## 为什么自己写，而不用宿主的 `ctx.web.fetch`
 *
 * 宿主那个能力是给"读一个网页"设计的：它的返回体是**闭合联合，只有 `html` 和 `text` 两种**，
 * 二进制内容类型直接判为不支持（`web-fetch-http/src/policy.ts:78-84`）。也就是说图片、PDF 的
 * 直链它拿不到——而用户往输入框里粘一个图床链接是最常见的用法之一。
 *
 * ## 防护口径（每一条都是必需的，不是"顺手加的"）
 *
 * 1. **只允许 http / https**：`file:`、`data:` 这类协议不该在服务端被解析。
 * 2. **地址先校验再钉住**：域名解析出的**每一个**地址都必须是公网地址；随后连接**只用这批
 *    已校验的地址**（`lookup` 交给固定的应答集），不再让系统解析第二次——这正是 DNS 重绑定
 *    的入口：先解析一次拿到公网地址过检，连接时再解析一次拿内网地址。宿主的实现也这么做
 *    （`web-fetch-http/src/network.ts:3-4`）。
 * 3. **只跟同源重定向**，且跳数有上限：跨源跳转等于让被请求的站点决定我们下一个去连谁。
 * 4. **字节上限按实际读到的量算**，并且提前拒 `content-length` 超限的响应。
 * 5. **超时**，且**不许压缩**：`accept-encoding: identity`——压缩体是个现成的解压炸弹，
 *    不接它就不必防它。
 * 6. **内容类型白名单**：拿到的是网页/文档/图片才收，其余（可执行文件、压缩包）直接拒。
 *
 * ## 不做的事（如实记下）
 *
 * 不跟随跨源跳转、不代发凭据（不带 cookie / authorization）、不复用任何登录态——这个请求出去的
 * 身份就是一个匿名客户端，与宿主 `web-fetch-http` 的定位一致。
 */

import { lookup as systemLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { Buffer } from 'node:buffer'

/** 一次抓取的结果。 */
export interface FetchedResource {
  /** 最终 URL（跟过同源跳转之后）。 */
  readonly url: string
  /** 猜测的文件名：取自地址最后一段，取不到就用内容类型推一个。 */
  readonly name: string
  /** 响应声明的媒体类型（去掉参数、小写）。 */
  readonly mediaType: string
  readonly bytes: Uint8Array
}

/** 抓取失败的原因分类。调用方按 `code` 决定 HTTP 状态与页面文案。 */
export type FetchFailureCode =
  /** 地址本身不合法：不是 http(s)、太长、或者是个内网/本机地址。 */
  | 'url_invalid'
  /** 域名解析不出来。 */
  | 'dns_failed'
  /** 连不上、超时、TLS 失败。 */
  | 'unreachable'
  /** 对方给的状态码不是 2xx。 */
  | 'http_error'
  /** 响应体超过上限（或声称要超过）。 */
  | 'too_large'
  /** 内容类型不在白名单里。 */
  | 'unsupported_type'
  /** 跳转次数超限，或跳到了别的源。 */
  | 'redirect_refused'

/** 一次抓取失败。 */
export class FetchFailure extends Error {
  constructor(
    readonly code: FetchFailureCode,
    message: string,
    /** 对方给的状态码（`http_error` 时有值）。 */
    readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'FetchFailure'
  }
}

/** 域名解析面；只为测试替换。 */
export type AddressResolver = (hostname: string) => Promise<readonly string[]>

/** 抓取选项。 */
export interface FetchOptions {
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  /** 允许的媒体类型前缀白名单，例如 `['image/', 'application/pdf', 'text/']`。 */
  readonly allowedMediaTypes?: readonly string[] | undefined
  /** 最多跟几跳同源重定向。 */
  readonly maxRedirects?: number | undefined
  /** 测试注入。 */
  readonly resolve?: AddressResolver | undefined
}

const DEFAULT_MAX_REDIRECTS = 3
/** 地址长度上限。够长的 URL 已经不可能是用户手打的，更像是构造出来的。 */
const MAX_URL_LENGTH = 2048

/** 缺省的域名解析：拿全部 A/AAAA 记录。 */
const defaultResolve: AddressResolver = async (hostname) => {
  const answers = await systemLookup(hostname, { all: true, order: 'verbatim' })
  return answers.map(answer => answer.address)
}

/**
 * 这个地址是不是公网地址。
 *
 * 判据是"**不在**任何私有 / 保留 / 回环 / 链路本地 / 组播段里"，所以未知的新段默认被拒——
 * 漏判一个私有段比误拒一个公网段严重得多。
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPublicV4(address)
  if (version === 6) return isPublicV6(address)
  return false
}

function isPublicV4(address: string): boolean {
  const parts = address.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a = 0, b = 0, c = 0] = parts
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

function isPublicV6(address: string): boolean {
  const text = address.toLowerCase().split('%')[0] ?? ''
  if (text === '::' || text === '::1') return false
  // IPv4 映射地址（`::ffff:127.0.0.1`）：按里面那个 v4 判，别让回环从这里溜进来。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
  if (mapped?.[1] !== undefined) return isPublicV4(mapped[1])
  // NAT64（`64:ff9b::/96`）同样按内嵌的 v4 判。
  const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
  if (nat64?.[1] !== undefined) return isPublicV4(nat64[1])
  const head = Number.parseInt(text.split(':')[0] ?? '', 16)
  if (!Number.isInteger(head)) return false
  if ((head & 0xfe00) === 0xfc00) return false // fc00::/7 唯一本地地址
  if ((head & 0xffc0) === 0xfe80) return false // fe80::/10 链路本地
  if ((head & 0xff00) === 0xff00) return false // ff00::/8 组播
  if (head === 0x2001 && (text.startsWith('2001:db8') || text.startsWith('2001:0:'))) return false
  return true
}

/** 解析并校验地址；任何一项不过就抛 `url_invalid`。 */
export async function assertPublicUrl(raw: string, resolve: AddressResolver): Promise<URL> {
  if (raw.length > MAX_URL_LENGTH) throw new FetchFailure('url_invalid', '地址太长了')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new FetchFailure('url_invalid', '这不是一个合法的地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchFailure('url_invalid', '只支持 http 与 https 地址')
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  // IP 字面量不必解析，直接判；这样"直接写内网 IP"这条最省事的攻击也挡住了。
  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) throw new FetchFailure('url_invalid', '这个地址指向内网或本机，不接受')
    return url
  }
  let addresses: readonly string[]
  try {
    addresses = await resolve(hostname)
  } catch {
    throw new FetchFailure('dns_failed', '域名解析失败')
  }
  if (addresses.length === 0) throw new FetchFailure('dns_failed', '域名解析不到地址')
  // 全部必须是公网地址：只要有一条私有地址，这个域名就可能是"内外双解析"的那类，整条拒掉。
  if (!addresses.every(isPublicAddress)) throw new FetchFailure('url_invalid', '这个域名解析到了内网地址，不接受')
  return url
}

/** 从地址最后一段猜文件名；取不到给空串。 */
export function fileNameFromUrl(url: URL, mediaType: string): string {
  const leaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
  const safe = leaf.replace(/[\\/\u0000-\u001f]/gu, '').trim()
  if (safe !== '') return safe.slice(0, 180)
  const extension = MEDIA_EXTENSIONS[mediaType] ?? 'bin'
  return `下载的内容.${extension}`
}

/** 没有文件名时按内容类型补一个扩展名。 */
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/html': 'html',
}

/** 内容类型是否被接受。白名单里给的是前缀（`image/`、`text/`）。 */
export function acceptsMediaType(contentType: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime === '') return false
  return allowed.some(prefix => mime === prefix || mime.startsWith(prefix))
}

/** 一次已在途的响应。 */
interface Attempt {
  readonly response: IncomingMessage
  /** 读完整响应体，超限抛 `too_large`。 */
  read(): Promise<Buffer>
}

/**
 * 发起一次请求，**连接只用已校验的地址**。
 *
 * `servername` 与 `host` 头都写回原域名：TLS 证书仍然按真正的域名校验，对方也仍然看到自己的
 * 域名——这一点不能省，否则 HTTPS 校验就形同虚设。
 */
function attempt(
  url: URL,
  address: string,
  options: FetchOptions,
  signal: AbortSignal,
): Promise<Attempt> {
  return new Promise<Attempt>((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const send = isHttps ? httpsRequest : httpRequest
    const request = send({
      // 连的是**已校验的地址**，不是域名：这样系统不会在连接时再解析一次。
      host: address,
      port: url.port === '' ? (isHttps ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        host: url.host,
        accept: '*/*',
        // 不接压缩：压缩体是现成的解压炸弹，不接它就不必防它。
        'accept-encoding': 'identity',
        'user-agent': 'dsh-butler-attachment/1.0',
      },
      ...(isHttps ? { servername: url.hostname } : {}),
      signal,
    }, (response) => {
      resolve({
        response,
        read: () => readBounded(response, options.maxBytes, signal),
      })
    })
    request.on('error', () => { reject(new FetchFailure('unreachable', '连不上这个地址')) })
    request.end()
  })
}

/** 读响应体，边读边数字节；超过上限立刻断开。 */
function readBounded(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(response.headers['content-length'] ?? '0')
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy()
      reject(new FetchFailure('too_large', '对方声称的内容超过大小上限'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        response.destroy()
        reject(new FetchFailure('too_large', '内容超过大小上限'))
        return
      }
      chunks.push(chunk)
    })
    response.on('error', () => { reject(new FetchFailure('unreachable', '读取内容时连接中断')) })
    response.on('end', () => {
      if (signal.aborted) {
        reject(new FetchFailure('unreachable', '请求已取消'))
        return
      }
      resolve(Buffer.concat(chunks))
    })
  })
}

/**
 * 抓一个地址。
 *
 * @throws FetchFailure 各种失败，按 `code` 分类。
 */
export async function fetchPublicResource(raw: string, options: FetchOptions): Promise<FetchedResource> {
  const resolve = options.resolve ?? defaultResolve
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])

  let current = await assertPublicUrl(raw, resolve)
  // 同源基准取第一次的地址：跳转只允许在这个源里绕，绕出这个源就停。
  const origin = current.origin
  for (let hop = 0; ; hop += 1) {
    const hostname = current.hostname.replace(/^\[|\]$/gu, '')
    // 每一跳都重新校验：跳转目标虽然是我们自己跟的，它同样是一个新的输入。
    const addresses = isIP(hostname) !== 0 ? [hostname] : await resolve(hostname)
    if (addresses.length === 0) throw new FetchFailure('dns_failed', '域名解析不到地址')
    if (!addresses.every(isPublicAddress)) throw new FetchFailure('url_invalid', '这个地址指向内网或本机，不接受')

    let outcome: Attempt | undefined
    let redirect: URL | undefined
    let failure: unknown
    for (const address of addresses) {
      try {
        const candidate = await attempt(current, address, options, signal)
        const status = candidate.response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          // 跳转：这条响应体我们不要，放掉它，只留 Location。
          candidate.response.resume()
          const location = candidate.response.headers.location
          if (location === undefined) throw new FetchFailure('http_error', '对方给了跳转但没有给目标', status)
          const target = new URL(location, current)
          // 只跟同源：跨源跳转让被请求的站点决定我们下一个去连谁。
          if (target.origin !== origin) throw new FetchFailure('redirect_refused', '对方要求跳到别的站点，已停止')
          redirect = target
          break
        }
        outcome = candidate
        break
      } catch (error) {
        // 只有"连不上"才换下一个地址试（这台机器有 v6 也有 v4，一条不通不等于域名不通）；
        // 地址不合法、跳转被拒这些是结论，重试没有意义。
        if (error instanceof FetchFailure && error.code !== 'unreachable') throw error
        failure = error
      }
    }

    if (redirect !== undefined) {
      if (hop >= maxRedirects) throw new FetchFailure('redirect_refused', '跳转次数太多，已停止')
      current = redirect
      continue
    }
    if (outcome === undefined) throw failure ?? new FetchFailure('unreachable', '连不上这个地址')

    const { response, read } = outcome
    const status = response.statusCode ?? 0
    if (status < 200 || status >= 300) {
      response.resume()
      throw new FetchFailure('http_error', `对方返回 ${status}`, status)
    }
    const mediaType = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!acceptsMediaType(mediaType, options.allowedMediaTypes)) {
      response.resume()
      throw new FetchFailure('unsupported_type', mediaType === '' ? '对方没有说明内容类型' : `不接受 ${mediaType} 这类内容`)
    }
    const bytes = await read()
    return {
      url: current.href,
      name: fileNameFromUrl(current, mediaType),
      mediaType: mediaType === '' ? 'application/octet-stream' : mediaType,
      bytes: new Uint8Array(bytes),
    }
  }
}

/**
 * 把 HTML 粗略剥成文字。
 *
 * **明确说清它有多粗**：只丢掉 `script` / `style` / 注释、把标签换成空白、收拢连续空白、还原
 * 五个基本实体。它不做正文抽取，也不解析 DOM——导航栏、页脚、广告都会留在里面。够用就够用：
 * 目标是让模型看得懂这一页在讲什么，不是排版复原。真正的正文抽取要靠模型自己判断。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, '\'')
    .replace(/&amp;/giu, '&')
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/\s*\n\s*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}
