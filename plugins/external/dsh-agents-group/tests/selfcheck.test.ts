/**
 * P3 判据①：⑦ 四条程序性校验的**正反用例**，以及自检四态的归约。
 *
 * 这里只测**纯函数**（`runSelfCheck` / `selfCheckState` / `toSelfCheck`）——它们不读时钟、
 * 不碰存储、不调用模型。端到端的行为（补交轮、超时预算、幂等、待答问题往返、真 `/reply` 链）
 * 在 `runtime-closure.test.ts`。
 *
 * 每条规则都给"该过"与"该拦"两侧；**另外**给"如实标未核验"的中间态——它既不是通过也不是
 * 不达标，把它压成布尔正是这一期要修掉的毛病。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectedResult } from '../packages/runtime/src/definition.ts'
import { runSelfCheck, selfCheckState, toSelfCheck, type SelfCheckInput } from '../packages/runtime/src/selfcheck.ts'

/** 一份**材料**（位置型，不是内容）。 */
const ARTIFACT = { title: '候选稿', path: '/agents/blog/drafts/1', kind: 'draft' as const }

const input = (overrides: Partial<SelfCheckInput> = {}): SelfCheckInput => ({
  result: { status: 'completed', text: '写好了' },
  acceptance: undefined,
  reported: true,
  ...overrides,
})

const verdictOf = (value: SelfCheckInput, rule: string) =>
  runSelfCheck(value).findings.find(item => item.rule === rule)?.verdict

describe('规则 1：summary 非空', () => {
  it('有正文 → 通过', () => {
    expect(verdictOf(input(), 'summary')).toBe('ok')
  })

  it('正文是空串 → 不达标（**空结果是最容易被放过的失败**）', () => {
    expect(verdictOf(input({ result: { status: 'completed', text: '' } }), 'summary')).toBe('failed')
  })

  it('正文只有空白 → 也不达标（不是"看起来有内容"就算）', () => {
    expect(verdictOf(input({ result: { status: 'completed', text: '  \n\t ' } }), 'summary')).toBe('failed')
  })
})

describe('规则 2：自检必须真的通过（四态，不是"非 unverifiable 即通过"）', () => {
  it('passed → 通过', () => {
    expect(verdictOf(input({ selfCheck: { status: 'passed' } }), 'self-check')).toBe('ok')
  })

  it('failed → 不达标，且把执行方的说明带进 detail', () => {
    const value = input({ selfCheck: { status: 'failed', detail: '少了发布链接' } })
    expect(verdictOf(value, 'self-check')).toBe('failed')
    expect(runSelfCheck(value).failed).toBe(true)
    expect(runSelfCheck(value).findings.find(item => item.rule === 'self-check')?.detail).toContain('少了发布链接')
  })

  it('unverifiable → **未核验**，不计入不达标', () => {
    const value = input({ selfCheck: { status: 'unverifiable' } })
    expect(verdictOf(value, 'self-check')).toBe('unverified')
    expect(runSelfCheck(value).failed).toBe(false)
  })

  it('⚠️ 缺省 → **未核验，绝不是通过**（这是与主方案字面不同的关键一处）', () => {
    // 主方案原文"status !== 'unverifiable' 才算自检通过"按字面让缺省也满足 ⇒ 也算通过。
    // 异构期两个真实执行方都还没有读 selfCheck，按旧口径 = 所有交付都被标记为"自检通过"。
    expect(verdictOf(input(), 'self-check')).toBe('unverified')
    expect(runSelfCheck(input()).failed).toBe(false)
  })

  it('状态名拼错 / 形状不对 → 归到 absent，按未核验处理（不猜、不降级成通过）', () => {
    expect(selfCheckState({ status: 'PASSED' } as never)).toBe('absent')
    expect(selfCheckState({} as never)).toBe('absent')
    expect(selfCheckState(undefined)).toBe('absent')
    expect(verdictOf(input({ selfCheck: { status: 'PASSED' } as never }), 'self-check')).toBe('unverified')
  })
})

