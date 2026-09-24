/**
 * 群组主题契约守护（群组二期批 0 入库，方案 §3.3）。
 *
 * 契约：成员页禁止自造字面色值与系统字体栈，颜色只准消费 --bt-* 槽；白名单外命中即红。
 * 正则覆盖三类形态（评审 P1-4）：#hex、rgba(/hsla( 函数色、data-URI 的 %23 编码形态。
 * 豁免分级：行级 `/* contract-exempt: 理由 *​/` + 文件级白名单清单（下方数组，每条注理由）。
 *
 * 生效时点（架构评审 P2 定案）：批 0 只扫新增的 web-react/ + web-common/ + huiyu
 * page.ts；旧成员 web/ 不扫——旧 CSS 批 3 删码退出后自然收敛纳管。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const GROUP = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 扫描目标：目录取递归，文件取单个。批 0 生效面=新代码三处。 */
const TARGETS = [
  resolve(GROUP, 'agents/blog/web-react'),
  resolve(GROUP, 'agents/closedoff/web-react'),
  resolve(GROUP, 'agents/web-common/src'),
  resolve(GROUP, 'agents/web-common/styles'),
  resolve(GROUP, 'agents/huiyu/src/page.ts'),
]
const EXTS = new Set(['.css', '.ts', '.tsx'])

/**
 * 文件级白名单（入库清单，每条注理由）：
 * - web-common/styles/tokens.css：--bt-* token 定义本身（契约的唯一来源）；
 * - web-common/styles/textures.css：材质基元定义处（胶带/滚动条/荧光笔的基元配方色）；
 * - agents/huiyu/src/page.ts：SSR 说明页 12 个字面色——批 3 契约化（构建期从 tokens.css
 *   生成 :root 契约段）后收窄为「仅生成段」，批 0 先整文件豁免。
 * - closedoff 暗色地图域文件：批 1 Cesium 飞地落地时按色值逐条注理由加入（暗色底图域
 *   与手账纸面两个世界，走 contract-exempt 白名单，方案 §3.2(b) 待拍板项 6）。
 */
const FILE_WHITELIST = [
  'agents/web-common/styles/tokens.css',
  'agents/web-common/styles/textures.css',
  'agents/huiyu/src/page.ts',
]

/** 三类色值形态 + data-URI 的 %23。hex 要求词边界，避免命中 URL fragment 一类。 */
const PATTERNS = [
  { name: 'hex', re: /(?<![\w#])#[0-9a-fA-F]{3,8}\b/g },
  { name: 'rgb/a', re: /\brgba?\(/g },
  { name: 'hsl/a', re: /\bhsla?\(/g },
  { name: 'data-uri-%23', re: /%23[0-9a-fA-F]{2,8}/g },
]

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (EXTS.has(extname(entry.name))) yield full
  }
}

const files = new Set()
for (const target of TARGETS) {
  try {
    if (readFileSync(target).length >= 0) files.add(target)
  } catch {
    // 目录：递归收集。
    try {
      for (const file of walk(target)) files.add(file)
    } catch { /* 目标不存在（如尚未创建的 web-react/）：跳过。 */ }
  }
}

const violations = []
for (const file of [...files].sort()) {
  const rel = relative(GROUP, file).split(sep).join('/')
  if (FILE_WHITELIST.includes(rel)) continue
  const source = readFileSync(file, 'utf8')
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.includes('contract-exempt')) continue
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0
      const hit = re.exec(line)
      if (hit !== null) violations.push({ rel, line: index + 1, kind: name, text: line.trim().slice(0, 120) })
    }
  }
}

if (violations.length > 0) {
  console.error(`[contract-guard] 命中 ${violations.length} 处白名单外字面色：`)
  for (const v of violations) console.error(`  ${v.rel}:${v.line} [${v.kind}] ${v.text}`)
  console.error('契约：颜色只准消费 --bt-* 槽；确需豁免用行内 /* contract-exempt: 理由 */ 或进 FILE_WHITELIST（注理由）。')
  process.exit(1)
}
console.log(`[contract-guard] 通过：扫描 ${files.size} 个文件，0 处白名单外字面色。`)
