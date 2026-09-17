/**
 * SigV4 签名的验证。
 *
 * ## 为什么这些用例值得写
 *
 * 签名算法错了只会表现为"上传返回 403"，而那时很难判断是签名错、凭据错还是桶策略错——
 * 三者在服务端的回应一模一样。所以要在**脱离网络**的地方把算法本身钉住。
 *
 * ## 用例怎么选的
 *
 * 不去抄一份期望签名（那需要一份可信参考实现，而本项目没有），而是断言**规范里的硬性质**：
 * 哪一段变了签名必须变、哪些变化**不该**影响签名、以及编码规则。这些性质一旦成立，
 * 签名就符合 AWS 的定义；哪条被写错，对应的用例必然红。
 *
 * 其中三条是实际踩过或最容易踩的：
 *
 * 1. **路径里的 `/` 不编码**——用 `encodeURIComponent` 会编成 `%2F`，对象键于是变成一个
 *    不存在的名字（上传成功但读不到，或直接 404）。
 * 2. **非 ASCII 逐字节编码**——中文对象键若按字符编码，服务端算出的规范请求就与这里不一致。
 * 3. **CanonicalHeaders 的排序与规范化**——头名必须小写且按字典序，值要去首尾空白并把内部
 *    连续空白压成一个空格，否则签名与请求对不上。
 */

import { describe, expect, it } from 'vitest'
import { encodePath, sha256Hex, signS3Request, signedRequestHeaders, uriEncode } from '../src/minio/sigv4.ts'

const AT = new Date('2026-09-18T02:30:45.000Z')

/** 一份固定的签名输入，用例在它上面做单点变化。 */
function baseInput() {
  return {
    method: 'PUT',
    path: '/huiyu/2026/09/18/abc.png',
    query: '',
    headers: { 'content-type': 'image/png' },
    payload: new TextEncoder().encode('fake-image-bytes'),
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    now: AT,
    endpoint: 'http://127.0.0.1:3101',
  } as const
}

