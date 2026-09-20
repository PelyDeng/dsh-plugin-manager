/**
 * PDF 解析工具。
 *
 * 只做一件事：把**文本层**按页取出来。不做 OCR（见 README：`DSH_OFFLINE` 下不能下模型），
 * 不做版面重建，不做表格识别——这些要么需要模型，要么是有损猜测。
 *
 * 依赖 `pdfjs-dist`，**按需动态加载**：装了就解析，没装报 `unavailable`。用它的 legacy 构建，
 * 因为那是不依赖浏览器 API 的那个入口，在 Node 里能直接跑。
 *
 * 单独一个工具而不是合进统一解析器：它是唯一会碰 PDF 的地方，依赖也最重，不该让纯文本那条路
 * 为它买单。
 */

import { DocumentParseError, resolveLimits, type DocumentLimits } from './limits.ts'
import { createBudget, loadDependency, type DocumentLoader } from './budget.ts'
import { detectDocumentKind } from './kinds.ts'
import { assertHasText, asCorrupt, type ParsedDocument, type ParsedUnit } from './units.ts'

/** pdfjs 的入口；写成常量是为了让"用哪个构建"这件事只有一个出处。 */
export const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs'

/** 入参：文件名与完整字节。 */
export interface PdfParseInput {
  readonly name: string
  readonly bytes: Uint8Array
}

/** PDF 解析的可选项。 */
export interface PdfParseOptions {
  readonly limits?: Partial<DocumentLimits> | undefined
  readonly signal?: AbortSignal | undefined
  /** 依赖加载器；缺省用动态 `import()`。测试用它注入替身。 */
  readonly load?: DocumentLoader | undefined
}

/** `pdfjs-dist` 在本工具里用到的面。 */
interface PdfDocumentLike {
  readonly numPages: number
  getPage(page: number): Promise<{
    getTextContent(): Promise<{ items: readonly { str?: string; hasEOL?: boolean }[] }>
    cleanup(): void
  }>
}

/**
 * 解析一份 PDF。
 *
 * @throws DocumentParseError `empty` / `too_large` / `corrupt`（不是 PDF）/ `unavailable`（缺依赖）/
 *   `no_text`（没有文本层，多半是扫描件）/ `timeout` / `aborted`。
 */
export async function parsePdfDocument(
  input: PdfParseInput,
  options: PdfParseOptions = {},
): Promise<ParsedDocument> {
  const limits = resolveLimits(options.limits)
  const bytes = input.bytes
  if (bytes.length === 0) throw new DocumentParseError('empty', '文件是空的')
  if (bytes.length > limits.maxBytes) {
    throw new DocumentParseError('too_large', `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)} MiB`)
  }
  // 魔数先核一遍：拿一个改了名的图片进来，pdfjs 会报一句内部错误，那句话对用户毫无意义。
  if (detectDocumentKind(input.name, bytes) !== 'pdf') {
    throw new DocumentParseError('corrupt', '文件内容不是 PDF')
  }
  const budget = createBudget(limits, options.signal)
  budget.checkpoint()
  const load = options.load ?? (specifier => import(specifier))
  const pdfjs = await loadDependency(load, PDFJS_SPECIFIER, '解析 PDF 需要 pdfjs-dist')
  const getDocument = pdfjs['getDocument']
  if (typeof getDocument !== 'function') {
    throw new DocumentParseError('unavailable', '依赖 pdfjs-dist 的版本不兼容（缺少 getDocument）')
  }
  const loading = (getDocument as (options: unknown) => { promise: Promise<PdfDocumentLike>, destroy(): Promise<void> })({
    data: new Uint8Array(bytes),
    // 这几项都是"不要做额外的事"：不求值、不取系统字体、不渲染字体、不发额外请求。
    // 取文本层不需要它们，开着只会更慢，也更容易在受限环境里失败。
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    stopAtErrors: true,
  })
  const units: ParsedUnit[] = []
  let characters = 0
  let partial = false
  try {
    // pdfjs 自己抛的错（结构坏了、xref 读不出来）在这里归到 `corrupt`：用户看到的该是
    // 一句"这个 PDF 读不出来"，而不是库内部那句英文。
    const pdf = await asCorrupt(() => loading.promise, 'PDF 文件损坏或读不出来')
    const totalUnits = pdf.numPages
    const pageLimit = Math.min(pdf.numPages, limits.maxPdfPages)
    for (let number = 1; number <= pageLimit; number += 1) {
      budget.checkpoint()
      const page = await asCorrupt(() => pdf.getPage(number), 'PDF 文件损坏或读不出来')
      const content = await asCorrupt(() => page.getTextContent(), 'PDF 文件损坏或读不出来')
      const text = content.items.map(item => `${item.str ?? ''}${item.hasEOL === true ? '\n' : ' '}`).join('')
      if (characters + text.length > limits.maxCharacters) {
        partial = true
        break
      }
      units.push({ number, text })
      characters += text.length
      page.cleanup()
    }
    if (units.length < totalUnits) partial = true
    assertHasText(units, 'PDF 没有可读取的文本层，需要先 OCR 再上传')
    return { kind: 'pdf', unit: '页', units, totalUnits, characters, partial }
  } finally {
    // 读完了要放掉：pdfjs 会在内存里留解析中间态，不 destroy 会随着每次上传累积。
    // destroy 自己失败不影响已经拿到的结果，所以吞掉。
    await loading.destroy().catch(() => {})
  }
}

/** 本工具需要的外部依赖清单，供调用方核对部署是否装齐。 */
export const PDF_DEPENDENCIES = [PDFJS_SPECIFIER] as const
