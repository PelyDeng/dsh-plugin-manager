/**
 * tokens 双份漂移断言（群组二期批 0 入库，方案 §3.3）：butler web-react 的 tokens.css
 * 与群组 web-common 的 tokens.css sha256 必须一致——不一致即红。零成本，替代人工登记
 * （butler 侧本期不回迁 web-common，双份过渡态由本断言看住，三期归一）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GROUP = resolve(fileURLToPath(import.meta.url), '..', '..')
// butler 与 agents-group 是 plugins/external/ 下的平级目录；环境变量可覆盖（异机布局）。
const BUTLER = process.env.BUTLER_ROOT ?? resolve(GROUP, '..', 'dsh-butler-console')

const sources = [
  ['butler', resolve(BUTLER, 'web-react/src/styles/tokens.css')],
  ['web-common', resolve(GROUP, 'agents/web-common/styles/tokens.css')],
]

const hashes = new Map()
for (const [name, file] of sources) {
  try {
    hashes.set(name, createHash('sha256').update(readFileSync(file)).digest('hex'))
  } catch (error) {
    console.error(`[tokens-hash] 读取失败：${name} → ${file}（${error.code ?? error}）`)
    process.exit(1)
  }
}

const [a, b] = [...hashes.values()]
if (a !== b) {
  console.error(`[tokens-hash] 双份 tokens.css 已漂移：\n  butler     ${a}\n  web-common ${b}\n手账 token 层必须单一来源同步修改（或有意分叉时先更新本断言的登记）。`)
  process.exit(1)
}
console.log(`[tokens-hash] 一致：sha256 ${a.slice(0, 16)}…（butler ≡ web-common）`)