describe('sigv4 的编码规则', () => {
  it('路径里的斜杠不编码，其余按 RFC3986 编码', () => {
    expect(encodePath('/huiyu/2026/09/18/abc.png')).toBe('/huiyu/2026/09/18/abc.png')
    // 空格与加号必须编码（加号在查询串里是空格的别名，不编码会被服务端理解错）。
    expect(encodePath('/huiyu/a b+c.png')).toBe('/huiyu/a%20b%2Bc.png')
  })

  it('非 ASCII 逐字节百分号编码（中文对象键）', () => {
    // '图' 的 UTF-8 是 E5 9B BE。
    expect(uriEncode('图', true)).toBe('%E5%9B%BE')
  })

  it('不编码的字符集只有 A-Za-z0-9-_.~', () => {
    expect(uriEncode("aZ0-_.~", true)).toBe('aZ0-_.~')
    // 这四个在查询串里有特殊含义，必须编码。
    expect(uriEncode('&=?#', true)).toBe('%26%3D%3F%23')
  })

  it('sha256Hex 对已知输入给出已知摘要', () => {
    // 空串的 SHA256 是个广为人知的常量，用它确认摘要实现没接错。
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('sigv4 的签名性质', () => {
  it('相同输入给出相同签名（确定性）', () => {
    expect(signS3Request(baseInput())).toEqual(signS3Request(baseInput()))
  })

  it('Authorization 的形状正确', () => {
    const headers = signS3Request(baseInput())
    const authorization = headers.authorization as string
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260918\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/)
    // 凭据范围里的日期必须与 x-amz-date 的日期段一致。
    expect(authorization).toContain(`/20260918/us-east-1/s3/aws4_request`)
  })

  it('x-amz-date 是 ISO8601 基本格式', () => {
    expect(signS3Request(baseInput())['x-amz-date']).toBe('20260918T023045Z')
  })

  it('x-amz-content-sha256 是载荷摘要', () => {
    const headers = signS3Request(baseInput())
    expect(headers['x-amz-content-sha256']).toBe(sha256Hex(new TextEncoder().encode('fake-image-bytes')))
  })

  it('host 一定进签名头，且取自 endpoint（含端口）', () => {
    const signed = signS3Request(baseInput()).authorization as string
    expect(signed).toContain('host')
    // 换端口必须换签名——否则签给 A 的请求能拿去打 B。
    const other = signS3Request({ ...baseInput(), endpoint: 'http://127.0.0.1:3102' }).authorization
    expect(other).not.toBe(signed)
  })

  it('载荷变一个字节，签名必变', () => {
    const before = signS3Request(baseInput()).authorization
    const after = signS3Request({ ...baseInput(), payload: new TextEncoder().encode('fake-image-bytes!') }).authorization
    expect(after).not.toBe(before)
  })

  it('路径变一个字符，签名必变', () => {
    const before = signS3Request(baseInput()).authorization
    const after = signS3Request({ ...baseInput(), path: '/huiyu/2026/09/18/abd.png' }).authorization
    expect(after).not.toBe(before)
  })

  it('区域或服务变，签名必变（密钥链里含它们）', () => {
    const base = signS3Request(baseInput()).authorization
    expect(signS3Request({ ...baseInput(), region: 'us-west-2' }).authorization).not.toBe(base)
    expect(signS3Request({ ...baseInput(), service: 's3-object-lambda' }).authorization).not.toBe(base)
  })

  it('密钥变，签名必变', () => {
    const base = signS3Request(baseInput()).authorization
    expect(signS3Request({ ...baseInput(), secretKey: 'another-secret' }).authorization).not.toBe(base)
  })

  it('时间变，签名必变', () => {
    const base = signS3Request(baseInput()).authorization
    const later = new Date(AT.getTime() + 1000)
    expect(signS3Request({ ...baseInput(), now: later }).authorization).not.toBe(base)
  })

  it('放进 headers 的头都参与签名（签什么就发什么）', () => {
    // SigV4 的语义是"签什么发什么"。把附加头放进 `headers` 就意味着把它签进去，
    // 这正是 `signedRequestHeaders` 存在的原因：让实际发出的头与签过的头严格一致。
    const base = signS3Request(baseInput()).authorization as string
    const withExtra = signS3Request({
      ...baseInput(),
      headers: { 'content-type': 'image/png', 'x-custom': 'signed' },
    }).authorization as string
    expect(withExtra).not.toBe(base)
    expect(withExtra).toContain('x-custom')
  })

  it('signedRequestHeaders 交出 authorization、签过的头，并丢掉 host', () => {
    const signed = signS3Request(baseInput())
    const headers = signedRequestHeaders(signed, { 'content-type': 'image/png' })
    // authorization 是认证凭据本身，必须发；其余恰好等于 SignedHeaders 里那几个。
    expect(Object.keys(headers).sort()).toEqual(['authorization', 'content-type', 'x-amz-content-sha256', 'x-amz-date'])
    expect(headers.authorization).toBe(signed.authorization)
    expect(headers['content-type']).toBe('image/png')
    expect((headers as Record<string, unknown>).host).toBeUndefined()
  })

  it('没进签名的头不会被交出去（避免发出未签名的 x-amz-*）', () => {
    // 直接构造一份"签名里不含 x-custom"的场景：把 x-custom 排除在签名输入之外，
    // 但作为"想发的头"传进来 —— 它必须被丢掉。
    const signed = signS3Request(baseInput())
    const headers = signedRequestHeaders(signed, { 'x-custom': 'not-signed', 'content-type': 'image/png' })
    expect(headers['x-custom']).toBeUndefined()
  })

  it('headers 的大小写不影响 signedRequestHeaders 的筛选', () => {
    const signed = signS3Request(baseInput())
    const headers = signedRequestHeaders(signed, { 'Content-Type': 'image/jpeg' })
    expect(headers['Content-Type']).toBe('image/jpeg')
  })

  it('头名的书写形式不影响签名（大小写与空白被规范化）', () => {
    const lower = signS3Request({ ...baseInput(), headers: { 'content-type': 'image/png' } }).authorization
    const upper = signS3Request({ ...baseInput(), headers: { 'Content-Type': '  image/png  ' } }).authorization
    expect(upper).toBe(lower)
  })

  it('查询串进签名：空查询与带查询的签名不同', () => {
    const none = signS3Request(baseInput()).authorization
    const withQuery = signS3Request({ ...baseInput(), query: 'uploads=' }).authorization
    expect(withQuery).not.toBe(none)
  })

  it('方法进签名：PUT 与 GET 的签名不同', () => {
    const put = signS3Request(baseInput()).authorization
    const get = signS3Request({ ...baseInput(), method: 'GET' }).authorization
    expect(get).not.toBe(put)
  })
})
