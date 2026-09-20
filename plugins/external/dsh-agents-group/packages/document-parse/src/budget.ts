/**
 * 解析的时间预算与依赖加载。
 *
 * 这两件事是三个解析工具（文本 / PDF / DOCX）共用的底座，所以单独一个文件：
 * 工具之间**不互相调用**，只共用这里和 `units.ts`。
 */

import { DocumentParseError, type DocumentLimits } from './limits.ts'

/** 解析依赖的加载器。返回该模块的导出对象；加载不到时抛错。 */
export type DocumentLoader = (specifier: string) => Promise<unknown>

/** 缺省的依赖加载器：变量说明符，打包器因此不会把它内联。 */
export const defaultLoader: DocumentLoader = specifier => import(specifier)

/** 一次解析的时间预算与中止状态的记账。 */
export interface Budget {
  /** 每个单元之间调一次；超时或已中止就抛。 */
  checkpoint(): void
}

/**
 * 记账的起点。
 *
 * 预算**只**在单元之间检查，不打断一次已经在跑的解析调用：进程内解析（见 README「为什么不起
 * worker」）本来就没法强杀，与其假装能中断，不如把预算用在"不要把剩下的页读完"这件事上。
 */
export function createBudget(limits: DocumentLimits, signal: AbortSignal | undefined): Budget {
  const startedAt = Date.now()
  return {
    checkpoint(): void {
      if (signal?.aborted === true) throw new DocumentParseError('aborted', '解析已中止')
      if (Date.now() - startedAt > limits.timeoutMs) {
        throw new DocumentParseError('timeout', `解析超过 ${Math.round(limits.timeoutMs / 1000)} 秒，已停止`)
      }
    },
  }
}

/**
 * 按名字加载一个解析依赖。
 *
 * 缺依赖与"文件坏了"是两件完全不同的事：前者是部署问题，后者是用户的问题。报成同一句话会让
 * 两边都查错方向，所以这里给一个专属错误码。
 */
export async function loadDependency(
  load: DocumentLoader,
  specifier: string,
  purpose: string,
): Promise<Record<string, unknown>> {
  try {
    const loaded = await load(specifier)
    if (loaded === null || typeof loaded !== 'object') throw new Error('模块没有可用的导出')
    return loaded as Record<string, unknown>
  } catch {
    throw new DocumentParseError('unavailable', `${purpose}，当前部署没有安装依赖 ${specifier}`)
  }
}
