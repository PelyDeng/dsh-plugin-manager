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
 * 协作契约显式列出，而不是 `export *`：这个模块**只有类型**（外加一个版本常量），
 * 打包器在生成声明时会把纯类型转发丢掉，子包构建就会报 `AgentParticipant is not exported`。
 */
export { PARTICIPANT_PROTOCOL } from './participant.ts'
export type {
  AgentParticipant,
  ParticipantArtifact,
  ParticipantProgress,
  ParticipantRequest,
  ParticipantResult,
  ParticipantStatus,
} from './participant.ts'

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