describe('规则 3：口径-产物自洽（口径非空 ⇒ 材料非空）', () => {
  it('没有声明口径 → 未核验（**豁免判据是"这一步是否真的收到非空口径"**）', () => {
    expect(verdictOf(input({ acceptance: undefined }), 'acceptance-artifacts')).toBe('unverified')
    expect(verdictOf(input({ acceptance: '   ' }), 'acceptance-artifacts')).toBe('unverified')
  })

  it('有口径且交回了材料 → 通过', () => {
    const value = input({ acceptance: '一份 800 字以上的候选稿', result: { status: 'completed', text: '写好了', artifacts: [ARTIFACT] } })
    expect(verdictOf(value, 'acceptance-artifacts')).toBe('ok')
  })

  it('有口径却一条材料都没有 → 不达标', () => {
    const value = input({ acceptance: '一份 800 字以上的候选稿' })
    expect(verdictOf(value, 'acceptance-artifacts')).toBe('failed')
    expect(runSelfCheck(value).failed).toBe(true)
  })

  it('artifacts 是空数组同样不达标（空数组与"没给"在这里是一回事）', () => {
    const value = input({ acceptance: '一份候选稿', result: { status: 'completed', text: '写好了', artifacts: [] } })
    expect(verdictOf(value, 'acceptance-artifacts')).toBe('failed')
  })

  it('detail 如实说明强度：只说"没有交回任何材料"，不宣称"交错了种类"', () => {
    const detail = runSelfCheck(input({ acceptance: '一份候选稿' })).findings.find(item => item.rule === 'acceptance-artifacts')?.detail ?? ''
    expect(detail).toContain('没有交回任何材料')
    // 逐 kind 对照在当前契约下不可实现（自由文本 vs 固定英文枚举），detail 不能暗示它做过。
    expect(detail).not.toContain('kind')
  })
})

describe('规则 4：调过交活工具', () => {
  it('调过 → 通过', () => {
    expect(verdictOf(input({ reported: true }), 'report-called')).toBe('ok')
  })

  it('没调 → **未核验，不是不达标**（§4.3：没调工具不等于失败，用投影兜底）', () => {
    const value = input({ reported: false })
    expect(verdictOf(value, 'report-called')).toBe('unverified')
    expect(runSelfCheck(value).failed).toBe(false)
  })
})

describe('汇总：回报给协调方的 selfCheck', () => {
  it('四条全通过 → passed', () => {
    const value = input({ acceptance: '一份候选稿', selfCheck: { status: 'passed' }, result: { status: 'completed', text: '写好了', artifacts: [ARTIFACT] } })
    expect(toSelfCheck(runSelfCheck(value))).toEqual({ status: 'passed' })
  })

  it('有未核验但没有不达标 → unverifiable（并带上原因）', () => {
    const summary = toSelfCheck(runSelfCheck(input()))
    expect(summary.status).toBe('unverifiable')
    expect(summary.detail ?? '').not.toBe('')
  })

  it('有不达标 → failed（且优先于未核验）', () => {
    const value = input({ acceptance: '一份候选稿', result: { status: 'completed', text: '写好了', artifacts: [ARTIFACT] }, selfCheck: { status: 'failed', detail: '口径没对上' } })
    expect(toSelfCheck(runSelfCheck(value)).status).toBe('failed')
  })

  it('`failed` 与 `unverifiable` 是两回事：只有前者进 `outcome.failed`', () => {
    expect(runSelfCheck(input({ selfCheck: { status: 'failed' } })).failed).toBe(true)
    expect(runSelfCheck(input({ selfCheck: { status: 'unverifiable' } })).failed).toBe(false)
    expect(runSelfCheck(input()).failed).toBe(false)
  })
})

describe('纯函数性质', () => {
  it('同样的输入给同样的输出，且不改写输入', () => {
    const value = input({ acceptance: '一份候选稿' })
    const snapshot = JSON.stringify(value)
    const first: ProjectedResult = value.result
    expect(runSelfCheck(value)).toEqual(runSelfCheck(value))
    expect(JSON.stringify(value)).toBe(snapshot)
    expect(value.result).toBe(first)
  })
})
