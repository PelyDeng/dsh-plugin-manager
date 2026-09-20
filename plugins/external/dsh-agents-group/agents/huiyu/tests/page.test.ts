/**
 * 页面的验证。
 *
 * 两件事必须钉住：
 *
 * 1. **密钥绝不能出现在页面里**。页面是服务端渲染的 HTML，一旦把 `env.conf` 的值整个塞进去，
 *    访问者按一次「查看源代码」就拿到对象存储与生图接口的凭据。所以只展示白名单字段。
 * 2. **未就绪原因要转义**。那段文字来自配置解析，包含用户填的值（例如键名与占位符），
 *    属于外部输入，直接插进 HTML 就是一次注入。
 */

import { describe, expect, it } from 'vitest'
import { renderPage } from '../src/page.ts'
import type { HuiyuEnvironment } from '../src/env.ts'

const ENVIRONMENT: HuiyuEnvironment = {
  minio: {
    endpoint: 'http://127.0.0.1:3101',
    bucket: 'huiyu',
    region: 'us-east-1',
    accessKey: 'SECRET-ACCESS-KEY',
    secretKey: 'SECRET-SECRET-KEY',
    publicBaseUrl: 'https://img.pelycloud.com',
  },
  image: {
    provider: 'openai-images',
    baseUrl: 'https://relay.example.com',
    model: 'gpt-image-1.5',
    apiKey: 'SECRET-IMAGE-KEY',
    coverStyle: '',
  },
}

describe('页面内容', () => {
  it('就绪时显示状态，并列出全部八个工具', () => {
    const html = renderPage({ environment: ENVIRONMENT })
    expect(html).toContain('已就绪')
    for (const name of ['huiyu_describe', 'huiyu_extract', 'huiyu_compare', 'huiyu_draw', 'huiyu_cover', 'huiyu_illustrate', 'huiyu_library', 'huiyu_upload']) {
      expect(html, `${name} 应出现在页面上`).toContain(name)
    }
  })

  it('**不出现任何密钥**', () => {
    const html = renderPage({ environment: ENVIRONMENT })
    for (const secret of ['SECRET-ACCESS-KEY', 'SECRET-SECRET-KEY', 'SECRET-IMAGE-KEY']) {
      expect(html, `${secret} 泄漏到了页面上`).not.toContain(secret)
    }
    // 连键名都不该出现——那会提示攻击者去猜哪一份配置有价值。
    expect(html).not.toContain('HUIYU_MINIO_ACCESS_KEY')
    expect(html).not.toContain('HUIYU_IMAGE_API_KEY')
  })

  it('展示非敏感的运行信息', () => {
    const html = renderPage({ environment: ENVIRONMENT })
    expect(html).toContain('huiyu')
    expect(html).toContain('https://img.pelycloud.com')
    expect(html).toContain('gpt-image-1.5')
  })

  it('未就绪时如实显示原因，而不是假装正常', () => {
    const html = renderPage({ unavailable: '绘语未配置：缺 HUIYU_IMAGE_BASE_URL' })
    expect(html).toContain('暂不可用')
    expect(html).toContain('HUIYU_IMAGE_BASE_URL')
    expect(html).not.toContain('已就绪')
  })

  it('未就绪原因被 HTML 转义（那段文字来自配置，属于外部输入）', () => {
    const html = renderPage({ unavailable: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('环境信息里的特殊字符也被转义', () => {
    const hostile: HuiyuEnvironment = {
      ...ENVIRONMENT,
      minio: { ...ENVIRONMENT.minio, bucket: 'a"onmouseover="x' },
    }
    const html = renderPage({ environment: hostile })
    expect(html).not.toContain('a"onmouseover="x')
    expect(html).toContain('&quot;')
  })

  it('输出是一份完整的 HTML 文档', () => {
    const html = renderPage({ environment: ENVIRONMENT })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>绘语（图片智能体）</title>')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('未提供环境时不渲染运行信息区块', () => {
    const html = renderPage({ unavailable: '缺配置' })
    expect(html).not.toContain('运行信息')
  })
})
