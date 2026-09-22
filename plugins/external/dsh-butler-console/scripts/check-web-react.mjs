/**
 * web-react 边界门禁（批 6，替代原 check-web-cycles / check-module-leaks）：
 * 1. web-react/src 不得引用已删除的旧前端目录（../web/ 下的 js/css/html）；
 * 2. web-react/src 模块引用图不得出现循环依赖（DFS 检测，环约束长期价值保留）。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(root, '../web-react/src')
const legacyWebDir = resolve(root, '../web')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(srcDir)
let errors = 0

// 1. 旧前端目录引用禁令（迁移完成后 web/ 仅剩 media 与 fonts 资产）
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const legacy = source.match(/from\s+['"][^'"]*\/web\/[^'"]*['"]/g)
  if (legacy !== null) {
    console.error(`[legacy-import] ${file}: ${legacy.join(' ')}`)
    errors += 1
  }
}

// 2. 循环依赖（import 相对路径解析为文件，DFS 找回边）
const graph = new Map()
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const imports = [...source.matchAll(/from\s+['"](\.[^']+)['"]/g)].map(match => {
    const spec = match[1]
    const base = resolve(dirname(file), spec)
    for (const candidate of [base, base + '.ts', base + '.tsx', base + '.js', base + sep + 'index.ts', base + sep + 'index.tsx']) {
      if (existsSync(candidate) && !candidate.endsWith(sep)) return candidate
      if (existsSync(candidate)) return candidate
    }
    return null
  }).filter(value => value !== null)
  graph.set(file, imports)
}

const WHITE = 0
const GREY = 1
const BLACK = 2
const color = new Map()
let cycles = 0
function dfs(node, stack) {
  color.set(node, GREY)
  stack.push(node)
  for (const next of graph.get(node) ?? []) {
    const state = color.get(next) ?? WHITE
    if (state === GREY) {
      cycles += 1
      const start = stack.indexOf(next)
      console.error(`[cycle] ${stack.slice(start).map(f => f.replace(srcDir, '')).join(' -> ')} -> ${next.replace(srcDir, '')}`)
    } else if (state === undefined || state === WHITE) {
      dfs(next, stack)
    }
  }
  stack.pop()
  color.set(node, BLACK)
}
for (const file of files) {
  if ((color.get(file) ?? WHITE) === WHITE) dfs(file, [])
}

if (errors > 0 || cycles > 0) {
  console.error(`check-web-react: ${errors} legacy import(s), ${cycles} cycle(s)`)
  process.exit(1)
}

// 产物体积门禁（评审 #8）：app.js 超过硬上限拦下、逼近上限警告——超限只能靠人眼是漏报源。
// dist 未构建时跳过（门禁日常在构建前跑；发版链路 build 后会再跑一次）。
const appJs = resolve(root, '../dist/web/app.js')
let sizeLabel = ''
if (existsSync(appJs)) {
  const bytes = Number(statSync(appJs).size)
  const LIMIT_HARD = 1_300_000
  const LIMIT_WARN = 1_200_000
  sizeLabel = ` (app.js ${(bytes / 1024).toFixed(1)} KB)`
  if (bytes > LIMIT_HARD) {
    console.error(`check-web-react: bundle over hard limit${sizeLabel}`)
    process.exit(1)
  }
  if (bytes > LIMIT_WARN) console.warn(`check-web-react: bundle approaching limit${sizeLabel}`)
}
console.log(`check-web-react: ${files.length} files, no legacy imports, no cycles${sizeLabel}`)
