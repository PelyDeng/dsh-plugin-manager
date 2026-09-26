/**
 * 群组主题契约守护（群组二期批 0 入库，方案 §3.3）。
 *
 * 契约：成员页禁止自造字面色值与系统字体栈，颜色只准消费 --bt-* 槽；白名单外命中即红。
 * 正则覆盖三类形态（评审 P1-4）：#hex、rgba(/hsla( 函数色、data-URI 的 %23 编码形态。
 * 豁免分级：行级 `/* contract-exempt: 理由 *​/` + 文件级白名单清单（下方数组，每条注理由）。
 *
 * 生效时点（架构评审 P2 定案）：批 0 只扫新增的 web-react/ + web-common/ + huiyu
 * page.ts；旧成员 web/ 的 CSS 已随 React 二期批 C1 删码退出，无需再纳管。
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
  // 生成段在扫描面内、白名单豁免：若有人误删白名单条目即红，豁免关系始终真实可验证。
  resolve(GROUP, 'agents/huiyu/src/contract.ts'),
]
const EXTS = new Set(['.css', '.ts', '.tsx'])

/**
 * 文件级白名单（入库清单，每条注理由）：
 * - web-common/styles/tokens.css：--bt-* token 定义本身（契约的唯一来源）；
 * - web-common/styles/textures.css：材质基元定义处（胶带/滚动条/荧光笔的基元配方色）；
 * - agents/huiyu/src/contract.ts：批 3a 契约化后的生成段豁免——构建期从 tokens.css
 *   机械生成的 :root 契约段（方案 §3.3），色值随源零手改；漂移由 generate-contract.mjs
 *   --check 断言（挂在群组 check）看住。page.ts 手写部分已随之退出白名单、开始纳管。
 * - closedoff 暗色地图域文件：批 1 Cesium 飞地落地时按色值逐条注理由加入（暗色底图域
 *   与手账纸面两个世界，走 contract-exempt 白名单，方案 §3.2(b) 待拍板项 6）。
 */
const FILE_WHITELIST = [
  'agents/web-common/styles/tokens.css',
  'agents/web-common/styles/textures.css',
  'agents/huiyu/src/contract.ts',
  // 批 1b closedoff 暗色地图域（方案 §3.2(b) 待拍板项 6）：Cesium 底图容器
  // (#101b2d)、视频预览深底 (#0d1d32)、加载遮罩 (rgba(9,19,34,.78)) 与深底上的
  // 浅色文字——与手账纸面是两个世界，硬映射到 --bt-* 暖色槽必失真。文件内亮色
  // 部分（弹窗外框/列表/信息行）仍消费 --bt-* 槽；逐色值理由见文件内注释。
  'agents/closedoff/web-react/src/styles/enclaves.css',
  // 同口径：Cesium 飞地引擎文件——色值全部是三维场景内的标绘材质（轨迹线/
  // 起终点/围栏四色/底图色，画进 WebGL 画布），与页面 DOM 观感换肤无关；
  // 设计文档 §3.3「Cesium 三方不扫」的延伸，色值随旧 trajectory.js 原样保留。
  'agents/closedoff/web-react/src/enclaves/cesium-enclave.ts',
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
