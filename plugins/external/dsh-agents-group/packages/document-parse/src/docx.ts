/**
 * DOCX 解析工具。
 *
 * 两件事：先自己走一遍压缩包，再交给 `mammoth` 抽文字。顺序不能反。
 *
 * ## 为什么要自己走一遍压缩包
 *
 * DOCX 就是个 zip，而 zip 的头部可以声称"展开后 100 字节"、实际吐出几个 GB（zip 炸弹）。
 * `mammoth` 会老老实实解开它。所以这里按**真实读到的字节数**累加，超限立刻停。顺带做三件
 * mammoth 不管的事：
 *
 * - 拒掉加密包（通用位标记第 0 位）——解出来也是密文；
 * - 拒掉带宏的文档（`vbaProject`）——这是**主动不收**，不是"读不动"，两者对用户的说法不同；
 * - 核验 `word/document.xml` 存在，否则"这不是一个 DOCX"，而不是"这个文档是空的"。
 *
 * 依赖 `yauzl`（走包）与 `mammoth`（抽文字），都按需动态加载，缺了报 `unavailable`。
 */

import { Buffer } from 'node:buffer'
import { DocumentParseError, resolveLimits, type DocumentLimits } from './limits.ts'
import { createBudget, loadDependency, type Budget, type DocumentLoader } from './budget.ts'
import { detectDocumentKind } from './kinds.ts'
import { assertHasText, asCorrupt, collectUnits, type ParsedDocument } from './units.ts'

/** 依赖名；写成常量是为了让"用哪两个包"只有一个出处。 */
export const DOCX_DEPENDENCIES = ['yauzl', 'mammoth'] as const

/** 入参：文件名与完整字节。 */
export interface DocxParseInput {
  readonly name: string
  readonly bytes: Uint8Array
}

/** DOCX 解析的可选项。 */
export interface DocxParseOptions {
  readonly limits?: Partial<DocumentLimits> | undefined
  readonly signal?: AbortSignal | undefined
  readonly load?: DocumentLoader | undefined
}

/** `yauzl` 在本工具里用到的面。 */
interface ZipEntryLike {
  readonly fileName: string
  readonly uncompressedSize: number
  readonly generalPurposeBitFlag: number
}

interface ZipLike {
  on(event: 'error', handler: (error: Error) => void): void
  on(event: 'end', handler: () => void): void
  on(event: 'entry', handler: (entry: ZipEntryLike) => void): void
  readEntry(): void
  openReadStream(entry: ZipEntryLike, callback: (error: Error | null, stream: NodeJS.ReadableStream | undefined) => void): void
  close(): void
}

interface YauzlLike {
  fromBuffer(
    buffer: Buffer,
    options: { lazyEntries: boolean, validateEntrySizes: boolean },
    callback: (error: Error | null, zip: ZipLike | undefined) => void,
  ): void
}

/**
 * 核验压缩包结构，超限立刻停。
 *
 * 用 `lazyEntries` 逐个取条目而不是一次列出全部：一次列出会先信任头部的
 * `uncompressedSize`，而那正是炸弹要骗的那个数。这里逐个真读，读到多少算多少。
 */
