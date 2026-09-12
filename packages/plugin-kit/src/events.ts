/**
 * Cordis 事件通道的类型增强，单独成文件。
 *
 * 为什么必须单独一份：kit 被多个插件以**不同符号链接路径**引用（每个插件的
 * `node_modules/@dsh-plugin-manager/plugin-kit` 各自指向同一实体目录），TypeScript 按
 * 解析到的路径区分模块身份。如果这份 `declare module` 出现在被加载两次的模块里，
 * 同一个事件属性就会被声明两次，在 `skipLibCheck: false` 下直接报 TS2717 —— 而两个
 * 类型**看起来完全一样**，报错信息不会告诉你是重复加载造成的。
 *
 * 所以这里保持「一个事件通道只有一个声明」：谁需要这些事件就导入本模块，
 * 不要在其他文件里重复写 `declare module '@deepseek-ai/cordis'`。
 */

import type { AuthProvider, PluginDescriptor, Revocation } from './access.ts'

/** 目录条目：插件以协议版本 + 自身描述登记，读取方据此判断兼容性。 */
export interface CatalogEntry { readonly protocol: number; readonly plugin: PluginDescriptor }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'ecosystem/catalog': (accept: (entry: CatalogEntry) => void) => void
    'ecosystem/providers': (accept: (provider: AuthProvider) => void) => void
    'ecosystem/revoked': (scope: Revocation) => void
  }
}
