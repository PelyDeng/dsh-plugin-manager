/**
 * huiyu 主题契约生成器（群组二期批 3a，方案 §3.3 定案「构建期从 tokens.css 机械生成
 * :root 契约段」）。
 *
 * 从群组共享 token 层 `agents/web-common/styles/tokens.css` 的 `:root` 段机械提取
 * `--bt-*` 变量声明与 `color-scheme: light;`，生成 `src/contract.ts` 导出的字符串，
 * 由 page.ts 的 `<style>` 内联段消费——单一来源、零新路由、零外部资源。
 *
 * 提取规则（机械，不做语义筛选）：
 * - 只取 `--bt-` 前缀变量（手账 token 命名空间本身；shadcn/Tailwind 桥变量
 *   `--background` 等是 var() 引用桥，SSR 页不消费，不进契约段）；
 * - 排除值含 `url(` 的声明（现状唯一的 `--bt-ink-frame` 是 data-URI SVG 手绘边框
 *   配方，SSR 说明页不消费它）——并对生成结果断言零 `url(`，把「断网可读性核对」
 *   从人工核对变成构建期硬断言；
 * - `color-scheme: light;` 随源提取（huiyu 原 `light dark` 随契约固定为亮色，行为
 *   变化已在 page.ts 头注释与批 3a 验收记录登记）。
 *
 * 用法：
 * - `node scripts/generate-contract.mjs`        —— 生成/覆写 src/contract.ts
 * - `node scripts/generate-contract.mjs --check` —— 重新生成并与现存文件比对，
 *   不一致即退出码 1（挂在群组 check 上防「改了 tokens.css 忘了重新生成」的漂移）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUIYU = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(HUIYU, '..', 'web-common', 'styles', 'tokens.css')
const TARGET = resolve(HUIYU, 'src', 'contract.ts')

const source = readFileSync(SOURCE, 'utf8')

// 定位 `:root {` 段（tokens.css 只有一个 :root；取其起始行到配对 `}` 之间的行）。
const lines = source.split(/\r?\n/)
const start = lines.findIndex(line => line.trim().startsWith(':root'))
if (start < 0) {
  console.error(`[generate-contract] ${SOURCE} 里找不到 :root 段——token 层结构变了？`)
  process.exit(1)
}
const end = lines.findIndex((line, index) => index > start && line.trim() === '}')
if (end < 0) {
  console.error(`[generate-contract] :root 段没有闭合 \`}\`——文件被截断了？`)
  process.exit(1)
}

/** 契约声明行：--bt-* 变量（排除 url() 形态）+ color-scheme。 */
const declarations = []
const skipped = []
for (const line of lines.slice(start + 1, end)) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
  const isBtVar = /^--bt-[\w-]+\s*:/.test(trimmed)
  const isColorScheme = /^color-scheme\s*:/.test(trimmed)
  if (!isBtVar && !isColorScheme) continue
  if (trimmed.includes('url(')) {
    // --bt-ink-frame 一类 data-URI 声明：SSR 页不消费，登记后跳过（保证生成段零 url(）。
    skipped.push(trimmed.split(':')[0].trim())
    continue
  }
  declarations.push(trimmed)
}

if (declarations.length < 20) {
  // 防呆：token 层结构变化导致空提取时静默生成空契约段，比报错更糟。
  console.error(`[generate-contract] 只提取到 ${declarations.length} 条声明（预期 ≥20）——:root 段结构可疑，拒绝生成。`)
  process.exit(1)
}
const joined = declarations.join('\n')
for (const forbidden of ['url(', '`', '${', '\\']) {
  if (joined.includes(forbidden)) {
    console.error(`[generate-contract] 生成段含禁用序列 ${JSON.stringify(forbidden)}（断网纯内联约束或 TS 模板字符串安全被破坏），拒绝生成。`)
    process.exit(1)
  }
}

const banner = `/**
 * huiyu 主题契约段——本文件由 scripts/generate-contract.mjs 从
 * agents/web-common/styles/tokens.css 的 :root 段机械生成，**勿手改**。
 * 改 token 后重跑生成（群组 check 的 --check 断言会拦住漂移）。
 *
 * 生成规则：--bt-* 变量 + color-scheme: light；排除 url() 形态声明
 * （${skipped.length > 0 ? skipped.join('、') : '无'}，SSR 页不消费）——生成段零 url() 引用，断网可读。
 */
/** 原样内插进 page.ts \`<style>\` 的 :root 契约段（每行一条声明，含分号）。 */
export const CONTRACT_ROOT_CSS = \`
${declarations.map(line => `  ${line}`).join('\n')}
\`
`

if (process.argv.includes('--check')) {
  let current = null
  try {
    current = readFileSync(TARGET, 'utf8')
  } catch {
    console.error(`[generate-contract] --check：${TARGET} 不存在，先跑一次生成。`)
    process.exit(1)
  }
  if (current !== banner) {
    console.error(`[generate-contract] --check：src/contract.ts 与 tokens.css 现状不一致（tokens 改了没重新生成）。运行：node agents/huiyu/scripts/generate-contract.mjs`)
    process.exit(1)
  }
  console.log(`[generate-contract] --check 通过：契约段 ${declarations.length} 条声明与 tokens.css 同步。`)
} else {
  writeFileSync(TARGET, banner)
  console.log(`[generate-contract] 生成 ${TARGET}：${declarations.length} 条声明；跳过 url() 声明 ${skipped.length > 0 ? skipped.join('、') : '0 条'}。`)
}
