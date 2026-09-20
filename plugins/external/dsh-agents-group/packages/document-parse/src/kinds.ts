/**
 * 文件种类判定：**先看字节，再看扩展名**。
 *
 * 只信扩展名是常见漏洞的起点：把 `payload.js` 改名成 `note.txt` 就绕过了所有按名字做的判断。
 * 反过来只信字节也不行——纯文本没有魔数，"这是什么文本"只能靠扩展名（csv 与 markdown 的
 * 字节形态一模一样）。所以顺序是：
 *
 * 1. 字节里有明确的容器特征（图片、PDF、zip）→ 以字节为准，扩展名说了不算；
 * 2. 字节没有特征、扩展名是认识的文本类型 → 取扩展名给的那个更细的种类；
 * 3. 还是没有 → 试着按 UTF-8 解一次：解得开且没有 NUL，就当纯文本；解不开就是 `binary`。
 *
 * 第 3 条是**兜底而不是猜测**：它只说"这是一段文字"，不假装知道它是 csv 还是日志。
 * 代码文件、`.conf`、没有扩展名的文件都从这里落进 `text`。
 */

/** 本包认得的文件种类。 */
export type DocumentKind =
  /** 纯文本：txt、日志、代码、配置等一切没有更细归属的文字。 */
  | 'text'
  | 'markdown'
  | 'csv'
  | 'json'
  | 'yaml'
  | 'xml'
  | 'html'
  /** 带文本层的 PDF。 */
  | 'pdf'
  /** Word OOXML 文档（`.docx`）。 */
  | 'docx'
  /** 图片。不做 OCR，交给视觉模型（见 README）。 */
  | 'image'
  /** 认得出来但不能解析：zip、xlsx、可执行文件、音视频…… 原文件照存，只是读不出文字。 */
  | 'binary'

/** 需要外部依赖、按格式解析的种类。 */
export type StructuredKind = 'pdf' | 'docx'

/** 能直接解成文字的纯文本种类。 */
export type TextKind = 'text' | 'markdown' | 'csv' | 'json' | 'yaml' | 'xml' | 'html'

const TEXT_KINDS: readonly TextKind[] = ['text', 'markdown', 'csv', 'json', 'yaml', 'xml', 'html']

/** 是否是纯文本种类。 */
export function isTextKind(kind: DocumentKind): kind is TextKind {
  return (TEXT_KINDS as readonly string[]).includes(kind)
}

/** 是否是本包能抽出文字的结构化文档。 */
export function isStructuredKind(kind: DocumentKind): kind is StructuredKind {
  return kind === 'pdf' || kind === 'docx'
}

/** 扩展名 → 文本种类。没有列进来的扩展名走"解一次 UTF-8"的兜底。 */
const TEXT_EXTENSIONS: Readonly<Record<string, TextKind>> = {
  txt: 'text', text: 'text', log: 'text', ini: 'text', conf: 'text', cfg: 'text',
  env: 'text', sql: 'text', sh: 'text', bash: 'text', ps1: 'text', bat: 'text',
  py: 'text', rb: 'text', go: 'text', rs: 'text', java: 'text', kt: 'text', php: 'text',
  c: 'text', h: 'text', cpp: 'text', hpp: 'text', cs: 'text', swift: 'text',
  js: 'text', mjs: 'text', cjs: 'text', jsx: 'text', vue: 'text', svelte: 'text',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  csv: 'csv', tsv: 'csv',
  json: 'json', jsonl: 'json', ndjson: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', xsd: 'xml', xsl: 'xml', plist: 'xml', svg: 'xml',
  html: 'html', htm: 'html', xhtml: 'html',
}

/** 扩展名 → 图片。用于字节匹配不上但扩展名明确时报"图片"，避免把图片当文本去解码。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'tif', 'tiff'])

/** 取小写的最后一个扩展名；没有扩展名时给空串。 */
export function extensionOf(name: string): string {
  const leaf = name.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const dot = leaf.lastIndexOf('.')
  // 前导点（`.gitignore`）不算扩展名：那不是"类型"，是隐藏文件。
  if (dot <= 0 || dot === leaf.length - 1) return ''
  return leaf.slice(dot + 1).toLowerCase()
}

/** 按魔数判定；认不出来给 undefined。只看开头这些字节，不读全文。 */
function magicKind(bytes: Uint8Array): DocumentKind | undefined {
  const startsWith = (text: string, offset = 0): boolean => {
    if (bytes.length < offset + text.length) return false
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  // PDF：`%PDF-` 必须落在开头。有的文件前面有几个字节的垃圾，那种情况不迁就——
  // 迁就一次就要为"到底能偏移多少"再定一条规则，代价大于收益。
  if (startsWith('%PDF-')) return 'pdf'
  if (bytes.length >= 8 && bytes[0] === 0x89 && startsWith('PNG', 1)) return 'image'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image'
  if (startsWith('GIF8')) return 'image'
  if (startsWith('BM') && bytes.length >= 14) return 'image'
  if (startsWith('RIFF') && bytes.length >= 12 && startsWith('WEBP', 8)) return 'image'
  if (startsWith('II*\0') || startsWith('MM\0*')) return 'image'
  // OOXML / zip：`PK\x03\x04`。docx 与 xlsx 的字节特征一样，只能靠扩展名分，
  // 所以这里只回答"这是个 zip"，由调用处结合扩展名决定是 docx 还是 binary。
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)) {
    return 'binary'
  }
  return undefined
}

/**
 * 这段字节能按 UTF-8 解成文字吗。
 *
 * 判据是三条一起：严格解码不报错、中间没有 NUL、控制字符占比很低。前两条挡的是二进制，
 * 第三条挡的是"碰巧是合法 UTF-8 的二进制"——随机字节里有 0x00-0x1f 的概率不低。
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  // 只看前 8 KiB：判定类型不需要读完整个文件，而大文件全解一遍是白花的 CPU。
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192))
  if (sample.includes(0)) return false
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample)
  } catch {
    return false
  }
  let control = 0
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0
    // 制表、换行、回车是正常的；其余 C0 控制字符算异常。DEL（0x7f）也算。
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) control += 1
  }
  return control <= Math.max(1, Math.floor(decoded.length / 100))
}

/**
 * 判定一份文件的种类。
 *
 * @param name 文件名。只取它的扩展名，**从不**把它当路径用。
 * @param bytes 文件开头（够判定即可，传完整字节也可以）。
 */
export function detectDocumentKind(name: string, bytes: Uint8Array): DocumentKind {
  const extension = extensionOf(name)
  const magic = magicKind(bytes)
  if (magic === 'image') return 'image'
  if (magic === 'pdf') return 'pdf'
  if (magic === 'binary') {
    // zip 家族：扩展名说是 docx 就按 docx 试（真的不是，解析会以 corrupt 报出来，
    // 比"静默当成二进制"更诚实）；xlsx / pptx / odt 等本包不解析。
    return extension === 'docx' ? 'docx' : 'binary'
  }
  // 到这里字节没有任何容器特征。扩展名说是图片，但字节不是任何认识的图片格式 ——
  // 那多半是坏文件或改了名的东西，当二进制处理，别拿去按文本解码。
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  const textKind = TEXT_EXTENSIONS[extension]
  if (textKind !== undefined) return textKind
  return looksLikeText(bytes) ? 'text' : 'binary'
}
