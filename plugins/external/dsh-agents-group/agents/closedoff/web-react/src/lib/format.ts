/**
 * 展示格式化（旧 web/format.js 的等价迁移）：token 数、耗时与终态文案。
 * 纯函数，单测直接对照旧实现行为。
 */
import { stripMarkdownTables } from './render-text.ts'

export function compactTokens(value: number | undefined): string {
  const n = Number(value) || 0
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}M tok`
  if (n >= 1000) return `${Math.round(n / 100) / 10}K tok`
  return `${n.toLocaleString('zh-CN')} tok`
}

export function exactTokens(value: number | undefined): string {
  return `${(Number(value) || 0).toLocaleString('zh-CN')} tok`
}

export function compactDuration(ms: number | undefined): string {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 1000) return `${Math.round(n)} 毫秒`
  if (n < 60000) return `${Math.round(n / 100) / 10} 秒`
  const minutes = Math.floor(n / 60000)
  return `${minutes} 分 ${Math.round((n % 60000) / 1000)} 秒`
}

export function summaryDuration(ms: number | undefined): string {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function fmtClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => (n < 10 ? '0' : '') + n
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 回合未正常完成的提示（旧 finishReasonMessage 等价）。 */
export function finishReasonMessage(reason: string | undefined, hasResult: boolean): string {
  if (reason === undefined || reason === '' || reason === 'completed') return ''
  const messages: Record<string, string> = {
    aborted: '本轮回答已停止，内容可能不完整。',
    interrupted: '本轮回答因运行中断而未完成。',
    'max-tokens': '本轮回答达到输出上限，内容可能不完整。',
    blocked: '本轮请求被阻止，尚未执行或继续。',
    error: '本轮回答发生错误，未能完整结束。',
  }
  const message = messages[reason] ?? '本轮回答未正常完成。'
  return message + (hasResult ? ' 上方查询结果已保留，可发送“继续分析”生成或补全结论。' : ' 请重试或补充条件后再次查询。')
}

/** 助手正文：存在结构化结果时剥离 Markdown 表格（旧 answerText/renderAnalysis 口径）。 */
export function assistantDisplayText(text: string, hasStructured: boolean): string {
  return hasStructured ? stripMarkdownTables(text) : text
}
