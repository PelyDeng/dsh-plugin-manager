/**
 * AWS Signature Version 4 签名（S3 用）。
 *
 * ## 为什么自己写而不引依赖
 *
 * 本项目对引依赖的口径是"必须真正删掉自有代码和测试"。MinIO 这边只需要一个操作
 * （`PutObject`），而 SigV4 是一套固定的算法——引 `minio` 或 `@aws-sdk/client-s3` 会带进
 * 一棵依赖树，换来的只是省下本文件。等以后要加删除、列举、预签名等操作时再重新评估。
 *
 * ## 实现依据
 *
 * 对照 AWS 的 SigV4 规范逐步实现。三处最容易写错、也最难从症状反推的地方，这里都单独标了：
 *
 * 1. **CanonicalRequest 的换行**：五段之间是 `\n`，最后一段（payload hash）**不留**尾换行；
 *    CanonicalHeaders 每行自带 `\n`，所以拼完头之后不要再补一个。
 * 2. **签名密钥链的嵌套顺序**：`HMAC(HMAC(HMAC(HMAC("AWS4"+key, date), region), service), "aws4_request")`
 *    ——顺序反了会得到一个"格式完全合法但服务端说签名不匹配"的请求。
 * 3. **URI 编码**：除 `A-Za-z0-9-_.~` 外全部百分号编码，**且路径里的 `/` 不编码**。
 *    用 `encodeURIComponent` 会把 `/` 编成 `%2F`，那会让对象键变成一个不存在的名字。
 */

import { createHash, createHmac } from 'node:crypto'

/** 签名输入。 */
export interface SignS3Input {
  readonly method: string
  /** 资源路径，形如 `/bucket/2026/09/18/abc.png`；本函数负责编码。 */
  readonly path: string
  /** 查询串（已按 key 排序）；无查询时传空串。 */
  readonly query: string
  /** 参与签名的头。`host` 由本函数从 endpoint 补，不必调用方给。 */
  readonly headers: Readonly<Record<string, string>>
  readonly payload: Uint8Array
  readonly accessKey: string
  readonly secretKey: string
  readonly region: string
  /** 服务名，S3 固定 `s3`。 */
  readonly service: string
  readonly now: Date
  /** 端点，形如 `http://127.0.0.1:3101`，用于取 host。 */
  readonly endpoint: string
}

/** 计算字节的 SHA256 十六进制摘要。 */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * RFC 3986 编码。
 *
 * @param value 原始字符串
 * @param encodeSlash 是否连 `/` 一起编码。路径段用 `true`，整个路径用 `false`
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  let out = ''
  for (const char of value) {
    if (/[A-Za-z0-9\-_.~]/.test(char)) {
      out += char
    } else if (char === '/' && !encodeSlash) {
      out += char
    } else {
      // 逐字节百分号编码：非 ASCII 字符（中文对象键）会展开成多个 UTF-8 字节。
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      }
    }
  }
  return out
}

/** 按 `/` 分段编码路径，段间保留 `/`。 */
export function encodePath(path: string): string {
  return path.split('/').map(segment => uriEncode(segment, true)).join('/')
}

/** `YYYYMMDDTHHMMSSZ`。 */
function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

/** `YYYYMMDD`。 */
function dateStamp(now: Date): string {
  return amzDate(now).slice(0, 8)
}

/** 把头名规范成小写并去掉首尾空白。 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** 头值规范化：去首尾空白，内部连续空白压成一个空格。 */
function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * 从签名结果取出要**实际发送**的请求头。
 *
 * ## 为什么必须有这一步
 *
 * 签名返回的头不能一股脑全发出去：`signS3Request` 总是补上 `x-amz-*`，而调用方可能只想签
 * 一部分头（那样签名里就不含它们）。**发出一个没进 `SignedHeaders` 的 `x-amz-*` 头**在
 * 规范上是另一种请求，服务端可以据此拒绝或按不同语义处理。
 *
 * 所以规则是：
 *
 * - `authorization` **一定发**——它是认证凭据本身，不参与自己的签名；
 * - `SignedHeaders` 里列出的头发出去（`host` 除外——它由 HTTP 栈自己写）；
 * - 其余一律丢掉。
 *
 * @param signed {@link signS3Request} 的返回值
 * @param requested 调用方原本想发的头
 * @returns 合并后、与签名一致的头
 */
export function signedRequestHeaders(
  signed: Record<string, string>,
  requested: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const authorization = signed.authorization as string
  const match = /SignedHeaders=([^,]+)/.exec(authorization)
  const signedNames = new Set((match?.[1] ?? '').split(';').filter(name => name !== '' && name !== 'host'))
  const out: Record<string, string> = { authorization }
  for (const [name, value] of Object.entries(requested)) {
    // 调用方给的头保留它自己的书写形式（`Content-Type` 与 `content-type` 等价），
    // 只按小写名判断它是否在签名清单里。
    if (signedNames.has(name.trim().toLowerCase()) && name.trim().toLowerCase() !== 'host') out[name] = value
  }
  for (const [name, value] of Object.entries(signed)) {
    if (name !== 'authorization' && name !== 'host' && signedNames.has(name)) out[name] = value
  }
  return out
}

/**
 * 计算签名并返回要附加到请求上的头。
 *
 * `headers` 里**每一个**头都会参与签名（这是 SigV4 的语义：签什么就发什么）。调用方若只要
 * 签一部分，就不要把它们放进来——用 {@link signedRequestHeaders} 保证发出的与签的一致。
 *
 * @param input 签名输入
 * @returns `authorization` / `x-amz-date` / `x-amz-content-sha256`（键为小写）
 */
export function signS3Request(input: SignS3Input): Record<string, string> {
  const stamp = amzDate(input.now)
  const date = dateStamp(input.now)
  const payloadHash = sha256Hex(input.payload)
  const host = new URL(input.endpoint).host

  // 参与签名的头：调用方给的 + host + 时间与载荷摘要。全部小写化后按名排序。
  const all: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers)) all[normalizeName(name)] = normalizeValue(value)
  all.host = host
  all['x-amz-content-sha256'] = payloadHash
  all['x-amz-date'] = stamp
  const names = Object.keys(all).sort()
  const canonicalHeaders = names.map(name => `${name}:${all[name] as string}\n`).join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    input.method,
    encodePath(input.path),
    input.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')

  // 密钥链：日期 → 区域 → 服务 → 终结符。顺序不能换。
  const kDate = createHmac('sha256', `AWS4${input.secretKey}`).update(date).digest()
  const kRegion = createHmac('sha256', kDate).update(input.region).digest()
  const kService = createHmac('sha256', kRegion).update(input.service).digest()
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest()
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
  }
}
