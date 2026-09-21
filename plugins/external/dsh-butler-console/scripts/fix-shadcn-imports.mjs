/**
 * shadcn / ai-elements CLI 产物导入路径修正：把 web-react/src 下 tsx 的
 * `@/...` 无扩展名 import 补成显式 .tsx/.ts（仓库 tsconfig 是 NodeNext +
 * 显式扩展名纪律，CLI 产物是 bundler 风格，两者冲突）。
 *
 * 每次用 CLI add 组件后运行：node scripts/fix-shadcn-imports.mjs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../web-react/src')
const extensions = ['.tsx', '.ts']

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.tsx$/.test(entry.name))
    .map(entry => join(entry.parentPath ?? entry.path, entry.name))
}

let changed = 0
for (const file of walk(root)) {
  const source = readFileSync(file, 'utf8')
  const fixed = source.replaceAll(/(from\s+")@\/([^"]+)(")/g, (whole, lead, spec, tail) => {
    if (/\.(tsx|ts|mjs|css)"$/.test(lead + spec + tail)) return whole
    const base = join(root, spec)
    const hit = extensions.find(ext => existsSync(base + ext))
    return hit === undefined ? whole : `${lead}@/${spec}${hit}${tail}`
  })
  if (fixed !== source) {
    writeFileSync(file, fixed)
    changed += 1
  }
}
console.log(`fix-shadcn-imports: ${changed} file(s) updated`)

// CLI（shadcn / ai-elements）add 会把组件的第三方依赖塞进**运行时** dependencies——
// 本仓纪律是前端包全部进 devDependencies（tsdown alwaysBundle 打进产物，运行时零污染）。
// 这里只检查并报出，不动 package.json：命中即手工 `pnpm remove <包> && pnpm add -D <包>`。
// 白名单 = 插件后端的真运行时依赖（附件解析等），它们本就该在 dependencies。
const BACKEND_RUNTIME = new Set(['@deepseek-ai/schemastery', 'mammoth', 'pdfjs-dist', 'yauzl'])
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'))
const polluted = Object.keys(pkg.dependencies ?? {}).filter(name => !BACKEND_RUNTIME.has(name))
if (polluted.length > 0) {
  console.error(`[dependencies 污染] 以下包必须移到 devDependencies（或删除）：\n  ${polluted.join('\n  ')}`)
  process.exitCode = 1
}
