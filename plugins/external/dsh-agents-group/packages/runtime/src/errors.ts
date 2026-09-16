/**
 * 用户可读的错误整理（自 `@dsh-agents-group/common` 的 `src/index.ts` 迁来）。
 *
 * 它是「所有 Agent 都要用、且必须逐字一致」的共享能力：两个 Agent 各自实现同一件事时，
 * 总有一边忘记抹掉本机路径或凭据形状。
 */

/**
 * 把错误整理成用户可读的一句话。
 *
 * 这是第一个确认要抽的能力：两个 Agent 都在各自实现同一件事，且都要抹掉本机路径
 * 与凭据形状，避免把内部信息展示给使用者。
 */
export function visibleErrorMessage(error: unknown, limit = 500): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误'
  const cleaned = raw
    .replace(/[A-Za-z]:\\[^\s，。；]+/gu, '（本机路径）')
    .replace(/\/(?:home|Users|var|opt|srv)\/[^\s，。；]+/gu, '（本机路径）')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '（凭据）')
  const text = cleaned.replace(/\s+/gu, ' ').trim()
  if (text === '') return '未知错误'
  return text.length > limit ? `${[...text].slice(0, Math.max(1, limit - 1)).join('')}…` : text
}
