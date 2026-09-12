/**
 * kit 的公开入口。
 *
 * 这里的导出形式是刻意的：`./events.ts` 单独导出，`./access.ts` 用**显式命名**导出而
 * 不是 `export *`。原因是 `access.ts` 会转出 events 的 Cordis 事件增强，星号导出会让
 * 同一个事件通道经由两条路径各声明一次；kit 又被多个插件以不同符号链接路径引用，
 * TypeScript 按解析路径区分模块身份，于是重复声明在 `skipLibCheck: false` 下报
 * TS2717（两个类型看起来完全一样，报错不会说明是重复加载造成的）。详见 events.ts。
 */

export type { CatalogEntry } from './events.ts'
export {
  AGENT_PLUGIN_CATEGORY,
  AccessError,
  actorKey,
  collectProviders,
  createAccess,
  emitRevoked,
  installProvider,
  isAccessError,
  listPlugins,
  onRevoked,
  pluginCategoryLabels,
  pluginCategoryOrder,
  registerPlugin,
} from './access.ts'
export type {
  Access,
  AccessMode,
  Actor,
  AuthProvider,
  PluginCategory,
  PluginDescriptor,
  Revocation,
  ToolDescriptor,
} from './access.ts'
export * from './http.ts'
export * from './tools.ts'
export * from './conversations.ts'
export * from './models.ts'
