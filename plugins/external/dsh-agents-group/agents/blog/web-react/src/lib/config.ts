/**
 * 页面配置（批 0 定型的 body data-base 通道；方案 §4.4）。
 *
 * 本页 CSP 为 script-src 'self'——不允许 head inline 注入（与 butler/CLOSEDOFF_CONFIG
 * 的 inline 通道不同构）。前缀由服务端替换进 `<body data-base="__BASE__">`，
 * HTML 属性不受 script-src 约束，零新资源。
 *
 * 测试注入：单测在**被测模块加载前**设 `globalThis.__BLOG_BASE__`（Node 环境无
 * document；helpers.ts 同 closedoff installBrowserGlobals 的时序约束），生产环境
 * 不存在该全局，恒走 data-base 读取。
 */

/** 读取路由前缀（缺配置直接抛错：不渲染残缺页面）。 */
export function resolveBase(): string {
  const injected = (globalThis as { __BLOG_BASE__?: unknown }).__BLOG_BASE__
  if (typeof injected === 'string' && injected !== '') return injected
  const base = typeof document === 'undefined' ? '' : document.body?.dataset.base ?? ''
  if (base === '') throw new Error('博客页面配置缺失（body data-base）')
  return base
}

/** 模块加载期读一次：服务端替换发生在 HTML 里，运行期不变。 */
export const BASE = resolveBase()

/** 资源/接口路径：BASE + 相对路径（与旧页面 base+path 拼法一致）。 */
export function basePath(path: string): string {
  return BASE + path
}
