/**
 * 智能体群组内部的共享组件包。
 *
 * 只服务群组内的 Agent，不对外发布。按既定决策，它通过 workspace 引用并在构建期
 * **内联**进群组产物 —— 运行时归档里不能留下 `workspace:` / `file:` / `link:` 依赖。
 *
 * 抽取原则：**只抽真正重复且稳定的东西**。closedoff 以 TypeScript 为主、blog 以
 * `.mjs` 为主，技术栈并不一致，先不要设计「Agent 基类」——抽象错了比不抽象更贵。
 */

export * from './weather.ts'
export * from './agent-resources.ts'

/**
 * 协作契约（`AgentParticipant` 等）**不在这里**：它是运行时与协调方之间的协议，唯一归属是
 * `packages/runtime/src/contract.ts`。
 *
 * 这里曾经有一份同名拷贝（旧版、缺「待确认操作」那几个成员）。两份契约的代价不是多写几行，
 * 而是**漂移后无人察觉**：runtime 那份加了 `listActions` / `applyAction`，blog 通过这份旧类型
 * 看不见自己已经实现的能力——编译期全绿、判据写不出来、运行时却真的在跑。契约只留一份。
 */

/** 包版本，用于确认内联生效（构建后不应依赖外部解析）。 */
export const COMMON_VERSION = '0.1.0'

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
