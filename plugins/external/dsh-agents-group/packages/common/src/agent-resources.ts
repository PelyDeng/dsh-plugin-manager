/**
 * 子包运行时资源在两种布局下的定位。
 *
 * 子包的源码被打进群组的 `dist/`，所以 `import.meta.url` 指向群组产物，而群组产物与子包
 * 源码的相对位置**在开发与发布两种形态下不同**：
 *
 * | 形态 | 代码所在 | 子包资源所在 |
 * | --- | --- | --- |
 * | 源码（`pnpm test`、`dev/`） | `<插件根>/agents/<id>/src/` | `<插件根>/agents/<id>/` |
 * | 群组产物（发布） | `<插件根>/dist/` | `<插件根>/agents/<id>/` |
 *
 * 用一条写死的相对路径无法同时覆盖两者。这里统一从**插件根**出发解析：两种形态下资源都在
 * `<插件根>/agents/<id>/` 下，只是代码距离插件根的层数不同。
 *
 * 这个不一致本身是「多子包共用一个归档」的代价。之所以值得，是因为它把资源位置收敛到一个
 * 函数里 —— 否则每个子包各自写 `../` 层数，换布局时会静默错位（装载期抛出 ENOENT，而单测
 * 因为跑的是源码而看不出来）。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 从当前模块位置向上找到插件根。
 *
 * 判据是「该目录下同时存在 `package.json` 与 `agents/`」：这正是群组插件的形状。用结构判据
 * 而不是写死层数，插件根移动位置（例如换个目录名）也不会失效。
 */
function pluginRootOf(moduleUrl: string): URL {
  let current: URL
  try {
    current = new URL(moduleUrl)
  } catch {
    throw new Error(`子包资源定位需要模块的 file URL，收到的是：${moduleUrl}`)
  }
  if (current.protocol !== 'file:') {
    throw new Error(`子包资源定位只支持本地文件，收到协议 ${current.protocol}`)
  }
  const matches = (candidate: URL): boolean => {
    try {
      return existsSync(fileURLToPath(new URL('agents/', candidate)))
        && existsSync(fileURLToPath(new URL('package.json', candidate)))
    } catch {
      // 已经退到文件系统根之上时 fileURLToPath 会拒绝，继续向上也没有意义。
      return false
    }
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = new URL('../', current)
    if (candidate.href === current.href) break
    if (matches(candidate)) return candidate
    current = candidate
  }
  throw new Error(`找不到插件根：从 ${moduleUrl} 向上都没有同时含 agents/ 与 package.json 的目录`)
}

/**
 * 求一个子包资源在群组里的位置。
 *
 * @param moduleUrl 调用方模块的 `import.meta.url`。
 * @param agentId 子包目录名，例如 `closedoff`。
 * @param relative 相对该子包根的资源路径，例如 `persona.txt` 或 `web/index.html`。
 */
export function agentResource(moduleUrl: string, agentId: string, relative: string): URL {
  return new URL(`agents/${agentId}/${relative}`, pluginRootOf(moduleUrl))
}

/** 同 {@link agentResource}，返回文件系统路径。 */
export function agentResourcePath(moduleUrl: string, agentId: string, relative: string): string {
  return fileURLToPath(agentResource(moduleUrl, agentId, relative))
}
