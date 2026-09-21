// 跨模块引用完整性检查：模块文件函数体引用了「其他模块的导出符号」但本文件未 import 的漏网。
// 这是运行时 ReferenceError 的来源（rolldown/vitest 沙盒都测不出，只有真实浏览器炸）。
import { readFileSync, readdirSync } from 'node:fs'

const files = ['web/app.js', ...readdirSync('web/modules').map(f => `web/modules/${f}`)]

// 1. 符号 -> 定义文件（每模块的导出面）
const owner = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/^export (?:const|let|function|async function|class) ([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
    if (!owner.has(m[1])) owner.set(m[1], file)
  }
}

// 2. 每文件已 import 的符号
const importedOf = new Map()
for (const file of files) {
  const set = new Set()
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/^import (?:type )?\{ ([^}]+) \} from '([^']+)'/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(' as ')[0].trim()
      if (name !== '') set.add(name)
    }
  }
  importedOf.set(file, set)
}

// 3. 扫描引用：只看代码行（排除 import/注释行、对象属性键 `xxx:`、字符串字面量），
//    标识符命中其他模块导出符号且未 import 即漏网（state.js 的属性键与函数同名、
//    字符串里的 'mention-pop' 片段都是误报源）。
let leaks = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const imported = importedOf.get(file)
  const lines = text.split('\n')
  const seen = new Set()
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('import ') || trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    // 去字符串字面量；收集本行属性键名（`key:` 形态，含行首缩进的键——多行对象跨行）
    const noStrings = line.replace(/'[^']*'|\"[^\"]*\"|\`[^\`]*\`/g, '')
    const keyNames = new Set()
    for (const k of noStrings.matchAll(/(?:\{|,|^)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm)) keyNames.add(k[1])
    for (const m of noStrings.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const sym = m[1]
      if (keyNames.has(sym)) continue
      const def = owner.get(sym)
      if (def === undefined || def === file) continue
      if (imported.has(sym) || seen.has(sym)) continue
      seen.add(sym)
      console.log(`漏网：${file} 引用 ${sym}（定义于 ${def}）—— 行 ${i + 1}：${trimmed.slice(0, 70)}`)
      leaks += 1
    }
  }
}
console.log(leaks === 0 ? '全部跨模块引用无漏网' : `共 ${leaks} 处漏网`)
