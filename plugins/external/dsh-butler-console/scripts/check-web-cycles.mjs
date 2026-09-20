/**
 * web 域模块的 import 环检测（拆分设计 v2 §4.1 门禁）。
 *
 * app.js 拆分后依赖图存在两个**文档化环簇**（ES 模块函数声明环在运行时安全：
 * 簇内模块只含函数声明、无顶层 const 相互求值依赖，调用都发生在模块求值之后）：
 *   - 环簇一：events ↔ cards ↔ send（卡片 UI 触发回合的固有边）
 *   - 环簇二：panels ↔ history（列表点击进详情、详情刷新列表）
 * 白名单只放这两簇的**内部环**；任何新增的环（尤其涉及模块求值顺序的顶层依赖）会在这里红。
 *
 * 用法：node scripts/check-web-cycles.mjs（package.json check 已串入）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../web')

/** 文档化环簇（拆分设计 v2）：簇内节点构成的环豁免。 */
const CYCLE_WHITELIST = [
  new Set(['events', 'cards', 'send']),
  new Set(['panels', 'history']),
]

function moduleGraph() {
  const files = ['app.js']
  const modulesDir = join(WEB_ROOT, 'modules')
  if (existsSync(modulesDir)) {
    for (const name of readdirSync(modulesDir)) {
      if (name.endsWith('.js')) files.push(`modules/${name}`)
    }
  }
  const edges = new Map()
  const idOf = file => file === 'app.js' ? 'app' : file.replace(/^modules\//, '').replace(/\.js$/, '')
  for (const file of files) {
    const text = readFileSync(join(WEB_ROOT, file), 'utf8')
    const deps = new Set()
    for (const match of text.matchAll(/import\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
      const target = match[1].replace(/^\.\//, '').replace(/^modules\//, '')
      const id = idOf(target)
      if (id !== 'app' && target !== 'app.js') deps.add(id)
      else deps.add('app')
    }
    edges.set(idOf(file), deps)
  }
  return edges
}

/** 找出全部环（每个环报一次，节点集合去重）。 */
function findCycles(edges) {
  const cycles = []
  const seenCycles = new Set()
  const walk = (node, path, visited) => {
    for (const dep of edges.get(node) ?? []) {
      if (!edges.has(dep)) continue
      if (visited.has(dep)) {
        const start = path.indexOf(dep)
        const cycle = [...path.slice(start), dep]
        const key = [...new Set(cycle)].sort().join('|')
        if (!seenCycles.has(key)) { seenCycles.add(key); cycles.push(cycle) }
        continue
      }
      if (path.length > edges.size) continue
      walk(dep, [...path, dep], new Set([...visited, dep]))
    }
  }
  for (const node of edges.keys()) walk(node, [node], new Set([node]))
  return cycles
}

const edges = moduleGraph()
const cycles = findCycles(edges)
const illegal = cycles.filter(cycle => {
  const nodes = new Set(cycle.slice(0, -1))
  return ![...CYCLE_WHITELIST].some(cluster => nodes.size <= cluster.size && [...nodes].every(n => cluster.has(n)))
})

if (illegal.length > 0) {
  console.error('web 模块依赖出现白名单外的环（文档化环簇只有 {events,cards,send} 与 {panels,history}）：')
  for (const cycle of illegal) console.error('  ' + cycle.join(' → '))
  process.exit(1)
}
console.log(`web 模块环检测通过：${edges.size} 个文件，白名单环 ${cycles.length - illegal.length} 个，无新增环。`)
