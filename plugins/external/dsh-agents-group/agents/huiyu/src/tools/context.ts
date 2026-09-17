/**
 * 工具层的共享装配。
 *
 * 八个工具放在同一个模块里而不是一人一个文件：它们共享同一套上下文、同一套参数解析和同一份
 * 错误口径，拆开只会让"这个工具有没有做参数校验"要靠翻八个文件才能确认。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HuiyuEnvironment } from '../env.ts'
import { invalid } from '../errors.ts'
import type { ImageGenerationProvider } from '../image/index.ts'
import type { HuiyuStore } from '../store.ts'
import type { MinioClient } from '../minio/client.ts'
import type { AttachmentService } from '../media/attachments.ts'

/**
 * 参数校验用的错误构造，从这里转出。
 *
 * 各工具模块只需要 import 这一处：它们的依赖面就是"上下文 + 参数解析 + 错误口径"，
 * 让每个工具再去 `../errors.ts` 各取一次只会让依赖关系变散。
 */
export { invalid }

/** 工具执行需要的一切。装配期建一次，工具按需取用。 */
export interface HuiyuToolContext {
  readonly ctx: Context
  readonly environment: HuiyuEnvironment
  /** 对象存储；未配置时为 undefined，生图工具据此给出"未配置"而不是崩溃。 */
  readonly minio: MinioClient | undefined
  readonly imageProvider: ImageGenerationProvider
  /** 业务存储；未配置时为 undefined。 */
  readonly store: HuiyuStore | undefined
  /** 宿主附件服务；未装配时工具按未就绪拒绝。 */
  readonly attachments: () => AttachmentService
}

/**
 * 读一个必填的字符串参数。
 *
 * 模型给的工具参数是**不可信输入**（它可能给数字、给 null、给超长串），所以每个字段都要过一遍。
 * 长度上限不是洁癖：一个几万字的提示词会让上游直接拒绝，而错误信息会指向"请求过大"，
 * 与真实原因（模型把正文当提示词了）差得很远。
 */
export function requiredString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key]
  if (typeof value !== 'string') throw invalid(`参数 ${key} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed === '') throw invalid(`参数 ${key} 不能为空`)
  if (trimmed.length > maxLength) throw invalid(`参数 ${key} 过长（最多 ${maxLength} 字，收到 ${trimmed.length} 字）`)
  return trimmed
}

/** 读一个可选字符串参数。 */
export function optionalString(args: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`参数 ${key} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > maxLength) throw invalid(`参数 ${key} 过长（最多 ${maxLength} 字）`)
  return trimmed
}

/**
 * 读一个必填的字符串数组。
 *
 * 上限同样是防御性的：一次要生成十几张图会**真的花钱**，而模型很容易把"配图"理解成给每一段
 * 都来一张。上限让它在一次调用里就撞到边界，而不是先花掉钱再被用户发现。
 */
export function requiredStringArray(args: Record<string, unknown>, key: string, maxItems: number, maxLength: number): readonly string[] {
  const value = args[key]
  if (!Array.isArray(value)) throw invalid(`参数 ${key} 必须是字符串数组`)
  if (value.length === 0) throw invalid(`参数 ${key} 不能为空数组`)
  if (value.length > maxItems) throw invalid(`参数 ${key} 最多 ${maxItems} 项（收到 ${value.length} 项）`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw invalid(`参数 ${key}[${index}] 必须是字符串`)
    const trimmed = item.trim()
    if (trimmed === '') throw invalid(`参数 ${key}[${index}] 不能为空`)
    if (trimmed.length > maxLength) throw invalid(`参数 ${key}[${index}] 过长（最多 ${maxLength} 字）`)
    return trimmed
  })
}

/**
 * 一个工具的固定元数据：名字、显示名、说明。
 *
 * `parameters` 按**标准 JSON Schema** 写（`{ type, properties, required }`）——那是所有人都会写、
 * 也是模型看到的文案来源的形状。注册时由 `tools/index.ts` 翻成宿主自定义的词汇，翻译规则只有
 * 一份，工具模块不必了解宿主的 schema 方言。
 */
export interface ToolSpec {
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, {
      readonly type?: string
      readonly description?: string
      readonly items?: { readonly type?: string }
      readonly enum?: readonly string[]
    }>>
    readonly required?: readonly string[]
  }
}

/**
 * 一次工具执行能拿到的运行时信息。
 *
 * `sessionId` 是**记账必需**的：业务记录里要留下"这张图是哪个会话的哪一轮要的"，因为生成的
 * 图片不进备份，图丢了只能靠这两个字段定位回原会话重新生成。
 *
 * ⚠️ **归属按会话派生，不是按登录用户**：工具执行面上拿不到本轮 `actor`（它只在结果投影阶段
 * 出现），所以这里用会话标识作为归属键。后果是同一用户的两个会话各自成组，列表按会话分而非
 * 按人合并——不影响正确性，也不影响"回查是哪一轮要的图"。要按用户合并需要运行时把 actor
 * 下推到工具执行面，那是运行时契约的改动，不在本次范围。
 */
export interface ToolExecution {
  readonly signal: AbortSignal
  readonly agent: object | undefined
  /** 宿主会话 id。 */
  readonly sessionId: string
}

/** 一个工具：定义 + 实现。 */
export interface HuiyuTool {
  readonly spec: ToolSpec
  readonly run: (args: Record<string, unknown>, execution: ToolExecution) => Promise<readonly unknown[]>
}
