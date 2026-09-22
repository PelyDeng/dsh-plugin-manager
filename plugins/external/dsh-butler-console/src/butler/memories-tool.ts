/**
 * butler 的记忆工具（P1.5：实现上收 plugin-kit，本文件只是**插件侧适配层**）。
 * 全部机制来自 kit 的 memory-tools 模块；这里的差异只有调用点签名映射
 * （butler 内部用 `actor` 命名，kit 用 `getActor`）。
 */
export { makeMemoryTools, confirmForget, MEMORY_FORGET_TTL_MS } from '@dsh-plugin-manager/plugin-kit'
export type { MemoryToolsDeps, PendingForget, PendingForgetIndex } from '@dsh-plugin-manager/plugin-kit'
