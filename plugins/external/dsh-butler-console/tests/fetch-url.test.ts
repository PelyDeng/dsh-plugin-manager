/**
 * 有界抓取：地址校验、内容类型白名单、文件名推断、HTML 剥文字。
 *
 * 这里全部是**纯函数**，不发真实请求：真正要守住的是"哪些地址不许连"，而那一判断与网络无关。
 * 网络那一段（钉住地址、只跟同源跳转、字节上限）在真实站点上验证，不在单测里假装。
 */
import { describe, expect, it } from 'vitest'
import {
  FetchFailure,
  acceptsMediaType,
  assertPublicUrl,
  fetchPublicResource,
  fileNameFromUrl,
  htmlToText,
  isPublicAddress,
} from '../src/fetch-url.ts'

/** 固定的解析结果替身：不查真实 DNS。 */
const resolves = (addresses: readonly string[]) => async () => addresses

describe('isPublicAddress：只放公网地址过去', () => {
  it('放行常见的公网地址', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('1.1.1.1')).toBe(true)
    expect(isPublicAddress('104.16.0.1')).toBe(true)
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true)
  })

  it('挡住回环、私有、链路本地与保留段', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.1', '198.18.0.1',
      '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('IPv6 的私网段与内嵌 v4 也挡住', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    // 内嵌的是公网 v4 时照常放行。
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true)
  })

  it('看不懂的字符串一律不放行', () => {
    expect(isPublicAddress('example.com')).toBe(false)
    expect(isPublicAddress('8.8.8')).toBe(false)
    expect(isPublicAddress('')).toBe(false)
  })
})

describe('assertPublicUrl', () => {
  it('只接 http 与 https', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', resolves(['8.8.8.8'])))
      .rejects.toMatchObject({ code: 'url_invalid' })
    await expect(assertPublicUrl('data:text/plain,hi', resolves(['8.8.8.8'])))
      .rejects.toMatchObject({ code: 'url_invalid' })
    await expect(assertPublicUrl('不是地址', resolves(['8.8.8.8'])))
      .rejects.toMatchObject({ code: 'url_invalid' })
    await expect(assertPublicUrl(`https://example.com/${'x'.repeat(4096)}`, resolves(['8.8.8.8'])))
      .rejects.toMatchObject({ code: 'url_invalid' })
  })

  it('IP 字面量直接判，不查 DNS —— 直接写内网 IP 这条最省事的路要第一个被挡住', async () => {
    let asked = 0
    const resolve = async () => { asked += 1; return ['8.8.8.8'] }
    await expect(assertPublicUrl('http://127.0.0.1:7780/', resolve)).rejects.toMatchObject({ code: 'url_invalid' })
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/', resolve)).rejects.toMatchObject({ code: 'url_invalid' })
    expect(asked).toBe(0)
    await expect(assertPublicUrl('http://8.8.8.8/', resolve)).resolves.toBeInstanceOf(URL)
  })

  it('域名解析出任何一个内网地址就整条拒掉', async () => {
    // "内外双解析"是常见做法：只要有一条私有地址，这个域名就不可信。
    await expect(assertPublicUrl('http://evil.example/', resolves(['8.8.8.8', '127.0.0.1'])))
      .rejects.toMatchObject({ code: 'url_invalid' })
  })

  it('解析失败与解析为空各有专属码', async () => {
    const boom = async () => { throw new Error('ENOTFOUND') }
    await expect(assertPublicUrl('http://nope.example/', boom)).rejects.toMatchObject({ code: 'dns_failed' })
    await expect(assertPublicUrl('http://nope.example/', resolves([]))).rejects.toMatchObject({ code: 'dns_failed' })
  })
})

describe('acceptsMediaType', () => {
  it('没给白名单就都收；给了就按前缀匹配', () => {
    expect(acceptsMediaType('application/zip', undefined)).toBe(true)
    expect(acceptsMediaType('image/png; charset=binary', ['image/'])).toBe(true)
    expect(acceptsMediaType('text/html; charset=utf-8', ['text/', 'application/pdf'])).toBe(true)
    expect(acceptsMediaType('application/zip', ['image/', 'text/'])).toBe(false)
    expect(acceptsMediaType('', ['image/'])).toBe(false)
  })
})

describe('fileNameFromUrl', () => {
  it('取地址最后一段；解不开或为空时按内容类型补一个', () => {
    expect(fileNameFromUrl(new URL('https://img.example/a/b/图%20片.png'), 'image/png')).toBe('图 片.png')
    expect(fileNameFromUrl(new URL('https://example.com/'), 'application/pdf')).toBe('下载的内容.pdf')
    expect(fileNameFromUrl(new URL('https://example.com/'), '')).toBe('下载的内容.bin')
  })

  it('名字里的路径分隔与控制字符被清掉（它只用于展示，也从不许带出路径形状）', () => {
    // `%2F` 不是真的分隔符，解出来之后名字里会带上斜杠 —— 必须在这一步就抹掉。
    expect(fileNameFromUrl(new URL('https://example.com/a%2F..%2Fb.txt'), 'text/plain')).toBe('a..b.txt')
    expect(fileNameFromUrl(new URL('https://example.com/%E4%B8%80.txt'), 'text/plain')).toBe('一.txt')
  })
})

describe('fetchPublicResource：不发请求就能判定的失败', () => {
  it('内网地址在发请求之前就被拒', async () => {
    await expect(fetchPublicResource('http://10.1.2.3/secret', { maxBytes: 1024, timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'url_invalid' })
    await expect(fetchPublicResource('http://evil.example/x', {
      maxBytes: 1024,
      timeoutMs: 1000,
      resolve: resolves(['127.0.0.1']),
    })).rejects.toMatchObject({ code: 'url_invalid' })
  })
})

describe('htmlToText', () => {
  it('丢掉脚本与样式，标签变空白，收拢连续空白', () => {
    const html = `<html><head><style>body{color:red}</style><script>alert('x')</script></head>
      <body><h1>标题</h1><p>第一段  有   空格</p><p>第二段</p></body></html>`
    const text = htmlToText(html)
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('<')
    expect(text).toContain('标题')
    expect(text).toContain('第一段 有 空格')
  })

  it('还原五个基本实体', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f</p>')).toBe('a & b <c> "d" \'e\' f')
  })
})

describe('FetchFailure', () => {
  it('是可辨认的错误类型，带稳定码', () => {
    const failure = new FetchFailure('too_large', '太大了', 413)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.code).toBe('too_large')
    expect(failure.statusCode).toBe(413)
  })
})
