/**
 * `@dsh-agents-group/document-parse` 的行为测试。
 *
 * 第三方依赖全部用**注入的加载器**替身，不真装 PDF / DOCX 的库：这里要验的是工具自己的判定与
 * 上限逻辑，而不是 mammoth 能不能读某个文件。真库的兼容性由消费方的集成测试覆盖。
 */

import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIMITS,
  DOCUMENT_PARSE_VERSION,
  DocumentParseError,
  IMAGE_READ_PROMPT,
  describeDocument,
  detectDocumentKind,
  extensionOf,
  isDocumentParseError,
  parseDocxDocument,
  parseDocument,
  parsePdfDocument,
  parseTextDocument,
  readImageDocument,
  renderDocumentText,
  type DocumentLoader,
  type VisionCall,
} from '../packages/document-parse/src/index.ts'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const pngBytes = (): Uint8Array => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const docxBytes = (): Uint8Array => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)])
const pdfBytes = (): Uint8Array => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)])

/** 取回失败原因。`Error.message` 不可枚举，`toMatchObject` 看不到它，所以文案单独断言。 */
async function failureOf(run: Promise<unknown>): Promise<DocumentParseError> {
  const caught = await run.then(() => undefined, (error: unknown) => error)
  expect(isDocumentParseError(caught)).toBe(true)
  return caught as DocumentParseError
}

