/**
 * 群组侧 React 前端共享基元层（React 二期批 0，方案 §3.1）。
 *
 * 收编自 butler 0.14.6 已验收资产：Icon（Lucide 内联）、RichText（受控 DOM 飞地的
 * React 包装）与其渲染器 markdown.js、useFlash（就近轻提示）、announce（读屏播报）。
 * 成员以 devDependencies: workspace:* 引用，构建经 tsdown deps.alwaysBundle
 * 内联显式包名（运行时归档零 workspace 依赖）。
 */
export { Icon, type IconName } from './Icon.tsx'
export { RichText, type RichTextProps } from './RichText.tsx'
export { useFlash } from './lib/useFlash.ts'
export { announce } from './lib/announce.ts'
export { errorTextOf } from './lib/error-text.ts'