export function validateDocxArchive(
  buffer: Buffer,
  yauzl: YauzlLike,
  limits: DocumentLimits,
  budget: Budget,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error !== null || zip === undefined) {
        reject(new DocumentParseError('corrupt', 'DOCX 文件损坏或不是有效的压缩包'))
        return
      }
      const archive = zip
      let total = 0
      let count = 0
      let hasDocument = false
      let settled = false
      const stop = (failure: DocumentParseError): void => {
        if (settled) return
        settled = true
        archive.close()
        reject(failure)
      }
      archive.on('error', () => { stop(new DocumentParseError('corrupt', 'DOCX 文件损坏')) })
      archive.on('end', () => {
        if (!hasDocument) {
          stop(new DocumentParseError('corrupt', '不是有效的 DOCX 文档（缺少 word/document.xml）'))
          return
        }
        settled = true
        resolve()
      })
      archive.on('entry', (entry) => {
        try {
          budget.checkpoint()
        } catch (caught) {
          stop(caught as DocumentParseError)
          return
        }
        count += 1
        if (count > limits.maxEntries) {
          stop(new DocumentParseError('too_large', `DOCX 内部条目超过 ${limits.maxEntries} 个`))
          return
        }
        if (entry.uncompressedSize > limits.maxExpandedBytes) {
          stop(new DocumentParseError('too_large', 'DOCX 展开后超过大小限制'))
          return
        }
        if ((entry.generalPurposeBitFlag & 1) !== 0) {
          stop(new DocumentParseError('encrypted', 'DOCX 已加密，无法读取'))
          return
        }
        if (entry.fileName === 'word/document.xml') hasDocument = true
        if (/vbaProject|\.bin$/iu.test(entry.fileName)) {
          stop(new DocumentParseError('encrypted', '不支持包含宏或嵌入对象的文档'))
          return
        }
        if (entry.fileName.endsWith('/')) {
          archive.readEntry()
          return
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            stop(new DocumentParseError('corrupt', 'DOCX 文件损坏'))
            return
          }
          stream.on('error', () => { stop(new DocumentParseError('corrupt', 'DOCX 文件损坏')) })
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > limits.maxExpandedBytes) {
              stop(new DocumentParseError(
                'too_large',
                `DOCX 展开后超过 ${Math.round(limits.maxExpandedBytes / 1024 / 1024)} MiB`,
              ))
            }
          })
          stream.on('end', () => { if (!settled) archive.readEntry() })
        })
      })
      archive.readEntry()
    })
  })
}

/**
 * 解析一份 DOCX。
 *
 * @throws DocumentParseError `empty` / `too_large`（含展开后超限）/ `corrupt` /
 *   `encrypted`（加密或带宏）/ `unavailable`（缺依赖）/ `no_text` / `timeout` / `aborted`。
 */
export async function parseDocxDocument(
  input: DocxParseInput,
  options: DocxParseOptions = {},
): Promise<ParsedDocument> {
  const limits = resolveLimits(options.limits)
  const bytes = input.bytes
  if (bytes.length === 0) throw new DocumentParseError('empty', '文件是空的')
  if (bytes.length > limits.maxBytes) {
    throw new DocumentParseError('too_large', `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)} MiB`)
  }
  if (detectDocumentKind(input.name, bytes) !== 'docx') {
    throw new DocumentParseError('corrupt', '文件内容不是 DOCX')
  }
  const load = options.load ?? (specifier => import(specifier))
  const budget = createBudget(limits, options.signal)
  budget.checkpoint()

  const buffer = Buffer.from(bytes)
  const yauzl = await loadDependency(load, 'yauzl', '解析 DOCX 需要先核验压缩包结构')
  const fromBuffer = yauzl['fromBuffer']
  if (typeof fromBuffer !== 'function') {
    throw new DocumentParseError('unavailable', '依赖 yauzl 的版本不兼容（缺少 fromBuffer）')
  }
  await validateDocxArchive(buffer, yauzl as unknown as YauzlLike, limits, budget)
  budget.checkpoint()

  const mammoth = await loadDependency(load, 'mammoth', '解析 DOCX 需要文本抽取')
  const extractRawText = mammoth['extractRawText']
  if (typeof extractRawText !== 'function') {
    throw new DocumentParseError('unavailable', '依赖 mammoth 的版本不兼容（缺少 extractRawText）')
  }
  const extracted = await asCorrupt(
    async () => await (extractRawText as (input: unknown, options: unknown) => Promise<{ value?: unknown }>)
      .call(mammoth, { buffer }, { externalFileAccess: false }),
    'DOCX 文件损坏或读不出来',
  )
  const text = typeof extracted?.value === 'string' ? extracted.value : ''
  budget.checkpoint()
  // 空行分段：DOCX 的换行语义就是段落，按行切会让一段长文碎成几百个"单元"。
  const parts = text.split(/\n\s*\n/u)
  const collected = collectUnits(parts, limits, budget)
  assertHasText(collected.units, '文档里没有可读取的文字')
  return {
    kind: 'docx',
    unit: '段',
    units: collected.units,
    totalUnits: parts.length,
    characters: collected.characters,
    partial: collected.partial,
  }
}