describe('种类判定', () => {
  it('扩展名取最后一段并小写化；点开头、点结尾算没有扩展名', () => {
    expect(extensionOf('需求.DOCX')).toBe('docx')
    expect(extensionOf('a/b/c.tar.gz')).toBe('gz')
    expect(extensionOf('C:\\下载\\说明.txt')).toBe('txt')
    expect(extensionOf('README')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
  })

  it('字节有容器特征时以字节为准，不信扩展名', () => {
    // 名字说它是 txt，字节说是 PDF：以 PDF 为准。
    expect(detectDocumentKind('伪装.txt', pdfBytes())).toBe('pdf')
    expect(detectDocumentKind('x.png', pngBytes())).toBe('image')
    expect(detectDocumentKind('x.dat', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('image')
    expect(detectDocumentKind('x.dat', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image')
  })

  it('zip 家族按扩展名区分 docx 与"认得出但不能解析"', () => {
    expect(detectDocumentKind('报告.docx', docxBytes())).toBe('docx')
    expect(detectDocumentKind('表格.xlsx', docxBytes())).toBe('binary')
    expect(detectDocumentKind('东西.zip', docxBytes())).toBe('binary')
  })

  it('没有魔数时用扩展名给出更细的文本种类', () => {
    expect(detectDocumentKind('a.csv', utf8('a,b\n1,2'))).toBe('csv')
    expect(detectDocumentKind('a.md', utf8('# 标题'))).toBe('markdown')
    expect(detectDocumentKind('a.json', utf8('{}'))).toBe('json')
  })

  it('扩展名不认识时按 UTF-8 兜底', () => {
    expect(detectDocumentKind('未知后缀', utf8('这是一段普通中文文字'))).toBe('text')
    expect(detectDocumentKind('blob', Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x81]))).toBe('binary')
  })
})

describe('纯文本工具', () => {
  it('按行切成带编号的单元', async () => {
    const parsed = await parseTextDocument({ name: 'a.txt', bytes: utf8('第一行\n第二行\r\n第三行') })
    expect(parsed.kind).toBe('text')
    expect(parsed.unit).toBe('行')
    expect(parsed.totalUnits).toBe(3)
    expect(parsed.partial).toBe(false)
    expect(parsed.units.map(unit => unit.number)).toEqual([1, 2, 3])
    expect(parsed.units[1]?.text).toBe('第二行')
  })

  it('空文件、超限、非 UTF-8、只有空白各有专属错误码', async () => {
    expect((await failureOf(parseTextDocument({ name: 'a.txt', bytes: new Uint8Array() }))).code).toBe('empty')
    expect((await failureOf(parseTextDocument({ name: 'a.txt', bytes: utf8('x'.repeat(100)) }, { limits: { maxBytes: 10 } }))).code).toBe('too_large')
    expect((await failureOf(parseTextDocument({ name: 'a.txt', bytes: Buffer.from([0xff, 0xfe, 0x41, 0x42]) }))).code).toBe('corrupt')
    expect((await failureOf(parseTextDocument({ name: 'a.txt', bytes: utf8('\n\n   \n') }))).code).toBe('no_text')
  })

  it('含 NUL 的当二进制拒绝，不当成文本', async () => {
    expect((await failureOf(parseTextDocument({ name: 'a.txt', bytes: Buffer.from('abc\0def') }))).code).toBe('corrupt')
  })

  it('json 先校验格式', async () => {
    expect((await failureOf(parseTextDocument({ name: 'a.json', bytes: utf8('{ 不是 json') }))).code).toBe('corrupt')
    expect((await parseTextDocument({ name: 'a.json', bytes: utf8('{"a":1}') })).kind).toBe('json')
  })

  it('走错工具时明确报 unsupported，而不是解出乱码', async () => {
    const failure = await failureOf(parseTextDocument({ name: 'a.pdf', bytes: pdfBytes() }))
    expect(failure.code).toBe('unsupported')
    expect(failure.message).toContain('pdf')
  })

  it('超过单元上限或字符上限时部分返回并置 partial，不抛错', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行`).join('\n')
    const byUnits = await parseTextDocument({ name: 'a.txt', bytes: utf8(lines) }, { limits: { maxUnits: 5 } })
    expect(byUnits.units).toHaveLength(5)
    expect(byUnits.totalUnits).toBe(20)
    expect(byUnits.partial).toBe(true)

    const long = Array.from({ length: 10 }, () => 'x'.repeat(50)).join('\n')
    const byChars = await parseTextDocument({ name: 'a.txt', bytes: utf8(long) }, { limits: { maxCharacters: 120 } })
    expect(byChars.partial).toBe(true)
    expect(byChars.characters).toBeLessThanOrEqual(120)
  })

  it('已经中止的信号在第一次检查点就停', async () => {
    const controller = new AbortController()
    controller.abort()
    expect((await failureOf(parseTextDocument({ name: 'a.txt', bytes: utf8('内容') }, { signal: controller.signal }))).code).toBe('aborted')
  })
})

describe('PDF 工具', () => {
  function pdfLoader(pages: readonly string[], options: { destroyThrows?: boolean } = {}): DocumentLoader {
    return async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: pages.length,
          getPage: async (number: number) => ({
            getTextContent: async () => ({ items: [{ str: pages[number - 1] ?? '', hasEOL: true }] }),
            cleanup: () => { /* 替身没有真资源要放 */ },
          }),
        }),
        destroy: async () => {
          if (options.destroyThrows === true) throw new Error('destroy failed')
        },
      }),
    })
  }

  it('按页切成单元', async () => {
    const parsed = await parsePdfDocument({ name: 'a.pdf', bytes: pdfBytes() }, { load: pdfLoader(['第一页', '第二页', '第三页']) })
    expect(parsed.kind).toBe('pdf')
    expect(parsed.unit).toBe('页')
    expect(parsed.totalUnits).toBe(3)
    // 每页末尾带一个换行：pdfjs 用 `hasEOL` 标出"这一行到这儿结束"，照录，不替它裁。
    expect(parsed.units.map(unit => unit.text)).toEqual(['第一页\n', '第二页\n', '第三页\n'])
  })

  it('页数超过 maxPdfPages 时部分返回并置 partial', async () => {
    const parsed = await parsePdfDocument({ name: 'a.pdf', bytes: pdfBytes() }, {
      load: pdfLoader(['一', '二', '三', '四', '五']),
      limits: { maxPdfPages: 2 },
    })
    expect(parsed.units).toHaveLength(2)
    expect(parsed.totalUnits).toBe(5)
    expect(parsed.partial).toBe(true)
  })

  it('没有文本层时报 no_text 并说明需要 OCR', async () => {
    const failure = await failureOf(parsePdfDocument({ name: 'a.pdf', bytes: pdfBytes() }, { load: pdfLoader(['', '   ']) }))
    expect(failure.code).toBe('no_text')
    expect(failure.message).toContain('OCR')
  })

  it('字节不是 PDF 时先拦住，不把 pdfjs 的内部错误抛给用户', async () => {
    expect((await failureOf(parsePdfDocument({ name: 'a.pdf', bytes: utf8('这不是 PDF') }))).code).toBe('corrupt')
  })

  it('destroy 失败不影响已经拿到的结果', async () => {
    const parsed = await parsePdfDocument({ name: 'a.pdf', bytes: pdfBytes() }, { load: pdfLoader(['内容'], { destroyThrows: true }) })
    expect(parsed.units[0]?.text).toBe('内容\n')
  })

  it('缺依赖时报 unavailable', async () => {
    const load: DocumentLoader = async () => { throw new Error('Cannot find module pdfjs-dist') }
    expect((await failureOf(parsePdfDocument({ name: 'a.pdf', bytes: pdfBytes() }, { load }))).code).toBe('unavailable')
  })

  it('库自己抛的错归到 corrupt：用户该看到"读不出来"，不是库内部那句英文', async () => {
    const load: DocumentLoader = async () => ({
      getDocument: () => ({
        promise: Promise.reject(new Error('Invalid PDF structure')),
        destroy: async () => {},
      }),
    })
    const failure = await failureOf(parsePdfDocument({ name: 'a.pdf', bytes: pdfBytes() }, { load }))
    expect(failure.code).toBe('corrupt')
    expect(failure.message).not.toContain('Invalid PDF structure')
  })

  it('取页失败也归到 corrupt', async () => {
    const load: DocumentLoader = async () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => { throw new Error('bad xref') },
        }),
        destroy: async () => {},
      }),
    })
    expect((await failureOf(parsePdfDocument({ name: 'a.pdf', bytes: pdfBytes() }, { load }))).code).toBe('corrupt')
  })
})

describe('DOCX 工具', () => {
  /** 一个最小的 yauzl 替身：按给的表逐个条目回调。 */
  function zipStub(entries: readonly { name: string, size?: number, data?: Buffer, flags?: number }[]): unknown {
    return {
      fromBuffer(_buffer: Buffer, _options: unknown, callback: (error: Error | null, zip: unknown) => void): void {
        const handlers = new Map<string, ((arg?: unknown) => void)[]>()
        let index = 0
        const zip = {
          on(event: string, handler: (arg?: unknown) => void) {
            const list = handlers.get(event) ?? []
            list.push(handler)
            handlers.set(event, list)
            return zip
          },
          readEntry() {
            setImmediate(() => {
              if (index >= entries.length) {
                for (const handler of handlers.get('end') ?? []) handler()
                return
              }
              const entry = entries[index]
              index += 1
              if (entry === undefined) return
              for (const handler of handlers.get('entry') ?? []) {
                handler({ fileName: entry.name, uncompressedSize: entry.size ?? 0, generalPurposeBitFlag: entry.flags ?? 0, data: entry.data })
              }
            })
          },
          openReadStream(entry: { data?: Buffer }, done: (error: Error | null, stream: NodeJS.ReadableStream) => void) {
            setImmediate(() => { done(null, Readable.from([entry.data ?? Buffer.alloc(0)])) })
          },
          close() { /* 替身没有真资源要放 */ },
        }
        callback(null, zip)
      },
    }
  }

  const docxLoader = (entries: readonly { name: string, size?: number, data?: Buffer, flags?: number }[], text: string): DocumentLoader =>
    async specifier => specifier === 'yauzl'
      ? zipStub(entries)
      : { extractRawText: async () => ({ value: text }) }

  it('正常文档按空行切段', async () => {
    const load = docxLoader([{ name: 'word/document.xml', data: Buffer.from('<xml/>') }], '第一段\n\n第二段\n\n第三段')
    const parsed = await parseDocxDocument({ name: 'a.docx', bytes: docxBytes() }, { load })
    expect(parsed.kind).toBe('docx')
    expect(parsed.unit).toBe('段')
    expect(parsed.totalUnits).toBe(3)
    expect(parsed.units[0]?.text).toBe('第一段')
  })

  it('缺 word/document.xml 按 corrupt 拒绝', async () => {
    const load = docxLoader([{ name: 'docProps/app.xml', data: Buffer.from('x') }], '')
    expect((await failureOf(parseDocxDocument({ name: 'a.docx', bytes: docxBytes() }, { load }))).code).toBe('corrupt')
  })

  it('带宏的文档主动拒绝，不当成"读不动"', async () => {
    const load = docxLoader([
      { name: 'word/document.xml', data: Buffer.from('<xml/>') },
      { name: 'word/vbaProject.bin', data: Buffer.from('m') },
    ], '正文')
    expect((await failureOf(parseDocxDocument({ name: 'a.docx', bytes: docxBytes() }, { load }))).code).toBe('encrypted')
  })

  it('加密位被置上的文档拒绝', async () => {
    const load = docxLoader([{ name: 'word/document.xml', data: Buffer.from('<xml/>'), flags: 1 }], '正文')
    expect((await failureOf(parseDocxDocument({ name: 'a.docx', bytes: docxBytes() }, { load }))).code).toBe('encrypted')
  })

  it('展开后超限时立刻停，不把整个包解开', async () => {
    const load = docxLoader([{ name: 'word/document.xml', size: 1024, data: Buffer.alloc(1024) }], '正文')
    expect((await failureOf(parseDocxDocument({ name: 'a.docx', bytes: docxBytes() }, { load, limits: { maxExpandedBytes: 100 } }))).code).toBe('too_large')
  })

  it('条目数超限时拒绝', async () => {
    const load = docxLoader([{ name: 'word/document.xml', data: Buffer.from('<xml/>') }], '正文')
    expect((await failureOf(parseDocxDocument({ name: 'a.docx', bytes: docxBytes() }, { load, limits: { maxEntries: 0 } }))).code).toBe('too_large')
  })

  it('字节不是 DOCX、或缺少依赖时都给出对应错误码', async () => {
    expect((await failureOf(parseDocxDocument({ name: 'a.docx', bytes: utf8('这是纯文本') }))).code).toBe('corrupt')
    const load: DocumentLoader = async () => { throw new Error('Cannot find module yauzl') }
    expect((await failureOf(parseDocxDocument({ name: 'a.docx', bytes: docxBytes() }, { load }))).code).toBe('unavailable')
  })
})

describe('图片工具', () => {
  it('把提示词与字节交给读图调用，产出单单元结果', async () => {
    const vision = vi.fn<VisionCall>(async () => '一、图里的文字：合计 1200\n二、图里的内容：一张报表截图')
    const parsed = await readImageDocument({ name: 'a.png', bytes: pngBytes(), mediaType: 'image/png' }, vision)
    expect(parsed.kind).toBe('image')
    expect(parsed.unit).toBe('图')
    expect(parsed.totalUnits).toBe(1)
    expect(parsed.characters).toBeGreaterThan(0)
    expect(vision).toHaveBeenCalledTimes(1)
    expect(vision.mock.calls[0]?.[0].prompt).toBe(IMAGE_READ_PROMPT)
    expect(vision.mock.calls[0]?.[0].mediaType).toBe('image/png')
  })

  it('提示词可以换：调用方有更具体的问题时用自己的', async () => {
    const vision = vi.fn<VisionCall>(async () => '合计是 1200')
    await readImageDocument({ name: 'a.png', bytes: pngBytes() }, vision, { prompt: '这张报表的合计是多少？' })
    expect(vision.mock.calls[0]?.[0].prompt).toBe('这张报表的合计是多少？')
  })

  it('不是图片、媒体类型不在白名单、字节超限都拒绝', async () => {
    const vision: VisionCall = async () => 'x'
    expect((await failureOf(readImageDocument({ name: 'a.txt', bytes: utf8('文本') }, vision))).code).toBe('unsupported')
    expect((await failureOf(readImageDocument({ name: 'a.png', bytes: pngBytes(), mediaType: 'image/tiff' }, vision, { allowedMediaTypes: ['image/png'] }))).code).toBe('unsupported')
    expect((await failureOf(readImageDocument({ name: 'a.png', bytes: pngBytes() }, vision, { limits: { maxBytes: 4 } }))).code).toBe('too_large')
  })

  it('模型没给出内容时按 no_text 报，调用失败按 unavailable 报', async () => {
    expect((await failureOf(readImageDocument({ name: 'a.png', bytes: pngBytes() }, async () => '   '))).code).toBe('no_text')
    const failure = await failureOf(readImageDocument({ name: 'a.png', bytes: pngBytes() }, async () => { throw new Error('没有可用的视觉模型') }))
    expect(failure.code).toBe('unavailable')
    expect(failure.message).toContain('没有可用的视觉模型')
  })
})

describe('分派器 parseDocument', () => {
  it('按内容转给对应工具', async () => {
    expect((await parseDocument({ name: 'a.txt', bytes: utf8('一行') })).kind).toBe('text')
    expect((await parseDocument({ name: 'a.png', bytes: pngBytes() }, { vision: async () => '图' })).kind).toBe('image')
  })

  it('图片没给读图调用时明确报 unsupported，不悄悄花掉一次模型调用', async () => {
    const failure = await failureOf(parseDocument({ name: 'a.png', bytes: pngBytes() }))
    expect(failure.code).toBe('unsupported')
    expect(failure.message).toContain('读图调用')
  })

  it('认得出但读不出文字的文件给 unsupported', async () => {
    expect((await failureOf(parseDocument({ name: '表格.xlsx', bytes: docxBytes() }))).code).toBe('unsupported')
  })
})

describe('渲染', () => {
  it('按上限拼接，超出时截断并如实标注', async () => {
    const parsed = await parseTextDocument({ name: 'a.txt', bytes: utf8('aaaa\nbbbb\ncccc') })
    expect(renderDocumentText(parsed, 1000)).toEqual({ text: 'aaaa\nbbbb\ncccc', truncated: false })
    // 6 个字符正好放下 `aaaa` + 换行 + `b`：计数含自己插入的换行。
    expect(renderDocumentText(parsed, 6)).toEqual({ text: 'aaaa\nb', truncated: true })
  })

  it('解析本身是 partial 时，渲染结果也算截断', async () => {
    const lines = Array.from({ length: 10 }, () => 'x'.repeat(10)).join('\n')
    const parsed = await parseTextDocument({ name: 'a.txt', bytes: utf8(lines) }, { limits: { maxUnits: 2 } })
    expect(renderDocumentText(parsed, 100000).truncated).toBe(true)
  })

  it('跳过空单元，不浪费预算', async () => {
    const parsed = await parseTextDocument({ name: 'a.txt', bytes: utf8('甲\n\n\n乙') })
    expect(renderDocumentText(parsed, 1000).text).toBe('甲\n乙')
  })

  it('一句话说明规模：完整与部分说法不同', async () => {
    const full = await parseTextDocument({ name: 'a.txt', bytes: utf8('甲\n乙') })
    expect(describeDocument(full)).toBe('共 2 行，2 字')
    const cut = await parseTextDocument({ name: 'a.txt', bytes: utf8('甲\n乙\n丙') }, { limits: { maxUnits: 1 } })
    expect(describeDocument(cut)).toBe('前 1 行，共 3 行，1 字')
  })
})

describe('错误类型与包信息', () => {
  it('跨打包副本也能认出来（不只看 instanceof）', () => {
    expect(isDocumentParseError(new DocumentParseError('corrupt', 'x'))).toBe(true)
    expect(isDocumentParseError({ name: 'DocumentParseError', code: 'corrupt' })).toBe(true)
    expect(isDocumentParseError(new Error('x'))).toBe(false)
    expect(isDocumentParseError(null)).toBe(false)
  })

  it('缺省上限是完整的一份', () => {
    expect(DEFAULT_LIMITS.maxBytes).toBeGreaterThan(0)
    expect(DEFAULT_LIMITS.timeoutMs).toBeGreaterThan(0)
    expect(DOCUMENT_PARSE_VERSION).toBe('0.2.0')
  })
})
