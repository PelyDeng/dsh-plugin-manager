/**
 * 错误呈现（拆分 v2 批 2）：把内部异常翻成给老板看的短句；堆栈只进日志。
 */

import { clip } from './text.ts'

/**
 * 把失败原因裁剪成用户可读的一段话。
 *
 * 设计文档要求不展示内部路径、配置值和凭据，所以这里只保留错误消息本身，并抹掉
 * 可能出现的绝对路径和密钥形状的片段。
 *
 * 但「不泄露」不等于「什么都不说」：早先这里对任何非 Error 的抛出物一律返回
 * 「未知错误」，结果是模型调用失败时页面上只有这四个字，连失败来自哪一类都不知道，
 * 排查只能靠猜。宿主的事件里 `reason.error` 既可能是 Error，也可能是普通对象、
 * 字符串或别的抛出物，所以这里按几种常见形状尽力取出**有信息量的那一部分**，
 * 再统一做脱敏。脱敏规则只有这一份，所有出口都走它。
 */
export function describeThrown(error: unknown): string {
  if (error === null || error === undefined) return ''
  if (error instanceof Error) {
    const name = typeof error.name === 'string' ? error.name.trim() : ''
    const message = typeof error.message === 'string' ? error.message.trim() : ''
    // name 是 'Error' 时没有信息量，只有别的名字（如 LlmError、TypeError）才值得带出来。
    return name !== '' && name !== 'Error' ? (message === '' ? name : `${name}: ${message}`) : message
  }
  if (typeof error === 'string') return error.trim()
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error)
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    // 常见形状：{ code, message } / { name, message } / 带 cause 的包装对象。
    const parts: string[] = []
    for (const key of ['code', 'name', 'message'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim())
    }
    if (parts.length > 0) return parts.join(': ')
    // 空对象与空数组同样没有信息量，如实退回「未知错误」而不是显示一个空壳。
    const keys = Object.keys(record)
    if (keys.length === 0) return ''
    // 认不出来时给出对象内容的简短摘要，比「未知错误」有用得多。
    try {
      const text = JSON.stringify(error)
      if (typeof text === 'string' && text !== '{}' && text !== 'null' && text !== '[]') return text
    } catch { /* 循环引用等无法序列化的情况退回字段摘要 */ }
    return `无法识别的错误对象（字段：${keys.slice(0, 6).join(', ')}）`
  }
  return ''
}

/**
 * 取出一段可写进日志的错误栈，并抹掉本机绝对路径。
 *
 * 只用于服务端日志：宿主与插件的部署路径、账号名等不该出现在日志里，但文件名与行号
 * 是定位问题的关键，所以保留相对形态。
 */
export function stackOf(error: unknown): string {
  if (error === null || error === undefined) return '（无抛出物）'
  const raw = error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : describeThrown(error)
  return (raw === '' ? '（无栈信息）' : raw)
    .replace(/[A-Za-z]:\\[^\s)]+/gu, '…')
    .replace(/\/(?:data|home|Users|opt|srv|var)\/[^\s):]+/gu, '…')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '（凭据）')
    .slice(0, 4000)
}

export function visibleError(error: unknown, limit: number): string {
  const cleaned = describeThrown(error)
    .replace(/[A-Za-z]:\\[^\s，。；]+/gu, '（本机路径）')
    .replace(/\/(?:home|Users|var|opt|srv)\/[^\s，。；]+/gu, '（本机路径）')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '（凭据）')
  return clip(cleaned === '' ? '未知错误' : cleaned, limit)
}
